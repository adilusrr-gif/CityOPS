import {randomBytes} from 'node:crypto';
import {id,hash,fail,text,choice,normalizeEmail} from '../domain.mjs';
import {passwordService as defaultPasswordService,passwordText} from '../passwords.mjs';
import {generateTotpSecret,verifyTotp,encryptSecret,decryptSecret,generateRecoveryCodes,hashRecoveryCode,sessionExpired} from '../security.mjs';
import {createOidc} from './oidc.mjs';
import {PROGRESSION} from '../product-policy.mjs';

const cookieToken=req=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('aq_session='))?.slice(11);
const requestToken=req=>req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):cookieToken(req);
const opaque=()=>randomBytes(32).toString('hex');
export function isNativeRequest(req,cfg){
 const origins=cfg.nativeOrigins||[];
 return req.headers['x-cityquest-client']==='native'&&(!req.headers.origin||(req.headers.origin!==cfg.origin&&origins.includes(req.headers.origin)));
}
export function createEnterpriseAuth({db,cfg,audit,throttle,env=process.env,passwordService=defaultPasswordService}){
 const publicUser=u=>u?{id:u.id,email:u.email,name:u.name,role:u.role,xp:u.xp,level:1+Math.floor(u.xp/PROGRESSION.xpPerLevel),mfaEnabled:!!u.mfa_enabled,requiresMfaSetup:!!(cfg.requireAdminMfa&&u.role==='admin'&&!u.mfa_enabled),passwordLoginEnabled:u.password_login_enabled!==0}:null;
 function required(user,roles){if(!user)fail('Войдите в аккаунт',401);if(roles&&!roles.includes(user.role))fail('Недостаточно прав',403);if(roles&&user.role==='admin'&&cfg.requireAdminMfa&&(!user.mfa_enabled||!user.session_mfa_verified))fail('Настройте MFA в профиле перед административными действиями',423);return user;}
 async function session(req){
  const token=requestToken(req);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;
  const u=await db.get('SELECT u.*,s.id AS session_id,s.expires,s.last_seen,s.mfa_verified AS session_mfa_verified FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=$1',[hash(token)]);
  if(!u)return null;
  if(u.disabled||sessionExpired(u,{idleMs:cfg.idleMs})){
   // An already-completed activity touch on another replica must not be deleted
   // merely because this request read the previous idle timestamp.
   await db.run('DELETE FROM sessions WHERE token=$1 AND last_seen=$2 AND expires=$3',[hash(token),u.last_seen,u.expires]);return null;
  }
  if(Date.now()-u.last_seen>15000){
   const now=Date.now();
   // Return the account that still owns a live session after the asynchronous
   // touch. A revoked token or disabled account must not return the old SELECT.
   // GREATEST preserves a newer touch without treating it as a failed login.
   const fresh=await db.get('UPDATE sessions s SET last_seen=GREATEST(s.last_seen,$1) FROM users u WHERE s.token=$2 AND s.user_id=u.id AND u.disabled=0 AND s.expires>$1 AND s.last_seen>$3 RETURNING u.*,s.id AS session_id,s.expires,s.last_seen,s.mfa_verified AS session_mfa_verified',[now,hash(token),now-cfg.idleMs]);
   return fresh&&!sessionExpired(fresh,{idleMs:cfg.idleMs})?fresh:null;
  }
  return u;
 }
 async function freshActor(tx,user){
  required(user);
  const fresh=await tx.get('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE',[user.id]);
  const s=await tx.get('SELECT id AS session_id,expires,last_seen,mfa_verified AS session_mfa_verified FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE',[user.session_id,user.id]);
  if(!fresh||fresh.disabled||!s||sessionExpired(s,{idleMs:cfg.idleMs}))fail('Сессия истекла. Войдите заново.',401);
  return {...fresh,...s};
 }
 async function startSession(tx,user,mfaVerified=false){
  const token=opaque(),now=Date.now(),seconds=user.role==='admin'?43200:604800;
  await tx.run('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES($1,$2,$3,$4,$5,$5,$6)',[hash(token),id(),user.id,now+seconds*1000,now,mfaVerified?1:0]);
  return {token,seconds,user};
 }
 function publishSession(res,created,native=false){
  const response={user:publicUser(created.user)};
  if(native)response.accessToken=created.token;
  else {const previous=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',[...(previous?(Array.isArray(previous)?previous:[previous]):[]),`aq_session=${created.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${created.seconds}${cfg.secure?'; Secure':''}`]);}
  return response;
 }
 async function challenge(tx,user){
  const challengeId=opaque();
  await tx.run('INSERT INTO login_challenges(id_hash,user_id,expires) VALUES($1,$2,$3)',[hash(challengeId),user.id,Date.now()+300000]);
  return {mfaRequired:true,challengeId};
 }
 async function completeLogin(tx,user,ctx,{source='password'}={}){
  if(user.disabled)fail('Вход недоступен',401);
  if(user.mfa_enabled)return challenge(tx,user);
  const created=await startSession(tx,user,false);
  await audit(tx,user.id,'auth.login',user.id,{mfa:false,source});return {created};
 }
 function loginResponse(ctx,result){return result.created?publishSession(ctx.res,result.created,isNativeRequest(ctx.req,cfg)):result;}
 async function validMfa(tx,user,code){
  // JSON objects/arrays are not credentials. Avoid coercion that can throw and
  // roll back the failed-attempt counter for malformed MFA requests.
  if(typeof code!=='string'||code.length>128)return false;
  const counter=verifyTotp(decryptSecret(user.mfa_secret,cfg.keys.encryptionKey),code,{lastCounter:user.mfa_last_counter});
  if(counter!==null){const r=await tx.run('UPDATE users SET mfa_last_counter=$1 WHERE id=$2 AND mfa_last_counter<$1',[counter,user.id]);return r.rowCount===1;}
  let digest;try{digest=hashRecoveryCode(code);}catch{return false;}
  const r=await tx.run('UPDATE recovery_codes SET used_at=$1 WHERE user_id=$2 AND code_hash=$3 AND used_at IS NULL',[Date.now(),user.id,digest]);return r.rowCount===1;
 }
 const oidc=createOidc({db,cfg,env,audit,throttle,completeLogin,loginResponse,publicUser,isNativeRequest});
 async function handle(ctx){
  const {req,res,user,ip}=ctx,p=ctx.path||ctx.url.pathname,m=ctx.method||req.method;
  if(p.startsWith('/api/auth/sso/')||p==='/api/auth/mobile/exchange')return oidc.handle(ctx);
  if(p==='/api/me'&&m==='GET')return {user:publicUser(user)};
  if(p==='/api/register'&&m==='POST'){
   await throttle(`register:${ip}`,10,600000);const b=await ctx.readBody(),email=normalizeEmail(b.email),password=passwordText(b.password,12),name=text(b.name,'Имя',60,2),role=choice(b.role||'player',['player','business'],'роль');
   const uid=id(),digest=await passwordService.hash(password);
   let created;try{created=await db.transaction(async tx=>{await tx.run('INSERT INTO users(id,email,name,password,role,created_at) VALUES($1,$2,$3,$4,$5,$6)',[uid,email,name,digest,role,Date.now()]);const fresh=await tx.get('SELECT * FROM users WHERE id=$1',[uid]);await audit(tx,uid,'auth.register',uid);return startSession(tx,fresh);});}catch(e){if(e.code==='23505')fail('Этот email уже зарегистрирован',409);throw e;}
   return publishSession(res,created,isNativeRequest(req,cfg));
  }
  if(p==='/api/login'&&m==='POST'){
   await throttle(`login:${ip}`,25,600000);const b=await ctx.readBody(),email=normalizeEmail(b.email);await throttle(`login-account:${email}`,15,600000);
   const password=passwordText(b.password),u=await db.get('SELECT * FROM users WHERE email=$1',[email]),ok=await passwordService.verify(password,u?.password);
   if(!u||u.disabled||u.password_login_enabled===0||!ok){await audit(db,null,'auth.login_failed','account',{account_hash:hash(email)});fail('Неверный email или пароль',401);}
   const result=await db.transaction(async tx=>{const fresh=await tx.get('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE',[u.id]);if(!fresh||fresh.disabled||fresh.password_login_enabled===0||fresh.password!==u.password)fail('Вход недоступен. Повторите вход.',401);return completeLogin(tx,fresh,ctx);});
   return loginResponse(ctx,result);
  }
  if(p==='/api/auth/mfa/login'&&m==='POST'){
   await throttle(`mfa-login:${ip}`,20,600000);const b=await ctx.readBody(),digest=hash(text(b.challengeId,'Подтверждение входа',64,64)),hint=await db.get('SELECT user_id FROM login_challenges WHERE id_hash=$1',[digest]);
   if(!hint)fail('Подтверждение истекло. Войдите заново.',401);
   const result=await db.transaction(async tx=>{
    const fresh=await tx.get('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE',[hint.user_id]);
    const c=await tx.get('SELECT * FROM login_challenges WHERE id_hash=$1 FOR UPDATE',[digest]);
    if(!c||c.expires<=Date.now()||c.attempts>=5)return {error:'Подтверждение истекло. Войдите заново.'};
    await tx.run('UPDATE login_challenges SET attempts=attempts+1 WHERE id_hash=$1',[digest]);
    if(!fresh||fresh.disabled||!fresh.mfa_enabled){await tx.run('DELETE FROM login_challenges WHERE id_hash=$1',[digest]);return {error:'Вход недоступен'};}
    if(!await validMfa(tx,fresh,b.code)){await audit(tx,fresh.id,'auth.mfa_failed',fresh.id);return {error:'Неверный, использованный или истёкший код'};}
    await tx.run('DELETE FROM login_challenges WHERE id_hash=$1',[digest]);const created=await startSession(tx,fresh,true);await audit(tx,fresh.id,'auth.login',fresh.id,{mfa:true});return {created};
   });
   if(result.error)fail(result.error,401);return loginResponse(ctx,result);
  }
  if(p==='/api/logout'&&m==='POST'){
   if(user)await db.transaction(async tx=>{await freshActor(tx,user);await tx.run('DELETE FROM sessions WHERE id=$1 AND user_id=$2',[user.session_id,user.id]);await audit(tx,user.id,'auth.logout',user.id);});
   res.setHeader('Set-Cookie',`aq_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cfg.secure?'; Secure':''}`);return {ok:true};
  }
  if(p==='/api/auth/security'&&m==='GET'){
   required(user);const sessions=(await db.all('SELECT id,created_at,last_seen,expires FROM sessions WHERE user_id=$1 AND expires>$2 AND last_seen>$3 ORDER BY last_seen DESC',[user.id,Date.now(),Date.now()-cfg.idleMs])).map(s=>({...s,current:s.id===user.session_id}));
   return {mfaEnabled:!!user.mfa_enabled,requiresMfaSetup:publicUser(user).requiresMfaSetup,passwordLoginEnabled:user.password_login_enabled!==0,sessions};
  }
  if(p==='/api/auth/mfa/setup'&&m==='POST'){
   required(user);await throttle(`mfa-setup:${user.id}`,6,600000);const b=await ctx.readBody(),candidate=required(await session(req));
   if(candidate.id!==user.id||candidate.session_id!==user.session_id)fail('Сессия изменилась. Войдите заново.',401);
   if(candidate.password_login_enabled===0)fail('Для SSO-аккаунта настройте MFA у поставщика входа. Локальная MFA доступна после привязки к локальному аккаунту оператором.',409);
   const ok=await passwordService.verify(passwordText(b.password),candidate.password);
   return db.transaction(async tx=>{
    const fresh=await freshActor(tx,user);
    if(fresh.password_login_enabled===0)fail('Для SSO-аккаунта настройте MFA у поставщика входа. Локальная MFA доступна после привязки к локальному аккаунту оператором.',409);
    if(!ok||fresh.password!==candidate.password)fail('Неверный пароль',401);if(fresh.mfa_enabled)fail('MFA уже включена',409);
    const secret=generateTotpSecret();await tx.run('UPDATE users SET mfa_pending_secret=$1,mfa_pending_at=$2 WHERE id=$3',[encryptSecret(secret,cfg.keys.encryptionKey),Date.now(),fresh.id]);await audit(tx,fresh.id,'auth.mfa_setup',fresh.id);
    return {secret,otpauthUri:`otpauth://totp/${encodeURIComponent('City Quest:'+fresh.email)}?secret=${encodeURIComponent(secret)}&issuer=City%20Quest&algorithm=SHA1&digits=6&period=30`};
   });
  }
  if(p==='/api/auth/mfa/enable'&&m==='POST'){
   required(user);await throttle(`mfa-enable:${user.id}`,10,600000);const b=await ctx.readBody();
   return db.transaction(async tx=>{
    const fresh=await freshActor(tx,user),now=Date.now();
    if(fresh.mfa_enabled||!fresh.mfa_pending_secret||!Number.isSafeInteger(fresh.mfa_pending_at)||now-fresh.mfa_pending_at>=600000||fresh.mfa_pending_at>now)fail('Начните настройку MFA заново');
    const counter=verifyTotp(decryptSecret(fresh.mfa_pending_secret,cfg.keys.encryptionKey),b.code);if(counter===null)fail('Неверный код подтверждения');
    await tx.run('UPDATE users SET mfa_enabled=1,mfa_secret=mfa_pending_secret,mfa_pending_secret=NULL,mfa_pending_at=NULL,mfa_last_counter=$1 WHERE id=$2',[counter,fresh.id]);const recoveryCodes=generateRecoveryCodes();
    await tx.run('DELETE FROM recovery_codes WHERE user_id=$1',[fresh.id]);for(const code of recoveryCodes)await tx.run('INSERT INTO recovery_codes(user_id,code_hash) VALUES($1,$2)',[fresh.id,hashRecoveryCode(code)]);
    await tx.run('DELETE FROM login_challenges WHERE user_id=$1',[fresh.id]);await tx.run('DELETE FROM mobile_auth_codes WHERE user_id=$1',[fresh.id]);await tx.run('DELETE FROM sessions WHERE user_id=$1 AND id<>$2',[fresh.id,fresh.session_id]);await tx.run('UPDATE sessions SET mfa_verified=1 WHERE id=$1',[fresh.session_id]);await audit(tx,fresh.id,'auth.mfa_enabled',fresh.id);return {recoveryCodes};
   });
  }
  if(p==='/api/auth/mfa/disable'&&m==='POST'){
   required(user);await throttle(`mfa-disable:${user.id}`,6,600000);const b=await ctx.readBody(),candidate=required(await session(req));
   if(candidate.id!==user.id||candidate.session_id!==user.session_id)fail('Сессия изменилась. Войдите заново.',401);
   const ok=await passwordService.verify(passwordText(b.password),candidate.password);
   return db.transaction(async tx=>{
    const fresh=await freshActor(tx,user);if(cfg.requireAdminMfa&&fresh.role==='admin')fail('Для администратора MFA обязательна',403);if(!fresh.mfa_enabled)fail('MFA не включена');
    if(!ok||fresh.password!==candidate.password||fresh.password_login_enabled===0||!await validMfa(tx,fresh,b.code))fail('Неверный пароль или код',401);
    await tx.run('UPDATE users SET mfa_enabled=0,mfa_secret=NULL,mfa_last_counter=-1,mfa_pending_secret=NULL,mfa_pending_at=NULL WHERE id=$1',[fresh.id]);await tx.run('DELETE FROM recovery_codes WHERE user_id=$1',[fresh.id]);await tx.run('DELETE FROM login_challenges WHERE user_id=$1',[fresh.id]);await tx.run('DELETE FROM mobile_auth_codes WHERE user_id=$1',[fresh.id]);await tx.run('DELETE FROM sessions WHERE user_id=$1 AND id<>$2',[fresh.id,fresh.session_id]);await tx.run('UPDATE sessions SET mfa_verified=0 WHERE id=$1',[fresh.session_id]);await audit(tx,fresh.id,'auth.mfa_disabled',fresh.id);return {ok:true};
   });
  }
  if(p==='/api/auth/sessions/revoke'&&m==='POST'){
   required(user);const b=await ctx.readBody();return db.transaction(async tx=>{const fresh=await freshActor(tx,user);if(b.allOthers===true){await tx.run('DELETE FROM sessions WHERE user_id=$1 AND id<>$2',[fresh.id,fresh.session_id]);await tx.run('DELETE FROM login_challenges WHERE user_id=$1',[fresh.id]);await tx.run('DELETE FROM mobile_auth_codes WHERE user_id=$1',[fresh.id]);}else await tx.run('DELETE FROM sessions WHERE user_id=$1 AND id=$2',[fresh.id,text(b.sessionId,'Сессия',40)]);await audit(tx,fresh.id,'auth.sessions_revoked',fresh.id);return {ok:true};});
  }
  return undefined;
 }
 return {publicUser,required,session,handle,freshActor,startSession,publishSession,completeLogin,loginResponse};
}
