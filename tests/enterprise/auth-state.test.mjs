import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestDatabase} from './db-fixture.mjs';
import {createEnterpriseAuth} from '../../src/enterprise/auth.mjs';
import {appendAudit,verifyAudit} from '../../src/enterprise/security-store.mjs';
import {totp} from '../../src/security.mjs';
import {hash} from '../../src/domain.mjs';
import {linkIdentity} from '../../scripts/link-oidc.mjs';

function res(){const h=new Map();return {setHeader(k,v){h.set(k,v);},getHeader(k){return h.get(k);}};}
const keys={encryptionKey:randomBytes(32),auditKey:randomBytes(32)};
const cfg={secure:false,origin:'http://localhost',keys,idleMs:1800000,nativeOrigins:[],requireAdminMfa:true};
const password='state-test-long-password';

test('shared auth state preserves MFA attempts, setup atomicity and operator identity linking',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());t.diagnostic(`Database engine: ${f.engine}`);
 const audit=(tx,actor,action,target,metadata={})=>appendAudit(tx,{actor,action,target,metadata},keys.auditKey);
 const auth1=createEnterpriseAuth({db:f.db,cfg,env:{},audit,throttle:async()=>{}}),auth2=createEnterpriseAuth({db:f.db2,cfg,env:{},audit,throttle:async()=>{}});
 async function call(auth,path,body={},token){const req={method:'POST',headers:{'x-cityquest-client':'native',...(token?{authorization:`Bearer ${token}`}:{})}},response=res();return auth.handle({req,res:response,path,method:'POST',url:new URL(path,cfg.origin),user:await auth.session(req),ip:'local',readBody:async()=>body});}
 const user=await call(auth1,'/api/register',{name:'MFA atomicity',email:'atomicity@example.com',password}),token=user.accessToken;
 let recovery;
 await t.test('simultaneous MFA enable retains secret and one recovery set',async()=>{
  const pending=await call(auth1,'/api/auth/mfa/setup',{password},token);
  await f.db.run('INSERT INTO mobile_auth_codes(code_hash,user_id,code_challenge,expires,created_at) VALUES($1,$2,$3,$4,$5)',[hash('pending-before-mfa'),user.user.id,'x'.repeat(43),Date.now()+120000,Date.now()]);
  const results=await Promise.allSettled([call(auth1,'/api/auth/mfa/enable',{code:totp(pending.secret)},token),call(auth2,'/api/auth/mfa/enable',{code:totp(pending.secret)},token)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);recovery=results.find(r=>r.status==='fulfilled').value.recoveryCodes;
  const stored=await f.db.get('SELECT mfa_enabled,mfa_secret,mfa_pending_secret FROM users WHERE id=$1',[user.user.id]);assert.equal(stored.mfa_enabled,1);assert.ok(stored.mfa_secret);assert.equal(stored.mfa_pending_secret,null);assert.equal((await f.db.get('SELECT COUNT(*)::integer AS n FROM recovery_codes WHERE user_id=$1',[user.user.id])).n,recovery.length);assert.equal((await f.db.get('SELECT COUNT(*)::integer AS n FROM mobile_auth_codes WHERE user_id=$1',[user.user.id])).n,0);
 });
 await t.test('MFA failed attempts commit and lock challenge even with correct recovery later',async()=>{
  const login=await call(auth2,'/api/login',{email:user.user.email,password});assert.equal(login.mfaRequired,true);
  for(let attempt=0;attempt<5;attempt++)await assert.rejects(call(auth1,'/api/auth/mfa/login',{challengeId:login.challengeId,code:'invalid-format'}),e=>e.status===401);
  const c=await f.db.get('SELECT attempts FROM login_challenges WHERE id_hash=$1',[hash(login.challengeId)]);assert.equal(c.attempts,5);
  await assert.rejects(call(auth2,'/api/auth/mfa/login',{challengeId:login.challengeId,code:recovery[0]}),e=>e.status===401);
  assert.equal((await f.db.get('SELECT used_at FROM recovery_codes WHERE user_id=$1 AND code_hash IS NOT NULL LIMIT 1',[user.user.id])).used_at,null);
  const newLogin=await call(auth1,'/api/login',{email:user.user.email,password});const completed=await call(auth2,'/api/auth/mfa/login',{challengeId:newLogin.challengeId,code:recovery[0]});assert.equal(completed.user.id,user.user.id);
 });
 await t.test('revoke all other sessions also invalidates pending login and mobile continuations',async()=>{
  const pending=await call(auth1,'/api/login',{email:user.user.email,password});assert.equal(pending.mfaRequired,true);
  await f.db.run('INSERT INTO mobile_auth_codes(code_hash,user_id,code_challenge,expires,created_at) VALUES($1,$2,$3,$4,$5)',[hash('pending-before-revoke'),user.user.id,'x'.repeat(43),Date.now()+120000,Date.now()]);
  await call(auth2,'/api/auth/sessions/revoke',{allOthers:true},token);
  assert.equal((await f.db.get('SELECT COUNT(*)::integer AS n FROM login_challenges WHERE user_id=$1',[user.user.id])).n,0);assert.equal((await f.db.get('SELECT COUNT(*)::integer AS n FROM mobile_auth_codes WHERE user_id=$1',[user.user.id])).n,0);
  assert.ok(await auth1.session({headers:{authorization:`Bearer ${token}`}}));
 });
 await t.test('explicit operator links exact issuer/subject, preserves MFA/role and revokes sessions',async()=>{
  const issuer='https://identity.example.test/realms/quest',subject=' specific-subject ';await f.db.run("UPDATE users SET role='admin' WHERE id=$1",[user.user.id]);
  const linked=await linkIdentity(f.db,{issuer,subject,email:user.user.email,auditKey:keys.auditKey});assert.equal(linked.role,'admin');assert.equal(linked.mfaEnabled,true);
  assert.equal((await f.db.get('SELECT COUNT(*)::integer AS n FROM sessions WHERE user_id=$1',[user.user.id])).n,0);assert.equal((await f.db.get('SELECT COUNT(*)::integer AS n FROM login_challenges WHERE user_id=$1',[user.user.id])).n,0);
  await assert.rejects(linkIdentity(f.db2,{issuer,subject,email:user.user.email,auditKey:keys.auditKey}),/already linked/);
  const linkedRow=await f.db.get('SELECT * FROM oidc_identities WHERE issuer=$1 AND subject=$2',[issuer,subject]);assert.equal(linkedRow.user_id,user.user.id);assert.equal((await verifyAudit(f.db,keys.auditKey)).ok,true);
 });
});
