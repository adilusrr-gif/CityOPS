import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {randomBytes} from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {createAuth} from '../src/auth.mjs';
import {createPasswordService} from '../src/passwords.mjs';
import {id, hash, passwordHash} from '../src/domain.mjs';
import {appendAudit, decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, sealLegacyAudit, totp, verifyAudit} from '../src/security.mjs';

const PASSWORD = 'test-long-password-for-MFA-2026';
function fixture({passwordService}={}) {
  const db = openDb(':memory:', {withSnapshot: false});
  const keys = {encryptionKey: randomBytes(32), auditKey: randomBytes(32)};
  sealLegacyAudit(db, keys.auditKey);
  const userId = id(), sessionId = id(), token = randomBytes(32).toString('hex'), now = Date.now();
  db.prepare('INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run(userId, 'race@example.test', 'Race test', passwordHash(PASSWORD), 'player', now);
  db.prepare('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,0)').run(hash(token), sessionId, userId, now + 600000, now, now);
  let auditFailure = false;
  const auth = createAuth({db, passwordService, cfg: {keys, idleMs: 30 * 60000, secure: false, requireAdminMfa: false}, throttle() {}, audit(actor, action, target, metadata = {}) {
    if (auditFailure) throw new Error('Simulated audit failure');
    appendAudit(db, {actor, action, target, metadata}, keys.auditKey);
  }});
  function request(body, {signedIn = true, gate} = {}) {
    const req = Readable.from((async function* () {if (gate) await gate; yield Buffer.from(JSON.stringify(body));})());
    req.headers = signedIn ? {cookie: `aq_session=${token}`} : {};
    req.method = 'POST';
    const headers = new Map();
    return {req, response: {setHeader(name, value) {headers.set(name, value);}}, headers, snapshot: auth.session(req)};
  }
  function call(path, body, options) {
    const r = request(body, options);
    return auth.handle(r.req, r.response, new URL(path, 'http://test.local'), r.snapshot, '127.0.0.1');
  }
  function enabled() {
    const secret = generateTotpSecret(), codes = generateRecoveryCodes(2);
    db.prepare('UPDATE users SET mfa_enabled=1,mfa_secret=?,mfa_last_counter=-1 WHERE id=?').run(encryptSecret(secret, keys.encryptionKey), userId);
    for (const code of codes) db.prepare('INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?)').run(userId, hashRecoveryCode(code));
    return {secret, codes};
  }
  function challenge() {
    const value = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO login_challenges(id_hash,user_id,expires) VALUES(?,?,?)').run(hash(value), userId, Date.now() + 300000);
    return value;
  }
  return {db, keys, auth, userId, sessionId, call, request, enabled, challenge, failAudit(value) {auditFailure = value;}};
}

function gatedPasswords(){
 const actual=createPasswordService();let entered,release;
 const started=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 return {started,release,service:{hash:actual.hash,async verify(...args){const ok=await actual.verify(...args);entered();await gate;return ok;}}};
}

test('async login revalidates password and account state before issuing a session',async t=>{
 for(const change of ['password','disabled','mfa'])await t.test(change,async()=>{
  const gate=gatedPasswords(),f=fixture({passwordService:gate.service});
  try{
   const result=f.call('/api/login',{email:'race@example.test',password:PASSWORD},{signedIn:false});await gate.started;
   if(change==='password')f.db.prepare('UPDATE users SET password=? WHERE id=?').run(passwordHash('replacement-long-password'),f.userId);
   if(change==='disabled')f.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.userId);
   if(change==='mfa')f.enabled();
   gate.release();
   if(change==='mfa')assert.equal((await result).mfaRequired,true);else await assert.rejects(result,e=>e.status===401);
   assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get().n,1);
  }finally{gate.release();f.db.close();}
 });
});

test('revocation during asynchronous MFA password verification prevents mutation',async()=>{
 const gate=gatedPasswords(),f=fixture({passwordService:gate.service});
 try{
  const setting=f.call('/api/auth/mfa/setup',{password:PASSWORD});await gate.started;
  f.db.prepare('DELETE FROM sessions WHERE id=?').run(f.sessionId);gate.release();
  await assert.rejects(setting,e=>e.status===401);
  assert.equal(f.db.prepare('SELECT mfa_pending_secret FROM users WHERE id=?').get(f.userId).mfa_pending_secret,null);
 }finally{gate.release();f.db.close();}
});

test('registration race creates one account and duplicate gets a conflict',async()=>{
 const f=fixture();try{
  const body={email:'duplicate@example.test',password:PASSWORD,name:'Duplicate player'};
  const results=await Promise.allSettled([f.call('/api/register',body,{signedIn:false}),f.call('/api/register',body,{signedIn:false})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.status,409);
  assert.equal(f.db.prepare('SELECT count(*) n FROM users WHERE email=?').get(body.email).n,1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='auth.register'").get().n,1);
 }finally{f.db.close();}
});

test('failed login audit does not issue a session cookie or commit a session',async()=>{
 const f=fixture();try{
  const r=f.request({email:'race@example.test',password:PASSWORD},{signedIn:false});f.failAudit(true);
  await assert.rejects(f.auth.handle(r.req,r.response,new URL('/api/login','http://test.local'),null,'local'),/Simulated audit/);
  assert.equal(r.headers.has('Set-Cookie'),false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get().n,1);
 }finally{f.db.close();}
});

test('revoked in-flight session cannot revoke another session',async()=>{
 const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});
 try{
  const now=Date.now(),other=id();f.db.prepare('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,0)').run(hash('other-token'),other,f.userId,now+600000,now,now);
  const revoking=f.call('/api/auth/sessions/revoke',{allOthers:true},{gate});
  f.db.prepare('DELETE FROM sessions WHERE id=?').run(f.sessionId);release();
  await assert.rejects(revoking,e=>e.status===401);
  assert.ok(f.db.prepare('SELECT id FROM sessions WHERE id=?').get(other));
 }finally{release();f.db.close();}
});

test('concurrent MFA enable requests cannot overwrite an enabled secret with NULL', async () => {
  const f = fixture();
  try {
    const setup = await f.call('/api/auth/mfa/setup', {password: PASSWORD});
    let release; const gate = new Promise(resolve => {release = resolve;});
    const code = totp(setup.secret);
    const requests = [f.call('/api/auth/mfa/enable', {code}, {gate}), f.call('/api/auth/mfa/enable', {code}, {gate})];
    release();
    const results = await Promise.allSettled(requests);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    const user = f.db.prepare('SELECT * FROM users WHERE id=?').get(f.userId);
    assert.equal(user.mfa_enabled, 1);
    assert.equal(decryptSecret(user.mfa_secret, f.keys.encryptionKey), setup.secret);
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_codes').get().n, 10);
    assert.equal(verifyAudit(f.db, f.keys.auditKey).ok, true);
  } finally {f.db.close();}
});

test('an in-flight enable code cannot authenticate a replacement pending secret', async () => {
  const f = fixture();
  try {
    const old = await f.call('/api/auth/mfa/setup', {password: PASSWORD});
    let release; const gate = new Promise(resolve => {release = resolve;});
    const enabling = f.call('/api/auth/mfa/enable', {code: totp(old.secret)}, {gate});
    // Choose a different current code to avoid a one-in-a-million collision.
    let replacement;
    do {replacement = generateTotpSecret();} while ([-1, 0, 1].some(offset => totp(replacement, {now: Date.now() + offset * 30000}) === totp(old.secret)));
    f.db.prepare('UPDATE users SET mfa_pending_secret=?,mfa_pending_at=? WHERE id=?').run(encryptSecret(replacement, f.keys.encryptionKey), Date.now(), f.userId);
    release();
    await assert.rejects(enabling, /Неверный код/);
    assert.equal(f.db.prepare('SELECT mfa_enabled FROM users WHERE id=?').get(f.userId).mfa_enabled, 0);
  } finally {f.db.close();}
});

test('login challenge is single-use even with two different valid recovery codes', async () => {
  const f = fixture();
  try {
    const {codes} = f.enabled(), challengeId = f.challenge();
    const results = await Promise.allSettled(codes.map(code => f.call('/api/auth/mfa/login', {challengeId, code}, {signedIn: false})));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM login_challenges').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_codes WHERE used_at IS NOT NULL').get().n, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM sessions WHERE mfa_verified=1').get().n, 1);
  } finally {f.db.close();}
});

test('failed MFA attempts commit and lock the challenge after five tries', async () => {
  const f = fixture();
  try {
    const {codes} = f.enabled(), challengeId = f.challenge();
    for (let attempt = 1; attempt <= 5; attempt++) {
      await assert.rejects(f.call('/api/auth/mfa/login', {challengeId, code: 'invalid'}, {signedIn: false}), /Неверный/);
      assert.equal(f.db.prepare('SELECT attempts FROM login_challenges').get().attempts, attempt);
    }
    await assert.rejects(f.call('/api/auth/mfa/login', {challengeId, code: codes[0]}, {signedIn: false}), /истекло/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_codes WHERE used_at IS NOT NULL').get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) n FROM audit WHERE action='auth.mfa_failed'").get().n, 5);
  } finally {f.db.close();}
});

test('audit failure rolls back MFA login counter, challenge and newly issued session', async () => {
  const f = fixture();
  try {
    const {codes} = f.enabled(), challengeId = f.challenge();
    f.failAudit(true);
    await assert.rejects(f.call('/api/auth/mfa/login', {challengeId, code: codes[0]}, {signedIn: false}), /Simulated audit/);
    assert.equal(f.db.prepare('SELECT attempts FROM login_challenges').get().attempts, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_codes WHERE used_at IS NOT NULL').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get().n, 1);
    f.failAudit(false);
    assert.ok((await f.call('/api/auth/mfa/login', {challengeId, code: codes[0]}, {signedIn: false})).user);
  } finally {f.db.close();}
});

test('revoked in-flight session cannot enable MFA', async () => {
  const f = fixture();
  try {
    const setup = await f.call('/api/auth/mfa/setup', {password: PASSWORD});
    let release; const gate = new Promise(resolve => {release = resolve;});
    const enabling = f.call('/api/auth/mfa/enable', {code: totp(setup.secret)}, {gate});
    f.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.userId);
    release();
    await assert.rejects(enabling, /Войдите/);
    assert.equal(f.db.prepare('SELECT mfa_enabled FROM users WHERE id=?').get(f.userId).mfa_enabled, 0);
  } finally {f.db.close();}
});

test('MFA disable and recovery consumption roll back together on audit failure', async () => {
  const f = fixture();
  try {
    const {codes} = f.enabled(); f.challenge();
    f.failAudit(true);
    await assert.rejects(f.call('/api/auth/mfa/disable', {password: PASSWORD, code: codes[0]}), /Simulated audit/);
    assert.equal(f.db.prepare('SELECT mfa_enabled FROM users WHERE id=?').get(f.userId).mfa_enabled, 1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_codes WHERE used_at IS NOT NULL').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM login_challenges').get().n, 1);
    f.failAudit(false);
    assert.deepEqual(await f.call('/api/auth/mfa/disable', {password: PASSWORD, code: codes[0]}), {ok: true});
    assert.equal(f.db.prepare('SELECT mfa_enabled FROM users WHERE id=?').get(f.userId).mfa_enabled, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM login_challenges').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM recovery_codes').get().n, 0);
  } finally {f.db.close();}
});
