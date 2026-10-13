// Production wiring: which store and model client get built from which env vars.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { depsFromEnv, DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '../src/index.js';
import { PgStore } from '../src/store.js';
import { createApp, redact } from '../src/app.js';
import { petForm, validCharacter, fakeApiKey } from './helpers.js';

const quiet = { error() {}, warn() {}, info() {} };

describe('redact (log hygiene)', () => {
  const secret = 'Pw7k'.repeat(6);

  test('masks database URLs to the end of the line, even malformed ones with spaces', () => {
    const neonStyle = `Database connection string provided to neon() is not a valid URL (connection string: ${[
      'postgresql://u:',
      secret,
      ' tail@h/db)',
    ].join('')}`;
    const out = redact(new Error(neonStyle));
    assert.ok(!out.includes(secret));
    assert.match(out, /^Database connection string provided to neon\(\) is not a valid URL \(connection string: \[redacted url\]$/);
  });

  test('masks any URL carrying user-info, and leaves ordinary text alone', () => {
    const out = redact(['fetch to https://user:', secret, '@api.example.test/v1 failed'].join(''));
    assert.ok(!out.includes(secret));
    assert.equal(out, 'fetch to [redacted url] failed');
    assert.equal(redact(new Error('model responded 429')), 'model responded 429');
    assert.equal(redact('see https://example.test/docs'), 'see https://example.test/docs');
  });
});

describe('depsFromEnv', () => {
  test('uses Postgres when DATABASE_URL is set', () => {
    const { store } = depsFromEnv({ DATABASE_URL: 'postgres://' + 'localhost/alterpaw' });
    assert.ok(store instanceof PgStore);
  });

  test('without DATABASE_URL it refuses to store rather than silently using memory', async () => {
    const { store } = depsFromEnv({});
    await assert.rejects(store.createPet({}), /DATABASE_URL/);
    await assert.rejects(store.getPet('AAAAAAAAAAAAAAAAAAAAAA'), /DATABASE_URL/);
    await assert.rejects(store.getPhoto('AAAAAAAAAAAAAAAAAAAAAA'), /DATABASE_URL/);
    await assert.rejects(store.reportPet('AAAAAAAAAAAAAAAAAAAAAA', {}), /DATABASE_URL/);
    await assert.rejects(store.expirePhotos(new Date(), new Date()), /DATABASE_URL/);
  });

  test('CRON_SECRET authorises the deletion job; without it the job refuses to run', async () => {
    const secret = ['cron', 'Zq9x'.repeat(8)].join('-');
    const withSecret = createApp({ ...depsFromEnv({ CRON_SECRET: secret }), logger: quiet });
    const ok = await withSecret.request('/jobs/expire-photos', { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(ok.status, 500, 'authorised, then fails on the missing database (not 401/503)');
    const without = createApp({ ...depsFromEnv({}), logger: quiet });
    assert.equal((await without.request('/jobs/expire-photos', { headers: { authorization: `Bearer ${secret}` } })).status, 503);
  });

  test('defaults the model to the Gemini OpenAI-compatible endpoint with GOOGLE_API_KEY', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, init });
      return Response.json({ choices: [{ message: { content: JSON.stringify(validCharacter()) } }] });
    };
    const key = fakeApiKey();
    const { complete } = depsFromEnv({ GOOGLE_API_KEY: key }, { fetch });
    await complete([{ role: 'user', content: 'hi' }]);
    assert.equal(seen[0].url, `${DEFAULT_LLM_BASE_URL}/chat/completions`);
    assert.equal(seen[0].init.headers.authorization, `Bearer ${key}`);
    assert.equal(JSON.parse(seen[0].init.body).model, DEFAULT_LLM_MODEL);
  });

  test('LLM_BASE_URL / LLM_API_KEY / LLM_MODEL override the defaults (e.g. a LiteLLM proxy)', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ url, init });
      return Response.json({ choices: [{ message: { content: '{}' } }] });
    };
    const key = fakeApiKey();
    const { complete } = depsFromEnv(
      { LLM_BASE_URL: 'http://localhost:4000/v1', LLM_API_KEY: key, LLM_MODEL: 'free/model', GOOGLE_API_KEY: 'unused' },
      { fetch },
    );
    await complete([]);
    assert.equal(seen[0].url, 'http://localhost:4000/v1/chat/completions');
    assert.equal(seen[0].init.headers.authorization, `Bearer ${key}`);
    assert.equal(JSON.parse(seen[0].init.body).model, 'free/model');
  });

  test('with no key and no database, /generate fails cleanly with 502 and nothing is stored', async () => {
    const app = createApp({ ...depsFromEnv({}), logger: quiet });
    const res = await app.request('/generate', { method: 'POST', body: petForm() });
    assert.equal(res.status, 502);
  });

  test('a malformed DATABASE_URL fails the request (500), not the whole app', async () => {
    const app = createApp({ ...depsFromEnv({ DATABASE_URL: 'not a connection string' }), logger: quiet });
    const home = await app.request('/');
    assert.equal(home.status, 200, 'home page still works');
    const page = await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(page.status, 500);
  });

  test('a malformed DATABASE_URL never reaches the logs, password or otherwise', async () => {
    // Built at runtime so no credential-shaped string sits in the repo. The space makes it unparseable,
    // which is the case where Neon's driver would quote the whole string in its error.
    const password = 'Zq9x'.repeat(6);
    const badUrl = ['postgresql://', 'alterpaw', ':', password, '@', 'db host.example.test/alterpaw'].join('');
    const lines = [];
    const logger = { error: (m) => lines.push(String(m)), warn() {}, info() {} };
    const app = createApp({ ...depsFromEnv({ DATABASE_URL: badUrl }), logger });
    assert.equal((await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA')).status, 500);
    assert.equal((await app.request('/generate', { method: 'POST', body: petForm() })).status, 502);
    assert.ok(lines.length > 0, 'the failure is logged');
    for (const line of lines) {
      assert.ok(!line.includes(password), 'password not logged');
      assert.ok(!line.includes('db host'), 'URL not logged');
    }
    assert.ok(lines.some((l) => l.includes('DATABASE_URL is not a valid')));
  });

  test('importing the production entry builds an app without throwing', async () => {
    const mod = await import('../src/index.js');
    assert.equal(typeof mod.default.fetch, 'function');
  });
});
