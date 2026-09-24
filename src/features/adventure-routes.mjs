import {id,fail,text,number,choice,city,point,distance} from '../domain.mjs';
import {get,all,run,audit} from './store.mjs';
import {loadProductPolicy} from '../product-policy.mjs';

const DAY=86400000;
const ROUTE_NOTICE='Отметки высоты взяты из описаний мест. Это не измеренный GPS-набор высоты и не доказательство физического присутствия. Линии между точками не являются маршрутом навигации. За скорость и большую высоту бонусов нет.';
const ZONE_NOTICE='Зоны и владение существуют только в игре. Посещение даёт команде 1 очко в зоне за игрока в сутки UTC; при равенстве очков зона спорная. Не вступайте в конфликты, не препятствуйте проходу других людей. GPS клиента можно подменить: очки пилота не дают денежного приза.';
const object = value => {if(!value||typeof value!=='object'||Array.isArray(value))fail('Ожидается объект');return value;};
const integer=(value,label,min,max)=>{number(value,label,min,max);if(!Number.isSafeInteger(value))fail(`${label}: нужно целое число`);return value;};
const parse = (json, fallback=[]) => {try{return JSON.parse(json);}catch{return fallback;}};
export const territorySeason=time=>new Date(time).toISOString().slice(0,7);
function expected(body,row){if(!Number.isSafeInteger(body.version)||body.version!==row.version)fail('Объект изменился. Обновите данные.',409);}
function urls(value){if(!Array.isArray(value)||value.length>8)fail('Укажите не более 8 ссылок на источники');return value.map(item=>{const result=text(item,'Ссылка на источник',600);let url;try{url=new URL(result);}catch{fail('Некорректная ссылка на источник');}if(url.protocol!=='https:'||url.username||url.password)fail('Источник должен иметь HTTPS-адрес без учётных данных');return url.href;});}
function checkpoints(value,cityId){if(!Array.isArray(value)||value.length<1||value.length>20)fail('Маршрут должен содержать от 1 до 20 точек');return value.map(value=>{const p=object(value);point(p.lng,p.lat,cityId);return{title:text(p.title,'Название точки',120,3),lng:p.lng,lat:p.lat,radius:integer(p.radius??100,'Радиус точки',30,250),altitudeM:p.altitudeM===null||p.altitudeM===undefined?null:integer(p.altitudeM,'Отметка высоты',-100,4500)};});}
function routeInput(body,old,cityId){
 const kind=choice(body.kind??old?.kind??'urban',['urban','mountain'],'тип маршрута');
 const status=choice(body.status??old?.status??'draft',['draft','open','closed'],'статус маршрута');
 const sourceUrls=urls(body.sourceUrls??(old?parse(old.source_urls):[]));
 const cautions=text(body.cautions??old?.cautions??'','Ограничения и подготовка',1500,status==='open'?10:0);
 const statusReason=text(body.statusReason??old?.status_reason??'','Причина статуса',700,status==='open'?10:0);
 // Any published revision requires the operator to explicitly re-confirm the
 // exact checkpoints and local restrictions. A source link is not validation.
 if(status==='open'&&(body.fieldVerified!==true||body.safetyReviewed!==true))fail('Для открытия подтвердите проверку точек на месте и условий доступа',409);
 if(status==='open'&&!sourceUrls.length)fail('Перед открытием добавьте источники описания маршрута');
 const points=checkpoints(body.checkpoints??(old?parse(old.checkpoints_json):[]),cityId);
 if(kind==='urban'&&points.some(p=>p.altitudeM!==null))fail('Для городской прогулки отметки горной высоты не используются');
 return {cityId,title:text(body.title??old?.title,'Название маршрута',120,3),description:text(body.description??old?.description??'','Описание',2000,10),kind,difficulty:choice(body.difficulty??old?.difficulty??'easy',['easy','moderate','hard'],'сложность'),cautions,sourceUrls,checkpoints:points,status,statusReason,xp:integer(body.xp??old?.xp??80,'Награда XP',0,500)};
}
function summarizeProgress(row,visits,reward){
 const points=parse(row.checkpoints_json);
 let ascent=0,max=null,previous=null;
 for(const visit of visits){if(visit.altitude_m!==null){if(previous!==null)ascent+=Math.max(0,visit.altitude_m-previous);max=max===null?visit.altitude_m:Math.max(max,visit.altitude_m);}previous=visit.altitude_m;}
 return {visited:visits.length,total:points.length,completed:visits.length===points.length,rewardClaimed:Boolean(reward),maxCheckpointAltitudeM:max,checkpointAscentM:ascent};
}
function* progress(row,userId){
 const visits=userId?yield all('SELECT checkpoint_index,altitude_m FROM adventure_checkins WHERE user_id=$1 AND route_id=$2 AND route_version=$3 ORDER BY checkpoint_index',[userId,row.id,row.version]):[];
 const reward=userId?yield get('SELECT xp FROM adventure_rewards WHERE user_id=$1 AND route_id=$2',[userId,row.id]):null;
 return summarizeProgress(row,visits,reward);
}
function* routeView(row,userId,knownProgress){return{id:row.id,cityId:row.city_id,title:row.title,description:row.description,kind:row.kind,difficulty:row.difficulty,cautions:row.cautions,sourceUrls:parse(row.source_urls),checkpoints:parse(row.checkpoints_json),status:row.status,statusReason:row.status_reason,version:row.version,xp:row.xp,verifiedAt:row.verified_at,progress:knownProgress??(yield* progress(row,userId))};}
function* routeList(cityId,userId){
 const rows=yield all('SELECT * FROM adventure_routes WHERE city_id=$1 ORDER BY kind,title,id LIMIT 200',[cityId]),byRoute=new Map(),versions=new Map(rows.map(row=>[row.id,row.version]));
 const visits=userId?yield all('SELECT c.route_id,c.route_version,c.checkpoint_index,c.altitude_m FROM adventure_checkins c JOIN adventure_routes r ON r.id=c.route_id AND r.version=c.route_version WHERE c.user_id=$1 AND r.city_id=$2 ORDER BY c.route_id,c.checkpoint_index',[userId,cityId]):[];
 const rewarded=new Set((userId?yield all('SELECT a.route_id FROM adventure_rewards a JOIN adventure_routes r ON r.id=a.route_id WHERE a.user_id=$1 AND r.city_id=$2',[userId,cityId]):[]).map(row=>row.route_id));
 // A concurrent edit between read statements must not display revision N+1's
 // progress against revision N's checkpoints under PostgreSQL READ COMMITTED.
 for(const visit of visits){if(versions.get(visit.route_id)!==visit.route_version)continue;if(!byRoute.has(visit.route_id))byRoute.set(visit.route_id,[]);byRoute.get(visit.route_id).push(visit);}
 const items=[];for(const row of rows)items.push(yield* routeView(row,userId,summarizeProgress(row,byRoute.get(row.id)||[],rewarded.has(row.id))));return items;
}
function* reserveCatalogSlot(kind,cityId){
 // Shared row lock closes count-and-insert races between different admins.
 yield run('INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value',[`adventure:catalog:${kind}:${cityId}`,'1']);
 const table=kind==='route'?'adventure_routes':'territory_zones',cap=kind==='route'?200:100;
 const count=yield get(`SELECT COUNT(*) AS n FROM ${table} WHERE city_id=$1`,[cityId]);
 if(Number(count.n)>=cap)fail(`Лимит объектов этого типа в городе: ${cap}`,409);
}
function* gps(userId,cityId,target,time,policy){
 const position=yield get('SELECT * FROM positions WHERE user_id=$1',[userId]);
 if(!position||position.city_id!==cityId||position.updated_at>time||time-position.updated_at>policy.maxAgeMs)fail(`Обновите геопозицию в выбранном городе: нужна отметка не старше ${policy.maxAgeMs/1000} секунд`,409);
 if(!Number.isFinite(position.accuracy)||position.accuracy<0||position.accuracy>policy.maxAccuracyM)fail(`Недостаточная точность GPS: требуется ${policy.maxAccuracyM} м или лучше`,409);
 point(position.lng,position.lat,cityId);
 if(distance(position,target)>target.radius)fail('Вы за пределами зоны точки',409);
 return position;
}
function* awardRoute(userId,route,time,petRewardXp){
 const saved=yield run('INSERT INTO adventure_rewards(user_id,route_id,xp,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,route_id) DO NOTHING',[userId,route.id,route.xp,time]);
 if(!saved.rowCount)return{rewarded:false,xpAwarded:0,petXpAwarded:0};
 yield run('UPDATE users SET xp=xp+$1 WHERE id=$2',[route.xp,userId]);
 const pet=yield get('SELECT user_id FROM pets WHERE user_id=$1 FOR UPDATE',[userId]);let petXp=0;
 if(pet){const reward=yield run('INSERT INTO pet_rewards(user_id,event_key,xp,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,event_key) DO NOTHING',[userId,`adventure:${route.id}`,petRewardXp,time]);petXp=reward.rowCount*petRewardXp;if(petXp)yield run('UPDATE pets SET xp=xp+$1,updated_at=$2 WHERE user_id=$3',[petXp,time,userId]);}
 yield audit(userId,'adventure.completed',route.id,{city_id:route.city_id,xp:route.xp,pet_xp:petXp});
 return{rewarded:true,xpAwarded:route.xp,petXpAwarded:petXp};
}
function zoneInput(body,old,cityId){
 const lng=body.lng??old?.lng,lat=body.lat??old?.lat;point(lng,lat,cityId);
 const status=choice(body.status??old?.status??'disabled',['active','disabled'],'статус зоны');
 if(status==='active'&&body.publicAccessReviewed!==true)fail('Подтвердите проверку общедоступных подходов к зоне',409);
 return{cityId,title:text(body.title??old?.title,'Название зоны',120,3),description:text(body.description??old?.description??'','Описание зоны',1000,10),lng,lat,radius:integer(body.radius??old?.radius??120,'Радиус зоны',50,300),status};
}
function zoneView(row){return{id:row.id,cityId:row.city_id,title:row.title,description:row.description,lng:row.lng,lat:row.lat,radius:row.radius,status:row.status,version:row.version};}
function* zoneScores(zoneId,season){return (yield all('SELECT v.team_id,t.name,COUNT(*) AS points FROM territory_visits v JOIN teams t ON t.id=v.team_id WHERE v.zone_id=$1 AND v.season=$2 GROUP BY v.team_id,t.name ORDER BY points DESC,v.team_id LIMIT 20',[zoneId,season])).map(row=>({teamId:row.team_id,name:row.name,points:Number(row.points)}));}
function* territoryView(row,userId,time){const leaders=yield* zoneScores(row.id,territorySeason(time)),contested=leaders.length>1&&leaders[0].points===leaders[1].points,visit=userId?yield get('SELECT team_id FROM territory_visits WHERE user_id=$1 AND zone_id=$2 AND day=$3',[userId,row.id,Math.floor(time/DAY)]):null;return{...zoneView(row),leaders,contested,owner:contested?null:leaders[0]??null,visitedToday:Boolean(visit)};}
function* territoryList(cityId,userId,time){
 const season=territorySeason(time),rows=yield all("SELECT * FROM territory_zones WHERE city_id=$1 AND status='active' ORDER BY title,id LIMIT 100",[cityId]);
 const scores=yield all("SELECT zone_id,team_id,name,points FROM (SELECT v.zone_id,v.team_id,t.name,COUNT(*) AS points,ROW_NUMBER() OVER(PARTITION BY v.zone_id ORDER BY COUNT(*) DESC,v.team_id) AS ranking FROM territory_visits v JOIN territory_zones z ON z.id=v.zone_id JOIN teams t ON t.id=v.team_id WHERE z.city_id=$1 AND z.status='active' AND v.season=$2 GROUP BY v.zone_id,v.team_id,t.name) ranked WHERE ranking<=20 ORDER BY zone_id,points DESC,team_id",[cityId,season]);
 const byZone=new Map();for(const score of scores){if(!byZone.has(score.zone_id))byZone.set(score.zone_id,[]);byZone.get(score.zone_id).push({teamId:score.team_id,name:score.name,points:Number(score.points)});}
 const visited=new Set((userId?yield all('SELECT v.zone_id FROM territory_visits v JOIN territory_zones z ON z.id=v.zone_id WHERE v.user_id=$1 AND v.day=$2 AND z.city_id=$3',[userId,Math.floor(time/DAY),cityId]):[]).map(row=>row.zone_id));
 const items=rows.map(row=>{const leaders=byZone.get(row.id)||[],contested=leaders.length>1&&leaders[0].points===leaders[1].points;return{...zoneView(row),leaders,contested,owner:contested?null:leaders[0]??null,visitedToday:visited.has(row.id)};});
 const leaderboard=(yield all("SELECT v.team_id,t.name,COUNT(*) AS points FROM territory_visits v JOIN territory_zones z ON z.id=v.zone_id JOIN teams t ON t.id=v.team_id WHERE z.city_id=$1 AND z.status='active' AND v.season=$2 GROUP BY v.team_id,t.name ORDER BY points DESC,v.team_id LIMIT 50",[cityId,season])).map(row=>({teamId:row.team_id,name:row.name,points:Number(row.points)}));
 return{items,cityId,season,leaderboard,notice:ZONE_NOTICE};
}

export function createAdventureRoutes({store,cfg={},env=cfg.env||process.env,now=Date.now}={}){
 const policy=cfg.productPolicy||loadProductPolicy(env);
 return async function adventureRoutes(ctx){
  const {path,method,user}=ctx;
  if(!/^\/api\/(?:admin\/)?(?:adventures|territories)(?:\/|$)/.test(path))return undefined;
  const cityId=city(ctx.cityId||ctx.url?.searchParams.get('city')||'almaty').id;
  if(path==='/api/adventures'&&method==='GET')return store.read(function*(){return{items:yield* routeList(cityId,user?.id),cityId,notice:ROUTE_NOTICE};});
  if(path==='/api/territories'&&method==='GET')return store.read(function*(){return yield* territoryList(cityId,user?.id,now());});
  if(!user?.id)fail('Войдите в аккаунт',401);
  const checkin=path.match(/^\/api\/adventures\/([a-zA-Z0-9-]{1,100})\/checkin$/);
  if(checkin&&method==='POST'){
   const body=object(await ctx.readBody()),index=integer(body.checkpointIndex,'Номер точки',0,19);
   return store.transaction(function*(){yield* store.requireActor(user);const row=yield get('SELECT * FROM adventure_routes WHERE id=$1 FOR UPDATE',[checkin[1]]);if(!row||row.city_id!==cityId)fail('Маршрут не найден в выбранном городе',404);expected(body,row);if(row.status!=='open')fail('Маршрут закрыт для прохождения. '+row.status_reason,409);const points=parse(row.checkpoints_json);if(index>=points.length)fail('Такой точки в маршруте нет');const before=yield* progress(row,user.id);if(index<before.visited)return{item:yield* routeView(row,user.id),replayed:true,rewarded:false,xpAwarded:0,petXpAwarded:0};if(index!==before.visited)fail('Сначала отметьте предыдущую точку',409);const time=now();yield* gps(user.id,row.city_id,points[index],time,policy.gps);yield run('INSERT INTO adventure_checkins(user_id,route_id,route_version,checkpoint_index,altitude_m,created_at) VALUES($1,$2,$3,$4,$5,$6)',[user.id,row.id,row.version,index,points[index].altitudeM,time]);const reward=index===points.length-1?yield* awardRoute(user.id,row,time,policy.adventures.petXp):{rewarded:false,xpAwarded:0,petXpAwarded:0};return{item:yield* routeView(row,user.id),replayed:false,...reward};});
  }
  const visit=path.match(/^\/api\/territories\/([a-zA-Z0-9-]{1,100})\/visit$/);
  if(visit&&method==='POST'){
   await ctx.readBody();
   return store.transaction(function*(){
    yield* store.requireActor(user);
    const row=yield get('SELECT * FROM territory_zones WHERE id=$1 FOR UPDATE',[visit[1]]);
    if(!row||row.city_id!==cityId)fail('Зона не найдена в выбранном городе',404);
    if(row.status!=='active')fail('Зона временно отключена',409);
    let time=now(),day=Math.floor(time/DAY),season=territorySeason(time);
    const existing=yield get('SELECT team_id FROM territory_visits WHERE user_id=$1 AND zone_id=$2 AND day=$3',[user.id,row.id,day]);
    // A replay remains valid after leaving a team and needs no fresh GPS.
    if(existing)return{item:yield* territoryView(row,user.id,time),season,replayed:true,pointsAwarded:0,teamId:existing.team_id};
    const membership=yield get('SELECT team_id,joined_at FROM members WHERE user_id=$1 FOR UPDATE',[user.id]);
    if(!membership)fail('Сначала вступите в команду выбранного города',409);
    const team=yield get('SELECT * FROM teams WHERE id=$1 FOR NO KEY UPDATE',[membership.team_id]);
    if(!team||team.city_id!==cityId)fail('Нужна команда выбранного города',409);
    // A concurrent join/leave can delay the team lock. Validate freshness and
    // record the UTC day/season using the clock after that wait, not before it.
    time=now();
    const currentDay=Math.floor(time/DAY);
    if(currentDay!==day){
     day=currentDay;season=territorySeason(time);
     const currentVisit=yield get('SELECT team_id FROM territory_visits WHERE user_id=$1 AND zone_id=$2 AND day=$3',[user.id,row.id,day]);
     if(currentVisit)return{item:yield* territoryView(row,user.id,time),season,replayed:true,pointsAwarded:0,teamId:currentVisit.team_id};
    }
    const position=yield* gps(user.id,cityId,row,time,policy.gps);
    if(position.updated_at<membership.joined_at)fail('После вступления в команду обновите геопозицию',409);
    const count=yield get('SELECT COUNT(*) AS n FROM territory_visits WHERE user_id=$1 AND day=$2',[user.id,day]);
    if(Number(count.n)>=policy.territories.dailyVisits)fail(`Дневной лимит: ${policy.territories.dailyVisits} посещений командных зон`,429);
    yield run('INSERT INTO territory_visits(user_id,zone_id,season,day,team_id,created_at) VALUES($1,$2,$3,$4,$5,$6)',[user.id,row.id,season,day,team.id,time]);
    yield audit(user.id,'territory.visited',row.id,{city_id:cityId,team_id:team.id,season});
    return{item:yield* territoryView(row,user.id,time),season,replayed:false,pointsAwarded:1,teamId:team.id};
   });
  }
  if(path==='/api/admin/adventures'&&method==='GET')return store.transaction(function*(){yield* store.requireActor(user,['admin']);return{items:yield* routeList(cityId,user.id),cityId,notice:ROUTE_NOTICE};});
  if(path==='/api/admin/adventures'&&method==='POST'){
   const body=object(await ctx.readBody()),targetCity=city(body.cityId??cityId).id,value=routeInput(body,null,targetCity);
   return store.transaction(function*(){const actor=yield* store.requireActor(user,['admin']),time=now(),rid=id();yield* reserveCatalogSlot('route',targetCity);yield run('INSERT INTO adventure_routes(id,city_id,title,description,kind,difficulty,cautions,source_urls,checkpoints_json,status,status_reason,verified_by,verified_at,created_at,updated_at,version,xp) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,1,$15)',[rid,targetCity,value.title,value.description,value.kind,value.difficulty,value.cautions,JSON.stringify(value.sourceUrls),JSON.stringify(value.checkpoints),value.status,value.statusReason,value.status==='open'?actor.id:null,value.status==='open'?time:null,time,value.xp]);yield audit(actor.id,'adventure.created',rid,{city_id:targetCity,status:value.status});return{item:yield* routeView(yield get('SELECT * FROM adventure_routes WHERE id=$1',[rid]),user.id)};});
  }
  const editRoute=path.match(/^\/api\/admin\/adventures\/([a-zA-Z0-9-]{1,100})$/);
  if(editRoute&&method==='PATCH'){
   const body=object(await ctx.readBody());
   return store.transaction(function*(){const actor=yield* store.requireActor(user,['admin']),row=yield get('SELECT * FROM adventure_routes WHERE id=$1 FOR UPDATE',[editRoute[1]]);if(!row||row.city_id!==cityId)fail('Маршрут не найден',404);expected(body,row);if(body.cityId!==undefined&&body.cityId!==row.city_id)fail('Город созданного маршрута менять нельзя');const value=routeInput(body,row,row.city_id),time=now();yield run('UPDATE adventure_routes SET title=$2,description=$3,kind=$4,difficulty=$5,cautions=$6,source_urls=$7,checkpoints_json=$8,status=$9,status_reason=$10,verified_by=$11,verified_at=$12,updated_at=$13,version=version+1,xp=$14 WHERE id=$1',[row.id,value.title,value.description,value.kind,value.difficulty,value.cautions,JSON.stringify(value.sourceUrls),JSON.stringify(value.checkpoints),value.status,value.statusReason,value.status==='open'?actor.id:row.verified_by,value.status==='open'?time:row.verified_at,time,value.xp]);yield audit(actor.id,'adventure.updated',row.id,{city_id:row.city_id,status:value.status,version:row.version+1});return{item:yield* routeView(yield get('SELECT * FROM adventure_routes WHERE id=$1',[row.id]),user.id)};});
  }
  if(path==='/api/admin/territories'&&method==='GET')return store.transaction(function*(){yield* store.requireActor(user,['admin']);return{items:(yield all('SELECT * FROM territory_zones WHERE city_id=$1 ORDER BY updated_at DESC,id LIMIT 100',[cityId])).map(zoneView),cityId};});
  if(path==='/api/admin/territories'&&method==='POST'){
   const body=object(await ctx.readBody()),targetCity=city(body.cityId??cityId).id,value=zoneInput(body,null,targetCity);
   return store.transaction(function*(){const actor=yield* store.requireActor(user,['admin']),time=now(),zid=id();yield* reserveCatalogSlot('zone',targetCity);yield run('INSERT INTO territory_zones(id,city_id,title,description,lng,lat,radius,status,created_at,updated_at,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,1)',[zid,targetCity,value.title,value.description,value.lng,value.lat,value.radius,value.status,time]);yield audit(actor.id,'territory.created',zid,{city_id:targetCity,status:value.status});return{item:zoneView(yield get('SELECT * FROM territory_zones WHERE id=$1',[zid]))};});
  }
  const editZone=path.match(/^\/api\/admin\/territories\/([a-zA-Z0-9-]{1,100})$/);
  if(editZone&&method==='PATCH'){
   const body=object(await ctx.readBody());
   return store.transaction(function*(){const actor=yield* store.requireActor(user,['admin']),row=yield get('SELECT * FROM territory_zones WHERE id=$1 FOR UPDATE',[editZone[1]]);if(!row||row.city_id!==cityId)fail('Зона не найдена',404);expected(body,row);if(body.cityId!==undefined&&body.cityId!==row.city_id)fail('Город зоны менять нельзя');const value=zoneInput(body,row,row.city_id),time=now();yield run('UPDATE territory_zones SET title=$2,description=$3,lng=$4,lat=$5,radius=$6,status=$7,updated_at=$8,version=version+1 WHERE id=$1',[row.id,value.title,value.description,value.lng,value.lat,value.radius,value.status,time]);yield audit(actor.id,'territory.updated',row.id,{city_id:row.city_id,status:value.status,version:row.version+1});return{item:zoneView(yield get('SELECT * FROM territory_zones WHERE id=$1',[row.id]))};});
  }
  return undefined;
 };
}
