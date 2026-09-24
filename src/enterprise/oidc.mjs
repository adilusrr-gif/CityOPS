import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import * as client from 'openid-client';
import {id,hash,fail,text} from '../domain.mjs';
import {encryptSecret,decryptSecret} from '../security.mjs';

const opaque=()=>randomBytes(32).toString('hex');
const bindingCookie=req=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('aq_oidc='))?.slice(8);
const digestS256=value=>createHash('sha256').update(value).digest('base64url');
function equalString(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
function redirect(res,location){res.statusCode=303;res.setHeader('Location',location);res.setHeader('Cache-Control','no-store');res.end();return {handled:true};}
function setCookie(res,value){const previous=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',[...(previous?(Array.isArray(previous)?previous:[previous]):[]),value]);}

export function exactSubject(value){if(typeof value!=='string'||value.length<1||value.length>1024||value.includes('\0'))fail('Некорректный OIDC subject');return value;}

export function createOidc({db,cfg,env=process.env,audit,throttle,completeLogin,loginResponse,isNativeRequest}){
 const enabled=Boolean(env.OIDC_ISSUER||env.OIDC_CLIENT_ID),label=env.OIDC_BUTTON_LABEL||'Войти через организацию';
 const allowHttp=env.NODE_ENV==='test'&&env.OIDC_ALLOW_HTTP_TEST==='true';
 let issuer,redirectUri,configuration;
 if(enabled){
  if(!env.OIDC_ISSUER||!env.OIDC_CLIENT_ID)throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID must be supplied together');
  issuer=new URL(env.OIDC_ISSUER);
  if(issuer.username||issuer.password||issuer.search||issuer.hash||(!allowHttp&&issuer.protocol!=='https:'))throw new Error('OIDC_ISSUER must be a trusted HTTPS issuer URL without credentials/query/fragment');
  if(!cfg.origin)throw new Error('OIDC requires PUBLIC_ORIGIN');
  redirectUri=new URL('/api/auth/sso/callback',cfg.origin).href;
 }
 async function config(){
  if(!configuration){configuration=client.discovery(issuer,env.OIDC_CLIENT_ID,{client_secret:env.OIDC_CLIENT_SECRET||undefined,id_token_signed_response_alg:'RS256'},env.OIDC_CLIENT_SECRET?client.ClientSecretPost(env.OIDC_CLIENT_SECRET):client.None(),{execute:[client.enableNonRepudiationChecks,...(allowHttp?[client.allowInsecureRequests]:[])],timeout:10}).catch(e=>{configuration=undefined;throw e;});}
  return configuration;
 }
 async function resolveIdentity(tx,claims){
  // Serialize creation/linking by verified issuer+subject, then lock user like other mutations.
  const subject=exactSubject(claims.sub),identityKey=hash(`${issuer.href}\0${subject}`);
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`oidc:${identityKey}`]);
  const identity=await tx.get('SELECT user_id FROM oidc_identities WHERE issuer=$1 AND subject=$2',[env.OIDC_ISSUER,subject]);
  if(identity){const existing=await tx.get('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE',[identity.user_id]);if(!existing||existing.disabled)fail('Вход недоступен',401);return existing;}
  const uid=id(),name=typeof claims.name==='string'&&claims.name.trim()?claims.name.trim().slice(0,60):'Игрок SSO';
  // Email is display data, not an identity key. Synthetic unique email prevents takeover by unverified/colliding claims.
  // This account has no password credential. Do not run a password KDF while
  // holding identity-provisioning locks; local login uses a dummy KDF instead.
  await tx.run('INSERT INTO users(id,email,name,password,role,created_at,password_login_enabled) VALUES($1,$2,$3,$4,$5,$6,0)',[uid,`sso-${uid}@identity.invalid`,name,`disabled:${opaque()}`,'player',Date.now()]);
  await tx.run('INSERT INTO oidc_identities(issuer,subject,user_id,created_at) VALUES($1,$2,$3,$4)',[env.OIDC_ISSUER,subject,uid,Date.now()]);
  await audit(tx,uid,'auth.sso_registered',uid,{issuer:env.OIDC_ISSUER});return tx.get('SELECT * FROM users WHERE id=$1',[uid]);
 }
 async function handle(ctx){
  const {req,res,url,ip}=ctx,p=ctx.path||url.pathname,m=ctx.method||req.method;
  if(p==='/api/auth/sso/config'&&m==='GET')return {enabled,buttonLabel:label};
  if(!enabled)fail('SSO не настроен',404);
  if(p==='/api/auth/sso/start'&&m==='GET'){
   await throttle(`sso-start:${ip}`,30,600000);
   const platform=url.searchParams.get('platform')||'web';if(!['web','mobile'].includes(platform))fail('Неизвестная платформа');
   const mobileChallenge=url.searchParams.get('code_challenge');
   if(platform==='mobile'&&!/^[A-Za-z0-9_-]{43}$/.test(mobileChallenge||''))fail('Для мобильного входа требуется PKCE S256');
   const c=await config(),state=client.randomState(),nonce=client.randomNonce(),verifier=client.randomPKCECodeVerifier(),binding=opaque(),now=Date.now();
   await db.run('INSERT INTO oidc_states(state_hash,nonce,verifier_secret,platform,mobile_challenge,binding_hash,expires,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[hash(state),nonce,encryptSecret(verifier,cfg.keys.encryptionKey),platform,platform==='mobile'?mobileChallenge:null,hash(binding),now+300000,now]);
   setCookie(res,`aq_oidc=${binding}; HttpOnly; SameSite=Lax; Path=/api/auth/sso/callback; Max-Age=300${cfg.secure?'; Secure':''}`);
   const destination=client.buildAuthorizationUrl(c,{redirect_uri:redirectUri,scope:'openid profile email',state,nonce,code_challenge:await client.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256'});
   return redirect(res,destination.href);
  }
  if(p==='/api/auth/sso/callback'&&m==='GET'){
   await throttle(`sso-callback:${ip}`,40,600000);
   const state=url.searchParams.get('state'),binding=bindingCookie(req);
   if(!state||state.length>256||!binding||!/^[a-f0-9]{64}$/.test(binding))fail('Подтверждение SSO недействительно. Начните вход заново.',401);
   // DELETE is atomic across replicas; no HTTP request is made with a replayed or expired state.
   const stateRow=await db.get('DELETE FROM oidc_states WHERE state_hash=$1 AND binding_hash=$2 AND expires>$3 RETURNING *',[hash(state),hash(binding),Date.now()]);
   if(!stateRow)fail('Подтверждение SSO истекло или уже использовано.',401);
   setCookie(res,`aq_oidc=; HttpOnly; SameSite=Lax; Path=/api/auth/sso/callback; Max-Age=0${cfg.secure?'; Secure':''}`);
   let claims;
   try{
    const callback=new URL(redirectUri);callback.search=url.search;
    const tokens=await client.authorizationCodeGrant(await config(),callback,{pkceCodeVerifier:decryptSecret(stateRow.verifier_secret,cfg.keys.encryptionKey),expectedNonce:stateRow.nonce,expectedState:state,idTokenExpected:true});
    claims=tokens.claims();
    if(!claims||claims.iss!==env.OIDC_ISSUER)throw new Error('Unexpected issuer');
   }catch{await audit(db,null,'auth.sso_failed','oidc',{reason:'protocol_validation'});fail('Поставщик SSO не подтвердил вход. Начните заново.',401);}
   const result=await db.transaction(async tx=>{
    const fresh=await resolveIdentity(tx,claims);
    if(stateRow.platform==='mobile'){
     const code=opaque(),now=Date.now();await tx.run('INSERT INTO mobile_auth_codes(code_hash,user_id,code_challenge,expires,created_at) VALUES($1,$2,$3,$4,$5)',[hash(code),fresh.id,stateRow.mobile_challenge,now+120000,now]);
     await audit(tx,fresh.id,'auth.sso_mobile_pending',fresh.id);return {mobileCode:code};
    }
    return completeLogin(tx,fresh,ctx,{source:'oidc'});
   });
   if(result.mobileCode)return redirect(res,`cityquest://auth/callback?code=${encodeURIComponent(result.mobileCode)}`);
   if(result.mfaRequired)return redirect(res,`${cfg.origin}/#mfaChallenge=${encodeURIComponent(result.challengeId)}`);
   loginResponse(ctx,result);return redirect(res,`${cfg.origin}/`);
  }
  if(p==='/api/auth/mobile/exchange'&&m==='POST'){
   if(!isNativeRequest(req,cfg))fail('Требуется мобильный клиент',403);
   await throttle(`mobile-exchange:${ip}`,30,600000);const b=await ctx.readBody(),code=text(b.code,'Код входа',64,64),verifier=text(b.code_verifier,'PKCE verifier',128,43);
   if(!/^[a-f0-9]{64}$/.test(code)||!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))fail('Некорректный код входа',401);
   const digest=hash(code),hint=await db.get('SELECT user_id FROM mobile_auth_codes WHERE code_hash=$1',[digest]);if(!hint)fail('Код истёк или уже использован',401);
   const result=await db.transaction(async tx=>{
    const fresh=await tx.get('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE',[hint.user_id]);
    const pending=await tx.get('SELECT * FROM mobile_auth_codes WHERE code_hash=$1 FOR UPDATE',[digest]);
    if(!fresh||fresh.disabled||!pending||pending.expires<=Date.now()||!equalString(digestS256(verifier),pending.code_challenge))fail('Код истёк, уже использован или PKCE не совпадает',401);
    await tx.run('DELETE FROM mobile_auth_codes WHERE code_hash=$1',[digest]);return completeLogin(tx,fresh,ctx,{source:'oidc-mobile'});
   });return loginResponse(ctx,result);
  }
  return undefined;
 }
 return {handle};
}
