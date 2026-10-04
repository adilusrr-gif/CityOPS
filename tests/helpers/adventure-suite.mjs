import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeatureStore,get,run} from '../../src/features/store.mjs';
import {createAdventureRoutes} from '../../src/features/adventure-routes.mjs';
import {seedAdventures} from '../../src/features/adventure-seed.mjs';
const DAY=86400000;

export function adventureSuite(label,createDatabase){
 async function fixture(t){
  const dbFixture=await createDatabase(t),cfg={idleMs:60*DAY,requireAdminMfa:true},events=[];
  const store=createFeatureStore({db:dbFixture.db,dialect:dbFixture.dialect,cfg,audit:(_tx,...event)=>{events.push(event);}});
  let time=Date.now(),afterClockRead=0;
  await store.transaction(function*(){yield* seedAdventures(time);for(const uid of ['u1','u2','u3','admin']){yield run('INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled) VALUES($1,$2,$1,$3,$4,$5,$6)',[uid,`${uid}@example.test`,'unused',uid==='admin'?'admin':'player',time-2*DAY,uid==='admin'?1:0]);yield run('INSERT INTO sessions(token,user_id,expires,id,created_at,last_seen,mfa_verified) VALUES($1,$1,$2,$3,$4,$4,$5)',[uid,time+60*DAY,uid+'-session',time,uid==='admin'?1:0]);}});
  const route=createAdventureRoutes({store,cfg,now:()=>{const result=time;time+=afterClockRead;afterClockRead=0;return result;}}),actors=Object.fromEntries(['u1','u2','u3','admin'].map(uid=>[uid,{id:uid,session_id:uid+'-session'}]));
  const call=(path,method='GET',body={},uid='u1',cityId='almaty')=>route({path,method,user:actors[uid],cityId,readBody:async()=>body});
  const exec=(sql,params=[])=>store.transaction(function*(){return yield run(sql,params);}),one=(sql,params=[])=>store.read(function*(){return yield get(sql,params);});
  const location=(p,uid='u1',options={})=>exec('INSERT INTO positions(user_id,lng,lat,accuracy,updated_at,city_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET lng=$2,lat=$3,accuracy=$4,updated_at=$5,city_id=$6',[uid,p.lng,p.lat,options.accuracy??10,options.updatedAt??time,options.cityId??'almaty']);
  const team=async(uid='u1',tid='team-a',cityId='almaty')=>{await exec('INSERT INTO teams(id,name,owner_id,invite,created_at,city_id) VALUES($1,$1,$2,$1,$3,$4) ON CONFLICT(id) DO NOTHING',[tid,uid,time-1000,cityId]);await exec('INSERT INTO members(user_id,team_id,share_location,joined_at) VALUES($1,$2,0,$3) ON CONFLICT(user_id) DO UPDATE SET team_id=$2,joined_at=$3',[uid,tid,time]);};
  const adopt=uid=>exec('INSERT INTO pets(user_id,name,species,color,xp,created_at,updated_at,chat_epoch) VALUES($1,$2,$3,$4,0,$5,$5,0)',[uid,'Искра','fox','mint',time]);
  return{...dbFixture,cfg,store,events,actors,call,exec,one,location,team,adopt,now:()=>time,advance:ms=>{time+=ms;},advanceAfterNextClockRead:ms=>{afterClockRead=ms;}};
 }
 const openRoute=()=>({title:'Проверенный маршрут',description:'Две общедоступные проверенные точки для пилота.',kind:'mountain',difficulty:'moderate',cautions:'Оператор проверил открытые дорожки. При закрытии не проходить.',sourceUrls:['https://example.test/verified-route'],status:'open',statusReason:'Проверенные открытые точки пилота.',fieldVerified:true,safetyReviewed:true,xp:100,checkpoints:[{title:'Первая точка',lng:76.9538,lat:43.258,radius:50,altitudeM:1600},{title:'Вторая точка',lng:76.9558,lat:43.258,radius:50,altitudeM:1750}]});
 test(`${label}: ordered checkpoints award player and pet XP exactly once, including concurrent retries`,async t=>{
  const f=await fixture(t);await f.adopt('u1');const {item:r}=await f.call('/api/admin/adventures','POST',openRoute(),'admin');
  await f.location(r.checkpoints[1]);await assert.rejects(f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:1}),e=>e.status===409);
  await f.location(r.checkpoints[0]);const first=await f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:0});assert.equal(first.item.progress.visited,1);assert.equal(first.xpAwarded,0);assert.equal(first.item.progress.maxCheckpointAltitudeM,1600);
  f.advance(1);await f.location(r.checkpoints[1]);const results=await Promise.all(Array.from({length:8},()=>f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:1})));assert.equal(results.filter(item=>item.rewarded).length,1);assert.equal(results[0].item.progress.checkpointAscentM,150);assert.equal(results[0].item.progress.maxCheckpointAltitudeM,1750);assert.equal((await f.one('SELECT xp FROM users WHERE id=$1',['u1'])).xp,100);assert.equal((await f.one('SELECT xp FROM pets WHERE user_id=$1',['u1'])).xp,20);assert.equal((await f.one('SELECT COUNT(*) AS n FROM adventure_rewards')).n,1);assert.equal((await f.one('SELECT COUNT(*) AS n FROM pet_rewards')).n,1);
  assert.equal(f.events.filter(e=>e[1]==='adventure.completed').length,1);
 });
 test(`${label}: overlapping checkpoint circles reject one fix, ambiguous midpoint and inaccurate center samples`,async t=>{
  const f=await fixture(t),input=openRoute();input.checkpoints=[{title:'Начальная точка',lng:76.9538,lat:43.258,radius:100,altitudeM:1600},{title:'Следующая точка',lng:76.9548,lat:43.258,radius:100,altitudeM:1610}];
  const {item:r}=await f.call('/api/admin/adventures','POST',input,'admin'),check=index=>f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:index});
  assert.equal(r.playable,true);assert.equal(r.planning.checkpointCount,2);assert.ok(r.planning.straightLineDistanceM>70&&r.planning.straightLineDistanceM<90);
  const midpoint={lng:76.9543,lat:43.258};
  await f.location(midpoint);await assert.rejects(check(0),e=>e.status===409&&/безопасной/.test(e.message));
  await f.location(r.checkpoints[0],'u1',{accuracy:50});await assert.rejects(check(0),e=>e.status===409);
  await f.location(r.checkpoints[0]);assert.equal((await check(0)).item.progress.visited,1);
  // Both centers are inside the other's 100m circle. Reusing the fix fails.
  await assert.rejects(check(1),e=>e.status===409);
  await f.location(r.checkpoints[1]);await assert.rejects(check(1),e=>e.status===409,'even a changed coordinate needs a fresh timestamp');
  f.advance(1);await f.location(midpoint);await assert.rejects(check(1),e=>e.status===409);
  await f.location(r.checkpoints[0]);await assert.rejects(check(1),e=>e.status===409,'refreshing an identical coordinate cannot advance');
  await f.location(r.checkpoints[1]);assert.equal((await check(1)).xpAwarded,100);
  f.advance(120000);await f.location({lng:76.97,lat:43.26},'u1',{updatedAt:f.now()-100000});assert.equal((await check(1)).replayed,true);assert.equal((await check(0)).xpAwarded,0);
  assert.equal((await f.one('SELECT count(*) AS n FROM adventure_rewards')).n,1);
 });
 test(`${label}: old unverified open routes fail closed without erasing historical check-ins or rewards`,async t=>{
  const f=await fixture(t),{item:r}=await f.call('/api/admin/adventures','POST',openRoute(),'admin');
  await f.exec('INSERT INTO adventure_checkins(user_id,route_id,route_version,checkpoint_index,altitude_m,created_at) VALUES($1,$2,$3,0,1600,$4)',['u1',r.id,r.version,f.now()-1000]);
  await f.exec('INSERT INTO adventure_rewards(user_id,route_id,xp,created_at) VALUES($1,$2,100,$3)',['u1',r.id,f.now()-1000]);
  await f.exec('UPDATE adventure_routes SET verified_at=NULL,verified_by=NULL WHERE id=$1',[r.id]);
  const item=(await f.call('/api/adventures')).items.find(x=>x.id===r.id);assert.equal(item.status,'draft');assert.equal(item.playable,false);assert.equal(item.progress.visited,1);assert.equal(item.progress.rewardClaimed,true);
  await f.location(r.checkpoints[1]);await assert.rejects(f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:1}),e=>e.status===409);
  assert.equal((await f.one('SELECT count(*) AS n FROM adventure_checkins WHERE route_id=$1',[r.id])).n,1);assert.equal((await f.one('SELECT count(*) AS n FROM adventure_rewards WHERE route_id=$1',[r.id])).n,1);
  const input=openRoute();input.checkpoints[1]={...input.checkpoints[1],lng:input.checkpoints[0].lng,lat:input.checkpoints[0].lat};
  await assert.rejects(f.call('/api/admin/adventures','POST',input,'admin'),e=>e.status===409);
  assert.equal((await f.call('/api/admin/adventures','POST',{...input,status:'draft'},'admin')).item.playable,false);
 });
 test(`${label}: GPS is checked on server for city, age, accuracy, distance and future timestamps`,async t=>{
  const f=await fixture(t),{item:r}=await f.call('/api/admin/adventures','POST',openRoute(),'admin'),check=()=>f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:0});
  await assert.rejects(check(),e=>e.status===409);
  for(const options of [{cityId:'astana'},{updatedAt:f.now()-90001},{updatedAt:f.now()+1},{accuracy:81},{accuracy:-1}]){await f.location(r.checkpoints[0],'u1',options);await assert.rejects(check(),e=>e.status===409);}
  await f.location(r.checkpoints[1]);await assert.rejects(check(),e=>e.status===409);await f.location(r.checkpoints[0]);await assert.rejects(f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version+1,checkpointIndex:0}),e=>e.status===409);await assert.rejects(f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:0},'u1','astana'),e=>e.status===404);assert.equal((await check()).item.progress.visited,1);
 });
 test(`${label}: routes require admin, MFA and explicit access validation; drafts are closed to check-ins`,async t=>{
  const f=await fixture(t),input=openRoute();await assert.rejects(f.call('/api/admin/adventures','POST',input),e=>e.status===403);await f.exec('UPDATE sessions SET mfa_verified=0 WHERE user_id=$1',['admin']);await assert.rejects(f.call('/api/admin/adventures','POST',input,'admin'),e=>e.status===423);await f.exec('UPDATE sessions SET mfa_verified=1 WHERE user_id=$1',['admin']);await assert.rejects(f.call('/api/admin/adventures','POST',{...input,fieldVerified:false},'admin'),e=>e.status===409);
  const {item:r}=await f.call('/api/admin/adventures','POST',{...input,status:'draft'},'admin');await f.location(r.checkpoints[0]);await assert.rejects(f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:0}),e=>e.status===409);
  const publicList=await f.call('/api/adventures','GET',{},'anonymous');assert.ok(publicList.items.some(item=>item.id==='almaty-medeu-shymbulak'&&item.status==='draft'));assert.ok(publicList.items.every(item=>item.progress.visited===0));
  await assert.rejects(f.call(`/api/admin/adventures/${r.id}`,'PATCH',{...input,version:r.version+1},'admin'),e=>e.status===409);const opened=await f.call(`/api/admin/adventures/${r.id}`,'PATCH',{version:r.version,status:'open',fieldVerified:true,safetyReviewed:true},'admin');assert.equal(opened.item.verifiedAt,f.now());assert.equal(opened.item.version,r.version+1);
 });
 test(`${label}: edits restart ordered revision progress without farming another route reward`,async t=>{
  const f=await fixture(t),input=openRoute();input.checkpoints=input.checkpoints.slice(0,1);const {item:r}=await f.call('/api/admin/adventures','POST',input,'admin');await f.location(r.checkpoints[0]);assert.equal((await f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:r.version,checkpointIndex:0})).xpAwarded,100);
  const {item:edited}=await f.call(`/api/admin/adventures/${r.id}`,'PATCH',{version:r.version,xp:500,fieldVerified:true,safetyReviewed:true},'admin');assert.equal(edited.progress.visited,0);const own=(await f.call('/api/adventures')).items.find(item=>item.id===r.id);assert.equal(own.progress.rewardClaimed,true);assert.equal((await f.call(`/api/adventures/${r.id}/checkin`,'POST',{version:edited.version,checkpointIndex:0})).xpAwarded,0);assert.equal((await f.one('SELECT xp FROM users WHERE id=$1',['u1'])).xp,100);
  await f.adopt('u1');assert.equal((await f.one('SELECT xp FROM pets WHERE user_id=$1',['u1'])).xp,0,'a pet adopted after the reward does not retroactively farm it');
 });
 test(`${label}: territory capture, contested ties, team changes and monthly reset use durable visit ledger`,async t=>{
  const f=await fixture(t),zone=(await f.call('/api/territories')).items[0],path=`/api/territories/${zone.id}/visit`;await f.location(zone);await assert.rejects(f.call(path,'POST'),e=>e.status===409);await f.team();await f.location(zone);const first=await f.call(path,'POST');assert.equal(first.pointsAwarded,1);assert.equal(first.item.owner.teamId,'team-a');
  const repeats=await Promise.all(Array.from({length:5},()=>f.call(path,'POST')));assert.ok(repeats.every(r=>r.replayed&&r.pointsAwarded===0));await f.team('u2','team-b');await f.location(zone,'u2');const tie=await f.call(path,'POST',{},'u2');assert.equal(tie.item.contested,true);assert.equal(tie.item.owner,null);
  await f.team('u1','team-b');const switched=await f.call(path,'POST');assert.equal(switched.teamId,'team-a');assert.equal(switched.pointsAwarded,0);assert.equal((await f.one('SELECT xp FROM users WHERE id=$1',['u1'])).xp,0);
  await f.exec('DELETE FROM members WHERE team_id=$1',['team-a']);await f.exec('DELETE FROM teams WHERE id=$1',['team-a']);assert.equal((await f.call(path,'POST')).pointsAwarded,0,'deleting team must not delete deduplication');
  const before=(await f.call('/api/territories')).season;f.advance(32*DAY);const newSeason=await f.call('/api/territories');assert.notEqual(newSeason.season,before);assert.equal(newSeason.leaderboard.length,0);assert.equal(newSeason.items.find(i=>i.id===zone.id).visitedToday,false);await f.location(zone);assert.equal((await f.call(path,'POST')).pointsAwarded,1);
 });
 test(`${label}: territory requires fresh position after joining and keeps daily limit across teams`,async t=>{
  const f=await fixture(t),zone=(await f.call('/api/territories')).items[0],path=`/api/territories/${zone.id}/visit`;await f.location(zone);f.advance(1000);await f.team();await assert.rejects(f.call(path,'POST'),e=>e.status===409);await f.location(zone);await f.call(path,'POST');
  for(let i=0;i<9;i++){const {item:z}=await f.call('/api/admin/territories','POST',{title:`Зона ${i}`,description:'Общедоступная проверенная площадка.',lng:zone.lng,lat:zone.lat,radius:100,status:'active',publicAccessReviewed:true},'admin');await f.call(`/api/territories/${z.id}/visit`,'POST');}
  const {item:last}=await f.call('/api/admin/territories','POST',{title:'Последняя зона',description:'Общедоступная проверенная площадка.',lng:zone.lng,lat:zone.lat,radius:100,status:'active',publicAccessReviewed:true},'admin');await f.team('u1','another-team');await f.location(zone);await assert.rejects(f.call(`/api/territories/${last.id}/visit`,'POST'),e=>e.status===429);
  await assert.rejects(f.call(`/api/admin/territories/${last.id}`,'PATCH',{version:last.version,status:'active'},'admin'),e=>e.status===409);const disabled=await f.call(`/api/admin/territories/${last.id}`,'PATCH',{version:last.version,status:'disabled'},'admin');assert.equal(disabled.item.status,'disabled');await assert.rejects(f.call(`/api/territories/${last.id}/visit`,'POST'),e=>e.status===409);
 });
 test(`${label}: waiting for a team lock rechecks GPS freshness and records the actual UTC season`,async t=>{
  const f=await fixture(t),zone=(await f.call('/api/territories')).items[0],path=`/api/territories/${zone.id}/visit`;
  await f.team();await f.location(zone);
  f.advanceAfterNextClockRead(90001);
  await assert.rejects(f.call(path,'POST'),e=>e.status===409&&e.message.includes('90 секунд'));
  assert.equal((await f.one('SELECT COUNT(*) AS n FROM territory_visits')).n,0);
  const date=new Date(f.now()),boundary=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
  f.advance(boundary-500-f.now());await f.location(zone);
  f.advanceAfterNextClockRead(1000);
  const result=await f.call(path,'POST');assert.equal(result.pointsAwarded,1);
  const saved=await f.one('SELECT day,season,created_at FROM territory_visits WHERE user_id=$1',['u1']);
  assert.equal(saved.day,Math.floor(f.now()/DAY));assert.equal(saved.season,new Date(boundary).toISOString().slice(0,7));assert.equal(saved.created_at,f.now());assert.equal(result.season,saved.season);
  await f.exec('DELETE FROM members WHERE user_id=$1',['u1']);
  assert.equal((await f.call(path,'POST')).replayed,true,'leaving the team preserves idempotent replay');
 });
 test(`${label}: stale sessions and role changes cannot mutate adventure state`,async t=>{
  const f=await fixture(t),{item:route}=await f.call('/api/admin/adventures','POST',openRoute(),'admin');await f.exec('UPDATE users SET role=$1 WHERE id=$2',['player','admin']);await assert.rejects(f.call('/api/admin/territories','GET',{},'admin'),e=>e.status===403);await f.exec('DELETE FROM sessions WHERE user_id=$1',['u1']);await f.location(route.checkpoints[0]);await assert.rejects(f.call(`/api/adventures/${route.id}/checkin`,'POST',{version:route.version,checkpointIndex:0}),e=>e.status===401);assert.equal((await f.one('SELECT COUNT(*) AS n FROM adventure_checkins')).n,0);
 });
 test(`${label}: repeated editorial seed preserves operator closures and territory configuration`,async t=>{
  const f=await fixture(t);await f.exec("UPDATE adventure_routes SET status='closed',version=7 WHERE id='almaty-park-walk'");await f.exec("UPDATE territory_zones SET radius=222,status='disabled',version=8 WHERE id='almaty-panfilov'");await f.store.transaction(function*(){yield* seedAdventures();});assert.equal((await f.one("SELECT status,version FROM adventure_routes WHERE id='almaty-park-walk'")).version,7);assert.equal((await f.one("SELECT radius FROM territory_zones WHERE id='almaty-panfilov'")).radius,222);
 });
}
