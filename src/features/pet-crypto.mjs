import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

// Separate envelope and authenticated context from MFA secrets. A ciphertext
// copied to a different account/message cannot be authenticated there.
export function encryptPetText(value, key, context) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192) throw new TypeError('Invalid pet text');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`cityquest:pet:v1:${context}`));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['p1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decryptPetText(value, key, context) {
  try {
    if (typeof value !== 'string' || value.length > 12000) throw new Error();
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== 'p1' || parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const [iv, tag, data] = parts.slice(1).map(part => Buffer.from(part, 'base64url'));
    if (iv.length !== 12 || tag.length !== 16 || !data.length || [iv, tag, data].some((part, index) => part.toString('base64url') !== parts[index + 1])) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`cityquest:pet:v1:${context}`)); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8');
  } catch {throw new Error('Encrypted pet text could not be authenticated');}
}
