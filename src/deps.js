// Production wiring: the app's dependencies, built from environment variables. Both entries use it: the
// Cloudflare Worker (src/worker.js, live) with the Worker's vars and secrets, and Vercel's (src/index.js) with
// process.env. Values are never logged or stored (errors are redacted in app.js, and a malformed DATABASE_URL
// is refused before the driver sees it).
//   DATABASE_URL    Postgres (Neon free tier), required to save previews
//   GOOGLE_API_KEY  Gemini API key (free tier), used when LLM_API_KEY is not set
//   LLM_BASE_URL    optional OpenAI-compatible endpoint, e.g. a LiteLLM proxy
//   LLM_API_KEY     optional key for LLM_BASE_URL
//   LLM_MODEL       optional model name
//   CRON_SECRET     bearer token for the daily jobs' URLs (/jobs/*). The Worker's Cron Triggers don't need it
//                   (src/worker.js); on Vercel, Vercel Cron sent it
//   STRIPE_SECRET_KEY      Stripe secret (or restricted) key; without it checkout answers 503
//   STRIPE_WEBHOOK_SECRET  signing secret of the Stripe webhook endpoint; without it the webhook answers 503
//   BREVO_API_KEY + EMAIL_FROM  Brevo v3 API key and its verified sender address; without both, no gifts (M4)
//   PRODIGI_API_KEY        Prodigi Print API key; without it, no printed posters (M4)
//   PRODIGI_ENV            'live' sends print orders to Prodigi's live API; anything else uses its sandbox
// Go-live (wrangler.jsonc vars on the Worker; Vercel set its own two):
//   DEPLOY_ENV             'production' loads the RepoHQ visit beacon; wins over Vercel's VERCEL_ENV
//   SITE_HOST              the production host, for canonical URLs, robots.txt and the sitemap; wins over
//                          Vercel's VERCEL_PROJECT_PRODUCTION_URL
import { neon } from '@neondatabase/serverless';
import { createChatCompletion } from './character.js';
import { createBrevoSender } from './email.js';
import { createStripeCheckout } from './payments.js';
import { createProdigiPrinter } from './print.js';
import { PgStore } from './store.js';
import { siteUrlFromEnv } from './site.js';

export const DEFAULT_LLM_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const DEFAULT_LLM_MODEL = 'gemini-flash-latest';

// Fails loudly instead of quietly keeping previews in one serverless instance's memory.
// The message is fixed: it never includes the variable's value.
const unconfiguredStore = (message) => {
  const fail = async () => {
    throw new Error(message);
  };
  return {
    createPet: fail,
    getPet: fail,
    getPhoto: fail,
    reportPet: fail,
    expirePhotos: fail,
    markPaid: fail,
    saveRegenerated: fail,
    createOrder: fail,
    getOrder: fail,
    markOrderPaid: fail,
    listOrders: fail,
    claimDueGifts: fail,
    markGiftSent: fail,
    cancelGift: fail,
    releaseGift: fail,
    setPrintOrder: fail,
  };
};

// The sender must be a plain address (Brevo checks that it is verified); anything else leaves gifts off.
const isEmailAddress = (value) => typeof value === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);

// Checked here because Neon's own error for a malformed URL quotes the whole string, password included.
function isPostgresUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && Boolean(url.hostname);
  } catch {
    return false;
  }
}

// Neon's HTTP driver: one HTTPS request per query, no connection pool to leak between serverless calls.
function neonQuery(url) {
  let sql;
  return (text, params) => (sql ??= neon(url)).query(text, params);
}

function storeFromEnv(env) {
  if (!env.DATABASE_URL) return unconfiguredStore('DATABASE_URL is not set');
  if (!isPostgresUrl(env.DATABASE_URL)) return unconfiguredStore('DATABASE_URL is not a valid Postgres connection URL');
  return new PgStore(neonQuery(env.DATABASE_URL));
}

export function depsFromEnv(env, { fetch = globalThis.fetch } = {}) {
  const store = storeFromEnv(env);
  const complete = createChatCompletion({
    baseUrl: env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL,
    apiKey: env.LLM_API_KEY || env.GOOGLE_API_KEY || '',
    model: env.LLM_MODEL || DEFAULT_LLM_MODEL,
    fetch,
  });
  return {
    store,
    complete,
    cronSecret: env.CRON_SECRET || '',
    checkout: env.STRIPE_SECRET_KEY ? createStripeCheckout({ secretKey: env.STRIPE_SECRET_KEY, fetch }) : null,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    sendEmail:
      env.BREVO_API_KEY && isEmailAddress(env.EMAIL_FROM) ? createBrevoSender({ apiKey: env.BREVO_API_KEY, from: env.EMAIL_FROM, fetch }) : null,
    printOrder: env.PRODIGI_API_KEY
      ? createProdigiPrinter({ apiKey: env.PRODIGI_API_KEY, environment: env.PRODIGI_ENV === 'live' ? 'live' : 'sandbox', fetch })
      : null,
    siteUrl: siteUrlFromEnv(env),
    beacon: (env.DEPLOY_ENV || env.VERCEL_ENV) === 'production',
  };
}

