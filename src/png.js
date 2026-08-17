import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IHDR = Buffer.from('IHDR');
const IDAT = Buffer.from('IDAT');
const IEND = Buffer.from('IEND');

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// EVERY structural claim in the file is checked before it is believed. A decoder
// that trusts its input is not strict; it is merely undiagnosed.
function walkChunks(png) {
  if (png.length < SIGNATURE.length || !png.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('png: not a PNG (bad signature)');
  }

  let ihdr = null;
  const idat = [];
  let sawEnd = false;
  let at = 8;
  while (at < png.length) {
    if (at + 12 > png.length) throw new Error(`png: truncated chunk header at byte ${at}`);
    const length = png.readUInt32BE(at);
    const typeBytes = png.subarray(at + 4, at + 8);
    if (!typeBytes.every((byte) =>
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a))) {
      throw new Error(
        `png: invalid chunk type bytes ${typeBytes.toString('hex').match(/../g).join(' ')} — chunk types must be four ASCII letters`,
      );
    }
    const type = typeBytes.toString('ascii');
    const dataEnd = at + 8 + length;
    const next = dataEnd + 4;
    if (next > png.length) {
      throw new Error(`png: chunk "${type}" claims ${length} bytes, which runs past the end of the file`);
    }

    const want = png.readUInt32BE(dataEnd);
    const got = crc32(png.subarray(at + 4, dataEnd));
    if (want !== got) throw new Error(`png: chunk "${type}" fails its CRC — the file is corrupt`);

    const data = png.subarray(at + 8, dataEnd);
    if (typeBytes.equals(IHDR)) {
      if (ihdr) throw new Error('png: a second IHDR — the file declares its header twice');
      if (length !== 13) throw new Error(`png: IHDR is ${length} bytes, not 13`);
      ihdr = data;
    } else {
      if (!ihdr) throw new Error(`png: chunk "${type}" appears before IHDR`);
      if (typeBytes.equals(IDAT)) idat.push(data);
      if (typeBytes.equals(IEND)) {
        if (length !== 0) throw new Error(`png: IEND is ${length} bytes, not 0`);
        sawEnd = true;
        if (next !== png.length) {
          throw new Error(`png: ${png.length - next} bytes of trailing garbage after IEND`);
        }
        break;
      }
    }
    at = next;
  }

  if (!ihdr) throw new Error('png: no IHDR');
  if (idat.length === 0) throw new Error('png: no IDAT — the file carries no pixels');
  if (!sawEnd) throw new Error('png: no IEND — the file is truncated');
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  if (w === 0 || h === 0) throw new Error(`png: zero-sized image (${w}x${h})`);
  return { w, h, ihdr, idat };
}

export function pngSize(bytes) {
  const { w, h } = walkChunks(Buffer.from(bytes));
  return { w, h };
}

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

export function encodeRgba({ w, h, buf }) {
  // The buffer is a VIEW, and the row copy below reads through it into the
  // underlying ArrayBuffer. A short view is therefore not a short read -- it is a
  // read of memory the caller never handed over, encoded into a PNG that looks
  // perfectly valid. (Measured: a 3x2 encode from a 20-byte view over a 64-byte
  // buffer emitted a last pixel of [17,17,17,17].) A long one is silently cropped.
  if (buf.length !== w * h * 4) {
    throw new Error(`png: encode of ${w}x${h} RGBA needs ${w * h * 4} bytes, got ${buf.length}`);
  }
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                                  // filter: none
    Buffer.from(buf.buffer, buf.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodeRgba(bytes) {
  const png = Buffer.from(bytes);
  const { w, h, ihdr, idat } = walkChunks(png);
  const depth = ihdr[8], colour = ihdr[9];
  const compression = ihdr[10], filterMethod = ihdr[11], interlace = ihdr[12];
  if (depth !== 8) throw new Error(`png: bit depth ${depth} unsupported (need 8)`);
  if (colour !== 6 && colour !== 2) throw new Error(`png: colour type ${colour} unsupported (need 2 or 6)`);
  // Every field IHDR declares gets checked. The spec defines exactly one legal value
  // for each of these today -- but "the only legal value" and "the value we assumed
  // without looking" produce identical code and completely different failure modes.
  if (compression !== 0) throw new Error(`png: compression method ${compression} unsupported (need 0)`);
  if (filterMethod !== 0) throw new Error(`png: filter method ${filterMethod} unsupported (need 0)`);
  if (interlace !== 0) throw new Error('png: interlaced images unsupported');

  const channels = colour === 6 ? 4 : 3;
  const stride = w * channels;
  const expected = (stride + 1) * h;
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected });
  } catch (cause) {
    if (cause?.code === 'ERR_BUFFER_TOO_LARGE' || /maxOutputLength/i.test(cause?.message ?? '')) {
      throw new Error(`png: IDAT inflates past what IHDR promises (${expected} bytes)`, { cause });
    }
    throw new Error(`png: IDAT does not inflate — the compressed pixel data is corrupt (${cause.message})`, { cause });
  }
  if (raw.length !== expected) {
    throw new Error(`png: IDAT inflates to ${raw.length} bytes, but IHDR promises ${expected}`);
  }

  const out = new Uint8Array(w * h * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 0xff;
      else if (filter === 2) line[i] = (line[i] + b) & 0xff;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) line[i] = (line[i] + paeth(a, b, c)) & 0xff;
      else if (filter !== 0) throw new Error(`png: unknown filter ${filter} on row ${y}`);
    }
    for (let x = 0; x < w; x++) {
      const s = x * channels, d = (y * w + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    line.copy(prev);
  }
  return { w, h, buf: out };
}
