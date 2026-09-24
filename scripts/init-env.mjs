import {randomBytes} from 'node:crypto';
import {mkdir,open,rm} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

export async function generateProductionEnv({origin,admin,output='.env.production'}={}) {
 let address;
 try{address=new URL(origin);}catch{throw new Error('--origin must be a canonical HTTPS origin, for example https://quest.example.com');}
 if(typeof origin!=='string'||address.protocol!=='https:'||address.origin!==origin)throw new Error('--origin must be canonical HTTPS with no trailing slash, credentials, path, query or fragment');
 const email=typeof admin==='string'?admin.trim().toLowerCase():'';
 // A conservative dot-atom email form keeps generated dotenv values unambiguous.
 if(email.length>254||!(/^[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/).test(email))throw new Error('--admin must be a valid email address using letters, digits, dot, underscore, percent, plus or hyphen');
 const file=resolve(output);await mkdir(dirname(file),{recursive:true,mode:0o700});
 // Exclusive creation prevents accidental rotation of keys and bootstrap password.
 const handle=await open(file,'wx',0o600);
 try{
  const keys=Array.from({length:3},()=>randomBytes(32).toString('hex'));
  const content=[
   '# Generated locally. Contains secrets: do not commit, share or print this file.',
   '# Keep an independent protected copy of all three keys. Do not rotate them blindly.',
   'NODE_ENV=production','HOST=127.0.0.1','PORT=3000','DATABASE_PATH=./data/almaty.sqlite',
   '# Production Compose overrides DATABASE_PATH with /app/data/almaty.sqlite.',
   `PUBLIC_ORIGIN=${origin}`,'COOKIE_SECURE=true','REQUIRE_ADMIN_MFA=true',
   'TRUST_PROXY=loopback','SESSION_IDLE_MINUTES=30','JSON_LOGS=true',
   `ADMIN_EMAIL=${email}`,`ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`,
   '# Remove ADMIN_PASSWORD from the active configuration after first admin bootstrap.',
   `DATA_ENCRYPTION_KEY=${keys[0]}`,`AUDIT_HMAC_KEY=${keys[1]}`,`BACKUP_ENCRYPTION_KEY=${keys[2]}`,
   'MAP_STYLE=https://tiles.openfreemap.org/styles/dark','',
  ].join('\n');
  await handle.writeFile(content);await handle.sync();
 }catch(error){await handle.close();await rm(file,{force:true});throw error;}
 await handle.close();
 return {file};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const {values}=parseArgs({options:{origin:{type:'string'},admin:{type:'string'},output:{type:'string'},help:{type:'boolean'}}});
  if(values.help)console.log('Usage: node scripts/init-env.mjs --origin https://quest.example.com --admin admin@example.com [--output .env.production]\nCreates a new private file with independent random keys and an administrator password. Never overwrites or prints secrets.');
  else{const {file}=await generateProductionEnv(values);console.log(`Created ${JSON.stringify(file)}. Open this file locally to read the administrator password and configure your server; secrets were not printed.`);}
 }catch(error){console.error(`Configuration failed: ${error.code==='EEXIST'?'Output already exists; refusing to overwrite credentials.':error.message}`);process.exitCode=1;}
}
