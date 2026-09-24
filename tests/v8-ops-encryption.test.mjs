import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../src/db.mjs';
import {encryptSecret,generateTotpSecret} from '../src/security.mjs';
import {encryptPetText} from '../src/features/pet-crypto.mjs';
import {inspectEncryptionSync,requireValidEncryption} from '../src/key-check.mjs';
import {runCheck} from '../scripts/production-check.mjs';
import {createApp} from '../src/server.mjs';

const key=randomBytes(32),otherKey=randomBytes(32);
function fixture(t){const db=openDb(':memory:',{withSnapshot:false});t.after(()=>db.close());db.prepare("INSERT INTO users(id,email,name,password,role,created_at) VALUES('owner','owner@company.kz','Owner','unused','admin',1)").run();return db;}

test('startup encryption sample rejects replaced keys and enabled MFA without valid secret',t=>{
 const db=fixture(t);
 db.prepare('UPDATE users SET mfa_enabled=1,mfa_secret=?,mfa_pending_secret=?').run(encryptSecret(generateTotpSecret(),key),encryptSecret(generateTotpSecret(),key));
 assert.equal(requireValidEncryption(inspectEncryptionSync(db,key,{sample:true})).checked,2);
 const wrong=inspectEncryptionSync(db,otherKey,{sample:true});assert.equal(wrong.invalid,2);
 assert.throws(()=>requireValidEncryption(wrong),/DATA_ENCRYPTION_KEY/);
 db.prepare('UPDATE users SET mfa_secret=NULL,mfa_pending_secret=NULL').run();
 assert.equal(inspectEncryptionSync(db,key,{sample:true}).invalidMfaAccounts,1);
 db.prepare('UPDATE users SET mfa_secret=?').run(encryptSecret('not a totp secret',key));
 assert.equal(inspectEncryptionSync(db,key).invalid,1);
});

test('SQLite application rejects the wrong encryption key before exposing a server',t=>{
 const db=fixture(t);
 db.prepare('UPDATE users SET mfa_enabled=1,mfa_secret=?').run(encryptSecret(generateTotpSecret(),key));
 assert.throws(()=>createApp({db,env:{},keys:{encryptionKey:otherKey,auditKey:randomBytes(32)},secure:false}),/DATA_ENCRYPTION_KEY/);
 assert.equal(db.prepare('SELECT count(*) n FROM users').get().n,1,'caller-owned database stays usable after rejected startup');
});

test('full encryption preflight checks late pages and authenticates pet account/message context',t=>{
 const db=fixture(t),insert=db.prepare("INSERT INTO pet_messages(id,user_id,request_id,role,mode,content_cipher,created_at,expires_at) VALUES(?,'owner',?,'assistant','offline',?,1,9999999999999)"),request=db.prepare("INSERT INTO pet_chat_requests(user_id,request_id,request_hash,status,epoch,mode,reply_cipher,created_at,expires_at) VALUES('owner',?,'hash','complete',0,'offline',?,1,9999999999999)");
 for(let i=0;i<251;i++){
  const id='m'+String(i).padStart(3,'0');
  insert.run(id,id,encryptPetText('private text',key,`owner:message:${id}`));
  request.run(id,encryptPetText('private reply',key,`owner:request:${id}`));
 }
 assert.deepEqual(inspectEncryptionSync(db,key),{checked:502,invalid:0,invalidMfaAccounts:0,sampled:false});
 db.prepare("UPDATE pet_messages SET content_cipher=(SELECT content_cipher FROM pet_messages WHERE id='m000') WHERE id='m250'").run();
 db.prepare("UPDATE pet_chat_requests SET reply_cipher=? WHERE request_id='m250'").run(encryptPetText('private reply',otherKey,'owner:request:m250'));
 assert.equal(inspectEncryptionSync(db,key,{sample:true}).invalid,0,'startup sample is explicitly not a full history audit');
 assert.equal(inspectEncryptionSync(db,key).invalid,2);
 assert.equal(inspectEncryptionSync(db,otherKey,{sample:true}).invalid,2,'wrong deployment key is caught by each populated ciphertext kind');
});

test('release database gate rejects wrong key without changing records or exposing private values',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'cq-v8-key-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'source.sqlite');
 const db=openDb(path,{withSnapshot:false}),secret=generateTotpSecret();
 db.prepare("INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled,mfa_secret) VALUES('private-admin','admin@company.kz','Private administrator','unused','admin',1,1,?)").run(encryptSecret(secret,key));db.close();
 const env={NODE_ENV:'production',COOKIE_SECURE:'true',PUBLIC_ORIGIN:'https://quest.company.kz',SUPPORT_EMAIL:'support@company.kz',PRIVACY_URL:'https://quest.company.kz/privacy',TERMS_URL:'https://quest.company.kz/terms',DATABASE_PATH:path,DATA_ENCRYPTION_KEY:key.toString('hex'),AUDIT_HMAC_KEY:randomBytes(32).toString('hex'),BACKUP_ENCRYPTION_KEY:randomBytes(32).toString('hex')};
 const before=await readFile(path),good=await runCheck({env,database:true});assert.equal(good.ok,true,JSON.stringify(good.errors));
 const bad=await runCheck({env:{...env,DATA_ENCRYPTION_KEY:otherKey.toString('hex')},database:true});
 assert.equal(bad.ok,false);assert.ok(bad.errors.some(row=>row.code==='database_encryption'));
 for(const value of [key.toString('hex'),otherKey.toString('hex'),secret,'private-admin','admin@company.kz'])assert.equal(JSON.stringify(bad).includes(value),false);
 assert.deepEqual(await readFile(path),before);
});
