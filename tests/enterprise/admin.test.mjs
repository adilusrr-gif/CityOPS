import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './db-fixture.mjs';
import {provisionAdmin} from '../../scripts/admin-postgres.mjs';
import {passwordOK} from '../../src/domain.mjs';
import {verifyAudit} from '../../src/enterprise/security-store.mjs';
const keys={encryptionKey:Buffer.alloc(32,17),auditKey:Buffer.alloc(32,18)},password='Operator-test-password-v3';
test('PostgreSQL operator bootstrap is idempotent and credential reset preserves MFA and disabled state',async t=>{
 const f=await createTestDatabase();t.after(f.close);t.diagnostic('SQL engine: '+f.engine);
 const first=await provisionAdmin({db:f.db,email:'admin@example.test',password,keys,bootstrap:true});assert.equal(first.created,true);
 assert.equal((await provisionAdmin({db:f.db2,email:'second@example.test',password,keys,bootstrap:true})).skipped,true);
 await f.db.run('UPDATE users SET mfa_enabled=1,mfa_secret=$1,disabled=1 WHERE id=$2',['opaque-existing-secret',first.id]);
 await f.db.run('INSERT INTO sessions(token,id,user_id,expires,last_seen) VALUES($1,$2,$3,$4,$5)',['opaque-test-token','session-one',first.id,Date.now()+100000,Date.now()]);
 await f.db.run('INSERT INTO mobile_auth_codes(code_hash,user_id,code_challenge,expires,created_at) VALUES($1,$2,$3,$4,$5)',['pending-code',first.id,'challenge',Date.now()+10000,Date.now()]);
 await provisionAdmin({db:f.db2,email:'admin@example.test',password:password+'2',keys});
 const row=await f.db.get('SELECT * FROM users WHERE id=$1',[first.id]);assert.equal(row.mfa_enabled,1);assert.equal(row.mfa_secret,'opaque-existing-secret');assert.equal(row.disabled,1);assert.equal(passwordOK(password+'2',row.password),true);
 assert.equal(Number((await f.db.get('SELECT count(*) n FROM sessions')).n),0);assert.equal(Number((await f.db.get('SELECT count(*) n FROM mobile_auth_codes')).n),0);
 assert.equal((await verifyAudit(f.db,keys.auditKey)).ok,true);
 await provisionAdmin({db:f.db,email:'admin@example.test',password:password+'3',keys,resetMfa:true});assert.equal((await f.db.get('SELECT mfa_enabled FROM users WHERE id=$1',[first.id])).mfa_enabled,0);
});
test('operator refuses a damaged audit before resetting credentials',async t=>{
 const f=await createTestDatabase();t.after(f.close);
 const first=await provisionAdmin({db:f.db,email:'admin@example.test',password,keys,bootstrap:true});
 const before=await f.db.get('SELECT password FROM users WHERE id=$1',[first.id]);await f.db.run("UPDATE audit SET action='tampered' WHERE id=1");
 await assert.rejects(()=>provisionAdmin({db:f.db,email:'admin@example.test',password:password+'2',keys}),/integrity/);
 assert.deepEqual(await f.db.get('SELECT password FROM users WHERE id=$1',[first.id]),before);
});
