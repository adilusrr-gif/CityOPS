import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {featureKeys, featureEnv, startFeatureServer, featureHttp} from './v4-http.test.mjs';

export const policyHttpEnv = () => featureEnv({GAME_GPS_MAX_AGE_SECONDS: '45', GAME_GPS_MAX_ACCURACY_METERS: '25', PHOTO_DAILY_UPLOAD_LIMIT: '1', PHOTO_PET_XP: '13', TERRITORY_DAILY_VISIT_LIMIT: '2', PHOTO_STORAGE_LIMIT_MB: '3'});
export function installPolicyHttpSuite(label, makeFixture) {
  test(`${label}: HTTP exposes the same validated policy enforced by upload admission`, async t => {
    const {request} = await makeFixture(t);
    const config = await request('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.productPolicy.gps.maxAgeMs, 45000);
    assert.equal(config.body.productPolicy.gps.maxAccuracyM, 25);
    assert.equal(config.body.productPolicy.photos.dailyUploads, 1);
    assert.equal(config.body.productPolicy.photos.petXp, 13);
    assert.equal(config.body.productPolicy.territories.dailyVisits, 2);
    assert.equal('photoStorageBytes' in config.body.productPolicy, false);
    assert.equal(JSON.stringify(config.body).includes('test-only-provider-key'), false);
    const registered = await request('/api/register', {method: 'POST', body: {name: 'Игрок', email: randomBytes(8).toString('hex') + '@example.test', password: 'Product-policy-password-2026'}});
    assert.equal(registered.status, 200, JSON.stringify(registered.body));
    const cookie = registered.cookie;
    const locate = accuracy => request('/api/location', {cookie, method: 'POST', body: {city_id: 'almaty', lng: 76.947, lat: 43.249, accuracy, timestamp: Date.now()}});
    assert.equal((await locate(30)).status, 200, 'legacy location ingestion retains its separate accuracy bound');
    const invalidImage = {title: 'Проверенное место', imageBase64: 'invalid-image', rightsAttested: true, placeOnlyAttested: true};
    const rejectedGps = await request('/api/photos', {cookie, method: 'POST', body: invalidImage});
    assert.equal(rejectedGps.status, 409);
    assert.match(rejectedGps.body.error, /25 м.*45 секунд/);
    assert.equal((await locate(5)).status, 200);
    const imageBase64 = (await sharp({create: {width: 10, height: 10, channels: 3, background: '#987654'}}).jpeg().toBuffer()).toString('base64');
    assert.equal((await request('/api/photos', {cookie, method: 'POST', body: {...invalidImage, imageBase64}})).status, 200);
    const quota = await request('/api/photos', {cookie, method: 'POST', body: invalidImage});
    assert.equal(quota.status, 429, 'exhausted quota is rejected before invalid image decoding');
    const mine = await request('/api/photos/mine', {cookie});
    assert.equal(mine.status, 200);
    assert.equal(mine.body.limits.daily, config.body.productPolicy.photos.dailyUploads);
    assert.equal(mine.body.limits.usedToday, 1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) installPolicyHttpSuite('SQLite policy', async t => {
  const db = openDb(':memory:', {withSnapshot: false});
  const app = await startFeatureServer(createApp({db, keys: featureKeys, env: policyHttpEnv()}));
  t.after(async () => {await new Promise(resolve => app.server.close(resolve)); db.close();});
  return {request: featureHttp([app])};
});
