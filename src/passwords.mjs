import {randomBytes, scrypt, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {fail, text} from './domain.mjs';

const derive = promisify(scrypt);
const MAX_PASSWORD_BYTES = 512;
// These are the Node scrypt defaults used by existing salt:hex records.
const KDF_OPTIONS = Object.freeze({N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024});
// Missing, disabled and malformed credentials still perform one full KDF.
// Random comparison bytes require no synchronous KDF during module loading.
const dummySalt = randomBytes(16).toString('hex');
const dummyKey = randomBytes(64);

export function passwordText(value, min = 1) {
  // Preserve existing whitespace normalization so existing accounts can log in.
  const password = text(value, 'Пароль', 128, min);
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) fail(`Пароль: не более ${MAX_PASSWORD_BYTES} байт`);
  return password;
}

export function createPasswordService({concurrency = 2} = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Password KDF concurrency must be an integer from 1 to 8');
  let active = 0;
  async function key(password, salt) {
    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) fail(`Пароль: не более ${MAX_PASSWORD_BYTES} байт`);
    // There is deliberately no waiting queue. Each admitted request reserves
    // at most one ~16 MiB scrypt operation, outside any database transaction.
    if (active >= concurrency) throw Object.assign(new Error('Сервис входа занят. Повторите попытку через несколько секунд.'), {status: 503, retryAfter: 1});
    active++;
    try { return await derive(password, salt, 64, KDF_OPTIONS); }
    finally { active--; }
  }
  return Object.freeze({
    async hash(password) {
      const salt = randomBytes(16).toString('hex');
      return `${salt}:${(await key(password, salt)).toString('hex')}`;
    },
    async verify(password, stored) {
      const record = typeof stored === 'string' && /^([a-f0-9]{32}):([a-f0-9]{128})$/.exec(stored);
      const actual = await key(password, record ? record[1] : dummySalt);
      const matches = timingSafeEqual(actual, record ? Buffer.from(record[2], 'hex') : dummyKey);
      return !!record && matches;
    },
  });
}

// Shared across auth factories in the same process unless the server injects
// one configured service. Never allocate a new service for each request.
export const passwordService = createPasswordService();
