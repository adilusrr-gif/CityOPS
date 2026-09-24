import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const program=resolve('deploy/generate-k8s-secrets.mjs');
function run(destination,env={},extra=[]) {
  const clean={...process.env};delete clean.DATA_ENCRYPTION_KEY;delete clean.AUDIT_HMAC_KEY;
  return spawnSync(process.execPath,[program,'--db-host','cityquest-pg-rw.cityquest.svc.cluster.local','--admin','admin@example.com','--output',destination,...extra],{encoding:'utf8',env:{...clean,...env}});
}
async function temporary(t){const dir=await mkdtemp(join(tmpdir(),'cityquest-deployment-'));t.after(()=>rm(dir,{recursive:true,force:true}));return join(dir,'secrets.json');}
test('secret bundle separates SQL roles, reuses keys across replicas and hides credentials',async t=>{
 const path=await temporary(t),result=run(path);assert.equal(result.status,0,result.stderr);
 const bundle=JSON.parse(await readFile(path,'utf8'));const secrets=Object.fromEntries(bundle.items.map(x=>[x.metadata.name,x.stringData]));
 const runtime=secrets['cityquest-runtime'],migration=secrets['cityquest-migration'];
 assert.equal(runtime.DATA_ENCRYPTION_KEY,migration.DATA_ENCRYPTION_KEY);assert.equal(runtime.AUDIT_HMAC_KEY,migration.AUDIT_HMAC_KEY);assert.notEqual(runtime.DATA_ENCRYPTION_KEY,runtime.AUDIT_HMAC_KEY);
 assert.equal(new URL(runtime.DATABASE_URL).username,'cityquest_app');assert.equal(new URL(migration.DATABASE_URL).username,'cityquest_owner');
 assert.equal(new URL(runtime.DATABASE_URL).password,secrets['cityquest-pg-app'].password);assert.equal(new URL(migration.DATABASE_URL).password,secrets['cityquest-pg-owner'].password);
 assert.equal(runtime.METRICS_TOKEN,secrets['cityquest-metrics'].token);assert.equal(runtime.ADMIN_PASSWORD,undefined);
 for(const s of Object.values(secrets))for(const [key,value] of Object.entries(s))if(/KEY|PASSWORD|password|TOKEN|DATABASE_URL/.test(key))assert.ok(!(result.stdout+result.stderr).includes(value));
 if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o777,0o600);
});
test('existing bundle is never overwritten',async t=>{
 const path=await temporary(t);assert.equal(run(path).status,0);const original=await readFile(path);assert.notEqual(run(path).status,0);assert.deepEqual(await readFile(path),original);
});
test('migration preserves explicit original keys, incomplete or equivalent keys are rejected',async t=>{
 const path=await temporary(t);const keys={DATA_ENCRYPTION_KEY:'ab'.repeat(32),AUDIT_HMAC_KEY:'cd'.repeat(32)};
 assert.equal(run(path,keys).status,0);const runtime=JSON.parse(await readFile(path,'utf8')).items[0].stringData;assert.equal(runtime.DATA_ENCRYPTION_KEY,keys.DATA_ENCRYPTION_KEY);assert.equal(runtime.AUDIT_HMAC_KEY,keys.AUDIT_HMAC_KEY);
 assert.notEqual(run(path+'.incomplete',{DATA_ENCRYPTION_KEY:keys.DATA_ENCRYPTION_KEY}).status,0);
 assert.notEqual(run(path+'.equal',{DATA_ENCRYPTION_KEY:'ab'.repeat(32),AUDIT_HMAC_KEY:'AB'.repeat(32)}).status,0);
});
test('invalid parameters cannot create a secret file',async t=>{
 const path=await temporary(t);assert.notEqual(run(path,{},['--db-host','evil/host']).status,0);await assert.rejects(stat(path),{code:'ENOENT'});
});
