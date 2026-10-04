import {parseQuestMetadata,publicQuest} from '../quest-metadata.mjs';
import {randomBytes} from 'node:crypto';
import {id,hash,fail,text,number,choice,point,normalizeCode,city} from '../domain.mjs';
import {DEFAULT_CITY} from '../cities.mjs';
import {osmQuery} from '../osm.mjs';
import {enterpriseListRoutes} from '../features/list-routes.mjs';

const MANAGER_ROLES=['business','admin'];
const RESOURCE_ID=/^[a-zA-Z0-9-]+$/;
const stale=()=>fail('Запись изменена. Обновите данные перед сохранением.',409);

// Every mutation holds the actor until commit. Role changes lock all affected users
// in ID order; NO KEY UPDATE permits unrelated foreign-key checks on user IDs.
async function freshActor(ctx,tx,additionalIds=[]) {
 const {user,required,cfg}=ctx;required(user,MANAGER_ROLES);
 const ids=[...new Set([user.id,...additionalIds])].sort();
 const rows=await tx.all('SELECT * FROM users WHERE id=ANY($1::text[]) ORDER BY id FOR NO KEY UPDATE',[ids]);
 const actor=rows.find(row=>row.id===user.id);
 const session=actor&&user.session_id?await tx.get('SELECT id,user_id,expires,last_seen,mfa_verified FROM sessions WHERE id=$1 AND user_id=$2',[user.session_id,user.id]):null;
 const now=Date.now();
 if(!actor||actor.disabled||!session||session.expires<=now||session.last_seen<=now-(cfg.idleMs??1800000)||actor.role!==user.role||actor.mfa_enabled!==user.mfa_enabled||session.mfa_verified!==user.session_mfa_verified)fail('Доступ изменился. Войдите заново.',401);
 const result={...actor,session_id:session.id,session_mfa_verified:session.mfa_verified};
 required(result,MANAGER_ROLES);return {actor:result,rows};
}
function orgPermission(ctx,user,org) {
 ctx.required(user,MANAGER_ROLES);if(!org)fail('Организация не найдена',404);
 if(user.role!=='admin'&&org.owner_id!==user.id)fail('Это чужая организация',403);
}
function questPermission(ctx,user,quest) {
 ctx.required(user,MANAGER_ROLES);if(!quest)fail('Квест не найден',404);
 if(user.role!=='admin'&&quest.owner_id!==user.id)fail('Это чужой квест',403);
}
async function validAssignee(tx,value) {
 if(!value)return null;
 if(typeof value!=='string'||!RESOURCE_ID.test(value))fail('Пользователь не найден');
 if(!await tx.get('SELECT id FROM users WHERE id=$1 AND disabled=0',[value]))fail('Пользователь не найден');return value;
}
async function insertObject(tx,table,obj) {
 const names=Object.keys(obj);
 await tx.run(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map((_,i)=>'$'+(i+1)).join(',')})`,names.map(n=>obj[n]));
}
async function updateVersioned(tx,table,old,body,obj) {
 if(!Number.isSafeInteger(body.version)||body.version!==old.version)stale();
 const values={...obj,version:old.version+1,updated_at:Date.now()},names=Object.keys(values);
 const item=await tx.get(`UPDATE ${table} SET ${names.map((n,i)=>n+'=$'+(i+1)).join(',')} WHERE id=$${names.length+1} AND version=$${names.length+2} RETURNING *`,[...names.map(n=>values[n]),old.id,old.version]);
 if(!item)stale();return item;
}
async function parseOrg(tx,body,user,old) {
 const c=city(body.city_id||old?.city_id||DEFAULT_CITY);point(body.lng,body.lat,c.id);
 if(old&&c.id!==old.city_id)fail('Для другого города создайте новую карточку');
 const status=user.role==='admin'?choice(body.status||'approved',['pending','approved','rejected'],'статус'):'pending';
 return {city_id:c.id,name:text(body.name,'Название',160),category:text(body.category||'other','Категория',60),lng:body.lng,lat:body.lat,address:text(body.address||'','Адрес',250,0),description:text(body.description||'','Описание',2000,0),status,owner_id:user.role==='admin'?await validAssignee(tx,body.owner_id):user.id};
}
async function lockOrganizations(tx,ids) {
 const selected=[...new Set(ids.filter(Boolean))].sort();
 if(selected.some(value=>typeof value!=='string'||!RESOURCE_ID.test(value)))fail('Организация не найдена');
 return selected.length?await tx.all('SELECT * FROM organizations WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[selected]):[];
}
async function parseQuest(ctx,tx,body,user,old,organizations) {
 const c=city(body.city_id||old?.city_id||DEFAULT_CITY);point(body.lng,body.lat,c.id);
 if(old&&c.id!==old.city_id)fail('Нельзя переместить существующий квест в другой город');
 const orgId=body.organization_id||null,org=orgId?organizations.find(item=>item.id===orgId):null;
 if(orgId&&!org)fail('Организация не найдена');if(org&&org.city_id!==c.id)fail('Организация находится в другом городе');
 if(user.role==='business')orgPermission(ctx,user,org);
 const status=user.role==='admin'?choice(body.status||'draft',['draft','pending','published','archived'],'статус'):choice(body.status||'pending',['draft','pending'],'статус');
 if(status==='published'&&org&&org.status!=='approved')fail('Сначала одобрите организацию');
 const verification=choice(body.verification||'checkin',['checkin','code','token'],'проверка');let codeHash=null;
 if(verification==='code'){
  if(body.code)codeHash=hash(normalizeCode(text(body.code,'Код',64,4)));
  else if(old?.verification==='code')codeHash=old.code_hash;
  else fail('Укажите код от 4 символов');
 }
 // Assignment is an administrator decision. An ordinary merchant edit must
 // preserve it through moderation instead of silently widening the audience.
 const scope=choice(body.scope||'public',['public','personal'],'тип квеста'),assigned=user.role==='admin'?await validAssignee(tx,body.assigned_to):(old?.assigned_to??null);
 if(assigned&&scope!=='personal')fail('Назначать игроку можно только индивидуальный квест');
 const starts=body.starts_at==null||body.starts_at===''?null:Math.round(number(body.starts_at,'Начало',0,9000000000000));
 const ends=body.ends_at==null||body.ends_at===''?null:Math.round(number(body.ends_at,'Окончание',0,9000000000000));
 if(starts!==null&&ends!==null&&ends<=starts)fail('Окончание должно быть после начала');
 const cap=body.max_completions==null||body.max_completions===''?null:Math.round(number(body.max_completions,'Лимит наград',1,1000000));
 if(old&&cap!==null&&(await tx.get('SELECT count(*) n FROM completions WHERE quest_id=$1',[old.id])).n>cap)fail('Лимит меньше уже выданных наград');
 return {city_id:c.id,title:text(body.title,'Название',160),description:text(body.description,'Описание',3000,10),lng:body.lng,lat:body.lat,radius:Math.round(number(body.radius??150,'Радиус',30,500)),xp:Math.round(number(body.xp??100,'Опыт',10,1000)),scope,verification,code_hash:codeHash,status,organization_id:orgId,assigned_to:assigned,goal:Math.round(number(body.goal??20,'Общая цель',1,10000)),starts_at:starts,ends_at:ends,max_completions:cap,...parseQuestMetadata(body,old)};
}
// Organization rows always precede quests. A concurrent relink is a conflict,
// not a reason to acquire a second organization lock out of order.
async function lockQuestWithOrganizations(tx,questId,body) {
 const snapshot=await tx.get('SELECT organization_id FROM quests WHERE id=$1',[questId]);
 if(!snapshot)fail('Квест не найден',404);
 const organizations=await lockOrganizations(tx,[snapshot.organization_id,body&&Object.hasOwn(body,'organization_id')?body.organization_id:snapshot.organization_id]);
 const quest=await tx.get('SELECT * FROM quests WHERE id=$1 FOR UPDATE',[questId]);
 if(!quest)fail('Квест не найден',404);if(quest.organization_id!==snapshot.organization_id)stale();
 return {quest,organizations};
}
function normalizeOsm(data,cityId) {
 const bounds=city(cityId).bounds;
 if(!Array.isArray(data?.elements)||data.elements.length>50000)fail('Ожидается Overpass JSON, максимум 50000 объектов');
 if(data.remark)fail('Overpass вернул неполный ответ: '+String(data.remark).slice(0,200));
 const unique=new Map();let skipped=0;
 for(const item of data.elements){
  const tags=item?.tags||{},lng=item?.lon??item?.center?.lon,lat=item?.lat??item?.center?.lat;
  if(!['node','way','relation'].includes(item?.type)||!Number.isSafeInteger(item.id)||item.id<=0||typeof tags.name!=='string'||!tags.name.trim()||!Number.isFinite(lng)||!Number.isFinite(lat)||lng<bounds.west||lng>bounds.east||lat<bounds.south||lat>bounds.north){skipped++;continue;}
  const osm_id=`${item.type}/${item.id}`;
  if(unique.has(osm_id))skipped++;
  unique.set(osm_id,{id:id(),osm_id,name:String(tags['name:ru']||tags.name).slice(0,160),category:String(tags.shop?'shop':tags.amenity||tags.tourism||tags.leisure||tags.office||tags.craft||'other').slice(0,60),lng,lat,address:[tags['addr:street'],tags['addr:housenumber']].filter(Boolean).join(' ').slice(0,250),source:`https://www.openstreetmap.org/${osm_id}`});
 }
 return {items:[...unique.values()].sort((a,b)=>a.osm_id.localeCompare(b.osm_id)),skipped};
}
async function importOsmPostgres(ctx,tx,user,data,cityId,normalized) {
 const now=Date.now();let inserted=0,updated=0,skipped=normalized.skipped;
 // Serialize imports, then lock existing cards in the same ID order as editor
 // mutations. Sorting only by OSM ID could deadlock with a quest relink that
 // locks two organizations by their application IDs.
 await tx.get("SELECT pg_advisory_xact_lock(hashtextextended('cityquest:osm-import',0))");
 if(normalized.items.length)await tx.all('SELECT id FROM organizations WHERE osm_id=ANY($1::text[]) ORDER BY id FOR UPDATE',[normalized.items.map(item=>item.osm_id)]);
 // ORDER BY also gives stable insertion order for new OSM IDs.
 // The WHERE clause is checked after ON CONFLICT obtains the current row lock:
 // a concurrent claim cannot be overwritten, and existing city IDs never move.
 if(normalized.items.length){
  const stats=await tx.get(`WITH changed AS (
   INSERT INTO organizations(id,osm_id,name,category,lng,lat,address,source,description,status,created_at,updated_at,city_id,version)
   SELECT x.id,x.osm_id,x.name,x.category,x.lng,x.lat,x.address,x.source,
    'Импорт OpenStreetMap. Актуальность и часы работы уточняйте у организации.','approved',$2,$2,$3,1
   FROM jsonb_to_recordset($1::jsonb) AS x(id text,osm_id text,name text,category text,lng double precision,lat double precision,address text,source text)
   ORDER BY x.osm_id
   ON CONFLICT(osm_id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,lng=EXCLUDED.lng,lat=EXCLUDED.lat,address=EXCLUDED.address,source=EXCLUDED.source,version=organizations.version+1,updated_at=EXCLUDED.updated_at
   WHERE organizations.owner_id IS NULL AND organizations.city_id=EXCLUDED.city_id
   RETURNING (xmax=0) AS inserted
  ) SELECT count(*) FILTER(WHERE inserted) AS inserted,count(*) FILTER(WHERE NOT inserted) AS updated FROM changed`,[JSON.stringify(normalized.items),now,cityId]);
  inserted=Number(stats.inserted);updated=Number(stats.updated);skipped+=normalized.items.length-inserted-updated;
 }
 const report={cityId,at:now,sourceTimestamp:typeof data.osm3s?.timestamp_osm_base==='string'?data.osm3s.timestamp_osm_base.slice(0,100):null,inserted,updated,skipped};
 for(const key of [`osm_import_${cityId}`,'osm_import'])await tx.run('INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[key,JSON.stringify(report)]);
 await ctx.audit(tx,user.id,'osm.import',cityId,{...report,city_id:cityId});return {inserted,updated,skipped};
}

export function createManageRoutes() {
 return async function route(ctx) {
  const {db,req,url,user,required,readBody,audit,throttle}=ctx;
  const path=ctx.path??url.pathname,method=ctx.method??req.method,cityId=city(ctx.cityId||url.searchParams.get('city')||DEFAULT_CITY).id;
  if(!path.startsWith('/api/manage'))return undefined;
  const withActor=(callback,extra=[])=>db.transaction(async tx=>{const {actor,rows}=await freshActor(ctx,tx,extra);return callback(tx,actor,rows);});

  const listResult=await enterpriseListRoutes({...ctx,path,method,cityId});
  if(listResult!==undefined)return listResult;
  if(path==='/api/manage/organizations'&&method==='POST'){
   required(user,MANAGER_ROLES);const body=await readBody();
   return withActor(async(tx,actor)=>{const now=Date.now(),item={id:id(),...await parseOrg(tx,body,actor),source:'manual',created_at:now,updated_at:now,version:1};await insertObject(tx,'organizations',item);await audit(tx,actor.id,'organization.create',item.id,{city_id:item.city_id});return {item};});
  }
  const editOrg=path.match(/^\/api\/manage\/organizations\/([a-zA-Z0-9-]+)$/);
  if(editOrg&&method==='PATCH'){
   required(user,MANAGER_ROLES);const body=await readBody();
   return withActor(async(tx,actor)=>{
    const old=await tx.get('SELECT * FROM organizations WHERE id=$1 FOR UPDATE',[editOrg[1]]);orgPermission(ctx,actor,old);
    const values=await parseOrg(tx,{...old,...body},actor,old),item=await updateVersioned(tx,'organizations',old,body,values);
    if(values.status!=='approved'){
     const affected=await tx.all("SELECT id FROM quests WHERE organization_id=$1 AND status='published' ORDER BY id FOR UPDATE",[old.id]);
     if(affected.length){
      const ids=affected.map(q=>q.id),now=Date.now();
      await tx.run("UPDATE quests SET status='pending',version=version+1,updated_at=$1 WHERE id=ANY($2::text[])",[now,ids]);
      await tx.run('UPDATE reward_tokens SET revoked_at=$1 WHERE quest_id=ANY($2::text[]) AND redeemed_at IS NULL AND revoked_at IS NULL',[now,ids]);
     }
    }
    await audit(tx,actor.id,'organization.update',old.id,{city_id:old.city_id,version:item.version});return {item};
   });
  }
  if(path==='/api/manage/quests'&&method==='POST'){
   required(user,MANAGER_ROLES);const body=await readBody();
   return withActor(async(tx,actor)=>{const organizations=await lockOrganizations(tx,[body.organization_id]),now=Date.now();const item={id:id(),owner_id:actor.id,...await parseQuest(ctx,tx,body,actor,null,organizations),created_at:now,updated_at:now,version:1};await insertObject(tx,'quests',item);await audit(tx,actor.id,'quest.create',item.id,{city_id:item.city_id});return {item:publicQuest(item)};});
  }
  const editQuest=path.match(/^\/api\/manage\/quests\/([a-zA-Z0-9-]+)$/);
  if(editQuest&&method==='PATCH'){
   required(user,MANAGER_ROLES);const body=await readBody();
   return withActor(async(tx,actor)=>{
    const {quest,organizations}=await lockQuestWithOrganizations(tx,editQuest[1],body);questPermission(ctx,actor,quest);
    const values=await parseQuest(ctx,tx,{...quest,...body},actor,quest,organizations),item=await updateVersioned(tx,'quests',quest,body,values);
    if(values.status!=='published'||values.verification!=='token')await tx.run('UPDATE reward_tokens SET revoked_at=$1 WHERE quest_id=$2 AND redeemed_at IS NULL AND revoked_at IS NULL',[Date.now(),quest.id]);
    await audit(tx,actor.id,'quest.update',quest.id,{city_id:quest.city_id,version:item.version});return {item:publicQuest(item)};
   });
  }
  const tokens=path.match(/^\/api\/manage\/quests\/([a-zA-Z0-9-]+)\/tokens$/);
  if(tokens&&method==='POST'){
   required(user,MANAGER_ROLES);await throttle(`tokens:${user.id}`,20);const body=await readBody();
   const count=number(body.count??1,'Число кодов',1,20),minutes=number(body.expires_in_minutes??60,'Срок кода, мин',5,1440);
   if(!Number.isInteger(count)||!Number.isInteger(minutes))fail('Укажите целое число');
   return withActor(async(tx,actor)=>{
    const {quest,organizations}=await lockQuestWithOrganizations(tx,tokens[1]);questPermission(ctx,actor,quest);
    if(actor.role==='business')orgPermission(ctx,actor,organizations.find(org=>org.id===quest.organization_id));
    if(quest.verification!=='token'||quest.status!=='published')fail('Одноразовые коды доступны опубликованному квесту с этой проверкой');
    const now=Date.now();if(quest.ends_at!==null&&quest.ends_at<=now)fail('Квест завершён');const expires=Math.min(now+minutes*60000,quest.ends_at??Infinity),issued=[];
    for(let i=0;i<count;i++){
     const code=randomBytes(12).toString('hex').toUpperCase(),tid=id();
     await tx.run('INSERT INTO reward_tokens(id,quest_id,issuer_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)',[tid,quest.id,actor.id,hash(code),now,expires]);issued.push({id:tid,code,expires_at:expires});
    }
    await audit(tx,actor.id,'reward.tokens_issued',quest.id,{city_id:quest.city_id,count});return {tokens:issued};
   });
  }
  if(path==='/api/manage/osm'&&method==='POST'){
   required(user,['admin']);const data=await readBody(),normalized=normalizeOsm(data,cityId);
   return withActor(async(tx,actor)=>{required(actor,['admin']);return importOsmPostgres(ctx,tx,actor,data,cityId,normalized);});
  }
  if(path==='/api/manage/osm-query'&&method==='GET'){
   required(user,['admin']);return withActor(async(_tx,actor)=>{required(actor,['admin']);return {query:osmQuery(cityId)};});
  }
  const access=path.match(/^\/api\/manage\/users\/([a-zA-Z0-9-]+)$/);
  if(access&&method==='PATCH'){
   required(user,['admin']);const body=await readBody(),target=access[1];if(target===user.id)fail('Нельзя менять свою роль');
   if(body.disabled!==undefined&&typeof body.disabled!=='boolean')fail('Некорректный статус аккаунта');
   return withActor(async(tx,actor,rows)=>{
    required(actor,['admin']);const old=rows.find(row=>row.id===target);if(!old)fail('Пользователь не найден',404);
    const next=choice(body.role||old.role,['player','business','admin'],'роль'),disabled=body.disabled===undefined?old.disabled:body.disabled?1:0;
    if(next==='admin'&&old.role!=='admin'&&old.password_login_enabled===0)fail('Сначала оператор должен настроить локальный пароль и MFA или привязать SSO к существующему администратору',409);
    await tx.run('UPDATE users SET role=$1,disabled=$2 WHERE id=$3',[next,disabled,target]);
    await tx.run('DELETE FROM sessions WHERE user_id=$1',[target]);await tx.run('DELETE FROM login_challenges WHERE user_id=$1',[target]);
    await tx.run('DELETE FROM mobile_auth_codes WHERE user_id=$1',[target]);
    await audit(tx,actor.id,'user.access_updated',target,{role:next,disabled:!!disabled});return {ok:true};
   },[target]);
  }
  return undefined;
 };
}
