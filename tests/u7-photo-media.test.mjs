import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {normalizePhoto, inspectStoredPhoto, photoBase64, PHOTO_INPUT_BYTES} from '../src/features/photo-media.mjs';

function stored(bytes, width = 24, height = 16) {
  return {status: 'approved', image_base64: bytes.toString('base64'), image_bytes: bytes.length, image_sha256: createHash('sha256').update(bytes).digest('hex'), width, height};
}
function insertSegment(jpeg, marker, payload) {
  const header = Buffer.from([0xff, marker, 0, 0]); header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

test('stored JPEG validation rejects metadata containers omitted by Sharp and bytes after the first image', async () => {
  const original = await sharp({create: {width: 24, height: 16, channels: 3, background: '#123456'}}).jpeg().toBuffer();
  const secret = Buffer.from('GPSLatitude=43.123456 GPSLongitude=76.123456');
  const candidates = [insertSegment(original, 0xfe, secret), insertSegment(original, 0xef, secret), Buffer.concat([original, secret, Buffer.from([0xff, 0xd9])])];
  for (const bytes of candidates) {
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, 24);
    assert.equal(metadata.exif, undefined, 'the previous metadata-only guard would accept this');
    await sharp(bytes).raw().toBuffer();
    await assert.rejects(inspectStoredPhoto(stored(bytes)), /canonical bounded JPEG/);
    const normalized = await normalizePhoto(bytes.toString('base64'));
    assert.equal(await inspectStoredPhoto({...normalized, status: 'pending'}), true);
    assert.equal(Buffer.from(normalized.image_base64, 'base64').includes(secret), false);
  }
});

test('canonical JPEG scan permits stuffed entropy bytes in real photographic data', async () => {
  const pixels = Buffer.alloc(256 * 256 * 3); let state = 19;
  for (let i = 0; i < pixels.length; i++) {state = (Math.imul(state, 1664525) + 1013904223) >>> 0; pixels[i] = state >>> 24;}
  const input = await sharp(pixels, {raw: {width: 256, height: 256, channels: 3}}).png().toBuffer();
  const normalized = await normalizePhoto(input.toString('base64'));
  assert.ok(Buffer.from(normalized.image_base64, 'base64').includes(Buffer.from([0xff, 0])));
  assert.equal(await inspectStoredPhoto({...normalized, status: 'approved'}), true);
});

test('bounded base64 round trip rejects permissive decoder variants and accepts the full upload limit', () => {
  for (const input of ['Zg==\n\n\n\n', 'Zh==', 'Zm9=', 'Zg======', 'Z g=', '-_8=', 'Z\u0000g=', 'data:image/svg+xml;base64,Zg==']) {
    assert.throws(() => photoBase64(input), error => error.status === 400);
  }
  assert.equal(photoBase64('Zg==').toString(), 'f');
  assert.equal(photoBase64('data:image/png;base64,Zm8=').toString(), 'fo');
  const bytes = Buffer.alloc(PHOTO_INPUT_BYTES, 117);
  assert.deepEqual(photoBase64(bytes.toString('base64')), bytes);
  assert.throws(() => photoBase64(Buffer.alloc(PHOTO_INPUT_BYTES + 1).toString('base64')), error => error.status === 400);
});
