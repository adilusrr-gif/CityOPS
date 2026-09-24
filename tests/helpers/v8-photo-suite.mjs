import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createFeatureStore, run} from '../../src/features/store.mjs';
import {createPhotoRoutes} from '../../src/features/photo-routes.mjs';
import {normalizePhoto} from '../../src/features/photo-media.mjs';

export function photoCursorSuite(label, createDatabase) {
  test(`${label}: photo cursors reject coerced identifiers and preserve same-time page boundaries`, async t => {
    const database = await createDatabase(t), time = Date.now();
    const store = createFeatureStore({...database, cfg: {idleMs: 600000}, audit() {}});
    const image = await normalizePhoto((await sharp({create: {width: 8, height: 6, channels: 3, background: '#123456'}}).png().toBuffer()).toString('base64'));
    await store.transaction(function* () {
      yield run("INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled) VALUES('author','photo-cursor@example.test','Автор','unused','admin',$1,1)", [time]);
      yield run("INSERT INTO sessions(token,user_id,expires,id,created_at,last_seen,mfa_verified) VALUES('photo-cursor-token','author',$1,'photo-cursor-session',$2,$2,1)", [time + 600000, time]);
      for (let i = 0; i < 41; i++) yield run("INSERT INTO photos(id,user_id,city_id,title,cell,approx_lng,approx_lat,status,image_base64,image_bytes,image_sha256,width,height,created_at,updated_at) VALUES($1,'author','almaty','Место','38473:28832',76.947,43.249,'approved',$2,$3,$4,$5,$6,$7,$7)", [`photo-${String(i).padStart(2, '0')}`, image.image_base64, image.image_bytes, image.image_sha256, image.width, image.height, time]);
    });
    const route = createPhotoRoutes({store}), user = {id: 'author', session_id: 'photo-cursor-session'};
    const call = path => {const url = new URL(path, 'http://local'); return route({path: url.pathname, url, method: 'GET', user});};
    for (const path of ['/api/photos', '/api/photos/mine', '/api/admin/photos?status=approved']) {
      const separator = path.includes('?') ? '&' : '?';
      for (const id of [true, false, 123, null, ['photo-01'], {toString: null}]) {
        const cursor = Buffer.from(JSON.stringify({time, id})).toString('base64url');
        await assert.rejects(call(`${path}${separator}cursor=${cursor}`), error => error.status === 400, `${path}: cursor id must be a string`);
      }
      const first = await call(path);
      assert.equal(first.items.length, 40); assert.equal(first.hasMore, true);
      const second = await call(`${path}${separator}cursor=${first.nextCursor}`);
      assert.equal(second.items.length, 1); assert.equal(second.hasMore, false);
      assert.equal(new Set([...first.items, ...second.items].map(photo => photo.id)).size, 41);
      assert.equal(second.items[0].id, 'photo-00');
    }
  });
}
