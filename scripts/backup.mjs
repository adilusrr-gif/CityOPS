import {DatabaseSync,backup} from 'node:sqlite';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdir,chmod,rm,stat,writeFile,open} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {parseArgs} from 'node:util';

export const FORMAT='cityquest-sqlite-backup-v1';
export function encryptionKey(value,{required=false}={}) {
 if(!value){if(required)throw new Error('BACKUP_ENCRYPTION_KEY is required in production');return null;}
 if(typeof value!=='string'||!/^[a-f0-9]{64}$/i.test(value))throw new Error('BACKUP_ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
 return Buffer.from(value,'hex');
}
export async function sha256(path){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
export async function syncFile(path){const file=await open(path,'r');try{await file.sync();}finally{await file.close();}}
export async function syncDirectory(path){
 // Directory fsync is supported on the production Linux filesystem; Windows may reject it.
 try{await syncFile(path);}catch(error){if(process.platform!=='win32'||!['EINVAL','EPERM','EISDIR'].includes(error.code))throw error;}
}
export function integrityCheck(path){
 const db=new DatabaseSync(path,{readOnly:true,timeout:5000});
 try{
  const results=db.prepare('PRAGMA integrity_check').all();
  if(results.length!==1||Object.values(results[0])[0]!=='ok')throw new Error('SQLite integrity_check failed');
  // Page/B-tree integrity alone accepts dangling references. Reject them both
  // when producing a backup and before installing a restored legacy snapshot.
  if(db.prepare('PRAGMA foreign_key_check').get())throw new Error('SQLite foreign_key_check failed');
 }
 finally{db.close();}
}

export async function createBackup({database=process.env.DATABASE_PATH||'./data/almaty.sqlite',output,key=process.env.BACKUP_ENCRYPTION_KEY,production=process.env.NODE_ENV==='production'}={}) {
 const secret=encryptionKey(key,{required:production});
 const source=resolve(database);if(!(await stat(source)).isFile())throw new Error('Source database must be a file');
 const destination=resolve(output||join('backups',`${new Date().toISOString().replaceAll(':','-')}-${randomBytes(4).toString('hex')}`));
 await mkdir(dirname(destination),{recursive:true,mode:0o700});
 // Exclusive new directory: never truncate an earlier backup or the live database.
 await mkdir(destination,{mode:0o700});
 const snapshot=join(destination,'snapshot.sqlite');let db;
 try{
  db=new DatabaseSync(source,{readOnly:true,timeout:5000});
  await backup(db,snapshot,{rate:100});db.close();db=null;
  await chmod(snapshot,0o600);
  // Normalize ONLY the private snapshot to DELETE journal mode. An online backup
  // inherits WAL mode; opening that copy read-only can otherwise leave sidecars.
  const standalone=new DatabaseSync(snapshot,{timeout:5000});
  try{standalone.exec('PRAGMA journal_mode=DELETE');}finally{standalone.close();}
  integrityCheck(snapshot);
  // Standalone backup must never rely on source WAL/SHM sidecars.
  const sqliteSha256=await sha256(snapshot);let file='snapshot.sqlite',encryption=null;
  if(secret){
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(Buffer.from(FORMAT));
   file='snapshot.sqlite.enc';
   await pipeline(createReadStream(snapshot),cipher,createWriteStream(join(destination,file),{flags:'wx',mode:0o600}));
   encryption={algorithm:'aes-256-gcm',iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),keyId:createHash('sha256').update(secret).digest('hex').slice(0,16)};
   await rm(snapshot);
  }
  const payload=join(destination,file);
  const manifest={format:FORMAT,createdAt:new Date().toISOString(),engine:'sqlite',file,bytes:(await stat(payload)).size,sha256:await sha256(payload),sqliteSha256,encryption};
  await syncFile(payload);
  await writeFile(join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  await syncFile(join(destination,'manifest.json'));await syncDirectory(destination);await syncDirectory(dirname(destination));
  return {directory:destination,...manifest};
 }catch(error){await rm(destination,{recursive:true,force:true});throw error;}
 finally{if(db)db.close();}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.env.DATABASE_URL)throw new Error('This tool handles SQLite only. Use PostgreSQL cluster backup/PITR procedures in docs/PRODUCTION-HA.md.');
  const {values}=parseArgs({options:{database:{type:'string'},output:{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('Usage: node scripts/backup.mjs [--database PATH] [--output NEW_DIRECTORY]\nUses BACKUP_ENCRYPTION_KEY (64 hex); required when NODE_ENV=production.');
  else console.log(JSON.stringify(await createBackup(values),null,2));
 }catch(error){console.error(`Backup failed: ${error.message}`);process.exitCode=1;}
}
