import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createTestDatabase} from './db-fixture.mjs';
import {createEnterpriseApp} from '../../src/enterprise/server.mjs';
import {hash} from '../../src/domain.mjs';
import {encryptSecret,generateTotpSecret} from '../../src/security.mjs';

test('protected admin reads revalidate revoked, disabled and demoted actors after initial lookup',async t=>{
 const f=await createTestDatabase();const keys={encryptionKey:randomBytes(32),auditKey:randomBytes(32)};
 let armed=false,entered,release;
 const wrapped={...f.db,async get(sql,params){
  const row=await f.db.get(sql,params);
  if(armed&&sql.startsWith('SELECT u.*,s.id AS session_id')){armed=false;entered();await new Promise(resolve=>release=resolve);}
  return row;
 }};
 const app=await createEnterpriseApp({db:wrapped,keys,env:{NODE_ENV:'test',REQUIRE_ADMIN_MFA:'true'}});
 t.after(async()=>{release?.();app.server.closeAllConnections();await app.close();await f.close();});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
 const base=`http://127.0.0.1:${app.server.address().port}`,uid='regression-admin',sid='regression-session',token=randomBytes(32).toString('hex');
 await f.db.run('INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled,mfa_secret) VALUES($1,$2,$3,$4,$5,$6,1,$7)',[uid,'regression@company.kz','Synthetic admin','disabled:fixture','admin',Date.now(),encryptSecret(generateTotpSecret(),keys.encryptionKey)]);
 await app.audit(f.db,uid,'synthetic.admin.read',uid);
 async function restore(){
  const now=Date.now();await f.db.run("UPDATE users SET role='admin',disabled=0 WHERE id=$1",[uid]);
  await f.db.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$3,$4,$5,$5,1) ON CONFLICT(token) DO UPDATE SET expires=excluded.expires,last_seen=excluded.last_seen',[hash(token),sid,uid,now+600000,now]);
  await f.db.run('DELETE FROM rate_limits');
 }
 for(const action of ['revoked','demoted','disabled'])for(const path of ['/api/admin/audit','/api/admin/metrics','/api/admin/audit/verify']){
  await t.test(`${action}: ${path}`,async()=>{
   await restore();const ready=new Promise(resolve=>entered=resolve);armed=true;
   const pending=fetch(base+path,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});await ready;
   try{
    if(action==='revoked')await f.db.run('DELETE FROM sessions WHERE user_id=$1',[uid]);
    if(action==='demoted')await f.db.run("UPDATE users SET role='player' WHERE id=$1",[uid]);
    if(action==='disabled')await f.db.run('UPDATE users SET disabled=1 WHERE id=$1',[uid]);
   }finally{release();}
   const response=await pending,body=await response.json();
   assert.equal(response.status,action==='demoted'?403:401);
   assert.deepEqual(Object.keys(body).sort(),['error','requestId'],'private report data must not escape after access changed');
  });
 }
 await restore();
 for(const path of ['/api/admin/audit','/api/admin/metrics','/api/admin/audit/verify']){
  const response=await fetch(base+path,{headers:{Authorization:`Bearer ${token}`}});assert.equal(response.status,200,path);await response.json();
 }
 t.diagnostic(`Engine: ${f.engine}; deterministic post-lookup barrier, no production data.`);
});
