import {decryptSecret,totp} from './security.mjs';
import {decryptPetText} from './features/pet-crypto.mjs';

// Format-only key checks miss accidentally replaced release keys. A startup
// sample rejects that configuration before listening; the operator preflight
// scans all ciphertext in bounded keyset pages within its read-only snapshot.
// Neither path returns plaintext, ciphertext, account IDs or secret errors.
function* inspection(dialect,encryptionKey,{sample=false}={}) {
 if(!['sqlite','postgres'].includes(dialect))throw new TypeError('Invalid database dialect');
 const key=Buffer.isBuffer(encryptionKey)?encryptionKey:typeof encryptionKey==='string'&&/^[a-f0-9]{64}$/i.test(encryptionKey)?Buffer.from(encryptionKey,'hex'):null;
 if(key?.length!==32)throw new TypeError('Invalid release encryption key');
 const bind=n=>dialect==='sqlite'?'?':`$${n}`,limit=sample?1:250;
 const summary={checked:0,invalid:0,invalidMfaAccounts:0,sampled:sample};
 let after=null;
 for(;;){
  const rows=yield {sql:`SELECT id,mfa_enabled,mfa_secret,mfa_pending_secret FROM users WHERE (mfa_enabled=1 OR mfa_secret IS NOT NULL OR mfa_pending_secret IS NOT NULL) ${after===null?'':`AND id>${bind(1)}`} ORDER BY id LIMIT ${limit}`,params:after===null?[]:[after]};
  if(!rows.length)break;
  for(const row of rows){
   let invalidMfa=false;
   if(row.mfa_enabled&&!row.mfa_secret){summary.invalid++;invalidMfa=true;}
   for(const secret of [row.mfa_secret,row.mfa_pending_secret])if(secret!==null){
    summary.checked++;
    try{totp(decryptSecret(secret,key),{counter:0});}catch{summary.invalid++;invalidMfa=true;}
   }
   if(invalidMfa)summary.invalidMfaAccounts++;
  }
  if(sample)break;
  after=rows.at(-1).id;
 }
 for(const spec of [
  {table:'pet_messages',columns:'id,user_id,content_cipher',keys:['id'],cipher:'content_cipher',context:row=>`${row.user_id}:message:${row.id}`},
  {table:'pet_chat_requests',columns:'user_id,request_id,reply_cipher',keys:['user_id','request_id'],cipher:'reply_cipher',context:row=>`${row.user_id}:request:${row.request_id}`},
 ]){
  let cursor=null;
  for(;;){
   const comparison=spec.keys.length===1?`${spec.keys[0]}>${bind(1)}`:`(${spec.keys.join(',')})>(${spec.keys.map((_,i)=>bind(i+1)).join(',')})`;
   const rows=yield {sql:`SELECT ${spec.columns} FROM ${spec.table} WHERE ${spec.cipher} IS NOT NULL ${cursor?`AND ${comparison}`:''} ORDER BY ${spec.keys.join(',')} LIMIT ${limit}`,params:cursor||[]};
   if(!rows.length)break;
   for(const row of rows){summary.checked++;try{decryptPetText(row[spec.cipher],key,spec.context(row));}catch{summary.invalid++;}}
   if(sample)break;
   cursor=spec.keys.map(name=>rows.at(-1)[name]);
  }
 }
 return summary;
}

export function inspectEncryptionSync(db,key,options) {
 const work=inspection('sqlite',key,options);let step=work.next();
 while(!step.done){const {sql,params}=step.value;step=work.next(db.prepare(sql).all(...params));}
 return step.value;
}
export async function inspectEncryption(db,dialect,key,options) {
 if(dialect==='sqlite')return inspectEncryptionSync(db,key,options);
 const work=inspection(dialect,key,options);let step=work.next();
 while(!step.done){const {sql,params}=step.value;step=work.next(await db.all(sql,params));}
 return step.value;
}

export function requireValidEncryption(result) {
 if(result.invalid)throw new Error('Stored ciphertext could not be authenticated with DATA_ENCRYPTION_KEY or MFA configuration is invalid; restore the original key before starting');
 return result;
}
