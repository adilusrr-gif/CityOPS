import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  appendAudit, base32Decode, base32Encode, consumeRate, decryptSecret, encryptSecret,
  generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, loadSecurityKeys,
  pruneRateLimits, safeEqualDigest, sealLegacyAudit, sessionExpired, totp, verifyAudit, verifyTotp,
} from '../src/security.mjs';

const KEY = Buffer.alloc(32, 11);
const OTHER_KEY = Buffer.alloc(32, 22);
function database(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rate_expiry ON rate_limits(reset_at);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT,action TEXT NOT NULL,target TEXT NOT NULL,created_at INTEGER NOT NULL,metadata TEXT,request_id TEXT,prev_hash TEXT,event_hash TEXT);`);
  return db;
}

test('base32 round trips RFC4648 vectors and rejects ambiguous encodings', () => {
  for (const [plain, encoded] of [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']]) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.equal(base32Decode(encoded.toLowerCase()).toString(), plain);
    assert.equal(base32Decode(encoded + '='.repeat((8 - encoded.length % 8) % 8)).toString(), plain);
  }
  for (const invalid of ['A', 'AB', 'MY=', 'MY======A', 'M Y', 'M0======', 'MY=======']) assert.throws(() => base32Decode(invalid));
  assert.equal(base32Decode(generateTotpSecret()).length, 20);
});

test('TOTP matches RFC6238 SHA1 vectors truncated to six digits', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  for (const [seconds, expected] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
    assert.equal(totp(secret, {now: seconds * 1000}), expected);
    assert.equal(verifyTotp(secret, expected, {now: seconds * 1000}), Math.floor(seconds / 30));
  }
});

test('TOTP accepts only adjacent steps and returns a counter for atomic replay prevention', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  const code = totp(secret, {counter: 100});
  assert.equal(verifyTotp(secret, code, {now: 99 * 30_000}), 100);
  assert.equal(verifyTotp(secret, code, {now: 101 * 30_000}), 100);
  assert.equal(verifyTotp(secret, code, {now: 102 * 30_000}), null);
  assert.equal(verifyTotp(secret, code, {now: 101 * 30_000, lastCounter: 100}), null);
  assert.equal(verifyTotp(secret, code, {now: 100 * 30_000, lastCounter: 101}), null);
  assert.equal(verifyTotp(secret, code, {now: 101 * 30_000, window: 0}), null);
  for (const invalid of [123456, '12345', '1234567', '123 456', '12345x']) assert.equal(verifyTotp(secret, invalid, {now: 0}), null);
  assert.throws(() => verifyTotp(secret, code, {window: 2}));
  assert.throws(() => totp(secret, {counter: -1}));
  // Caller transaction decides whether consuming the counter commits.
  const db = database();
  try {
    db.exec('CREATE TABLE mfa(last_counter INTEGER NOT NULL);INSERT INTO mfa VALUES(-1)');
    db.exec('BEGIN IMMEDIATE');
    const matched = verifyTotp(secret, code, {now: 100 * 30_000, lastCounter: db.prepare('SELECT last_counter FROM mfa').get().last_counter});
    db.prepare('UPDATE mfa SET last_counter=?').run(matched);
    assert.equal(verifyTotp(secret, code, {now: 100 * 30_000, lastCounter: db.prepare('SELECT last_counter FROM mfa').get().last_counter}), null);
    db.exec('ROLLBACK');
    assert.equal(verifyTotp(secret, code, {now: 100 * 30_000, lastCounter: db.prepare('SELECT last_counter FROM mfa').get().last_counter}), 100);
  } finally {db.close();}
});

test('authenticated encryption randomizes envelopes and rejects modified ciphertext, tags and keys', () => {
  const secret = generateTotpSecret();
  const encrypted = encryptSecret(secret, KEY);
  assert.equal(decryptSecret(encrypted, KEY), secret);
  assert.notEqual(encrypted, encryptSecret(secret, KEY));
  assert.equal(encrypted.includes(secret), false);
  assert.throws(() => decryptSecret(encrypted, OTHER_KEY), /authenticated/);
  for (const part of [1, 2, 3]) {
    const pieces = encrypted.split('.');
    const changed = Buffer.from(pieces[part], 'base64url'); changed[0] ^= 1;
    pieces[part] = changed.toString('base64url');
    assert.throws(() => decryptSecret(pieces.join('.'), KEY), /authenticated/);
  }
  for (const bad of ['', 'v2.a.b.c', 'v1.invalid', `${encrypted}.extra`, null]) assert.throws(() => decryptSecret(bad, KEY), /authenticated/);
  assert.throws(() => encryptSecret(secret, 'not-a-key'));
});

test('production requires valid independent encryption and audit keys', () => {
  assert.throws(() => loadSecurityKeys({env: {NODE_ENV: 'production'}}), /DATA_ENCRYPTION_KEY/);
  assert.throws(() => loadSecurityKeys({env: {NODE_ENV: 'production', DATA_ENCRYPTION_KEY: KEY.toString('hex')}}), /AUDIT_HMAC_KEY/);
  assert.throws(() => loadSecurityKeys({env: {DATA_ENCRYPTION_KEY: 'invalid'}}), /64 hexadecimal/);
  assert.throws(() => loadSecurityKeys({env: {NODE_ENV: 'production', DATA_ENCRYPTION_KEY: KEY.toString('hex'), AUDIT_HMAC_KEY: KEY.toString('hex')}}), /differ/);
  const keys = loadSecurityKeys({env: {NODE_ENV: 'production', DATA_ENCRYPTION_KEY: KEY.toString('hex'), AUDIT_HMAC_KEY: OTHER_KEY.toString('hex')}});
  assert.deepEqual(keys.encryptionKey, KEY); assert.deepEqual(keys.auditKey, OTHER_KEY);
});

test('recovery codes are random, normalized and hashed with fixed-length comparison', () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10);
  const hash = hashRecoveryCode(codes[0]);
  assert.equal(hash.length, 64);
  assert.equal(hash, hashRecoveryCode(codes[0].toLowerCase().replaceAll('-', ' ')));
  assert.equal(safeEqualDigest(hash, hash.toUpperCase()), true);
  assert.equal(safeEqualDigest(hash, hashRecoveryCode(codes[1])), false);
  assert.equal(safeEqualDigest(hash, hash.slice(1)), false);
  assert.equal(safeEqualDigest(hash, undefined), false);
  assert.throws(() => hashRecoveryCode('not-valid'));
});

test('sessions expire at idle and absolute boundaries and fail closed for invalid timestamps', () => {
  assert.equal(sessionExpired({expires: 5000, last_seen: 1000}, {now: 1999, idleMs: 1000}), false);
  assert.equal(sessionExpired({expires: 5000, last_seen: 1000}, {now: 2000, idleMs: 1000}), true);
  assert.equal(sessionExpired({expires: 1500, last_seen: 1499}, {now: 1500, idleMs: 1000}), true);
  assert.equal(sessionExpired({expires: 5000, last_seen: 2001}, {now: 2000, idleMs: 1000}), false);
  assert.equal(sessionExpired({expires: 5000}, {now: 2000, idleMs: 1000}), true);
});

test('persistent limiter has exact fixed-window boundaries, independent keys and rollback semantics', () => {
  const db = database();
  try {
    const options = {limit: 2, windowMs: 1000, now: 1000};
    assert.deepEqual(consumeRate(db, 'login:a', options), {allowed: true, remaining: 1, resetAt: 2000, retryAfterMs: 0});
    assert.equal(consumeRate(db, 'login:a', options).remaining, 0);
    assert.equal(consumeRate(db, 'login:a', {...options, now: 1999}).retryAfterMs, 1);
    assert.equal(consumeRate(db, 'login:b', options).allowed, true);
    assert.equal(consumeRate(db, 'login:a', {...options, now: 2000}).allowed, true);
    db.exec('BEGIN IMMEDIATE');
    assert.equal(consumeRate(db, 'inside-transaction', options).allowed, true);
    assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT 1 FROM rate_limits WHERE key=?').get('inside-transaction'), undefined);
  } finally {db.close();}
});

test('limiter bounds active keys, caps rejected counts and prunes expired rows in bounded batches', () => {
  const db = database();
  try {
    const options = {limit: 1, windowMs: 1000, now: 1000, maxKeys: 2};
    consumeRate(db, 'a', options); consumeRate(db, 'b', options);
    assert.equal(consumeRate(db, 'c', options).reason, 'capacity');
    assert.equal(db.prepare('SELECT count(*) n FROM rate_limits').get().n, 2);
    for (let i = 0; i < 10; i++) assert.equal(consumeRate(db, 'a', options).allowed, false);
    assert.equal(db.prepare('SELECT count FROM rate_limits WHERE key=?').get('a').count, 2);
    assert.equal(pruneRateLimits(db, {now: 2000, limit: 1}), 1);
    assert.equal(db.prepare('SELECT count(*) n FROM rate_limits').get().n, 1);
    assert.equal(consumeRate(db, 'c', {...options, now: 2000}).allowed, true);
    assert.throws(() => consumeRate(db, 'x', {...options, windowMs: 0}));
  } finally {db.close();}
});

test('rate limit counts survive SQLite restart', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cityquest-rate-'));
  let db;
  try {
    const file = join(folder, 'db.sqlite');
    db = database(file); consumeRate(db, 'persistent', {limit: 1, windowMs: 10000, now: 100}); db.close();
    db = database(file);
    assert.equal(consumeRate(db, 'persistent', {limit: 1, windowMs: 10000, now: 101}).allowed, false);
  } finally {db?.close(); rmSync(folder, {recursive: true, force: true});}
});

function auditEvents(db) {
  appendAudit(db, {actor: 'admin', action: 'organization.approve', target: 'org-1', metadata: {city: 'astana'}, requestId: 'req-1', at: 1000}, KEY);
  appendAudit(db, {actor: 'admin', action: 'quest.publish', target: 'quest-1', at: 1001}, KEY);
  appendAudit(db, {actor: 'player', action: 'quest.complete', target: 'quest-1', at: 1002}, KEY);
}

test('audit authenticates all fields, key and chain plus external checkpoint', () => {
  const db = database();
  try {
    auditEvents(db);
    const valid = verifyAudit(db, KEY);
    assert.equal(valid.ok, true); assert.equal(valid.count, 3);
    assert.equal(verifyAudit(db, OTHER_KEY).ok, false);
    assert.equal(verifyAudit(db, KEY, {expectedHead: valid.head}).ok, true);
    assert.equal(verifyAudit(db, KEY, {expectedHead: {id: 2, hash: valid.head.hash}}).reason, 'external_checkpoint');
    for (const [column, replacement] of [['actor_id', 'attacker'], ['action', 'changed'], ['target', 'different'], ['created_at', 9], ['metadata', '{}'], ['request_id', 'changed']]) {
      db.exec('BEGIN');
      db.prepare(`UPDATE audit SET ${column}=? WHERE id=1`).run(replacement);
      assert.equal(verifyAudit(db, KEY).reason, 'event_hash', column);
      db.exec('ROLLBACK');
    }
  } finally {db.close();}
});

test('audit detects missing middle rows and truncated tail using persisted head', () => {
  const db = database();
  try {
    auditEvents(db);
    db.exec('BEGIN'); db.exec('DELETE FROM audit WHERE id=2');
    assert.equal(verifyAudit(db, KEY).reason, 'gap'); db.exec('ROLLBACK');
    db.exec('DELETE FROM audit WHERE id=3');
    assert.equal(verifyAudit(db, KEY).reason, 'checkpoint');
    assert.throws(() => appendAudit(db, {action: 'attempt-after-truncation'}, KEY), /checkpoint/);
    db.exec('DELETE FROM audit');
    assert.equal(verifyAudit(db, KEY).reason, 'checkpoint');
    assert.throws(() => sealLegacyAudit(db, KEY), /previously signed/);
  } finally {db.close();}
});

test('audit append and checkpoint are atomic inside caller transaction', () => {
  const db = database();
  try {
    appendAudit(db, {action: 'before'}, KEY);
    const initial = verifyAudit(db, KEY);
    db.exec('BEGIN IMMEDIATE');
    appendAudit(db, {action: 'rolled-back'}, KEY);
    assert.equal(verifyAudit(db, KEY).count, 2); assert.equal(db.isTransaction, true);
    db.exec('ROLLBACK');
    assert.deepEqual(verifyAudit(db, KEY), initial);
    assert.throws(() => appendAudit(db, {action: 'bad', metadata: {value: Infinity}}, KEY));
    assert.deepEqual(verifyAudit(db, KEY), initial);
  } finally {db.close();}
});

test('legacy sealing marks trust boundary, is idempotent, and rejects mixed histories', () => {
  const db = database();
  try {
    db.prepare('INSERT INTO audit(actor_id,action,target,created_at) VALUES(?,?,?,?)').run('old-admin', 'legacy.event', 'old', 10);
    assert.equal(sealLegacyAudit(db, KEY).migrated, 1);
    assert.deepEqual(JSON.parse(db.prepare('SELECT metadata FROM audit').get().metadata), {legacyUnsigned: true});
    assert.equal(verifyAudit(db, KEY).ok, true);
    assert.equal(sealLegacyAudit(db, KEY).migrated, 0);
    appendAudit(db, {action: 'modern.event'}, KEY);
    db.prepare('INSERT INTO audit(actor_id,action,target,created_at) VALUES(?,?,?,?)').run('old-admin', 'unexpected.unsigned', 'old', 11);
    assert.throws(() => sealLegacyAudit(db, KEY), /mixed/);
  } finally {db.close();}
});
