// Screenshot proof for the README: `npm run screenshots` (not part of `npm test`).
// Starts the dev server (scripts/dev.js) on a free port with the service variables removed, so previews live
// in memory, the canned demo writer is used, and Stripe, Brevo and Prodigi are the dev server's local stand-ins
// (paid through its own signed webhook): no database, no model call, no secrets, no email sent, nothing
// printed. Then drives Chromium through the real flow with a sample dog (drawn below, so no real photo or person
// is involved), at desktop size (1280×800) and on an iPhone 13, viewport only:
//   home-*            the form, filled in
//   preview-mobile    the free preview's "Buy it as a gift" form, filled in (M4's core action)
//   preview-desktop   after paying for the gift and a printed poster: "Your orders" over the clean cards
//   share-*           the share image of the now-paid preview (no "free preview" stamp)
// Needs CHROMIUM_PATH pointing at an installed Chromium or Chrome; playwright-core never downloads a browser.
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = 'docs/screenshots';
const START_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 20_000;

// Unset for the app so it never reaches a real database, model, payment, email or print service, whatever the
// shell has exported.
const SERVICE_VARS = [
  'DATABASE_URL',
  'GOOGLE_API_KEY',
  'LLM_API_KEY',
  'LLM_BASE_URL',
  'LLM_MODEL',
  'CRON_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'BREVO_API_KEY',
  'EMAIL_FROM',
  'PRODIGI_API_KEY',
  'PRODIGI_ENV',
];

const SAMPLE_PET = {
  name: 'Biscuit',
  species: 'dog',
  traits: ['greedy', 'dramatic', 'afraid of the vacuum'],
  alterEgo: 'crime-boss',
};

// Sample people and a sample address (example.com, a fictional street): no real person's data.
const SAMPLE_GIFT = {
  recipientEmail: 'jamie@example.com',
  recipientName: 'Jamie',
  fromName: 'Sam',
  message: 'Happy birthday! I always knew Biscuit was up to something.',
  daysAhead: 6,
};
const SAMPLE_ADDRESS = { name: 'Jamie Rivera', line1: '742 Evergreen Terrace', city: 'Portland', state: 'OR', zip: '97201' };
// The form's default zone when the host sends none (scripts/dev.js has no x-vercel-ip-timezone).
const GIFT_ZONE = 'America/New_York';

// Which steps each size keeps. The phone gets the Stories-sized share image, the desktop the feed-sized one.
const VIEWS = [
  { suffix: 'desktop', context: { viewport: { width: 1280, height: 800 } }, giftForm: false, orders: true, share: { name: 'share-post', query: '' } },
  { suffix: 'mobile', context: devices['iPhone 13'], giftForm: true, orders: false, share: { name: 'share-story', query: '?size=story' } },
];

// "YYYY-MM-DD" `days` after today in `timeZone`.
function dateAhead(days, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  const day = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day + days));
  return day.toISOString().slice(0, 10);
}

// A beagle on a sofa, with a collar and a judgmental eyebrow. Rendered to JPEG by the browser at run time.
const DOG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="900" viewBox="0 0 900 900">
  <defs>
    <radialGradient id="wall" cx="50%" cy="35%" r="80%"><stop offset="0" stop-color="#d6eef7"/><stop offset="1" stop-color="#7fb5cf"/></radialGradient>
    <radialGradient id="fur" cx="50%" cy="30%" r="75%"><stop offset="0" stop-color="#eab67a"/><stop offset="1" stop-color="#b06f35"/></radialGradient>
    <linearGradient id="sofa" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8a5a9e"/><stop offset="1" stop-color="#5b3870"/></linearGradient>
  </defs>
  <rect width="900" height="900" fill="url(#wall)"/>
  <rect x="0" y="610" width="900" height="290" rx="40" fill="url(#sofa)"/>
  <rect x="60" y="560" width="160" height="120" rx="30" fill="#f2c14e" transform="rotate(-12 140 620)"/>
  <ellipse cx="450" cy="790" rx="260" ry="200" fill="url(#fur)"/>
  <ellipse cx="450" cy="815" rx="135" ry="150" fill="#f7ead8"/>
  <path d="M285 290 C 175 310, 150 520, 230 615 C 300 580, 330 440, 330 330 Z" fill="#6b3f1f"/>
  <path d="M615 290 C 725 310, 750 520, 670 615 C 600 580, 570 440, 570 330 Z" fill="#6b3f1f"/>
  <ellipse cx="450" cy="400" rx="185" ry="180" fill="url(#fur)"/>
  <path d="M450 235 C 425 300, 415 380, 385 450 L 515 450 C 485 380, 475 300, 450 235 Z" fill="#f7ead8"/>
  <ellipse cx="450" cy="495" rx="118" ry="88" fill="#f7ead8"/>
  <path d="M330 340 Q 372 318 412 345" stroke="#5a3418" stroke-width="12" fill="none" stroke-linecap="round"/>
  <path d="M492 352 Q 530 342 568 352" stroke="#5a3418" stroke-width="12" fill="none" stroke-linecap="round"/>
  <ellipse cx="373" cy="392" rx="27" ry="31" fill="#2a1a0e"/>
  <ellipse cx="527" cy="392" rx="27" ry="31" fill="#2a1a0e"/>
  <circle cx="383" cy="381" r="9" fill="#fff"/>
  <circle cx="537" cy="381" r="9" fill="#fff"/>
  <ellipse cx="450" cy="458" rx="42" ry="29" fill="#2a1a0e"/>
  <ellipse cx="437" cy="449" rx="11" ry="6" fill="#6a5442"/>
  <path d="M432 530 Q 451 600 472 530 Z" fill="#e8677a"/>
  <path d="M450 487 L 450 515 M 450 515 Q 420 545 392 518 M 450 515 Q 480 545 508 518" stroke="#2a1a0e" stroke-width="7" fill="none" stroke-linecap="round"/>
  <path d="M300 590 Q 450 655 600 590 L 600 628 Q 450 695 300 628 Z" fill="#c2410c"/>
  <circle cx="450" cy="672" r="30" fill="#facc15" stroke="#a16207" stroke-width="6"/>
</svg>`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startApp() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port) };
  for (const name of SERVICE_VARS) delete env[name];
  const child = spawn(process.execPath, ['scripts/dev.js'], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = `http://localhost:${port}`;
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited before answering (exit code ${child.exitCode})`);
    try {
      if ((await fetch(base)).ok) return { base, child };
    } catch {
      // Not listening yet.
    }
    await sleep(200);
  }
  child.kill();
  throw new Error(`the app did not answer on ${base} within ${START_TIMEOUT_MS / 1000} s`);
}

async function stopApp(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(5_000)]);
}

async function samplePhoto(browser) {
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.setContent(`<body style="margin:0">${DOG_SVG}</body>`);
  const buffer = await page.screenshot({ type: 'jpeg', quality: 90 });
  await page.close();
  return { name: 'biscuit.jpg', mimeType: 'image/jpeg', buffer };
}

// The share PNG exactly as the app sent it, centred and fitted to the screen. Chromium's own image viewer
// pins it to the left on desktop and lays it out 980px wide on a phone, so it isn't used.
const shareViewer = (png) => `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body { height: 100%; margin: 0; background: #1d1a16; }
  body { display: grid; place-items: center; }
  img { display: block; max-width: 96vw; max-height: 96vh; }
</style>
<img src="data:image/png;base64,${png.toString('base64')}" alt="">`;

// Every visible image decoded, so no screenshot catches a half-loaded photo.
const imagesLoaded = (page) =>
  page.waitForFunction(() => [...document.images].filter((img) => !img.hidden).every((img) => img.complete && img.naturalWidth > 0));

async function save(page, name) {
  const path = `${OUT_DIR}/${name}.png`;
  await page.screenshot({ path: `${ROOT}${path}` });
  console.log(`saved ${path}`);
}

async function captureFlow(browser, base, photo, view) {
  const context = await browser.newContext(view.context);
  const page = await context.newPage();
  try {
    await page.goto(`${base}/`);
    await page.setInputFiles('input[name="photo"]', photo);
    await page.fill('input[name="name"]', SAMPLE_PET.name);
    await page.selectOption('select[name="species"]', SAMPLE_PET.species);
    const traitBoxes = page.locator('input[name="traits"]');
    for (const [i, trait] of SAMPLE_PET.traits.entries()) await traitBoxes.nth(i).fill(trait);
    await page.check(`input[name="alterEgo"][value="${SAMPLE_PET.alterEgo}"]`);
    await imagesLoaded(page);
    // Filling scrolled the phone down to the last field; show the page from the top, nothing focused.
    await page.evaluate(() => {
      document.activeElement?.blur();
      window.scrollTo(0, 0);
    });
    await save(page, `home-${view.suffix}`);

    await page.click('button[type="submit"]');
    try {
      await page.waitForURL(/\/p\/[\w-]+$/, { timeout: GENERATE_TIMEOUT_MS });
    } catch {
      throw new Error(`no preview after submitting the form: ${(await page.textContent('#form-status')) || 'no status shown'}`);
    }
    await imagesLoaded(page);
    const previewUrl = page.url();

    // M4: buy it as a gift, delivered in six days.
    await page.click('details.gift > summary');
    const gift = page.locator('form[action="/gift"]');
    await gift.locator('input[name="recipientEmail"]').fill(SAMPLE_GIFT.recipientEmail);
    await gift.locator('input[name="recipientName"]').fill(SAMPLE_GIFT.recipientName);
    await gift.locator('input[name="fromName"]').fill(SAMPLE_GIFT.fromName);
    await gift.locator('textarea[name="message"]').fill(SAMPLE_GIFT.message);
    await gift.locator('input[name="deliverOn"]').fill(dateAhead(SAMPLE_GIFT.daysAhead, GIFT_ZONE));
    await gift.locator('select[name="timeZone"]').selectOption(GIFT_ZONE);
    if (view.giftForm) {
      await page.evaluate(() => {
        document.activeElement?.blur();
        document.querySelector('details.gift').scrollIntoView({ block: 'start' });
        window.scrollBy(0, -12);
      });
      await save(page, `preview-${view.suffix}`);
    }
    await gift.locator('button[type="submit"]').click();
    await page.waitForURL(/\?checkout=success$/);
    if (!(await page.locator('.orders').count())) throw new Error('no "Your orders" box after paying for the gift');

    // M4: then the printed poster, offered on the paid page.
    await page.click('details.print-details > summary');
    const print = page.locator('form[action="/print"]');
    for (const field of ['name', 'line1', 'city', 'zip']) await print.locator(`input[name="${field}"]`).fill(SAMPLE_ADDRESS[field]);
    await print.locator('select[name="state"]').selectOption(SAMPLE_ADDRESS.state);
    await print.locator('button[type="submit"]').click();
    await page.waitForURL(/\?checkout=success$/);
    const orders = await page.textContent('.orders');
    if (!/We'll email/.test(orders) || !/Sent to the printer/.test(orders)) throw new Error(`unexpected orders box: ${orders}`);
    await imagesLoaded(page);
    if (view.orders) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await save(page, `preview-${view.suffix}`);
    }

    const share = await page.request.get(`${previewUrl}/share.png${view.share.query}`);
    if (!share.ok() || share.headers()['content-type'] !== 'image/png') {
      throw new Error(`share image answered ${share.status()} ${share.headers()['content-type']}`);
    }
    // A blank tab: the preview page's CSP would block the viewer's inline style.
    const viewer = await context.newPage();
    await viewer.setContent(shareViewer(await share.body()));
    await imagesLoaded(viewer);
    await save(viewer, `${view.share.name}-${view.suffix}`);
  } finally {
    await context.close();
  }
}

async function main() {
  if (!process.env.CHROMIUM_PATH) {
    throw new Error('Set CHROMIUM_PATH to an installed Chromium or Chrome; this script never downloads a browser.');
  }
  await mkdir(`${ROOT}${OUT_DIR}`, { recursive: true });
  const { base, child } = await startApp();
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    const photo = await samplePhoto(browser);
    for (const view of VIEWS) await captureFlow(browser, base, photo, view);
  } finally {
    await browser?.close();
    await stopApp(child);
  }
}

main().catch((err) => {
  console.error(`screenshots: ${err.message}`);
  process.exit(1);
});
