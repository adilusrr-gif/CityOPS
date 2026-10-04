import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as ui from '../public/quest-ui.js';
import {questHarness,deferred,quest} from './helpers/quest-ui-harness.mjs';

const rgb=hex=>hex.match(/[a-f\d]{2}/gi).map(value=>parseInt(value,16)/255);
const luminance=values=>values.map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
const contrast=(a,b)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
test('difficulty badges and filter controls have distinct words, symbols, and AA text contrast',async()=>{
 const css=await readFile(new URL('../public/styles.css',import.meta.url),'utf8'),symbols=new Set();
 for(const [key,info] of Object.entries(ui.DIFFICULTIES)){
  const badge=ui.difficultyBadge(key);assert(badge.includes(info.label));assert(badge.includes(info.symbol));assert(badge.includes('aria-hidden="true"'));symbols.add(info.symbol);
  assert(css.includes(`--difficulty:${info.color}`));
  // Selected filters: solid #263346. Badge: #0d1521 at 40% over card.
  for(const background of [rgb('263346'),rgb('162130').map((c,i)=>.4*rgb('0d1521')[i]+.6*c)])assert(contrast(rgb(info.color),background)>=4.5,`${key} contrast`);
 }
 assert.equal(symbols.size,3);assert.match(ui.difficultyBadge(null),/Сложность не оценена/);assert.match(ui.difficultyBadge('toString'),/difficulty-unknown/);
 const controls=ui.questControls({search:'"<test>',scope:'personal',difficulty:'hard'});
 assert.match(controls,/fieldset.*legend/s);assert.match(controls,/data-difficulty="hard" aria-pressed="true"/);assert.match(controls,/type="button"/);assert(!controls.includes('value=""<test>'));
});
test('planning never invents time from XP and the optional checklist cannot contain server fields or hidden secrets',()=>{
 assert.match(ui.questPlanning(quest('unknown',null,{estimated_minutes:null,xp:999})),/Время на месте не оценено/);
 const q=quest('secret','hard',{objective_steps:[{id:'look',text:'<script>secret</script>'}],hint:'Hidden hint'});
 const html=ui.questObjectives(q);assert.match(html,/не подтверждают прибытие/);assert.match(html,/не дают дополнительный XP/);assert.match(html,/&lt;script&gt;secret/);assert(!html.includes('<script>'));assert(!html.includes('name='));assert.equal(ui.questObjectives(q,{secret:true}),'');
 const checked=ui.questObjectives(q,{checked:new Set(['look'])});assert.match(checked,/checked/);assert.match(checked,/Отмечено для себя: 1 из 1/);
});
test('all map markers use shared difficulty colors while locked secrets and completion remain distinct',()=>{
 for(const value of Object.keys(ui.DIFFICULTIES)){const p=ui.questMapProperties(quest('q',value));assert.equal(p.color,ui.DIFFICULTIES[value].color);assert.equal(p.symbol,ui.DIFFICULTIES[value].symbol);}
 assert.equal(ui.questMapProperties(quest('q','hard',{locked:true})).symbol,'?');assert.equal(ui.questMapProperties(quest('q','hard',{completed:true})).symbol,'✓');
});
test('latest difficulty request wins and both API totals and cursors belong to that filter',async()=>{
 const requests=[],h=await questHarness(path=>{const gate=deferred();requests.push({path,...gate});return gate.promise;});
 const old=h.click({difficulty:'easy'}); // Current all -> easy.
 const newer=h.click({difficulty:'hard'});
 assert.match(requests[0].path,/difficulty=easy/);assert.match(requests[1].path,/difficulty=hard/);
 requests[1].resolve({items:[quest('hard','hard')],total:41,next_cursor:'hard-page'});await newer;
 requests[0].resolve({items:[quest('old','easy')],total:999,next_cursor:'old-page'});await old;
 assert.equal(h.S.questTotal,41);assert.equal(h.S.questCursor,'hard-page');assert.equal(h.S.quests[0].id,'hard');assert(!h.node('quest-list').innerHTML.includes('История old'));
 const more=h.loadMoreQuests();assert.match(requests[2].path,/difficulty=hard.*cursor=hard-page/);
 requests[2].resolve({items:[quest('hard2','hard')],total:41,next_cursor:null});await more;assert.equal(h.S.quests.length,2);
 const before=requests.length;await h.click({difficulty:'hard'});assert.equal(requests.length,before,'selected filter is not a reset action');
});
test('changing a filter during pagination discards the old page and keeps the newer cursor',async()=>{
 const requests=[],h=await questHarness(path=>{const gate=deferred();requests.push({path,...gate});return gate.promise;});
 const initial=h.searchQuests();requests[0].resolve({items:[quest('first')],next_cursor:'all-page',total:30});await initial;
 const more=h.loadMoreQuests(),filter=h.click({difficulty:'moderate'});
 requests[2].resolve({items:[quest('medium','moderate')],next_cursor:'medium-page',total:25});await filter;
 requests[1].resolve({items:[quest('stale')],next_cursor:null,total:30});await more;
 assert.equal(h.S.quests.length,1);assert.equal(h.S.quests[0].id,'medium');assert.equal(h.S.questCursor,'medium-page');
});
test('search on quest page keeps the same controls and combined filters through navigation',async()=>{
 const calls=[],h=await questHarness(async path=>{calls.push(path);return {items:[],total:0};});
 h.S.tab='quests';h.S.filter='personal';h.S.difficulty='hard';h.renderQuestPage();const markup=h.node('page-view').innerHTML;
 h.listeners.input[0]({target:{id:'quest-page-search',value:'Площадь'}});
 assert.equal(h.node('page-view').innerHTML,markup,'typing must not rebuild or blur the input');
 await h.searchQuests();const parsed=new URL(calls.at(-1),'https://fixture.test');assert.equal(parsed.searchParams.get('scope'),'personal');assert.equal(parsed.searchParams.get('difficulty'),'hard');assert.equal(parsed.searchParams.get('q'),'Площадь');
 await h.navigate('world');await h.navigate('quests');assert.equal(h.S.search,'Площадь');assert.equal(h.S.difficulty,'hard');assert.equal(h.S.filter,'personal');
});
test('navigation during search restarts the pending query and cannot install the old view response',async()=>{
 const requests=[],h=await questHarness(path=>{const gate=deferred();requests.push({path,...gate});return gate.promise;});h.S.difficulty='moderate';
 const search=h.searchQuests(),navigation=h.navigate('quests');assert.equal(requests.length,2);
 requests[1].resolve({items:[quest('current','moderate')],total:1});await navigation;
 requests[0].resolve({items:[quest('stale','moderate')],total:1});await search;assert.equal(h.S.quests[0].id,'current');
});
test('periodic progress refresh retains loaded pagination and respects a later filter',async()=>{
 const requests=[],h=await questHarness(path=>{const gate=deferred();requests.push({path,...gate});return gate.promise;});
 const first=h.searchQuests();requests[0].resolve({items:Array.from({length:24},(_,i)=>quest(String(i))),total:50,next_cursor:'second'});await first;
 const more=h.loadMoreQuests();requests[1].resolve({items:Array.from({length:24},(_,i)=>quest(String(i+24))),total:50,next_cursor:'third'});await more;
 const refresh=h.refreshQuestProgress();requests[2].resolve({items:Array.from({length:24},(_,i)=>quest(String(i),i?'easy':'hard')),total:50,next_cursor:'second'});await new Promise(r=>setImmediate(r));
 requests[3].resolve({items:Array.from({length:24},(_,i)=>quest(String(i+24))),total:50,next_cursor:'third'});await refresh;
 assert.equal(h.S.quests.length,48);assert.equal(h.S.questCursor,'third');
 const stale=h.refreshQuestProgress();h.S.difficulty='hard';h.beginQuestSearch();requests[4].resolve({items:[],total:0});await stale;assert.equal(h.S.quests.length,48);assert.equal(h.S.questCursor,null);
});
test('failed filtering has an explicit keyboard-operable retry and never displays an unrelated old list',async()=>{
 let fail=false;const h=await questHarness(async()=>{if(fail)throw new Error('offline fixture');return {items:[quest('easy')],total:1};});await h.searchQuests();fail=true;
 await h.click({difficulty:'hard'});assert.match(h.node('quest-list').innerHTML,/data-action="quests-retry"/);assert(!h.node('quest-list').innerHTML.includes('История easy'));
});
test('locked quest UI hides title, description, rationale, objectives and hint but keeps safety visible',async()=>{
 const h=await questHarness();h.S.quests=[quest('secret','hard',{scope:'personal',unlocked:false,title:'HIDDEN TITLE',description:'HIDDEN DESCRIPTION',difficulty_reason:'HIDDEN REASON',objective_steps:[{id:'s',text:'HIDDEN STEP'}],hint:'HIDDEN HINT'})];h.showQuest('secret');
 const html=h.node('dialog-body').innerHTML;assert(!html.includes('HIDDEN'));assert.match(html,/общедоступным пешеходным/);assert.match(html,/гололёд/);assert.match(html,/точно к центру не нужно/);assert(!html.includes('data-objective='));
});
test('self-guided checks make no request, persist only in memory and stay outside the arrival form',async()=>{
 const calls=[],h=await questHarness(async(...args)=>{calls.push(args);return {};});h.S.quests=[quest('q')];h.S.user={id:'a'};h.showQuest('q');
 const html=h.node('dialog-body').innerHTML;assert(html.indexOf('data-objective=')<html.indexOf('<form data-form="complete"'));
 await h.change({dataset:{objective:'look',objectiveQuest:'q'},checked:true});assert.equal(calls.length,0);h.showQuest('q');assert.match(h.node('dialog-body').innerHTML,/Отмечено для себя: 1 из 1/);
 h.S.user={id:'b'};h.showQuest('q');assert.match(h.node('dialog-body').innerHTML,/Отмечено для себя: 0 из 1/);
});
test('next route checkpoint is the first unvisited sequential stop and unavailable routes give no next-step instruction',()=>{
 const route={status:'open',playable:true,checkpoints:[{title:'First'},{title:'Second'},{title:'Third'}],progress:{visited:1}};assert.equal(ui.nextCheckpoint(route).point.title,'Second');assert.match(ui.routeGuidance(route),/2 из 3/);
 for(const visited of [3,-1,1.5])assert.equal(ui.nextCheckpoint({...route,progress:{visited}}),null);
 for(const status of ['draft','closed'])assert(!ui.routeGuidance({...route,status}).includes('Second'));
 assert(!ui.routeGuidance({...route,playable:false}).includes('Second'));assert.equal(ui.isRoutePlayable({...route,playable:undefined}),false);
});
test('shipped adventure handler focuses the next stop and does not offer or submit a closed route',async()=>{
 for(const status of ['open','closed','draft']){
  const handlers={},nodes=new Map(),calls=[],flies=[];let html='';const node=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',addEventListener(){}});return nodes.get(id);};
  const route={id:'r',version:2,title:'Route',description:'Description',status,playable:status==='open',difficulty:'moderate',kind:'urban',checkpoints:[{title:'First',lng:1,lat:1,radius:100},{title:'Second',lng:2,lat:2,radius:100}],progress:{visited:1}};
  const S={city:'almaty',epoch:0,view:0,tab:'adventures',user:{id:'a'},config:{}};
  const context=vm.createContext({...ui,document:{addEventListener:(type,fn)=>handlers[type]=fn},URL,setMapData(){},flyTo:(...args)=>flies.push(args)});
  let source=(await readFile(new URL('../public/adventures.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export function createAdventureFeatures','function createAdventureFeatures');vm.runInContext(source+'\nglobalThis.create=createAdventureFeatures;',context);
  const features=context.create({S,$:node,api:async(...args)=>{calls.push(args);return {items:[route]};},esc:String,cityPath:x=>x,pageHead:()=>'',modal:value=>html=value,closeModal(){},toast(){},navigate:async tab=>{S.tab=tab;S.view++;}});await features.render();
  const click=async(action,extra={})=>{const el={dataset:{adventure:action,id:'r',...extra},isConnected:true};el.closest=()=>el;await handlers.click({target:el});};
  await click('route');assert(html.includes('difficulty-moderate'));
  if(status==='open'){assert(html.includes('data-index="1"'));assert(html.includes('aria-current="step"'));await click('route-map');assert.deepEqual(flies,[[2,2]]);}
  else{assert(!html.includes('data-adventure="checkin"'));assert(!html.includes('data-adventure="route-map"'));await click('route-map');await click('checkin',{index:'1',version:'2'});assert.equal(flies.length,0);assert.equal(calls.length,1);}
 }
});

test('progress response started before load-more cannot shrink newly loaded pages',async()=>{
 const requests=[],h=await questHarness(path=>{const gate=deferred();requests.push({path,...gate});return gate.promise;});
 const first=h.searchQuests();requests[0].resolve({items:[quest('first')],total:3,next_cursor:'second'});await first;
 const progress=h.refreshQuestProgress(),more=h.loadMoreQuests();requests[2].resolve({items:[quest('second')],total:3,next_cursor:'third'});await more;
 requests[1].resolve({items:[quest('old-first')],total:3,next_cursor:'second'});await progress;
 assert.equal(h.S.quests.length,2);assert.equal(h.S.quests[1].id,'second');assert.equal(h.S.questCursor,'third');
});
test('server-normalized search results are not locally filtered against hidden titles or untrimmed text',async()=>{
 const h=await questHarness(async()=>({items:[quest('matches')],total:1}));h.S.search='  история  ';await h.searchQuests();assert.match(h.node('quest-list').innerHTML,/История matches/);assert.equal(h.node('quest-count').textContent,'Показано 1 из 1');
});
test('PWA caches the shared helper and mobile build bundles it without a duplicate module',async()=>{
 const sw=await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),build=await readFile(new URL('../scripts/build-mobile.mjs',import.meta.url),'utf8');
 assert.match(sw,/'\/quest-ui.js'/);assert.match(build,/'quest-ui.js'/);assert.match(build,/bundle:true/);
});
