import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync, rmSync, readFileSync, statSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {openDb} from '../src/db.mjs';
import {runtimeConfig} from '../src/runtime.mjs';
import {hash, passwordHash, passwordOK} from '../src/domain.mjs';
import {appendAudit, encryptSecret, generateTotpSecret, generateRecoveryCodes, hashRecoveryCode, sealLegacyAudit, verifyAudit} from '../src/security.mjs';

const CLI = fileURLToPath(new URL('../scripts/admin.mjs', import.meta.url));
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OLD_PASSWORD = 'cli-old-password-2026-safe';
const NEW_PASSWORD = 'cli-new-password-2026-safe';
function environment(folder) {
  return {...process.env, NODE_ENV: 'development', DATABASE_PATH: join(folder, 'db.sqlite'), SECURITY_KEYS_PATH: join(folder, 'security-keys.json'), DATA_ENCRYPTION_KEY: '', AUDIT_HMAC_KEY: '', ADMIN_EMAIL: 'operator@example.test', ADMIN_PASSWORD: NEW_PASSWORD};
}
function run(env, args = []) {return spawnSync(process.execPath, [CLI, ...args], {cwd: ROOT, env, encoding: 'utf8', timeout: 30000});}
function seededFixture(folder) {
  const env = environment(folder), db = openDb(env.DATABASE_PATH, {withSnapshot: false}), cfg = runtimeConfig(db, {env});
  for (const key of ['bundled_osm_v1', 'bundled_osm_astana_v1']) db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES(?,?)').run(key, 'test-skip-snapshot');
  const secret = generateTotpSecret(), code = generateRecoveryCodes(1)[0], now = Date.now();
  db.prepare('INSERT INTO users(id,email,name,password,role,mfa_enabled,mfa_secret,mfa_pending_secret,mfa_pending_at,mfa_last_counter,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('operator-test', env.ADMIN_EMAIL, 'Operator', passwordHash(OLD_PASSWORD), 'business', 1, encryptSecret(secret, cfg.keys.encryptionKey), encryptSecret(generateTotpSecret(), cfg.keys.encryptionKey), now, 88, now);
  db.prepare('INSERT INTO recovery_codes(user_id,code_hash) VALUES(?,?)').run('operator-test', hashRecoveryCode(code));
  db.prepare('INSERT INTO sessions(token,id,user_id,expires,created_at,last_seen,mfa_verified) VALUES(?,?,?,?,?,?,?)').run(hash(randomBytes(32).toString('hex')), 'session-test', 'operator-test', now + 100000, now, now, 1);
  db.prepare('INSERT INTO login_challenges(id_hash,user_id,expires) VALUES(?,?,?)').run(hash('fixture-challenge'), 'operator-test', now + 100000);
  sealLegacyAudit(db, cfg.keys.auditKey);
  appendAudit(db, {actor: 'operator-test', action: 'fixture.seeded', target: 'operator-test'}, cfg.keys.auditKey);
  const previous = {...db.prepare('SELECT * FROM users WHERE id=?').get('operator-test')};
  db.close();
  return {env, cfg, secret, code, previous};
}

test('admin CLI preserves MFA, resets credentials, and revokes every session/challenge', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cq-cli-preserve-'));
  let db;
  try {
    const f = seededFixture(folder), result = run(f.env);
    assert.equal(result.status, 0, result.stderr);
    db = new DatabaseSync(f.env.DATABASE_PATH);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get('operator-test');
    assert.equal(user.role, 'admin'); assert.equal(passwordOK(NEW_PASSWORD, user.password), true);
    assert.equal(user.mfa_enabled, 1); assert.equal(user.mfa_secret, f.previous.mfa_secret); assert.equal(user.mfa_last_counter, 88);
    assert.equal(user.mfa_pending_secret, null); assert.equal(user.mfa_pending_at, null);
    assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM login_challenges').get().n, 0);
    assert.equal(db.prepare('SELECT code_hash FROM recovery_codes').get().code_hash, hashRecoveryCode(f.code));
    assert.equal(verifyAudit(db, f.cfg.keys.auditKey).ok, true);
    const event = db.prepare("SELECT * FROM audit WHERE action='operator.admin_credentials_reset'").get();
    assert.equal(JSON.parse(event.metadata).mfaPreserved, true);
    for (const secret of [NEW_PASSWORD, OLD_PASSWORD, f.secret, f.code]) assert.equal((result.stdout + result.stderr + event.metadata).includes(secret), false);
    if (process.platform !== 'win32') assert.equal(statSync(f.env.SECURITY_KEYS_PATH).mode & 0o777, 0o600);
  } finally {db?.close(); rmSync(folder, {recursive: true, force: true});}
});

test('only explicit --reset-mfa removes MFA and recovery codes and records an operator event', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cq-cli-reset-'));
  let db;
  try {
    const f = seededFixture(folder), result = run(f.env, ['--reset-mfa']);
    assert.equal(result.status, 0, result.stderr);
    db = new DatabaseSync(f.env.DATABASE_PATH);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get('operator-test');
    assert.equal(user.mfa_enabled, 0); assert.equal(user.mfa_secret, null); assert.equal(user.mfa_pending_secret, null); assert.equal(user.mfa_last_counter, -1);
    assert.equal(db.prepare('SELECT count(*) n FROM recovery_codes').get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='operator.mfa_reset'").get().n, 1);
    assert.equal(verifyAudit(db, f.cfg.keys.auditKey).ok, true);
  } finally {db?.close(); rmSync(folder, {recursive: true, force: true});}
});

test('tampered audit stops the CLI before any database or credential change', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cq-cli-tamper-'));
  let db;
  try {
    const f = seededFixture(folder);
    db = new DatabaseSync(f.env.DATABASE_PATH); db.exec("UPDATE audit SET target='tampered' WHERE id=1"); db.close(); db = null;
    const before = readFileSync(f.env.DATABASE_PATH);
    const result = run(f.env, ['--reset-mfa']);
    assert.equal(result.status, 1); assert.match(result.stderr, /аудита/);
    assert.deepEqual(readFileSync(f.env.DATABASE_PATH), before);
    db = new DatabaseSync(f.env.DATABASE_PATH);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get('operator-test');
    assert.equal(user.role, 'business'); assert.equal(user.password, f.previous.password); assert.equal(user.mfa_secret, f.previous.mfa_secret);
    assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) n FROM login_challenges').get().n, 1);
  } finally {db?.close(); rmSync(folder, {recursive: true, force: true});}
});

test('CLI can bootstrap the first admin and rejects invalid passwords without creating a database', () => {
  const folder = mkdtempSync(join(tmpdir(), 'cq-cli-first-'));
  let db;
  try {
    const env = environment(folder);
    const bad = run({...env, ADMIN_PASSWORD: 'short'});
    assert.equal(bad.status, 1); assert.equal(existsSync(env.DATABASE_PATH), false);
    const good = run(env, ['first@example.test']);
    assert.equal(good.status, 0, good.stderr);
    db = new DatabaseSync(env.DATABASE_PATH);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get('first@example.test');
    assert.equal(user.role, 'admin'); assert.equal(user.mfa_enabled, 0); assert.equal(passwordOK(NEW_PASSWORD, user.password), true);
    assert.ok(db.prepare("SELECT count(*) n FROM quests WHERE city_id='astana'").get().n > 0);
    const keys = JSON.parse(readFileSync(env.SECURITY_KEYS_PATH, 'utf8'));
    assert.equal(verifyAudit(db, keys.AUDIT_HMAC_KEY).ok, true);
  } finally {db?.close(); rmSync(folder, {recursive: true, force: true});}
});
