// Vercel's entry (Vercel detects Hono and serves this default export). Hosting moved to a Cloudflare Worker on
// 2026-11-08 (src/worker.js); this stays so the app still runs on Node, which is also what `npm run dev` and
// the tests use. Settings: src/deps.js.
import { createApp } from './app.js';
import { depsFromEnv } from './deps.js';

export * from './deps.js';

export default createApp(depsFromEnv(process.env));
