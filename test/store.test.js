import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { MemoryStore, PgStore } from '../src/store.js';
import { parseCharacter } from '../src/character.js';
import { validCharacter, pngBytes, jpegBytes } from './helpers.js';

function record(overrides = {}) {
  return {
    slug: 'AbCdEfGhIjKlMnOpQrStUv',
    name: 'Biscuit',
    species: 'dog',
    traits: ['greedy', '<script>alert(1)</script>', "o'clock"],
    alterEgo: 'crime-boss',
    character: validCharacter(),
    photo: pngBytes(300 * 1024),
    photoType: 'image/png',
    ...overrides,
  };
}

// The same contract runs against both stores, so the in-memory store can't drift from the SQL one.
function contract(name, makeStore) {
  describe(`${name} store contract`, () => {
    let store;
    before(async () => {
      store = await makeStore();
    });

    test('round-trips a record, and getPet never includes the photo bytes', async () => {
      const rec = record();
      await store.createPet(rec);
      const pet = await store.getPet(rec.slug);
      assert.equal(pet.slug, rec.slug);
      assert.equal(pet.name, 'Biscuit');
      assert.equal(pet.species, 'dog');
      assert.deepEqual(pet.traits, rec.traits);
      assert.equal(pet.alterEgo, 'crime-boss');
      assert.deepEqual(pet.character, rec.character);
      assert.equal(pet.photoType, 'image/png');
      assert.ok(pet.createdAt instanceof Date && !Number.isNaN(pet.createdAt.getTime()));
      assert.equal(pet.photo, undefined);
    });

    test('getPhoto returns the exact bytes and type', async () => {
      const bytes = jpegBytes(123457);
      await store.createPet(record({ slug: 'photo-roundtrip-slug-01', photo: bytes, photoType: 'image/jpeg' }));
      const photo = await store.getPhoto('photo-roundtrip-slug-01');
      assert.equal(photo.type, 'image/jpeg');
      assert.ok(photo.bytes instanceof Uint8Array);
      assert.deepEqual(Buffer.from(photo.bytes), Buffer.from(bytes));
    });

    test('unknown slugs return null', async () => {
      assert.equal(await store.getPet('no-such-slug-000000'), null);
      assert.equal(await store.getPhoto('no-such-slug-000000'), null);
    });

    test('injection-shaped slugs are just values', async () => {
      assert.equal(await store.getPet("x'; DROP TABLE pets; --"), null);
      assert.ok(await store.getPet('AbCdEfGhIjKlMnOpQrStUv'), 'table still there');
    });

    test('a duplicate slug is rejected, not overwritten', async () => {
      await store.createPet(record({ slug: 'duplicate-slug-000001', name: 'First' }));
      await assert.rejects(store.createPet(record({ slug: 'duplicate-slug-000001', name: 'Second' })));
      assert.equal((await store.getPet('duplicate-slug-000001')).name, 'First');
    });

    test('stored records are copies, not shared references', async () => {
      const rec = record({ slug: 'copy-check-slug-000001' });
      await store.createPet(rec);
      rec.traits.push('mutated');
      rec.character.alias = 'mutated';
      const pet = await store.getPet('copy-check-slug-000001');
      assert.equal(pet.traits.length, 3);
      assert.notEqual(pet.character.alias, 'mutated');
    });

    // M2
    test('a new record has no reports, is not expired, and keeps the createdAt it was given', async () => {
      const createdAt = new Date(Date.now() - 60_000); // recent, so the expiry test below leaves it alone
      await store.createPet(record({ slug: 'm2-fresh-record-slug-01', createdAt }));
      const pet = await store.getPet('m2-fresh-record-slug-01');
      assert.equal(pet.reports, 0);
      assert.equal(pet.expiredAt, null);
      assert.equal(pet.createdAt.toISOString(), createdAt.toISOString());
    });

    test('reportPet counts distinct reporters and says whether this call added one', async () => {
      const slug = 'm2-report-count-slug-01';
      await store.createPet(record({ slug }));
      const at = new Date();
      assert.deepEqual(await store.reportPet(slug, { reporter: 'aaaaaa', reason: 'offensive', at }), { reports: 1, added: true });
      assert.deepEqual(
        await store.reportPet(slug, { reporter: 'aaaaaa', reason: 'other', at }),
        { reports: 1, added: false },
        'same reporter again',
      );
      assert.deepEqual(await store.reportPet(slug, { reporter: 'bbbbbb', reason: 'not-a-pet', at }), { reports: 2, added: true });
      assert.equal((await store.getPet(slug)).reports, 2);
    });

    test('reportPet on an unknown slug returns null and stores nothing', async () => {
      assert.equal(await store.reportPet('no-such-slug-000000', { reporter: 'c'.repeat(32), reason: 'other', at: new Date() }), null);
      assert.equal(await store.getPet('no-such-slug-000000'), null);
    });

    test('expirePhotos deletes only photos created before the cutoff, once', async () => {
      // Relative to the real clock: the other tests' records were created just now, after this cutoff,
      // so exactly one photo goes.
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      await store.createPet(record({ slug: 'm2-expire-old-slug-001', createdAt: new Date(cutoff.getTime() - 1000) }));
      await store.createPet(record({ slug: 'm2-expire-new-slug-001', createdAt: cutoff }));
      assert.equal(await store.expirePhotos(cutoff, now), 1);
      assert.equal(await store.getPhoto('m2-expire-old-slug-001'), null);
      assert.ok(await store.getPhoto('m2-expire-new-slug-001'));
      const old = await store.getPet('m2-expire-old-slug-001');
      assert.equal(old.expiredAt.toISOString(), now.toISOString());
      assert.equal(old.name, 'Biscuit', 'the text stays; only the photo is deleted');
      assert.equal(await store.expirePhotos(cutoff, now), 0, 'idempotent');
    });
  });
}

contract('memory', () => new MemoryStore());

describe('MemoryStore specifics', () => {
  test('expirePhotos also drops report entries past the cutoff, keeping the count on the record', async () => {
    const store = new MemoryStore();
    await store.createPet(record({ slug: 'memory-report-rows-0001' }));
    await store.reportPet('memory-report-rows-0001', { reporter: 'f'.repeat(32), reason: 'my-photo', at: new Date('2026-01-01T00:00:00Z') });
    await store.reportPet('memory-report-rows-0001', { reporter: '0'.repeat(32), reason: 'other', at: new Date('2026-03-01T00:00:00Z') });
    await store.expirePhotos(new Date('2026-02-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    assert.deepEqual([...store.reports.get('memory-report-rows-0001').keys()], ['0'.repeat(32)]);
    assert.equal((await store.getPet('memory-report-rows-0001')).reports, 2);
  });
});

let pg;
contract('postgres (PGlite)', async () => {
  pg = new PGlite();
  return new PgStore((text, params) => pg.query(text, params).then((r) => r.rows));
});

describe('PgStore specifics', () => {
  after(async () => {
    await pg?.close();
  });

  test('creates the schema once, lazily, and only uses parameterised SQL', async () => {
    const db = new PGlite();
    const seen = [];
    const store = new PgStore((text, params) => {
      seen.push({ text, params });
      return db.query(text, params).then((r) => r.rows);
    });
    await store.getPet('lazy-schema-slug-0001');
    await store.getPet('lazy-schema-slug-0002');
    assert.equal(seen.filter((q) => /CREATE TABLE/i.test(q.text)).length, 1);
    for (const q of seen) {
      assert.ok(!q.text.includes('lazy-schema-slug'), 'slug is never interpolated into SQL');
    }
    await db.close();
  });

  test('a failed schema creation is retried on the next call', async () => {
    const db = new PGlite();
    let failNext = true;
    const store = new PgStore((text, params) => {
      if (failNext && /CREATE TABLE/i.test(text)) {
        failNext = false;
        return Promise.reject(new Error('cold start'));
      }
      return db.query(text, params).then((r) => r.rows);
    });
    await assert.rejects(store.getPet('retry-schema-slug-001'));
    assert.equal(await store.getPet('retry-schema-slug-001'), null);
    await db.close();
  });

  test('losing a CREATE TABLE race to another instance counts as success', async () => {
    for (const code of ['23505', '42P07']) {
      const db = new PGlite();
      let raced = false;
      const store = new PgStore(async (text, params) => {
        if (!raced && /CREATE TABLE/i.test(text)) {
          raced = true;
          await db.query(text); // the other instance wins…
          throw Object.assign(new Error('duplicate key value violates unique constraint'), { code }); // …we lose
        }
        return (await db.query(text, params)).rows;
      });
      assert.equal(await store.getPet('race-schema-slug-0001'), null, code);
      await db.close();
    }
  });

  test('model text with NUL, a lone surrogate or an emoji at the cut stores fine once parsed', async () => {
    const db = new PGlite();
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    const nasty = validCharacter({
      alias: 'a'.repeat(58) + String.fromCodePoint(0x1f436).repeat(3),
      bio: `Biscuit${String.fromCharCode(0)} naps ${String.fromCharCode(0xd83d)}a lot.`,
    });

    // Control: Postgres jsonb really does reject the raw text, which is why parseCharacter cleans it.
    await assert.rejects(store.createPet(record({ slug: 'raw-model-text-slug-01', character: nasty })));

    const character = parseCharacter(JSON.stringify(nasty));
    await store.createPet(record({ slug: 'clean-model-text-slug1', character }));
    assert.deepEqual((await store.getPet('clean-model-text-slug1')).character, character);
    await db.close();
  });

  test('upgrades a database created by M1 (photo NOT NULL, no report or expiry columns)', async () => {
    const db = new PGlite();
    // M1's schema and one M1 row, verbatim.
    await db.exec(`
      CREATE TABLE pets (
        slug        text PRIMARY KEY,
        name        text NOT NULL,
        species     text NOT NULL,
        traits      jsonb NOT NULL,
        alter_ego   text NOT NULL,
        character   jsonb NOT NULL,
        photo       bytea NOT NULL,
        photo_type  text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO pets (slug, name, species, traits, alter_ego, character, photo, photo_type, created_at)
      VALUES ('m1-era-record-slug-0001', 'Biscuit', 'dog', '["greedy"]', 'crime-boss', '{"alias":"x"}',
              '\\xffd8ff', 'image/jpeg', '2026-01-01T00:00:00Z');
    `);
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    const pet = await store.getPet('m1-era-record-slug-0001');
    assert.equal(pet.reports, 0);
    assert.equal(pet.expiredAt, null);
    assert.deepEqual(await store.reportPet('m1-era-record-slug-0001', { reporter: 'dddddd', reason: 'other', at: new Date() }), {
      reports: 1,
      added: true,
    });
    assert.equal(await store.expirePhotos(new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z')), 1);
    assert.equal(await store.getPhoto('m1-era-record-slug-0001'), null);
    await db.close();
  });

  // PGlite runs one query at a time, so this checks the statement's logic under interleaved calls, not real
  // row-lock contention; the single-statement CTE is what makes it safe on a real server (see store.js).
  test('interleaved reports: distinct reporters all count, the same reporter counts once', async () => {
    const db = new PGlite();
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    await store.createPet(record({ slug: 'parallel-report-slug-01' }));
    const at = new Date();
    const distinct = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => store.reportPet('parallel-report-slug-01', { reporter: String(i).repeat(6), reason: 'other', at })),
    );
    assert.deepEqual(distinct.map((r) => r.reports).sort(), [1, 2, 3, 4, 5]);
    const repeats = await Promise.all(
      [1, 2, 3].map(() => store.reportPet('parallel-report-slug-01', { reporter: 'eeeeee', reason: 'other', at })),
    );
    assert.equal(repeats.filter((r) => r.added).length, 1, 'only one of the repeats is added');
    assert.equal((await store.getPet('parallel-report-slug-01')).reports, 6);
    await db.close();
  });

  test('reports keep the hashed reporter and reason; expirePhotos also drops report rows past the cutoff', async () => {
    const db = new PGlite();
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    await store.createPet(record({ slug: 'report-rows-slug-00001' }));
    await store.reportPet('report-rows-slug-00001', { reporter: 'f'.repeat(32), reason: 'my-photo', at: new Date('2026-01-01T00:00:00Z') });
    await store.reportPet('report-rows-slug-00001', { reporter: '0'.repeat(32), reason: 'other', at: new Date('2026-03-01T00:00:00Z') });
    const before = (await db.query('SELECT reporter, reason FROM reports ORDER BY created_at')).rows;
    assert.deepEqual(before, [
      { reporter: 'f'.repeat(32), reason: 'my-photo' },
      { reporter: '0'.repeat(32), reason: 'other' },
    ]);
    await store.expirePhotos(new Date('2026-02-01T00:00:00Z'), new Date('2026-03-02T00:00:00Z'));
    const after = (await db.query('SELECT reporter FROM reports')).rows;
    assert.deepEqual(after, [{ reporter: '0'.repeat(32) }]);
    assert.equal((await store.getPet('report-rows-slug-00001')).reports, 2, 'the count on the record stays');
    await db.close();
  });

  test('accepts jsonb columns returned as strings (driver differences)', async () => {
    const db = new PGlite();
    const store = new PgStore(async (text, params) => {
      const rows = (await db.query(text, params)).rows;
      return rows.map((row) => ({
        ...row,
        ...(row.traits ? { traits: JSON.stringify(row.traits) } : {}),
        ...(row.character ? { character: JSON.stringify(row.character) } : {}),
      }));
    });
    await store.createPet(record({ slug: 'json-string-slug-0001' }));
    const pet = await store.getPet('json-string-slug-0001');
    assert.deepEqual(pet.character, validCharacter());
    assert.equal(pet.traits.length, 3);
    await db.close();
  });
});
