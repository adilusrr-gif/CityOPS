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

test('v8 PostgreSQL: business edits preserve administrator assignment until explicitly released',async t=>{
 const f=await fixture(t),admin=await f.account(),business=await f.account('business'),player=await f.account('player');
 const org=await f.organization(admin,'almaty',{owner_id:business.id});
 let quest=await f.quest(business,'almaty',{organization_id:org.id,status:'pending',scope:'personal'});
 const path='/api/manage/quests/'+quest.id;
 quest=(await f.call(path,{user:admin,method:'PATCH',body:{version:quest.version,status:'published',assigned_to:player.id}})).item;
 quest=(await f.call(path,{user:business,method:'PATCH',body:{version:quest.version,status:'pending',title:'Сохранить индивидуальный доступ',assigned_to:null}})).item;
 assert.equal(quest.assigned_to,player.id);
 await rejectsStatus(()=>f.call(path,{user:business,method:'PATCH',body:{version:quest.version,status:'pending',scope:'public'}}),400);
 quest=(await f.call(path,{user:admin,method:'PATCH',body:{version:quest.version,status:'published'}})).item;
 assert.equal(quest.assigned_to,player.id);
 quest=(await f.call(path,{user:admin,method:'PATCH',body:{version:quest.version,assigned_to:null}})).item;
 assert.equal(quest.assigned_to,null);
 t.diagnostic(`Database: ${f.engine}`);
});

test('v8 PostgreSQL: revoked organization ownership cannot issue reward tokens',async t=>{
 const f=await fixture(t),admin=await f.account(),business=await f.account('business');
 const org=await f.organization(admin,'almaty',{owner_id:business.id});
 let quest=await f.quest(business,'almaty',{organization_id:org.id,status:'pending',verification:'token'});
 quest=(await f.call('/api/manage/quests/'+quest.id,{user:admin,method:'PATCH',body:{version:quest.version,status:'published'}})).item;
 const issue=()=>f.call(`/api/manage/quests/${quest.id}/tokens`,{user:business,method:'POST',body:{count:1}});
 await issue();
 await f.call('/api/manage/organizations/'+org.id,{user:admin,method:'PATCH',body:{version:org.version,owner_id:null}});
 const before=Number((await f.db.get('SELECT count(*) n FROM reward_tokens WHERE quest_id=$1',[quest.id])).n);
 await rejectsStatus(issue,403);
 assert.equal(Number((await f.db.get('SELECT count(*) n FROM reward_tokens WHERE quest_id=$1',[quest.id])).n),before);
 const issued=await f.call(`/api/manage/quests/${quest.id}/tokens`,{user:admin,method:'POST',body:{count:1}});
 assert.equal(issued.tokens.length,1);
});

test('v8 PostgreSQL: epoch-zero end cannot mint a usable reward token',async t=>{
 const f=await fixture(t),admin=await f.account(),quest=await f.quest(admin,'almaty',{verification:'token',ends_at:0});
 await rejectsStatus(()=>f.call(`/api/manage/quests/${quest.id}/tokens`,{user:admin,method:'POST',body:{count:1}}),400);
 assert.equal(Number((await f.db.get('SELECT count(*) n FROM reward_tokens WHERE quest_id=$1',[quest.id])).n),0);
});
