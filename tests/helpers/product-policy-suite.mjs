import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createFeatureStore, get, run} from '../../src/features/store.mjs';
import {createAdventureRoutes} from '../../src/features/adventure-routes.mjs';
import {createPhotoRoutes} from '../../src/features/photo-routes.mjs';
import {normalizePhoto} from '../../src/features/photo-media.mjs';
import {loadProductPolicy} from '../../src/product-policy.mjs';

const DAY = 86400000, location = {lng: 76.94712, lat: 43.24923};
export function productPolicySuite(label, createDatabase) {
  async function fixture(t, env = {}) {
    const database = await createDatabase(t), time = Date.now(), operations = [];
    const cfg = {idleMs: 60 * DAY, requireAdminMfa: true, productPolicy: loadProductPolicy(env)};
    const store = createFeatureStore({...database, cfg, audit() {}});
    let mutationAfterRead;
    const routedStore = {...store, transaction(work) {
      return store.transaction(function* () {
        const iterator = work(); let step = iterator.next();
        while (!step.done) {
          const op = step.value, result = yield op; operations.push(op);
          if (mutationAfterRead?.matches(op)) {const mutation = mutationAfterRead; mutationAfterRead = null; yield run(mutation.sql, mutation.params);}
          step = iterator.next(result);
        }
        return step.value;
      });
    }};
    await store.transaction(function* () {
      for (const uid of ['alice', 'bob', 'admin']) {
        const role = uid === 'admin' ? 'admin' : 'player', mfa = Number(uid === 'admin');
        yield run('INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled) VALUES($1,$2,$1,$3,$4,$5,$6)', [uid, uid + '@example.test', 'unused', role, time - 3 * DAY, mfa]);
        yield run('INSERT INTO sessions(token,user_id,expires,id,created_at,last_seen,mfa_verified) VALUES($1,$1,$2,$3,$4,$4,$5)', [uid, time + 60 * DAY, uid + '-session', time, mfa]);
        yield run("INSERT INTO positions(user_id,lng,lat,accuracy,updated_at,city_id) VALUES($1,$2,$3,5,$4,'almaty')", [uid, location.lng, location.lat, time]);
      }
      yield run("INSERT INTO pets(user_id,name,species,color,xp,created_at,updated_at,chat_epoch) VALUES('alice','Друг','fox','mint',0,$1,$1,0)", [time]);
    });
    let decodeCount = 0;
    const photos = createPhotoRoutes({store: routedStore, cfg, now: () => time, normalize: async image => {decodeCount++; return normalizePhoto(image);}});
    const adventures = createAdventureRoutes({store: routedStore, cfg, now: () => time});
    const call = async (path, method = 'GET', body = {}, uid = 'alice', res) => {
      const url = new URL(path, 'http://local'), ctx = {path: url.pathname, url, cityId: 'almaty', method, user: uid ? {id: uid, session_id: uid + '-session'} : null, readBody: async () => body, throttle: async () => {}, res};
      const adventure = await adventures(ctx); return adventure === undefined ? photos(ctx) : adventure;
    };
    const exec = (sql, params = []) => store.transaction(function* () {return yield run(sql, params);});
    const one = (sql, params = []) => store.read(function* () {return yield get(sql, params);});
    const imageBase64 = (await sharp({create: {width: 12, height: 8, channels: 3, background: '#876543'}}).jpeg().toBuffer()).toString('base64');
    const upload = extra => call('/api/photos', 'POST', {title: 'Проверенное место', imageBase64, rightsAttested: true, placeOnlyAttested: true, ...extra});
    const review = (photo, status = 'approved') => call(`/api/admin/photos/${photo.id}`, 'PATCH', {version: photo.version, status, reason: 'Проверка оператором'}, 'admin');
    return {cfg, time, operations, call, exec, one, upload, review, decodeCount: () => decodeCount, mutateAfterRead(value) {mutationAfterRead = value;}};
  }

  test(`${label}: configured GPS, route pet XP and territory quotas are enforced without duplicate rewards`, async t => {
    const f = await fixture(t, {GAME_GPS_MAX_AGE_SECONDS: '30', GAME_GPS_MAX_ACCURACY_METERS: '25', ADVENTURE_PET_XP: '7', TERRITORY_DAILY_VISIT_LIMIT: '1'});
    const route = (await f.call('/api/admin/adventures', 'POST', {title: 'Проверенный маршрут', description: 'Общедоступная проверенная площадка', kind: 'urban', cautions: 'Проверить открытые подходы', sourceUrls: ['https://example.test/route'], status: 'open', statusReason: 'Проверка оператором выполнена', fieldVerified: true, safetyReviewed: true, xp: 50, checkpoints: [{title: 'Проверенная точка', ...location, radius: 50}]}, 'admin')).item;
    const check = () => f.call(`/api/adventures/${route.id}/checkin`, 'POST', {version: route.version, checkpointIndex: 0});
    await f.exec("UPDATE positions SET accuracy=26 WHERE user_id='alice'");
    await assert.rejects(check(), error => error.status === 409 && /25 м/.test(error.message));
    await f.exec("UPDATE positions SET accuracy=5,updated_at=$1 WHERE user_id='alice'", [f.time - 30001]);
    await assert.rejects(check(), error => error.status === 409 && /30 секунд/.test(error.message));
    await f.exec("UPDATE positions SET updated_at=$1 WHERE user_id='alice'", [f.time]);
    assert.equal((await check()).petXpAwarded, 7);
    assert.equal((await check()).petXpAwarded, 0);
    assert.equal((await f.one("SELECT xp FROM pets WHERE user_id='alice'")).xp, 7);
    await f.exec("INSERT INTO teams(id,name,owner_id,invite,created_at,city_id) VALUES('team-policy','Команда','alice','invite-policy',$1,'almaty')", [f.time]);
    await f.exec("INSERT INTO members(user_id,team_id,share_location,joined_at) VALUES('alice','team-policy',0,$1)", [f.time]);
    const createZone = title => f.call('/api/admin/territories', 'POST', {title, description: 'Открытая проверенная территория', ...location, radius: 100, status: 'active', publicAccessReviewed: true}, 'admin');
    const first = (await createZone('Первая зона')).item, second = (await createZone('Вторая зона')).item;
    assert.equal((await f.call(`/api/territories/${first.id}/visit`, 'POST')).pointsAwarded, 1);
    assert.equal((await f.call(`/api/territories/${first.id}/visit`, 'POST')).pointsAwarded, 0);
    await assert.rejects(f.call(`/api/territories/${second.id}/visit`, 'POST'), error => error.status === 429 && /1 посещений/.test(error.message));
  });

  test(`${label}: photo admission rejects stale GPS/quota before decode and zero player XP still revokes pet XP`, async t => {
    const f = await fixture(t, {GAME_GPS_MAX_AGE_SECONDS: '30', PHOTO_DAILY_UPLOAD_LIMIT: '1', PHOTO_DISCOVERY_XP: '0', PHOTO_PET_XP: '17'});
    await f.exec("UPDATE positions SET updated_at=$1 WHERE user_id='alice'", [f.time - 30001]);
    await assert.rejects(f.upload(), error => error.status === 409);
    assert.equal(f.decodeCount(), 0);
    await f.exec("UPDATE positions SET updated_at=$1 WHERE user_id='alice'", [f.time]);
    const initial = (await f.upload()).photo, approved = await f.review(initial);
    assert.equal(f.decodeCount(), 1);
    assert.equal((await f.one("SELECT xp FROM users WHERE id='alice'")).xp, 0);
    assert.equal((await f.one("SELECT xp FROM pets WHERE user_id='alice'")).xp, 17);
    await assert.rejects(f.upload(), error => error.status === 429);
    assert.equal(f.decodeCount(), 1, 'exhausted accounts cannot repeatedly consume decoder capacity');
    const rejected = await f.review(approved.photo, 'rejected');
    assert.equal(rejected.revoked, true);
    assert.equal((await f.one("SELECT xp FROM pets WHERE user_id='alice'")).xp, 0);
    assert.equal((await f.review(rejected.photo)).rewarded, false);
    assert.equal((await f.one("SELECT xp FROM pets WHERE user_id='alice'")).xp, 0);
    assert.ok(f.operations.every(op => !/SELECT \* FROM photos/.test(op.sql || '')), 'metadata actions never select image blobs');
  });

  test(`${label}: private media is authorized before blob fetch and public visibility is rechecked`, async t => {
    const f = await fixture(t), initial = (await f.upload()).photo;
    f.operations.length = 0;
    await assert.rejects(f.call(`/api/photos/${initial.id}/image`, 'GET', {}, 'bob'), error => error.status === 403);
    assert.equal(f.operations.some(op => /SELECT .*image_base64/.test(op.sql || '')), false);
    const approved = (await f.review(initial)).photo;
    let publicBytes;
    await f.call(`/api/photos/${initial.id}/image`, 'GET', {}, null, {writeHead(status) {assert.equal(status, 200);}, end(value) {publicBytes = value;}});
    assert.ok(publicBytes.length > 0);
    f.mutateAfterRead({matches: op => op.sql?.startsWith('SELECT p.user_id,p.status,u.disabled'), sql: "UPDATE photos SET status='rejected' WHERE id=$1", params: [approved.id]});
    await assert.rejects(f.call(`/api/photos/${initial.id}/image`, 'GET', {}, 'bob'), error => error.status === 404);
    let bytes;
    await f.call(`/api/photos/${initial.id}/image`, 'GET', {}, 'alice', {writeHead(status) {assert.equal(status, 200);}, end(value) {bytes = value;}});
    assert.ok(bytes.length > 0);
  });
}
