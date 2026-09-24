import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {hash} from '../src/domain.mjs';

async function fixture(t){
 const db=openDb(':memory:',{withSnapshot:false}),{server}=createApp({db,env:{NODE_ENV:'test'}}),now=Date.now();
 const credentials={};
 for(const role of ['admin','business','player']){
  const uid=`u7-${role}`,token=randomBytes(32).toString('hex');credentials[role]=`aq_session=${token}`;
  db.prepare('INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run(uid,uid+'@example.test',uid,'no-password-login',role,now);
  db.prepare('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,0)').run(hash(token),uid+'-session',uid,now+300000,now,now);
 }
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();});
 const request=async(path,{method='GET',body,role='admin'}={})=>{
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{cookie:credentials[role],'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  return{status:response.status,body:await response.json()};
 };
 const organization=async()=>{
  const result=await request('/manage/organizations',{method:'POST',body:{name:'Отзываемая организация',category:'cafe',lng:76.95,lat:43.25,status:'approved',owner_id:'u7-business'}});
  assert.equal(result.status,200,JSON.stringify(result.body));return result.body.item;
 };
 return{db,request,organization};
}

test('u7: clearing an organization owner persists null and removes the previous business access',async t=>{
 const f=await fixture(t),org=await f.organization();
 const changed=await f.request(`/manage/organizations/${org.id}`,{method:'PATCH',body:{version:org.version,owner_id:null}});
 assert.equal(changed.status,200);assert.equal(changed.body.item.owner_id,null);
 assert.equal(f.db.prepare('SELECT owner_id FROM organizations WHERE id=?').get(org.id).owner_id,null);
 assert.equal((await f.request('/manage',{role:'business'})).body.organizations.some(row=>row.id===org.id),false);
 const oldOwner=await f.request(`/manage/organizations/${org.id}`,{method:'PATCH',role:'business',body:{version:changed.body.item.version,name:'Недопустимая правка'}});
 assert.equal(oldOwner.status,403);
});

test('u7: malformed organization owner IDs fail as validation errors without changing the card',async t=>{
 const f=await fixture(t),org=await f.organization();
 for(const owner_id of [{id:'u7-player'},['u7-player'],42,true,'bad id']){
  const result=await f.request(`/manage/organizations/${org.id}`,{method:'PATCH',body:{version:org.version,owner_id}});
  assert.equal(result.status,400,JSON.stringify({owner_id,response:result}));
 }
 assert.deepEqual({...f.db.prepare('SELECT owner_id,version FROM organizations WHERE id=?').get(org.id)},{owner_id:'u7-business',version:org.version});
});

test('u7: malformed quest assignee IDs fail before insertion',async t=>{
 const f=await fixture(t),count=f.db.prepare('SELECT count(*) AS n FROM quests').get().n;
 for(const assigned_to of [{id:'u7-player'},['u7-player'],42,true,'bad id']){
  const result=await f.request('/manage/quests',{method:'POST',body:{title:'Персональный тест',description:'Проверяем валидацию назначения игроку',lng:76.95,lat:43.25,scope:'personal',status:'published',assigned_to}});
  assert.equal(result.status,400,JSON.stringify({assigned_to,response:result}));
 }
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM quests').get().n,count);
});

test('u7: malformed quest organization IDs fail before insertion',async t=>{
 const f=await fixture(t),count=f.db.prepare('SELECT count(*) AS n FROM quests').get().n;
 for(const organization_id of [{id:'invalid'},['invalid'],42,true,'bad id']){
  const result=await f.request('/manage/quests',{method:'POST',body:{title:'Организация квеста',description:'Проверяем валидацию организации квеста',lng:76.95,lat:43.25,status:'published',organization_id}});
  assert.equal(result.status,400,JSON.stringify({organization_id,response:result}));
 }
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM quests').get().n,count);
});

test('u7: malformed completion and team codes return 400 without rewards or membership changes',async t=>{
 const f=await fixture(t),quests=[];
 for(const verification of ['code','token']){
  const created=await f.request('/manage/quests',{method:'POST',body:{title:'Проверка кода '+verification,description:'Проверяем тип переданного кода подтверждения',lng:76.95,lat:43.25,verification,status:'published',code:'VALID-CODE'}});
  assert.equal(created.status,200,JSON.stringify(created.body));quests.push(created.body.item);
 }
 const position=await f.request('/location',{method:'POST',role:'player',body:{lng:76.95,lat:43.25,accuracy:5,timestamp:Date.now()}});assert.equal(position.status,200);
 for(const code of [{toString:null},[],{},42,true]){
  for(const quest of quests){
   const result=await f.request(`/quests/${quest.id}/complete`,{method:'POST',role:'player',body:{code}});
   assert.equal(result.status,400,JSON.stringify({verification:quest.verification,code,response:result}));
  }
  const joined=await f.request('/team/join',{method:'POST',role:'player',body:{code}});
  assert.equal(joined.status,400,JSON.stringify({code,response:joined}));
 }
 assert.equal(f.db.prepare("SELECT xp FROM users WHERE id='u7-player'").get().xp,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM completions WHERE user_id='u7-player'").get().n,0);
 assert.equal(f.db.prepare("SELECT count(*) n FROM members WHERE user_id='u7-player'").get().n,0);
});
