import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodeRgba, encodeRgba, crc32, pngSize } from 'familiar-theme';

const onePixel = () => Buffer.from(encodeRgba({ w: 1, h: 1, buf: new Uint8Array([0, 0, 0, 255]) }));

// IHDR layout: 8-byte signature, then [len:4][type:4][data:13][crc:4].
// So the chunk's type starts at 12, its data at 16, and its CRC at 29. The bit-depth
// byte is data[8] -> absolute offset 24.
const IHDR_DEPTH = 24;
const IHDR_CRC = 29;
const reseal = (png) => png.writeUInt32BE(crc32(png.subarray(12, 29)), IHDR_CRC);

// ── a PNG assembler that is NOT the encoder ──────────────────────────────────
//
// encodeRgba emits colour type 6 with filter 0 on every row, exclusively. The real
// contact sheet is colour type 2 with a row-filter histogram of {1:19, 2:142, 3:1,
// 4:862} -- NOT ONE ROW USES FILTER 0. So a suite whose only pixel test round-trips
// through encodeRgba never executes `channels === 3`, and never executes a single one
// of Sub/Up/Average/Paeth: the entire production decode path. (Proven: mutating
// paeth() to `return a` left the old suite fully green while the real sheet died.)
//
// Hence this assembler. It takes ALREADY-FILTERED scanline bytes and a per-row filter
// byte, so the test controls the colour type and the filter of every row -- and every
// fixture below hardcodes both the filtered bytes and the pixels they must decode to,
// computed BY HAND. Nothing here re-implements a predictor: a test that derives its
// expectation from the same arithmetic as the code under test agrees with the author
// instead of testing him, which is the exact failure this file exists to end.
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// `rows` is [[filterByte, [...filtered scanline bytes]], ...] -- raw IDAT content.
function assemble({ w, h, colour, depth = 8, compression = 0, filterMethod = 0, interlace = 0, rows, extra = [] }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = depth;
  ihdr[9] = colour;
  ihdr[10] = compression;
  ihdr[11] = filterMethod;
  ihdr[12] = interlace;
  const raw = Buffer.concat(rows.map(([f, bytes]) => Buffer.from([f, ...bytes])));
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    ...extra,
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pixels = ({ w, h, buf }) => Array.from({ length: w * h }, (_, i) => Array.from(buf.subarray(i * 4, i * 4 + 4)));

// ── the production decode path: colour type 2, and all five row filters ──────

test('decodes colour type 2 (RGB) — three channels, alpha forced opaque', () => {
  // The real sheet's colour type. encodeRgba cannot produce it, so nothing else here
  // can reach `channels = 3` or the `colour === 4 ? line[s+3] : 255` alpha fill.
  const png = assemble({
    w: 2, h: 2, colour: 2,
    rows: [[0, [10, 20, 30, 40, 50, 60]], [0, [70, 80, 90, 100, 110, 120]]],
  });
  assert.deepEqual(pixels(decodeRgba(png)), [
    [10, 20, 30, 255], [40, 50, 60, 255],
    [70, 80, 90, 255], [100, 110, 120, 255],
  ]);
});

test('reconstructs all five row filters, EACH ON A DIFFERENT ROW (colour type 2)', () => {
  // Rows carry DIFFERENT filters from one another, which is what a real encoder emits
  // and is the only shape in which an Up/Average/Paeth bug -- all three of which read
  // the PREVIOUS row -- can actually show itself.
  //
  // Filtered bytes and expected pixels are both hand-computed; bpp = 3.
  //
  //   row 0  None    stored as-is.
  //   row 1  Sub     raw[i] - raw[i-3].  raw = 15,25,35, 45,55,65, 75,85,95
  //                  -> 15,25,35 then 30 everywhere (each pixel is +30 on the last).
  //   row 2  Up      raw[i] - above[i].  raw is above + 5 -> a flat row of 5s.
  //   row 3  Average raw[i] - ((a + b) >> 1), a = left, b = above.
  //                  i0: a=0  b=20 -> 10; 25-10 = 15      (odd sums below: an
  //                  i1: a=0  b=30 -> 15; 35-15 = 20       (a+b+1)>>1 rounding bug
  //                  i2: a=0  b=40 -> 20; 45-20 = 25       moves i3..i8 by one)
  //                  i3: a=25 b=50 -> 37; 55-37 = 18
  //                  i4: a=35 b=60 -> 47; 65-47 = 18
  //                  i5: a=45 b=70 -> 57; 75-57 = 18
  //                  i6: a=55 b=80 -> 67; 85-67 = 18
  //                  i7: a=65 b=90 -> 77; 95-77 = 18
  //                  i8: a=75 b=100-> 87; 105-87 = 18
  //   row 4  Paeth   here every byte's predictor resolves to `b` (a=0/c=0 at the left
  //                  edge, and p lands on b after); the branch coverage that forces
  //                  Paeth to choose a, b AND c is the dedicated test below.
  const png = assemble({
    w: 3, h: 5, colour: 2,
    rows: [
      [0, [10, 20, 30, 40, 50, 60, 70, 80, 90]],
      [1, [15, 25, 35, 30, 30, 30, 30, 30, 30]],
      [2, [5, 5, 5, 5, 5, 5, 5, 5, 5]],
      [3, [15, 20, 25, 18, 18, 18, 18, 18, 18]],
      [4, [5, 5, 5, 5, 5, 5, 5, 5, 5]],
    ],
  });
  assert.deepEqual(pixels(decodeRgba(png)), [
    [10, 20, 30, 255], [40, 50, 60, 255], [70, 80, 90, 255],        // None
    [15, 25, 35, 255], [45, 55, 65, 255], [75, 85, 95, 255],        // Sub
    [20, 30, 40, 255], [50, 60, 70, 255], [80, 90, 100, 255],       // Up
    [25, 35, 45, 255], [55, 65, 75, 255], [85, 95, 105, 255],       // Average
    [30, 40, 50, 255], [60, 70, 80, 255], [90, 100, 110, 255],      // Paeth
  ]);
});

test('Paeth picks a, b AND c — all three branches, on values that differ', () => {
  // `return a`, `return b` and `return c` are each a one-token mutation of paeth(),
  // and a fixture on which the predictor happens to resolve the same way every time
  // cannot tell them apart. So the previous row is shaped to force a different winner
  // per byte. bpp = 3; a = left, b = above, c = above-left. p = a + b - c;
  // pa = |p-a|, pb = |p-b|, pc = |p-c|.
  //
  //   above  = 20,100,100 | 20,200, 90 |  0, 0, 0 | 255, 1,140
  //   filter = 80,  0, 10 | 30, 10,  5 | 10,50,60 |  10, 5,  0
  //
  //   i0: a=0   b=20  c=0    p=20   pa=20 pb=0   pc=20  -> b=20    100 = 80+20
  //   i1: a=0   b=100 c=0    p=100  pa=100 pb=0  pc=100 -> b=100   100 =  0+100
  //   i2: a=0   b=100 c=0    p=100  pa=100 pb=0  pc=100 -> b=100   110 = 10+100
  //   i3: a=100 b=20  c=20   p=100  pa=0  pb=80  pc=80  -> a=100   130 = 30+100  [A]
  //   i4: a=100 b=200 c=100  p=200  pa=100 pb=0  pc=100 -> b=200   210 = 10+200  [B]
  //   i5: a=110 b=90  c=100  p=100  pa=10 pb=10  pc=0   -> c=100   105 =  5+100  [C]
  //   i6: a=130 b=0   c=20   p=110  pa=20 pb=110 pc=90  -> a=130   140 = 10+130  [A]
  //   i7: a=210 b=0   c=200  p=10   pa=200 pb=10 pc=190 -> b=0      50 = 50+0
  //   i8: a=105 b=0   c=90   p=15   pa=90 pb=15  pc=75  -> b=0      60 = 60+0
  //   i9: a=140 b=255 c=0    p=395  pa=255 pb=140 pc=395-> b=255     9 = (10+255) & 0xff
  //   i10:a=50  b=1   c=0    p=51   pa=1  pb=50  pc=51  -> a=50     55 =  5+50   [A]
  //   i11:a=60  b=140 c=0    p=200  pa=140 pb=60 pc=200 -> b=140   140 =  0+140
  //
  // i9 also pins the & 0xff wrap: 265 must come back as 9, not 255-clamped.
  const png = assemble({
    w: 4, h: 2, colour: 2,
    rows: [
      [0, [20, 100, 100, 20, 200, 90, 0, 0, 0, 255, 1, 140]],
      [4, [80, 0, 10, 30, 10, 5, 10, 50, 60, 10, 5, 0]],
    ],
  });
  assert.deepEqual(pixels(decodeRgba(png)), [
    [20, 100, 100, 255], [20, 200, 90, 255], [0, 0, 0, 255], [255, 1, 140, 255],
    [100, 100, 110, 255], [130, 210, 105, 255], [140, 50, 60, 255], [9, 55, 140, 255],
  ]);
});

test('filters use the colour type\'s bytes-per-pixel — RGBA (bpp 4), with wraparound', () => {
  // The same Sub/Up code has to step back FOUR bytes here and THREE above. A decoder
  // that hardcoded either one passes the other fixture and fails this.
  //
  //   row 0  None
  //   row 1  Sub   raw = 11,22,33,44, 61,72,83,94 -> 11,22,33,44 then a flat 50
  //   row 2  Up    raw = 1,2,3,4, 5,6,7,8; every byte is BELOW the row above, so each
  //                filtered byte is negative and wraps: 1-11 = -10 -> 246, etc. The
  //                decoder's `& 0xff` is what brings them back.
  const png = assemble({
    w: 2, h: 3, colour: 6,
    rows: [
      [0, [10, 20, 30, 40, 50, 60, 70, 80]],
      [1, [11, 22, 33, 44, 50, 50, 50, 50]],
      [2, [246, 236, 226, 216, 200, 190, 180, 170]],
    ],
  });
  assert.deepEqual(pixels(decodeRgba(png)), [
    [10, 20, 30, 40], [50, 60, 70, 80],
    [11, 22, 33, 44], [61, 72, 83, 94],
    [1, 2, 3, 4], [5, 6, 7, 8],
  ]);
});

// ── encode ───────────────────────────────────────────────────────────────────

test('encode -> decode round-trips pixels exactly', () => {
  const w = 3, h = 2;
  const buf = new Uint8Array([
    255, 0, 0, 255,   0, 255, 0, 128,   0, 0, 255, 0,
    1, 2, 3, 4,       5, 6, 7, 8,       9, 10, 11, 12,
  ]);
  const round = decodeRgba(encodeRgba({ w, h, buf }));
  assert.equal(round.w, w);
  assert.equal(round.h, h);
  assert.deepEqual(Array.from(round.buf), Array.from(buf));
});

test('encode refuses a buffer that is not exactly w*h*4 — it will not encode memory it was not given', () => {
  // The row copy reads THROUGH the view into the underlying ArrayBuffer. Before the
  // length check, a 20-byte view over a 64-byte buffer encoded a perfectly valid 3x2
  // PNG whose last pixel was [17,17,17,17] -- bytes the caller never handed over.
  const backing = new ArrayBuffer(64);
  new Uint8Array(backing).fill(17);
  const short = new Uint8Array(backing, 0, 20);              // 3x2 RGBA needs 24
  assert.throws(() => encodeRgba({ w: 3, h: 2, buf: short }), /needs 24 bytes, got 20/);

  // And a long one is not silently cropped either.
  assert.throws(() => encodeRgba({ w: 1, h: 1, buf: new Uint8Array(8) }), /needs 4 bytes, got 8/);
});

// ── the guards ───────────────────────────────────────────────────────────────
//
// EVERY ONE OF THESE RESEALS OR REBUILDS ITS CRC. A test that corrupts a byte and
// leaves the CRC stale is testing CRC rejection: it passes, names a branch it never
// reached, and proves nothing. The assembler above always seals correctly, so the
// fixtures it builds are well-formed files that are refused for the reason claimed.

test('decode rejects an interlaced image', () => {
  const png = assemble({ w: 1, h: 1, colour: 6, interlace: 1, rows: [[0, [0, 0, 0, 255]]] });
  assert.throws(() => decodeRgba(png), /interlac/i);
});

test('decode rejects an unsupported colour type, naming it', () => {
  // Greyscale (0) and palette (3) are the two a model could plausibly hand back. The
  // decoder supports 2 and 6 and says so; it does not guess at the rest.
  for (const colour of [0, 3, 4]) {
    const png = assemble({ w: 1, h: 1, colour, rows: [[0, [0, 0, 0, 255]]] });
    assert.throws(() => decodeRgba(png), new RegExp(`colour type ${colour} unsupported`));
  }
});

test('decode rejects a zero-sized image', () => {
  const png = assemble({ w: 0, h: 1, colour: 6, rows: [[0, []]] });
  assert.throws(() => pngSize(png), /zero-sized image \(0x1\)/);
  assert.throws(() => decodeRgba(png), /zero-sized image \(0x1\)/);
});

test('decode rejects an unknown row filter, naming the filter AND the row', () => {
  // Filter 5 does not exist. Silently treating it as None is how a decoder returns a
  // plausible-looking image that is not the one in the file.
  const png = assemble({
    w: 1, h: 2, colour: 6,
    rows: [[0, [1, 2, 3, 4]], [5, [1, 2, 3, 4]]],
  });
  assert.throws(() => decodeRgba(png), /unknown filter 5 on row 1/);
});

test('decode rejects a file whose signature is not a PNG', () => {
  const notPng = Buffer.from('GIF89a-and-then-some-plausible-looking-bytes');
  assert.throws(() => pngSize(notPng), /bad signature/);
  assert.throws(() => decodeRgba(notPng), /bad signature/);
  assert.throws(() => pngSize(Buffer.alloc(3)), /bad signature/);
  assert.throws(() => decodeRgba(Buffer.alloc(3)), /bad signature/);   // too short to even compare
});

test('decode rejects an unsupported bit depth, naming it', () => {
  // The CRC is RESEALED after corrupting the depth. Without that, this PNG is simply
  // corrupt, and a correct decoder rejects it for its CRC long before it ever looks
  // at the bit depth -- so the test would pass while proving nothing about depth.
  const bad = onePixel();
  bad[IHDR_DEPTH] = 16;
  reseal(bad);
  assert.throws(() => decodeRgba(bad), /bit depth/i);
});

test('decode rejects a corrupt chunk on its CRC', () => {
  const bad = onePixel();
  bad[IHDR_DEPTH] = 16;        // same corruption, CRC deliberately NOT resealed
  assert.throws(() => pngSize(bad), /CRC/i);
  assert.throws(() => decodeRgba(bad), /CRC/i);
});

test('decode rejects a truncated file rather than reading past its end', () => {
  assert.throws(() => pngSize(onePixel().subarray(0, 30)), /truncat|past the end/i);
  assert.throws(() => decodeRgba(onePixel().subarray(0, 30)), /truncat|past the end/i);
});

test('decode rejects a PNG with no pixels', () => {
  // IDAT is not optional. An earlier draft simply produced a zero-filled image.
  const headless = onePixel();
  const noIdat = Buffer.concat([headless.subarray(0, 33), headless.subarray(headless.length - 12)]);
  assert.throws(() => pngSize(noIdat), /IDAT/);
  assert.throws(() => decodeRgba(noIdat), /IDAT/);
});

test('decode rejects a PNG whose IEND was lopped off', () => {
  // Distinct from the truncation test above, which dies inside an INCOMPLETE chunk
  // header. Here every chunk is whole and correctly CRC'd; the file just stops. A
  // decoder that only bounds-checks would accept this and return a valid image.
  const noEnd = onePixel();
  assert.throws(() => pngSize(noEnd.subarray(0, noEnd.length - 12)), /IEND/);
  assert.throws(() => decodeRgba(noEnd.subarray(0, noEnd.length - 12)), /IEND/);
});

test('decode rejects IDAT that inflates to the wrong size for its IHDR', () => {
  // The IHDR promises h rows; the IDAT carries h. Claim one more and the pixel loop
  // would happily read `undefined` off the end of the buffer and call it black.
  const bad = onePixel();
  bad.writeUInt32BE(2, 16 + 4);   // IHDR height: 1 -> 2
  reseal(bad);
  assert.throws(() => decodeRgba(bad), /inflates to/);
});

test('decode rejects an unsupported compression or filter method', () => {
  for (const [offset, name] of [[16 + 10, 'compression'], [16 + 11, 'filter']]) {
    const bad = onePixel();
    bad[offset] = 1;
    reseal(bad);
    assert.throws(() => decodeRgba(bad), new RegExp(name, 'i'));
  }
});

test('decode rejects a PNG whose header chunk is not IHDR', () => {
  // Retype IHDR to a private chunk and reseal: every chunk is still CRC-valid, the
  // file is still well-formed -- there is simply no header. Without the check, `ihdr`
  // stays null and the decoder reads width and height off `null`.
  const bad = onePixel();
  bad.write('iHDR', 12, 'ascii');
  reseal(bad);
  assert.throws(() => pngSize(bad), /IHDR/);
  assert.throws(() => decodeRgba(bad), /IHDR/);
});

test('decode rejects an IHDR of the wrong length', () => {
  // A CRC-VALID IHDR carrying 12 bytes instead of 13. It has to be rebuilt rather
  // than patched, because the length lives in the chunk header and the CRC covers the
  // payload -- which is exactly why the earlier "every invariant has a test" claim was
  // false here: this branch is unreachable by corrupting bytes in place.
  const good = onePixel();
  const data = good.subarray(16, 28);                        // 12 bytes: one short
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write('IHDR', 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);

  const bad = Buffer.concat([good.subarray(0, 8), head, data, crc, good.subarray(33)]);
  assert.throws(() => pngSize(bad), /IHDR is 12 bytes/);
  assert.throws(() => decodeRgba(bad), /IHDR is 12 bytes/);
});

// ── structure: order is a claim too ──────────────────────────────────────────

test('decode rejects a chunk that appears before IHDR', () => {
  const good = onePixel();
  const bad = Buffer.concat([good.subarray(0, 8), chunk('gAMA', Buffer.alloc(4)), good.subarray(8)]);
  assert.throws(() => pngSize(bad), /"gAMA" appears before IHDR/);
  assert.throws(() => decodeRgba(bad), /"gAMA" appears before IHDR/);
});

test('decode rejects a SECOND IHDR rather than letting it override the first', () => {
  // Two headers that AGREE about size slipped through entirely: the inflate-length
  // check caught this only when they happened to disagree. A file that declares its
  // dimensions twice is a file whose dimensions nobody knows.
  const png = assemble({
    w: 1, h: 1, colour: 6, rows: [[0, [1, 2, 3, 4]]],
    extra: [chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]))],
  });
  assert.throws(() => pngSize(png), /second IHDR/);
  assert.throws(() => decodeRgba(png), /second IHDR/);
});

test('decode rejects trailing garbage after IEND', () => {
  const bad = Buffer.concat([onePixel(), Buffer.from('a payload nobody declared')]);
  assert.throws(() => pngSize(bad), /25 bytes of trailing garbage after IEND/);
  assert.throws(() => decodeRgba(bad), /25 bytes of trailing garbage after IEND/);
});

const ihdrData = (w, h, { depth = 8, colour = 6 } = {}) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = depth; d[9] = colour; d[10] = 0; d[11] = 0; d[12] = 0;
  return d;
};

test('decodeRgba bounds inflation to the IHDR promise, not the attacker payload', () => {
  const bomb = Buffer.concat([
    SIG,
    chunk('IHDR', ihdrData(1, 1)),
    chunk('IDAT', deflateSync(Buffer.alloc(1024 * 1024))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => decodeRgba(bomb), /IDAT inflates past what IHDR promises/);
});

test('decodeRgba still rejects an inflate UNDERRUN with the length mismatch error', () => {
  const short = Buffer.concat([
    SIG,
    chunk('IHDR', ihdrData(2, 2)),
    chunk('IDAT', deflateSync(Buffer.alloc(5))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  assert.throws(() => decodeRgba(short), /IDAT inflates to 5 bytes, but IHDR promises 18/);
});

const withBadTypeChunk = () => {
  const data = deflateSync(Buffer.from([0, 1, 2, 3, 255]));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write('ID~T', 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdrData(1, 1)),
    head, data, crc,
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

const structuralFixtures = () => {
  const good = Buffer.concat([
    SIG,
    chunk('IHDR', ihdrData(1, 1)),
    chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const resigned = (mutate) => { const b = Buffer.from(good); mutate(b); return b; };
  return [
    ['bad signature', resigned((b) => { b[0] = 0; }), /not a PNG/],
    ['truncated chunk header', good.subarray(0, good.length - 10), /truncated chunk header|runs past the end/],
    ['CRC mismatch', resigned((b) => { b[b.length - 1] ^= 0xff; }), /fails its CRC/],
    ['invalid chunk type bytes under a VALID CRC', withBadTypeChunk(), /invalid chunk type bytes/],
    ['trailing garbage', Buffer.concat([good, Buffer.from([1])]), /trailing garbage after IEND/],
    ['no IEND', good.subarray(0, good.length - 12), /no IEND/],
  ];
};

for (const [name, bytes, re] of structuralFixtures()) {
  test(`walker parity: ${name} rejects in pngSize AND decodeRgba`, () => {
    assert.throws(() => pngSize(bytes), re, 'pngSize accepted it');
    assert.throws(() => decodeRgba(bytes), re, 'decodeRgba accepted it');
  });
}

test('pngSize keeps its stricter checks after unification: IEND length and chunk-type bytes', () => {
  const nonEmptyIend = Buffer.concat([
    SIG,
    chunk('IHDR', ihdrData(1, 1)),
    chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3, 255]))),
    chunk('IEND', Buffer.from([7])),
  ]);
  assert.throws(() => pngSize(nonEmptyIend), /IEND is 1 bytes, not 0/);
  assert.throws(() => decodeRgba(nonEmptyIend), /IEND is 1 bytes, not 0/);
});
