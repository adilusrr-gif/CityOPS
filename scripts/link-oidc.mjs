import {pathToFileURL} from 'node:url';
import {openPostgres} from '../src/enterprise/db.mjs';
import {appendAudit,verifyAudit} from '../src/enterprise/security-store.mjs';
import {loadSecurityKeys} from '../src/security.mjs';
import {hash,normalizeEmail} from '../src/domain.mjs';
import {exactSubject} from '../src/enterprise/oidc.mjs';

export async function linkIdentity(db,{issuer,subject,email,auditKey}){
 const url=new URL(issuer);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('Issuer must be the exact trusted HTTPS issuer');
 subject=exactSubject(subject);email=normalizeEmail(email);
 return db.transaction(async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`oidc:${hash(`${url.href}\0${subject}`)}`]);
  const identity=await tx.get('SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject=$2',[issuer,subject]);
  if(identity)throw new Error('Identity is already linked; automatic reassignment is forbidden');
  const user=await tx.get('SELECT * FROM users WHERE email=$1 FOR NO KEY UPDATE',[email]);
  if(!user||user.disabled)throw new Error('An enabled target account must already exist');
  if(user.password_login_enabled===0)throw new Error('Use an existing local account as the explicit link target');
  const integrity=await verifyAudit(tx,auditKey);if(!integrity.ok)throw new Error('Audit verification failed; no identity linked');
  await tx.run('INSERT INTO oidc_identities(issuer,subject,user_id,created_at) VALUES($1,$2,$3,$4)',[issuer,subject,user.id,Date.now()]);
  await tx.run('DELETE FROM sessions WHERE user_id=$1',[user.id]);await tx.run('DELETE FROM login_challenges WHERE user_id=$1',[user.id]);await tx.run('DELETE FROM mobile_auth_codes WHERE user_id=$1',[user.id]);
  await appendAudit(tx,{actor:user.id,action:'auth.oidc_linked_by_operator',target:user.id,metadata:{issuer,subject_hash:hash(subject)}},auditKey);
  return {userId:user.id,role:user.role,mfaEnabled:!!user.mfa_enabled};
 });
}
async function main(){
 const argv=process.argv.slice(2),args={};for(let i=0;i<argv.length;i+=2){if(!['--issuer','--subject','--email'].includes(argv[i])||!argv[i+1])throw new Error('Usage: node --env-file=.env.enterprise scripts/link-oidc.mjs --issuer HTTPS_ISSUER --subject EXACT_SUBJECT --email EXISTING_LOCAL_EMAIL');args[argv[i].slice(2)]=argv[i+1];}
 if(!args.issuer||!args.subject||!args.email)throw new Error('--issuer, --subject and --email are required');
 if(args.issuer!==process.env.OIDC_ISSUER)throw new Error('--issuer must exactly match configured OIDC_ISSUER');
 const {auditKey}=loadSecurityKeys(),db=await openPostgres();try{const r=await linkIdentity(db,{...args,auditKey});console.log(JSON.stringify({ok:true,...r,sessionsRevoked:true}));}finally{await db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
