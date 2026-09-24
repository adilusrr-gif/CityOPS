import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomBytes} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createTestDatabase} from './db-fixture.mjs';
import {createEnterpriseAuth} from '../../src/enterprise/auth.mjs';
import {appendAudit} from '../../src/enterprise/security-store.mjs';
import {totp,encryptSecret} from '../../src/security.mjs';
import {hash} from '../../src/domain.mjs';

const s256=v=>createHash('sha256').update(v).digest('base64url');
const keys={encryptionKey:randomBytes(32),auditKey:randomBytes(32)};
const config={origin:'http://127.0.0.1:18881',secure:false,nativeOrigins:['capacitor://localhost'],keys,idleMs:1800000,requireAdminMfa:false};
function response(){const headers=new Map();return {headers,statusCode:200,writableEnded:false,setHeader(k,v){headers.set(k.toLowerCase(),v);},getHeader(k){return headers.get(k.toLowerCase());},end(){this.writableEnded=true;}};}
function cookies(res){const values=res.getHeader('set-cookie')||[];return (Array.isArray(values)?values:[values]).map(v=>v.split(';')[0]).join('; ');}
function ctx(auth,path,{method='GET',body={},headers={},user=null}={}){const req={method,headers,socket:{remoteAddress:'127.0.0.1'}},res=response();return {req,res,url:new URL(path,config.origin),path:new URL(path,config.origin).pathname,method,user,ip:'127.0.0.1',readBody:async()=>body,auth};}
async function call(auth,path,options){const c=ctx(auth,path,options);if(!c.user)c.user=await auth.session(c.req);const body=await auth.handle(c);return {body,res:c.res};}
async function mockProvider(){
 const pair=await generateKeyPair('RS256'),wrong=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey),pending=new Map();jwk.kid='signing-1';jwk.alg='RS256';
 let issuer,mode='valid',subject='ordinary-subject',email='victim@example.com',tokenCalls=0;
 const server=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url,issuer);res.setHeader('Content-Type','application/json');
   if(url.pathname==='/.well-known/openid-configuration')return res.end(JSON.stringify({issuer,authorization_endpoint:`${issuer}/authorize`,token_endpoint:`${issuer}/token`,jwks_uri:`${issuer}/jwks`,response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_post'],code_challenge_methods_supported:['S256']}));
   if(url.pathname==='/jwks')return res.end(JSON.stringify({keys:[jwk]}));
   if(url.pathname==='/authorize'){
    const code=randomBytes(32).toString('hex');pending.set(code,{nonce:url.searchParams.get('nonce'),challenge:url.searchParams.get('code_challenge'),redirect:url.searchParams.get('redirect_uri')});
    const to=new URL(url.searchParams.get('redirect_uri'));to.searchParams.set('code',code);to.searchParams.set('state',url.searchParams.get('state'));res.statusCode=302;res.setHeader('Location',to.href);return res.end();
   }
   if(url.pathname==='/token'){
    tokenCalls++;let raw='';for await(const chunk of req)raw+=chunk;const b=new URLSearchParams(raw),p=pending.get(b.get('code'));pending.delete(b.get('code'));
    if(!p||s256(b.get('code_verifier')||'')!==p.challenge||b.get('redirect_uri')!==p.redirect||b.get('client_id')!=='city-quest-test'||b.get('client_secret')!=='test-secret'){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_grant'}));}
    const token=await new SignJWT({nonce:mode==='nonce'?'wrong-nonce':p.nonce,email,email_verified:true,name:'SSO test',roles:['admin']}).setProtectedHeader({alg:'RS256',kid:'signing-1'}).setIssuer(mode==='issuer'?`${issuer}/wrong`:issuer).setAudience(mode==='audience'?'wrong-client':'city-quest-test').setSubject(subject).setIssuedAt().setExpirationTime(mode==='expired'?'-120s':'5m').sign(mode==='signature'?wrong.privateKey:pair.privateKey);
    return res.end(JSON.stringify({access_token:'provider-secret-access-token',token_type:'Bearer',expires_in:300,id_token:token}));
   }
   res.statusCode=404;res.end('{}');
  }catch(e){res.statusCode=500;res.end(JSON.stringify({error:e.message}));}
 });server.listen(0,'127.0.0.1');await once(server,'listening');issuer=`http://127.0.0.1:${server.address().port}`;
 return {issuer,setMode(v){mode=v;},setSubject(v){subject=v;},get tokenCalls(){return tokenCalls;},async close(){server.close();await once(server,'close');}};
}

test('OIDC protocol, native sessions and MFA against real PostgreSQL SQL engine',async t=>{
 const fixture=await createTestDatabase(),provider=await mockProvider();t.diagnostic(`Database engine: ${fixture.engine}`);t.after(async()=>{await provider.close();await fixture.close();});
 const env={NODE_ENV:'test',OIDC_ALLOW_HTTP_TEST:'true',OIDC_ISSUER:provider.issuer,OIDC_CLIENT_ID:'city-quest-test',OIDC_CLIENT_SECRET:'test-secret'};
 const audit=(tx,actor,action,target,metadata={})=>appendAudit(tx,{actor,action,target,metadata,requestId:'oidc-test'},keys.auditKey);
 const auth1=createEnterpriseAuth({db:fixture.db,cfg:config,env,audit,throttle:async()=>{}}),auth2=createEnterpriseAuth({db:fixture.db2,cfg:config,env,audit,throttle:async()=>{}});
 async function begin(query=''){
  const first=await call(auth1,`/api/auth/sso/start${query}`);assert.equal(first.res.statusCode,303);
  const authorized=await fetch(first.res.getHeader('location'),{redirect:'manual'});assert.equal(authorized.status,302);
  return {location:authorized.headers.get('location'),cookie:cookies(first.res)};
 }
 async function finish(flow,auth=auth2){return call(auth,new URL(flow.location).pathname+new URL(flow.location).search,{headers:{cookie:flow.cookie}});}
 let local,localCookie;
 await t.test('web cookies and native tokens are distinct; shared replica revocation works',async()=>{
  const created=await call(auth1,'/api/register',{method:'POST',body:{email:'victim@example.com',name:'Existing account',password:'a-strong-test-password'},headers:{origin:config.origin,'x-cityquest-client':'native'}});local=created.body.user;localCookie=cookies(created.res);assert.equal(created.body.accessToken,undefined);assert.ok(localCookie.includes('aq_session='));
  const login=await call(auth2,'/api/login',{method:'POST',body:{email:local.email,password:'a-strong-test-password'},headers:{origin:'capacitor://localhost','x-cityquest-client':'native'}});assert.match(login.body.accessToken,/^[a-f0-9]{64}$/);assert.equal(login.res.getHeader('set-cookie'),undefined);
  const native={authorization:`Bearer ${login.body.accessToken}`};assert.equal((await call(auth1,'/api/me',{headers:native})).body.user.id,local.id);
  await call(auth1,'/api/auth/sessions/revoke',{method:'POST',headers:{cookie:localCookie},body:{allOthers:true}});assert.equal((await call(auth2,'/api/me',{headers:native})).body.user,null);
 });
 await t.test('valid callback on another app instance creates player without email linking',async()=>{
  const flow=await begin(),finished=await finish(flow);assert.equal(finished.res.statusCode,303);assert.equal(finished.res.getHeader('location'),`${config.origin}/`);
  const user=await auth1.session({headers:{cookie:cookies(finished.res)}});assert.notEqual(user.id,local.id);assert.equal(user.role,'player');assert.equal(user.password_login_enabled,0);assert.match(user.email,/@identity.invalid$/);
  assert.equal((await fixture.db.get('SELECT COUNT(*)::integer AS n FROM oidc_identities')).n,1);
  await assert.rejects(finish(flow),e=>e.status===401); // one-time state, including across instances
 });
 await t.test('callback requires browser binding and cannot be transplanted',async()=>{
  const flow=await begin(),calls=provider.tokenCalls;
  await assert.rejects(call(auth2,new URL(flow.location).pathname+new URL(flow.location).search),e=>e.status===401);
  const wrong={...flow,cookie:`aq_oidc=${randomBytes(32).toString('hex')}`};await assert.rejects(finish(wrong),e=>e.status===401);assert.equal(provider.tokenCalls,calls);await finish(flow);
 });
 for(const mode of ['signature','nonce','audience','issuer','expired'])await t.test(`rejects ${mode} tampering`,async()=>{provider.setMode(mode);const flow=await begin();await assert.rejects(finish(flow),e=>e.status===401);provider.setMode('valid');});
 await t.test('PKCE is validated by provider and verifier is encrypted in database',async()=>{
  const flow=await begin(),state=new URL(flow.location).searchParams.get('state'),stored=await fixture.db.get('SELECT verifier_secret FROM oidc_states WHERE state_hash=$1',[hash(state)]);assert.ok(stored.verifier_secret.includes('.')); // versioned AEAD envelope
  const authorization=new URL((await call(auth1,'/api/auth/sso/start')).res.getHeader('location'));assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
  await fixture.db.run('UPDATE oidc_states SET verifier_secret=$1 WHERE state_hash=$2',[encryptSecret(randomBytes(32).toString('base64url'),keys.encryptionKey),hash(state)]);
  await assert.rejects(finish(flow),e=>e.status===401);
 });
 await t.test('mobile code requires verifier, is single-use, and never contains session token in URL',async()=>{
  const verifier=randomBytes(32).toString('base64url'),flow=await begin(`?platform=mobile&code_challenge=${s256(verifier)}`),finished=await finish(flow),link=new URL(finished.res.getHeader('location'));assert.equal(link.protocol,'cityquest:');assert.equal(link.hostname,'auth');assert.equal(link.pathname,'/callback');assert.equal(link.searchParams.has('accessToken'),false);
  const code=link.searchParams.get('code'),headers={'x-cityquest-client':'native',origin:'capacitor://localhost'};assert.match(code,/^[a-f0-9]{64}$/);
  await assert.rejects(call(auth2,'/api/auth/mobile/exchange',{method:'POST',body:{code,code_verifier:verifier}}),e=>e.status===403);
  await assert.rejects(call(auth2,'/api/auth/mobile/exchange',{method:'POST',headers,body:{code,code_verifier:randomBytes(32).toString('base64url')}}),e=>e.status===401);
  const completed=await call(auth1,'/api/auth/mobile/exchange',{method:'POST',headers,body:{code,code_verifier:verifier}});assert.match(completed.body.accessToken,/^[a-f0-9]{64}$/);assert.equal(completed.res.getHeader('set-cookie'),undefined);
  await assert.rejects(call(auth2,'/api/auth/mobile/exchange',{method:'POST',headers,body:{code,code_verifier:verifier}}),e=>e.status===401);
 });
 await t.test('linked local MFA remains mandatory after SSO; concurrent challenge replay succeeds once',async()=>{
  const setup=await call(auth1,'/api/auth/mfa/setup',{method:'POST',headers:{cookie:localCookie},body:{password:'a-strong-test-password'}});
  const enabled=await call(auth1,'/api/auth/mfa/enable',{method:'POST',headers:{cookie:localCookie},body:{code:totp(setup.body.secret)}});
  await fixture.db.run('INSERT INTO oidc_identities(issuer,subject,user_id,created_at) VALUES($1,$2,$3,$4)',[provider.issuer,'linked-admin-subject',local.id,Date.now()]);await fixture.db.run("UPDATE users SET role='admin' WHERE id=$1",[local.id]);provider.setSubject('linked-admin-subject');
  const flow=await begin(),finished=await finish(flow),fragment=new URLSearchParams(new URL(finished.res.getHeader('location')).hash.slice(1)),challengeId=fragment.get('mfaChallenge');assert.match(challengeId,/^[a-f0-9]{64}$/);assert.ok(!cookies(finished.res).includes('aq_session='));
  const req={method:'POST',body:{challengeId,code:enabled.body.recoveryCodes[0]}};
  const results=await Promise.allSettled([call(auth1,'/api/auth/mfa/login',req),call(auth2,'/api/auth/mfa/login',req)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);const successful=results.find(r=>r.status==='fulfilled').value;assert.equal(successful.body.user.id,local.id);
  const u=await auth2.session({headers:{cookie:cookies(successful.res)}});assert.equal(u.session_mfa_verified,1);
  const verifier=randomBytes(32).toString('base64url'),mobileFlow=await begin(`?platform=mobile&code_challenge=${s256(verifier)}`),mobileCallback=await finish(mobileFlow),code=new URL(mobileCallback.res.getHeader('location')).searchParams.get('code');
  const result=await call(auth2,'/api/auth/mobile/exchange',{method:'POST',headers:{'x-cityquest-client':'native'},body:{code,code_verifier:verifier}});assert.equal(result.body.mfaRequired,true);assert.equal(result.body.accessToken,undefined);
  const verified=await call(auth1,'/api/auth/mfa/login',{method:'POST',headers:{'x-cityquest-client':'native'},body:{challengeId:result.body.challengeId,code:enabled.body.recoveryCodes[1]}});assert.match(verified.body.accessToken,/^[a-f0-9]{64}$/);
 });
 await t.test('disabled accounts and idle expiry apply to native bearer sessions across replicas',async()=>{
  const registered=await call(auth1,'/api/register',{method:'POST',headers:{'x-cityquest-client':'native'},body:{email:'native-expiry@example.com',name:'Native expiry',password:'a-strong-test-password'}}),headers={authorization:`Bearer ${registered.body.accessToken}`};
  await fixture.db.run('UPDATE sessions SET last_seen=$1 WHERE user_id=$2',[Date.now()-config.idleMs-1,registered.body.user.id]);assert.equal((await call(auth2,'/api/me',{headers})).body.user,null);
  const login=await call(auth1,'/api/login',{method:'POST',headers:{'x-cityquest-client':'native'},body:{email:'native-expiry@example.com',password:'a-strong-test-password'}});await fixture.db.run('UPDATE users SET disabled=1 WHERE id=$1',[registered.body.user.id]);assert.equal((await call(auth2,'/api/me',{headers:{authorization:`Bearer ${login.body.accessToken}`}})).body.user,null);
 });
});
