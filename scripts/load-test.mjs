import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir,platform,arch,cpus} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';

const paths=['/api/health','/api/config','/api/quests','/api/organizations'];
const numeric=(value,name,min,max)=>{const number=Number(value);if(!Number.isFinite(number)||number<min||number>max)throw new Error(`${name} must be between ${min} and ${max}`);return number;};
export function distribution(values){
 if(!values.length)return {samples:0,minMs:null,p50Ms:null,p95Ms:null,p99Ms:null,maxMs:null,meanMs:null};
 const sorted=[...values].sort((a,b)=>a-b),round=n=>Number(n.toFixed(2)),at=p=>round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]);
 return {samples:sorted.length,minMs:round(sorted[0]),p50Ms:at(.5),p95Ms:at(.95),p99Ms:at(.99),maxMs:round(sorted.at(-1)),meanMs:round(sorted.reduce((a,b)=>a+b,0)/sorted.length)};
}

export async function runLoadTest({url,concurrency=4,duration=10,city='almaty',rps=8,allowRemote=false,timeout=5000}={}){
 concurrency=numeric(concurrency,'concurrency',1,200);if(!Number.isInteger(concurrency))throw new Error('concurrency must be an integer');
 duration=numeric(duration,'duration',.1,3600);rps=numeric(rps,'rps',0,10000);timeout=numeric(timeout,'timeout',100,30000);
 if(!['almaty','astana'].includes(city))throw new Error('city must be almaty or astana');
 let folder,app,target,fixture=null;
 try{
  if(!url){
   if(process.env.NODE_ENV==='production')throw new Error('Ephemeral load fixture must run with NODE_ENV=development; specify --url for an existing server');
   folder=await mkdtemp(join(tmpdir(),'cityquest-load-'));
   const [{openDb},{createApp}]=await Promise.all([import('../src/db.mjs'),import('../src/server.mjs')]);
   const db=openDb(join(folder,'test.sqlite'));
   try{app=createApp({db,secure:false,origin:undefined});}catch(error){db.close();throw error;}
   await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
   url=`http://127.0.0.1:${app.server.address().port}`;
   fixture={organizations:db.prepare('SELECT count(*) n FROM organizations').get().n,quests:db.prepare('SELECT count(*) n FROM quests').get().n,sameProcess:true};
  }
  target=new URL(url);
  if(!['http:','https:'].includes(target.protocol)||target.username||target.password||target.search||target.hash||target.pathname!=='/')throw new Error('--url must be an HTTP(S) origin without credentials, query or path');
  if(!allowRemote&&!['127.0.0.1','localhost','[::1]'].includes(target.hostname))throw new Error('Only loopback URLs are allowed by default; --allow-remote requires an explicitly authorized system');
  const totals={requests:0,successes:0,errors:0,statuses:{},networkErrors:0,invalidResponses:0,bytes:0};
  const perPath=Object.fromEntries(paths.map(path=>[path,{requests:0,errors:0,latencies:[],statuses:{}}]));
  const latencies=[],startedAt=new Date().toISOString(),start=performance.now(),deadline=start+duration*1000;let next=start,sequence=0;
  async function worker(){
   while(performance.now()<deadline&&sequence<1000000){
    const slot=next;if(rps>0)next+=1000/rps;
    if(slot>=deadline)break;if(rps>0&&slot>performance.now())await delay(slot-performance.now());
    if(performance.now()>=deadline)break;
    const path=paths[sequence++%paths.length],stats=perPath[path],address=new URL(path,target);address.searchParams.set('city',city);
    const started=performance.now();let status='network',failed=false;
    try{
     const response=await fetch(address,{redirect:'error',signal:AbortSignal.timeout(timeout)});status=String(response.status);
     const bytes=await response.arrayBuffer();totals.bytes+=bytes.byteLength;
     if(!response.ok)failed=true;
     else{
      try{const data=JSON.parse(Buffer.from(bytes).toString());if(path==='/api/health'&&data.ok!==true)throw new Error('health');if(['/api/quests','/api/organizations'].includes(path)&&!Array.isArray(data.items))throw new Error('items');}
      catch{totals.invalidResponses++;failed=true;}
     }
    }catch{totals.networkErrors++;failed=true;}
    const elapsed=performance.now()-started;latencies.push(elapsed);stats.latencies.push(elapsed);stats.requests++;totals.requests++;
    totals.statuses[status]=(totals.statuses[status]||0)+1;stats.statuses[status]=(stats.statuses[status]||0)+1;
    if(failed){totals.errors++;stats.errors++;}else totals.successes++;
   }
  }
  await Promise.all(Array.from({length:concurrency},worker));
  const elapsed=(performance.now()-start)/1000;
  return {format:'cityquest-load-report-v1',startedAt,target:target.origin,city,concurrency,requestedDurationSeconds:duration,elapsedSeconds:Number(elapsed.toFixed(3)),requestedRps:rps||'unlimited',fixture,runtime:{node:process.version,platform:platform(),arch:arch(),logicalCpus:cpus().length},...totals,requestsPerSecond:Number((totals.requests/elapsed).toFixed(2)),errorRate:totals.requests?totals.errors/totals.requests:0,latency:distribution(latencies),endpoints:Object.fromEntries(Object.entries(perPath).map(([path,stats])=>[path,{requests:stats.requests,errors:stats.errors,statuses:stats.statuses,latency:distribution(stats.latencies)}])),scope:'Anonymous GET requests only; no map tiles, browser rendering, writes, login, multiplayer, durability or capacity/SLA claims. Latency includes errors and full response body; fixed concurrency may limit requested RPS. Ephemeral mode shares the load generator process with the application.'};
 }finally{
  if(app){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.db.close();}
  if(folder)await rm(folder,{recursive:true,force:true});
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const {values}=parseArgs({options:{url:{type:'string'},concurrency:{type:'string'},duration:{type:'string'},city:{type:'string'},rps:{type:'string'},timeout:{type:'string'},output:{type:'string'},'allow-remote':{type:'boolean'},help:{type:'boolean'}}});
  if(values.help)console.log('Usage: node scripts/load-test.mjs [--url http://127.0.0.1:3000] [--concurrency 4] [--duration 10] [--city almaty|astana] [--rps 8] [--timeout 5000] [--output NEW_REPORT.json]\nWithout --url, starts and removes an isolated temporary fixture. Remote targets require --allow-remote and owner authorization.');
  else{
   const report=await runLoadTest({...values,allowRemote:values['allow-remote']});const json=JSON.stringify(report,null,2)+'\n';
   if(values.output){const output=resolve(values.output);await mkdir(dirname(output),{recursive:true});await writeFile(output,json,{flag:'wx',mode:0o600});}
   console.log(json);if(!report.requests||report.errors)process.exitCode=1;
  }
 }catch(error){console.error(`Load test failed: ${error.message}`);process.exitCode=1;}
}
