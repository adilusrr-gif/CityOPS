import test from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './db-fixture.mjs';
import {consumeRate,pruneRateLimits} from '../../src/enterprise/security-store.mjs';

const now=1800000000000;
test('rate-limit admission cleanup removes a bounded expired batch and preserves active counters',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());
 await f.db.run("INSERT INTO rate_limits(key,count,reset_at) VALUES('expired-a',2,$1),('expired-b',3,$1),('active',4,$2)",[now,now+1000]);
 assert.equal(await pruneRateLimits(f.db,{now,limit:1}),1);
 assert.deepEqual(await f.db.all('SELECT key,count FROM rate_limits ORDER BY key'),[{key:'active',count:4},{key:'expired-b',count:3}]);
 assert.equal((await consumeRate(f.db,'new-key',{now,limit:1,windowMs:1000,maxKeys:2})).allowed,true);
 assert.equal((await consumeRate(f.db,'new-key',{now,limit:1,windowMs:1000,maxKeys:2})).allowed,false);
 assert.deepEqual(await f.db.all('SELECT key,count FROM rate_limits ORDER BY key'),[{key:'active',count:4},{key:'new-key',count:2}]);
});

test('native rate admission skips a counter being refreshed without blocking global capacity admission',{timeout:10000},async t=>{
 if(!process.env.PG_TEST_URL){t.skip('Native PostgreSQL is required for concurrent row-lock and snapshot behavior');return;}
 const f=await createTestDatabase();t.after(()=>f.close());
 await f.db.run("INSERT INTO rate_limits(key,count,reset_at) VALUES('refreshing',8,$1),('expired',1,$1)",[now]);
 let ready,release;const locked=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve);
 const holder=f.db.transaction(async tx=>{
  await tx.query("UPDATE rate_limits SET count=1,reset_at=$1 WHERE key='refreshing'",[now+1000]);
  ready();await gate;
 });
 await locked;
 try{
  // SET LOCAL is pinned to the same transaction as admission; no pool checkout
  // can silently pick a different connection with a longer timeout.
  const result=await f.db2.transaction(async tx=>{
   await tx.query("SET LOCAL statement_timeout='1000ms'");
   return consumeRate(tx,'new-key',{now,limit:2,windowMs:1000,maxKeys:3});
  });
  assert.equal(result.allowed,true);
 }finally{release();await holder;}
 assert.deepEqual(await f.db.get("SELECT count,reset_at FROM rate_limits WHERE key='refreshing'"),{count:1,reset_at:now+1000});
 assert.equal((await consumeRate(f.db,'refreshing',{now,limit:1,windowMs:1000,maxKeys:3})).allowed,false,'a refreshed counter must keep its consumed request');
});
