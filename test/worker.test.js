// The Cloudflare Worker: its wrangler.jsonc, the assets src/worker.js bundles, satori's text shaper wasm, and the
// scheduled jobs. The Worker itself only runs in workerd (it imports .wasm modules); its pieces are checked here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeApp, fakeCronSecret, SpyStore } from './helpers.js';
import { ASSET_URLS } from '../src/share.js';
import { SCHEDULED_JOBS, runScheduledJob } from '../src/schedule.js';

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

// wrangler.jsonc → JSON: drops // and /* */ comments outside strings, and trailing commas.
function parseJsonc(text) {
  let out = '';
  for (let i = 0, inString = false; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (text.startsWith('//', i)) {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (text.startsWith('/*', i)) {
      i = text.indexOf('*/', i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

describe('wrangler.jsonc', async () => {
  const config = parseJsonc(await source('wrangler.jsonc'));

  test('names the Worker after the repo, runs src/worker.js, and has no build step (the deploy broker refuses one)', () => {
    assert.equal(config.name, 'alterpaw');
    assert.equal(config.main, 'src/worker.js');
    assert.equal(config.build, undefined);
    assert.ok(config.compatibility_flags.includes('nodejs_compat'));
  });

  test("keeps esbuild's keepNames off, so /beacon.js (a function's source) has no __name() calls", () => {
    assert.equal(config.keep_names, false);
  });

  test('bundles the fonts as bytes', () => {
    assert.ok(config.rules.some((rule) => rule.type === 'Data' && rule.globs.includes('**/*.woff')));
  });

  test('is production on its own workers.dev host: canonical URLs there, visit beacon on', () => {
    assert.equal(config.vars.SITE_HOST, 'alterpaw.1426davejobs.workers.dev');
    assert.equal(config.vars.DEPLOY_ENV, 'production');
  });

  test('has one Cron Trigger per scheduled job', () => {
    assert.deepEqual([...config.triggers.crons].sort(), Object.keys(SCHEDULED_JOBS).sort());
  });
});

describe('src/worker.js', () => {
  test('bundles every asset the renderers read, by file name', async () => {
    const worker = await source('src/worker.js');
    for (const url of ASSET_URLS) {
      const name = url.pathname.split('/').pop();
      const pkgPath = url.pathname.split('/node_modules/').pop();
      assert.match(worker, new RegExp(`from '${pkgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `imports ${pkgPath}`);
      assert.match(worker, new RegExp(`'${name.replace(/\./g, '\\.')}':`), `maps ${name}`);
    }
  });

  test('loads the harfbuzz substitute before anything that imports satori', async () => {
    const imports = [...(await source('src/worker.js')).matchAll(/^import .*$/gm)].map(([line]) => line);
    assert.equal(imports[0], "import './harfbuzz-wasm.js';");
  });
});

describe('satori text shaper (src/harfbuzz-wasm.js)', () => {
  test("satori's inline wasm is harfbuzzjs/hb.wasm byte for byte, of the size the Worker matches on", async () => {
    const satori = await readFile(new URL('../node_modules/satori/dist/standalone.js', import.meta.url), 'utf8');
    const blobs = satori.match(/[A-Za-z0-9+/=]{20000,}/g) ?? [];
    assert.equal(blobs.length, 1, 'one inline wasm');
    const inline = Buffer.from(blobs[0], 'base64');
    const hb = await readFile(new URL('../node_modules/harfbuzzjs/hb.wasm', import.meta.url));
    assert.ok(inline.equals(hb), 'identical bytes');
    const size = Number((await source('src/harfbuzz-wasm.js')).match(/HARFBUZZ_WASM_BYTES = (\d+);/)[1]);
    assert.equal(hb.length, size);
  });
});

describe('scheduled jobs (src/schedule.js)', () => {
  const quietApp = (options) => makeApp({ cronSecret: fakeCronSecret(), ...options });

  test('each cron runs its job inside the app, with the bearer secret', async () => {
    const { app } = quietApp();
    const result = await runScheduledJob(app, '0 4 * * *', fakeCronSecret());
    assert.equal(result.path, '/jobs/expire-photos');
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { deleted: 0 });
  });

  test('a wrong secret, a failed job or an unknown schedule throws, so the run shows as failed', async () => {
    const { app } = quietApp();
    await assert.rejects(runScheduledJob(app, '0 4 * * *', 'wrong'), /answered 401/);
    await assert.rejects(runScheduledJob(app, '5 5 * * *', fakeCronSecret()), /no job is scheduled/);
    class BrokenStore extends SpyStore {
      async expirePhotos() {
        throw new Error('database unavailable');
      }
    }
    const broken = quietApp({ store: new BrokenStore() });
    await assert.rejects(runScheduledJob(broken.app, '0 4 * * *', fakeCronSecret()), /answered 500/);
  });

  test('a job that is not configured (gifts without email) is skipped, not failed', async () => {
    const { app, logs } = quietApp();
    const result = await runScheduledJob(app, '0 16 * * *', fakeCronSecret());
    assert.equal(result.status, 503);
    assert.ok(logs.some((l) => l.includes('BREVO_API_KEY')));
  });
});
