#!/usr/bin/env node
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

// Development-only, new file, generated passwords never printed. No credentials in the archive.
const args = process.argv.slice(2);
if (args.length > 1 || (args[0] && args[0].startsWith('-'))) throw new Error('Usage: node deploy/local/init-env.mjs [new-env-path]');
const destination = resolve(args[0] || '.env.enterprise.local');
const value = size => randomBytes(size).toString('hex');
await writeFile(destination, [
  '# Local two-process demonstration only; no external exposure and no HA guarantee.',
  `POSTGRES_PASSWORD=${value(24)}`,
  `CQ_OWNER_PASSWORD=${value(24)}`,
  `CQ_APP_PASSWORD=${value(24)}`,
  `DATA_ENCRYPTION_KEY=${value(32)}`,
  `AUDIT_HMAC_KEY=${value(32)}`,
  'ADMIN_EMAIL=admin@example.test',
  `ADMIN_PASSWORD=${value(24)}`,
  '',
].join('\n'), {flag:'wx',mode:0o600});
console.log(`Created private local configuration: ${destination}`);
