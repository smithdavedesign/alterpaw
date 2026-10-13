import satori from 'satori';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const font = readFileSync('node_modules/@fontsource/roboto-slab/files/roboto-slab-latin-400-normal.woff');
const fonts = [{ name: 'slab', data: font, weight: 400, style: 'normal' }];

async function run(label, src) {
  const t0 = performance.now();
  try {
    const svg = await satori(
      { type: 'div', props: { style: { display: 'flex', flexDirection: 'column', width: 1080, height: 1350, background: '#ead9b5' }, children: [
        { type: 'div', props: { style: { fontSize: 80 }, children: 'WANTED' } },
        { type: 'img', props: { src, width: 800, height: 600, style: { objectFit: 'cover' } } },
      ] } },
      { width: 1080, height: 1350, fonts },
    );
    const t1 = performance.now();
    const r = new Resvg(svg, { fitTo: { mode: 'original' } });
    const img = r.render();
    const png = img.asPng();
    const t2 = performance.now();
    // pixel inside image area (x=100,y=400)
    const px = img.pixels;
    const i = (400 * img.width + 100) * 4;
    console.log(label, 'ok', img.width, img.height, png.length, 'satori', Math.round(t1 - t0), 'resvg', Math.round(t2 - t1), 'px', px[i], px[i + 1], px[i + 2], px[i + 3]);
  } catch (err) {
    console.log(label, 'ERR', err?.message ?? err);
  }
}

const red = solidPng(64, 48, [220, 30, 30]);
await run('png', `data:image/png;base64,${red.toString('base64')}`);
const fakeJpeg = Buffer.alloc(2048); fakeJpeg.set([0xff, 0xd8, 0xff, 0xe0]);
for (let i = 4; i < 2048; i++) fakeJpeg[i] = i % 251;
await run('fakejpeg', `data:image/jpeg;base64,${fakeJpeg.toString('base64')}`);
const fakeWebp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 16, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(100)]);
await run('fakewebp', `data:image/webp;base64,${fakeWebp.toString('base64')}`);
const fakeGif = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(100)]);
await run('fakegif', `data:image/gif;base64,${fakeGif.toString('base64')}`);
await run('png-again', `data:image/png;base64,${red.toString('base64')}`);
