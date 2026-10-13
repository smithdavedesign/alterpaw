// Routes. Dependencies are injected so tests run with a fake model, an in-memory store and a fixed clock:
//   createApp({ store, complete, logger, now, renderShare, cronSecret })
//     store       — createPet / getPet / getPhoto / reportPet / expirePhotos (store.js)
//     complete    — (messages) => Promise<string>, one chat-completion call (character.js)
//     now         — () => Date; drives the 30-day expiry
//     renderShare — (pet, photo, { size, host }) => Promise<{ png, photoShown }> (share.js, loaded on first use)
//     cronSecret  — bearer token Vercel Cron sends to /jobs/expire-photos; unset means the job refuses to run
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { csrf } from 'hono/csrf';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { timingSafeEqual } from 'hono/utils/buffer';
import { generateCharacter, ModelError } from './character.js';
import { parsePetForm, InputError, MAX_BODY_BYTES, PHOTO_TOO_BIG } from './input.js';
import {
  homePage,
  previewPage,
  expiredPage,
  removedPage,
  reportThanksPage,
  notFoundPage,
  errorPage,
  STYLES,
  UPLOAD_SCRIPT,
  SHARE_SIZES,
  shareFileName,
} from './views.js';

// 16 random bytes → 22 base64url characters. Previews are only reachable by knowing the slug.
const SLUG_BYTES = 16;
const SLUG_PATTERN = /^[A-Za-z0-9_-]{12,64}$/;
const ASSET_CACHE = 'public, max-age=3600';

// Moderation and retention policy. The store only counts and deletes; these numbers decide.
export const REPORT_LIMIT = 3; // distinct reporters before a preview is taken down (410)
export const PHOTO_RETENTION_DAYS = 30; // photos older than this are deleted and the preview shows "expired"
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_REPORT_BYTES = 8 * 1024;
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

// Same-site check for /report that survives TLS termination: compare hosts, not full origins (http vs https).
function sameHost(origin, c) {
  try {
    return new URL(origin).host === new URL(c.req.url).host;
  } catch {
    return false;
  }
}

const wantsJson = (c) => /application\/json/i.test(`${c.req.header('accept') ?? ''} ${c.req.header('content-type') ?? ''}`);

async function readReport(c) {
  if (/^application\/json/i.test(c.req.header('content-type') ?? '')) {
    const body = await c.req.json();
    return body && typeof body === 'object' ? body : {};
  }
  return c.req.parseBody();
}

// The renderer pulls in satori and resvg (~200 ms to load), so it's imported on the first share image only.
const renderShareLazily = async (...args) => (await import('./share.js')).renderSharePng(...args);

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
}) {
  const app = new Hono();

  // Looks a preview up and decides what the visitor gets: { pet } when it's live, or a ready 404/410 response.
  async function findLive(c) {
    const slugParam = c.req.param('slug');
    const pet = SLUG_PATTERN.test(slugParam) ? await store.getPet(slugParam) : null;
    if (!pet) return { response: c.html(notFoundPage(), 404) };
    const status = previewStatus(pet, now());
    if (status === 'removed') return { response: c.html(removedPage(), 410) };
    if (status === 'expired') return { response: c.html(expiredPage({ retentionDays: PHOTO_RETENTION_DAYS }), 410) };
    return { pet };
  }

  // Live preview, but the photo was deleted between the two reads (the job ran in between).
  const photoGone = (c) => c.html(expiredPage({ retentionDays: PHOTO_RETENTION_DAYS }), 410);

  app.use(
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'blob:', 'data:'],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      xFrameOptions: 'DENY',
    }),
  );

  // Everything under /p/ is a private preview: never indexed, never followed.
  app.use('/p/*', async (c, next) => {
    c.header('X-Robots-Tag', 'noindex, nofollow');
    await next();
  });

  app.get('/', (c) => c.html(homePage()));

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

      return c.json({ slug: record.slug, url: `/p/${record.slug}`, pet: input.pet, character });
    },
  );

  app.get('/p/:slug', async (c) => {
    const { pet, response } = await findLive(c);
    if (response) return response;
    c.header('Cache-Control', 'private, no-store');
    return c.html(previewPage(pet, { reportReasons: REPORT_REASONS, retentionDays: PHOTO_RETENTION_DAYS }));
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
    const photo = await store.getPhoto(pet.slug);
    if (!photo) return photoGone(c);
    const { png, photoShown, photoProblem } = await renderShare(pet, photo, { size, host: new URL(c.req.url).host });
    if (!photoShown) logger.warn(`share: photo not drawn (${redact(photoProblem ?? 'unknown')}); used a placeholder`);
    return c.body(png, 200, {
      'content-type': 'image/png',
      'content-disposition': `inline; filename="${shareFileName(size)}"`,
      'cache-control': 'private, max-age=600',
    });
  });

  // Report a preview. One report per person per preview; at REPORT_LIMIT the preview, its photo and its
  // share images return 410. The CSRF check stops a hostile page from making its visitors' browsers report.
  app.post(
    '/report',
    csrf({ origin: sameHost }),
    bodyLimit({ maxSize: MAX_REPORT_BYTES, onError: (c) => c.json({ error: 'That report is too large.' }, 413) }),
    async (c) => {
      const fail = (status, error) =>
        wantsJson(c) ? c.json({ error }, status) : c.html(status === 404 ? notFoundPage() : errorPage(), status);

      let input;
      try {
        input = await readReport(c);
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
  // Fails closed without a secret. The header is compared in constant time, and any secret characters work
  // (Hono's bearerAuth would 400 on characters outside the token68 set).
  app.get('/jobs/expire-photos', async (c) => {
    c.header('Cache-Control', 'no-store');
    if (!cronSecret) {
      logger.error('expire-photos: CRON_SECRET is not set, so the job will not run');
      return c.json({ error: 'The job is not configured.' }, 503);
    }
    if (!(await timingSafeEqual(c.req.header('authorization') ?? '', `Bearer ${cronSecret}`))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const at = now();
    let deleted;
    try {
      deleted = await store.expirePhotos(new Date(at.getTime() - PHOTO_RETENTION_DAYS * DAY_MS), at);
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
