import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {seed} from './seed.mjs';
import {importOsm} from './osm.mjs';
import {migrate} from './migrations.mjs';
import {CITIES} from './cities.mjs';
import {createFeatureStore} from './features/store.mjs';
import {seedAdventureFeatures} from './features/seed.mjs';
export function openDb(path=process.env.DATABASE_PATH||'./data/almaty.sqlite',{withSnapshot=true}={}) {
 if(path!==':memory:')mkdirSync(dirname(resolve(path)),{recursive:true});
 const db=new DatabaseSync(path);
 // SQLite's built-in lower()/LIKE only fold ASCII. City names and business
 // cards are multilingual; use Unicode case folding without changing stored data.
 db.function('cityquest_lower',{deterministic:true},value=>value==null?null:String(value).toLowerCase());
 db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('player','business','admin')),xp INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id),name TEXT NOT NULL,category TEXT NOT NULL,lng REAL NOT NULL,lat REAL NOT NULL,address TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),source TEXT NOT NULL DEFAULT 'manual',osm_id TEXT UNIQUE,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS quests(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id),organization_id TEXT REFERENCES organizations(id),title TEXT NOT NULL,description TEXT NOT NULL,lng REAL NOT NULL,lat REAL NOT NULL,radius INTEGER NOT NULL,xp INTEGER NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('public','personal')),assigned_to TEXT REFERENCES users(id),verification TEXT NOT NULL CHECK(verification IN ('checkin','code')),code_hash TEXT,status TEXT NOT NULL CHECK(status IN ('draft','pending','published','archived')),goal INTEGER NOT NULL DEFAULT 20,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS completions(user_id TEXT NOT NULL REFERENCES users(id),quest_id TEXT NOT NULL REFERENCES quests(id),xp INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,quest_id));
 CREATE TABLE IF NOT EXISTS explored(user_id TEXT NOT NULL REFERENCES users(id),cell TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,cell));
 CREATE TABLE IF NOT EXISTS positions(user_id TEXT PRIMARY KEY REFERENCES users(id),lng REAL NOT NULL,lat REAL NOT NULL,accuracy REAL NOT NULL,updated_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY,name TEXT NOT NULL,owner_id TEXT NOT NULL REFERENCES users(id),invite TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS members(user_id TEXT PRIMARY KEY REFERENCES users(id),team_id TEXT NOT NULL REFERENCES teams(id),share_location INTEGER NOT NULL DEFAULT 0,joined_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT REFERENCES users(id),action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS org_coords ON organizations(lat,lng);
 CREATE INDEX IF NOT EXISTS quest_status ON quests(status,scope);
 CREATE INDEX IF NOT EXISTS member_team ON members(team_id);
 `);migrate(db);seed(db);createFeatureStore({db,dialect:'sqlite'}).transaction(seedAdventureFeatures);db.aqPath=path;
 for(const cityId of Object.keys(CITIES)){
 const key=cityId==='almaty'?'bundled_osm_v1':`bundled_osm_${cityId}_v1`;
 const snapshot=new URL(`../datasets/${cityId}-osm.json`,import.meta.url);
 if(withSnapshot&&!db.prepare('SELECT value FROM meta WHERE key=?').get(key)&&existsSync(snapshot)){
  const data=JSON.parse(readFileSync(snapshot,'utf8'));importOsm(db,data,cityId);
  db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(key,data.osm3s?.timestamp_osm_base||String(Date.now()));
 }
 }
 return db;
}
export function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
