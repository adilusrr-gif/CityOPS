import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {billingHarness} from './billing-suite.mjs';
import {createPetRoutes} from '../../src/features/pet-routes.mjs';
import {encryptPetText} from '../../src/features/pet-crypto.mjs';

const env = {OPENAI_API_KEY: 'test-only-no-network', OPENAI_PET_MODEL: 'test-model'};
const safe = {results: [{flagged: false, categories: {'self-harm': false, 'self-harm/intent': false, 'self-harm/instructions': false}}]};
const generated = {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'Можно немного отдохнуть.'}]}]};

export function v8FeaturesSuite(label, fixtureFactory) {
  test(`${label}: pet generation excludes history that expired during input moderation`, async t => {
    const fixture = fixtureFactory ? await fixtureFactory() : undefined;
    const h = await billingHarness(t, fixture), user = await h.person(), start = Date.now();
    let time = start, requests = 0, generation;
    const route = createPetRoutes({store: h.store, cfg: h.cfg, env, now: () => time, fetchImpl: async (url, options) => {
      requests++;
      if (url.endsWith('/responses')) generation = JSON.parse(options.body);
      else if (requests === 1) time += 1000;
      return new Response(JSON.stringify(url.endsWith('/responses') ? generated : safe));
    }});
    const call = (path, method = 'GET', body = {}) => route({path, method, user, required() {}, readBody: async () => body, throttle: async () => {}});
    await call('/api/pet/adopt', 'POST', {name: 'Искра', species: 'fox'});
    await call('/api/pet', 'PATCH', {consent: true, adultAttested: true});
    for (const [index, value, expiresAt] of [[0, 'expired-private-context', start + 500], [1, 'still-current-context', start + 60000]]) {
      const messageId = randomUUID();
      await h.exec('INSERT INTO pet_messages(id,user_id,request_id,role,content_cipher,mode,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [messageId, user.id, `past-${index}`, 'user', encryptPetText(value, h.cfg.keys.encryptionKey, `${user.id}:message:${messageId}`), 'ai', start - 2000 + index, expiresAt]);
    }
    const result = await call('/api/pet/chat', 'POST', {message: 'Сегодня пойду гулять', requestId: randomUUID()});
    assert.equal(result.mode, 'ai');
    assert.equal(requests, 3);
    assert.deepEqual(generation.input.map(item => item.content), ['still-current-context', 'Сегодня пойду гулять']);
    assert.equal((await call('/api/pet')).history.some(item => item.text === 'expired-private-context'), false);
  });

  test(`${label}: promotion paging reaches an old occupied slot and binds cursors to actor, city and role`, async t => {
    const fixture = fixtureFactory ? await fixtureFactory() : undefined;
    const h = await billingHarness(t, fixture), owner = await h.person('business'), other = await h.person('business'), admin = await h.person('admin', true), weak = await h.person('admin');
    const org = await h.org(owner), order = (await h.order(owner, 'business_start')).order;
    await h.confirm(admin, order.id);
    const time = Date.now(), params = [], values = [];
    for (let index = 0; index < 237; index++) {
      const offset = params.length, id = `promo-historic-${String(index).padStart(3, '0')}`;
      params.push(id, owner.id, org, index === 0 ? 'approved' : 'archived', time - 237 + Math.floor(index / 3));
      values.push(`($${offset+1},$${offset+2},$${offset+3},'almaty','Кампания','Описание',$${offset+4},$${offset+5},$${offset+5},1)`);
    }
    await h.exec(`INSERT INTO promotions(id,owner_id,organization_id,city_id,title,description,status,created_at,updated_at,version) VALUES ${values.join(',')}`, params);
    const create = () => h.call('/api/manage/promotions', owner, {method: 'POST', body: {organizationId: org, title: 'Новая кампания'}});
    await assert.rejects(create(), {status: 409});
    const first = await h.call('/api/manage/promotions?limit=50', owner);
    assert.equal(first.items.some(item => item.id === 'promo-historic-000'), false, 'The occupied campaign is beyond the first 200 newest records');
    assert.equal(first.items.length, 50); assert.equal(first.total, 237); assert.ok(first.next_cursor);
    const seen = new Set(); let page = first;
    do {
      for (const item of page.items) {assert.equal(seen.has(item.id), false); seen.add(item.id);}
      if (!page.next_cursor) break;
      page = await h.call('/api/manage/promotions?limit=50&cursor='+page.next_cursor, owner);
    } while (true);
    assert.equal(seen.size, 237); assert.ok(seen.has('promo-historic-000'));
    for (const [path, actor, options] of [
      ['/api/manage/promotions', other, {}], ['/api/manage/promotions', owner, {city: 'astana'}], ['/api/admin/promotions', admin, {}],
    ]) await assert.rejects(h.call(path+'?cursor='+first.next_cursor, actor, options), {status: 400});
    assert.equal((await h.call('/api/manage/promotions', other)).total, 0);
    const adminFirst = await h.call('/api/admin/promotions?limit=200', admin);
    assert.equal(adminFirst.items.length, 200); assert.equal(adminFirst.total, 237);
    const adminLast = await h.call('/api/admin/promotions?limit=200&cursor='+adminFirst.next_cursor, admin);
    assert.equal(adminLast.items.length, 37); assert.equal(adminLast.next_cursor, null);
    await assert.rejects(h.call('/api/admin/promotions', weak), {status: 403});
    for (const query of ['limit=0', 'limit=201', 'cursor=invalid', 'offset=200']) await assert.rejects(h.call('/api/manage/promotions?'+query, owner), {status: 400});
    await h.call('/api/manage/promotions/promo-historic-000', owner, {method: 'PATCH', body: {version: 1, status: 'archived'}});
    assert.equal((await create()).item.status, 'pending');
  });

}
