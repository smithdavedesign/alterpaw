// Stripe, over plain HTTPS: one REST call creates a Checkout Session, and webhooks are verified with Stripe's
// documented signature scheme. No SDK: fetch and Web Crypto run on any host, and there's nothing to bundle.
//
//   createStripeCheckout({ secretKey, fetch }) → ({ slug, successUrl, cancelUrl, expiresAt?, product?, orderId? })
//                                                 => Promise<{ id, url }>
//   verifyStripeEvent(payload, signatureHeader, secret, now) → Promise<event>, or throws SignatureError
//
// The secret key is only ever sent in the Authorization header. Errors carry a status code at most, never
// Stripe's error text (it can quote the key) or the key itself.

import { PRINT_SIZE_LABEL } from './print.js';

export const CURRENCY = 'usd';
// What can be bought. Names and descriptions are fixed text: no user input goes to Stripe. The bundle is M3;
// the gift (the same bundle, emailed on a chosen date) and the printed poster are M4, each with an order row.
export const PRODUCTS = {
  bundle: {
    cents: 900,
    name: "alterpaw bundle: your pet's secret life",
    description: '4 high-res images (wanted poster, front page, trading card, bio card) and a printable PDF, no watermark, plus one rewrite of the jokes.',
  },
  gift: {
    cents: 900,
    name: "alterpaw gift: a pet's secret life",
    description: 'The clean bundle (4 high-res images and a printable PDF), emailed to the person you chose on the date you chose.',
  },
  print: {
    cents: 2900,
    name: `alterpaw printed wanted poster, ${PRINT_SIZE_LABEL}`,
    description: `The wanted poster printed on ${PRINT_SIZE_LABEL} matte art paper and shipped to the US address you gave.`,
  },
};
export const PRICE_CENTS = PRODUCTS.bundle.cents;
export const priceLabel = (product) => `$${PRODUCTS[product].cents / 100}`;
export const PRICE_LABEL = priceLabel('bundle');
export const PRINT_PRICE_LABEL = priceLabel('print');

const STRIPE_API = 'https://api.stripe.com/v1';
// Where Checkout Sessions live; the pay form's CSP form-action must allow it (see app.js).
export const STRIPE_CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
const CHECKOUT_TIMEOUT_MS = 15_000;

// Stripe's recommended tolerance: a signed event older or newer than this is a replay.
export const SIGNATURE_TOLERANCE_SECONDS = 300;
// checkout.session.completed is paid at once for cards; bank debits complete unpaid and are paid later
// by async_payment_succeeded. Both carry the Checkout Session; payment_status says which.
// Refunds and disputes deliberately change nothing: a refunded buyer keeps the bundle (it's $9, and the
// photo is deleted after 30 days anyway), so the endpoint doesn't subscribe to those events.
export const PAID_EVENT_TYPES = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

export class PaymentError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PaymentError';
  }
}

export class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignatureError';
  }
}

// `expiresAt` (a Date, optional) closes the session early; Stripe accepts 30 min to 24 h from now.
// `product` is a PRODUCTS key (the bundle if absent). A gift or print also passes its `orderId`, which the
// webhook uses to find the order; `metadata[kind]` is only there for the dashboard.
export function createStripeCheckout({ secretKey, fetch = globalThis.fetch, timeoutMs = CHECKOUT_TIMEOUT_MS }) {
  return async function createCheckout({ slug, successUrl, cancelUrl, expiresAt, product = 'bundle', orderId }) {
    if (!Object.hasOwn(PRODUCTS, product)) throw new RangeError(`unknown product: ${product}`);
    const { cents, name, description } = PRODUCTS[product];
    const body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': CURRENCY,
      'line_items[0][price_data][unit_amount]': String(cents),
      'line_items[0][price_data][product_data][name]': name,
      'line_items[0][price_data][product_data][description]': description,
      // The webhook finds the preview by this; metadata shows it in the dashboard too.
      client_reference_id: slug,
      'metadata[slug]': slug,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    if (orderId) {
      body.set('metadata[order]', orderId);
      body.set('metadata[kind]', product);
    }
    if (expiresAt) body.set('expires_at', String(Math.floor(expiresAt.getTime() / 1000)));
    let res;
    try {
      res = await fetch(`${STRIPE_API}/checkout/sessions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new PaymentError(`stripe request failed: ${err?.name ?? 'Error'}`);
    }
    if (!res.ok) throw new PaymentError(`stripe responded ${res.status}`);
    let session;
    try {
      session = await res.json();
    } catch {
      throw new PaymentError('stripe response is not JSON');
    }
    // Only Stripe's own Checkout origin: it's the one the pay form's CSP form-action allows (app.js). A custom
    // Checkout domain would make browsers block the redirect silently; this way it's a logged 502.
    if (typeof session?.id !== 'string' || typeof session.url !== 'string' || originOf(session.url) !== STRIPE_CHECKOUT_ORIGIN) {
      throw new PaymentError(`stripe response has no checkout url on ${STRIPE_CHECKOUT_ORIGIN}`);
    }
    return { id: session.id, url: session.url };
  };
}

function originOf(value) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const encoder = new TextEncoder();

function hexToBytes(hex) {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return new Uint8Array(hex.match(/../g).map((pair) => parseInt(pair, 16)));
}

// `t=<unix seconds>,v1=<hex>,v1=<hex>,v0=<hex>`: one t, any number of v1 (several during a secret
// rotation). v0 and unknown schemes are ignored.
function parseSignatureHeader(header) {
  let timestamp = null;
  const signatures = [];
  for (const part of String(header ?? '').split(',')) {
    const at = part.indexOf('=');
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) timestamp = Number(value);
    else if (key === 'v1') signatures.push(value);
  }
  return { timestamp, signatures };
}

// Verifies the raw body (bytes or text, exactly as received) and returns the parsed event.
// HMAC-SHA256 over "<t>.<body>" keyed with the endpoint secret, compared by crypto.subtle.verify (constant
// time). The JSON is parsed only after the signature checks out.
export async function verifyStripeEvent(payload, header, secret, now) {
  const body = typeof payload === 'string' ? encoder.encode(payload) : payload;
  const { timestamp, signatures } = parseSignatureHeader(header);
  if (timestamp === null || signatures.length === 0) throw new SignatureError('missing or malformed Stripe-Signature header');
  if (Math.abs(now.getTime() / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new SignatureError('signature timestamp is outside the tolerance (a replay, or a wrong clock)');
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  let valid = false;
  for (const signature of signatures) {
    const bytes = hexToBytes(signature);
    if (bytes && bytes.length === 32 && (await crypto.subtle.verify('HMAC', key, bytes, signed))) valid = true;
  }
  if (!valid) throw new SignatureError('no v1 signature matches (wrong secret, or the body was changed)');
  let event;
  try {
    event = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new SignatureError('signed body is not JSON');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
    throw new SignatureError('signed body is not an event');
  }
  return event;
}
