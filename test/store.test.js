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

    // M3
    test('a new record is unpaid, with its rewrite unused', async () => {
      await store.createPet(record({ slug: 'm3-fresh-record-slug-01' }));
      const pet = await store.getPet('m3-fresh-record-slug-01');
      assert.equal(pet.paidAt, null);
      assert.equal(pet.regeneratedAt, null);
    });

    test('markPaid records the first payment only; a repeat or another session changes nothing', async () => {
      const slug = 'm3-mark-paid-slug-0001';
      await store.createPet(record({ slug }));
      const at = new Date('2026-10-13T12:00:00Z');
      const later = new Date('2026-10-13T12:05:00Z');
      assert.deepEqual(await store.markPaid(slug, { sessionId: 'cs_one', at }), { changed: true, sessionId: 'cs_one' });
      assert.equal((await store.getPet(slug)).paidAt.toISOString(), at.toISOString());
      assert.deepEqual(await store.markPaid(slug, { sessionId: 'cs_one', at: later }), { changed: false, sessionId: 'cs_one' }, 'repeat');
      assert.deepEqual(await store.markPaid(slug, { sessionId: 'cs_two', at: later }), { changed: false, sessionId: 'cs_one' }, 'another session');
      assert.equal((await store.getPet(slug)).paidAt.toISOString(), at.toISOString(), 'paid time unchanged');
    });

    test('markPaid on an unknown slug returns null and stores nothing', async () => {
      assert.equal(await store.markPaid('no-such-slug-000000', { sessionId: 'cs_one', at: new Date() }), null);
      assert.equal(await store.getPet('no-such-slug-000000'), null);
    });

    test('saveRegenerated replaces the text once, and only for a paid preview', async () => {
      const slug = 'm3-regenerate-slug-001';
      await store.createPet(record({ slug }));
      const at = new Date('2026-10-14T09:00:00Z');
      const rewrite = validCharacter({ alias: 'Biscuit "The Sequel" Corleone' });
      assert.equal(await store.saveRegenerated(slug, rewrite, at), false, 'unpaid');
      assert.deepEqual((await store.getPet(slug)).character, validCharacter());

      await store.markPaid(slug, { sessionId: 'cs_one', at });
      assert.equal(await store.saveRegenerated(slug, rewrite, at), true);
      const pet = await store.getPet(slug);
      assert.deepEqual(pet.character, rewrite);
      assert.equal(pet.regeneratedAt.toISOString(), at.toISOString());

      assert.equal(await store.saveRegenerated(slug, validCharacter({ alias: 'Third' }), at), false, 'used');
      assert.deepEqual((await store.getPet(slug)).character, rewrite);
      assert.equal(await store.saveRegenerated('no-such-slug-000000', rewrite, at), false, 'unknown');
    });

    test('saveRegenerated stores a copy, not a shared reference', async () => {
      const slug = 'm3-regenerate-copy-001';
      await store.createPet(record({ slug }));
      await store.markPaid(slug, { sessionId: 'cs_one', at: new Date() });
      const rewrite = validCharacter({ alias: 'Original rewrite' });
      await store.saveRegenerated(slug, rewrite, new Date());
      rewrite.alias = 'mutated';
      assert.equal((await store.getPet(slug)).character.alias, 'Original rewrite');
    });

    // M4
    test('createOrder / getOrder round-trip a gift order, unpaid and unsent', async () => {
      const slug = 'm4-order-roundtrip-slug1';
      await store.createPet(record({ slug }));
      const order = giftOrder(slug, 'm4-gift-order-00000001');
      await store.createOrder(order);
      const stored = await store.getOrder(order.id);
      assert.deepEqual(stored, {
        id: order.id,
        slug,
        kind: 'gift',
        amountCents: 900,
        details: order.details,
        origin: 'https://alterpaw.example',
        createdAt: order.createdAt,
        deliverAt: order.deliverAt,
        paidAt: null,
        claimedAt: null,
        sentAt: null,
        cancelledAt: null,
        podOrderId: null,
      });
      assert.equal(await store.getOrder('no-such-order-0000000'), null);
      order.details.message = 'mutated';
      assert.notEqual((await store.getOrder(order.id)).details.message, 'mutated', 'a copy, not a shared reference');
    });

    test('a print order has no delivery instant; a duplicate id is rejected', async () => {
      const slug = 'm4-print-order-slug-001';
      await store.createPet(record({ slug }));
      await store.createOrder(printOrder(slug, 'm4-print-order-0000001'));
      const stored = await store.getOrder('m4-print-order-0000001');
      assert.equal(stored.kind, 'print');
      assert.equal(stored.deliverAt, null);
      assert.deepEqual(stored.details, ADDRESS);
      await assert.rejects(store.createOrder(printOrder(slug, 'm4-print-order-0000001')));
    });

    test('markOrderPaid records the first payment only; unknown ids return null', async () => {
      const slug = 'm4-order-paid-slug-0001';
      await store.createPet(record({ slug }));
      await store.createOrder(giftOrder(slug, 'm4-paid-order-00000001'));
      const at = new Date('2026-10-14T19:05:00Z');
      assert.deepEqual(await store.markOrderPaid('m4-paid-order-00000001', { sessionId: 'cs_one', at }), { changed: true, sessionId: 'cs_one' });
      assert.deepEqual(await store.markOrderPaid('m4-paid-order-00000001', { sessionId: 'cs_one', at: new Date() }), { changed: false, sessionId: 'cs_one' });
      assert.deepEqual(await store.markOrderPaid('m4-paid-order-00000001', { sessionId: 'cs_two', at: new Date() }), { changed: false, sessionId: 'cs_one' });
      assert.equal((await store.getOrder('m4-paid-order-00000001')).paidAt.toISOString(), at.toISOString());
      assert.equal(await store.markOrderPaid('no-such-order-0000000', { sessionId: 'cs_one', at }), null);
    });

    test('listOrders gives a preview’s paid orders, oldest first', async () => {
      const slug = 'm4-list-orders-slug-001';
      await store.createPet(record({ slug }));
      await store.createOrder(giftOrder(slug, 'm4-list-unpaid-0000001'));
      await store.createOrder({ ...printOrder(slug, 'm4-list-print-00000001'), createdAt: new Date('2026-10-14T19:10:00Z') });
      await store.createOrder({ ...giftOrder(slug, 'm4-list-gift-000000001'), createdAt: new Date('2026-10-14T19:01:00Z') });
      await store.markOrderPaid('m4-list-print-00000001', { sessionId: 'cs_p', at: new Date() });
      await store.markOrderPaid('m4-list-gift-000000001', { sessionId: 'cs_g', at: new Date() });
      assert.deepEqual((await store.listOrders(slug)).map((o) => o.id), ['m4-list-gift-000000001', 'm4-list-print-00000001']);
      assert.deepEqual(await store.listOrders('no-such-slug-000000'), []);
    });

    // The claim tests each get an empty store: paid gifts left by the tests above would be due too.
    test('claimDueGifts claims paid, due, unsent gifts once; a stale claim can be taken again', async () => {
      const store = await makeStore();
      const slug = 'm4-claim-gifts-slug-001';
      await store.createPet(record({ slug }));
      const deliverAt = new Date('2026-10-20T04:00:00Z');
      for (const id of ['m4-claim-due-000000001', 'm4-claim-unpaid-000001', 'm4-claim-later-0000001']) {
        await store.createOrder({ ...giftOrder(slug, id), deliverAt: id.includes('later') ? new Date('2026-10-25T04:00:00Z') : deliverAt });
      }
      await store.createOrder(printOrder(slug, 'm4-claim-print-0000001'));
      for (const id of ['m4-claim-due-000000001', 'm4-claim-later-0000001', 'm4-claim-print-0000001']) {
        await store.markOrderPaid(id, { sessionId: `cs_${id}`, at: new Date('2026-10-14T19:05:00Z') });
      }

      const lease = 15 * 60 * 1000;
      const claim = (at) => store.claimDueGifts(new Date(at), { staleBefore: new Date(new Date(at).getTime() - lease) });
      assert.deepEqual(await claim('2026-10-20T03:59:59.999Z'), [], 'not due yet');
      const claimed = await claim('2026-10-20T14:00:00Z');
      assert.deepEqual(claimed.map((o) => o.id), ['m4-claim-due-000000001'], 'only the paid gift that is due');
      assert.equal(claimed[0].claimedAt.toISOString(), '2026-10-20T14:00:00.000Z');
      assert.deepEqual(claimed[0].details, giftOrder(slug, 'x').details);
      assert.deepEqual(await claim('2026-10-20T14:10:00Z'), [], 'claimed by the first run');
      assert.deepEqual((await claim('2026-10-20T14:15:01Z')).map((o) => o.id), ['m4-claim-due-000000001'], 'stale claim, taken again');
    });

    test('a released gift can be claimed again; a sent or cancelled one never', async () => {
      const store = await makeStore();
      const slug = 'm4-finish-gifts-slug-01';
      await store.createPet(record({ slug }));
      for (const id of ['m4-finish-release-0001', 'm4-finish-sent-000001', 'm4-finish-cancel-00001']) {
        await store.createOrder(giftOrder(slug, id));
        await store.markOrderPaid(id, { sessionId: `cs_${id}`, at: new Date('2026-10-14T19:05:00Z') });
      }
      const at = new Date('2026-10-20T14:00:00Z');
      const options = { staleBefore: new Date(at.getTime() - 15 * 60 * 1000) };
      assert.equal((await store.claimDueGifts(at, options)).length, 3);
      await store.releaseGift('m4-finish-release-0001');
      assert.equal(await store.markGiftSent('m4-finish-sent-000001', at), true);
      assert.equal(await store.cancelGift('m4-finish-cancel-00001', at), true);
      assert.deepEqual((await store.claimDueGifts(at, options)).map((o) => o.id), ['m4-finish-release-0001']);
      const later = new Date('2026-10-21T14:00:00Z');
      await store.releaseGift('m4-finish-release-0001');
      assert.deepEqual((await store.claimDueGifts(later, { staleBefore: later })).map((o) => o.id), ['m4-finish-release-0001']);
      assert.equal((await store.getOrder('m4-finish-sent-000001')).sentAt.toISOString(), at.toISOString());
      assert.equal((await store.getOrder('m4-finish-cancel-00001')).cancelledAt.toISOString(), at.toISOString());
      assert.equal(await store.markGiftSent('m4-finish-sent-000001', later), false, 'already sent');
    });

    test('claimDueGifts can be limited to one order', async () => {
      const store = await makeStore();
      const slug = 'm4-claim-one-slug-00001';
      await store.createPet(record({ slug }));
      for (const id of ['m4-claim-one-a-0000001', 'm4-claim-one-b-0000001']) {
        await store.createOrder(giftOrder(slug, id));
        await store.markOrderPaid(id, { sessionId: `cs_${id}`, at: new Date() });
      }
      const at = new Date('2026-10-20T14:00:00Z');
      const claimed = await store.claimDueGifts(at, { staleBefore: at, id: 'm4-claim-one-b-0000001' });
      assert.deepEqual(claimed.map((o) => o.id), ['m4-claim-one-b-0000001']);
    });

    test('setPrintOrder records the first print-on-demand order only', async () => {
      const slug = 'm4-set-print-slug-00001';
      await store.createPet(record({ slug }));
      await store.createOrder(printOrder(slug, 'm4-set-print-000000001'));
      assert.equal(await store.setPrintOrder('m4-set-print-000000001', 'ord_1'), true);
      assert.equal(await store.setPrintOrder('m4-set-print-000000001', 'ord_2'), false);
      assert.equal((await store.getOrder('m4-set-print-000000001')).podOrderId, 'ord_1');
    });

    test("expirePhotos also erases orders' personal details past the cutoff, keeping the money facts", async () => {
      const slug = 'm4-expire-orders-slug01';
      await store.createPet(record({ slug, createdAt: new Date() }));
      const now = new Date(Math.floor(Date.now() / 1000) * 1000);
      const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      await store.createOrder({ ...printOrder(slug, 'm4-expire-old-order-01'), createdAt: new Date(cutoff.getTime() - 1000) });
      await store.createOrder({ ...printOrder(slug, 'm4-expire-new-order-01'), createdAt: now });
      await store.markOrderPaid('m4-expire-old-order-01', { sessionId: 'cs_old', at: cutoff });
      await store.expirePhotos(cutoff, now);
      const old = await store.getOrder('m4-expire-old-order-01');
      assert.equal(old.details, null);
      assert.equal(old.amountCents, 2900);
      assert.ok(old.paidAt);
      assert.deepEqual((await store.getOrder('m4-expire-new-order-01')).details, ADDRESS);
    });
  });
}

const ADDRESS = { name: 'Jamie Rivera', line1: '742 Evergreen Terrace', line2: '', city: 'Portland', state: 'OR', zip: '97201', country: 'US' };

function giftOrder(slug, id) {
  return {
    id,
    slug,
    kind: 'gift',
    amountCents: 900,
    details: {
      recipientName: 'Jamie',
      recipientEmail: 'jamie@example.com',
      fromName: 'Sam',
      message: "Biscuit's secret is out",
      deliverOn: '2026-10-20',
      timeZone: 'America/New_York',
    },
    origin: 'https://alterpaw.example',
    createdAt: new Date('2026-10-14T19:00:00Z'),
    deliverAt: new Date('2026-10-20T04:00:00Z'),
  };
}

function printOrder(slug, id) {
  return {
    id,
    slug,
    kind: 'print',
    amountCents: 2900,
    details: { ...ADDRESS },
    origin: 'https://alterpaw.example',
    createdAt: new Date('2026-10-14T19:00:00Z'),
    deliverAt: null,
  };
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

// Each call is its own database (the M4 claim tests ask for empty ones); all are closed at the end.
const databases = [];
contract('postgres (PGlite)', async () => {
  const db = new PGlite();
  databases.push(db);
  return new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
});

describe('PgStore specifics', () => {
  after(async () => {
    await Promise.all(databases.map((db) => db.close()));
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

  // M1's schema and one M1 row, verbatim.
  const M1_DATABASE = `
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
  `;

  // Reads, reports and deletes the M1 row through the M2 store: every M2 column and constraint is in place.
  async function assertUpgraded(db, label) {
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    const pet = await store.getPet('m1-era-record-slug-0001');
    assert.equal(pet.reports, 0, label);
    assert.equal(pet.expiredAt, null, label);
    assert.deepEqual(await store.reportPet('m1-era-record-slug-0001', { reporter: 'dddddd', reason: 'other', at: new Date() }), {
      reports: 1,
      added: true,
    });
    assert.equal(await store.expirePhotos(new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z')), 1, label);
    assert.equal(await store.getPhoto('m1-era-record-slug-0001'), null, label);
    await assertPaymentColumns(store, 'm1-era-record-slug-0001', label);
  }

  // The M3 columns are there: the record starts unpaid and can be paid for and rewritten once.
  async function assertPaymentColumns(store, slug, label) {
    const pet = await store.getPet(slug);
    assert.equal(pet.paidAt, null, label);
    assert.equal(pet.regeneratedAt, null, label);
    assert.deepEqual(await store.markPaid(slug, { sessionId: 'cs_upgrade', at: new Date() }), { changed: true, sessionId: 'cs_upgrade' }, label);
    assert.equal(await store.saveRegenerated(slug, validCharacter(), new Date()), true, label);
  }

  // M2's schema (as M2 created it) and one M2 row.
  const M2_DATABASE = `
    CREATE TABLE pets (
      slug          text PRIMARY KEY,
      name          text NOT NULL,
      species       text NOT NULL,
      traits        jsonb NOT NULL,
      alter_ego     text NOT NULL,
      character     jsonb NOT NULL,
      photo         bytea,
      photo_type    text NOT NULL,
      created_at    timestamptz NOT NULL DEFAULT now(),
      report_count  integer NOT NULL DEFAULT 0,
      expired_at    timestamptz
    );
    CREATE TABLE reports (
      slug        text NOT NULL REFERENCES pets (slug) ON DELETE CASCADE,
      reporter    text NOT NULL,
      reason      text NOT NULL,
      created_at  timestamptz NOT NULL,
      PRIMARY KEY (slug, reporter)
    );
    CREATE INDEX pets_unexpired_created_at ON pets (created_at) WHERE expired_at IS NULL;
    INSERT INTO pets (slug, name, species, traits, alter_ego, character, photo, photo_type, created_at, report_count)
    VALUES ('m2-era-record-slug-0001', 'Biscuit', 'dog', '["greedy"]', 'crime-boss', '{"alias":"x"}',
            '\\xffd8ff', 'image/jpeg', '2026-09-20T00:00:00Z', 1);
  `;

  test('upgrades a database created by M2 (no payment or rewrite columns), keeping its reports', async () => {
    const db = new PGlite();
    await db.exec(M2_DATABASE);
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    assert.equal((await store.getPet('m2-era-record-slug-0001')).reports, 1);
    await assertPaymentColumns(store, 'm2-era-record-slug-0001', 'M2 database');
    await db.close();
  });

  test('also repairs a database with only some of the M3 columns', async () => {
    for (const ddl of ['ALTER TABLE pets ADD COLUMN paid_at timestamptz', 'ALTER TABLE pets ADD COLUMN regenerated_at timestamptz']) {
      const db = new PGlite();
      await db.exec(M2_DATABASE);
      await db.exec(ddl);
      const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
      await assertPaymentColumns(store, 'm2-era-record-slug-0001', ddl);
      await db.close();
    }
  });

  // As with reports: interleaved on PGlite; the single conditional UPDATE is what makes it safe on a server.
  test('interleaved payments and rewrites: exactly one of each wins', async () => {
    const db = new PGlite();
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    await store.createPet(record({ slug: 'parallel-paid-slug-0001' }));
    const at = new Date();
    const paid = await Promise.all(['cs_a', 'cs_b', 'cs_c'].map((sessionId) => store.markPaid('parallel-paid-slug-0001', { sessionId, at })));
    assert.equal(paid.filter((r) => r.changed).length, 1);
    assert.equal(new Set(paid.map((r) => r.sessionId)).size, 1, 'everyone sees the winning session');
    const saved = await Promise.all([1, 2, 3].map((i) => store.saveRegenerated('parallel-paid-slug-0001', validCharacter({ alias: `Try ${i}` }), at)));
    assert.equal(saved.filter(Boolean).length, 1);
    await db.close();
  });

  // M4. As above, interleaved: the FOR UPDATE SKIP LOCKED claim is what keeps two real runs apart.
  test('interleaved gift claims: every due gift goes to exactly one run', async () => {
    const db = new PGlite();
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    await store.createPet(record({ slug: 'parallel-claim-slug-001' }));
    for (let i = 0; i < 5; i++) {
      const id = `parallel-claim-order-${String(i).padStart(2, '0')}`;
      await store.createOrder({
        ...giftOrder('parallel-claim-slug-001', id),
      });
      await store.markOrderPaid(id, { sessionId: `cs_${i}`, at: new Date() });
    }
    const at = new Date('2026-10-20T14:00:00Z');
    const runs = await Promise.all([1, 2, 3].map(() => store.claimDueGifts(at, { staleBefore: new Date(at.getTime() - 900_000), limit: 2 })));
    const ids = runs.flat().map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length, 'no gift claimed twice');
    assert.ok(runs.every((r) => r.length <= 2), 'each run takes at most its limit');
    const rest = await store.claimDueGifts(at, { staleBefore: new Date(at.getTime() - 900_000) });
    assert.equal(ids.length + rest.length, 5, 'and none is lost');
    await db.close();
  });

  test('upgrades a database created by M3 (no orders table) in place', async () => {
    const db = new PGlite();
    await db.exec(M2_DATABASE);
    await db.exec('ALTER TABLE pets ADD COLUMN paid_at timestamptz, ADD COLUMN stripe_session text, ADD COLUMN regenerated_at timestamptz');
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    await store.createOrder(giftOrder('m2-era-record-slug-0001', 'm3-era-gift-order-00001'));
    assert.equal((await store.getOrder('m3-era-gift-order-00001')).kind, 'gift');
    assert.equal((await store.getPet('m2-era-record-slug-0001')).reports, 1);
    await db.close();
  });

  test('an order for an unknown preview is refused (foreign key)', async () => {
    const db = new PGlite();
    const store = new PgStore((text, params) => db.query(text, params).then((r) => r.rows));
    await assert.rejects(store.createOrder(giftOrder('no-such-slug-000000000', 'orphan-order-0000000001')));
    await db.close();
  });

  test('upgrades a database created by M1 (photo NOT NULL, no report or expiry columns)', async () => {
    const db = new PGlite();
    await db.exec(M1_DATABASE);
    await assertUpgraded(db, 'M1 database');
    await db.close();
  });

  test('also repairs a half-upgraded database (one M2 column missing, or photo still NOT NULL)', async () => {
    const halfway = [
      'ALTER TABLE pets ADD COLUMN expired_at timestamptz',
      'ALTER TABLE pets ADD COLUMN report_count integer NOT NULL DEFAULT 0',
      'ALTER TABLE pets ADD COLUMN expired_at timestamptz, ADD COLUMN report_count integer NOT NULL DEFAULT 0',
    ];
    for (const ddl of halfway) {
      const db = new PGlite();
      await db.exec(M1_DATABASE);
      await db.exec(ddl);
      await assertUpgraded(db, ddl);
      await db.close();
    }
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
