import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../../src/db.mjs';
import {createFeatureStore,get,run} from '../../src/features/store.mjs';
import {createBillingRoutes} from '../../src/features/billing-routes.mjs';
import {billingConfig,getEntitlements,BILLING_PERIOD_MS} from '../../src/features/billing.mjs';
import {hash} from '../../src/domain.mjs';
import {appendAudit,verifyAudit} from '../../src/security.mjs';

let sequence=0;
const keys={encryptionKey:Buffer.alloc(32,12),auditKey:Buffer.alloc(32,25)};
export async function billingHarness(t,fixture){
 const db=fixture?.db||openDb(':memory:',{withSnapshot:false}),dialect=fixture?'postgres':'sqlite';
 t.after(()=>fixture?fixture.close():db.close());
 const cfg={idleMs:1800000,requireAdminMfa:false,keys,nativeOrigins:['capacitor://localhost','https://localhost']};
 const store=createFeatureStore({db,cfg,dialect,audit:fixture?.audit||((connection,actor,action,target,metadata)=>appendAudit(connection,{actor,action,target,metadata,requestId:'billing-test'},keys.auditKey))});
 const route=createBillingRoutes({store,cfg,env:{BILLING_MANUAL_ENABLED:'true'}});
 const exec=(sql,params=[])=>store.transaction(function*(){return yield run(sql,params);});
 const query=(sql,params=[])=>store.read(function*(){return yield get(sql,params);});
 async function person(role='player',mfa=false){const uid=`billing-user-${++sequence}`,sid=`billing-session-${sequence}`,now=Date.now();await exec('INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid,`${uid}@example.test`,'Пилот','unused',role,now,mfa?1:0]);await exec('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$3,$4,$5,$5,$6)',[hash(sid),sid,uid,now+3600000,now,mfa?1:0]);return {...await query('SELECT * FROM users WHERE id=$1',[uid]),session_id:sid,session_mfa_verified:mfa?1:0};}
 async function call(path,user,{method='GET',body={},headers={},city='almaty',routeOverride=route}={}){const url=new URL(path,'http://localhost');url.searchParams.set('city',city);return routeOverride({url,path:url.pathname,method,user,cityId:city,req:{method,headers},readBody:async()=>body});}
 const order=(user,plan='plus',key=`order-key-${++sequence}`)=>call('/api/billing/orders',user,{method:'POST',body:{plan,idempotencyKey:key}});
 const confirm=(admin,oid,ref=`payment-ref-${++sequence}`)=>call(`/api/admin/billing/${oid}/confirm`,admin,{method:'POST',body:{paymentReference:ref}});
 async function org(owner,cityId='almaty'){const oid=`billing-org-${++sequence}`;await exec("INSERT INTO organizations(id,owner_id,name,category,lng,lat,status,created_at,city_id) VALUES($1,$2,'Кофейня','cafe',$3,$4,'approved',$5,$6)",[oid,owner.id,cityId==='almaty'?76.947:71.4304,cityId==='almaty'?43.249:51.1282,Date.now(),cityId]);return oid;}
 async function quest(owner,organizationId,cityId='almaty'){const qid=`billing-quest-${++sequence}`;await exec("INSERT INTO quests(id,owner_id,organization_id,title,description,lng,lat,radius,xp,scope,verification,status,created_at,city_id) VALUES($1,$2,$3,'Квест','Общий квест',$4,$5,150,100,'public','checkin','published',$6,$7)",[qid,owner.id,organizationId,cityId==='almaty'?76.947:71.4304,cityId==='almaty'?43.249:51.1282,Date.now(),cityId]);return qid;}
 return {db,store,cfg,route,exec,query,person,call,order,confirm,org,quest,dialect};
}

export function billingSuite(label,fixtureFactory){
 test(`${label}: prices, native checkout guard, idempotency, fixed term and refund revocation`,async t=>{
  const h=await billingHarness(t,fixtureFactory&&await fixtureFactory()),user=await h.person(),admin=await h.person('admin',true);
  assert.equal(billingConfig().prices.plus,1490);assert.throws(()=>billingConfig({BILLING_PLUS_KZT:'12.5'}));assert.throws(()=>billingConfig({BILLING_BUSINESS_PRO_KZT:'1000000001'}));
  const free=await h.call('/api/billing/me',user);assert.equal(free.entitlements.aiMessagesPerDay,5);assert.equal(free.entitlements.campaignSlots,0);
  assert.equal((await h.call('/api/billing/catalog',null,{headers:{'x-cityquest-client':'native'}})).checkoutAvailable,false);
  for(const headers of [{'x-cityquest-client':'native'},{origin:'capacitor://localhost'},{origin:'https://localhost'}])await assert.rejects(h.call('/api/billing/orders',user,{method:'POST',headers,body:{plan:'plus',idempotencyKey:'native-key'}}),{status:403});
  const disabled=createBillingRoutes({store:h.store,cfg:h.cfg,env:{}});await assert.rejects(h.call('/api/billing/orders',user,{method:'POST',routeOverride:disabled,body:{plan:'plus',idempotencyKey:'disabled-key'}}),{status:503});
  const outcomes=await Promise.all(Array.from({length:4},()=>h.order(user,'plus','same-request-key')));assert.equal(new Set(outcomes.map(r=>r.order.id)).size,1);assert.equal(outcomes.filter(r=>!r.idempotent).length,1);
  const order=outcomes[0].order;assert.equal(order.amount,1490);assert.equal(order.currency,'KZT');await assert.rejects(h.order(user,'plus','another-pending-key'),{status:409});
  const paid=await h.confirm(admin,order.id,'reference-fixed');assert.equal(paid.order.service_ends_at-paid.order.service_starts_at,BILLING_PERIOD_MS);assert.equal(paid.moneyTransferred,false);
  assert.equal((await h.confirm(admin,order.id,'reference-fixed')).idempotent,true);await assert.rejects(h.confirm(admin,order.id,'other-reference'),{status:409});
  const ent=(await h.call('/api/billing/me',user)).entitlements;assert.equal(ent.aiMessagesPerDay,40);assert.equal(ent.premiumColors,true);assert.equal(ent.campaignSlots,0);
  await assert.rejects(h.order(user),{status:409});
  const refund=await h.call(`/api/admin/billing/${order.id}/refund`,admin,{method:'POST',body:{note:'Внешний возврат выполнен оператором'}});assert.equal(refund.moneyTransferred,false);assert.equal((await h.call('/api/billing/me',user)).entitlements.aiMessagesPerDay,5);
  assert.equal((await h.call(`/api/admin/billing/${order.id}/refund`,admin,{method:'POST',body:{note:'Повторная проверка'}})).idempotent,true);
  assert.equal(Number((await h.query('SELECT count(*) AS n FROM billing_entitlements WHERE order_id=$1',[order.id])).n),1);
  if(!fixtureFactory)assert.equal(verifyAudit(h.db,keys.auditKey).ok,true);
 });
 test(`${label}: MFA, ownership, disabled users, expiration and external payment uniqueness`,async t=>{
  const h=await billingHarness(t,fixtureFactory&&await fixtureFactory()),user=await h.person(),other=await h.person(),admin=await h.person('admin',true),weak=await h.person('admin'),order=(await h.order(user)).order;
  await assert.rejects(h.confirm(weak,order.id),{status:403});await assert.rejects(h.confirm(user,order.id),{status:403});
  await assert.rejects(h.call('/api/admin/billing',weak),{status:403});await assert.rejects(h.order(user,'business_start'),{status:403});
  assert.equal((await h.call('/api/billing/orders',other)).orders.length,0);
  await h.confirm(admin,order.id,'shared-reference');const otherOrder=(await h.order(other)).order;await assert.rejects(h.confirm(admin,otherOrder.id,'shared-reference'),{status:409});
  await h.exec('UPDATE billing_orders SET expires_at=$1 WHERE id=$2',[Date.now()-1,otherOrder.id]);await assert.rejects(h.confirm(admin,otherOrder.id),{status:409});assert.equal((await h.call('/api/billing/orders',other)).orders[0].status,'expired');
  const replacement=(await h.order(other)).order;await h.exec('UPDATE users SET disabled=1 WHERE id=$1',[other.id]);await assert.rejects(h.confirm(admin,replacement.id),{status:409});await assert.rejects(h.call('/api/billing/me',other),{status:401});
  await h.exec('UPDATE billing_entitlements SET ends_at=$1,starts_at=$2 WHERE user_id=$3',[Date.now()-1,Date.now()-10000,user.id]);assert.equal((await h.store.read(function*(){return yield* getEntitlements(user.id);})).playerPlan,'free');
 });
 test(`${label}: payment and refund roll back with audit failure`,async t=>{
  const h=await billingHarness(t,fixtureFactory&&await fixtureFactory()),user=await h.person(),admin=await h.person('admin',true),order=(await h.order(user)).order;
  const failedStore=createFeatureStore({db:h.db,cfg:h.cfg,dialect:h.dialect,audit:()=>{throw new Error('Audit write unavailable');}}),failedRoute=createBillingRoutes({store:failedStore,cfg:h.cfg,env:{BILLING_MANUAL_ENABLED:'true'}});
  await assert.rejects(h.call(`/api/admin/billing/${order.id}/confirm`,admin,{method:'POST',body:{paymentReference:'audit-payment'},routeOverride:failedRoute}),/Audit write unavailable/);
  assert.equal((await h.query('SELECT status FROM billing_orders WHERE id=$1',[order.id])).status,'pending');assert.equal(Number((await h.query('SELECT count(*) AS n FROM billing_entitlements WHERE order_id=$1',[order.id])).n),0);
  await h.confirm(admin,order.id,'audit-payment');
  await assert.rejects(h.call(`/api/admin/billing/${order.id}/refund`,admin,{method:'POST',body:{note:'Внешний возврат проверен'},routeOverride:failedRoute}),/Audit write unavailable/);
  assert.equal((await h.query('SELECT status FROM billing_orders WHERE id=$1',[order.id])).status,'paid');assert.equal((await h.call('/api/billing/me',user)).entitlements.aiMessagesPerDay,40);
 });
 test(`${label}: sponsored campaigns require ownership, paid slots and current moderation eligibility`,async t=>{
  const h=await billingHarness(t,fixtureFactory&&await fixtureFactory()),business=await h.person('business'),other=await h.person('business'),admin=await h.person('admin',true),org=await h.org(business),quest=await h.quest(business,org),foreign=await h.org(other);
  const create=(organizationId=org,questId=quest,city='almaty')=>h.call('/api/manage/promotions',business,{method:'POST',city,body:{organizationId,questId,title:'Кофе после прогулки',description:'Открытая кампания бизнеса'}});
  await assert.rejects(create(),{status:403});const order=(await h.order(business,'business_start')).order;await h.confirm(admin,order.id);
  await assert.rejects(create(foreign,null),{status:403});const promotion=(await create()).item;await assert.rejects(create(),{status:409});
  assert.equal((await h.call('/api/promotions',null)).items.length,0);
  await assert.rejects(h.call(`/api/manage/promotions/${promotion.id}`,other,{method:'PATCH',body:{version:1,status:'archived'}}),{status:403});
  const approved=(await h.call(`/api/admin/promotions/${promotion.id}/review`,admin,{method:'POST',body:{version:1,status:'approved'}})).item;
  const ads=await h.call('/api/promotions',null);assert.equal(ads.items.length,1);assert.equal(ads.items[0].label,'Реклама');assert.equal(ads.items[0].organizationId,org);assert.equal((await h.call('/api/promotions',null,{city:'astana'})).items.length,0);
  await h.exec("UPDATE quests SET scope='personal' WHERE id=$1",[quest]);assert.equal((await h.call('/api/promotions',null)).items.length,0);await h.exec("UPDATE quests SET scope='public' WHERE id=$1",[quest]);
  await h.exec("UPDATE organizations SET status='pending' WHERE id=$1",[org]);assert.equal((await h.call('/api/promotions',null)).items.length,0);await h.exec("UPDATE organizations SET status='approved' WHERE id=$1",[org]);
  await assert.rejects(h.call(`/api/manage/promotions/${promotion.id}`,business,{method:'PATCH',body:{version:1,title:'Запоздавшая правка'}}),{status:409});
  const changed=(await h.call(`/api/manage/promotions/${promotion.id}`,business,{method:'PATCH',body:{version:approved.version,title:'Новый рекламный текст'}})).item;assert.equal(changed.status,'pending');assert.equal((await h.call('/api/promotions',null)).items.length,0);
  await h.call(`/api/admin/promotions/${promotion.id}/review`,admin,{method:'POST',body:{version:changed.version,status:'approved'}});
  await h.call(`/api/admin/billing/${order.id}/refund`,admin,{method:'POST',body:{note:'Внешний возврат средств подтвержден'}});assert.equal((await h.call('/api/promotions',null)).items.length,0);
  const item=await h.query('SELECT * FROM promotions WHERE id=$1',[promotion.id]);await h.call(`/api/manage/promotions/${promotion.id}`,business,{method:'PATCH',body:{version:item.version,status:'archived'}});assert.equal((await h.query('SELECT status FROM promotions WHERE id=$1',[item.id])).status,'archived');
 });
}
