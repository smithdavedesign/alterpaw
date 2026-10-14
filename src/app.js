// Routes. Dependencies are injected so tests run with a fake model, an in-memory store and a fixed clock:
//   createApp({ store, complete, logger, now, renderShare, cronSecret, uploadSweepWaitMs,
//               checkout, webhookSecret, renderBundle })
//     store       — createPet / getPet / getPhoto / reportPet / expirePhotos / markPaid / saveRegenerated (store.js)
//     complete    — (messages) => Promise<string>, one chat-completion call (character.js)
//     now         — () => Date; drives the 30-day expiry and the webhook's replay window
//     renderShare — (pet, photo, { size, host }) => Promise<{ png, photoShown, photoProblem? }> (share.js, loaded
//                   on first use)
//     cronSecret  — bearer token Vercel Cron sends to /jobs/expire-photos; unset means the job refuses to run
//     uploadSweepWaitMs — how long an upload waits for its photo-deletion sweep before answering anyway
//     checkout    — ({ slug, successUrl, cancelUrl }) => Promise<{ id, url }>, a Stripe Checkout Session
//                   (payments.js); null means payments aren't configured
//     webhookSecret — the Stripe webhook endpoint's signing secret; unset means the webhook refuses events
//     renderBundle — (pet, photo) => Promise<{ files: [{ name, bytes }], photoShown, photoProblem? }> (bundle.js,
//                   loaded on first use)
//   M4:
//     sendEmail   — ({ to, toName, subject, text, html }) => Promise<{ id }>, Brevo (email.js); null means no gifts
//     printOrder  — ({ orderId, address, imageUrl }) => Promise<{ id }>, Prodigi (print.js); null means no prints
//     renderPrint — (pet, photo) => Promise<{ png, photoShown, photoProblem? }> (bundle.js, loaded on first use)
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { timingSafeEqual } from 'hono/utils/buffer';
import { generateCharacter, ModelError } from './character.js';
import { parsePetForm, parseGiftForm, parseShippingAddress, isTimeZone, dateIn, InputError, MAX_BODY_BYTES, PHOTO_TOO_BIG } from './input.js';
import {
  verifyStripeEvent,
  SignatureError,
  PaymentError,
  PAID_EVENT_TYPES,
  STRIPE_CHECKOUT_ORIGIN,
  PRICE_CENTS,
  PRODUCTS,
  CURRENCY,
} from './payments.js';
import { EmailError } from './email.js';
import { PrintError } from './print.js';
import { zipFiles, streamOf } from './files.js';
import {
  homePage,
  previewPage,
  expiredPage,
  removedPage,
  reportThanksPage,
  paymentRequiredPage,
  paymentsUnavailablePage,
  rewriteUsedPage,
  rewriteFailedPage,
  formProblemPage,
  featureUnavailablePage,
  giftEmail,
  legalPage,
  notFoundPage,
  errorPage,
  STYLES,
  UPLOAD_SCRIPT,
  SHARE_SIZES,
  shareFileName,
  BUNDLE_FILE_NAME,
} from './views.js';

export { BUNDLE_FILE_NAME };

// 16 random bytes → 22 base64url characters. Previews are only reachable by knowing the slug.
const SLUG_BYTES = 16;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;
const ASSET_CACHE = 'public, max-age=3600';

// Moderation and retention policy. The store only counts and deletes; these numbers decide.
export const REPORT_LIMIT = 3; // distinct reporters before a preview is taken down (410)
export const PHOTO_RETENTION_DAYS = 30; // photos older than this are deleted and the preview shows "expired"
const DAY_MS = 24 * 60 * 60 * 1000;
// Uploads also run the deletion, at most this often per instance, and wait at most this long for it (see
// /generate). Neon's HTTP driver has no timeout of its own, and the preview is already saved by then.
export const UPLOAD_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const UPLOAD_SWEEP_WAIT_MS = 1000;
// The same-site form posts (/report, /checkout, /regenerate) carry a slug and a reason at most.
const MAX_FORM_BYTES = 8 * 1024;
// A Checkout Session event is a few KB; this leaves room for fields Stripe adds later.
export const MAX_WEBHOOK_BYTES = 256 * 1024;
// A Checkout Session stays open at most a day (Stripe's maximum) and never past the preview's expiry, so
// nobody pays for a preview that is gone. Under an hour left, it's too late to buy (Stripe's minimum is 30 min).
const CHECKOUT_MAX_OPEN_MS = DAY_MS;
const CHECKOUT_MIN_OPEN_MS = 60 * 60 * 1000;

// M4 gift policy. A gift is due at the first instant of its delivery date in the buyer's chosen zone; the daily
// job (vercel.json, 16:00 UTC) then sends it on that date in every zone, and a gift already due when it's paid
// goes at once. Hobby fires a daily cron anywhere in its hour, so no zone may start its day inside that hour:
// 14:00 missed Darwin (UTC+9:30), and 16:00–16:59 UTC is local midnight nowhere (tested against every zone).
// The latest date leaves the recipient about a week before the photo is deleted.
export const GIFT_MIN_DAYS_TO_DOWNLOAD = 7;
// A claimed gift whose run died before settling it is claimable again after this. Far longer than one send
// (10 s timeout), so a live run is never overtaken.
export const GIFT_CLAIM_LEASE_MS = 15 * 60 * 1000;
// The job claims gifts in batches until none are due, so a busy day's all go that day, up to Brevo's free plan's
// 300 emails a day. Failures in a row look like an outage: the run stops instead of waiting on every gift.
const GIFT_BATCH = 50;
const GIFT_MAX_BATCHES = 6;
const GIFT_OUTAGE_FAILURES = 3;
// Prices are in USD and most buyers are in the US, so with no zone from the host the form starts on New York.
const DEFAULT_GIFT_ZONE = 'America/New_York';
const PRINT_FILE_NAME = 'alterpaw-wanted-poster-print.png';
export const REPORT_REASONS = [
  { id: 'not-a-pet', label: "It isn't a pet" },
  { id: 'offensive', label: 'Offensive or inappropriate' },
  { id: 'my-photo', label: 'My photo, used without permission' },
  { id: 'other', label: 'Something else' },
];

// live | expired | removed. Expiry is decided here too, not only by the job, so a photo is never shown past
// 30 days even if the daily job runs late or fails.
export function previewStatus(pet, now) {
  if (pet.reports >= REPORT_LIMIT) return 'removed';
  if (pet.expiredAt || now.getTime() - pet.createdAt.getTime() > PHOTO_RETENTION_DAYS * DAY_MS) return 'expired';
  return 'live';
}

// The client address as the edge proxy saw it. Vercel overwrites X-Forwarded-For and Cloudflare appends to
// it, so the last entry is theirs; anything in front of it could have been typed by the client. This trust
// is only right behind such a proxy: on a host that passes the header through untouched, a client can set
// it (check before moving hosts). With no header at all every reporter is "unknown" and counts once.
function clientIp(c) {
  const forwarded = c.req.header('x-forwarded-for');
  const last = forwarded
    ?.split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  return last || c.req.header('x-real-ip') || 'unknown';
}

// IPv6 clients usually own a whole /64 and can rotate addresses inside it, so a /64 counts as one reporter.
// IPv4 (including IPv4-mapped IPv6, ::ffff:a.b.c.d) is one address each.
export function reporterNetwork(raw) {
  const ip = raw.replace(/%.*$/, ''); // zone id
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

// One report per person per preview, without keeping the IP. The key is 24 bits of SHA-256(slug, network):
// enough to tell a preview's handful of reporters apart (two of three colliding is about 1 in 5 million),
// too short to recover an address from (each key matches ~256 IPv4 addresses per preview), and not
// comparable across previews. Rows are deleted by the 30-day job.
export const REPORTER_KEY_BYTES = 3;
async function reporterKey(slug, ip) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${slug}\n${reporterNetwork(ip)}`));
  return [...new Uint8Array(digest, 0, REPORTER_KEY_BYTES)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Same-site check for the form posts that survives TLS termination: compare hosts, not full origins (http vs https).
function sameHost(origin, c) {
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}

const wantsJson = (c) => /application\/json/i.test(`${c.req.header('accept') ?? ''} ${c.req.header('content-type') ?? ''}`);

// Hono's csrf() only checks form content types (what a cross-site <form> can send). A browser can't send a
// cross-site JSON post without a CORS preflight, which the form posts never answer, but the rule shouldn't hang
// on that: any request that says it comes from another site is refused, whatever its content type.
function crossSite(c) {
  const origin = c.req.header('origin');
  const site = c.req.header('sec-fetch-site');
  return site === 'cross-site' || site === 'same-site' || Boolean(origin && origin !== 'null' && !sameHost(origin, c));
}

// Resolves when `promise` settles or after `ms`, whichever is first; never rejects (`promise` must not either).
async function waitAtMost(promise, ms) {
  let timer;
  try {
    await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

// The three same-site form posts share one guard. Anything marked cross-site is refused, Hono's csrf()
// checks the Origin of form content types, and the body is capped (a page for forms, JSON for JSON).
// Without it a hostile page could make its visitors' browsers report previews or start checkouts.
const sameSiteForm = () => [
  async (c, next) => (crossSite(c) ? c.text('Forbidden', 403) : next()),
  csrf({ origin: sameHost }),
  bodyLimit({
    maxSize: MAX_FORM_BYTES,
    onError: (c) => (wantsJson(c) ? c.json({ error: 'That request is too large.' }, 413) : c.html(errorPage(), 413)),
  }),
];

// A form or JSON body as an object; throws on a body that is neither.
async function readForm(c) {
  if (/^application\/json/i.test(c.req.header('content-type') ?? '')) {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : {};
  }
  return c.req.parseBody();
}

// The renderers pull in satori and resvg (~200 ms to load), so they're imported on first use only.
const renderShareLazily = async (...args) => (await import('./share.js')).renderSharePng(...args);
const renderBundleLazily = async (...args) => (await import('./bundle.js')).renderBundle(...args);
const renderPrintLazily = async (...args) => (await import('./bundle.js')).renderPrintPoster(...args);

// Error text from drivers can quote a URL with its credentials (Neon echoes a malformed connection string).
// Database URLs are masked to the end of the line (a malformed one may contain spaces), and any other URL
// with a user-info part is masked whole, before anything reaches the logs.
const DATABASE_URL_TEXT = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?):\/\/[^\n]*/gi;
const USERINFO_URL_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@\S*/gi;
export const redact = (err) =>
  String(err?.message ?? err)
    .replace(DATABASE_URL_TEXT, '[redacted url]')
    .replace(USERINFO_URL_TEXT, '[redacted url]');

export function newSlug() {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_BYTES));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function createApp({
  store,
  complete,
  logger = console,
  slug = newSlug,
  now = () => new Date(),
  renderShare = renderShareLazily,
  cronSecret = '',
  uploadSweepWaitMs = UPLOAD_SWEEP_WAIT_MS,
  checkout = null,
  webhookSecret = '',
  renderBundle = renderBundleLazily,
  sendEmail = null,
  printOrder = null,
  renderPrint = renderPrintLazily,
}) {
  const app = new Hono();
  // Each M4 product is offered only when everything it needs is configured, so nothing is sold that can't be
  // delivered: a gift needs Stripe, email and the scheduler; a print needs Stripe and the printer.
  const giftsMissing = () =>
    !sendEmail ? 'BREVO_API_KEY or EMAIL_FROM (a plain address)' : !cronSecret ? 'CRON_SECRET' : !checkout ? 'STRIPE_SECRET_KEY' : null;
  const printsMissing = () => (!printOrder ? 'PRODIGI_API_KEY' : !checkout ? 'STRIPE_SECRET_KEY' : null);

  // Looks a preview up: { pet } when it's live, otherwise { problem: 'missing' | 'expired' | 'removed' }.
  // Malformed slugs never reach the store.
  async function lookup(slug) {
    const pet = typeof slug === 'string' && SLUG_PATTERN.test(slug) ? await store.getPet(slug) : null;
    if (!pet) return { problem: 'missing' };
    const status = previewStatus(pet, now());
    return status === 'live' ? { pet } : { problem: status };
  }

  const PROBLEMS = {
    missing: { status: 404, error: 'There is no preview with that slug.', page: () => notFoundPage() },
    removed: { status: 410, error: 'This preview was taken down.', page: () => removedPage() },
    expired: { status: 410, error: 'This preview has expired.', page: () => expiredPage({ retentionDays: PHOTO_RETENTION_DAYS }) },
  };

  // For the /p/<slug> pages: { pet } when it's live, or a ready 404/410 page.
  async function findLive(c) {
    const { pet, problem } = await lookup(c.req.param('slug'));
    return pet ? { pet } : { response: c.html(PROBLEMS[problem].page(), PROBLEMS[problem].status) };
  }

  // For the form posts: a page for a browser form, JSON for a JSON client.
  const failWith = (c, status, error, page) => (wantsJson(c) ? c.json({ error }, status) : c.html(page(), status));
  const problemResponse = (c, problem) => failWith(c, PROBLEMS[problem].status, PROBLEMS[problem].error, PROBLEMS[problem].page);
  const badSlug = (c) => failWith(c, 400, 'Which preview? The slug is missing or malformed.', errorPage);

  // Live preview, but the photo was deleted between the two reads (the job ran in between).
  const photoGone = (c) => c.html(expiredPage({ retentionDays: PHOTO_RETENTION_DAYS }), 410);

  // Deletes every photo older than the retention period; returns how many. Used by the daily job and by uploads.
  const expireOldPhotos = (at) => store.expirePhotos(new Date(at.getTime() - PHOTO_RETENTION_DAYS * DAY_MS), at);

  // The daily cron needs CRON_SECRET (set by hand) and a host with a scheduler. Uploads run the same deletion,
  // at most hourly per instance, so photos still go after 30 days and storage can't outgrow a month of
  // uploads without either. Best effort: a failure is logged and never fails the upload. Never rejects.
  let lastUploadSweep = -Infinity;
  async function sweepAfterUpload(at) {
    if (at.getTime() - lastUploadSweep < UPLOAD_SWEEP_INTERVAL_MS) return;
    lastUploadSweep = at.getTime();
    try {
      const deleted = await expireOldPhotos(at);
      if (deleted > 0) logger.info(`expire-photos (after upload): deleted ${deleted} photo(s) older than ${PHOTO_RETENTION_DAYS} days`);
    } catch (err) {
      logger.warn(`expire-photos (after upload): ${redact(err)}`);
    }
  }

  const photoDeletedAt = (pet) => new Date(pet.createdAt.getTime() + PHOTO_RETENTION_DAYS * DAY_MS);

  // When a Checkout Session for this preview must close: at most a day (Stripe's maximum) and never after the
  // preview expires, so nobody pays for one that is gone. null when it's under an hour away (too late to buy).
  function checkoutClosesAt(pet) {
    const at = now().getTime();
    const closesAt = Math.min(at + CHECKOUT_MAX_OPEN_MS, photoDeletedAt(pet).getTime());
    return closesAt - at < CHECKOUT_MIN_OPEN_MS ? null : new Date(closesAt);
  }
  const tooLateToBuy = (c) => failWith(c, 410, 'This preview expires within the hour, too soon to buy anything for it.', PROBLEMS.expired.page);

  // Creates the Checkout Session and sends the buyer there (303; JSON clients get the URL). Nothing is marked
  // paid here: only the signed webhook does that. `order` ({ product, orderId }) is set for gifts and prints.
  async function startCheckout(c, pet, closesAt, order = null) {
    const origin = new URL(c.req.url).origin;
    let session;
    try {
      session = await checkout({
        slug: pet.slug,
        successUrl: `${origin}/p/${pet.slug}?checkout=success`,
        cancelUrl: `${origin}/p/${pet.slug}`,
        expiresAt: closesAt,
        ...(order ?? {}),
      });
    } catch (err) {
      if (!(err instanceof PaymentError)) throw err;
      logger.error(`checkout: ${redact(err)}`);
      return failWith(c, 502, "We couldn't reach our payment provider. Please try again in a minute.", () => paymentsUnavailablePage({ retry: true }));
    }
    return wantsJson(c) ? c.json({ url: session.url }) : c.redirect(session.url, 303);
  }

  // M4: the last instant a gift for this preview may be due, and the gift form's settings (null: no form).
  const giftLatest = (pet) => new Date(photoDeletedAt(pet).getTime() - GIFT_MIN_DAYS_TO_DOWNLOAD * DAY_MS);
  function giftOffer(c, pet) {
    if (giftsMissing() || pet.paidAt) return null;
    const detected = c.req.header('x-vercel-ip-timezone');
    const zone = isTimeZone(detected) ? detected : DEFAULT_GIFT_ZONE;
    const minDate = dateIn(now(), zone);
    const maxDate = dateIn(giftLatest(pet), zone);
    return minDate <= maxDate ? { zone, minDate, maxDate, downloadBy: photoDeletedAt(pet) } : null;
  }

  // Emails one claimed gift. Returns 'sent', 'failed' (worth retrying: deliverGifts releases the claim) or
  // 'cancelled' (never sendable: logged for a refund). Logs name the order, never the recipient.
  async function deliverGift(order, at) {
    const cancel = async (why) => {
      await store.cancelGift(order.id, at);
      logger.error(`gift: order ${order.id} for preview ${order.slug} not sent: ${why}; refund it in Stripe`);
      return 'cancelled';
    };
    const pet = await store.getPet(order.slug);
    const status = pet ? previewStatus(pet, at) : 'missing';
    if (status !== 'live') return cancel(`the preview is ${status}`);
    if (!order.details) return cancel('its details were already erased');
    const email = giftEmail({ pet, details: order.details, link: `${order.origin}/p/${order.slug}`, downloadBy: photoDeletedAt(pet) });
    try {
      await sendEmail({ to: order.details.recipientEmail, toName: order.details.recipientName, ...email });
    } catch (err) {
      if (err instanceof EmailError && err.permanent) return cancel(`the email service refused it (${err.message})`);
      if (!(err instanceof EmailError)) throw err;
      logger.warn(`gift: order ${order.id} not sent yet (${err.message}); the next run retries`);
      return 'failed';
    }
    // It has gone. If recording that fails, the claim is kept (not released), so no run takes it again before the
    // lease runs out; a run after that may send it twice, which beats never.
    try {
      await store.markGiftSent(order.id, at);
    } catch (err) {
      logger.error(`gift: order ${order.id} was emailed but not recorded as sent (${redact(err)}); a run after the claim lease may send it again`);
      return 'sent';
    }
    logger.info(`gift: order ${order.id} for preview ${order.slug} emailed`);
    return 'sent';
  }

  // Claims the gifts due at `at` (or just order `id`) and emails each, batch after batch until none are left, so a
  // busy day's gifts all go that day. One gift's failure (Brevo, or the database) fails only that gift: it keeps
  // its claim until the run ends, so this run doesn't take it straight back, and is then released for the next
  // run. GIFT_OUTAGE_FAILURES in a row end the run, leaving the rest for the next one. Returns the counts.
  async function deliverGifts(at, { id = null } = {}) {
    const counts = { sent: 0, failed: 0, cancelled: 0 };
    const toRelease = [];
    let failedInARow = 0;
    try {
      for (let batch = 0; batch < GIFT_MAX_BATCHES && failedInARow < GIFT_OUTAGE_FAILURES; batch++) {
        const due = await store.claimDueGifts(at, { staleBefore: new Date(at.getTime() - GIFT_CLAIM_LEASE_MS), limit: GIFT_BATCH, id });
        for (const order of due) {
          let result = 'failed';
          if (failedInARow < GIFT_OUTAGE_FAILURES) {
            try {
              result = await deliverGift(order, at);
            } catch (err) {
              logger.error(`gift: order ${order.id} not sent yet (${redact(err)}); the next run retries`);
            }
          }
          counts[result] += 1;
          if (result === 'failed') {
            toRelease.push(order.id);
            failedInARow += 1;
          } else failedInARow = 0;
        }
        if (due.length < GIFT_BATCH) break;
      }
    } finally {
      for (const orderId of toRelease) {
        await store.releaseGift(orderId).catch((err) => logger.error(`gift: order ${orderId} not released (${redact(err)}); the claim lease frees it`));
      }
    }
    return counts;
  }

  // Places a paid print order with Prodigi, once: the stored Prodigi id skips the call, and Prodigi's idempotency
  // key (our order id) dedupes concurrent calls. Returns 'placed', 'transient' (Stripe should retry the event)
  // or 'permanent' (logged for a refund).
  async function placePrint(order) {
    if (order.podOrderId) return 'placed';
    if (!printOrder) {
      logger.error(`print: PRODIGI_API_KEY is not set, so paid print order ${order.id} waits; Stripe retries the event`);
      return 'transient';
    }
    if (!order.details) {
      logger.error(`print: order ${order.id} has no shipping address left; refund it in Stripe`);
      return 'permanent';
    }
    let placed;
    try {
      placed = await printOrder({ orderId: order.id, address: order.details, imageUrl: `${order.origin}/prints/${order.id}/poster.png` });
    } catch (err) {
      if (!(err instanceof PrintError)) throw err;
      if (err.permanent) {
        logger.error(`print: Prodigi refused order ${order.id} (${err.message}); fix it in the Prodigi dashboard or refund it in Stripe`);
        return 'permanent';
      }
      logger.error(`print: order ${order.id} not placed yet (${err.message}); Stripe retries the event`);
      return 'transient';
    }
    await store.setPrintOrder(order.id, placed.id);
    logger.info(`print: order ${order.id} placed with Prodigi as ${placed.id}`);
    return 'placed';
  }

  // The scheduled jobs' gate: fails closed without a secret, compares the bearer header in constant time (any
  // secret characters work; Hono's bearerAuth would 400 outside the token68 set). null means go ahead.
  async function cronRefusal(c, job) {
    c.header('Cache-Control', 'no-store');
    if (!cronSecret) {
      logger.error(`${job}: CRON_SECRET is not set, so the job will not run`);
      return c.json({ error: 'The job is not configured.' }, 503);
    }
    if (!(await timingSafeEqual(c.req.header('authorization') ?? '', `Bearer ${cronSecret}`))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
  }

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        // Chrome and Safari check form-action on every redirect after a form post, so the pay form's 303 to
        // Stripe Checkout would be blocked (the button would silently do nothing) without its origin here.
        formAction: ["'self'", STRIPE_CHECKOUT_ORIGIN],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      xFrameOptions: 'DENY',
    }),
  );

  // Everything under /p/ is a private preview, and /prints/ holds the print files: never indexed, never followed.
  const noindex = async (c, next) => {
    c.header('X-Robots-Tag', 'noindex, nofollow');
    await next();
  };
  app.use('/p/*', noindex);
  app.use('/prints/*', noindex);

  app.get('/', (c) => c.html(homePage()));

  app.get('/legal', (c) => c.html(legalPage({ retentionDays: PHOTO_RETENTION_DAYS })));

  app.get('/styles.css', (c) =>
    c.body(STYLES, 200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': ASSET_CACHE }),
  );

  app.get('/upload.js', (c) =>
    c.body(UPLOAD_SCRIPT, 200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': ASSET_CACHE,
    }),
  );

  app.post(
    '/generate',
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: PHOTO_TOO_BIG }, 400) }),
    async (c) => {
      let form;
      try {
        form = await c.req.raw.formData();
      } catch {
        return c.json({ error: 'Please send the form as multipart/form-data.' }, 400);
      }

      let input;
      try {
        input = await parsePetForm(form);
      } catch (err) {
        if (err instanceof InputError) return c.json({ error: err.message }, 400);
        throw err;
      }

      // Validate before storing: a bad model reply returns 502 and leaves no record behind.
      let character;
      try {
        character = await generateCharacter(input.pet, complete);
      } catch (err) {
        if (!(err instanceof ModelError)) throw err;
        logger.error(`generate: ${redact(err)}`);
        return c.json({ error: 'Our joke writer is stuck right now. Please try again in a minute.' }, 502);
      }

      const record = {
        slug: slug(),
        ...input.pet,
        character,
        photo: input.photo.bytes,
        photoType: input.photo.type,
        createdAt: now(),
      };
      try {
        await store.createPet(record);
      } catch (err) {
        logger.error(`store: ${redact(err)}`);
        return c.json({ error: "We couldn't save your preview. Please try again." }, 500);
      }

      await waitAtMost(sweepAfterUpload(record.createdAt), uploadSweepWaitMs);
      return c.json({ slug: record.slug, url: `/p/${record.slug}`, pet: input.pet, character });
    },
  );

  app.get('/p/:slug', async (c) => {
    const { pet, response } = await findLive(c);
    if (response) return response;
    c.header('Cache-Control', 'private, no-store');
    return c.html(
      previewPage(pet, {
        reportReasons: REPORT_REASONS,
        retentionDays: PHOTO_RETENTION_DAYS,
        checkoutReturn: c.req.query('checkout') === 'success',
        orders: await store.listOrders(pet.slug),
        gift: giftOffer(c, pet),
        prints: !printsMissing(),
      }),
    );
  });

  app.get('/p/:slug/photo', async (c) => {
    const { pet, response } = await findLive(c);
    if (response) return response;
    const photo = await store.getPhoto(pet.slug);
    if (!photo) return photoGone(c);
    return c.body(photo.bytes, 200, {
      'content-type': photo.type,
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=3600',
    });
  });

  // The wanted poster as a share-sized PNG: ?size=post (default, 1080×1350) or ?size=story (1080×1920).
  // `private` so no shared cache keeps serving it after the preview expires or is taken down.
  app.get('/p/:slug/share.png', async (c) => {
    const size = c.req.query('size') ?? 'post';
    if (!Object.hasOwn(SHARE_SIZES, size)) {
      return c.json({ error: `size must be one of: ${Object.keys(SHARE_SIZES).join(', ')}` }, 400);
    }
    const { pet, response } = await findLive(c);
    if (response) return response;
    const headers = {
      'content-type': 'image/png',
      'content-disposition': `inline; filename="${shareFileName(size)}"`,
      'cache-control': 'private, max-age=600',
    };
    // A render costs ~0.5 s of CPU; link checkers and unfurlers only want the status and headers.
    if (c.req.method === 'HEAD') return c.body(null, 200, headers);
    const photo = await store.getPhoto(pet.slug);
    if (!photo) return photoGone(c);
    const { png, photoShown, photoProblem } = await renderShare(pet, photo, { size, host: new URL(c.req.url).host });
    if (!photoShown) logger.warn(`share: photo not drawn (${redact(photoProblem ?? 'unknown')}); used a placeholder`);
    return c.body(png, 200, headers);
  });

  // The paid bundle: 402 until the preview is paid for, then a zip of the four clean high-res cards and a
  // PDF. Built in full first, so a failure is still a clean 500 page, then streamed: Vercel caps buffered
  // responses at 4.5 MB, and a bundle is ~5–20 MB.
  app.get('/p/:slug/bundle.zip', async (c) => {
    const { pet, response } = await findLive(c);
    if (response) return response;
    if (!pet.paidAt) {
      return wantsJson(c)
        ? c.json({ error: 'The bundle unlocks once it is paid for.', checkout: '/checkout' }, 402)
        : c.html(paymentRequiredPage(pet), 402);
    }
    const headers = {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${BUNDLE_FILE_NAME}"`,
      'cache-control': 'private, no-store',
    };
    if (c.req.method === 'HEAD') return c.body(null, 200, headers);
    const photo = await store.getPhoto(pet.slug);
    if (!photo) return photoGone(c);
    const { files, photoShown, photoProblem } = await renderBundle(pet, photo);
    if (!photoShown) logger.warn(`bundle: photo not drawn (${redact(photoProblem ?? 'unknown')}); used a placeholder`);
    const { stream, size } = zipFiles(files, { date: now() });
    return c.body(stream, 200, { ...headers, 'content-length': String(size) });
  });

  // Starts a Stripe Checkout for the bundle and sends the buyer there (303). Nothing is stored here: only the
  // signed webhook marks a preview paid.
  app.post('/checkout', ...sameSiteForm(), async (c) => {
    let input;
    try {
      input = await readForm(c);
    } catch {
      return badSlug(c);
    }
    if (typeof input.slug !== 'string' || !SLUG_PATTERN.test(input.slug)) return badSlug(c);
    const { pet, problem } = await lookup(input.slug);
    if (problem) return problemResponse(c, problem);
    if (pet.paidAt) return c.redirect(`/p/${pet.slug}`, 303); // a second tab: never charge twice
    const closesAt = checkoutClosesAt(pet);
    if (!closesAt) return tooLateToBuy(c);
    if (!checkout) {
      logger.error('checkout: STRIPE_SECRET_KEY is not set, so payments are off');
      return failWith(c, 503, 'Payments are not switched on yet.', () => paymentsUnavailablePage({ retry: false }));
    }
    return startCheckout(c, pet, closesAt);
  });

  // M4: buy the bundle as a gift. Stores the unpaid gift order (who, what, when), then the $9 Checkout. Paying
  // marks it paid and unlocks the preview; the email goes on the delivery date (deliverGifts).
  app.post('/gift', ...sameSiteForm(), async (c) => {
    let input;
    try {
      input = await readForm(c);
    } catch {
      return badSlug(c);
    }
    if (typeof input.slug !== 'string' || !SLUG_PATTERN.test(input.slug)) return badSlug(c);
    const { pet, problem } = await lookup(input.slug);
    if (problem) return problemResponse(c, problem);
    if (pet.paidAt) return c.redirect(`/p/${pet.slug}`, 303); // already unlocked: they can forward the link
    const missing = giftsMissing();
    if (missing) {
      logger.error(`gift: ${missing} is not set, so gifts are off`);
      return failWith(c, 503, 'Gifts are not switched on yet.', () => featureUnavailablePage('Gifts'));
    }
    let gift;
    try {
      gift = parseGiftForm(input, { now: now(), latest: giftLatest(pet) });
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      return failWith(c, 400, err.message, () => formProblemPage(pet, { title: 'Check the gift', heading: 'Please check the gift details', problems: [err.message] }));
    }
    const closesAt = checkoutClosesAt(pet);
    if (!closesAt) return tooLateToBuy(c);
    const order = {
      id: newSlug(),
      slug: pet.slug,
      kind: 'gift',
      amountCents: PRODUCTS.gift.cents,
      details: gift.details,
      origin: new URL(c.req.url).origin,
      createdAt: now(),
      deliverAt: gift.deliverAt,
    };
    try {
      await store.createOrder(order);
    } catch (err) {
      logger.error(`gift: ${redact(err)}`);
      return failWith(c, 500, "We couldn't save the gift. Please try again.", errorPage);
    }
    return startCheckout(c, pet, closesAt, { product: 'gift', orderId: order.id });
  });

  // M4: the printed poster, for a paid preview. Validates and stores the US shipping address with the unpaid
  // order, then the $29 Checkout. Paying places the print-on-demand order (placePrint).
  app.post('/print', ...sameSiteForm(), async (c) => {
    let input;
    try {
      input = await readForm(c);
    } catch {
      return badSlug(c);
    }
    if (typeof input.slug !== 'string' || !SLUG_PATTERN.test(input.slug)) return badSlug(c);
    const { pet, problem } = await lookup(input.slug);
    if (problem) return problemResponse(c, problem);
    if (!pet.paidAt) {
      return failWith(c, 402, 'The printed poster comes with the paid bundle. Unlock the bundle first.', () => paymentRequiredPage(pet, { print: true }));
    }
    const missing = printsMissing();
    if (missing) {
      logger.error(`print: ${missing} is not set, so printed posters are off`);
      return failWith(c, 503, 'Printed posters are not switched on yet.', () => featureUnavailablePage('Printed posters'));
    }
    let address;
    try {
      address = parseShippingAddress(input);
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      return wantsJson(c)
        ? c.json({ error: err.message, fields: err.fields }, 400)
        : c.html(formProblemPage(pet, { title: 'Check the address', heading: 'Please check the shipping address', problems: Object.values(err.fields) }), 400);
    }
    const closesAt = checkoutClosesAt(pet);
    if (!closesAt) return tooLateToBuy(c);
    const order = {
      id: newSlug(),
      slug: pet.slug,
      kind: 'print',
      amountCents: PRODUCTS.print.cents,
      details: address,
      origin: new URL(c.req.url).origin,
      createdAt: now(),
      deliverAt: null,
    };
    try {
      await store.createOrder(order);
    } catch (err) {
      logger.error(`print: ${redact(err)}`);
      return failWith(c, 500, "We couldn't save the order. Please try again.", errorPage);
    }
    return startCheckout(c, pet, closesAt, { product: 'print', orderId: order.id });
  });

  // M4: the print file Prodigi fetches for a paid print order. The order id (128-bit random) is the capability;
  // the preview must still be live. Streamed: ~10 MB, over Vercel's 4.5 MB cap on buffered responses.
  app.get('/prints/:id/poster.png', async (c) => {
    const id = c.req.param('id');
    const order = SLUG_PATTERN.test(id) ? await store.getOrder(id) : null;
    if (!order || order.kind !== 'print' || !order.paidAt) return c.html(notFoundPage(), 404);
    const { pet, problem } = await lookup(order.slug);
    if (problem) return c.html(PROBLEMS[problem].page(), PROBLEMS[problem].status);
    const headers = {
      'content-type': 'image/png',
      'content-disposition': `inline; filename="${PRINT_FILE_NAME}"`,
      'cache-control': 'private, max-age=3600',
    };
    if (c.req.method === 'HEAD') return c.body(null, 200, headers);
    const photo = await store.getPhoto(pet.slug);
    if (!photo) return photoGone(c);
    const { png, photoShown, photoProblem } = await renderPrint(pet, photo);
    if (!photoShown) logger.warn(`print: photo not drawn (${redact(photoProblem ?? 'unknown')}); used a placeholder`);
    return c.body(streamOf(png), 200, { ...headers, 'content-length': String(png.length) });
  });

  // Stripe's webhook. Only a correctly signed, fresh event changes anything, and a payment is recorded once:
  // repeats and second sessions change nothing. Stripe retries anything but a 2xx for up to three days, so a
  // fixed secret or a recovered database still gets the events; everything verified and handled is a 200.
  app.post(
    '/stripe/webhook',
    bodyLimit({ maxSize: MAX_WEBHOOK_BYTES, onError: (c) => c.json({ error: 'Payload too large.' }, 413) }),
    async (c) => {
      if (!webhookSecret) {
        logger.error('stripe webhook: STRIPE_WEBHOOK_SECRET is not set, so events are refused');
        return c.json({ error: 'The webhook is not configured.' }, 503);
      }
      let event;
      try {
        const payload = new Uint8Array(await c.req.arrayBuffer());
        event = await verifyStripeEvent(payload, c.req.header('stripe-signature'), webhookSecret, now());
      } catch (err) {
        if (!(err instanceof SignatureError)) throw err;
        logger.warn(`stripe webhook: refused, ${err.message}`);
        return c.json({ error: 'Invalid signature.' }, 400);
      }
      const session = event.data?.object;
      // Bank debits complete unpaid; they count when async_payment_succeeded arrives with payment_status paid.
      if (!PAID_EVENT_TYPES.has(event.type) || session?.payment_status !== 'paid') return c.json({ received: true });

      const sessionId = String(session.id);
      // metadata.slug is set only by our own session request. client_reference_id is not trusted: on a
      // Payment Link (should the account ever have one) the buyer sets it from the URL.
      const slug = session.metadata?.slug;
      if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) {
        logger.error(`payment: paid session ${sessionId} names no valid preview; refund it in Stripe`);
        return c.json({ received: true });
      }
      // M4: a gift or a print carries its order; the bundle (M3) doesn't.
      if (session.metadata?.order !== undefined) return orderPaid(c, session, sessionId, slug);
      if (session.amount_total !== PRICE_CENTS || session.currency !== CURRENCY) {
        logger.error(`payment: session ${sessionId} paid ${session.amount_total} ${session.currency}, not the bundle price; preview ${slug} not unlocked, check it in Stripe`);
        return c.json({ received: true });
      }
      const pet = await store.getPet(slug);
      if (!pet) {
        logger.error(`payment: paid session ${sessionId} is for unknown preview ${slug}; refund it in Stripe`);
        return c.json({ received: true });
      }
      const result = await store.markPaid(slug, { sessionId, at: now() });
      if (result?.changed) {
        logger.info(`payment: preview ${slug} paid (session ${sessionId})`);
        // A bank debit can confirm days after checkout, and a preview can be taken down meanwhile.
        const status = previewStatus(pet, now());
        if (status !== 'live') logger.error(`payment: preview ${slug} is ${status}, so the buyer can't download it; refund session ${sessionId} in Stripe`);
      } else if (result && result.sessionId !== sessionId) {
        logger.warn(`payment: preview ${slug} was already paid (session ${result.sessionId}); session ${sessionId} is a second payment, refund it in Stripe`);
      }
      return c.json({ received: true });
    },
  );

  // M4: a verified, paid Checkout Session for a gift or print order. The order (from our own metadata) must
  // exist, belong to that preview and match the amount. Then it's marked paid once, and what it bought follows,
  // also on every repeat of the event, so a delivery that failed the first time is retried by Stripe:
  //   gift:  the preview is unlocked; if the date has already come, the email goes now (the daily run may be over)
  //   print: the print-on-demand order is placed unless it already was
  // A transient failure answers 500, which Stripe retries for up to three days.
  async function orderPaid(c, session, sessionId, slug) {
    const received = () => c.json({ received: true });
    const orderId = session.metadata.order;
    const order = typeof orderId === 'string' && SLUG_PATTERN.test(orderId) ? await store.getOrder(orderId) : null;
    if (!order || order.slug !== slug) {
      logger.error(`payment: paid session ${sessionId} names no known order for preview ${slug}; refund it in Stripe`);
      return received();
    }
    if (session.amount_total !== order.amountCents || session.currency !== CURRENCY) {
      logger.error(`payment: session ${sessionId} paid ${session.amount_total} ${session.currency}, not the ${order.kind} price; order ${order.id} not marked paid, check it in Stripe`);
      return received();
    }
    const result = await store.markOrderPaid(order.id, { sessionId, at: now() });
    if (result.changed) logger.info(`payment: ${order.kind} order ${order.id} for preview ${slug} paid (session ${sessionId})`);
    else if (result.sessionId !== sessionId) {
      logger.warn(`payment: ${order.kind} order ${order.id} was already paid (session ${result.sessionId}); session ${sessionId} is a second payment, refund it in Stripe`);
    }
    const pet = await store.getPet(slug);
    const status = pet ? previewStatus(pet, now()) : 'missing';
    const paid = await store.getOrder(order.id);

    if (order.kind === 'gift') {
      const unlock = await store.markPaid(slug, { sessionId, at: now() });
      if (unlock && !unlock.changed && unlock.sessionId !== sessionId && result.changed) {
        logger.warn(`payment: preview ${slug} was already unlocked (session ${unlock.sessionId}); gift order ${order.id} still goes out, one payment could be refunded`);
      }
      if (paid.deliverAt <= now() && !paid.sentAt && !paid.cancelledAt) {
        if (!sendEmail) {
          logger.error(`gift: BREVO_API_KEY or EMAIL_FROM is not set, so gift order ${order.id} waits; Stripe retries the event`);
          return c.json({ error: 'Email is not configured.' }, 500);
        }
        const { failed } = await deliverGifts(now(), { id: order.id });
        if (failed > 0) return c.json({ error: 'The gift email failed; retry.' }, 500);
      }
      return received();
    }

    if (!paid.podOrderId && status !== 'live') {
      logger.error(`print: order ${order.id} is for preview ${slug}, which is ${status}, so it isn't sent to the printer; refund session ${sessionId} in Stripe`);
      return received();
    }
    return (await placePrint(paid)) === 'transient' ? c.json({ error: 'The printer is unavailable; retry.' }, 500) : received();
  }

  // Daily (vercel.json, 16:00 UTC): emails every paid gift whose delivery date has come, once.
  app.get('/jobs/deliver-gifts', async (c) => {
    const refusal = await cronRefusal(c, 'deliver-gifts');
    if (refusal) return refusal;
    if (!sendEmail) {
      logger.error('deliver-gifts: BREVO_API_KEY or EMAIL_FROM is not set, so gifts cannot be emailed');
      return c.json({ error: 'Email is not configured.' }, 503);
    }
    let counts;
    try {
      counts = await deliverGifts(now());
    } catch (err) {
      logger.error(`deliver-gifts: ${redact(err)}`);
      return c.json({ error: 'The job failed. It will run again tomorrow.' }, 500);
    }
    logger.info(`deliver-gifts: sent ${counts.sent}, failed ${counts.failed}, cancelled ${counts.cancelled}`);
    return c.json(counts);
  });

  // The one included rewrite of a paid preview's text. It's used up only when the new text is stored: a
  // model failure leaves it available. The pre-checks spare the model quota; the store's conditional
  // UPDATE is what makes "once" hold when two requests race.
  app.post('/regenerate', ...sameSiteForm(), async (c) => {
    let input;
    try {
      input = await readForm(c);
    } catch {
      return badSlug(c);
    }
    if (typeof input.slug !== 'string' || !SLUG_PATTERN.test(input.slug)) return badSlug(c);
    const { pet, problem } = await lookup(input.slug);
    if (problem) return problemResponse(c, problem);
    const used = () => failWith(c, 409, "This preview's one rewrite is already used.", () => rewriteUsedPage(pet));
    if (!pet.paidAt) return failWith(c, 402, 'The rewrite comes with the paid bundle.', () => paymentRequiredPage(pet));
    if (pet.regeneratedAt) return used();

    let character;
    try {
      character = await generateCharacter(pet, complete);
    } catch (err) {
      if (!(err instanceof ModelError)) throw err;
      logger.error(`regenerate: ${redact(err)}`);
      return failWith(c, 502, 'Our joke writer is stuck right now. Your rewrite is still available; please try again in a minute.', () =>
        rewriteFailedPage(pet),
      );
    }
    let saved;
    try {
      saved = await store.saveRegenerated(pet.slug, character, now());
    } catch (err) {
      logger.error(`regenerate: ${redact(err)}`);
      return failWith(c, 500, "We couldn't save the new text. Please try again.", errorPage);
    }
    if (!saved) return used(); // another request used it while the model was writing
    return wantsJson(c) ? c.json({ ok: true, character }) : c.redirect(`/p/${pet.slug}`, 303);
  });

  // Report a preview. One report per person per preview; at REPORT_LIMIT the preview, its photo and its
  // share images return 410.
  app.post(
    '/report',
    ...sameSiteForm(),
    async (c) => {
      const fail = (status, error) =>
        wantsJson(c) ? c.json({ error }, status) : c.html(status === 404 ? notFoundPage() : errorPage(), status);

      let input;
      try {
        input = await readForm(c);
      } catch {
        return fail(400, 'Please send the report as a form or as JSON.');
      }
      const reportSlug = typeof input.slug === 'string' ? input.slug : '';
      if (!SLUG_PATTERN.test(reportSlug)) return fail(400, 'Which preview? The slug is missing or malformed.');
      const reason = REPORT_REASONS.some((r) => r.id === input.reason) ? input.reason : 'other';

      let result;
      try {
        const reporter = await reporterKey(reportSlug, clientIp(c));
        result = await store.reportPet(reportSlug, { reporter, reason, at: now() });
      } catch (err) {
        logger.error(`report: ${redact(err)}`);
        return fail(500, "We couldn't save your report. Please try again.");
      }
      if (result === null) return fail(404, 'There is no preview with that slug.');
      // Only the report that tipped it over logs; a resubmitted form (same reporter) doesn't repeat it.
      if (result.added && result.reports === REPORT_LIMIT) {
        logger.warn(`report: preview ${reportSlug} reached ${REPORT_LIMIT} reports and is now hidden (410); review it`);
      }
      return wantsJson(c) ? c.json({ ok: true, reports: result.reports }) : c.html(reportThanksPage());
    },
  );

  // Daily photo deletion, called by Vercel Cron with `Authorization: Bearer $CRON_SECRET` (vercel.json).
  // Fails closed without a secret (cronRefusal).
  app.get('/jobs/expire-photos', async (c) => {
    const refusal = await cronRefusal(c, 'expire-photos');
    if (refusal) return refusal;
    let deleted;
    try {
      deleted = await expireOldPhotos(now());
    } catch (err) {
      logger.error(`expire-photos: ${redact(err)}`);
      return c.json({ error: 'The job failed. It will run again tomorrow.' }, 500);
    }
    logger.info(`expire-photos: deleted ${deleted} photo(s) older than ${PHOTO_RETENTION_DAYS} days`);
    return c.json({ deleted });
  });

  app.notFound((c) => c.html(notFoundPage(), 404));

  app.onError((err, c) => {
    // Middleware (csrf) signals 4xx by throwing; those are answers, not failures.
    if (err instanceof HTTPException) return err.getResponse();
    logger.error(`unhandled: ${redact(err)}`);
    if (c.req.method === 'GET') return c.html(errorPage(), 500);
    return c.json({ error: 'Something went wrong. Please try again.' }, 500);
  });

  return app;
}
