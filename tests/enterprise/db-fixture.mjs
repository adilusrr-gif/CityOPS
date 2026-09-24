import {randomBytes} from 'node:crypto';
import {openPostgres,migratePostgres,seedPostgres} from '../../src/enterprise/db.mjs';

let savepointId=0;
function wasmAdapter(engine,isTransaction=false){
 const db={
  isTransaction,
  async query(sql,params=[]){
   const result=params.length?await engine.query(sql,params):(await engine.exec(sql)).at(-1)||{};
   return {rows:result.rows||[],rowCount:result.affectedRows || result.rows?.length || 0};
  },
  async get(sql,params=[]){return (await db.query(sql,params)).rows[0];},
  async all(sql,params=[]){return (await db.query(sql,params)).rows;},
  async run(sql,params=[]){return {rowCount:(await db.query(sql,params)).rowCount};},
  async transaction(callback){
   if(!isTransaction)return engine.transaction(async tx=>callback(wasmAdapter(tx,true)));
   const name=`fixture_${++savepointId}`;
   await db.query(`SAVEPOINT ${name}`);
   try{const result=await callback(db);await db.query(`RELEASE SAVEPOINT ${name}`);return result;}
   catch(error){await db.query(`ROLLBACK TO SAVEPOINT ${name}`);await db.query(`RELEASE SAVEPOINT ${name}`);throw error;}
  },
 };
 return db;
}

// The fallback executes the actual PostgreSQL WASM engine, with no SQL matching
// or mock results. It serializes transactions and is NOT evidence of multi-node
// concurrency, process failover, network/TLS behavior or PostgreSQL replication.
export async function createTestDatabase({seed=false}={}){
 let db,db2,engine,cleanup;
 if(process.env.PG_TEST_URL){
  const schema=`cq_test_${randomBytes(10).toString('hex')}`;
  const admin=await openPostgres({connectionString:process.env.PG_TEST_URL,max:2});
  try{
   await admin.query(`CREATE SCHEMA ${schema}`);
   db=await openPostgres({connectionString:process.env.PG_TEST_URL,max:8,schema});
   db2=await openPostgres({connectionString:process.env.PG_TEST_URL,max:8,schema});
  }catch(error){if(db)await db.close();if(db2)await db2.close();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.close();throw error;}
  engine='postgres-native';
  cleanup=async()=>{await Promise.all([db.close(),db2.close()]);await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();};
 }else{
  if(process.env.PG_TEST_REQUIRED==='true')throw new Error('PG_TEST_URL is required by this test gate');
  const {PGlite}=await import('@electric-sql/pglite');
  const pg=await PGlite.create({parsers:{20:value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new RangeError('PostgreSQL bigint exceeds JavaScript safe integer range');return n;}}});
  db=wasmAdapter(pg);db2=wasmAdapter(pg);engine='pglite-wasm-serialized';
  cleanup=()=>pg.close();
 }
 let closed=false;
 const close=async()=>{if(closed)return;closed=true;await cleanup();};
 try{await migratePostgres(db);if(seed)await seedPostgres(db);}
 catch(error){await close();throw error;}
 return {db,db2,engine,close};
}
export const freshTestDb=createTestDatabase;
