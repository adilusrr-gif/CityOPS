import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
import {createTestDatabase} from './db-fixture.mjs';
import {migratePostgres,seedPostgres,TRANSFER_TABLES,FEATURE_TABLES,ADVENTURE_TABLES,openPostgres} from '../../src/enterprise/db.mjs';
import {appendAudit,verifyAudit,consumeRate} from '../../src/enterprise/security-store.mjs';
import {openDb} from '../../src/db.mjs';
import {passwordHash,passwordOK} from '../../src/domain.mjs';
import {appendAudit as appendSqliteAudit,verifyAudit as verifySqliteAudit,encryptSecret} from '../../src/security.mjs';
import {importSqlitePostgres} from '../../scripts/import-sqlite-postgres.mjs';
import {encryptPetText,decryptPetText} from '../../src/features/pet-crypto.mjs';

async function fixture(t,opts){const f=await createTestDatabase(opts);t.after(()=>f.close());t.diagnostic(`SQL engine: ${f.engine}`);return f;}
const key=Buffer.alloc(32,47);

test('PG migrations, complete bundled cities, account-free seed and idempotence',async t=>{
 const {db,db2}=await fixture(t);
 assert.deepEqual(await Promise.all([migratePostgres(db),migratePostgres(db2)]),[{version:6,migrated:false},{version:6,migrated:false}]);
 for(const table of ADVENTURE_TABLES)assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,0,'DDL must leave import destination empty');
 const seeded=await seedPostgres(db);
 assert.equal(seeded.counts.organizations,13128);assert.equal(seeded.counts.quests,24);assert.equal(seeded.counts.users,0);
 assert.deepEqual(await db.all('SELECT city_id,COUNT(*) AS n FROM organizations GROUP BY city_id ORDER BY city_id'),[{city_id:'almaty',n:8346},{city_id:'astana',n:4782}]);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM users')).n,0);
 assert.equal((await db.get("SELECT COUNT(*) AS n FROM photo_contests WHERE status='draft'")).n,2);
 assert.ok((await db.get('SELECT COUNT(*) AS n FROM adventure_routes')).n>=2);
 await db.query("UPDATE adventure_routes SET status='closed',status_reason='Operator closure' WHERE id='almaty-park-walk'");
 assert.equal((await seedPostgres(db2)).seeded,false);
 assert.equal((await db.get("SELECT status_reason FROM adventure_routes WHERE id='almaty-park-walk'")).status_reason,'Operator closure');
 await db.query("UPDATE schema_migrations SET checksum='modified' WHERE version=3");
 await assert.rejects(migratePostgres(db),/checksum/);
});

test('PostgreSQL schema 4 upgrades additively and preserves paid plans and pet data',async t=>{
 const {db}=await fixture(t),now=1780000000000;
 await db.transaction(async tx=>{
  for(const table of [...ADVENTURE_TABLES].reverse())await tx.query(`DROP TABLE ${table}`);
  await tx.query('DELETE FROM schema_migrations WHERE version>=5');
  await tx.query("INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES('upgrade-user','upgrade@example.test','Игрок','kept-password','player',400,$1)",[now]);
  await tx.query("INSERT INTO pets(user_id,name,species,color,xp,created_at,updated_at) VALUES('upgrade-user','Друг','fox','amber',120,$1,$1)",[now]);
  await tx.query("INSERT INTO billing_orders(id,user_id,plan,amount,status,idempotency_key,created_at,expires_at,payment_reference) VALUES('kept-order','upgrade-user','plus',1490,'paid','kept-key',$1,$2,'kept-receipt')",[now,now+60000]);
  await tx.query("INSERT INTO billing_entitlements(id,order_id,user_id,plan,starts_at,ends_at) VALUES('kept-entitlement','kept-order','upgrade-user','plus',$1,$2)",[now,now+2592000000]);
 });
 const before={pet:await db.get('SELECT * FROM pets'),order:await db.get('SELECT * FROM billing_orders'),entitlement:await db.get('SELECT * FROM billing_entitlements')};
 assert.deepEqual(await migratePostgres(db),{version:6,migrated:true});
 assert.deepEqual(await migratePostgres(db),{version:6,migrated:false});
 assert.deepEqual(await db.get('SELECT * FROM pets'),before.pet);
 assert.deepEqual(await db.get('SELECT * FROM billing_orders'),before.order);
 assert.deepEqual(await db.get('SELECT * FROM billing_entitlements'),before.entitlement);
 assert.equal((await db.get("SELECT xp FROM users WHERE id='upgrade-user'")).xp,400);
 for(const table of ADVENTURE_TABLES)assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,0);
});

test('transaction rollback and nested savepoint preserve only committed work',async t=>{
 const {db}=await fixture(t);
 await db.transaction(async tx=>{
  await tx.query("INSERT INTO meta VALUES('outer','kept')");
  await assert.rejects(tx.transaction(async inner=>{await inner.query("INSERT INTO meta VALUES('inner','lost')");throw new Error('rollback inner');}),/rollback inner/);
  assert.equal((await tx.get("SELECT value FROM meta WHERE key='outer'")).value,'kept');
 });
 await assert.rejects(db.transaction(async tx=>{await tx.query("INSERT INTO meta VALUES('rolled','lost')");await appendAudit(tx,{action:'rolled'},key);throw new Error('rollback outer');}),/rollback outer/);
 assert.deepEqual(await db.all('SELECT key,value FROM meta'),[{key:'outer',value:'kept'}]);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM audit')).n,0);
});

test('audit concurrent calls from two DB handles keep one contiguous authenticated chain',async t=>{
 const {db,db2}=await fixture(t);
 const ids=await Promise.all(Array.from({length:40},(_,i)=>appendAudit(i%2?db:db2,{action:'parallel',target:String(i),metadata:{z:2,a:{second:true,first:['Астана',null]}},at:1_780_000_000_000+i},key)));
 assert.deepEqual(ids.sort((a,b)=>a-b),Array.from({length:40},(_,i)=>i+1));
 const result=await verifyAudit(db,key);assert.equal(result.ok,true);assert.equal(result.count,40);
 assert.equal((await verifyAudit(db2,key,{expectedHead:{id:0,hash:'0'.repeat(64)}})).reason,'external_checkpoint');
 await db.query("UPDATE audit SET target='tampered' WHERE id=40");
 assert.equal((await verifyAudit(db,key)).reason,'event_hash');
 await assert.rejects(appendAudit(db,{action:'blocked'},key),/invalid/);
});

test('shared rate budget allows exact limit, expires and bounds distinct keys',async t=>{
 const {db,db2}=await fixture(t);
 const now=1_780_000_000_000;
 const results=await Promise.all(Array.from({length:50},(_,i)=>consumeRate(i%2?db:db2,'shared',{limit:9,windowMs:1000,now,maxKeys:2})));
 assert.equal(results.filter(x=>x.allowed).length,9);
 assert.equal((await db.get("SELECT count FROM rate_limits WHERE key='shared'")).count,10);
 assert.equal((await consumeRate(db,'second',{limit:1,windowMs:1000,now,maxKeys:2})).allowed,true);
 const denied=await consumeRate(db2,'third',{limit:1,windowMs:1000,now,maxKeys:2});
 assert.equal(denied.allowed,false);assert.equal(denied.reason,'capacity');
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM rate_limits')).n,2);
 assert.equal((await consumeRate(db,'third',{limit:1,windowMs:1000,now:now+1000,maxKeys:2})).allowed,true);
});

function createSource(path,encryptionKey){
 const source=openDb(path,{withSnapshot:false}),now=1_780_000_000_000;
 source.prepare("INSERT INTO users(id,email,name,password,role,xp,created_at,mfa_enabled,mfa_secret,mfa_last_counter) VALUES(?,?,?,?,?,?,?,?,?,?)").run('source-user','owner@example.test','Сохранённый игрок',passwordHash('Original-v2-password-42'),'business',100,now,1,encryptSecret('JBSWY3DPEHPK3PXP',encryptionKey),59333331);
 source.prepare("UPDATE organizations SET owner_id='source-user',version=4 WHERE id='seed-panfilov'").run();
 source.prepare("UPDATE quests SET owner_id='source-user',verification='token',version=3,max_completions=15 WHERE id='quest-panfilov'").run();
 source.prepare('INSERT INTO completions VALUES(?,?,?,?)').run('source-user','quest-panfilov',100,now+1);
 source.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run('session-hash','source-user',now+86400000,'session-public',now,now,1);
 source.prepare('INSERT INTO explored VALUES(?,?,?,?)').run('source-user','astana:cell',now,'astana');
 source.prepare('INSERT INTO positions VALUES(?,?,?,?,?,?)').run('source-user',71.43,51.12,10,now,'astana');
 source.prepare('INSERT INTO teams VALUES(?,?,?,?,?,?)').run('team-original','Команда','source-user','INVITE',now,'astana');
 source.prepare('INSERT INTO members VALUES(?,?,?,?)').run('source-user','team-original',1,now);
 source.prepare('INSERT INTO recovery_codes VALUES(?,?,?)').run('source-user','recovery-hash',null);
 source.prepare('INSERT INTO login_challenges VALUES(?,?,?,?)').run('challenge','source-user',now+60000,1);
 source.prepare('INSERT INTO reward_tokens VALUES(?,?,?,?,?,?,?,?,?)').run('reward-original','quest-panfilov','source-user','token-hash',now,now+60000,now+1,'source-user',null);
 source.prepare('INSERT INTO rate_limits VALUES(?,?,?)').run('limited',4,now+60000);
 source.prepare('INSERT INTO pets(user_id,name,species,color,xp,created_at,updated_at,consent_at,adult_attested_at) VALUES(?,?,?,?,?,?,?,?,?)').run('source-user','Лис','fox','amber',80,now,now,now,now);
 source.prepare('INSERT INTO pet_rewards(user_id,event_key,xp,created_at) VALUES(?,?,?,?)').run('source-user','quest:quest-panfilov',20,now);
 const message=encryptPetText('Личное сообщение',encryptionKey,'source-user:message:message-original'),reply=encryptPetText('Поддерживающий ответ',encryptionKey,'source-user:request:request-original');
 source.prepare('INSERT INTO pet_chat_requests(user_id,request_id,request_hash,status,epoch,mode,reply_cipher,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').run('source-user','request-original','request-hash','complete',0,'offline',reply,now,now+86400000);
 source.prepare('INSERT INTO pet_messages(id,user_id,request_id,role,mode,content_cipher,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run('message-original','source-user','request-original','assistant','offline',message,now,now+86400000);
 source.prepare('INSERT INTO pet_usage(day,user_id,count) VALUES(?,?,?)').run(Math.floor(now/86400000),'source-user',3);
 source.prepare('INSERT INTO billing_orders(id,user_id,plan,amount,currency,status,idempotency_key,created_at,expires_at,paid_at,payment_reference,service_starts_at,service_ends_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('order-original','source-user','plus',1490,'KZT','paid','order-key',now,now+60000,now,'receipt-test',now,now+2592000000);
 source.prepare('INSERT INTO billing_entitlements(id,order_id,user_id,plan,starts_at,ends_at) VALUES(?,?,?,?,?,?)').run('entitlement-original','order-original','source-user','plus',now,now+2592000000);
 source.prepare('INSERT INTO promotions(id,owner_id,organization_id,quest_id,city_id,title,description,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('promotion-original','source-user','seed-panfilov','quest-panfilov','almaty','Продвижение','Сохранённая карточка','pending',now,now,2);
 appendSqliteAudit(source,{actor:'source-user',action:'legacy.create',target:'source-user',metadata:{nested:{z:1,a:'Алматы'},arr:[false,null,1]},requestId:'request-original',at:now},key);
 appendSqliteAudit(source,{actor:'source-user',action:'legacy.complete',target:'quest-panfilov',metadata:{xp:100},at:now+1},key);
 return source;
}

async function addAdventureSource(source){
 const now=1780000000000;
 source.prepare("INSERT INTO adventure_checkins(user_id,route_id,route_version,checkpoint_index,altitude_m,created_at) VALUES('source-user','almaty-park-walk',1,0,850,?)").run(now);
 source.prepare("INSERT INTO adventure_rewards(user_id,route_id,xp,created_at) VALUES('source-user','almaty-park-walk',80,?)").run(now);
 source.prepare("INSERT INTO territory_visits(user_id,zone_id,season,day,team_id,created_at) VALUES('source-user','astana-ataturk','2026-05',20601,'team-original',?)").run(now);
 const {default:sharp}=await import('sharp');
 const image=await sharp({create:{width:2,height:3,channels:3,background:'#c08040'}}).jpeg({progressive:false}).toBuffer();
 source.prepare("INSERT INTO photos(id,user_id,city_id,contest_id,title,caption,cell,approx_lng,approx_lat,status,image_base64,image_bytes,image_sha256,width,height,created_at,updated_at,version) VALUES('photo-original','source-user','almaty','photo-almaty-first','Новое место','Пейзаж','almaty:cell',76.954,43.258,'approved',?,?,?,?,?,?,?,1)").run(image.toString('base64'),image.length,createHash('sha256').update(image).digest('hex'),2,3,now,now);
 source.prepare('INSERT INTO photo_storage(id,used_bytes) VALUES(1,?)').run(image.length);
 source.prepare("INSERT INTO photo_upload_usage(user_id,day,count) VALUES('source-user',20601,1)").run();
 source.prepare("INSERT INTO photo_discovery_rewards(user_id,city_id,cell,photo_id,xp,created_at) VALUES('source-user','almaty','almaty:cell','photo-original',20,?)").run(now);
 source.prepare("INSERT INTO users(id,email,name,password,role,created_at) VALUES('voter','voter@example.test','Зритель','hash','player',?)").run(now);
 source.prepare("INSERT INTO photo_votes(contest_id,user_id,photo_id,created_at,updated_at) VALUES('photo-almaty-first','voter','photo-original',?,?)").run(now,now);
 source.prepare("INSERT INTO photo_reports(id,photo_id,user_id,reason,status,created_at) VALUES('report-original','photo-original','voter','Проверить публикацию','open',?)").run(now);
}

for(const sourceVersion of [4,5])test(`SQLite schema ${sourceVersion} import preserves photos, adventure ledgers, pet ciphertext, billing and audit signatures`,async t=>{
 const {db}=await fixture(t),directory=mkdtempSync(join(tmpdir(),'cq-pg-import-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'source.sqlite'),encryptionKey=randomBytes(32),source=createSource(path,encryptionKey);
 t.after(()=>source.close());
 await addAdventureSource(source);
 if(sourceVersion===4)source.exec('DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4');
 const expectedHead=verifySqliteAudit(source,key).head;
 const result=await importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey});
 assert.equal(result.imported,true);assert.deepEqual(result.audit.head,expectedHead);
 assert.equal(passwordOK('Original-v2-password-42',(await db.get("SELECT password FROM users WHERE id='source-user'")).password),true);
 for(const table of TRANSFER_TABLES){
  const columns=source.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);
  const expected=source.prepare(`SELECT * FROM ${table}`).all().map(row=>({...row}));
  const actual=await db.all(`SELECT ${columns.map(x=>`"${x}"`).join(',')} FROM ${table}${table==='meta'?" WHERE key<>'enterprise_initialized'":''}`);
  const sorted=rows=>rows.map(x=>JSON.stringify(x)).sort();
  assert.deepEqual(sorted(actual),sorted(expected),`preserved ${table}`);
 }
 assert.equal((await db.get("SELECT password_login_enabled FROM users WHERE id='source-user'")).password_login_enabled,1);
 const message=await db.get("SELECT content_cipher FROM pet_messages WHERE id='message-original'");
 assert.equal(decryptPetText(message.content_cipher,encryptionKey,'source-user:message:message-original'),'Личное сообщение');
 await appendAudit(db,{actor:'source-user',action:'pg.after-import'},key);
 assert.equal((await verifyAudit(db,key)).count,3);
 assert.equal((await seedPostgres(db)).seeded,false);
 await assert.rejects(importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey}),/destination must be empty/);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM users')).n,2);
});

test('SQLite schema 2 import remains supported without feature tables',async t=>{
 const {db}=await fixture(t),directory=mkdtempSync(join(tmpdir(),'cq-pg-v2-import-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'source.sqlite'),encryptionKey=randomBytes(32),source=createSource(path,encryptionKey);t.after(()=>source.close());
 for(const table of [...FEATURE_TABLES,...ADVENTURE_TABLES].reverse())source.exec(`DROP TABLE ${table}`);
 source.exec('DELETE FROM schema_migrations WHERE version>=3; PRAGMA user_version=2');
 const result=await importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey});
 assert.equal(result.imported,true);assert.equal(result.counts.users,1);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM pets')).n,0);
 assert.equal((await db.get("SELECT password FROM users WHERE id='source-user'")).password,source.prepare("SELECT password FROM users WHERE id='source-user'").get().password);
});

test('SQLite schema 3 import remains supported without adventure tables',async t=>{
 const {db}=await fixture(t),directory=mkdtempSync(join(tmpdir(),'cq-pg-v3-import-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'source.sqlite'),encryptionKey=randomBytes(32),source=createSource(path,encryptionKey);t.after(()=>source.close());
 for(const table of [...ADVENTURE_TABLES].reverse())source.exec(`DROP TABLE ${table}`);
 source.exec('DELETE FROM schema_migrations WHERE version>=4; PRAGMA user_version=3');
 const result=await importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey});
 assert.equal(result.imported,true);assert.equal(result.counts.pets,1);assert.equal(result.counts.billing_orders,1);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM photos')).n,0);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM adventure_routes')).n,0);
 await seedPostgres(db);
 assert.ok((await db.get('SELECT COUNT(*) AS n FROM adventure_routes')).n>=2);
 assert.equal((await db.get("SELECT xp FROM pets WHERE user_id='source-user'")).xp,80);
});

test('migration fails closed on wrong keys or unsigned/tampered history without writing target',async t=>{
 const {db}=await fixture(t),directory=mkdtempSync(join(tmpdir(),'cq-pg-reject-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'source.sqlite'),encryptionKey=randomBytes(32),source=createSource(path,encryptionKey);
 t.after(()=>source.close());
 await assert.rejects(importSqlitePostgres({db,sqlitePath:path,auditKey:randomBytes(32),encryptionKey}),/audit verification/);
 await assert.rejects(importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey:randomBytes(32)}),/authenticated/);
 // Pet ciphertext must independently authenticate even when nobody uses MFA.
 source.prepare('UPDATE users SET mfa_secret=NULL,mfa_pending_secret=NULL,mfa_enabled=0').run();
 await assert.rejects(importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey:randomBytes(32)}),/pet text could not be authenticated/);
 source.prepare("UPDATE audit SET target='changed' WHERE id=1").run();
 await assert.rejects(importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey}),/audit verification/);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM users')).n,0);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM meta')).n,0);
});

test('SQLite import rejects malformed photograph bytes and divergent media quotas before target writes',async t=>{
 const {db}=await fixture(t),directory=mkdtempSync(join(tmpdir(),'cq-pg-photo-import-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'source.sqlite'),encryptionKey=randomBytes(32),source=createSource(path,encryptionKey);t.after(()=>source.close());
 await addAdventureSource(source);
 const row=source.prepare("SELECT image_base64,image_sha256 FROM photos WHERE id='photo-original'").get();
 source.prepare("UPDATE photos SET image_sha256=? WHERE id='photo-original'").run('0'.repeat(64));
 await assert.rejects(importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey}),/canonical bounded JPEG/);
 source.prepare("UPDATE photos SET image_sha256=? WHERE id='photo-original'").run(row.image_sha256);
 source.prepare('UPDATE photo_storage SET used_bytes=used_bytes+1').run();
 await assert.rejects(importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey}),/byte count/);
 source.prepare('UPDATE photo_storage SET used_bytes=used_bytes-1').run();
 source.prepare("UPDATE photos SET status='withdrawn' WHERE id='photo-original'").run();
 await assert.rejects(importSqlitePostgres({db,sqlitePath:path,auditKey:key,encryptionKey}),/Withdrawn photo/);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM users')).n,0);
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM photos')).n,0);
});

test('bigint overflow rejects silently rounded timestamps and TLS bypass is rejected before connecting',async t=>{
 const {db}=await fixture(t);
 await assert.rejects(db.get('SELECT 9007199254740993::bigint AS unsafe'),/safe integer/);
 await assert.rejects(openPostgres({connectionString:'postgres://localhost/test?sslmode=no-verify'}),/PGSSLMODE/);
 await assert.rejects(openPostgres({connectionString:'postgres://localhost/test',ssl:{rejectUnauthorized:false}}),/verification/);
});
