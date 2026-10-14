// Readers for what the bundle writes, strict enough to catch a broken file: a PDF is read through its xref
// table (every offset must land on its object), and a zip through its central directory.
import { crc32 } from './png.js';

const latin1 = (buf, from, to) => buf.toString('latin1', from, to);

// → { objects: Map(number → { dict, stream }), trailer, size }. Throws on anything malformed.
export function readPdf(bytes) {
  const buf = Buffer.from(bytes);
  if (!latin1(buf, 0, 8).startsWith('%PDF-1.')) throw new Error('no %PDF header');
  const tail = latin1(buf, Math.max(0, buf.length - 64), buf.length);
  const end = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!end) throw new Error('no startxref / %%EOF at the end');
  const xrefAt = Number(end[1]);
  const head = latin1(buf, xrefAt, xrefAt + 32).match(/^xref\s+0 (\d+)\s+/);
  if (!head) throw new Error('startxref does not point at an xref table');
  const size = Number(head[1]);
  const entriesAt = xrefAt + head[0].length;
  const objects = new Map();
  for (let n = 0; n < size; n++) {
    const entry = latin1(buf, entriesAt + 20 * n, entriesAt + 20 * n + 20);
    if (!/^\d{10} \d{5} [nf](?: \r| \n|\r\n)$/.test(entry)) throw new Error(`xref entry ${n} is not 20 bytes: ${JSON.stringify(entry)}`);
    if (entry[17] !== 'n') continue;
    const offset = Number(entry.slice(0, 10));
    const window = latin1(buf, offset, offset + 4096);
    if (!window.startsWith(`${n} 0 obj`)) throw new Error(`xref offset of object ${n} does not land on it`);
    const streamAt = window.search(/>>\s*stream\r?\n/);
    const endobjAt = window.indexOf('endobj');
    if (streamAt !== -1 && (endobjAt === -1 || streamAt < endobjAt)) {
      const dict = window.slice(0, streamAt + 2);
      const length = Number(dict.match(/\/Length (\d+)/)?.[1]);
      const dataAt = offset + streamAt + window.slice(streamAt).match(/>>\s*stream\r?\n/)[0].length;
      const stream = buf.subarray(dataAt, dataAt + length);
      if (!/^\r?\n?endstream/.test(latin1(buf, dataAt + length, dataAt + length + 12))) {
        throw new Error(`object ${n}: /Length does not end at endstream`);
      }
      objects.set(n, { dict, stream });
    } else {
      objects.set(n, { dict: window.slice(0, endobjAt) });
    }
  }
  const trailer = latin1(buf, entriesAt + 20 * size, buf.length);
  if (!trailer.trimStart().startsWith('trailer')) throw new Error('no trailer after the xref table');
  if (Number(trailer.match(/\/Size (\d+)/)?.[1]) !== size) throw new Error('trailer /Size does not match the xref');
  return { objects, trailer, size };
}

const ref = (dict, key) => Number(dict.match(new RegExp(`/${key} (\\d+) 0 R`))?.[1]);

// The pages in order, each with its MediaBox, content stream and the image objects it draws.
export function pdfPages(pdf) {
  const root = pdf.objects.get(ref(pdf.trailer, 'Root'));
  if (!/\/Type \/Catalog/.test(root.dict)) throw new Error('/Root is not a catalog');
  const pages = pdf.objects.get(ref(root.dict, 'Pages'));
  const kids = [...pages.dict.match(/\/Kids \[([^\]]*)\]/)[1].matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  if (Number(pages.dict.match(/\/Count (\d+)/)[1]) !== kids.length) throw new Error('/Count does not match /Kids');
  return kids.map((n) => {
    const page = pdf.objects.get(n);
    if (!/\/Type \/Page\b(?!s)/.test(page.dict)) throw new Error(`object ${n} is not a page`);
    const mediaBox = page.dict.match(/\/MediaBox \[([^\]]*)\]/)[1].trim().split(/\s+/).map(Number);
    const content = pdf.objects.get(ref(page.dict, 'Contents')).stream.toString('latin1');
    const images = [...page.dict.matchAll(/\/(\w+) (\d+) 0 R/g)]
      .map(([, name, num]) => ({ name, object: pdf.objects.get(Number(num)) }))
      .filter(({ object }) => object && /\/Subtype \/Image/.test(object.dict));
    return { mediaBox, content, images };
  });
}

// Central directory of a zip → [{ name, method, crc, size, compressedSize, localOffset }], cross-checked
// against each local header and against a CRC computed here.
export function readZipDirectory(bytes) {
  const buf = Buffer.from(bytes);
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt === -1 || eocdAt !== buf.length - 22) throw new Error('no end-of-central-directory record at the end');
  const count = buf.readUInt16LE(eocdAt + 10);
  const dirSize = buf.readUInt32LE(eocdAt + 12);
  const dirAt = buf.readUInt32LE(eocdAt + 16);
  if (dirAt + dirSize !== eocdAt) throw new Error('central directory size/offset are inconsistent');
  const entries = [];
  for (let at = dirAt, i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`entry ${i}: bad central header signature`);
    const entry = {
      method: buf.readUInt16LE(at + 10),
      crc: buf.readUInt32LE(at + 16),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      localOffset: buf.readUInt32LE(at + 42),
    };
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    entry.name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extra;

    const local = entry.localOffset;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`${entry.name}: bad local header signature`);
    if (buf.readUInt32LE(local + 14) !== entry.crc) throw new Error(`${entry.name}: local and central CRC differ`);
    const dataAt = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (entry.method === 0 && crc32(buf.subarray(dataAt, dataAt + entry.size)) !== entry.crc) {
      throw new Error(`${entry.name}: CRC does not match the data`);
    }
    entries.push(entry);
  }
  return entries;
}
