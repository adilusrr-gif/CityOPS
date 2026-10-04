import {fail,choice} from '../domain.mjs';
import {publicQuest,QUEST_DIFFICULTIES,HIDDEN_QUEST_TITLE} from '../quest-metadata.mjs';
import {EXPLORATION_GRID} from '../product-policy.mjs';
import {all,get,createFeatureStore} from './store.mjs';

const PUBLIC_ORG_FIELDS='id,name,category,lng,lat,address,description,status,source,osm_id,created_at,city_id,version,updated_at';
function integer(value,fallback,max){if(value===null||value===undefined||value==='')return fallback;if(!/^\d+$/.test(String(value))||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>max)fail(`Размер страницы должен быть от 1 до ${max}`);return Number(value);}
function offset(value){if(value===null||value==='')return 0;if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)>100000)fail('Некорректное смещение страницы');return Number(value);}
function encode(value){return Buffer.from(JSON.stringify(value)).toString('base64url');}
function cursor(value,scope,keys){if(!value)return null;try{if(value.length>2048||!/^[A-Za-z0-9_-]+$/.test(value))throw Error();const parsed=JSON.parse(Buffer.from(value,'base64url'));if(!Array.isArray(parsed)||parsed.length!==keys.length+1||parsed[0]!==scope)throw Error();if(keys.some((type,index)=>typeof parsed[index+1]!==type||(type==='number'&&!Number.isSafeInteger(parsed[index+1]))||(type==='string'&&parsed[index+1].length>250)))throw Error();return parsed.slice(1);}catch{fail('Некорректный курсор страницы');}}
function bindings(initial=[]){const params=[...initial];return {params,bind:value=>{params.push(value);return '$'+params.length;}};}
function searchTerm(value){const term=(value||'').trim();if(term.length>100)fail('Поиск ограничен 100 символами');return term;}
function search(filters,columns,term,bind,dialect){if(!term)return;const placeholder=bind('%'+term.replace(/[\\%_]/g,'\\$&')+'%');filters.push('('+columns.map(column=>dialect==='postgres'?`${column} ILIKE ${placeholder} ESCAPE '\\'`:`cityquest_lower(${column}) LIKE cityquest_lower(${placeholder}) ESCAPE '\\'`).join(' OR ')+')');}
function page(rows,limit,scope,toCursor){const more=rows.length>limit,items=rows.slice(0,limit);return {items,limit,next_cursor:more?encode([scope,...toCursor(items.at(-1))]):null};}
function after(filters,current,fields,bind){if(!current)return;const [time,id]=current,t=bind(time),i=bind(id);filters.push(`(${fields[0]},${fields[1]})<(${t},${i})`);}
function bbox(raw){if(!raw)return null;const values=raw.split(',').map(Number);if(values.length!==4||values.some(n=>!Number.isFinite(n))||values[0]>values[2]||values[1]>values[3]||values[0]<-180||values[2]>180||values[1]<-90||values[3]>90)fail('Некорректная область');return values;}
function* count(table,filters,params){return Number((yield get(`SELECT count(*) AS n FROM ${table} WHERE ${filters.join(' AND ')}`,params)).n);}

function* organizations({url,cityId},dialect){
 const {params,bind}=bindings([cityId]),filters=["status='approved'",'city_id=$1'],term=searchTerm(url.searchParams.get('q')),bounds=bbox(url.searchParams.get('bbox'));
 search(filters,['name','address','category'],term,bind,dialect);if(bounds)filters.push(`lng BETWEEN ${bind(bounds[0])} AND ${bind(bounds[2])} AND lat BETWEEN ${bind(bounds[1])} AND ${bind(bounds[3])}`);
 const scope=JSON.stringify(['organizations',cityId,term,bounds]),current=cursor(url.searchParams.get('cursor'),scope,['string','string']),limit=integer(url.searchParams.get('limit'),500,500),start=offset(url.searchParams.get('offset'));
 if(current&&start)fail('Нельзя совмещать курсор и смещение');
 const total=yield* count('organizations',filters,params);
 if(current){const n=bind(current[0]),i=bind(current[1]);filters.push(`(name,id)>(${n},${i})`);}
 const rows=yield all(`SELECT ${PUBLIC_ORG_FIELDS} FROM organizations WHERE ${filters.join(' AND ')} ORDER BY name,id LIMIT ${bind(limit+1)} OFFSET ${bind(start)}`,params);
 return {...page(rows,limit,scope,row=>[row.name,row.id]),total,offset:start,city_id:cityId};
}
function* quests({url,cityId,user},dialect){
 const {params,bind}=bindings([cityId,user?.id||'']),filters=["q.status='published'",'q.city_id=$1','(q.assigned_to IS NULL OR q.assigned_to=$2)'],term=searchTerm(url.searchParams.get('q')),scopeFilter=url.searchParams.get('scope'),difficulty=url.searchParams.get('difficulty');
 if(scopeFilter&&!['public','personal'].includes(scopeFilter))fail('Неизвестный тип квестов');if(scopeFilter)filters.push(`q.scope=${bind(scopeFilter)}`);
 if(difficulty!==null){choice(difficulty,QUEST_DIFFICULTIES,'сложность квеста');filters.push(`q.difficulty=${bind(difficulty)}`);}
 const countParams=[...params],now=Date.now(),position=user?.id?yield get('SELECT lng,lat,accuracy,updated_at,city_id FROM positions WHERE user_id=$1',[user.id]):null;
 // Membership remains indexed; no full exploration history is downloaded.
 const lngCell=bind(EXPLORATION_GRID.lngCellSize),latCell=bind(EXPLORATION_GRID.latCellSize);
 const grid=dialect==='postgres'?`(floor(q.lng/${lngCell})::bigint::text || ':' || floor(q.lat/${latCell})::bigint::text)`:`(CAST(CAST(q.lng/${lngCell} AS INTEGER) AS TEXT) || ':' || CAST(CAST(q.lat/${latCell} AS INTEGER) AS TEXT))`;
 const completed='EXISTS(SELECT 1 FROM completions c WHERE c.user_id=$2 AND c.quest_id=q.id)',explored=`EXISTS(SELECT 1 FROM explored e WHERE e.user_id=$2 AND e.city_id=q.city_id AND e.cell=${grid})`;
 let nearby='false';
 if(position&&position.city_id===cityId&&Number.isFinite(position.lng)&&Number.isFinite(position.lat)&&Number.isFinite(position.accuracy)&&position.accuracy>=0&&position.accuracy<=100&&position.updated_at<=now&&now-position.updated_at<=90000){
  const lng=bind(position.lng),lat=bind(position.lat),accuracy=bind(Math.min(position.accuracy,30)),radians=Math.PI/180;
  // Exact haversine radius comparison, algebraically equivalent to domain.distance.
  // Use the SAME predicate for projection and title search/counts. An approximate
  // bounding box or post-filtering would leak hidden titles or break pagination.
  const dlat=`sin((q.lat-${lat})*${radians/2})`,dlng=`sin((q.lng-${lng})*${radians/2})`,h=`(${dlat}*${dlat}+cos(q.lat*${radians})*cos(${lat}*${radians})*${dlng}*${dlng})`,threshold=`sin((q.radius+${accuracy})/12742000.0)`;
  const bounded=dialect==='postgres'?`LEAST(1.0,GREATEST(0.0,${h}))`:`min(1.0,max(0.0,${h}))`;
  nearby=`(${bounded}<=${threshold}*${threshold})`;
 }
 const revealed=`(q.scope='public' OR ${completed} OR ${explored} OR ${nearby})`;
 if(term)search(filters,[`CASE WHEN ${revealed} THEN q.title ELSE ${bind(HIDDEN_QUEST_TITLE)} END`],term,bind,dialect);
 const scope=JSON.stringify(['quests',cityId,user?.id||'',term,scopeFilter,difficulty]),current=cursor(url.searchParams.get('cursor'),scope,['string','number','string']),limit=integer(url.searchParams.get('limit'),100,200),total=yield* count('quests q',filters,term?params:countParams);
 if(current){const s=bind(current[0]),t=bind(current[1]),i=bind(current[2]);filters.push(`(q.scope,q.created_at,q.id)<(${s},${t},${i})`);}
 const rows=yield all(`SELECT q.*,(SELECT count(*) FROM completions c WHERE c.quest_id=q.id) AS completions,${completed} AS completed,${revealed} AS unlocked FROM quests q WHERE ${filters.join(' AND ')} ORDER BY q.scope DESC,q.created_at DESC,q.id DESC LIMIT ${bind(limit+1)}`,params);
 const result=page(rows,limit,scope,row=>[row.scope,Number(row.created_at),row.id]);
 result.items=result.items.map(row=>{const unlocked=!!row.unlocked,quest=publicQuest(row,{hideObjectives:!unlocked});return {...quest,completed:!!quest.completed,unlocked,completions:quest.scope==='public'?Number(quest.completions):undefined,available:(quest.starts_at===null||quest.starts_at<=now)&&(quest.ends_at===null||quest.ends_at>now)&&(quest.max_completions===null||Number(quest.completions)<quest.max_completions)};});return {...result,total,city_id:cityId};
}

function* cellsPage({url,cityId,user},dialect,{viewport=false}={}){
 const {params,bind}=bindings([user.id,cityId]),filters=['user_id=$1','city_id=$2'],bounds=viewport?bbox(url.searchParams.get('bbox')):null,limit=integer(url.searchParams.get('limit'),500,1000);
 if(viewport&&!bounds)fail('Укажите область карты');
 if(bounds){
  // Imported historical rows may predate the numeric cell format. Parse only
  // validated bounded strings; malformed legacy records never abort a viewport.
  const valid=dialect==='postgres'?"cell ~ '^[0-9]{1,6}:[0-9]{1,6}$'":"cell NOT GLOB '*[^0-9:]*' AND instr(cell,':') BETWEEN 2 AND 7 AND length(cell)-instr(cell,':') BETWEEN 1 AND 6 AND instr(substr(cell,instr(cell,':')+1),':')=0";
  const x=dialect==='postgres'?"CAST(split_part(cell,':',1) AS INTEGER)":"CAST(substr(cell,1,instr(cell,':')-1) AS INTEGER)",y=dialect==='postgres'?"CAST(split_part(cell,':',2) AS INTEGER)":"CAST(substr(cell,instr(cell,':')+1) AS INTEGER)";
  filters.push(`CASE WHEN ${valid} THEN (${x} BETWEEN ${bind(Math.floor(bounds[0]/EXPLORATION_GRID.lngCellSize))} AND ${bind(Math.floor(bounds[2]/EXPLORATION_GRID.lngCellSize))} AND ${y} BETWEEN ${bind(Math.floor(bounds[1]/EXPLORATION_GRID.latCellSize))} AND ${bind(Math.floor(bounds[3]/EXPLORATION_GRID.latCellSize))}) ELSE false END`);
 }
 const scope=JSON.stringify(['cells',cityId,user.id,bounds]),current=cursor(url.searchParams.get(viewport?'cursor':'cells_cursor'),scope,['string']),total=yield* count('explored',filters,params);
 if(current)filters.push(`cell>${bind(current[0])}`);
 const result=page(yield all(`SELECT cell FROM explored WHERE ${filters.join(' AND ')} ORDER BY cell LIMIT ${bind(limit+1)}`,params),limit,scope,row=>[row.cell]);
 return {city_id:cityId,cells:result.items.map(row=>row.cell),total,limit,next_cursor:result.next_cursor};
}
function* progress(ctx,dialect,current){
 const cells=yield* cellsPage(ctx,dialect),{url,cityId,user}=ctx,{params,bind}=bindings([user.id,cityId]),filters=['c.user_id=$1','q.city_id=$2'],scope=JSON.stringify(['completed',cityId,user.id]),cur=cursor(url.searchParams.get('completed_cursor'),scope,['number','string']),total=yield* count('completions c JOIN quests q ON q.id=c.quest_id',filters,params);
 after(filters,cur,['c.created_at','c.quest_id'],bind);
 const result=page(yield all(`SELECT c.quest_id,c.xp,c.created_at FROM completions c JOIN quests q ON q.id=c.quest_id WHERE ${filters.join(' AND ')} ORDER BY c.created_at DESC,c.quest_id DESC LIMIT ${bind(cells.limit+1)}`,params),cells.limit,scope,row=>[Number(row.created_at),row.quest_id]);
 return {city_id:cityId,user:ctx.auth.publicUser(current),cells:cells.cells,completed:result.items,cells_total:cells.total,completed_total:total,cells_next_cursor:cells.next_cursor,completed_next_cursor:result.next_cursor,limit:cells.limit};
}
function* managementPage(ctx,dialect,kind,actor,{standalone=false}={}){
 const {url,cityId}=ctx,admin=actor.role==='admin',limit=integer(url.searchParams.get('limit'),standalone?20:50,100),{params,bind}=bindings(),filters=[],term=searchTerm(url.searchParams.get(standalone?'q':kind==='organizations'?'search':kind==='quests'?'quest_search':'user_search'));
 let table,fields,columns;
 if(kind==='users'){if(!admin)fail('Недостаточно прав',403);table='users';fields='id,name,email,role,xp,disabled,created_at';columns=['id','name','email'];filters.push('1=1');}
 else{table=kind;fields=kind==='quests'?'q.*,(SELECT count(*) FROM completions c WHERE c.quest_id=q.id) AS completions':'*';if(kind==='quests')table+=' q';filters.push(`city_id=${bind(cityId)}`);if(!admin)filters.push(`owner_id=${bind(actor.id)}`);columns=kind==='quests'?['title','status']:['name','address','status'];}
 search(filters,columns,term,bind,dialect);
 const scope=JSON.stringify(['manage',kind,cityId,actor.id,term]),cur=cursor(url.searchParams.get(standalone?'cursor':kind+'_cursor'),scope,['number','string']),total=yield* count(table,filters,params);
 after(filters,cur,[kind==='quests'?'q.created_at':'created_at',kind==='quests'?'q.id':'id'],bind);
 const result=page(yield all(`SELECT ${fields} FROM ${table} WHERE ${filters.join(' AND ')} ORDER BY ${kind==='quests'?'q.':''}created_at DESC,${kind==='quests'?'q.':''}id DESC LIMIT ${bind(limit+1)}`,params),limit,scope,row=>[Number(row.created_at),row.id]);
 if(kind==='quests')result.items=result.items.map(row=>publicQuest(row));return {...result,total};
}
function* management(ctx,dialect,actor){
 const organizations=yield* managementPage(ctx,dialect,'organizations',actor),quests=yield* managementPage(ctx,dialect,'quests',actor),users=actor.role==='admin'?yield* managementPage(ctx,dialect,'users',actor):{items:[],total:0,next_cursor:null,limit:50};
 return {city_id:ctx.cityId,organizations:organizations.items,organizationTotal:organizations.total,quests:quests.items,users:users.items,audit:actor.role==='admin'?yield all('SELECT action,target,created_at,metadata,request_id FROM audit ORDER BY id DESC LIMIT 50'):[],pagination:Object.fromEntries(Object.entries({organizations,quests,users}).map(([key,{items,...meta}])=>[key,meta]))};
}
function* rewards(ctx,dialect,actor){
 const {url,cityId}=ctx,{params,bind}=bindings([cityId]),filters=['q.city_id=$1',"q.verification='token'"],scope=JSON.stringify(['rewards',cityId,actor.id]),cur=cursor(url.searchParams.get('cursor'),scope,['number','string']),limit=integer(url.searchParams.get('limit'),50,100);
 if(actor.role!=='admin')filters.push(`q.owner_id=${bind(actor.id)}`);const total=yield* count('quests q',filters,params);after(filters,cur,['q.created_at','q.id'],bind);
 const rows=yield all(`SELECT q.id,q.title,q.created_at,(SELECT count(*) FROM reward_tokens t WHERE t.quest_id=q.id) AS issued,(SELECT count(*) FROM reward_tokens t WHERE t.quest_id=q.id AND t.redeemed_at IS NOT NULL) AS redeemed FROM quests q WHERE ${filters.join(' AND ')} ORDER BY q.created_at DESC,q.id DESC LIMIT ${bind(limit+1)}`,params);return {...page(rows,limit,scope,row=>[Number(row.created_at),row.id]),total};
}
function* redemptions(ctx,actor,questId){
 const quest=yield get('SELECT id,owner_id FROM quests WHERE id=$1',[questId]);if(!quest)fail('Квест не найден',404);if(actor.role!=='admin'&&quest.owner_id!==actor.id)fail('Это чужой квест',403);
 const {url}=ctx,{params,bind}=bindings([questId]),filters=['t.quest_id=$1'],scope=JSON.stringify(['redemptions',questId,actor.id]),cur=cursor(url.searchParams.get('cursor'),scope,['number','string']),limit=integer(url.searchParams.get('limit'),50,100),total=yield* count('reward_tokens t',filters,params);after(filters,cur,['t.created_at','t.id'],bind);
 const rows=yield all(`SELECT t.id,t.created_at,t.expires_at,t.redeemed_at,t.revoked_at,u.name AS user_name FROM reward_tokens t LEFT JOIN users u ON u.id=t.redeemed_by WHERE ${filters.join(' AND ')} ORDER BY t.created_at DESC,t.id DESC LIMIT ${bind(limit+1)}`,params),result=page(rows,limit,scope,row=>[Number(row.created_at),row.id]),now=Date.now();
 result.items=result.items.map(token=>({...token,state:token.redeemed_at?'redeemed':token.revoked_at?'revoked':token.expires_at<=now?'expired':'active'}));return {...result,total};
}
export function createListRoutes({store}){
 return async ctx=>{
  const path=ctx.path||ctx.url.pathname,method=ctx.method||ctx.req?.method;if(method!=='GET')return undefined;
  if(path==='/api/organizations')return store.read(function*(){return yield* organizations(ctx,store.dialect);});
  if(path==='/api/quests')return store.read(function*(){return yield* quests(ctx,store.dialect);});
  const redemption=path.match(/^\/api\/manage\/quests\/([a-zA-Z0-9-]+)\/redemptions$/);
  if(redemption||['/api/progress','/api/explored','/api/manage','/api/manage/users','/api/manage/rewards'].includes(path)){
   const roles=path.startsWith('/api/manage')?['admin','business']:undefined;ctx.required(ctx.user,roles);
   return store.transaction(function*(){const actor=yield* store.requireActor(ctx.user,roles);ctx.required(actor,roles);if(redemption)return yield* redemptions(ctx,actor,redemption[1]);if(path==='/api/progress')return yield* progress(ctx,store.dialect,actor);if(path==='/api/explored')return yield* cellsPage(ctx,store.dialect,{viewport:true});if(path==='/api/manage/users')return yield* managementPage(ctx,store.dialect,'users',actor,{standalone:true});if(path==='/api/manage/rewards')return yield* rewards(ctx,store.dialect,actor);return yield* management(ctx,store.dialect,actor);});
  }
  return undefined;
 };
}
// Enterprise route factories are also exercised independently in integration
// tests. Both factories delegate their read models to this identical code.
export function enterpriseListRoutes(ctx){return createListRoutes({store:createFeatureStore({db:ctx.db,cfg:ctx.cfg,dialect:'postgres'})})(ctx);}
