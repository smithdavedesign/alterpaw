// Production entry (Vercel detects Hono and serves this default export).
// Configuration comes only from environment variables; their values are never logged or stored
// (errors are redacted in app.js, and a malformed DATABASE_URL is refused before the driver sees it).
//   DATABASE_URL    Postgres (Neon free tier), required to save previews
//   GOOGLE_API_KEY  Gemini API key (free tier), used when LLM_API_KEY is not set
//   LLM_BASE_URL    optional OpenAI-compatible endpoint, e.g. a LiteLLM proxy
//   LLM_API_KEY     optional key for LLM_BASE_URL
//   LLM_MODEL       optional model name
//   CRON_SECRET     bearer token for the daily photo-deletion job; Vercel Cron sends it automatically
import { neon } from '@neondatabase/serverless';
import { createApp } from './app.js';
import { createChatCompletion } from './character.js';
import { PgStore } from './store.js';

export const DEFAULT_LLM_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
export const DEFAULT_LLM_MODEL = 'gemini-flash-latest';

// Fails loudly instead of quietly keeping previews in one serverless instance's memory.
// The message is fixed: it never includes the variable's value.
const unconfiguredStore = (message) => {
  const fail = async () => {
    throw new Error(message);
  };
  return { createPet: fail, getPet: fail, getPhoto: fail, reportPet: fail, expirePhotos: fail };
};

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
  return { store, complete, cronSecret: env.CRON_SECRET || '' };
}

export default createApp(depsFromEnv(process.env));
