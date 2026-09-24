import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestDatabase} from './db-fixture.mjs';
import {createEnterpriseAuth} from '../../src/enterprise/auth.mjs';
import {hash} from '../../src/domain.mjs';

const cfg={idleMs:1800000,keys:{encryptionKey:randomBytes(32),auditKey:randomBytes(32)},nativeOrigins:[],requireAdminMfa:false};
const noAudit=async()=>{},noThrottle=async()=>{};

test('PostgreSQL session touches respect revocation and bounded replica clock skew',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());t.diagnostic(`Database engine: ${f.engine}; deterministic application barriers, not native lock contention`);
 let now=Date.now();t.mock.method(Date,'now',()=>now);
 async function account({lastSeen=now,expires=now+600000}={}){
  const uid=randomBytes(12).toString('hex'),token=randomBytes(32).toString('hex');
  await f.db.run('INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',[uid,`${uid}@example.test`,'Session review','disabled:test','player',now]);
  await f.db.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$2,$3,$4,$5,0)',[hash(token),uid,expires,now,lastSeen]);
  return {uid,token,req:{headers:{authorization:`Bearer ${token}`}}};
 }
 const create=db=>createEnterpriseAuth({db,cfg,env:{},audit:noAudit,throttle:noThrottle});
 const auth=create(f.db);
 for(const change of ['revoked','disabled','expired'])await t.test(`${change} during the asynchronous activity touch returns no actor`,async()=>{
  const u=await account({lastSeen:now-16000,expires:now+1000});
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  async function intercepted(method,sql,params){
   if(/^UPDATE sessions(?: s)? SET last_seen=/.test(sql)){enter();await gate;}
   return f.db[method](sql,params);
  }
  const wrapped={...f.db,get:(sql,params)=>intercepted('get',sql,params),run:(sql,params)=>intercepted('run',sql,params)};
  const checking=create(wrapped).session(u.req);await entered;
  try{
   if(change==='revoked')await f.db2.run('DELETE FROM sessions WHERE user_id=$1',[u.uid]);
   if(change==='disabled')await f.db2.run('UPDATE users SET disabled=1 WHERE id=$1',[u.uid]);
   if(change==='expired')now+=1001;
  }finally{release();}
  assert.equal(await checking,null);
 });
 await t.test('a simultaneous newer touch keeps authentication and never moves activity backward',async()=>{
  const u=await account({lastSeen:now-16000});
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const wrapped={...f.db,async get(sql,params){if(/^UPDATE sessions(?: s)? SET last_seen=/.test(sql)){enter();await gate;}return f.db.get(sql,params);}};
  const checking=create(wrapped).session(u.req);await entered;
  try{await f.db2.run('UPDATE sessions SET last_seen=$1 WHERE user_id=$2',[now+250,u.uid]);}finally{release();}
  assert.equal((await checking)?.id,u.uid);
  assert.equal((await f.db.get('SELECT last_seen FROM sessions WHERE id=$1',[u.uid])).last_seen,now+250);
 });
 await t.test('an expired snapshot cannot delete activity renewed by another replica',async()=>{
  const u=await account({lastSeen:now-cfg.idleMs});
  let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const wrapped={...f.db,async run(sql,params){if(/^DELETE FROM sessions WHERE token=/.test(sql)){enter();await gate;}return f.db.run(sql,params);}};
  const checking=create(wrapped).session(u.req);await entered;
  try{await f.db2.run('UPDATE sessions SET last_seen=$1 WHERE user_id=$2',[now,u.uid]);}finally{release();}
  assert.equal(await checking,null);
  assert.equal((await auth.session(u.req))?.id,u.uid);
 });
 await t.test('a 250 ms clock difference between replicas preserves the shared session',async()=>{
  const u=await account({lastSeen:now+250});
  assert.equal((await auth.session(u.req))?.id,u.uid);
  assert.ok(await f.db.get('SELECT id FROM sessions WHERE id=$1',[u.uid]));
  const actor=await auth.session(u.req);
  await f.db.transaction(async tx=>assert.equal((await auth.freshActor(tx,actor)).id,u.uid));
 });
 await t.test('future session activity beyond the skew allowance is rejected and removed',async()=>{
  const u=await account({lastSeen:now+5001});
  assert.equal(await auth.session(u.req),null);
  assert.equal(await f.db.get('SELECT id FROM sessions WHERE id=$1',[u.uid]),undefined);
 });
});
