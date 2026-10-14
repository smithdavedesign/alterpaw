// M3: Stripe Checkout at $9, and the webhook that marks a preview paid.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeApp,
  createPreview,
  fakeCheckout,
  fakeWebhookSecret,
  fakeStripeKey,
  fakeSessionId,
  stripeEvent,
  stripeSignature,
  postWebhook,
  postForm,
  postJson,
  payFor,
  petRecord,
  DAY_MS,
} from './helpers.js';
import {
  createStripeCheckout,
  verifyStripeEvent,
  PaymentError,
  SignatureError,
  PRICE_CENTS,
  CURRENCY,
  SIGNATURE_TOLERANCE_SECONDS,
} from '../src/payments.js';
import { MAX_WEBHOOK_BYTES, REPORT_LIMIT } from '../src/app.js';

const SECRET = fakeWebhookSecret();
const nowSeconds = () => Math.floor(Date.now() / 1000);
const FIXED_NOW = new Date('2026-10-13T12:00:00Z');
const FIXED_SECONDS = FIXED_NOW.getTime() / 1000;

describe('POST /stripe/webhook (M3 exit criterion 2)', () => {
  test('a signed checkout.session.completed marks the order paid', async () => {
    const { app, store, logs } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    assert.equal((await store.getPet(slug)).paidAt, null, 'unpaid to start with');

    const res = await postWebhook(app, stripeEvent(slug), { secret: SECRET, timestamp: nowSeconds() });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
    const pet = await store.getPet(slug);
    assert.ok(pet.paidAt instanceof Date, 'paid');
    assert.equal(store.records.get(slug).stripeSession, fakeSessionId(1), 'the Stripe session is kept for refunds');
    assert.ok(logs.some((l) => l.startsWith('info') && l.includes(`preview ${slug} paid`)));
  });

  test('the same event delivered again (a Stripe retry) changes nothing', async () => {
    const { app, store } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    const event = stripeEvent(slug);
    const first = nowSeconds() - 60;
    assert.equal((await postWebhook(app, event, { secret: SECRET, timestamp: first })).status, 200);
    const before = structuredClone(store.records.get(slug));

    // Byte-for-byte the same request, then the same event re-signed later, as Stripe's retries are.
    assert.equal((await postWebhook(app, event, { secret: SECRET, timestamp: first })).status, 200);
    assert.equal((await postWebhook(app, event, { secret: SECRET, timestamp: nowSeconds() })).status, 200);
    assert.deepEqual(store.records.get(slug), before);
  });

  test('a second paid session for an already-paid preview changes nothing and is logged for a refund', async () => {
    const { app, store, logs } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    await payFor(app, slug, SECRET);
    const before = structuredClone(store.records.get(slug));
    const second = stripeEvent(slug, { id: 'evt_test_2', session: { id: fakeSessionId(2) } });
    assert.equal((await postWebhook(app, second, { secret: SECRET, timestamp: nowSeconds() })).status, 200);
    assert.deepEqual(store.records.get(slug), before);
    assert.ok(logs.some((l) => l.startsWith('warn') && l.includes('refund') && l.includes(fakeSessionId(2))));
  });

  test('an unsigned webhook changes nothing (400)', async () => {
    const { app, store, logs } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    const res = await postWebhook(app, stripeEvent(slug), { signature: null });
    assert.equal(res.status, 400);
    assert.equal((await store.getPet(slug)).paidAt, null);
    assert.ok(logs.some((l) => l.startsWith('warn') && l.includes('webhook')));
  });

  test('a wrong secret, a tampered body or a malformed header changes nothing (400)', async () => {
    const { app, store } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    const t = nowSeconds();
    const event = stripeEvent(slug);

    const wrongSecret = await postWebhook(app, event, { secret: fakeWebhookSecret('Z9y8X7w6'), timestamp: t });
    assert.equal(wrongSecret.status, 400, 'signed with another secret');

    const signedFor = JSON.stringify(stripeEvent(slug, { session: { payment_status: 'unpaid' } }));
    const tampered = await postWebhook(app, event, { signature: stripeSignature(signedFor, SECRET, t) });
    assert.equal(tampered.status, 400, 'signature of a different body');

    const v1 = stripeSignature(JSON.stringify(event), SECRET, t).split('v1=')[1];
    for (const header of ['', 'nonsense', `t=${t}`, `v1=${v1}`, `t=abc,v1=${v1}`, `t=${t},v0=${v1}`, `t=${t},v1=${v1.slice(0, 40)}`, `t=${t},v1=${'z'.repeat(64)}`]) {
      const res = await postWebhook(app, event, { signature: header });
      assert.equal(res.status, 400, JSON.stringify(header));
    }
    assert.equal((await store.getPet(slug)).paidAt, null);
  });

  test('a signature older or newer than 5 minutes is refused (replay protection)', async () => {
    const { app, store } = makeApp({ webhookSecret: SECRET, now: () => new Date(FIXED_NOW) });
    await store.createPet(petRecord({ createdAt: new Date(FIXED_NOW.getTime() - DAY_MS) }));
    const slug = petRecord().slug;
    assert.equal(SIGNATURE_TOLERANCE_SECONDS, 300);
    for (const offset of [-301, 301, -86_400]) {
      const res = await postWebhook(app, stripeEvent(slug), { secret: SECRET, timestamp: FIXED_SECONDS + offset });
      assert.equal(res.status, 400, `offset ${offset}`);
    }
    assert.equal((await store.getPet(slug)).paidAt, null);
    const fresh = await postWebhook(app, stripeEvent(slug), { secret: SECRET, timestamp: FIXED_SECONDS - 299 });
    assert.equal(fresh.status, 200);
    assert.equal((await store.getPet(slug)).paidAt.toISOString(), FIXED_NOW.toISOString(), 'paid at the app clock');
  });

  test('during a secret rotation any matching v1 signature is accepted; v0 is ignored', async () => {
    const { app, store } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    const t = nowSeconds();
    const body = JSON.stringify(stripeEvent(slug));
    const good = stripeSignature(body, SECRET, t).split('v1=')[1];
    const other = stripeSignature(body, fakeWebhookSecret('Q1w2E3r4'), t).split('v1=')[1];
    const res = await postWebhook(app, null, { body, signature: `t=${t},v1=${other},v1=${good},v0=${other}` });
    assert.equal(res.status, 200);
    assert.ok((await store.getPet(slug)).paidAt);
  });

  test('without STRIPE_WEBHOOK_SECRET the webhook refuses (503), says why in the log, and changes nothing', async () => {
    const { app, store, logs } = makeApp();
    const slug = await createPreview(app);
    const res = await postWebhook(app, stripeEvent(slug), { secret: SECRET, timestamp: nowSeconds() });
    assert.equal(res.status, 503);
    assert.equal((await store.getPet(slug)).paidAt, null);
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('STRIPE_WEBHOOK_SECRET')));
  });

  test('a completed session that is not paid yet is ignored; async_payment_succeeded then marks it paid', async () => {
    const { app, store } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    const pending = stripeEvent(slug, { session: { payment_status: 'unpaid' } });
    assert.equal((await postWebhook(app, pending, { secret: SECRET, timestamp: nowSeconds() })).status, 200);
    assert.equal((await store.getPet(slug)).paidAt, null, 'a bank debit still in flight is not paid');

    const succeeded = stripeEvent(slug, { type: 'checkout.session.async_payment_succeeded', id: 'evt_test_3' });
    assert.equal((await postWebhook(app, succeeded, { secret: SECRET, timestamp: nowSeconds() })).status, 200);
    assert.ok((await store.getPet(slug)).paidAt);
  });

  test('other event types are acknowledged and ignored', async () => {
    const { app, store } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    for (const type of ['checkout.session.expired', 'checkout.session.async_payment_failed', 'payment_intent.succeeded', 'charge.refunded']) {
      const res = await postWebhook(app, stripeEvent(slug, { type }), { secret: SECRET, timestamp: nowSeconds() });
      assert.equal(res.status, 200, type);
    }
    assert.equal((await store.getPet(slug)).paidAt, null);
  });

  test('a paid session for an unknown, missing or malformed slug is acknowledged (200) and logged for a refund', async () => {
    const { app, logs } = makeApp({ webhookSecret: SECRET });
    const cases = [
      stripeEvent('AAAAAAAAAAAAAAAAAAAAAA'),
      stripeEvent(null, { session: { metadata: {} } }),
      stripeEvent("x'; DROP TABLE pets; --"),
    ];
    for (const event of cases) {
      const res = await postWebhook(app, event, { secret: SECRET, timestamp: nowSeconds() });
      assert.equal(res.status, 200, JSON.stringify(event.data.object.client_reference_id));
    }
    assert.equal(logs.filter((l) => l.startsWith('error') && l.includes('refund')).length, 3);
  });

  test('the slug is taken from metadata when client_reference_id is absent', async () => {
    const { app, store } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    const event = stripeEvent(slug, { session: { client_reference_id: null } });
    assert.equal((await postWebhook(app, event, { secret: SECRET, timestamp: nowSeconds() })).status, 200);
    assert.ok((await store.getPet(slug)).paidAt);
  });

  test('client_reference_id alone unlocks nothing: a Payment Link lets the buyer set it from the URL', async () => {
    const { app, store, logs } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    const event = stripeEvent(slug, { session: { metadata: {}, amount_total: 100 } });
    assert.equal((await postWebhook(app, event, { secret: SECRET, timestamp: nowSeconds() })).status, 200);
    assert.equal((await store.getPet(slug)).paidAt, null);
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('refund')));
  });

  test('a paid session for another amount or currency unlocks nothing and is logged for review', async () => {
    const { app, store, logs } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    for (const session of [{ amount_total: 100 }, { currency: 'eur' }, { amount_total: '900' }]) {
      const res = await postWebhook(app, stripeEvent(slug, { session }), { secret: SECRET, timestamp: nowSeconds() });
      assert.equal(res.status, 200, JSON.stringify(session));
    }
    assert.equal((await store.getPet(slug)).paidAt, null);
    assert.equal(logs.filter((l) => l.startsWith('error') && l.includes('not the bundle price')).length, 3);
  });

  test('a payment for a preview that expired or was taken down meanwhile is recorded and logged for a refund', async () => {
    const { app, store, logs } = makeApp({ webhookSecret: SECRET, now: () => new Date(FIXED_NOW) });
    await store.createPet(petRecord({ slug: 'expired-paid-late-slug1', createdAt: new Date(FIXED_NOW.getTime() - 31 * DAY_MS) }));
    await store.createPet(petRecord({ slug: 'removed-paid-late-slug1', createdAt: new Date(FIXED_NOW.getTime() - DAY_MS) }));
    store.records.get('removed-paid-late-slug1').reports = REPORT_LIMIT;
    for (const slug of ['expired-paid-late-slug1', 'removed-paid-late-slug1']) {
      const res = await postWebhook(app, stripeEvent(slug), { secret: SECRET, timestamp: FIXED_SECONDS });
      assert.equal(res.status, 200, slug);
      assert.ok((await store.getPet(slug)).paidAt, `${slug}: the payment is on record`);
      assert.ok(
        logs.some((l) => l.startsWith('error') && l.includes(slug) && l.includes("can't download") && l.includes('refund')),
        `${slug}: logged for a refund`,
      );
    }
  });

  test('a store failure answers 500 so Stripe retries, without leaking internals', async () => {
    const { app, store, logs } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    store.markPaid = async () => {
      throw new Error('connection reset by Neon');
    };
    const res = await postWebhook(app, stripeEvent(slug), { secret: SECRET, timestamp: nowSeconds() });
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes('Neon'));
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('connection reset')));
  });

  test('a signed body that is not an event object is refused (400)', async () => {
    const { app } = makeApp({ webhookSecret: SECRET });
    for (const body of ['[]', 'null', '"text"', '{not json']) {
      const res = await postWebhook(app, null, { body, secret: SECRET, timestamp: nowSeconds() });
      assert.equal(res.status, 400, body);
    }
  });

  test('an oversized body is refused (413) before anything else', async () => {
    const { app } = makeApp({ webhookSecret: SECRET });
    assert.ok(MAX_WEBHOOK_BYTES >= 64 * 1024, 'room for any Checkout Session event');
    const body = 'x'.repeat(MAX_WEBHOOK_BYTES + 1);
    const res = await postWebhook(app, null, { body, secret: SECRET, timestamp: nowSeconds() });
    assert.equal(res.status, 413);
  });
});

describe('verifyStripeEvent', () => {
  test('returns the parsed event for a valid signature, from text or bytes', async () => {
    const event = stripeEvent('AbCdEfGhIjKlMnOpQrStUv');
    const body = JSON.stringify(event);
    const header = stripeSignature(body, SECRET, FIXED_SECONDS);
    assert.deepEqual(await verifyStripeEvent(body, header, SECRET, FIXED_NOW), event);
    assert.deepEqual(await verifyStripeEvent(new TextEncoder().encode(body), header, SECRET, FIXED_NOW), event);
  });

  test('signs the exact bytes: non-ASCII text in the body verifies', async () => {
    const event = stripeEvent('AbCdEfGhIjKlMnOpQrStUv', { session: { customer_details: { name: 'Zoë Łatka 猫' } } });
    const body = JSON.stringify(event);
    const header = stripeSignature(body, SECRET, FIXED_SECONDS);
    assert.deepEqual(await verifyStripeEvent(new TextEncoder().encode(body), header, SECRET, FIXED_NOW), event);
  });

  test('failures are SignatureErrors that never quote the secret', async () => {
    const body = JSON.stringify(stripeEvent('AbCdEfGhIjKlMnOpQrStUv'));
    const cases = [
      [undefined, 'missing header'],
      [stripeSignature(body, fakeWebhookSecret('Z9y8X7w6'), FIXED_SECONDS), 'wrong secret'],
      [stripeSignature(body, SECRET, FIXED_SECONDS - 3600), 'stale'],
    ];
    for (const [header, label] of cases) {
      await assert.rejects(verifyStripeEvent(body, header, SECRET, FIXED_NOW), (err) => {
        assert.ok(err instanceof SignatureError, label);
        assert.ok(!err.message.includes(SECRET), label);
        return true;
      });
    }
  });
});

describe('createStripeCheckout (Stripe Checkout at $9)', () => {
  const slug = 'AbCdEfGhIjKlMnOpQrStUv';
  const request = {
    slug,
    successUrl: `https://alterpaw.example/p/${slug}?checkout=success`,
    cancelUrl: `https://alterpaw.example/p/${slug}`,
  };

  function stripeFetch(respond) {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, init });
      return respond(url, init);
    };
    return { fetch, seen };
  }

  test('creates a one-off $9 Checkout Session tied to the preview', async () => {
    const key = fakeStripeKey();
    const { fetch, seen } = stripeFetch(() => Response.json({ id: fakeSessionId(7), url: `https://checkout.stripe.com/c/pay/${fakeSessionId(7)}` }));
    const checkout = createStripeCheckout({ secretKey: key, fetch });
    const session = await checkout(request);
    assert.deepEqual(session, { id: fakeSessionId(7), url: `https://checkout.stripe.com/c/pay/${fakeSessionId(7)}` });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers.authorization, `Bearer ${key}`);
    assert.equal(seen[0].init.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.ok(seen[0].init.signal, 'the request has a timeout');
    const params = new URLSearchParams(String(seen[0].init.body));
    assert.equal(PRICE_CENTS, 900);
    assert.equal(CURRENCY, 'usd');
    assert.equal(params.get('mode'), 'payment');
    assert.equal(params.get('line_items[0][quantity]'), '1');
    assert.equal(params.get('line_items[0][price_data][currency]'), 'usd');
    assert.equal(params.get('line_items[0][price_data][unit_amount]'), '900');
    assert.ok(params.get('line_items[0][price_data][product_data][name]'), 'a product name');
    assert.equal(params.get('client_reference_id'), slug);
    assert.equal(params.get('metadata[slug]'), slug);
    assert.equal(params.get('success_url'), request.successUrl);
    assert.equal(params.get('cancel_url'), request.cancelUrl);
    assert.equal(params.get('expires_at'), null, 'Stripe default (24 h) unless asked');
  });

  test('closes the session when asked (expires_at, in Unix seconds)', async () => {
    const { fetch, seen } = stripeFetch(() => Response.json({ id: fakeSessionId(7), url: `https://checkout.stripe.com/c/pay/${fakeSessionId(7)}` }));
    const expiresAt = new Date('2026-10-14T09:30:00Z');
    await createStripeCheckout({ secretKey: fakeStripeKey(), fetch })({ ...request, expiresAt });
    assert.equal(new URLSearchParams(String(seen[0].init.body)).get('expires_at'), String(expiresAt.getTime() / 1000));
  });

  test("Stripe errors become PaymentErrors that never include the key or Stripe's error text", async () => {
    const key = fakeStripeKey();
    const failures = [
      () => Response.json({ error: { message: `Invalid API Key provided: ${key}` } }, { status: 401 }),
      () => new Response('upstream error', { status: 500 }),
      () => new Response('not json', { status: 200 }),
      () => Response.json({ id: fakeSessionId(1) }),
      () => Response.json({ id: fakeSessionId(1), url: 'http://checkout.stripe.com/insecure' }),
      () => Response.json({ id: fakeSessionId(1), url: 'javascript:alert(1)' }),
      // A custom Checkout domain would be blocked by the pay form's CSP form-action: fail loudly instead.
      () => Response.json({ id: fakeSessionId(1), url: 'https://pay.example.com/c/pay/x' }),
      () => {
        throw new TypeError(`fetch failed for ${key}`);
      },
    ];
    for (const [i, respond] of failures.entries()) {
      const checkout = createStripeCheckout({ secretKey: key, fetch: stripeFetch(respond).fetch });
      await assert.rejects(checkout(request), (err) => {
        assert.ok(err instanceof PaymentError, `case ${i}: ${err}`);
        assert.ok(!err.message.includes(key), `case ${i}: key not in the message`);
        assert.ok(!err.message.includes('Invalid API Key'), `case ${i}: Stripe's text not echoed`);
        return true;
      });
    }
  });
});

describe('POST /checkout', () => {
  test('a same-origin form post creates a session and redirects (303) to Stripe Checkout', async () => {
    const { checkout, calls } = fakeCheckout();
    const { app } = makeApp({ checkout });
    const slug = await createPreview(app);
    const res = await postForm(app, 'https://alterpaw.example/checkout', { slug }, { origin: 'https://alterpaw.example' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `https://checkout.stripe.com/c/pay/${fakeSessionId(1)}`);
    assert.equal(calls.length, 1);
    const { expiresAt, ...urls } = calls[0];
    assert.deepEqual(urls, {
      slug,
      successUrl: `https://alterpaw.example/p/${slug}?checkout=success`,
      cancelUrl: `https://alterpaw.example/p/${slug}`,
    });
    assert.ok(expiresAt instanceof Date);
  });

  test('the checkout closes when the preview expires, so nobody can pay for a preview that is gone', async () => {
    const { checkout, calls } = fakeCheckout();
    const now = new Date('2026-10-13T12:00:00Z');
    const { app, store } = makeApp({ checkout, now: () => now });
    const fresh = 'fresh-preview-slug-0001';
    const lastDay = 'last-day-preview-slug01';
    const lastMinutes = 'last-minutes-slug-00001';
    await store.createPet(petRecord({ slug: fresh, createdAt: now }));
    await store.createPet(petRecord({ slug: lastDay, createdAt: new Date(now.getTime() - 29.5 * DAY_MS) }));
    await store.createPet(petRecord({ slug: lastMinutes, createdAt: new Date(now.getTime() - 30 * DAY_MS + 45 * 60 * 1000) }));

    assert.equal((await postForm(app, '/checkout', { slug: fresh })).status, 303);
    assert.equal(calls[0].expiresAt.getTime(), now.getTime() + DAY_MS, "Stripe's longest session: 24 h");
    assert.equal((await postForm(app, '/checkout', { slug: lastDay })).status, 303);
    assert.equal(calls[1].expiresAt.getTime(), now.getTime() + 0.5 * DAY_MS, 'closes when the preview expires');

    const late = await postForm(app, '/checkout', { slug: lastMinutes });
    assert.equal(late.status, 410, "under an hour left: too late to buy (Stripe's shortest session is 30 min)");
    assert.match(await late.text(), /expire/i);
    assert.equal(calls.length, 2);
  });

  test('a JSON client gets the Checkout URL instead of a redirect', async () => {
    const { checkout } = fakeCheckout();
    const { app } = makeApp({ checkout });
    const slug = await createPreview(app);
    const res = await postJson(app, '/checkout', { slug });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { url: `https://checkout.stripe.com/c/pay/${fakeSessionId(1)}` });
  });

  test('an already-paid preview goes back to its page, with no second session', async () => {
    const { checkout, calls } = fakeCheckout();
    const { app } = makeApp({ checkout, webhookSecret: SECRET });
    const slug = await createPreview(app);
    await payFor(app, slug, SECRET);
    const res = await postForm(app, '/checkout', { slug });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/p/${slug}`);
    assert.equal(calls.length, 0);
  });

  test('with payments not set up it answers 503 with a page, and logs why', async () => {
    const { app, logs } = makeApp();
    const slug = await createPreview(app);
    const res = await postForm(app, '/checkout', { slug });
    assert.equal(res.status, 503);
    assert.match(await res.text(), /<meta name="robots" content="[^"]*noindex/);
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('STRIPE_SECRET_KEY')));
  });

  test('when Stripe fails it answers 502 with a try-again page, and logs the reason', async () => {
    const checkout = async () => {
      throw new PaymentError('stripe responded 500');
    };
    const { app, logs } = makeApp({ checkout });
    const slug = await createPreview(app);
    const res = await postForm(app, '/checkout', { slug });
    assert.equal(res.status, 502);
    assert.match(await res.text(), /try again/i);
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('stripe responded 500')));
    const json = await postJson(app, '/checkout', { slug });
    assert.equal(json.status, 502);
    assert.ok((await json.json()).error);
  });

  test('malformed → 400, unknown → 404, expired or taken down → 410; no session in any case', async () => {
    const { checkout, calls } = fakeCheckout();
    const now = new Date();
    const { app, store } = makeApp({ checkout, now: () => now });
    await store.createPet(petRecord({ slug: 'expired-preview-slug-01', createdAt: new Date(now.getTime() - 31 * DAY_MS) }));
    await store.createPet(petRecord({ slug: 'removed-preview-slug-01' }));
    store.records.get('removed-preview-slug-01').reports = REPORT_LIMIT;

    assert.equal((await postForm(app, '/checkout', { slug: 'short' })).status, 400);
    assert.equal((await postForm(app, '/checkout', {})).status, 400);
    assert.equal((await postJson(app, '/checkout', { slug: 42 })).status, 400);
    assert.equal((await postJson(app, '/checkout', { slug: ['AAAAAAAAAAAAAAAAAAAAAA'] })).status, 400);
    assert.equal((await postForm(app, '/checkout', { slug: 'AAAAAAAAAAAAAAAAAAAAAA' })).status, 404);
    assert.equal((await postForm(app, '/checkout', { slug: 'expired-preview-slug-01' })).status, 410);
    assert.equal((await postForm(app, '/checkout', { slug: 'removed-preview-slug-01' })).status, 410);
    assert.equal(calls.length, 0);
  });

  test('cross-site posts are refused (403) whatever the content type', async () => {
    const { checkout, calls } = fakeCheckout();
    const { app } = makeApp({ checkout });
    const slug = await createPreview(app);
    assert.equal((await postForm(app, '/checkout', { slug }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postJson(app, '/checkout', { slug }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postForm(app, '/checkout', { slug }, { origin: null, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal(calls.length, 0);
  });

  test("the CSP lets the pay form's redirect reach Stripe Checkout (form-action), and nothing wider", async () => {
    const { app } = makeApp();
    const csp = (await app.request('/')).headers.get('content-security-policy') ?? '';
    const formAction = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('form-action'));
    assert.equal(formAction, "form-action 'self' https://checkout.stripe.com");
  });
});

describe('the $9 offer on an unpaid preview', () => {
  test('the preview has a pay form posting the slug to /checkout, the price, and a link to the terms', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app);
    const html = await (await app.request(`/p/${slug}`)).text();
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/checkout"/);
    assert.ok(html.includes(`<input type="hidden" name="slug" value="${slug}">`));
    assert.ok(html.includes('$9'), 'the price is shown');
    assert.match(html, /href="\/legal"/);
    assert.ok(!html.includes(`/p/${slug}/bundle.zip`), 'no download link before payment');
  });

  test('back from Stripe before the webhook: a "confirming" note; after it: the download', async () => {
    const { app } = makeApp({ webhookSecret: SECRET });
    const slug = await createPreview(app);
    const waiting = await (await app.request(`/p/${slug}?checkout=success`)).text();
    assert.match(waiting, /confirming your payment/i);
    assert.ok(waiting.includes(`href="/p/${slug}?checkout=success"`), 'a refresh link');
    const plain = await (await app.request(`/p/${slug}`)).text();
    assert.doesNotMatch(plain, /confirming your payment/i, 'only after returning from Stripe');

    await payFor(app, slug, SECRET);
    const paid = await (await app.request(`/p/${slug}?checkout=success`)).text();
    assert.doesNotMatch(paid, /confirming your payment/i);
    assert.ok(paid.includes(`href="/p/${slug}/bundle.zip"`));
  });
});

describe('GET /legal (terms, refunds, privacy)', () => {
  test('one indexable page covering terms, refunds and privacy, with the price and the 30-day deletion', async () => {
    const { app } = makeApp();
    const res = await app.request('/legal');
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const heading of ['Terms', 'Refunds', 'Privacy']) assert.match(html, new RegExp(`<h2[^>]*>${heading}`), heading);
    assert.ok(html.includes('$9'));
    assert.match(html, /30 days/);
    assert.match(html, /Stripe/);
    assert.match(html, /<meta name="robots" content="index/);
  });

  test('the home page links to it', async () => {
    const { app } = makeApp();
    const html = await (await app.request('/')).text();
    assert.match(html, /href="\/legal"/);
    assert.ok(html.includes('$9'), 'the home page says what the paid bundle costs');
  });
});
