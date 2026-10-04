import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {releaseOrigin,verifyRelease} from '../mobile/scripts/verify-release.mjs';

test('mobile release origin rejects demo, local, HTTP and ambiguous API configuration',()=>{
 for(const origin of [undefined,'http://api.cityquest.kz','https://cityquest.example','https://cityquest.example.','https://api.example.com','https://demo.test','https://localhost','https://127.0.0.2','https://10.0.0.10','https://192.168.1.1','https://172.20.0.1','https://api.cityquest.kz/api','https://u:p@api.cityquest.kz','https://api.cityquest.kz?key=x'])assert.throws(()=>releaseOrigin(origin));
 assert.equal(releaseOrigin('https://api.cityquest.kz/'),'https://api.cityquest.kz');
});
test('mobile release requires identical synced Android and iOS shared assets for the chosen origin',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cityquest-mobile-release-')),origin='https://api.cityquest.kz';
 try{
  await writeFile(join(root,'capacitor.config.json'),JSON.stringify({webDir:'www',server:{cleartext:false},android:{allowMixedContent:false}}));
  for(const path of ['www','android/app/src/main/assets/public','ios/App/App/public']){
   const directory=join(root,path);await mkdir(directory,{recursive:true});
   for(const [name,data] of Object.entries({'build-info.json':JSON.stringify({apiOrigin:origin,bundledAssets:true}),'mobile.js':'native bundle','index.html':'bundled HTML'}))await writeFile(join(directory,name),data);
   if(path!=='www')await writeFile(join(directory,'cordova.js'),'Capacitor bootstrap');
  }
  assert.equal((await verifyRelease({mobileRoot:root,apiOrigin:origin})).synchronized,true);
  await assert.rejects(verifyRelease({mobileRoot:root,apiOrigin:'https://other.cityquest.kz'}),/not built/);
  await writeFile(join(root,'ios/App/App/public/mobile.js'),'stale bundle');
  await assert.rejects(verifyRelease({mobileRoot:root,apiOrigin:origin}),/differs from www/);
 }finally{await rm(root,{recursive:true,force:true});}
});
