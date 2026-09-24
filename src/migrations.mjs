import {readFileSync} from 'node:fs';
// Versioned, transactional migrations preserve existing accounts and progress.
export const SCHEMA_VERSION=5;
function hasColumn(db,table,column){return db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column);}
function addColumn(db,table,column,definition){if(!hasColumn(db,table,column))db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);}
function migrateV2(db){
 const current=db.prepare('PRAGMA user_version').get().user_version;
 if(current>SCHEMA_VERSION)throw new Error(`Database schema ${current} is newer than application ${SCHEMA_VERSION}`);
 if(current>=2)return;
 db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
 try{
  for(const table of ['organizations','explored','positions','teams'])addColumn(db,table,'city_id',"TEXT NOT NULL DEFAULT 'almaty' CHECK(city_id IN ('almaty','astana'))");
  addColumn(db,'organizations','version','INTEGER NOT NULL DEFAULT 1');
  addColumn(db,'organizations','updated_at','INTEGER NOT NULL DEFAULT 0');
  addColumn(db,'users','mfa_enabled','INTEGER NOT NULL DEFAULT 0');
  addColumn(db,'users','mfa_secret','TEXT');
  addColumn(db,'users','mfa_pending_secret','TEXT');
  addColumn(db,'users','mfa_pending_at','INTEGER');
  addColumn(db,'users','mfa_last_counter','INTEGER NOT NULL DEFAULT -1');
  addColumn(db,'users','disabled','INTEGER NOT NULL DEFAULT 0');
  for(const [col,def] of [['id','TEXT'],['created_at','INTEGER NOT NULL DEFAULT 0'],['last_seen','INTEGER NOT NULL DEFAULT 0'],['mfa_verified','INTEGER NOT NULL DEFAULT 0']])addColumn(db,'sessions',col,def);
  db.exec('DELETE FROM sessions'); // Legacy sessions have no verified MFA or idle timestamp.
  for(const [col,def] of [['metadata',"TEXT NOT NULL DEFAULT '{}'"],['request_id','TEXT'],['prev_hash','TEXT'],['event_hash','TEXT']])addColumn(db,'audit',col,def);
  // Rebuild only quests to widen the legacy CHECK constraint without losing references.
  db.exec(`CREATE TABLE quests_v2(
   id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id),organization_id TEXT REFERENCES organizations(id),
   title TEXT NOT NULL,description TEXT NOT NULL,lng REAL NOT NULL,lat REAL NOT NULL,radius INTEGER NOT NULL,xp INTEGER NOT NULL,
   scope TEXT NOT NULL CHECK(scope IN ('public','personal')),assigned_to TEXT REFERENCES users(id),
   verification TEXT NOT NULL CHECK(verification IN ('checkin','code','token')),code_hash TEXT,
   status TEXT NOT NULL CHECK(status IN ('draft','pending','published','archived')),goal INTEGER NOT NULL DEFAULT 20,created_at INTEGER NOT NULL,
   city_id TEXT NOT NULL DEFAULT 'almaty' CHECK(city_id IN ('almaty','astana')),version INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL DEFAULT 0,
   starts_at INTEGER,ends_at INTEGER,max_completions INTEGER CHECK(max_completions IS NULL OR max_completions>0)
  );
  INSERT INTO quests_v2(id,owner_id,organization_id,title,description,lng,lat,radius,xp,scope,assigned_to,verification,code_hash,status,goal,created_at)
   SELECT id,owner_id,organization_id,title,description,lng,lat,radius,xp,scope,assigned_to,verification,code_hash,status,goal,created_at FROM quests;
  DROP TABLE quests;ALTER TABLE quests_v2 RENAME TO quests;
  CREATE TABLE IF NOT EXISTS recovery_codes(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,used_at INTEGER,PRIMARY KEY(user_id,code_hash));
  CREATE TABLE IF NOT EXISTS login_challenges(id_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS reward_tokens(id TEXT PRIMARY KEY,quest_id TEXT NOT NULL REFERENCES quests(id),issuer_id TEXT NOT NULL REFERENCES users(id),token_hash TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,redeemed_at INTEGER,redeemed_by TEXT REFERENCES users(id),revoked_at INTEGER);
  CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS session_public_id ON sessions(id);
  CREATE INDEX IF NOT EXISTS session_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS org_city_status ON organizations(city_id,status,lat,lng);
  CREATE INDEX IF NOT EXISTS quest_city_status ON quests(city_id,status,scope);
  CREATE INDEX IF NOT EXISTS progress_city ON explored(user_id,city_id);
  CREATE INDEX IF NOT EXISTS token_quest ON reward_tokens(quest_id,expires_at);
  CREATE INDEX IF NOT EXISTS completion_quest ON completions(quest_id,created_at);
  CREATE INDEX IF NOT EXISTS rate_expiry ON rate_limits(reset_at);
  CREATE INDEX IF NOT EXISTS audit_action ON audit(action,created_at);
  PRAGMA user_version=2;
  `);
  db.prepare('INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES(2,?)').run(Date.now());
  const violations=db.prepare('PRAGMA foreign_key_check').all();if(violations.length)throw new Error('Migration foreign key check failed');
  db.exec('COMMIT');
 }catch(e){db.exec('ROLLBACK');throw e;}finally{db.exec('PRAGMA foreign_keys=ON');}
}

export function migrate(db){
 const current=db.prepare('PRAGMA user_version').get().user_version;
 if(current>SCHEMA_VERSION)throw new Error(`Database schema ${current} is newer than application ${SCHEMA_VERSION}`);
 if(current<2)migrateV2(db);
 for(const {version,file} of [
  {version:3,file:'004-pet-billing.sql'},
  {version:4,file:'005-adventures.sql'},
  {version:5,file:'006-query-indexes.sql'},
 ]){
  if(current>=version)continue;
  db.exec('BEGIN IMMEDIATE');
  try{
   // This immutable migration uses the SQL subset shared by both databases.
   db.exec(readFileSync(new URL(`./enterprise/sql/${file}`,import.meta.url),'utf8'));
   db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(?,?)').run(version,Date.now());
   db.exec(`PRAGMA user_version=${version}`);
   if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Migration foreign key check failed');
   db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
 }
}
