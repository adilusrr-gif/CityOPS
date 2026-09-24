import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestDatabase} from './db-fixture.mjs';
import {createEnterpriseAuth} from '../../src/enterprise/auth.mjs';
import {hash,passwordHash} from '../../src/domain.mjs';
import {encryptSecret,generateTotpSecret,generateRecoveryCodes,hashRecoveryCode,totp} from '../../src/security.mjs';

const password='review-password-2026',digest=passwordHash(password);
test('PostgreSQL MFA treats JSON types as failed credentials, with atomic attempt accounting',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());t.diagnostic(`Database engine: ${f.engine}`);
 const keys={encryptionKey:randomBytes(32),auditKey:randomBytes(32)},cfg={keys,idleMs:1800000,nativeOrigins:[]};
 const auth=createEnterpriseAuth({db:f.db,cfg,env:{},throttle:async()=>{},audit:async()=>{}});
 async function fixture({enabled=true}={}){
  const uid=randomBytes(12).toString('hex'),secret=generateTotpSecret(),recovery=generateRecoveryCodes(1)[0],now=Date.now(),token=randomBytes(32).toString('hex'),challengeId=randomBytes(32).toString('hex');
  await f.db.run('INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled,mfa_secret,mfa_pending_secret,mfa_pending_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[uid,`${uid}@example.test`,'Review',digest,'player',now,enabled?1:0,enabled?encryptSecret(secret,keys.encryptionKey):null,enabled?null:encryptSecret(secret,keys.encryptionKey),enabled?null:now]);
  await f.db.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$2,$3,$4,$4,$5)',[hash(token),uid,now+600000,now,enabled?1:0]);
  await f.db.run('INSERT INTO login_challenges(id_hash,user_id,expires) VALUES($1,$2,$3)',[hash(challengeId),uid,now+60000]);
  await f.db.run('INSERT INTO recovery_codes(user_id,code_hash) VALUES($1,$2)',[uid,hashRecoveryCode(recovery)]);
  async function call(path,body){const req={method:'POST',headers:{authorization:`Bearer ${token}`,'x-cityquest-client':'native'}},headers=new Map(),res={setHeader(k,v){headers.set(k,v);},getHeader(k){return headers.get(k);}};return auth.handle({req,res,path,url:new URL(path,'http://localhost'),user:await auth.session(req),ip:'local',readBody:async()=>JSON.parse(JSON.stringify(body))});}
  return {uid,secret,recovery,challengeId,call};
 }
 await t.test('malformed login increments all five attempts and issues no session',async()=>{
  const u=await fixture();
  for(const [index,code] of [{toString:null},[totp(u.secret)],null,123456,'x'.repeat(129)].entries()){
   await assert.rejects(u.call('/api/auth/mfa/login',{challengeId:u.challengeId,code}),e=>e.status===401);
   assert.equal((await f.db.get('SELECT attempts FROM login_challenges WHERE user_id=$1',[u.uid])).attempts,index+1);
   assert.equal((await f.db.get('SELECT mfa_last_counter FROM users WHERE id=$1',[u.uid])).mfa_last_counter,-1);
  }
  await assert.rejects(u.call('/api/auth/mfa/login',{challengeId:u.challengeId,code:u.recovery}),e=>e.status===401);
  assert.equal((await f.db.get('SELECT used_at FROM recovery_codes WHERE user_id=$1',[u.uid])).used_at,null);
  assert.equal((await f.db.get('SELECT count(*)::int n FROM sessions WHERE user_id=$1',[u.uid])).n,1);
 });
 await t.test('enrollment rejects objects and arrays, then accepts a string TOTP',async()=>{
  const u=await fixture({enabled:false});
  for(const code of [{toString:null},[totp(u.secret)]])await assert.rejects(u.call('/api/auth/mfa/enable',{code}),e=>e.status===400);
  assert.equal((await f.db.get('SELECT mfa_enabled FROM users WHERE id=$1',[u.uid])).mfa_enabled,0);
  assert.ok((await u.call('/api/auth/mfa/enable',{code:totp(u.secret)})).recoveryCodes.length);
 });
 await t.test('disable rejects coerced recovery codes without consuming them',async()=>{
  const u=await fixture();
  for(const code of [{toString:null},[u.recovery]])await assert.rejects(u.call('/api/auth/mfa/disable',{password,code}),e=>e.status===401);
  assert.equal((await f.db.get('SELECT mfa_enabled FROM users WHERE id=$1',[u.uid])).mfa_enabled,1);
  assert.equal((await f.db.get('SELECT used_at FROM recovery_codes WHERE user_id=$1',[u.uid])).used_at,null);
  assert.deepEqual(await u.call('/api/auth/mfa/disable',{password,code:u.recovery}),{ok:true});
 });
});
