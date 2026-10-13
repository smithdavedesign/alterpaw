import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from './helpers.js';
import { ALTER_EGOS } from '../src/character.js';

describe('GET / — upload form', () => {
  test('has the photo, name, species, 3 trait fields and the 6 alter egos, posting to /generate', async () => {
    const { app } = makeApp();
    const res = await app.request('/');
    assert.equal(res.status, 200);
    const html = await res.text();

    assert.match(html, /<form[^>]*action="\/generate"[^>]*method="post"[^>]*enctype="multipart\/form-data"/);
    assert.match(html, /<input[^>]*type="file"[^>]*name="photo"[^>]*accept="image\/\*"[^>]*required/);
    assert.match(html, /<input[^>]*name="name"[^>]*maxlength="30"[^>]*required/);
    assert.match(html, /<select[^>]*name="species"/);
    for (const species of ['dog', 'cat', 'other']) assert.match(html, new RegExp(`<option value="${species}"`));
    assert.equal(html.split('name="traits"').length - 1, 3, 'three trait inputs');
    assert.match(html, /data-trait="/, 'trait suggestion chips');

    assert.equal(ALTER_EGOS.length, 6);
    for (const ego of ALTER_EGOS) {
      assert.match(html, new RegExp(`<input[^>]*type="radio"[^>]*name="alterEgo"[^>]*value="${ego.id}"`));
      assert.ok(html.includes(ego.label));
    }
    assert.match(html, /<script src="\/upload\.js" defer><\/script>/);
    assert.match(html, /<link rel="stylesheet" href="\/styles\.css">/);
  });

  test('the alter egos include the four named in the PRD', () => {
    const labels = ALTER_EGOS.map((e) => e.label.toLowerCase());
    for (const name of ['crime boss', 'corrupt ceo', 'washed-up rock star', 'celebrity chef']) {
      assert.ok(labels.includes(name), name);
    }
  });
});

describe('static assets', () => {
  test('GET /upload.js serves the client script', async () => {
    const { app } = makeApp();
    const res = await app.request('/upload.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    const js = await res.text();
    assert.ok(js.includes('/generate'), 'posts to /generate');
    assert.ok(js.includes('toBlob'), 'resizes the photo in the browser');
    // The script must parse as standalone JavaScript.
    assert.doesNotThrow(() => new Function(js));
  });

  test('GET /styles.css serves the stylesheet', async () => {
    const { app } = makeApp();
    const res = await app.request('/styles.css');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/css/);
    const css = await res.text();
    for (const card of ['card-wanted', 'card-newspaper', 'card-trading', 'card-bio', 'watermark']) {
      assert.ok(css.includes(`.${card}`), card);
    }
  });

  test('unknown routes return 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/nope');
    assert.equal(res.status, 404);
  });
});
