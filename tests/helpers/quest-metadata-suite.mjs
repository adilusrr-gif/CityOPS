import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {hash,cell,distance} from '../../src/domain.mjs';
import {createFeatureStore,run,get} from '../../src/features/store.mjs';

export const METADATA={difficulty:'moderate',difficulty_reason:'Несколько самостоятельных наблюдений и сравнение деталей.',estimated_minutes:12,objective_steps:[{id:'look',text:'Найдите две заметные детали с открытой дорожки.'},{id:'compare',text:'Сравните форму деталей и придумайте короткое название.'}],hint:'Если деталь не видна, выберите другую с безопасной дорожки.'};
export async function questMetadataSuite(t,{db,dialect,server}){
 const store=createFeatureStore({db,dialect}),now=Date.now(),tokens={},userIds={};
 await store.transaction(function*(){for(const role of ['admin','player','other']){const uid='metadata-'+role,token=randomBytes(32).toString('hex');userIds[role]=uid;tokens[role]='aq_session='+token;yield run('INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$1,$3,$4,$5)',[uid,uid+'@example.test','unused',role==='admin'?'admin':'player',now]);yield run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$3,$4,$5,$5,0)',[hash(token),uid+'-session',uid,now+3600000,now]);}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const request=async(path,{role='admin',method='GET',body}={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{method,headers:{...(role?{cookie:tokens[role]}:{}),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:response.status,body:await response.json()};};
 const good=result=>{assert.equal(result.status,200,JSON.stringify(result.body));return result.body;};
 const payload={city_id:'almaty',title:'Metadatafixture observation',description:'Сравните городские детали, оставаясь на открытой дорожке.',lng:76.95,lat:43.25,radius:100,xp:130,scope:'public',verification:'checkin',status:'published',...METADATA};
 let quest;
 await t.test('create, public read, manage read and partial edit preserve identical structured metadata',async()=>{
  quest=good(await request('/manage/quests',{method:'POST',body:payload})).item;
  for(const key of Object.keys(METADATA))assert.deepEqual(quest[key],METADATA[key]);
  assert.equal(Object.hasOwn(quest,'objective_steps_json'),false);assert.equal(Object.hasOwn(quest,'code_hash'),false);
  for(const item of [good(await request('/quests?q=Metadatafixture',{role:null})).items[0],good(await request('/manage?quest_search=Metadatafixture')).quests[0]])for(const key of Object.keys(METADATA))assert.deepEqual(item[key],METADATA[key]);
  quest=good(await request('/manage/quests/'+quest.id,{method:'PATCH',body:{version:quest.version,title:'Metadatafixture edited'}})).item;
  for(const key of Object.keys(METADATA))assert.deepEqual(quest[key],METADATA[key]);
  assert.equal(quest.xp,130);assert.equal(quest.version,2);
  assert.equal((await request('/manage/quests/'+quest.id,{method:'PATCH',body:{version:1,hint:'Stale hint'}})).status,409);
 });
 await t.test('strict validation rejects ambiguous levels, estimates, malformed steps and excessive text atomically',async()=>{
  const invalid=[{difficulty:'medium'},{difficulty:'hard',difficulty_reason:''},{difficulty:null,difficulty_reason:METADATA.difficulty_reason},{estimated_minutes:0},{estimated_minutes:241},{estimated_minutes:2.5},{estimated_minutes:'12'},{objective_steps:null},{objective_steps:['plain text']},{objective_steps:[{id:'A B',text:'Invalid id'}]},{objective_steps:[{id:'same',text:'One step'},{id:'same',text:'Another step'}]},{objective_steps:[{id:'step',text:'Valid text',complete:true}]},{objective_steps:Array.from({length:9},(_,i)=>({id:'step-'+i,text:'Too many steps'}))},{hint:'x'.repeat(501)},{difficulty_reason:'x'.repeat(501)}];
  for(const fields of invalid){const response=await request('/manage/quests/'+quest.id,{method:'PATCH',body:{version:quest.version,...fields}});assert.equal(response.status,400,JSON.stringify({fields,response}));}
  const current=good(await request('/manage?quest_search=Metadatafixture')).quests[0];assert.equal(current.version,quest.version);assert.deepEqual(current.objective_steps,METADATA.objective_steps);
 });
 await t.test('difficulty pages bind filters, enforce totals and cannot replay another filter cursor',async()=>{
  for(const difficulty of ['easy','easy','hard'])good(await request('/manage/quests',{method:'POST',body:{...payload,difficulty}}));
  let path='/quests?q=Metadatafixture&difficulty=easy&limit=1',ids=[],first;
  do{const page=good(await request(path,{role:null}));assert.equal(page.total,2);assert.ok(page.items.every(q=>q.difficulty==='easy'));ids.push(...page.items.map(q=>q.id));first??=page.next_cursor;path=page.next_cursor?'/quests?q=Metadatafixture&difficulty=easy&limit=1&cursor='+page.next_cursor:null;}while(path);
  assert.equal(new Set(ids).size,2);
  for(const difficulty of ['moderate','hard',''])assert.equal((await request('/quests?q=Metadatafixture&difficulty='+difficulty+'&cursor='+first,{role:null})).status,400);
  assert.equal((await request('/quests?q=Metadatafixture&cursor='+first,{role:null})).status,400);
  for(const value of ['medium','unknown','EASY','easy,hard'])assert.equal((await request('/quests?difficulty='+value,{role:null})).status,400);
 });
 await t.test('unclassified legacy-compatible create stays unknown and explicit clearing round-trips',async()=>{
  const plain={...payload,title:'Legacyfixture unknown'};for(const key of Object.keys(METADATA))delete plain[key];
  const item=good(await request('/manage/quests',{method:'POST',body:plain})).item;
  assert.equal(item.difficulty,null);assert.equal(item.estimated_minutes,null);assert.equal(item.difficulty_reason,'');assert.deepEqual(item.objective_steps,[]);assert.equal(item.hint,'');
  const cleared=good(await request('/manage/quests/'+quest.id,{method:'PATCH',body:{version:quest.version,difficulty:null,difficulty_reason:'',estimated_minutes:null,objective_steps:[],hint:''}})).item;assert.equal(cleared.difficulty,null);assert.equal(cleared.estimated_minutes,null);assert.deepEqual(cleared.objective_steps,[]);quest=cleared;
 });
 await t.test('locked and assigned personal objectives stay hidden; exploration reveals only eligible detail',async()=>{
  const personal=good(await request('/manage/quests',{method:'POST',body:{...payload,title:'Privatefixture hidden',scope:'personal',assigned_to:userIds.player}})).item;
  assert.equal(good(await request('/quests?q=Privatefixture',{role:null})).total,0);assert.equal(good(await request('/quests?q=Privatefixture',{role:'other'})).total,0);
  assert.equal(good(await request('/quests?q=Privatefixture',{role:'player'})).total,0);
  let item=good(await request('/quests?scope=personal',{role:'player'})).items.find(q=>q.id===personal.id);assert.equal(item.title,'Скрытая история');assert.equal(item.unlocked,false);assert.deepEqual(item.objective_steps,[]);assert.equal(item.description,'');assert.equal(item.hint,'');assert.equal(item.difficulty_reason,'');assert.equal(JSON.stringify(item).includes(METADATA.objective_steps[0].text),false);
  const masked=good(await request('/quests?scope=personal&q='+encodeURIComponent('Скрытая история'),{role:'player'}));assert.ok(masked.items.some(q=>q.id===personal.id));assert.ok(masked.items.every(q=>q.title==='Скрытая история'&&!q.unlocked));
  await store.transaction(function*(){yield run('INSERT INTO explored(user_id,cell,created_at,city_id) VALUES($1,$2,$3,$4)',[userIds.player,cell(payload.lng,payload.lat),now,'almaty']);});
  item=good(await request('/quests?q=Privatefixture',{role:'player'})).items[0];assert.equal(item.unlocked,true);assert.deepEqual(item.objective_steps,METADATA.objective_steps);assert.equal(item.hint,METADATA.hint);assert.equal(item.id,personal.id);
 });
 await t.test('fresh position in the accepted radius reveals a personal quest across grid boundaries without changing exploration',async()=>{
  const target={lng:76.9602,lat:43.25},near={lng:76.9596,lat:43.25};assert.notEqual(cell(target.lng,target.lat),cell(near.lng,near.lat));
  const personal=good(await request('/manage/quests',{method:'POST',body:{...payload,...target,title:'Nearbyfixture safe edge',scope:'personal'}})).item;
  const read=async()=>good(await request('/quests?scope=personal',{role:'player'})).items.find(q=>q.id===personal.id),searched=async()=>good(await request('/quests?q=Nearbyfixture',{role:'player'}));
  const setPosition=async(options={})=>store.transaction(function*(){yield run('INSERT INTO positions(user_id,lng,lat,accuracy,updated_at,city_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET lng=$2,lat=$3,accuracy=$4,updated_at=$5,city_id=$6',[userIds.player,options.lng??near.lng,options.lat??near.lat,options.accuracy??5,options.updatedAt??Date.now(),options.cityId??'almaty']);});
  assert.equal((await read()).unlocked,false);assert.equal((await searched()).total,0);await setPosition();assert.equal((await read()).unlocked,true);assert.equal((await searched()).total,1);assert.deepEqual((await read()).objective_steps,METADATA.objective_steps);
  // Check both sides of the check-in radius against the canonical JS distance,
  // including the 30m accuracy-tolerance cap, without relying on a bounding box.
  for(const accuracy of [0,5,30,80])for(const delta of [-0.01,0.01]){
   const meters=payload.radius+Math.min(accuracy,30)+delta,r=Math.PI/180,lng=target.lng-2*Math.asin(Math.sin(meters/12742000)/Math.cos(target.lat*r))/r;
   const expected=distance({lng,lat:target.lat},target)<=payload.radius+Math.min(accuracy,30);
   await setPosition({lng,lat:target.lat,accuracy});assert.equal((await read()).unlocked,expected,`radius parity: accuracy=${accuracy}, delta=${delta}`);assert.equal((await searched()).total,expected?1:0);
  }
  for(const options of [{updatedAt:Date.now()-91000},{updatedAt:Date.now()+60000},{cityId:'astana'},{accuracy:101}]){await setPosition(options);assert.equal((await read()).unlocked,false);assert.equal((await searched()).total,0);}
  await store.transaction(function*(){yield run('DELETE FROM positions WHERE user_id=$1',[userIds.player]);});
  assert.equal((await store.read(function*(){return yield get('SELECT count(*) AS n FROM explored WHERE user_id=$1 AND cell=$2',[userIds.player,cell(target.lng,target.lat)]);})).n,0);
 });
 await t.test('self-guided checklists cannot bypass GPS or multiply completion rewards',async()=>{
  const path='/quests/'+quest.id+'/complete',body={objective_steps:METADATA.objective_steps.map(s=>({...s,complete:true})),completed:true,xp:9999};
  assert.ok([400,409].includes((await request(path,{method:'POST',role:'player',body})).status));
  good(await request('/location',{method:'POST',role:'player',body:{lng:payload.lng,lat:payload.lat,accuracy:5,timestamp:Date.now()}}));
  assert.equal(good(await request(path,{method:'POST',role:'player',body})).xp,130);assert.equal(good(await request(path,{method:'POST',role:'player',body})).xp,0);
  assert.equal((await store.read(function*(){return yield get('SELECT xp FROM users WHERE id=$1',[userIds.player]);})).xp,130);
 });
}
