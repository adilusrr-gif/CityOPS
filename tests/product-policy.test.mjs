import test from 'node:test';
import assert from 'node:assert/strict';
import {loadProductPolicy, publicProductPolicy, EXPLORATION_GRID, PROGRESSION} from '../src/product-policy.mjs';
import {openDb} from '../src/db.mjs';
import {productPolicySuite} from './helpers/product-policy-suite.mjs';

test('product policy rejects unsafe operator input and exposes only an explicit public projection', () => {
  const policy = loadProductPolicy({GAME_GPS_MAX_AGE_SECONDS: '45', PHOTO_DISCOVERY_XP: '0', ADVENTURE_PET_XP: '33', PHOTO_STORAGE_LIMIT_MB: '2'});
  assert.equal(policy.gps.maxAgeMs, 45000);
  assert.equal(policy.photos.discoveryXp, 0);
  assert.equal(policy.adventures.petXp, 33);
  assert.equal(policy.photoStorageBytes, 2097152);
  assert.throws(() => {policy.gps.maxAgeMs = 999;}, TypeError);
  const projected = publicProductPolicy({...policy, secret: 'secret', photos: {...policy.photos, providerKey: 'secret'}});
  assert.equal(JSON.stringify(projected).includes('secret'), false);
  assert.equal('photoStorageBytes' in projected, false);
  assert.deepEqual(projected.exploration, EXPLORATION_GRID);
  assert.deepEqual(projected.progression, PROGRESSION);
  projected.photos.discoveryXp = 999;
  assert.equal(policy.photos.discoveryXp, 0);
  for (const env of [
    {GAME_GPS_MAX_AGE_SECONDS: '121'}, {GAME_GPS_MAX_AGE_SECONDS: '29'},
    {GAME_GPS_MAX_ACCURACY_METERS: '101'}, {TERRITORY_DAILY_VISIT_LIMIT: '0'},
    {ADVENTURE_PET_XP: '-1'}, {PHOTO_DISCOVERY_XP: '101'}, {PHOTO_PET_XP: '1.5'},
    {PHOTO_DAILY_UPLOAD_LIMIT: '21'}, {PHOTO_RETAINED_LIMIT: '101'},
    {PHOTO_VOTER_MIN_AGE_HOURS: '23'}, {PHOTO_STORAGE_LIMIT_MB: 'Infinity'},
    {PHOTO_DAILY_UPLOAD_LIMIT: '0x10'}, {PHOTO_DAILY_UPLOAD_LIMIT: '1e1'},
  ]) assert.throws(() => loadProductPolicy(env), /must be an integer/);
  assert.deepEqual(loadProductPolicy({GAME_GPS_MAX_AGE_SECONDS: ''}), loadProductPolicy({}));
});

productPolicySuite('SQLite product policy', async t => {
  const db = openDb(':memory:', {withSnapshot: false});
  t.after(() => db.close());
  return {db, dialect: 'sqlite'};
});
