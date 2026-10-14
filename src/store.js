// Storage for generated previews. Two implementations of one contract:
//   MemoryStore — tests and local dev without a database
//   PgStore     — Postgres (Neon free tier in production); one row per preview, photo as bytea
//
// Record: { slug, name, species, traits[], alterEgo, character{}, photo: Uint8Array, photoType, createdAt }
// getPet(slug)        → the record without the photo, plus { reports, expiredAt, paidAt, regeneratedAt }, or null
// getPhoto(slug)      → { bytes, type }, or null (unknown slug, or the photo was deleted)
// reportPet(slug, { reporter, reason, at }) → { reports, added }: distinct reporters so far, and whether this
//                       call added one (false for a repeat). null for an unknown slug. `reporter` is an
//                       opaque key (app.js hashes it); one report per reporter per preview.
// expirePhotos(cutoff, now) → how many photos created before `cutoff` were deleted. The text stays (the
//                       preview shows "expired"), expiredAt is set to `now`, and report rows older than
//                       `cutoff` go too.
// markPaid(slug, { sessionId, at }) → { changed, sessionId }: the first call records the payment; any later
//                       one (a repeated webhook, or a second session) changes nothing, and `sessionId` is
//                       always the recorded one. null for an unknown slug.
// saveRegenerated(slug, character, at) → true if the new text was stored: only for a paid preview whose one
//                       rewrite is unused, checked and set in one step.
//
// Orders (M4): one row per gift or printed-poster purchase.
//   Order: { id, slug, kind: 'gift' | 'print', amountCents, details{}, origin, createdAt, deliverAt (gifts) }
// createOrder(order)   → stores it unpaid; a duplicate id or an unknown slug is rejected
// getOrder(id)         → the order plus { paidAt, claimedAt, sentAt, cancelledAt, podOrderId }, or null
// markOrderPaid(id, { sessionId, at }) → { changed, sessionId } like markPaid; null for an unknown id
// listOrders(slug)     → the preview's paid orders, oldest first
// claimDueGifts(at, { staleBefore, limit, id? }) → paid, unsent, uncancelled gifts due by `at` whose claim is
//                        empty or older than `staleBefore`, now claimed at `at` (each by one caller only)
// markGiftSent(id, at) / cancelGift(id, at) → true if this call settled the gift; releaseGift(id) drops a claim
// setPrintOrder(id, podOrderId) → true if this call recorded the print-on-demand order (the first one wins)
// expirePhotos also erases `details` (recipient, message, address) of orders created before the cutoff.
// Policy (how many reports hide a preview, how old is too old, what paid unlocks, when a gift is due) lives in
// app.js, not here.

const clone = (value) => structuredClone(value);

export class MemoryStore {
  constructor() {
    this.records = new Map();
    this.reports = new Map(); // slug → Map(reporter → { reason, createdAt })
    this.orders = new Map(); // id → order
  }

  async createPet(record) {
    if (this.records.has(record.slug)) throw new Error('duplicate slug');
    this.records.set(record.slug, {
      ...clone(record),
      createdAt: record.createdAt ?? new Date(),
      reports: 0,
      expiredAt: null,
      paidAt: null,
      stripeSession: null,
      regeneratedAt: null,
    });
  }

  async getPet(slug) {
    const record = this.records.get(slug);
    if (!record) return null;
    const { photo, stripeSession, ...pet } = record;
    return clone(pet);
  }

  async getPhoto(slug) {
    const record = this.records.get(slug);
    return record?.photo ? { bytes: new Uint8Array(record.photo), type: record.photoType } : null;
  }

  async reportPet(slug, { reporter, reason, at }) {
    const record = this.records.get(slug);
    if (!record) return null;
    if (!this.reports.has(slug)) this.reports.set(slug, new Map());
    const reporters = this.reports.get(slug);
    const added = !reporters.has(reporter);
    if (added) {
      reporters.set(reporter, { reason, createdAt: new Date(at) });
      record.reports += 1;
    }
    return { reports: record.reports, added };
  }

  async expirePhotos(cutoff, now) {
    let deleted = 0;
    for (const record of this.records.values()) {
      if (record.createdAt < cutoff && !record.expiredAt) {
        record.photo = null;
        record.expiredAt = new Date(now);
        deleted += 1;
      }
    }
    for (const reporters of this.reports.values()) {
      for (const [reporter, report] of reporters) if (report.createdAt < cutoff) reporters.delete(reporter);
    }
    for (const order of this.orders.values()) if (order.createdAt < cutoff) order.details = null;
    return deleted;
  }

  async markPaid(slug, { sessionId, at }) {
    const record = this.records.get(slug);
    if (!record) return null;
    const changed = !record.paidAt;
    if (changed) {
      record.paidAt = new Date(at);
      record.stripeSession = sessionId;
    }
    return { changed, sessionId: record.stripeSession };
  }

  async saveRegenerated(slug, character, at) {
    const record = this.records.get(slug);
    if (!record?.paidAt || record.regeneratedAt) return false;
    record.character = clone(character);
    record.regeneratedAt = new Date(at);
    return true;
  }

  // M4: orders.
  async createOrder(order) {
    if (this.orders.has(order.id)) throw new Error('duplicate order id');
    if (!this.records.has(order.slug)) throw new Error('order for an unknown preview');
    this.orders.set(order.id, {
      id: order.id,
      slug: order.slug,
      kind: order.kind,
      amountCents: order.amountCents,
      details: clone(order.details),
      origin: order.origin,
      createdAt: new Date(order.createdAt),
      deliverAt: order.deliverAt ? new Date(order.deliverAt) : null,
      paidAt: null,
      stripeSession: null,
      claimedAt: null,
      sentAt: null,
      cancelledAt: null,
      podOrderId: null,
    });
  }

  async getOrder(id) {
    const order = this.orders.get(id);
    if (!order) return null;
    const { stripeSession, ...rest } = order;
    return clone(rest);
  }

  async markOrderPaid(id, { sessionId, at }) {
    const order = this.orders.get(id);
    if (!order) return null;
    const changed = !order.paidAt;
    if (changed) {
      order.paidAt = new Date(at);
      order.stripeSession = sessionId;
    }
    return { changed, sessionId: order.stripeSession };
  }

  async listOrders(slug) {
    const paid = [...this.orders.values()].filter((o) => o.slug === slug && o.paidAt);
    paid.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return Promise.all(paid.map((o) => this.getOrder(o.id)));
  }

  async claimDueGifts(at, { staleBefore, limit = 50, id = null }) {
    const due = [...this.orders.values()]
      .filter(
        (o) =>
          o.kind === 'gift' &&
          o.paidAt &&
          !o.sentAt &&
          !o.cancelledAt &&
          o.deliverAt <= at &&
          (!o.claimedAt || o.claimedAt < staleBefore) &&
          (id === null || o.id === id),
      )
      .sort((a, b) => a.deliverAt - b.deliverAt || a.id.localeCompare(b.id))
      .slice(0, limit);
    for (const order of due) order.claimedAt = new Date(at);
    return Promise.all(due.map((o) => this.getOrder(o.id)));
  }

  async markGiftSent(id, at) {
    const order = this.orders.get(id);
    if (!order || order.sentAt) return false;
    order.sentAt = new Date(at);
    return true;
  }

  async cancelGift(id, at) {
    const order = this.orders.get(id);
    if (!order || order.sentAt || order.cancelledAt) return false;
    order.cancelledAt = new Date(at);
    return true;
  }

  async releaseGift(id) {
    const order = this.orders.get(id);
    if (!order || order.sentAt) return false;
    order.claimedAt = null;
    return true;
  }

  async setPrintOrder(id, podOrderId) {
    const order = this.orders.get(id);
    if (!order || order.podOrderId) return false;
    order.podOrderId = podOrderId;
    return true;
  }
}

// One statement, so a cold start costs one round trip and the whole schema appears atomically (two
// instances racing on it is handled below). The upgrade from an M1 or M2 database only ALTERs when part of
// it is missing (any later column, or photo still NOT NULL), so a warm database never takes the table
// lock, and a half-upgraded one (manual DDL, an early dev build) is still repaired.
const SCHEMA = `
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS pets (
    slug            text PRIMARY KEY,
    name            text NOT NULL,
    species         text NOT NULL,
    traits          jsonb NOT NULL,
    alter_ego       text NOT NULL,
    character       jsonb NOT NULL,
    photo           bytea,
    photo_type      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    report_count    integer NOT NULL DEFAULT 0,
    expired_at      timestamptz,
    paid_at         timestamptz,
    stripe_session  text,
    regenerated_at  timestamptz
  );
  -- Created by M1 or M2: add the M2 and M3 columns and let the deletion job clear photos.
  IF (
    SELECT count(*) FILTER (
             WHERE column_name IN ('report_count', 'expired_at', 'paid_at', 'stripe_session', 'regenerated_at')
           ) < 5
        OR bool_or(column_name = 'photo' AND is_nullable = 'NO')
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'pets'
  ) THEN
    ALTER TABLE pets
      ADD COLUMN IF NOT EXISTS report_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS expired_at timestamptz,
      ADD COLUMN IF NOT EXISTS paid_at timestamptz,
      ADD COLUMN IF NOT EXISTS stripe_session text,
      ADD COLUMN IF NOT EXISTS regenerated_at timestamptz,
      ALTER COLUMN photo DROP NOT NULL;
  END IF;
  CREATE TABLE IF NOT EXISTS reports (
    slug        text NOT NULL REFERENCES pets (slug) ON DELETE CASCADE,
    reporter    text NOT NULL,
    reason      text NOT NULL,
    created_at  timestamptz NOT NULL,
    PRIMARY KEY (slug, reporter)
  );
  -- The daily job looks only at photos not yet deleted.
  IF to_regclass('pets_unexpired_created_at') IS NULL THEN
    CREATE INDEX IF NOT EXISTS pets_unexpired_created_at ON pets (created_at) WHERE expired_at IS NULL;
  END IF;
  -- M4: gifts and printed posters. details holds the personal data and is erased with the photo.
  CREATE TABLE IF NOT EXISTS orders (
    id              text PRIMARY KEY,
    slug            text NOT NULL REFERENCES pets (slug) ON DELETE CASCADE,
    kind            text NOT NULL CHECK (kind IN ('gift', 'print')),
    amount_cents    integer NOT NULL,
    details         jsonb,
    origin          text NOT NULL,
    created_at      timestamptz NOT NULL,
    deliver_at      timestamptz,
    paid_at         timestamptz,
    stripe_session  text,
    claimed_at      timestamptz,
    sent_at         timestamptz,
    cancelled_at    timestamptz,
    pod_order_id    text
  );
  IF to_regclass('orders_slug') IS NULL THEN
    CREATE INDEX IF NOT EXISTS orders_slug ON orders (slug);
  END IF;
  -- The gift job looks only at gifts not yet settled.
  IF to_regclass('orders_gifts_due') IS NULL THEN
    CREATE INDEX IF NOT EXISTS orders_gifts_due ON orders (deliver_at)
      WHERE kind = 'gift' AND sent_at IS NULL AND cancelled_at IS NULL;
  END IF;
END
$$`;

const ORDER_COLUMNS = `id, slug, kind, amount_cents, details, origin, created_at, deliver_at, paid_at, claimed_at, sent_at,
  cancelled_at, pod_order_id`;
const dateOrNull = (value) => (value ? new Date(value) : null);
const isoOrNull = (value) => (value ? new Date(value).toISOString() : null);

const SCHEMA_RACE_CODES = new Set(['23505', '42P07']);

// Drivers differ: some parse jsonb, some hand back the string.
const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

function toBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text) {
  // Postgres wraps encode(…, 'base64') output every 76 characters.
  const binary = atob(text.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class PgStore {
  // query(text, params) → Promise<rows[]>. Every query is parameterised; nothing is interpolated.
  // The photo travels as base64 text so bytea works the same over HTTP (Neon), TCP (pg) and PGlite.
  constructor(query) {
    this.query = query;
    this.ready = null;
  }

  // Run once per instance. Two cold starts racing on CREATE TABLE IF NOT EXISTS can make the loser fail
  // with unique_violation (on pg_type) or duplicate_table; the table exists either way, so that's success.
  // Any other failure is retried on the next call.
  async #schema() {
    this.ready ??= this.query(SCHEMA, []).catch((err) => {
      if (SCHEMA_RACE_CODES.has(err?.code)) return;
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  // created_at comes from the app's clock (the same one the deletion cutoff uses), or now() if absent.
  async createPet(record) {
    await this.#schema();
    await this.query(
      `INSERT INTO pets (slug, name, species, traits, alter_ego, character, photo, photo_type, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, decode($7, 'base64'), $8, COALESCE($9::timestamptz, now()))`,
      [
        record.slug,
        record.name,
        record.species,
        JSON.stringify(record.traits),
        record.alterEgo,
        JSON.stringify(record.character),
        toBase64(record.photo),
        record.photoType,
        record.createdAt ? new Date(record.createdAt).toISOString() : null,
      ],
    );
  }

  async getPet(slug) {
    await this.#schema();
    const rows = await this.query(
      `SELECT slug, name, species, traits, alter_ego, character, photo_type, created_at, report_count, expired_at,
              paid_at, regenerated_at
       FROM pets WHERE slug = $1`,
      [slug],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      slug: row.slug,
      name: row.name,
      species: row.species,
      traits: json(row.traits),
      alterEgo: row.alter_ego,
      character: json(row.character),
      photoType: row.photo_type,
      createdAt: new Date(row.created_at),
      reports: Number(row.report_count),
      expiredAt: row.expired_at ? new Date(row.expired_at) : null,
      paidAt: row.paid_at ? new Date(row.paid_at) : null,
      regeneratedAt: row.regenerated_at ? new Date(row.regenerated_at) : null,
    };
  }

  async getPhoto(slug) {
    await this.#schema();
    const rows = await this.query(`SELECT encode(photo, 'base64') AS photo, photo_type FROM pets WHERE slug = $1`, [slug]);
    const row = rows[0];
    return row?.photo ? { bytes: fromBase64(row.photo), type: row.photo_type } : null;
  }

  // One statement: the primary key makes a repeat report a no-op, and the count is bumped under the row
  // lock, so concurrent reports neither double-count nor get lost. No row back means an unknown slug.
  async reportPet(slug, { reporter, reason, at }) {
    await this.#schema();
    const rows = await this.query(
      `WITH added AS (
         INSERT INTO reports (slug, reporter, reason, created_at)
         SELECT slug, $2, $3, $4::timestamptz FROM pets WHERE slug = $1
         ON CONFLICT (slug, reporter) DO NOTHING
         RETURNING 1
       )
       UPDATE pets SET report_count = report_count + (SELECT count(*) FROM added)
       WHERE slug = $1
       RETURNING report_count, (SELECT count(*) FROM added)::int AS added`,
      [slug, reporter, reason, new Date(at).toISOString()],
    );
    return rows[0] ? { reports: Number(rows[0].report_count), added: Number(rows[0].added) > 0 } : null;
  }

  async expirePhotos(cutoff, now) {
    await this.#schema();
    const rows = await this.query(
      `WITH expired AS (
         UPDATE pets SET photo = NULL, expired_at = $2::timestamptz
         WHERE created_at < $1::timestamptz AND expired_at IS NULL
         RETURNING 1
       ), old_reports AS (
         DELETE FROM reports WHERE created_at < $1::timestamptz
         RETURNING 1
       ), erased_orders AS (
         UPDATE orders SET details = NULL WHERE created_at < $1::timestamptz AND details IS NOT NULL
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM expired)::int AS deleted`,
      [new Date(cutoff).toISOString(), new Date(now).toISOString()],
    );
    return Number(rows[0]?.deleted ?? 0);
  }

  // `paid_at IS NULL` is rechecked under the row lock, so of two concurrent deliveries exactly one records
  // the payment. Only when nothing changed is the recorded session read back, in a second statement: it
  // sees the winner's commit, which a SELECT in the same statement (same snapshot) would not.
  async markPaid(slug, { sessionId, at }) {
    await this.#schema();
    const paid = await this.query(
      `UPDATE pets SET paid_at = $2::timestamptz, stripe_session = $3
       WHERE slug = $1 AND paid_at IS NULL
       RETURNING stripe_session`,
      [slug, new Date(at).toISOString(), sessionId],
    );
    if (paid[0]) return { changed: true, sessionId: paid[0].stripe_session };
    const rows = await this.query(`SELECT stripe_session FROM pets WHERE slug = $1`, [slug]);
    return rows[0] ? { changed: false, sessionId: rows[0].stripe_session } : null;
  }

  // Check and set in one conditional UPDATE: of two concurrent rewrites exactly one is stored.
  async saveRegenerated(slug, character, at) {
    await this.#schema();
    const rows = await this.query(
      `UPDATE pets SET character = $2::jsonb, regenerated_at = $3::timestamptz
       WHERE slug = $1 AND paid_at IS NOT NULL AND regenerated_at IS NULL
       RETURNING 1 AS saved`,
      [slug, JSON.stringify(character), new Date(at).toISOString()],
    );
    return rows.length > 0;
  }

  // M4: orders. Every state change is one conditional UPDATE, as above.
  async createOrder(order) {
    await this.#schema();
    await this.query(
      `INSERT INTO orders (id, slug, kind, amount_cents, details, origin, created_at, deliver_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::timestamptz, $8::timestamptz)`,
      [
        order.id,
        order.slug,
        order.kind,
        order.amountCents,
        JSON.stringify(order.details),
        order.origin,
        new Date(order.createdAt).toISOString(),
        isoOrNull(order.deliverAt),
      ],
    );
  }

  #order(row) {
    return {
      id: row.id,
      slug: row.slug,
      kind: row.kind,
      amountCents: Number(row.amount_cents),
      details: row.details == null ? null : json(row.details),
      origin: row.origin,
      createdAt: new Date(row.created_at),
      deliverAt: dateOrNull(row.deliver_at),
      paidAt: dateOrNull(row.paid_at),
      claimedAt: dateOrNull(row.claimed_at),
      sentAt: dateOrNull(row.sent_at),
      cancelledAt: dateOrNull(row.cancelled_at),
      podOrderId: row.pod_order_id ?? null,
    };
  }

  async getOrder(id) {
    await this.#schema();
    const rows = await this.query(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [id]);
    return rows[0] ? this.#order(rows[0]) : null;
  }

  // Like markPaid: of concurrent deliveries exactly one records the payment, and the read-back sees it.
  async markOrderPaid(id, { sessionId, at }) {
    await this.#schema();
    const paid = await this.query(
      `UPDATE orders SET paid_at = $2::timestamptz, stripe_session = $3
       WHERE id = $1 AND paid_at IS NULL
       RETURNING stripe_session`,
      [id, new Date(at).toISOString(), sessionId],
    );
    if (paid[0]) return { changed: true, sessionId: paid[0].stripe_session };
    const rows = await this.query(`SELECT stripe_session FROM orders WHERE id = $1`, [id]);
    return rows[0] ? { changed: false, sessionId: rows[0].stripe_session } : null;
  }

  async listOrders(slug) {
    await this.#schema();
    const rows = await this.query(
      `SELECT ${ORDER_COLUMNS} FROM orders WHERE slug = $1 AND paid_at IS NOT NULL ORDER BY created_at, id`,
      [slug],
    );
    return rows.map((row) => this.#order(row));
  }

  // A queue claim: FOR UPDATE SKIP LOCKED gives each due gift to one caller even when two runs overlap, and a
  // claim older than `staleBefore` (a run that died before settling it) can be taken again.
  async claimDueGifts(at, { staleBefore, limit = 50, id = null }) {
    await this.#schema();
    const rows = await this.query(
      `UPDATE orders SET claimed_at = $1::timestamptz
       WHERE id IN (
         SELECT id FROM orders
         WHERE kind = 'gift' AND paid_at IS NOT NULL AND sent_at IS NULL AND cancelled_at IS NULL
           AND deliver_at <= $1::timestamptz
           AND (claimed_at IS NULL OR claimed_at < $2::timestamptz)
           AND ($4::text IS NULL OR id = $4::text)
         ORDER BY deliver_at, id
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       RETURNING ${ORDER_COLUMNS}`,
      [new Date(at).toISOString(), new Date(staleBefore).toISOString(), limit, id],
    );
    return rows.map((row) => this.#order(row)).sort((a, b) => a.deliverAt - b.deliverAt || a.id.localeCompare(b.id));
  }

  async markGiftSent(id, at) {
    await this.#schema();
    const rows = await this.query(`UPDATE orders SET sent_at = $2::timestamptz WHERE id = $1 AND sent_at IS NULL RETURNING 1`, [
      id,
      new Date(at).toISOString(),
    ]);
    return rows.length > 0;
  }

  async cancelGift(id, at) {
    await this.#schema();
    const rows = await this.query(
      `UPDATE orders SET cancelled_at = $2::timestamptz WHERE id = $1 AND sent_at IS NULL AND cancelled_at IS NULL RETURNING 1`,
      [id, new Date(at).toISOString()],
    );
    return rows.length > 0;
  }

  async releaseGift(id) {
    await this.#schema();
    const rows = await this.query(`UPDATE orders SET claimed_at = NULL WHERE id = $1 AND sent_at IS NULL RETURNING 1`, [id]);
    return rows.length > 0;
  }

  async setPrintOrder(id, podOrderId) {
    await this.#schema();
    const rows = await this.query(`UPDATE orders SET pod_order_id = $2 WHERE id = $1 AND pod_order_id IS NULL RETURNING 1`, [id, podOrderId]);
    return rows.length > 0;
  }
}
