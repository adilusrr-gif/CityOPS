#!/usr/bin/env node
import {randomBytes} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';

const args=process.argv.slice(2), values={};
for(let i=0;i<args.length;i+=2){
  if(!['--db-host','--admin','--output'].includes(args[i])||!args[i+1]||values[args[i]])throw new Error('Usage: node deploy/generate-k8s-secrets.mjs --db-host cityquest-pg-rw.cityquest.svc.cluster.local --admin admin@example.com [--output data/deployment-secrets/secrets.json]');
  values[args[i]]=args[i+1];
}
const hostname=values['--db-host'];
const email=values['--admin'];
if(!hostname||hostname.length>253||!hostname.split('.').every(s=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(s)))throw new Error('Supply a valid PostgreSQL DNS hostname');
if(!email||email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email)||/[\r\n]/.test(email))throw new Error('Supply an admin email');
const hex=bytes=>randomBytes(bytes).toString('hex');
let encryptionKey=process.env.DATA_ENCRYPTION_KEY,auditKey=process.env.AUDIT_HMAC_KEY;
if(Boolean(encryptionKey)!==Boolean(auditKey))throw new Error('For a migration supply BOTH original DATA_ENCRYPTION_KEY and AUDIT_HMAC_KEY');
if(!encryptionKey){encryptionKey=hex(32);auditKey=hex(32);}
if(!/^[a-f0-9]{64}$/i.test(encryptionKey)||!/^[a-f0-9]{64}$/i.test(auditKey)||encryptionKey.toLowerCase()===auditKey.toLowerCase())throw new Error('Keys must be independent 64-hex strings');
const ownerPassword=hex(24),appPassword=hex(24),metricsToken=hex(32);
const shared={DATA_ENCRYPTION_KEY:encryptionKey,AUDIT_HMAC_KEY:auditKey};
const secret=(name,stringData,type='Opaque')=>({apiVersion:'v1',kind:'Secret',metadata:{name,namespace:'cityquest'},type,stringData});
const bundle={apiVersion:'v1',kind:'List',items:[
  secret('cityquest-runtime',{...shared,DATABASE_URL:`postgresql://cityquest_app:${appPassword}@${hostname}:5432/cityquest`,METRICS_TOKEN:metricsToken}),
  secret('cityquest-metrics',{token:metricsToken}),
  secret('cityquest-migration',{...shared,DATABASE_URL:`postgresql://cityquest_owner:${ownerPassword}@${hostname}:5432/cityquest`}),
  secret('cityquest-bootstrap',{ADMIN_EMAIL:email,ADMIN_PASSWORD:hex(24)}),
  secret('cityquest-pg-owner',{username:'cityquest_owner',password:ownerPassword},'kubernetes.io/basic-auth'),
  secret('cityquest-pg-app',{username:'cityquest_app',password:appPassword},'kubernetes.io/basic-auth'),
]};
const destination=resolve(values['--output']||'data/deployment-secrets/secrets.json');
await mkdir(dirname(destination),{recursive:true,mode:0o700});
await writeFile(destination,JSON.stringify(bundle,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(`Created private secret bundle: ${destination}`);
console.log('No credentials printed. Store keys independently; do not include this file in releases.');
