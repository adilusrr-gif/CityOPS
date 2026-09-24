import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {passwordHash} from '../src/domain.mjs';
import {totp} from '../src/security.mjs';
import {sqliteStatement} from '../src/features/store.mjs';

export const featureKeys={encryptionKey:Buffer.alloc(32,71),auditKey:Buffer.alloc(32,73)};
const password='Http-v4-test-password-2026';
const unique=()=>randomBytes(12).toString('hex');
const good=result=>{assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
const at={lng:76.947,lat:43.249};
export function featureProvider(){
 const calls=[];let failure=false,paused=null;
 return {calls,setFailure(value){failure=value;},pause(){let entered,release;const started=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});paused={entered,wait};return {started,release};},
  async fetch(url,options){
   const body=JSON.parse(options.body);calls.push({url:String(url),body});
   if(String(url).endsWith('/moderations')){
    if(failure)return new Response(JSON.stringify({error:'test moderation outage'}),{status:503});
    return Response.json({results:[{flagged:false,categories:{'self-harm':false,'self-harm/intent':false,'self-harm/instructions':false,violence:false}}]});
   }
   assert.equal(String(url),'https://api.openai.com/v1/responses');
   if(paused){const current=paused;paused=null;current.entered();await current.wait;}
   return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'Давай сделаем небольшую паузу и подумаем, какой шаг будет удобен сегодня.'}]}]});
  },
 };
}
export function featureEnv(extra={}){return {NODE_ENV:'test',BILLING_MANUAL_ENABLED:'true',BILLING_PLUS_KZT:'1749',OPENAI_API_KEY:'test-only-provider-key',OPENAI_PET_MODEL:'test-model',PET_AI_TIMEOUT_MS:'10000',...extra};}
export async function startFeatureServer(app){await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});app.base=`http://127.0.0.1:${app.server.address().port}`;return app;}
export function featureHttp(apps){return async function request(path,{index=0,cookie,method='GET',body,headers={}}={}){
 const response=await fetch(apps[index%apps.length].base+path,{method,headers:{...headers,...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
 const value=await response.text();return {status:response.status,body:value?JSON.parse(value):null,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};
};}
async function sqliteFixture(t){
 const sqlite=openDb(':memory:',{withSnapshot:false}),provider=featureProvider();
 const app=await startFeatureServer(createApp({db:sqlite,keys:featureKeys,env:featureEnv(),petFetchImpl:provider.fetch}));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));sqlite.close();});
 const db={
  async get(sql,params=[]){const s=sqliteStatement(sql,params);return sqlite.prepare(s.sql).get(...s.params);},
  async all(sql,params=[]){const s=sqliteStatement(sql,params);return sqlite.prepare(s.sql).all(...s.params);},
  async run(sql,params=[]){const s=sqliteStatement(sql,params);return {rowCount:Number(sqlite.prepare(s.sql).run(...s.params).changes)};},
 };
 return {db,provider,apps:[app],request:featureHttp([app]),engine:'sqlite-local'};
}

export function installFeatureHttpSuite(label,makeFixture){
 test(`${label}: pet and manual billing enforce authorization through HTTP`,{timeout:60000},async t=>{
  const f=await makeFixture(t);t.diagnostic(`HTTP integration database: ${f.engine}`);
  async function account(role='player'){
   const uid=unique(),email=uid+'@example.test';await f.db.run('INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',[uid,email,'HTTP '+role,passwordHash(password),role,Date.now()]);
   const login=await f.request('/api/login',{method:'POST',body:{email,password}});good(login);return {id:uid,email,cookie:login.cookie};
  }
  const admin=await account('admin'),player=await account(),other=await account(),business=await account('business'),otherBusiness=await account('business');
  const order=async(actor,plan,key=unique(),extra={})=>good(await f.request('/api/billing/orders',{cookie:actor.cookie,method:'POST',body:{plan,idempotencyKey:key,...extra}})).order;
  const confirm=async(item,reference=unique())=>good(await f.request(`/api/admin/billing/${item.id}/confirm`,{cookie:admin.cookie,method:'POST',body:{paymentReference:reference}}));
  let playerOrder,businessOrder,promotion;

  await t.test('public catalog is safe, price is server-owned, financial actions require MFA',async()=>{
   const catalog=good(await f.request('/api/billing/catalog'));assert.equal(catalog.checkoutAvailable,true);assert.equal(catalog.pilot,true);assert.equal(catalog.plans.find(p=>p.id==='plus').amount,1749);
   const native=good(await f.request('/api/billing/catalog',{headers:{'X-CityQuest-Client':'native'}}));assert.equal(native.checkoutAvailable,false);assert.equal(native.nativePurchasesAvailable,false);
   assert.equal((await f.request('/api/billing/me')).status,401);
   assert.equal((await f.request('/api/billing/orders',{cookie:player.cookie,method:'POST',headers:{Origin:'https://untrusted.example'},body:{plan:'plus',idempotencyKey:unique()}})).status,403);
   const key=unique(),results=await Promise.all([0,1,0].map(index=>f.request('/api/billing/orders',{index,cookie:player.cookie,method:'POST',body:{plan:'plus',idempotencyKey:key,amount:1,currency:'USD',user_id:other.id}})));
   playerOrder=good(results[0]).order;assert.ok(results.every(result=>good(result).order.id===playerOrder.id));assert.equal(playerOrder.amount,1749);assert.equal(playerOrder.currency,'KZT');assert.equal(playerOrder.user_id,player.id);
   assert.equal((await f.db.get('SELECT count(*) n FROM billing_orders WHERE user_id=$1',[player.id])).n,1);
   assert.equal((await f.request('/api/billing/orders',{cookie:player.cookie,method:'POST',headers:{'X-CityQuest-Client':'native'},body:{plan:'plus',idempotencyKey:unique()}})).status,403);
   assert.equal((await f.request(`/api/admin/billing/${playerOrder.id}/confirm`,{cookie:player.cookie,method:'POST',body:{paymentReference:'player-cannot-grant'}})).status,403);
   assert.equal((await f.request(`/api/admin/billing/${playerOrder.id}/confirm`,{cookie:admin.cookie,method:'POST',body:{paymentReference:'mfa-is-required'}})).status,403);
   assert.equal((await f.db.get('SELECT count(*) n FROM billing_entitlements WHERE user_id=$1',[player.id])).n,0);
   const setup=good(await f.request('/api/auth/mfa/setup',{cookie:admin.cookie,method:'POST',body:{password}}));good(await f.request('/api/auth/mfa/enable',{cookie:admin.cookie,method:'POST',body:{code:totp(setup.secret)}}));
   const reference=unique(),grants=await Promise.all([0,1,0].map(index=>f.request(`/api/admin/billing/${playerOrder.id}/confirm`,{index,cookie:admin.cookie,method:'POST',body:{paymentReference:reference}})));
   assert.equal(grants.filter(result=>good(result).idempotent===false).length,1);assert.ok(grants.every(result=>result.body.moneyTransferred===false));
   const paid=grants[0].body.order;assert.equal(paid.service_ends_at-paid.service_starts_at,30*86400000);assert.equal((await f.db.get('SELECT count(*) n FROM billing_entitlements WHERE order_id=$1',[playerOrder.id])).n,1);
   assert.equal(good(await f.request('/api/billing/me',{cookie:player.cookie})).entitlements.playerPlan,'plus');
   const own=good(await f.request('/api/billing/me?userId='+player.id,{cookie:other.cookie}));assert.deepEqual(own.orders,[]);assert.equal(own.entitlements.playerPlan,'free');
   const otherOrder=await order(other,'plus');assert.equal((await f.request(`/api/admin/billing/${otherOrder.id}/confirm`,{cookie:admin.cookie,method:'POST',body:{paymentReference:reference}})).status,409);
   assert.equal((await f.db.get('SELECT count(*) n FROM billing_entitlements WHERE order_id=$1',[otherOrder.id])).n,0);
   const forbidden=await f.request('/api/billing/orders',{cookie:other.cookie,method:'POST',body:{plan:'business_start',idempotencyKey:unique()}});assert.equal(forbidden.status,403);
  });

  await t.test('pet belongs to its session owner and daily or quest rewards cannot be replayed',async()=>{
   good(await f.request('/api/pet/help'));assert.equal((await f.request('/api/pet')).status,401);
   const adopted=good(await f.request('/api/pet/adopt',{cookie:player.cookie,method:'POST',body:{name:'Алма',species:'fox',color:'mint',user_id:other.id}}));assert.equal(adopted.pet.name,'Алма');
   assert.equal(good(await f.request('/api/pet?userId='+player.id,{cookie:other.cookie})).pet,null);
   good(await f.request('/api/pet/adopt',{cookie:other.cookie,method:'POST',body:{name:'Друг',species:'cat',color:'mint'}}));
   const cared=await Promise.all([0,1,0,1].map(index=>f.request('/api/pet/care',{index,cookie:player.cookie,method:'POST',body:{action:'feed'}})));
   assert.equal(cared.filter(result=>good(result).rewarded).length,1);assert.equal(good(await f.request('/api/pet',{cookie:player.cookie})).pet.xp,10);assert.equal(good(await f.request('/api/pet',{cookie:other.cookie})).pet.xp,0);
   const q=good(await f.request('/api/manage/quests',{cookie:admin.cookie,method:'POST',body:{city_id:'almaty',title:'HTTP pet reward',description:'Пройти это задание для проверки награды',...at,radius:100,xp:100,verification:'checkin',scope:'public',status:'published'}})).item;
   good(await f.request('/api/location',{cookie:player.cookie,method:'POST',body:{city_id:'almaty',...at,accuracy:5,timestamp:Date.now()}}));
   const completions=await Promise.all([0,1].map(index=>f.request(`/api/quests/${q.id}/complete`,{index,cookie:player.cookie,method:'POST',body:{}})));assert.equal(completions.filter(result=>good(result).alreadyCompleted===false).length,1);
   const first=good(await f.request('/api/pet',{cookie:player.cookie})),again=good(await f.request('/api/pet',{index:1,cookie:player.cookie}));assert.equal(first.pet.xp,30);assert.equal(again.pet.xp,30);assert.equal((await f.db.get('SELECT count(*) n FROM pet_rewards WHERE user_id=$1 AND event_key=$2',[player.id,'quest:'+q.id])).n,1);
  });

  await t.test('AI consent and history are private; idempotent retries do not call the provider again',async()=>{
   const requestId=unique(),message='Сегодня непростой рабочий день, хочется спокойного разговора.';
   const before=f.provider.calls.length;
   assert.equal((await f.request('/api/pet/chat',{cookie:player.cookie,method:'POST',body:{message,requestId}})).status,403);assert.equal(f.provider.calls.length,before);
   assert.equal((await f.request('/api/pet',{cookie:player.cookie,method:'PATCH',body:{consent:true}})).status,400);
   good(await f.request('/api/pet',{cookie:player.cookie,method:'PATCH',body:{adultAttested:true,consent:true}}));
   const reply=good(await f.request('/api/pet/chat',{cookie:player.cookie,method:'POST',body:{message,requestId,userId:other.id}}));assert.equal(reply.mode,'ai');assert.equal(reply.replayed,false);assert.equal(f.provider.calls.length,before+3);
   const retried=good(await f.request('/api/pet/chat',{index:1,cookie:player.cookie,method:'POST',body:{message,requestId}}));assert.equal(retried.replayed,true);assert.equal(f.provider.calls.length,before+3);
   assert.equal((await f.request('/api/pet/chat',{cookie:player.cookie,method:'POST',body:{message:'Другое сообщение',requestId}})).status,409);
   const view=good(await f.request('/api/pet',{cookie:player.cookie}));assert.ok(view.history.some(row=>row.text===message));assert.deepEqual(good(await f.request('/api/pet?user_id='+player.id,{cookie:other.cookie})).history,[]);
   const ciphertext=await f.db.all('SELECT content_cipher FROM pet_messages WHERE user_id=$1',[player.id]);assert.ok(ciphertext.length>=2);assert.equal(JSON.stringify(ciphertext).includes(message),false);
   const logs=await f.db.all('SELECT metadata FROM audit');assert.equal(JSON.stringify(logs).includes(message),false);
   const generation=f.provider.calls.find(call=>call.url.endsWith('/responses'));assert.equal(generation.body.store,false);assert.equal(Object.hasOwn(generation.body,'tools'),false);assert.equal(JSON.stringify(generation.body).includes(player.email),false);assert.equal(JSON.stringify(generation.body).includes(String(at.lng)),false);
   good(await f.request('/api/pet/history',{index:1,cookie:player.cookie,method:'DELETE'}));assert.deepEqual(good(await f.request('/api/pet',{cookie:player.cookie})).history,[]);
   assert.equal((await f.request('/api/pet/chat',{cookie:player.cookie,method:'POST',body:{message,requestId}})).status,409);assert.equal(f.provider.calls.length,before+3);
  });

  await t.test('deleting history during an AI request cannot restore the deleted conversation',async()=>{
   const pending=f.provider.pause(),requestId=unique();
   const reply=f.request('/api/pet/chat',{cookie:player.cookie,method:'POST',body:{message:'Поговорим о планах на завтра.',requestId}});
   await pending.started;
   try{good(await f.request('/api/pet/history',{index:1,cookie:player.cookie,method:'DELETE'}));}finally{pending.release();}
   assert.equal((await reply).status,409);assert.deepEqual(good(await f.request('/api/pet',{cookie:player.cookie})).history,[]);
   assert.equal((await f.db.get('SELECT count(*) n FROM pet_messages WHERE user_id=$1',[player.id])).n,0);
   assert.equal((await f.db.get('SELECT reply_cipher FROM pet_chat_requests WHERE user_id=$1 AND request_id=$2',[player.id,requestId])).reply_cipher,null);
  });

  await t.test('revoking a session during provider generation prevents returning or saving its reply',async()=>{
   good(await f.request('/api/pet',{cookie:other.cookie,method:'PATCH',body:{adultAttested:true,consent:true}}));
   const pending=f.provider.pause();
   const reply=f.request('/api/pet/chat',{cookie:other.cookie,method:'POST',body:{message:'Хочу придумать спокойный план на выходные.',requestId:unique()}});
   await pending.started;
   try{good(await f.request('/api/logout',{index:1,cookie:other.cookie,method:'POST',body:{}}));}finally{pending.release();}
   assert.equal((await reply).status,401);
   assert.equal((await f.db.get('SELECT count(*) n FROM pet_messages WHERE user_id=$1',[other.id])).n,0);
   assert.equal((await f.request('/api/pet',{cookie:other.cookie})).status,401);
  });

  await t.test('moderation outage fails closed; urgent support is available without consent or quota',async()=>{
   const before=f.provider.calls.length;f.provider.setFailure(true);
   const failed=await f.request('/api/pet/chat',{cookie:player.cookie,method:'POST',body:{message:'Хочу немного обсудить свой день.',requestId:unique()}});f.provider.setFailure(false);assert.equal(failed.status,503);
   assert.equal(f.provider.calls.length,before+1);assert.ok(f.provider.calls.at(-1).url.endsWith('/moderations'));
   assert.deepEqual(good(await f.request('/api/pet',{cookie:player.cookie})).history,[]);
   good(await f.request('/api/pet',{cookie:player.cookie,method:'PATCH',body:{consent:false}}));
   await f.db.run('INSERT INTO pet_usage(day,user_id,count) VALUES($1,$2,1000) ON CONFLICT(day,user_id) DO UPDATE SET count=1000',[Math.floor(Date.now()/86400000),player.id]);
   const support=good(await f.request('/api/pet/chat',{cookie:player.cookie,method:'POST',body:{message:'Я не хочу жить',requestId:unique()}}));assert.equal(support.mode,'support');assert.equal(f.provider.calls.length,before+1);
   assert.equal((await f.db.get('SELECT count(*) n FROM pet_messages WHERE user_id=$1',[player.id])).n,0);
  });

  await t.test('promotions need owned approved places, paid access and explicit moderation',async()=>{
   businessOrder=await order(business,'business_start');await confirm(businessOrder);
   const org=good(await f.request('/api/manage/organizations',{cookie:admin.cookie,method:'POST',body:{name:'HTTP место бизнеса',category:'cafe',...at,city_id:'almaty',status:'approved',owner_id:business.id}})).item;
   const foreign=good(await f.request('/api/manage/organizations',{cookie:admin.cookie,method:'POST',body:{name:'HTTP чужое место',category:'cafe',...at,city_id:'almaty',status:'approved',owner_id:otherBusiness.id}})).item;
   const payload={organizationId:org.id,title:'Тестовая реклама',description:'Явно отмеченная рекламная кампания'};
   assert.equal((await f.request('/api/manage/promotions?city=almaty',{cookie:business.cookie,method:'POST',body:{...payload,organizationId:foreign.id}})).status,403);
   promotion=good(await f.request('/api/manage/promotions?city=almaty',{cookie:business.cookie,method:'POST',body:payload})).item;assert.equal(promotion.status,'pending');
   assert.equal(good(await f.request('/api/promotions?city=almaty')).items.some(row=>row.id===promotion.id),false);
   assert.equal((await f.request(`/api/admin/promotions/${promotion.id}/review`,{cookie:business.cookie,method:'POST',body:{version:promotion.version,status:'approved'}})).status,403);
   const approved=good(await f.request(`/api/admin/promotions/${promotion.id}/review`,{cookie:admin.cookie,method:'POST',body:{version:promotion.version,status:'approved'}})).item;
   const visible=good(await f.request('/api/promotions?city=almaty')).items.find(row=>row.id===promotion.id);assert.equal(visible.label,'Реклама');assert.equal(Object.hasOwn(visible,'owner_id'),false);assert.equal(good(await f.request('/api/promotions?city=astana')).items.some(row=>row.id===promotion.id),false);
   assert.equal((await f.request(`/api/manage/promotions/${promotion.id}`,{cookie:otherBusiness.cookie,method:'PATCH',body:{version:approved.version,status:'archived'}})).status,403);
   assert.equal((await f.request(`/api/manage/promotions/${promotion.id}`,{cookie:business.cookie,method:'PATCH',body:{version:promotion.version,title:'Stale edit'}})).status,409);
   await f.db.run('UPDATE billing_entitlements SET ends_at=$1,starts_at=$2 WHERE order_id=$3',[Date.now()-1,Date.now()-86400000,businessOrder.id]);assert.equal(good(await f.request('/api/promotions?city=almaty')).items.some(row=>row.id===promotion.id),false);
  });

  await t.test('refund records are idempotent, revoke features, and stale sessions cannot create orders',async()=>{
   const refunds=await Promise.all([0,1,0].map(index=>f.request(`/api/admin/billing/${playerOrder.id}/refund`,{index,cookie:admin.cookie,method:'POST',body:{note:'Внешний возврат подтверждён оператором'}})));
   assert.equal(refunds.filter(result=>good(result).idempotent===false).length,1);assert.ok(refunds.every(result=>result.body.moneyTransferred===false));
   assert.equal(good(await f.request('/api/billing/me',{cookie:player.cookie})).entitlements.playerPlan,'free');
   assert.equal((await f.db.get('SELECT count(*) n FROM billing_entitlements WHERE order_id=$1 AND revoked_at IS NULL',[playerOrder.id])).n,0);
   assert.equal((await f.request(`/api/admin/billing/${playerOrder.id}/confirm`,{cookie:admin.cookie,method:'POST',body:{paymentReference:'cannot-regrant-refunded'}})).status,409);
   const fresh=await account();await f.db.run('DELETE FROM sessions WHERE user_id=$1',[fresh.id]);
   assert.equal((await f.request('/api/billing/orders',{cookie:fresh.cookie,method:'POST',body:{plan:'plus',idempotencyKey:unique()}})).status,401);
   assert.equal((await f.request('/api/pet/adopt',{cookie:fresh.cookie,method:'POST',body:{name:'Недоступно',species:'fox'}})).status,401);
   assert.equal((await f.db.get('SELECT count(*) n FROM billing_orders WHERE user_id=$1',[fresh.id])).n,0);
  });
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))installFeatureHttpSuite('SQLite v4',sqliteFixture);
