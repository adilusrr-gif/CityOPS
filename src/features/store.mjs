import {fail} from '../domain.mjs';
import {sessionExpired} from '../security.mjs';

// A unit of work is a synchronous generator of SQL operations. SQLite executes
// it without yielding to the event loop; PostgreSQL awaits the same operations
// on its transaction connection. Never perform HTTP or other asynchronous work
// in one of these generators. SQL/audit failures always abort the whole unit;
// catching a yield must never conceal PostgreSQL's aborted transaction state.
const OP = Symbol('feature-store-operation');
const operation = (kind, sql, params = []) => Object.freeze({[OP]: true, kind, sql, params: [...params]});
export const get = (sql, params) => operation('get', sql, params);
export const all = (sql, params) => operation('all', sql, params);
export const run = (sql, params) => operation('run', sql, params);
export const audit = (actor, action, target, metadata = {}) => Object.freeze({[OP]: true, kind: 'audit', args: [actor, action, target, metadata]});

// Translate only SQL code, preserving quoted literals, identifiers and comments.
// Repeated/out-of-order $N references must duplicate/reorder SQLite parameters.
export function sqliteStatement(sql, params = []) {
 if (typeof sql !== 'string' || !Array.isArray(params)) throw new TypeError('SQL and parameter array are required');
 const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\$([A-Za-z_][A-Za-z_0-9]*|)\$[\s\S]*?\$\1\$|[^'"/$-]+|[/$-]/g) || [];
 const values = [];
 let code = '', output = '';
 const flush = () => {
  output += code.replace(/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE(?:\s+OF\s+[A-Za-z_][A-Za-z_0-9]*(?:\s*,\s*[A-Za-z_][A-Za-z_0-9]*)*)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?\b/gi, '').replace(/\$(\d+)/g, (_, index) => {
   const n = Number(index);
   if (!Number.isSafeInteger(n) || n < 1 || n > params.length) throw new RangeError('SQL parameter is missing');
   values.push(params[n - 1]);
   return '?';
  });
  code = '';
 };
 for (const token of tokens) {
  if (/^(?:['"]|--|\/\*|\$(?:[A-Za-z_][A-Za-z_0-9]*|)\$)/.test(token)) {flush(); output += token;}
  else code += token;
 }
 flush();
 return {sql: output, params: values};
}

export function* requireActor(user, roles, {cfg = {}, now, additionalIds = []} = {}) {
 if (!user?.id || !user.session_id) fail('Войдите в аккаунт', 401);
 // Match the authentication subsystem's lock order to avoid deadlocks with MFA,
 // account disabling and session revocation.
 let fresh;
 for (const uid of [...new Set([user.id, ...additionalIds])].sort()) {
  const row = yield get('SELECT * FROM users WHERE id=$1 FOR NO KEY UPDATE', [uid]);
  if (uid === user.id) fresh = row;
 }
 const session = yield get('SELECT id AS session_id,expires,last_seen,mfa_verified AS session_mfa_verified FROM sessions WHERE id=$1 AND user_id=$2 FOR UPDATE', [user.session_id, user.id]);
 if (!fresh || fresh.disabled || !session || sessionExpired(session, {now: now ?? Date.now(), idleMs: cfg.idleMs})) fail('Сессия истекла. Войдите заново.', 401);
 if (roles && !roles.includes(fresh.role)) fail('Недостаточно прав', 403);
 if (roles && fresh.role === 'admin' && cfg.requireAdminMfa && (!fresh.mfa_enabled || !session.session_mfa_verified)) fail('Настройте MFA в профиле перед административными действиями', 423);
 return {...fresh, ...session};
}

const thenable = value => value && typeof value.then === 'function';
function generator(work) {
 if (typeof work !== 'function') throw new TypeError('A synchronous generator function is required');
 const iterator = work();
 if (!iterator || typeof iterator.next !== 'function' || iterator[Symbol.asyncIterator]) throw new TypeError('A synchronous generator function is required');
 return iterator;
}
function checkOperation(op, transactional) {
 if (!op?.[OP] || !['get', 'all', 'run', 'audit'].includes(op.kind)) throw new TypeError('Unknown feature store operation');
 if (!transactional && ['run', 'audit'].includes(op.kind)) throw new TypeError('Mutations require a transaction');
}
function runSync(work, execute) {
 const iterator = generator(work);
 let step = iterator.next();
 while (!step.done) {
  const value = execute(step.value);
  if (thenable(value)) {value.catch?.(() => {}); throw new TypeError('An asynchronous operation cannot run in a SQLite transaction');}
  step = iterator.next(value);
 }
 if (thenable(step.value)) throw new TypeError('A feature unit of work cannot return a Promise');
 return step.value;
}
async function runAsync(work, execute) {
 const iterator = generator(work);
 let step = iterator.next();
 while (!step.done) {
  step = iterator.next(await execute(step.value));
 }
 if (thenable(step.value)) throw new TypeError('A feature unit of work cannot return a Promise');
 return step.value;
}

let nextSavepoint = 0;
export function createFeatureStore({db, cfg = {}, audit: appendAudit, dialect}) {
 if (!['sqlite', 'postgres'].includes(dialect)) throw new TypeError('Feature store dialect must be sqlite or postgres');
 function execute(connection, op, transactional) {
  checkOperation(op, transactional);
  if (op.kind === 'audit') {
   if (typeof appendAudit !== 'function') throw new TypeError('An audit writer is required');
   return appendAudit(connection, ...op.args);
  }
  if (dialect === 'postgres') return connection[op.kind](op.sql, op.params);
  const statement = sqliteStatement(op.sql, op.params), prepared = connection.prepare(statement.sql);
  if (op.kind === 'run') return {rowCount: Number(prepared.run(...statement.params).changes)};
  return prepared[op.kind](...statement.params);
 }
 return {
  dialect,
  requireActor(user, roles, additionalIds = []) {return requireActor(user, roles, {cfg, additionalIds});},
  read(work) {
   return dialect === 'sqlite' ? runSync(work, op => execute(db, op, false)) : runAsync(work, op => execute(db, op, false));
  },
  transaction(work) {
   if (dialect === 'postgres') return db.transaction(tx => runAsync(work, op => execute(tx, op, true)));
   const savepoint = db.isTransaction ? `feature_${++nextSavepoint}` : null;
   db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
   try {
    const result = runSync(work, op => execute(db, op, true));
    db.exec(savepoint ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
   } catch (error) {
    if (savepoint) db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
    else db.exec('ROLLBACK');
    throw error;
   }
  },
 };
}
