// M3: one included text rewrite for a paid preview.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeApp,
  createPreview,
  payFor,
  fakeWebhookSecret,
  validCharacter,
  postForm,
  postJson,
  petRecord,
  DAY_MS,
} from './helpers.js';
import { REPORT_LIMIT } from '../src/app.js';

const SECRET = fakeWebhookSecret();

// The first model call writes the original; every later one a numbered rewrite.
function writer() {
  let n = 0;
  return () => JSON.stringify(validCharacter(n++ === 0 ? {} : { alias: `Rewrite No. ${n - 1}`, headline: `REWRITE ${n - 1}` }));
}

async function paidPreview(options = {}) {
  const ctx = makeApp({ webhookSecret: SECRET, reply: writer(), ...options });
  const slug = await createPreview(ctx.app);
  await payFor(ctx.app, slug, SECRET);
  return { ...ctx, slug };
}

describe('POST /regenerate (M3 exit criterion 4)', () => {
  test('succeeds once for a paid order and returns 409 the second time', async () => {
    const { app, store, slug, calls } = await paidPreview();
    assert.equal(calls.length, 1, 'the original');

    const first = await postJson(app, '/regenerate', { slug });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.character.alias, 'Rewrite No. 1');
    assert.equal(calls.length, 2, 'one model call for the rewrite');
    const pet = await store.getPet(slug);
    assert.equal(pet.character.alias, 'Rewrite No. 1', 'the new text is stored');
    assert.ok(pet.regeneratedAt instanceof Date);
    assert.equal(pet.name, 'Biscuit', 'the pet details are unchanged');

    const second = await postJson(app, '/regenerate', { slug });
    assert.equal(second.status, 409);
    assert.ok((await second.json()).error);
    assert.equal(calls.length, 2, 'no model call for a used rewrite');
    assert.equal((await store.getPet(slug)).character.alias, 'Rewrite No. 1');
  });

  test('the rewrite uses the stored pet details, and the page then shows the new text with the rewrite used', async () => {
    const { app, slug, calls } = await paidPreview();
    assert.equal((await postForm(app, '/regenerate', { slug })).status, 303);
    assert.equal(calls[1][1].content, calls[0][1].content, 'same name, species, traits and alter ego as the original');
    const html = await (await app.request(`/p/${slug}`)).text();
    assert.ok(html.includes('Rewrite No. 1'));
    assert.ok(!html.includes(validCharacter().alias.replace(/"/g, '&quot;')), 'the old alias is gone');
    assert.doesNotMatch(html, /action="\/regenerate"/, 'no rewrite button once it is used');
    assert.match(html, /rewrite (?:is )?used/i);
  });

  test('paying and rewriting change the share links, so a browser never reuses a cached stamped or old image', async () => {
    const ctx = makeApp({ webhookSecret: SECRET, reply: writer() });
    const slug = await createPreview(ctx.app);
    const shareLinks = async () =>
      [...(await (await ctx.app.request(`/p/${slug}`)).text()).matchAll(/href="(\/p\/[^"]*\/share\.png[^"]*)"/g)].map((m) => m[1]);

    const unpaid = await shareLinks();
    assert.deepEqual(unpaid, [`/p/${slug}/share.png`, `/p/${slug}/share.png?size=story`]);
    await payFor(ctx.app, slug, SECRET);
    const paid = await shareLinks();
    assert.equal(paid.length, 2);
    assert.match(paid[0], /^\/p\/[\w-]+\/share\.png\?v=[\w-]+$/);
    assert.match(paid[1], /^\/p\/[\w-]+\/share\.png\?size=story&amp;v=[\w-]+$/);
    assert.equal((await postJson(ctx.app, '/regenerate', { slug })).status, 200);
    const rewritten = await shareLinks();
    assert.notDeepEqual(rewritten, paid);
    for (const link of [...paid, ...rewritten]) {
      assert.equal((await ctx.app.request(link.replace('&amp;', '&'), { method: 'HEAD' })).status, 200, link);
    }
  });

  test('a form post redirects back to the preview (303)', async () => {
    const { app, slug } = await paidPreview();
    const res = await postForm(app, '/regenerate', { slug });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/p/${slug}`);
    const again = await postForm(app, '/regenerate', { slug });
    assert.equal(again.status, 409);
    assert.match(again.headers.get('content-type') ?? '', /text\/html/);
  });

  test('before payment it is 402 and the model is not called', async () => {
    const ctx = makeApp({ reply: writer() });
    const slug = await createPreview(ctx.app);
    const res = await postJson(ctx.app, '/regenerate', { slug });
    assert.equal(res.status, 402);
    assert.equal(ctx.calls.length, 1);
    assert.equal((await postForm(ctx.app, '/regenerate', { slug })).status, 402);
    const html = await (await ctx.app.request(`/p/${slug}`)).text();
    assert.doesNotMatch(html, /action="\/regenerate"/, 'no rewrite button before payment');
  });

  test('a model failure answers 502 and does not use up the rewrite', async () => {
    let fail = true;
    let n = 0;
    const reply = () => {
      if (n++ === 0) return JSON.stringify(validCharacter());
      return fail ? 'Sorry, I cannot help with that.' : JSON.stringify(validCharacter({ alias: 'Second try' }));
    };
    const { app, store, slug, logs } = await paidPreview({ reply });
    const res = await postJson(app, '/regenerate', { slug });
    assert.equal(res.status, 502);
    assert.equal((await store.getPet(slug)).regeneratedAt, null, 'still available');
    assert.equal((await store.getPet(slug)).character.alias, validCharacter().alias, 'the original text is kept');
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('regenerate')));

    fail = false;
    const retry = await postJson(app, '/regenerate', { slug });
    assert.equal(retry.status, 200);
  });

  test('a model call that throws is a 502 too', async () => {
    let calls = 0;
    const reply = () => {
      if (calls++ > 0) throw new Error('429 quota');
      return JSON.stringify(validCharacter());
    };
    const { app, store, slug } = await paidPreview({ reply });
    assert.equal((await postJson(app, '/regenerate', { slug })).status, 502);
    assert.equal((await store.getPet(slug)).regeneratedAt, null);
  });

  test('two rewrites at once: one succeeds, the other gets 409, and one text is stored', async () => {
    const { app, store, slug } = await paidPreview();
    const results = await Promise.all([postJson(app, '/regenerate', { slug }), postJson(app, '/regenerate', { slug })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = await results.find((r) => r.status === 200).json();
    assert.equal((await store.getPet(slug)).character.alias, winner.character.alias);
  });

  test('malformed → 400, unknown → 404, expired or taken down → 410; the model is never called', async () => {
    const now = new Date();
    const { app, store, calls } = makeApp({ now: () => now });
    await store.createPet(petRecord({ slug: 'expired-regen-slug-001', createdAt: new Date(now.getTime() - 31 * DAY_MS) }));
    await store.createPet(petRecord({ slug: 'removed-regen-slug-001' }));
    for (const slug of ['expired-regen-slug-001', 'removed-regen-slug-001']) await store.markPaid(slug, { sessionId: 'cs_x', at: now });
    store.records.get('removed-regen-slug-001').reports = REPORT_LIMIT;

    assert.equal((await postJson(app, '/regenerate', {})).status, 400);
    assert.equal((await postJson(app, '/regenerate', { slug: 'short' })).status, 400);
    assert.equal((await postJson(app, '/regenerate', { slug: 42 })).status, 400);
    assert.equal((await postJson(app, '/regenerate', { slug: 'AAAAAAAAAAAAAAAAAAAAAA' })).status, 404);
    assert.equal((await postJson(app, '/regenerate', { slug: 'expired-regen-slug-001' })).status, 410);
    assert.equal((await postJson(app, '/regenerate', { slug: 'removed-regen-slug-001' })).status, 410);
    assert.equal(calls.length, 0);
  });

  test('cross-site posts are refused (403) and the model is not called', async () => {
    const { app, slug, calls } = await paidPreview();
    assert.equal((await postForm(app, '/regenerate', { slug }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postJson(app, '/regenerate', { slug }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(calls.length, 1);
  });

  test('a store failure while saving is a 500, logged without internals', async () => {
    const { app, store, slug, logs } = await paidPreview();
    store.saveRegenerated = async () => {
      throw new Error('connection reset by Neon');
    };
    const res = await postJson(app, '/regenerate', { slug });
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes('Neon'));
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('connection reset')));
  });
});
