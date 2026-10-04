import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export function releaseOrigin(value){
 let url;try{url=new URL(value);}catch{throw new Error('Set CITYQUEST_API_ORIGIN to your deployed HTTPS API origin.');}
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Release API must be an HTTPS origin without credentials, path, query or fragment.');
 const host=url.hostname.toLowerCase().replace(/\.$/,'');
 if(!host.includes('.')||/(^|\.)(example|test|invalid|localhost|local)$/.test(host)||/(^|\.)example\.(com|net|org)$/.test(host)||/^(0|10|127)\./.test(host)||/^169\.254\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2[0-9]|3[01])\./.test(host))throw new Error('Release API cannot use a sample, reserved or local hostname. Use the deployed API origin.');
 return url.origin;
}
async function files(directory,base=directory){
 const result=[];
 for(const entry of await readdir(directory,{withFileTypes:true})){
  // Capacitor adds these platform bootstrap stubs during sync. They are not shared UI assets.
  if(directory===base&&['cordova.js','cordova_plugins.js'].includes(entry.name))continue;
  const path=resolve(directory,entry.name);
  if(entry.isDirectory())result.push(...await files(path,base));
  else if(entry.isFile())result.push([relative(base,path),createHash('sha256').update(await readFile(path)).digest('hex')]);
  else throw new Error('Unexpected non-file bundled asset: '+path);
 }
 return result.sort(([a],[b])=>a.localeCompare(b));
}
export async function verifyRelease({mobileRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..'),apiOrigin=process.env.CITYQUEST_API_ORIGIN}={}){
 const origin=releaseOrigin(apiOrigin),config=JSON.parse(await readFile(resolve(mobileRoot,'capacitor.config.json'),'utf8'));
 if(config.webDir!=='www'||config.server?.url||config.server?.cleartext!==false||config.android?.allowMixedContent!==false)throw new Error('Native release must use bundled assets with HTTPS and no mixed content.');
 const directories=['www','android/app/src/main/assets/public','ios/App/App/public'];
 let expected;
 for(const directory of directories){
  const root=resolve(mobileRoot,directory),info=JSON.parse(await readFile(resolve(root,'build-info.json'),'utf8'));
  if(info.apiOrigin!==origin||info.bundledAssets!==true)throw new Error(directory+' is not built for '+origin+'. Run npm run sync with that origin.');
  const entries=await files(root),manifest=JSON.stringify(entries);
  if(!entries.some(([name])=>name==='mobile.js')||!entries.some(([name])=>name==='index.html'))throw new Error(directory+' is missing the native entry point.');
  if(expected&&manifest!==expected)throw new Error(directory+' differs from www. Run npm run sync before packaging.');
  expected=manifest;
 }
 return {apiOrigin:origin,platforms:['android','ios'],synchronized:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const result=await verifyRelease();console.log('Mobile release assets verified for '+result.apiOrigin+'. Android and iOS copies match. Device tests, reachable backend, signing and store review remain separate checks.');}
 catch(error){console.error('Mobile release blocked: '+error.message);process.exitCode=1;}
}
