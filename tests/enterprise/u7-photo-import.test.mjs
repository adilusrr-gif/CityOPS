import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import sharp from 'sharp';
import {createTestDatabase} from './db-fixture.mjs';
import {openDb} from '../../src/db.mjs';
import {importSqlitePostgres} from '../../scripts/import-sqlite-postgres.mjs';

test('PostgreSQL import rejects hidden JPEG metadata before any target data is copied', async t => {
  const fixture = await createTestDatabase(); t.after(() => fixture.close());
  t.diagnostic(`SQL engine: ${fixture.engine}`);
  const directory = mkdtempSync(join(tmpdir(), 'cq-photo-privacy-')), path = join(directory, 'source.sqlite');
  const source = openDb(path, {withSnapshot: false});
  t.after(() => {source.close(); rmSync(directory, {recursive: true, force: true});});
  source.prepare("INSERT INTO users(id,email,name,password,role,created_at) VALUES('author','author@example.test','Автор','unused','player',1)").run();
  const jpeg = await sharp({create: {width: 24, height: 16, channels: 3, background: '#123456'}}).jpeg().toBuffer();
  source.prepare("INSERT INTO photos(id,user_id,city_id,title,cell,approx_lng,approx_lat,status,image_base64,image_bytes,image_sha256,width,height,created_at,updated_at) VALUES('photo','author','almaty','Место','38473:28832',76.947,43.249,'approved',?,0,'',24,16,1,1)").run('');
  source.prepare('INSERT INTO photo_storage(id,used_bytes) VALUES(1,0)').run();
  const secret = Buffer.from('GPSLatitude=43.123456 GPSLongitude=76.123456'), header = Buffer.from([0xff, 0xfe, 0, 0]);
  header.writeUInt16BE(secret.length + 2, 2);
  const embedded = Buffer.concat([jpeg.subarray(0, 2), header, secret, jpeg.subarray(2)]), trailer = Buffer.concat([jpeg, secret, Buffer.from([0xff, 0xd9])]);
  const keys = {auditKey: randomBytes(32), encryptionKey: randomBytes(32)};
  const replace = bytes => {
    source.prepare('UPDATE photos SET image_base64=?,image_bytes=?,image_sha256=?').run(bytes.toString('base64'), bytes.length, createHash('sha256').update(bytes).digest('hex'));
    source.prepare('UPDATE photo_storage SET used_bytes=?').run(bytes.length);
  };
  for (const bytes of [embedded, trailer]) {
    replace(bytes);
    await assert.rejects(importSqlitePostgres({db: fixture.db, sqlitePath: path, ...keys}), /canonical bounded JPEG/);
    for (const table of ['users', 'photos', 'photo_storage', 'meta']) assert.equal((await fixture.db.get(`SELECT count(*) AS n FROM ${table}`)).n, 0);
  }
  replace(jpeg);
  assert.equal((await importSqlitePostgres({db: fixture.db, sqlitePath: path, ...keys})).imported, true);
  assert.equal((await fixture.db.get('SELECT image_bytes FROM photos')).image_bytes, jpeg.length);
});
