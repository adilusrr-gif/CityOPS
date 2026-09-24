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
  const uid=`v8-${role}`,token=randomBytes(32).toString('hex');credentials[role]=`aq_session=${token}`;
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
  const result=await request('/manage/organizations',{method:'POST',body:{name:'Отзываемая организация',category:'cafe',lng:76.95,lat:43.25,status:'approved',owner_id:'v8-business'}});
  assert.equal(result.status,200,JSON.stringify(result.body));return result.body.item;
 };
 return{db,request,organization};
}

test('v8: organization ownership revocation prevents former business issuing new rewards',async t=>{
 const f=await fixture(t),org=await f.organization();
 const created=await f.request('/manage/quests',{method:'POST',role:'business',body:{organization_id:org.id,title:'Награда организации',description:'Награда принадлежит текущему владельцу организации',lng:76.95,lat:43.25,status:'pending',verification:'token'}});
 assert.equal(created.status,200,JSON.stringify(created.body));let quest=created.body.item;
 const approved=await f.request(`/manage/quests/${quest.id}`,{method:'PATCH',body:{version:quest.version,status:'published'}});
 assert.equal(approved.status,200);quest=approved.body.item;
 const issue=()=>f.request(`/manage/quests/${quest.id}/tokens`,{method:'POST',role:'business',body:{count:1}});
 assert.equal((await issue()).status,200);
 const cleared=await f.request(`/manage/organizations/${org.id}`,{method:'PATCH',body:{version:org.version,owner_id:null}});
 assert.equal(cleared.status,200);
 const before=f.db.prepare('SELECT count(*) n FROM reward_tokens WHERE quest_id=?').get(quest.id).n;
 const denied=await issue();assert.equal(denied.status,403,JSON.stringify(denied.body));
 assert.equal(f.db.prepare('SELECT count(*) n FROM reward_tokens WHERE quest_id=?').get(quest.id).n,before);
 // Platform administrators retain the ability to manage the campaign.
 assert.equal((await f.request(`/manage/quests/${quest.id}/tokens`,{method:'POST',body:{count:1}})).status,200);
});

test('v8: business edits preserve administrator assignment through moderation',async t=>{
 const f=await fixture(t),org=await f.organization();
 const created=await f.request('/manage/quests',{method:'POST',role:'business',body:{organization_id:org.id,title:'Личная награда',description:'Индивидуальное задание с назначением администратора',lng:76.95,lat:43.25,status:'pending',scope:'personal'}});
 assert.equal(created.status,200,JSON.stringify(created.body));let quest=created.body.item;
 const assigned=await f.request(`/manage/quests/${quest.id}`,{method:'PATCH',body:{version:quest.version,status:'published',assigned_to:'v8-player'}});
 assert.equal(assigned.status,200);quest=assigned.body.item;
 const edited=await f.request(`/manage/quests/${quest.id}`,{method:'PATCH',role:'business',body:{version:quest.version,status:'pending',title:'Личная награда — новое название',assigned_to:null}});
 assert.equal(edited.status,200,JSON.stringify(edited.body));quest=edited.body.item;
 assert.equal(quest.assigned_to,'v8-player','A business cannot silently clear an administrator assignment');
 const broadened=await f.request(`/manage/quests/${quest.id}`,{method:'PATCH',role:'business',body:{version:quest.version,scope:'public',status:'pending'}});
 assert.equal(broadened.status,400,JSON.stringify(broadened.body));
 const approved=await f.request(`/manage/quests/${quest.id}`,{method:'PATCH',body:{version:quest.version,status:'published'}});
 assert.equal(approved.status,200);quest=approved.body.item;
 assert.equal((await f.request('/quests',{role:'business'})).body.items.some(row=>row.id===quest.id),false);
 assert.equal((await f.request('/quests',{role:'player'})).body.items.some(row=>row.id===quest.id),true);
 // Explicit release remains an administrator decision, not an editing side effect.
 const released=await f.request(`/manage/quests/${quest.id}`,{method:'PATCH',body:{version:quest.version,assigned_to:null}});
 assert.equal(released.status,200);assert.equal(released.body.item.assigned_to,null);
});

test('v8: epoch-zero quest end is expired in listing, completion and token issuance',async t=>{
 const f=await fixture(t),quests=[];
 for(const verification of ['checkin','token']){
  const created=await f.request('/manage/quests',{method:'POST',body:{title:'Уже завершено '+verification,description:'Нулевая дата окончания является датой, а не отсутствием даты',lng:76.95,lat:43.25,status:'published',verification,ends_at:0}});
  assert.equal(created.status,200,JSON.stringify(created.body));quests.push(created.body.item);
 }
 assert.equal((await f.request('/location',{role:'player',method:'POST',body:{lng:76.95,lat:43.25,accuracy:5,timestamp:Date.now()}})).status,200);
 const listed=(await f.request('/quests',{role:'player'})).body.items;
 for(const quest of quests){
  assert.equal(listed.find(row=>row.id===quest.id).available,false);
  const result=await f.request(`/quests/${quest.id}/complete`,{role:'player',method:'POST',body:{}});assert.equal(result.status,409,JSON.stringify(result.body));
 }
 const issue=await f.request(`/manage/quests/${quests[1].id}/tokens`,{method:'POST',body:{count:1}});assert.equal(issue.status,400,JSON.stringify(issue.body));
 assert.equal(f.db.prepare("SELECT count(*) n FROM completions WHERE user_id='v8-player'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM reward_tokens WHERE quest_id=?').get(quests[1].id).n,0);
});

test('v8: team location TTL expires and is never exposed without consent',async t=>{
 const f=await fixture(t),time=Date.now();t.mock.timers.enable({apis:['Date'],now:time});
 const created=await f.request('/team',{method:'POST',body:{name:'Команда приватности'}});assert.equal(created.status,200);
 assert.equal((await f.request('/team/join',{role:'player',method:'POST',body:{code:created.body.team.invite}})).status,200);
 assert.equal((await f.request('/location',{role:'player',method:'POST',body:{lng:76.95,lat:43.25,accuracy:5,timestamp:time}})).status,200);
 const member=async()=>(await f.request('/team')).body.members.find(row=>row.id==='v8-player');
 assert.equal((await member()).location,null);
 assert.equal((await f.request('/team/sharing',{role:'player',method:'PATCH',body:{enabled:true}})).status,200);
 t.mock.timers.setTime(time+5000);
 assert.deepEqual((await member()).location,{lng:76.95,lat:43.25,expiresInMs:55000});
 t.mock.timers.setTime(time+60000);assert.equal((await member()).location,null);
 assert.equal((await f.request('/location',{role:'player',method:'POST',body:{lng:76.95,lat:43.25,accuracy:5,timestamp:time+60000}})).status,200);
 assert.equal((await f.request('/team/sharing',{role:'player',method:'PATCH',body:{enabled:false}})).status,200);
 assert.equal((await member()).location,null);
});
