import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, encodeRgba, LIMITS, validateThemePack } from 'familiar-theme';
import { assertDecodedTotal } from '../src/validate.js';
import { writePack, TINY_PNG } from './helpers/fixture.js';

const pack = (t) => {
  const dir = writePack();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const rejects = (dir, re) => assert.rejects(() => validateThemePack(dir), re);

const rawChunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const headerOnlyPng = (w, h) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  // Deliberately INVALID compressed data under a VALID chunk CRC: pngSize
  // passes, decode would fail — the tripwire proving accounting runs first.
  return Buffer.concat([
    SIG, rawChunk('IHDR', ihdr), rawChunk('IDAT', Buffer.from('not deflate')), rawChunk('IEND', Buffer.alloc(0)),
  ]);
};

test('an invalid UNDECLARED source.png rejects — every PNG in the pack validates', async (t) => {
  const dir = pack(t);
  writeFileSync(join(dir, 'sprites', 'solo', 'source.png'), Buffer.from('not a png'));
  await rejects(dir, /sprites\/solo\/source\.png.*not a PNG/);
});

test('CRC-valid-but-corrupt IDAT passes structure and fails decode, naming the file', async (t) => {
  const dir = pack(t);
  writeFileSync(join(dir, 'sprites', 'solo', 'noise.png'), headerOnlyPng(1, 1));
  await rejects(dir, /sprites\/solo\/noise\.png.*(does not inflate|corrupt)/);
});

test('dimension caps fail from the header, before any inflate', async (t) => {
  const overSide = pack(t);
  writeFileSync(join(overSide, 'sprites', 'solo', 'wide.png'), headerOnlyPng(LIMITS.MAX_ASSET_SIDE + 1, 1));
  await rejects(overSide, /wide\.png.*MAX_ASSET_SIDE|wide\.png is \d+ px/);

  const overPixels = pack(t);
  writeFileSync(join(overPixels, 'sprites', 'solo', 'tall.png'), headerOnlyPng(4096, 2049));
  await rejects(overPixels, /tall\.png.*MAX_ASSET_PIXELS|pixels/);
});

test('at the dimension limits, a real asset decodes clean', async (t) => {
  const dir = pack(t);
  // 4096 x 2048 = exactly MAX_ASSET_PIXELS; side exactly MAX_ASSET_SIDE.
  const w = LIMITS.MAX_ASSET_SIDE, h = LIMITS.MAX_ASSET_PIXELS / LIMITS.MAX_ASSET_SIDE;
  writeFileSync(join(dir, 'sprites', 'solo', 'max.png'),
    encodeRgba({ w, h, buf: new Uint8Array(w * h * 4) }));
  await validateThemePack(dir);
});

test('MAX_DECODED_TOTAL trips from accounting BEFORE any IDAT reaches zlib', async (t) => {
  const dir = pack(t);
  // 17 headers promising 32 MiB decoded each (544 MiB total), all with invalid
  // IDAT. If decode ran first the error would be an inflate error; it must be
  // the accounting error.
  for (let i = 0; i < 17; i++) {
    writeFileSync(join(dir, 'sprites', 'solo', `promise-${String(i).padStart(2, '0')}.png`),
      headerOnlyPng(4096, 2048));
  }
  await rejects(dir, /MAX_DECODED_TOTAL/);
});

test('the accounting comparison: exact limit passes, smallest representable excess fails', () => {
  assert.doesNotThrow(() => assertDecodedTotal(LIMITS.MAX_DECODED_TOTAL));
  assert.throws(() => assertDecodedTotal(LIMITS.MAX_DECODED_TOTAL + 4), /MAX_DECODED_TOTAL/);
});

test('a missing declared state rejects with the state named', async (t) => {
  const dir = pack(t);
  rmSync(join(dir, 'sprites', 'solo', 'working.png'));
  await rejects(dir, /solo.*working/);
});

test('.light.png: absent passes; present-but-malformed rejects', async (t) => {
  const ok = pack(t);
  await validateThemePack(ok);

  const bad = pack(t);
  writeFileSync(join(bad, 'sprites', 'solo', 'idle.light.png'), Buffer.from('junk'));
  await rejects(bad, /idle\.light\.png.*not a PNG/);
});

test('at MAX_ASSET_BYTES exactly, a padded valid PNG passes', async (t) => {
  const dir = pack(t);
  const base = TINY_PNG();
  // Insert an ancillary chunk before IEND to land the file at the exact cap.
  const pad = LIMITS.MAX_ASSET_BYTES - base.length - 12;   // 12 = chunk overhead
  const padded = Buffer.concat([
    base.subarray(0, base.length - 12),
    rawChunk('teXt', Buffer.alloc(pad)),
    base.subarray(base.length - 12),
  ]);
  assert.equal(padded.length, LIMITS.MAX_ASSET_BYTES);
  writeFileSync(join(dir, 'sprites', 'solo', 'fat.png'), padded);
  await validateThemePack(dir);
});
