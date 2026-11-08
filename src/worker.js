// The Cloudflare Worker (wrangler.jsonc; production since 2026-11-08). The same Hono app as Vercel's entry
// (src/index.js), built once per isolate from the Worker's vars and secrets (src/deps.js):
//   - The renderers' wasm (resvg, satori's layout engine) and fonts are bundled at deploy as modules: a
//     Worker can't read files or compile wasm at run time. setAssetReader hands them to share.js by file name.
//   - The daily jobs run from Cron Triggers (`scheduled`, src/schedule.js). The scheduler is part of the
//     Worker, so it needs no CRON_SECRET: without one, each isolate makes its own random secret, which only
//     its own scheduled runs carry. /jobs/* over HTTP still answers only CRON_SECRET, if one is set.
//   - The report counter keys on CF-Connecting-IP, which Cloudflare sets itself (app.js, clientIp).
// First, before satori loads: its text shaper's wasm, compiled at deploy (src/harfbuzz-wasm.js).
import './harfbuzz-wasm.js';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import layoutWasm from 'satori/layout.wasm';
import rye400 from '@fontsource/rye/files/rye-latin-400-normal.woff';
import slabLatin400 from '@fontsource/roboto-slab/files/roboto-slab-latin-400-normal.woff';
import slabLatin700 from '@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff';
import slabLatinExt400 from '@fontsource/roboto-slab/files/roboto-slab-latin-ext-400-normal.woff';
import slabLatinExt700 from '@fontsource/roboto-slab/files/roboto-slab-latin-ext-700-normal.woff';
import slabVietnamese400 from '@fontsource/roboto-slab/files/roboto-slab-vietnamese-400-normal.woff';
import slabVietnamese700 from '@fontsource/roboto-slab/files/roboto-slab-vietnamese-700-normal.woff';
import slabCyrillic400 from '@fontsource/roboto-slab/files/roboto-slab-cyrillic-400-normal.woff';
import slabCyrillic700 from '@fontsource/roboto-slab/files/roboto-slab-cyrillic-700-normal.woff';
import slabGreek400 from '@fontsource/roboto-slab/files/roboto-slab-greek-400-normal.woff';
import slabGreek700 from '@fontsource/roboto-slab/files/roboto-slab-greek-700-normal.woff';
import { createApp } from './app.js';
import { depsFromEnv } from './deps.js';
import { runScheduledJob } from './schedule.js';
import { setAssetReader } from './share.js';

// share.js's ASSET_URLS by file name (each name is unique). test/worker.test.js checks every one is here.
const ASSETS = {
  'index_bg.wasm': resvgWasm,
  'layout.wasm': layoutWasm,
  'rye-latin-400-normal.woff': rye400,
  'roboto-slab-latin-400-normal.woff': slabLatin400,
  'roboto-slab-latin-700-normal.woff': slabLatin700,
  'roboto-slab-latin-ext-400-normal.woff': slabLatinExt400,
  'roboto-slab-latin-ext-700-normal.woff': slabLatinExt700,
  'roboto-slab-vietnamese-400-normal.woff': slabVietnamese400,
  'roboto-slab-vietnamese-700-normal.woff': slabVietnamese700,
  'roboto-slab-cyrillic-400-normal.woff': slabCyrillic400,
  'roboto-slab-cyrillic-700-normal.woff': slabCyrillic700,
  'roboto-slab-greek-400-normal.woff': slabGreek400,
  'roboto-slab-greek-700-normal.woff': slabGreek700,
};

setAssetReader(async (url) => {
  const name = String(url).split('/').pop();
  if (!Object.hasOwn(ASSETS, name)) throw new Error(`asset not bundled into the Worker: ${name}`);
  return ASSETS[name];
});

const randomSecret = () => [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');

let built = null;
function appFor(env) {
  if (!built) {
    const deps = depsFromEnv(env);
    const cronSecret = deps.cronSecret || randomSecret();
    built = { cronSecret, app: createApp({ ...deps, cronSecret, clientIpHeader: 'cf-connecting-ip' }) };
  }
  return built;
}

export default {
  fetch: (request, env, ctx) => appFor(env).app.fetch(request, env, ctx),
  async scheduled(controller, env, ctx) {
    const { app, cronSecret } = appFor(env);
    const { path, status, body } = await runScheduledJob(app, controller.cron, cronSecret, { env, ctx });
    console.log(`scheduled ${path}: ${status === 503 ? 'skipped, not configured' : status} ${body.slice(0, 200)}`);
  },
};
