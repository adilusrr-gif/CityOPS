import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {createApiClient,watchLocation,handleDeepLink,startSso,apiRequest,clearSession} from '../public/platform.js';

test('native transport keeps bearer only inside client memory and clears on logout',async()=>{
 const requests=[];let response={accessToken:'session-secret',user:{id:'u'}};
 const fetchImpl=async(url,options)=>{requests.push({url,options});return {ok:true,status:200,json:async()=>({...response})};};
 const api=createApiClient({native:true,apiBase:'https://api.example.test',fetchImpl});
 const login=await api.request('/login','POST',{password:'not-persisted'});assert(!('accessToken' in login));
 await api.request('/me');assert.equal(requests[1].options.headers.Authorization,'Bearer session-secret');assert.equal(requests[1].options.credentials,'omit');assert.equal(requests[1].options.headers['X-CityQuest-Client'],'native');assert.equal(requests[1].options.redirect,'error');
 response={ok:true};await api.request('/logout','POST',{});await api.request('/me');assert.equal(requests.at(-1).options.headers.Authorization,undefined);
 const fresh=createApiClient({native:true,apiBase:'https://api.example.test',fetchImpl});await fresh.request('/me');assert.equal(requests.at(-1).options.headers.Authorization,undefined);
});
test('browser transport never emits native header or persists access token',async()=>{
 let request;const api=createApiClient({apiBase:'https://must-not-be-used.example',fetchImpl:async(url,options)=>{request={url,options};return {ok:true,json:async()=>({user:null})};}});await api.request('/me');assert.equal(request.url,'/api/me');assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.headers.Authorization,undefined);assert.equal(request.options.headers['X-CityQuest-Client'],undefined);
});
test('mobile transport rejects insecure or ambiguous API origins and does not retry mutations',async()=>{
 for(const apiBase of ['http://api.example','https://user:pass@api.example','https://api.example/path','https://api.example?x=1'])assert.throws(()=>createApiClient({native:true,apiBase}));
 let calls=0;const api=createApiClient({fetchImpl:async()=>{calls++;throw new Error('network');}});await assert.rejects(api.request('/quests/x/complete','POST',{}),/Нет соединения/);assert.equal(calls,1);
});
test('late native location watch creation is canceled after app backgrounding',async()=>{
 let resolveWatch,cleared=[],delivered=[];globalThis.CityQuestNative={isNative:true,geolocation:{requestPermissions:async()=>({location:'granted'}),watchPosition:async(options,cb)=>{cb({timestamp:1});return new Promise(resolve=>resolveWatch=resolve);},clearWatch:async({id})=>cleared.push(id)}};
 const watch=watchLocation(pos=>delivered.push(pos),assert.fail);await new Promise(resolve=>setImmediate(resolve));const stopped=watch.stop();resolveWatch('native-watch');await stopped;assert.deepEqual(cleared,['native-watch']);assert.equal(delivered.length,1);delete globalThis.CityQuestNative;
});
test('location permission pending at cancellation does not start a watch',async()=>{
 let resolvePermission,started=0;globalThis.CityQuestNative={isNative:true,geolocation:{requestPermissions:()=>new Promise(resolve=>resolvePermission=resolve),watchPosition:async()=>{started++;return 'id';},clearWatch:async()=>{}}};const watch=watchLocation(assert.fail,assert.fail);const stopped=watch.stop();resolvePermission({location:'granted'});await stopped;assert.equal(started,0);delete globalThis.CityQuestNative;
});
test('deep link validator ignores unrelated or malformed URLs without token exchange',async()=>{
 for(const raw of ['https://evil.test/auth/callback?code='+'a'.repeat(64),'cityquest://evil/callback?code='+'a'.repeat(64),'cityquest://auth/callback?code=bad','cityquest://user@auth/callback?code='+'a'.repeat(64)])assert.equal(await handleDeepLink(raw),false);
});
test('service worker only handles explicitly listed static GET assets, never API, auth, tiles or writes',async()=>{
 const listeners={};let responses=0;const self={location:{origin:'https://app.example'},addEventListener:(name,fn)=>listeners[name]=fn};
 vm.runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL,Set,caches:{open:async()=>({match:async()=>({})})},fetch:async()=>({})});
 for(const [path,method] of [['/api/me','GET'],['/api/auth/sso/callback?code=secret','GET'],['/api/location','POST'],['/index.html?code=secret','GET'],['https://tiles.openfreemap.org/planet','GET']])listeners.fetch({request:{url:path.startsWith('https:')?path:'https://app.example'+path,method},respondWith:()=>responses++});
 assert.equal(responses,0);listeners.fetch({request:{url:'https://app.example/styles.css',method:'GET'},respondWith:()=>responses++});assert.equal(responses,1);
});
test('mobile config has bundled webDir, TLS, no remote server.url and foreground permissions',async()=>{
 const config=JSON.parse(await readFile(new URL('../mobile/capacitor.config.json',import.meta.url)));assert.equal(config.webDir,'www');assert.equal(config.server.url,undefined);assert.equal(config.server.cleartext,false);assert.equal(config.android.allowMixedContent,false);assert.equal(config.android.webContentsDebuggingEnabled,false);
});

test('native SSO proves PKCE, consumes deep link once and keeps resulting bearer off the callback URL',async()=>{
 const originalFetch=globalThis.fetch;let opened,exchange,authorized,requests=0;
 globalThis.fetch=async(url,options)=>{requests++;if(url.endsWith('/exchange')){exchange=JSON.parse(options.body);return {ok:true,json:async()=>({user:{id:'u'},accessToken:'sso-secret'})};}authorized=options.headers.Authorization;return {ok:true,json:async()=>({user:{id:'u'}})};};
 globalThis.CityQuestNative={isNative:true,apiBase:'https://api.example.test',browser:{open:async({url})=>opened=url,close:async()=>{}}};
 try{await startSso();const start=new URL(opened);assert.equal(start.searchParams.get('platform'),'mobile');assert(!opened.includes('verifier'));const callback='cityquest://auth/callback?code='+'b'.repeat(64);assert(await handleDeepLink(callback));assert.equal(createHash('sha256').update(exchange.code_verifier).digest('base64url'),start.searchParams.get('code_challenge'));assert.equal(exchange.code,'b'.repeat(64));await apiRequest('/me');assert.equal(authorized,'Bearer sso-secret');const before=requests;await handleDeepLink(callback);assert.equal(requests,before);}
 finally{clearSession();globalThis.fetch=originalFetch;delete globalThis.CityQuestNative;}
});
test('native 401 clears bearer before next request',async()=>{
 let call=0,last;const api=createApiClient({native:true,apiBase:'https://api.example.test',fetchImpl:async(url,options)=>{call++;last=options;if(call===1)return {ok:true,json:async()=>({accessToken:'expired-secret'})};if(call===2)return {ok:false,status:401,json:async()=>({error:'expired'})};return {ok:true,json:async()=>({user:null})};}});await api.request('/login','POST',{});await assert.rejects(api.request('/me'),{status:401});await api.request('/me');assert.equal(last.headers.Authorization,undefined);
});

test('late chat rejection and logout from an old account preserve the newer native session',async()=>{
 for(const path of ['/pet/chat','/logout']){
  let release,observed;
  const api=createApiClient({native:true,apiBase:'https://api.example.test',fetchImpl:async(url,options)=>{
   if(url.endsWith('/login'))return {ok:true,json:async()=>({accessToken:JSON.parse(options.body).account})};
   if(url.endsWith(path))return new Promise(resolve=>{release=()=>resolve(path==='/pet/chat'?{ok:false,status:401,json:async()=>({error:'Old session revoked'})}:{ok:true,json:async()=>({ok:true})});});
   observed=options.headers.Authorization;return {ok:true,json:async()=>({user:{id:'new-account'}})};
  }});
  await api.request('/login','POST',{account:'old-session'});
  const pending=api.request(path,'POST',{});
  await api.request('/login','POST',{account:'new-session'});
  release();
  if(path==='/pet/chat')await assert.rejects(pending,{status:401});else await pending;
  await api.request('/me');assert.equal(observed,'Bearer new-session');
 }
});

test('photo transport sends native bearer privately and browser cookie without caching',async()=>{
 for(const native of [false,true]){
  const requests=[],jpeg=new Uint8Array([255,216,255,217]);
  const api=createApiClient({native,apiBase:'https://api.example.test',fetchImpl:async(url,options)=>{
   requests.push({url,options});
   if(url.endsWith('/login'))return new Response(JSON.stringify({accessToken:'private-photo-session'}),{headers:{'Content-Type':'application/json'}});
   return new Response(jpeg,{headers:{'Content-Type':'image/jpeg','Content-Length':String(jpeg.length)}});
  }});
  await api.request('/login','POST',{});const photo=await api.photoBlob('/api/photos/photo-123/image');
  assert.equal(photo.type,'image/jpeg');assert.deepEqual(new Uint8Array(await photo.arrayBuffer()),jpeg);
  const {url,options}=requests.at(-1);assert.equal(url,(native?'https://api.example.test':'')+'/api/photos/photo-123/image');
  assert.equal(options.headers.Authorization,native?'Bearer private-photo-session':undefined);
  assert.equal(options.headers['X-CityQuest-Client'],native?'native':undefined);
  assert.equal(options.credentials,native?'omit':'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.redirect,'error');
  for(const bad of ['https://evil.example/photo','//evil.example/photo','/photos/../image','/photos/a/image?token=x','/photos/a%2fb/image'])await assert.rejects(api.photoBlob(bad),/Некорректный путь/);
  assert.equal(requests.length,2);
 }
});

test('photo transport rejects non-JPEG, empty and oversized images even without Content-Length',async()=>{
 for(const [body,headers,error] of [
  ['<svg/>',{'Content-Type':'image/svg+xml'},/Неизвестный формат/],
  [new Uint8Array(),{'Content-Type':'image/jpeg'},/Пустая/],
  [new Uint8Array(2),{'Content-Type':'image/jpeg','Content-Length':'524289'},/слишком большая/],
  [new Uint8Array(524289),{'Content-Type':'image/jpeg'},/слишком большая/]
 ]){
  const api=createApiClient({fetchImpl:async()=>new Response(body,{headers})});
  await assert.rejects(api.photoBlob('/photos/p/image'),error);
 }
});

test('late private photo rejection preserves the newer native session',async()=>{
 let release,observed;
 const api=createApiClient({native:true,apiBase:'https://api.example.test',fetchImpl:async(url,options)=>{
  if(url.endsWith('/login'))return new Response(JSON.stringify({accessToken:JSON.parse(options.body).account}));
  if(url.endsWith('/image'))return new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({error:'expired'}),{status:401}));});
  observed=options.headers.Authorization;return new Response(JSON.stringify({user:{id:'new'}}));
 }});
 await api.request('/login','POST',{account:'old'});const pending=api.photoBlob('/photos/p/image');
 await api.request('/login','POST',{account:'new'});release();await assert.rejects(pending,{status:401});
 await api.request('/me');assert.equal(observed,'Bearer new');
});

test('newer native login and explicit session clearing invalidate late token responses',async()=>{
 for(const clear of [false,true,'logout']){
  let release,observed;const api=createApiClient({native:true,apiBase:'https://api.example.test',fetchImpl:async(url,options)=>{
   if(url.endsWith('/login')){const account=JSON.parse(options.body).account;if(account==='old')return new Promise(resolve=>{release=()=>resolve(new Response(JSON.stringify({accessToken:'old'})));});return new Response(JSON.stringify({accessToken:account}));}
   observed=options.headers.Authorization;return new Response('{}');
  }});
  const old=api.request('/login','POST',{account:'old'});if(clear==='logout')await api.request('/logout','POST',{});else if(clear)api.clear();else await api.request('/login','POST',{account:'new'});release();await assert.rejects(old,{status:409});await api.request('/me');assert.equal(observed,clear?undefined:'Bearer new');
 }
});

test('viewport and private photo requests support cancellation without retries or translated errors',async()=>{
 for(const binary of [false,true]){let calls=0;const controller=new AbortController(),api=createApiClient({fetchImpl:async(url,options)=>{calls++;return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}});
 const request=binary?api.photoBlob('/photos/a/image',{signal:controller.signal}):api.request('/organizations','GET',undefined,{signal:controller.signal});controller.abort();await assert.rejects(request,{name:'AbortError'});assert.equal(calls,1);
 }
});

test('native GPS denial, approximate-only permission and retry use actionable Russian errors',async()=>{
 let requests=0,started=0,errors=[];globalThis.CityQuestNative={isNative:true,geolocation:{requestPermissions:async()=>++requests===1?{location:'denied',coarseLocation:'granted'}:{location:'granted'},watchPosition:async()=>{started++;return 'gps';},clearWatch:async()=>{}}};
 try{
  const first=watchLocation(assert.fail,error=>errors.push(error));await new Promise(resolve=>setImmediate(resolve));await first.stop();
  assert.equal(started,0);assert.equal(errors[0].code,1);assert.match(errors[0].message,/точную геолокацию/);
  const retry=watchLocation(assert.fail,assert.fail);await new Promise(resolve=>setImmediate(resolve));await retry.stop();assert.equal(started,1);
 }finally{delete globalThis.CityQuestNative;}
});

test('native GPS service and timeout failures are localized consistently',async()=>{
 const {locationError}=await import('../public/platform.js');
 for(const [code,expected,message] of [['OS-PLUG-GLOC-0007',2,/выключена/],['OS-PLUG-GLOC-0008',1,/ограничен/],['OS-PLUG-GLOC-0010',3,/вовремя/],['OS-PLUG-GLOC-0017',2,/интернет/],[1,1,/Разрешите/],[3,3,/вовремя/]]){
  const result=locationError({code,message:'English system detail'});assert.equal(result.code,expected);assert.match(result.message,message);assert(!result.message.includes('English'));
 }
});

async function platformHarness(){
 const listeners={},nativeListeners={},document={hidden:false,addEventListener:(name,fn)=>listeners[name]=fn,querySelector:()=>null};
 const context=vm.createContext({document,window:{},navigator:{},URL,URLSearchParams,AbortController,DOMException,TextEncoder,Uint8Array,crypto:globalThis.crypto,btoa,setTimeout,clearTimeout,Date,CityQuestNative:{isNative:true,apiBase:'https://api.example.test',app:{addListener:async(name,fn)=>nativeListeners[name]=fn,getLaunchUrl:async()=>null},browser:{open:async()=>{},close:async()=>{}}}});
 const source=(await readFile(new URL('../public/platform.js',import.meta.url),'utf8')).replace(/export /g,'');
 vm.runInContext(source+'\nglobalThis.platform={initializePlatform,startSso,handleDeepLink,clearSession};',context);
 return {context,document,listeners,nativeListeners,platform:context.platform};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('native and DOM lifecycle events deduplicate inactivity and await cleanup before resume',async()=>{
 const h=await platformHarness(),calls=[];let finish;
 await h.platform.initializePlatform({onInactive:()=>{calls.push('inactive');return new Promise(resolve=>finish=resolve);},onActive:()=>calls.push('active')});
 h.document.hidden=true;h.listeners.visibilitychange();h.nativeListeners.appStateChange({isActive:false});assert.deepEqual(calls,['inactive']);
 h.document.hidden=false;h.listeners.visibilitychange();h.nativeListeners.appStateChange({isActive:true});await flush();assert.deepEqual(calls,['inactive']);
 finish();await flush();assert.deepEqual(calls,['inactive','active']);h.nativeListeners.appStateChange({isActive:true});assert.equal(calls.length,2);
});
test('a rapid return to background suppresses stale foreground work',async()=>{
 const h=await platformHarness(),calls=[];let finish;
 await h.platform.initializePlatform({onInactive:()=>{calls.push('inactive');return new Promise(resolve=>finish=resolve);},onActive:()=>calls.push('active')});
 h.nativeListeners.appStateChange({isActive:false});const firstFinish=finish;
 h.nativeListeners.appStateChange({isActive:true});h.nativeListeners.appStateChange({isActive:false});firstFinish();finish();await flush();assert.deepEqual(calls,['inactive','inactive']);
});
test('duplicate native SSO callbacks cannot interrupt or repeat an in-flight exchange',async()=>{
 const h=await platformHarness(),callbacks=[];let resolveExchange,exchanges=0;
 h.context.fetch=async()=>{exchanges++;return new Promise(resolve=>resolveExchange=()=>resolve({ok:true,json:async()=>({user:{id:'one'},accessToken:'memory-only'})}));};
 await h.platform.initializePlatform({onAuth:(error,result)=>callbacks.push({error,result})});
 try{
  await h.platform.startSso();const url='cityquest://auth/callback?code='+'f'.repeat(64),first=h.platform.handleDeepLink(url);await flush();
  await h.platform.handleDeepLink(url);assert.equal(exchanges,1);assert.equal(callbacks.length,0);
  resolveExchange();await first;await h.platform.handleDeepLink(url);assert.equal(exchanges,1);assert.equal(callbacks.length,1);assert.equal(callbacks[0].error,null);
 }finally{h.platform.clearSession();}
});
