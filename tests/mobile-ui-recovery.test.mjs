import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
async function app({api}={}){
 const listeners={},nodes=new Map(),calls=[],state={watchStarts:0,mapStarts:0,cleared:0};
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',open:false,isConnected:true,hidden:false,dataset:{},classList:{toggle(){}},setAttribute(){},addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];},close(){this.open=false;},showModal(){this.open=true;}});return nodes.get(id);};
 const defaults=async path=>path==='/me'?{user:null}:path.startsWith('/quests?')?{items:[],total:0}:path.startsWith('/config?')?{city:{id:'almaty',name:'Алматы',bounds:[[76,43],[77,44]]}}:{enabled:false};
 const context=vm.createContext({apiRequest:async(...args)=>{calls.push(args);return (api||defaults)(...args);},createCompanionFeatures:()=>({invalidate(){}}),createAdventureFeatures:()=>({invalidate(){},loadMap(){}}),createTeamPresence:()=>({reset(){},clear(){state.cleared++;},update(){}}),watchLocation:()=>{state.watchStarts++;},initMap:async()=>{state.mapStarts++;},setMapData(){},resizeMap(){},isNative:()=>true,clearSession(){},cancelSso(){},document:{hidden:false,activeElement:null,getElementById:node,querySelectorAll:()=>[],addEventListener(){}},navigator:{onLine:true},window:{addEventListener:(name,callback)=>listeners[name]=callback},localStorage:{getItem(){}},setTimeout:()=>1,clearTimeout(){},setInterval(){},URL,URLSearchParams,AbortController,performance});
 let source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export const api=','const api=');source=source.slice(0,source.indexOf('const webMfaChallenge='));
 vm.runInContext(source+'\nglobalThis.ui={S,recoverConnection,startGPS};',context);
 return {context,node,calls,state,listeners,...context.ui};
}

test('returning from native photo selection preserves the open form and never starts GPS',async()=>{
 const h=await app();h.node('dialog').open=true;h.node('dialog-body').innerHTML='photo selection and draft';
 await h.recoverConnection({automatic:true});assert.equal(h.calls.length,0);assert.equal(h.state.watchStarts,0);assert.equal(h.node('dialog-body').innerHTML,'photo selection and draft');assert.equal(h.node('connection-retry').hidden,false);
});
test('foreground recovery preserves focused text and non-map screens until explicit refresh',async()=>{
 for(const mode of ['typing','profile']){
  const h=await app();if(mode==='typing')h.context.document.activeElement={matches:()=>true};else h.S.tab='profile';
  await h.recoverConnection({automatic:true});assert.equal(h.calls.length,0);assert.equal(h.state.watchStarts,0);assert.equal(h.node('connection-status').hidden,false);
 }
});
test('reconnect refresh reads data, initializes the map once and does not replay writes',async()=>{
 const h=await app();await h.recoverConnection({automatic:true});assert.equal(h.node('connection-status').hidden,true);assert.equal(h.state.mapStarts,1);
 await h.recoverConnection({automatic:true});assert.equal(h.state.mapStarts,1);assert.equal(h.state.watchStarts,0);
 assert(h.calls.length>=4);assert(h.calls.every(([,method])=>method===undefined||method==='GET'));
});
test('offline stops GPS locally and shows persistent retry without server writes',async()=>{
 const h=await app();let stopped=0;h.S.user={id:'account'};h.S.watch={stop:async()=>stopped++};h.context.navigator.onLine=false;
 h.listeners.offline();await flush();assert.equal(stopped,1);assert.equal(h.S.watch,null);assert.equal(h.calls.length,0);assert.equal(h.node('connection-status').hidden,false);
 await h.recoverConnection({automatic:true});assert.equal(h.calls.length,0);assert.equal(h.state.watchStarts,0);
});
test('failed reconnect remains retryable and concurrent triggers share one recovery',async()=>{
 let reject,requests=0;const h=await app({api:async path=>{requests++;if(path==='/me')return new Promise((_,no)=>reject=no);return {};}});
 const first=h.recoverConnection({automatic:true}),second=h.recoverConnection({automatic:true});assert.equal(requests,4);
 reject(new Error('network down'));await Promise.all([first,second]);assert.equal(h.node('connection-status').hidden,false);assert.equal(h.node('connection-retry').hidden,false);assert.match(h.node('connection-message').textContent,/network down/);
});


test('starting GPS while offline explains the requirement without requesting a permission or position',async()=>{
 const h=await app();h.context.navigator.onLine=false;await h.startGPS();assert.equal(h.state.watchStarts,0);assert.equal(h.calls.length,0);assert.match(h.node('toast').textContent,/интернет/);
});
test('navigation during recovery does not leave a permanent loading message',async()=>{
 let finish;const h=await app({api:async path=>path==='/me'?new Promise(resolve=>finish=()=>resolve({user:null})):path.startsWith('/quests?')?{items:[]}:path.startsWith('/config?')?{city:{id:'almaty',bounds:[[76,43],[77,44]]}}:{}});
 const pending=h.recoverConnection({automatic:true});h.S.view++;finish();await pending;assert.notEqual(h.node('connection-message').textContent,'Обновляем соединение…');assert.equal(h.node('connection-retry').hidden,false);
});
