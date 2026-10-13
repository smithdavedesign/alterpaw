import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { makeApp, petRecord, SpyStore, DAY_MS } from './helpers.js';
import { PgStore } from '../src/store.js';
import { PHOTO_RETENTION_DAYS, previewStatus } from '../src/app.js';

const NOW = new Date('2026-10-13T12:00:00Z');
const daysAgo = (days, ms = 0) => new Date(NOW.getTime() - days * DAY_MS - ms);
const OLD = 'old-preview-slug-000001';
const FRESH = 'fresh-preview-slug-0001';
// Built at runtime so nothing credential-shaped sits in the repo.
const SECRET = ['cron', 'A1b2C3d4'.repeat(4)].join('-');

const runJob = (app, token = SECRET) =>
  app.request('/jobs/expire-photos', { headers: token === null ? {} : { authorization: `Bearer ${token}` } });

const STORES = [
  ['memory', async () => ({ store: new SpyStore(), close: async () => {} })],
  [
    'postgres (PGlite)',
    async () => {
      const db = new PGlite();
      return { store: new PgStore((text, params) => db.query(text, params).then((r) => r.rows)), close: () => db.close() };
    },
  ],
];

describe('photo deletion job (M2 exit criterion 3)', () => {
  assert.equal(PHOTO_RETENTION_DAYS, 30);

  for (const [name, open] of STORES) {
    test(`${name}: removes photos older than 30 days, and the preview then shows an "expired" page`, async () => {
      const { store, close } = await open();
      try {
        await store.createPet(petRecord({ slug: OLD, createdAt: daysAgo(31) }));
        await store.createPet(petRecord({ slug: FRESH, createdAt: daysAgo(29) }));
        const { app } = makeApp({ store, now: () => NOW, cronSecret: SECRET });

        const res = await runJob(app);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { deleted: 1 });

        assert.equal(await store.getPhoto(OLD), null, 'the old photo is gone from storage');
        assert.ok((await store.getPhoto(FRESH))?.bytes.length > 0, 'the recent photo is kept');
        assert.ok((await store.getPet(OLD)).expiredAt instanceof Date, 'the record remembers when');

        const page = await app.request(`/p/${OLD}`);
        assert.equal(page.status, 410);
        const html = await page.text();
        assert.match(html, /expired/i);
        assert.match(html, /<meta name="robots" content="[^"]*noindex/);
        assert.match(html, /<a[^>]*href="\/"[^>]*>Make your pet(?:'|&#39;)s/);
        assert.equal((await app.request(`/p/${OLD}/photo`)).status, 410);
        assert.equal((await app.request(`/p/${OLD}/share.png`)).status, 410);

        assert.equal((await app.request(`/p/${FRESH}`)).status, 200, 'the recent preview still works');

        const again = await runJob(app);
        assert.deepEqual(await again.json(), { deleted: 0 }, 'a second run has nothing left to do');
      } finally {
        await close();
      }
    });
  }

  for (const [name, open] of STORES) {
    test(`${name}: "older than 30 days" is strict, and the page and the job agree on the boundary`, async () => {
      const { store, close } = await open();
      try {
        await store.createPet(petRecord({ slug: 'thirty-days-exactly-001', createdAt: daysAgo(30) }));
        await store.createPet(petRecord({ slug: 'thirty-days-and-1ms-001', createdAt: daysAgo(30, 1) }));
        const { app } = makeApp({ store, now: () => NOW, cronSecret: SECRET });
        assert.equal((await app.request('/p/thirty-days-exactly-001')).status, 200, 'page: exactly 30 days is live');
        assert.equal((await app.request('/p/thirty-days-and-1ms-001')).status, 410, 'page: 1 ms more is expired');
        assert.deepEqual(await (await runJob(app)).json(), { deleted: 1 });
        assert.ok(await store.getPhoto('thirty-days-exactly-001'), 'job: exactly 30 days is kept');
        assert.equal(await store.getPhoto('thirty-days-and-1ms-001'), null, 'job: 1 ms more is deleted');
      } finally {
        await close();
      }
    });
  }

  test('a preview past 30 days is expired even if the job has not run yet, and its photo is not served', async () => {
    const store = new SpyStore();
    await store.createPet(petRecord({ slug: OLD, createdAt: daysAgo(31) }));
    const { app } = makeApp({ store, now: () => NOW, cronSecret: SECRET });
    assert.ok(await store.getPhoto(OLD), 'bytes still stored (the job has not run)');
    const page = await app.request(`/p/${OLD}`);
    assert.equal(page.status, 410);
    assert.match(await page.text(), /expired/i);
    assert.equal((await app.request(`/p/${OLD}/photo`)).status, 410);
    assert.equal((await app.request(`/p/${OLD}/share.png`)).status, 410);
  });

  test('the job logs how many photos it deleted', async () => {
    const store = new SpyStore();
    await store.createPet(petRecord({ slug: OLD, createdAt: daysAgo(40) }));
    const { app, logs } = makeApp({ store, now: () => NOW, cronSecret: SECRET });
    await runJob(app);
    assert.ok(logs.some((l) => l.startsWith('info') && l.includes('deleted 1 photo')));
  });
});

describe('previewStatus', () => {
  const pet = (overrides) => ({ reports: 0, expiredAt: null, createdAt: daysAgo(1), ...overrides });

  test('live, expired by age, expired by the job, removed by reports', () => {
    assert.equal(previewStatus(pet({}), NOW), 'live');
    assert.equal(previewStatus(pet({ createdAt: daysAgo(30) }), NOW), 'live');
    assert.equal(previewStatus(pet({ createdAt: daysAgo(30, 1) }), NOW), 'expired');
    assert.equal(previewStatus(pet({ expiredAt: daysAgo(0) }), NOW), 'expired', 'the job ran, whatever the age');
    assert.equal(previewStatus(pet({ reports: 2 }), NOW), 'live');
    assert.equal(previewStatus(pet({ reports: 3 }), NOW), 'removed');
  });

  test('removed wins over expired (nothing from a taken-down preview is described)', () => {
    assert.equal(previewStatus(pet({ reports: 3, createdAt: daysAgo(40), expiredAt: daysAgo(5) }), NOW), 'removed');
  });
});

describe('GET /jobs/expire-photos authorisation', () => {
  test('without CRON_SECRET configured it refuses to run (503) and touches nothing', async () => {
    const store = new SpyStore();
    let runs = 0;
    store.expirePhotos = async () => (runs++, 0);
    for (const cronSecret of [undefined, '']) {
      const { app } = makeApp({ store, now: () => NOW, cronSecret });
      assert.equal((await runJob(app)).status, 503);
      assert.equal((await runJob(app, '')).status, 503);
    }
    assert.equal(runs, 0);
  });

  test('a missing or wrong token is 401 and touches nothing', async () => {
    const store = new SpyStore();
    let runs = 0;
    store.expirePhotos = async () => (runs++, 0);
    const { app } = makeApp({ store, now: () => NOW, cronSecret: SECRET });
    assert.equal((await runJob(app, null)).status, 401);
    assert.equal((await runJob(app, `${SECRET}x`)).status, 401);
    assert.equal((await runJob(app, SECRET.slice(0, -1))).status, 401);
    const basic = await app.request('/jobs/expire-photos', { headers: { authorization: SECRET } });
    assert.equal(basic.status, 401, 'the Bearer prefix is required');
    assert.equal(runs, 0);
  });

  test('any characters in the secret work (no token-format trap)', async () => {
    const secret = ['x!y', 'Q9z'.repeat(8), '"; ='].join('#');
    const { app } = makeApp({ store: new SpyStore(), now: () => NOW, cronSecret: secret });
    assert.equal((await runJob(app, secret)).status, 200);
  });

  test('a storage failure is a 500 JSON error, logged', async () => {
    const store = new SpyStore();
    store.expirePhotos = async () => {
      throw new Error('connection refused');
    };
    const { app, logs } = makeApp({ store, now: () => NOW, cronSecret: SECRET });
    const res = await runJob(app);
    assert.equal(res.status, 500);
    assert.ok(logs.some((l) => l.startsWith('error')));
  });
});

describe('scheduling', () => {
  test('vercel.json runs the job once a day (the most Vercel Hobby allows)', async () => {
    const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
    const cron = config.crons?.find((c) => c.path === '/jobs/expire-photos');
    assert.ok(cron, 'cron entry for the job');
    assert.match(cron.schedule, /^\d{1,2} \d{1,2} \* \* \*$/, 'daily');
  });
});
