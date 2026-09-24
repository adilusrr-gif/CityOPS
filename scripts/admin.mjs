import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {openDb, transaction} from '../src/db.mjs';
import {id, normalizeEmail, text, passwordHash} from '../src/domain.mjs';
import {runtimeConfig} from '../src/runtime.mjs';
import {appendAudit, sealLegacyAudit, verifyAudit} from '../src/security.mjs';

// Reserved for a trusted operator with access to the database and server keys.
function argumentsFrom(argv) {
  let email, resetMfa = false;
  for (const argument of argv) {
    if (argument === '--reset-mfa') resetMfa = true;
    else if (argument.startsWith('--') || email !== undefined) throw new Error('Использование: npm run admin -- [email] [--reset-mfa]');
    else email = argument;
  }
  return {email, resetMfa};
}

function preflightAudit(path) {
  if (path === ':memory:' || !existsSync(path)) return;
  // openDb migrates and seeds data; verify signed history before those writes.
  const db = new DatabaseSync(path, {readOnly: true});
  db.aqPath = path;
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit'").get()) return;
    const columns = new Set(db.prepare('PRAGMA table_info(audit)').all().map(column => column.name));
    if (!columns.has('event_hash') || !columns.has('prev_hash')) return;
    const signed = db.prepare("SELECT 1 FROM audit WHERE COALESCE(event_hash,'')<>'' OR COALESCE(prev_hash,'')<>'' LIMIT 1").get();
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get();
    const checkpoint = hasMeta && db.prepare("SELECT 1 FROM meta WHERE key='audit_chain_head'").get();
    if (!signed && !checkpoint) return;
    const cfg = runtimeConfig(db);
    if (!verifyAudit(db, cfg.keys.auditKey).ok) throw new Error('Проверка журнала аудита не пройдена. Изменения учётной записи отменены.');
  } finally {db.close();}
}

function main() {
  if (process.argv.slice(2).includes('--help')) {
    console.log('Использование: npm run admin -- [email] [--reset-mfa]\nADMIN_EMAIL задаёт email по умолчанию; ADMIN_PASSWORD обязателен (не менее 12 символов).\nMFA сохраняется. --reset-mfa явно сбрасывает MFA и коды восстановления.');
    return;
  }
  if (process.env.DATABASE_URL) throw new Error('PostgreSQL mode: use npm run admin:enterprise instead of the SQLite operator.');
  const args = argumentsFrom(process.argv.slice(2));
  const email = normalizeEmail(args.email || process.env.ADMIN_EMAIL || '');
  const password = text(process.env.ADMIN_PASSWORD || '', 'ADMIN_PASSWORD', 128, 12);
  const path = process.env.DATABASE_PATH || './data/almaty.sqlite';
  preflightAudit(path);
  const db = openDb(path);
  let result;
  try {
    const cfg = runtimeConfig(db);
    const passwordDigest = passwordHash(password);
    result = transaction(db, () => {
      // Re-check under the write lock after the read-only preflight.
      sealLegacyAudit(db, cfg.keys.auditKey);
      const existing = db.prepare('SELECT id,role,mfa_enabled,disabled FROM users WHERE email=?').get(email);
      const userId = existing?.id || id();
      const now = Date.now();
      if (existing) db.prepare("UPDATE users SET role='admin',password=?,mfa_pending_secret=NULL,mfa_pending_at=NULL WHERE id=?").run(passwordDigest, userId);
      else db.prepare('INSERT INTO users(id,email,name,password,role,created_at) VALUES(?,?,?,?,?,?)').run(userId, email, 'Администратор', passwordDigest, 'admin', now);
      const sessionsRevoked = Number(db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId).changes);
      const challengesRevoked = Number(db.prepare('DELETE FROM login_challenges WHERE user_id=?').run(userId).changes);
      if (args.resetMfa) {
        db.prepare('UPDATE users SET mfa_enabled=0,mfa_secret=NULL,mfa_pending_secret=NULL,mfa_pending_at=NULL,mfa_last_counter=-1 WHERE id=?').run(userId);
        db.prepare('DELETE FROM recovery_codes WHERE user_id=?').run(userId);
      }
      const requestId = `cli-${id()}`;
      appendAudit(db, {
        actor: null, action: existing ? 'operator.admin_credentials_reset' : 'operator.admin_created', target: userId, requestId, at: now,
        metadata: {source: 'local_cli', roleBefore: existing?.role || null, roleAfter: 'admin', mfaReset: args.resetMfa, mfaPreserved: Boolean(existing?.mfa_enabled && !args.resetMfa), sessionsRevoked, challengesRevoked},
      }, cfg.keys.auditKey);
      if (args.resetMfa && existing) appendAudit(db, {actor: null, action: 'operator.mfa_reset', target: userId, requestId, at: now, metadata: {source: 'local_cli'}}, cfg.keys.auditKey);
      return {disabled: Boolean(existing?.disabled)};
    });
  } finally {db.close();}
  console.log('Администратор настроен. Все прежние сессии и подтверждения входа отозваны.');
  console.log(args.resetMfa ? 'MFA сброшена по явному флагу оператора. Настройте её заново при входе.' : 'Действующая MFA и коды восстановления сохранены.');
  if (result.disabled) console.log('Учётная запись остаётся отключённой; сброс пароля не снимает блокировку.');
  console.log('Удалите ADMIN_PASSWORD из окружения и .env после настройки.');
}

try {main();} catch (error) {
  console.error(`Настройка администратора не выполнена: ${error.message}`);
  process.exitCode = 1;
}
