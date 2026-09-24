import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {isIP} from 'node:net';
import {loadSecurityKeys} from './security.mjs';
import {loadProductPolicy} from './product-policy.mjs';
import {envInteger,httpConfiguration,mapConfiguration,contactConfiguration} from './http-policy.mjs';
let memoryKeys;
export function runtimeConfig(db,{env=process.env,secure=env.COOKIE_SECURE==='true',origin=env.PUBLIC_ORIGIN,keys}={}){
 const production=env.NODE_ENV==='production';
 const http=httpConfiguration(env),map=mapConfiguration(env),contacts=contactConfiguration(env),productPolicy=loadProductPolicy(env);
 const passwordKdfConcurrency=envInteger(env,'PASSWORD_KDF_CONCURRENCY',2,1,8),rateLimitMaxKeys=envInteger(env,'RATE_LIMIT_MAX_KEYS',10000,1000,100000);
 for(const name of ['COOKIE_SECURE','REQUIRE_ADMIN_MFA','JSON_LOGS'])if(env[name]!==undefined&&!['true','false'].includes(env[name]))throw new Error(`${name} must be true or false`);
 const trustProxy=env.TRUST_PROXY??'none';
 if(!['none','loopback'].includes(trustProxy))throw new Error('TRUST_PROXY must be none or loopback');
 const idleMinutes=env.SESSION_IDLE_MINUTES===undefined?30:Number(env.SESSION_IDLE_MINUTES);
 if(!Number.isFinite(idleMinutes)||idleMinutes<1||idleMinutes>1440)throw new Error('SESSION_IDLE_MINUTES must be a finite number between 1 and 1440');
 const explicitEncryption=Boolean(env.DATA_ENCRYPTION_KEY),explicitAudit=Boolean(env.AUDIT_HMAC_KEY);
 if(explicitEncryption!==explicitAudit)throw new Error('DATA_ENCRYPTION_KEY and AUDIT_HMAC_KEY must be supplied together');
 // Validate explicit values before reading or creating any development key file.
 const explicitKeys=explicitEncryption?loadSecurityKeys({env}):null;
 if(production){
  if(!secure)throw new Error('Production requires COOKIE_SECURE=true');
  if(!origin||new URL(origin).protocol!=='https:'||new URL(origin).origin!==origin)throw new Error('Production requires canonical HTTPS PUBLIC_ORIGIN');
 }
 let securityKeys=keys||explicitKeys;
 if(!securityKeys){
  if(production)securityKeys=loadSecurityKeys({env});
  else if(db.aqPath===':memory:'){memoryKeys??=loadSecurityKeys({env:{NODE_ENV:'test'}});securityKeys=memoryKeys;}
  else{
   const keyPath=resolve(env.SECURITY_KEYS_PATH||resolve(dirname(db.aqPath||'./data/cityquest.sqlite'),'security-keys.json'));
   mkdirSync(dirname(keyPath),{recursive:true});
   if(!existsSync(keyPath)){try{writeFileSync(keyPath,JSON.stringify({DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),AUDIT_HMAC_KEY:randomBytes(32).toString('hex')}),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}}
   const stored=JSON.parse(readFileSync(keyPath,'utf8'));
   if(!stored.DATA_ENCRYPTION_KEY||!stored.AUDIT_HMAC_KEY)throw new Error('Development key file must contain both DATA_ENCRYPTION_KEY and AUDIT_HMAC_KEY');
   securityKeys=loadSecurityKeys({env:{NODE_ENV:env.NODE_ENV||'development',DATA_ENCRYPTION_KEY:stored.DATA_ENCRYPTION_KEY,AUDIT_HMAC_KEY:stored.AUDIT_HMAC_KEY}});
  }
 }
 return {production,secure,origin,http,...map,contacts,productPolicy,passwordKdfConcurrency,rateLimitMaxKeys,keys:securityKeys,requireAdminMfa:production||env.REQUIRE_ADMIN_MFA==='true',trustProxy,jsonLogs:production||env.JSON_LOGS==='true',idleMs:Math.round(idleMinutes*60000)};
}
export function clientIp(req,trustProxy='none'){
 const remote=req.socket.remoteAddress||'unknown';
 if(trustProxy!=='loopback'||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote))return remote;
 // Trust only the rightmost address appended by the directly connected local proxy.
 const forwarded=String(req.headers['x-forwarded-for']||'').split(',').at(-1)?.trim();
 return forwarded&&isIP(forwarded)?forwarded:remote;
}
