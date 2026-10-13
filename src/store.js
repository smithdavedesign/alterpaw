// Storage for generated previews. Two implementations of one contract:
//   MemoryStore — tests and local dev without a database
//   PgStore     — Postgres (Neon free tier in production); one row per preview, photo as bytea
//
// Record: { slug, name, species, traits[], alterEgo, character{}, photo: Uint8Array, photoType, createdAt }
// getPet(slug)        → the record without the photo, plus { reports, expiredAt }, or null
// getPhoto(slug)      → { bytes, type }, or null (unknown slug, or the photo was deleted)
// reportPet(slug, { reporter, reason, at }) → { reports, added }: distinct reporters so far, and whether this
//                       call added one (false for a repeat). null for an unknown slug. `reporter` is an
//                       opaque key (app.js hashes it); one report per reporter per preview.
// expirePhotos(cutoff, now) → how many photos created before `cutoff` were deleted. The text stays (the
//                       preview shows "expired"), expiredAt is set to `now`, and report rows older than
//                       `cutoff` go too.
// Policy (how many reports hide a preview, how old is too old) lives in app.js, not here.

const clone = (value) => structuredClone(value);

export class MemoryStore {
  constructor() {
    this.records = new Map();
    this.reports = new Map(); // slug → Map(reporter → { reason, createdAt })
  }

  async createPet(record) {
    if (this.records.has(record.slug)) throw new Error('duplicate slug');
    this.records.set(record.slug, {
      ...clone(record),
      createdAt: record.createdAt ?? new Date(),
      reports: 0,
      expiredAt: null,
    });
  }

  async getPet(slug) {
    const record = this.records.get(slug);
    if (!record) return null;
    const { photo, ...pet } = record;
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
    return deleted;
  }
}

// One statement, so a cold start costs one round trip and the whole schema appears atomically (two
// instances racing on it is handled below). The M1 → M2 upgrade only ALTERs when a column is missing, so
// a warm database never takes the table lock.
const SCHEMA = `
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS pets (
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
  -- Created by M1: add the M2 columns and let the deletion job clear photos.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'pets' AND column_name = 'expired_at'
  ) THEN
    ALTER TABLE pets
      ADD COLUMN IF NOT EXISTS report_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS expired_at timestamptz,
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
END
$$`;

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
      `SELECT slug, name, species, traits, alter_ego, character, photo_type, created_at, report_count, expired_at
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
       )
       SELECT (SELECT count(*) FROM expired)::int AS deleted`,
      [new Date(cutoff).toISOString(), new Date(now).toISOString()],
    );
    return Number(rows[0]?.deleted ?? 0);
  }
}
