import test from 'node:test';
import {createTestDatabase} from './db-fixture.mjs';
import {createEnterpriseApp} from '../../src/enterprise/server.mjs';
import {questMetadataSuite} from '../helpers/quest-metadata-suite.mjs';
test('PostgreSQL quest metadata HTTP contract and game invariants',async t=>{
 const storage=await createTestDatabase(),app=await createEnterpriseApp({db:storage.db,keys:{encryptionKey:Buffer.alloc(32,41),auditKey:Buffer.alloc(32,43)},env:{NODE_ENV:'test',REQUIRE_ADMIN_MFA:'false'}});
 t.after(async()=>{await app.close();await storage.close();});t.diagnostic(storage.engine);
 await questMetadataSuite(t,{db:storage.db,dialect:'postgres',server:app.server});
});

test('PostgreSQL schema 6 metadata upgrade preserves revision and reward ledger with no fabricated estimates',async t=>{
 const storage=await createTestDatabase(),db=storage.db;t.after(()=>storage.close());t.diagnostic(storage.engine);
 const {REMOVE_QUEST_METADATA_SQL}=await import('../helpers/quest-schema.mjs'),{migratePostgres}=await import('../../src/enterprise/db.mjs'),{default:assert}=await import('node:assert/strict');
 await db.query(REMOVE_QUEST_METADATA_SQL);await db.query('DELETE FROM schema_migrations WHERE version=7');
 await db.run("INSERT INTO users(id,email,name,password,role,xp,created_at) VALUES('legacy','legacy@example.test','Legacy','hash','player',130,1700000000000)");
 await db.run("INSERT INTO quests(id,title,description,lng,lat,radius,xp,scope,verification,status,created_at,city_id,version,updated_at) VALUES('legacy-quest','Legacy quest','Legacy objective description',76.95,43.25,100,130,'public','checkin','published',1700000000000,'almaty',9,1700000000001)");
 await db.run("INSERT INTO completions(user_id,quest_id,xp,created_at) VALUES('legacy','legacy-quest',130,1700000000002)");
 const before=await db.get("SELECT * FROM quests WHERE id='legacy-quest'"),completion=await db.get('SELECT * FROM completions');
 assert.deepEqual(await migratePostgres(db),{version:7,migrated:true});assert.deepEqual(await migratePostgres(db),{version:7,migrated:false});
 const {difficulty,difficulty_reason,estimated_minutes,objective_steps_json,hint,...after}=await db.get("SELECT * FROM quests WHERE id='legacy-quest'");assert.deepEqual(after,before);assert.deepEqual({difficulty,difficulty_reason,estimated_minutes,objective_steps_json,hint},{difficulty:null,difficulty_reason:'',estimated_minutes:null,objective_steps_json:'[]',hint:''});
 assert.deepEqual(await db.get('SELECT * FROM completions'),completion);assert.equal((await db.get("SELECT xp FROM users WHERE id='legacy'")).xp,130);
});
