import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {openPostgres,migratePostgres} from '../../src/enterprise/db.mjs';
import {appendAudit,verifyAudit} from '../../src/enterprise/security-store.mjs';

// Exercises the real node-postgres pool/type parsers and transaction wrapper over
// TCP. One PGlite connection deliberately avoids its experimental multiplexing;
// this is protocol coverage, not a native PostgreSQL concurrency/HA test.
test('node-postgres TCP adapter runs migrations, bound transactions, savepoints and bigint parsing',async t=>{
 const engine=await PGlite.create(),socket=new PGLiteSocketServer({db:engine,port:0,host:'127.0.0.1',maxConnections:1});
 let db;
 t.after(async()=>{if(db)await db.close();await socket.stop();await engine.close();});
 await socket.start();
 db=await openPostgres({connectionString:`postgres://postgres:postgres@${socket.getServerConn()}/postgres`,ssl:false,max:1});
 await migratePostgres(db);
 assert.equal((await db.get('SELECT 1780000000000::bigint AS at')).at,1780000000000);
 await db.transaction(async tx=>{
  await tx.query("INSERT INTO meta VALUES('kept','yes')");
  await assert.rejects(tx.transaction(async nested=>{await nested.query("INSERT INTO meta VALUES('discard','yes')");throw new Error('discard');}),/discard/);
  await appendAudit(tx,{action:'protocol.commit'},Buffer.alloc(32,51));
 });
 await assert.rejects(db.transaction(async tx=>{await tx.query("UPDATE meta SET value='no' WHERE key='kept'");await appendAudit(tx,{action:'protocol.rollback'},Buffer.alloc(32,51));throw new Error('rollback');}),/rollback/);
 assert.equal((await db.get("SELECT value FROM meta WHERE key='kept'")).value,'yes');
 assert.equal(await db.get("SELECT value FROM meta WHERE key='discard'"),undefined);
 assert.equal((await verifyAudit(db,Buffer.alloc(32,51))).count,1);
 t.diagnostic('PostgreSQL protocol: pg pool over TCP, PGlite WASM engine, one connection; native HA not tested');
});
