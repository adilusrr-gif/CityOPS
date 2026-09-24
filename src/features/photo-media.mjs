import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {fail} from '../domain.mjs';
import {PHOTO_MEDIA_LIMITS} from '../product-policy.mjs';

export const PHOTO_INPUT_BYTES = PHOTO_MEDIA_LIMITS.inputBytes;
export const PHOTO_OUTPUT_BYTES = PHOTO_MEDIA_LIMITS.outputBytes;
export const PHOTO_MAX_PIXELS = PHOTO_MEDIA_LIMITS.maxPixels;
let active = 0;
const waiting = [];

// Across all requests in this process, at most two decoders and four waiters.
// This is a memory/CPU bound, separate from the durable cross-replica quotas.
async function decodeSlot(work) {
  if (active >= PHOTO_MEDIA_LIMITS.decoderConcurrency) {
    if (waiting.length >= PHOTO_MEDIA_LIMITS.decoderQueue) fail('Обработка фотографий занята. Попробуйте позже.', 429);
    await new Promise(resolve => waiting.push(resolve));
  } else active++;
  try {return await work();}
  finally {const next = waiting.shift(); if (next) next(); else active--;}
}

export function photoBase64(value, limit = PHOTO_INPUT_BYTES) {
  if (typeof value !== 'string') fail('Нужна фотография JPEG, PNG или WebP');
  const encoded = value.replace(/^data:image\/(?:jpeg|png|webp);base64,/, '');
  if (!encoded.length || encoded.length > 4 * Math.ceil(limit / 3) || encoded.length % 4) fail('Некорректная фотография или размер больше допустимого');
  // Buffer's decoder is permissive, so require the exact canonical round trip.
  // This also rejects whitespace, URL alphabet, invalid padding and pad bits
  // without running a redundant grouped regex over up to four MiB on the loop.
  const buffer = Buffer.from(encoded, 'base64');
  if (!buffer.length || buffer.length > limit || buffer.toString('base64') !== encoded) fail('Некорректная фотография или размер больше допустимого');
  return buffer;
}

export async function normalizePhoto(value) {
  // Reject very large text before enqueueing; only a bounded number of buffers
  // is then retained by the decoder queue. No original is written to disk/DB.
  if (typeof value !== 'string' || value.length > 4 * Math.ceil(PHOTO_INPUT_BYTES / 3) + 40) fail('Фото должно быть не больше 3 МиБ');
  return decodeSlot(async () => {
    const input = photoBase64(value);
    try {
      const options = {limitInputPixels: PHOTO_MAX_PIXELS, failOn: 'error', sequentialRead: true};
      const metadata = await sharp(input, options).metadata();
      if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1 || !metadata.width || !metadata.height || metadata.width * metadata.height > PHOTO_MAX_PIXELS || metadata.width > 16384 || metadata.height > 16384) fail('Нужно одно неподвижное изображение JPEG, PNG или WebP до 12 мегапикселей');
      let output;
      for (const [size, quality] of [[PHOTO_MEDIA_LIMITS.maxSide, 80], [1024, 70], [640, 65]]) {
        // Sharp drops all EXIF/XMP/IPTC/ICC metadata by default. rotate() applies
        // EXIF orientation first, so there is no metadata to interpret later.
        output = await sharp(input, options).rotate().resize(size, size, {fit: 'inside', withoutEnlargement: true}).flatten({background: '#ffffff'}).jpeg({quality, progressive: false}).toBuffer({resolveWithObject: true});
        if (output.data.length <= PHOTO_OUTPUT_BYTES) break;
      }
      if (output.data.length > PHOTO_OUTPUT_BYTES) fail('Не удалось безопасно уменьшить фотографию');
      return {image_base64: output.data.toString('base64'), image_bytes: output.data.length, image_sha256: createHash('sha256').update(output.data).digest('hex'), width: output.info.width, height: output.info.height};
    } catch (error) {
      if (error.status) throw error;
      fail('Не удалось прочитать фотографию. Используйте JPEG, PNG или WebP до 12 мегапикселей');
    }
  });
}

// libvips metadata() does not report every JPEG metadata container (notably COM
// and arbitrary APP segments), and decoders accept bytes after EOI. Walk marker
// boundaries, including byte stuffing inside the entropy stream, instead of
// searching bytes that may legitimately occur within compressed image data.
// Our encoder emits one baseline scan without application/metadata segments.
function assertCanonicalJpeg(buffer) {
  const invalid = () => {throw new Error('Stored photograph is not a canonical bounded JPEG: forbidden metadata or trailing data');};
  let offset = 2, entropy = false, scanned = false;
  while (offset < buffer.length) {
    if (entropy) {
      while (offset < buffer.length) {
        if (buffer[offset++] !== 0xff) continue;
        const start = offset - 1;
        while (buffer[offset] === 0xff) offset++;
        const marker = buffer[offset];
        if (marker === 0 || (marker >= 0xd0 && marker <= 0xd7)) {offset++; continue;}
        offset = start; entropy = false; break;
      }
    }
    if (buffer[offset++] !== 0xff) invalid();
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xd9) {if (!scanned || offset !== buffer.length) invalid(); return;}
    if (![0xc0, 0xc4, 0xdb, 0xdd, 0xda].includes(marker) || offset + 2 > buffer.length) invalid();
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) invalid();
    offset += length;
    if (marker === 0xda) {if (scanned) invalid(); scanned = true; entropy = true;}
  }
  invalid();
}

// Used by import validation too: a forged backup must not expose active SVG,
// metadata-bearing originals, oversized buffers or inconsistent quota counters.
export function validateStoredPhoto(row) {
  if (row.status === 'withdrawn') {
    if (row.image_base64 !== null || Number(row.image_bytes) !== 0) throw new Error('Withdrawn photo still contains image data');
    return null;
  }
  const buffer = photoBase64(row.image_base64, PHOTO_OUTPUT_BYTES);
  if (buffer.length !== Number(row.image_bytes) || createHash('sha256').update(buffer).digest('hex') !== row.image_sha256 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9 || !Number.isInteger(Number(row.width)) || !Number.isInteger(Number(row.height)) || row.width < 1 || row.height < 1 || row.width > PHOTO_MEDIA_LIMITS.maxSide || row.height > PHOTO_MEDIA_LIMITS.maxSide) throw new Error('Stored photograph is not a canonical bounded JPEG');
  assertCanonicalJpeg(buffer);
  return buffer;
}

export async function inspectStoredPhoto(row) {
  const buffer = validateStoredPhoto(row);
  if (!buffer) return true;
  const metadata = await sharp(buffer, {limitInputPixels: PHOTO_MEDIA_LIMITS.maxSide ** 2, failOn: 'error'}).metadata();
  if (metadata.format !== 'jpeg' || metadata.width !== Number(row.width) || metadata.height !== Number(row.height) || (metadata.pages || 1) !== 1 || metadata.exif || metadata.xmp || metadata.iptc || metadata.icc || metadata.orientation) throw new Error('Stored JPEG has forbidden metadata or inconsistent dimensions');
  // Force the full decoder, not just the header parser, during an import.
  await sharp(buffer, {limitInputPixels: PHOTO_MEDIA_LIMITS.maxSide ** 2, failOn: 'error'}).raw().toBuffer();
  return true;
}
