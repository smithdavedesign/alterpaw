// M4: the printed poster upsell. A paid preview's owner gives a US address, pays $29, and the webhook places one
// print-on-demand order (Prodigi) with that stored address.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';
import {
  makeApp,
  createPreview,
  petForm,
  payFor,
  fakeCheckout,
  fakeWebhookSecret,
  fakePrinter,
  fakeProdigiKey,
  addressFields,
  payOrder,
  postForm,
  postJson,
  testClock,
  validCharacter,
} from './helpers.js';
import { REPORT_LIMIT } from '../src/app.js';
import { PRODUCTS } from '../src/payments.js';
import { createProdigiPrinter, PrintError, PRINT_SKU, PRODIGI_URLS } from '../src/print.js';
import { parseShippingAddress, InputError, US_STATES } from '../src/input.js';
import { PRINT_POSTER_SIZE, renderPrintPoster } from '../src/bundle.js';
import { pngSize, decodePng, countColour, solidJpeg } from './png.js';
import { PGlite } from '@electric-sql/pglite';
import { PgStore } from '../src/store.js';

const SECRET = fakeWebhookSecret();
const SITE = 'https://alterpaw.example';
const BLUE = [30, 90, 200];

// The address the form posts, as it is stored and sent to the printer.
const STORED_ADDRESS = {
  name: 'Jamie Rivera',
  line1: '742 Evergreen Terrace',
  line2: 'Apt 2',
  city: 'Portland',
  state: 'OR',
  zip: '97201',
  country: 'US',
};

function printApp(options = {}) {
  const clock = testClock('2026-10-14T19:00:00Z');
  const printer = fakePrinter();
  const { checkout, calls } = fakeCheckout();
  const ctx = makeApp({ now: clock.now, checkout, webhookSecret: SECRET, printOrder: printer.printOrder, ...options });
  return { ...ctx, clock, printer, checkoutCalls: calls };
}

const postPrint = (app, fields, options = {}) => postForm(app, `${SITE}/print`, fields, { origin: SITE, ...options });

async function paidPreview(ctx, form = petForm()) {
  const slug = await createPreview(ctx.app, form);
  await payFor(ctx.app, slug, SECRET, ctx.clock.seconds());
  return slug;
}

// A paid preview, the print form, and the $29 payment.
async function buyPrint(ctx, overrides = {}) {
  const slug = await paidPreview(ctx);
  const res = await postPrint(ctx.app, addressFields(slug, overrides));
  assert.equal(res.status, 303, await res.clone().text());
  const request = ctx.checkoutCalls.at(-1);
  return { slug, request };
}

describe('a print order creates one print-on-demand order (M4 exit criterion 2)', () => {
  test('a paid print order creates one print-on-demand order with the stored shipping address', async () => {
    const ctx = printApp();
    const { slug, request } = await buyPrint(ctx);
    assert.equal(request.product, 'print');
    assert.equal(PRODUCTS.print.cents, 2900, '$29, inside the roadmap’s $24–$30');
    const stored = await ctx.store.getOrder(request.orderId);
    assert.deepEqual(stored.details, STORED_ADDRESS, 'the address is stored before payment');
    assert.equal(ctx.printer.calls.length, 0, 'nothing is printed before payment');

    await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2 });
    assert.equal(ctx.printer.calls.length, 1);
    assert.deepEqual(ctx.printer.calls[0], {
      orderId: request.orderId,
      address: STORED_ADDRESS,
      imageUrl: `${SITE}/prints/${request.orderId}/poster.png`,
    });
    const order = await ctx.store.getOrder(request.orderId);
    assert.ok(order.paidAt);
    assert.equal(order.podOrderId, 'ord_1');
    assert.equal(ctx.printer.orders.size, 1);
    assert.ok(ctx.logs.some((l) => l.startsWith('info') && l.includes('ord_1')));
    assert.equal(order.slug, slug);
  });

  test('the same payment confirmed again (a Stripe retry) places no second order', async () => {
    const ctx = printApp();
    const { request } = await buyPrint(ctx);
    for (let i = 0; i < 3; i++) await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2 });
    assert.equal(ctx.printer.calls.length, 1, 'no call once the print-on-demand order is stored');
    assert.equal(ctx.printer.orders.size, 1);
  });

  test('deliveries racing each other still make one print-on-demand order (the idempotency key)', async () => {
    const ctx = printApp();
    const { request } = await buyPrint(ctx);
    await Promise.all([1, 2, 3].map(() => payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2 })));
    assert.equal(ctx.printer.orders.size, 1);
    assert.ok(ctx.printer.calls.every((call) => call.orderId === request.orderId));
    assert.equal((await ctx.store.getOrder(request.orderId)).podOrderId, 'ord_1');
  });

  test('an incomplete address is rejected with 400 naming the field; nothing is stored or charged', async () => {
    const ctx = printApp();
    const slug = await paidPreview(ctx);
    for (const field of ['name', 'line1', 'city', 'state', 'zip']) {
      for (const value of [undefined, '', '   ']) {
        const fields = addressFields(slug, { [field]: value });
        if (value === undefined) delete fields[field];
        const json = await postJson(ctx.app, '/print', fields);
        assert.equal(json.status, 400, `${field}=${JSON.stringify(value)}`);
        const body = await json.json();
        assert.ok(body.error, field);
        assert.ok(body.fields?.[field], `the response names ${field}`);
        const page = await postPrint(ctx.app, fields);
        assert.equal(page.status, 400);
        assert.match(page.headers.get('content-type') ?? '', /text\/html/);
      }
    }
    assert.equal(ctx.checkoutCalls.length, 0);
    assert.equal(ctx.store.orders.size, 0);
    assert.equal(ctx.printer.calls.length, 0);
  });

  test('a JSON field that is not text (null, a number, a list, an object) counts as missing: 400, nothing stored', async () => {
    const ctx = printApp();
    const slug = await paidPreview(ctx);
    for (const field of ['name', 'line1', 'city', 'state', 'zip']) {
      for (const value of [null, 97201, ['742 Evergreen Terrace', 'Apt 2'], { line: 'x' }]) {
        const res = await postJson(ctx.app, '/print', addressFields(slug, { [field]: value }));
        assert.equal(res.status, 400, `${field}=${JSON.stringify(value)}`);
        assert.ok((await res.json()).fields?.[field], `the response names ${field}`);
      }
    }
    assert.equal(ctx.checkoutCalls.length, 0);
    assert.equal(ctx.store.orders.size, 0);
  });

  test('a field made only of invisible characters is missing too: 400, nothing stored', async () => {
    const ctx = printApp();
    const slug = await paidPreview(ctx);
    // Zero-width space, zero-width joiner, Hangul filler, word joiner: not whitespace to JavaScript.
    for (const field of ['name', 'line1', 'city']) {
      for (const value of ['\u200b', '\u200d\u200b', '\u3164', '\u2060 \u200b']) {
        const res = await postJson(ctx.app, '/print', addressFields(slug, { [field]: value }));
        assert.equal(res.status, 400, `${field}=${JSON.stringify(value)}`);
        assert.ok((await res.json()).fields?.[field], `the response names ${field}`);
      }
    }
    assert.equal(ctx.checkoutCalls.length, 0);
    assert.equal(ctx.store.orders.size, 0);
    // An invisible second line is no second line.
    assert.equal((await postJson(ctx.app, '/print', addressFields(slug, { line2: '\u200b' }))).status, 200);
    assert.equal((await ctx.store.getOrder(ctx.checkoutCalls[0].orderId)).details.line2, '');
  });

  test('on Postgres, an address with a broken UTF-16 character (a JSON client) is stored, not a 500', async () => {
    const db = new PGlite();
    try {
      const ctx = printApp({ store: new PgStore((text, params) => db.query(text, params).then((r) => r.rows)) });
      const slug = await paidPreview(ctx);
      const res = await postJson(ctx.app, '/print', addressFields(slug, { line2: `Apt ${String.fromCharCode(0xdc00)}2` }));
      assert.equal(res.status, 200, await res.clone().text());
      const order = await ctx.store.getOrder(ctx.checkoutCalls[0].orderId);
      assert.equal(order.details.line2, 'Apt \ufffd2');
    } finally {
      await db.close();
    }
  });

  test('an invalid ZIP, state or country is a 400 too; the second line is optional', async () => {
    const ctx = printApp();
    const slug = await paidPreview(ctx);
    for (const [overrides, field] of [
      [{ zip: '9720' }, 'zip'],
      [{ zip: 'ABCDE' }, 'zip'],
      [{ zip: '97201-12' }, 'zip'],
      [{ state: 'ZZ' }, 'state'],
      [{ state: 'Oregon' }, 'state'],
      [{ country: 'CA' }, 'country'],
      [{ name: 'N'.repeat(61) }, 'name'],
      [{ line1: 'L'.repeat(101) }, 'line1'],
    ]) {
      const res = await postJson(ctx.app, '/print', addressFields(slug, overrides));
      assert.equal(res.status, 400, JSON.stringify(overrides));
      assert.ok((await res.json()).fields[field], JSON.stringify(overrides));
    }
    assert.equal(ctx.checkoutCalls.length, 0);
    const ok = await postPrint(ctx.app, addressFields(slug, { line2: '', state: 'or', zip: '97201-1234', country: 'US' }));
    assert.equal(ok.status, 303);
    const order = await ctx.store.getOrder(ctx.checkoutCalls[0].orderId);
    assert.deepEqual(order.details, { ...STORED_ADDRESS, line2: '', zip: '97201-1234' });
  });
});

describe('POST /print', () => {
  test('sends the buyer to a $29 Checkout and back to the preview', async () => {
    const ctx = printApp();
    const { slug, request } = await buyPrint(ctx);
    assert.equal(request.successUrl, `${SITE}/p/${slug}?checkout=success`);
    assert.equal(request.cancelUrl, `${SITE}/p/${slug}`);
    const order = await ctx.store.getOrder(request.orderId);
    assert.equal(order.kind, 'print');
    assert.equal(order.amountCents, 2900);
    assert.equal(order.origin, SITE);
  });

  test('a JSON client gets the Checkout URL', async () => {
    const ctx = printApp();
    const slug = await paidPreview(ctx);
    const res = await postJson(ctx.app, '/print', addressFields(slug));
    assert.equal(res.status, 200);
    assert.match((await res.json()).url, /^https:\/\/checkout\.stripe\.com\//);
  });

  test('the poster comes after the bundle: an unpaid preview gets 402', async () => {
    const ctx = printApp();
    const slug = await createPreview(ctx.app);
    const res = await postPrint(ctx.app, addressFields(slug));
    assert.equal(res.status, 402);
    assert.equal(ctx.checkoutCalls.length, 0);
    assert.equal((await postJson(ctx.app, '/print', addressFields(slug))).status, 402);
  });

  test('without the printer or Stripe it answers 503 and logs which; nothing is stored', async () => {
    for (const [missing, pattern] of [
      [{ printOrder: null }, /PRODIGI_API_KEY/],
      [{ checkout: null }, /STRIPE_SECRET_KEY/],
    ]) {
      const ctx = printApp(missing);
      const slug = await paidPreview(ctx);
      assert.equal((await postPrint(ctx.app, addressFields(slug))).status, 503);
      assert.ok(ctx.logs.some((l) => l.startsWith('error') && pattern.test(l)));
      assert.equal(ctx.store.orders.size, 0);
    }
  });

  test('malformed → 400, unknown → 404, taken down → 410; cross-site → 403', async () => {
    const ctx = printApp();
    const slug = await paidPreview(ctx);
    assert.equal((await postPrint(ctx.app, addressFields('short'))).status, 400);
    assert.equal((await postPrint(ctx.app, addressFields('AAAAAAAAAAAAAAAAAAAAAA'))).status, 404);
    assert.equal((await postPrint(ctx.app, addressFields(slug), { origin: 'https://evil.example' })).status, 403);
    ctx.store.records.get(slug).reports = REPORT_LIMIT;
    assert.equal((await postPrint(ctx.app, addressFields(slug))).status, 410);
    assert.equal(ctx.checkoutCalls.length, 0);
  });
});

describe('placing the print-on-demand order from the webhook', () => {
  test('a printer outage answers 500 so Stripe retries; the retry places the one order', async () => {
    const ctx = printApp();
    const { request } = await buyPrint(ctx);
    ctx.printer.failWith(new PrintError('prodigi responded 503', { permanent: false }));
    const first = await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2, expect: null });
    assert.equal(first.status, 500);
    assert.ok(ctx.logs.some((l) => l.startsWith('error') && l.includes(request.orderId) && l.includes('prodigi responded 503')));
    const order = await ctx.store.getOrder(request.orderId);
    assert.ok(order.paidAt, 'the payment is recorded anyway');
    assert.equal(order.podOrderId, null);

    await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2 });
    assert.equal((await ctx.store.getOrder(request.orderId)).podOrderId, 'ord_1');
    assert.equal(ctx.printer.orders.size, 1);
  });

  test('an order the printer refuses for good is logged for a refund and not retried by Stripe (200)', async () => {
    const ctx = printApp();
    const { request } = await buyPrint(ctx);
    ctx.printer.failWith(new PrintError('prodigi responded 400', { permanent: true }));
    const res = await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2, expect: null });
    assert.equal(res.status, 200);
    assert.ok(ctx.logs.some((l) => l.startsWith('error') && l.includes(request.orderId) && /refund/.test(l)));
    assert.equal((await ctx.store.getOrder(request.orderId)).podOrderId, null);
  });

  test('paid while the printer is not configured: 500 (Stripe retries until it is), logged', async () => {
    const ctx = printApp();
    const { request } = await buyPrint(ctx);
    const unconfigured = makeApp({ store: ctx.store, now: ctx.clock.now, webhookSecret: SECRET, printOrder: null });
    const res = await payOrder(unconfigured.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2, expect: null });
    assert.equal(res.status, 500);
    assert.ok(unconfigured.logs.some((l) => l.startsWith('error') && l.includes('PRODIGI_API_KEY')));
  });

  test('the wrong amount places nothing', async () => {
    const ctx = printApp();
    const { request } = await buyPrint(ctx);
    await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2, session: { amount_total: 900 } });
    assert.equal(ctx.printer.calls.length, 0);
    assert.equal((await ctx.store.getOrder(request.orderId)).paidAt, null);
  });
});

describe('the print file Prodigi fetches', () => {
  test('a paid print order gets the 12×16 in poster at 300 dpi with the real photo; unpaid or unknown → 404', async () => {
    const ctx = printApp();
    const slug = await paidPreview(ctx, petForm({ photo: new File([solidJpeg(400, 300, BLUE)], 'pet.jpg', { type: 'image/jpeg' }) }));
    await postPrint(ctx.app, addressFields(slug));
    const request = ctx.checkoutCalls[0];
    const path = `/prints/${request.orderId}/poster.png`;
    assert.equal((await ctx.app.request(path)).status, 404, 'not before the print is paid for');
    assert.equal((await ctx.app.request('/prints/AAAAAAAAAAAAAAAAAAAAAA/poster.png')).status, 404);
    assert.equal((await ctx.app.request('/prints/short/poster.png')).status, 404);

    await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2 });
    const head = await ctx.app.request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    const res = await ctx.app.request(path);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.match(res.headers.get('cache-control') ?? '', /private/);
    const png = new Uint8Array(await res.arrayBuffer());
    assert.equal(Number(res.headers.get('content-length')), png.length);
    assert.deepEqual(pngSize(png), { width: 3600, height: 4800 });
    assert.deepEqual(PRINT_POSTER_SIZE, { width: 3600, height: 4800 });
    const image = decodePng(png);
    assert.ok(countColour(image, BLUE) > 1_000_000, 'the photo is drawn large on the poster');
  });

  test('a HEAD request renders nothing; a taken-down preview is 410', async () => {
    let renders = 0;
    const renderPrint = async () => {
      renders += 1;
      return { png: new Uint8Array([1, 2, 3]), photoShown: true };
    };
    const ctx = printApp({ renderPrint });
    const { slug, request } = await buyPrint(ctx);
    await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2 });
    const path = `/prints/${request.orderId}/poster.png`;
    assert.equal((await ctx.app.request(path, { method: 'HEAD' })).status, 200);
    assert.equal(renders, 0);
    assert.equal((await ctx.app.request(path)).status, 200);
    assert.equal(renders, 1);
    ctx.store.records.get(slug).reports = REPORT_LIMIT;
    assert.equal((await ctx.app.request(path)).status, 410);
  });

  test('renderPrintPoster draws the wanted poster with no stamp at the print size', async () => {
    const pet = { slug: 'AbCdEfGhIjKlMnOpQrStUv', name: 'Biscuit', species: 'dog', traits: ['greedy'], alterEgo: 'crime-boss', character: validCharacter(), paidAt: new Date() };
    const { png, photoShown } = await renderPrintPoster(pet, { bytes: solidJpeg(400, 300, BLUE), type: 'image/jpeg' });
    assert.equal(photoShown, true);
    assert.deepEqual(pngSize(png), PRINT_POSTER_SIZE);
  });
});

describe('the print offer on the preview page', () => {
  test('a paid preview offers the poster with a US address form; an unpaid one does not', async () => {
    const ctx = printApp();
    const unpaid = await createPreview(ctx.app);
    assert.doesNotMatch(await (await ctx.app.request(`/p/${unpaid}`)).text(), /action="\/print"/);
    const slug = await paidPreview(ctx);
    const html = await (await ctx.app.request(`/p/${slug}`)).text();
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/print"/);
    for (const name of ['name', 'line1', 'line2', 'city', 'zip']) assert.match(html, new RegExp(`<input[^>]*name="${name}"`), name);
    assert.match(html, /<select name="state"/);
    assert.ok(html.includes('$29'));
    assert.match(html, /12×16/);
  });

  test('without the printer configured there is no print form', async () => {
    const ctx = printApp({ printOrder: null });
    const slug = await paidPreview(ctx);
    assert.doesNotMatch(await (await ctx.app.request(`/p/${slug}`)).text(), /action="\/print"/);
  });

  test('after paying, "Your orders" says the poster went to the printer, with the city', async () => {
    const ctx = printApp();
    const { slug, request } = await buyPrint(ctx);
    await payOrder(ctx.app, request, SECRET, ctx.clock.seconds(), { sessionNumber: 2 });
    const html = await (await ctx.app.request(`/p/${slug}`)).text();
    assert.match(html, /Your orders/);
    assert.match(html, /Printed poster/);
    assert.match(html, /Portland, OR/);
    assert.ok(!html.includes('742 Evergreen Terrace'), 'the street address is not on a page anyone with the link can see');
  });
});

describe('the Prodigi client', () => {
  const address = STORED_ADDRESS;
  const request = { orderId: 'Order0123456789abcdefg', address, imageUrl: `${SITE}/prints/Order0123456789abcdefg/poster.png` };

  function prodigiFetch(respond) {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, init });
      return respond(url, init);
    };
    return { fetch, seen };
  }

  test('creates the order on the sandbox by default, with the address, SKU, sizing, asset and idempotency key', async () => {
    const key = fakeProdigiKey();
    const { fetch, seen } = prodigiFetch(() => Response.json({ outcome: 'Created', order: { id: 'ord_840797' } }));
    const result = await createProdigiPrinter({ apiKey: key, fetch })(request);
    assert.deepEqual(result, { id: 'ord_840797' });
    assert.equal(seen[0].url, `${PRODIGI_URLS.sandbox}/Orders`);
    assert.equal(PRODIGI_URLS.sandbox, 'https://api.sandbox.prodigi.com/v4.0');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers['x-api-key'], key);
    assert.equal(seen[0].init.headers['content-type'], 'application/json');
    assert.ok(seen[0].init.signal, 'the request has a timeout');
    assert.equal(PRINT_SKU, 'GLOBAL-FAP-12X16');
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      merchantReference: request.orderId,
      idempotencyKey: `alterpaw-${request.orderId}`,
      shippingMethod: 'Standard',
      recipient: {
        name: 'Jamie Rivera',
        address: {
          line1: '742 Evergreen Terrace',
          line2: 'Apt 2',
          postalOrZipCode: '97201',
          countryCode: 'US',
          townOrCity: 'Portland',
          stateOrCounty: 'OR',
        },
      },
      items: [{ merchantReference: 'wanted-poster', sku: 'GLOBAL-FAP-12X16', copies: 1, sizing: 'fillPrintArea', assets: [{ printArea: 'default', url: request.imageUrl }] }],
    });
  });

  test('an empty second line is left out; the live environment uses the live API', async () => {
    const { fetch, seen } = prodigiFetch(() => Response.json({ outcome: 'Created', order: { id: 'ord_1' } }));
    await createProdigiPrinter({ apiKey: fakeProdigiKey(), environment: 'live', fetch })({ ...request, address: { ...address, line2: '' } });
    assert.equal(seen[0].url, 'https://api.prodigi.com/v4.0/Orders');
    assert.equal(JSON.parse(seen[0].init.body).recipient.address.line2, null);
  });

  test('a repeat with the same idempotency key ("AlreadyExists") returns the first order', async () => {
    const { fetch } = prodigiFetch(() => Response.json({ outcome: 'AlreadyExists', order: { id: 'ord_840797' } }));
    assert.deepEqual(await createProdigiPrinter({ apiKey: fakeProdigiKey(), fetch })(request), { id: 'ord_840797' });
  });

  test('failures are PrintErrors without the key: 400 is permanent; 5xx, 429, 401, timeouts and junk are not', async () => {
    const key = fakeProdigiKey();
    const cases = [
      [() => Response.json({ outcome: 'ValidationFailed', failures: { key } }, { status: 400 }), true],
      [() => new Response('upstream', { status: 502 }), false],
      [() => new Response('slow down', { status: 429 }), false],
      [() => Response.json({ message: `bad key ${key}` }, { status: 401 }), false],
      [() => new Response('not json', { status: 200 }), false],
      [() => Response.json({ outcome: 'Created', order: {} }), false],
      [
        () => {
          throw new DOMException(`timed out ${key}`, 'TimeoutError');
        },
        false,
      ],
    ];
    for (const [i, [respond, permanent]] of cases.entries()) {
      await assert.rejects(createProdigiPrinter({ apiKey: key, fetch: prodigiFetch(respond).fetch })(request), (err) => {
        assert.ok(err instanceof PrintError, `case ${i}`);
        assert.equal(err.permanent, permanent, `case ${i}`);
        assert.ok(!err.message.includes(key), `case ${i}: no key in the message`);
        return true;
      });
    }
  });
});

describe('shipping address validation (input.js)', () => {
  test('parseShippingAddress trims, upper-cases the state and fixes the country', () => {
    const parsed = parseShippingAddress({ name: ' Jamie  Rivera ', line1: '742 Evergreen Terrace', line2: ' Apt 2 ', city: 'Portland', state: 'or', zip: '97201' });
    assert.deepEqual(parsed, STORED_ADDRESS);
  });

  test('an InputError lists every bad field at once', () => {
    assert.throws(
      () => parseShippingAddress({}),
      (err) => err instanceof InputError && ['name', 'line1', 'city', 'state', 'zip'].every((f) => err.fields[f]),
    );
  });

  test('all 50 states and DC are accepted', () => {
    assert.equal(US_STATES.length, 51);
    for (const { code } of US_STATES) parseShippingAddress({ ...STORED_ADDRESS, state: code });
  });
});

describe('deploy bundle (M4)', () => {
  test("Vercel's file tracer ships the email and print clients", async () => {
    const base = fileURLToPath(new URL('..', import.meta.url));
    const { fileList } = await nodeFileTrace(['src/index.js'], { base });
    for (const file of ['src/email.js', 'src/print.js', 'src/bundle.js']) assert.ok(fileList.has(file), file);
  });
});
