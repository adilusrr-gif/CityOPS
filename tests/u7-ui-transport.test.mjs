import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApiClient} from '../public/platform.js';

// Older supported WebViews have AbortController but lack the newer static methods.
test('u7 JSON and private-image transport work without AbortSignal.any and timeout',async()=>{
 const descriptors=['any','timeout'].map(key=>[key,Object.getOwnPropertyDescriptor(AbortSignal,key)]);
 try{
  for(const [key] of descriptors)Object.defineProperty(AbortSignal,key,{value:undefined,configurable:true});
  const controller=new AbortController();let seen;
  const api=createApiClient({fetchImpl:async(url,options)=>{seen=options.signal;return url.endsWith('/image')?new Response(new Uint8Array([255,216,255,217]),{headers:{'Content-Type':'image/jpeg'}}):new Response('{"user":null}');}});
  assert.deepEqual(await api.request('/me','GET',undefined,{signal:controller.signal}),{user:null});
  assert.equal((await api.photoBlob('/photos/test/image',{signal:controller.signal})).size,4);
  assert.equal(seen.aborted,false);
 }finally{for(const [key,descriptor] of descriptors)Object.defineProperty(AbortSignal,key,descriptor);}
});

test('u7 transport removes abort listeners and deadline timer after success or failure',async()=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
 let timers=0,cleared=0;
 globalThis.setTimeout=(...args)=>{timers++;return originalSet(...args);};globalThis.clearTimeout=id=>{cleared++;originalClear(id);};
 try{for(const image of [false,true])for(const failure of [false,true]){
  const controller=new AbortController(),signal=controller.signal;let added=0,removed=0;
  const add=signal.addEventListener.bind(signal),remove=signal.removeEventListener.bind(signal);
  signal.addEventListener=(...args)=>{added++;return add(...args);};signal.removeEventListener=(...args)=>{removed++;return remove(...args);};
  const api=createApiClient({fetchImpl:async()=>{if(failure)throw new Error('offline');return image?new Response(new Uint8Array([255,216]),{headers:{'Content-Type':'image/jpeg'}}):new Response('{}');}});
  const result=image?api.photoBlob('/photos/test/image',{signal}):api.request('/me','GET',undefined,{signal});
  if(failure)await assert.rejects(result);else await result;
  assert.equal(added,1);assert.equal(removed,1);
 }
 assert.equal(timers,4);assert.equal(cleared,4);
 }finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('u7 request deadline stays connected through response-body consumption',async()=>{
 for(const image of [false,true]){
  const controller=new AbortController();let bodyStarted;
  const entered=new Promise(resolve=>bodyStarted=resolve);
  const api=createApiClient({fetchImpl:async(url,{signal})=>image?new Response(new ReadableStream({start(stream){signal.addEventListener('abort',()=>stream.error(signal.reason),{once:true});bodyStarted();}}),{headers:{'Content-Type':'image/jpeg'}}):{ok:true,json:()=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});bodyStarted();})}});
  const request=image?api.photoBlob('/photos/test/image',{signal:controller.signal}):api.request('/me','GET',undefined,{signal:controller.signal});
  await entered;controller.abort();await assert.rejects(request);
 }
});

test('u7 clearing a native session cancels a pending SSO deep link before exchange',async()=>{
 const platform=await import('../public/platform.js?u7-cancel-before-exchange');
 const fetch=globalThis.fetch,bridge=globalThis.CityQuestNative;let calls=0,releaseClose;
 globalThis.fetch=async()=>{calls++;return new Response('{}');};
 globalThis.CityQuestNative={isNative:true,apiBase:'https://api.example.test',browser:{open:async()=>{},close:()=>new Promise(resolve=>releaseClose=resolve)}};
 try{
  await platform.startSso();const pending=platform.handleDeepLink('cityquest://auth/callback?code='+'c'.repeat(64));
  platform.clearSession();releaseClose();assert.equal(await pending,true);assert.equal(calls,0);
 }finally{platform.clearSession();globalThis.fetch=fetch;if(bridge)globalThis.CityQuestNative=bridge;else delete globalThis.CityQuestNative;}
});

test('u7 clearing a native session cannot install an in-flight SSO exchange bearer',async()=>{
 const platform=await import('../public/platform.js?u7-cancel-during-exchange');
 const fetch=globalThis.fetch,bridge=globalThis.CityQuestNative;let resolveExchange,entered,authorization;
 const started=new Promise(resolve=>entered=resolve);
 globalThis.fetch=async(url,options)=>{if(url.endsWith('/exchange')){entered();return new Promise(resolve=>resolveExchange=resolve);}authorization=options.headers.Authorization;return new Response('{}');};
 globalThis.CityQuestNative={isNative:true,apiBase:'https://api.example.test',browser:{open:async()=>{},close:async()=>{}}};
 try{
  await platform.startSso();const pending=platform.handleDeepLink('cityquest://auth/callback?code='+'d'.repeat(64));await started;
  platform.clearSession();resolveExchange(new Response('{"accessToken":"old-sso-token","user":{"id":"old"}}'));await pending;await platform.apiRequest('/me');assert.equal(authorization,undefined);
 }finally{platform.clearSession();globalThis.fetch=fetch;if(bridge)globalThis.CityQuestNative=bridge;else delete globalThis.CityQuestNative;}
});

test('u7 active PWA serves HTML and modules from its own release while a newer shell waits',async()=>{
 const {readFile}=await import('node:fs/promises'),{default:vm}=await import('node:vm');
 const source=await readFile(new URL('../public/sw.js',import.meta.url),'utf8');
 const listeners={},opened=[],reads=[];let network=0;
 vm.runInNewContext(source,{URL,Set,self:{location:{origin:'https://app.example.test'},addEventListener:(event,handler)=>listeners[event]=handler},
  caches:{open:async name=>{opened.push(name);return {match:async path=>{reads.push(typeof path==='string'?path:new URL(path.url).pathname);return {release:'installed',path};}};},match:async()=>({release:'waiting-newer'})},
  fetch:async()=>{network++;return {release:'network-newer'};}});
 for(const [path,mode] of [['/','navigate'],['/index.html','navigate'],['/app.js','cors']]){
  let result;listeners.fetch({request:{url:'https://app.example.test'+path,method:'GET',mode},respondWith:value=>{result=value;}});
  assert.equal((await result).release,'installed');
 }
 assert.equal(network,0);assert.equal(new Set(opened).size,1);assert.deepEqual(reads,['/index.html','/index.html','/app.js']);
});
