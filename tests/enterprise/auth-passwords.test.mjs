import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestDatabase} from './db-fixture.mjs';
import {createEnterpriseAuth} from '../../src/enterprise/auth.mjs';
import {createPasswordService} from '../../src/passwords.mjs';
import {passwordHash} from '../../src/domain.mjs';
import {appendAudit} from '../../src/enterprise/security-store.mjs';

const password='async-password-test-2026';
const cfg={secure:false,origin:'http://localhost',keys:{encryptionKey:randomBytes(32),auditKey:randomBytes(32)},idleMs:1800000,nativeOrigins:[],requireAdminMfa:true};
function response(){const headers=new Map();return {setHeader(k,v){headers.set(k,v);},getHeader(k){return headers.get(k);}};}

test('PostgreSQL auth derives passwords outside transactions and rechecks credentials and live sessions',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());t.diagnostic(`Database engine: ${f.engine}`);
 let inTransaction=false,gate,started,enter,release,failAudit=false;
 const wrapped={...f.db,async transaction(callback){return f.db.transaction(async tx=>{inTransaction=true;try{return await callback(tx);}finally{inTransaction=false;}});}};
 const actual=createPasswordService();
 const service={async hash(...args){assert.equal(inTransaction,false,'KDF must not hold database transaction');return actual.hash(...args);},async verify(...args){assert.equal(inTransaction,false,'KDF must not hold database transaction');const ok=await actual.verify(...args);if(gate){enter();await gate;}return ok;}};
 const auth=createEnterpriseAuth({db:wrapped,cfg,env:{},passwordService:service,throttle:async()=>{},audit:async(tx,actor,action,target,metadata={})=>{if(failAudit)throw new Error('audit unavailable');return appendAudit(tx,{actor,action,target,metadata},cfg.keys.auditKey);}});
 async function call(path,body={},token){const req={method:'POST',headers:{'x-cityquest-client':'native',...(token?{authorization:`Bearer ${token}`}:{})}},res=response();return auth.handle({req,res,path,method:'POST',url:new URL(path,cfg.origin),user:await auth.session(req),ip:'local',readBody:async()=>body});}
 function gateNext(){started=new Promise(resolve=>{enter=resolve;});gate=new Promise(resolve=>{release=resolve;});}
 function ungate(){release?.();gate=null;}
 t.after(ungate);
 const account=await call('/api/register',{name:'Async passwords',email:'async@example.test',password});

 await t.test('password replacement during KDF cannot create a session',async()=>{
  gateNext();const pending=call('/api/login',{email:account.user.email,password});await started;
  const count=(await f.db.get('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[account.user.id])).n;
  await f.db.run('UPDATE users SET password=$1 WHERE id=$2',[passwordHash('replacement-password-2026'),account.user.id]);ungate();
  await assert.rejects(pending,e=>e.status===401);
  assert.equal((await f.db.get('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[account.user.id])).n,count);
  await f.db.run('UPDATE users SET password=$1 WHERE id=$2',[passwordHash(password),account.user.id]);
 });
 await t.test('SSO-only conversion during KDF prevents password login',async()=>{
  gateNext();const pending=call('/api/login',{email:account.user.email,password});await started;
  await f.db.run('UPDATE users SET password_login_enabled=0 WHERE id=$1',[account.user.id]);ungate();
  await assert.rejects(pending,e=>e.status===401);
  await f.db.run('UPDATE users SET password_login_enabled=1 WHERE id=$1',[account.user.id]);
 });
 await t.test('MFA setup revalidates a session revoked during KDF',async()=>{
  gateNext();const pending=call('/api/auth/mfa/setup',{password},account.accessToken);await started;
  await f.db.run('DELETE FROM sessions WHERE user_id=$1',[account.user.id]);ungate();
  await assert.rejects(pending,e=>e.status===401);
  assert.equal((await f.db.get('SELECT mfa_pending_secret FROM users WHERE id=$1',[account.user.id])).mfa_pending_secret,null);
 });
 await t.test('concurrent registration gives one account and one conflict',async()=>{
  const body={name:'Duplicate',email:'async-duplicate@example.test',password};
  const results=await Promise.allSettled([call('/api/register',body),call('/api/register',body)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  assert.equal((await f.db.get('SELECT count(*)::int n FROM users WHERE email=$1',[body.email])).n,1);
 });
 await t.test('failed login audit rolls back session creation',async()=>{
  failAudit=true;
  try{await assert.rejects(call('/api/login',{email:account.user.email,password}),/audit unavailable/);}
  finally{failAudit=false;}
  assert.equal((await f.db.get('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[account.user.id])).n,0);
 });
});
