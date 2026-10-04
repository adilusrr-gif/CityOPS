// Shared browser/native boundary. Session and PKCE secrets intentionally live in memory only.
const bridge = () => globalThis.CityQuestNative;
export const isNative = () => bridge()?.isNative === true;
// Supported WebViews include versions without AbortSignal.any()/timeout().
// Keep the timer through response-body consumption, then remove every listener.
function requestDeadline(signal,timeoutMs){
 const controller=new AbortController();
 const abort=()=>controller.abort(signal.reason||new DOMException('Запрос отменён','AbortError'));
 if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>controller.abort(new DOMException('Время ожидания истекло','TimeoutError')),timeoutMs);timer.unref?.();
 return {signal:controller.signal,dispose(){clearTimeout(timer);signal?.removeEventListener('abort',abort);}};
}
export function createApiClient({native=false,apiBase='',fetchImpl=globalThis.fetch}={}) {
 let accessToken='',authGeneration=0;if(!native)apiBase='';
 if(native){const url=new URL(apiBase);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Нужен HTTPS origin API');apiBase=url.origin;}
 return {
  clear(){accessToken='';authGeneration++;},
  async request(path,method='GET',body,{signal}={}){
   if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Некорректный путь API');
   const requestToken=accessToken,authAttempt=native&&['/login','/register','/auth/mfa/login','/auth/mobile/exchange','/logout'].includes(path),generation=authAttempt?++authGeneration:authGeneration;
   const headers={Accept:'application/json'};if(body!==undefined)headers['Content-Type']='application/json';
   if(native){headers['X-CityQuest-Client']='native';if(requestToken)headers.Authorization='Bearer '+requestToken;}
   const deadline=requestDeadline(signal,path==='/pet/chat'||method==='POST'&&/^\/photos(?:\?|$)/.test(path)?60000:20000);
   try{let r;try{r=await fetchImpl(apiBase+'/api'+path,{method,headers,credentials:native?'omit':'same-origin',cache:'no-store',redirect:'error',signal:deadline.signal,body:body!==undefined?JSON.stringify(body):undefined});}catch(error){if(signal?.aborted)throw signal.reason||error;throw new Error(error.name==='TimeoutError'?'Сервер отвечает слишком долго. Проверьте результат перед повтором действия.':'Нет соединения с сервером. Для игры нужен интернет.');}
   let data;try{data=await r.json();}catch{throw new Error('Сервер вернул неизвестный ответ');}
   // An old chat/logout can finish after the user signs into another account.
   // Its response must never clear the newer account's native bearer.
   if(!r.ok){if(r.status===401&&accessToken===requestToken)accessToken='';const error=new Error(data.error||'Ошибка запроса');error.status=r.status;throw error;}
   if(native&&typeof data.accessToken==='string'){if(generation!==authGeneration){delete data.accessToken;const error=new Error('Этот вход заменён более новым действием.');error.status=409;throw error;}accessToken=data.accessToken;delete data.accessToken;}
   if(path==='/logout'&&accessToken===requestToken)accessToken='';return data;
   }finally{deadline.dispose();}
  },
  async photoBlob(path,{signal,maxBytes=512*1024}={}){
   if(typeof path!=='string')throw new Error('Некорректный путь фотографии');
   if(path.startsWith('/api/'))path=path.slice(4);
   if(!/^\/photos\/[a-zA-Z0-9-]{1,100}\/image$/.test(path))throw new Error('Некорректный путь фотографии');
   const requestToken=accessToken,headers={Accept:'image/jpeg'};
   if(native){headers['X-CityQuest-Client']='native';if(requestToken)headers.Authorization='Bearer '+requestToken;}
   const deadline=requestDeadline(signal,20000);
   try{let response;
   try{response=await fetchImpl(apiBase+'/api'+path,{method:'GET',headers,credentials:native?'omit':'same-origin',cache:'no-store',redirect:'error',signal:deadline.signal});}
   catch(error){if(signal?.aborted)throw signal.reason||error;throw new Error('Не удалось загрузить фотографию. Проверьте соединение.');}
   if(!response.ok){
    if(response.status===401&&accessToken===requestToken)accessToken='';
    let data;try{data=await response.json();}catch{}
    const error=new Error(data?.error||'Фотография недоступна');error.status=response.status;throw error;
   }
   if(response.headers.get('content-type')?.split(';')[0].trim()!=='image/jpeg')throw new Error('Неизвестный формат фотографии');
   maxBytes=Math.min(512*1024,Math.max(1,Number(maxBytes)||512*1024));const length=Number(response.headers.get('content-length'));
   if(length>maxBytes){await response.body?.cancel();throw new Error('Фотография слишком большая');}
   const reader=response.body?.getReader();if(!reader)throw new Error('Фотография недоступна');
   const chunks=[];let size=0;
   try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error('Фотография слишком большая');}chunks.push(value);}}
   finally{reader.releaseLock();}
   if(!size)throw new Error('Пустая фотография');
   return new Blob(chunks,{type:'image/jpeg'});
   }finally{deadline.dispose();}
  }
 };
}
let client;
export function apiRequest(...args){if(['/login','/register','/auth/mfa/login','/logout'].includes(args[0]))cancelSso();client??=createApiClient({native:isNative(),apiBase:bridge()?.apiBase||''});return client.request(...args);}
export function getPhotoBlob(path,options){client??=createApiClient({native:isNative(),apiBase:bridge()?.apiBase||''});return client.photoBlob(path,options);}
export function cancelSso(){ssoGeneration++;verifier='';clearTimeout(verifierTimer);}
export function clearSession(){client?.clear();cancelSso();}
export function locationError(error){
 const code=error?.code;
 const messages={
  'OS-PLUG-GLOC-0003':[1,'Разрешите точную геолокацию в настройках приложения, затем нажмите «Моё положение» снова.'],
  'OS-PLUG-GLOC-0007':[2,'Геолокация устройства выключена. Включите её в настройках и повторите попытку.'],
  'OS-PLUG-GLOC-0008':[1,'Доступ к геолокации ограничен настройками устройства. Проверьте разрешения приложения.'],
  'OS-PLUG-GLOC-0009':[2,'Геолокация устройства не включена. Включите её в настройках и повторите попытку.'],
  'OS-PLUG-GLOC-0010':[3,'Не удалось получить GPS вовремя. Выйдите на открытое место и повторите попытку.'],
  'OS-PLUG-GLOC-0014':[2,'Проверьте сервисы геолокации Google Play и повторите попытку.'],
  'OS-PLUG-GLOC-0015':[2,'Сервисы геолокации Google Play недоступны. Проверьте их настройки.'],
  'OS-PLUG-GLOC-0017':[2,'Включите интернет и геолокацию устройства, затем повторите попытку.'],
  1:[1,'Разрешите точную геолокацию в настройках устройства, затем повторите попытку.'],
  2:[2,'Координаты недоступны. Проверьте геолокацию устройства и попробуйте на открытом месте.'],
  3:[3,'Не удалось получить GPS вовремя. Выйдите на открытое место и повторите попытку.']
 };
 const [normalized,message]=messages[code]||[2,'Не удалось получить GPS. Проверьте геолокацию и повторите попытку.'];
 return Object.assign(new Error(message),{code:normalized,nativeCode:typeof code==='string'?code:undefined});
}
export function watchLocation(success,error){
 let stopped=false,id;const native=isNative();
 const stop=async()=>{stopped=true;await started;if(id!==undefined){const current=id;id=undefined;if(native)await bridge().geolocation.clearWatch({id:current});else navigator.geolocation.clearWatch(current);}};
 const options={enableHighAccuracy:true,maximumAge:5000,timeout:20000,minimumUpdateInterval:7000,interval:7000};
 const accept=position=>{if(!stopped)success(position);};const reject=err=>{if(!stopped)error(locationError(err));};
 const started=(async()=>{
  try{
   if(native){const permission=await bridge().geolocation.requestPermissions({permissions:['location']});if(stopped)return;if(permission.location!=='granted')throw Object.assign(new Error('Location permission denied'),{code:'OS-PLUG-GLOC-0003'});id=await bridge().geolocation.watchPosition(options,(position,err)=>{if(err)reject(err);else if(position)accept(position);});}
   else{if(!navigator.geolocation)throw new Error('Геолокация не поддерживается');id=navigator.geolocation.watchPosition(accept,reject,options);}
  }catch(err){reject(err);}
 })();
 return {stop};
}
function base64url(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
let verifier='',verifierTimer,ssoStarted=0,ssoGeneration=0,handledSsoGeneration=-1,authCallback=()=>{};
export async function startSso(){
 if(!isNative()){location.assign('/api/auth/sso/start');return;}
 cancelSso();const generation=ssoGeneration;verifier=base64url(crypto.getRandomValues(new Uint8Array(32)));ssoStarted=Date.now();verifierTimer=setTimeout(()=>{verifier='';},10*60*1000);
 const challenge=base64url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
 if(generation!==ssoGeneration)return;
 try{await bridge().browser.open({url:bridge().apiBase+'/api/auth/sso/start?platform=mobile&code_challenge='+challenge,presentationStyle:'popover'});}catch(error){if(generation===ssoGeneration)cancelSso();throw error;}
}
export async function handleDeepLink(rawUrl){
 let url;try{url=new URL(rawUrl);}catch{return false;}
 if(url.protocol!=='cityquest:'||url.hostname!=='auth'||url.pathname!=='/callback'||url.username||url.password||url.port||url.hash)return false;
 const code=url.searchParams.get('code');if(!/^[a-f0-9]{64}$/.test(code||''))return false;
 // Android may deliver the same callback both as launch URL and appUrlOpen.
 // Claim the attempt before awaiting anything so a duplicate cannot report a false failure.
 if(handledSsoGeneration===ssoGeneration)return true;
 const codeVerifier=verifier,generation=ssoGeneration,started=ssoStarted;handledSsoGeneration=generation;verifier='';clearTimeout(verifierTimer);
 try{
  await bridge()?.browser.close().catch(()=>{});
  if(generation!==ssoGeneration)return true;
  if(!codeVerifier||Date.now()-started>10*60*1000)throw new Error('Вход прерван. Повторите вход через организацию.');
  const result=await apiRequest('/auth/mobile/exchange','POST',{code,code_verifier:codeVerifier});if(generation===ssoGeneration)await authCallback(null,result);
 }catch(error){if(generation===ssoGeneration)await authCallback(error);}
 return true;
}
export function consumeWebMfaChallenge(){
 if(isNative())return null;const params=new URLSearchParams(location.hash.slice(1));const challenge=params.get('mfaChallenge');
 if(params.has('mfaChallenge'))history.replaceState(null,'',location.pathname+location.search);
 return /^[a-f0-9]{64}$/.test(challenge||'')?challenge:null;
}
export async function initializePlatform({onInactive=()=>{},onActive=()=>{},onAuth=()=>{}}={}){
 authCallback=onAuth;
 let nativeActive=true,active=!document.hidden,inactiveWork=Promise.resolve(),transition=0;
 const updateActivity=()=>{
  const next=nativeActive&&!document.hidden;if(next===active)return;active=next;const version=++transition;
  if(!active){try{inactiveWork=Promise.resolve(onInactive()).catch(()=>{});}catch{inactiveWork=Promise.resolve();}}
  else void inactiveWork.then(()=>{if(active&&version===transition)return onActive();}).catch(()=>{});
 };
 document.addEventListener('visibilitychange',updateActivity);
 if(isNative()){
  await bridge().app.addListener('appStateChange',({isActive})=>{nativeActive=isActive;updateActivity();});
  await bridge().app.addListener('appUrlOpen',({url})=>{void handleDeepLink(url);});
  await bridge().app.addListener('backButton',()=>{const dialog=document.querySelector('dialog[open]');if(dialog)dialog.close();else void bridge().app.minimizeApp();});
  const launch=await bridge().app.getLaunchUrl();if(launch?.url)await handleDeepLink(launch.url);
 }else if('serviceWorker' in navigator&&window.isSecureContext){
  // A new shell activates on next launch; never reload while a user is entering a reward or MFA code.
  navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});
 }
}
