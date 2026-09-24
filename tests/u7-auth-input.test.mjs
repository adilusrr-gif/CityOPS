import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Readable} from 'node:stream';
import {openDb} from '../src/db.mjs';
import {createAuth} from '../src/auth.mjs';
import {hash,passwordHash} from '../src/domain.mjs';
import {encryptSecret,generateTotpSecret,generateRecoveryCodes,hashRecoveryCode,totp} from '../src/security.mjs';

const password='review-password-2026',digest=passwordHash(password);
function fixture(t,{enabled=true}={}){
 const db=openDb(':memory:',{withSnapshot:false});t.after(()=>db.close());
 const keys={encryptionKey:randomBytes(32),auditKey:randomBytes(32)},secret=generateTotpSecret(),recovery=generateRecoveryCodes(1)[0],now=Date.now(),token=randomBytes(32).toString('hex'),challengeId=randomBytes(32).toString('hex');
 db.prepare('INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled,mfa_secret,mfa_pending_secret,mfa_pending_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('u','review@example.test','Review',digest,'player',now,enabled?1:0,enabled?encryptSecret(secret,keys.encryptionKey):null,enabled?null:encryptSecret(secret,keys.encryptionKey),enabled?null:now);
 db.prepare('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,?)').run(hash(token),'s','u',now+600000,now,now,enabled?1:0);
 db.prepare('INSERT INTO login_challenges(id_hash,user_id,expires) VALUES(?,?,?)').run(hash(challengeId),'u',now+60000);
 db.prepare('INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?)').run('u',hashRecoveryCode(recovery));
 const auth=createAuth({db,cfg:{keys,idleMs:1800000},throttle(){},audit(){}});
 async function call(path,body){const req=Readable.from([JSON.stringify(body)]);req.method='POST';req.headers={cookie:`aq_session=${token}`};return auth.handle(req,{setHeader(){}},new URL(path,'http://localhost'),auth.session(req),'local');}
 return {db,secret,recovery,challengeId,call};
}

test('MFA malformed JSON credentials are denied and consume login challenge attempts',async t=>{
 const f=fixture(t);
 for(const [index,code] of [{toString:null},[totp(f.secret)],null,123456,'x'.repeat(129)].entries()){
  await assert.rejects(f.call('/api/auth/mfa/login',{challengeId:f.challengeId,code}),e=>e.status===401);
  assert.equal(f.db.prepare('SELECT attempts FROM login_challenges').get().attempts,index+1);
  assert.equal(f.db.prepare('SELECT mfa_last_counter FROM users WHERE id=?').get('u').mfa_last_counter,-1);
 }
 await assert.rejects(f.call('/api/auth/mfa/login',{challengeId:f.challengeId,code:f.recovery}),e=>e.status===401);
 assert.equal(f.db.prepare('SELECT used_at FROM recovery_codes').get().used_at,null);
 assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get().n,1);
});

test('MFA enrollment rejects objects and arrays without enabling a factor',async t=>{
 const f=fixture(t,{enabled:false});
 for(const code of [{toString:null},[totp(f.secret)]])await assert.rejects(f.call('/api/auth/mfa/enable',{code}),e=>e.status===400);
 assert.equal(f.db.prepare('SELECT mfa_enabled FROM users WHERE id=?').get('u').mfa_enabled,0);
 assert.ok((await f.call('/api/auth/mfa/enable',{code:totp(f.secret)})).recoveryCodes.length);
});

test('MFA disable rejects coerced recovery codes and preserves the valid recovery code',async t=>{
 const f=fixture(t);
 for(const code of [{toString:null},[f.recovery]])await assert.rejects(f.call('/api/auth/mfa/disable',{password,code}),e=>e.status===401);
 assert.equal(f.db.prepare('SELECT mfa_enabled FROM users WHERE id=?').get('u').mfa_enabled,1);
 assert.equal(f.db.prepare('SELECT used_at FROM recovery_codes').get().used_at,null);
 assert.deepEqual(await f.call('/api/auth/mfa/disable',{password,code:f.recovery}),{ok:true});
});
