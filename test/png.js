// Just enough PNG to check the share images: size from IHDR, RGBA pixels for 8-bit RGBA output, and real
// solid-colour photos (PNG via zlib, JPEG via jpeg-js) made at runtime so no binary fixtures sit in the repo.
import { deflateSync, inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (bytes) => Buffer.from(bytes.subarray(0, 8)).equals(SIGNATURE);

function chunks(bytes) {
  const buf = Buffer.from(bytes);
  const out = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    out.push({ type: buf.toString('latin1', at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

export function pngSize(bytes) {
  if (!isPng(bytes)) throw new Error('not a PNG');
  const ihdr = chunks(bytes)[0];
  if (ihdr.type !== 'IHDR') throw new Error('IHDR is not the first chunk');
  return { width: ihdr.data.readUInt32BE(0), height: ihdr.data.readUInt32BE(4) };
}

// Every chunk's CRC checks out and the file ends with IEND (viewers reject a PNG otherwise).
export function pngChunksValid(bytes) {
  const buf = Buffer.from(bytes);
  const types = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    const body = buf.subarray(at + 4, at + 8 + length);
    if (crc32(body) !== buf.readUInt32BE(at + 8 + length)) return false;
    types.push(body.toString('latin1', 0, 4));
    at += 12 + length;
  }
  return types[0] === 'IHDR' && types.at(-1) === 'IEND' && types.includes('IDAT');
}

// The concatenated IDAT data: the zlib stream of filtered scanlines.
export const pngIdat = (bytes) => Buffer.concat(chunks(bytes).filter((c) => c.type === 'IDAT').map((c) => c.data));

// Decodes 8-bit RGBA (what resvg writes) or 8-bit RGB (what the bundle writes), non-interlaced.
// `pixels` is always RGBA, so countColour works on both.
export function decodePng(bytes) {
  const all = chunks(bytes);
  const ihdr = all[0].data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const channels = { 2: 3, 6: 4 }[ihdr[9]];
  if (ihdr[8] !== 8 || !channels || ihdr[12] !== 0) throw new Error('expected 8-bit RGB or RGBA, not interlaced');
  const raw = inflateSync(pngIdat(bytes));
  if (raw.length !== (width * channels + 1) * height) throw new Error('IDAT size does not match IHDR');
  const stride = width * channels;
  const decoded = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) throw new Error(`bad filter type ${filter} on row ${y}`);
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? decoded[y * stride + x - channels] : 0;
      const b = y > 0 ? decoded[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? decoded[(y - 1) * stride + x - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      decoded[y * stride + x] = (line[x] + predicted) & 0xff;
    }
  }
  if (channels === 4) return { width, height, pixels: decoded };
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < decoded.length; i += 3, j += 4) {
    pixels[j] = decoded[i];
    pixels[j + 1] = decoded[i + 1];
    pixels[j + 2] = decoded[i + 2];
    pixels[j + 3] = 255;
  }
  return { width, height, pixels };
}

const near = (pixels, i, [r, g, b], tolerance) =>
  Math.abs(pixels[i] - r) <= tolerance && Math.abs(pixels[i + 1] - g) <= tolerance && Math.abs(pixels[i + 2] - b) <= tolerance;

// How many pixels are within `tolerance` of an RGB colour.
export function countColour({ pixels }, colour, tolerance = 16) {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4) if (near(pixels, i, colour, tolerance)) n++;
  return n;
}

// The smallest box around every pixel of a colour, and how much of that box the colour fills. A photo drawn
// whole fills its box; a stamp or watermark over it leaves holes.
export function colourBox({ width, pixels }, colour, tolerance = 16) {
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (!near(pixels, i, colour, tolerance)) continue;
    const x = (i / 4) % width;
    const y = Math.floor(i / 4 / width);
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    count++;
  }
  if (!count) return { width: 0, height: 0, count: 0, fill: 0 };
  const box = { width: right - left + 1, height: bottom - top + 1 };
  return { ...box, count, fill: count / (box.width * box.height) };
}

export function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function solidPng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set([r, g, b], y * (width * 3 + 1) + 1 + x * 3);
  }
  return new Uint8Array(
    Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]),
  );
}

export function solidJpeg(width, height, [r, g, b]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  return new Uint8Array(jpeg.encode({ data, width, height }, 90).data);
}
