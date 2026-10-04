import {REMOVE_QUEST_METADATA_SQL} from './helpers/quest-schema.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDb} from '../src/db.mjs';
import {migrate} from '../src/migrations.mjs';
import {FEATURE_TABLES,ADVENTURE_TABLES} from '../src/enterprise/db.mjs';

// Frozen v1 schema: keep independent of the current migration/DDL implementation.
// Original releases used user_version=0 and the seed_version metadata marker.
const LEGACY_SCHEMA=`
 PRAGMA foreign_keys=ON;
 CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('player','business','admin')),xp INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
 CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
 CREATE TABLE organizations(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id),name TEXT NOT NULL,category TEXT NOT NULL,lng REAL NOT NULL,lat REAL NOT NULL,address TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),source TEXT NOT NULL DEFAULT 'manual',osm_id TEXT UNIQUE,created_at INTEGER NOT NULL);
 CREATE TABLE quests(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id),organization_id TEXT REFERENCES organizations(id),title TEXT NOT NULL,description TEXT NOT NULL,lng REAL NOT NULL,lat REAL NOT NULL,radius INTEGER NOT NULL,xp INTEGER NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('public','personal')),assigned_to TEXT REFERENCES users(id),verification TEXT NOT NULL CHECK(verification IN ('checkin','code')),code_hash TEXT,status TEXT NOT NULL CHECK(status IN ('draft','pending','published','archived')),goal INTEGER NOT NULL DEFAULT 20,created_at INTEGER NOT NULL);
 CREATE TABLE completions(user_id TEXT NOT NULL REFERENCES users(id),quest_id TEXT NOT NULL REFERENCES quests(id),xp INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,quest_id));
 CREATE TABLE explored(user_id TEXT NOT NULL REFERENCES users(id),cell TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,cell));
 CREATE TABLE positions(user_id TEXT PRIMARY KEY REFERENCES users(id),lng REAL NOT NULL,lat REAL NOT NULL,accuracy REAL NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),invite TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE members(user_id TEXT PRIMARY KEY REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),share_location INTEGER NOT NULL DEFAULT 0,joined_at INTEGER NOT NULL);
 CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL);
`;

test('a real v1 file migrates without losing accounts, XP, claimed cards or quest progress',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'cityquest-v1-migration-')),path=join(folder,'legacy.sqlite');let db;
 try{
  db=new DatabaseSync(path);db.exec(LEGACY_SCHEMA);const at=1700000000000;
  db.prepare('INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES(?,?,?,?,?,?,?)').run('legacy-player','legacy@example.test','Игрок','old-password-hash','player',170,at);
  db.prepare('INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES(?,?,?,?,?,?,?)').run('legacy-owner','owner@example.test','Владелец','owner-password-hash','business',0,at);
  db.prepare('INSERT INTO organizations(id,owner_id,name,category,lng,lat,status,osm_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-org','legacy-owner','Моё заведение','cafe',76.947,43.249,'approved','node/900000001',at);
  db.prepare('INSERT INTO quests(id,owner_id,organization_id,title,description,lng,lat,radius,xp,scope,assigned_to,verification,code_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('legacy-quest','legacy-owner','legacy-org','Квест из v1','Сохраняем исполненное задание',76.947,43.249,100,170,'personal','legacy-player','code','legacy-code-hash','published',at);
  db.prepare('INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES(?,?,?,?)').run('legacy-player','legacy-quest',170,at+1000);
  db.prepare('INSERT INTO explored(user_id,cell,created_at) VALUES(?,?,?)').run('legacy-player','legacy-cell',at);
  db.prepare('INSERT INTO positions(user_id,lng,lat,accuracy,updated_at) VALUES(?,?,?,?,?)').run('legacy-player',76.947,43.249,10,at);
  db.prepare('INSERT INTO teams(id,name,owner_id,invite,created_at) VALUES(?,?,?,?,?)').run('legacy-team','Старая команда','legacy-player','OLDINVITE',at);
  db.prepare('INSERT INTO members(user_id,team_id,share_location,joined_at) VALUES(?,?,?,?)').run('legacy-player','legacy-team',1,at);
  db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES(?,?,?)').run('old-session-token','legacy-player',Date.now()+86400000);
  db.prepare('INSERT INTO audit(actor_id,action,target,created_at) VALUES(?,?,?,?)').run('legacy-player','quest.complete','legacy-quest',at);
  db.exec("INSERT INTO meta(key,value) VALUES('seed_version','1')");db.close();db=null;
  db=openDb(path,{withSnapshot:false});
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  const player=db.prepare('SELECT * FROM users WHERE id=?').get('legacy-player');assert.equal(player.xp,170);assert.equal(player.password,'old-password-hash');assert.equal(player.email,'legacy@example.test');
  const org=db.prepare('SELECT * FROM organizations WHERE id=?').get('legacy-org');assert.equal(org.owner_id,'legacy-owner');assert.equal(org.city_id,'almaty');assert.equal(org.version,1);
  const q=db.prepare('SELECT * FROM quests WHERE id=?').get('legacy-quest');assert.equal(q.code_hash,'legacy-code-hash');assert.equal(q.assigned_to,'legacy-player');assert.equal(q.city_id,'almaty');assert.equal(q.verification,'code');
  const completion=db.prepare('SELECT c.*,q.city_id FROM completions c JOIN quests q ON q.id=c.quest_id WHERE c.user_id=?').get('legacy-player');assert.equal(completion.quest_id,'legacy-quest');assert.equal(completion.xp,170);assert.equal(completion.created_at,at+1000);assert.equal(completion.city_id,'almaty');
  assert.equal(db.prepare('SELECT city_id FROM explored WHERE user_id=?').get('legacy-player').city_id,'almaty');assert.equal(db.prepare('SELECT city_id FROM positions WHERE user_id=?').get('legacy-player').city_id,'almaty');
  assert.equal(db.prepare('SELECT city_id FROM teams WHERE id=?').get('legacy-team').city_id,'almaty');assert.equal(db.prepare('SELECT team_id FROM members WHERE user_id=?').get('legacy-player').team_id,'legacy-team');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n,0);assert.equal(db.prepare('SELECT action FROM audit WHERE id=1').get().action,'quest.complete');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM quests WHERE city_id='almaty'").get().n,1);assert.equal(db.prepare("SELECT COUNT(*) n FROM quests WHERE city_id='astana'").get().n,12);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key='seed_astana_v1'").get().value,'1');
  // The widened constraint accepts token verification after the table rebuild.
  db.prepare('UPDATE quests SET verification=? WHERE id=?').run('token','legacy-quest');
  db.close();db=null;db=openDb(path,{withSnapshot:false});assert.equal(db.prepare('SELECT COUNT(*) n FROM quests').get().n,13);assert.equal(db.prepare('SELECT COUNT(*) n FROM completions').get().n,1);assert.equal(db.prepare('SELECT xp FROM users WHERE id=?').get('legacy-player').xp,170);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{if(db)db.close();await rm(folder,{recursive:true,force:true});}
});

test('additive SQLite schema 2 upgrade preserves active sessions and signed history',()=>{
 const db=openDb(':memory:',{withSnapshot:false});
 try{
  // Remove only the additive feature schema to reconstruct a v2 installation.
  for(const table of [...FEATURE_TABLES,...ADVENTURE_TABLES].reverse())db.exec(`DROP TABLE ${table}`);
  db.exec(REMOVE_QUEST_METADATA_SQL);
  db.exec('DELETE FROM schema_migrations WHERE version>=3; PRAGMA user_version=2');
  const now=Date.now();
  db.prepare("INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES('existing','existing@example.test','Existing','kept-hash','player',640,?)").run(now);
  db.prepare("INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES('kept-token','kept-session','existing',?,?,?,1)").run(now+600000,now,now);
  db.prepare("INSERT INTO audit(actor_id,action,target,created_at,metadata,prev_hash,event_hash) VALUES('existing','existing.action','existing',?,'{}','kept-prev','kept-signature')").run(now);
  const before={user:{...db.prepare("SELECT * FROM users WHERE id='existing'").get()},session:{...db.prepare("SELECT * FROM sessions WHERE id='kept-session'").get()},audit:{...db.prepare('SELECT * FROM audit').get()}};
  migrate(db);migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);
  assert.deepEqual({...db.prepare("SELECT * FROM users WHERE id='existing'").get()},before.user);
  assert.deepEqual({...db.prepare("SELECT * FROM sessions WHERE id='kept-session'").get()},before.session);
  assert.deepEqual({...db.prepare('SELECT * FROM audit').get()},before.audit);
  for(const table of [...FEATURE_TABLES,...ADVENTURE_TABLES])assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('SQLite schema 3 upgrade keeps pet progress, encrypted history and paid entitlements intact',()=>{
 const db=openDb(':memory:',{withSnapshot:false}),now=1780000000000;
 try{
  for(const table of [...ADVENTURE_TABLES].reverse())db.exec(`DROP TABLE ${table}`);
  db.exec(REMOVE_QUEST_METADATA_SQL);
  db.exec('DELETE FROM schema_migrations WHERE version>=4; PRAGMA user_version=3');
  db.prepare("INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES('kept','kept@example.test','Игрок','password-hash','player',900,?)").run(now);
  db.prepare("INSERT INTO pets(user_id,name,species,color,xp,created_at,updated_at) VALUES('kept','Друг','fox','amber',420,?,?)").run(now,now);
  db.prepare("INSERT INTO pet_rewards(user_id,event_key,xp,created_at) VALUES('kept','quest:before-upgrade',20,?)").run(now);
  db.prepare("INSERT INTO pet_messages(id,user_id,request_id,role,mode,content_cipher,created_at,expires_at) VALUES('message','kept','request','user','ai','opaque-existing-cipher',?,?)").run(now,now+86400000);
  db.prepare("INSERT INTO billing_orders(id,user_id,plan,amount,status,idempotency_key,created_at,expires_at,paid_at,payment_reference) VALUES('order','kept','plus',1490,'paid','order-key',?,?,?,'receipt-kept')").run(now,now+60000,now);
  db.prepare("INSERT INTO billing_entitlements(id,order_id,user_id,plan,starts_at,ends_at) VALUES('entitlement','order','kept','plus',?,?)").run(now,now+2592000000);
  const before=Object.fromEntries(FEATURE_TABLES.map(table=>[table,db.prepare(`SELECT * FROM ${table}`).all().map(row=>({...row}))]));
  migrate(db);migrate(db);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);
  for(const table of FEATURE_TABLES)assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all().map(row=>({...row})),before[table]);
  for(const table of ADVENTURE_TABLES)assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
  assert.equal(db.prepare("SELECT xp FROM users WHERE id='kept'").get().xp,900);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});

test('SQLite schema 5 metadata upgrade preserves quest revisions and rewards and leaves unknown facts empty',()=>{
 const db=openDb(':memory:',{withSnapshot:false}),now=Date.now();
 try{
  db.exec(REMOVE_QUEST_METADATA_SQL);db.exec('DELETE FROM schema_migrations WHERE version=6; PRAGMA user_version=5');
  db.prepare("INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES('metadata-legacy','metadata-legacy@example.test','Legacy','hash','player',130,?)").run(now);
  const quest=db.prepare('SELECT * FROM quests ORDER BY id LIMIT 1').get();
  db.prepare('UPDATE quests SET version=9,updated_at=? WHERE id=?').run(now,quest.id);
  db.prepare('INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES(?,?,130,?)').run('metadata-legacy',quest.id,now);
  const before={...db.prepare('SELECT * FROM quests WHERE id=?').get(quest.id)},completion={...db.prepare('SELECT * FROM completions').get()};
  migrate(db);migrate(db);
  const {difficulty,difficulty_reason,estimated_minutes,objective_steps_json,hint,...after}=db.prepare('SELECT * FROM quests WHERE id=?').get(quest.id);
  assert.deepEqual(after,before);assert.deepEqual({difficulty,difficulty_reason,estimated_minutes,objective_steps_json,hint},{difficulty:null,difficulty_reason:'',estimated_minutes:null,objective_steps_json:'[]',hint:''});
  assert.deepEqual({...db.prepare('SELECT * FROM completions').get()},completion);assert.equal(db.prepare("SELECT xp FROM users WHERE id='metadata-legacy'").get().xp,130);assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{db.close();}
});
