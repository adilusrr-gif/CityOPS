import {REMOVE_QUEST_METADATA_SQL} from '../helpers/quest-schema.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './db-fixture.mjs';
import {createFeatureStore,get,run,audit} from '../../src/features/store.mjs';
import {FEATURE_TABLES,ADVENTURE_TABLES,migratePostgres} from '../../src/enterprise/db.mjs';

async function fixture(t){const f=await createTestDatabase();t.after(()=>f.close());t.diagnostic(`SQL engine: ${f.engine}`);return f;}
test('PostgreSQL portable units retain SQL binding, atomic audit and reject unknown/async work',async t=>{
 const {db}=await fixture(t),store=createFeatureStore({db,dialect:'postgres',audit:async(tx,actor,action,target)=>{
  await tx.run('INSERT INTO meta(key,value) VALUES($1,$2)',[`test-audit:${action}`,target]);
  if(action==='reject')throw new Error('audit unavailable');
 }});
 const result=await store.transaction(function*(){yield run('INSERT INTO meta(key,value) VALUES($2,$1)',['kept','portable']);yield audit(null,'created','portable');return yield get('SELECT value FROM meta WHERE key=$1 FOR UPDATE',['portable']);});
 assert.equal(result.value,'kept');
 await assert.rejects(store.transaction(function*(){yield run("INSERT INTO meta VALUES('rolled','back')");yield audit(null,'reject','rolled');}),/audit unavailable/);
 assert.equal(await db.get("SELECT * FROM meta WHERE key='rolled'"),undefined);assert.equal(await db.get("SELECT * FROM meta WHERE key='test-audit:reject'"),undefined);
 await assert.rejects(store.transaction(function*(){yield run("INSERT INTO meta VALUES('bad','op')");yield {kind:'run',sql:'DELETE FROM users'};}),/Unknown/);
 await assert.rejects(store.transaction(async function*(){yield get('SELECT 1');}),/synchronous generator/);
 await assert.rejects(store.read(function*(){yield run('DELETE FROM users');}),/transaction/);
 await assert.rejects(store.transaction(function*(){yield run("INSERT INTO meta VALUES('before-error','must-roll-back')");try{yield run("INSERT INTO meta VALUES('portable','duplicate')");}catch{return {concealed:true};}}),/duplicate key/);
 assert.equal(await db.get("SELECT * FROM meta WHERE key='before-error'"),undefined);
 assert.equal(await db.get("SELECT * FROM meta WHERE key='bad'"),undefined);
});

test('PostgreSQL actor and additional-account locks serialize cross-account operations',async t=>{
 const {db,db2}=await fixture(t),cfg={idleMs:60000,requireAdminMfa:true},now=Date.now();
 for(const uid of ['a','b']){
  await db.run("INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled) VALUES($1,$2,$1,'unused','admin',$3,1)",[uid,`${uid}@example.test`,now]);
  await db.run('INSERT INTO sessions(token,user_id,expires,id,created_at,last_seen,mfa_verified) VALUES($1,$1,$2,$1,$3,$3,1)',[uid,now+600000,now]);
 }
 const stores=[db,db2].map(connection=>createFeatureStore({db:connection,dialect:'postgres',cfg}));
 await Promise.all(Array.from({length:12},(_,i)=>{
  const uid=i%2?'a':'b',target=uid==='a'?'b':'a',store=stores[i%2];
  return store.transaction(function*(){yield* store.requireActor({id:uid,session_id:uid},['admin'],[target]);const row=yield get('SELECT xp FROM users WHERE id=$1',[target]);yield run('UPDATE users SET xp=$1 WHERE id=$2',[row.xp+1,target]);});
 }));
 assert.deepEqual(await db.all('SELECT id,xp FROM users ORDER BY id'),[{id:'a',xp:6},{id:'b',xp:6}]);
 await db.run("UPDATE users SET role='player' WHERE id='a'");
 await assert.rejects(stores[0].transaction(function*(){yield* stores[0].requireActor({id:'a',session_id:'a',role:'admin'},['admin']);}),e=>e.status===403);
 await db.run("DELETE FROM sessions WHERE id='b'");
 await assert.rejects(stores[1].transaction(function*(){yield* stores[1].requireActor({id:'b',session_id:'b'},['admin']);}),e=>e.status===401);
});

test('PostgreSQL schema 3 upgrades additively and validates every applied migration checksum',async t=>{
 const {db}=await fixture(t);
 for(const table of [...FEATURE_TABLES,...ADVENTURE_TABLES].reverse())await db.query(`DROP TABLE ${table}`);
 await db.query(REMOVE_QUEST_METADATA_SQL);
 await db.run('DELETE FROM schema_migrations WHERE version>=4');
 await db.run("INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES('kept','kept@example.test','Kept','password-hash','player',540,1700000000000)");
 await db.run("INSERT INTO sessions(token,user_id,expires,id,created_at,last_seen,mfa_verified) VALUES('hash','kept',1900000000000,'session',1700000000000,1700000000000,1)");
 await db.run("INSERT INTO audit(id,actor_id,action,target,created_at,event_hash) VALUES(1,'kept','kept','kept',1700000000000,'signature')");
 const before={user:await db.get("SELECT * FROM users WHERE id='kept'"),session:await db.get("SELECT * FROM sessions WHERE id='session'"),audit:await db.get('SELECT * FROM audit')};
 assert.deepEqual(await migratePostgres(db),{version:7,migrated:true});
 assert.deepEqual(await migratePostgres(db),{version:7,migrated:false});
 assert.deepEqual(await db.get("SELECT * FROM users WHERE id='kept'"),before.user);
 assert.deepEqual(await db.get("SELECT * FROM sessions WHERE id='session'"),before.session);
 assert.deepEqual(await db.get('SELECT * FROM audit'),before.audit);
 for(const table of [...FEATURE_TABLES,...ADVENTURE_TABLES])assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,0);
 await db.run("UPDATE schema_migrations SET checksum='tampered' WHERE version=4");
 await assert.rejects(migratePostgres(db),/migration 4 checksum/);
});
