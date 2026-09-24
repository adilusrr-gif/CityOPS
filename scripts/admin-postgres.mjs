import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPostgres} from '../src/enterprise/db.mjs';
import {loadSecurityKeys} from '../src/security.mjs';
import {appendAudit,verifyAudit} from '../src/enterprise/security-store.mjs';
import {id,normalizeEmail,text,passwordHash} from '../src/domain.mjs';

export async function provisionAdmin({db,email,password,keys,bootstrap=false,resetMfa=false}){
 const normalized=normalizeEmail(email),secret=text(password,'ADMIN_PASSWORD',128,12);
 const preflight=await verifyAudit(db,keys.auditKey);if(!preflight.ok)throw new Error('Audit integrity verification failed; no credential changes made');
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(172989,12)');
  if(bootstrap&&await tx.get("SELECT id FROM users WHERE role='admin' LIMIT 1"))return {created:false,skipped:true};
  let user=await tx.get('SELECT * FROM users WHERE email=$1 FOR NO KEY UPDATE',[normalized]);
  if(bootstrap&&user)throw new Error('This email already belongs to an account; use an explicit operator reset/link');
  const created=!user,uid=user?.id||id(),now=Date.now();
  if(!user){await tx.run("INSERT INTO users(id,email,name,password,role,created_at,password_login_enabled) VALUES($1,$2,'Администратор',$3,'admin',$4,1)",[uid,normalized,passwordHash(secret),now]);}
  else{
   await tx.run("UPDATE users SET password=$1,password_login_enabled=1,role='admin',mfa_pending_secret=NULL,mfa_pending_at=NULL WHERE id=$2",[passwordHash(secret),uid]);
   if(resetMfa){await tx.run('UPDATE users SET mfa_enabled=0,mfa_secret=NULL,mfa_last_counter=-1 WHERE id=$1',[uid]);await tx.run('DELETE FROM recovery_codes WHERE user_id=$1',[uid]);}
   await tx.run('DELETE FROM sessions WHERE user_id=$1',[uid]);await tx.run('DELETE FROM login_challenges WHERE user_id=$1',[uid]);await tx.run('DELETE FROM mobile_auth_codes WHERE user_id=$1',[uid]);
  }
  await appendAudit(tx,{actor:uid,action:created?'operator.admin_created':'operator.password_reset',target:uid,metadata:{bootstrap,resetMfa},requestId:'operator'},keys.auditKey);
  if(resetMfa)await appendAudit(tx,{actor:uid,action:'operator.mfa_reset',target:uid,requestId:'operator'},keys.auditKey);
  return {id:uid,created,skipped:false,mfaPreserved:!resetMfa};
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let db;
 try{
  let email=process.env.ADMIN_EMAIL,bootstrap=false,resetMfa=false,seenEmail=false;
  for(const arg of process.argv.slice(2)){
   if(arg==='--bootstrap')bootstrap=true;
   else if(arg==='--reset-mfa')resetMfa=true;
   else if(arg==='--help'){console.log('node --env-file=.env.enterprise scripts/admin-postgres.mjs [email] [--bootstrap] [--reset-mfa]\nADMIN_PASSWORD must be supplied in the protected environment. Existing MFA is preserved unless explicitly reset.');process.exit(0);}
   else if(arg.startsWith('--')||seenEmail)throw new Error('Invalid arguments');
   else{email=arg;seenEmail=true;}
  }
  if(!process.env.DATA_ENCRYPTION_KEY||!process.env.AUDIT_HMAC_KEY)throw new Error('Use the existing application encryption/audit keys');
  const keys=loadSecurityKeys({env:process.env});normalizeEmail(email);text(process.env.ADMIN_PASSWORD||'','ADMIN_PASSWORD',128,12);
  db=await openPostgres();const result=await provisionAdmin({db,email,password:process.env.ADMIN_PASSWORD,keys,bootstrap,resetMfa});
  console.log(result.skipped?'Administrator already exists; bootstrap skipped.':'Administrator configured. Remove ADMIN_PASSWORD from the active environment.');
 }catch(e){console.error('Administrator operation failed: '+e.message);process.exitCode=1;}
 finally{await db?.close();}
}
