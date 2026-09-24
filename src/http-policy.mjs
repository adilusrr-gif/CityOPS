// Operator settings are validated once. Protocol/security bounds remain in code.
export function envInteger(env,name,fallback,min,max){
 const raw=env[name];
 if(raw===undefined)return fallback;
 if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<min||Number(raw)>max)throw new Error(`${name} must be an integer between ${min} and ${max}`);
 return Number(raw);
}
export function mapConfiguration(env={}){
 const mapStyle=env.MAP_STYLE||'https://tiles.openfreemap.org/styles/dark';
 let style;try{style=new URL(mapStyle);}catch{throw new Error('MAP_STYLE must be an HTTPS URL');}
 if(style.protocol!=='https:'||style.username||style.password)throw new Error('MAP_STYLE must be an HTTPS URL without credentials');
 const explicit=env.MAP_RESOURCE_ORIGINS===undefined?[]:env.MAP_RESOURCE_ORIGINS.split(',').map(x=>x.trim()).filter(Boolean);
 if(explicit.length>6)throw new Error('MAP_RESOURCE_ORIGINS accepts at most 6 origins');
 for(const value of explicit){let url;try{url=new URL(value);}catch{throw new Error('MAP_RESOURCE_ORIGINS must contain canonical HTTPS origins');}if(url.protocol!=='https:'||url.origin!==value)throw new Error('MAP_RESOURCE_ORIGINS must contain canonical HTTPS origins');}
 return {mapStyle,mapOrigins:Object.freeze([...new Set(['https://tiles.openfreemap.org',style.origin,...explicit])])};
}
export function contactConfiguration(env={}){
 const result={};
 for(const [name,key] of [['SUPPORT_EMAIL','supportEmail'],['BILLING_CONTACT_EMAIL','billingEmail']]){
  if(env[name]===undefined||env[name]==='')continue;
  if(typeof env[name]!=='string'||env[name].length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(env[name])||/[<>?&#]/.test(env[name]))throw new Error(`${name} must be an email address`);
  result[key]=env[name];
 }
 for(const [name,key] of [['PRIVACY_URL','privacyUrl'],['TERMS_URL','termsUrl']]){
  if(env[name]===undefined||env[name]==='')continue;
  let url;try{url=new URL(env[name]);}catch{throw new Error(`${name} must be an HTTPS URL`);}
  if(url.protocol!=='https:'||url.username||url.password||env[name].length>2048)throw new Error(`${name} must be an HTTPS URL without credentials`);
  result[key]=url.href;
 }
 return Object.freeze(result);
}
export function httpConfiguration(env={}){
 return Object.freeze({maxInflight:envInteger(env,'HTTP_MAX_INFLIGHT',128,8,512),uploadConcurrency:envInteger(env,'HTTP_UPLOAD_CONCURRENCY',2,1,8),bodyTimeoutMs:envInteger(env,'HTTP_BODY_TIMEOUT_MS',15000,1000,60000),responseTimeoutMs:envInteger(env,'HTTP_RESPONSE_TIMEOUT_MS',45000,1000,120000),jsonBytes:envInteger(env,'HTTP_JSON_LIMIT_KB',64,16,256)*1024});
}
export function contentSecurityPolicy({mapOrigins,apiOrigin,native=false}){
 const sources=mapOrigins.join(' '),cdn=native?'':' https://cdn.jsdelivr.net';
 return `default-src 'self'; script-src 'self'${cdn}; style-src 'self' 'unsafe-inline'${cdn}; img-src 'self' data: blob: ${sources}; font-src 'self' data: ${sources}; connect-src 'self' ${apiOrigin||''} ${sources}${cdn}; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action ${native?"'none'":"'self'"}`;
}
export function createAdmission({maxInflight,uploadConcurrency}){
 let active=0,uploads=0,rejected=0;
 return {
  enter({upload=false}={}){
   if(active>=maxInflight||upload&&uploads>=uploadConcurrency){rejected++;throw Object.assign(new Error('Сервис занят. Повторите запрос позже.'),{status:503,retryAfter:1,closeConnection:true});}
   active++;if(upload)uploads++;let released=false;
   return ()=>{if(released)return;released=true;active--;if(upload)uploads--;};
  },
  snapshot(){return {active,uploads,rejected,maxInflight,uploadConcurrency};}
 };
}
// Slow response readers and disconnected callers must not free a work slot
// while the handler still runs or bytes remain in the response stream.
export function holdResponseSlot(res,release){
 let workDone=false,responseDone=res.destroyed||res.writableFinished,released=false;
 const complete=()=>{if(!released&&workDone&&responseDone){released=true;release();}};
 const ended=()=>{responseDone=true;complete();};
 res.once('finish',ended);res.once('close',ended);
 return ()=>{workDone=true;complete();};
}
