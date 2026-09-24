import test from 'node:test';
import assert from 'node:assert/strict';
import {request as requestHttp,createServer} from 'node:http';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {createApp} from '../src/server.mjs';
import {hash} from '../src/domain.mjs';
import {readJson,setBodyPolicy} from '../src/http-body.mjs';

async function listen(server){server.listen(0,'127.0.0.1');await once(server,'listening');return `http://127.0.0.1:${server.address().port}`;}
async function close(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
async function fixture(t,env={}){
 const db=openDb(':memory:',{withSnapshot:false}),app=createApp({db,env:{NODE_ENV:'test',...env}}),base=await listen(app.server);
 t.after(async()=>{await close(app.server);db.close();});return {...app,base};
}
function request(base,{path='/',headers={},body,chunked=false,partial=false}={}){
 let outgoing;
 const response=new Promise((resolve,reject)=>{
  outgoing=requestHttp(base+path,{method:'POST',headers:{'content-type':'application/json',...headers,...(chunked?{'transfer-encoding':'chunked'}:{})}},incoming=>{
   const chunks=[];incoming.on('data',chunk=>chunks.push(chunk));incoming.on('end',()=>{const raw=Buffer.concat(chunks).toString();resolve({status:incoming.statusCode,headers:incoming.headers,body:raw?JSON.parse(raw):null});});incoming.on('error',reject);
  });
  outgoing.on('error',reject);
  if(partial){if(body)outgoing.write(body);else outgoing.flushHeaders();}else outgoing.end(body);
 });
 return {outgoing,response};
}
function actor(db,name,{role='player',mfa=false,verified=false}={}){
 const token=randomBytes(32).toString('hex'),now=Date.now();
 db.prepare('INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled) VALUES(?,?,?,?,?,?,?)').run(name,`${name}@example.test`,name,'unused',role,now,mfa?1:0);
 db.prepare('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,?)').run(hash(token),`${name}-session`,name,now+300000,now,now,verified?1:0);
 return `aq_session=${token}`;
}

test('HTTP reader enforces byte limits for declared and chunked bodies and rejects unsupported encodings',async t=>{
 const server=createServer(async(req,res)=>{try{const value=await readJson(req);res.end(JSON.stringify({value}));}catch(error){res.writeHead(error.status,{'connection':'close'});res.end(JSON.stringify({error:error.message}));}}),base=await listen(server);t.after(()=>close(server));
 const exact=JSON.stringify({value:'x'.repeat(64*1024-12)});assert.equal(Buffer.byteLength(exact),64*1024);
 assert.equal((await request(base,{body:exact}).response).status,200);
 assert.equal((await request(base,{body:exact+' ',chunked:true}).response).status,413);
 const declared=request(base,{headers:{'content-length':64*1024+1},partial:true});
 try{assert.equal((await declared.response).status,413);}finally{declared.outgoing.destroy();}
 assert.equal((await request(base,{headers:{'content-encoding':'gzip'},body:'{}'}).response).status,415);
 assert.equal((await request(base,{body:'[]'}).response).status,400);
 assert.equal((await request(base,{body:'{"broken"'}).response).status,400);
});

test('incomplete chunked JSON has an application read deadline and closes the connection',async t=>{
 const server=createServer(async(req,res)=>{setBodyPolicy(req,{maxBytes:1024,timeoutMs:40});try{await readJson(req);res.end('{}');}catch(error){res.writeHead(error.status,{'connection':'close'});res.end(JSON.stringify({error:error.message}));}}),base=await listen(server);t.after(()=>close(server));
 const partial=request(base,{chunked:true,body:'{',partial:true});
 try{const result=await partial.response;assert.equal(result.status,408);assert.equal(result.headers.connection,'close');}finally{partial.outgoing.destroy();}
 const healthy=await request(base,{body:'{}'}).response;assert.equal(healthy.status,200);
});

test('aborted upload never crashes the process and a following request still succeeds',()=>{
 const moduleUrl=new URL('../src/http-body.mjs',import.meta.url).href;
 const source=`import http from 'node:http';import {once} from 'node:events';import {readJson} from ${JSON.stringify(moduleUrl)};
 let reached;const reading=new Promise(resolve=>{reached=resolve});let aborted=0;
 const server=http.createServer(async(req,res)=>{req.once('data',()=>reached());try{await readJson(req);res.end('{}')}catch(error){if(error.status===400)aborted++;if(!res.destroyed){res.writeHead(error.status,{'connection':'close'});res.end('{}')}}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const partial=http.request(base,{method:'POST',headers:{'content-length':100}});partial.on('error',()=>{});partial.write('{');await reading;partial.destroy();
 const response=await fetch(base,{method:'POST',body:'{}'});await response.text();
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));console.log(JSON.stringify({status:response.status,aborted}));`;
 const result=execFileSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8',timeout:10000});
 assert.deepEqual(JSON.parse(result.trim()),{status:200,aborted:1});
});

test('HTTP admission rejects excess work before database access while health and readiness remain responsive',async t=>{
 const f=await fixture(t,{HTTP_MAX_INFLIGHT:'8',HTTP_BODY_TIMEOUT_MS:'5000'}),held=[];
 t.after(()=>held.forEach(item=>item.outgoing.destroy()));
 for(let n=0;n<8;n++){
  const reading=new Promise(resolve=>f.server.once('request',incoming=>incoming.once('data',resolve)));
  const item=request(f.base,{path:'/api/register',headers:{'content-length':100},body:'{',partial:true});item.response.catch(()=>{});held.push(item);await reading;
 }
 let prepares=0;const original=f.db.prepare.bind(f.db);f.db.prepare=(...args)=>{prepares++;return original(...args);};
 const busy=await fetch(f.base+'/api/config');assert.equal(busy.status,503);assert.equal(busy.headers.get('retry-after'),'1');assert.equal(prepares,0,'overload must be rejected before consuming database slots');await busy.text();
 const health=await fetch(f.base+'/api/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
 const ready=await fetch(f.base+'/api/ready');assert.equal(ready.status,200);assert.equal((await ready.json()).ok,true);
 held.forEach(item=>item.outgoing.destroy());
});

test('large OSM import retains its bounded allowance and requires admin MFA before reading the body',async t=>{
 const f=await fixture(t,{REQUIRE_ADMIN_MFA:'true'}),user=actor(f.db,'body-player'),unverified=actor(f.db,'body-admin-unverified',{role:'admin',mfa:true}),admin=actor(f.db,'body-admin',{role:'admin',mfa:true,verified:true});
 const body=JSON.stringify({elements:[{type:'node',id:9999000001,lon:76.93,lat:43.24,tags:{name:'Проверка большого импорта'}}],padding:'x'.repeat(96*1024)});
 for(const [cookie,status] of [[undefined,401],[user,403],[unverified,423]]){
  const denied=request(f.base,{path:'/api/manage/osm',headers:{'content-length':Buffer.byteLength(body),...(cookie?{cookie}:{})},body:'{',partial:true});
  try{assert.equal((await denied.response).status,status);}finally{denied.outgoing.destroy();}
 }
 const accepted=await request(f.base,{path:'/api/manage/osm',headers:{cookie:admin},body}).response;assert.equal(accepted.status,200,JSON.stringify(accepted.body));assert.equal(accepted.body.inserted,1);
 const oversized=request(f.base,{path:'/api/manage/osm',headers:{cookie:admin,'content-length':8*1024*1024+1},partial:true});
 try{assert.equal((await oversized.response).status,413);}finally{oversized.outgoing.destroy();}
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM organizations WHERE osm_id=?').get('node/9999000001').n,1);
});
