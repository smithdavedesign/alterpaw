// Its own file, so it runs in a fresh process where the renderer hasn't loaded anything yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderSharePng } from '../src/share.js';
import { validCharacter } from './helpers.js';
import { pngSize } from './png.js';

const pet = { slug: 'AbCdEfGhIjKlMnOpQrStUv', name: 'Biscuit', species: 'dog', traits: [], alterEgo: 'crime-boss', character: validCharacter() };

test('a font read that fails once is retried on the next render, without re-initialising the wasm', async () => {
  let failures = 0;
  const flakyRead = async (url) => {
    if (String(url).endsWith('rye-latin-400-normal.woff') && failures === 0) {
      failures += 1;
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    }
    return readFile(url);
  };
  await assert.rejects(renderSharePng(pet, null, { size: 'post', host: 'h', read: flakyRead }), /EMFILE/);
  // resvg's initWasm throws "Already initialized" if called twice; the second render must not call it again.
  const { png } = await renderSharePng(pet, null, { size: 'post', host: 'h', read: flakyRead });
  assert.deepEqual(pngSize(png), { width: 1080, height: 1350 });
  assert.equal(failures, 1);
});
