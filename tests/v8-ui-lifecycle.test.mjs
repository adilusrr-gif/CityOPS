import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// Execute the shipped UI event handlers, without a network, WebGL or a synthetic
// copy of their logic. API/local-file barriers make account and dialog races exact.
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function harness(api){
 const listeners={},nodes=new Map(),timers=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',open:true,isConnected:true,hidden:false,value:'',dataset:{},classList:{toggle(){}},setAttribute(){},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},contains(){return false;}});return nodes.get(id);};
 const context=vm.createContext({apiRequest:api,createCompanionFeatures:()=>({invalidate(){}}),createAdventureFeatures:()=>({invalidate(){}}),createTeamPresence:()=>({reset(){},clear(){},update(){}}),document:{getElementById:node,querySelectorAll:()=>[],addEventListener:(type,fn)=>(listeners[type]??=[]).push(fn)},localStorage:{getItem(){}},setTimeout:(fn)=>{timers.push(fn);return timers.length;},clearTimeout(){},setInterval(){},URL,URLSearchParams,AbortController,FormData:class {constructor(form){this.values=Object.entries(form.data||{});}*[Symbol.iterator](){yield* this.values;}},setMapData(){},isNative:()=>false,resizeMap(){},window:{addEventListener(){}},performance,cancelSso(){},clearSession(){}});
 return {context,listeners,node};
}
async function app(api){
 const h=harness(api);let source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 source=source.replace(/^import .*;\n/gm,'').replace('export const api=','const api=');source=source.slice(0,source.indexOf('const webMfaChallenge='));
 vm.runInContext(source+'\nglobalThis.ui={S,viewStamp,setupMfa};',h.context);h.S=h.context.ui.S;
 h.S.user={id:'account-a',name:'A',role:'admin',xp:0,level:1};return h;
}
function form(kind,dialog=true){return {dataset:{form:kind},data:{code:'123456',password:'test-secret'},isConnected:true,querySelector:()=>({disabled:false}),closest:()=>dialog?{}:null};}
function submit(h,f){return h.listeners.submit[0]({target:f,preventDefault(){}});}

test('late MFA recovery codes never reopen after an account switch or closed form',async()=>{
 for(const invalidate of ['account','closed']){
  const gate=deferred(),h=await app(path=>path==='/auth/mfa/enable'?gate.promise:Promise.resolve({sessions:[]})),f=form('mfa-enable');
  const pending=submit(h,f);
  if(invalidate==='account'){h.S.user={...h.S.user,id:'account-b'};h.S.epoch++;}else{f.isConnected=false;h.node('dialog').open=false;}
  gate.resolve({recoveryCodes:['PRIVATE-RECOVERY-A']});await pending;
  assert(!h.node('dialog-body').innerHTML.includes('PRIVATE-RECOVERY-A'));
 }
});

test('MFA recovery codes are still shown to the current connected form',async()=>{
 const h=await app(path=>Promise.resolve(path==='/auth/mfa/enable'?{recoveryCodes:['CURRENT-RECOVERY']}:{sessions:[]}));
 await submit(h,form('mfa-enable'));assert(h.node('dialog-body').innerHTML.includes('CURRENT-RECOVERY'));
});

test('late MFA setup secret is discarded after closing its password form',async()=>{
 const gate=deferred(),h=await app(()=>gate.promise),f=form('mfa-setup');const pending=submit(h,f);
 f.isConnected=false;h.node('dialog').open=false;gate.resolve({secret:'PRIVATE-TOTP-SECRET',otpauthUri:'otpauth://example'});await pending;
 assert(!h.node('dialog-body').innerHTML.includes('PRIVATE-TOTP-SECRET'));
});

test('late MFA disable completion does not close a newer dialog',async()=>{
 const gate=deferred(),h=await app(()=>gate.promise),f=form('mfa-disable');const pending=submit(h,f);
 f.isConnected=false;h.node('dialog-body').innerHTML='New dialog';gate.resolve({ok:true});await pending;
 assert.equal(h.node('dialog').open,true);assert.equal(h.node('dialog-body').innerHTML,'New dialog');
});

test('deferred OSM file read cannot import into a different city, account, or page',async()=>{
 for(const change of ['city','account','page','removed']){
  const gate=deferred(),calls=[],h=await app((...args)=>{calls.push(args);return Promise.resolve({});});
  const input={id:'osm-file',dataset:{},files:[{size:5,text:()=>gate.promise}],disabled:false,isConnected:true};
  const pending=h.listeners.change[0]({target:input});
  if(change==='city'){h.S.city='astana';h.S.epoch++;}else if(change==='account')h.S.user={...h.S.user,id:'account-b'};else if(change==='page')h.S.view++;else input.isConnected=false;
  gate.resolve('{"elements":[]}');await pending;assert.equal(calls.length,0,change);
 }
});

test('OSM import retains captured city while still active and does not navigate after completion on another page',async()=>{
 const gate=deferred(),calls=[],h=await app((...args)=>{calls.push(args);return gate.promise;});
 const input={id:'osm-file',dataset:{},files:[{size:5,text:async()=>'{"elements":[]}'}],isConnected:true};
 const pending=h.listeners.change[0]({target:input});await new Promise(r=>setImmediate(r));
 assert.equal(calls.length,1);assert.equal(calls[0][0],'/manage/osm?city=almaty');assert.equal(calls[0][2].city_id,'almaty');
 h.S.view++;gate.resolve({inserted:1,updated:0,skipped:0});await pending;assert.equal(calls.length,1);
});

test('closing the photo form during local decoding prevents an unexpected upload',async()=>{
 const gate=deferred(),calls=[],h=harness((...args)=>{calls.push(args);return Promise.resolve({});});let bitmapClosed=false;
 h.context.createImageBitmap=()=>gate.promise;
 h.context.FileReader=class {readAsDataURL(){this.result='data:image/jpeg;base64,/9j/2Q==';this.onload();}};
 h.context.document.createElement=()=>({getContext:()=>({fillRect(){},drawImage(){}}),toBlob:cb=>cb({size:4})});
 let source=await readFile(new URL('../public/adventures.js',import.meta.url),'utf8');source=source.replace(/^import .*;\n/gm,'').replace('export function createAdventureFeatures','function createAdventureFeatures');
 vm.runInContext(source+'\nglobalThis.makeAdventure=createAdventureFeatures;',h.context);
 const S={city:'almaty',epoch:1,user:{id:'a'},tab:'adventures',config:{}};
 h.context.makeAdventure({S,api:h.context.apiRequest,esc:String,$:h.node,pageHead:()=>'',formError(){},field:()=>'',cityPath:x=>x});
 const f={dataset:{adventureForm:'upload'},data:{image:{type:'image/jpeg',size:4},rightsAttested:'on',placeOnlyAttested:'on',title:'test'},isConnected:true,querySelector:()=>({disabled:false,isConnected:true})};
 const pending=h.listeners.submit[0]({target:f,preventDefault(){}});f.isConnected=false;h.node('dialog').open=false;
 gate.resolve({width:20,height:20,close(){bitmapClosed=true;}});await pending;
 assert.equal(calls.length,0);assert.equal(bitmapClosed,true);
});

async function commerce({role='business',api}={}){
 const h=harness(api),S={city:'almaty',user:{id:'owner',role},epoch:1,tab:'commerce',config:{}};
 let source=await readFile(new URL('../public/companion.js',import.meta.url),'utf8');source=source.replace(/^import .*;\n/gm,'').replace('export function createCompanionFeatures','function createCompanionFeatures');
 vm.runInContext(source+'\nglobalThis.makeCompanion=createCompanionFeatures;',h.context);
 h.features=h.context.makeCompanion({S,api,esc:String,$:h.node,pageHead:(_title,copy)=>copy,cityPath:path=>path+(path.includes('?')?'&':'?')+'city='+S.city,toast(){}});h.S=S;
 h.click=action=>{const el={dataset:{feature:action},isConnected:true};el.closest=()=>el;return h.listeners.click[0]({target:el});};return h;
}
function commerceApi(calls,{fail}={}){return async path=>{
 calls.push(path);
 if(path==='/billing/catalog')return {plans:[]};if(path==='/billing/me')return {};
 if(path.startsWith('/admin/billing'))return {orders:[],total:201,next_cursor:'billing-next'};
 if(path.startsWith('/manage?'))return {organizations:[],quests:[]};
 if(path.includes('/promotions')){if(path.includes('cursor=')&&fail?.())throw new Error('Connection lost');return {items:[],total:201,next_cursor:path.includes('cursor=')?null:'page-two'};}
 throw new Error('Unexpected '+path);
};}

test('business and admin promotion pages support cursor navigation and reset on city/account invalidation',async()=>{
 for(const role of ['business','admin']){
  const calls=[],h=await commerce({role,api:commerceApi(calls)});await h.features.render('commerce');assert(h.node('page-view').innerHTML.includes('Всего карточек: 201'));
  await h.click('promotions-next');assert(calls.some(path=>path.includes('/promotions?limit=50&cursor=page-two&city=almaty')));
  await h.click('promotions-prev');assert.equal(calls.filter(path=>path.includes('/promotions')).at(-1),`/${role==='admin'?'admin':'manage'}/promotions?limit=50&city=almaty`);
  await h.click('promotions-next');h.features.invalidate();h.S.city='astana';h.S.epoch++;await h.features.render('commerce');assert.equal(calls.filter(path=>path.includes('/promotions')).at(-1),`/${role==='admin'?'admin':'manage'}/promotions?limit=50&city=astana`);
 }
});

test('failed commerce page keeps the previous usable controls and can be retried',async()=>{
 let fail=true;const calls=[],h=await commerce({api:commerceApi(calls,{fail:()=>fail})});await h.features.render('commerce');const html=h.node('page-view').innerHTML;
 await h.click('promotions-next');assert.equal(h.node('page-view').innerHTML,html);fail=false;await h.click('promotions-next');assert(h.node('page-view').innerHTML.includes('promotions-prev'));assert(!h.node('page-view').innerHTML.includes('promotions-next'));
});
