import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
test('SQLite operator commands fail closed with DATABASE_URL and create no misleading local data',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cq-operator-mode-'));
 try{
  for(const script of ['admin','import-osm','backup','restore']){
   const file=fileURLToPath(new URL(`../scripts/${script}.mjs`,import.meta.url));
   const result=spawnSync(process.execPath,[file],{cwd:dir,env:{...process.env,DATABASE_URL:'postgresql://unused@localhost/unused'},encoding:'utf8'});
   assert.notEqual(result.status,0,script);assert.match(result.stderr,/PostgreSQL|SQLite only/,script);
   assert.deepEqual(await readdir(dir),[],script);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
