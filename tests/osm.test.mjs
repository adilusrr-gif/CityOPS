import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {openDb} from '../src/db.mjs';
import {importOsm} from '../src/osm.mjs';
import {verifyAudit} from '../src/security.mjs';

const dataset=(name='Импортированная карточка')=>({osm3s:{timestamp_osm_base:'2026-09-23T18:17:56Z'},elements:[{type:'node',id:987650000001,lat:51.1282,lon:71.4304,tags:{name,amenity:'cafe'}}]});
const importedCard=db=>db.prepare("SELECT * FROM organizations WHERE osm_id='node/987650000001'").get();

test('OSM updates advance editor versions and timestamps; claimed cards remain untouched',()=>{
 const db=openDb(':memory:',{withSnapshot:false});
 try{
  importOsm(db,dataset(),'astana');const original=importedCard(db);assert.equal(original.version,1);assert.ok(original.updated_at>0);
  db.prepare('UPDATE organizations SET updated_at=1 WHERE id=?').run(original.id);
  let called=0;
  const result=importOsm(db,dataset('Обновлено источником'),'astana',{onImported:report=>{
   called++;assert.equal(db.isTransaction,true);assert.equal(report.cityId,'astana');assert.equal(report.updated,1);assert.equal(report.inserted,0);assert.equal(report.sourceTimestamp,'2026-09-23T18:17:56Z');
   const changed=importedCard(db);assert.equal(changed.version,original.version+1);assert.equal(changed.updated_at,report.at);assert.equal(changed.name,'Обновлено источником');
  }});
  assert.equal(called,1);assert.deepEqual(result,{inserted:0,updated:1,skipped:0});
  db.prepare('INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run('osm-owner','osm@example.test','Владелец','unused','business',Date.now());
  db.prepare('UPDATE organizations SET owner_id=? WHERE id=?').run('osm-owner',original.id);const claimed=importedCard(db);
  assert.deepEqual(importOsm(db,dataset('Нельзя перезаписать'),'astana'),{inserted:0,updated:0,skipped:1});assert.deepEqual(importedCard(db),claimed);
 }finally{db.close();}
});

test('an import callback failure rolls back inserts, updates, editor versions and import metadata',()=>{
 const db=openDb(':memory:',{withSnapshot:false});
 try{
  importOsm(db,dataset(),'astana');const original=importedCard(db),before=db.prepare("SELECT key,value FROM meta WHERE key LIKE 'osm_import%' ORDER BY key").all();
  const data=dataset('Не должно сохраниться');data.elements.push({...data.elements[0],id:987650000002});
  assert.throws(()=>importOsm(db,data,'astana',{onImported:report=>{assert.equal(report.updated,1);assert.equal(report.inserted,1);throw new Error('Audit write failed');}}),/Audit write failed/);
  assert.deepEqual(importedCard(db),original);assert.equal(db.prepare("SELECT id FROM organizations WHERE osm_id='node/987650000002'").get(),undefined);
  assert.deepEqual(db.prepare("SELECT key,value FROM meta WHERE key LIKE 'osm_import%' ORDER BY key").all(),before);assert.equal(db.isTransaction,false);
 }finally{db.close();}
});

test('the OSM operator CLI signs its import report with the server audit key',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'cityquest-osm-cli-'));let db;
 try{
  const path=join(directory,'catalog.sqlite'),file=join(directory,'import.json');db=openDb(path,{withSnapshot:false});
  db.exec("INSERT INTO meta(key,value) VALUES('bundled_osm_v1','fixture'),('bundled_osm_astana_v1','fixture')");db.close();db=null;await writeFile(file,JSON.stringify(dataset()));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/import-osm.mjs',import.meta.url)),'--city','astana','--file',file],{encoding:'utf8',env:{...process.env,NODE_ENV:'test',DATABASE_PATH:path,DATA_ENCRYPTION_KEY:'11'.repeat(32),AUDIT_HMAC_KEY:'22'.repeat(32)},timeout:10000});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).inserted,1);
  db=openDb(path,{withSnapshot:false});assert.ok(importedCard(db));const row=db.prepare("SELECT * FROM audit WHERE action='osm.import'").get();assert.equal(row.target,'astana');assert.equal(row.actor_id,null);
  const metadata=JSON.parse(row.metadata);assert.equal(metadata.source,'local_cli');assert.equal(metadata.cityId,'astana');assert.equal(metadata.inserted,1);assert.equal(verifyAudit(db,Buffer.from('22'.repeat(32),'hex')).ok,true);
 }finally{if(db)db.close();await rm(directory,{recursive:true,force:true});}
});
