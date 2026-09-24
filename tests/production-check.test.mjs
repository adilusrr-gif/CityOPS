import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {openDb} from '../src/db.mjs';
import {encryptSecret,generateTotpSecret} from '../src/security.mjs';
import {checkProductionConfig, checkRenderedManifest, inspectDatabase, runCheck} from '../scripts/production-check.mjs';
function env(overrides = {}) {return {NODE_ENV: 'production', COOKIE_SECURE: 'true', PUBLIC_ORIGIN: 'https://quest.valid-company.kz', SUPPORT_EMAIL: 'support@valid-company.kz', PRIVACY_URL: 'https://quest.valid-company.kz/privacy', TERMS_URL: 'https://quest.valid-company.kz/terms', DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), AUDIT_HMAC_KEY: randomBytes(32).toString('hex'), BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('hex'), ...overrides};}
const codes = report => report.errors.map(error => error.code);

test('production check accepts configured offline mode without claiming launch certification', () => {
 const report = checkProductionConfig(env());
 assert.equal(report.ok, true); assert.equal(report.productionReady, false);
 assert.equal(report.scope, 'configuration-only');
 assert.ok(report.warnings.some(item => item.code === 'ai_offline'));
 assert.ok(report.warnings.some(item => item.code === 'single_node'));
});

test('production check rejects reserved origins, repeated/shared keys and active bootstrap credentials', () => {
 for (const origin of ['https://quest.example.com', 'https://cityquest.example', 'https://localhost', 'https://quest.valid-company.kz/', 'https://secret@quest.valid-company.kz']) assert.ok(codes(checkProductionConfig(env({PUBLIC_ORIGIN: origin}))).includes('public_origin'));
 const report = checkProductionConfig(env({DATA_ENCRYPTION_KEY: 'ab'.repeat(32), AUDIT_HMAC_KEY: 'ab'.repeat(32), ADMIN_PASSWORD: 'never-print-this'}));
 assert.ok(codes(report).includes('security_key')); assert.ok(codes(report).includes('independent_keys')); assert.ok(codes(report).includes('bootstrap_credentials'));
 assert.ok(!JSON.stringify(report).includes('never-print-this'));
});

test('production check rejects incomplete enabled integrations and missing product contacts', () => {
 for (const [fields, code] of [
  [{OPENAI_API_KEY: 'secret-provider-key'}, 'ai_incomplete'],
  [{OIDC_ISSUER: 'https://idp.valid-company.kz'}, 'oidc_incomplete'],
  [{SUPPORT_EMAIL: ''}, 'support_email'], [{PRIVACY_URL: 'https://example.com/privacy'}, 'legal_url'],
  [{BILLING_MANUAL_ENABLED: 'true'}, 'billing_contact'],
  [{PHOTO_STORAGE_LIMIT_MB: '1e3'}, 'product_policy'],
  [{DATABASE_URL: 'postgresql://user:secret@db.internal/cityquest', PGSSLMODE: 'disable'}, 'postgres_config'],
 ]) assert.ok(codes(checkProductionConfig(env(fields))).includes(code), code);
 assert.equal(checkProductionConfig(env({BILLING_MANUAL_ENABLED: 'true', BILLING_CONTACT_EMAIL: 'billing@valid-company.kz'})).ok, true);
});

test('rendered manifest gate rejects sample targets and mutable tags without exposing content', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'cq-preflight-')); t.after(() => rm(dir, {recursive: true, force: true}));
 const file = join(dir, 'rendered.yaml');
 await writeFile(file, 'PUBLIC_ORIGIN: https://quest.example.com\nimage: ghcr.io/YOUR_ORGANIZATION/cityquest:0.6.0\nsecret: do-not-print\n');
 let result = await checkRenderedManifest(file);
 assert.deepEqual(result.errors.map(item => item.code), ['manifest_placeholder', 'manifest_image_digest']); assert.ok(!JSON.stringify(result).includes('do-not-print'));
 await writeFile(file, `image: registry.valid-company.kz/cityquest@sha256:${'a'.repeat(64)}\nimageName: 'registry.valid-company.kz/postgres@sha256:${'b'.repeat(64)}'\n`);
 result = await checkRenderedManifest(file); assert.equal(result.images, 2); assert.deepEqual(result.errors, []);
});

test('read-only database inspection preserves schema and contents and rejects missing files', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'cq-preflight-db-')); t.after(() => rm(dir, {recursive: true, force: true}));
 const path = join(dir, 'existing.sqlite'), cfg = env({DATABASE_PATH: path});
 const db = openDb(path, {withSnapshot: false});
 db.prepare("INSERT INTO users(id,email,name,password,role,created_at,mfa_enabled) VALUES(?,?,?,?,?,?,?)").run('admin1', 'admin@valid-company.kz', 'Administrator', 'hash', 'admin', Date.now(), 1);
 db.prepare('UPDATE users SET mfa_secret=? WHERE id=?').run(encryptSecret(generateTotpSecret(),cfg.DATA_ENCRYPTION_KEY),'admin1');
 db.close();
 const before = await readFile(path), report = await runCheck({env: cfg, database: true});
 assert.equal(report.ok, true, JSON.stringify(report.errors)); assert.equal(report.database.mfaAdministrators, 1); assert.ok(report.database.editorialQuests > 0);
 assert.deepEqual(await readFile(path), before);
 const missing = join(dir, 'missing.sqlite'); await assert.rejects(inspectDatabase({...cfg, DATABASE_PATH: missing})); await assert.rejects(stat(missing), {code: 'ENOENT'});
});

test('read-only database gate detects unconfigured administration, reserved accounts and ledger drift', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'cq-preflight-ledger-')); t.after(() => rm(dir, {recursive: true, force: true}));
 const path = join(dir, 'existing.sqlite'); const db = openDb(path, {withSnapshot: false});
 db.prepare("INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,?,?,?)").run('demo', 'demo@example.com', 'Demo', 'hash', 'player', Date.now());
 db.prepare('INSERT INTO photo_storage(id,used_bytes) VALUES(1,1) ON CONFLICT(id) DO UPDATE SET used_bytes=1').run(); db.close();
 const report = await runCheck({env: env({DATABASE_PATH: path}), database: true});
 assert.ok(codes(report).includes('administrator_mfa')); assert.ok(codes(report).includes('example_accounts')); assert.ok(codes(report).includes('photo_ledger'));
 assert.ok(!JSON.stringify(report).includes('demo@example.com'));
});

test('CLI fails closed with bounded static errors and never prints malformed URLs or secrets', () => {
 const secret = 'sensitive-credential-marker';
 const result = spawnSync(process.execPath, ['scripts/production-check.mjs', '--database'], {cwd: new URL('..', import.meta.url), env: {...process.env, ...env({DATABASE_URL: `postgresql://user:${secret}@[invalid`, ADMIN_PASSWORD: secret})}, encoding: 'utf8'});
 assert.equal(result.status, 1); assert.ok(!result.stdout.includes(secret)); assert.ok(!result.stderr.includes(secret));
 const report = JSON.parse(result.stdout); assert.ok(report.warnings.some(item => item.code === 'database_skipped'));
});
