import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBackup,sha256} from '../scripts/backup.mjs';
import {restoreBackup} from '../scripts/restore.mjs';

async function fixture(t){
 const folder=await mkdtemp(join(tmpdir(),'cq-u7-ops-')),database=join(folder,'source.sqlite');
 t.after(()=>rm(folder,{recursive:true,force:true}));
 const db=new DatabaseSync(database);
 db.exec('CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id)); INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1)');
 db.close();return {folder,database};
}
function corruptReference(path){
 const db=new DatabaseSync(path);
 try{db.exec('PRAGMA foreign_keys=OFF; DELETE FROM parent');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.ok(db.prepare('PRAGMA foreign_key_check').get());}
 finally{db.close();}
}

test('backup rejects relational corruption even when SQLite pages are intact and removes the rejected copy',async t=>{
 const {folder,database}=await fixture(t);corruptReference(database);
 const output=join(folder,'backup');
 await assert.rejects(createBackup({database,output,key:'',production:false}),/foreign_key_check/);
 await assert.rejects(stat(output),{code:'ENOENT'});
 assert.ok((await stat(database)).isFile());
});

test('restore rejects a checksummed legacy backup containing dangling references without publishing it',async t=>{
 const {folder,database}=await fixture(t),input=join(folder,'backup'),output=join(folder,'restored.sqlite');
 await createBackup({database,output:input,key:'',production:false});
 const payload=join(input,'snapshot.sqlite'),manifestFile=join(input,'manifest.json');
 corruptReference(payload);
 const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
 manifest.bytes=(await stat(payload)).size;manifest.sha256=manifest.sqliteSha256=await sha256(payload);
 await writeFile(manifestFile,JSON.stringify(manifest));
 await assert.rejects(restoreBackup({input,output}),/foreign_key_check/);
 await assert.rejects(stat(output),{code:'ENOENT'});
 assert.deepEqual((await readdir(folder)).filter(name=>name.startsWith('.restore-')),[]);
});

test('HA rolling strategy can advance on the minimum three nodes while retaining the availability floor',async()=>{
 const manifest=await readFile(new URL('../deploy/k8s/base/application.yaml',import.meta.url),'utf8');
 const value=name=>Number(manifest.match(new RegExp(`^\\s*${name}: (\\d+)\\s*$`,'m'))?.[1]);
 const replicas=value('replicas'),surge=value('maxSurge'),unavailable=value('maxUnavailable'),floor=value('minAvailable');
 assert.match(manifest,/requiredDuringSchedulingIgnoredDuringExecution:/);
 assert.match(manifest,/topologyKey: kubernetes\.io\/hostname/);
 assert.equal(replicas,3);assert.ok(replicas-unavailable>=floor&&floor>=2);
 // Every existing pod occupies one required hostname; there is no fourth node.
 // Either an old slot can be released or a surge could fit in spare capacity.
 const minimumNodes=3,freeNodes=minimumNodes-replicas;
 assert.ok(unavailable>0||(surge>0&&freeNodes>0),'rolling update would deadlock under required host anti-affinity');
});
