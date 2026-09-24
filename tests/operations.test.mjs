import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import http from 'node:http';
import {createBackup,sha256} from '../scripts/backup.mjs';
import {restoreBackup} from '../scripts/restore.mjs';
import {runLoadTest} from '../scripts/load-test.mjs';

const key='ab'.repeat(32);
async function fixture(t){
 const folder=await mkdtemp(join(tmpdir(),'cityquest-operations-')),database=join(folder,'source.sqlite'),db=new DatabaseSync(database);
 db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE ledger(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO ledger VALUES(1,\'committed\')');
 t.after(async()=>{try{db.close();}finally{await rm(folder,{recursive:true,force:true});}});
 return {folder,database,db};
}
function rows(path){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT * FROM ledger ORDER BY id').all().map(r=>({...r}));}finally{db.close();}}

test('online backup captures committed WAL data and excludes an open uncommitted transaction',async t=>{
 const {folder,database,db}=await fixture(t);assert.ok((await stat(database+'-wal')).size>0);
 db.exec("BEGIN IMMEDIATE;INSERT INTO ledger VALUES(2,'uncommitted')");
 const output=join(folder,'backup'),backup=await createBackup({database,output,key:'',production:false});db.exec('ROLLBACK');
 assert.equal(backup.encryption,null);assert.equal(backup.sha256,backup.sqliteSha256);
 const restored=await restoreBackup({input:output,output:join(folder,'restored.sqlite')});
 assert.equal(restored.integrity,'ok');assert.deepEqual(rows(restored.database),[{id:1,value:'committed'}]);
 assert.deepEqual((await readdir(folder)).filter(name=>name.startsWith('.restore-')),[]);
});

test('AES-256-GCM encrypted backup round trips and leaves no plaintext backup',async t=>{
 const {folder,database}=await fixture(t),output=join(folder,'encrypted');
 const manifest=await createBackup({database,output,key,production:true});
 assert.equal(manifest.encryption.algorithm,'aes-256-gcm');assert.equal(manifest.encryption.iv.length,24);
 assert.deepEqual((await readdir(output)).sort(),['manifest.json','snapshot.sqlite.enc']);
 const restored=await restoreBackup({input:output,output:join(folder,'restored.sqlite'),key});
 assert.deepEqual(rows(restored.database),[{id:1,value:'committed'}]);
 if(process.platform!=='win32')assert.equal((await stat(restored.database)).mode&0o777,0o600);
});

test('wrong encryption key fails authentication and cleans temporary plaintext',async t=>{
 const {folder,database}=await fixture(t),output=join(folder,'encrypted');await createBackup({database,output,key,production:true});
 await assert.rejects(restoreBackup({input:output,output:join(folder,'wrong.sqlite'),key:'cd'.repeat(32)}));
 assert.equal((await readdir(folder)).includes('wrong.sqlite'),false);assert.deepEqual((await readdir(folder)).filter(name=>name.startsWith('.restore-')),[]);
});

test('production rejects missing and malformed keys before creating a backup',async t=>{
 const {folder,database}=await fixture(t),output=join(folder,'bad');
 await assert.rejects(createBackup({database,output,key:'',production:true}),/required/);
 await assert.rejects(createBackup({database,output,key:'not-a-key',production:true}),/64 hex/);
 assert.equal((await readdir(folder)).includes('bad'),false);
});

test('backup never overwrites an existing destination and restore never overwrites an existing database or sidecar',async t=>{
 const {folder,database}=await fixture(t),output=join(folder,'backup');
 await createBackup({database,output,key:'',production:false});const before=await readFile(join(output,'manifest.json'));
 await assert.rejects(createBackup({database,output,key:'',production:false}),/EEXIST/);assert.deepEqual(await readFile(join(output,'manifest.json')),before);
 await assert.rejects(restoreBackup({input:output,output:database}),/Refusing to overwrite/);
 await writeFile(join(folder,'stale.sqlite-wal'),'oldwal');await assert.rejects(restoreBackup({input:output,output:join(folder,'stale.sqlite')}),/sidecar/);
 assert.deepEqual(rows(database),[{id:1,value:'committed'}]);
});

test('corrupted payload is rejected before restore',async t=>{
 const {folder,database}=await fixture(t),output=join(folder,'backup');await createBackup({database,output,key:'',production:false});
 const payload=join(output,'snapshot.sqlite'),data=await readFile(payload);data[100]^=255;await writeFile(payload,data);
 await assert.rejects(restoreBackup({input:output,output:join(folder,'restored.sqlite')}),/checksum/);
 assert.equal((await readdir(folder)).includes('restored.sqlite'),false);
});

test('integrity_check rejects invalid SQLite even when manifest hashes match',async t=>{
 const {folder,database}=await fixture(t),output=join(folder,'backup');await createBackup({database,output,key:'',production:false});
 const payload=join(output,'snapshot.sqlite'),manifestFile=join(output,'manifest.json'),manifest=JSON.parse(await readFile(manifestFile));
 await writeFile(payload,Buffer.alloc(4096));manifest.bytes=4096;manifest.sha256=manifest.sqliteSha256=await sha256(payload);await writeFile(manifestFile,JSON.stringify(manifest));
 await assert.rejects(restoreBackup({input:output,output:join(folder,'restored.sqlite')}));
 assert.equal((await readdir(folder)).includes('restored.sqlite'),false);assert.deepEqual((await readdir(folder)).filter(name=>name.startsWith('.restore-')),[]);
});

test('manifest cannot select a payload outside the backup directory',async t=>{
 const {folder,database}=await fixture(t),output=join(folder,'backup');await createBackup({database,output,key:'',production:false});
 const manifestFile=join(output,'manifest.json'),manifest=JSON.parse(await readFile(manifestFile));manifest.file='../source.sqlite';await writeFile(manifestFile,JSON.stringify(manifest));
 await assert.rejects(restoreBackup({input:output,output:join(folder,'restored.sqlite')}),/Invalid backup manifest/);
});

test('load harness counts HTTP errors, validates responses and includes city in every request',async t=>{
 const seen=[];const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');seen.push(url.searchParams.get('city'));res.setHeader('content-type','application/json');
  if(url.pathname==='/api/config'){res.statusCode=503;res.end('{}');return;}
  res.end(JSON.stringify(url.pathname==='/api/health'?{ok:true}:{items:[]}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const report=await runLoadTest({url:`http://127.0.0.1:${server.address().port}`,duration:.2,concurrency:2,rps:100,city:'astana'});
 assert.ok(report.requests>=4);assert.ok(report.errors>0);assert.equal(report.networkErrors,0);assert.equal(report.statuses['503'],report.errors);assert.ok(report.latency.p99Ms>=report.latency.p50Ms);assert.ok(seen.every(city=>city==='astana'));
});

test('load harness rejects non-local targets before sending requests',async()=>{
 await assert.rejects(runLoadTest({url:'https://example.com',duration:.1}),/Only loopback/);
 await assert.rejects(runLoadTest({url:'http://user:pass@127.0.0.1',duration:.1}),/without credentials/);
});
