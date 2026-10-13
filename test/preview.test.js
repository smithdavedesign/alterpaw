import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, generate, petForm, validCharacter, pngBytes } from './helpers.js';

async function createPreview(options = {}, formOptions = {}) {
  const ctx = makeApp(options);
  const { res, body } = await generate(ctx.app, petForm(formOptions));
  assert.equal(res.status, 200, JSON.stringify(body));
  const page = await ctx.app.request(body.url);
  return { ...ctx, slug: body.slug, page, html: await page.text() };
}

describe('GET /p/<slug> (exit criterion 4)', () => {
  test('returns the pet name, the photo, 4 rendered cards and a noindex robots tag; slug is 12+ chars', async () => {
    const { slug, page, html } = await createPreview();

    assert.ok(slug.length >= 12, 'slug is 12+ chars');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);

    assert.ok(html.includes('Biscuit'), 'pet name on the page');
    assert.match(html, /<meta name="robots" content="[^"]*noindex[^"]*">/);
    assert.match(page.headers.get('x-robots-tag') ?? '', /noindex/);

    const cards = [...html.matchAll(/data-card="([a-z]+)"/g)].map((m) => m[1]);
    assert.deepEqual(cards, ['wanted', 'newspaper', 'trading', 'bio']);

    const photoSrc = `src="/p/${slug}/photo"`;
    assert.equal(html.split(photoSrc).length - 1, 4, 'the real photo appears in all 4 cards');
  });

  test('every card carries the preview watermark', async () => {
    const { html } = await createPreview();
    assert.equal(html.split('class="watermark"').length - 1, 4);
  });

  test('the cards show the generated story', async () => {
    const { html } = await createPreview();
    const c = validCharacter();
    for (const text of [c.headline, c.rapSheet[0], c.rapSheet[2], c.stats[0].label, c.bio.slice(0, 40)]) {
      assert.ok(html.includes(text), `page shows: ${text}`);
    }
    assert.ok(html.includes('Biscuit &quot;The Crumb&quot; Corleone'), 'alias shown (escaped)');
    assert.ok(html.includes('Crime boss'), 'alter ego label shown');
    for (const s of c.stats) assert.ok(html.includes(`>${s.value}<`), `stat value ${s.value} shown`);
  });

  test('the newspaper article renders one paragraph per paragraph', async () => {
    const reply = JSON.stringify(validCharacter({ article: 'Para one.\n\nPara two.\n\nPara three.' }));
    const { html } = await createPreview({ reply });
    assert.match(html, /<div class="article"><p>Para one\.<\/p><p>Para two\.<\/p><p>Para three\.<\/p><\/div>/);
  });

  test('slugs are unique and URL-safe across many previews', async () => {
    const { app } = makeApp();
    const slugs = new Set();
    for (let i = 0; i < 50; i++) {
      const { body } = await generate(app);
      assert.match(body.slug, /^[A-Za-z0-9_-]{12,}$/);
      slugs.add(body.slug);
    }
    assert.equal(slugs.size, 50);
  });
});

describe('escaping (exit criterion 3)', () => {
  test('a trait containing <script> appears escaped in the rendered page and not as an element', async () => {
    const { html } = await createPreview({}, { traits: ['<script>alert(1)</script>', 'loyal', 'greedy'] });
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'escaped text is shown');
    assert.ok(!html.includes('<script>alert(1)'), 'no raw script element');
    assert.ok(!/<script/i.test(html), 'the preview page contains no script elements at all');
  });

  test('HTML echoed back by the model is escaped too', async () => {
    const reply = JSON.stringify(
      validCharacter({
        bio: 'Known for <img src=x onerror=alert(1)> and <script>steal()</script>',
        headline: '<b>BREAKING</b>',
        rapSheet: ['<a href="javascript:alert(1)">click</a>', 'two', 'three'],
      }),
    );
    const { html } = await createPreview({ reply });
    assert.ok(!html.includes('<img src=x'), 'model HTML not rendered');
    assert.ok(!/<script/i.test(html));
    assert.ok(!html.includes('<b>BREAKING'));
    assert.ok(!html.includes('href="javascript:'));
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  });

  test('quotes in the name cannot break out of attributes', async () => {
    const { html } = await createPreview({}, { name: 'Bis"cuit\' onload="x' });
    assert.ok(!html.includes('onload="x'), 'no injected attribute');
    assert.ok(html.includes('Bis&quot;cuit&#39; onload=&quot;x'));
  });
});

describe('GET /p/<slug>/photo', () => {
  test('returns the uploaded bytes with the sniffed type and nosniff', async () => {
    const bytes = pngBytes(4096);
    const ctx = makeApp();
    const { body } = await generate(ctx.app, petForm({ photo: new File([bytes], 'p.jpg', { type: 'image/jpeg' }) }));
    const res = await ctx.app.request(`/p/${body.slug}/photo`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), Buffer.from(bytes));
  });

  test('an unknown slug returns 404', async () => {
    const { app } = makeApp();
    const res = await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA/photo');
    assert.equal(res.status, 404);
  });
});

describe('unknown and malformed slugs', () => {
  test('an unknown slug returns a 404 page that is also noindex', async () => {
    const { app } = makeApp();
    const res = await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /<meta name="robots" content="[^"]*noindex/);
  });

  test('short or odd slugs return 404 without touching the store', async () => {
    const { app, store } = makeApp();
    let lookups = 0;
    const original = store.getPet.bind(store);
    store.getPet = async (slug) => {
      lookups += 1;
      return original(slug);
    };
    for (const slug of ['abc', 'short-slug1', "x'%3B%20DROP%20TABLE%20pets%3B--aaaaaa", '%3Cscript%3Eaaaaaaaaaaaa']) {
      const res = await app.request(`/p/${slug}`);
      assert.equal(res.status, 404, slug);
    }
    assert.equal(lookups, 0);
  });
});

describe('storage errors on read', () => {
  test('a failing store shows an error page (500, noindex) instead of crashing', async () => {
    const { app, store } = makeApp();
    store.getPet = async () => {
      throw new Error('connection refused');
    };
    store.getPhoto = store.getPet;
    const page = await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(page.status, 500);
    const html = await page.text();
    assert.match(html, /Something went wrong/);
    assert.match(html, /<meta name="robots" content="[^"]*noindex/);
    assert.ok(!html.includes('connection refused'), 'internal error text is not leaked');
    const photo = await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA/photo');
    assert.equal(photo.status, 500);
  });
});

describe('security headers', () => {
  test('pages send a strict CSP, no-referrer and nosniff', async () => {
    const { page } = await createPreview();
    const csp = page.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  });

  test('previews are not cached by shared caches', async () => {
    const { page } = await createPreview();
    assert.match(page.headers.get('cache-control') ?? '', /private|no-store/);
  });
});
