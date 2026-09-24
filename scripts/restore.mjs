import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,mkdtemp,readFile,stat,lstat,rm,link,chmod} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDecipheriv,randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {parseArgs} from 'node:util';
import {FORMAT,encryptionKey,sha256,integrityCheck,syncFile,syncDirectory} from './backup.mjs';

export async function restoreBackup({input,output,key=process.env.BACKUP_ENCRYPTION_KEY}={}){
 if(!input)throw new Error('--input BACKUP_DIRECTORY is required');
 const source=resolve(input),manifestPath=join(source,'manifest.json');
 if((await stat(manifestPath)).size>65536)throw new Error('Manifest is too large');
 const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
 if(manifest.format!==FORMAT||manifest.engine!=='sqlite'||!['snapshot.sqlite','snapshot.sqlite.enc'].includes(manifest.file)||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<1||!(/^[a-f0-9]{64}$/).test(manifest.sha256)||!(/^[a-f0-9]{64}$/).test(manifest.sqliteSha256))throw new Error('Invalid backup manifest');
 if(Boolean(manifest.encryption)!==(manifest.file==='snapshot.sqlite.enc'))throw new Error('Inconsistent backup manifest');
 const secret=manifest.encryption?encryptionKey(key,{required:true}):null;
 if(manifest.encryption&&(manifest.encryption.algorithm!=='aes-256-gcm'||!(/^[a-f0-9]{24}$/).test(manifest.encryption.iv)||!(/^[a-f0-9]{32}$/).test(manifest.encryption.tag)))throw new Error('Invalid encryption metadata');
 const payload=join(source,manifest.file),info=await lstat(payload);
 if(!info.isFile()||info.size!==manifest.bytes||await sha256(payload)!==manifest.sha256)throw new Error('Backup payload checksum or size mismatch');
 const target=resolve(output||join('data',`restored-${Date.now()}-${randomBytes(4).toString('hex')}.sqlite`));
 // Restoring in-place is intentionally unsupported, including stale SQLite sidecars.
 for(const path of [target,`${target}-wal`,`${target}-shm`,`${target}-journal`]){
  try{await lstat(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  throw new Error(`Refusing to overwrite existing database or sidecar: ${path}`);
 }
 await mkdir(dirname(target),{recursive:true,mode:0o700});
 const staging=await mkdtemp(join(dirname(target),'.restore-'));await chmod(staging,0o700);
 const temporary=join(staging,'validated.sqlite');
 try{
  if(secret){const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(manifest.encryption.iv,'hex'));decipher.setAAD(Buffer.from(FORMAT));decipher.setAuthTag(Buffer.from(manifest.encryption.tag,'hex'));await pipeline(createReadStream(payload),decipher,createWriteStream(temporary,{flags:'wx',mode:0o600}));}
  else await pipeline(createReadStream(payload),createWriteStream(temporary,{flags:'wx',mode:0o600}));
  if(await sha256(temporary)!==manifest.sqliteSha256)throw new Error('Restored SQLite checksum mismatch');
  integrityCheck(temporary);await syncFile(temporary);
  // A hard link is an atomic no-overwrite install on the same filesystem.
  await link(temporary,target);await syncDirectory(dirname(target));
  return {database:target,integrity:'ok',backupCreatedAt:manifest.createdAt,sqliteSha256:manifest.sqliteSha256};
 }finally{await rm(staging,{recursive:true,force:true});}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.env.DATABASE_URL)throw new Error('This tool handles SQLite only. Use PostgreSQL cluster backup/PITR procedures in docs/PRODUCTION-HA.md.');const {values}=parseArgs({options:{input:{type:'string'},output:{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('Usage: node scripts/restore.mjs --input BACKUP_DIRECTORY [--output NEW_SQLITE_PATH]\nNever overwrites. Stop the app before switching DATABASE_PATH to the restored file.');
  else console.log(JSON.stringify(await restoreBackup(values),null,2));
 }catch(error){console.error(`Restore failed: ${error.message}`);process.exitCode=1;}
}
