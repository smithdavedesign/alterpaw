// Go-live: search and sharing tags, robots.txt and the sitemap, the 1200×630 share image, the footer's
// privacy and terms pages, the Buy button only when payments are on, and where the visit beacon is loaded.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, createPreview, fakeCheckout, petForm } from './helpers.js';
import { pngSize } from './png.js';
import { depsFromEnv } from '../src/index.js';
import { PUBLIC_PAGES, OG_IMAGE, SIGNAL_ENDPOINT, ISSUES_URL, siteUrlFromEnv } from '../src/site.js';

const ORIGIN = 'https://alterpaw.example';
const PATHS = Object.values(PUBLIC_PAGES).map((p) => p.path);

const meta = (html, attr, key) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)">`))?.[1];
const decode = (s) => s?.replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');

async function page(app, path) {
  const res = await app.request(path);
  return { res, html: await res.text() };
}

describe('public pages: titles, descriptions, sharing tags, canonical URL and JSON-LD', () => {
  test('/, /privacy and /terms render, each with its own title and description', async () => {
    const { app } = makeApp({ siteUrl: ORIGIN });
    const titles = new Set();
    const descriptions = new Set();
    for (const path of PATHS) {
      const { res, html } = await page(app, path);
      assert.equal(res.status, 200, path);
      const title = decode(html.match(/<title>([^<]*)<\/title>/)?.[1]);
      const description = decode(meta(html, 'name', 'description'));
      assert.ok(title, `${path} has a title`);
      assert.ok(description && description.length >= 50, `${path} has a real description`);
      titles.add(title);
      descriptions.add(description);
      assert.match(html, /<meta name="robots" content="index, follow">/, `${path} is indexable`);
    }
    assert.equal(titles.size, PATHS.length, 'titles are unique');
    assert.equal(descriptions.size, PATHS.length, 'descriptions are unique');
  });

  test('each has Open Graph and Twitter card tags with the 1200×630 image, and a canonical URL', async () => {
    const { app } = makeApp({ siteUrl: ORIGIN });
    for (const path of PATHS) {
      const { html } = await page(app, path);
      const url = `${ORIGIN}${path}`;
      assert.ok(html.includes(`<link rel="canonical" href="${url}">`), `${path} canonical`);
      assert.equal(meta(html, 'property', 'og:url'), url);
      assert.equal(meta(html, 'property', 'og:type'), 'website');
      assert.equal(meta(html, 'property', 'og:site_name'), 'alterpaw');
      assert.equal(decode(meta(html, 'property', 'og:title')), decode(html.match(/<title>([^<]*)<\/title>/)[1]));
      assert.equal(decode(meta(html, 'property', 'og:description')), decode(meta(html, 'name', 'description')));
      assert.equal(meta(html, 'property', 'og:image'), `${ORIGIN}/og.png`);
      assert.equal(meta(html, 'property', 'og:image:width'), '1200');
      assert.equal(meta(html, 'property', 'og:image:height'), '630');
      assert.ok(meta(html, 'property', 'og:image:alt'));
      assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
      assert.equal(meta(html, 'name', 'twitter:image'), `${ORIGIN}/og.png`);
      assert.ok(meta(html, 'name', 'twitter:title'));
      assert.ok(meta(html, 'name', 'twitter:description'));
    }
  });

  test('each carries SoftwareApplication JSON-LD that parses and points at the site', async () => {
    const { app } = makeApp({ siteUrl: ORIGIN });
    for (const path of PATHS) {
      const { html } = await page(app, path);
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)];
      assert.equal(blocks.length, 1, `${path} has one JSON-LD block`);
      const data = JSON.parse(blocks[0][1]);
      assert.equal(data['@context'], 'https://schema.org');
      assert.equal(data['@type'], 'SoftwareApplication');
      assert.equal(data.name, 'alterpaw');
      assert.equal(data.url, `${ORIGIN}/`);
      assert.equal(data.image, `${ORIGIN}/og.png`);
      assert.ok(data.applicationCategory && data.operatingSystem);
      const offers = [data.offers].flat();
      assert.ok(offers.some((o) => o.price === '0' && o.priceCurrency === 'USD'), 'the free preview');
      assert.ok(offers.some((o) => o.price === '9.00' && o.priceCurrency === 'USD'), 'the $9 bundle');
    }
  });

  test('without a configured site URL the tags use the request origin', async () => {
    const { app } = makeApp();
    const { html } = await page(app, '/privacy');
    assert.ok(html.includes('<link rel="canonical" href="http://localhost/privacy">'));
    assert.equal(meta(html, 'property', 'og:image'), 'http://localhost/og.png');
  });

  test("private pages (previews, 404) get none of it: they stay noindex and aren't canonicalised", async () => {
    const { app } = makeApp({ siteUrl: ORIGIN });
    const slug = await createPreview(app);
    for (const path of [`/p/${slug}`, '/nope']) {
      const { html } = await page(app, path);
      assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
      assert.ok(!html.includes('rel="canonical"'), path);
      assert.ok(!html.includes('og:image'), path);
      assert.ok(!html.includes('application/ld+json'), path);
    }
  });
});

describe('VERCEL_PROJECT_PRODUCTION_URL sets the canonical origin', () => {
  test('a bare host becomes https://host; anything else is ignored', () => {
    assert.equal(siteUrlFromEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'alterpaw.vercel.app' }), 'https://alterpaw.vercel.app');
    assert.equal(siteUrlFromEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'www.alterpaw.com' }), 'https://www.alterpaw.com');
    for (const bad of [undefined, '', 'https://alterpaw.vercel.app', 'evil.example/path', 'a b.example', '"><x', 'localhost']) {
      assert.equal(siteUrlFromEnv({ VERCEL_PROJECT_PRODUCTION_URL: bad }), null, String(bad));
    }
  });

  test('depsFromEnv passes it to the app', async () => {
    const deps = depsFromEnv({ VERCEL_PROJECT_PRODUCTION_URL: 'alterpaw.vercel.app' });
    assert.equal(deps.siteUrl, 'https://alterpaw.vercel.app');
    assert.equal(depsFromEnv({}).siteUrl, null);
  });
});

describe('robots.txt and sitemap.xml', () => {
  test('robots.txt allows indexing and points at the sitemap', async () => {
    const { app } = makeApp({ siteUrl: ORIGIN });
    const res = await app.request('/robots.txt');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
    const body = await res.text();
    assert.match(body, /^User-agent: \*$/m);
    assert.match(body, /^Allow: \/$/m);
    assert.doesNotMatch(body, /^Disallow: \/\s*$/m, 'the site is not blocked');
    assert.match(body, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, 'm'));
  });

  test('sitemap.xml lists exactly the public pages, each of which answers 200 and is indexable', async () => {
    const { app } = makeApp({ siteUrl: ORIGIN });
    const res = await app.request('/sitemap.xml');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /xml/);
    const xml = await res.text();
    assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    assert.deepEqual(locs.sort(), PATHS.map((p) => `${ORIGIN}${p}`).sort());
    for (const loc of locs) {
      const { res: pageRes, html } = await page(app, new URL(loc).pathname);
      assert.equal(pageRes.status, 200, loc);
      assert.match(html, /<meta name="robots" content="index, follow">/, loc);
    }
  });
});

describe('the share image', () => {
  test('GET /og.png is a 1200×630 PNG drawn by the app, cacheable, and rendered once', async () => {
    let renders = 0;
    const { renderOgPng } = await import('../src/share.js');
    const { app } = makeApp({
      renderOg: async () => {
        renders += 1;
        return renderOgPng();
      },
    });
    const res = await app.request('/og.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control') ?? '', /public/);
    const png = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(pngSize(png), { width: OG_IMAGE.width, height: OG_IMAGE.height });
    assert.deepEqual(pngSize(png), { width: 1200, height: 630 });
    assert.equal((await app.request('/og.png')).status, 200);
    assert.equal(renders, 1, 'the second request is served from memory');
  });

  test('other sites may embed it (Cross-Origin-Resource-Policy: cross-origin); everything else stays same-origin', async () => {
    const { app } = makeApp({ renderOg: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
    assert.equal((await app.request('/og.png')).headers.get('cross-origin-resource-policy'), 'cross-origin');
    for (const path of ['/', '/styles.css', '/robots.txt']) {
      assert.equal((await app.request(path)).headers.get('cross-origin-resource-policy'), 'same-origin', path);
    }
  });

  test('a failed render is a 500 and is retried on the next request', async () => {
    let calls = 0;
    const { app } = makeApp({
      renderOg: async () => {
        calls += 1;
        if (calls === 1) throw new Error('fonts unavailable');
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      },
    });
    assert.equal((await app.request('/og.png')).status, 500);
    assert.equal((await app.request('/og.png')).status, 200);
    assert.equal(calls, 2);
  });
});

describe('the footer links Privacy and Terms on every page', () => {
  test('home, privacy, terms, a preview, its 402 page and the 404 page', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app);
    for (const path of [...PATHS, `/p/${slug}`, `/p/${slug}/bundle.zip`, '/nope']) {
      const { html } = await page(app, path);
      const footer = html.match(/<footer class="site-foot">([\s\S]*?)<\/footer>/)?.[1] ?? '';
      assert.match(footer, /<a href="\/privacy">Privacy<\/a>/, path);
      assert.match(footer, /<a href="\/terms">Terms<\/a>/, path);
    }
  });

  test('/legal, the old combined page, moves permanently to /terms', async () => {
    const { app } = makeApp();
    const res = await app.request('/legal');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/terms');
  });
});

describe('/privacy', () => {
  test('says what is stored, that there are no cookies, the three visit signals, and how to get in touch', async () => {
    const { app } = makeApp();
    const { html } = await page(app, '/privacy');
    assert.match(html, /<h1>Privacy<\/h1>/);
    for (const text of [/photo/i, /30 days/, /Stripe/, /Gemini/, /Brevo/, /Prodigi/, /Neon/, /Vercel/]) assert.match(html, text, String(text));
    assert.match(html, /no cookies/i);
    for (const kind of ['visit', 'activate', 'checkout']) assert.match(html, new RegExp(`<code>${kind}</code>`), kind);
    assert.ok(html.includes(new URL(SIGNAL_ENDPOINT).host), 'names where the signals go');
    assert.match(html, /repohq:notrack/, 'how to switch it off');
    assert.ok(html.includes(`href="${ISSUES_URL}"`), 'contact through GitHub issues');
  });
});

describe('/terms', () => {
  test('covers the product, prices, refunds, no warranty and contact', async () => {
    const { app } = makeApp();
    const { html } = await page(app, '/terms');
    assert.match(html, /<h1>Terms<\/h1>/);
    for (const heading of ['Refunds', 'No warranty', 'Contact']) assert.match(html, new RegExp(`<h2[^>]*>${heading}`), heading);
    for (const text of [/\$9/, /\$29/, /30 days/, /parody/i, /gift/i, /printed poster/i, /United States/, /as is/i, /without warranty/i]) {
      assert.match(html, text, String(text));
    }
    assert.ok(html.includes(`href="${ISSUES_URL}"`));
    assert.ok(html.includes('href="/privacy"'), 'links to the privacy page');
  });
});

describe('the Buy button', () => {
  test('is hidden when payments are not configured (no STRIPE_SECRET_KEY): a note instead, no pay form', async () => {
    assert.equal(depsFromEnv({}).checkout, null, 'no key, no checkout');
    const { app } = makeApp();
    const slug = await createPreview(app);
    for (const path of [`/p/${slug}`, `/p/${slug}/bundle.zip`]) {
      const { html } = await page(app, path);
      assert.doesNotMatch(html, /action="\/checkout"/, path);
      assert.doesNotMatch(html, /Unlock for \$9/, path);
      assert.match(html, /Payments aren(?:'|&#39;)t switched on yet/, path);
    }
  });

  test('shows, marked for the checkout signal, when payments are configured', async () => {
    const { checkout } = fakeCheckout();
    const { app } = makeApp({ checkout });
    const slug = await createPreview(app);
    for (const path of [`/p/${slug}`, `/p/${slug}/bundle.zip`]) {
      const { html } = await page(app, path);
      assert.match(html, /<form method="post" action="\/checkout" data-checkout>/, path);
      assert.match(html, /Unlock for \$9/, path);
      assert.doesNotMatch(html, /switched on yet/, path);
    }
  });
});

describe('the visit beacon is loaded only on the production deployment', () => {
  test('depsFromEnv turns it on for VERCEL_ENV=production only', () => {
    assert.equal(depsFromEnv({ VERCEL_ENV: 'production' }).beacon, true);
    for (const env of [{}, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, { VERCEL_ENV: 'Production' }]) {
      assert.equal(depsFromEnv(env).beacon, false, JSON.stringify(env));
    }
  });

  test('on: public pages and previews load /beacon.js; off: no page does', async () => {
    const on = makeApp({ beacon: true, checkout: fakeCheckout().checkout });
    const off = makeApp({ checkout: fakeCheckout().checkout });
    const slugOn = await createPreview(on.app, petForm());
    const slugOff = await createPreview(off.app, petForm());
    const tag = '<script src="/beacon.js" defer></script>';
    for (const path of [...PATHS, `/p/${slugOn}`]) assert.ok((await page(on.app, path)).html.includes(tag), path);
    for (const path of [...PATHS, `/p/${slugOff}`]) assert.ok(!(await page(off.app, path)).html.includes('beacon.js'), path);
  });

  test('GET /beacon.js serves the script, which posts to the RepoHQ signal endpoint', async () => {
    const { app } = makeApp();
    const res = await app.request('/beacon.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /javascript/);
    const js = await res.text();
    assert.ok(js.includes(JSON.stringify(SIGNAL_ENDPOINT)));
    assert.doesNotThrow(() => new Function(js));
  });

  test('the CSP lets pages reach the signal endpoint and nothing else off-site', async () => {
    const { app } = makeApp();
    const csp = (await app.request('/')).headers.get('content-security-policy') ?? '';
    const connect = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
    assert.equal(connect, `connect-src 'self' ${new URL(SIGNAL_ENDPOINT).origin}`);
  });

  test('every pay form (bundle, gift, print) is marked for the checkout signal', async () => {
    const { readFileSync } = await import('node:fs');
    const views = readFileSync(new URL('../src/views.js', import.meta.url), 'utf8');
    for (const action of ['/checkout', '/gift', '/print']) {
      assert.match(views, new RegExp(`<form method="post" action="${action}"[^>]*data-checkout`), action);
    }
  });
});
