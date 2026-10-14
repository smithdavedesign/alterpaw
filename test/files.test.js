// M3: the byte formats of the bundle (src/files.js), checked with independent readers (test/png.js,
// test/formats.js and fflate).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import { encodePng, buildPdf, zipFiles } from '../src/files.js';
import { decodePng, pngSize, pngIdat, pngChunksValid, isPng } from './png.js';
import { readPdf, pdfPages, readZipDirectory } from './formats.js';

// A small RGB image with a different colour in every pixel, so filtering mistakes show.
function gradient(width, height) {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) rgb.set([(i * 37) & 255, (i * 91) & 255, (i * 13 + 7) & 255], i * 3);
  return rgb;
}

const readAll = async (stream) => new Uint8Array(await new Response(stream).arrayBuffer());

describe('encodePng', () => {
  test('writes an 8-bit RGB PNG that decodes back to the exact pixels, with valid chunk CRCs', async () => {
    const rgb = gradient(7, 5);
    const { png, idat } = await encodePng(7, 5, rgb);
    assert.ok(isPng(png));
    assert.ok(pngChunksValid(png), 'IHDR first, IEND last, every CRC right');
    assert.deepEqual(pngSize(png), { width: 7, height: 5 });
    assert.equal(png[8 + 8 + 9], 2, 'colour type 2: RGB, no alpha');
    const { pixels } = decodePng(png);
    for (let i = 0; i < 35; i++) assert.deepEqual([...pixels.subarray(i * 4, i * 4 + 3)], [...rgb.subarray(i * 3, i * 3 + 3)], `pixel ${i}`);
    assert.deepEqual(Buffer.from(idat), pngIdat(png), 'idat is the IDAT stream, for the PDF to reuse');
  });

  test('uses one PNG filter type per row that PDF predictors understand (0–4)', async () => {
    const { idat } = await encodePng(4, 3, gradient(4, 3));
    const raw = inflateSync(idat);
    for (let y = 0; y < 3; y++) assert.ok(raw[y * (4 * 3 + 1)] <= 4);
  });

  test('refuses pixel data that does not match the size', async () => {
    await assert.rejects(encodePng(4, 4, new Uint8Array(10)), RangeError);
  });
});

describe('buildPdf', () => {
  test('one page per image, each 8×10 in, drawing the PNG data as-is, readable through its xref', async () => {
    const a = await encodePng(6, 4, gradient(6, 4));
    const b = await encodePng(3, 5, gradient(3, 5));
    const pdf = buildPdf(
      [
        { width: 6, height: 4, idat: a.idat },
        { width: 3, height: 5, idat: b.idat },
      ],
      { width: 576, height: 720 },
    );
    const doc = readPdf(pdf);
    const pages = pdfPages(doc);
    assert.equal(pages.length, 2);
    for (const [i, { width, idat }] of [
      { width: 6, idat: a.idat },
      { width: 3, idat: b.idat },
    ].entries()) {
      const page = pages[i];
      assert.deepEqual(page.mediaBox, [0, 0, 576, 720]);
      assert.equal(page.images.length, 1);
      const image = page.images[0];
      assert.match(page.content, new RegExp(`^q 576 0 0 720 0 0 cm /${image.name} Do Q\\s*$`), 'the image fills the page');
      assert.doesNotMatch(page.content, /\bBT\b|\bTj\b/, 'no text on the page');
      for (const key of [`/Width ${width}`, '/ColorSpace /DeviceRGB', '/BitsPerComponent 8', '/Filter /FlateDecode']) {
        assert.ok(image.object.dict.includes(key), key);
      }
      assert.match(image.object.dict, new RegExp(`/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns ${width} >>`));
      assert.deepEqual(Buffer.from(image.object.stream), Buffer.from(idat), "the PNG's compressed rows, byte for byte");
    }
    assert.match(doc.trailer, /\/Info \d+ 0 R/);
  });

  test('refuses an empty page list', () => {
    assert.throws(() => buildPdf([], { width: 576, height: 720 }), RangeError);
  });
});

describe('zipFiles', () => {
  const files = [
    { name: 'alterpaw-1-wanted-poster.png', bytes: new Uint8Array([1, 2, 3, 250, 0, 9]) },
    { name: 'alterpaw-bundle.pdf', bytes: new TextEncoder().encode('%PDF-1.4 not really') },
    { name: 'empty.txt', bytes: new Uint8Array() },
  ];
  const date = new Date(2026, 9, 13, 14, 30, 20); // local time: zip timestamps have no time zone

  test('streams a zip of stored entries whose size is known up front', async () => {
    const { stream, size } = zipFiles(files, { date });
    assert.ok(stream instanceof ReadableStream, 'a stream, so hosts with a buffered-response cap pass it through');
    const zip = await readAll(stream);
    assert.equal(zip.length, size);
    const unzipped = unzipSync(zip);
    assert.deepEqual(Object.keys(unzipped), files.map((f) => f.name));
    for (const f of files) assert.deepEqual(Buffer.from(unzipped[f.name]), Buffer.from(f.bytes), f.name);
  });

  test('every entry is stored (PNG and PDF are already compressed) with a correct CRC and the given date', async () => {
    const zip = await readAll(zipFiles(files, { date }).stream);
    const entries = readZipDirectory(zip);
    assert.deepEqual(entries.map((e) => e.name), files.map((f) => f.name));
    for (const e of entries) {
      assert.equal(e.method, 0);
      assert.equal(e.size, e.compressedSize);
    }
    const buf = Buffer.from(zip);
    const centralAt = buf.readUInt32LE(buf.length - 22 + 16);
    // Local header: time at 10, date at 12. Central directory header: time at 12, date at 14.
    for (const [timeAt, dateAt] of [
      [10, 12],
      [centralAt + 12, centralAt + 14],
    ]) {
      const dosDate = buf.readUInt16LE(dateAt);
      const dosTime = buf.readUInt16LE(timeAt);
      assert.deepEqual([1980 + (dosDate >> 9), (dosDate >> 5) & 15, dosDate & 31], [2026, 10, 13]);
      assert.deepEqual([dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2], [14, 30, 20]);
    }
  });

  test('refuses file names that could escape the folder or need encoding', () => {
    for (const name of ['../evil.png', '/abs.png', 'dir/file.png', 'naïve.png', '', 'a\\b.png']) {
      assert.throws(() => zipFiles([{ name, bytes: new Uint8Array(1) }], { date }), RangeError, name);
    }
  });
});
