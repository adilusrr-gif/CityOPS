import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {billingHarness} from '../helpers/billing-suite.mjs';
import {createTestDatabase} from './db-fixture.mjs';
import {createFeatureStore} from '../../src/features/store.mjs';
import {createPetRoutes} from '../../src/features/pet-routes.mjs';

for (const revokeConsent of [false, true]) {
  test(`PostgreSQL pet: ${revokeConsent ? 'consent revocation' : 'history deletion'} on another replica stops later provider stages`, async t => {
    const fixture = await createTestDatabase(), h = await billingHarness(t, {...fixture, audit() {}}), user = await h.person();
    const secondStore = createFeatureStore({db: fixture.db2, cfg: h.cfg, dialect: 'postgres', audit() {}});
    let enter, unblock, calls = 0;
    const entered = new Promise(resolve => {enter = resolve;}), gate = new Promise(resolve => {unblock = resolve;});
    const env = {OPENAI_API_KEY: 'mock-key', OPENAI_PET_MODEL: 'mock-model'};
    const routes = [h.store, secondStore].map(store => createPetRoutes({store, cfg: h.cfg, env, fetchImpl: async () => {
      calls++; enter(); await gate;
      return new Response(JSON.stringify({results: [{flagged: false, categories: {'self-harm': false, 'self-harm/intent': false, 'self-harm/instructions': false}}]}));
    }}));
    const call = (replica, path, method = 'GET', body = {}) => routes[replica]({path, method, user, required() {}, readBody: async () => body, throttle: async () => {}});
    await call(0, '/api/pet/adopt', 'POST', {name: 'Друг', species: 'fox'});
    await call(0, '/api/pet', 'PATCH', {consent: true, adultAttested: true});
    const requestId = randomUUID(), pending = call(0, '/api/pet/chat', 'POST', {message: 'Приватная мысль', requestId});
    await entered;
    if (revokeConsent) await call(1, '/api/pet', 'PATCH', {consent: false});
    else await call(1, '/api/pet/history', 'DELETE');
    unblock(); await assert.rejects(pending, {status: 409});
    assert.equal(calls, 1);
    assert.equal((await h.query('SELECT status FROM pet_chat_requests WHERE request_id=$1', [requestId])).status, 'failed');
    assert.equal(Number((await h.query('SELECT count(*) AS n FROM pet_messages')).n), 0);
    t.diagnostic(`SQL engine: ${fixture.engine}; no external provider contacted`);
  });
}

test('PostgreSQL billing: one global campaign slot cannot be reused in each city after downgrade', async t => {
  const fixture = await createTestDatabase(), h = await billingHarness(t, {...fixture, audit() {}});
  const owner = await h.person('business'), admin = await h.person('admin', true), order = (await h.order(owner, 'business_pro')).order;
  await h.confirm(admin, order.id);
  let offset = 0;
  for (const city of ['almaty', 'astana']) {
    const organizationId = await h.org(owner, city), promotion = (await h.call('/api/manage/promotions', owner, {city, method: 'POST', body: {organizationId, title: 'Кампания города'}})).item;
    await h.call(`/api/admin/promotions/${promotion.id}/review`, admin, {method: 'POST', body: {version: promotion.version, status: 'approved'}});
    await h.exec('UPDATE promotions SET created_at=$1 WHERE id=$2', [Date.now() + offset++ * 1000, promotion.id]);
  }
  assert.equal((await h.call('/api/promotions', null, {city: 'astana'})).items.length, 1);
  await h.exec("UPDATE billing_entitlements SET plan='business_start' WHERE order_id=$1", [order.id]);
  assert.equal((await h.call('/api/promotions', null, {city: 'almaty'})).items.length, 1);
  assert.equal((await h.call('/api/promotions', null, {city: 'astana'})).items.length, 0);
  await h.exec('UPDATE billing_entitlements SET revoked_at=$1 WHERE order_id=$2', [Date.now(), order.id]);
  assert.equal((await h.call('/api/promotions', null, {city: 'almaty'})).items.length, 0);
  t.diagnostic(`SQL engine: ${fixture.engine}`);
});

test('PostgreSQL billing: admin cursor pagination reaches the oldest of 237 tied orders and checks MFA', async t => {
  const fixture = await createTestDatabase(), h = await billingHarness(t, {...fixture, audit() {}}), user = await h.person(), admin = await h.person('admin', true), weak = await h.person('admin');
  const now = Date.now(), params = [], values = [];
  for (let index = 0; index < 237; index++) {
    const id = `historic-${String(index).padStart(3, '0')}`, offset = params.length;
    params.push(id, user.id, id, now, now + 3600000);
    values.push(`($${offset+1},$${offset+2},'plus',1490,'KZT','pending',$${offset+3},$${offset+4},$${offset+5})`);
  }
  await h.exec(`INSERT INTO billing_orders(id,user_id,plan,amount,currency,status,idempotency_key,created_at,expires_at) VALUES ${values.join(',')}`, params);
  const seen = new Set(); let cursor = null;
  do {
    const page = await h.call('/api/admin/billing?limit=80'+(cursor?'&cursor='+cursor:''), admin);
    assert.equal(page.total, 237); assert.ok(page.orders.length <= 80);
    for (const order of page.orders) {assert.equal(seen.has(order.id), false); seen.add(order.id);}
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.size, 237); assert.equal((await h.call('/api/admin/billing/historic-000', admin)).order.id, 'historic-000');
  for (const actor of [user, weak]) for (const path of ['/api/admin/billing', '/api/admin/billing/historic-000']) await assert.rejects(h.call(path, actor), {status: 403});
  t.diagnostic(`SQL engine: ${fixture.engine}`);
});
