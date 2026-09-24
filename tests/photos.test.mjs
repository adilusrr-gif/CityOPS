import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {openDb} from '../src/db.mjs';
import {createFeatureStore} from '../src/features/store.mjs';
import {createPhotoRoutes, prunePhotoUsage} from '../src/features/photo-routes.mjs';
import {normalizePhoto, inspectStoredPhoto, PHOTO_INPUT_BYTES} from '../src/features/photo-media.mjs';

const DAY = 86400000;
async function picture(color = '#38547b', options = {}) {return (await sharp({create: {width: 120, height: 80, channels: 3, background: color}}).withMetadata(options).jpeg().toBuffer()).toString('base64');}
function fixture(t, env = {}) {
  const db = openDb(':memory:', {withSnapshot: false}); t.after(() => db.close());
  let time = Date.now(), failAudit = false, resumeHook = null;
  const cfg = {idleMs: 60 * DAY}, store = createFeatureStore({db, cfg, dialect: 'sqlite', audit(_db, actor, action) {if (failAudit && action.startsWith('photo.')) throw new Error('audit unavailable');}});
  // Deterministic scheduling seam: advance the clock when a SQL operation
  // resumes. This checks time-of-use logic, not native PostgreSQL concurrency.
  const routedStore = {...store, transaction(work) {
    return store.transaction(function* () {
      const iterator = work(); let step = iterator.next();
      while (!step.done) {
        const op = step.value, result = yield op;
        if (resumeHook) resumeHook(op);
        step = iterator.next(result);
      }
      return step.value;
    });
  }};
  const route = createPhotoRoutes({store: routedStore, cfg, env, now: () => time});
  const actors = {};
  for (const uid of ['alice', 'bob', 'voter', 'newbie', 'admin']) {
    const role = uid === 'admin' ? 'admin' : 'player';
    db.prepare('INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled) VALUES(?,?,?,\'unused\',?,?,?)').run(uid, uid + '@example.test', uid, role, uid === 'newbie' ? time : time - 3 * DAY, uid === 'admin' ? 1 : 0);
    db.prepare('INSERT INTO sessions(token,user_id,expires,id,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,?)').run(uid + '-token', uid, time + 60 * DAY, uid + '-session', time, time, uid === 'admin' ? 1 : 0);
    actors[uid] = {id: uid, role, session_id: uid + '-session'};
    db.prepare("INSERT INTO positions(user_id,lng,lat,accuracy,updated_at,city_id) VALUES(?,76.9471234,43.2492345,5,?,'almaty')").run(uid, time);
  }
  const call = (path, method = 'GET', body = {}, uid = 'alice', res) => {
    const url = new URL(path, 'http://local');
    return route({path: url.pathname, url, method, user: actors[uid], res, readBody: async () => body, throttle: async () => {}});
  };
  const upload = async (uid = 'alice', color = '#38547b', extra = {}) => call('/api/photos', 'POST', {title: 'Новое место', caption: 'Пейзаж', rightsAttested: true, placeOnlyAttested: true, imageBase64: await picture(color), ...extra}, uid);
  const review = (photo, status = 'approved', extra = {}) => call(`/api/admin/photos/${photo.id}`, 'PATCH', {status, version: photo.version, reason: 'Снимок проверен оператором', ...extra}, 'admin');
  const contest = async () => (await call('/api/admin/photo-contests', 'POST', {title: 'Красота мест', description: 'Городской фотоконкурс', cityId: 'almaty', startsAt: time - 1000, submissionsCloseAt: time + DAY, votesCloseAt: time + 2 * DAY, status: 'published'}, 'admin')).contest;
  const activity = uid => {const quest = db.prepare('SELECT id FROM quests LIMIT 1').get(); db.prepare('INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES(?,?,100,?)').run(uid, quest.id, time);};
  return {db, store, call, upload, review, contest, activity, now: () => time, advance(ms) {time += ms; db.prepare('UPDATE positions SET updated_at=?').run(time);}, setClock(value) {time = value;}, blockAudit(value = true) {failAudit = value;}, onResume(callback) {resumeHook = callback;}};
}

test('media normalizer rotates orientation, drops all metadata and validates bounded canonical JPEGs', async () => {
  const photo = await normalizePhoto(await picture('#123456', {orientation: 6}));
  assert.equal(photo.width, 80); assert.equal(photo.height, 120);
  const metadata = await sharp(Buffer.from(photo.image_base64, 'base64')).metadata();
  assert.equal(metadata.format, 'jpeg'); assert.equal(metadata.orientation, undefined); assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
  assert.equal(await inspectStoredPhoto({...photo, status: 'pending'}), true);
  await assert.rejects(inspectStoredPhoto({...photo, status: 'pending', image_bytes: photo.image_bytes + 1}));
  await assert.rejects(inspectStoredPhoto({...photo, status: 'withdrawn'}));
  assert.equal(await inspectStoredPhoto({...photo, status: 'withdrawn', image_base64: null, image_bytes: 0}), true);
});

test('media parser rejects malformed/base64 abuse, active formats, animation and pixel bombs', async () => {
  for (const value of ['!!!!', 'Zg===', 'Zg', 'Zg==\n', 'A'.repeat(4 * Math.ceil(PHOTO_INPUT_BYTES / 3) + 50), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>').toString('base64'), 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7']) await assert.rejects(normalizePhoto(value), error => error.status === 400);
  const jpeg = Buffer.from(await picture(), 'base64'), marker = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(marker > 0); jpeg.writeUInt16BE(4000, marker + 5); jpeg.writeUInt16BE(4000, marker + 7);
  await assert.rejects(normalizePhoto(jpeg.toString('base64')), error => error.status === 400);
  const frames = Buffer.alloc(2 * 4 * 3); frames.fill(255, 12);
  const animatedWebp = await sharp(frames, {raw: {width: 2, height: 4, channels: 3, pageHeight: 2}}).webp({loop: 0, delay: [100, 100]}).toBuffer();
  assert.equal((await sharp(animatedWebp).metadata()).pages, 2);
  await assert.rejects(normalizePhoto(animatedWebp.toString('base64')), error => error.status === 400);
});

test('photos require consent and fresh server GPS, hide raw coordinates and remain private before review', async t => {
  const f = fixture(t), imageBase64 = await picture();
  await assert.rejects(f.upload('alice', '#123456', {rightsAttested: false}), error => error.status === 400);
  f.db.prepare('UPDATE positions SET accuracy=90 WHERE user_id=\'alice\'').run();
  await assert.rejects(f.upload(), error => error.status === 409);
  f.db.prepare('UPDATE positions SET accuracy=5,updated_at=? WHERE user_id=\'alice\'').run(f.now() - 100000);
  await assert.rejects(f.upload(), error => error.status === 409);
  f.db.prepare('UPDATE positions SET updated_at=? WHERE user_id=\'alice\'').run(f.now());
  const {photo} = await f.upload(); assert.equal(photo.status, 'pending'); assert.equal(photo.isMine, true);
  assert.notEqual(photo.approxLng, 76.9471234); assert.notEqual(photo.approxLat, 43.2492345);
  assert.equal((await f.call('/api/photos', 'GET', {}, 'anonymous')).items.length, 0);
  await assert.rejects(f.call(`/api/photos/${photo.id}/image`, 'GET', {}, 'anonymous'), error => error.status === 404);
  await assert.rejects(f.call(`/api/photos/${photo.id}/image`, 'GET', {}, 'bob'), error => error.status === 403);
  let headers, bytes;
  await f.call(`/api/photos/${photo.id}/image`, 'GET', {}, 'alice', {writeHead(status, value) {assert.equal(status, 200); headers = value;}, end(value) {bytes = value;}});
  assert.equal(headers['Content-Type'], 'image/jpeg'); assert.ok(bytes.length);
  await assert.rejects(f.call('/api/photos', 'POST', {title: 'Копия', imageBase64, rightsAttested: true, placeOnlyAttested: true}), error => error.status === 409);
});

test('approval and rejection update player/pet XP once per cell; privacy withdrawal does not farm rewards', async t => {
  const f = fixture(t);
  f.db.prepare("INSERT INTO pets(user_id,name,species,color,xp,created_at,updated_at,chat_epoch) VALUES('alice','Друг','fox','mint',0,?,?,0)").run(f.now(), f.now());
  const initial = (await f.upload()).photo, approved = await f.review(initial); assert.equal(approved.rewarded, true);
  const second = (await f.upload('alice', '#124658')).photo; assert.equal((await f.review(second)).rewarded, false);
  assert.equal(f.db.prepare("SELECT xp FROM users WHERE id='alice'").get().xp, 20);
  assert.equal(f.db.prepare("SELECT xp FROM pets WHERE user_id='alice'").get().xp, 10);
  await assert.rejects(f.review(initial), error => error.status === 409);
  assert.equal((await f.review(approved.photo)).idempotent, true);
  const rejected = await f.review(approved.photo, 'rejected'); assert.equal(rejected.revoked, true);
  assert.equal(f.db.prepare("SELECT xp FROM users WHERE id='alice'").get().xp, 0);
  assert.equal(f.db.prepare("SELECT xp FROM pets WHERE user_id='alice'").get().xp, 0);
  const reinstated = await f.review(rejected.photo); assert.equal(reinstated.rewarded, false);
  await f.call(`/api/photos/${initial.id}`, 'DELETE', {version: reinstated.photo.version});
  const third = (await f.upload('alice', '#efef12')).photo; assert.equal((await f.review(third)).rewarded, false);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM photo_discovery_rewards').get().n, 1);
});

test('daily and retained quotas survive deletion; storage and accounting roll back on failed audit', async t => {
  const f = fixture(t, {PHOTO_DAILY_UPLOAD_LIMIT: '2', PHOTO_RETAINED_LIMIT: '1'});
  const first = (await f.upload()).photo, used = f.db.prepare('SELECT used_bytes FROM photo_storage').get().used_bytes;
  assert.ok(used > 0);
  await assert.rejects(f.upload('alice', '#000001'), error => error.status === 429);
  await f.call(`/api/photos/${first.id}`, 'DELETE', {version: first.version});
  assert.equal(f.db.prepare('SELECT used_bytes FROM photo_storage').get().used_bytes, 0);
  const second = (await f.upload('alice', '#000001')).photo;
  await f.call(`/api/photos/${second.id}`, 'DELETE', {version: second.version});
  await assert.rejects(f.upload('alice', '#abcdef'), error => error.status === 429);
  f.advance(DAY); f.blockAudit();
  await assert.rejects(f.upload('alice', '#abcdef'), /audit unavailable/);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM photos WHERE status<>'withdrawn'").get().n, 0);
  assert.equal(f.db.prepare('SELECT used_bytes FROM photo_storage').get().used_bytes, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM photo_upload_usage WHERE day=?').get(Math.floor(f.now() / DAY)).n, 0);
  f.blockAudit(false); await f.upload('alice', '#abcdef');
  f.advance(40 * DAY); assert.equal((await prunePhotoUsage(f.store, {now: f.now(), limit: 1})).rowCount, 1);
});

test('shared storage quota is charged transactionally and can be released without resetting upload quota', async t => {
  const f = fixture(t, {PHOTO_STORAGE_LIMIT_MB: '1'});
  f.db.prepare('INSERT INTO photo_storage(id,used_bytes) VALUES(1,1048576)').run();
  await assert.rejects(f.upload(), error => error.status === 507);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM photos').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM photo_upload_usage').get().n, 0);
});

test('contest phases, immutable entry periods, activity eligibility, single ballot and equal ranks are enforced', async t => {
  const f = fixture(t), contest = await f.contest();
  assert.equal(contest.phase, 'submission');
  const a = (await f.upload('alice', '#001122', {contestId: contest.id})).photo, b = (await f.upload('bob', '#223344', {contestId: contest.id})).photo;
  const approvedA = (await f.review(a)).photo; await f.review(b);
  await assert.rejects(f.call(`/api/admin/photo-contests/${contest.id}`, 'PATCH', {version: 1, votesCloseAt: f.now() + 3 * DAY}, 'admin'), error => error.status === 409);
  await assert.rejects(f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: a.id}, 'voter'), error => error.status === 409);
  const before = await f.call(`/api/photo-contests/${contest.id}`); assert.deepEqual(before.leaderboard.map(p => p.rank), [1, 1]);
  f.advance(DAY); f.activity('alice'); f.activity('newbie');
  f.db.prepare('UPDATE users SET created_at=? WHERE id=\'newbie\'').run(f.now());
  await assert.rejects(f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: a.id}, 'alice'), error => error.status === 403);
  await assert.rejects(f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: a.id}, 'voter'), error => error.status === 403);
  await assert.rejects(f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: a.id}, 'newbie'), error => error.status === 403);
  f.activity('voter'); await f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: a.id}, 'voter');
  assert.equal((await f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: a.id}, 'voter')).idempotent, true);
  await f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: b.id}, 'voter');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM photo_votes').get().n, 1);
  f.advance(DAY);
  await assert.rejects(f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: a.id}, 'voter'), error => error.status === 409);
  assert.equal((await f.call(`/api/photo-contests/${contest.id}`)).leaderboard[0].id, b.id);
  await f.review(approvedA, 'rejected');
  assert.equal((await f.call(`/api/photo-contests/${contest.id}`)).leaderboard.length, 1);
});

test('moderation closes the ballot before voting and disabled accounts cannot contribute public photos or votes', async t => {
  const f = fixture(t), contest = await f.contest();
  const pending = (await f.upload('alice', '#101010', {contestId: contest.id})).photo, approved = (await f.upload('bob', '#202020', {contestId: contest.id})).photo;
  await f.review(approved); f.advance(DAY);
  await assert.rejects(f.review(pending), error => error.status === 409);
  f.activity('voter'); await f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: approved.id}, 'voter');
  f.db.prepare("UPDATE users SET disabled=1 WHERE id='voter'").run();
  assert.equal((await f.call(`/api/photo-contests/${contest.id}`)).leaderboard[0].votes, 0);
  f.db.prepare("UPDATE users SET disabled=1 WHERE id='bob'").run();
  assert.equal((await f.call('/api/photos')).items.length, 0);
  await assert.rejects(f.call(`/api/photos/${approved.id}/image`, 'GET', {}, 'anonymous'), error => error.status === 404);
});

test('same-millisecond contest creation returns each exact ID and reports require accountable moderation', async t => {
  const f = fixture(t), a = await f.contest(), b = await f.contest();
  assert.notEqual(a.id, b.id);
  assert.ok(f.db.prepare('SELECT id FROM photo_contests WHERE id=?').get(b.id));
  const photo = (await f.review((await f.upload()).photo)).photo;
  await f.call(`/api/photos/${photo.id}/report`, 'POST', {reason: 'Проверить право публикации'}, 'bob');
  assert.equal((await f.call(`/api/photos/${photo.id}/report`, 'POST', {reason: 'Повторный запрос проверки'}, 'bob')).idempotent, true);
  await assert.rejects(f.call('/api/admin/photo-reports', 'GET', {}, 'bob'), error => error.status === 403);
  const report = (await f.call('/api/admin/photo-reports', 'GET', {}, 'admin')).items[0];
  assert.equal(report.photo_id, photo.id);
  assert.equal((await f.call(`/api/admin/photos/${photo.id}`, 'GET', {}, 'admin')).photo.id, photo.id);
  await f.call(`/api/admin/photo-reports/${report.id}`, 'PATCH', {status: 'resolved'}, 'admin');
  assert.deepEqual((await f.call('/api/admin/photo-reports', 'GET', {}, 'admin')).items, []);
  f.db.prepare("UPDATE sessions SET mfa_verified=0 WHERE user_id='admin'").run();
  await assert.rejects(f.call('/api/admin/photo-reports', 'GET', {}, 'admin'), error => error.status === 403);
});

test('submission and ballot deadlines use the clock after resource locks resume', async t => {
  const f = fixture(t), contest = await f.contest();
  const approved = (await f.review((await f.upload('bob', '#394959', {contestId: contest.id})).photo)).photo;
  f.onResume(op => {
    if (op.sql === 'SELECT * FROM photo_contests WHERE id=$1 FOR UPDATE') {
      f.onResume(null); f.setClock(contest.submissionsCloseAt);
    }
  });
  await assert.rejects(f.upload('alice', '#ee12ee', {contestId: contest.id}), error => error.status === 409 && /Приём фотографий/.test(error.message));
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM photos WHERE user_id='alice'").get().n, 0);
  f.activity('voter');
  f.onResume(op => {
    if (op.sql.includes('FROM photos WHERE id=$1 FOR UPDATE')) {
      f.onResume(null); f.setClock(contest.votesCloseAt);
    }
  });
  await assert.rejects(f.call(`/api/photo-contests/${contest.id}/vote`, 'POST', {photoId: approved.id}, 'voter'), error => error.status === 409 && /Голосование сейчас закрыто/.test(error.message));
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM photo_votes').get().n, 0);
});
