# alterpaw — build notes

## Plan

Milestone: **M2 — Share loop** (2 of 4 in this MVP run; M1 is built and its tests stay green). Built
non-interactively: every question the gstack frameworks would ask a person is answered here, with the reason.

### Step 0: Scope challenge (M2)

1. **Existing code.** M1 already provides most of what M2 needs:
   - the preview record, and `getPet`/`getPhoto` (the share image reads the same record and photo);
   - the `SLUG_PATTERN` gate before any lookup, the `/p/*` noindex middleware and the `html` escaping;
   - the DI seams in `createApp` (store, model, logger, slug), which M2 extends with `now`, `renderShare`
     and `cronSecret`, so every new path is testable with no network, no clock and no secret.

   Built-ins reused rather than written:
   - Hono's `csrf()` on `/report` and `timingSafeEqual` (`hono/utils/buffer`) for the cron token **[Layer 1]**;
   - Vercel Cron to trigger the deletion job (free on Hobby, once a day) **[Layer 1]**;
   - satori (layout to SVG; text becomes glyph paths) plus `@resvg/resvg-wasm` (SVG to PNG) for share images
     **[Layer 2]**. That's the standard Vercel OG stack, pure JS/WASM, so it works with install scripts off.
   - Rejected: Playwright (a 100+ MB browser, too big for a serverless function) and `@resvg/resvg-js`
     (a native binary per platform, and no path to Cloudflare later).
2. **Minimum change that meets the exit criteria.**
   - In:
     - `GET /p/<slug>/share.png`: 1080×1350 by default, `?size=story` for 1080×1920. It's the wanted
       poster with the real photo, a "FREE PREVIEW" stamp and "Make your pet's at <host>".
     - On the preview page: two download links, a "Make your pet's" link and a no-JS report form.
     - `POST /report`: one report per person per preview, counted on the record. At 3, the preview, its
       photo and its share images all return 410.
     - `GET /jobs/expire-photos`: Vercel Cron, daily, bearer `CRON_SECRET`. It deletes photos older than
       30 days.
     - An "expired" page (410).
     - Previews older than 30 days are treated as expired even if the job hasn't run yet.
     - A schema migration so a database created by M1 keeps working.
   - Deliberately **not** in M2:
     - Open Graph tags. Link previews would need an absolute URL and a 1.91:1 crop. Easy to add later.
     - A moderation UI. David reviews with one SQL query (see "Operations").
     - Reporter notifications or email: no free email service is wired up yet.
     - Share-count analytics. That's a PRD metric but no exit criterion; noted in "What's left".
     - A rate limit on `/generate` (open since M1; still listed under Review).
     - The paid unlock (M3).
3. **Complexity check.** It touches 8 source files: `share.js` is new; `app`, `store`, `views`, `index` and
   `dev` change; `vercel.json` and `package.json` are config. That's at the smell threshold. There's one
   new service: the share renderer, behind one function, `renderSharePng`. There are no new classes: the
   store contract gains two methods (`reportPet`, `expirePhotos`) on the two existing classes. Each file
   is touched once for one reason, so I'm proceeding without a scope cut. The alternative, a separate
   job runner or image service, would add files, not remove them.
4. **Search check.** Search unavailable, so this relies on in-distribution knowledge only, plus local
   experiments. Things found by actually running the code:
   - satori throws on a photo it can't decode ("Invalid JPEG"), so the renderer retries without the photo
     rather than failing the share.
   - satori defaults to `content-box`, so every node sets `border-box`.
   - The Roboto Slab Latin subset has no `→`.
   - **[EUREKA]** Vercel's file tracer (`@vercel/nft`, run here) follows
     `new URL('../node_modules/…', import.meta.url)` but **not** `createRequire().resolve()`. The usual
     resvg-wasm snippet would deploy without its `.wasm`. The assets use the `new URL` form, and a test
     traces the real entry.
   - Hono's `bearerAuth` rejects tokens outside `[A-Za-z0-9._~+/-]` with a 400. A plain constant-time
     header compare has no such trap.
   - Hono's `csrf()` throws `HTTPException`, which M1's catch-all `onError` would turn into a 500, so
     `onError` now passes HTTP exceptions through.
5. **TODOS cross-reference.** No `TODOS.md`. M1's "What's left" said the `/generate` rate limit was
   "planned for M2". The roadmap's M2 doesn't include it, so it stays open (Review). The 30-day job now
   bounds storage growth from normal use.
6. **Completeness check.** Every new error path gets a test:
   - bad size, unknown and malformed slugs;
   - an undecodable photo, and a renderer failure;
   - a duplicate reporter, a cross-site post, a missing slug, an unknown slug;
   - the job: no secret configured, a wrong token, a second run, a database still on the M1 schema.
7. **Distribution check.** It's still a web service. The new deploy artifact is `vercel.json` (the cron
   entry), which is tested. The nft trace test covers what goes into the function bundle.

### 1. Architecture review (M2)

```
GET /p/:slug ─────────────▶ store.getPet ─▶ status(pet, now)
GET /p/:slug/photo                               │ live    → page / photo / PNG
GET /p/:slug/share.png[?size=story]              │ expired → 410 "expired" page   (expiredAt set, or created ≥ 30 days ago)
                                                 │ removed → 410 "taken down"     (reports ≥ 3)
            share.png (live) ─▶ store.getPhoto ─▶ share.renderSharePng(pet, photo, { size, host })
                                                     satori(tree) → SVG (glyph paths) → resvg-wasm → PNG
                                                     photo undecodable → re-render with a placeholder

POST /report {slug, reason} ─▶ csrf (Origin host = our host, or Sec-Fetch-Site same-origin)
                            ─▶ reporter = sha256(slug + client IP)        (raw IP never stored)
                            ─▶ store.reportPet  INSERT … ON CONFLICT DO NOTHING + count, one statement
                            ─▶ 200 {reports} / thank-you page; 3rd distinct reporter hides the preview

Vercel Cron (daily 04:00 UTC) ─▶ GET /jobs/expire-photos  Authorization: Bearer $CRON_SECRET
                            ─▶ store.expirePhotos(now − 30 days): photo = NULL, expired_at = now
                               and report rows older than 30 days (hashed IPs) are deleted
```

- **Boundaries.**
  - `share.js` owns the share-image layout and rasterising. It's pure apart from loading its fonts and
    wasm once.
  - `app.js` owns the policy constants (`REPORT_LIMIT = 3`, `PHOTO_RETENTION_DAYS = 30`) and the status
    decision, so the store only counts and the views only render.
  - `store.js` gains `reportPet` and `expirePhotos`. `getPet` now also returns `reports` and `expiredAt`.
- **Data.**
  - `pets` gains `report_count` and `expired_at`, and `photo` becomes nullable.
  - A new table, `reports (slug, reporter, reason, created_at, PRIMARY KEY (slug, reporter))`, gives
    one report per person per preview.
  - The migration is idempotent `ALTER … IF NOT EXISTS` / `DROP NOT NULL`, run once per instance like
    M1's `CREATE TABLE`.
  - `createPet` now writes the app's `createdAt`, so the app clock and the job's cutoff agree.
  - A partial index on `created_at WHERE expired_at IS NULL` keeps the daily job cheap.
- **Security.**
  - Share text never becomes markup (satori draws glyphs).
  - `/report` is CSRF-checked; otherwise a hostile page could make each visitor's browser file a report.
  - Reporter identity is a SHA-256 of slug and IP. It isn't linkable across previews and is deleted
    after 30 days.
  - The cron route fails closed (503) when `CRON_SECRET` is unset and compares in constant time.
  - All `/p/*` responses stay noindex. Share PNGs are `private` so no shared cache keeps serving a
    removed preview.
- **Production failure scenarios.**
  - The share render is slow or out of memory: about 0.5 s and ~50 MB per render here. wasm memory is
    freed after each render. A crash returns a 500 page and is logged (tested).
  - A photo resvg can't decode: placeholder, a warning in the logs, still 200 (tested).
  - Fonts or wasm missing from the deploy bundle: caught before deploy by the nft trace test.
  - The cron doesn't run (Hobby crons can fire late in their hour, or the secret is missing): photos past
    30 days are still not served, because expiry is also enforced at read time (tested). The bytes stay
    until the next successful run.
  - A troll files 3 reports alone: they count once (tested).
  - A troll with 3 IPs, or a coordinated group: the preview is hidden until David restores it with
    `UPDATE pets SET report_count = 0 …`. Accepted for an MVP; listed under Review.
  - Hosts that don't set `X-Forwarded-For`: every reporter becomes "unknown", so previews can't be taken
    down there. Vercel sets the header. Documented.

### 3. Test review (M2)

Each M2 exit criterion maps to tests. They are written first, against the routes above.

| Exit criterion | Tests |
|---|---|
| GET /p/<slug>/share.png returns an image of the stated dimensions | `share.test.js`: 1080×1350 by default and 1080×1920 with `?size=story` (PNG signature + IHDR); the real photo's pixels in the image (a real JPEG and a real PNG made at runtime); an undecodable photo still gives the right size; bad `size` → 400; unknown/malformed slug → 404; renderer failure → 500; private, noindex, nosniff headers; tree text (name, alias, charges, "Make your pet's at <host>", "FREE PREVIEW", headline in the story); nft trace includes the wasm and fonts |
| POST /report flags the record; preview 410 after 3 reports | `report.test.js`: 3 distinct reporters → count 1, 2, 3 on the record, preview 200, 200, then 410 (and photo and share.png 410); same person ×3 counts once; JSON and form bodies; thank-you page; cross-site form post → 403; missing/malformed slug → 400; unknown slug → 404; unknown reason → `other`; the report form is on the preview page; raw IP never stored |
| The deletion job removes photos older than 30 days and the preview then shows an "expired" page | `expiry.test.js`: 31-day-old photo deleted and 29-day-old kept (memory store and PGlite); preview 410 with "expired" (noindex), photo and share.png 410; second run deletes 0; no `CRON_SECRET` → 503, wrong/missing token → 401; read-time expiry before the job runs; `vercel.json` schedules the job daily |

Other new code paths covered:
- **Store contract** (memory and PGlite): `reportPet` counts distinct reporters, returns null for an
  unknown slug and keeps the reason; `expirePhotos` removes only old photos, is idempotent and removes old
  report rows; `getPet` returns `reports` and `expiredAt`.
- **Postgres:** parallel reports, upgrading a database created with the M1 schema, and `createdAt`
  round-trips.
- **Wiring:** `depsFromEnv` passes `CRON_SECRET` through, and the unconfigured store fails loudly on the
  new methods too.
- **Views:** share links, the "Make your pet's" link, the report form, and the expired and removed pages
  are all escaped and noindex.

### Step 0: Scope challenge (M1, kept for reference)

1. **Existing code.** The repo held only docs (PRD, roadmap, research, review). Nothing to reuse in-repo. Reused
   built-ins instead of writing our own: Hono's `bodyLimit` (upload cap), `secureHeaders` (CSP and friends) and
   `html` tagged template (auto-escaping) **[Layer 1]**; the Web `Request.formData()` multipart parser that ships
   with Node **[Layer 1]**; Web Crypto for slugs **[Layer 1]**.
2. **Minimum change that meets the exit criteria.**
   - In: upload form (photo, name, species, up to 3 traits with suggestion chips, 6 alter egos);
     `POST /generate` (validate input, one model call, validate output, store, return JSON);
     four HTML/CSS cards (wanted poster, newspaper front page, trading card, bio card) showing the real photo
     under a "PREVIEW" watermark; `GET /p/<slug>` (unguessable 22-char slug, `noindex`);
     `GET /p/<slug>/photo`.
   - Deliberately **not** in M1 (roadmap puts them later, or nothing blocks on them): PNG/PDF rendering and
     share-sized images (M2/M3), "make your pet's" link, report link and 30-day deletion (M2), the non-pet photo
     check (PRD scope, but in no milestone's exit criteria; noted under "What's left"), Stripe, downloads and
     regenerate (M3), gift and print (M4), rate limiting, accounts, analytics.
3. **Complexity check.** Six source files (`app`, `input`, `character`, `store`, `views`, `index`) plus a local
   dev server script. Two "services" sit behind interfaces: the model call (`complete(messages) → text`) and
   storage (`createPet/getPet/getPhoto`). That's the floor for a model call plus persistence, so the check
   doesn't trigger a scope reduction. The client script and CSS live inside `views.js` and are served from
   routes, so the app runs as one function with no static-file setup.
4. **Search check.** Search unavailable, so this relies on in-distribution knowledge only. Choices: Hono over
   Next.js because the same fetch-style app deploys to Vercel (zero-config Hono) now and to Cloudflare Workers
   later. The roadmap wants a commercial-use host before M3 charges money, and Vercel Hobby forbids
   commercial use. Known footguns handled: Vercel's 4.5 MB request-body limit (the browser shrinks photos to
   ≤1600 px JPEG before upload), CSP vs inline styles (stat bars are SVG, not `style=""`), and
   `encode(…,'base64')` line-wrapping in Postgres (whitespace is stripped before decoding).
5. **TODOS cross-reference.** No `TODOS.md`. New deferred work is listed under "What's left".
6. **Completeness check.** Every error path has a test: bad photo, bad fields, model failure, malformed model
   output, store failure, unknown slug. The "model not called on bad input" behaviour is tested because a free
   model's quota is the scarcest resource.
7. **Distribution check.** It's a web service, not a distributed artifact. It deploys through the pipeline's
   Vercel project (`.provision`). There's no CI publish step to add.

### 1. Architecture review (M1)

```
Browser ── GET / ─────────────▶ views.homePage  (form, /upload.js, /styles.css)
   │  upload.js: draw photo to canvas, ≤1600px JPEG (drops EXIF/GPS, stays under Vercel's 4.5 MB)
   └─ POST /generate (multipart) ─▶ bodyLimit(10 MB + 64 KB) ─▶ input.parsePetForm
                                        │  400 on bad photo / fields — model NOT called
                                        ▼
                                  character.generateCharacter ─▶ complete(messages)
                                        │                         OpenAI-compatible /chat/completions
                                        │                         (Gemini free tier by default, or LiteLLM)
                                        │  parse + validate + cap lengths
                                        │  502 on any failure — nothing stored
                                        ▼
                                  store.createPet  (Neon Postgres: one row, photo as bytea)
                                        │  500 if the DB fails
                                        ▼
                                  200 { slug, url, pet, character }
Browser ── GET /p/:slug ───────▶ store.getPet   ─▶ views.previewPage (4 cards, watermark, noindex)
        ── GET /p/:slug/photo ─▶ store.getPhoto ─▶ stored bytes, sniffed type, nosniff
```

- **Boundaries.** `app.js` only routes and maps errors to status codes. `input.js` owns request validation
  and image sniffing. `character.js` owns the alter-ego library, prompt, model client and output validation.
  `store.js` owns SQL. `views.js` owns HTML and is the only place user text meets markup. Dependencies are
  injected (`createApp({ store, complete })`), so tests run with no network, no keys and no database.
- **Data.** One table, `pets`. The photo lives in the same row as `bytea`, so one free Neon database is the
  only infrastructure. `getPet` never selects the photo column. At ~300 KB per resized photo, the 0.5 GB free
  tier holds ~1,500 previews before M2's 30-day deletion job is needed.
- **Security.**
  - All user text and all model text go through Hono's `html` escaping (`& < > " '`) and never into
    `<script>`, `<style>` or URL contexts.
  - CSP: `script-src 'self'; style-src 'self'`, with no inline script or style.
  - Slugs come from 16 random bytes and are checked against `^[A-Za-z0-9_-]{12,64}$` before any DB lookup.
  - `Referrer-Policy: no-referrer`, so capability URLs don't leak.
  - Photo type comes from magic bytes, never from the client's type or filename. SVG is never accepted, and
    photos are served with `nosniff`.
  - SQL is parameterized only.
  - Pet details go to the model as a JSON data block, with an instruction to treat them as data. Model output
    is shape-checked and length-capped before storage, and extra keys are dropped.
- **Production failure scenarios.**
  - Model slow, over quota or down: 30 s timeout, then 502 "try again" with nothing stored (tested).
  - Model returns prose or half the fields: 502, nothing stored (tested).
  - Neon cold start or outage: 500 after one model call is spent (tested). The user retries.
  - Upload over 4.5 MB on Vercel: Vercel returns 413 before our code runs. The browser resize prevents this in
    practice; the 10 MB / 400 rule applies on any host without that limit (tested in-process and over real HTTP).
  - Spam on `/generate`: there's no rate limit in M1. It can burn the free model quota and fill the database.
    Listed under Review.
- **Model choice.** One OpenAI-compatible client. It defaults to Google's Gemini API free tier
  (`gemini-flash-latest`, key from the credential broker as `GOOGLE_API_KEY`). `LLM_BASE_URL` / `LLM_API_KEY` /
  `LLM_MODEL` point it at a LiteLLM proxy or any other free OpenAI-compatible model instead, as the roadmap
  suggests. No `response_format` is sent, because providers disagree on it. The parser accepts a bare or
  fenced JSON object and rejects everything else.

### 3. Test plan (M1)

`node --test` (built in, no test dependencies) plus PGlite (Postgres compiled to WASM) so the real SQL runs in
tests. Each M1 exit criterion maps to tests:

| Exit criterion | Tests |
|---|---|
| POST /generate Biscuit/dog/3 traits/"crime boss" → 200 with alias, rap sheet 3+, 5 stats 1–99, headline, bio | `generate.test.js` "exit criterion 1…" (+ alter-ego id form, prompt carries the inputs, record stored) |
| Invalid JSON or missing field from the model → 502, nothing stored | `generate.test.js` invalid JSON, each required field missing (6 cases), short rap sheet, 4 stats, non-numeric stat, model throws |
| `<script>` trait escaped, not an element | `preview.test.js` escaped text present, no `<script` in the page; model echoing HTML and quotes in the name are escaped too |
| GET /p/<slug> → pet name, photo, 4 cards, `noindex`; slug 12+ chars | `preview.test.js` (4 `data-card`s, 4 photo `<img>`s, 4 watermarks, meta + header noindex, slug format, 50 unique slugs) |
| Upload over 10 MB or a non-image → 400 | `generate.test.js` 10 MB + 1 byte, 12 MB body, text file posing as JPEG, missing photo (model not called in any). `http.test.js` repeats over a real socket |

Other code paths covered:
- **Input:** field validation (name, species, trait count and length, unknown alter ego) and image sniffing
  (JPEG, PNG, WebP and GIF accepted; SVG and plain text rejected).
- **Model output:** normalisation (fences, clamping, rounding, truncation, extra keys dropped).
- **Model client:** URL, auth header, model, non-2xx, non-JSON, empty content, timeout.
- **Stores:** both run one contract (round-trip bytes, unknown slug, photo not selected, injection-shaped slug,
  duplicate slug, copies not references). Postgres also covers lazy schema creation, retry, the cold-start
  race, and jsonb returned as strings.
- **Routes:** photo route, 404 and malformed slugs, read-side DB errors, unexpected POST errors, security
  headers, home page form and assets.
- **Browser upload script** (`client.test.js`, fake DOM): resize to 1600 px, every field posted, redirect on
  success, server error shown, the host's 413 explained, network failure (the browser's own text is never
  shown), undecodable photo refused (the original is never uploaded), no `createImageBitmap`, no photo,
  back/forward-cache reset, trait chips, thumbnail.
- **Wiring:** production setup from env (`depsFromEnv`, including a malformed `DATABASE_URL` that must never
  reach the logs), log redaction, and the local demo writer.
- **Text hygiene:** NUL, lone surrogates and an emoji split by truncation are cleaned before storage. This is
  tested against real Postgres, with a control showing jsonb rejects the raw text. Article paragraphs are kept.

## What the product does now (M1 + M2)

1. `/`: the owner uploads one pet photo and enters a name, a species (dog, cat or other) and up to three traits.
   They can type traits or tap suggestion chips. They pick one of six alter egos: crime boss, corrupt CEO,
   washed-up rock star, celebrity chef, retired spy, reality TV villain.
2. The browser shrinks the photo to ≤1600 px JPEG, which also strips EXIF and GPS data, and posts it to
   `POST /generate`. If the browser can't read the photo, it asks for a JPEG or PNG; it never uploads the
   original.
3. The server validates everything and makes one call to a free model. That call writes the alias, a 3–6 item
   rap sheet, 5 stats (1–99), a front-page headline and article, and a bio. The reply is checked, capped and
   stored with the photo.
4. The owner lands on `/p/<22-char slug>`. It's unlisted and marked `noindex`. It shows four cards built
   around the real photo: a sepia **wanted poster** with the rap sheet and a species reward, a black-and-white
   **newspaper front page** ("The Daily Bark" or "The Purrington Post"), a **trading card** with stat bars,
   and a **character bio card** with traits. Each card is covered by an "alterpaw preview" watermark.
5. **New in M2, the share loop.** Under the cards, two buttons download the wanted poster as a PNG:
   - **Instagram post**, 1080×1350;
   - **Story, Reels or TikTok**, 1080×1920 (adds the front-page headline and more charges).

   Both images contain:
   - the real photo with a red "FREE PREVIEW" rubber stamp;
   - the name, alias, rap sheet and reward;
   - a footer, "alterpaw · Make your pet's at <host>", so every shared image points back to the site.

   Long text is clamped with an ellipsis, so the layout never breaks. A photo the decoder can't read gets
   a "PHOTO ON FILE" frame instead of failing.
6. **"Make your pet's secret life"** is a big link on every preview, and on the expired, taken-down and
   thank-you pages, back to the form.
7. **Report this page** is a small no-JavaScript form at the bottom with four reasons: not a pet,
   offensive, my photo, something else. Each person (client IP, hashed per preview) counts once. At 3
   reports, the preview, its photo and its share images return **410** with a "taken down" page, and the
   log says which slug to review.
8. **30-day deletion.** Once a day, Vercel Cron calls `/jobs/expire-photos`, which deletes every photo older
   than 30 days. The preview then shows **410 "This preview has expired"**. Previews past 30 days count as
   expired at read time too, so a photo is never shown late even if the job hasn't run.

There's still no payment, clean download or regenerate; those are M3.

### API

| Method | Path | Result |
|---|---|---|
| GET | `/` | Upload form |
| POST | `/generate` | multipart: `photo` (file), `name`, `species`, `traits` (1–3, repeated), `alterEgo` (id or label). **200** `{ slug, url, pet, character }` · **400** `{ error }` bad photo or field (model not called) · **502** `{ error }` model failed or returned bad JSON (nothing stored) · **500** `{ error }` storage failed |
| GET | `/p/:slug` | Preview page (noindex, `Cache-Control: private, no-store`) · **404** unknown · **410** expired or taken down |
| GET | `/p/:slug/photo` | The stored photo with its sniffed type · 404 · 410 |
| GET | `/p/:slug/share.png` | Wanted-poster PNG, 1080×1350; `?size=story` gives 1080×1920 · **400** other `size` · 404 · 410. `private, max-age=600`, noindex |
| POST | `/report` | Form or JSON: `slug`, `reason` (`not-a-pet` / `offensive` / `my-photo` / `other`; anything else → `other`). Same-origin only (403 otherwise). **200** thank-you page, or `{ ok, reports }` for JSON · **400** missing or malformed slug or body · **404** unknown slug · **413** body over 8 KB |
| GET | `/jobs/expire-photos` | `Authorization: Bearer $CRON_SECRET`. **200** `{ deleted }` · **401** wrong or missing token · **503** `CRON_SECRET` not set · **500** storage failed |
| GET | `/styles.css`, `/upload.js` | Page assets |

## Run it locally

```sh
npm install
npm test          # 193 tests, no network, no keys, no database
npm run dev       # http://localhost:3000
```

With nothing set, `npm run dev` keeps previews in memory and writes canned demo text, so the whole flow works
offline. To use the real services, export them in your shell first. Never put them in a committed file.

| Variable | Needed for | Default |
|---|---|---|
| `DATABASE_URL` | saving previews (Postgres; Neon free tier in production) | in-memory store in dev; required in production |
| `GOOGLE_API_KEY` | the model (Gemini API free tier) | canned demo text in dev |
| `LLM_BASE_URL` | another OpenAI-compatible endpoint, e.g. a LiteLLM proxy (`http://localhost:4000/v1`) | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `LLM_API_KEY` | key for `LLM_BASE_URL` (takes precedence over `GOOGLE_API_KEY`) | none |
| `LLM_MODEL` | model name | `gemini-flash-latest` |
| `CRON_SECRET` | authorising `GET /jobs/expire-photos` (Vercel Cron sends it as a Bearer token) | unset, so the job answers 503 |
| `PORT` | dev server port | `3000` |

The tables are created on first use, and a database created by M1 is upgraded in place. That's one
idempotent `DO $$ … $$` statement in `src/store.js`.

Trying M2 locally:
- **Share images:** click the two buttons under the cards, or open `/p/<slug>/share.png?size=story`.
  Photos uploaded through the form arrive as real JPEGs, so they show up in the image.
- **Reports:** the dev server has no proxy, so every local report comes from the same "unknown" client and
  counts once. To see the 410, send three reports with different addresses:
  `curl -X POST localhost:3000/report -H 'Origin: http://localhost:3000' -H 'X-Forwarded-For: 192.0.2.1' -d slug=<slug>`
  (then `.2` and `.3`).
- **Deletion job:** start the server with a throwaway `CRON_SECRET` exported in your shell, then call
  `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/jobs/expire-photos`. Fresh previews are
  under 30 days old, so it reports `{"deleted":0}`. The tests cover the 31-day case with a fixed clock.

### Screenshots

`CHROMIUM_PATH=<path to an installed Chromium> npm run screenshots` regenerates the six PNGs at the top of the
README (`docs/screenshots/`). It is separate from `npm test`. What it does, and the choices made:
- **Starts `scripts/dev.js` itself** on a free port and stops it afterwards. There is no build step, so the
  dev server is the production code path (same `createApp`). `DATABASE_URL`, the model variables and
  `CRON_SECRET` are removed from the child's environment, so a screenshot run never touches a real database
  or model, even if the shell has them exported. The text on the cards is the dev server's canned demo writer;
  the README says so.
- **Goes through the real flow** in Chromium (`playwright-core`, `executablePath: CHROMIUM_PATH`, never a
  downloaded browser): it fills the form, uploads a photo through the file input (shrunk by the page's own
  script), submits, waits for the preview, then fetches `share.png`. It does this at 1280×800 and as an iPhone 13.
- **Sample photo:** a cartoon beagle drawn as SVG in the script and rasterised to JPEG by the browser at run
  time. No real pet or person, and no binary fixture in the repo.
- **Share image framing:** the PNG bytes come from the app, but they're shown on a blank page, centred and
  fitted. Chromium's own image viewer pins the image to the left on desktop and lays it out 980px wide on a phone.
  The footer reads `localhost:<port>` because the image prints the requesting host; in production it's the
  real domain.
- **Fonts:** the sandbox Chromium falls back to a monospace face for `system-ui`, so the page text looks
  typewritten. Real phones and desktops use their own system font, so the CSS was left alone.
- **Product changes:** none from the screenshots, which all showed the flow working. Re-running `npm test`
  afterwards showed the deploy-bundle test already failing (`src/` was untouched; same `@vercel/nft` 1.11.0):
  the tracer shipped the wasm but none of the 11 fonts, so `share.png` would have failed on Vercel. The cause
  was `FONT_FILES` being an array of `[name, weight, url]` arrays (see the comment in `src/share.js`). It is
  now an array of `{ name, weight, url }` objects, the tracer lists every font, and the test passes.

## Deploy (free tier)

**Vercel Hobby (this milestone).**
- **Setup.** The pipeline creates the Vercel project and pushes `DATABASE_URL`, `GOOGLE_API_KEY` and (once
  David provides it) `CRON_SECRET` to it. See Infrastructure.
- **Function.** Vercel detects Hono from `package.json` and serves the default export of `src/index.js` as
  one function. There's no build step. If detection ever fails, set the Framework Preset to "Hono" in the
  project settings.
- **Uploads.** Vercel caps them at 4.5 MB; the browser resize keeps real uploads around 0.2–0.6 MB.
- **Share images.** These render inside that same function (satori and resvg-wasm, about 0.5 s and well
  under 100 MB per image). The fonts and `index_bg.wasm` are read from `node_modules` with literal
  `new URL(…, import.meta.url)` paths. Vercel's file tracer ships those; it would miss `require.resolve`.
  `test/share.test.js` runs the same tracer (`@vercel/nft`) over `src/index.js` to prove the files are in
  the bundle.
- **Deletion job.** `vercel.json` registers one cron, `0 4 * * *` → `/jobs/expire-photos`. Hobby allows
  daily crons, which fire somewhere within that hour, and only on the production deployment. Vercel sends
  `Authorization: Bearer $CRON_SECRET` by itself once the `CRON_SECRET` env var exists. Without it the route
  answers 503 and logs why. Expiry is also enforced at read time, so a missed run delays the byte deletion
  but never shows an old photo.

**Before M3 takes money:** Vercel Hobby forbids commercial use (the roadmap and review both flag this). Either
move to a commercial-use free host or put the project on a paid plan (David's call; paid plans are out of
scope here). The app is a plain fetch handler, so moving is small:
- **Cloudflare Workers (free plan, commercial use allowed):**
  - Add a `wrangler.toml` with `main = "src/index.js"` and `compatibility_flags = ["nodejs_compat"]`
    (fills `process.env`), then set the same secrets. The Neon HTTP driver works there unchanged.
  - Two M2 changes come with it. Workers can't compile wasm from bytes or read files, so `share.js` must
    import `index_bg.wasm` and the fonts as modules (wrangler bundles them). And a Cron Trigger in
    `wrangler.toml`, calling the same route with the header, replaces `vercel.json`.
  - Check the CPU limit too: the Workers free plan allows 10 ms of CPU per request, far below a 0.5 s
    render, so share images need the paid plan or another host.
- **Any Node host (Render free, Fly):** run `@hono/node-server` the way `scripts/dev.js` does; everything
  works unchanged. Call the job from any scheduler (for example a GitHub Actions `schedule`) with `curl` and
  the bearer header.

**Model cost.** The Gemini API key is free only if its Google Cloud project has no billing account. If billing
is on, each generation costs well under $0.01, which is still far below the PRD's $0.10 per-order cap.
Free-tier rate limits are small: roughly ten requests a minute and a few hundred a day for Flash at the time
of writing, but check AI Studio for current numbers. That's enough for the 100-visitor test, not for a viral
spike. On quota errors users get a 502 "try again in a minute". To change provider, set `LLM_BASE_URL`,
`LLM_API_KEY` and `LLM_MODEL`; no code change is needed.

## Operations (M2)

Run these in the Neon SQL editor. They're plain SQL, so you never need the connection string in a terminal.
- **Reported previews:**
  `SELECT slug, name, report_count, created_at FROM pets WHERE report_count > 0 ORDER BY report_count DESC;`
  (why: `SELECT reason, count(*) FROM reports WHERE slug = '…' GROUP BY reason;`). The function log also
  prints `report: preview <slug> reached 3 reports` when one is hidden.
- **Restore a wrongly reported preview:** `UPDATE pets SET report_count = 0 WHERE slug = '…';`
  (and `DELETE FROM reports WHERE slug = '…';` so the same people can report it again).
- **Remove a preview's photo right now** (e.g. a "my photo" report you agree with):
  `UPDATE pets SET photo = NULL, expired_at = now() WHERE slug = '…';` The preview then shows "expired".
- **Run the deletion job by hand:** in Vercel → Settings → Cron Jobs → "Run", or call it with the bearer
  header.

## Exit criteria (M1)

| Exit criterion | Status |
|---|---|
| POST /generate "Biscuit"/dog/3 traits/"crime boss" → 200 with non-empty alias, rap sheet 3+, 5 stats 1–99, headline, bio | ✅ passing (`test/generate.test.js`) |
| Invalid JSON or missing field from the model → 502, nothing stored | ✅ passing (`test/generate.test.js`, 14 tests) |
| `<script>` in a trait is escaped in the page, not an element | ✅ passing (`test/preview.test.js`) |
| GET /p/<slug> → pet name, photo, 4 cards, `noindex`; slug 12+ chars | ✅ passing (`test/preview.test.js`; slugs are 22 chars) |
| Upload over 10 MB or a non-image → 400 | ✅ passing (`test/generate.test.js`, `test/http.test.js`) |

The model is faked in tests. Nobody has checked the jokes from the real free model yet; that happens after
the pipeline provisions the key (see "What's left").

## Exit criteria (M2)

| Exit criterion | Status |
|---|---|
| GET /p/<slug>/share.png returns an image of the stated dimensions | ✅ passing (`test/share.test.js`). 1080×1350 by default, 1080×1920 with `?size=story`, read from the PNG's IHDR. The real photo's pixels are in both (a real JPEG and a real PNG). An unreadable photo still gives the right size. Also over a real socket (`test/http.test.js`). |
| POST /report with a slug flags the record and the preview returns 410 after 3 reports | ✅ passing (`test/report.test.js`). The count on the record goes 1, 2, 3; the preview goes 200, 200, then 410, and so do its photo and share image. One person three times counts once. Also tested: CSRF, bad and unknown slugs, JSON and form bodies. |
| The deletion job removes photos older than 30 days and the preview then shows an "expired" page | ✅ passing (`test/expiry.test.js`, on the memory store **and** PGlite). The 31-day photo is gone, the 29-day one is kept; the preview is 410 "expired" and noindex. Also tested: a second run deletes 0, the exact 30-day boundary, read-time expiry before the job runs, and auth (401/503). |

The M2 deliverables beyond the criteria are tested too:
- the "make your pet's" link on each preview and in each share image (`share.test.js`);
- the report link on each preview (`report.test.js`);
- the daily cron in `vercel.json` (`expiry.test.js`).

The share images were also checked by eye here. Renders with a typical pet and with every field at its
maximum length fit both formats, with no overflow and no clipped text.

## What's left

- **Next milestones:**
  - M3: Stripe Checkout at $9, the webhook, the clean PNG/PDF bundle, one regenerate, legal pages, and a
    commercial-use host.
  - M4: gift flow and print upsell.
- **Host choice for M3, new from M2.** Share images take ~0.5 s of CPU each. That rules out the Cloudflare
  Workers *free* plan (10 ms CPU per request) that M1 suggested as the commercial-use host. Two options:
  a Node host (Render, Fly, Koyeb free tiers run the app unchanged with `@hono/node-server`), or Workers
  Paid. See Deploy.
- **PRD items in no milestone yet:**
  - The "refuse non-pet photos" check.
  - Analytics for the review's watch list: which alter ego, abandoned forms, regenerate rate, **share
    rate**. The PRD's "20% of previews shared" and the kill criterion "share rate under 10%" need a counter.
    The smallest version is a `share_count` column bumped on each `share.png` request; it's not built,
    because no exit criterion needs it.
- **Not built in M2, on purpose:**
  - Open Graph tags, which would put the poster in iMessage/WhatsApp link previews. They need an absolute
    URL and a 1.91:1 crop.
  - A moderation UI (SQL is enough; see Operations).
  - Email to David when something is reported: no free email service is wired up yet. The log line is the
    signal.
- **Not verified here:**
  - Prompt quality with the real model. Run a handful of generations once `GOOGLE_API_KEY` exists and tune
    `buildMessages` in `src/character.js`. Humour quality is the product.
  - A real deploy, including Vercel Cron actually calling the job with `CRON_SECRET`.
  - Visual polish on real phones, and share images with real pet photos (tested with solid-colour JPEG
    and PNG).
  - The Neon HTTP driver against a live database. The SQL itself, including the `DO $$` migration and the
    report CTE, runs on PGlite (real Postgres) in tests.
- **Ops:**
  - No rate limit on `/generate`, and none on `share.png` renders (see Review).
  - Photos live in Postgres. The 30-day job now caps storage at about one month of uploads (~1,500
    previews fit the free 0.5 GB). Move photos to object storage if volume grows past that.

## Infrastructure

Requested in `.provision` (the pipeline runs these through the credential broker after the build; no values
are in this repo):

| Line | Gives | Used by |
|---|---|---|
| `neon db alterpaw` | `DATABASE_URL` (Postgres, Neon free tier) | `src/index.js` → `PgStore` |
| `gcp key alterpaw generativelanguage.googleapis.com` | `GOOGLE_API_KEY` restricted to the Gemini API | `src/index.js` → model client |
| `vercel project alterpaw` | the Vercel project, with every stored value as env | hosting (M1, M2) and Vercel Cron (M2) |
| `request "CRON_SECRET for alterpaw: …"` (new in M2) | a random letters-and-digits value as the Vercel env var `CRON_SECRET` | `src/index.js` → `/jobs/expire-photos`; Vercel Cron sends it automatically |

M2 needs no other service. Share images render in the same function with no paid API, and the cron is part
of Vercel Hobby. Stripe and a commercial-use host will be requested in M3; see "What's left" for the host.

## Review

**How it was reviewed.** `git status` shows only new files (`.gitignore`, `.provision`, `BUILD.md`,
`package.json`, `package-lock.json`, `scripts/`, `src/`, `test/`); there were no edits to existing files.
I reviewed the code against gstack's checklist ("Review Categories", "Fix-First Heuristic"). An independent
read-only reviewer then went through `src/` and `scripts/` with the same checklist. Every finding below was
checked against the code, or against `node_modules`, before being fixed. `npm test` was rerun after the
fixes: 126/126 pass.

### Pass 1 — CRITICAL

| Finding | Outcome |
|---|---|
| [P1] (confidence 9/10) `src/index.js`, logged in `src/app.js`: a malformed `DATABASE_URL` (a pasted `psql '…'` snippet, a password with a space) makes Neon's driver throw `…not a valid URL (connection string: <the whole string>)`. Confirmed in `node_modules/@neondatabase/serverless/index.mjs`. The app logged `err.message`, so the database password would be written to Vercel logs on every request. | **Fixed.** `depsFromEnv` checks the URL first and fails with a fixed message that never contains the value. Every logged error also goes through `redact()`, which masks database URLs to the end of the line and any `scheme://user:pass@…`. Tests check the actual logged lines. |
| SQL & data safety | Clean. Parameterised queries only, one query per request (no N+1), `getPet` never selects the photo. |
| Races | Clean after one fix. Slugs are 128-bit random with a primary key, and a duplicate is rejected, not overwritten. Two cold starts racing on `CREATE TABLE IF NOT EXISTS` now count as success (tested). |
| XSS | Clean. Every value goes through Hono's `html` escaping (checked in its source), with no `raw()` on data. CSP allows no inline script or style (stat bars are SVG attributes). Photos are typed by magic bytes, SVG is refused, `nosniff` is set. |
| LLM output trust boundary | Clean. Shape and type checks, length caps, unknown keys dropped, nothing fetched from model output. Pet details are sent as data with an instruction to treat them as data. |
| Shell / eval | None. The client test's `new Function` only parses our own served script. |
| Enum completeness | Clean. Species (`dog`/`cat`/`other`) and the six alter-ego ids are traced through input, prompt, views and the form. The species `<select>` is now built from `SPECIES` (it was hard-coded). |

### Pass 2 — fixed (mechanical fixes, or bugs with a clear fix)

- [P2] **jsonb rejected NUL, lone surrogates and emoji split by truncation.** That gave a 500 after a model
  call was already spent. `tidy()` now cleans and cuts by code point. A PGlite test proves both the failure
  and the fix.
- [P2] **Undecodable photos uploaded the original, with EXIF/GPS.** The form now refuses instead.
- [P2] **Stuck form after Back.** The back/forward cache restored the page with the button disabled. It's now
  reset on `pageshow`.
- [P3] **Browser error text in the UI.** "Failed to fetch" or "Load failed" was shown to users. Only our
  messages or the server's `error` are shown now.
- [P3] **Old browsers left the form stuck.** A missing `createImageBitmap` threw synchronously. Now handled.
- [P3] **Article paragraphs were collapsed.** They're preserved, and the newspaper renders one `<p>` each.
- [P3] **Limits duplicated in the form.** `maxlength` values now come from the server constants.
- [P3] **Partial watermark.** It didn't cover tall cards fully; it now has more repeats.

### Left open (judgement calls or later milestones)

- [P2] (confidence 7/10) **No rate limit on `/generate`.** A script can burn the free model quota and fill the
  0.5 GB Neon tier: roughly 110 uploads at Vercel's 4.5 MB cap, or about 1,500 normal ones. An in-memory
  limit is useless across serverless instances; a real one needs shared state (a Postgres counter per hashed
  IP, or a KV store). Planned for M2, next to the deletion job and report link, which are the other abuse
  controls.
- [P2] **Server photo cap stays at 10 MB, as the roadmap specifies.** The browser sends ~0.2–0.6 MB, so
  lowering `MAX_PHOTO_BYTES` to ~2 MB would cut storage abuse per request 5× and still meet "over 10 MB →
  400". That's a product call for David; it's a one-constant change plus the "exactly 10 MB is accepted" test.
- [P3] **API uploads keep EXIF.** Someone posting straight to `/generate`, bypassing the form, keeps their
  photo's metadata. Only their own choice; add server-side JPEG metadata stripping if API use appears.
- [P3] **Newspaper date is UTC.** A US visitor in the evening sees tomorrow's date.
- **Not verified in this sandbox:**
  - Real model output and humour.
  - Vercel's Hono auto-detection of `src/index.js`.
  - The Neon HTTP driver against a live database. The same SQL passes on PGlite.
  - Rendering on real phones.
- **Still to do:** move off Vercel Hobby before M3 charges money (no commercial use), and build the PRD's
  non-pet photo check (it's in no milestone yet).
