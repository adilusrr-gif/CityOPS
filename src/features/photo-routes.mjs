import {id, text, choice, city, cell, point, fail} from '../domain.mjs';
import {get, all, run, audit} from './store.mjs';
import {normalizePhoto, PHOTO_INPUT_BYTES, PHOTO_OUTPUT_BYTES} from './photo-media.mjs';
import {loadProductPolicy, EXPLORATION_GRID} from '../product-policy.mjs';

const DAY = 86400000;
const PHOTO_COLUMNS = 'p.id,p.user_id,p.city_id,p.contest_id,p.title,p.caption,p.approx_lng,p.approx_lat,p.status,p.created_at,p.updated_at,p.version,p.review_reason,p.width,p.height';
// Transactions need metadata and accounting, never the potentially 512 KiB blob.
const PHOTO_MUTATION_COLUMNS = PHOTO_COLUMNS.replaceAll('p.', '') + ',cell,image_bytes';
const APPROVED = "p.status='approved' AND u.disabled=0";
const VOTES = '(SELECT count(*) FROM photo_votes v JOIN users vu ON vu.id=v.user_id WHERE v.photo_id=p.id AND vu.disabled=0)';
const RESOURCE = /^[a-zA-Z0-9_-]{1,100}$/;
const validId = value => {if (typeof value !== 'string' || !RESOURCE.test(value)) fail('Неверный идентификатор'); return value;};
const bodyObject = value => {if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Ожидается объект'); return value;};
function plain(value, label, max, min = 1) {const result = text(value, label, max, min); if (/[\p{Cc}\p{Cf}<>]/u.test(result)) fail(`${label}: используйте обычный текст`); return result;}
function admin(actor) {if (actor.role !== 'admin') fail('Недостаточно прав', 403); if (!actor.mfa_enabled || !actor.session_mfa_verified) fail('Для модерации нужен подтверждённый MFA администратора', 403);}
function version(body, row) {if (!Number.isSafeInteger(body.version) || body.version !== row.version) fail('Данные изменились. Обновите страницу.', 409);}

export function photoPhase(row, now = Date.now()) {
  if (row.status !== 'published') return 'draft';
  if (now < row.starts_at) return 'upcoming';
  if (now < row.submissions_close_at) return 'submission';
  if (now < row.votes_close_at) return 'voting';
  return 'closed';
}
function contestView(row, now, myVote = null) {
  return {id: row.id, cityId: row.city_id, title: row.title, description: row.description, status: row.status, phase: photoPhase(row, now), startsAt: row.starts_at, submissionsCloseAt: row.submissions_close_at, votesCloseAt: row.votes_close_at, version: row.version, myVote, rules: 'Красота пейзажей и мест. Один изменяемый голос на конкурс; за себя голосовать нельзя. Одинаковое число голосов даёт одинаковое место. Никаких баллов за риск, скорость или внешность людей.'};
}
function photoView(row, user, {privateFields = false} = {}) {
  const result = {id: row.id, cityId: row.city_id, contestId: row.contest_id, title: row.title, caption: row.caption, approxLng: row.approx_lng, approxLat: row.approx_lat, authorName: row.author_name || '', isMine: row.user_id === user?.id, imageUrl: row.status === 'withdrawn' ? null : `/api/photos/${row.id}/image`, createdAt: row.created_at, width: row.width, height: row.height, votes: Number(row.votes || 0)};
  if (privateFields) Object.assign(result, {status: row.status, version: row.version, reviewReason: row.review_reason, updatedAt: row.updated_at});
  return result;
}
function pageCursor(value) {
  if (!value) return null;
  try {if (value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) throw 0; const result = JSON.parse(Buffer.from(value, 'base64url').toString()); if (!result || typeof result !== 'object' || Array.isArray(result) || !Number.isSafeInteger(result.time) || result.time < 0 || typeof result.id !== 'string' || !RESOURCE.test(result.id)) throw 0; return result;}
  catch {fail('Некорректная страница');}
}
function pagination(rows, mapper) {
  const hasMore = rows.length > 40, visible = rows.slice(0, 40), last = visible.at(-1);
  return {items: visible.map(mapper), hasMore, nextCursor: hasMore ? Buffer.from(JSON.stringify({time: last.created_at, id: last.id})).toString('base64url') : null};
}
function* photoSnapshot(photoId) {const row = yield get('SELECT user_id,contest_id FROM photos WHERE id=$1', [photoId]); if (!row) fail('Фотография не найдена', 404); return row;}
function* lockContest(contestId) {if (!contestId) return null; const row = yield get('SELECT * FROM photo_contests WHERE id=$1 FOR UPDATE', [contestId]); if (!row) fail('Конкурс не найден', 404); return row;}
function* lockPhoto(photoId) {const row = yield get(`SELECT ${PHOTO_MUTATION_COLUMNS} FROM photos WHERE id=$1 FOR UPDATE`, [photoId]); if (!row) fail('Фотография не найдена', 404); return row;}
function* storageBudget() {yield run('INSERT INTO photo_storage(id,used_bytes) VALUES(1,0) ON CONFLICT(id) DO NOTHING'); return yield get('SELECT used_bytes FROM photo_storage WHERE id=1 FOR UPDATE');}
function* uploadLocation(userId, cityId, time, gps) {
  const position = yield get('SELECT lng,lat,accuracy,updated_at,city_id FROM positions WHERE user_id=$1', [userId]);
  if (!position || position.city_id !== cityId || time - position.updated_at > gps.maxAgeMs || position.updated_at > time + 5000 || !Number.isFinite(position.accuracy) || position.accuracy < 0 || position.accuracy > gps.maxAccuracyM) fail(`Обновите GPS в выбранном городе: точность до ${gps.maxAccuracyM} м, давность до ${gps.maxAgeMs / 1000} секунд`, 409);
  point(position.lng, position.lat, cityId);
  return position;
}
function* uploadQuota(userId, day, dailyLimit, retainedLimit) {
  const retained = yield get("SELECT count(*) AS n FROM photos WHERE user_id=$1 AND status<>'withdrawn'", [userId]);
  if (Number(retained.n) >= retainedLimit) fail('Лимит сохраняемых фото исчерпан. Удалите ненужный снимок.', 429);
  const usage = yield get('SELECT count FROM photo_upload_usage WHERE user_id=$1 AND day=$2', [userId, day]);
  if (usage && usage.count >= dailyLimit) fail('Дневной лимит загрузок исчерпан. Он обновится в 00:00 UTC.', 429);
}
function* eligibleVoter(actor, time, minAgeMs) {
  if (actor.created_at > time - minAgeMs) fail(`Голосование доступно аккаунтам старше ${minAgeMs / 3600000} часов`, 403);
  const activity = yield get('SELECT 1 AS eligible WHERE EXISTS(SELECT 1 FROM completions WHERE user_id=$1) OR EXISTS(SELECT 1 FROM adventure_rewards WHERE user_id=$1) OR EXISTS(SELECT 1 FROM territory_visits WHERE user_id=$1)', [actor.id]);
  if (!activity) fail('Для голосования сначала завершите квест, маршрут или отметьтесь на территории', 403);
}
function* rewardDiscovery(photo, time, policy) {
  const saved = yield run('INSERT INTO photo_discovery_rewards(user_id,city_id,cell,photo_id,xp,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,city_id,cell) DO NOTHING', [photo.user_id, photo.city_id, photo.cell, photo.id, policy.discoveryXp, time]);
  if (!saved.rowCount) return false;
  yield run('UPDATE users SET xp=xp+$2 WHERE id=$1', [photo.user_id, policy.discoveryXp]);
  const pet = yield get('SELECT user_id FROM pets WHERE user_id=$1 FOR UPDATE', [photo.user_id]);
  if (pet) {
    const reward = yield run('INSERT INTO pet_rewards(user_id,event_key,xp,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,event_key) DO NOTHING', [photo.user_id, `photo:${photo.city_id}:${photo.cell}`, policy.petXp, time]);
    if (reward.rowCount) yield run('UPDATE pets SET xp=xp+$2,updated_at=$3 WHERE user_id=$1', [photo.user_id, policy.petXp, time]);
  }
  return true;
}
function* revokeDiscovery(photo, time) {
  const reward = yield get('SELECT xp,photo_id FROM photo_discovery_rewards WHERE user_id=$1 AND city_id=$2 AND cell=$3 FOR UPDATE', [photo.user_id, photo.city_id, photo.cell]);
  if (!reward || reward.photo_id !== photo.id) return false;
  let revoked = reward.xp > 0;
  yield run('UPDATE photo_discovery_rewards SET xp=0 WHERE user_id=$1 AND city_id=$2 AND cell=$3', [photo.user_id, photo.city_id, photo.cell]);
  if (reward.xp) yield run('UPDATE users SET xp=CASE WHEN xp>=$2 THEN xp-$2 ELSE 0 END WHERE id=$1', [photo.user_id, reward.xp]);
  const pet = yield get('SELECT user_id FROM pets WHERE user_id=$1 FOR UPDATE', [photo.user_id]);
  if (pet) {
    const petReward = yield get('SELECT xp FROM pet_rewards WHERE user_id=$1 AND event_key=$2 FOR UPDATE', [photo.user_id, `photo:${photo.city_id}:${photo.cell}`]);
    if (petReward?.xp) {
      revoked = true;
      yield run('UPDATE pet_rewards SET xp=0 WHERE user_id=$1 AND event_key=$2', [photo.user_id, `photo:${photo.city_id}:${photo.cell}`]);
      yield run('UPDATE pets SET xp=CASE WHEN xp>=$2 THEN xp-$2 ELSE 0 END,updated_at=$3 WHERE user_id=$1', [photo.user_id, petReward.xp, time]);
    }
  }
  return revoked;
}

export async function prunePhotoUsage(store, {now = Date.now(), limit = 1000} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new TypeError('Invalid photo cleanup limit');
  return store.transaction(function* () {return yield run('DELETE FROM photo_upload_usage WHERE (user_id,day) IN (SELECT user_id,day FROM photo_upload_usage WHERE day<$1 ORDER BY day,user_id LIMIT $2 FOR UPDATE SKIP LOCKED)', [Math.floor(now / DAY) - 31, limit]);});
}

export function createPhotoRoutes({store, cfg = {}, env = cfg.env || process.env, now = Date.now, normalize = normalizePhoto} = {}) {
  const policy = cfg.productPolicy || loadProductPolicy(env), storageLimit = policy.photoStorageBytes;
  const dailyLimit = policy.photos.dailyUploads, retainedLimit = policy.photos.retained;
  return async function photoRoutes(ctx) {
    const {path, method, user} = ctx, url = ctx.url || new URL(path, 'http://local');
    if (!path.startsWith('/api/photos') && !path.startsWith('/api/photo-contests') && !path.startsWith('/api/admin/photos') && !path.startsWith('/api/admin/photo-contests') && !path.startsWith('/api/admin/photo-reports')) return undefined;
    const cityId = city(ctx.cityId || url.searchParams.get('city') || 'almaty').id;
    const readBody = async () => bodyObject(await ctx.readBody());
    const requireUser = () => {if (!user?.id) fail('Войдите в аккаунт', 401);};

    if (path === '/api/photos' && method === 'GET') {
      const cursor = pageCursor(url.searchParams.get('cursor')), contestId = url.searchParams.get('contestId');
      if (contestId) validId(contestId);
      return store.read(function* () {
        if (contestId) {const contest = yield get("SELECT id FROM photo_contests WHERE id=$1 AND city_id=$2 AND status='published'", [contestId, cityId]); if (!contest) fail('Конкурс не найден', 404);}
        const params = [cityId], conditions = [APPROVED, 'p.city_id=$1'];
        if (contestId) {params.push(contestId); conditions.push(`p.contest_id=$${params.length}`);}
        if (cursor) {params.push(cursor.time, cursor.id); conditions.push(`(p.created_at<$${params.length - 1} OR (p.created_at=$${params.length - 1} AND p.id<$${params.length}))`);}
        const rows = yield all(`SELECT ${PHOTO_COLUMNS},u.name AS author_name,${VOTES} AS votes FROM photos p JOIN users u ON u.id=p.user_id WHERE ${conditions.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC LIMIT 41`, params);
        return {...pagination(rows, row => photoView(row, user)), notice: 'Публикуются только одобренные снимки. Место округлено до игровой ячейки; GPS не доказывает авторство или присутствие.'};
      });
    }
    if (path === '/api/photos/mine' && method === 'GET') {
      requireUser(); const cursor = pageCursor(url.searchParams.get('cursor'));
      return store.transaction(function* () {
        yield* store.requireActor(user);
        const params = [user.id], conditions = ['p.user_id=$1'];
        if (cursor) {params.push(cursor.time, cursor.id); conditions.push('(p.created_at<$2 OR (p.created_at=$2 AND p.id<$3))');}
        const rows = yield all(`SELECT ${PHOTO_COLUMNS},u.name AS author_name,${VOTES} AS votes FROM photos p JOIN users u ON u.id=p.user_id WHERE ${conditions.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC LIMIT 41`, params);
        const usage = yield get('SELECT count FROM photo_upload_usage WHERE user_id=$1 AND day=$2', [user.id, Math.floor(now() / DAY)]);
        return {...pagination(rows, row => photoView(row, user, {privateFields: true})), limits: {inputBytes: PHOTO_INPUT_BYTES, outputBytes: PHOTO_OUTPUT_BYTES, daily: dailyLimit, usedToday: usage?.count || 0, retained: retainedLimit}};
      });
    }
    if (path === '/api/photos' && method === 'POST') {
      requireUser(); await ctx.throttle(`photo-upload:${user.id}`, 10);
      const body = await readBody(), title = plain(body.title, 'Название', 100), caption = plain(body.caption || '', 'Описание', 500, 0), uploadCity = city(body.cityId || cityId).id, contestId = body.contestId ? validId(body.contestId) : null;
      if (body.rightsAttested !== true || body.placeOnlyAttested !== true) fail('Подтвердите авторство, право публикации и фотографию места без портретов людей');
      // Cheap admission checks happen before bounded CPU work. Recheck everything
      // transactionally after decoding: concurrent uploads can consume quotas and
      // GPS/contest deadlines can expire while waiting. No lock spans image work.
      await store.transaction(function* () {
        yield* store.requireActor(user); const time = now();
        if (contestId) {
          const contest = yield get('SELECT * FROM photo_contests WHERE id=$1', [contestId]);
          if (!contest) fail('Конкурс не найден', 404);
          if (contest.city_id !== uploadCity || photoPhase(contest, time) !== 'submission') fail('Приём фотографий на этот конкурс сейчас закрыт', 409);
        }
        yield* uploadLocation(user.id, uploadCity, time, policy.gps);
        yield* uploadQuota(user.id, Math.floor(time / DAY), dailyLimit, retainedLimit);
        const budget = yield get('SELECT used_bytes FROM photo_storage WHERE id=1');
        if (budget && budget.used_bytes >= storageLimit) fail('Хранилище фотографий пилота заполнено. Сообщите организатору.', 507);
      });
      const image = await normalize(body.imageBase64);
      return store.transaction(function* () {
        yield* store.requireActor(user); const contest = yield* lockContest(contestId), time = now();
        // This is the submission acceptance point. A request that waited for a
        // contest lock must use the clock after acquisition, not arrival time.
        if (contest && (contest.city_id !== uploadCity || photoPhase(contest, time) !== 'submission')) fail('Приём фотографий на этот конкурс сейчас закрыт', 409);
        const position = yield* uploadLocation(user.id, uploadCity, time, policy.gps);
        const duplicate = yield get('SELECT id FROM photos WHERE user_id=$1 AND image_sha256=$2 LIMIT 1', [user.id, image.image_sha256]);
        if (duplicate) fail('Эта фотография уже была отправлена. Повторная загрузка не создаёт новое открытие.', 409);
        const day = Math.floor(time / DAY);
        yield* uploadQuota(user.id, day, dailyLimit, retainedLimit);
        yield run('INSERT INTO photo_upload_usage(user_id,day,count) VALUES($1,$2,0) ON CONFLICT(user_id,day) DO NOTHING', [user.id, day]);
        const usage = yield get('SELECT count FROM photo_upload_usage WHERE user_id=$1 AND day=$2 FOR UPDATE', [user.id, day]);
        if (usage.count >= dailyLimit) fail('Дневной лимит загрузок исчерпан. Он обновится в 00:00 UTC.', 429);
        const budget = yield* storageBudget();
        if (budget.used_bytes + image.image_bytes > storageLimit) fail('Хранилище фотографий пилота заполнено. Сообщите организатору.', 507);
        const photoId = id(), photoCell = cell(position.lng, position.lat), [cx, cy] = photoCell.split(':').map(Number);
        yield run('INSERT INTO photos(id,user_id,city_id,contest_id,title,caption,cell,approx_lng,approx_lat,status,image_base64,image_bytes,image_sha256,width,height,created_at,updated_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16,1)', [photoId, user.id, uploadCity, contestId, title, caption, photoCell, (cx + 0.5) * EXPLORATION_GRID.lngCellSize, (cy + 0.5) * EXPLORATION_GRID.latCellSize, 'pending', image.image_base64, image.image_bytes, image.image_sha256, image.width, image.height, time]);
        yield run('UPDATE photo_upload_usage SET count=count+1 WHERE user_id=$1 AND day=$2', [user.id, day]);
        yield run('UPDATE photo_storage SET used_bytes=used_bytes+$1 WHERE id=1', [image.image_bytes]);
        yield audit(user.id, 'photo.submitted', photoId, {cityId: uploadCity, contestId, bytes: image.image_bytes});
        return {photo: photoView(yield get(`SELECT ${PHOTO_MUTATION_COLUMNS} FROM photos WHERE id=$1`, [photoId]), user, {privateFields: true}), rewarded: false};
      });
    }
    const mediaMatch = path.match(/^\/api\/photos\/([a-zA-Z0-9_-]+)\/image$/);
    if (mediaMatch && method === 'GET') {
      validId(mediaMatch[1]);
      const readMedia = user?.id ? store.transaction : store.read;
      const result = await readMedia(function* () {
        const snapshot = yield get('SELECT p.user_id,p.status,u.disabled FROM photos p JOIN users u ON u.id=p.user_id WHERE p.id=$1', [mediaMatch[1]]);
        if (!snapshot || snapshot.status === 'withdrawn') fail('Фотография не найдена', 404);
        let privateAccess = false;
        if (snapshot.status !== 'approved' || snapshot.disabled) {
          if (!user?.id) fail('Фотография не найдена', 404);
          const actor = yield* store.requireActor(user);
          if (actor.id !== snapshot.user_id) admin(actor);
          privateAccess = true;
        }
        // Read the blob only after authorization. Re-evaluate public visibility
        // in this same SELECT so a concurrent rejection between the two reads
        // cannot leak a now-private image under READ COMMITTED isolation.
        const photo = yield get(`SELECT p.image_base64,p.image_bytes FROM photos p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND p.status<>'withdrawn'${privateAccess ? '' : ` AND ${APPROVED}`}`, [mediaMatch[1]]);
        if (!photo?.image_base64) fail('Фотография не найдена', 404);
        return photo;
      });
      const bytes = Buffer.from(result.image_base64, 'base64');
      ctx.res.writeHead(200, {'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="place.jpg"'});
      ctx.res.end(bytes); return {sent: true};
    }
    const ownPhoto = path.match(/^\/api\/photos\/([a-zA-Z0-9_-]+)$/);
    if (ownPhoto && method === 'DELETE') {
      requireUser(); const body = await readBody();
      return store.transaction(function* () {
        yield* store.requireActor(user); const snapshot = yield* photoSnapshot(ownPhoto[1]);
        if (snapshot.user_id !== user.id) fail('Можно удалить только свою фотографию', 403);
        yield* lockContest(snapshot.contest_id); const photo = yield* lockPhoto(ownPhoto[1]);
        if (photo.status === 'withdrawn') return {ok: true, idempotent: true};
        version(body, photo); const budget = yield* storageBudget();
        if (budget.used_bytes < photo.image_bytes) throw new Error('Photo storage accounting mismatch');
        yield run('DELETE FROM photo_votes WHERE photo_id=$1', [photo.id]);
        yield run("UPDATE photos SET status='withdrawn',image_base64=NULL,image_bytes=0,version=version+1,updated_at=$2 WHERE id=$1", [photo.id, now()]);
        yield run('UPDATE photo_storage SET used_bytes=used_bytes-$1 WHERE id=1', [photo.image_bytes]);
        yield audit(user.id, 'photo.withdrawn', photo.id);
        return {ok: true, idempotent: false};
      });
    }
    const reportMatch = path.match(/^\/api\/photos\/([a-zA-Z0-9_-]+)\/report$/);
    if (reportMatch && method === 'POST') {
      requireUser(); await ctx.throttle(`photo-report:${user.id}`, 10); const body = await readBody(), reason = plain(body.reason, 'Причина жалобы', 500, 5);
      return store.transaction(function* () {
        yield* store.requireActor(user);
        const photo = yield get(`SELECT p.id FROM photos p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND ${APPROVED}`, [reportMatch[1]]);
        if (!photo) fail('Фотография не найдена', 404);
        const saved = yield run("INSERT INTO photo_reports(id,photo_id,user_id,reason,status,created_at) VALUES($1,$2,$3,$4,'open',$5) ON CONFLICT(photo_id,user_id) DO NOTHING", [id(), photo.id, user.id, reason, now()]);
        if (saved.rowCount) yield audit(user.id, 'photo.reported', photo.id);
        return {ok: true, idempotent: !saved.rowCount};
      });
    }
    if ((path === '/api/photo-contests' || path === '/api/admin/photo-contests') && method === 'GET') {
      const managing = path.includes('/admin/'); if (managing) requireUser();
      const readContests = managing ? store.transaction : store.read;
      return readContests(function* () {
        if (managing) admin(yield* store.requireActor(user, ['admin']));
        const rows = yield all(`SELECT * FROM photo_contests WHERE city_id=$1${managing ? '' : " AND status='published'"} ORDER BY starts_at DESC,id LIMIT 100`, [cityId]);
        const votes = user && rows.length ? yield all(`SELECT contest_id,photo_id FROM photo_votes WHERE user_id=$1 AND contest_id IN (${rows.map((row, index) => `$${index + 2}`).join(',')})`, [user.id, ...rows.map(row => row.id)]) : [];
        return {items: rows.map(row => contestView(row, now(), votes.find(v => v.contest_id === row.id)?.photo_id || null))};
      });
    }
    const contestMatch = path.match(/^\/api\/photo-contests\/([a-zA-Z0-9_-]+)$/);
    if (contestMatch && method === 'GET') return store.read(function* () {
      const contest = yield get("SELECT * FROM photo_contests WHERE id=$1 AND status='published'", [contestMatch[1]]);
      if (!contest) fail('Конкурс не найден', 404);
      const rows = yield all(`SELECT ${PHOTO_COLUMNS},u.name AS author_name,${VOTES} AS votes FROM photos p JOIN users u ON u.id=p.user_id WHERE p.contest_id=$1 AND ${APPROVED} ORDER BY votes DESC,p.created_at,p.id LIMIT 100`, [contest.id]);
      const total = yield get(`SELECT count(*) AS n FROM photos p JOIN users u ON u.id=p.user_id WHERE p.contest_id=$1 AND ${APPROVED}`, [contest.id]);
      let rank = 0, previous = null;
      const leaderboard = rows.map((row, index) => {const votes = Number(row.votes); if (votes !== previous) rank = index + 1; previous = votes; return {...photoView(row, user), rank};});
      const ownVote = user ? yield get('SELECT photo_id FROM photo_votes WHERE contest_id=$1 AND user_id=$2', [contest.id, user.id]) : null;
      return {contest: contestView(contest, now(), ownVote?.photo_id || null), leaderboard, myVote: ownVote?.photo_id || null, total: Number(total.n), provisional: photoPhase(contest, now()) !== 'closed'};
    });
    const voteMatch = path.match(/^\/api\/photo-contests\/([a-zA-Z0-9_-]+)\/vote$/);
    if (voteMatch && method === 'POST') {
      requireUser(); await ctx.throttle(`photo-vote:${user.id}`, 20); const body = await readBody(), photoId = validId(body.photoId);
      return store.transaction(function* () {
        const actor = yield* store.requireActor(user), contest = yield* lockContest(voteMatch[1]);
        const photo = yield* lockPhoto(photoId), time = now();
        // Both contested resources are locked before evaluating the deadline.
        if (photoPhase(contest, time) !== 'voting') fail('Голосование сейчас закрыто', 409);
        yield* eligibleVoter(actor, time, policy.photos.voterMinAgeMs);
        const owner = yield get('SELECT disabled FROM users WHERE id=$1', [photo.user_id]);
        if (photo.contest_id !== contest.id || photo.status !== 'approved' || owner?.disabled) fail('Фотография не участвует в этом конкурсе', 409);
        if (photo.user_id === actor.id) fail('Нельзя голосовать за свою фотографию', 403);
        const old = yield get('SELECT photo_id FROM photo_votes WHERE contest_id=$1 AND user_id=$2', [contest.id, actor.id]);
        if (old?.photo_id === photoId) return {ok: true, myVote: photoId, idempotent: true};
        yield run('INSERT INTO photo_votes(contest_id,user_id,photo_id,created_at,updated_at) VALUES($1,$2,$3,$4,$4) ON CONFLICT(contest_id,user_id) DO UPDATE SET photo_id=excluded.photo_id,updated_at=excluded.updated_at', [contest.id, actor.id, photoId, time]);
        yield audit(actor.id, 'photo.vote_cast', contest.id, {photoId});
        return {ok: true, myVote: photoId, idempotent: false};
      });
    }
    if (path === '/api/admin/photos' && method === 'GET') {
      requireUser(); const status = choice(url.searchParams.get('status') || 'pending', ['pending', 'approved', 'rejected', 'withdrawn'], 'статус'), cursor = pageCursor(url.searchParams.get('cursor'));
      return store.transaction(function* () {
        admin(yield* store.requireActor(user, ['admin']));
        const params = [cityId, status], conditions = ['p.city_id=$1', 'p.status=$2'];
        if (cursor) {params.push(cursor.time, cursor.id); conditions.push('(p.created_at<$3 OR (p.created_at=$3 AND p.id<$4))');}
        const rows = yield all(`SELECT ${PHOTO_COLUMNS},u.name AS author_name FROM photos p JOIN users u ON u.id=p.user_id WHERE ${conditions.join(' AND ')} ORDER BY p.created_at DESC,p.id DESC LIMIT 41`, params);
        const budget = yield get('SELECT used_bytes FROM photo_storage WHERE id=1');
        return {...pagination(rows, row => photoView(row, user, {privateFields: true})), storage: {usedBytes: budget?.used_bytes || 0, limitBytes: storageLimit}};
      });
    }
    const reviewMatch = path.match(/^\/api\/admin\/photos\/([a-zA-Z0-9_-]+)$/);
    if (reviewMatch && method === 'GET') {
      requireUser(); return store.transaction(function* () {
        admin(yield* store.requireActor(user, ['admin']));
        const row = yield get(`SELECT ${PHOTO_COLUMNS},u.name AS author_name,${VOTES} AS votes FROM photos p JOIN users u ON u.id=p.user_id WHERE p.id=$1`, [reviewMatch[1]]);
        if (!row) fail('Фотография не найдена', 404);
        return {photo: photoView(row, user, {privateFields: true})};
      });
    }
    if (reviewMatch && method === 'PATCH') {
      requireUser(); const body = await readBody(), status = choice(body.status, ['approved', 'rejected'], 'статус'), reason = plain(body.reason, 'Обоснование модерации', 500, 3);
      return store.transaction(function* () {
        const snapshot = yield* photoSnapshot(reviewMatch[1]), actor = yield* store.requireActor(user, ['admin'], [snapshot.user_id]); admin(actor);
        const contest = yield* lockContest(snapshot.contest_id), photo = yield* lockPhoto(reviewMatch[1]);
        if (photo.status === 'withdrawn') fail('Фотография удалена владельцем', 409);
        version(body, photo);
        if (photo.status === status) return {photo: photoView(photo, user, {privateFields: true}), idempotent: true, rewarded: false};
        // The ballot set is fixed before voting opens. Emergency rejection and
        // removal remain possible at any time; late approval cannot alter it.
        if (status === 'approved' && contest && now() >= contest.submissions_close_at) fail('Одобрить конкурсное фото можно только до начала голосования', 409);
        const owner = yield get('SELECT disabled FROM users WHERE id=$1', [photo.user_id]);
        if (status === 'approved' && owner?.disabled) fail('Аккаунт автора отключён', 409);
        const time = now();
        yield run('UPDATE photos SET status=$2,reviewed_by=$3,review_reason=$4,updated_at=$5,version=version+1 WHERE id=$1', [photo.id, status, actor.id, reason, time]);
        let rewarded = false, revoked = false;
        if (status === 'approved') rewarded = yield* rewardDiscovery(photo, time, policy.photos);
        else {yield run('DELETE FROM photo_votes WHERE photo_id=$1', [photo.id]); revoked = yield* revokeDiscovery(photo, time);}
        yield audit(actor.id, `photo.${status}`, photo.id, {rewarded, revoked});
        return {photo: photoView(yield get(`SELECT ${PHOTO_MUTATION_COLUMNS} FROM photos WHERE id=$1`, [photo.id]), user, {privateFields: true}), idempotent: false, rewarded, revoked};
      });
    }
    const editContest = path.match(/^\/api\/admin\/photo-contests\/([a-zA-Z0-9_-]+)$/);
    if ((path === '/api/admin/photo-contests' && method === 'POST') || (editContest && method === 'PATCH')) {
      requireUser(); const body = await readBody();
      return store.transaction(function* () {
        const actor = yield* store.requireActor(user, ['admin']); admin(actor); const previous = editContest ? yield* lockContest(editContest[1]) : null, time = now(), contestId = previous?.id || id();
        if (previous) version(body, previous);
        const value = {city_id: city(body.cityId ?? previous?.city_id ?? cityId).id, title: plain(body.title ?? previous?.title, 'Название', 100), description: plain(body.description ?? previous?.description ?? '', 'Описание', 1000, 0), status: choice(body.status ?? previous?.status ?? 'draft', ['draft', 'published'], 'статус'), starts_at: body.startsAt ?? previous?.starts_at, submissions_close_at: body.submissionsCloseAt ?? previous?.submissions_close_at, votes_close_at: body.votesCloseAt ?? previous?.votes_close_at};
        if (![value.starts_at, value.submissions_close_at, value.votes_close_at].every(Number.isSafeInteger) || value.starts_at < 0 || !(value.starts_at < value.submissions_close_at && value.submissions_close_at < value.votes_close_at) || value.votes_close_at - value.starts_at > 90 * DAY) fail('Укажите UTC-сроки: начало < конец приёма < конец голосования; длительность до 90 дней');
        if (!previous && value.votes_close_at <= time) fail('Новый конкурс должен завершаться в будущем');
        if (previous?.status === 'draft' && value.status === 'published' && value.votes_close_at <= time) fail('Перед публикацией обновите истёкшие сроки конкурса');
        if (previous) {
          const submitted = yield get('SELECT 1 AS n FROM photos WHERE contest_id=$1 LIMIT 1', [previous.id]);
          if (submitted && ['city_id', 'starts_at', 'submissions_close_at', 'votes_close_at'].some(key => value[key] !== previous[key])) fail('После первой заявки город и сроки конкурса неизменны', 409);
          yield run('UPDATE photo_contests SET city_id=$2,title=$3,description=$4,status=$5,starts_at=$6,submissions_close_at=$7,votes_close_at=$8,version=version+1,updated_at=$9 WHERE id=$1', [previous.id, value.city_id, value.title, value.description, value.status, value.starts_at, value.submissions_close_at, value.votes_close_at, time]);
        } else yield run('INSERT INTO photo_contests(id,city_id,title,description,status,starts_at,submissions_close_at,votes_close_at,version,created_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$10)', [contestId, value.city_id, value.title, value.description, value.status, value.starts_at, value.submissions_close_at, value.votes_close_at, actor.id, time]);
        const saved = yield get('SELECT * FROM photo_contests WHERE id=$1', [contestId]);
        yield audit(actor.id, previous ? 'photo.contest_updated' : 'photo.contest_created', saved.id, {status: value.status});
        return {contest: contestView(saved, time)};
      });
    }
    if (path === '/api/admin/photo-reports' && method === 'GET') {
      requireUser(); return store.transaction(function* () {admin(yield* store.requireActor(user, ['admin'])); return {items: yield all("SELECT r.id,r.photo_id AS photo_id,r.reason,r.status,r.created_at,p.title,p.status AS photo_status,p.version AS photo_version FROM photo_reports r JOIN photos p ON p.id=r.photo_id WHERE r.status='open' AND p.city_id=$1 ORDER BY r.created_at,r.id LIMIT 100", [cityId])};});
    }
    const reportReview = path.match(/^\/api\/admin\/photo-reports\/([a-zA-Z0-9_-]+)$/);
    if (reportReview && method === 'PATCH') {
      requireUser(); const body = await readBody(); if (body.status !== 'resolved') fail('Нужен статус resolved');
      return store.transaction(function* () {
        const actor = yield* store.requireActor(user, ['admin']); admin(actor);
        const row = yield get('SELECT * FROM photo_reports WHERE id=$1 FOR UPDATE', [reportReview[1]]); if (!row) fail('Жалоба не найдена', 404);
        if (row.status === 'resolved') return {ok: true, idempotent: true};
        yield run("UPDATE photo_reports SET status='resolved',reviewed_by=$2,reviewed_at=$3 WHERE id=$1", [row.id, actor.id, now()]);
        yield audit(actor.id, 'photo.report_resolved', row.id);
        return {ok: true, idempotent: false};
      });
    }
    return undefined;
  };
}
