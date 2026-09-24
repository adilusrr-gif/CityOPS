import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv,promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generateProductionEnv} from '../scripts/init-env.mjs';

async function fixture(t){const folder=await mkdtemp(join(tmpdir(),'cityquest-env-'));t.after(()=>rm(folder,{recursive:true,force:true}));return {folder,output:join(folder,'.env.production')};}

test('production initializer generates three independent keys, password and hardened settings in a private file',async t=>{
 const {output}=await fixture(t);assert.deepEqual(await generateProductionEnv({origin:'https://quest.example.com',admin:'Admin+Ops@example.com',output}),{file:output});
 const config=parseEnv(await readFile(output,'utf8')),keys=['DATA_ENCRYPTION_KEY','AUDIT_HMAC_KEY','BACKUP_ENCRYPTION_KEY'].map(name=>config[name]);
 assert.ok(keys.every(value=>/^[a-f0-9]{64}$/.test(value)));assert.equal(new Set(keys).size,3);assert.match(config.ADMIN_PASSWORD,/^[A-Za-z0-9_-]{32}$/);
 assert.equal(config.ADMIN_EMAIL,'admin+ops@example.com');assert.equal(config.NODE_ENV,'production');assert.equal(config.PUBLIC_ORIGIN,'https://quest.example.com');assert.equal(config.COOKIE_SECURE,'true');assert.equal(config.REQUIRE_ADMIN_MFA,'true');assert.equal(config.TRUST_PROXY,'loopback');assert.equal(config.SESSION_IDLE_MINUTES,'30');assert.equal(config.DATABASE_PATH,'./data/almaty.sqlite');
 if(process.platform!=='win32')assert.equal((await stat(output)).mode&0o777,0o600);
});

test('initializer refuses to overwrite an existing file',async t=>{
 const {output}=await fixture(t);await writeFile(output,'existing credentials\n');
 await assert.rejects(generateProductionEnv({origin:'https://quest.example.com',admin:'admin@example.com',output}),{code:'EEXIST'});
 assert.equal(await readFile(output,'utf8'),'existing credentials\n');
});

test('initializer rejects noncanonical or insecure origins before writing',async t=>{
 const {folder,output}=await fixture(t);
 for(const origin of [undefined,'http://quest.example.com','https://quest.example.com/','https://user:pass@quest.example.com','https://quest.example.com/path','https://quest.example.com?q=1','https://quest.example.com#fragment','https://QUEST.example.com','https://quest.example.com\n'])await assert.rejects(generateProductionEnv({origin,admin:'admin@example.com',output}),/origin/);
 assert.deepEqual(await readdir(folder),[]);
});

test('initializer rejects email newline injection before writing',async t=>{
 const {folder,output}=await fixture(t);
 await assert.rejects(generateProductionEnv({origin:'https://quest.example.com',admin:'admin@example.com\nCOOKIE_SECURE=false',output}),/email/);
 assert.deepEqual(await readdir(folder),[]);
});

test('initializer CLI reports a file path without printing generated secrets',async t=>{
 const {output}=await fixture(t),script=fileURLToPath(new URL('../scripts/init-env.mjs',import.meta.url));
 const result=await promisify(execFile)(process.execPath,[script,'--origin','https://quest.example.com','--admin','admin@example.com','--output',output]);
 const config=parseEnv(await readFile(output,'utf8')),printed=result.stdout+result.stderr;
 assert.ok(printed.includes(output));for(const name of ['ADMIN_PASSWORD','DATA_ENCRYPTION_KEY','AUDIT_HMAC_KEY','BACKUP_ENCRYPTION_KEY'])assert.ok(!printed.includes(config[name]));
});
