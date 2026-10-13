// End-to-end over a real socket, through the same Node adapter the local dev server uses.
// Covers the Content-Length path of the upload limit, which in-process requests don't exercise.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { MB, makeApp, petForm, jpegBytes } from './helpers.js';

describe('over HTTP', () => {
  let server;
  let base;
  let ctx;

  before(async () => {
    ctx = makeApp();
    await new Promise((resolve) => {
      server = serve({ fetch: ctx.app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        base = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
  });

  after(() => {
    // Drop fetch's keep-alive sockets so close() completes.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  });

  test('upload → 200 JSON → preview page → photo', async () => {
    const res = await fetch(`${base}/generate`, { method: 'POST', body: petForm() });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.slug.length >= 12);

    const page = await fetch(base + body.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('Biscuit'));
    assert.match(html, /noindex/);

    const photo = await fetch(`${base}${body.url}/photo`);
    assert.equal(photo.status, 200);
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  });

  test('a body declared over the limit is refused with 400 before it is read', async () => {
    const photo = new File([jpegBytes(12 * MB)], 'huge.jpg', { type: 'image/jpeg' });
    const res = await fetch(`${base}/generate`, { method: 'POST', body: petForm({ photo }) });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /10 MB/);
  });

  test('share.png streams a whole PNG of the stated size through the Node adapter', async () => {
    const { pngSize } = await import('./png.js');
    const { slug } = await (await fetch(`${base}/generate`, { method: 'POST', body: petForm() })).json();
    const res = await fetch(`${base}/p/${slug}/share.png?size=story`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length') ?? bytes.length), bytes.length);
    assert.deepEqual(pngSize(bytes), { width: 1080, height: 1920 });
  });

  test('the report form posts same-origin over a real socket; with no proxy headers every reporter is one person', async () => {
    const { slug } = await (await fetch(`${base}/generate`, { method: 'POST', body: petForm() })).json();
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/report`, { method: 'POST', body: new URLSearchParams({ slug }), headers: { origin: base } });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Thanks/);
    }
    assert.equal((await ctx.store.getPet(slug)).reports, 1);
    assert.equal((await fetch(`${base}/p/${slug}`)).status, 200);
  });

  test('a non-image over HTTP is refused with 400', async () => {
    const photo = new File(['hello'], 'pet.png', { type: 'image/png' });
    const res = await fetch(`${base}/generate`, { method: 'POST', body: petForm({ photo }) });
    assert.equal(res.status, 400);
  });
});
