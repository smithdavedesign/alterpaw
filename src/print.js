// Printed posters, through Prodigi's Print API v4 (print-on-demand: nothing in stock, Prodigi prints and ships
// each order and charges per order). One REST call creates an order; no SDK.
//
//   createProdigiPrinter({ apiKey, environment, fetch }) → ({ orderId, address, imageUrl }) => Promise<{ id }>
//
// "One print-on-demand order per paid order" rests on Prodigi's idempotencyKey: it is remembered indefinitely,
// and a repeat answers outcome "AlreadyExists" with the first order's id. The key is our order id (128-bit
// random) with a prefix, so it can't collide with anything else on the account.
// `environment` is 'sandbox' (the default: orders are never printed or charged) or 'live'.
// The key is only sent in the X-API-Key header; errors carry a status code at most. `permanent` is true for a
// 400 (Prodigi refusing the order itself, e.g. an address it can't ship to); everything else can be retried.

export const PRODIGI_URLS = {
  sandbox: 'https://api.sandbox.prodigi.com/v4.0',
  live: 'https://api.prodigi.com/v4.0',
};
// Enhanced matte art paper (200 gsm, giclée), 12×16 in. The print file is drawn at this size (bundle.js).
export const PRINT_SKU = 'GLOBAL-FAP-12X16';
export const PRINT_SIZE_LABEL = '12×16 in';
const SHIPPING_METHOD = 'Standard';
// Under Stripe's webhook timeout, so a slow Prodigi becomes a clean 500 that Stripe retries.
const ORDER_TIMEOUT_MS = 8_000;

export class PrintError extends Error {
  constructor(message, { permanent = false } = {}) {
    super(message);
    this.name = 'PrintError';
    this.permanent = permanent;
  }
}

export function createProdigiPrinter({ apiKey, environment = 'sandbox', fetch = globalThis.fetch, timeoutMs = ORDER_TIMEOUT_MS }) {
  const base = environment === 'live' ? PRODIGI_URLS.live : PRODIGI_URLS.sandbox;
  return async function printOrder({ orderId, address, imageUrl }) {
    let res;
    try {
      res = await fetch(`${base}/Orders`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          merchantReference: orderId,
          idempotencyKey: `alterpaw-${orderId}`,
          shippingMethod: SHIPPING_METHOD,
          recipient: {
            name: address.name,
            address: {
              line1: address.line1,
              line2: address.line2 || null,
              postalOrZipCode: address.zip,
              countryCode: address.country,
              townOrCity: address.city,
              stateOrCounty: address.state,
            },
          },
          items: [
            {
              merchantReference: 'wanted-poster',
              sku: PRINT_SKU,
              copies: 1,
              sizing: 'fillPrintArea',
              assets: [{ printArea: 'default', url: imageUrl }],
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new PrintError(`prodigi request failed: ${err?.name ?? 'Error'}`);
    }
    if (!res.ok) throw new PrintError(`prodigi responded ${res.status}`, { permanent: res.status === 400 });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new PrintError('prodigi response is not JSON');
    }
    // Created, CreatedWithIssues and AlreadyExists all carry the order's id. Without one, a retry with the same
    // idempotency key finds the order Prodigi may have made.
    const id = body?.order?.id;
    if (typeof id !== 'string' || !id) throw new PrintError('prodigi response has no order id');
    return { id };
  };
}
