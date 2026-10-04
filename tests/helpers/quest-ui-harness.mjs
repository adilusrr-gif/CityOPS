import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as questUI from '../../public/quest-ui.js';

// The fixture runs shipped UI handlers with controllable API barriers. It does
// not recreate filter, paging, checklist or route-selection logic in the test.
export async function questHarness(api=async()=>({items:[],total:0})){
 const listeners={},nodes=new Map(),timers=new Map(),map=[],flies=[],toasts=[];let timerId=0;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{id,innerHTML:'',textContent:'',open:false,isConnected:true,hidden:false,value:'',dataset:{},attributes:{},classList:{toggle(){}},setAttribute(key,value){this.attributes[key]=value;},querySelector(){return null;},querySelectorAll(){return [];},addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},contains(){return false;}});return nodes.get(id);};
 const context=vm.createContext({...questUI,apiRequest:api,createCompanionFeatures:()=>({invalidate(){}}),createAdventureFeatures:()=>({invalidate(){},loadMap(){}}),createTeamPresence:()=>({reset(){},clear(){},update(){}}),document:{hidden:false,getElementById:node,querySelectorAll:()=>[],addEventListener:(type,fn)=>(listeners[type]??=[]).push(fn)},localStorage:{getItem(){}},navigator:{onLine:true},setTimeout:fn=>{const id=++timerId;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),setInterval(){},URL,URLSearchParams,AbortController,FormData:class{constructor(form){this.values=Object.entries(form.data||{});}*[Symbol.iterator](){yield* this.values;}},setMapData:data=>map.push(data),flyTo:(...args)=>flies.push(args),isNative:()=>false,resizeMap(){},window:{addEventListener(){}},performance,cancelSso(){},clearSession(){}});
 let source=await readFile(new URL('../../public/app.js',import.meta.url),'utf8');source=source.replace(/^import .*;\n/gm,'').replace('export const api=','const api=');source=source.slice(0,source.indexOf('const webMfaChallenge='));
 vm.runInContext(source+'\nglobalThis.ui={S,questPath,searchQuests,loadMoreQuests,refreshQuestProgress,refresh,renderQuestPage,navigate,showQuest,questCard,beginQuestSearch};',context);
 const ui=context.ui;ui.S.config={city:{id:'almaty',name:'Алматы',bounds:[[76,43],[77,44]]}};
 function element(dataset){const el={dataset,isConnected:true,disabled:false,classList:{contains:()=>false}};el.closest=()=>el;return el;}
 const click=dataset=>listeners.click[0]({target:element(dataset)});
 const change=input=>listeners.change[0]({target:{isConnected:true,...input}});
 return {...ui,context,listeners,node,map,flies,toasts,timers,click,change,element};
}
export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
export const quest=(id,difficulty='easy',extra={})=>({id,title:'История '+id,description:'Наблюдение в общедоступном месте',scope:'public',difficulty,difficulty_reason:'Небольшое наблюдение на месте.',estimated_minutes:7,objective_steps:[{id:'look',text:'Найди интересную деталь вокруг.'}],hint:'Выбирай то, что видно с дорожки.',verification:'checkin',goal:20,xp:100,lng:76.95,lat:43.25,radius:150,version:1,...extra});
