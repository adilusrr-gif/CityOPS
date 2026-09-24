import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {passwordHash} from '../src/domain.mjs';
import {totp} from '../src/security.mjs';
import {sqliteStatement} from '../src/features/store.mjs';
import {featureKeys,featureEnv,startFeatureServer,featureHttp} from './v4-http.test.mjs';

const password='Http-v5-test-password-2026',DAY=86400000;
const unique=()=>randomBytes(12).toString('hex');
const good=result=>{assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
const rejected=(result,statuses=[400,403,409])=>assert.ok(statuses.includes(result.status),JSON.stringify(result));
const first={lng:76.9471234,lat:43.2492345},second={lng:76.9475234,lat:43.2495345};

export async function sqliteAdventureFixture(t){
 const sqlite=openDb(':memory:',{withSnapshot:false});
 const app=await startFeatureServer(createApp({db:sqlite,keys:featureKeys,env:featureEnv({REQUIRE_ADMIN_MFA:'true'})}));
 t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));sqlite.close();});
 const db={
  async get(sql,params=[]){const s=sqliteStatement(sql,params);return sqlite.prepare(s.sql).get(...s.params);},
  async all(sql,params=[]){const s=sqliteStatement(sql,params);return sqlite.prepare(s.sql).all(...s.params);},
  async run(sql,params=[]){const s=sqliteStatement(sql,params);return {rowCount:Number(sqlite.prepare(s.sql).run(...s.params).changes)};},
 };
 return {db,apps:[app],request:featureHttp([app]),engine:'sqlite-local',async blockPhotoAudit(){sqlite.exec("CREATE TRIGGER reject_photo_audit BEFORE INSERT ON audit WHEN NEW.action LIKE 'photo.%' BEGIN SELECT RAISE(ABORT,'test audit unavailable'); END");},async unblockPhotoAudit(){sqlite.exec('DROP TRIGGER reject_photo_audit');}};
}

export function installAdventureHttpSuite(label,makeFixture){
 test(`${label}: adventures, territories and photographs preserve permissions and rewards through HTTP`,{timeout:90000},async t=>{
  const f=await makeFixture(t);t.diagnostic(`HTTP integration database: ${f.engine}`);
  async function account(role='player'){
   const uid=unique(),email=uid+'@example.test';await f.db.run('INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',[uid,email,'HTTP '+role,passwordHash(password),role,Date.now()-2*DAY]);
   const login=await f.request('/api/login',{method:'POST',body:{email,password}});good(login);return {id:uid,email,cookie:login.cookie};
  }
  const admin=await account('admin'),player=await account(),other=await account(),voter=await account(),outsider=await account();
  const point=async(actor,value=first,cityId='almaty')=>good(await f.request('/api/location',{cookie:actor.cookie,method:'POST',body:{city_id:cityId,...value,accuracy:5,timestamp:Date.now()}}));
  const binary=async(path,actor,index=0,headers={})=>{
   const response=await fetch(f.apps[index%f.apps.length].base+path,{headers:{...headers,...(actor?{Cookie:actor.cookie}:{})}});
   return {status:response.status,headers:response.headers,bytes:Buffer.from(await response.arrayBuffer())};
  };
  const review=async(photo,status='approved',extra={})=>f.request(`/api/admin/photos/${photo.id}`,{cookie:admin.cookie,method:'PATCH',body:{version:photo.version,status,reason:'Проверка фотографии места оператором',...extra}});
  let route,team,zoneId=unique(),contest,photo,otherPhoto;
  const routeBody={cityId:'almaty',title:'HTTP маршрут высоты',description:'Проверка последовательных контрольных точек маршрута',kind:'mountain',difficulty:'moderate',cautions:'Тестовый маршрут, не используется для навигации.',sourceUrls:['https://www.openstreetmap.org/'],checkpoints:[{title:'Начало',...first,radius:30,altitudeM:1500},{title:'Вторая точка',...second,radius:30,altitudeM:1530}],xp:125,status:'open',statusReason:'Проверено оператором',fieldVerified:true,safetyReviewed:true};

  await t.test('administrative route creation requires MFA and cannot be granted by request fields',async()=>{
   assert.equal((await f.request('/api/admin/adventures',{cookie:player.cookie,method:'POST',body:{...routeBody,role:'admin'}})).status,403);
   rejected(await f.request('/api/admin/adventures',{cookie:admin.cookie,method:'POST',body:routeBody}),[403,423]);
   const setup=good(await f.request('/api/auth/mfa/setup',{cookie:admin.cookie,method:'POST',body:{password}}));good(await f.request('/api/auth/mfa/enable',{cookie:admin.cookie,method:'POST',body:{code:totp(setup.secret)}}));
   route=good(await f.request('/api/admin/adventures',{cookie:admin.cookie,method:'POST',body:routeBody})).item;
   assert.equal(route.xp,125);assert.equal(route.status,'open');
   assert.equal(good(await f.request('/api/adventures?city=astana')).items.some(item=>item.id===route.id),false);
   rejected(await f.request(`/api/admin/adventures/${route.id}`,{cookie:admin.cookie,method:'PATCH',body:{version:route.version+1,status:'closed',statusReason:'Неверная версия'}}),[409]);
  });

  await t.test('ordered check-ins require recent accurate GPS in the correct city; route and pet rewards are idempotent',async()=>{
   good(await f.request('/api/pet/adopt',{cookie:player.cookie,method:'POST',body:{name:'Горный друг',species:'fox',color:'mint'}}));
   const check=(checkpointIndex,extra={})=>f.request(`/api/adventures/${route.id}/checkin`,{cookie:player.cookie,method:'POST',body:{checkpointIndex,version:route.version,xp:9999,...extra}});
   assert.equal((await f.request(`/api/adventures/${route.id}/checkin`,{method:'POST',body:{checkpointIndex:0,version:route.version}})).status,401);
   rejected(await check(0));
   await point(player,{lng:71.4318,lat:51.152},'astana');rejected(await check(0));
   good(await f.request('/api/location',{cookie:player.cookie,method:'DELETE'}));await point(player);
   rejected(await check(1));
   await f.db.run('UPDATE positions SET updated_at=$1 WHERE user_id=$2',[Date.now()-120000,player.id]);rejected(await check(0));
   await point(player);await f.db.run('UPDATE positions SET accuracy=100 WHERE user_id=$1',[player.id]);rejected(await check(0));await point(player);
   good(await check(0));rejected(await check(1,{version:route.version+1}),[409]);
   await point(player,second);
   const results=await Promise.all([0,1,0].map(index=>f.request(`/api/adventures/${route.id}/checkin`,{index,cookie:player.cookie,method:'POST',body:{checkpointIndex:1,version:route.version}})));
   assert.equal(results.filter(result=>good(result).rewarded).length,1);
   assert.equal((await f.db.get('SELECT xp FROM users WHERE id=$1',[player.id])).xp,125);
   assert.equal((await f.db.get('SELECT count(*) AS n FROM adventure_rewards WHERE user_id=$1 AND route_id=$2',[player.id,route.id])).n,1);
   const pet=good(await f.request('/api/pet',{cookie:player.cookie})).pet;assert.equal(pet.xp,20);
   assert.equal((await f.db.get('SELECT count(*) AS n FROM pet_rewards WHERE user_id=$1 AND event_key=$2',[player.id,'adventure:'+route.id])).n,1);
  });

  await t.test('territory visits need a team and cannot be replayed after leaving or changing teams',async()=>{
   const time=Date.now();await f.db.run("INSERT INTO territory_zones(id,city_id,title,description,lng,lat,radius,status,created_at,updated_at,version) VALUES($1,'almaty','HTTP территория','Виртуальная зона',$2,$3,80,'active',$4,$4,1)",[zoneId,first.lng,first.lat,time]);
   const visit=actor=>f.request(`/api/territories/${zoneId}/visit`,{cookie:actor.cookie,method:'POST',body:{teamId:'forged',points:999}});
   rejected(await visit(player));
   team=good(await f.request('/api/team',{cookie:player.cookie,method:'POST',body:{city_id:'almaty',name:'HTTP первопроходцы'}})).team;
   await point(player);const results=await Promise.all([0,1].map(index=>f.request(`/api/territories/${zoneId}/visit`,{index,cookie:player.cookie,method:'POST',body:{}})));results.forEach(good);
   assert.equal((await f.db.get('SELECT count(*) AS n FROM territory_visits WHERE user_id=$1 AND zone_id=$2',[player.id,zoneId])).n,1);
   let zone=good(await f.request('/api/territories?city=almaty')).items.find(item=>item.id===zoneId);assert.equal(zone.owner.teamId,team.id);assert.equal(zone.owner.points,1);
   good(await f.request('/api/team',{cookie:player.cookie,method:'DELETE'}));
   const next=good(await f.request('/api/team',{cookie:player.cookie,method:'POST',body:{city_id:'almaty',name:'HTTP новая команда'}})).team;
   await point(player);good(await visit(player));
   assert.equal((await f.db.get('SELECT count(*) AS n FROM territory_visits WHERE user_id=$1 AND zone_id=$2',[player.id,zoneId])).n,1);
   zone=good(await f.request('/api/territories?city=almaty')).items.find(item=>item.id===zoneId);assert.notEqual(zone.owner?.teamId,next.id);
   assert.equal((await f.db.get('SELECT xp FROM users WHERE id=$1',[player.id])).xp,125);
  });

  const cameraSecret='private-camera-serial-and-location';
  const image=await sharp({create:{width:100,height:80,channels:3,background:{r:61,g:103,b:147}}}).withExif({IFD0:{ImageDescription:cameraSecret}}).jpeg().toBuffer();
  const upload=(actor,extra={})=>f.request('/api/photos',{cookie:actor.cookie,method:'POST',body:{cityId:'almaty',title:'Новое красивое место',caption:'Фотография пейзажа без людей',imageBase64:image.toString('base64'),rightsAttested:true,placeOnlyAttested:true,...extra}});

  await t.test('uploads validate ownership declarations and strip metadata before private storage',async()=>{
   const time=Date.now();contest=good(await f.request('/api/admin/photo-contests',{cookie:admin.cookie,method:'POST',body:{cityId:'almaty',title:'HTTP конкурс мест',description:'Проверка конкурса пейзажей и новых мест',startsAt:time-60000,submissionsCloseAt:time+3600000,votesCloseAt:time+7200000,status:'published'}})).contest;
   assert.equal((await upload(player,{rightsAttested:false})).status,400);
   assert.equal((await upload(player,{imageBase64:Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64')})).status,400);
   rejected(await upload(outsider));
   await point(other,{lng:71.4318,lat:51.152},'astana');rejected(await upload(other));good(await f.request('/api/location',{cookie:other.cookie,method:'DELETE'}));await point(other);
   photo=good(await upload(player,{contestId:contest.id,userId:other.id})).photo;assert.equal(photo.status,'pending');
   otherPhoto=good(await upload(other,{contestId:contest.id})).photo;
   assert.equal(good(await f.request('/api/photos/mine',{cookie:other.cookie})).items.some(item=>item.id===photo.id),false);
   assert.equal(good(await f.request('/api/photos?city=almaty')).items.some(item=>item.id===photo.id),false);
   const owned=await binary(`/api/photos/${photo.id}/image`,player);assert.equal(owned.status,200);assert.equal(owned.headers.get('content-type'),'image/jpeg');assert.match(owned.headers.get('cache-control'),/no-store/);assert.equal(owned.headers.get('x-content-type-options'),'nosniff');
   assert.equal(owned.bytes.includes(Buffer.from(cameraSecret)),false);const metadata=await sharp(owned.bytes).metadata();assert.equal(metadata.exif,undefined);assert.equal(metadata.xmp,undefined);
   rejected(await binary(`/api/photos/${photo.id}/image`,other),[403,404]);rejected(await binary(`/api/photos/${photo.id}/image`),[401,403,404]);
   const stored=await f.db.get('SELECT * FROM photos WHERE id=$1',[photo.id]);assert.equal(stored.user_id,player.id);assert.notEqual(stored.approx_lng,second.lng);assert.notEqual(stored.approx_lat,second.lat);assert.equal(owned.bytes.length,stored.image_bytes);
   if(f.engine!=='sqlite-local'){
    const headers={Origin:'capacitor://localhost','X-CityQuest-Client':'native'};
    const login=good(await f.request('/api/login',{method:'POST',headers,body:{email:player.email,password}}));assert.match(login.accessToken,/^[a-f0-9]{64}$/);
    const nativeHeaders={...headers,Authorization:'Bearer '+login.accessToken},native=await binary(`/api/photos/${photo.id}/image`,null,1,nativeHeaders);
    assert.equal(native.status,200);assert.equal(native.headers.get('access-control-allow-origin'),'capacitor://localhost');assert.deepEqual(native.bytes,owned.bytes);
    assert.equal((await binary(`/api/photos/${photo.id}/image`,null,1,{...nativeHeaders,Origin:'https://untrusted.example'})).status,403);
    good(await f.request('/api/logout',{index:1,method:'POST',headers:nativeHeaders,body:{}}));rejected(await binary(`/api/photos/${photo.id}/image`,null,0,nativeHeaders),[401,403,404]);
   }
  });

  await t.test('moderation grants discovery once, requires MFA, and public photos expose no private metadata',async()=>{
   assert.equal((await f.request(`/api/admin/photos/${photo.id}`,{cookie:other.cookie,method:'PATCH',body:{version:photo.version,status:'approved',reason:'fake'}})).status,403);
   const unverified=await account('admin');rejected(await f.request(`/api/admin/photos/${photo.id}`,{cookie:unverified.cookie,method:'PATCH',body:{version:photo.version,status:'approved',reason:'Без MFA'}}),[403,423]);
   const before=(await f.db.get('SELECT xp FROM users WHERE id=$1',[player.id])).xp;
   photo=good(await review(photo)).photo;otherPhoto=good(await review(otherPhoto)).photo;
   const after=(await f.db.get('SELECT xp FROM users WHERE id=$1',[player.id])).xp;assert.ok(after>before);
   rejected(await review({...photo,version:photo.version-1}),[409]);const repeated=good(await review(photo));assert.equal(repeated.idempotent,true);assert.equal((await f.db.get('SELECT xp FROM users WHERE id=$1',[player.id])).xp,after);
   const publicPhoto=good(await f.request('/api/photos?city=almaty')).items.find(item=>item.id===photo.id);assert.ok(publicPhoto);assert.equal(Object.hasOwn(publicPhoto,'user_id'),false);assert.equal(Object.hasOwn(publicPhoto,'image_base64'),false);assert.equal(Object.hasOwn(publicPhoto,'reviewed_by'),false);assert.equal(JSON.stringify(publicPhoto).includes(player.email),false);
   assert.equal((await binary(`/api/photos/${photo.id}/image`)).status,200);
   assert.equal(good(await f.request('/api/pet',{cookie:player.cookie})).pet.xp,30);
   assert.equal((await f.db.get('SELECT count(*) AS n FROM photo_discovery_rewards WHERE user_id=$1',[player.id])).n,1);
  });

  await t.test('free voting requires participation, forbids self-votes and retains only one ballot per contest',async()=>{
   await f.db.run('UPDATE photo_contests SET submissions_close_at=$1 WHERE id=$2',[Date.now()-1,contest.id]);
   const vote=(actor,photoId,index=0)=>f.request(`/api/photo-contests/${contest.id}/vote`,{index,cookie:actor.cookie,method:'POST',body:{photoId,weight:999,paid:true}});
   assert.equal((await vote(player,photo.id)).status,403);
   assert.equal((await vote(outsider,photo.id)).status,403);
   // A genuine adventure completion supplies participation; account age already
   // exceeds the 24-hour gate. Entitlements remain the default free plan.
   await f.db.run('INSERT INTO adventure_rewards(user_id,route_id,xp,created_at) VALUES($1,$2,0,$3)',[voter.id,route.id,Date.now()]);
   const votes=await Promise.all([0,1,0].map(index=>vote(voter,photo.id,index)));votes.forEach(good);
   assert.equal((await f.db.get('SELECT count(*) AS n FROM photo_votes WHERE contest_id=$1 AND user_id=$2',[contest.id,voter.id])).n,1);
   good(await vote(voter,otherPhoto.id));assert.equal((await f.db.get('SELECT photo_id FROM photo_votes WHERE contest_id=$1 AND user_id=$2',[contest.id,voter.id])).photo_id,otherPhoto.id);
   await f.db.run('UPDATE photo_contests SET votes_close_at=$1 WHERE id=$2',[Date.now()-1,contest.id]);
   rejected(await vote(voter,photo.id));assert.equal((await f.db.get('SELECT photo_id FROM photo_votes WHERE contest_id=$1 AND user_id=$2',[contest.id,voter.id])).photo_id,otherPhoto.id);
  });

  await t.test('withdrawal immediately hides image, frees storage and preserves discovery deduplication',async()=>{
   const before=await f.db.get('SELECT used_bytes FROM photo_storage WHERE id=1'),row=await f.db.get('SELECT * FROM photos WHERE id=$1',[otherPhoto.id]);
   assert.equal((await f.request(`/api/photos/${otherPhoto.id}`,{cookie:player.cookie,method:'DELETE',body:{version:otherPhoto.version}})).status,403);
   good(await f.request(`/api/photos/${otherPhoto.id}`,{cookie:other.cookie,method:'DELETE',body:{version:otherPhoto.version}}));
   rejected(await binary(`/api/photos/${otherPhoto.id}/image`),[401,403,404]);
   assert.equal(good(await f.request('/api/photos?city=almaty')).items.some(item=>item.id===otherPhoto.id),false);
   const withdrawn=await f.db.get('SELECT * FROM photos WHERE id=$1',[otherPhoto.id]);assert.equal(withdrawn.image_base64,null);assert.equal(withdrawn.image_bytes,0);
   assert.equal((await f.db.get('SELECT used_bytes FROM photo_storage WHERE id=1')).used_bytes,before.used_bytes-row.image_bytes);
   assert.equal((await f.db.get('SELECT count(*) AS n FROM photo_discovery_rewards WHERE user_id=$1',[other.id])).n,1);
   const view=good(await f.request(`/api/photo-contests/${contest.id}?city=almaty`));assert.equal(JSON.stringify(view).includes(otherPhoto.id),false);
  });

  await t.test('audit failure rolls photo approval and both reward ledgers back atomically',async()=>{
   await point(voter);good(await f.request('/api/pet/adopt',{cookie:voter.cookie,method:'POST',body:{name:'Друг фотографа',species:'cat',color:'mint'}}));
   const pending=good(await upload(voter)).photo;
   const before=await f.db.get('SELECT xp FROM users WHERE id=$1',[voter.id]);await f.blockPhotoAudit();
   try{assert.equal((await review(pending)).status,500);}finally{await f.unblockPhotoAudit();}
   assert.equal((await f.db.get('SELECT status FROM photos WHERE id=$1',[pending.id])).status,'pending');assert.deepEqual(await f.db.get('SELECT xp FROM users WHERE id=$1',[voter.id]),before);
   assert.equal((await f.db.get('SELECT xp FROM pets WHERE user_id=$1',[voter.id])).xp,0);
   assert.equal((await f.db.get('SELECT count(*) AS n FROM pet_rewards WHERE user_id=$1',[voter.id])).n,0);
   assert.equal((await f.db.get('SELECT count(*) AS n FROM photo_discovery_rewards WHERE photo_id=$1',[pending.id])).n,0);
  });
 });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))installAdventureHttpSuite('SQLite v5',sqliteAdventureFixture);
