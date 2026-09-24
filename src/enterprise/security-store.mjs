import {createHmac} from 'node:crypto';
import {safeEqualDigest} from '../security.mjs';

const ZERO_HASH = '0'.repeat(64);
const AUDIT_HEAD = 'audit_chain_head';
const AUDIT_LOCK = [172989, 2];
const RATE_CAPACITY_LOCK = [172989, 3];
function integer(value, name, minimum = 0) {
 if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Invalid ${name}`);
 return value;
}
function keyBytes(key) {
 if (Buffer.isBuffer(key) && key.length === 32) return key;
 if (typeof key === 'string' && /^[a-f0-9]{64}$/i.test(key)) return Buffer.from(key, 'hex');
 throw new TypeError('Audit key must contain 32 random bytes');
}
// Kept byte-compatible with src/security.mjs so migration does not resign history.
function metadataJson(value) {
 const seen = new Set();
 function canonical(input) {
  if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input !== 'object' || seen.has(input)) throw new TypeError('Audit metadata must be JSON-compatible');
  seen.add(input);
  let output;
  if (Array.isArray(input)) output = input.map(canonical);
  else {
   if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new TypeError('Audit metadata must be plain JSON');
   output = Object.fromEntries(Object.keys(input).sort().map(k => [k, canonical(input[k])]));
  }
  seen.delete(input);
  return output;
 }
 const serialized = JSON.stringify(canonical(value));
 if (Buffer.byteLength(serialized) > 8192) throw new TypeError('Audit metadata is too large');
 return serialized;
}
function eventHash(row, key) {
 return createHmac('sha256', key).update(JSON.stringify([
  row.id, row.actor_id, row.action, row.target, row.created_at,
  row.metadata, row.request_id, row.prev_hash,
 ])).digest('hex');
}
function sameHead(left, right) {return left?.id === right.id && safeEqualDigest(left?.hash, right.hash);}
async function storedHead(db) {
 const row = await db.get('SELECT value FROM meta WHERE key=$1', [AUDIT_HEAD]);
 if (!row) return null;
 try {return JSON.parse(row.value);} catch {return {invalid:true};}
}

export async function appendAudit(db, {actor = null, action, target = '', metadata = {}, requestId = null, at = Date.now()}, key) {
 const hmacKey = keyBytes(key);
 if (actor !== null && (typeof actor !== 'string' || actor.length > 256)) throw new TypeError('Invalid audit actor');
 if (typeof action !== 'string' || !action || action.length > 256 || typeof target !== 'string' || target.length > 2048) throw new TypeError('Invalid audit event');
 if (requestId !== null && (typeof requestId !== 'string' || requestId.length > 128)) throw new TypeError('Invalid request ID');
 const metadataText = metadataJson(metadata);
 integer(at, 'audit time');
 return db.transaction(async tx => {
  // The transaction-level lock is shared by every replica. It is held until the
  // outer business mutation commits, including when this is a nested savepoint.
  await tx.query('SELECT pg_advisory_xact_lock($1,$2)', AUDIT_LOCK);
  const previous = await tx.get('SELECT * FROM audit ORDER BY id DESC LIMIT 1');
  const head = previous ? {id:previous.id,hash:previous.event_hash} : {id:0,hash:ZERO_HASH};
  if (previous && !safeEqualDigest(previous.event_hash, eventHash(previous,hmacKey))) throw new Error('Audit chain head is invalid');
  const persisted = await storedHead(tx);
  if ((persisted && !sameHead(persisted,head)) || (!persisted && previous)) throw new Error('Audit checkpoint does not match history');
  const row = {id:head.id+1,actor_id:actor,action,target,created_at:at,metadata:metadataText,request_id:requestId,prev_hash:head.hash};
  integer(row.id, 'audit id', 1);
  const signature = eventHash(row,hmacKey);
  await tx.query('INSERT INTO audit(id,actor_id,action,target,created_at,metadata,request_id,prev_hash,event_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[row.id,actor,action,target,at,metadataText,requestId,head.hash,signature]);
  await tx.query('INSERT INTO meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',[AUDIT_HEAD,JSON.stringify({id:row.id,hash:signature})]);
  return row.id;
 });
}

export async function verifyAudit(db, key, {expectedHead} = {}) {
 const hmacKey = keyBytes(key);
 const snapshot = typeof db.readSnapshot === 'function' ? callback => db.readSnapshot(callback) : callback => db.transaction(callback);
 return snapshot(async tx => {
  // Never hold the writer's global audit lock while scanning history. An outer
  // database supplies a read-only, repeatable-read snapshot. Inside an existing
  // operator transaction, capture the checkpoint and physical tail in one SQL
  // snapshot instead; subsequent appends cannot change this verified prefix.
  const captured = await tx.get(`SELECT
   (SELECT value FROM meta WHERE key=$1) AS checkpoint,
   (SELECT id FROM audit ORDER BY id DESC LIMIT 1) AS tail_id,
   (SELECT event_hash FROM audit ORDER BY id DESC LIMIT 1) AS tail_hash,
   (SELECT id FROM audit WHERE id<=0 ORDER BY id LIMIT 1) AS invalid_id`, [AUDIT_HEAD]);
  let head = {id:0,hash:ZERO_HASH}, count = 0;
  if(captured.invalid_id!==null&&captured.invalid_id!==undefined)return {ok:false,count,at:captured.invalid_id,reason:'gap',head};
  const target = captured.tail_id===null||captured.tail_id===undefined ? head : {id:captured.tail_id,hash:captured.tail_hash};
  const hasCheckpoint=captured.checkpoint!==null&&captured.checkpoint!==undefined;
  let checkpoint = null;
  try {if(hasCheckpoint)checkpoint=JSON.parse(captured.checkpoint);} catch {return {ok:false,count,reason:'checkpoint',head};}
  if((hasCheckpoint&&!sameHead(checkpoint,target))||(!hasCheckpoint&&target.id)||!Number.isSafeInteger(target.id)||target.id<0)return {ok:false,count,reason:'checkpoint',head};
  for (;;) {
   const rows = await tx.all('SELECT * FROM audit WHERE id>$1 AND id<=$2 ORDER BY id LIMIT 1000',[head.id,target.id]);
   if (!rows.length) break;
   for (const row of rows) {
    if (row.id !== head.id+1) return {ok:false,count,at:row.id,reason:'gap',head};
    if (!safeEqualDigest(row.prev_hash,head.hash)) return {ok:false,count,at:row.id,reason:'previous_hash',head};
    if (!safeEqualDigest(row.event_hash,eventHash(row,hmacKey))) return {ok:false,count,at:row.id,reason:'event_hash',head};
    count++;head={id:row.id,hash:row.event_hash};
   }
  }
  if (!sameHead(target,head)) return {ok:false,count,reason:'checkpoint',head};
  if (expectedHead && !sameHead(expectedHead,head)) return {ok:false,count,reason:'external_checkpoint',head};
  return {ok:true,count,head};
 });
}

export async function pruneRateLimits(db, {now = Date.now(), limit = 1000} = {}) {
 integer(now,'time');integer(limit,'cleanup limit',1);
 // Admission holds the global capacity lock. Do not wait there for an expired
 // counter that a live request is resetting; lock its selected version before
 // deleting it, so a stale subquery cannot remove a newly refreshed counter.
 return (await db.run('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE reset_at<=$1 ORDER BY reset_at,key LIMIT $2 FOR UPDATE SKIP LOCKED)',[now,limit])).rowCount;
}

export async function consumeRate(db, key, {limit, windowMs, now = Date.now(), maxKeys = 10_000} = {}) {
 if (typeof key !== 'string' || !key || key.length > 256) throw new TypeError('Invalid rate-limit key');
 integer(limit,'rate limit',1);integer(windowMs,'rate window',1);integer(now,'time');integer(maxKeys,'rate key capacity',1);
 if (limit > 2147483646 || !Number.isSafeInteger(now+windowMs)) throw new TypeError('Rate window or count overflow');
 const values=[key,now,limit,now+windowMs];
 const update=`UPDATE rate_limits SET count=CASE WHEN reset_at<=$2 THEN 1 ELSE LEAST(count::bigint+1,$3::bigint+1)::integer END,
  reset_at=CASE WHEN reset_at<=$2 THEN $4 ELSE reset_at END WHERE key=$1 RETURNING count,reset_at`;
 const result = row => ({allowed:row.count<=limit,remaining:Math.max(0,limit-row.count),resetAt:row.reset_at,retryAfterMs:row.count<=limit?0:Math.max(1,row.reset_at-now)});
 // Existing keys have only a per-row lock and can be consumed independently.
 let row=await db.get(update,values);
 if(row)return result(row);
 return db.transaction(async tx=>{
  // Serialize only key admission and bounded pruning to enforce a hard capacity
  // across replicas; existing-key counters still use atomic PostgreSQL updates.
  await tx.query('SELECT pg_advisory_xact_lock($1,$2)',RATE_CAPACITY_LOCK);
  row=await tx.get(update,values);
  if(row)return result(row);
  await pruneRateLimits(tx,{now,limit:100});
  const used=await tx.get('SELECT COUNT(*) AS n FROM (SELECT key FROM rate_limits LIMIT $1) AS bounded',[maxKeys]);
  if(used.n>=maxKeys){
   const next=await tx.get('SELECT MIN(reset_at) AS at FROM rate_limits');
   return {allowed:false,remaining:0,resetAt:next.at,retryAfterMs:Math.max(1,next.at-now),reason:'capacity'};
  }
  row=await tx.get(`INSERT INTO rate_limits(key,count,reset_at) VALUES($1,1,$4)
   ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limits.reset_at<=$2 THEN 1 ELSE LEAST(rate_limits.count::bigint+1,$3::bigint+1)::integer END,
    reset_at=CASE WHEN rate_limits.reset_at<=$2 THEN $4 ELSE rate_limits.reset_at END RETURNING count,reset_at`,values);
  return result(row);
 });
}
