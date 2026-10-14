// M4: buy the bundle as a gift. The buyer makes the preview from the recipient's pet photo, pays $9, and the
// recipient gets one email on the chosen date.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeApp,
  createPreview,
  petRecord,
  fakeCheckout,
  fakeWebhookSecret,
  fakeCronSecret,
  fakeEmail,
  testClock,
  giftFields,
  payOrder,
  runGiftJob,
  postForm,
  postJson,
  payFor,
  DAY_MS,
} from './helpers.js';
import { REPORT_LIMIT, GIFT_CLAIM_LEASE_MS } from '../src/app.js';
import { PRODUCTS } from '../src/payments.js';
import { EmailError } from '../src/email.js';
import { startOfDayIn, dateIn, isTimeZone, parseGiftForm, InputError, MAX_GIFT_MESSAGE_LENGTH } from '../src/input.js';
import { giftEmail } from '../src/views.js';

const SECRET = fakeWebhookSecret();
const CRON = fakeCronSecret();
const SITE = 'https://alterpaw.example';
// Mid-afternoon in New York on Wednesday, October 14, 2026.
const START = '2026-10-14T19:00:00Z';

// An app with everything a gift needs: Stripe (fake), email (fake), the scheduler secret and a hand-moved clock.
function giftApp(options = {}) {
  const clock = testClock(options.start ?? START);
  const email = fakeEmail();
  const { checkout, calls } = fakeCheckout();
  const ctx = makeApp({ now: clock.now, checkout, webhookSecret: SECRET, sendEmail: email.sendEmail, cronSecret: CRON, ...options.app });
  return { ...ctx, clock, email, checkoutCalls: calls };
}

const postGift = (app, fields, options = {}) => postForm(app, `${SITE}/gift`, fields, { origin: SITE, ...options });

const HOUR_MS = 60 * 60 * 1000;

// The UTC hour of the gift job's daily schedule in vercel.json ("M H * * *"). Vercel Hobby fires a daily cron
// anywhere within its hour, so a run is any instant from H:00 to H:59:59.999 UTC.
async function giftRunHour() {
  const { readFile } = await import('node:fs/promises');
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const crons = (config.crons ?? []).filter((c) => c.path === '/jobs/deliver-gifts');
  assert.equal(crons.length, 1, 'one gift job');
  const match = crons[0].schedule.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  assert.ok(match, `a once-a-day schedule (Hobby allows no more): ${crons[0].schedule}`);
  return Number(match[2]);
}

// Preview → gift form → Stripe → signed webhook. Returns the order's checkout request.
async function buyGift(ctx, overrides = {}) {
  const slug = await createPreview(ctx.app);
  const res = await postGift(ctx.app, giftFields(slug, overrides));
  assert.equal(res.status, 303, await res.clone().text());
  const request = ctx.checkoutCalls.at(-1);
  await payOrder(ctx.app, request, SECRET, ctx.clock.seconds());
  return { slug, request };
}

describe('a gift is emailed once, on its delivery date (M4 exit criterion 1)', () => {
  test('a gift with a future delivery date sends nothing before that date and one email on it', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);

    const res = await postGift(ctx.app, giftFields(slug, { deliverOn: '2026-10-20', timeZone: 'America/New_York' }));
    assert.equal(res.status, 303);
    assert.match(res.headers.get('location'), /^https:\/\/checkout\.stripe\.com\//);
    const request = ctx.checkoutCalls[0];
    assert.equal(request.product, 'gift');
    assert.equal(request.slug, slug);
    assert.match(request.orderId, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(PRODUCTS.gift.cents, 900, 'the gift is the $9 bundle');

    await payOrder(ctx.app, request, SECRET, ctx.clock.seconds());
    assert.ok((await ctx.store.getPet(slug)).paidAt, 'paying for the gift unlocks the bundle');
    assert.equal(ctx.email.sent.length, 0, 'nothing is sent when it is paid for');

    // Every day's run before the date sends nothing, up to the last millisecond of October 19 in New York.
    const hour = await giftRunHour();
    for (const when of [Date.UTC(2026, 9, 15, hour), Date.UTC(2026, 9, 19, hour, 59, 59, 999), '2026-10-20T03:59:59.999Z']) {
      ctx.clock.set(when);
      const { res: run, body } = await runGiftJob(ctx.app, CRON);
      assert.equal(run.status, 200);
      assert.deepEqual(body, { sent: 0, failed: 0, cancelled: 0 }, when);
    }
    assert.equal(ctx.email.sent.length, 0);

    // Midnight, October 20, New York time: due.
    ctx.clock.set('2026-10-20T04:00:00Z');
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 1, failed: 0, cancelled: 0 });
    assert.equal(ctx.email.sent.length, 1);
    const [email] = ctx.email.sent;
    assert.equal(email.to, 'jamie@example.com');
    assert.equal(email.toName, 'Jamie');
    assert.match(email.subject, /Sam/);
    assert.ok(email.text.includes(`${SITE}/p/${slug}`), 'the link to the unlocked preview');
    assert.ok(email.text.includes('Biscuit has been hiding things from you.'), "the buyer's message");
    assert.ok(email.html.includes(`href="${SITE}/p/${slug}"`));

    // Later runs that day and the day after send nothing more.
    for (const when of [Date.UTC(2026, 9, 20, hour, 5), Date.UTC(2026, 9, 20, hour, 50), Date.UTC(2026, 9, 21, hour, 5), Date.UTC(2026, 10, 1, hour, 5)]) {
      ctx.clock.set(when);
      assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 0, failed: 0, cancelled: 0 }, new Date(when).toISOString());
    }
    assert.equal(ctx.email.sent.length, 1, 'exactly one email');
    const order = await ctx.store.getOrder(request.orderId);
    assert.equal(order.sentAt.toISOString(), '2026-10-20T04:00:00.000Z');
  });

  test("the date is the buyer's chosen time zone's date: Tokyo and Los Angeles against the daily run", async () => {
    const hour = await giftRunHour();
    // Tokyo is UTC+9: October 20 starts at 15:00 UTC on October 19. A moment before, nothing is due; the daily
    // run on October 19 UTC (1 am on the 20th in Tokyo) sends it.
    const tokyo = giftApp();
    await buyGift(tokyo, { timeZone: 'Asia/Tokyo' });
    tokyo.clock.set('2026-10-19T14:59:59.999Z');
    assert.equal((await runGiftJob(tokyo.app, CRON)).body.sent, 0);
    tokyo.clock.set(Date.UTC(2026, 9, 19, hour, 30));
    assert.equal((await runGiftJob(tokyo.app, CRON)).body.sent, 1);
    assert.equal(dateIn(tokyo.clock.now(), 'Asia/Tokyo'), '2026-10-20');

    // Los Angeles is UTC−7 in October: the October 20 run is in the morning there.
    const la = giftApp();
    await buyGift(la, { timeZone: 'America/Los_Angeles' });
    la.clock.set('2026-10-20T06:59:59Z'); // 11:59 pm on the 19th in Los Angeles
    assert.equal((await runGiftJob(la.app, CRON)).body.sent, 0);
    la.clock.set(Date.UTC(2026, 9, 20, hour, 30));
    assert.equal((await runGiftJob(la.app, CRON)).body.sent, 1);
    assert.equal(dateIn(la.clock.now(), 'America/Los_Angeles'), '2026-10-20');
    assert.equal(la.email.sent.length, 1);
  });

  test('wherever in its hour Vercel fires the daily run, the email arrives on the date, in half- and quarter-hour zones too', async () => {
    const hour = await giftRunHour();
    // Darwin (UTC+9:30) is the zone a 14:00 UTC run missed: October 20 starts there at 14:30 UTC on the 19th. A
    // run at 14:00 that day was too early, and the next one, as late as 14:59 on the 20th, was October 21 there.
    const zones = [
      'Australia/Darwin', 'Australia/Eucla', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Chatham',
      'America/St_Johns', 'Pacific/Marquesas', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/New_York',
    ];
    const patterns = {
      'top of the hour': () => 0,
      'end of the hour': () => HOUR_MS - 1,
      'alternating, early first': (i) => (i % 2 ? HOUR_MS - 1 : 0),
      'alternating, late first': (i) => (i % 2 ? 0 : HOUR_MS - 1),
    };
    for (const timeZone of zones) {
      for (const [pattern, within] of Object.entries(patterns)) {
        const ctx = giftApp();
        await buyGift(ctx, { deliverOn: '2026-10-20', timeZone });
        const sentOn = [];
        for (let i = 0; i < 6; i++) {
          const at = Date.UTC(2026, 9, 17 + i, hour) + within(i); // one run a day, October 17 to 22 (UTC)
          ctx.clock.set(at);
          if ((await runGiftJob(ctx.app, CRON)).body.sent) sentOn.push(dateIn(new Date(at), timeZone));
        }
        assert.deepEqual(sentOn, ['2026-10-20'], `${timeZone}, runs at the ${pattern}`);
        assert.equal(ctx.email.sent.length, 1);
      }
    }
  });

  test("a gift for today is sent as soon as it's paid, and only once", async () => {
    const ctx = giftApp();
    const { request } = await buyGift(ctx, { deliverOn: '2026-10-14' }); // today in New York
    assert.equal(ctx.email.sent.length, 1, 'sent by the payment itself: the daily run may already be over');
    await payOrder(ctx.app, request, SECRET, ctx.clock.seconds()); // Stripe retries the event
    ctx.clock.set('2026-10-15T14:05:00Z');
    assert.equal((await runGiftJob(ctx.app, CRON)).body.sent, 0);
    assert.equal(ctx.email.sent.length, 1);
  });

  test('a send that fails for a moment is retried by the next run and sent exactly once', async () => {
    const ctx = giftApp();
    const { request } = await buyGift(ctx);
    ctx.email.failWith(new EmailError('brevo responded 503', { permanent: false }));
    ctx.clock.set('2026-10-20T14:05:00Z');
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 0, failed: 1, cancelled: 0 });
    assert.ok(ctx.logs.some((l) => l.startsWith('warn') && l.includes(request.orderId) && l.includes('brevo responded 503')));
    assert.equal((await ctx.store.getOrder(request.orderId)).sentAt, null);

    ctx.clock.set('2026-10-20T14:20:00Z'); // a manual re-run the same day
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 1, failed: 0, cancelled: 0 });
    ctx.clock.set('2026-10-21T14:05:00Z');
    assert.equal((await runGiftJob(ctx.app, CRON)).body.sent, 0);
    assert.equal(ctx.email.sent.length, 1);
  });

  test('a send the email service refuses for good (a bad address) is cancelled, logged for a refund, never retried', async () => {
    const ctx = giftApp();
    const { request } = await buyGift(ctx);
    ctx.email.failWith(new EmailError('brevo responded 400', { permanent: true }));
    ctx.clock.set('2026-10-20T14:05:00Z');
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 0, failed: 0, cancelled: 1 });
    assert.ok(ctx.logs.some((l) => l.startsWith('error') && l.includes(request.orderId) && /refund/.test(l)));
    ctx.clock.set('2026-10-21T14:05:00Z');
    assert.equal((await runGiftJob(ctx.app, CRON)).body.cancelled, 0);
    assert.equal(ctx.email.sent.length, 0);
    assert.ok((await ctx.store.getOrder(request.orderId)).cancelledAt);
    // The page can only be seen while the preview is live, so the reason it gives must not be "can't be shown".
    const page = await (await ctx.app.request(`/p/${request.slug}`)).text();
    assert.match(page, /<b>Gift\.<\/b> Not sent: we couldn't deliver the email to j•••@example\.com\. It will be refunded\./);
    assert.ok(!page.includes('can no longer be shown'));
  });

  test('a busy day: every gift due goes in that day’s run, past one batch, and one that keeps failing holds up none', async () => {
    const hour = await giftRunHour();
    const email = fakeEmail();
    const attempts = [];
    const sendEmail = async (message) => {
      attempts.push(message.to);
      if (message.to === 'stuck@example.com') throw new EmailError('brevo responded 502');
      return email.sendEmail(message);
    };
    const ctx = giftApp({ app: { sendEmail } });
    const DUE = 120; // more than two of the job's batches (50 each)
    for (let i = 0; i < DUE; i++) await buyGift(ctx, { recipientEmail: `friend${i}@example.com` });
    await buyGift(ctx, { recipientEmail: 'stuck@example.com' });

    ctx.clock.set(Date.UTC(2026, 9, 20, hour, 5));
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: DUE, failed: 1, cancelled: 0 });
    assert.equal(new Set(email.sent.map((m) => m.to)).size, DUE, 'each one, once');
    assert.equal(attempts.filter((to) => to === 'stuck@example.com').length, 1, 'the failing one is tried once per run');

    ctx.clock.set(Date.UTC(2026, 9, 21, hour, 5)); // the next run retries only the one that failed
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 0, failed: 1, cancelled: 0 });
    assert.equal(email.sent.length, DUE);
  });

  test('an email outage ends the run after a few failures and leaves every gift for the next run, which sends each once', async () => {
    const hour = await giftRunHour();
    const email = fakeEmail();
    let outage = true;
    let attempts = 0;
    const sendEmail = async (message) => {
      attempts += 1;
      if (outage) throw new EmailError('brevo request failed: TimeoutError');
      return email.sendEmail(message);
    };
    const ctx = giftApp({ app: { sendEmail } });
    for (let i = 0; i < 60; i++) await buyGift(ctx, { recipientEmail: `friend${i}@example.com` });

    ctx.clock.set(Date.UTC(2026, 9, 20, hour, 5));
    const { body } = await runGiftJob(ctx.app, CRON);
    assert.equal(body.sent, 0);
    assert.ok(body.failed > 0);
    assert.ok(attempts <= 5, `it stops instead of waiting on a service that is down (${attempts} tries)`);
    assert.ok([...ctx.store.orders.values()].every((o) => o.claimedAt === null && o.sentAt === null), 'nothing left claimed');

    outage = false;
    ctx.clock.set(Date.UTC(2026, 9, 20, hour, 30)); // a re-run once it's back
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 60, failed: 0, cancelled: 0 });
    assert.equal(new Set(email.sent.map((m) => m.to)).size, 60);
    ctx.clock.set(Date.UTC(2026, 9, 21, hour, 5));
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 0, failed: 0, cancelled: 0 });
  });

  test('a database error on one gift fails only that gift: the rest of the run goes on, and it goes on the next run', async () => {
    const hour = await giftRunHour();
    const ctx = giftApp();
    await buyGift(ctx, { recipientEmail: 'jamie@example.com' });
    await buyGift(ctx, { recipientEmail: 'alex@example.com' });
    const getPet = ctx.store.getPet.bind(ctx.store);
    let failures = 1;
    ctx.store.getPet = async (slug) => {
      if (failures-- > 0) throw new Error('database unavailable');
      return getPet(slug);
    };
    ctx.clock.set(Date.UTC(2026, 9, 20, hour, 5));
    const first = await runGiftJob(ctx.app, CRON);
    assert.equal(first.res.status, 200);
    assert.deepEqual(first.body, { sent: 1, failed: 1, cancelled: 0 });
    assert.ok(ctx.logs.some((l) => l.startsWith('error') && l.includes('database unavailable')));

    ctx.clock.set(Date.UTC(2026, 9, 20, hour, 20)); // a re-run the same day: the failed gift was released
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 1, failed: 0, cancelled: 0 });
    assert.deepEqual(ctx.email.sent.map((m) => m.to).sort(), ['alex@example.com', 'jamie@example.com']);
  });

  test('if recording a gift as sent fails after the email went, a re-run that day does not send it again', async () => {
    const hour = await giftRunHour();
    const ctx = giftApp();
    const { request } = await buyGift(ctx);
    const markGiftSent = ctx.store.markGiftSent.bind(ctx.store);
    let failures = 1;
    ctx.store.markGiftSent = async (...args) => {
      if (failures-- > 0) throw new Error('database unavailable');
      return markGiftSent(...args);
    };
    ctx.clock.set(Date.UTC(2026, 9, 20, hour, 5));
    const first = await runGiftJob(ctx.app, CRON);
    assert.equal(first.res.status, 200);
    assert.deepEqual(first.body, { sent: 1, failed: 0, cancelled: 0 });
    assert.ok(ctx.logs.some((l) => l.startsWith('error') && l.includes(request.orderId) && l.includes('database unavailable')));
    ctx.clock.set(Date.UTC(2026, 9, 20, hour, 10));
    assert.equal((await runGiftJob(ctx.app, CRON)).body.sent, 0, 'still claimed: not released after it went');
    assert.equal(ctx.email.sent.length, 1);
  });

  test('two runs at the same moment send one email', async () => {
    const ctx = giftApp();
    await buyGift(ctx);
    ctx.clock.set('2026-10-20T14:05:00Z');
    const runs = await Promise.all([runGiftJob(ctx.app, CRON), runGiftJob(ctx.app, CRON), runGiftJob(ctx.app, CRON)]);
    assert.equal(runs.reduce((sum, r) => sum + r.body.sent, 0), 1);
    assert.equal(ctx.email.sent.length, 1);
  });

  test('a run that died after claiming a gift leaves it to the next run once the claim is stale', async () => {
    const ctx = giftApp();
    const { request } = await buyGift(ctx);
    ctx.clock.set('2026-10-20T14:05:00Z');
    await ctx.store.claimDueGifts(ctx.clock.now(), { staleBefore: new Date(ctx.clock.now().getTime() - GIFT_CLAIM_LEASE_MS) }); // …and then crashed
    assert.equal((await runGiftJob(ctx.app, CRON)).body.sent, 0, 'still claimed by the dead run');
    ctx.clock.set(new Date(ctx.clock.now().getTime() + GIFT_CLAIM_LEASE_MS + 1000));
    assert.equal((await runGiftJob(ctx.app, CRON)).body.sent, 1);
    assert.equal(ctx.email.sent.length, 1);
    assert.ok((await ctx.store.getOrder(request.orderId)).sentAt);
  });

  test('an unpaid gift is never sent', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    assert.equal((await postGift(ctx.app, giftFields(slug))).status, 303); // …and the buyer closes Stripe's tab
    for (const when of ['2026-10-20T14:05:00Z', '2026-10-25T14:05:00Z']) {
      ctx.clock.set(when);
      assert.equal((await runGiftJob(ctx.app, CRON)).body.sent, 0);
    }
    assert.equal(ctx.email.sent.length, 0);
    assert.equal((await ctx.store.getPet(slug)).paidAt, null);
  });

  test('a preview taken down before the date is not sent; the gift is cancelled and logged for a refund', async () => {
    const ctx = giftApp();
    const { slug, request } = await buyGift(ctx);
    ctx.store.records.get(slug).reports = REPORT_LIMIT;
    ctx.clock.set('2026-10-20T14:05:00Z');
    assert.deepEqual((await runGiftJob(ctx.app, CRON)).body, { sent: 0, failed: 0, cancelled: 1 });
    assert.equal(ctx.email.sent.length, 0);
    assert.ok(ctx.logs.some((l) => l.startsWith('error') && l.includes(request.orderId) && l.includes('removed') && /refund/.test(l)));
  });

  test('a payment for the wrong amount marks nothing paid and schedules nothing', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    await postGift(ctx.app, giftFields(slug));
    await payOrder(ctx.app, ctx.checkoutCalls[0], SECRET, ctx.clock.seconds(), { session: { amount_total: 100 } });
    assert.equal((await ctx.store.getOrder(ctx.checkoutCalls[0].orderId)).paidAt, null);
    assert.equal((await ctx.store.getPet(slug)).paidAt, null);
    assert.ok(ctx.logs.some((l) => l.startsWith('error') && l.includes('100 usd')));
    ctx.clock.set('2026-10-20T14:05:00Z');
    assert.equal((await runGiftJob(ctx.app, CRON)).body.sent, 0);
  });

  test("an order id the store doesn't know, or one for another preview, unlocks nothing", async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    const other = await createPreview(ctx.app);
    await postGift(ctx.app, giftFields(other));
    const request = ctx.checkoutCalls[0];
    await payOrder(ctx.app, { ...request, slug }, SECRET, ctx.clock.seconds()); // the slug of another preview
    await payOrder(ctx.app, { ...request, orderId: 'Zz'.repeat(11) }, SECRET, ctx.clock.seconds(), { sessionNumber: 2 });
    assert.equal((await ctx.store.getPet(slug)).paidAt, null);
    assert.equal((await ctx.store.getOrder(request.orderId)).paidAt, null);
    assert.equal(ctx.logs.filter((l) => l.startsWith('error') && /refund|check/.test(l)).length, 2);
  });
});

describe('POST /gift', () => {
  test('stores the gift with its delivery instant, then sends the buyer to a $9 Checkout', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    await postGift(ctx.app, giftFields(slug, { recipientEmail: ' Jamie@Example.COM ' }));
    const { orderId, successUrl, cancelUrl, expiresAt } = ctx.checkoutCalls[0];
    assert.equal(successUrl, `${SITE}/p/${slug}?checkout=success`);
    assert.equal(cancelUrl, `${SITE}/p/${slug}`);
    assert.ok(expiresAt instanceof Date);
    const order = await ctx.store.getOrder(orderId);
    assert.equal(order.kind, 'gift');
    assert.equal(order.slug, slug);
    assert.equal(order.amountCents, 900);
    assert.equal(order.origin, SITE);
    assert.equal(order.paidAt, null);
    assert.equal(order.deliverAt.toISOString(), '2026-10-20T04:00:00.000Z', 'midnight on October 20 in New York (EDT)');
    assert.deepEqual(order.details, {
      recipientName: 'Jamie',
      recipientEmail: 'jamie@example.com',
      fromName: 'Sam',
      message: 'Happy birthday! Biscuit has been hiding things from you.',
      deliverOn: '2026-10-20',
      timeZone: 'America/New_York',
    });
  });

  test('a JSON client gets the Checkout URL', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    const res = await postJson(ctx.app, '/gift', giftFields(slug));
    assert.equal(res.status, 200);
    assert.match((await res.json()).url, /^https:\/\/checkout\.stripe\.com\//);
  });

  test('each invalid field is a 400 that names the problem; nothing is stored and nothing charged', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    const cases = [
      [{ recipientEmail: '' }, /email/i],
      [{ recipientEmail: 'not-an-email' }, /email/i],
      [{ recipientEmail: 'a@b' }, /email/i],
      [{ recipientEmail: `${'a'.repeat(250)}@example.com` }, /email/i],
      [{ recipientEmail: 'jamie@example.com, other@example.com' }, /email/i],
      [{ fromName: '' }, /your name/i],
      [{ fromName: 'S'.repeat(41) }, /40/],
      [{ recipientName: 'J'.repeat(41) }, /40/],
      [{ message: 'm'.repeat(MAX_GIFT_MESSAGE_LENGTH + 1) }, new RegExp(String(MAX_GIFT_MESSAGE_LENGTH))],
      [{ deliverOn: '' }, /date/i],
      [{ deliverOn: '20-10-2026' }, /date/i],
      [{ deliverOn: '2026-02-30' }, /date/i],
      [{ deliverOn: '2026-10-13' }, /past/i],
      [{ deliverOn: '2026-11-07' }, /latest|week/i], // the photo is deleted November 13
      [{ timeZone: 'Mars/Olympus_Mons' }, /time zone/i],
    ];
    for (const [overrides, pattern] of cases) {
      const res = await postJson(ctx.app, '/gift', giftFields(slug, overrides));
      assert.equal(res.status, 400, JSON.stringify(overrides));
      assert.match((await res.json()).error, pattern, JSON.stringify(overrides));
      const page = await postGift(ctx.app, giftFields(slug, overrides));
      assert.equal(page.status, 400);
      assert.match(page.headers.get('content-type') ?? '', /text\/html/, 'a form post gets a page');
    }
    assert.equal(ctx.checkoutCalls.length, 0);
    assert.equal(ctx.store.orders.size, 0);
  });

  test('the latest date leaves the recipient a week before the photo is deleted; the empty message is fine', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app); // uploaded October 14, deleted November 13
    assert.equal((await postGift(ctx.app, giftFields(slug, { deliverOn: '2026-11-06', message: '', recipientName: '' }))).status, 303);
    const order = await ctx.store.getOrder(ctx.checkoutCalls[0].orderId);
    assert.equal(order.details.message, '');
    assert.equal(order.details.recipientName, '');
  });

  test('"today" is today in the chosen time zone', async () => {
    // 2 am UTC on October 15 is still October 14 in New York, but already October 15 in UTC.
    const ctx = giftApp({ start: '2026-10-15T02:00:00Z' });
    const slug = await createPreview(ctx.app);
    assert.equal((await postGift(ctx.app, giftFields(slug, { deliverOn: '2026-10-14', timeZone: 'America/New_York' }))).status, 303);
    assert.equal((await postGift(ctx.app, giftFields(slug, { deliverOn: '2026-10-14', timeZone: 'UTC' }))).status, 400);
  });

  test('no time zone (an API client) means UTC', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    const { timeZone, ...fields } = giftFields(slug);
    assert.equal((await postGift(ctx.app, fields)).status, 303);
    const order = await ctx.store.getOrder(ctx.checkoutCalls[0].orderId);
    assert.equal(order.details.timeZone, 'UTC');
    assert.equal(order.deliverAt.toISOString(), '2026-10-20T00:00:00.000Z');
  });

  test('an already-paid preview goes back to its page: no second charge', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    await payFor(ctx.app, slug, SECRET, ctx.clock.seconds());
    const res = await postGift(ctx.app, giftFields(slug));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/p/${slug}`);
    assert.equal(ctx.checkoutCalls.length, 0);
  });

  test('without email, the scheduler secret or Stripe it answers 503 and logs which; nothing is stored', async () => {
    for (const [missing, pattern] of [
      [{ sendEmail: null }, /BREVO_API_KEY/],
      [{ cronSecret: '' }, /CRON_SECRET/],
      [{ checkout: null }, /STRIPE_SECRET_KEY/],
    ]) {
      const ctx = giftApp({ app: missing });
      const slug = await createPreview(ctx.app);
      const res = await postGift(ctx.app, giftFields(slug));
      assert.equal(res.status, 503, JSON.stringify(missing));
      assert.ok(ctx.logs.some((l) => l.startsWith('error') && pattern.test(l)), String(pattern));
      assert.equal(ctx.store.orders.size, 0);
    }
  });

  test('malformed → 400, unknown → 404, expired or taken down → 410', async () => {
    const ctx = giftApp();
    const now = ctx.clock.now();
    await ctx.store.createPet(petRecord({ slug: 'expired-preview-slug-01', createdAt: new Date(now.getTime() - 31 * DAY_MS) }));
    await ctx.store.createPet(petRecord({ slug: 'removed-preview-slug-01', createdAt: now }));
    ctx.store.records.get('removed-preview-slug-01').reports = REPORT_LIMIT;
    assert.equal((await postGift(ctx.app, giftFields('short'))).status, 400);
    assert.equal((await postGift(ctx.app, giftFields('AAAAAAAAAAAAAAAAAAAAAA'))).status, 404);
    assert.equal((await postGift(ctx.app, giftFields('expired-preview-slug-01'))).status, 410);
    assert.equal((await postGift(ctx.app, giftFields('removed-preview-slug-01'))).status, 410);
    assert.equal(ctx.checkoutCalls.length, 0);
  });

  test('cross-site posts are refused (403)', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    assert.equal((await postGift(ctx.app, giftFields(slug), { origin: 'https://evil.example' })).status, 403);
    assert.equal((await postJson(ctx.app, '/gift', giftFields(slug), { origin: 'https://evil.example' })).status, 403);
    assert.equal(ctx.checkoutCalls.length, 0);
  });
});

describe('GET /jobs/deliver-gifts authorisation', () => {
  test('needs the bearer secret (401), refuses to run without one (503) or without email (503)', async () => {
    const ctx = giftApp();
    assert.equal((await runGiftJob(ctx.app, 'wrong')).res.status, 401);
    assert.equal((await ctx.app.request('/jobs/deliver-gifts')).status, 401);
    const noSecret = giftApp({ app: { cronSecret: '' } });
    assert.equal((await runGiftJob(noSecret.app, CRON)).res.status, 503);
    const noEmail = giftApp({ app: { sendEmail: null } });
    assert.equal((await runGiftJob(noEmail.app, CRON)).res.status, 503);
    assert.ok(noEmail.logs.some((l) => l.startsWith('error') && l.includes('BREVO_API_KEY')));
  });

  test('a store failure is a 500, logged', async () => {
    const ctx = giftApp();
    ctx.store.claimDueGifts = async () => {
      throw new Error('database unavailable');
    };
    const { res } = await runGiftJob(ctx.app, CRON);
    assert.equal(res.status, 500);
    assert.ok(ctx.logs.some((l) => l.startsWith('error') && l.includes('database unavailable')));
  });

  test('vercel.json runs it once a day, at an hour that lands on the delivery date in every time zone, all year', async () => {
    const hour = await giftRunHour();
    const late = [];
    for (const timeZone of [...Intl.supportedValuesOf('timeZone'), 'UTC']) {
      for (let day = Date.UTC(2026, 9, 14); day < Date.UTC(2027, 9, 14); day += DAY_MS) {
        const date = new Date(day).toISOString().slice(0, 10);
        const due = startOfDayIn(date, timeZone)?.getTime();
        if (due === undefined) continue; // a date the zone skips (none in this range; the form refuses them)
        // Each day's run is somewhere in [hour:00, hour:59:59.999] UTC. The earliest the email can go is in the
        // first window that ends after it's due; the latest is the end of the first window that starts at or after
        // it (a run inside a window that straddles the due instant may fire just before it).
        const windows = [0, 1].map((k) => Math.floor(due / DAY_MS) * DAY_MS + k * DAY_MS + hour * HOUR_MS);
        const earliest = Math.max(due, windows.find((start) => start + HOUR_MS > due));
        const latest = windows.find((start) => start >= due) + HOUR_MS - 1;
        for (const at of [earliest, latest]) if (dateIn(new Date(at), timeZone) !== date) late.push(`${timeZone} ${date}`);
      }
    }
    assert.deepEqual([...new Set(late.map((l) => l.split(' ')[0]))], [], `first misses: ${late.slice(0, 5).join(', ')}`);
  });
});

describe('the gift on the preview page', () => {
  test('an unpaid preview offers the gift form, with the zone Vercel detected pre-selected and the date range', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    const html = await (await ctx.app.request(`/p/${slug}`, { headers: { 'x-vercel-ip-timezone': 'America/Chicago' } })).text();
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/gift"/);
    for (const name of ['recipientEmail', 'recipientName', 'fromName', 'deliverOn']) assert.match(html, new RegExp(`name="${name}"`), name);
    assert.match(html, /<textarea[^>]*name="message"[^>]*maxlength="300"/);
    assert.match(html, /<option value="America\/Chicago" selected>/);
    assert.match(html, /<input type="date" name="deliverOn"[^>]*min="2026-10-14"[^>]*max="2026-11-06"/);
    assert.ok(!/<script/i.test(html), 'still no script on the preview page');
  });

  test('a zone missing from the list is added; a bogus header falls back to New York', async () => {
    const ctx = giftApp();
    const slug = await createPreview(ctx.app);
    const odd = await (await ctx.app.request(`/p/${slug}`, { headers: { 'x-vercel-ip-timezone': 'America/Argentina/Buenos_Aires' } })).text();
    assert.match(odd, /<option value="America\/Argentina\/Buenos_Aires" selected>/);
    const bogus = await (await ctx.app.request(`/p/${slug}`, { headers: { 'x-vercel-ip-timezone': '"><script>' } })).text();
    assert.match(bogus, /<option value="America\/New_York" selected>/);
    assert.ok(!bogus.includes('"><script>'));
  });

  test('without gifts configured there is no gift form', async () => {
    const ctx = giftApp({ app: { sendEmail: null } });
    const slug = await createPreview(ctx.app);
    assert.doesNotMatch(await (await ctx.app.request(`/p/${slug}`)).text(), /action="\/gift"/);
  });

  test('the home page tells gift buyers to upload the recipient’s pet', async () => {
    const ctx = giftApp();
    assert.match(await (await ctx.app.request('/')).text(), /gift/i);
  });

  test('after paying, "Your orders" shows the scheduled gift (masked address), then that it was sent', async () => {
    const ctx = giftApp();
    const { slug } = await buyGift(ctx);
    const scheduled = await (await ctx.app.request(`/p/${slug}?checkout=success`)).text();
    assert.match(scheduled, /Your orders/);
    assert.ok(scheduled.includes('j•••@example.com'));
    assert.ok(!scheduled.includes('jamie@example.com'), 'the full address is not on a page anyone with the link can see');
    assert.match(scheduled, /Tuesday, October 20, 2026/);
    assert.doesNotMatch(scheduled, /action="\/gift"/, 'no second gift form once paid');

    ctx.clock.set('2026-10-20T14:05:00Z');
    await runGiftJob(ctx.app, CRON);
    const sent = await (await ctx.app.request(`/p/${slug}`)).text();
    assert.match(sent, /Emailed to j•••@example\.com on October 20/);
  });
});

describe('the gift email', () => {
  const pet = { slug: 'AbCdEfGhIjKlMnOpQrStUv', name: 'Biscuit', createdAt: new Date('2026-10-14T19:00:00Z') };
  const details = { recipientName: 'Jamie', recipientEmail: 'jamie@example.com', fromName: 'Sam', message: 'Hi!', deliverOn: '2026-10-20', timeZone: 'UTC' };
  const link = `${SITE}/p/${pet.slug}`;

  test('says who it is from, links to the preview, and says until when the bundle can be downloaded', () => {
    const email = giftEmail({ pet, details, link, downloadBy: new Date('2026-11-13T19:00:00Z') });
    assert.match(email.subject, /Sam/);
    assert.match(email.subject, /Biscuit/);
    for (const part of [email.text, email.html]) {
      assert.ok(part.includes(link));
      assert.match(part, /Hi!/);
      assert.match(part, /November 13, 2026/);
      assert.match(part, /Jamie/);
    }
  });

  test('user text is escaped in the HTML and the subject has no line breaks', () => {
    const email = giftEmail({
      pet: { ...pet, name: 'Bis<b>cuit' },
      details: { ...details, fromName: 'Sam\r\nBcc: x@example.com', message: '<script>alert(1)</script> & <a href="https://evil.example">x</a>' },
      link,
      downloadBy: new Date('2026-11-13T19:00:00Z'),
    });
    assert.doesNotMatch(email.subject, /[\r\n]/);
    assert.ok(!email.html.includes('<script>'));
    assert.ok(email.html.includes('&lt;script&gt;'));
    assert.ok(!email.html.includes('href="https://evil.example"'));
    assert.ok(email.html.includes('Bis&lt;b&gt;cuit'));
  });

  test('works without a recipient name or a message', () => {
    const email = giftEmail({ pet, details: { ...details, recipientName: '', message: '' }, link, downloadBy: new Date('2026-11-13T19:00:00Z') });
    assert.match(email.text, /^Hi there/);
  });
});

describe('/legal covers M4', () => {
  test('gifts, printed posters, the new data and who processes it', async () => {
    const { app } = makeApp();
    const html = await (await app.request('/legal')).text();
    for (const text of [/gift/i, /recipient/i, /printed poster/i, /\$29/, /shipping address/i, /United States/, /Brevo/, /Prodigi/]) {
      assert.match(html, text, String(text));
    }
  });
});

describe('gift form validation and time zones (input.js)', () => {
  test('startOfDayIn is the first instant of that date in the zone, DST and odd offsets included', () => {
    const cases = [
      ['2026-10-20', 'America/New_York', '2026-10-20T04:00:00.000Z'],
      ['2026-12-25', 'America/New_York', '2026-12-25T05:00:00.000Z'],
      ['2026-03-08', 'America/New_York', '2026-03-08T05:00:00.000Z'], // the day DST starts (at 2 am)
      ['2026-11-01', 'America/New_York', '2026-11-01T04:00:00.000Z'], // the day DST ends
      ['2026-10-20', 'Asia/Tokyo', '2026-10-19T15:00:00.000Z'],
      ['2026-10-20', 'Asia/Kolkata', '2026-10-19T18:30:00.000Z'],
      ['2026-10-20', 'Australia/Adelaide', '2026-10-19T13:30:00.000Z'],
      ['2026-10-20', 'Pacific/Kiritimati', '2026-10-19T10:00:00.000Z'],
      ['2026-10-20', 'UTC', '2026-10-20T00:00:00.000Z'],
    ];
    for (const [date, zone, expected] of cases) assert.equal(startOfDayIn(date, zone).toISOString(), expected, `${date} ${zone}`);
  });

  test("in a zone whose clocks skip midnight (Chile's DST start), the day starts at the first instant it has", () => {
    // Chile moves from 00:00 to 01:00 on the first Sunday of September: 2026-09-06 has no midnight.
    const start = startOfDayIn('2026-09-06', 'America/Santiago');
    assert.equal(dateIn(start, 'America/Santiago'), '2026-09-06');
    assert.equal(dateIn(new Date(start.getTime() - 1), 'America/Santiago'), '2026-09-05');
  });

  test('dateIn gives the calendar date in a zone', () => {
    const instant = new Date('2026-10-15T02:00:00Z');
    assert.equal(dateIn(instant, 'America/New_York'), '2026-10-14');
    assert.equal(dateIn(instant, 'UTC'), '2026-10-15');
    assert.equal(dateIn(instant, 'Asia/Tokyo'), '2026-10-15');
  });

  test('isTimeZone accepts IANA names and refuses junk', () => {
    for (const zone of ['UTC', 'America/New_York', 'Asia/Kolkata', 'America/Argentina/Buenos_Aires']) assert.ok(isTimeZone(zone), zone);
    for (const zone of ['', 'Mars/Olympus', 'EST5EDT; DROP', 42, null, 'a'.repeat(200)]) assert.ok(!isTimeZone(zone), String(zone));
  });

  test('parseGiftForm returns the clean details and the delivery instant, or an InputError', () => {
    const now = new Date(START);
    const latest = new Date(now.getTime() + 23 * DAY_MS);
    const parsed = parseGiftForm(giftFields('AbCdEfGhIjKlMnOpQrStUv', { fromName: '  Sam\n ' }), { now, latest });
    assert.equal(parsed.details.fromName, 'Sam');
    assert.equal(parsed.deliverAt.toISOString(), '2026-10-20T04:00:00.000Z');
    assert.throws(() => parseGiftForm({}, { now, latest }), InputError);
  });

  test('a name made only of invisible characters is no name; an optional one becomes empty', () => {
    const now = new Date(START);
    const latest = new Date(now.getTime() + 23 * DAY_MS);
    // Zero-width space, zero-width joiner, Hangul filler, word joiner: not whitespace to JavaScript.
    const invisible = ['\u200b', '\u200d\u200b', '\u3164', '\u2060 \u200b'];
    for (const fromName of invisible) {
      assert.throws(() => parseGiftForm(giftFields('AbCdEfGhIjKlMnOpQrStUv', { fromName }), { now, latest }), /your name/, JSON.stringify(fromName));
    }
    const parsed = parseGiftForm(giftFields('AbCdEfGhIjKlMnOpQrStUv', { recipientName: '\u3164', message: '\u200b\u200b' }), { now, latest });
    assert.equal(parsed.details.recipientName, '');
    assert.equal(parsed.details.message, '');
    // Joiners inside real text are kept: an emoji family is one name.
    const family = 'Sam \u{1F469}\u200d\u{1F467}';
    assert.equal(parseGiftForm(giftFields('AbCdEfGhIjKlMnOpQrStUv', { fromName: family }), { now, latest }).details.fromName, family);
  });

  test('text with a broken UTF-16 character (a JSON client can send one) comes out well-formed', () => {
    const now = new Date(START);
    const latest = new Date(now.getTime() + 23 * DAY_MS);
    const lone = String.fromCharCode(0xd800);
    const { details } = parseGiftForm(giftFields('AbCdEfGhIjKlMnOpQrStUv', { fromName: `Sam${lone}`, message: `Hi ${lone}there` }), { now, latest });
    for (const value of Object.values(details)) assert.ok(value.isWellFormed(), JSON.stringify(value));
    assert.equal(details.fromName, 'Sam\ufffd');
  });

  test('time zone names in any letter case share one cached formatter, so they cannot grow memory', async () => {
    const { cachedZoneFormats } = await import('../src/input.js');
    assert.equal(typeof cachedZoneFormats, 'function');
    const expected = dateIn(new Date(START), 'America/New_York');
    const before = cachedZoneFormats();
    const zone = 'america/new_york';
    for (let mask = 0; mask < 256; mask++) {
      const variant = [...zone].map((ch, i) => (i < 8 && mask & (1 << i) ? ch.toUpperCase() : ch)).join('');
      assert.ok(isTimeZone(variant), variant);
      assert.equal(dateIn(new Date(START), variant), expected, variant);
    }
    assert.ok(cachedZoneFormats() <= before + 1, `${cachedZoneFormats() - before} new formatters`);
  });
});
