import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, createPreview, reportForm } from './helpers.js';
import { REPORT_LIMIT, REPORT_REASONS, REPORTER_KEY_BYTES, reporterNetwork } from '../src/app.js';

const statusOf = async (app, path) => (await app.request(path)).status;

describe('POST /report (M2 exit criterion 2)', () => {
  test('flags the record, and the preview returns 410 after 3 reports', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    assert.equal(REPORT_LIMIT, 3);

    for (const [i, ip] of ['198.51.100.1', '198.51.100.2'].entries()) {
      const res = await reportForm(app, slug, { ip });
      assert.equal(res.status, 200);
      assert.equal((await store.getPet(slug)).reports, i + 1, 'the record is flagged with the count');
      assert.equal(await statusOf(app, `/p/${slug}`), 200, `still visible after ${i + 1} report(s)`);
    }

    assert.equal((await reportForm(app, slug, { ip: '198.51.100.3' })).status, 200);
    assert.equal((await store.getPet(slug)).reports, 3);

    const page = await app.request(`/p/${slug}`);
    assert.equal(page.status, 410);
    const html = await page.text();
    assert.match(html, /taken down/i);
    assert.match(html, /<meta name="robots" content="[^"]*noindex/);
    assert.ok(!html.includes('Biscuit'), 'nothing from the removed preview is shown');
    assert.equal(await statusOf(app, `/p/${slug}/photo`), 410, 'the photo is hidden too');
    assert.equal(await statusOf(app, `/p/${slug}/share.png`), 410, 'and the share image');
  });

  test('one person reporting three times counts once', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    for (let i = 0; i < 3; i++) assert.equal((await reportForm(app, slug, { ip: '198.51.100.7' })).status, 200);
    assert.equal((await store.getPet(slug)).reports, 1);
    assert.equal(await statusOf(app, `/p/${slug}`), 200);
  });

  test('the client IP is the one the edge proxy appended, not one the client typed in front of it', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    for (const spoofed of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      await reportForm(app, slug, { ip: `${spoofed}, 198.51.100.9` });
    }
    assert.equal((await store.getPet(slug)).reports, 1);
  });

  test('the raw IP is never stored, only a short per-preview key that cannot be turned back into it', async () => {
    const { app, store } = makeApp();
    const slugs = [await createPreview(app), await createPreview(app)];
    for (const slug of slugs) await reportForm(app, slug, { ip: '198.51.100.42' });
    const keys = slugs.map((slug) => [...store.reports.get(slug).keys()][0]);
    const stored = JSON.stringify([...store.reports.values()].map((m) => [...m.entries()]));
    assert.ok(!stored.includes('198.51.100.42'));
    for (const key of keys) assert.match(key, new RegExp(`^[0-9a-f]{${REPORTER_KEY_BYTES * 2}}$`));
    assert.equal(REPORTER_KEY_BYTES, 3, '24 bits: ~256 IPv4 addresses share each key per preview');
    assert.notEqual(keys[0], keys[1], 'the same person gets unrelated keys on different previews');
  });

  test('an IPv6 /64 is one reporter; another /64 is another; IPv4-mapped addresses are plain IPv4', async () => {
    assert.equal(reporterNetwork('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(reporterNetwork('2001:0db8:0001:0002:ffff:ffff:ffff:fffe'), '2001:db8:1:2::/64');
    assert.equal(reporterNetwork('2001:db8::5'), '2001:db8:0:0::/64');
    assert.equal(reporterNetwork('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(reporterNetwork('::ffff:198.51.100.7'), '198.51.100.7');
    assert.equal(reporterNetwork('198.51.100.7'), '198.51.100.7');

    const { app, store } = makeApp();
    const slug = await createPreview(app);
    for (const ip of ['2001:db8:1:2::a', '2001:db8:1:2::b', '2001:db8:1:2:dead:beef:0:1']) await reportForm(app, slug, { ip });
    assert.equal((await store.getPet(slug)).reports, 1, 'rotating addresses inside one /64 counts once');
    await reportForm(app, slug, { ip: '2001:db8:1:3::a' });
    assert.equal((await store.getPet(slug)).reports, 2);
  });

  test('a form post gets a thank-you page; a JSON post gets JSON', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app);

    const page = await reportForm(app, slug);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.match(html, /Thanks/);
    assert.match(html, /<meta name="robots" content="[^"]*noindex/);

    const res = await app.request('/report', {
      method: 'POST',
      body: JSON.stringify({ slug, reason: 'not-a-pet' }),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-forwarded-for': '198.51.100.20' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, reports: 2 });
  });

  test('keeps a known reason and files anything else as "other"', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    assert.deepEqual(REPORT_REASONS.map((r) => r.id), ['not-a-pet', 'offensive', 'my-photo', 'other']);
    await reportForm(app, slug, { ip: '198.51.100.1', reason: 'my-photo' });
    await reportForm(app, slug, { ip: '198.51.100.2', reason: '<script>' });
    await reportForm(app, slug, { ip: '198.51.100.3', reason: null });
    const reasons = [...store.reports.get(slug).values()].map((r) => r.reason).sort();
    assert.deepEqual(reasons, ['my-photo', 'other', 'other']);
  });

  test('a cross-site form post is refused (403) and counts nothing', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    const res = await reportForm(app, slug, { origin: 'https://evil.example', headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.status, 403);
    const noOrigin = await reportForm(app, slug, { origin: null });
    assert.equal(noOrigin.status, 403, 'a form post with no Origin and no Sec-Fetch-Site is refused too');
    assert.equal((await store.getPet(slug)).reports, 0);
  });

  test('a cross-site JSON post is refused too (Hono\'s csrf() only checks form content types)', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    const postJson = (headers) =>
      app.request('/report', {
        method: 'POST',
        body: JSON.stringify({ slug }),
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-forwarded-for': '198.51.100.1', ...headers },
      });
    assert.equal((await postJson({ origin: 'https://evil.example' })).status, 403);
    assert.equal((await postJson({ 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await postJson({ origin: 'https://sub.localhost', 'sec-fetch-site': 'same-site' })).status, 403);
    assert.equal((await store.getPet(slug)).reports, 0);
    const same = await postJson({ origin: 'http://localhost', 'sec-fetch-site': 'same-origin' });
    assert.equal(same.status, 200, 'a same-origin JSON post still works');
    assert.equal((await store.getPet(slug)).reports, 1);
  });

  test('an oversized report is 413: a page for a form post, JSON for a JSON client', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    const huge = 'x'.repeat(9 * 1024);
    const form = await reportForm(app, slug, { reason: huge });
    assert.equal(form.status, 413);
    assert.match(form.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await form.text(), /<meta name="robots" content="[^"]*noindex/);
    const json = await app.request('/report', {
      method: 'POST',
      body: JSON.stringify({ slug, reason: huge }),
      headers: { 'content-type': 'application/json', accept: 'application/json', origin: 'http://localhost' },
    });
    assert.equal(json.status, 413);
    assert.equal(typeof (await json.json()).error, 'string');
    assert.equal((await store.getPet(slug)).reports, 0);
  });

  test('a browser that sends Origin: null is let through only with Sec-Fetch-Site: same-origin', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    const sameSite = await reportForm(app, slug, { origin: 'null', headers: { 'sec-fetch-site': 'same-origin' } });
    assert.equal(sameSite.status, 200);
    const bare = await reportForm(app, slug, { origin: 'null', ip: '198.51.100.99' });
    assert.equal(bare.status, 403, 'Origin: null alone could be a sandboxed frame on another site');
    assert.equal((await store.getPet(slug)).reports, 1);
  });

  test('the preview page asks for a same-origin referrer policy, so its form sends a real Origin', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app);
    const html = await (await app.request(`/p/${slug}`)).text();
    assert.ok(html.includes('<meta name="referrer" content="same-origin">'));
  });

  test('the same host behind a TLS-terminating proxy is still same-origin', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    const res = await app.request('http://alterpaw.example/report', {
      method: 'POST',
      body: new URLSearchParams({ slug }),
      headers: { origin: 'https://alterpaw.example', 'x-forwarded-for': '198.51.100.1' },
    });
    assert.equal(res.status, 200);
    assert.equal((await store.getPet(slug)).reports, 1);
  });

  test('a missing or malformed slug is 400; an unknown one is 404', async () => {
    const { app, store } = makeApp();
    let writes = 0;
    const original = store.reportPet.bind(store);
    store.reportPet = async (...args) => (writes++, original(...args));
    assert.equal((await reportForm(app, null)).status, 400);
    assert.equal((await reportForm(app, 'short')).status, 400);
    assert.equal((await reportForm(app, "x'; DROP TABLE pets; --aaaaaaaa")).status, 400);
    assert.equal(writes, 0, 'malformed slugs never reach the store');
    assert.equal((await reportForm(app, 'AAAAAAAAAAAAAAAAAAAAAA')).status, 404);
  });

  test('a body that is neither a form nor JSON is 400', async () => {
    const { app } = makeApp();
    const res = await app.request('/report', {
      method: 'POST',
      body: '{not json',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' },
    });
    assert.equal(res.status, 400);
  });

  test('reaching the limit is logged once, so David can review the preview', async () => {
    const { app, logs } = makeApp();
    const slug = await createPreview(app);
    // The third reporter resubmits (reload of the thanks page, double click) before a fourth person reports.
    for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3', '198.51.100.3', '198.51.100.3', '198.51.100.4']) {
      await reportForm(app, slug, { ip });
    }
    const hidden = logs.filter((l) => l.includes('hidden'));
    assert.equal(hidden.length, 1);
    assert.ok(hidden[0].includes(slug));
  });

  test('a storage failure is a 500, not a crash', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    store.reportPet = async () => {
      throw new Error('connection refused');
    };
    const res = await reportForm(app, slug);
    assert.equal(res.status, 500);
  });
});

describe('report link on the preview page', () => {
  test('every preview has a no-JS report form posting its slug to /report', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app);
    const html = await (await app.request(`/p/${slug}`)).text();
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/report"/);
    assert.ok(html.includes(`<input type="hidden" name="slug" value="${slug}">`));
    for (const reason of REPORT_REASONS) assert.ok(html.includes(`value="${reason.id}"`), reason.id);
    assert.match(html, /Report this page/);
  });
});
