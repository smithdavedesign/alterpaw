// Byte formats for the paid bundle, on node:zlib only (no PNG, PDF or ZIP library):
//   encodePng(width, height, rgb) → Promise<{ png, idat }>   8-bit RGB, one "Up" filter byte per row
//   buildPdf(pages, pageSize)     → Uint8Array                one full-page image per page
//   zipFiles(files, { date })     → { stream, size }          stored entries, streamed
//   streamOf(bytes)               → ReadableStream            one file, streamed in 1 MB views (M4 print file)
//
// The PDF embeds each PNG's IDAT stream as-is: PDF's FlateDecode with /Predictor 15 reads exactly PNG's
// filtered rows, so the images are compressed once and the PDF costs what the PNGs cost.
import { crc32, deflate } from 'node:zlib';
import { promisify } from 'node:util';

const deflateAsync = promisify(deflate); // runs on the libuv thread pool, off the main thread

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FILTER_UP = 2; // each byte minus the one above it: cheap, and good for both photos and flat colour

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export async function encodePng(width, height, rgb) {
  const stride = width * 3;
  if (rgb.length !== stride * height) throw new RangeError(`expected ${stride * height} bytes of RGB, got ${rgb.length}`);
  const rows = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const out = y * (stride + 1);
    const line = y * stride;
    rows[out] = FILTER_UP;
    if (y === 0) rows.set(rgb.subarray(0, stride), out + 1);
    else for (let x = 0; x < stride; x++) rows[out + 1 + x] = (rgb[line + x] - rgb[line - stride + x]) & 0xff;
  }
  const idat = new Uint8Array(await deflateAsync(rows));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits per channel
  ihdr[9] = 2; // RGB
  const png = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array())]);
  return { png: new Uint8Array(png.buffer, png.byteOffset, png.length), idat };
}

// pages: [{ width, height, idat }] (pixels and the PNG IDAT stream); pageSize in points (1/72 in).
// Each image is stretched to the full page, so pages should share the images' aspect ratio.
export function buildPdf(pages, { width: pageWidth, height: pageHeight }) {
  if (pages.length === 0) throw new RangeError('a PDF needs at least one page');
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk;
    parts.push(bytes);
    length += bytes.length;
  };
  const object = (n, dict, stream) => {
    offsets[n] = length;
    if (!stream) return push(`${n} 0 obj\n${dict}\nendobj\n`);
    push(`${n} 0 obj\n${dict.replace(/>>$/, `/Length ${stream.length} >>`)}\nstream\n`);
    push(stream);
    push('\nendstream\nendobj\n');
  };

  // 1 catalog, 2 page tree, 3 info, then three objects per page: page, contents, image.
  const pageNumber = (i) => 4 + i * 3;
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'); // the binary comment marks the file as binary for transfer tools
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageNumber(i)} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  object(3, '<< /Title (alterpaw bundle) /Producer (alterpaw) >>');
  pages.forEach(({ width, height, idat }, i) => {
    const n = pageNumber(i);
    object(
      n,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`,
    );
    object(n + 1, '<< >>', Buffer.from(`q ${pageWidth} 0 0 ${pageHeight} 0 0 cm /Im0 Do Q`, 'latin1'));
    object(
      n + 2,
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${width} >> >>`,
      idat,
    );
  });

  const size = offsets.length;
  const xrefAt = length;
  // Each xref entry is exactly 20 bytes, "nnnnnnnnnn ggggg n" plus a two-byte line end.
  const entries = ['0000000000 65535 f \n', ...offsets.slice(1).map((at) => `${String(at).padStart(10, '0')} 00000 n \n`)];
  push(`xref\n0 ${size}\n${entries.join('')}trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  const pdf = Buffer.concat(parts);
  return new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.length);
}

// Plain ASCII names with no folders: nothing a zip tool could write outside the folder it extracts to.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// MS-DOS date and time, in local time (zip timestamps have no time zone; servers run in UTC).
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// files: [{ name, bytes }]. Stored, not deflated: PNG and PDF are already compressed. Everything is built
// up front (so a failure happens before any byte is sent) and handed out as a stream with a known size,
// because some hosts cap buffered response bodies (Vercel: 4.5 MB) but not streamed ones.
export function zipFiles(files, { date = new Date() } = {}) {
  const { time, day } = dosDateTime(date);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, bytes } of files) {
    if (!SAFE_NAME.test(name)) throw new RangeError(`unsafe zip entry name: ${JSON.stringify(name)}`);
    const nameBytes = Buffer.from(name, 'ascii');
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(10, 4); // version needed: 1.0, stored
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, bytes);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by: 2.0
    entry.writeUInt16LE(10, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42); // extra, comment, disk and attributes stay 0
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const directorySize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);
  chunks.push(...central, end);

  const size = offset + directorySize + end.length;
  return { stream: streamChunks(chunks), size };
}

const STREAM_CHUNK = 1024 * 1024;

// A file that's already built, handed out as a stream for the same reason as the zip (buffered caps).
export function streamOf(bytes) {
  const chunks = [];
  for (let at = 0; at < bytes.length; at += STREAM_CHUNK) chunks.push(bytes.subarray(at, at + STREAM_CHUNK));
  return streamChunks(chunks);
}

function streamChunks(chunks) {
  let next = 0;
  return new ReadableStream({
    pull(controller) {
      if (next === chunks.length) return controller.close();
      const chunk = chunks[next++];
      controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length)); // a view, not a copy
    },
  });
}
