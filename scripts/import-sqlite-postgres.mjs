import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';
import {realpathSync} from 'node:fs';
import {openPostgres,migratePostgres,requireEmptyDestination,copySqliteRows,LEGACY_TRANSFER_TABLES,FEATURE_TABLES,TRANSFER_TABLES} from '../src/enterprise/db.mjs';
import {verifyAudit as verifySqliteAudit,decryptSecret} from '../src/security.mjs';
import {verifyAudit as verifyPostgresAudit} from '../src/enterprise/security-store.mjs';
import {decryptPetText} from '../src/features/pet-crypto.mjs';

// Source is read-only and kept in a read transaction for a consistent WAL
// snapshot. Destination copy+verification+marker commit as a single transaction.
// Stop SQLite writers before cutover: this is a one-time snapshot, not CDC replication.
export async function importSqlitePostgres({db,sqlitePath,auditKey,encryptionKey}) {
 if(!sqlitePath)throw new Error('SQLite source path is required');
 const validKey=value=>(Buffer.isBuffer(value)&&value.length===32)||(typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value));
 if(!validKey(auditKey)||!validKey(encryptionKey))throw new Error('The existing AUDIT_HMAC_KEY and DATA_ENCRYPTION_KEY are required as 32-byte keys; never generate replacement keys during migration');
 const source=new DatabaseSync(realpathSync(sqlitePath),{readOnly:true});
 try {
  source.exec('PRAGMA foreign_keys=ON; BEGIN');
  const version=source.prepare('PRAGMA user_version').get().user_version;
  if(![2,3,4,5,6].includes(version))throw new Error('Source must be a supported SQLite schema 2, 3, 4, 5 or 6 database; upgrade and verify it first');
  const integrity=source.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||integrity[0].integrity_check!=='ok'||source.prepare('PRAGMA foreign_key_check').all().length)throw new Error('SQLite source integrity check failed');
  const signed=verifySqliteAudit(source,auditKey);
  if(!signed.ok)throw new Error(`SQLite audit verification failed: ${signed.reason}`);
  // A wrong encryption key must fail before data is copied, rather than locking
  // every MFA user out after cutover. Empty-secret sources still require the key.
  for(const user of source.prepare('SELECT mfa_secret,mfa_pending_secret FROM users').iterate()){
   for(const secret of [user.mfa_secret,user.mfa_pending_secret])if(secret)decryptSecret(secret,encryptionKey);
  }
  if(version>=3){
   const petKey=Buffer.isBuffer(encryptionKey)?encryptionKey:Buffer.from(encryptionKey,'hex');
   for(const row of source.prepare('SELECT user_id,id,content_cipher FROM pet_messages').iterate())decryptPetText(row.content_cipher,petKey,`${row.user_id}:message:${row.id}`);
   for(const row of source.prepare('SELECT user_id,request_id,reply_cipher FROM pet_chat_requests WHERE reply_cipher IS NOT NULL').iterate())decryptPetText(row.reply_cipher,petKey,`${row.user_id}:request:${row.request_id}`);
  }
  if(version>=4){
   const {inspectStoredPhoto}=await import('../src/features/photo-media.mjs');
   let photoBytes=0;
   // Decode each bounded photograph before opening the destination transaction.
   // This rejects stale hashes, disguised files and retained EXIF metadata.
   for(const row of source.prepare('SELECT * FROM photos').iterate()){
    await inspectStoredPhoto(row);
    photoBytes+=row.image_bytes;
    if(!Number.isSafeInteger(photoBytes))throw new Error('Photo storage byte count exceeds the safe integer range');
   }
   const storage=source.prepare('SELECT id,used_bytes FROM photo_storage').all();
   if(storage.length>1||(storage.length===0&&photoBytes!==0)||(storage.length===1&&(storage[0].id!==1||storage[0].used_bytes!==photoBytes)))throw new Error('Photo storage byte count does not match stored media');
  }
  const result=await db.transaction(async tx=>{
   await requireEmptyDestination(tx);
   const tables=version===2?LEGACY_TRANSFER_TABLES:version===3?[...LEGACY_TRANSFER_TABLES,...FEATURE_TABLES]:TRANSFER_TABLES;
   const counts=await copySqliteRows(tx,source,{tables});
   for(const row of source.prepare('SELECT version,applied_at FROM schema_migrations').all()){
    await tx.query('INSERT INTO schema_migrations(version,applied_at) VALUES($1,$2) ON CONFLICT(version) DO NOTHING',[row.version,row.applied_at]);
   }
   const audit=await verifyPostgresAudit(tx,auditKey,{expectedHead:signed.head});
   if(!audit.ok)throw new Error(`Imported PostgreSQL audit verification failed: ${audit.reason}`);
   await tx.query("INSERT INTO meta(key,value) VALUES('enterprise_initialized',$1)",[`import-sqlite-schema-${version}`]);
   return {imported:true,counts,audit};
  });
  source.exec('COMMIT');
  return result;
 }catch(error){try{source.exec('ROLLBACK');}catch{}throw error;}
 finally{source.close();}
}

export async function main(argv=process.argv.slice(2)){
 if(argv.includes('--help')){console.log('Usage: node --env-file=.env.enterprise scripts/import-sqlite-postgres.mjs --source /path/cityquest.sqlite\nAccepts SQLite schema 2, 3, 4, 5 or 6. Stop writers first, verify a backup and preserve existing security keys. Destination must be empty; omit --seed during migration.');return;}
 if(argv.length!==2||argv[0]!=='--source')throw new Error('Usage: import-sqlite-postgres.mjs --source /path/cityquest.sqlite');
 for(const name of ['AUDIT_HMAC_KEY','DATA_ENCRYPTION_KEY'])if(!/^[a-f0-9]{64}$/i.test(process.env[name]||''))throw new Error(`${name} must be the existing 64-hex key`);
 const db=await openPostgres();
 try {
  await migratePostgres(db);
  console.log(JSON.stringify(await importSqlitePostgres({db,sqlitePath:argv[1],auditKey:Buffer.from(process.env.AUDIT_HMAC_KEY,'hex'),encryptionKey:Buffer.from(process.env.DATA_ENCRYPTION_KEY,'hex')})));
 }finally{await db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(`SQLite import failed: ${error.message}`);process.exitCode=1;});
