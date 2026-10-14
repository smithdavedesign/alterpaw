// Local server: `npm run dev`, then open http://localhost:3000
// With no DATABASE_URL, previews live in memory until the process stops.
// With no model key (LLM_API_KEY or GOOGLE_API_KEY), a canned demo character is used, so the whole flow
// can be clicked through offline. Set the variables in your shell to use the real services.
// With no STRIPE_SECRET_KEY and the in-memory store, "Unlock" marks the preview paid on the spot (no Stripe),
// so the bundle and the rewrite can be tried offline too. Gifts and prints (M4) pay the same way, through a
// webhook event the dev server signs itself, so the real fulfilment code runs.
// With no BREVO_API_KEY/EMAIL_FROM, gift emails are printed here instead of sent; with no PRODIGI_API_KEY, print
// orders are printed instead of placed. Gift delivery runs every minute in-process.
import { createHmac, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { depsFromEnv } from '../src/index.js';
import { MemoryStore } from '../src/store.js';
import { findAlterEgo } from '../src/character.js';
import { PRODUCTS, CURRENCY } from '../src/payments.js';

const JOB_INTERVAL_MS = 60_000;

export function demoComplete(messages) {
  const pet = JSON.parse(messages[1].content.slice(messages[1].content.indexOf('{')));
  const ego = findAlterEgo(pet.alterEgo)?.label ?? pet.alterEgo;
  const [first = 'mysterious', second = 'restless', third = 'hungry'] = pet.traits;
  return JSON.stringify({
    alias: `${pet.name} "The ${first}" ${ego}`,
    rapSheet: [
      `Being ${first} in a public place`,
      `Aggravated ${second}ness, second offence`,
      `Conspiracy to commit ${third} acts before breakfast`,
    ],
    stats: [
      { label: 'Menace', value: 87 },
      { label: 'Charm', value: 99 },
      { label: 'Snack Theft', value: 93 },
      { label: 'Nap Power', value: 76 },
      { label: 'Alibi', value: 12 },
    ],
    headline: `${pet.name.toUpperCase()} SPOTTED LIVING SECRET LIFE AS ${ego.toUpperCase()}`,
    article: `Neighbours were stunned this week when ${pet.name}, a local ${pet.species} known for being ${first}, was revealed to be ${ego.toLowerCase()}. "We always wondered," said one witness. (Demo text: set GOOGLE_API_KEY for the real writer.)`,
    bio: `${pet.name} rose from humble beginnings to become the most ${second} ${ego.toLowerCase()} on the block. (Demo text.)`,
  });
}

// Stands in for Stripe Checkout on the dev server and goes straight to the success URL. With `fulfil`, the
// payment is confirmed the way Stripe confirms it, as a paid Checkout Session handed to the webhook; without
// it, the preview is simply marked paid.
export function devCheckout(store, { fulfil } = {}) {
  let sessions = 0;
  return async ({ slug, successUrl, product = 'bundle', orderId }) => {
    sessions += 1;
    const id = `dev-checkout-${sessions}`;
    if (fulfil) {
      await fulfil({
        id,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        amount_total: PRODUCTS[product].cents,
        currency: CURRENCY,
        client_reference_id: slug,
        metadata: orderId ? { slug, order: orderId, kind: product } : { slug },
      });
    } else {
      await store.markPaid(slug, { sessionId: id, at: new Date() });
    }
    return { id, url: successUrl };
  };
}

// Posts a paid Checkout Session to the app's own webhook, signed the way Stripe signs it.
async function postSignedSession(app, secret, session, log) {
  const payload = JSON.stringify({ id: `evt_${session.id}`, object: 'event', type: 'checkout.session.completed', data: { object: session } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  const res = await app.request('/stripe/webhook', {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` },
  });
  if (!res.ok) log(`dev checkout: the webhook answered ${res.status}`);
}

// Gift emails, printed instead of sent.
export function devSendEmail(log) {
  let sent = 0;
  return async ({ to, subject, text }) => {
    sent += 1;
    log(`dev email (not sent) to ${to}: ${subject}\n${text}`);
    return { id: `dev-email-${sent}` };
  };
}

// Print orders, printed instead of placed. Only the city is shown: the dev log is still a log.
export function devPrintOrder(log) {
  return async ({ orderId, address, imageUrl }) => {
    log(`dev print order (not placed) ${orderId} to ${address.city}, ${address.state}; print file ${imageUrl}`);
    return { id: `dev-print-${orderId}` };
  };
}

// The dev app: the production deps from `env`, with local stand-ins for whatever isn't set.
// Returns { app, store, runJobs }; runJobs() runs the gift delivery the way Vercel Cron would.
export function createDevApp(env, { log = console.log } = {}) {
  const deps = depsFromEnv(env);
  deps.logger = { error: log, warn: log, info: log };
  const notes = [];
  let app;
  if (!env.DATABASE_URL) {
    deps.store = new MemoryStore();
    notes.push('No DATABASE_URL: previews are kept in memory.');
    if (!env.STRIPE_SECRET_KEY) {
      deps.webhookSecret ||= randomBytes(24).toString('hex');
      const secret = deps.webhookSecret;
      deps.checkout = devCheckout(deps.store, { fulfil: (session) => postSignedSession(app, secret, session, log) });
      notes.push('No STRIPE_SECRET_KEY: "Unlock", gifts and prints are paid locally, without Stripe.');
    }
  }
  if (!env.LLM_API_KEY && !env.GOOGLE_API_KEY) {
    deps.complete = async (messages) => demoComplete(messages);
    notes.push('No model key: using canned demo text.');
  }
  if (!deps.sendEmail) {
    deps.sendEmail = devSendEmail(log);
    notes.push('No BREVO_API_KEY/EMAIL_FROM: gift emails are printed here, not sent.');
  }
  if (!deps.printOrder) {
    deps.printOrder = devPrintOrder(log);
    notes.push('No PRODIGI_API_KEY: print orders are printed here, not placed.');
  }
  if (!deps.cronSecret) {
    // In-process only (never printed), so gift delivery can run here; export CRON_SECRET to call the jobs yourself.
    deps.cronSecret = randomBytes(24).toString('hex');
    notes.push('No CRON_SECRET: the jobs only run in-process (gift delivery every minute).');
  }
  app = createApp(deps);
  const runJobs = () => app.request('/jobs/deliver-gifts', { headers: { authorization: `Bearer ${deps.cronSecret}` } });
  return { app, store: deps.store, runJobs, notes };
}

function main(env) {
  const { app, runJobs, notes } = createDevApp(env);
  for (const note of notes) console.log(note);
  const port = Number(env.PORT) || 3000;
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`alterpaw running at http://localhost:${info.port}`);
  });
  setInterval(() => runJobs().catch((err) => console.error(`deliver-gifts: ${err.message}`)), JOB_INTERVAL_MS);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main(process.env);
