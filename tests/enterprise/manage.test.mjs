import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestDatabase} from './db-fixture.mjs';
import {createManageRoutes} from '../../src/enterprise/manage-routes.mjs';
import {appendAudit,verifyAudit} from '../../src/enterprise/security-store.mjs';
import {hash,fail} from '../../src/domain.mjs';

const coords={almaty:{lng:76.947,lat:43.249},astana:{lng:71.4304,lat:51.1282}};
const auditKey=Buffer.alloc(32,19),unique=()=>randomBytes(10).toString('hex');
const rejectsStatus=(work,status)=>assert.rejects(work,error=>error.status===status);

async function fixture(t) {
 const storage=await createTestDatabase({seed:false}),{db,db2}=storage;
 t.after(()=>storage.close());const route=createManageRoutes(),cfg={idleMs:30*60000,requireAdminMfa:false};
 const audit=(tx,actor,action,target,metadata={})=>appendAudit(tx,{actor,action,target,metadata,requestId:'manage-test'},auditKey);
 function required(user,roles){if(!user)fail('Войдите в аккаунт',401);if(roles&&!roles.includes(user.role))fail('Недостаточно прав',403);return user;}
 async function account(role='admin',extra={}){
  const uid=unique(),now=Date.now();await db.run('INSERT INTO users(id,email,name,password,role,created_at,password_login_enabled) VALUES($1,$2,$3,$4,$5,$6,$7)',[uid,uid+'@example.test','Тест '+role,'unused-test-password',role,now,extra.password_login_enabled??1]);
  const sid=unique();await db.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$3,$4,$5,$5,0)',[hash(unique()),sid,uid,now+3600000,now]);
  return {...await db.get('SELECT * FROM users WHERE id=$1',[uid]),session_id:sid,session_mfa_verified:0};
 }
 async function call(path,{user,body,method='GET',connection=db,auditOverride=audit}={}){
  const url=new URL(path,'http://test.invalid');
  return route({db:connection,cfg,req:{method},res:{},url,path:url.pathname,method,cityId:url.searchParams.get('city')||'almaty',user,required,readBody:async()=>body,audit:auditOverride,throttle:async()=>{},requestId:'manage-test'});
 }
 const organization=(user,city='astana',extra={})=>call('/api/manage/organizations',{user,method:'POST',body:{city_id:city,name:'Место '+unique(),category:'cafe',...coords[city],status:'approved',...extra}}).then(x=>x.item);
 const quest=(user,city='astana',extra={})=>call('/api/manage/quests',{user,method:'POST',body:{city_id:city,title:'Квест '+unique(),description:'Описание задания для проверки PostgreSQL',...coords[city],verification:'checkin',status:'published',...extra}}).then(x=>x.item);
 return {db,db2,engine:storage.engine,account,call,organization,quest};
}

test('PostgreSQL management API preserves moderation, ownership and atomic changes',async t=>{
 const f=await fixture(t);t.diagnostic(`Database engine: ${f.engine}`);
 const admin=await f.account(),otherAdmin=await f.account(),business=await f.account('business'),otherBusiness=await f.account('business'),player=await f.account('player');

 await t.test('city dashboards and business moderation keep private fields out',async()=>{
  const pending=await f.organization(business,'astana',{status:'approved',owner_id:otherBusiness.id});assert.equal(pending.status,'pending');assert.equal(pending.owner_id,business.id);
  const published=await f.call('/api/manage/organizations/'+pending.id,{user:admin,method:'PATCH',body:{version:1,status:'approved'}});assert.equal(published.item.version,2);
  await f.organization(business,'almaty');
  const q=await f.quest(business,'astana',{organization_id:pending.id,status:'pending',verification:'code',code:'SAMPLE-CODE'});assert.equal(q.status,'pending');assert.equal(Object.hasOwn(q,'code_hash'),false);
  await rejectsStatus(()=>f.quest(business,'astana',{organization_id:pending.id,status:'published'}),400);
  await rejectsStatus(()=>f.quest(otherBusiness,'astana',{organization_id:pending.id,status:'pending'}),403);
  await rejectsStatus(()=>f.quest(business,'almaty',{organization_id:pending.id,status:'pending'}),400);
  await rejectsStatus(()=>f.quest(admin,'astana',{scope:'public',assigned_to:player.id}),400);
  for(const city of ['almaty','astana']){
   const result=await f.call('/api/manage?city='+city,{user:business});assert.ok(result.organizations.length);assert.ok(result.organizations.every(row=>row.city_id===city&&row.owner_id===business.id));assert.ok(result.quests.every(row=>row.city_id===city&&row.owner_id===business.id));assert.deepEqual(result.users,[]);assert.deepEqual(result.audit,[]);assert.equal(JSON.stringify(result).includes('SAMPLE-CODE'),false);assert.equal(JSON.stringify(result).includes('code_hash'),false);
  }
  await rejectsStatus(()=>f.call('/api/manage',{user:player}),403);
  await rejectsStatus(()=>f.call('/api/manage'),401);
  assert.equal(await f.call('/api/other-route'),undefined);
 });

 await t.test('two editors race without overwriting a committed version',async()=>{
  for(const kind of ['organizations','quests']){
   const item=kind==='organizations'?await f.organization(admin):await f.quest(admin),field=kind==='organizations'?'name':'title',path='/api/manage/'+kind+'/'+item.id;
   const results=await Promise.allSettled([admin,otherAdmin].map((user,i)=>f.call(path,{user,method:'PATCH',connection:i?f.db2:f.db,body:{version:item.version,[field]:'Concurrent '+i}})));
   assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
   assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
   const row=await f.db.get(`SELECT * FROM ${kind} WHERE id=$1`,[item.id]);assert.equal(row.version,2);assert.match(row[field],/^Concurrent [01]$/);
   await rejectsStatus(()=>f.call(path,{user:admin,method:'PATCH',body:{[field]:'No version'}}),409);
  }
 });

 await t.test('reward tokens are one-time secrets and moderation revokes outstanding codes',async()=>{
  const org=await f.organization(admin,'astana',{owner_id:business.id});
  const pending=await f.quest(business,'astana',{organization_id:org.id,status:'pending',verification:'token',ends_at:Date.now()+180000});
  const q=(await f.call('/api/manage/quests/'+pending.id,{user:admin,method:'PATCH',body:{version:pending.version,status:'published'}})).item;
  const issued=await f.call(`/api/manage/quests/${q.id}/tokens`,{user:business,method:'POST',body:{count:3,expires_in_minutes:60}});
  assert.equal(issued.tokens.length,3);for(const token of issued.tokens){assert.match(token.code,/^[A-F0-9]{24}$/);assert.equal(token.expires_at,q.ends_at);const stored=await f.db.get('SELECT token_hash FROM reward_tokens WHERE id=$1',[token.id]);assert.equal(stored.token_hash,hash(token.code));assert.notEqual(stored.token_hash,token.code);}
  await rejectsStatus(()=>f.call(`/api/manage/quests/${q.id}/tokens`,{user:otherBusiness,method:'POST',body:{count:1}}),403);
  const rewards=await f.call('/api/manage/rewards?city=astana',{user:business});assert.equal(rewards.items.find(row=>row.id===q.id).issued,3);
  const history=await f.call(`/api/manage/quests/${q.id}/redemptions`,{user:business});assert.ok(history.items.every(row=>row.state==='active'));assert.equal(JSON.stringify(history).includes('token_hash'),false);assert.equal(JSON.stringify(history).includes(issued.tokens[0].code),false);
  await f.call('/api/manage/organizations/'+org.id,{user:admin,method:'PATCH',body:{version:org.version,status:'rejected'}});
  const changed=await f.db.get('SELECT status,version FROM quests WHERE id=$1',[q.id]);assert.equal(changed.status,'pending');assert.equal(changed.version,q.version+1);
  const revoked=await f.call(`/api/manage/quests/${q.id}/redemptions`,{user:business});assert.ok(revoked.items.every(row=>row.state==='revoked'));
  await rejectsStatus(()=>f.call(`/api/manage/quests/${q.id}/tokens`,{user:business,method:'POST',body:{count:1}}),400);
 });

 await t.test('fresh role and ownership checks reject a stale request context',async()=>{
  const temporary=await f.account('business'),org=await f.organization(temporary);
  await f.call('/api/manage/organizations/'+org.id,{user:admin,method:'PATCH',body:{version:org.version,owner_id:otherBusiness.id,status:'approved'}});
  await rejectsStatus(()=>f.call('/api/manage/organizations/'+org.id,{user:temporary,method:'PATCH',body:{version:2,name:'Stolen edit'}}),403);
  await f.db.run("UPDATE users SET role='player' WHERE id=$1",[temporary.id]);
  await rejectsStatus(()=>f.organization(temporary),401);
  const unclaimed=await f.call('/api/manage/organizations/'+org.id,{user:admin,method:'PATCH',body:{version:2,owner_id:null}});assert.equal(unclaimed.item.owner_id,null);
 });

 await t.test('account access changes revoke all sessions and block SSO-only admin promotion',async()=>{
  const target=await f.account('business');
  await f.db.run('INSERT INTO login_challenges(id_hash,user_id,expires) VALUES($1,$2,$3)',[hash(unique()),target.id,Date.now()+10000]);
  await f.db.run('INSERT INTO mobile_auth_codes(code_hash,user_id,code_challenge,expires,created_at) VALUES($1,$2,$3,$4,$5)',[hash(unique()),target.id,'x'.repeat(43),Date.now()+120000,Date.now()]);
  await f.call('/api/manage/users/'+target.id,{user:admin,method:'PATCH',body:{role:'player',disabled:true}});
  assert.equal((await f.db.get('SELECT count(*) n FROM sessions WHERE user_id=$1',[target.id])).n,0);
  assert.equal((await f.db.get('SELECT count(*) n FROM login_challenges WHERE user_id=$1',[target.id])).n,0);
  assert.equal((await f.db.get('SELECT count(*) n FROM mobile_auth_codes WHERE user_id=$1',[target.id])).n,0);
  assert.deepEqual(await f.db.get('SELECT role,disabled FROM users WHERE id=$1',[target.id]),{role:'player',disabled:1});
  await rejectsStatus(()=>f.call('/api/manage/users/'+admin.id,{user:admin,method:'PATCH',body:{disabled:true}}),400);
  const ssoOnly=await f.account('player',{password_login_enabled:0});
  await rejectsStatus(()=>f.call('/api/manage/users/'+ssoOnly.id,{user:admin,method:'PATCH',body:{role:'admin'}}),409);
  assert.equal((await f.db.get('SELECT role FROM users WHERE id=$1',[ssoOnly.id])).role,'player');
 });

 await t.test('OSM imports preserve claimed cards, city IDs and optimistic versions',async()=>{
  const base=Number.parseInt(unique().slice(0,10),16),nodes=[base,base+1,base+2];
  const data={osm3s:{timestamp_osm_base:'2026-09-23T12:00:00Z'},elements:nodes.map((node,i)=>({type:'node',id:node,lon:coords.astana.lng,lat:coords.astana.lat,tags:{name:'Imported '+i,amenity:'cafe'}}))};
  const first=await f.call('/api/manage/osm?city=astana',{user:admin,method:'POST',body:data});assert.deepEqual(first,{inserted:3,updated:0,skipped:0});
  const rows=await f.db.all('SELECT * FROM organizations WHERE osm_id=ANY($1::text[]) ORDER BY osm_id',[nodes.map(node=>'node/'+node)]),unclaimed=rows[0],claimed=rows[1],otherCity=rows[2];
  await f.call('/api/manage/organizations/'+claimed.id,{user:admin,method:'PATCH',body:{version:claimed.version,owner_id:business.id,name:'Business protected name'}});
  await f.db.run("UPDATE organizations SET city_id='almaty' WHERE id=$1",[otherCity.id]);
  const changed={...data,elements:[...data.elements.map(item=>({...item,tags:{...item.tags,name:'OSM new name'}})),data.elements[0],{type:'node',id:base+3,lon:0,lat:0,tags:{name:'Out of bounds'}}]};
  const second=await f.call('/api/manage/osm?city=astana',{user:otherAdmin,method:'POST',body:changed});assert.deepEqual(second,{inserted:0,updated:1,skipped:4});
  assert.equal((await f.db.get('SELECT version FROM organizations WHERE id=$1',[unclaimed.id])).version,unclaimed.version+1);
  assert.equal((await f.db.get('SELECT name FROM organizations WHERE id=$1',[claimed.id])).name,'Business protected name');
  assert.equal((await f.db.get('SELECT city_id FROM organizations WHERE id=$1',[otherCity.id])).city_id,'almaty');
  await rejectsStatus(()=>f.call('/api/manage/organizations/'+unclaimed.id,{user:admin,method:'PATCH',body:{version:unclaimed.version,name:'Stale editor'}}),409);
  await rejectsStatus(()=>f.call('/api/manage/osm?city=astana',{user:admin,method:'POST',body:{...data,remark:'runtime error'}}),400);
  await rejectsStatus(()=>f.call('/api/manage/osm?city=astana',{user:business,method:'POST',body:data}),403);
  const query=await f.call('/api/manage/osm-query?city=astana',{user:admin});assert.match(query.query,/50\.95,71\.2,51\.35,71\.75/);
 });

 await t.test('audit failure rolls back catalog edits, imports and metadata',async()=>{
  const failedAudit=async()=>{throw new Error('Audit unavailable');},name='Rollback '+unique();
  await assert.rejects(()=>f.call('/api/manage/organizations',{user:admin,method:'POST',body:{city_id:'astana',name,...coords.astana},auditOverride:failedAudit}),/Audit unavailable/);
  assert.equal((await f.db.get('SELECT count(*) n FROM organizations WHERE name=$1',[name])).n,0);
  const before=await f.db.get("SELECT value FROM meta WHERE key='osm_import_astana'"),node=Number.parseInt(unique().slice(0,10),16);
  await assert.rejects(()=>f.call('/api/manage/osm?city=astana',{user:admin,method:'POST',body:{elements:[{type:'node',id:node,lon:coords.astana.lng,lat:coords.astana.lat,tags:{name:'Atomic OSM'}}]},auditOverride:failedAudit}),/Audit unavailable/);
  assert.equal(await f.db.get('SELECT id FROM organizations WHERE osm_id=$1',['node/'+node]),undefined);
  assert.deepEqual(await f.db.get("SELECT value FROM meta WHERE key='osm_import_astana'"),before);
  assert.equal((await verifyAudit(f.db,auditKey)).ok,true);
 });
});
