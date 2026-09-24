import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {billingHarness} from './helpers/billing-suite.mjs';
import {createPetRoutes} from '../src/features/pet-routes.mjs';
import {createPetProvider} from '../src/features/pet-provider.mjs';

const env = {OPENAI_API_KEY: 'mock-no-network', OPENAI_PET_MODEL: 'mock-model'};
const safe = {results: [{flagged: false, categories: {'self-harm': false, 'self-harm/intent': false, 'self-harm/instructions': false}}]};
const response = url => new Response(JSON.stringify(url.endsWith('/responses') ? {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Можно отдохнуть и поговорить с близким.'}]}]} : safe));
async function setup(t, fetchImpl) {
  const h = await billingHarness(t), user = await h.person();
  const route = createPetRoutes({store: h.store, cfg: h.cfg, env, fetchImpl});
  const call = (path, method = 'GET', body = {}, transport = {}) => route({path, method, user, required() {}, readBody: async () => body, throttle: async () => {}, ...transport});
  await call('/api/pet/adopt', 'POST', {name: 'Искра', species: 'fox'});
  await call('/api/pet', 'PATCH', {consent: true, adultAttested: true});
  return {...h, user, call};
}
function latch() {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};}

for (const action of ['delete-history', 'revoke-consent', 'revoke-session', 'disable-account']) {
  test(`pet: ${action} during input moderation prevents transmission to generation`, async t => {
    const entered = latch(), release = latch(), calls = [];
    const h = await setup(t, async (url, options) => {calls.push({url, body: JSON.parse(options.body)}); entered.resolve(); await release.promise; return response(url);});
    const requestId = randomUUID();
    const pending = h.call('/api/pet/chat', 'POST', {message: 'Личная история дня', requestId});
    await entered.promise;
    if (action === 'delete-history') await h.call('/api/pet/history', 'DELETE');
    else if (action === 'revoke-consent') await h.call('/api/pet', 'PATCH', {consent: false});
    else if (action === 'revoke-session') await h.exec('DELETE FROM sessions WHERE user_id=$1', [h.user.id]);
    else await h.exec('UPDATE users SET disabled=1 WHERE id=$1', [h.user.id]);
    release.resolve();
    await assert.rejects(pending, {status: action.startsWith('revoke-s') || action === 'disable-account' ? 401 : 409});
    assert.equal(calls.length, 1, 'No generation or output-moderation request after durable revocation');
    assert.equal((await h.query('SELECT status FROM pet_chat_requests WHERE user_id=$1 AND request_id=$2', [h.user.id, requestId])).status, 'failed');
    assert.equal(Number((await h.query('SELECT count(*) AS n FROM pet_messages WHERE user_id=$1', [h.user.id])).n), 0);
    assert.equal((await h.query('SELECT count FROM pet_usage WHERE user_id=$1', [h.user.id])).count, 1, 'An uncertain provider cost stays charged');
  });
}

test('pet: failed finalization settles reservation after the final upstream call', async t => {
  const entered = latch(), release = latch(); let calls = 0;
  const h = await setup(t, async url => {if (++calls === 3) {entered.resolve(); await release.promise;} return response(url);});
  const requestId = randomUUID(), pending = h.call('/api/pet/chat', 'POST', {message: 'Сегодня был хороший день', requestId});
  await entered.promise; await h.exec('DELETE FROM sessions WHERE user_id=$1', [h.user.id]); release.resolve();
  await assert.rejects(pending, {status: 401});
  assert.equal((await h.query('SELECT status FROM pet_chat_requests WHERE request_id=$1', [requestId])).status, 'failed');
  assert.equal(Number((await h.query('SELECT count(*) AS n FROM pet_messages')).n), 0);
});

test('pet: disconnected HTTP client aborts upstream and settles the charged reservation', async t => {
  const entered = latch(); let upstreamSignal;
  const h = await setup(t, async (_url, {signal}) => {
    upstreamSignal = signal; entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once: true}));
  });
  const req = new EventEmitter(), res = new EventEmitter(), requestId = randomUUID();
  res.writableEnded = false;
  const pending = h.call('/api/pet/chat', 'POST', {message: 'Поговорим о прогулке', requestId}, {req, res});
  await entered.promise; res.emit('close');
  await assert.rejects(pending, {status: 503});
  assert.equal(upstreamSignal.aborted, true);
  assert.equal((await h.query('SELECT status FROM pet_chat_requests WHERE request_id=$1', [requestId])).status, 'failed');
  assert.equal((await h.query('SELECT count FROM pet_usage WHERE user_id=$1', [h.user.id])).count, 1);
  assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0);
});

test('pet: rejected upstream response cancels its unread body', async () => {
  let cancelled = 0;
  const provider = createPetProvider({env, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) {controller.enqueue(new TextEncoder().encode('private upstream error'));},
    cancel() {cancelled++;},
  }), {status: 503})});
  await assert.rejects(provider.reply({message: 'Привет'}), error => error.status === 503 && !error.message.includes('private'));
  assert.equal(cancelled, 1);
});

test('billing: public promotions use one query, global paid slots and current authorization', async t => {
  const {createBillingRoutes} = await import('../src/features/billing-routes.mjs');
  const h = await billingHarness(t); let queries = 0;
  const countedStore = {...h.store, read(work) {return h.store.read(function* () {
    const iterator = work(); let step = iterator.next();
    while (!step.done) {queries++; step = iterator.next(yield step.value);}
    return step.value;
  });}};
  const routeOverride = createBillingRoutes({store: countedStore, cfg: h.cfg, env: {}});
  const now = Date.now(), owners = [];
  for (let index = 0; index < 50; index++) {
    const owner = await h.person('business'), organizationId = await h.org(owner), order = (await h.order(owner, 'business_start')).order;
    owners.push({owner, order});
    await h.exec('INSERT INTO billing_entitlements(id,order_id,user_id,plan,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6)', [`slot-${index}`, order.id, owner.id, 'business_start', now - 1000, now + 3600000]);
    await h.exec("INSERT INTO promotions(id,owner_id,organization_id,city_id,title,description,status,created_at,updated_at,version) VALUES($1,$2,$3,'almaty','Реклама','Описание','approved',$4,$4,1)", [`ad-${index}`, owner.id, organizationId, now + index]);
  }
  const list = city => h.call('/api/promotions', null, {city, routeOverride});
  assert.equal((await list('almaty')).items.length, 50); assert.equal(queries, 1);
  const [{owner, order}] = owners, astanaOrg = await h.org(owner, 'astana');
  await h.exec("INSERT INTO promotions(id,owner_id,organization_id,city_id,title,description,status,created_at,updated_at,version) VALUES('later-astana',$1,$2,'astana','Астана','Описание','approved',$3,$3,1)", [owner.id, astanaOrg, now + 100]);
  // Both campaigns could remain approved after a former five-slot plan expires.
  assert.equal((await list('astana')).items.length, 0, 'Start has one slot across all cities');
  await h.exec("UPDATE billing_entitlements SET plan='business_pro' WHERE order_id=$1", [order.id]);
  assert.equal((await list('astana')).items.length, 1);
  await h.exec('UPDATE billing_entitlements SET revoked_at=$1 WHERE order_id=$2', [now, order.id]);
  assert.equal((await list('astana')).items.length, 0);
  await h.exec('UPDATE users SET disabled=1 WHERE id=$1', [owners[1].owner.id]);
  assert.equal((await list('almaty')).items.length, 48);
  assert.equal(queries, 5, 'Each city response uses exactly one database statement');
});

test('billing: administrators can page beyond 200 orders without duplicate ties and fetch old orders by id', async t => {
  const h = await billingHarness(t), user = await h.person(), admin = await h.person('admin', true), weak = await h.person('admin'), otherAdmin = await h.person('admin', true);
  const now = Date.now(), params = [], values = [];
  for (let index = 0; index < 237; index++) {
    const id = `historic-${String(index).padStart(3, '0')}`, offset = params.length;
    params.push(id, user.id, id, now, now + 3600000);
    values.push(`($${offset+1},$${offset+2},'plus',1490,'KZT','pending',$${offset+3},$${offset+4},$${offset+5})`);
  }
  await h.exec(`INSERT INTO billing_orders(id,user_id,plan,amount,currency,status,idempotency_key,created_at,expires_at) VALUES ${values.join(',')}`, params);
  const first = await h.call('/api/admin/billing', admin);
  assert.equal(first.orders.length, 50); assert.equal(first.limit, 50); assert.equal(first.total, 237); assert.ok(first.next_cursor);
  const seen = new Set(first.orders.map(order => order.id)); let cursor = first.next_cursor;
  await h.exec("INSERT INTO billing_orders(id,user_id,plan,amount,currency,status,idempotency_key,created_at,expires_at) VALUES('newest',$1,'plus',1490,'KZT','pending','newest-key',$2,$3)", [user.id, now+1, now+3600000]);
  while (cursor) {
    const page = await h.call(`/api/admin/billing?cursor=${encodeURIComponent(cursor)}`, admin);
    assert.equal(page.total, 238); assert.ok(page.orders.length <= 50);
    for (const order of page.orders) {assert.equal(seen.has(order.id), false); seen.add(order.id);}
    cursor = page.next_cursor;
  }
  assert.equal(seen.size, 237); assert.equal(seen.has('historic-000'), true); assert.equal(seen.has('newest'), false);
  assert.equal((await h.call('/api/admin/billing/historic-000', admin)).order.id, 'historic-000');
  assert.equal((await h.call('/api/admin/billing?limit=200', admin)).orders.length, 200);
  for (const actor of [user, weak]) for (const path of ['/api/admin/billing', '/api/admin/billing/historic-000']) await assert.rejects(h.call(path, actor), {status: 403});
  await assert.rejects(h.call('/api/admin/billing?cursor='+first.next_cursor, otherAdmin), {status: 400});
  for (const query of ['limit=201', 'limit=0', 'limit=no', 'cursor=invalid', 'offset=200']) await assert.rejects(h.call('/api/admin/billing?'+query, admin), {status: 400});
  await assert.rejects(h.call('/api/admin/billing/missing', admin), {status: 404});
});
