import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {envInteger} from '../http-policy.mjs';
import {openDb} from '../db.mjs';
import {createFeatureStore} from '../features/store.mjs';
import {seedAdventureFeatures} from '../features/seed.mjs';

export const PG_SCHEMA_VERSION = 7;
const MIGRATION_LOCK = [172989, 1];
const types = {getTypeParser(oid, format) {
 if (oid === 20 && format !== 'binary') return value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('PostgreSQL bigint exceeds JavaScript safe integer range');
  return number;
 };
 return pg.types.getTypeParser(oid, format);
}};
let nextSavepoint = 0;

function connectionWrapper(client) {
 const db = {
  isTransaction: true,
  query(sql, params = []) {return client.query(sql, params);},
  async get(sql, params = []) {return (await db.query(sql, params)).rows[0];},
  async all(sql, params = []) {return (await db.query(sql, params)).rows;},
  async run(sql, params = []) {return {rowCount: (await db.query(sql, params)).rowCount};},
  async transaction(callback) {
   const savepoint = `cq_${++nextSavepoint}`;
   await client.query(`SAVEPOINT ${savepoint}`);
   try {const result = await callback(db); await client.query(`RELEASE SAVEPOINT ${savepoint}`); return result;}
   catch (error) {
    try {await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await client.query(`RELEASE SAVEPOINT ${savepoint}`);} catch {}
    throw error;
   }
  },
 };
 return db;
}

// Build a single explicit TLS policy before node-postgres parses the URL. URL
// TLS/compat flags can otherwise replace a supplied ssl object, including its CA.
export function postgresConnectionOptions({env = process.env, connectionString = env.DATABASE_URL, ssl, schema, max = envInteger(env,'PG_POOL_MAX',10,1,100), ...options} = {}) {
 if (!connectionString) throw new Error('DATABASE_URL is required for enterprise mode');
 if (!Number.isInteger(max) || max < 1 || max > 100) throw new TypeError('PG pool max must be between 1 and 100');
 const url = new URL(connectionString);
 if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new TypeError('DATABASE_URL must use postgres:// or postgresql://');
 if(url.hash)throw new Error('DATABASE_URL must not contain a fragment');
 const tlsParameter = name => /^ssl/i.test(name) || name.toLowerCase() === 'uselibpqcompat';
 if ([...url.searchParams.keys()].some(tlsParameter)) throw new Error('DATABASE_URL must not contain TLS or compatibility parameters; use PGSSLMODE and PGSSLROOTCERT');
 if([...url.searchParams.keys()].length)throw new Error('DATABASE_URL query parameters are not supported; use explicit PG_* environment settings');
 if(env.PGOPTIONS?.trim()||process.env.PGOPTIONS?.trim())throw new Error('PGOPTIONS is not supported; use explicit PG_* environment settings');
 if(options.options!==undefined)throw new Error('PostgreSQL startup options must use explicit PG_* environment settings');
 // A single schema is needed by isolated native database tests. Do not reopen
 // arbitrary startup options: a space, comma or quote would allow extra GUCs or
 // search-path entries and could silently disable the timeout/TLS policy.
 if(schema!==undefined&&(typeof schema!=='string'||!/^[_a-z][_a-z0-9]{0,62}$/.test(schema)))throw new TypeError('PostgreSQL schema must be one lowercase SQL identifier (at most 63 bytes)');
 if (Object.keys(options).some(tlsParameter)) throw new Error('Pass TLS configuration through PGSSLMODE, PGSSLROOTCERT or the ssl object only');
 const sslMode = env.PGSSLMODE || (env.NODE_ENV === 'production' ? 'verify-full' : undefined);
 if (sslMode && !['disable','verify-full'].includes(sslMode)) throw new Error('Use PGSSLMODE=verify-full (or disable for local development only)');
 if (ssl !== undefined && typeof ssl !== 'boolean' && (!ssl || typeof ssl !== 'object' || Array.isArray(ssl))) throw new TypeError('PostgreSQL ssl must be a boolean or TLS object');
 if (ssl && typeof ssl === 'object') {
  if (ssl.rejectUnauthorized !== undefined && ssl.rejectUnauthorized !== true) throw new Error('PostgreSQL TLS certificate verification cannot be disabled');
  const allowed = new Set(['ca','cert','key','passphrase','rejectUnauthorized','minVersion']);
  if (Object.keys(ssl).some(name => !allowed.has(name))) throw new Error('Unsupported PostgreSQL TLS option; server identity overrides are forbidden');
 }
 if (env.NODE_ENV === 'production' && (sslMode === 'disable' || ssl === false)) throw new Error('Production PostgreSQL connections require verified TLS');
 if (sslMode === 'verify-full' && ssl === false) throw new Error('Verified PostgreSQL TLS cannot be disabled');
 if (sslMode === 'disable' && ssl) throw new Error('PGSSLMODE=disable conflicts with explicit TLS configuration');
 const enabled = sslMode === 'verify-full' || Boolean(ssl);
 // Set false explicitly in local mode so pg never rereads a different process
// environment after policy evaluation. All enabled TLS verifies CA and hostname.
 const tls = enabled ? {...(typeof ssl === 'object' ? ssl : {}), rejectUnauthorized:true,
  ...(env.PGSSLROOTCERT ? {ca:readFileSync(env.PGSSLROOTCERT,'utf8')} : {})} : false;
 const timeout=(name,option,fallback,min,maxValue)=>{
  const value=options[option]??envInteger(env,name,fallback,min,maxValue);
  if(!Number.isSafeInteger(value)||value<min||value>maxValue)throw new Error(`${name} must be an integer between ${min} and ${maxValue}`);
  return value;
 };
 return {connectionString:url.toString(),ssl:tls,max,idleTimeoutMillis:30_000,application_name:'city-quest',...options,
  ...(schema===undefined?{}:{options:`-c search_path=${schema}`}),
  connectionTimeoutMillis:timeout('PG_CONNECTION_TIMEOUT_MS','connectionTimeoutMillis',5000,100,30000),
  statement_timeout:timeout('PG_STATEMENT_TIMEOUT_MS','statement_timeout',15000,100,60000),
  lock_timeout:timeout('PG_LOCK_TIMEOUT_MS','lock_timeout',5000,100,30000),
  idle_in_transaction_session_timeout:timeout('PG_IDLE_TRANSACTION_TIMEOUT_MS','idle_in_transaction_session_timeout',30000,1000,120000),types};
}

// This function deliberately does not migrate or seed. A deployment migration Job
// finishes before pods start; application replicas never race to initialize data.
export async function openPostgres(options = {}) {
 const settings=postgresConnectionOptions(options),pool=new pg.Pool(settings);
 const queueLimit=envInteger(options.env||process.env,'PG_POOL_QUEUE_LIMIT',20,0,200),capacity=settings.max+queueLimit;
 let admitted=0,rejected=0,closing=false;
 pool.on('error',error=>console.error(JSON.stringify({event:'postgres_idle_connection_error',code:error.code||'CONNECTION_ERROR'})));
 const unavailable=(code)=>Object.assign(new Error('База временно занята. Повторите запрос позже.'),{code,status:503,retryAfter:1});
 async function withClient(callback){
  if(closing)throw unavailable('POOL_CLOSED');
  if(admitted>=capacity){rejected++;throw unavailable('POOL_BUSY');}
  admitted++;let client,broken=false;
  try{client=await pool.connect();return await callback(client,()=>{broken=true;});}
  catch(error){
   // node-postgres pool wait timeout has no SQLSTATE. Preserve a controlled
   // retryable response while never replaying a request/ambiguous COMMIT.
   if(!client&&(/timeout|terminated/i.test(error.message)||['ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(error.code)))throw unavailable('POOL_BUSY');
   throw error;
  }finally{client?.release(broken);admitted--;}
 }
 async function transaction(callback,readOnly=false){return withClient(async(client,markBroken)=>{
  try{
   await client.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY':'BEGIN');
   const result=await callback(connectionWrapper(client));
   const committed=await client.query('COMMIT');
   if(committed.command!=='COMMIT')throw Object.assign(new Error('Transaction was aborted before COMMIT'),{code:'TRANSACTION_ABORTED'});
   return result;
  }catch(error){try{await client.query('ROLLBACK');}catch{markBroken();}throw error;}
 });}
 const db={
  isTransaction:false,
  query(sql,params=[]){return withClient(client=>client.query(sql,params));},
  async get(sql,params=[]){return (await db.query(sql,params)).rows[0];},
  async all(sql,params=[]){return (await db.query(sql,params)).rows;},
  async run(sql,params=[]){return {rowCount:(await db.query(sql,params)).rowCount};},
  transaction(callback){return transaction(callback);},
  readSnapshot(callback){return transaction(callback,true);},
  metrics(){return {admitted,rejected,capacity,total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount};},
  async close(){closing=true;await pool.end();}
 };
 try{await db.query('SELECT 1');}catch(error){await db.close();throw error;}
 return db;
}

export async function migratePostgres(db) {
 const migrations = [
  {version:3, file:'003-enterprise.sql'},
  {version:4, file:'004-pet-billing.sql'},
  {version:5, file:'005-adventures.sql'},
  {version:6, file:'006-query-indexes.sql'},
  {version:7, file:'007-quest-metadata.sql'},
 ].map(migration => {
  const sql=readFileSync(new URL(`./sql/${migration.file}`,import.meta.url),'utf8');
  return {...migration,sql,checksum:createHash('sha256').update(sql).digest('hex')};
 });
 return db.transaction(async tx => {
  await tx.query('SELECT pg_advisory_xact_lock($1,$2)', MIGRATION_LOCK);
  await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY,applied_at bigint NOT NULL,checksum text)');
  const newest = await tx.get('SELECT MAX(version) AS version FROM schema_migrations');
  if (newest.version > PG_SCHEMA_VERSION) throw new Error('Database schema is newer than this application');
  let migrated=false;
  for(const {version,sql,checksum} of migrations){
   const applied=await tx.get('SELECT * FROM schema_migrations WHERE version=$1',[version]);
   if(applied){
    if(applied.checksum!==checksum)throw new Error(`Applied PostgreSQL migration ${version} checksum does not match`);
    continue;
   }
   await tx.query(sql);
   await tx.query('INSERT INTO schema_migrations(version,applied_at,checksum) VALUES($1,$2,$3)',[version,Date.now(),checksum]);
   migrated=true;
  }
  return {version:PG_SCHEMA_VERSION,migrated};
 });
}

// FK ordering is intentional. Imported rows retain all v2 columns, including
// hashes, signed audit metadata, recovery codes, ownership, locations and IDs.
export const FEATURE_TABLES = Object.freeze(['pets','pet_rewards','pet_chat_requests','pet_messages','pet_usage','billing_orders','billing_entitlements','promotions']);
export const ADVENTURE_TABLES = Object.freeze(['adventure_routes','adventure_checkins','adventure_rewards','territory_zones','territory_visits','photo_contests','photos','photo_storage','photo_upload_usage','photo_discovery_rewards','photo_votes','photo_reports']);
export const LEGACY_TRANSFER_TABLES = Object.freeze(['meta','users','sessions','organizations','quests','completions','explored','positions','teams','members','audit','recovery_codes','login_challenges','reward_tokens','rate_limits']);
export const TRANSFER_TABLES = Object.freeze([...LEGACY_TRANSFER_TABLES,...FEATURE_TABLES,...ADVENTURE_TABLES]);
export const AUTH_TABLES = Object.freeze(['oidc_states','oidc_identities','mobile_auth_codes']);

export async function requireEmptyDestination(tx) {
 await tx.query('SELECT pg_advisory_xact_lock($1,$2)', MIGRATION_LOCK);
 await tx.query(`LOCK TABLE ${[...TRANSFER_TABLES, ...AUTH_TABLES].join(',')} IN ACCESS EXCLUSIVE MODE`);
 for (const table of [...TRANSFER_TABLES, ...AUTH_TABLES]) {
  if (await tx.get(`SELECT 1 FROM ${table} LIMIT 1`)) throw new Error(`PostgreSQL destination must be empty; ${table} already contains data`);
 }
}

export async function copySqliteRows(tx, source, {tables = TRANSFER_TABLES} = {}) {
 const counts = {};
 for (const table of tables) {
  if (!TRANSFER_TABLES.includes(table)) throw new Error('Unrecognized transfer table');
  const columns = source.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.length) throw new Error(`Source is missing table ${table}`);
  // Columns come from a validated local schema, but quote them independently.
  const identifiers = columns.map(name => `"${name.replaceAll('"','""')}"`).join(',');
  let batch=[],batchBytes=0;
  counts[table]=0;
  async function flush() {
   if(!batch.length)return;
   const params=[];
   const tuples = batch.map(row => `(${columns.map(name => {params.push(row[name]);return `$${params.length}`;}).join(',')})`);
   await tx.query(`INSERT INTO ${table}(${identifiers}) VALUES ${tuples.join(',')}`, params);
   batch=[];batchBytes=0;
  }
  // Photographs make whole-table materialization unbounded. Iterate the source
  // snapshot and cap both row count and encoded payload per PostgreSQL batch.
  for(const row of source.prepare(`SELECT * FROM ${table}`).iterate()){
   const bytes=columns.reduce((total,name)=>total+(typeof row[name]==='string'?Buffer.byteLength(row[name]):8),0);
   if(batch.length&&(batch.length>=250||batchBytes+bytes>4*1024*1024))await flush();
   batch.push(row);batchBytes+=bytes;counts[table]++;
  }
  await flush();
 }
 return counts;
}

export async function seedPostgres(db) {
 // No source accounts exist: openDb creates only editorial quests and OSM data.
 let source;
 try {
  return await db.transaction(async tx => {
   await tx.query('SELECT pg_advisory_xact_lock($1,$2)', MIGRATION_LOCK);
   const marker = await tx.get("SELECT value FROM meta WHERE key='enterprise_initialized'");
   if (marker) {
    // Explicit --seed also adds new editorial content to existing installations.
    // Repeated runs preserve changed/closed routes and unpublished contests.
    await createFeatureStore({db:tx,dialect:'postgres'}).transaction(seedAdventureFeatures);
    return {seeded:false, initialized:marker.value,editorialSeedsChecked:true};
   }
   await requireEmptyDestination(tx);
   // Existing installations only need the small additive editorial seed above.
   // Materialize the bundled organization snapshot once for an empty database.
   source=openDb(':memory:');
   const counts = await copySqliteRows(tx, source);
   await tx.query("INSERT INTO meta(key,value) VALUES('enterprise_initialized','seed-v5')");
   return {seeded:true, counts};
  });
 } finally {source?.close();}
}
