import {createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ZERO_HASH = '0'.repeat(64);
const AUDIT_HEAD = 'audit_chain_head';
const DEVELOPMENT_KEYS = {encryptionKey: randomBytes(32), auditKey: randomBytes(32)};

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`Invalid ${name}`);
  return value;
}

function keyBytes(value, name = 'security key') {
  if (Buffer.isBuffer(value) && value.length === 32) return value;
  if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  throw new TypeError(`${name} must contain exactly 32 random bytes (64 hexadecimal characters)`);
}

// The caller must persist development keys for a file-backed database. The fallback
// is intentionally process-local and is only suitable for disposable/test databases.
export function loadSecurityKeys({env = process.env} = {}) {
  const production = env.NODE_ENV === 'production';
  function read(name, fallback) {
    if (env[name]) return keyBytes(env[name], name);
    if (production) throw new Error(`${name} is required in production`);
    return Buffer.from(fallback);
  }
  const encryptionKey = read('DATA_ENCRYPTION_KEY', DEVELOPMENT_KEYS.encryptionKey);
  const auditKey = read('AUDIT_HMAC_KEY', DEVELOPMENT_KEYS.auditKey);
  if (production && timingSafeEqual(encryptionKey, auditKey)) throw new Error('Encryption and audit keys must differ');
  return {encryptionKey, auditKey};
}

export function base32Encode(input) {
  const bytes = Buffer.from(input);
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {bits -= 5; result += BASE32[(value >>> bits) & 31];}
  }
  if (bits) result += BASE32[(value << (5 - bits)) & 31];
  return result;
}

export function base32Decode(input) {
  if (typeof input !== 'string') throw new TypeError('Invalid base32 secret');
  const normalized = input.toUpperCase();
  if (!/^[A-Z2-7]*={0,6}$/.test(normalized)) throw new TypeError('Invalid base32 secret');
  const bare = normalized.replace(/=+$/, '');
  if (![0, 2, 4, 5, 7].includes(bare.length % 8)) throw new TypeError('Invalid base32 length');
  if (bare !== normalized && (normalized.length % 8 !== 0 || normalized.length - bare.length !== (8 - bare.length % 8) % 8)) throw new TypeError('Invalid base32 padding');
  let bits = 0, value = 0;
  const bytes = [];
  for (const character of bare) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {bits -= 8; bytes.push((value >>> bits) & 255);}
  }
  if (bits && (value & ((1 << bits) - 1))) throw new TypeError('Noncanonical base32 secret');
  return Buffer.from(bytes);
}

export function generateTotpSecret() {return base32Encode(randomBytes(20));}

export function totp(secret, {now = Date.now(), counter} = {}) {
  const step = counter === undefined ? Math.floor(integer(now, 'time') / 30_000) : integer(counter, 'counter');
  const key = base32Decode(secret);
  if (key.length < 10) throw new TypeError('TOTP secret is too short');
  const data = Buffer.alloc(8);
  data.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(data).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// Persist the returned counter together with the authorized operation in one
// transaction. Returning the highest match avoids an ambiguous window replay.
export function verifyTotp(secret, code, {now = Date.now(), lastCounter = -1, window = 1} = {}) {
  integer(now, 'time'); integer(lastCounter, 'last counter', -1); integer(window, 'TOTP window');
  if (window > 1) throw new TypeError('TOTP window cannot exceed one step');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = Math.floor(now / 30_000);
  let match = null;
  for (let step = Math.max(0, current - window); step <= current + window; step++) {
    const accepted = timingSafeEqual(Buffer.from(totp(secret, {counter: step})), Buffer.from(code));
    if (accepted && step > lastCounter) match = step;
  }
  return match;
}

export function encryptSecret(plaintext, key) {
  if (typeof plaintext !== 'string' || !plaintext || Buffer.byteLength(plaintext) > 4096) throw new TypeError('Invalid secret');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(Buffer.from('cityquest:mfa:v1'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(envelope, key) {
  const encryptionKey = keyBytes(key);
  try {
    if (typeof envelope !== 'string' || envelope.length > 6000) throw new Error();
    const parts = envelope.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
    const [iv, tag, ciphertext] = parts.slice(1).map(p => Buffer.from(p, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw new Error();
    if ([iv, tag, ciphertext].some((p, index) => p.toString('base64url') !== parts[index + 1])) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAAD(Buffer.from('cityquest:mfa:v1'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {throw new Error('Encrypted secret could not be authenticated');}
}

export function generateRecoveryCodes(count = 10) {
  integer(count, 'recovery code count', 1);
  if (count > 50) throw new TypeError('Too many recovery codes');
  return Array.from({length: count}, () => randomBytes(10).toString('hex').toUpperCase().match(/.{5}/g).join('-'));
}

export function hashRecoveryCode(code) {
  if (typeof code !== 'string' || code.length > 128) throw new TypeError('Invalid recovery code');
  const normalized = code.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-F0-9]{20}$/.test(normalized)) throw new TypeError('Invalid recovery code');
  return createHash('sha256').update('cityquest:recovery:v1:').update(normalized).digest('hex');
}

export function safeEqualDigest(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function sessionExpired(session, {now = Date.now(), idleMs = 30 * 60_000, clockSkewMs = 5000} = {}) {
  integer(now, 'time'); integer(idleMs, 'session idle timeout', 1); integer(clockSkewMs, 'session clock skew');
  if (clockSkewMs > 30000) throw new TypeError('Session clock skew cannot exceed 30 seconds');
  if (!session || !Number.isSafeInteger(session.expires) || !Number.isSafeInteger(session.last_seen)) return true;
  // Application replicas can differ slightly even with synchronized clocks.
  // Tolerate bounded future activity without extending either expiry deadline.
  return session.expires <= now || session.last_seen + idleMs <= now || session.last_seen > now + clockSkewMs;
}

let savepointSequence = 0;
function atomic(db, callback) {
  if (!db.isTransaction) {
    db.exec('BEGIN IMMEDIATE');
    try {const value = callback(); db.exec('COMMIT'); return value;}
    catch (error) {db.exec('ROLLBACK'); throw error;}
  }
  const savepoint = `security_${++savepointSequence}`;
  // The caller owns the outer transaction; failures only roll back this helper.
  db.exec(`SAVEPOINT ${savepoint}`);
  try {const value = callback(); db.exec(`RELEASE SAVEPOINT ${savepoint}`); return value;}
  catch (error) {db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`); db.exec(`RELEASE SAVEPOINT ${savepoint}`); throw error;}
}

export function pruneRateLimits(db, {now = Date.now(), limit = 1000} = {}) {
  integer(now, 'time'); integer(limit, 'cleanup limit', 1);
  return Number(db.prepare('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE reset_at<=? ORDER BY reset_at LIMIT ?)').run(now, limit).changes);
}

export function consumeRate(db, key, {limit, windowMs, now = Date.now(), maxKeys = 10_000} = {}) {
  if (typeof key !== 'string' || !key || key.length > 256) throw new TypeError('Invalid rate-limit key');
  integer(limit, 'rate limit', 1); integer(windowMs, 'rate window', 1); integer(now, 'time'); integer(maxKeys, 'rate key capacity', 1);
  if (!Number.isSafeInteger(now + windowMs)) throw new TypeError('Rate window overflow');
  return atomic(db, () => {
    pruneRateLimits(db, {now, limit: 100});
    let current = db.prepare('SELECT count,reset_at FROM rate_limits WHERE key=?').get(key);
    if (!current) {
      const used = db.prepare('SELECT COUNT(*) n FROM (SELECT key FROM rate_limits LIMIT ?)').get(maxKeys).n;
      if (used >= maxKeys) {
        const resetAt = db.prepare('SELECT MIN(reset_at) value FROM rate_limits').get().value;
        return {allowed: false, remaining: 0, resetAt, retryAfterMs: Math.max(1, resetAt - now), reason: 'capacity'};
      }
      current = {count: 1, reset_at: now + windowMs};
      db.prepare('INSERT INTO rate_limits(key,count,reset_at) VALUES(?,?,?)').run(key, current.count, current.reset_at);
    } else {
      current = current.reset_at <= now ? {count: 1, reset_at: now + windowMs} : {...current, count: Math.min(current.count + 1, limit + 1)};
      db.prepare('UPDATE rate_limits SET count=?,reset_at=? WHERE key=?').run(current.count, current.reset_at, key);
    }
    const allowed = current.count <= limit;
    return {allowed, remaining: Math.max(0, limit - current.count), resetAt: current.reset_at, retryAfterMs: allowed ? 0 : Math.max(1, current.reset_at - now)};
  });
}

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

function hasMeta(db) {return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get());}
function storedHead(db) {
  const raw = db.prepare('SELECT value FROM meta WHERE key=?').get(AUDIT_HEAD);
  if (!raw) return null;
  try {return JSON.parse(raw.value);} catch {return {invalid: true};}
}
function sameHead(left, right) {return left?.id === right.id && safeEqualDigest(left?.hash, right.hash);}
function writeHead(db, head) {
  if (hasMeta(db)) db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(AUDIT_HEAD, JSON.stringify(head));
}

export function appendAudit(db, {actor = null, action, target = '', metadata = {}, requestId = null, at = Date.now()}, key) {
  const hmacKey = keyBytes(key, 'audit key');
  if (actor !== null && (typeof actor !== 'string' || actor.length > 256)) throw new TypeError('Invalid audit actor');
  if (typeof action !== 'string' || !action || action.length > 256 || typeof target !== 'string' || target.length > 2048) throw new TypeError('Invalid audit event');
  if (requestId !== null && (typeof requestId !== 'string' || requestId.length > 128)) throw new TypeError('Invalid request ID');
  const serialized = metadataJson(metadata);
  integer(at, 'audit time');
  return atomic(db, () => {
    const previous = db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 1').get();
    const head = previous ? {id: previous.id, hash: previous.event_hash} : {id: 0, hash: ZERO_HASH};
    if (previous && !safeEqualDigest(previous.event_hash, eventHash(previous, hmacKey))) throw new Error('Audit chain head is invalid; verify or migrate audit history');
    if (hasMeta(db)) {
      const persisted = storedHead(db);
      if ((persisted && !sameHead(persisted, head)) || (!persisted && previous)) throw new Error('Audit checkpoint does not match history');
    }
    const row = {id: head.id + 1, actor_id: actor, action, target, created_at: at, metadata: serialized, request_id: requestId, prev_hash: head.hash};
    const signature = eventHash(row, hmacKey);
    db.prepare('INSERT INTO audit(id,actor_id,action,target,created_at,metadata,request_id,prev_hash,event_hash) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, actor, action, target, at, serialized, requestId, head.hash, signature);
    writeHead(db, {id: row.id, hash: signature});
    return row.id;
  });
}

function verifyAuditRows(db, hmacKey, {expectedHead} = {}) {
  let head = {id: 0, hash: ZERO_HASH}, count = 0;
  for (const row of db.prepare('SELECT * FROM audit ORDER BY id').iterate()) {
    if (row.id !== head.id + 1) return {ok: false, count, at: row.id, reason: 'gap', head};
    if (!safeEqualDigest(row.prev_hash, head.hash)) return {ok: false, count, at: row.id, reason: 'previous_hash', head};
    if (!safeEqualDigest(row.event_hash, eventHash(row, hmacKey))) return {ok: false, count, at: row.id, reason: 'event_hash', head};
    count++; head = {id: row.id, hash: row.event_hash};
  }
  if (hasMeta(db)) {
    const checkpoint = storedHead(db);
    if ((checkpoint && !sameHead(checkpoint, head)) || (!checkpoint && count)) return {ok: false, count, reason: 'checkpoint', head};
  }
  if (expectedHead && !sameHead(expectedHead, head)) return {ok: false, count, reason: 'external_checkpoint', head};
  return {ok: true, count, head};
}

export function verifyAudit(db, key, options = {}) {
  const hmacKey = keyBytes(key, 'audit key');
  if (db.isTransaction) return verifyAuditRows(db, hmacKey, options);
  // Read the events and checkpoint from one SQLite snapshot. A simultaneous
  // writer must not turn an otherwise-valid chain into a false tampering alert.
  db.exec('BEGIN');
  try {const result = verifyAuditRows(db, hmacKey, options); db.exec('COMMIT'); return result;}
  catch (error) {db.exec('ROLLBACK'); throw error;}
}

// One-time trust boundary: pre-upgrade rows cannot be authenticated retroactively.
// The marker records this limitation. Gaps in old IDs cause migration to fail.
export function sealLegacyAudit(db, key) {
  const hmacKey = keyBytes(key, 'audit key');
  return atomic(db, () => {
    // Startup must not materialize years of metadata into the JS heap.
    const {count, signed} = db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(CASE WHEN COALESCE(event_hash,'')<>'' OR COALESCE(prev_hash,'')<>'' THEN 1 ELSE 0 END),0) AS signed FROM audit").get();
    if (signed) {
      if (signed !== count) throw new Error('Refusing mixed signed and unsigned audit history');
      const check = verifyAudit(db, hmacKey);
      if (!check.ok) throw new Error('Existing audit history failed verification');
      return {migrated: 0, ...check};
    }
    if (hasMeta(db) && storedHead(db)?.id) throw new Error('Refusing to reseal previously signed audit history');
    let head = {id: 0, hash: ZERO_HASH};
    for (const original of db.prepare('SELECT * FROM audit ORDER BY id').iterate()) {
      if (original.id !== head.id + 1) throw new Error('Legacy audit contains an ID gap');
      const row = {...original, metadata: metadataJson({legacyUnsigned: true}), request_id: original.request_id ?? null, prev_hash: head.hash};
      const signature = eventHash(row, hmacKey);
      db.prepare('UPDATE audit SET metadata=?,request_id=?,prev_hash=?,event_hash=? WHERE id=?').run(row.metadata, row.request_id, row.prev_hash, signature, row.id);
      head = {id: row.id, hash: signature};
    }
    writeHead(db, head);
    return {migrated: count, ok: true, count, head};
  });
}
