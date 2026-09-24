import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../../src/db.mjs';
import {appendAudit as appendSqliteAudit} from '../../src/security.mjs';
import {appendAudit,verifyAudit} from '../../src/enterprise/security-store.mjs';
import {createTestDatabase} from './db-fixture.mjs';

const key=Buffer.alloc(32,71);
async function fixture(t){const f=await createTestDatabase();t.after(()=>f.close());t.diagnostic(`SQL engine: ${f.engine}`);return f;}
async function history(db,count=1001){
 const source=openDb(':memory:',{withSnapshot:false});
 try{
  for(let n=0;n<count;n++)appendSqliteAudit(source,{action:'audit.scale',target:String(n),at:1780000000000+n},key);
  const rows=source.prepare('SELECT * FROM audit ORDER BY id').all(),checkpoint=source.prepare("SELECT value FROM meta WHERE key='audit_chain_head'").get().value;
  await db.transaction(async tx=>{
   await tx.query(`INSERT INTO audit(id,actor_id,action,target,created_at,metadata,request_id,prev_hash,event_hash)
    SELECT id,actor_id,action,target,created_at,metadata,request_id,prev_hash,event_hash
    FROM jsonb_to_recordset($1::jsonb) AS x(id bigint,actor_id text,action text,target text,created_at bigint,metadata text,request_id text,prev_hash text,event_hash text)`,[JSON.stringify(rows)]);
   await tx.query("INSERT INTO meta(key,value) VALUES('audit_chain_head',$1)",[checkpoint]);
  });
  return {rows,head:JSON.parse(checkpoint)};
 }finally{source.close();}
}

test('paged audit verifies captured prefix without writer lock and detects altered, missing and mismatched history',async t=>{
 const {db}=await fixture(t),seeded=await history(db),queries=[];
 const observed={transaction:callback=>db.transaction(tx=>callback({...tx,
  query:async(sql,params)=>{queries.push(sql);return tx.query(sql,params);},
  get:async(sql,params)=>{queries.push(sql);return tx.get(sql,params);},
  all:async(sql,params)=>{queries.push(sql);return tx.all(sql,params);},
 }))};
 assert.deepEqual(await verifyAudit(observed,key),{ok:true,count:1001,head:seeded.head});
 assert.equal(queries.some(sql=>sql.includes('pg_advisory_xact_lock')),false,'verification must not hold the global writer lock');
 assert.equal(queries.filter(sql=>/SELECT \* FROM audit WHERE/.test(sql)).length,3,'history is traversed in bounded pages');
 await db.query("UPDATE audit SET target='changed' WHERE id=501");
 assert.equal((await verifyAudit(db,key)).reason,'event_hash');
 await db.query('UPDATE audit SET target=$1 WHERE id=501',[seeded.rows[500].target]);
 await db.query('DELETE FROM audit WHERE id=1001');
 assert.equal((await verifyAudit(db,key)).reason,'checkpoint');
 await db.query("UPDATE meta SET value='not JSON' WHERE key='audit_chain_head'");
 assert.equal((await verifyAudit(db,key)).reason,'checkpoint');
});

test('operator transaction scan remains pinned to one captured tail as new events append',async t=>{
 const {db}=await fixture(t),seeded=await history(db,2);let appended=false;
 const observed={transaction:callback=>db.transaction(tx=>callback({...tx,
  all:async(sql,params)=>{
   const rows=await tx.all(sql,params);
   if(!appended&&/SELECT \* FROM audit WHERE/.test(sql)){appended=true;await appendAudit(tx,{action:'appended.after.capture'},key);}
   return rows;
  },
 }))};
 assert.deepEqual(await verifyAudit(observed,key),{ok:true,count:2,head:seeded.head});
 const after=await verifyAudit(db,key);assert.equal(after.ok,true);assert.equal(after.count,3);
 assert.equal((await verifyAudit(db,key,{expectedHead:seeded.head})).reason,'external_checkpoint');
});

test('native PostgreSQL append commits while repeatable-read audit verification is paused',async t=>{
 if(!process.env.PG_TEST_URL){t.skip('Native PostgreSQL is required to demonstrate nonblocking concurrent writers');return;}
 const {db,db2}=await fixture(t),seeded=await history(db);
 assert.equal(typeof db.readSnapshot,'function');
 let reached,release;const scanning=new Promise(resolve=>{reached=resolve;}),resume=new Promise(resolve=>{release=resolve;});
 let paused=false;
 const observed={readSnapshot:callback=>db.readSnapshot(tx=>callback({...tx,
  all:async(sql,params)=>{
   const rows=await tx.all(sql,params);
   if(!paused&&/SELECT \* FROM audit WHERE/.test(sql)){paused=true;reached();await resume;}
   return rows;
  },
 }))};
 const verification=verifyAudit(observed,key);
 let timer;
 try{
  await scanning;
  await Promise.race([
   appendAudit(db2,{action:'concurrent.writer'},key),
   new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Audit verifier blocked the writer')),2000);}),
  ]);
 }finally{clearTimeout(timer);release();}
 assert.deepEqual(await verification,{ok:true,count:1001,head:seeded.head});
 const after=await verifyAudit(db,key);assert.equal(after.ok,true);assert.equal(after.count,1002);
});
