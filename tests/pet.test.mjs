import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {createFeatureStore} from '../src/features/store.mjs';
import {createPetRoutes, prunePetData} from '../src/features/pet-routes.mjs';
import {PET_HELP} from '../src/features/pet-provider.mjs';

const DAY = 86400000;
const aiEnv = {OPENAI_API_KEY: 'mock-key', OPENAI_PET_MODEL: 'configured-model'};
const safe = {results: [{flagged: false, categories: {'self-harm': false, 'self-harm/intent': false, 'self-harm/instructions': false}}]};
function defaultFetch(url) {
  return Promise.resolve(new Response(JSON.stringify(url.endsWith('/responses') ? {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Понимаю. Какой небольшой шаг поможет сегодня?'}]}]} : safe)));
}
function fixture(t, {env = {}, fetchImpl = defaultFetch} = {}) {
  const db = openDb(':memory:', {withSnapshot: false}); t.after(() => db.close());
  let time = Date.now();
  const cfg = {keys: {encryptionKey: randomBytes(32), auditKey: randomBytes(32)}, idleMs: 30 * DAY}, events = [];
  const store = createFeatureStore({db, cfg, dialect: 'sqlite', audit(_db, ...event) {events.push(event);}});
  const route = createPetRoutes({store, cfg, env, fetchImpl, now: () => time});
  const actors = {};
  for (const uid of ['u1', 'u2']) {
    db.prepare("INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,'unused','player',?)").run(uid, uid + '@example.test', uid, time);
    db.prepare('INSERT INTO sessions(token,user_id,expires,id,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,0)').run(uid + '-token', uid, time + 30 * DAY, uid + '-session', time, time);
    actors[uid] = {id: uid, role: 'player', session_id: uid + '-session'};
  }
  const call = (path, method = 'GET', body = {}, uid = 'u1') => route({path, method, user: actors[uid], required(user) {if (!user) throw Object.assign(new Error('Login'), {status: 401});}, readBody: async () => body, throttle: async () => {}});
  const adopt = (uid = 'u1') => call('/api/pet/adopt', 'POST', {name: 'Искра', species: 'fox', color: 'mint'}, uid);
  const consent = () => call('/api/pet', 'PATCH', {consent: true, adultAttested: true});
  const chat = (message = 'Сегодня хорошая прогулка', requestId = randomUUID()) => call('/api/pet/chat', 'POST', {message, requestId});
  return {db, store, cfg, events, call, adopt, consent, chat, actors, now: () => time, advance(ms) {time += ms;}};
}

test('pet adoption, bounded daily care and verified quest growth are idempotent without XP decay', async t => {
  const f = fixture(t); const first = await f.adopt(); assert.equal(first.pet.xp, 0);
  await assert.rejects(f.adopt(), error => error.status === 409);
  const results = await Promise.all(Array.from({length: 8}, () => f.call('/api/pet/care', 'POST', {action: 'feed'})));
  assert.equal(results.filter(item => item.rewarded).length, 1); assert.equal(results.at(-1).pet.xp, 10);
  const quests = f.db.prepare('SELECT id FROM quests LIMIT 2').all();
  f.db.prepare('INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES(?,?,100,?)').run('u1', quests[0].id, f.now() + 1);
  f.db.prepare('INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES(?,?,100,?)').run('u1', quests[1].id, f.now() - 1);
  assert.equal((await f.call('/api/pet')).pet.xp, 30); assert.equal((await f.call('/api/pet')).pet.xp, 30);
  f.advance(10 * DAY); assert.equal((await f.call('/api/pet')).pet.xp, 30);
  assert.deepEqual((await f.call('/api/pet')).pet.careToday, []);
  assert.equal((await f.call('/api/pet/care', 'POST', {action: 'feed'})).pet.xp, 40);
});

test('offline conversation is labelled, encrypted, ordered at same millisecond and isolated by account', async t => {
  const f = fixture(t); await f.adopt();
  const requestId = randomUUID(), first = await f.chat('Секретная мысль', requestId);
  assert.equal(first.mode, 'offline'); assert.equal(first.replayed, false);
  assert.equal((await f.chat('Секретная мысль', requestId)).replayed, true);
  await assert.rejects(f.chat('Другая мысль', requestId), error => error.status === 409);
  await f.chat('Вторая мысль');
  const current = await f.call('/api/pet');
  assert.deepEqual(current.history.map(item => item.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(current.history[2].text, 'Вторая мысль');
  assert.equal(current.chat.used, 2); assert.equal(current.chat.limit, 100);
  const raw = f.db.prepare('SELECT * FROM pet_messages').all(); assert.equal(raw.length, 4);
  assert.ok(raw.every(row => row.content_cipher.startsWith('p1.') && !row.content_cipher.includes('мысль')));
  assert.doesNotMatch(JSON.stringify(f.events), /Секретная|мысль/);
  await f.adopt('u2'); assert.deepEqual((await f.call('/api/pet', 'GET', {}, 'u2')).history, []);
  await f.call('/api/pet/history', 'DELETE');
  assert.deepEqual((await f.call('/api/pet')).history, []);
  assert.equal(f.db.prepare('SELECT count(*) n FROM pet_messages').get().n, 0);
  await assert.rejects(f.chat('Секретная мысль', requestId), error => error.status === 409);
  assert.equal(f.db.prepare('SELECT reply_cipher FROM pet_chat_requests WHERE request_id=?').get(requestId).reply_cipher, null);
});

test('AI requires explicit adult consent; daily quota is durable and urgent support bypasses quota', async t => {
  let calls = 0;
  const f = fixture(t, {env: aiEnv, fetchImpl: async (...args) => {calls++; return defaultFetch(...args);}});
  await f.adopt(); await assert.rejects(f.chat(), error => error.status === 403);
  await assert.rejects(f.call('/api/pet', 'PATCH', {consent: true}), error => error.status === 400);
  await f.consent();
  const requestId = randomUUID(); await f.chat('Привет', requestId); await f.chat('Привет', requestId);
  assert.equal(calls, 3);
  for (let index = 0; index < 4; index++) await f.chat();
  assert.equal(calls, 15); assert.equal((await f.call('/api/pet')).chat.used, 5);
  await assert.rejects(f.chat(), error => error.status === 429); assert.equal(calls, 15);
  const help = await f.chat('Я хочу умереть'); assert.equal(help.mode, 'support'); assert.equal(help.reply, PET_HELP.text); assert.equal(calls, 15);
  await f.call('/api/pet/history', 'DELETE'); assert.equal((await f.call('/api/pet')).chat.used, 5);
  await f.call('/api/pet', 'PATCH', {consent: false}); assert.equal((await f.call('/api/pet')).chat.available, false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM pet_messages').get().n, 0);
});

test('provider failure reserves budget and never retries the same idempotency key', async t => {
  let calls = 0;
  const f = fixture(t, {env: aiEnv, fetchImpl: async () => {calls++; throw new Error('secret upstream failure');}});
  await f.adopt(); await f.consent(); const requestId = randomUUID();
  await assert.rejects(f.chat('Привет', requestId), error => error.status === 503 && !error.message.includes('secret'));
  await assert.rejects(f.chat('Привет', requestId), error => error.status === 409);
  assert.equal(calls, 1); assert.equal((await f.call('/api/pet')).chat.used, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM pet_messages').get().n, 0);
});

test('global AI budget is shared across users and cannot be exceeded by a second account', async t => {
  const f = fixture(t, {env: {...aiEnv, PET_AI_GLOBAL_DAILY_LIMIT: '1'}}); await f.adopt(); await f.consent(); await f.chat();
  await f.adopt('u2'); await f.call('/api/pet', 'PATCH', {consent: true, adultAttested: true}, 'u2');
  await assert.rejects(f.call('/api/pet/chat', 'POST', {message: 'Привет', requestId: randomUUID()}, 'u2'), error => error.status === 429);
  assert.equal(f.db.prepare("SELECT count FROM pet_usage WHERE user_id='*'").get().count, 1);
});

test('prepared exercises remain public before consent and after the AI budget is exhausted', async t => {
  let calls = 0;
  const f = fixture(t, {env: {...aiEnv, PET_AI_GLOBAL_DAILY_LIMIT: '1'}, fetchImpl: async (...args) => {calls++; return defaultFetch(...args);}});
  const exercises = await f.call('/api/pet/exercises', 'GET', {}, 'anonymous');
  assert.equal(exercises.items.length, 3); assert.equal(calls, 0);
  assert.ok(exercises.items.every(item => item.id && item.title && item.text));
  await f.adopt(); await f.consent(); await f.chat();
  await assert.rejects(f.chat(), error => error.status === 429);
  const before = f.db.prepare('SELECT count(*) n FROM pet_messages').get().n;
  assert.deepEqual(await f.call('/api/pet/exercises', 'GET', {}, 'anonymous'), exercises);
  assert.equal(calls, 3); assert.equal(f.db.prepare('SELECT count(*) n FROM pet_messages').get().n, before);
});

test('history deletion or consent revocation during a provider call blocks persistence', async t => {
  for (const action of ['delete', 'revoke', 'session']) {
    let unblock, entered;
    const waiting = new Promise(resolve => {entered = resolve;}), gate = new Promise(resolve => {unblock = resolve;});
    const f = fixture(t, {env: aiEnv, fetchImpl: async (...args) => {if (args[0].endsWith('/responses')) {entered(); await gate;} return defaultFetch(...args);}});
    await f.adopt(); await f.consent(); const pending = f.chat(); await waiting;
    assert.equal(f.db.isTransaction, false, 'provider wait must not hold a SQLite transaction');
    if (action === 'delete') await f.call('/api/pet/history', 'DELETE');
    else if (action === 'revoke') await f.call('/api/pet', 'PATCH', {consent: false});
    else f.db.prepare("DELETE FROM sessions WHERE user_id='u1'").run();
    unblock(); await assert.rejects(pending, error => error.status === (action === 'session' ? 401 : 409));
    assert.equal(f.db.prepare('SELECT count(*) n FROM pet_messages').get().n, 0);
    assert.equal(f.db.prepare('SELECT reply_cipher FROM pet_chat_requests').get().reply_cipher, null);
  }
});

test('bounded cleanup removes expired text and tombstones for dormant users', async t => {
  const f = fixture(t); await f.adopt(); await f.chat(); f.advance(8 * DAY);
  const first = await prunePetData(f.store, {now: f.now(), limit: 1});
  assert.equal(first.messages, 1); assert.equal(first.requests, 1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM pet_messages').get().n, 1);
  const second = await prunePetData(f.store, {now: f.now(), limit: 1}); assert.equal(second.messages, 1);
});

test('offline persisted conversations stop at 100 per UTC day without limiting exercises or resetting on deletion', async t => {
  const f = fixture(t); await f.adopt();
  f.db.prepare('INSERT INTO pet_usage(day,user_id,count) VALUES(?,?,99)').run(Math.floor(f.now() / DAY), 'offline:u1');
  const requestId = randomUUID(); await f.chat('Последнее сохраняемое сообщение', requestId);
  assert.equal((await f.call('/api/pet')).chat.used, 100);
  assert.equal((await f.chat('Последнее сохраняемое сообщение', requestId)).replayed, true);
  await assert.rejects(f.chat(), error => error.status === 429);
  await f.call('/api/pet/history', 'DELETE');
  await assert.rejects(f.chat(), error => error.status === 429);
  assert.equal((await f.call('/api/pet/exercises', 'GET', {}, 'anonymous')).items.length, 3);
  assert.equal((await f.chat('Я не хочу жить')).mode, 'support');
  assert.equal(f.db.prepare('SELECT count(*) n FROM pet_messages').get().n, 0);
  assert.equal(f.db.prepare("SELECT count(*) n FROM pet_usage WHERE user_id IN ('u1','*')").get().n, 0);
  f.advance(DAY); assert.equal((await f.chat()).mode, 'offline');
  assert.equal((await f.call('/api/pet')).chat.used, 1);
});

test('premium colors require an active entitlement, preserve existing selection after expiry', async t => {
  const f = fixture(t, {env: aiEnv}); await f.adopt();
  await assert.rejects(f.call('/api/pet', 'PATCH', {color: 'gold'}), error => error.status === 403);
  const n = f.now();
  f.db.prepare("INSERT INTO billing_orders(id,user_id,plan,amount,currency,status,idempotency_key,created_at,expires_at) VALUES('o','u1','plus',1490,'KZT','paid','test-order',?,?)").run(n, n + DAY);
  f.db.prepare("INSERT INTO billing_entitlements(id,order_id,user_id,plan,starts_at,ends_at) VALUES('e','o','u1','plus',?,?)").run(n - 1, n + DAY);
  assert.equal((await f.call('/api/pet', 'PATCH', {color: 'gold'})).pet.color, 'gold');
  assert.equal((await f.call('/api/pet')).chat.limit, 40);
  f.advance(2 * DAY); assert.equal((await f.call('/api/pet')).pet.color, 'gold');
  assert.equal((await f.call('/api/pet', 'PATCH', {name: 'Новое имя', color: 'gold'})).pet.color, 'gold');
  await assert.rejects(f.call('/api/pet', 'PATCH', {color: 'rose'}), error => error.status === 403);
});
