import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {passwordHash} from '../src/domain.mjs';
import {totp} from '../src/security.mjs';
import {importOsm} from '../src/osm.mjs';

const PASSWORD='Long-test-password-for-enterprise-42';
const coords={almaty:{lng:76.947,lat:43.249},astana:{lng:71.4304,lat:51.1282}};
async function fixture(t,{production=false}={}){
 const db=openDb(':memory:',{withSnapshot:false});
 const env=production?{NODE_ENV:'production',COOKIE_SECURE:'true',PUBLIC_ORIGIN:'https://quest.example.test',DATA_ENCRYPTION_KEY:'11'.repeat(32),AUDIT_HMAC_KEY:'22'.repeat(32)}:{NODE_ENV:'test'};
 const {server}=createApp({db,env});server.listen(0,'127.0.0.1');await once(server,'listening');
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 async function request(path,{cookie,method='GET',body,headers={}}={}){
  const r=await fetch(base+'/api'+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const setCookie=r.headers.get('set-cookie');return {status:r.status,body:await r.json(),cookie:setCookie?.split(';')[0],setCookie,headers:r.headers};
 }
 async function account(name,role='player'){
  const uid='test-'+name,email=name+'@example.test';
  db.prepare('INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run(uid,email,name,passwordHash(PASSWORD),role,Date.now());
  const r=await request('/login',{method:'POST',body:{email,password:PASSWORD}});ok(r);return {id:uid,email,cookie:r.cookie,setCookie:r.setCookie};
 }
 async function organization(admin,city,extra={}){const r=await request('/manage/organizations',{cookie:admin.cookie,method:'POST',body:{city_id:city,name:'Тест '+city,category:'cafe',...coords[city],address:'Тестовый адрес',description:'API fixture',status:'approved',...extra}});ok(r);return r.body.item;}
 async function quest(admin,city,extra={}){const r=await request('/manage/quests',{cookie:admin.cookie,method:'POST',body:{city_id:city,title:'Тестовый квест '+city,description:'Задание для проверки изоляции данных и наград',...coords[city],radius:100,xp:120,scope:'public',verification:'checkin',status:'published',...extra}});ok(r);return r.body.item;}
 async function locate(user,city){const r=await request('/location',{cookie:user.cookie,method:'POST',body:{city_id:city,...coords[city],accuracy:10,timestamp:Date.now()}});ok(r);return r;}
 return {db,request,account,organization,quest,locate};
}
function ok(result){assert.equal(result.status,200,JSON.stringify(result.body));return result;}
function denied(result){assert.ok(result.status>=400&&result.status<500,JSON.stringify(result));}

// City selection is a data boundary on every listing, not only a camera setting.
test('city catalogs, assigned quests and business dashboards are isolated',async t=>{
 const f=await fixture(t),admin=await f.account('catalog-admin','admin'),biz=await f.account('catalog-business','business'),player=await f.account('catalog-player'),other=await f.account('catalog-other');
 for(const city of ['almaty','astana']){
  const q=ok(await f.request('/quests?city='+city)).body.items;assert.equal(q.length,12);assert.ok(q.every(x=>x.city_id===city));assert.ok(q.every(x=>!('code_hash'in x)));
  const orgs=ok(await f.request('/organizations?city='+city)).body.items;assert.equal(orgs.length,12);assert.ok(orgs.every(x=>x.city_id===city));
 }
 assert.equal(ok(await f.request('/quests')).body.items.length,12);
 const almaty=await f.organization(admin,'almaty',{owner_id:biz.id}),astana=await f.organization(admin,'astana',{owner_id:biz.id});
 const questA=await f.quest(admin,'almaty',{organization_id:almaty.id});
 const privateQuest=await f.quest(admin,'astana',{organization_id:astana.id,scope:'personal',assigned_to:player.id});
 for(const city of ['almaty','astana']){
  const manage=ok(await f.request('/manage?city='+city,{cookie:biz.cookie})).body;assert.equal(manage.organizations.length,1);assert.equal(manage.organizations[0].city_id,city);
  const all=ok(await f.request('/manage?city='+city,{cookie:admin.cookie})).body;assert.ok(all.organizations.every(x=>x.city_id===city));assert.ok(all.quests.every(x=>x.city_id===city));
 }
 for(const cookie of [undefined,other.cookie])assert.equal(ok(await f.request('/quests?city=astana',{cookie})).body.items.some(x=>x.id===privateQuest.id),false);
 assert.equal(ok(await f.request('/quests?city=astana',{cookie:player.cookie})).body.items.some(x=>x.id===privateQuest.id),true);
 assert.equal((await f.request('/quests/'+privateQuest.id+'/complete',{cookie:other.cookie,method:'POST',body:{}})).status,404);
 assert.equal(ok(await f.request('/quests?city=astana')).body.items.some(x=>x.id===questA.id),false);
 for(const route of ['/quests?city=unknown','/organizations?city=__proto__','/progress?city=unknown','/manage?city=unknown'])denied(await f.request(route,{cookie:admin.cookie}));
 denied(await f.request('/location',{cookie:player.cookie,method:'POST',body:{city_id:'astana',...coords.almaty,accuracy:10,timestamp:Date.now()}}));
 denied(await f.request('/manage/organizations',{cookie:admin.cookie,method:'POST',body:{city_id:'unknown',name:'Invalid city',...coords.almaty}}));
 denied(await f.request('/manage/quests',{cookie:admin.cookie,method:'POST',body:{city_id:'astana',title:'Wrong organization',description:'Test organization from another city',...coords.astana,organization_id:almaty.id}}));
});

test('exploration and teammate coordinates respect the selected city',async t=>{
 const f=await fixture(t),a=await f.account('geo-owner'),b=await f.account('geo-member'),admin=await f.account('geo-admin','admin');
 const qa=await f.quest(admin,'almaty'),qb=await f.quest(admin,'astana');
 await f.locate(a,'almaty');ok(await f.request(`/quests/${qa.id}/complete`,{cookie:a.cookie,method:'POST',body:{}}));const first=ok(await f.request('/progress?city=almaty',{cookie:a.cookie})).body;assert.ok(first.cells.length>0);assert.deepEqual(first.completed.map(x=>x.quest_id),[qa.id]);assert.equal(ok(await f.request('/progress?city=astana',{cookie:a.cookie})).body.cells.length,0);
 ok(await f.request('/location',{cookie:a.cookie,method:'DELETE'}));await f.locate(a,'astana');ok(await f.request(`/quests/${qb.id}/complete`,{cookie:a.cookie,method:'POST',body:{}}));const astanaProgress=ok(await f.request('/progress?city=astana',{cookie:a.cookie})).body;assert.ok(astanaProgress.cells.length>0);assert.deepEqual(astanaProgress.completed.map(x=>x.quest_id),[qb.id]);assert.deepEqual(ok(await f.request('/progress?city=almaty',{cookie:a.cookie})).body.completed.map(x=>x.quest_id),[qa.id]);assert.deepEqual(ok(await f.request('/progress?city=almaty',{cookie:a.cookie})).body.cells,first.cells);
 const team=ok(await f.request('/team',{cookie:a.cookie,method:'POST',body:{name:'Астана команда',city_id:'astana'}})).body.team;assert.equal(team.city_id,'astana');
 ok(await f.request('/team/join',{cookie:b.cookie,method:'POST',body:{code:team.invite,city_id:'astana'}}));
 await f.locate(b,'almaty');ok(await f.request('/team/sharing',{cookie:b.cookie,method:'PATCH',body:{enabled:true}}));
 const visible=ok(await f.request('/team?city=astana',{cookie:a.cookie})).body;assert.equal(visible.members.find(x=>x.id===b.id).location,null);
 assert.equal(ok(await f.request('/team?city=almaty',{cookie:a.cookie})).body.team,null);
 ok(await f.request('/location',{cookie:b.cookie,method:'DELETE'}));await f.locate(b,'astana');ok(await f.request('/team/sharing',{cookie:b.cookie,method:'PATCH',body:{enabled:true}}));
 assert.equal(ok(await f.request('/team?city=astana',{cookie:a.cookie})).body.members.find(x=>x.id===b.id).location.lng,coords.astana.lng);
});

test('optimistic editing rejects stale organizations and quests without lost updates',async t=>{
 const f=await fixture(t),admin=await f.account('version-admin','admin');
 for(const kind of ['organizations','quests']){
  const item=kind==='organizations'?await f.organization(admin,'astana'):await f.quest(admin,'astana');
  const key=kind==='organizations'?'name':'title',path='/manage/'+kind+'/'+item.id;
  denied(await f.request(path,{cookie:admin.cookie,method:'PATCH',body:{[key]:'Missing version'}}));
  const first=ok(await f.request(path,{cookie:admin.cookie,method:'PATCH',body:{version:item.version,[key]:'Accepted edit'}}));assert.equal(first.body.item.version,item.version+1);
  const stale=await f.request(path,{cookie:admin.cookie,method:'PATCH',body:{version:item.version,[key]:'Lost update'}});assert.equal(stale.status,409);
  const row=f.db.prepare(`SELECT * FROM ${kind} WHERE id=?`).get(item.id);assert.equal(row[key],'Accepted edit');assert.equal(row.version,item.version+1);
 }
});

test('an OSM refresh invalidates an already opened organization editor',async t=>{
 const f=await fixture(t),admin=await f.account('osm-editor-admin','admin');
 const data={elements:[{type:'node',id:987650000010,lon:coords.astana.lng,lat:coords.astana.lat,tags:{name:'Before import',amenity:'cafe'}}]};
 importOsm(f.db,data,'astana');const old=ok(await f.request('/manage?city=astana',{cookie:admin.cookie})).body.organizations.find(x=>x.osm_id==='node/987650000010');assert.ok(old);
 data.elements[0].tags.name='Fresh OSM name';importOsm(f.db,data,'astana');
 const stale=await f.request('/manage/organizations/'+old.id,{cookie:admin.cookie,method:'PATCH',body:{version:old.version,name:'Stale UI edit'}});assert.equal(stale.status,409);
 const current=f.db.prepare('SELECT * FROM organizations WHERE id=?').get(old.id);assert.equal(current.name,'Fresh OSM name');assert.equal(current.version,old.version+1);
});

function tokenCode(token){return typeof token==='string'?token:token.code;}
async function issue(f,admin,quest,count=1){const r=ok(await f.request(`/manage/quests/${quest.id}/tokens`,{cookie:admin.cookie,method:'POST',body:{count,expires_in_minutes:10}}));assert.equal(r.body.tokens.length,count);return r.body.tokens.map(tokenCode);}

test('single-use reward tokens are atomic under races and honor campaign budgets',async t=>{
 const f=await fixture(t),admin=await f.account('token-admin','admin'),a=await f.account('token-player-a'),b=await f.account('token-player-b'),c=await f.account('token-player-c'),outsider=await f.account('token-business','business');
 const quest=await f.quest(admin,'astana',{verification:'token',max_completions:2}),codes=await issue(f,admin,quest,3);
 denied(await f.request(`/manage/quests/${quest.id}/tokens`,{cookie:outsider.cookie,method:'POST',body:{count:1,expires_in_minutes:10}}));
 await f.locate(a,'astana');await f.locate(b,'astana');await f.locate(c,'astana');
 const path=`/quests/${quest.id}/complete`;
 const results=await Promise.all([a,b].map(player=>f.request(path,{cookie:player.cookie,method:'POST',body:{code:codes[0]}})));
 assert.equal(results.filter(x=>x.status===200&&x.body.xp===120).length,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM completions WHERE quest_id=?').get(quest.id).n,1);
 assert.equal(f.db.prepare('SELECT SUM(xp) xp FROM users WHERE id IN (?,?)').get(a.id,b.id).xp,120);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reward_tokens WHERE quest_id=? AND redeemed_at IS NOT NULL').get(quest.id).n,1);
 const winner=results[0].status===200?a:b,loser=winner===a?b:a;
 // The campaign still has capacity: a second user must not reuse the first token.
 denied(await f.request(path,{cookie:loser.cookie,method:'POST',body:{code:codes[0]}}));
 const replay=ok(await f.request(path,{cookie:winner.cookie,method:'POST',body:{code:codes[0]}}));assert.equal(replay.body.xp,0);assert.equal(replay.body.alreadyCompleted,true);
 // Two distinct valid tokens race for the last campaign reward.
 const budgetRace=await Promise.all([loser,c].map((player,i)=>f.request(path,{cookie:player.cookie,method:'POST',body:{code:codes[i+1]}})));
 assert.equal(budgetRace.filter(x=>x.status===200&&x.body.xp===120).length,1);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM completions WHERE quest_id=?').get(quest.id).n,2);
 assert.equal(f.db.prepare('SELECT SUM(xp) xp FROM users WHERE id IN (?,?,?)').get(a.id,b.id,c.id).xp,240);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM reward_tokens WHERE quest_id=? AND redeemed_at IS NULL').get(quest.id).n,1);
 const dashboard=ok(await f.request('/manage?city=astana',{cookie:admin.cookie})).body;assert.equal(JSON.stringify(dashboard).includes(codes[0]),false);assert.equal(JSON.stringify(dashboard).includes('token_hash'),false);
});

test('token redemption rejects wrong city GPS, expiry, future and expired campaigns',async t=>{
 const f=await fixture(t),admin=await f.account('expiry-admin','admin'),p=await f.account('expiry-player');
 const quest=await f.quest(admin,'astana',{verification:'token'}),[code]=await issue(f,admin,quest);
 await f.locate(p,'almaty');denied(await f.request(`/quests/${quest.id}/complete`,{cookie:p.cookie,method:'POST',body:{code}}));
 assert.equal(f.db.prepare('SELECT redeemed_at FROM reward_tokens WHERE quest_id=?').get(quest.id).redeemed_at,null);
 ok(await f.request('/location',{cookie:p.cookie,method:'DELETE'}));await f.locate(p,'astana');
 f.db.prepare('UPDATE reward_tokens SET expires_at=? WHERE quest_id=?').run(Date.now()-1000,quest.id);
 denied(await f.request(`/quests/${quest.id}/complete`,{cookie:p.cookie,method:'POST',body:{code}}));
 assert.equal(f.db.prepare('SELECT xp FROM users WHERE id=?').get(p.id).xp,0);
 for(const window of [{starts_at:Date.now()+60000,ends_at:Date.now()+120000},{starts_at:Date.now()-120000,ends_at:Date.now()-60000}]){
  const q=await f.quest(admin,'astana',window);denied(await f.request(`/quests/${q.id}/complete`,{cookie:p.cookie,method:'POST',body:{}}));assert.equal(f.db.prepare('SELECT COUNT(*) n FROM completions WHERE quest_id=?').get(q.id).n,0);
 }
});

test('production admin requires MFA; setup, challenge, recovery and session revocation work',async t=>{
 const f=await fixture(t,{production:true}),admin=await f.account('mfa-admin','admin');assert.match(admin.setCookie,/; Secure/);
 assert.equal((await f.request('/manage',{cookie:admin.cookie})).status,423);
 const profile=ok(await f.request('/me',{cookie:admin.cookie})).body.user;assert.equal(profile.requiresMfaSetup,true);
 const other=ok(await f.request('/login',{method:'POST',body:{email:admin.email,password:PASSWORD}}));
 const setup=ok(await f.request('/auth/mfa/setup',{cookie:admin.cookie,method:'POST',body:{password:PASSWORD}}));assert.ok(setup.body.secret);assert.match(setup.body.otpauthUri,/^otpauth:/);
 const stored=f.db.prepare('SELECT mfa_pending_secret FROM users WHERE id=?').get(admin.id).mfa_pending_secret;assert.notEqual(stored,setup.body.secret);assert.equal(stored.includes(setup.body.secret),false);
 denied(await f.request('/auth/mfa/enable',{cookie:admin.cookie,method:'POST',body:{code:'invalid'}}));
 const enabled=ok(await f.request('/auth/mfa/enable',{cookie:admin.cookie,method:'POST',body:{code:totp(setup.body.secret)}}));const codes=enabled.body.recoveryCodes;assert.equal(codes.length,10);
 assert.equal(ok(await f.request('/me',{cookie:other.cookie})).body.user,null);ok(await f.request('/manage',{cookie:admin.cookie}));
 assert.equal((await f.request('/auth/mfa/disable',{cookie:admin.cookie,method:'POST',body:{password:PASSWORD,code:codes[9]}})).status,403);
 const challenge=ok(await f.request('/login',{method:'POST',body:{email:admin.email,password:PASSWORD}}));assert.equal(challenge.body.mfaRequired,true);assert.equal(challenge.cookie,undefined);
 assert.equal((await f.request('/auth/mfa/login',{method:'POST',body:{challengeId:challenge.body.challengeId,code:'invalid'}})).status,401);
 const login=ok(await f.request('/auth/mfa/login',{method:'POST',body:{challengeId:challenge.body.challengeId,code:codes[0]}}));assert.ok(login.cookie);assert.equal(login.body.user.mfaEnabled,true);ok(await f.request('/manage',{cookie:login.cookie}));
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM recovery_codes WHERE user_id=? AND used_at IS NOT NULL').get(admin.id).n,1);
 assert.equal((await f.request('/auth/mfa/login',{method:'POST',body:{challengeId:challenge.body.challengeId,code:codes[1]}})).status,401);
 const next=ok(await f.request('/login',{method:'POST',body:{email:admin.email,password:PASSWORD}}));assert.equal((await f.request('/auth/mfa/login',{method:'POST',body:{challengeId:next.body.challengeId,code:codes[0]}})).status,401);
 ok(await f.request('/auth/sessions/revoke',{cookie:login.cookie,method:'POST',body:{allOthers:true}}));assert.equal(ok(await f.request('/me',{cookie:admin.cookie})).body.user,null);
 const security=ok(await f.request('/auth/security',{cookie:login.cookie})).body;assert.equal(security.sessions.length,1);assert.equal(security.sessions[0].current,true);
 f.db.prepare('UPDATE sessions SET last_seen=? WHERE user_id=?').run(Date.now()-31*60000,admin.id);assert.equal(ok(await f.request('/me',{cookie:login.cookie})).body.user,null);
});
