import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {envInteger} from '../src/http-policy.mjs';
import {runtimeConfig} from '../src/runtime.mjs';
import {enterpriseConfig} from '../src/enterprise/config.mjs';
import {postgresConnectionOptions, openPostgres, PG_SCHEMA_VERSION} from '../src/enterprise/db.mjs';
import {SCHEMA_VERSION} from '../src/migrations.mjs';
import {loadProductPolicy} from '../src/product-policy.mjs';
import {billingConfig} from '../src/features/billing.mjs';
import {petProviderConfig} from '../src/features/pet-provider.mjs';
import {VERSION} from '../src/version.mjs';
import {inspectEncryption} from '../src/key-check.mjs';

const SAMPLE_HOST = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;
const SAMPLE_TEXT = /(?:YOUR[_-][A-Z0-9_-]+|\bREPLACE[_-]ME\b|\bCHANGE[_-]?ME\b|https?:\/\/[^\s/'"<>]*(?:\.example(?:[./:'"\s]|$)|example\.(?:com|net|org)(?:[/:\s'"]|$)))/i;
function realHttps(value, origin = false) {
 try {const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !SAMPLE_HOST.test(url.hostname) && url.hostname.includes('.') && (!origin || url.origin === value);}
 catch {return false;}
}
function realEmail(value) {return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !SAMPLE_HOST.test(value.split('@')[1]);}
function add(report, level, code, message) {report[level].push({code, message});}
function validate(report, code, message, operation) {try {operation();} catch {add(report, 'errors', code, message);}}
function finish(report) {report.ok = report.errors.length === 0; return report;}

// A read-only preflight is evidence about its explicit scope. It cannot certify
// infrastructure, restore drills, identity providers, stores, billing or safety.
export function checkProductionConfig(env = process.env) {
 const report = {version: VERSION, scope: 'configuration-only', ok: false, productionReady: false, errors: [], warnings: [], checks: {databaseMode: env.DATABASE_URL ? 'postgresql' : 'sqlite'}};
 if (env.NODE_ENV !== 'production') add(report, 'errors', 'production_mode', 'Set NODE_ENV=production for the release configuration.');
 if (!realHttps(env.PUBLIC_ORIGIN, true)) add(report, 'errors', 'public_origin', 'PUBLIC_ORIGIN must be a real canonical HTTPS origin; examples, localhost, paths and credentials are rejected.');
 if (env.COOKIE_SECURE !== 'true') add(report, 'errors', 'secure_cookie', 'COOKIE_SECURE must be true.');
 if (env.ADMIN_PASSWORD) add(report, 'errors', 'bootstrap_credentials', 'Remove ADMIN_PASSWORD from the running application after the explicit bootstrap job.');
 const keyNames = ['DATA_ENCRYPTION_KEY', 'AUDIT_HMAC_KEY', ...(env.DATABASE_URL ? [] : ['BACKUP_ENCRYPTION_KEY'])];
 const keys = keyNames.map(name => String(env[name] || '').toLowerCase());
 keyNames.forEach((name, index) => {if (!/^[a-f0-9]{64}$/.test(keys[index]) || new Set(keys[index]).size < 8) add(report, 'errors', 'security_key', `${name} must be an independent random 32-byte key, not an empty or repeated placeholder.`);});
 if (keys.filter(Boolean).length !== new Set(keys.filter(Boolean)).size) add(report, 'errors', 'independent_keys', 'Security and backup keys must be independent.');
 // Runtime validators remain authoritative. Errors are deliberately not echoed:
 // URL/parser/database exceptions can contain credentials or private endpoints.
 if (env.NODE_ENV === 'production') validate(report, 'runtime_config', 'Runtime configuration validation failed; check TLS cookies, keys, session and proxy settings.', () => env.DATABASE_URL ? enterpriseConfig({env}) : runtimeConfig({aqPath: ':memory:'}, {env}));
 if (env.DATABASE_URL) {
  validate(report, 'postgres_config', 'PostgreSQL configuration validation failed; verify database URL, pool limits and the readable trusted CA.', () => {postgresConnectionOptions({env}); envInteger(env, 'PG_POOL_QUEUE_LIMIT', 20, 0, 200);});
  try {const url = new URL(env.DATABASE_URL); if (SAMPLE_HOST.test(url.hostname) || /(?:YOUR[_-]|CHANGE[_-]?ME|REPLACE[_-]?ME)/i.test(decodeURIComponent(url.username + url.password))) add(report, 'errors', 'database_placeholder', 'Replace sample database hosts and credentials.');} catch {}
  if (!env.METRICS_TOKEN || env.METRICS_TOKEN.length < 32 || /(?:CHANGE.?ME|YOUR_|REPLACE)/i.test(env.METRICS_TOKEN)) add(report, 'errors', 'metrics_token', 'Configure a random METRICS_TOKEN of at least 32 characters for private monitoring.');
 } else add(report, 'warnings', 'single_node', 'SQLite is a single-process, single-host deployment; it provides no database HA.');
 validate(report, 'product_policy', 'Product policy settings are outside the supported ranges.', () => loadProductPolicy(env));
 validate(report, 'billing_config', 'Billing settings are invalid.', () => billingConfig(env));
 validate(report, 'pet_config', 'Pet provider settings are invalid.', () => petProviderConfig(env));
 if (!realHttps(env.MAP_STYLE || 'https://tiles.openfreemap.org/styles/dark')) add(report, 'errors', 'map_style', 'MAP_STYLE must be a real HTTPS URL with no credentials or fragment.');
 for (const field of ['OPENAI_API_KEY', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET']) if (env[field] && /(?:YOUR[_-]|REPLACE[_-]?ME|CHANGE[_-]?ME|^example$)/i.test(env[field])) add(report, 'errors', 'integration_placeholder', `${field} still contains a placeholder.`);
 const oidc = ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET'].filter(name => Boolean(env[name]));
 if (oidc.length && oidc.length !== 3) add(report, 'errors', 'oidc_incomplete', 'OIDC requires issuer, client ID and client secret together.');
 if (oidc.length && !realHttps(env.OIDC_ISSUER)) add(report, 'errors', 'oidc_issuer', 'OIDC_ISSUER must be a real HTTPS issuer URL.');
 if (Boolean(env.OPENAI_API_KEY?.trim()) !== Boolean(env.OPENAI_PET_MODEL?.trim())) add(report, 'errors', 'ai_incomplete', 'Configure both OPENAI_API_KEY and OPENAI_PET_MODEL, or leave both empty for the labelled offline companion.');
 if (!env.OPENAI_API_KEY?.trim()) add(report, 'warnings', 'ai_offline', 'The companion uses labelled prepared exercises; generative AI is disabled.');
 if (env.BILLING_MANUAL_ENABLED === 'true' && !realEmail(env.BILLING_CONTACT_EMAIL)) add(report, 'errors', 'billing_contact', 'Manual billing requires a real BILLING_CONTACT_EMAIL.');
 if (env.BILLING_MANUAL_ENABLED === 'true') add(report, 'warnings', 'manual_billing', 'Manual invoices require an operator, published terms and an external payment/refund process; this gate does not validate those procedures.');
 if (!realEmail(env.SUPPORT_EMAIL)) add(report, 'errors', 'support_email', 'SUPPORT_EMAIL must be a real operator email address.');
 for (const field of ['PRIVACY_URL', 'TERMS_URL']) if (!realHttps(env[field])) add(report, 'errors', 'legal_url', `${field} must be a real HTTPS URL.`);
 add(report, 'warnings', 'external_acceptance', 'Release still requires target-host TLS/DNS, restore and failover drills, native-device QA, operator review of content and published support/privacy/terms. No external services were called.');
 return finish(report);
}

export async function checkRenderedManifest(file) {
 const handle = await open(file, 'r');
 let content;
 try {
  const info = await handle.stat();
  if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error('Manifest must be a regular file no larger than 8 MiB.');
  // Read at most the observed size plus one sentinel byte. Concurrent file growth
  // cannot turn a local preflight into an unbounded allocation.
  const buffer = Buffer.alloc(info.size + 1); let offset = 0;
  while (offset < buffer.length) {const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset); if (!bytesRead) break; offset += bytesRead;}
  if (offset > info.size) throw new Error('Manifest changed during validation.');
  content = buffer.toString('utf8', 0, offset);
 } finally {await handle.close();}
 const errors = [];
 if (SAMPLE_TEXT.test(content) || /\b(?:quest|cityquest)\.example\b/i.test(content)) errors.push({code: 'manifest_placeholder', message: 'Rendered manifest contains a sample domain, registry, bucket or replacement marker.'});
 const images = [...content.matchAll(/^\s*(?:-\s*)?image(?:Name)?:\s*['"]?([^\s'"#]+).*$/gm)].map(match => match[1]);
 if (images.some(value => !/@sha256:[a-f0-9]{64}$/i.test(value))) errors.push({code: 'manifest_image_digest', message: 'Every rendered container/database image must use an immutable sha256 digest.'});
 return {images: images.length, errors};
}

async function inspectRows(db, dialect, env) {
 const get = dialect === 'sqlite' ? (sql, args = []) => db.prepare(sql).get(...args) : (sql, args = []) => db.get(sql, args);
 const schema = dialect === 'sqlite' ? (await get('PRAGMA user_version')).user_version : Number((await get('SELECT MAX(version) AS version FROM schema_migrations')).version);
 const expected = dialect === 'sqlite' ? SCHEMA_VERSION : PG_SCHEMA_VERSION;
 const result = {schema, expectedSchema: expected};
 if (schema !== expected) return result;
 const users = await get("SELECT SUM(CASE WHEN role='admin' AND disabled=0 THEN 1 ELSE 0 END) AS admins,SUM(CASE WHEN role='admin' AND disabled=0 AND mfa_enabled=1 THEN 1 ELSE 0 END) AS mfa_admins,SUM(CASE WHEN disabled=0 AND (lower(email) LIKE '%@example.com' OR lower(email) LIKE '%@example.org' OR lower(email) LIKE '%@example.net' OR lower(email) LIKE '%.example.com' OR lower(email) LIKE '%.example.org' OR lower(email) LIKE '%.example.net' OR lower(email) LIKE '%@localhost' OR lower(email) LIKE '%.localhost' OR lower(email) LIKE '%.example' OR lower(email) LIKE '%.test' OR lower(email) LIKE '%.invalid') THEN 1 ELSE 0 END) AS example_accounts FROM users");
 const media = await get('SELECT COALESCE(SUM(image_bytes),0) AS bytes,COUNT(*) AS photos FROM photos');
 const ledger = await get('SELECT used_bytes FROM photo_storage WHERE id=1');
 const content = await get("SELECT COUNT(*) AS editorial_quests FROM quests WHERE id LIKE 'quest-%'");
 const encryption=await inspectEncryption(db,dialect,env.DATA_ENCRYPTION_KEY);
 return {...result, encryption, administrators: Number(users.admins || 0), mfaAdministrators: Number(users.mfa_admins || 0), exampleAccounts: Number(users.example_accounts || 0), photos: Number(media.photos), photoBytes: Number(media.bytes), photoLedgerBytes: Number(ledger?.used_bytes || 0), editorialQuests: Number(content.editorial_quests)};
}

export async function inspectDatabase(env = process.env) {
 if (env.DATABASE_URL) {
  const db = await openPostgres({env, max: 1, statement_timeout: 5000, lock_timeout: 2000});
  try {return await db.transaction(async tx => {await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'); return inspectRows(tx, 'postgres',env);});}
  finally {await db.close();}
 }
 const {DatabaseSync} = await import('node:sqlite');
 // Never call openDb: it initializes, migrates and seeds. Missing files fail.
 const db = new DatabaseSync(resolve(env.DATABASE_PATH || './data/almaty.sqlite'), {readOnly: true});
 try {db.exec('PRAGMA busy_timeout=2000; BEGIN'); return await inspectRows(db, 'sqlite',env);}
 finally {db.close();}
}

export async function runCheck({env = process.env, database = false, manifests = []} = {}) {
 const report = checkProductionConfig(env);
 if (manifests.length) {
  report.manifests = [];
  for (let index = 0; index < manifests.length; index++) {
   try {const result = await checkRenderedManifest(manifests[index]); report.manifests.push({index, images: result.images}); report.errors.push(...result.errors.map(error => ({...error, manifestIndex: index})));}
   catch {add(report, 'errors', 'manifest_unreadable', `Manifest ${index} is missing, unreadable or over its size limit.`);}
  }
 }
 if (database) {
  report.scope = 'configuration-and-read-only-database';
  // Invalid production settings must not trigger a connection to a typoed URL.
  if (report.errors.length) add(report, 'warnings', 'database_skipped', 'Database inspection skipped because configuration or manifests failed.');
  else try {
   report.database = await inspectDatabase(env);
   const value = report.database;
   if (value.schema !== value.expectedSchema) add(report, 'errors', 'database_schema', 'Database schema differs from the application; run the separate migration procedure.');
   else {
    if (!value.administrators || !value.mfaAdministrators) add(report, 'errors', 'administrator_mfa', 'At least one active administrator with configured MFA is required.');
    if (value.encryption.invalid) add(report, 'errors', 'database_encryption', 'Stored MFA or companion ciphertext cannot be authenticated with DATA_ENCRYPTION_KEY, or an enabled MFA account has no valid secret. Restore the original key or repair affected records before launch.');
    if (value.exampleAccounts) add(report, 'errors', 'example_accounts', 'Active accounts with reserved example/test email domains remain in the database.');
    if (value.photoBytes !== value.photoLedgerBytes) add(report, 'errors', 'photo_ledger', 'Photograph storage ledger differs from stored byte totals.');
    if (value.photoBytes > loadProductPolicy(env).photoStorageBytes) add(report, 'errors', 'photo_capacity', 'Stored photographs exceed the configured storage quota.');
    if (value.editorialQuests) add(report, 'warnings', 'editorial_content', 'Bundled editorial quests remain; review access and coordinates before public launch. They are not evidence of business partnerships.');
   }
  } catch {add(report, 'errors', 'database_inspection', 'Read-only database inspection failed. Check access, TLS, schema and connectivity; no credentials were logged.');}
 }
 return finish(report);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
 const {values} = parseArgs({args: argv, options: {database: {type: 'boolean'}, manifest: {type: 'string', multiple: true}, help: {type: 'boolean'}}});
 if (values.help) {console.log('Usage: node --env-file=/secure/.env.production scripts/production-check.mjs [--database] [--manifest rendered.yaml ...]\nDefault: read-only local configuration checks. --database inspects an existing DB without migration, seed, writes or external provider calls. --manifest rejects known placeholders and mutable image references. JSON never includes env values or database credentials. Exit 0 means this gate passed, not production certification.'); return;}
 const report = await runCheck({env, database: values.database, manifests: values.manifest || []});
 console.log(JSON.stringify(report, null, 2));
 if (!report.ok) process.exitCode = 1;
 return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {console.error('Production check failed: invalid arguments or unreadable input; no configuration values were logged.'); process.exitCode = 1;});
