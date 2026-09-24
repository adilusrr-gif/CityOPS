import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createGameRoutes} from '../../src/enterprise/game-routes.mjs';
import {createEnterpriseAuth} from '../../src/enterprise/auth.mjs';
import {appendAudit,verifyAudit} from '../../src/enterprise/security-store.mjs';
import {hash} from '../../src/domain.mjs';
import {createTestDatabase} from './db-fixture.mjs';

const locations={almaty:{lng:76.947,lat:43.249},astana:{lng:71.4304,lat:51.1282}};
const keys={encryptionKey:Buffer.alloc(32,27),auditKey:Buffer.alloc(32,31)};
let sequence=0;

async function harness(t){
  const fixture=await createTestDatabase();
  t.after(()=>fixture.close());
  const db=fixture.db,db2=fixture.db2||db;
  t.diagnostic(`Database engine: ${fixture.engine||'PostgreSQL'}; database handles: ${db2!==db?2:1}. PGlite serializes transactions; native PG_TEST_URL exercises concurrent connections.`);
  const audit=(tx,actor,action,target,metadata={})=>appendAudit(tx,{actor,action,target,metadata,requestId:'game-test'},keys.auditKey);
  const cfg={keys,idleMs:1800000,requireAdminMfa:false,secure:false,origin:'http://localhost',nativeOrigins:[]};
  const auth=[db,db2].map(database=>createEnterpriseAuth({db:database,cfg,audit,throttle:async()=>{},env:{}}));
  const route=createGameRoutes();
  async function player(role='player'){
    const suffix=++sequence,uid=`game-user-${suffix}`,now=Date.now(),sessionId=`game-session-${suffix}`;
    await db.run('INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',[uid,`${uid}@example.test`,`Игрок ${suffix}`,'test-no-password-login',role,now]);
    await db.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$3,$4,$5,$5,0)',[hash(sessionId),sessionId,uid,now+3600000,now]);
    return db.get('SELECT u.*,s.id AS session_id,s.expires,s.last_seen,s.mfa_verified AS session_mfa_verified FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1',[uid]);
  }
  async function call(path,user,{method='GET',body={},city='almaty',replica=0,auditOverride}={}){
    const url=new URL(path,'http://localhost');url.searchParams.set('city',city);
    return route({db:replica?db2:db,cfg,url,path:url.pathname,method,cityId:city,user,required:auth[replica].required,auth:auth[replica],readBody:async()=>body,audit:auditOverride||audit,throttle:async()=>{}});
  }
  async function quest(options={}){
    const selected=options.city_id||'almaty',q={id:`game-quest-${++sequence}`,city_id:selected,title:'Проверяемый квест',description:'Описание игрового маршрута',...locations[selected],radius:150,xp:100,scope:'public',assigned_to:null,verification:'checkin',code_hash:null,status:'published',goal:20,created_at:Date.now(),starts_at:null,ends_at:null,max_completions:null,...options};
    const columns=Object.keys(q);
    await db.run(`INSERT INTO quests(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,columns.map(column=>q[column]));
    return q;
  }
  async function locate(user,selected='almaty'){
    return call('/api/location',user,{method:'POST',body:{...locations[selected],city_id:selected,accuracy:5,timestamp:Date.now()}});
  }
  async function token(quest,issuer,code=randomBytes(12).toString('hex').toUpperCase(),expires=Date.now()+600000){
    const tid=`game-token-${++sequence}`;
    await db.run('INSERT INTO reward_tokens(id,quest_id,issuer_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[tid,quest.id,issuer.id,hash(code),Date.now(),expires]);
    return {id:tid,code};
  }
  return {db,db2,call,player,quest,locate,token};
}

test('game: completion is idempotent and a shared reward cap holds',async t=>{
  const h=await harness(t),first=await h.player(),second=await h.player(),quest=await h.quest({max_completions:1});
  await h.locate(first);await h.locate(second);
  const sameUser=await Promise.all(Array.from({length:4},(_,i)=>h.call(`/api/quests/${quest.id}/complete`,first,{method:'POST',replica:i%2})));
  assert.equal(sameUser.filter(result=>!result.alreadyCompleted).length,1);
  assert.equal(sameUser.reduce((sum,result)=>sum+result.xp,0),100);
  await assert.rejects(h.call(`/api/quests/${quest.id}/complete`,second,{method:'POST',replica:1}),{status:409});
  assert.equal((await h.db.get('SELECT xp FROM users WHERE id=$1',[first.id])).xp,100);
  assert.equal(Number((await h.db.get('SELECT count(*) AS n FROM completions WHERE quest_id=$1',[quest.id])).n),1);

  const contested=await h.quest({max_completions:1});
  const results=await Promise.allSettled([first,second].map((user,i)=>h.call(`/api/quests/${contested.id}/complete`,user,{method:'POST',replica:i})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.status,409);
  assert.equal((await verifyAudit(h.db,keys.auditKey)).ok,true);
});

test('game: a merchant token is single use across players and atomic with reward/audit',async t=>{
  const h=await harness(t),first=await h.player(),second=await h.player(),quest=await h.quest({verification:'token'});
  await h.locate(first);await h.locate(second);
  const token=await h.token(quest,first);
  const outcomes=await Promise.allSettled([first,second].map((user,i)=>h.call(`/api/quests/${quest.id}/complete`,user,{method:'POST',body:{code:token.code},replica:i})));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(Number((await h.db.get('SELECT count(*) AS n FROM completions WHERE quest_id=$1',[quest.id])).n),1);
  assert.equal(Number((await h.db.get('SELECT sum(xp) AS n FROM users')).n),100);
  const redeemed=await h.db.get('SELECT * FROM reward_tokens WHERE id=$1',[token.id]);
  assert.ok(redeemed.redeemed_at);assert.ok([first.id,second.id].includes(redeemed.redeemed_by));

  const rollbackQuest=await h.quest({verification:'token'}),rollbackToken=await h.token(rollbackQuest,first);
  await assert.rejects(h.call(`/api/quests/${rollbackQuest.id}/complete`,first,{method:'POST',body:{code:rollbackToken.code},auditOverride:async()=>{throw new Error('simulated audit storage failure');}}),/simulated audit/);
  assert.equal((await h.db.get('SELECT redeemed_at FROM reward_tokens WHERE id=$1',[rollbackToken.id])).redeemed_at,null);
  assert.equal(Number((await h.db.get('SELECT count(*) AS n FROM completions WHERE quest_id=$1',[rollbackQuest.id])).n),0);
  assert.equal(Number((await h.db.get('SELECT sum(xp) AS n FROM users')).n),100);
  assert.equal((await verifyAudit(h.db,keys.auditKey)).ok,true);
});

test('game: city progress, assigned quests, GPS, schedules and token expiry stay isolated',async t=>{
  const h=await harness(t),first=await h.player(),second=await h.player();
  const almaty=await h.quest(),astana=await h.quest({city_id:'astana'}),personal=await h.quest({scope:'personal',assigned_to:first.id});
  await h.locate(first);
  await assert.rejects(h.call('/api/location',first,{method:'POST',body:{...locations.almaty,lat:43.40,accuracy:5,timestamp:Date.now()}}),/резкое перемещение/);
  await assert.rejects(h.call('/api/location',first,{method:'POST',body:{...locations.almaty,accuracy:5,timestamp:Date.now()-180000}}),/Время GPS/);
  await h.call(`/api/quests/${almaty.id}/complete`,first,{method:'POST'});
  await assert.rejects(h.call(`/api/quests/${astana.id}/complete`,first,{method:'POST',city:'astana'}),/GPS/);
  assert.equal((await h.call('/api/progress',first,{city:'astana'})).cells.length,0);
  assert.equal((await h.call('/api/progress',first,{city:'astana'})).completed.length,0);
  const publicQuests=await h.call('/api/quests',null),otherQuests=await h.call('/api/quests',second);
  assert.ok(!publicQuests.items.some(item=>item.id===personal.id));assert.ok(!otherQuests.items.some(item=>item.id===personal.id));
  assert.ok((await h.call('/api/quests',first)).items.some(item=>item.id===personal.id));
  assert.ok((await h.call('/api/quests',first,{city:'astana'})).items.every(item=>item.city_id==='astana'));
  await assert.rejects(h.call(`/api/quests/${personal.id}/complete`,second,{method:'POST'}),{status:404});
  for(const time of [{starts_at:Date.now()+600000},{ends_at:Date.now()-1000}]){
    const q=await h.quest(time);await assert.rejects(h.call(`/api/quests/${q.id}/complete`,first,{method:'POST'}),{status:409});
  }
  const tokenQuest=await h.quest({verification:'token'}),expired=await h.token(tokenQuest,first,undefined,Date.now()-1000);
  await assert.rejects(h.call(`/api/quests/${tokenQuest.id}/complete`,first,{method:'POST',body:{code:expired.code}}),/истёк/);
  await h.call('/api/location',first,{method:'DELETE'});await h.locate(first,'astana');
  await h.call(`/api/quests/${astana.id}/complete`,first,{method:'POST',city:'astana'});
  assert.equal((await h.call('/api/progress',first,{city:'astana'})).completed[0].quest_id,astana.id);
  assert.equal((await h.call('/api/progress',first,{city:'almaty'})).completed[0].quest_id,almaty.id);
  await h.call('/api/explored',first,{method:'DELETE',city:'astana'});
  assert.equal((await h.call('/api/progress',first,{city:'astana'})).cells.length,0);
  assert.equal((await h.call('/api/progress',first,{city:'almaty'})).cells.length,1);
  assert.equal((await h.db.get('SELECT xp FROM users WHERE id=$1',[first.id])).xp,200);
});

test('game: organization catalog filters city/status/bounds without exposing ownership',async t=>{
  const h=await harness(t),owner=await h.player('business');
  const insert=async (id,selected,status,name)=>h.db.run('INSERT INTO organizations(id,owner_id,name,category,lng,lat,status,created_at,city_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,owner.id,name,'cafe',locations[selected].lng,locations[selected].lat,status,Date.now(),selected]);
  await insert('game-org-almaty','almaty','approved',"Coffee 'One'");
  await insert('game-org-pending','almaty','pending','Скрытая организация');
  await insert('game-org-astana','astana','approved','Астана Кофе');
  const result=await h.call('/api/organizations',null);
  assert.equal(result.total,1);assert.equal(result.items[0].id,'game-org-almaty');
  assert.equal(Object.hasOwn(result.items[0],'owner_id'),false);
  assert.equal((await h.call('/api/organizations?q=COFFEE',null)).total,1);
  assert.equal((await h.call('/api/organizations?q=%27%20OR%201%3D1--',null)).total,0);
  assert.equal((await h.call('/api/organizations?bbox=76.70,43.02,76.71,43.03',null)).total,0);
  assert.equal((await h.call('/api/organizations',null,{city:'astana'})).items[0].id,'game-org-astana');
  await assert.rejects(h.call('/api/organizations?bbox=77,44,76,43',null),{status:400});
});

test('game: concurrent team joins enforce 20 members and owner departure rotates the invite',async t=>{
  const h=await harness(t),owner=await h.player(),players=[];
  for(let i=0;i<23;i++)players.push(await h.player());
  const {team}=await h.call('/api/team',owner,{method:'POST',body:{name:'Проверка команды',city_id:'astana'}});
  await assert.rejects(h.call('/api/team/join',players[0],{method:'POST',body:{code:team.invite,city_id:'almaty'}}),{status:404});
  const outcomes=await Promise.allSettled(players.map((user,i)=>h.call('/api/team/join',user,{method:'POST',body:{code:team.invite,city_id:'astana'},replica:i%2})));
  assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,19);
  assert.equal(outcomes.filter(result=>result.status==='rejected').length,4);
  assert.equal(Number((await h.db.get('SELECT count(*) AS n FROM members WHERE team_id=$1',[team.id])).n),20);
  const nextId=(await h.db.get('SELECT user_id FROM members WHERE team_id=$1 AND user_id<>$2 ORDER BY user_id LIMIT 1',[team.id,owner.id])).user_id;
  const next=players.find(user=>user.id===nextId);
  const hidden=await h.call('/api/team',next,{city:'astana'});assert.equal(hidden.team.invite,undefined);
  assert.deepEqual(await h.call('/api/team',owner,{city:'almaty'}),{team:null,otherCity:'astana'});
  await Promise.all([h.call('/api/team',owner,{method:'DELETE'}),h.call('/api/team',next,{method:'DELETE',replica:1})]);
  const after=await h.db.get('SELECT * FROM teams WHERE id=$1',[team.id]);
  assert.notEqual(after.invite,team.invite);assert.notEqual(after.owner_id,owner.id);assert.notEqual(after.owner_id,next.id);
  assert.ok(await h.db.get('SELECT user_id FROM members WHERE team_id=$1 AND user_id=$2',[team.id,after.owner_id]));
  assert.equal(Number((await h.db.get('SELECT count(*) AS n FROM members WHERE team_id=$1',[team.id])).n),18);
  await assert.rejects(h.call('/api/team/join',owner,{method:'POST',body:{code:team.invite,city_id:'astana'}}),{status:404});
  assert.equal((await verifyAudit(h.db,keys.auditKey)).ok,true);
});

test('game: teammate coordinates require consent and fresh same-city positions',async t=>{
  const h=await harness(t),owner=await h.player(),member=await h.player();
  const {team}=await h.call('/api/team',owner,{method:'POST',body:{name:'Приватная команда',city_id:'almaty'}});
  await h.call('/api/team/join',member,{method:'POST',body:{code:team.invite,city_id:'almaty'}});
  await h.locate(member);
  const position=async()=> (await h.call('/api/team',owner)).members.find(item=>item.id===member.id).location;
  assert.equal(await position(),null);
  await h.call('/api/team/sharing',member,{method:'PATCH',body:{enabled:true},replica:1});
  const visible=await position();assert.deepEqual({lng:visible.lng,lat:visible.lat},locations.almaty);assert.ok(visible.expiresInMs>0&&visible.expiresInMs<=60000);
  await h.db.run('UPDATE positions SET updated_at=$1 WHERE user_id=$2',[Date.now()-61000,member.id]);
  assert.equal(await position(),null);
  await h.db.run('UPDATE positions SET updated_at=$1,city_id=$2 WHERE user_id=$3',[Date.now(),'astana',member.id]);
  assert.equal(await position(),null);
  await h.call('/api/location',member,{method:'DELETE'});
  assert.equal((await h.db.get('SELECT share_location FROM members WHERE user_id=$1',[member.id])).share_location,0);
  assert.equal(await h.db.get('SELECT * FROM positions WHERE user_id=$1',[member.id]),undefined);
});

test('game: stale requests cannot mutate after session revocation or account disablement',async t=>{
  const h=await harness(t),revoked=await h.player(),disabled=await h.player();
  await h.db.run('DELETE FROM sessions WHERE user_id=$1',[revoked.id]);
  await assert.rejects(h.locate(revoked),{status:401});
  await h.db.run('UPDATE users SET disabled=1 WHERE id=$1',[disabled.id]);
  await assert.rejects(h.call('/api/team',disabled,{method:'POST',body:{name:'Запрещённая команда'}}),{status:401});
  assert.equal(Number((await h.db.get('SELECT count(*) AS n FROM positions')).n),0);
  assert.equal(Number((await h.db.get('SELECT count(*) AS n FROM teams')).n),0);
});
