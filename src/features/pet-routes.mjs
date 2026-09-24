import {createHmac} from 'node:crypto';
import {id, text, choice, fail} from '../domain.mjs';
import {get, all, run, audit} from './store.mjs';
import {getEntitlements} from './billing.mjs';
import {encryptPetText, decryptPetText} from './pet-crypto.mjs';
import {createPetProvider, localSafetyReply, PET_HELP, PET_DISCLAIMER, PET_EXERCISES} from './pet-provider.mjs';

const DAY = 86400000, RETENTION = 7 * DAY, OFFLINE_DAILY_LIMIT = 100;
const STAGES = [{id: 'seed', label: 'Малыш', minXp: 0}, {id: 'sprout', label: 'Друг', minXp: 100}, {id: 'companion', label: 'Спутник', minXp: 300}, {id: 'explorer', label: 'Исследователь', minXp: 700}];
const COLORS = ['mint', 'amber', 'lilac', 'sapphire', 'rose', 'gold'];
const COLOR_LABELS = ['Мята', 'Янтарь', 'Сирень', 'Сапфир', 'Роза', 'Золото'];
const PREMIUM_COLORS = ['sapphire', 'rose', 'gold'];
const CARE = ['feed', 'play', 'rest'];
const requestIdValue = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(value)) fail('Нужен уникальный requestId длиной 16–80 символов');
  return value;
};
function displayName(value) {
  const name = text(value, 'Имя питомца', 32);
  if (/[\p{Cc}\p{Cf}<>]/u.test(name)) fail('Используйте обычные буквы, цифры и пробелы в имени');
  return name;
}
function bodyObject(value) {if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Ожидается объект'); return value;}

// Run from the server's periodic maintenance too: dormant users' messages must
// expire. Every statement is bounded; backups have a separate retention policy.
export async function prunePetData(store, {now = Date.now(), limit = 1000} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new TypeError('Invalid pet cleanup limit');
  // Each table commits independently so cleanup never keeps message locks while
  // waiting for a request/pet lock acquired in the opposite order by a user.
  const messages = await store.transaction(function* () {
    return yield run('DELETE FROM pet_messages WHERE id IN (SELECT id FROM pet_messages WHERE expires_at<=$1 ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED)', [now, limit]);
  });
  const requests = await store.transaction(function* () {
    return yield run('DELETE FROM pet_chat_requests WHERE (user_id,request_id) IN (SELECT user_id,request_id FROM pet_chat_requests WHERE expires_at<=$1 ORDER BY user_id,request_id LIMIT $2 FOR UPDATE SKIP LOCKED)', [now, limit]);
  });
  const usage = await store.transaction(function* () {
    return yield run('DELETE FROM pet_usage WHERE (day,user_id) IN (SELECT day,user_id FROM pet_usage WHERE day<$1 ORDER BY day,user_id LIMIT $2 FOR UPDATE SKIP LOCKED)', [Math.floor(now / DAY) - 7, limit]);
  });
  return {messages: messages.rowCount, requests: requests.rowCount, usage: usage.rowCount};
}

export function createPetRoutes({store, cfg, env = process.env, fetchImpl = globalThis.fetch, now = Date.now} = {}) {
  const provider = createPetProvider({env, fetchImpl}), key = cfg.keys.encryptionKey;
  function* pruneUser(userId, time) {
    yield run('DELETE FROM pet_messages WHERE user_id=$1 AND expires_at<=$2', [userId, time]);
    yield run('DELETE FROM pet_chat_requests WHERE user_id=$1 AND expires_at<=$2', [userId, time]);
  }
  function* petRow(userId) {
    const pet = yield get('SELECT * FROM pets WHERE user_id=$1 FOR UPDATE', [userId]);
    if (!pet) fail('Сначала выберите питомца', 404);
    return pet;
  }
  function* reconcile(pet, time) {
    // Verified completion PK and the reward ledger protect against repeat XP.
    // A bounded batch also prevents a very old account from monopolizing a lock.
    const completed = yield all("SELECT c.quest_id FROM completions c WHERE c.user_id=$1 AND c.created_at>=$2 AND NOT EXISTS (SELECT 1 FROM pet_rewards r WHERE r.user_id=c.user_id AND r.event_key='quest:'||c.quest_id) ORDER BY c.created_at,c.quest_id LIMIT 100", [pet.user_id, pet.created_at]);
    let earned = 0;
    for (const item of completed) {
      const saved = yield run('INSERT INTO pet_rewards(user_id,event_key,xp,created_at) VALUES($1,$2,20,$3) ON CONFLICT(user_id,event_key) DO NOTHING', [pet.user_id, `quest:${item.quest_id}`, time]);
      earned += saved.rowCount * 20;
    }
    if (earned) {yield run('UPDATE pets SET xp=xp+$1,updated_at=$2 WHERE user_id=$3', [earned, time, pet.user_id]); pet.xp += earned;}
    return pet;
  }
  function* history(userId, time, limit = 40) {
    const rows = yield all('SELECT id,role,content_cipher,mode,created_at FROM pet_messages WHERE user_id=$1 AND expires_at>$2 ORDER BY created_at DESC,id DESC LIMIT $3', [userId, time, limit]);
    return rows.reverse().map(row => ({role: row.role, text: decryptPetText(row.content_cipher, key, `${userId}:message:${row.id}`), mode: row.mode, createdAt: row.created_at}));
  }
  function* view(userId, time) {
    yield* pruneUser(userId, time);
    let pet = yield get('SELECT * FROM pets WHERE user_id=$1 FOR UPDATE', [userId]);
    const entitlements = yield* getEntitlements(userId, time), day = Math.floor(time / DAY);
    const mode = provider.config.configured ? 'ai' : 'offline';
    const usage = yield get('SELECT count FROM pet_usage WHERE day=$1 AND user_id=$2', [day, mode === 'ai' ? userId : `offline:${userId}`]);
    const chat = {available: mode === 'offline' || Boolean(pet?.consent_at && pet?.adult_attested_at), mode, used: usage?.count || 0, limit: mode === 'ai' ? entitlements.aiMessagesPerDay : OFFLINE_DAILY_LIMIT, resetsAt: (day + 1) * DAY, retentionDays: 7};
    const colors = COLORS.map((color, index) => ({id: color, label: COLOR_LABELS[index], premium: PREMIUM_COLORS.includes(color), available: !PREMIUM_COLORS.includes(color) || entitlements.premiumColors || pet?.color === color}));
    if (!pet) return {pet: null, chat, colors, history: [], disclaimer: PET_DISCLAIMER};
    pet = yield* reconcile(pet, time);
    const index = STAGES.findLastIndex(stage => pet.xp >= stage.minXp), stage = STAGES[index], nextStageXp = STAGES[index + 1]?.minXp ?? null;
    const rewards = yield all('SELECT event_key FROM pet_rewards WHERE user_id=$1 AND created_at>=$2 AND event_key LIKE $3', [userId, day * DAY, `care:${day}:%`]);
    return {
      pet: {name: pet.name, species: pet.species, color: pet.color, xp: pet.xp, stage, nextStageXp, progress: nextStageXp === null ? 1 : Math.min(1, (pet.xp - stage.minXp) / (nextStageXp - stage.minXp)), consent: Boolean(pet.consent_at), adultAttested: Boolean(pet.adult_attested_at), careToday: rewards.map(item => item.event_key.split(':')[2]), providerMode: mode},
      chat, colors, history: yield* history(userId, time), disclaimer: PET_DISCLAIMER,
    };
  }
  function* wipe(userId, time) {
    yield run('UPDATE pets SET chat_epoch=chat_epoch+1,updated_at=$2 WHERE user_id=$1', [userId, time]);
    yield run('DELETE FROM pet_messages WHERE user_id=$1', [userId]);
    // Keep HMAC-only tombstones until expiration: retrying an old HTTP request
    // must not create a new provider call or restore deleted content.
    yield run("UPDATE pet_chat_requests SET status='failed',reply_cipher=NULL WHERE user_id=$1", [userId]);
  }

  return async function petRoutes(ctx) {
    const {path, method, user} = ctx;
    if (path === '/api/pet/help' && method === 'GET') return {...PET_HELP};
    if (path === '/api/pet/exercises' && method === 'GET') return {items: PET_EXERCISES};
    if (!path.startsWith('/api/pet')) return undefined;
    ctx.required(user);
    if (path === '/api/pet' && method === 'GET') return store.transaction(function* () {yield* store.requireActor(user); return yield* view(user.id, now());});

    if (path === '/api/pet/adopt' && method === 'POST') {
      const body = bodyObject(await ctx.readBody()), name = displayName(body.name), species = choice(body.species, ['fox', 'cat', 'dragon'], 'вид питомца'), color = choice(body.color || 'mint', COLORS, 'цвет');
      return store.transaction(function* () {
        yield* store.requireActor(user); const time = now();
        const existing = yield get('SELECT user_id FROM pets WHERE user_id=$1 FOR UPDATE', [user.id]);
        if (existing) fail('Питомец уже выбран', 409);
        if (PREMIUM_COLORS.includes(color) && !(yield* getEntitlements(user.id, time)).premiumColors) fail('Этот цвет доступен с Игрок Plus', 403);
        yield run('INSERT INTO pets(user_id,name,species,color,xp,created_at,updated_at,chat_epoch) VALUES($1,$2,$3,$4,0,$5,$5,0)', [user.id, name, species, color, time]);
        yield audit(user.id, 'pet.adopted', user.id, {species});
        return yield* view(user.id, time);
      });
    }

    if (path === '/api/pet' && method === 'PATCH') {
      const body = bodyObject(await ctx.readBody());
      if (body.consent !== undefined && typeof body.consent !== 'boolean') fail('Согласие должно быть явным');
      if (body.adultAttested !== undefined && typeof body.adultAttested !== 'boolean') fail('Подтвердите возраст явно');
      const name = body.name === undefined ? undefined : displayName(body.name), color = body.color === undefined ? undefined : choice(body.color, COLORS, 'цвет');
      return store.transaction(function* () {
        yield* store.requireActor(user); const time = now(), pet = yield* petRow(user.id);
        if (color !== undefined && color !== pet.color && PREMIUM_COLORS.includes(color) && !(yield* getEntitlements(user.id, time)).premiumColors) fail('Этот цвет доступен с Игрок Plus', 403);
        const adult = body.adultAttested === false ? null : body.adultAttested === true ? time : pet.adult_attested_at;
        if (body.consent === true && !adult) fail('ИИ-чат пилота доступен совершеннолетним после подтверждения 18+');
        const consent = adult ? (body.consent === true ? time : body.consent === false ? null : pet.consent_at) : null;
        yield run('UPDATE pets SET name=$2,color=$3,consent_at=$4,adult_attested_at=$5,updated_at=$6 WHERE user_id=$1', [user.id, name ?? pet.name, color ?? pet.color, consent, adult, time]);
        if (body.consent === false || body.adultAttested === false) {yield* wipe(user.id, time); yield audit(user.id, 'pet.consent_revoked', user.id);}
        else if (body.consent === true) yield audit(user.id, 'pet.consent_granted', user.id, {noticeVersion: 1});
        return yield* view(user.id, time);
      });
    }

    if (path === '/api/pet/care' && method === 'POST') {
      const body = bodyObject(await ctx.readBody()), action = choice(body.action, CARE, 'действие');
      return store.transaction(function* () {
        yield* store.requireActor(user); yield* petRow(user.id); const time = now();
        const saved = yield run('INSERT INTO pet_rewards(user_id,event_key,xp,created_at) VALUES($1,$2,10,$3) ON CONFLICT(user_id,event_key) DO NOTHING', [user.id, `care:${Math.floor(time / DAY)}:${action}`, time]);
        if (saved.rowCount) yield run('UPDATE pets SET xp=xp+10,updated_at=$2 WHERE user_id=$1', [user.id, time]);
        return {...yield* view(user.id, time), rewarded: Boolean(saved.rowCount)};
      });
    }

    if (path === '/api/pet/history' && method === 'DELETE') {
      await store.transaction(function* () {yield* store.requireActor(user); yield* petRow(user.id); yield* wipe(user.id, now()); yield audit(user.id, 'pet.history_deleted', user.id);});
      return {ok: true};
    }

    if (path === '/api/pet/chat' && method === 'POST') {
      const body = bodyObject(await ctx.readBody()), message = text(body.message, 'Сообщение', 1000), requestId = requestIdValue(body.requestId);
      // This deterministic help reply never sends sensitive input to a provider,
      // never consumes a paid allowance, and does not save crisis text.
      const local = localSafetyReply(message);
      if (local) {
        await store.transaction(function* () {yield* store.requireActor(user);});
        return {reply: local, mode: 'support', requestId, replayed: false};
      }
      await ctx.throttle(`pet-chat:${user.id}`, 20);
      const requestHash = createHmac('sha256', cfg.keys.auditKey).update(`pet:chat:${user.id}:`).update(message).digest('hex');
      const reservation = await store.transaction(function* () {
        yield* store.requireActor(user); const time = now(), pet = yield* petRow(user.id);
        yield* pruneUser(user.id, time);
        const existing = yield get('SELECT * FROM pet_chat_requests WHERE user_id=$1 AND request_id=$2 FOR UPDATE', [user.id, requestId]);
        if (existing) {
          if (existing.request_hash !== requestHash) fail('Этот requestId уже использован для другого сообщения', 409);
          if (existing.status === 'complete' && existing.epoch === pet.chat_epoch && existing.reply_cipher) return {cached: {reply: decryptPetText(existing.reply_cipher, key, `${user.id}:request:${requestId}`), mode: existing.mode, requestId, replayed: true}};
          fail(existing.status === 'reserved' ? 'Ответ ещё готовится. Повторите запрос позже с тем же requestId.' : 'Предыдущий запрос завершён или удалён. Отправьте новое сообщение.', 409);
        }
        const busy = yield get("SELECT request_id FROM pet_chat_requests WHERE user_id=$1 AND status='reserved' AND created_at>$2 LIMIT 1", [user.id, time - 120000]);
        if (busy) fail('Дождитесь ответа на предыдущее сообщение', 409);
        const ai = provider.config.configured;
        if (ai && (!pet.consent_at || !pet.adult_attested_at)) fail('Подтвердите 18+ и согласие на передачу текста в OpenAI в настройках питомца', 403);
        if (ai) {
          const entitlements = yield* getEntitlements(user.id, time), day = Math.floor(time / DAY);
          // Serialize the global budget first across every app replica, then the
          // per-user budget. A reservation is charged even on an uncertain error.
          for (const [uid, limit] of [['*', provider.config.globalDailyLimit], [user.id, entitlements.aiMessagesPerDay]]) {
            yield run('INSERT INTO pet_usage(day,user_id,count) VALUES($1,$2,0) ON CONFLICT(day,user_id) DO NOTHING', [day, uid]);
            const used = yield get('SELECT count FROM pet_usage WHERE day=$1 AND user_id=$2 FOR UPDATE', [day, uid]);
            if (used.count >= limit) fail(uid === '*' ? 'Дневной лимит ИИ для пилота исчерпан. Упражнения и раздел поддержки доступны.' : 'Дневной лимит ИИ-сообщений исчерпан. Раздел поддержки доступен бесплатно.', 429);
            yield run('UPDATE pet_usage SET count=count+1 WHERE day=$1 AND user_id=$2', [day, uid]);
          }
        } else {
          // Prepared exercises remain public and unlimited. Only persisted
          // offline conversations are bounded to protect storage from flooding.
          const day = Math.floor(time / DAY), usageKey = `offline:${user.id}`;
          yield run('INSERT INTO pet_usage(day,user_id,count) VALUES($1,$2,0) ON CONFLICT(day,user_id) DO NOTHING', [day, usageKey]);
          const used = yield get('SELECT count FROM pet_usage WHERE day=$1 AND user_id=$2 FOR UPDATE', [day, usageKey]);
          if (used.count >= OFFLINE_DAILY_LIMIT) fail('Лимит сохраняемых сообщений на сегодня исчерпан. Готовые упражнения и раздел поддержки доступны бесплатно.', 429);
          yield run('UPDATE pet_usage SET count=count+1 WHERE day=$1 AND user_id=$2', [day, usageKey]);
        }
        yield run('INSERT INTO pet_chat_requests(user_id,request_id,request_hash,status,epoch,mode,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [user.id, requestId, requestHash, 'reserved', pet.chat_epoch, ai ? 'ai' : 'offline', time, time + RETENTION]);
        return {epoch: pet.chat_epoch, mode: ai ? 'ai' : 'offline'};
      });
      if (reservation.cached) return reservation.cached;

      // No DB transaction/lock spans a provider request. Privacy is rechecked
      // between stages so deletion/revocation on any replica stops new sends.
      const controller = new AbortController();
      const disconnected = () => controller.abort();
      const responseClosed = () => {if (!ctx.res?.writableEnded) disconnected();};
      ctx.req?.once?.('aborted', disconnected);
      ctx.res?.once?.('close', responseClosed);
      if (ctx.req?.aborted || ctx.res?.destroyed) disconnected();
      const beforeRequest = endpoint => store.transaction(function* () {
        yield* store.requireActor(user); const time = now(), pet = yield* petRow(user.id);
        if (pet.chat_epoch !== reservation.epoch || (reservation.mode === 'ai' && (!pet.consent_at || !pet.adult_attested_at))) fail('Настройки приватности изменились. Ответ не сохранён.', 409);
        const pending = yield get('SELECT status,epoch,expires_at FROM pet_chat_requests WHERE user_id=$1 AND request_id=$2', [user.id, requestId]);
        if (!pending || pending.status !== 'reserved' || pending.epoch !== reservation.epoch || pending.expires_at <= time) fail('Запрос был удалён или завершён', 409);
        // Moderation may outlive a historical message's retention window. Load
        // only unexpired context immediately before the generation stage.
        if (endpoint === 'responses') return {history: yield* history(user.id, time, 6)};
      });
      try {
        const response = await provider.reply({message, signal: controller.signal, beforeRequest});
        await store.transaction(function* () {
          yield* store.requireActor(user); const time = now(), pet = yield* petRow(user.id);
          if (pet.chat_epoch !== reservation.epoch || (reservation.mode === 'ai' && (!pet.consent_at || !pet.adult_attested_at))) fail('Настройки приватности изменились. Ответ не сохранён.', 409);
          const saved = yield run("UPDATE pet_chat_requests SET status='complete',mode=$4,reply_cipher=$5 WHERE user_id=$1 AND request_id=$2 AND epoch=$3 AND status='reserved' AND expires_at>$6", [user.id, requestId, reservation.epoch, response.mode, encryptPetText(response.reply, key, `${user.id}:request:${requestId}`), time]);
          if (!saved.rowCount) fail('Запрос был удалён или завершён', 409);
          // Unsafe inputs are not retained; only the deterministic help reply.
          const messages = response.mode === 'support' ? [{role: 'assistant', value: response.reply}] : [{role: 'user', value: message}, {role: 'assistant', value: response.reply}];
          const latest = yield get('SELECT MAX(created_at) AS created_at FROM pet_messages WHERE user_id=$1', [user.id]);
          const messageTime = Math.max(time, (latest?.created_at ?? -1) + 1);
          for (const [offset, item] of messages.entries()) {
            const messageId = id();
            yield run('INSERT INTO pet_messages(id,user_id,request_id,role,content_cipher,mode,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [messageId, user.id, requestId, item.role, encryptPetText(item.value, key, `${user.id}:message:${messageId}`), response.mode, messageTime + offset, time + RETENTION]);
          }
        });
        return {...response, requestId, replayed: false};
      } catch (error) {
        // Finalization failures (revoked sessions, privacy edits, expired jobs)
        // must settle the reservation too, without refunding an uncertain cost.
        await store.transaction(function* () {
          yield run("UPDATE pet_chat_requests SET status='failed' WHERE user_id=$1 AND request_id=$2 AND status='reserved' AND epoch=$3", [user.id, requestId, reservation.epoch]);
        });
        throw error;
      } finally {
        ctx.req?.off?.('aborted', disconnected);
        ctx.res?.off?.('close', responseClosed);
      }
    }
    return undefined;
  };
}
