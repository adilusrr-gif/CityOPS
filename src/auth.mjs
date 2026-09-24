import {randomBytes} from 'node:crypto';
import {id,hash,fail,text,choice,normalizeEmail} from './domain.mjs';
import {passwordService as defaultPasswordService,passwordText} from './passwords.mjs';
import {transaction} from './db.mjs';
import {generateTotpSecret,verifyTotp,encryptSecret,decryptSecret,generateRecoveryCodes,hashRecoveryCode,sessionExpired} from './security.mjs';
const tokenFrom=req=>(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('aq_session='))?.slice(11);
import {readJson} from './http-body.mjs';
import {PROGRESSION} from './product-policy.mjs';
export {readJson};
export function createAuth({db,cfg,throttle,audit,passwordService=defaultPasswordService}){
 function publicUser(u){return u?{id:u.id,email:u.email,name:u.name,role:u.role,xp:u.xp,level:1+Math.floor(u.xp/PROGRESSION.xpPerLevel),mfaEnabled:!!u.mfa_enabled,requiresMfaSetup:!!(cfg.requireAdminMfa&&u.role==='admin'&&!u.mfa_enabled)}:null;}
 function required(user,roles){if(!user)fail('Войдите в аккаунт',401);if(roles&&!roles.includes(user.role))fail('Недостаточно прав',403);if(roles&&user.role==='admin'&&cfg.requireAdminMfa&&(!user.mfa_enabled||!user.session_mfa_verified))fail('Настройте MFA в профиле перед административными действиями',423);return user;}
 function session(req){const token=tokenFrom(req);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const u=db.prepare('SELECT u.*,s.id AS session_id,s.expires,s.last_seen,s.mfa_verified AS session_mfa_verified FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=?').get(hash(token));if(!u)return null;if(u.disabled||sessionExpired(u,{idleMs:cfg.idleMs})){db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));return null;}if(Date.now()-u.last_seen>15000)db.prepare('UPDATE sessions SET last_seen=? WHERE token=?').run(Date.now(),hash(token));return u;}
 function startSession(user,mfaVerified=false){const token=randomBytes(32).toString('hex'),now=Date.now(),seconds=user.role==='admin'?43200:604800;db.prepare('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,?)').run(hash(token),id(),user.id,now+seconds*1000,now,now,mfaVerified?1:0);return {token,seconds,user};}
 function publishSession(res,{token,seconds,user}){res.setHeader('Set-Cookie',`aq_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${cfg.secure?'; Secure':''}`);return {user:publicUser(user)};}
 function freshActor(req,user){const fresh=required(session(req));if(fresh.id!==user.id||fresh.session_id!==user.session_id)fail('Сессия изменилась. Войдите заново.',401);return fresh;}
 function validMfa(user,code){
  // JSON objects/arrays are not credentials. Avoid coercion that can throw and
  // roll back the failed-attempt counter for malformed MFA requests.
  if(typeof code!=='string'||code.length>128)return false;
  const counter=verifyTotp(decryptSecret(user.mfa_secret,cfg.keys.encryptionKey),code,{lastCounter:user.mfa_last_counter});
  if(counter!==null){const result=db.prepare('UPDATE users SET mfa_last_counter=? WHERE id=? AND mfa_last_counter<?').run(counter,user.id,counter);return Number(result.changes)===1;}
  let digest;try{digest=hashRecoveryCode(code);}catch{return false;}const result=db.prepare('UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL').run(Date.now(),user.id,digest);return Number(result.changes)===1;
 }
 async function handle(req,res,url,user,ip){const p=url.pathname,m=req.method;
  if(p==='/api/me'&&m==='GET')return {user:publicUser(user)};
  if(p==='/api/register'&&m==='POST'){
   throttle(`register:${ip}`,10,600000);const b=await readJson(req),email=normalizeEmail(b.email),password=passwordText(b.password,12),name=text(b.name,'Имя',60,2),role=choice(b.role||'player',['player','business'],'роль');
   const uid=id(),digest=await passwordService.hash(password);
   const created=transaction(db,()=>{if(db.prepare('SELECT id FROM users WHERE email=?').get(email))fail('Этот email уже зарегистрирован',409);db.prepare('INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run(uid,email,name,digest,role,Date.now());const fresh=db.prepare('SELECT * FROM users WHERE id=?').get(uid);const created=startSession(fresh);audit(uid,'auth.register',uid);return created;});return publishSession(res,created);
  }
  if(p==='/api/login'&&m==='POST'){
   throttle(`login:${ip}`,25,600000);const b=await readJson(req),email=normalizeEmail(b.email);throttle(`login-account:${email}`,15,600000);const password=passwordText(b.password),u=db.prepare('SELECT * FROM users WHERE email=?').get(email),ok=await passwordService.verify(password,u?.password);
   if(!u||u.disabled||!ok){audit(null,'auth.login_failed','account',{account_hash:hash(email)});fail('Неверный email или пароль',401);}
   const result=transaction(db,()=>{const fresh=db.prepare('SELECT * FROM users WHERE id=?').get(u.id);if(!fresh||fresh.disabled||fresh.password!==u.password)fail('Вход недоступен. Повторите вход.',401);if(fresh.mfa_enabled){const challengeId=randomBytes(32).toString('hex');db.prepare('INSERT INTO login_challenges(id_hash,user_id,expires) VALUES(?,?,?)').run(hash(challengeId),fresh.id,Date.now()+300000);return {mfaRequired:true,challengeId};}const created=startSession(fresh);audit(fresh.id,'auth.login',fresh.id,{mfa:false});return {created};});return result.created?publishSession(res,result.created):result;
  }
  if(p==='/api/auth/mfa/login'&&m==='POST'){
   throttle(`mfa-login:${ip}`,20,600000);const b=await readJson(req),challengeHash=hash(text(b.challengeId,'Подтверждение входа',64,64));
   const result=transaction(db,()=>{
    const challenge=db.prepare('SELECT * FROM login_challenges WHERE id_hash=?').get(challengeHash);
    if(!challenge||challenge.expires<=Date.now()||challenge.attempts>=5)return {error:'Подтверждение истекло. Войдите заново.'};
    db.prepare('UPDATE login_challenges SET attempts=attempts+1 WHERE id_hash=?').run(challenge.id_hash);
    const fresh=db.prepare('SELECT * FROM users WHERE id=?').get(challenge.user_id);
    if(!fresh||fresh.disabled||!fresh.mfa_enabled){db.prepare('DELETE FROM login_challenges WHERE id_hash=?').run(challenge.id_hash);return {error:'Вход недоступен'};}
    // Failures return normally so the attempt count and audit record commit.
    if(!validMfa(fresh,b.code)){audit(fresh.id,'auth.mfa_failed',fresh.id);return {error:'Неверный, использованный или истёкший код'};}
    db.prepare('DELETE FROM login_challenges WHERE id_hash=?').run(challenge.id_hash);
    const created=startSession(fresh,true);audit(fresh.id,'auth.login',fresh.id,{mfa:true});return {created};
   });
   if(result.error)fail(result.error,401);return publishSession(res,result.created);
  }
  if(p==='/api/logout'&&m==='POST'){const token=tokenFrom(req);if(token)db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token));res.setHeader('Set-Cookie',`aq_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cfg.secure?'; Secure':''}`);if(user)audit(user.id,'auth.logout',user.id);return {ok:true};}
  if(p==='/api/auth/security'&&m==='GET'){required(user);const sessions=db.prepare('SELECT id,created_at,last_seen,expires FROM sessions WHERE user_id=? AND expires>? AND last_seen>? ORDER BY last_seen DESC').all(user.id,Date.now(),Date.now()-cfg.idleMs).map(s=>({...s,current:s.id===user.session_id}));return {mfaEnabled:!!user.mfa_enabled,requiresMfaSetup:publicUser(user).requiresMfaSetup,sessions};}
  if(p==='/api/auth/mfa/setup'&&m==='POST'){
   required(user);throttle(`mfa-setup:${user.id}`,6,600000);const b=await readJson(req),candidate=freshActor(req,user),ok=await passwordService.verify(passwordText(b.password),candidate.password);
   return transaction(db,()=>{
    const fresh=freshActor(req,user);
    if(!ok||fresh.password!==candidate.password)fail('Неверный пароль',401);
    if(fresh.mfa_enabled)fail('MFA уже включена',409);
    const secret=generateTotpSecret();
    db.prepare('UPDATE users SET mfa_pending_secret=?,mfa_pending_at=? WHERE id=?').run(encryptSecret(secret,cfg.keys.encryptionKey),Date.now(),fresh.id);
    audit(fresh.id,'auth.mfa_setup',fresh.id);
    return {secret,otpauthUri:`otpauth://totp/${encodeURIComponent('City Quest:'+fresh.email)}?secret=${encodeURIComponent(secret)}&issuer=City%20Quest&algorithm=SHA1&digits=6&period=30`};
   });
  }
  if(p==='/api/auth/mfa/enable'&&m==='POST'){
   required(user);throttle(`mfa-enable:${user.id}`,10,600000);const b=await readJson(req);
   return transaction(db,()=>{
    const fresh=freshActor(req,user),now=Date.now();
    if(fresh.mfa_enabled||!fresh.mfa_pending_secret||!Number.isSafeInteger(fresh.mfa_pending_at)||now-fresh.mfa_pending_at>=600000||fresh.mfa_pending_at>now)fail('Начните настройку MFA заново');
    const counter=verifyTotp(decryptSecret(fresh.mfa_pending_secret,cfg.keys.encryptionKey),b.code);
    if(counter===null)fail('Неверный код подтверждения');
    const changed=db.prepare('UPDATE users SET mfa_enabled=1,mfa_secret=mfa_pending_secret,mfa_pending_secret=NULL,mfa_pending_at=NULL,mfa_last_counter=? WHERE id=? AND mfa_enabled=0 AND mfa_pending_secret=?').run(counter,fresh.id,fresh.mfa_pending_secret);
    if(Number(changed.changes)!==1)fail('Настройка MFA изменилась. Начните заново.',409);
    const recoveryCodes=generateRecoveryCodes();
    db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(fresh.id);
    for(const code of recoveryCodes)db.prepare('INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?)').run(fresh.id,hashRecoveryCode(code));
    db.prepare('DELETE FROM login_challenges WHERE user_id=?').run(fresh.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(fresh.id,fresh.session_id);
    db.prepare('UPDATE sessions SET mfa_verified=1 WHERE id=?').run(fresh.session_id);
    audit(fresh.id,'auth.mfa_enabled',fresh.id);return {recoveryCodes};
   });
  }
  if(p==='/api/auth/mfa/disable'&&m==='POST'){
   required(user);throttle(`mfa-disable:${user.id}`,6,600000);const b=await readJson(req),candidate=freshActor(req,user),ok=await passwordService.verify(passwordText(b.password),candidate.password);
   return transaction(db,()=>{
    const fresh=freshActor(req,user);
    if(cfg.requireAdminMfa&&fresh.role==='admin')fail('Для администратора MFA обязательна',403);
    if(!fresh.mfa_enabled)fail('MFA не включена');
    if(!ok||fresh.password!==candidate.password||!validMfa(fresh,b.code))fail('Неверный пароль или код',401);
    db.prepare('UPDATE users SET mfa_enabled=0,mfa_secret=NULL,mfa_last_counter=-1,mfa_pending_secret=NULL,mfa_pending_at=NULL WHERE id=?').run(fresh.id);
    db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(fresh.id);
    db.prepare('DELETE FROM login_challenges WHERE user_id=?').run(fresh.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(fresh.id,fresh.session_id);
    db.prepare('UPDATE sessions SET mfa_verified=0 WHERE id=?').run(fresh.session_id);
    audit(fresh.id,'auth.mfa_disabled',fresh.id);return {ok:true};
   });
  }
  if(p==='/api/auth/sessions/revoke'&&m==='POST'){required(user);const b=await readJson(req);return transaction(db,()=>{const fresh=freshActor(req,user);if(b.allOthers===true){db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(fresh.id,fresh.session_id);db.prepare('DELETE FROM login_challenges WHERE user_id=?').run(fresh.id);}else{const sid=text(b.sessionId,'Сессия',40);db.prepare('DELETE FROM sessions WHERE user_id=? AND id=?').run(fresh.id,sid);}audit(fresh.id,'auth.sessions_revoked',fresh.id);return {ok:true};});}
  return undefined;
 }
 return {publicUser,required,session,handle};
}
