import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import pg from 'pg';
import {openPostgres,postgresConnectionOptions} from '../../src/enterprise/db.mjs';

test('validated PostgreSQL timeout policy cannot be overridden by URL or ambient startup options',()=>{
 const base={env:{PG_STATEMENT_TIMEOUT_MS:'1234',PG_LOCK_TIMEOUT_MS:'2345',PG_IDLE_TRANSACTION_TIMEOUT_MS:'3456'},connectionString:'postgres://db.example.test/game'};
 const parsed=new pg.Client(postgresConnectionOptions(base)).connectionParameters;
 assert.equal(parsed.statement_timeout,1234);assert.equal(parsed.lock_timeout,2345);assert.equal(parsed.idle_in_transaction_session_timeout,3456);
 for(const key of ['statement_timeout','lock_timeout','idle_in_transaction_session_timeout','query_timeout','connect_timeout','options'])assert.throws(()=>postgresConnectionOptions({...base,connectionString:base.connectionString+'?'+key+'=0'}),/query parameters/);
 assert.throws(()=>postgresConnectionOptions({...base,env:{PGOPTIONS:'-c statement_timeout=0'}}),/PGOPTIONS/);
 for(const [key,values] of Object.entries({PG_POOL_MAX:['0','101','NaN','1e1'],PG_CONNECTION_TIMEOUT_MS:['0','30001'],PG_STATEMENT_TIMEOUT_MS:['0','60001'],PG_LOCK_TIMEOUT_MS:['0','30001'],PG_IDLE_TRANSACTION_TIMEOUT_MS:['0','120001']}))for(const value of values)assert.throws(()=>postgresConnectionOptions({...base,env:{[key]:value}}),new RegExp(key==='PG_POOL_MAX'?'PG_POOL_MAX|pool max':key));
});

test('node-postgres admission bounds pending work and read snapshots prohibit writes',async t=>{
 const engine=await PGlite.create(),socket=new PGLiteSocketServer({db:engine,port:0,host:'127.0.0.1',maxConnections:1});let db,release;
 t.after(async()=>{release?.();if(db)await db.close();await socket.stop();await engine.close();});await socket.start();
 db=await openPostgres({connectionString:`postgres://postgres:postgres@${socket.getServerConn()}/postgres`,ssl:false,max:1,env:{PG_POOL_QUEUE_LIMIT:'1',PG_CONNECTION_TIMEOUT_MS:'1000'}});
 await db.query('CREATE TABLE admission_probe(id integer PRIMARY KEY)');
 let entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const held=db.transaction(async tx=>{await tx.query('SELECT 1');entered();await gate;});await started;
 const queued=db.get('SELECT 42 AS value');assert.equal(db.metrics().admitted,2);
 await assert.rejects(db.get('SELECT 99 AS value'),{status:503,code:'POOL_BUSY',retryAfter:1});assert.equal(db.metrics().rejected,1);
 release();await held;assert.equal((await queued).value,42);assert.equal(db.metrics().admitted,0);
 await db.readSnapshot(async tx=>assert.equal((await tx.get('SELECT COUNT(*) AS n FROM admission_probe')).n,0));
 await assert.rejects(db.readSnapshot(tx=>tx.query('INSERT INTO admission_probe VALUES(1)')),{code:'25006'});
 await assert.rejects(db.transaction(async tx=>{await tx.query('INSERT INTO admission_probe VALUES(7)');try{await tx.query('INSERT INTO admission_probe VALUES(7)');}catch{}return 'must not report success';}),{code:'TRANSACTION_ABORTED'});
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM admission_probe')).n,0);
 // A queued checkout times out cleanly; it must never execute later.
 let entered2;const started2=new Promise(resolve=>entered2=resolve),gate2=new Promise(resolve=>release=resolve);
 const held2=db.transaction(async tx=>{await tx.query('SELECT 1');entered2();await gate2;});await started2;
 await assert.rejects(db.query('INSERT INTO admission_probe VALUES(2)'),{status:503,code:'POOL_BUSY'});assert.equal(db.metrics().admitted,1);
 release();await held2;assert.equal((await db.get('SELECT COUNT(*) AS n FROM admission_probe')).n,0);
 await db.close();await assert.rejects(db.query('SELECT 1'),{status:503,code:'POOL_CLOSED'});db=null;
 t.diagnostic('Real pg pool over TCP backed by one serialized PGlite connection; no native PostgreSQL concurrency claim');
});
