import { writeFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { renderSharePng } from '../src/share.js';
import { validCharacter } from '../test/helpers.js';

const w = 900, h = 700;
const data = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 4;
  data[i] = 120 + (x % 120); data[i + 1] = 80 + (y % 100); data[i + 2] = 60; data[i + 3] = 255;
}
const photo = { bytes: jpeg.encode({ data, width: w, height: h }, 85).data, type: 'image/jpeg' };
const pet = {
  slug: 'x', name: process.argv[2] ?? 'Biscuit', species: process.argv[4] ?? 'dog', traits: ['greedy'], alterEgo: 'crime-boss',
  character: validCharacter(process.argv[3] ? { rapSheet: Array(5).fill('x'.repeat(10) + ' word'.repeat(26)) , alias: 'A'.repeat(59)} : {}),
};
for (const size of ['post', 'story']) {
  const t = performance.now();
  const { png, photoShown } = await renderSharePng(pet, photo, { size, host: 'alterpaw.vercel.app' });
  console.log(size, png.length, photoShown, Math.round(performance.now() - t));
  writeFileSync(`.scratch/${size}.png`, png);
}
