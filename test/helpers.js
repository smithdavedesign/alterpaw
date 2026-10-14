// Shared fixtures for the test suite. No network, no keys, no database.
import { createHmac } from 'node:crypto';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

export const MB = 1024 * 1024;

export function validCharacter(overrides = {}) {
  return {
    alias: 'Biscuit "The Crumb" Corleone',
    rapSheet: [
      'Grand theft sausage (three counts)',
      'Running an unlicensed tennis-ball ring out of the laundry room',
      'Intimidating the mail carrier, daily, for eleven years',
    ],
    stats: [
      { label: 'Treat Theft', value: 97 },
      { label: 'Menace', value: 88 },
      { label: 'Loyalty', value: 64 },
      { label: 'Nap Power', value: 91 },
      { label: 'Charm', value: 99 },
    ],
    headline: 'LOCAL DOG DENIES ROLE IN SAUSAGE HEIST',
    article:
      'Witnesses report a golden blur near the barbecue moments before six sausages vanished. ' +
      'The suspect, who goes by Biscuit, was later found asleep on the couch, smelling faintly of paprika.',
    bio: 'Biscuit rose from humble puppyhood to run the most feared treat syndicate on Maple Street.',
    ...overrides,
  };
}

// Magic-byte prefixes padded with filler; enough for type sniffing, not real images.
function withPrefix(prefix, size) {
  const bytes = new Uint8Array(size);
  bytes.set(prefix);
  for (let i = prefix.length; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

export const jpegBytes = (size = 2048) => withPrefix([0xff, 0xd8, 0xff, 0xe0], size);
export const pngBytes = (size = 2048) =>
  withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size);
export const gifBytes = (size = 2048) => withPrefix([...Buffer.from('GIF89a')], size);
export const webpBytes = (size = 2048) =>
  withPrefix([...Buffer.from('RIFF'), 0x00, 0x10, 0x00, 0x00, ...Buffer.from('WEBP')], size);

// Pass null for a field to leave it out of the form entirely.
export function petForm({
  name = 'Biscuit',
  species = 'dog',
  traits = ['greedy', 'loyal', 'afraid of the vacuum'],
  alterEgo = 'crime boss',
  photo = new File([jpegBytes()], 'biscuit.jpg', { type: 'image/jpeg' }),
} = {}) {
  const form = new FormData();
  if (photo !== null) form.append('photo', photo);
  if (name !== null) form.append('name', name);
  if (species !== null) form.append('species', species);
  for (const trait of traits) form.append('traits', trait);
  if (alterEgo !== null) form.append('alterEgo', alterEgo);
  return form;
}

// A store wrapper that records writes, so "stores nothing" can be asserted.
export class SpyStore extends MemoryStore {
  constructor() {
    super();
    this.creates = 0;
  }
  async createPet(record) {
    this.creates += 1;
    return super.createPet(record);
  }
}

// Builds an app with a fake model. `reply` is the raw model text, or a function of the messages.
// Anything else (now, renderShare, cronSecret…) is passed straight to createApp. Log lines land in `logs`.
export function makeApp({ reply = JSON.stringify(validCharacter()), store = new SpyStore(), ...options } = {}) {
  const calls = [];
  const complete = async (messages) => {
    calls.push(messages);
    return typeof reply === 'function' ? reply(messages) : reply;
  };
  const logs = [];
  const logger = {
    error: (m) => logs.push(`error ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    info: (m) => logs.push(`info ${m}`),
  };
  const app = createApp({ store, complete, logger, ...options });
  return { app, store, calls, logs };
}

// Creates one preview through POST /generate and returns its slug.
export async function createPreview(app, form = petForm()) {
  const { res, body } = await generate(app, form);
  if (res.status !== 200) throw new Error(`generate failed: ${res.status} ${JSON.stringify(body)}`);
  return body.slug;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// A stored record built directly, for tests that need control over its age.
export function petRecord(overrides = {}) {
  return {
    slug: 'AbCdEfGhIjKlMnOpQrStUv',
    name: 'Biscuit',
    species: 'dog',
    traits: ['greedy', 'loyal', 'afraid of the vacuum'],
    alterEgo: 'crime-boss',
    character: validCharacter(),
    photo: jpegBytes(),
    photoType: 'image/jpeg',
    createdAt: new Date(),
    ...overrides,
  };
}

// POST /report the way the preview page's form does: same-origin, urlencoded, from one client IP.
// Pass null for slug, reason or origin to leave it out.
export function reportForm(app, slug, { ip = '203.0.113.1', reason = 'offensive', origin = 'http://localhost', headers = {} } = {}) {
  const body = new URLSearchParams();
  if (slug !== null) body.set('slug', slug);
  if (reason !== null) body.set('reason', reason);
  return app.request('/report', {
    method: 'POST',
    body,
    headers: { ...(origin !== null ? { origin } : {}), 'x-forwarded-for': ip, accept: 'text/html', ...headers },
  });
}

export async function generate(app, form = petForm()) {
  const res = await app.request('/generate', { method: 'POST', body: form });
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
  return { res, body };
}

// Fake credentials are assembled at runtime so secret scanners don't flag the repo.
export const fakeApiKey = () => ['test', 'key', 'A1b2C3d4'.repeat(4)].join('-');
export const fakeWebhookSecret = (filler = 'A1b2C3d4') => ['whsec', filler.repeat(4)].join('_');
export const fakeStripeKey = () => ['rk', 'test', 'A1b2C3d4'.repeat(6)].join('_');
export const fakeSessionId = (n = 1) => ['cs', 'test', `Session${n}`.padEnd(24, 'x')].join('_');

// M3: a stand-in for createStripeCheckout. Records every call and answers like Stripe does.
export function fakeCheckout() {
  const calls = [];
  const checkout = async (request) => {
    calls.push(request);
    const id = fakeSessionId(calls.length);
    return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
  };
  return { checkout, calls };
}

// A Stripe event as the webhook receives it. `session` overrides fields of the Checkout Session.
export function stripeEvent(slug, { type = 'checkout.session.completed', id = 'evt_test_1', session = {} } = {}) {
  return {
    id,
    object: 'event',
    type,
    created: 1_760_000_000,
    data: {
      object: {
        id: fakeSessionId(1),
        object: 'checkout.session',
        mode: 'payment',
        amount_total: 900,
        currency: 'usd',
        payment_status: 'paid',
        client_reference_id: slug,
        metadata: { slug },
        ...session,
      },
    },
  };
}

// Signs like Stripe: v1 = hex HMAC-SHA256 of "<t>.<raw body>" with the endpoint secret. Uses node:crypto,
// an implementation independent of the Web Crypto code under test.
export function stripeSignature(payload, secret, timestamp) {
  const v1 = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

// POSTs an event to /stripe/webhook. `signature` overrides the header (null leaves it out).
export function postWebhook(app, event, { secret, timestamp, signature, body } = {}) {
  const payload = body ?? JSON.stringify(event);
  const header = signature !== undefined ? signature : stripeSignature(payload, secret, timestamp);
  return app.request('/stripe/webhook', {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json', ...(header !== null ? { 'stripe-signature': header } : {}) },
  });
}

// A same-origin form post, the way the preview page's buttons send it. Pass origin: null to leave it out.
export function postForm(app, path, fields, { origin = 'http://localhost', accept = 'text/html', headers = {} } = {}) {
  return app.request(path, {
    method: 'POST',
    body: new URLSearchParams(fields),
    headers: { ...(origin !== null ? { origin } : {}), accept, ...headers },
  });
}

// Marks a preview paid the only way production can: a signed webhook. `timestamp` must be near the app's clock.
export async function payFor(app, slug, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const res = await postWebhook(app, stripeEvent(slug), { secret, timestamp });
  if (res.status !== 200) throw new Error(`webhook failed: ${res.status} ${await res.text()}`);
}

// M4 -----------------------------------------------------------------------------------------------------

export const fakeCronSecret = () => ['cron', 'Zq9x'.repeat(8)].join('-');
export const fakeBrevoKey = () => ['xkeysib', 'A1b2C3d4'.repeat(8), 'Q9w8E7r6'.repeat(2)].join('-');
export const fakeProdigiKey = () => ['A1b2C3d4'.repeat(1), 'E5f6', 'G7h8', 'I9j0', 'K1l2M3n4O5p6'].join('-');
export const unixSeconds = (date) => Math.floor(date.getTime() / 1000);

// A clock the test moves by hand: makeApp({ now: clock.now }) and then clock.set('2026-10-20T14:05:00Z').
export function testClock(start) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    set: (when) => {
      current = new Date(when);
    },
    seconds: () => unixSeconds(current),
  };
}

// A stand-in for the Brevo sender: keeps every message; `failWith(err)` makes the next call throw.
export function fakeEmail() {
  const sent = [];
  const failures = [];
  const sendEmail = async (message) => {
    const failure = failures.shift();
    if (failure) throw failure;
    sent.push(structuredClone(message));
    return { id: `msg-${sent.length}` };
  };
  return { sendEmail, sent, failWith: (err) => failures.push(err) };
}

// A stand-in for the Prodigi client that deduplicates like Prodigi does: one print-on-demand order per order
// id (Prodigi's idempotency key is derived from it). `orders` is what Prodigi would have.
export function fakePrinter() {
  const calls = [];
  const orders = new Map();
  const failures = [];
  const printOrder = async (request) => {
    calls.push(structuredClone(request));
    const failure = failures.shift();
    if (failure) throw failure;
    if (!orders.has(request.orderId)) orders.set(request.orderId, { id: `ord_${orders.size + 1}`, ...structuredClone(request) });
    return { id: orders.get(request.orderId).id };
  };
  return { printOrder, calls, orders, failWith: (err) => failures.push(err) };
}

// The gift form as the preview page posts it.
export function giftFields(slug, overrides = {}) {
  return {
    slug,
    recipientName: 'Jamie',
    recipientEmail: 'jamie@example.com',
    fromName: 'Sam',
    message: 'Happy birthday! Biscuit has been hiding things from you.',
    deliverOn: '2026-10-20',
    timeZone: 'America/New_York',
    ...overrides,
  };
}

// The print form as the paid preview page posts it.
export function addressFields(slug, overrides = {}) {
  return {
    slug,
    name: 'Jamie Rivera',
    line1: '742 Evergreen Terrace',
    line2: 'Apt 2',
    city: 'Portland',
    state: 'OR',
    zip: '97201',
    ...overrides,
  };
}

// Pays for an order (gift or print) the way Stripe confirms it: a signed event for the Checkout Session that
// the app asked for. `request` is the call recorded by fakeCheckout. `session` overrides session fields.
export async function payOrder(app, request, secret, timestamp, { session = {}, sessionNumber = 1, expect = 200 } = {}) {
  const { PRODUCTS } = await import('../src/payments.js');
  const event = stripeEvent(request.slug, {
    id: `evt_test_order_${sessionNumber}`,
    session: {
      id: fakeSessionId(sessionNumber),
      amount_total: PRODUCTS[request.product].cents,
      metadata: { slug: request.slug, order: request.orderId, kind: request.product },
      ...session,
    },
  });
  const res = await postWebhook(app, event, { secret, timestamp });
  if (expect !== null && res.status !== expect) throw new Error(`webhook answered ${res.status}: ${await res.text()}`);
  return res;
}

// Runs the gift delivery job the way Vercel Cron calls it.
export async function runGiftJob(app, secret) {
  const res = await app.request('/jobs/deliver-gifts', { headers: { authorization: `Bearer ${secret}` } });
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
  return { res, body };
}

export function postJson(app, path, value, { origin = 'http://localhost', headers = {} } = {}) {
  return app.request(path, {
    method: 'POST',
    body: JSON.stringify(value),
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(origin !== null ? { origin } : {}), ...headers },
  });
}
