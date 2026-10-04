import {VERSION} from '../version.mjs';
import {inspectEncryption,requireValidEncryption} from '../key-check.mjs';
import {createWorkTracker} from '../lifecycle.mjs';
import http from 'node:http';
import {createPasswordService} from '../passwords.mjs';
import {publicProductPolicy,PHOTO_MEDIA_LIMITS} from '../product-policy.mjs';
import {setBodyPolicy} from '../http-body.mjs';
import {createAdmission,holdResponseSlot,contentSecurityPolicy} from '../http-policy.mjs';
import {readFile,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,extname,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';
import {performance} from 'node:perf_hooks';
import {timingSafeEqual} from 'node:crypto';
import {id,hash,fail,city} from '../domain.mjs';
import {CITIES,DEFAULT_CITY} from '../cities.mjs';
import {readJson} from '../auth.mjs';
import {openPostgres,PG_SCHEMA_VERSION} from './db.mjs';
import {appendAudit,verifyAudit,consumeRate} from './security-store.mjs';
import {enterpriseConfig,enterpriseClientIp} from './config.mjs';
import {createEnterpriseAuth} from './auth.mjs';
import {createGameRoutes} from './game-routes.mjs';
import {createManageRoutes} from './manage-routes.mjs';
import {pruneEnterpriseData} from './maintenance.mjs';
import {createFeatureStore} from '../features/store.mjs';
import {createPetRoutes,prunePetData} from '../features/pet-routes.mjs';
import {createBillingRoutes} from '../features/billing-routes.mjs';
import {createAdventureRoutes} from '../features/adventure-routes.mjs';
import {createPhotoRoutes,prunePhotoUsage} from '../features/photo-routes.mjs';

const publicRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../public');
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const safeEqual=(a,b)=>{const aa=Buffer.from(a||''),bb=Buffer.from(b||'');return aa.length===bb.length&&timingSafeEqual(aa,bb);};

export async function createEnterpriseApp({db,env=process.env,keys,secure,origin,petFetchImpl,passwordService}={}){
 const cfg=enterpriseConfig({env,keys,secure,origin});
 const ownsDb=!db;db??=await openPostgres({env,connectionString:env.DATABASE_URL});
 try{
  const schema=await db.get('SELECT MAX(version) AS version FROM schema_migrations');
  if(schema?.version!==PG_SCHEMA_VERSION)throw new Error('Run PostgreSQL migrations before starting application replicas');
  const integrity=await verifyAudit(db,cfg.keys.auditKey);if(!integrity.ok)throw new Error('Audit integrity verification failed at startup');
  requireValidEncryption(await inspectEncryption(db,'postgres',cfg.keys.encryptionKey,{sample:true}));
 }catch(e){if(ownsDb)await db.close();throw e;}
 const contexts=new AsyncLocalStorage(),started=Date.now();let draining=false,cleanupRunning=false,closing;const work=createWorkTracker();
 const metrics={requests:0,errors:0,statuses:{},durations:[]};
 const audit=(tx,actor,action,target,metadata={})=>appendAudit(tx,{actor,action,target,metadata,requestId:contexts.getStore()?.requestId||'operator'},cfg.keys.auditKey);
 async function throttle(key,limit=30,windowMs=60000){
  const result=await consumeRate(db,hash(key),{limit,windowMs,maxKeys:cfg.rateLimitMaxKeys});
  if(!result.allowed)throw Object.assign(new Error('Слишком много попыток. Подождите.'),{status:429,retryAfter:Math.max(1,Math.ceil(result.retryAfterMs/1000))});
 }
 passwordService??=createPasswordService({concurrency:cfg.passwordKdfConcurrency});const admission=createAdmission(cfg.http);
 const auth=createEnterpriseAuth({db,cfg,audit,throttle,env,passwordService}),game=createGameRoutes(),manage=createManageRoutes();
 const featureStore=createFeatureStore({db,cfg,audit,dialect:'postgres'});
 const pet=createPetRoutes({store:featureStore,cfg,env,fetchImpl:petFetchImpl}),billing=createBillingRoutes({store:featureStore,cfg,env});
 const adventures=createAdventureRoutes({store:featureStore,cfg,env}),photos=createPhotoRoutes({store:featureStore,cfg,env});
 async function context(req,res,url){
  const user=await auth.session(req);
  const ctx={db,cfg,req,res,url,path:url.pathname,method:req.method,cityId:city(url.searchParams.get('city')||DEFAULT_CITY).id,user,ip:enterpriseClientIp(req,cfg),requestId:contexts.getStore().requestId,auth,required:auth.required,audit,throttle};
  ctx.readBody=async()=>{
   const body=await readJson(req);
   if(user){const fresh=await auth.session(req);if(!fresh||fresh.session_id!==user.session_id||fresh.role!==user.role||fresh.mfa_enabled!==user.mfa_enabled||fresh.session_mfa_verified!==user.session_mfa_verified)fail('Доступ изменился. Войдите заново.',401);}
   return body;
  };
  return ctx;
 }
 async function route(ctx){
  const {path,method,cityId,user,url}=ctx;
  if(path==='/api/config'&&method==='GET'){
   const [count,imported,admin]=await Promise.all([
    db.get("SELECT count(*) AS n FROM organizations WHERE status='approved' AND city_id=$1",[cityId]),
    db.get('SELECT value FROM meta WHERE key=$1',[`osm_import_${cityId}`]),
    db.get("SELECT id FROM users WHERE role='admin' AND disabled=0 LIMIT 1")
   ]);
   return {city:CITIES[cityId],cities:Object.values(CITIES),mapStyle:cfg.mapStyle,productPolicy:publicProductPolicy(cfg.productPolicy),contacts:cfg.contacts,localMapAssets:['maplibre-gl.js','maplibre-gl.css','three.module.js','three.core.js'].every(f=>existsSync(resolve(publicRoot,'vendor',f))),bounds:CITIES[cityId].bounds,organizations:Number(count.n),osmImport:JSON.parse(imported?.value||'null'),adminConfigured:!!admin,enterprisePilot:false,deployment:'postgresql-shared',version:VERSION};
  }
  const authResult=await auth.handle(ctx);if(authResult!==undefined)return authResult;
  const petResult=await pet(ctx);if(petResult!==undefined)return petResult;
  const billingResult=await billing(ctx);if(billingResult!==undefined)return billingResult;
  const adventureResult=await adventures(ctx);if(adventureResult!==undefined)return adventureResult;
  const photoResult=await photos(ctx);if(photoResult!==undefined||ctx.res.writableEnded)return photoResult;
  const gameResult=await game(ctx);if(gameResult!==undefined)return gameResult;
  const manageResult=await manage(ctx);if(manageResult!==undefined)return manageResult;
  if(['/api/admin/metrics','/api/admin/audit','/api/admin/audit/verify'].includes(path)&&method==='GET'){
   auth.required(user,['admin']);
   if(path==='/api/admin/audit/verify')await throttle(`audit-verify:${user.id}`,1,60000);
   // Authorization and protected reads share actor/session locks. A permission
   // change committed after the initial HTTP session lookup must take effect.
   return db.transaction(async tx=>{
    const fresh=await auth.freshActor(tx,user);auth.required(fresh,['admin']);
    if(path==='/api/admin/audit/verify')return verifyAudit(tx,cfg.keys.auditKey);
    if(path==='/api/admin/audit'){
     const limit=Math.min(500,Math.max(1,Math.trunc(Number(url.searchParams.get('limit'))||100))),before=Math.max(0,Math.trunc(Number(url.searchParams.get('before'))||Number.MAX_SAFE_INTEGER));
     return {items:await tx.all('SELECT id,actor_id,action,target,created_at,metadata,request_id,prev_hash,event_hash FROM audit WHERE id<$1 ORDER BY id DESC LIMIT $2',[before,limit])};
    }
    const samples=[...metrics.durations].sort((a,b)=>a-b),quantile=f=>samples[Math.min(samples.length-1,Math.floor(samples.length*f))]||0;
    return {admission:admission.snapshot(),database:db.metrics?.(),instance_id:cfg.instanceId,uptime_seconds:Math.floor((Date.now()-started)/1000),requests:metrics.requests,errors:metrics.errors,statuses:metrics.statuses,latency_ms:{p50:quantile(.5),p95:quantile(.95),p99:quantile(.99),sample_count:samples.length},active_sessions:Number((await tx.get('SELECT count(*) n FROM sessions WHERE expires>$1 AND last_seen>$2',[Date.now(),Date.now()-cfg.idleMs])).n),cities:await Promise.all(Object.keys(CITIES).map(async id=>({id,organizations:Number((await tx.get('SELECT count(*) n FROM organizations WHERE city_id=$1',[id])).n),quests:Number((await tx.get('SELECT count(*) n FROM quests WHERE city_id=$1',[id])).n)}))),deployment:'postgresql-shared',database_failover:'external-cluster-or-managed-service'};
   });
  }
  fail('Маршрут не найден',404);
 }
 const server=http.createServer((req,res)=>contexts.run({requestId:id()},async()=>{
  const doneWork=work.enter(),requestId=contexts.getStore().requestId,start=performance.now();let release;res.setTimeout(cfg.http.responseTimeoutMs,()=>res.destroy());
  res.setHeader('X-Request-Id',requestId);res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','geolocation=(self), camera=(), microphone=()');
  if(cfg.secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
  res.setHeader('Content-Security-Policy',contentSecurityPolicy(cfg));
  res.on('finish',()=>{const elapsed=Number((performance.now()-start).toFixed(2));metrics.requests++;metrics.statuses[res.statusCode]=(metrics.statuses[res.statusCode]||0)+1;if(res.statusCode>=500)metrics.errors++;metrics.durations.push(elapsed);if(metrics.durations.length>5000)metrics.durations.shift();if(cfg.jsonLogs)console.log(JSON.stringify({event:'http',instance:cfg.instanceId,request_id:requestId,method:req.method,status:res.statusCode,duration_ms:elapsed}));});
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  try{
   const url=new URL(req.url,'http://localhost'),path=url.pathname;
   if(path==='/metrics'){
    res.setHeader('Cache-Control','no-store');if(!cfg.metricsToken)fail('Не найдено',404);if(!safeEqual(req.headers.authorization,'Bearer '+cfg.metricsToken))fail('Недостаточно прав',401);
    if(req.method!=='GET')fail('Метод не поддерживается',405);
    const text=['# TYPE cityquest_http_requests_total counter',`cityquest_http_requests_total ${metrics.requests}`,'# TYPE cityquest_http_errors_total counter',`cityquest_http_errors_total ${metrics.errors}`,'# TYPE cityquest_uptime_seconds gauge',`cityquest_uptime_seconds ${Math.floor((Date.now()-started)/1000)}`,'# TYPE cityquest_draining gauge',`cityquest_draining ${draining?1:0}`].join('\n')+'\n';
    res.writeHead(200,{'Content-Type':'text/plain; version=0.0.4'});res.end(text);return;
   }
   if(path.startsWith('/api/')){
    res.setHeader('Cache-Control','no-store');
    const expected=cfg.origin||`${cfg.secure?'https':'http'}://${req.headers.host}`,originHeader=req.headers.origin,nativeOrigin=originHeader&&cfg.nativeOrigins.includes(originHeader)&&originHeader!==expected;
    if(originHeader&&originHeader!==expected&&!nativeOrigin)fail('Запрос с другого сайта запрещён',403);
    if(nativeOrigin){res.setHeader('Access-Control-Allow-Origin',originHeader);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Expose-Headers','X-Request-Id,Retry-After');}
    if(req.method==='OPTIONS'){
     if(!nativeOrigin&&originHeader!==expected)fail('Недопустимый источник',403);
     res.setHeader('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-CityQuest-Client');res.setHeader('Access-Control-Max-Age','600');res.writeHead(204);res.end();return;
    }
    if(path==='/api/health'&&req.method==='GET'){json(200,{ok:true,version:VERSION,deployment:'postgresql-shared'});return;}
    if(path==='/api/ready'&&req.method==='GET'){
     if(draining)fail('Сервис завершает работу',503);
     try{const row=await db.get('SELECT MAX(version) AS version FROM schema_migrations');if(row?.version!==PG_SCHEMA_VERSION)fail('Схема базы не готова',503);}catch(e){if(e.status)throw e;fail('База временно недоступна',503);}
     json(200,{ok:true,schema:PG_SCHEMA_VERSION});return;
    }
const photoUpload=req.method==='POST'&&url.pathname==='/api/photos',catalogImport=req.method==='POST'&&url.pathname==='/api/manage/osm',upload=photoUpload||catalogImport,bodyLimit=photoUpload?4*Math.ceil(PHOTO_MEDIA_LIMITS.inputBytes/3)+16384:catalogImport?8*1024*1024:cfg.http.jsonBytes;
    setBodyPolicy(req,{maxBytes:bodyLimit,timeoutMs:cfg.http.bodyTimeoutMs});
    if(Number(req.headers['content-length'])>bodyLimit)throw Object.assign(new Error('Запрос слишком большой'),{status:413,closeConnection:true});
    if(!['/api/health','/api/ready'].includes(url.pathname))release=holdResponseSlot(res,admission.enter({upload}));
    await throttle(`all:${enterpriseClientIp(req,cfg)}`,3000);
    if(!['GET','HEAD'].includes(req.method)){
     if(draining)fail('Сервис завершает работу',503);
     if(nativeOrigin&&req.headers['x-cityquest-client']!=='native')fail('Нативный клиент не указан',403);
     if(!nativeOrigin&&req.headers['sec-fetch-site']==='cross-site')fail('Запрос с другого сайта запрещён',403);
     if(req.method!=='DELETE'&&!req.headers['content-type']?.startsWith('application/json'))fail('Ожидается application/json',415);
    }
    const result=await route(await context(req,res,url));if(!res.writableEnded)json(200,result);return;
   }
   if(!['GET','HEAD'].includes(req.method))fail('Метод не поддерживается',405);
   let pathname;try{pathname=decodeURIComponent(path);}catch{fail('Некорректный адрес');}
   const localPath=resolve(publicRoot,'.'+(pathname==='/'?'/index.html':pathname));if(!localPath.startsWith(publicRoot+sep))fail('Не найдено',404);
   let info;try{info=await stat(localPath);}catch{fail('Файл не найден',404);}if(!info.isFile())fail('Файл не найден',404);
   res.writeHead(200,{'Content-Type':mime[extname(localPath)]||'application/octet-stream','Cache-Control':pathname.startsWith('/vendor/')?'public,max-age=86400':'no-cache'});res.end(req.method==='HEAD'?undefined:await readFile(localPath));
  }catch(e){
   if(res.writableEnded||res.destroyed)return;if(e.closeConnection||!req.complete)res.setHeader('Connection','close');const databaseUnavailable=['57P01','57P02','57P03','08000','08003','08006','ECONNREFUSED','ECONNRESET','ETIMEDOUT','53300','53400','55P03','57014','POOL_BUSY','POOL_CLOSED'].includes(e.code),status=e.status||(databaseUnavailable?503:e.code==='23505'?409:500);
   if(status>=500)console.error(JSON.stringify({event:'server_error',instance:cfg.instanceId,request_id:requestId,name:e.name,code:e.code||'INTERNAL'}));
   if(!res.headersSent){res.removeHeader('Set-Cookie');if(e.retryAfter)res.setHeader('Retry-After',e.retryAfter);json(status,{error:status>=500?(status===503?'Сервис временно недоступен':'Ошибка сервера'):e.code==='23505'?'Запись уже существует':e.message,requestId});}else res.end();
  }finally{release?.();doneWork();}
 }));
 server.requestTimeout=Math.max(30000,cfg.http.bodyTimeoutMs+5000);server.headersTimeout=15000;server.keepAliveTimeout=5000;server.maxRequestsPerSocket=1000;
 const cleanup=setInterval(async()=>{
  if(cleanupRunning||draining)return;cleanupRunning=true;const doneWork=work.enter();
  try{await pruneEnterpriseData(db,{idleMs:cfg.idleMs});await prunePetData(featureStore);await prunePhotoUsage(featureStore);}catch(e){console.error(JSON.stringify({event:'cleanup_failed',code:e.code||'INTERNAL'}));}finally{cleanupRunning=false;doneWork();}
 },60000);cleanup.unref();server.on('close',()=>clearInterval(cleanup));
 return {server,db,cfg,auth,audit,metrics,beginDrain(){draining=true;},close(){return closing??=(async()=>{draining=true;clearInterval(cleanup);if(server.listening){server.closeIdleConnections();await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}await work.idle();if(ownsDb)await db.close();})();}};
}
