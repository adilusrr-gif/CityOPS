import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createTestDatabase} from './db-fixture.mjs';
import {pruneEnterpriseData} from '../../src/enterprise/maintenance.mjs';

const now=1800000000000,idleMs=1800000;
async function user(db,id){await db.run("INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$1,'unused','player',$3)",[id,id+'@example.test',now-7200000]);}
async function session(db,{token,userId='cleanup-user',expires=now+60000,lastSeen=now}){
 await db.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen) VALUES($1,$1,$2,$3,$4,$5)',[token,userId,expires,now-7200000,lastSeen]);
}

test('PostgreSQL cleanup respects expiry, preserves current state and bounds each sweep',async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());t.diagnostic(`Database engine: ${f.engine}`);
 await user(f.db,'cleanup-user');await user(f.db,'position-boundary');
 await session(f.db,{token:'expired-session',expires:now});
 await session(f.db,{token:'idle-session',lastSeen:now-idleMs});
 await session(f.db,{token:'fresh-session'});
 await f.db.run("INSERT INTO positions(user_id,lng,lat,accuracy,updated_at,city_id) VALUES('cleanup-user',71.43,51.12,10,$1,'astana'),('position-boundary',71.43,51.12,10,$2,'astana')",[now-3600001,now-3600000]);
 for(const suffix of ['expired','fresh']){
  const expires=suffix==='expired'?now:now+60000;
  await f.db.run('INSERT INTO login_challenges(id_hash,user_id,expires) VALUES($1,$2,$3)',[suffix,'cleanup-user',expires]);
  await f.db.run("INSERT INTO oidc_states(state_hash,binding_hash,nonce,verifier_secret,platform,expires,created_at) VALUES($1,'binding','nonce','encrypted','web',$2,$3)",[suffix,expires,now]);
  await f.db.run("INSERT INTO mobile_auth_codes(code_hash,user_id,code_challenge,expires,created_at) VALUES($1,'cleanup-user','challenge',$2,$3)",[suffix,expires,now]);
 }
 await f.db.run("INSERT INTO rate_limits(key,count,reset_at) SELECT 'old-'||lpad(n::text,4,'0'),1,$1 FROM generate_series(1,1005) AS n",[now]);
 await f.db.run("INSERT INTO rate_limits(key,count,reset_at) VALUES('fresh-rate',1,$1)",[now+60000]);
 const removed=await pruneEnterpriseData(f.db,{now,idleMs});
 assert.deepEqual(removed,{sessions:2,positions:1,login_challenges:1,oidc_states:1,mobile_auth_codes:1,rate_limits:1000});
 assert.deepEqual((await f.db.all('SELECT token FROM sessions')).map(row=>row.token),['fresh-session']);
 assert.deepEqual((await f.db.all('SELECT user_id FROM positions')).map(row=>row.user_id),['position-boundary']);
 for(const [table,key] of [['login_challenges','id_hash'],['oidc_states','state_hash'],['mobile_auth_codes','code_hash']])assert.deepEqual((await f.db.all(`SELECT ${key} FROM ${table}`)).map(row=>row[key]),['fresh']);
 assert.equal((await f.db.get('SELECT count(*) n FROM rate_limits')).n,6);
 const second=await pruneEnterpriseData(f.db2,{now,idleMs});assert.equal(second.rate_limits,5);assert.equal(second.sessions,0);
 assert.deepEqual(await f.db.all('SELECT key FROM rate_limits'),[{key:'fresh-rate'}]);
 await assert.rejects(()=>pruneEnterpriseData(f.db,{now:Infinity}),/safe integer/);
 await assert.rejects(()=>pruneEnterpriseData(f.db,{idleMs:NaN}),/positive safe integer/);
 await f.db.transaction(async tx=>{await assert.rejects(()=>pruneEnterpriseData(tx,{now,idleMs}),/autocommit/);});
 // A later maintenance failure must not retain locks or roll back an earlier
 // successful table sweep. The fixture schema is discarded after this test.
 await session(f.db,{token:'expired-before-later-failure',expires:now});
 await f.db.run('DROP TABLE oidc_states');
 await assert.rejects(()=>pruneEnterpriseData(f.db,{now,idleMs}),error=>error.code==='42P01');
 assert.equal(await f.db.get("SELECT token FROM sessions WHERE token='expired-before-later-failure'"),undefined);
});

test('native PostgreSQL cleanup skips a locked authentication row without blocking another table',{timeout:10000},async t=>{
 const f=await createTestDatabase();t.after(()=>f.close());
 if(f.engine!=='postgres-native'){
  t.skip('SKIP LOCKED concurrency requires PG_TEST_URL and two native PostgreSQL connections; WASM fallback serializes transactions');return;
 }
 await user(f.db,'cleanup-user');await session(f.db,{token:'locked-expired',expires:now});await session(f.db,{token:'unlocked-expired',expires:now});
 await f.db.run("INSERT INTO login_challenges(id_hash,user_id,expires) VALUES('expired-challenge','cleanup-user',$1)",[now]);
 let lockReady,release;
 const ready=new Promise(resolve=>{lockReady=resolve;}),unblock=new Promise(resolve=>{release=resolve;});
 const holder=f.db.transaction(async tx=>{await tx.get("SELECT token FROM sessions WHERE token='locked-expired' FOR UPDATE");lockReady();await unblock;});
 await ready;
 try{
  // A short native connection statement timeout turns accidental waiting into a
  // failed test. The locked row must survive while independent expiry proceeds.
  await f.db2.query("SET statement_timeout='2000ms'");
  const removed=await pruneEnterpriseData(f.db2,{now,idleMs});assert.equal(removed.sessions,1);assert.equal(removed.login_challenges,1);
  assert.equal((await f.db2.get('SELECT count(*) n FROM sessions')).n,1);
  assert.equal((await f.db2.get("SELECT token FROM sessions WHERE token='locked-expired'")).token,'locked-expired');
 }finally{release();await holder;}
 const removed=await pruneEnterpriseData(f.db2,{now,idleMs});assert.equal(removed.sessions,1);
});
