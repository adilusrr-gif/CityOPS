import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createTestDatabase} from './db-fixture.mjs';
import {encryptSecret,generateTotpSecret} from '../../src/security.mjs';
import {encryptPetText} from '../../src/features/pet-crypto.mjs';
import {inspectEncryption,requireValidEncryption} from '../../src/key-check.mjs';
import {createEnterpriseApp} from '../../src/enterprise/server.mjs';

test('PostgreSQL release encryption inspection is bounded, read-only and includes late composite-key pages',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());const key=randomBytes(32),wrong=randomBytes(32);
 await f.db.run("INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled,mfa_secret) VALUES('owner','owner@company.kz','Owner','unused','admin',1,1,$1)",[encryptSecret(generateTotpSecret(),key)]);
 await f.db.transaction(async tx=>{
  for(let i=0;i<251;i++){
   const id=String(i).padStart(3,'0');
   await tx.run("INSERT INTO pet_chat_requests(user_id,request_id,request_hash,status,epoch,mode,reply_cipher,created_at,expires_at) VALUES('owner',$1,'hash','complete',0,'offline',$2,1,9999999999999)",[id,encryptPetText('private reply',key,`owner:request:${id}`)]);
  }
 });
 const clean=await f.db.transaction(async tx=>{await tx.query('SET TRANSACTION READ ONLY');return inspectEncryption(tx,'postgres',key);});
 assert.deepEqual(clean,{checked:252,invalid:0,invalidMfaAccounts:0,sampled:false});
 await f.db.run("UPDATE pet_chat_requests SET reply_cipher=$1 WHERE request_id='250'",[encryptPetText('wrong context',key,'owner:request:000')]);
 assert.equal((await inspectEncryption(f.db,'postgres',key,{sample:true})).invalid,0);
 assert.equal((await inspectEncryption(f.db,'postgres',key)).invalid,1);
 const replaced=await inspectEncryption(f.db,'postgres',wrong,{sample:true});assert.equal(replaced.invalid,2);
 assert.throws(()=>requireValidEncryption(replaced),/DATA_ENCRYPTION_KEY/);
 assert.equal((await f.db.get('SELECT count(*) n FROM pet_chat_requests')).n,251);
 await f.db.run('UPDATE users SET mfa_secret=NULL');
 assert.equal((await inspectEncryption(f.db,'postgres',key,{sample:true})).invalidMfaAccounts,1);
});

test('PostgreSQL application refuses an accidentally replaced encryption key at startup',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());const key=randomBytes(32);
 await f.db.run("INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled,mfa_secret) VALUES('owner','owner@company.kz','Owner','unused','admin',1,1,$1)",[encryptSecret(generateTotpSecret(),key)]);
 await assert.rejects(()=>createEnterpriseApp({db:f.db,env:{},keys:{encryptionKey:randomBytes(32),auditKey:randomBytes(32)},secure:false}),/DATA_ENCRYPTION_KEY/);
 assert.equal((await f.db.get('SELECT count(*) n FROM users')).n,1,'caller-owned database is not closed by a rejected startup');
});
