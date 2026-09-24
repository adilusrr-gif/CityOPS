import test from 'node:test';
import assert from 'node:assert/strict';
import {openDb} from '../src/db.mjs';
import {createFeatureStore,get,run,audit,sqliteStatement,requireActor} from '../src/features/store.mjs';

function fixture(t){
 const db=openDb(':memory:',{withSnapshot:false});t.after(()=>db.close());
 const store=createFeatureStore({db,dialect:'sqlite',cfg:{idleMs:60000,requireAdminMfa:true},audit(connection,actor,action,target){
  connection.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run(`test-audit:${action}`,target);
  if(action==='reject')throw new Error('audit unavailable');
 }});
 return {db,store};
}
test('SQLite generator transactions are synchronous, reorder bindings and roll back with audit',t=>{
 const {db,store}=fixture(t);
 const result=store.transaction(function*(){
  assert.equal((yield run('INSERT INTO meta(key,value) VALUES($2,$1)',['value','portable'])).rowCount,1);
  yield audit(null,'created','portable');
  return yield get("SELECT value,$1 AS repeated,$1 AS again,'$2 FOR UPDATE' AS literal FROM meta WHERE key=$2 FOR UPDATE",['same','portable']);
 });
 assert.equal(result.then,undefined);assert.deepEqual({...result},{value:'value',repeated:'same',again:'same',literal:'$2 FOR UPDATE'});
 assert.throws(()=>store.transaction(function*(){yield run("INSERT INTO meta VALUES('rolled','back')");yield audit(null,'reject','rolled');}),/audit unavailable/);
 assert.equal(db.prepare("SELECT * FROM meta WHERE key='rolled'").get(),undefined);
 assert.equal(db.prepare("SELECT * FROM meta WHERE key='test-audit:reject'").get(),undefined);
});

test('SQLite feature units reject async work and unknown operations without leaving transactions open',t=>{
 const {db,store}=fixture(t);
 assert.throws(()=>store.transaction(async function*(){yield get('SELECT 1');}),/synchronous generator/);
 assert.throws(()=>store.transaction(function*(){yield run("INSERT INTO meta VALUES('bad','op')");yield {kind:'run',sql:'DELETE FROM users'};}),/Unknown/);
 assert.throws(()=>store.transaction(function*(){yield run("INSERT INTO meta VALUES('bad','promise')");return Promise.resolve();}),/Promise/);
 assert.throws(()=>store.read(function*(){yield run('DELETE FROM users');}),/transaction/);
 assert.equal(db.isTransaction,false);assert.equal(db.prepare("SELECT * FROM meta WHERE key='bad'").get(),undefined);
 const asyncAudit=createFeatureStore({db,dialect:'sqlite',audit:async()=>{}});
 assert.throws(()=>asyncAudit.transaction(function*(){yield run("INSERT INTO meta VALUES('bad','audit')");yield audit(null,'async','x');}),/asynchronous/);
 assert.equal(db.isTransaction,false);assert.equal(db.prepare("SELECT * FROM meta WHERE key='bad'").get(),undefined);
});

test('nested SQLite feature units preserve outer transaction and SQL failures always abort their unit',t=>{
 const {db,store}=fixture(t);db.exec('BEGIN IMMEDIATE');
 db.prepare("INSERT INTO meta VALUES('outer','kept')").run();
 assert.throws(()=>store.transaction(function*(){yield run("INSERT INTO meta VALUES('inner','lost')");throw new Error('inner failed');}),/inner failed/);
 assert.equal(db.isTransaction,true);
 assert.throws(()=>store.transaction(function*(){try{yield run("INSERT INTO meta VALUES('outer','duplicate')");}catch{yield run("INSERT INTO meta VALUES('concealed','yes')");}}),/UNIQUE/);
 store.transaction(function*(){yield run("INSERT INTO meta VALUES('recovered','yes')");});
 db.exec('COMMIT');
 assert.equal(db.prepare("SELECT * FROM meta WHERE key='inner'").get(),undefined);
 assert.equal(db.prepare("SELECT * FROM meta WHERE key='concealed'").get(),undefined);
 assert.equal(store.read(function*(){return yield get("SELECT value FROM meta WHERE key='recovered'");}).value,'yes');
});

test('SQLite actor validation rereads role, disable flag, MFA and revoked or idle sessions',t=>{
 const {db,store}=fixture(t),now=Date.now(),user={id:'actor',session_id:'actor-session',role:'admin'};
 db.prepare("INSERT INTO users(id,email,name,password,role,created_at) VALUES('actor','a@example.test','A','unused','admin',?)").run(now);
 db.prepare("INSERT INTO sessions(token,user_id,expires,id,created_at,last_seen,mfa_verified) VALUES('hash','actor',?,'actor-session',?,?,0)").run(now+600000,now,now);
 const actor=()=>store.transaction(function*(){return yield* store.requireActor(user,['admin']);});
 assert.throws(actor,e=>e.status===423);
 db.prepare('UPDATE users SET mfa_enabled=1 WHERE id=?').run(user.id);db.prepare('UPDATE sessions SET mfa_verified=1').run();
 assert.equal(actor().role,'admin');
 db.prepare("UPDATE users SET role='player'").run();assert.throws(actor,e=>e.status===403);
 db.prepare("UPDATE users SET role='admin',disabled=1").run();assert.throws(actor,e=>e.status===401);
 db.prepare('UPDATE users SET disabled=0').run();db.prepare('UPDATE sessions SET last_seen=?').run(now-60001);assert.throws(actor,e=>e.status===401);
 db.prepare('DELETE FROM sessions').run();assert.throws(actor,e=>e.status===401);
});

test('SQLite SQL adaptation preserves comments, quoted identifiers and literal parameters',()=>{
 const result=sqliteStatement(`SELECT $2, '$1 FOR UPDATE', "column$1", $1, $2 -- $1 FOR UPDATE
 /* $2 FOR UPDATE */ FOR NO KEY UPDATE`,['first','second']);
 assert.deepEqual(result.params,['second','first','second']);
 assert.match(result.sql,/'\$1 FOR UPDATE'/);assert.match(result.sql,/"column\$1"/);assert.match(result.sql,/-- \$1 FOR UPDATE/);
 assert.match(result.sql,/\/\* \$2 FOR UPDATE \*\//);assert.doesNotMatch(result.sql,/FOR NO KEY UPDATE/);
 assert.throws(()=>sqliteStatement('SELECT $2',['one']),/missing/);
});

test('actor validation uses the time after locks, rejecting a session that expires while waiting',t=>{
 let now=1_800_000_000_000;t.mock.method(Date,'now',()=>now);
 const work=requireActor({id:'actor',session_id:'session'},['player'],{cfg:{idleMs:60000}});
 work.next();
 work.next({id:'actor',role:'player',disabled:0});
 const session={session_id:'session',expires:now+60000,last_seen:now,session_mfa_verified:0};
 now+=60001;
 assert.throws(()=>work.next(session),e=>e.status===401);
});
