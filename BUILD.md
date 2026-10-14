# alterpaw — build notes

## Plan

Milestone: **M4 — Gift flow and print**, the one milestone of this MVP run. M1–M3 stay green. This was built
non-interactively, so every question the gstack frameworks would ask a person is answered here, with the reason.

Exit criteria (ROADMAP.md):
1. A gift order with a delivery date in the future sends nothing before that date and one email on it.
2. A print order creates one print-on-demand order with the stored shipping address and rejects an incomplete
   address with 400.

**Where this run started.** M4 was already in the repo. The previous run built it, and it was committed with
M2–M3 (`d07c662`). That includes:
- `src/email.js` (Brevo) and `src/print.js` (Prodigi);
- the `orders` table;
- `POST /gift`, `POST /print`, `GET /jobs/deliver-gifts` and `GET /prints/:id/poster.png`;
- `test/gift.test.js`, `test/print.test.js` and `test/email.test.js`.

After `npm ci`, `npm test` passed 391/391. That run's plan is kept below as "M4 — first build".

Three things were unfinished:
- The M4 review stopped after Pass 1: no Pass 2, and nothing "left open".
- `.provision` was missing; the pipeline had consumed it.
- One test pinned the gift job's schedule but only checked whole-hour time zones.

So this run doesn't rebuild M4. It re-verifies each exit criterion against how production will actually behave,
writes a failing test for every real gap, and fixes it.

### Step 0: Scope challenge (M4, second pass)

1. **What existing code already solves:** all of M4 (see the first build's Step 0 below). There's no parallel
   flow to build. Gifts and prints already reuse:
   - M3's Checkout and signed webhook;
   - the `/` upload form, for the recipient's pet;
   - M2's cron pattern, for the gift job;
   - the wanted-poster layout, for the print file.
2. **Minimum change that meets the exit criteria.**
   - In:
     - **Re-verify each criterion where a passing test could still fail in production.** For criterion 1:
       the real cron's timing against every time zone. For criterion 2: the Prodigi and Brevo contracts,
       and the Neon HTTP driver vs. PGlite.
     - **A failing test, then the fix, for each real gap.** Found:
       - the gift run's hour (see Search check);
       - from the review: one batch of 50 gifts per run, every Brevo 400 treated as permanent, one gift's
         database error aborting the run, invisible-only address fields passing as filled in, and three
         smaller ones (see Review).
     - **Finish the M4 review:** Pass 2, plus what's left open (see Review).
     - **Refresh the rest:** write `.provision` again, re-run the screenshots, update BUILD.md and README.
   - Deliberately **not** in this run: everything outside M4's two criteria that's already listed in What's
     left:
     - rate limits;
     - the non-pet photo check;
     - the share-rate counter;
     - email to David on a third report;
     - a custom email domain;
     - shipping outside the US;
     - Stripe Tax;
     - the commercial-use host decision.

     The roadmap's "only if M3 sells" gate stays a switch: the gift and print forms appear only once their
     keys exist.
   - **Before charging.** There's no `REVENUE.md`. `/legal` already covers gifts, prints, the recipient's
     email, the shipping address, Brevo and Prodigi.
3. **Complexity check.** Five code files change, under the 8-file smell line:
   - `vercel.json`: the cron hour;
   - `src/app.js`: the gift job's batch loop and per-gift error handling;
   - `src/email.js`: which Brevo 400s are permanent;
   - `src/input.js`: invisible characters, well-formed text and the zone cache key;
   - `src/views.js`: one sentence.

   Three test files change too. There are no new modules, classes or services. Each fix is local to the
   function that had the gap.
4. **Search check** (WebSearch available):
   - **[Layer 1]** Vercel's cron docs: on Hobby a cron runs at most once a day, in UTC. It fires *anywhere
     from H:00:00 to H:59:59* of its hour ("0 1 * * *" triggers between 1:00 and 1:59), to spread load. The
     limit is 100 crons per project. Sources: [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs),
     [Usage & Pricing for Cron Jobs](https://vercel.com/docs/cron-jobs/usage-and-pricing).
   - **[Layer 1]** Brevo answers a bad request with 400 and `{ code, message }`. A recipient it won't take
     reads `"email is not valid in to"` (quoted in a public bug report:
     [drupal.org #3546064](https://www.drupal.org/project/brevo/issues/3546064)). An unverified sender is
     also refused, per its help page
     ([Troubleshooting issues with Brevo SMTP](https://help.brevo.com/hc/en-us/articles/115000188150-Troubleshooting-issues-with-Brevo-SMTP),
     [Sender creation and management](https://developers.brevo.com/docs/sender-creation-and-management)).
     That's the basis for the review's Brevo 400 fix.
   - **[EUREKA] One daily run is only "on the date" if no zone's midnight falls inside its hour.** A gift is
     due at local midnight. If that midnight lands inside the run's hour, a run that fires early in the hour
     misses the gift, and the next run is a day later, which can be past the date.
     - **What the first build missed.** It checked whole-hour offsets only. At 14:00 UTC it misses:
       - **Australia/Darwin** (UTC+9:30) every day of the year;
       - **Adelaide and Broken Hill** in their winter.
     - **The check.** I simulated both edges of the run's hour against all 418 IANA zones Node knows, for
       every date from 2026-10-14 to 2027-10-13. **16:00 UTC is the only one of the 24 hours with no misses.**
       Every other hour misses somewhere: half- and quarter-hour zones, or a whole-hour zone on its
       DST-change day, when midnight lands on the hour's edge.
     - **The move.** The run goes from 14:00 to 16:00 UTC. For the US buyers the prices and shipping target,
       that's around noon in New York (11 am in winter) and 9 am in Los Angeles. Asia-Pacific gets the
       email overnight, still on the date.
   - **[Layer 1]** Everything else the first build searched still holds: Prodigi's `idempotencyKey`, Brevo's
     v3 send API and free plan, and `Intl.DateTimeFormat` for zone offsets.
5. **TODOS cross-reference.** There's no `TODOS.md`. The M3 and M4 "left open" items are unchanged, and
   none of them blocks an M4 exit criterion.
6. **Completeness check.** The new tests cover the exact production behaviour, not a sample:
   - the run's actual hour, read from `vercel.json`;
   - both edges of Vercel's hour;
   - every zone, every day for a year;
   - an end-to-end gift through the app in ten odd-offset zones, with runs at the top of the hour, at its
     end, and alternating.
7. **Distribution check.** It's still a web service. The only deploy-side change is the cron expression in
   `vercel.json`, which the next production deploy picks up.

### 1. Architecture review (M4, second pass)

The design is unchanged. The data flow diagram, boundaries and failure scenarios are under "M4 — first build"
below, and they were re-read against the code. Each new codepath or integration point, and how it fails in
production:

| Path | Realistic production failure | Covered? |
|---|---|---|
| Vercel Cron → `/jobs/deliver-gifts` | Vercel fires early in the hour, before a half-hour zone's midnight, and the gift goes a day late. | **Fixed in this run** (16:00 UTC), with a test over every zone. |
| `/jobs/deliver-gifts` → Brevo | Brevo is down or rate-limited: the claim is released and the next daily run retries, so the email is a day late. | Yes, tested. A gift for *today* also retries through Stripe's webhook retries. **Second pass:** the run now stops after three failures in a row instead of waiting on every gift's timeout. |
| `/jobs/deliver-gifts` on a busy day | More gifts are due than one batch (50), and the rest wait until tomorrow. | **Fixed in this run:** batches until none are due (up to Brevo's free 300 a day), tested with 121. |
| Brevo 400 | `EMAIL_FROM` isn't verified in Brevo, so every send is a 400, which used to cancel every gift due that day for good. | **Fixed in this run:** only a 400 that names the recipient cancels; any other is retried. |
| Webhook → Prodigi | Prodigi times out after creating the order: a 500, and Stripe retries. The same `idempotencyKey` returns the first order (`AlreadyExists`), so there's one print. | Yes, tested with a fake that dedupes like Prodigi. |
| Prodigi → `/prints/:id/poster.png` | The preview was taken down between payment and the fetch: 410, Prodigi reports an asset error, and the order is visible in SQL for a refund. | Yes, tested (410). Refund by hand (Operations). |
| Neon HTTP driver | Each query is its own HTTP request, so there's no session and no multi-statement transaction. Every M4 state change is already one statement (the claim is a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`). | Yes. The SQL runs on PGlite in tests; the driver itself is unverified until deploy. |

**Security architecture** is unchanged and re-checked in the Review below:
- an email goes only to a **paid** gift's recipient;
- both forms are same-site only;
- the print file needs a 128-bit order id and a paid order on a live preview;
- keys travel only in headers.

### 3. Test review (M4, second pass)

The first build's tests stay as they are. This run adds tests where a criterion could pass in tests and fail
in production:

| Exit criterion | New in this run | Failed before the fix? |
|---|---|---|
| 1. Nothing before the date, one email on it | `gift.test.js`: **the run's hour from `vercel.json` lands on the date in every IANA zone, every day for a year**, at both edges of the hour. | Yes: Darwin, Adelaide and Broken Hill. |
| 1. | `gift.test.js`: **an end-to-end gift in 10 odd-offset zones** (Darwin, Eucla, Kolkata, Kathmandu, Chatham, St John's, Marquesas, Kiritimati, Pago Pago, New York). Runs go at the top of the hour, the end of the hour, and alternating. It's exactly one email each time, on the date. | Yes: Darwin with early-then-late runs. |
| 1. | `gift.test.js`: the Tokyo, Los Angeles and New York runs now use the scheduled hour, not a hard-coded 14:00. | Tokyo, yes. |
| 1. | `gift.test.js`: **121 gifts due on one day, one of which keeps failing** → 120 emailed in that day's run, the stuck one tried once. | Yes: the run stopped after 50. |
| 1. | `gift.test.js`: **an email outage on a 60-gift day** → at most 5 tries, nothing left claimed; the re-run sends 60, once each. | Yes: 50 tries, then 50 sent. |
| 1. | `gift.test.js`: **a database error on one gift** fails only that gift; the rest go, and it goes on a re-run. If recording "sent" fails after the email went, a re-run that day doesn't send it again. | Yes: the run answered 500. |
| 1. | `email.test.js`: **only a Brevo 400 about the recipient is permanent**; an unverified-sender 400 is retried, so it can't cancel a day of paid gifts. | Yes. |
| 1. | `gift.test.js`: "Your orders" tells the truth about a cancelled gift. | Yes. |
| 2. Incomplete address → 400 | `print.test.js`: a JSON field that isn't text (null, a number, a list, an object) counts as missing: 400 naming it, nothing stored or charged. | No. It pins behaviour that was already right. |
| 2. | `print.test.js`: **a name, street or city made only of invisible characters** (zero-width space, Hangul filler, word joiner) → 400 naming it. | Yes: they passed as filled in. |
| 2. | `print.test.js`: **on Postgres (PGlite), an address with a broken UTF-16 character** is stored, not a 500. | Yes: jsonb refused it. |
| Both | `gift.test.js`: invisible-only and broken text on the gift form; 256 casings of a zone name add at most one cached formatter. | Yes. |

### Earlier plans (kept for reference)

#### M4 — Gift flow and print (first build, previous run)

Milestone: **M4 — Gift flow and print** (3 of 3 in this MVP run: M2 and M3 are done). M1–M3 stay green.
This was built non-interactively. Every question the gstack frameworks would ask a person is answered here,
with the reason.

Exit criteria (ROADMAP.md):
1. A gift order with a delivery date in the future sends nothing before that date and one email on it.
2. A print order creates one print-on-demand order with the stored shipping address and rejects an
   incomplete address with 400.

The roadmap says "only if M3 sells". Nothing has sold yet (there are no live payments), but this run was told
to build M4. So the gate becomes a switch: **both features stay hidden until their keys exist**. The gift form
only appears once email, the scheduler and Stripe are configured, and the print form once Prodigi and Stripe
are. Nothing half-works in production while David decides whether M3 sold. There is no `REVENUE.md`.
"Before charging" for M4 means the terms, refunds and privacy page must cover gifts, prints, the new data
(a recipient's email, a shipping address) and the new processors (Brevo, Prodigi), so `/legal` is updated.

#### Step 0: Scope challenge (M4, first build)

1. **What existing code already solves.**
   - **Payments.** Stripe Checkout, the signed webhook and its replay and amount checks are all in M3.
     A gift and a print are just two more products. The session gets `metadata.order`, and the webhook finds
     the order row by it. There's no second payment path.
   - **The recipient's pet photo uploaded by the buyer** is the existing `/` form. The buyer makes the preview
     the same way an owner does; the home page now says so. Only paying differs.
   - **The bundle unlock.** A paid gift calls the existing `markPaid`, so the recipient's link opens the clean
     cards, the bundle and the rewrite, with no new "gift view".
   - **The scheduled job.** The pattern is M2's `/jobs/expire-photos`: bearer `CRON_SECRET`, a Vercel Cron
     entry, constant-time comparison and fail-closed. The gift job copies it.
   - **The print file.** It's the bundle's wanted poster (`bundle.js` → `wantedPoster` in `share.js`),
     drawn taller and rasterised at 300 dpi. There's no new layout.
   - **The guards.** The same-site form guard (`sameSiteForm`), `lookup`/`findLive`, `failWith`, the store's
     "one conditional UPDATE" style and the DI seams. They take two more: `sendEmail` and `printOrder`.
2. **Minimum change that meets the exit criteria.**
   - In:
     - **The `orders` table** (one row per gift or print purchase). M3's review asked for it before a second
       purchase per preview, and both M4 products are that.
     - **`POST /gift`:** recipient's email and optional name, the buyer's name, an optional message, the
       delivery date and its time zone. It validates the form, stores an unpaid gift order and sends the buyer
       to a $9 Checkout. It's offered on unpaid previews, as the other way to buy the bundle.
     - **The webhook** marks the order paid once and unlocks the preview. If the delivery date is already
       today, it sends at once.
     - **`GET /jobs/deliver-gifts`**, daily (Vercel Cron, 14:00 UTC). It claims due, paid, unsent gifts (a
       lease, so two runs can't both send), emails each one through Brevo, then marks it sent. A failed send
       releases the claim so the next run retries.
     - **`POST /print`:** a US shipping address. 400 lists the missing or invalid fields, and nothing is
       stored or charged. It's offered on paid previews, as the upsell. It stores an unpaid print order with
       the address and sends the buyer to a $29 Checkout.
     - **The webhook** marks the order paid and creates **one** Prodigi order with the stored address and
       `idempotencyKey` = our order id. The Prodigi order id is stored, and a repeat skips the call. A
       transient Prodigi failure answers 500, so Stripe retries, and the idempotency key keeps it to one order.
     - **`GET /prints/<order id>/poster.png`:** the 12×16 in print file (3600×4800 px), only for a paid print
       order on a live preview. Prodigi fetches it from there.
     - **The preview page:** an "Your orders" box (gift scheduled or sent, poster sent to the printer); the gift
       form inside the $9 offer; the print form on the paid page; a line on the home page about gifting.
     - **`/legal`:** gifts, prints, the recipient's email, the shipping address, Brevo and Prodigi.
     - **Retention:** the 30-day photo job also erases orders' personal details (recipient, message,
       address).
   - Deliberately **not** in M4:
     - **Gifting an already-paid preview.** The buyer can forward the link.
     - **Editing or cancelling a scheduled gift** (one SQL line, see Operations).
     - **A confirmation email to the gift buyer.** Stripe's receipt and the page do it.
     - **Shipping outside the US**, other sizes, frames, and tracking or Prodigi status callbacks.
     - **Sales tax.** Stripe Tax is a paid add-on, so it's David's call (see What's left).
     - **A custom email domain.** It costs money; Brevo's free plan sends from one verified address.
     - **Rate limits:** still open from M1–M3, see Review. Both new forms sit behind a payment, so neither adds
       anonymous email or print cost.
     - **The gate itself** ("only if M3 sells"): David's call, enforced by leaving the keys unset.
3. **Complexity check.** 11 files change, over the 8-file smell line:
   - `app`, `store`, `views`, `payments`, `bundle`, `input`, `index`, `scripts/dev` and `vercel.json` change;
   - `email.js` and `print.js` are new.

   There are two new services, the Brevo client and the Prodigi client, which is at the limit, not over it.
   Each changed file gets a small, local change in the pattern M3 set:
   - `bundle.js`: one render function;
   - `payments.js`: a product table;
   - `input.js`: two form parsers next to the pet-form parser.

   Merging the two clients into one "fulfilment" module would save a file and couple two vendors. Gift
   validation and time-zone math went into `input.js` instead of a third new module. Proceeding without a
   further cut.
4. **Search check** (WebSearch was available; WebFetch was not):
   - **[Layer 1]** Prodigi Print API v4: `POST /v4.0/Orders` with an `X-API-Key` header, plus a free sandbox
     (`api.sandbox.prodigi.com`) that never prints or charges. Its **`idempotencyKey`** is remembered
     indefinitely, and a repeat answers `outcome: "AlreadyExists"` with the first order's id. That's the
     built-in for "creates one print-on-demand order"; our own `pod_order_id` check only saves the call. Known
     footguns from other projects' issues:
     - an unprefixed key collides across deployments that share a Stripe account, so ours is
       `alterpaw-<order id>` and the order id is 128-bit random;
     - `postalOrZipCode` is required;
     - an `AlreadyExists` reply carries only the id.

     The SKU follows `GLOBAL-{paper}-{W}X{H}`. `GLOBAL-FAP-12X16` (enhanced matte art paper, 12×16 in) is
     named on Prodigi's product page, and Prodigi recommends 300 dpi.
   - **[Layer 1]** Brevo transactional API: `POST https://api.brevo.com/v3/smtp/email` with an `api-key`
     header, `sender`, `to`, `subject` and `htmlContent`. The free plan sends 300 emails a day, with no
     domain needed: one verified sender address works. The footgun: Brevo rewrites an unauthenticated or
     free-mail From address to `…@brevosend.com`, which hurts deliverability. That's noted for David; the
     fix is a domain, which costs money. Resend and Postmark need a verified domain to email strangers, so
     they're out at $0.
   - **[Layer 1]** Vercel Cron on Hobby: up to 100 jobs per project since early 2026, but each runs **at most
     once a day**, anywhere within its hour. An hourly expression fails the deploy.
   - **[EUREKA] One daily run is enough, if a gift is due at local midnight of its date.** Store
     `deliver_at` = the first instant of the delivery date in the buyer's time zone. Then a run at 14:00 UTC
     lands *on* that date everywhere from UTC−12 to UTC+14: about 10 am in New York, 7 am in Los Angeles,
     3 pm in London, 11 pm in Tokyo, 1 am in Sydney. *(Corrected in the second pass: that holds for
     whole-hour offsets only. Darwin's midnight falls inside the 14:00 hour, so the run is now at 16:00 UTC;
     see the Plan at the top.)* A time like "9 am local" would have needed an hourly
     scheduler, which Hobby doesn't have. The one gap is a delivery date of *today* after today's run, and
     the webhook covers it: a gift that's already due sends the moment it's paid.
   - **[EUREKA] The preview page can't run a script, so it can't read the browser's time zone.** An M1 test
     pins the page as script-free, and that's the XSS posture. Vercel adds `x-vercel-ip-timezone` to every
     request, so the gift form pre-selects that zone in a plain `<select>` (US zones and a few others), and
     the buyer can see and change it. With no header, it defaults to New York (prices are in USD). The server
     accepts any valid IANA zone.
   - **[Layer 1]** `Intl.DateTimeFormat` with `timeZone` gives zone offsets with no date library. Midnight is
     found by offset and checked again. The rare zone whose clocks jump at midnight (Chile) gets the first
     instant that exists on that date, and a test pins it. Temporal isn't in Node 22.
5. **TODOS cross-reference.** There's no `TODOS.md`. From the M3 review:
   - "A second purchase needs an `orders` table": done here.
   - "Email to David on the third report": M4 now has an email client. Wiring it to `/report` is a
     one-call change, but it needs David's address as config and isn't an exit criterion. Listed in Review.
   - The rate limit and the host decision are still open (Review, Deploy).
6. **Completeness check.** Every new error path gets a test:
   - **Gift:** a malformed, past or too-late date (the recipient needs a week before the photo is deleted);
     a bad email or zone; an over-long field; a paid or unknown preview; unconfigured services (503);
     cross-site requests; an unpaid gift (never sent); a transient send failure (retried once, then sent
     once); a permanent failure (cancelled and logged for a refund); a preview taken down before the date
     (not sent); two job runs at once (one email); a crash after the claim (the lease expires, then it's
     retried); a wrong amount.
   - **Print:** each missing field, a bad ZIP, state or country, an unpaid preview (402), no printer (503), a
     transient Prodigi failure (500, then one order on retry), a permanent one (logged), a repeated webhook,
     concurrent deliveries, and the print file for an unpaid, unknown or removed order.
7. **Distribution check.** It's still a web service with no new artifact. New deploy inputs:
   - one more cron entry in `vercel.json`;
   - four env vars (`BREVO_API_KEY`, `EMAIL_FROM`, `PRODIGI_API_KEY`, optionally `PRODIGI_ENV=live`),
     requested in `.provision`.

   `email.js` and `print.js` are imported statically from `index.js`, so the nft trace covers them.

#### 1. Architecture review (M4, first build)

```
Unpaid preview ── form POST /gift {slug, recipientEmail, recipientName?, fromName, message?, deliverOn, timeZone}
   ─▶ same-site guard ─▶ lookup (400/404/410) ─▶ paid already? 303 back
   ─▶ gifts configured? (checkout + sendEmail + CRON_SECRET, else 503)
   ─▶ parseGiftForm: email shape · names ≤ 40 · message ≤ 300 · valid IANA zone (default UTC)
        deliverOn ≥ today in that zone, ≤ the date of (upload + 23 days) · deliverAt = 00:00 that day, there
   ─▶ store.createOrder({ id: 22-char random, kind: 'gift', amount 900, details, deliverAt, origin })
   ─▶ checkout({ product: 'gift', orderId }) ─▶ 303 to Stripe
Paid preview ── form POST /print {slug, name, line1, line2?, city, state, zip}
   ─▶ same-site guard ─▶ lookup ─▶ unpaid? 402 ─▶ prints configured? (checkout + printOrder, else 503)
   ─▶ parseShippingAddress: every required field, a US state code, a 5- or 9-digit ZIP; else 400 {error, fields}
   ─▶ store.createOrder({ kind: 'print', amount 2900, details: address }) ─▶ checkout({ product: 'print' }) ─▶ 303
Stripe ── POST /stripe/webhook (verified as in M3) ─▶ metadata.order?
   no  ─▶ the M3 bundle path, unchanged
   yes ─▶ order exists, same slug, amount_total = the order's amount in usd (else 200 + "check/refund" log)
       ─▶ store.markOrderPaid(id) (UPDATE … WHERE paid_at IS NULL)
       ─▶ gift:  store.markPaid(slug) (unlocks the bundle) ─▶ due already? deliver this gift now
       ─▶ print: no pod_order_id yet? ─▶ printOrder({ orderId, address, imageUrl: <origin>/prints/<id>/poster.png })
                 POST Prodigi /v4.0/Orders, idempotencyKey alterpaw-<id> (Created | AlreadyExists → id)
                 ─▶ store.setPrintOrder(id, podId) (UPDATE … WHERE pod_order_id IS NULL)
       ─▶ transient failure (Brevo/Prodigi 5xx, 429, timeout): 500, so Stripe retries the event
          permanent failure (4xx): 200 + "refund" error log
Vercel Cron 14:00 UTC ── GET /jobs/deliver-gifts (Bearer CRON_SECRET; 401/503)
   ─▶ store.claimDueGifts(now): UPDATE orders SET claimed_at = now WHERE id IN (paid gift, unsent, not cancelled,
        deliver_at ≤ now, claim empty or older than 15 min … FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING *
   ─▶ for each: preview live? no ─▶ cancelGift + "refund" log
                giftEmail(...) ─▶ sendEmail (Brevo) ─▶ markGiftSent │ transient: releaseGift │ 4xx: cancelGift
   ─▶ 200 { sent, failed, cancelled }
Prodigi ── GET /prints/<id>/poster.png ─▶ paid print order, live preview ─▶ wanted poster 1200×1600 ×3 → PNG, streamed
```

- **Boundaries.**
  - `email.js` owns Brevo, and `print.js` owns Prodigi: each one request shape and its error classes
    (`permanent` or not), with no app imports.
  - `input.js` owns what a valid gift form and address are, plus the time-zone math.
  - `app.js` owns the policy: when a gift is due, what a failure means, which preview states block delivery.
  - `views.js` owns the email's words and markup, escaped like every page.
  - `store.js` records and claims; it holds no rules.
- **Data.** One new table, `orders`:
  - `id` (22-char random, also the capability in the print file's URL), `slug` → `pets`, `kind`
    (`gift`/`print`), `amount_cents`, `details` (jsonb, the personal data), `origin` (the site URL the buyer
    used, for links in the email and the print file URL), `created_at`, `paid_at`, `stripe_session`;
  - gift only: `deliver_at`, `claimed_at`, `sent_at`, `cancelled_at`;
  - print only: `pod_order_id`.

  A partial index serves the job: `(deliver_at) WHERE kind = 'gift' AND sent_at IS NULL AND cancelled_at IS
  NULL`. `pets` is unchanged. The bundle's paid state stays where M3 put it, and a paid gift sets it too.
  `CREATE TABLE IF NOT EXISTS` in the same `DO $$` block upgrades an M3 database in place.
- **Security.**
  - Both forms are same-site only. Email is only ever sent for a **paid** gift, so the gift form can't be used
    to mail strangers without paying $9 each time.
  - The email's HTML goes through Hono's `html` escaping, and its text strips control characters. Brevo's
    JSON API takes no raw headers, so there's no header injection.
  - The recipient's email is shape-checked, and nothing from the model goes into an address.
  - **Logs** name order ids and slugs, never an email, name or address.
  - **Keys** (Brevo, Prodigi) are only sent in a header and never in an error message (tested).
  - **The print file** needs the 128-bit order id and a paid print order on a live preview; it's noindex and
    `private`.
  - **Addresses** go to Prodigi and nowhere else. Recipient details go to Brevo and nowhere else.
- **Production failure scenarios.**
  - **Brevo down on the delivery date:** the claim is released and the next daily run retries, so the email
    is a day late, and the log says so (tested). A gift whose date is *today* retries through Stripe's webhook
    retries too, with no extra wait.
  - **Prodigi down when the print is paid:** 500, and Stripe retries over hours. The idempotency key makes
    the retry find or create the same order (tested with a fake that dedupes like Prodigi).
  - **Prodigi rejects the order** (4xx, e.g. an address it can't ship to): logged as an error with the order
    id and "refund", and the order stays paid with no Prodigi id (visible in SQL).
  - **The job runs twice at once** (a manual run during the cron): the `FOR UPDATE SKIP LOCKED` claim gives
    each gift to one run (tested by interleaving on PGlite).
  - **The function dies after the claim, before sending:** the gift stays claimed. Fifteen minutes later the
    lease is stale and the next run takes it. Email is at least once in that one case, rather than lost
    (tested).
  - **The preview is reported down or expires before the date:** the gift is cancelled, not sent, and logged
    for a refund (tested). Dates are capped so the recipient gets at least a week before the 30-day deletion.
  - **`CRON_SECRET`, Brevo or Prodigi unset in production:** that form is hidden, and a direct post answers
    503. Nothing is charged for something that can't be delivered (tested).
  - **Prodigi fetches the print file after the preview expired:** 410, and Prodigi reports the asset error
    on the order. The fetch normally happens within minutes of payment, and checkout already refuses previews
    with under an hour left.
  - **Render cost:** the 12×16 poster at 300 dpi is about 17 MP. It renders once per print order, when
    Prodigi fetches it (measured under "Deploy").

#### 3. Test review (M4, first build)

Tests are written first and fail before the code exists. Each exit criterion maps to tests:

| Exit criterion | Tests |
|---|---|
| 1. A future-dated gift sends nothing before its date and one email on it | `gift.test.js`, with a fixed clock:<ul><li>The form → 303 to a $9 Checkout carrying `metadata.order`, then a signed webhook marks it paid and unlocks the preview. Nothing is sent at payment. The job at 23:59 the evening before (the buyer's zone) sends nothing. The job on the date sends **one** email to the recipient with the link and the message. Later runs that day and the next send nothing more.</li><li>The same flow in Tokyo and Los Angeles against the 14:00 UTC run.</li><li>A date of today sends at once on payment, once.</li><li>A transient failure sends nothing, then exactly one on the next run.</li><li>Two concurrent runs send one email.</li><li>An unpaid gift is never sent.</li><li>A taken-down preview is never sent.</li></ul>The store contract (memory **and** PGlite) covers the claim, the lease, the sent, cancel and release paths, and an interleaved claim. |
| 2. A print order creates one print-on-demand order with the stored address; an incomplete address → 400 | `print.test.js`:<ul><li>A paid preview → `/print` with a full address → 303 to a $29 Checkout. A signed webhook → the printer is called **once**, with exactly the stored address, the SKU and the print file URL, and the Prodigi id is stored. The same event again, and two deliveries at once, give still one Prodigi order (the fake dedupes by `idempotencyKey` like Prodigi).</li><li>Each missing required field → 400 naming it, with no order stored and no Stripe call. A bad ZIP, state or country → 400.</li><li>An unpaid preview → 402. No printer → 503.</li><li>A transient Prodigi failure → 500, then one order on retry. A permanent one → 200 and a "refund" log.</li><li>The Prodigi client's request (URL, `X-API-Key`, recipient mapping, SKU, `fillPrintArea`, asset URL, idempotency key) and its error classes, with no key in any message.</li><li>The print file: a real render at 3600×4800 with the photo drawn; 404 for unpaid or unknown orders; 410 when the preview is gone; HEAD doesn't render.</li></ul> |

Other new code paths covered:
- **The Brevo client:** its request shape, `permanent` for 4xx and not for 5xx, 429 or timeouts, and the key
  never in an error.
- **Time zones:** `startOfDayIn` across several zones and DST dates, plus Chile's missing midnight; "today"
  in a zone.
- **Gift form validation**, one test per rule.
- **Pages:**
  - the gift form appears on an unpaid preview only when gifts are configured, with the detected zone
    pre-selected;
  - the print form appears on a paid preview only when prints are configured;
  - "Your orders" shows the masked recipient and the date, then "sent", then the poster status;
  - `/legal` names gifts, prints, Brevo and Prodigi.
- **The email itself:** the escaped message and names, the link, the download deadline, and a subject with
  no line breaks.
- **Retention:** `expirePhotos` erases orders' details older than the cutoff.
- **Wiring:**
  - `depsFromEnv` with `BREVO_API_KEY`/`EMAIL_FROM` and `PRODIGI_API_KEY`/`PRODIGI_ENV`;
  - the unconfigured store's new methods;
  - the dev server's offline gift and print (through the real webhook);
  - the second cron in `vercel.json`;
  - the nft trace;
  - an M3 database upgraded in place.

#### M3 — Paid unlock

Milestone: **M3 — Paid unlock** (2 of 3 in this MVP run: M2 is done, M4 comes next). M1 and M2 stay green.
This was built non-interactively. Every question the gstack frameworks would ask a person is answered here,
with the reason.

Exit criteria (ROADMAP.md):
1. Before payment, the download endpoint returns 402 and previews are watermarked.
2. A signed `checkout.session.completed` webhook marks the order paid; a repeated or unsigned one changes
   nothing.
3. After payment, `GET /p/<slug>/bundle.zip` returns the 4 images and a PDF without a watermark.
4. `POST /regenerate` succeeds once for a paid order and returns 409 the second time.

There is no `REVENUE.md`. Taking money still needs terms, a refund policy and a privacy notice (Stripe asks
for them, and buyers expect them), so one `/legal` page is in scope. Nothing else from "before charging" is.

#### Step 0: Scope challenge (M3)

1. **What existing code already solves.**
   - The preview record, `findLive` (404/410 for unknown, expired and taken-down previews) and the slug gate
     give the bundle route its whole "which preview, and may it be shown" decision.
   - The share renderer gives the card renderer what it needs:
     - satori → resvg-wasm, the fonts and wasm already traced into the Vercel bundle;
     - `drawable()` text filtering;
     - the photo-problem fallback;
     - the wanted-poster layout.

     The bundle reuses all of it. One poster function now serves both the share image and the print poster.
   - `/report`'s same-site guard (cross-site refusal, `csrf()`, `bodyLimit`) becomes one shared guard for the
     three new form posts: `/checkout`, `/regenerate` and `/report`.
   - `generateCharacter` (model call plus validation) is the whole text half of `/regenerate`.
   - The DI seams in `createApp` take three more: `checkout`, `webhookSecret` and `renderBundle`. Every new
     path runs in tests with no network, no Stripe account and no secret.
2. **Minimum change that meets the exit criteria.**
   - In:
     - `POST /checkout`: a same-origin form creates a Stripe Checkout Session ($9, one line item) and
       answers 303 to Stripe.
     - `POST /stripe/webhook`: the signature is verified, and `checkout.session.completed` (plus
       `checkout.session.async_payment_succeeded`) marks the preview paid, once.
     - `GET /p/<slug>/bundle.zip`: 402 until paid; then a zip of 4 unwatermarked 1800×2250 PNGs and a
       4-page PDF, streamed.
     - `POST /regenerate`: one model rewrite for a paid preview; 409 after that.
     - On a paid preview page:
       - no watermark on the cards and no "FREE PREVIEW" stamp on the share images;
       - a download button;
       - the rewrite button.
     - On an unpaid preview page: the $9 offer.
     - `/legal`: terms, refunds and privacy.
     - The schema migration (three nullable columns).
   - Deliberately **not** in M3:
     - Accounts and order lookup by email. The preview link is the receipt, and the Stripe session carries
       the slug in its metadata, so David can find any order in the Stripe dashboard.
     - Stripe Tax, coupons and other currencies.
     - Refund automation. Refunds are done by hand in Stripe, and access isn't revoked (it's $9).
     - Verifying the session on return from Stripe. The webhook is the single source of truth, and the page
       says "refresh in a moment" if it hasn't arrived yet.
     - Keeping the pre-rewrite text.
     - A "make it different" hint in the rewrite prompt. Temperature 0.9 already varies the text; tune
       this after real outputs are checked.
     - Rate limits (see Review).
     - Email of any kind.
     - The gift flow and print (M4).
     - The host move. The code is host-agnostic; the decision is David's and is requested in `.provision`
       (see "Deploy").
3. **Complexity check.** 10 files change, which is over the 8-file smell line:
   - `app`, `store`, `views`, `index`, `share` and `scripts/dev` change;
   - `payments.js`, `bundle.js` and `files.js` are new;
   - `package.json` changes.

   There are two new services, the Stripe client (`payments.js`) and the bundle renderer (`bundle.js`),
   which is at the limit, not over it. `files.js` is a pure encoder library (PNG, PDF, ZIP), not a service.
   It's separate so the byte formats can be tested apart from the layouts. Neither cut would make M3 smaller:
   - Merging `files.js` into `bundle.js` saves a file but mixes layout with byte formats.
   - Dropping the 6-line dev checkout (`scripts/dev.js`) would break the "the whole flow works offline"
     promise of `npm run dev`.

   No new classes; the store contract gains two methods. Proceeding without a scope cut.
4. **Search check** (WebSearch was available this time):
   - **[Layer 1]** Web Crypto `crypto.subtle.verify('HMAC', …)` for Stripe's documented signature scheme
     (`t=…,v1=…`, HMAC-SHA256 over `t.payload`, 5-minute tolerance, several `v1` values during secret
     rotation). It's constant-time, and there's no Stripe SDK to bundle. Checkout is one form-encoded
     `fetch` to `/v1/checkout/sessions`.
   - **[Layer 1]** `node:zlib` (`deflate` on the thread pool, plus `crc32`) for the PNG, PDF and ZIP
     encoders. There's no zip or PDF library: the bundle is 5 stored (uncompressed) zip entries, and the PDF is
     4 pages with one image each.
   - **[EUREKA] The PDF reuses the PNGs' compressed bytes.** The card PNGs are written as RGB with the PNG
     "Up" filter. PDF's `FlateDecode` with `/Predictor 15` reads exactly that stream, so each page embeds its
     PNG's IDAT data byte for byte. There's no second compression and no image library, and the PDF costs
     what the PNGs cost. resvg's own `asPng()` writes RGBA, which PDF can't embed without splitting out the
     alpha channel.
   - **[EUREKA] Vercel caps buffered function responses at 4.5 MB; streamed responses aren't capped.**
     Vercel's guidance is to stream larger bodies. Four print-size cards plus the PDF come to roughly
     5–20 MB depending on the photo. So the zip is built in full (a failure is still a clean 500 page),
     then sent as a `ReadableStream` with a `Content-Length`.
   - **[EUREKA] CSP `form-action 'self'` blocks the redirect to Stripe in Chrome and Safari.** They check
     every hop of a form submission's redirect chain; Firefox only checks the first. The pay form posts to
     `/checkout` and gets a 303 to `checkout.stripe.com`, which the M1 policy would silently block: the
     button would do nothing. `form-action` now allows exactly `https://checkout.stripe.com`, pinned by a
     test.
   - **Resolution.** Measured here: a 1200×1500 card rasterised at 2× (2400×3000) takes about 1.3 s and
     makes a PNG of up to 6.7 MB with a busy photo; at 1.5× (1800×2250) it's about 0.75 s and 3.9 MB. Uploads
     are at most 1600 px on the long side, so 2× only upscales the photo. **1800×2250** (8×10 in at
     225 dpi) is the resolution where the photo stops being the limit.
5. **TODOS cross-reference.** There's no `TODOS.md`. From the M2 review:
   - The `/generate` and `share.png` rate limit is still open. The bundle is only for paid previews, so it
     adds no anonymous CPU cost.
   - The share-rate counter isn't bundled: no exit criterion needs it.
   - The commercial-use host is now a blocker for **live** payments (not for test mode). It's requested in
     `.provision`.
6. **Completeness check.** Every new error path gets a test:
   - **Checkout:** not configured, Stripe down, Stripe answering garbage, already paid, expired, unknown,
     malformed, cross-site.
   - **Webhook:** no secret configured, missing, tampered, stale or wrong-secret signature, several `v1`
     values, an unpaid session, an ignored event type, an unknown slug, a second session for a paid
     preview, a store failure (500, so Stripe retries), an oversized body.
   - **Bundle:** unpaid, HEAD, the photo deleted between the two reads, an undecodable photo, a renderer
     failure.
   - **Regenerate:** unpaid, used, a model failure (the rewrite isn't used up), a bad model reply, a race,
     cross-site, a form post vs JSON.
7. **Distribution check.** It's still a web service with no new artifact type. New deploy inputs:
   - two env vars (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) and a Stripe webhook endpoint, requested in
     `.provision`;
   - the file tracer must still ship the fonts and wasm. The bundle module loads them through `share.js`,
     and the existing nft test covers that.

#### 1. Architecture review (M3)

```
Preview page (unpaid) ── form POST /checkout {slug} ──▶ same-site guard (Origin/Sec-Fetch-Site, csrf, 8 KB)
                                                       ─▶ lookup(slug): 400 malformed · 404 · 410
                                                       ─▶ already paid? 303 back to /p/<slug>
                                                       ─▶ under an hour before expiry? 410
                                                       ─▶ checkout({slug, successUrl, cancelUrl, expiresAt})
                                                            (expiresAt = min(now + 24 h, preview expiry))
                                                            POST api.stripe.com/v1/checkout/sessions
                                                            (mode=payment, $9 usd, client_reference_id
                                                             + metadata.slug = slug; 15 s timeout)
                                                       ─▶ 303 Location: https://checkout.stripe.com/…
                                                          (CSP form-action allows exactly that origin)
                                                          502 page if Stripe fails · 503 if unconfigured
Stripe ── POST /stripe/webhook (raw body ≤ 256 KB) ──▶ verify Stripe-Signature (HMAC-SHA256, ±300 s, any v1)
                                                       400 unsigned/invalid · 503 no secret (Stripe retries)
                                                       ─▶ type ∈ {completed, async_payment_succeeded}
                                                          and payment_status = paid, else 200 ignored
                                                       ─▶ slug from metadata only; $9 usd only; known
                                                          preview (else 200 + "refund/check it" log)
                                                       ─▶ store.markPaid(slug, {sessionId, at})
                                                            UPDATE … WHERE paid_at IS NULL (one statement)
                                                            first: paid · repeat: no change ·
                                                            other session: no change + "refund" warning
                                                            paid but no longer live: "refund" error log
                                                       ─▶ 200 (500 on a DB error, so Stripe retries)
Browser ── GET /p/<slug>/bundle.zip ──▶ findLive (404/410) ─▶ unpaid: 402 page with the pay form (JSON: 402)
                                     ─▶ HEAD: headers only ─▶ getPhoto (410 if deleted in between)
                                     ─▶ bundle.renderBundle(pet, photo)
                                          for each of 4 cards: satori(1200×1500) → resvg ×1.5 → RGB
                                            → PNG "Up" rows → zlib.deflate (thread pool) → PNG file
                                          PDF: 4 pages of 8×10 in, each the PNG's IDAT as /FlateDecode
                                          with /Predictor 15
                                     ─▶ files.zipFiles: 5 stored entries → ReadableStream + Content-Length
Browser ── form POST /regenerate {slug} ─▶ same-site guard ─▶ lookup ─▶ 402 unpaid ─▶ 409 used
                                     ─▶ generateCharacter (502 on a model failure: rewrite not used)
                                     ─▶ store.saveRegenerated: UPDATE … WHERE paid_at IS NOT NULL
                                          AND regenerated_at IS NULL → false means a parallel rewrite won → 409
                                     ─▶ 303 back to the preview (JSON: 200 {character})
```

- **Boundaries.**
  - `payments.js` owns everything Stripe: the price, the session request and signature verification.
    It has no app imports.
  - `bundle.js` owns the four print layouts and the order of the files.
  - `files.js` owns the byte formats.
  - `app.js` owns the policy: what unpaid means (402), the one rewrite (409), which events count.
  - `store.js` only records `paid_at`, `stripe_session` and `regenerated_at`.
- **Data.** Three nullable columns on `pets`: `paid_at`, `stripe_session` and `regenerated_at`.
  - A preview has at most one order, so "the order" is the preview row's paid state. A separate `orders`
    table would only matter for several purchases per preview, which nothing sells.
  - The migration extends M2's guarded `ALTER`, so a database created by M1 or M2 is upgraded in place.
  - The 30-day photo deletion is unchanged for paid previews: the PRD promises it. The paid page shows
    the download deadline.
- **Security.**
  - **Checkout.** Only our server can create a Checkout Session (secret key). The webhook trusts nothing
    unsigned.
  - **Webhook.** It reads the raw bytes before parsing, verifies with constant-time Web Crypto, rejects a
    timestamp more than 5 minutes off (replays), and fails closed with no secret.
  - **Paid state.** The browser can't set it: only a verified event marks a preview paid, and the success
    URL only shows a "confirming" note.
  - **Form posts.** All three are same-origin only (the M2 guard).
  - **Bundle.** It's served `private, no-store` and `noindex`, as an attachment with a fixed file name.
  - **Stripe.** No user text goes to Stripe: the product name is fixed. The slug goes in metadata, so
    David can find the order.
  - **Secrets.** The Stripe secret key is only ever in an `Authorization` header and never in a log.
    Stripe's error bodies aren't logged either, only the status code.
- **Production failure scenarios.**
  - **Stripe slow or down at checkout:** a 15 s timeout, then a 502 "payments are unavailable, try again"
    page. Nothing is stored (tested).
  - **The webhook arrives after the buyer returns:** the success URL shows "We're confirming your payment"
    with a refresh link (tested). Usually it takes a second or two.
  - **The webhook secret is missing or wrong in production:** every event gets 400/503 and nobody is
    marked paid. Stripe retries for up to 3 days and emails the account about failing deliveries, and the
    log says why. Run through it once in test mode before going live (see Deploy).
  - **Neon fails during the webhook:** 500, and Stripe retries (tested).
  - **A buyer pays twice (two tabs):** the second session changes nothing and logs "refund session cs_…"
    (tested).
  - **Bundle render time and memory:** about 0.75 s per card here, so about 3–4 s per bundle, and about
    16 MB of wasm memory per card, freed after each. It runs within Vercel's default function duration
    (300 s with Fluid compute). A crash gives a 500 page and a log line (tested).
  - **A response over 4.5 MB:** streamed (tested: the body is a stream with an exact `Content-Length`).
  - **A photo the decoder can't read:** a "PHOTO ON FILE" placeholder, a warning, and still 4 images and a
    PDF (tested).
  - **The model fails during a rewrite:** 502, and the rewrite isn't used up (tested).
  - **Two rewrites at once:** one wins and the other gets 409, through the conditional UPDATE (tested).
    The loser's model call is spent.
  - **A paid preview reported 3 times:** it goes 410 like any other. Listed under Review.

#### 3. Test review (M3)

Tests are written first and fail before the code exists. Each exit criterion maps to tests:

| Exit criterion | Tests |
|---|---|
| 1. Before payment: download → 402, previews watermarked | `bundle.test.js`: unpaid `bundle.zip` is 402, with a page carrying the pay form, or JSON for JSON clients, and nothing rendered; HEAD is 402 too; the unpaid preview has 4 watermarks and the $9 offer; the unpaid share image keeps "FREE PREVIEW"; unknown → 404, expired/removed → 410 even when paid |
| 2. Signed webhook marks paid; repeated or unsigned changes nothing | `payments.test.js`: signed → paid, with the session stored; the same event again → identical record; another session for the paid preview → unchanged and a refund warning; no signature, a wrong secret, a tampered body or a stale timestamp → 400 and unpaid; several `v1` values; no secret configured → 503; an unpaid session or another event type → 200 and unpaid; `async_payment_succeeded` → paid; unknown slug → 200 and an error log; store failure → 500; >256 KB → 413. The store contract (memory and PGlite) for `markPaid` |
| 3. After payment: `bundle.zip` has the 4 images and a PDF, no watermark | `bundle.test.js` with the real renderer: 200 `application/zip` attachment, `no-store`, streamed with an exact length; unzipped (fflate) there are 4 PNGs at 1800×2250 and a 4-page PDF; the photo's pixels are intact on the poster (no stamp over it); no card tree has any "preview"/watermark text; each PDF page's image is the matching PNG's pixel data; the PDF has no text operators; undecodable photo → still 5 files and a warning; renderer failure → 500; photo deleted in between → 410; HEAD → no render. `files.test.js`: the PNG encoder decodes; PDF xref offsets and page count; the zip is readable and its CRCs check out |
| 4. `POST /regenerate` succeeds once for a paid order, 409 the second time | `regenerate.test.js`: paid → 200 and the new text is stored and shown; second → 409 with no model call; unpaid → 402 with no model call; model failure or bad JSON → 502 and the rewrite is still available; two at once → one 200, one 409; form → 303 to the preview; cross-site → 403; malformed → 400, unknown → 404, expired → 410. The store contract for `saveRegenerated` |

Other new code paths covered:
- **Checkout:** the Stripe request (URL, Bearer, `mode=payment`, `unit_amount=900`, `usd`,
  `client_reference_id`, success and cancel URLs); non-2xx, network failure and a missing URL →
  `PaymentError` with no key in the message; `POST /checkout` → 303 to Stripe, JSON → `{ url }`, already
  paid → back to the preview with no session, unconfigured → 503, Stripe failure → 502, cross-site → 403;
  the CSP `form-action` allows `https://checkout.stripe.com`.
- **Pages:**
  - Paid preview: no watermarks, the download link, the rewrite form, then a "rewrite used" note, the
    download deadline. The share image tree has no stamp.
  - The success-URL note.
  - `/legal`: terms, refunds, privacy, price, 30 days, Stripe. It's linked from the home and preview pages.
- **Wiring:** `depsFromEnv` with `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, and the unconfigured store
  failing loudly on the new methods. The dev server's offline checkout.
- **Migration:** databases created by M1 and by M2 get the M3 columns.

#### M2 — Share loop

**Starting point of that run.** The repo's single build commit (titled "M1") already contained M2: share
images, the report flow, the deletion job, and their tests, 193 in all, passing. The earlier session built
M2 straight after M1 but stopped before M2's pre-landing review, and the pipeline consumed its
`.provision`. So this run doesn't rebuild M2. It runs Step 0, the architecture review and the test review
again on the M2 code as it stands. It closes the gaps they find with tests first, writes `.provision` again,
and does the missing M2 review (see "Review").

Decisions made in this run:
- **Uploads also run the photo deletion**, at most hourly per instance (new; tests first in
  `expiry.test.js`). Before this, the only trigger was Vercel Cron, which needs `CRON_SECRET`, a value David
  has to set by hand, and a host with a scheduler. M3 may move hosts because Vercel Hobby bans commercial
  use. Without the cron, read-time expiry still hid old photos, but their bytes stayed. That breaks the
  PRD's "photo deleted after 30 days" promise, which M3's privacy page will repeat, and lets storage creep
  toward the 0.5 GB Neon limit, at which point every upload fails. The fix is one shared helper in
  `app.js`, about 15 lines.
- **Five small fixes from the review**, each test-first (details under Review):
  - HEAD on `share.png` no longer renders;
  - `/report` refuses cross-site requests for every content type, not only forms;
  - an oversized report form gets a page, not JSON;
  - the M1→M2 migration also repairs a half-upgraded database;
  - an upload waits at most 1 s for its deletion sweep.
- **`.scratch/` should go.** It holds the earlier session's throwaway experiments (scripts and two PNGs,
  ~700 KB), committed by accident and used by nothing. Deleting files isn't permitted in this sandbox, so
  it's now in `.gitignore` and listed under Review for the caller to `git rm`.
- Everything else in the plan below stands as written.

#### Step 0: Scope challenge (M2)

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
     - The same deletion after a successful upload, at most hourly per instance (added in this run).
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
   job runner or image service, would add files, not remove them. This run's change is one source file
   (`app.js`), one test file and config/docs, with no new service. The upload sweep reuses
   `store.expirePhotos`; it doesn't add a second deletion path.
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

#### 1. Architecture review (M2)

```
GET /p/:slug ─────────────▶ store.getPet ─▶ status(pet, now)
GET /p/:slug/photo                               │ live    → page / photo / PNG
GET /p/:slug/share.png[?size=story]              │ expired → 410 "expired" page   (expiredAt set, or created ≥ 30 days ago)
                                                 │ removed → 410 "taken down"     (reports ≥ 3)
            share.png (live, HEAD) ─▶ 200 + headers, no render
            share.png (live, GET) ─▶ store.getPhoto ─▶ share.renderSharePng(pet, photo, { size, host })
                                                     satori(tree) → SVG (glyph paths) → resvg-wasm → PNG
                                                     photo undecodable → re-render with a placeholder

POST /report {slug, reason} ─▶ refuse anything marked cross-site (Origin, Sec-Fetch-Site), any content type
                            ─▶ csrf (Origin host = our host, or Sec-Fetch-Site same-origin)
                            ─▶ reporter = first 24 bits of SHA-256(slug, client IPv4 or IPv6 /64)
                               (raw IP never stored)
                            ─▶ store.reportPet  INSERT … ON CONFLICT DO NOTHING + count, one statement
                            ─▶ 200 {reports} / thank-you page; 3rd distinct reporter hides the preview

Vercel Cron (daily 04:00 UTC) ─▶ GET /jobs/expire-photos  Authorization: Bearer $CRON_SECRET
                            ─▶ expireOldPhotos(now) = store.expirePhotos(now − 30 days, now):
                               photo = NULL, expired_at = now, and report rows older than 30 days
                               (hashed IPs) are deleted
POST /generate (after the record is saved) ─▶ expireOldPhotos(now), if this instance hasn't in the last
                               hour; waits at most 1 s for it; a failure is logged as a warning and the
                               upload still returns 200
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
    Hono's `csrf()` covers form content types. Since this run, a request marked cross-site by its `Origin`
    or `Sec-Fetch-Site` is refused whatever its content type, JSON included.
  - Reporter identity is the first 24 bits of SHA-256 over the slug and the client's network (one IPv4
    address, or one IPv6 /64). It isn't linkable across previews, can't be turned back into an address,
    and is deleted after 30 days.
  - The cron route fails closed (503) when `CRON_SECRET` is unset and compares in constant time.
  - All `/p/*` responses stay noindex. Share PNGs are `private` so no shared cache keeps serving a
    removed preview.
- **Production failure scenarios.**
  - The share render is slow or out of memory: about 0.5 s and ~50 MB per render here. wasm memory is
    freed after each render. A crash returns a 500 page and is logged (tested).
  - A photo resvg can't decode: placeholder, a warning in the logs, still 200 (tested).
  - Fonts or wasm missing from the deploy bundle: caught before deploy by the nft trace test.
  - The cron doesn't run (Hobby crons can fire late in their hour, the secret is missing, or a new host has
    no scheduler): photos past 30 days are still not served, because expiry is also enforced at read time
    (tested). The bytes are deleted by the next upload's sweep (tested, including with no `CRON_SECRET`),
    or by the next cron run if nobody uploads.
  - The upload sweep fails (a lock timeout or a Neon blip): it's logged as a warning, the upload still
    succeeds (tested), and the next sweep is an hour later on that instance. If it's slow, the upload
    answers after 1 s and the sweep finishes in the background (tested). Neon's HTTP driver has no
    timeout of its own.
  - Someone loops requests to `share.png` (~0.5 s CPU each): HEAD no longer renders (tested). GET still
    renders on every request, so this stays a quota risk until M3's rate limit (see Review).
  - A troll files 3 reports alone: they count once (tested).
  - A troll with 3 IPs, or a coordinated group: the preview is hidden until David restores it with
    `UPDATE pets SET report_count = 0 …`. Accepted for an MVP; listed under Review.
  - Hosts that don't set `X-Forwarded-For`: every reporter becomes "unknown", so previews can't be taken
    down there. Vercel sets the header. Documented.

#### 3. Test review (M2)

Each M2 exit criterion maps to tests. They are written first, against the routes above.

| Exit criterion | Tests |
|---|---|
| GET /p/<slug>/share.png returns an image of the stated dimensions | `share.test.js`: 1080×1350 by default and 1080×1920 with `?size=story` (PNG signature + IHDR); the real photo's pixels in the image (a real JPEG and a real PNG made at runtime); an undecodable photo still gives the right size; bad `size` → 400; unknown/malformed slug → 404; renderer failure → 500; private, noindex, nosniff headers; tree text (name, alias, charges, "Make your pet's at <host>", "FREE PREVIEW", headline in the story); nft trace includes the wasm and fonts. Added in this run: HEAD gets status and headers with no render (404/400/410 too) |
| POST /report flags the record; preview 410 after 3 reports | `report.test.js`: 3 distinct reporters → count 1, 2, 3 on the record, preview 200, 200, then 410 (and photo and share.png 410); same person ×3 counts once; JSON and form bodies; thank-you page; cross-site form post → 403; missing/malformed slug → 400; unknown slug → 404; unknown reason → `other`; the report form is on the preview page; raw IP never stored. Added in this run: a cross-site JSON post → 403 (same-origin JSON still 200); a body over 8 KB → 413, a page for a form post and JSON for a JSON client |
| The deletion job removes photos older than 30 days and the preview then shows an "expired" page | `expiry.test.js`: 31-day-old photo deleted and 29-day-old kept (memory store and PGlite); preview 410 with "expired" (noindex), photo and share.png 410; second run deletes 0; no `CRON_SECRET` → 503, wrong/missing token → 401; read-time expiry before the job runs; `vercel.json` schedules the job daily. Added in this run: an upload with no `CRON_SECRET` deletes the 31-day photo, keeps the 29-day one and the new upload, and the old preview shows "expired"; at most one sweep per hour per instance and none for a rejected upload; a failing sweep still returns 200 and logs a warning; a hanging sweep doesn't hold the upload; a photo deleted between the record and photo reads → 410 |

Other new code paths covered:
- **Store contract** (memory and PGlite): `reportPet` counts distinct reporters, returns null for an
  unknown slug and keeps the reason; `expirePhotos` removes only old photos, is idempotent and removes old
  report rows; `getPet` returns `reports` and `expiredAt`.
- **Postgres:** interleaved reports, upgrading a database created with the M1 schema (and, added in this
  run, a half-upgraded one: either M2 column missing, or `photo` still `NOT NULL`), and `createdAt`
  round-trips.
- **Wiring:** `depsFromEnv` passes `CRON_SECRET` through, and the unconfigured store fails loudly on the
  new methods too.
- **Views:** share links, the "Make your pet's" link, the report form, and the expired and removed pages
  are all escaped and noindex.

#### M1 — Free generator: Step 0, scope challenge

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

#### 1. Architecture review (M1)

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

#### 3. Test plan (M1)

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

## What the product does now (M1–M4)

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
   and a **character bio card** with traits. Until the bundle is paid for, each card is covered by an
   "alterpaw preview" watermark.
5. **New in M2, the share loop.** Under the cards, two buttons download the wanted poster as a PNG:
   - **Instagram post**, 1080×1350;
   - **Story, Reels or TikTok**, 1080×1920 (adds the front-page headline and more charges).

   Both images contain:
   - the real photo with a red "FREE PREVIEW" rubber stamp (dropped once the bundle is paid for);
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
   than 30 days. The preview then shows **410 "This preview has expired"**. New uploads run the same deletion
   too, at most once an hour per server instance, so photos still get deleted while `CRON_SECRET` isn't set
   or on a host without a scheduler. Previews past 30 days count as expired at read time as well, so a
   photo is never shown late even if no deletion has run.
9. **New in M3, the $9 unlock.**
   - **The offer.** Above the share buttons, an unpaid preview offers "Get the clean bundle: $9": all four
     cards as high-res images without the watermark, a printable PDF, and one free rewrite of the jokes.
     It links to `/legal`.
   - **Payment.** "Unlock for $9" posts to `/checkout`, which creates a Stripe Checkout Session and sends
     the buyer to Stripe's hosted page. Card details never touch alterpaw.
   - **Confirmation.** Stripe calls `/stripe/webhook` with a signed `checkout.session.completed`, which marks
     the preview paid, once. The buyer returns to `/p/<slug>?checkout=success`. If the webhook hasn't arrived
     yet, the page says "We're confirming your payment with Stripe" with a refresh link.
   - **The paid preview:**
     - the watermarks and the share images' "FREE PREVIEW" stamp are gone;
     - a green "Your bundle is ready" box links to `bundle.zip` and gives the download deadline (30 days
       after upload, when the photo is deleted);
     - it offers the one rewrite.
   - **The bundle** (`/p/<slug>/bundle.zip`, about 1–2 MB for a typical photo):
     - `alterpaw-1-wanted-poster.png`, `alterpaw-2-front-page.png`, `alterpaw-3-trading-card.png` and
       `alterpaw-4-character-bio.png`, each 1800×2250 px (8×10 in at 225 dpi) with the real photo;
     - `alterpaw-bundle.pdf`, the same four as 8×10 in pages.

     Before payment, that URL answers **402** with the offer.
   - **The rewrite.** "Rewrite the jokes" asks the model for new text from the same name, species, traits and
     alter ego, and replaces the old text on the cards, the share images and the next bundle. It works once
     (409 after that). A model failure doesn't use it up.
   - **`/legal`.** One page with terms, refunds (14 days, by replying to the Stripe receipt) and privacy:
     what's stored, for how long, and which processors see what.
10. **New in M4: buy it as a gift.** The home page tells gift buyers to upload a photo of the *recipient's*
    pet. An unpaid preview's $9 offer then has a second option, **"Or buy it as a gift"** (a no-JavaScript
    `<details>` form). The buyer gives:
    - the recipient's email and, optionally, their name;
    - their own name and an optional message (300 characters);
    - the delivery date and its time zone. The zone is pre-selected from Vercel's `x-vercel-ip-timezone`, or
      New York with no header. Any date from today up to about a week before the photo is deleted is allowed.

    Then:
    - **Payment.** The buyer pays $9 on Stripe. The signed webhook marks the gift order paid and unlocks the
      preview, so the buyer can download the bundle too.
    - **Delivery.** The gift is due at the first instant of that date in that zone. The daily job
      (`/jobs/deliver-gifts`, 16:00 UTC, which is on the date in every time zone) emails the recipient
      **once**, through Brevo, with:
      - the buyer's message;
      - the link to the unlocked preview;
      - the download deadline.

      It works through every gift due, in batches, up to Brevo's free 300 a day. A gift dated today goes the
      moment it's paid. Nothing is ever sent for an unpaid gift.
    - **Failures.**
      - A send that fails for a moment is retried by the next run, without holding up the other gifts.
      - Three failures in a row look like an outage: the run stops and leaves the rest for the next run.
      - Two things cancel the gift and log it for a refund: Brevo refusing the recipient's address, or the
        preview being taken down before the date.
      - Any other refusal, such as an unverified sender, is retried once the setup is fixed. It never
        cancels.
      - In "Your orders", a cancelled gift reads "Not sent: we couldn't deliver the email … It will be
        refunded."
    - **"Your orders".** A box at the top of the preview says "We'll email j•••@example.com on Tuesday,
      October 20, 2026", then "Emailed … on October 20". The address is masked because anyone with the link
      sees the page.
11. **New in M4: the printed poster.** A paid preview offers **"Hang it on the wall: a printed poster, $29"**:
    the wanted poster on 12×16 in matte art paper, shipped to a US address (shipping included).
    - **The form.** Name, street, optional second line, city, state and ZIP. An incomplete or invalid address
      is a **400** that names each field, and nothing is stored or charged. A field that's blank, only
      invisible characters (a zero-width space), or not text at all counts as missing.
    - **Payment.** After the $29 Stripe payment, the webhook places **one** Prodigi print-on-demand order with
      the stored address, and stores Prodigi's order id. Prodigi fetches the print file, a 3600×4800 px PNG
      (300 dpi), from `/prints/<order id>/poster.png`.
    - **"Your orders"** says "Sent to the printer, shipping to Portland, OR" (the city only, not the street).
12. **Off until configured.** The gift form appears only when Brevo, `CRON_SECRET` and Stripe are set, and
    the print form only when Prodigi and Stripe are. A direct post answers 503, so nothing is ever sold that
    can't be delivered.
13. **Retention.** The 30-day job also erases each order's personal details: the recipient's email and name,
    the message, and the shipping address.

### API

| Method | Path | Result |
|---|---|---|
| GET | `/` | Upload form |
| POST | `/generate` | multipart: `photo` (file), `name`, `species`, `traits` (1–3, repeated), `alterEgo` (id or label). **200** `{ slug, url, pet, character }` · **400** `{ error }` bad photo or field (model not called) · **502** `{ error }` model failed or returned bad JSON (nothing stored) · **500** `{ error }` storage failed |
| GET | `/p/:slug` | Preview page (noindex, `Cache-Control: private, no-store`) · **404** unknown · **410** expired or taken down |
| GET | `/p/:slug/photo` | The stored photo with its sniffed type · 404 · 410 |
| GET | `/p/:slug/share.png` | Wanted-poster PNG, 1080×1350; `?size=story` gives 1080×1920 · **400** other `size` · 404 · 410. `private, max-age=600`, noindex. HEAD gives the same status and headers without rendering |
| POST | `/report` | Form or JSON: `slug`, `reason` (`not-a-pet` / `offensive` / `my-photo` / `other`; anything else → `other`). Same-origin only, for every content type (403 otherwise). **200** thank-you page, or `{ ok, reports }` for JSON · **400** missing or malformed slug or body · **404** unknown slug · **413** body over 8 KB (a page for forms, JSON for JSON) |
| GET | `/jobs/expire-photos` | `Authorization: Bearer $CRON_SECRET`. **200** `{ deleted }` · **401** wrong or missing token · **503** `CRON_SECRET` not set · **500** storage failed |
| GET | `/p/:slug/bundle.zip` | **M3.** Paid: **200** `application/zip` attachment `alterpaw-bundle.zip` (4 PNGs at 1800×2250 and a 4-page PDF), streamed with a `Content-Length`, `private, no-store`, noindex · **402** before payment, a page with the pay form (JSON `{ error, checkout }` for JSON clients) · 404 · 410 · **500** render failed. HEAD gives the status and headers without rendering |
| POST | `/checkout` | **M3.** Form or JSON: `slug`. Same-origin only (403). **303** to Stripe Checkout (JSON: `{ url }`); the session closes after 24 h or when the preview expires, whichever is sooner · **303** back to `/p/:slug` if it's already paid · **400** missing or malformed slug · 404 · **410** expired, taken down, or under an hour from expiry · **502** Stripe failed · **503** `STRIPE_SECRET_KEY` not set |
| POST | `/stripe/webhook` | **M3.** Stripe only: raw JSON with a `Stripe-Signature` header. The preview comes from `metadata.slug` only, and the session must be $9 in `usd`. **200** `{ received: true }` for every verified event, including ignored types, unpaid sessions, other amounts, and unknown or no-longer-live previews (all logged for a refund or a check) · **400** missing, invalid or stale signature, or a signed body that isn't an event · **413** over 256 KB · **503** `STRIPE_WEBHOOK_SECRET` not set · **500** storage failed (Stripe retries) |
| POST | `/regenerate` | **M3.** Form or JSON: `slug`. Same-origin only (403). **200** `{ ok, character }` (form: **303** to the preview) · **402** not paid · **409** the one rewrite is used · **502** model failed (the rewrite is still available) · 400 · 404 · 410 · 500 |
| GET | `/legal` | **M3.** Was terms, refunds and privacy on one page. **Go-live:** a 301 to `/terms` |
| GET | `/terms`, `/privacy` | **Go-live.** Terms (refunds, no warranty, contact) and privacy (what's stored, processors, no cookies, the visit counter's three events). Indexable, with search and sharing tags (see LAUNCH-READY.md) |
| GET | `/robots.txt`, `/sitemap.xml` | **Go-live.** Allow all, point at the sitemap; the sitemap lists `/`, `/privacy`, `/terms` on the canonical origin (`VERCEL_PROJECT_PRODUCTION_URL`, else the request's) |
| GET | `/og.png` | **Go-live.** The 1200×630 link-preview image, drawn by `renderOgPng` (share.js), rendered once per instance, `public, max-age=86400`, `Cross-Origin-Resource-Policy: cross-origin` |
| GET | `/beacon.js` | **Go-live.** The RepoHQ visit beacon (`src/site.js`); pages load it only when `VERCEL_ENV=production` |
| POST | `/gift` | **M4.** Form or JSON: `slug`, `recipientEmail`, `recipientName` (optional, ≤ 40), `fromName` (≤ 40), `message` (optional, ≤ 300), `deliverOn` (`YYYY-MM-DD`), `timeZone` (IANA; absent means UTC). Same-origin only (403). **303** to a $9 Stripe Checkout (JSON: `{ url }`) · **303** back to `/p/:slug` if already paid · **400** `{ error }` or a page, for any invalid field (nothing stored, nothing charged) · 404 · **410** expired, taken down or under an hour left · **502** Stripe failed · **503** Brevo, `CRON_SECRET` or Stripe not set |
| POST | `/print` | **M4.** Form or JSON: `slug`, `name`, `line1`, `line2` (optional), `city`, `state` (two-letter US code), `zip` (5 or 9 digits), `country` (optional, `US` only). Same-origin only (403). **303** to a $29 Stripe Checkout (JSON: `{ url }`) · **400** `{ error, fields }` naming every bad field, or a page listing them (nothing stored, nothing charged) · **402** preview not paid · 404 · 410 · 502 · **503** Prodigi or Stripe not set |
| GET | `/prints/:id/poster.png` | **M4.** The print file Prodigi fetches: 3600×4800 PNG, streamed with a `Content-Length`, `private`, noindex. Only for a **paid print order** on a live preview; **404** otherwise, **410** if the preview expired or was taken down. HEAD doesn't render |
| GET | `/jobs/deliver-gifts` | **M4.** `Authorization: Bearer $CRON_SECRET`. Emails every paid gift that is due, once. **200** `{ sent, failed, cancelled }` · **401** · **503** `CRON_SECRET` or Brevo not set · **500** storage failed |
| POST | `/stripe/webhook` (M4 additions) | A session with `metadata.order` is a gift or print. The order must exist, belong to `metadata.slug` and match its amount in `usd` (else 200 and a "check/refund" log). Then: paid once; a gift unlocks the preview and is emailed at once if it's due; a print is placed with Prodigi unless it already was. **500** on a transient Brevo or Prodigi failure, so Stripe retries |
| GET | `/styles.css`, `/upload.js` | Page assets |

## Run it locally

```sh
npm install
npm test          # 436 tests (about 45 s), no network, no keys, no database, no Stripe, Brevo or Prodigi account
                  # Node 22.2 or later (zlib.crc32)
npm run dev       # http://localhost:3000
```

With nothing set, `npm run dev` keeps previews in memory and writes canned demo text. "Unlock for $9", "Buy it as a
gift" and "Order the poster" are paid on the spot, with no Stripe involved. The dev server signs a paid Checkout
Session and posts it to its own `/stripe/webhook`, so the real fulfilment code runs. Gift emails and print orders
are printed in the terminal instead of being sent or placed, and gift delivery runs every minute in-process. So the
whole flow works offline: the bundle, the rewrite, gifts and prints. To use the real services, export them in your
shell first. Never put them in a committed file.

| Variable | Needed for | Default |
|---|---|---|
| `DATABASE_URL` | saving previews (Postgres; Neon free tier in production) | in-memory store in dev; required in production |
| `GOOGLE_API_KEY` | the model (Gemini API free tier) | canned demo text in dev |
| `LLM_BASE_URL` | another OpenAI-compatible endpoint, e.g. a LiteLLM proxy (`http://localhost:4000/v1`) | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `LLM_API_KEY` | key for `LLM_BASE_URL` (takes precedence over `GOOGLE_API_KEY`) | none |
| `LLM_MODEL` | model name | `gemini-flash-latest` |
| `CRON_SECRET` | authorising `GET /jobs/expire-photos` (Vercel Cron sends it as a Bearer token) | unset, so the job answers 503 |
| `STRIPE_SECRET_KEY` | creating Checkout Sessions (a test-mode restricted key is enough) | unset: `/checkout` answers 503 in production; the dev server fakes the payment |
| `STRIPE_WEBHOOK_SECRET` | verifying `/stripe/webhook` events | unset, so the webhook answers 503 |
| `BREVO_API_KEY` | **M4.** Sending gift emails (Brevo v3 API key, free plan) | unset: no gifts in production; the dev server prints the email |
| `EMAIL_FROM` | **M4.** The sender, a bare address verified in Brevo (`gifts@…`, no display name) | unset: no gifts |
| `PRODIGI_API_KEY` | **M4.** Placing printed-poster orders (a Prodigi **sandbox** key until going live) | unset: no prints in production; the dev server prints the order |
| `PRODIGI_ENV` | **M4.** `live` sends orders to Prodigi's live API (real prints, real charges) | anything else: the sandbox |
| `PORT` | dev server port | `3000` |

The tables are created on first use, and a database created by M1, M2 or M3 is upgraded in place. That's one
idempotent `DO $$ … $$` statement in `src/store.js`. M4 adds the `orders` table to it.

Trying M4 locally:
- **A gift:** make a preview, open "Or buy it as a gift", fill it in with a delivery date, and press "Buy it as a
  gift for $9". You come back to the unlocked preview with "Your orders: We'll email …". Pick today's date to
  see the email printed in the terminal at once. A later date prints when the in-process job finds it due,
  which you can't fast-forward locally; the tests do it with a fixed clock.
- **A print:** on a paid preview, open "Order the printed poster", give a US address and order. The terminal
  shows the order that would go to Prodigi and the print file URL. Open that URL to see the 3600×4800 poster
  (it takes about 4 s to render).
- **An incomplete address:** leave out the ZIP (remove the `required` attribute in the browser's dev tools,
  or `curl` it). You get a 400 page that names the field, and nothing is stored.
- **With Prodigi's sandbox:** export `PRODIGI_API_KEY` (a sandbox key), and orders go to Prodigi's sandbox
  for real. Prodigi needs a **public** print file URL, though, so a local server's `localhost` URL will make
  Prodigi report an asset error. Use a deployed preview for a full round trip.

Trying M3 locally:
- **Offline:** make a preview, press "Unlock for $9" (the dev server marks it paid), then "Download the
  bundle" and "Rewrite the jokes". Before unlocking, `/p/<slug>/bundle.zip` shows the 402 page.
- **With Stripe test mode:**
  - Export a test-mode `STRIPE_SECRET_KEY` and run `stripe listen --forward-to localhost:3000/stripe/webhook`
    (the Stripe CLI, free).
  - Export the `whsec_…` value it prints as `STRIPE_WEBHOOK_SECRET`, then start `npm run dev`.
  - Pay with Stripe's test card `4242 4242 4242 4242` (any future expiry and CVC). The CLI forwards the
    signed event, and the preview unlocks.
  - The fake checkout is only used with the in-memory store and no Stripe key.

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
README (`docs/screenshots/`). It is separate from `npm test`.

**Go-live run (current).** The shots now prove the launch-ready site rather than the M4 flows:
- **What it captures:** the filled-in form; the end of the form with the footer's Privacy · Terms links; the
  watermarked result; the $9 offer with the "Unlock for $9" Buy button; and the free preview's two share
  images.
- **What it checks:** that the footer links answer, that the Buy button is visible and that the four cards are
  watermarked.
- **Environment:** it also strips `VERCEL_ENV` and `VERCEL_PROJECT_PRODUCTION_URL` from the child's
  environment.
- **The M4 path:** the gift and print flows are no longer clicked through here; `npm test` covers them.

The notes below are from the M4 run and still describe how the script works:
- **Starts `scripts/dev.js` itself** on a free port and stops it afterwards. There is no build step, so the
  dev server is the production code path (same `createApp`). `DATABASE_URL`, the model variables,
  `CRON_SECRET` and every Stripe, Brevo and Prodigi variable are removed from the child's environment. So a
  screenshot run never touches a real database, model, payment, mailbox or printer, even if the shell has them
  exported. The text on the cards is the dev server's canned demo writer; the README says so.
- **Goes through the real flow** in Chromium (`playwright-core`, `executablePath: CHROMIUM_PATH`, never a
  downloaded browser), at 1280×800 and as an iPhone 13:
  - it fills the form, uploads a photo through the file input (shrunk by the page's own script), submits and
    waits for the preview;
  - **M4:** it fills in the gift form (sample people at `example.com`, a date six days ahead) and buys it;
  - then it orders the printed poster to a fictional address. Both go through the dev checkout and the real
    webhook;
  - it checks the "Your orders" box says the gift is scheduled and the poster went to the printer, then
    fetches `share.png`.
- **What each file shows (M4 run).** This sandbox can't delete files, and there may be at most six PNGs. So
  the six existing names were kept and given the M4 content their names still describe:
  - `preview-mobile.png` is the gift form filled in (the core action);
  - `preview-desktop.png` is the paid preview with "Your orders" over the clean cards (the result);
  - `share-*` are the share images of the now-paid preview, with no stamp.
- **Sample photo:** a cartoon beagle drawn as SVG in the script and rasterised to JPEG by the browser at run
  time. No real pet or person, and no binary fixture in the repo.
- **Share image framing:** the PNG bytes come from the app, but they're shown on a blank page, centred and
  fitted. Chromium's own image viewer pins the image to the left on desktop and lays it out 980px wide on a phone.
  The footer reads `localhost:<port>` because the image prints the requesting host; in production it's the
  real domain.
- **Fonts:** the sandbox Chromium falls back to a monospace face for `system-ui`, so the page text looks
  typewritten. Real phones and desktops use their own system font, so the CSS was left alone.
- **This run (M4, second pass):** the six PNGs were regenerated after the fixes and each was opened and
  checked by eye. The run went through the real flow: the home form; the gift form, filled in for a date six
  days ahead; the paid preview with "Your orders" (gift scheduled, poster at the printer); and both share
  images. None of this run's fixes changes what those screens show. The cancelled-gift wording only appears
  after Brevo refuses an address, which the tests cover.
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
  answers 503 and logs why. Deletion doesn't depend on the cron alone. Each upload also runs it, at most
  hourly per instance, so bytes are deleted whenever the site is in use. Expiry is enforced at read time
  as well, so a missed run never shows an old photo.
- **Bundle downloads (M3).**
  - **Rendering.** The bundle renders in the same function: four cards at about 0.75 s each, then the
    PNG and PDF encoding on the thread pool. That's about 3.5–4 s here. Vercel's default duration with Fluid
    compute (300 s) leaves plenty of room, so `vercel.json` sets nothing.
  - **Size.** The zip is about 1–2 MB for an ordinary photo; a very busy photo can reach 10–20 MB. It's
    streamed because Vercel caps *buffered* function responses at 4.5 MB.
  - **Deploy bundle.** `bundle.js`, `files.js` and `payments.js` reach it through the lazy `import()` in
    `app.js`, and the nft test checks they do.
- **Stripe (M3).**
  - **Credentials.** David creates the account and the webhook endpoint, and the pipeline stores
    `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` (see Infrastructure). The webhook endpoint is
    `https://<production domain>/stripe/webhook`, for `checkout.session.completed` and
    `checkout.session.async_payment_succeeded`.
  - **Cost.** Stripe has no monthly fee; it takes a per-payment fee (2.9% + 30¢ on US cards at the time of
    writing, so about 56¢ of each $9).
  - **Rehearse in test mode first.** Pay with `4242 4242 4242 4242` and check:
    - the preview unlocks;
    - the bundle downloads;
    - the rewrite works once;
    - Stripe → Developers → Webhooks shows 200s.
- **Gifts (M4).**
  - **The job.** `vercel.json` registers a second daily cron, `0 16 * * *` → `/jobs/deliver-gifts`. Hobby
    allows 100 crons per project, each at most daily. It needs `CRON_SECRET` like the deletion job; without
    it, the gift form is hidden.
  - **Email.** Brevo's free plan: 300 emails a day, no card. David verifies one sender address and the
    pipeline stores `BREVO_API_KEY` and `EMAIL_FROM` (see Infrastructure). With no domain of our own, Brevo
    shows the sender as `…@brevosend.com`, and its free plan adds a "Sent with Brevo" footer. Both are fine
    for the 100-visitor test, but deliverability is better with an authenticated domain, which costs money
    (What's left).
  - **Timing.** A gift is due at local midnight on its date. Hobby fires a daily cron anywhere from :00:00 to
    :59:59 of its hour (Vercel's docs), so local midnight must never fall inside that hour. If it did, a run
    that fired early would miss the gift and the next run could be the day after. **16:00–16:59 UTC is the
    only hour of the 24 that's on the date in every IANA zone, every day of the year.** That's tested against
    every zone Node knows. Every other hour misses somewhere: 14:00, the first build's choice, missed Darwin
    (UTC+9:30) all year and Adelaide in winter. Whole-hour hours also miss on DST-change days, when midnight
    lands exactly on the hour's edge.
    - **Local times:** a gift arrives around noon in New York (11 am in winter), 9 am in Los Angeles, 5 pm in
      London, 1 am in Tokyo and 3 am in Sydney. The US, where the prices and shipping are, gets daytime;
      Asia-Pacific gets the email overnight, still on the date.
    - **A gift for today** paid after that day's run goes at once, from the webhook.
- **Printed posters (M4).**
  - **The printer.** Prodigi: the account is free, and it charges per order. David creates the account and
    the pipeline stores a **sandbox** `PRODIGI_API_KEY`. Sandbox orders are never printed or charged, which
    matches Stripe test mode.
  - **The product.** `GLOBAL-FAP-12X16`, enhanced matte art paper, 12×16 in, `Standard` shipping, US
    addresses only.
  - **Unit economics.** These are unverified. The research put a poster plus US shipping at about $10–$15,
    so $29 leaves roughly $12–$17 before Stripe's ~$1.14. Check Prodigi's price for this SKU in its dashboard
    before going live.
  - **The print file** renders in the function when Prodigi fetches it: 3600×4800 px at 300 dpi. Measured
    here with a worst-case noise photo, it takes about 4.9 s and about 650 MB RSS, and makes a 9.7 MB PNG.
    That fits Hobby's 2 GB and 300 s. It's streamed with a `Content-Length` because of the 4.5 MB
    buffered cap, and it renders once per order.
  - **The URL.** Prodigi must reach `https://<production domain>/prints/<order id>/poster.png`. The domain
    is whatever host the buyer used, stored with the order, so a print paid on a protected Vercel preview
    deployment would give Prodigi a URL it can't fetch. Prints are only for production.

**Before Stripe goes live (real money):** Vercel Hobby forbids commercial use (the roadmap and review both flag
this). **Test-mode payments on Hobby are fine; live mode is not.** Go-live checklist:
1. Settle the host (requested in `.provision`; David's call). Either put the Vercel project on a plan that
   allows commercial use (paid, so outside the $0 rule) or move to a free host that allows commercial use
   and gives a request ~4 s of CPU and ~200 MB of memory.
2. Swap both Stripe values for live-mode ones. The live webhook endpoint has its own signing secret.
3. Turn on Stripe's "Successful payments" customer emails. `/terms` tells buyers to reply to the receipt
   for refunds, so receipts must go out with a support email that reaches David.
4. Re-read `/terms` and `/privacy` (`termsPage` and `privacyPage` in `src/views.js`; `/legal` redirects to
   `/terms` since go-live): the 14-day refund promise, the no-warranty section and the processor list are
   David's to confirm. M4 adds the gift and print terms, a 30-day reprint-or-refund promise for posters,
   and Brevo and Prodigi as processors.
5. **M4:**
   - Prodigi: swap in the live key, set `PRODIGI_ENV=live`, and add a payment card in Prodigi's dashboard
     (it bills per order);
   - place one real order to yourself first.
   - In test mode, buy one gift dated *today* for your own address. It's emailed at payment, which proves
     the Brevo sender is verified before any real gift depends on it. A sender problem is now retried, not
     cancelled, but every gift would still be late until it's fixed.
   - Sales tax on a physical product is David's call: Stripe Tax is a paid add-on, and nothing in the code
     collects tax.

The app is a plain fetch handler, so moving hosts is small:
- **Cloudflare Workers (free plan, commercial use allowed):**
  - Add a `wrangler.toml` with `main = "src/index.js"` and `compatibility_flags = ["nodejs_compat"]`
    (fills `process.env`), then set the same secrets. The Neon HTTP driver works there unchanged.
  - Two M2 changes come with it. Workers can't compile wasm from bytes or read files, so `share.js` must
    import `index_bg.wasm` and the fonts as modules (wrangler bundles them). And a Cron Trigger in
    `wrangler.toml`, calling the same route with the header, replaces `vercel.json`.
  - Check the CPU limit too: the Workers free plan allows 10 ms of CPU per request, far below a 0.5 s
    render (or a 4 s bundle), so share images and bundles need the paid plan or another host. M3's
    `files.js` also uses `node:zlib` (`deflate`, `crc32`); `nodejs_compat` provides both.
- **Any Node host (Render free, Fly):** run `@hono/node-server` the way `scripts/dev.js` does; everything
  works unchanged. Uploads already run the deletion. For quiet periods, call the job from any scheduler
  (for example a GitHub Actions `schedule`) with `curl` and the bearer header.

**Model cost.** The Gemini API key is free only if its Google Cloud project has no billing account. If billing
is on, each generation costs well under $0.01, which is still far below the PRD's $0.10 per-order cap.
Free-tier rate limits are small: roughly ten requests a minute and a few hundred a day for Flash at the time
of writing, but check AI Studio for current numbers. That's enough for the 100-visitor test, not for a viral
spike. On quota errors users get a 502 "try again in a minute". To change provider, set `LLM_BASE_URL`,
`LLM_API_KEY` and `LLM_MODEL`; no code change is needed.

## Operations (M2–M4)

Run these in the Neon SQL editor. They're plain SQL, so you never need the connection string in a terminal.
- **Orders (M4):**
  `SELECT id, slug, kind, amount_cents, paid_at, deliver_at, sent_at, cancelled_at, pod_order_id FROM orders WHERE paid_at IS NOT NULL ORDER BY paid_at DESC;`
  Stripe shows the same id as `metadata.order` on each payment, and Prodigi shows it as the merchant reference.
- **Gifts still to send (M4):**
  `SELECT id, slug, deliver_at, claimed_at FROM orders WHERE kind = 'gift' AND paid_at IS NOT NULL AND sent_at IS NULL AND cancelled_at IS NULL ORDER BY deliver_at;`
  - **Send a due one now:** call the job with the bearer header (or Vercel → Cron Jobs → "Run").
  - **Change a date:**
    `UPDATE orders SET deliver_at = '2026-12-25 00:00 America/New_York', details = jsonb_set(details, '{deliverOn}', '"2026-12-25"') WHERE id = '…' AND sent_at IS NULL;`
  - **Stop one:** `UPDATE orders SET cancelled_at = now() WHERE id = '…' AND sent_at IS NULL;`, then refund it.
  - **Resend one** (it bounced, or the recipient lost it): `UPDATE orders SET sent_at = NULL, claimed_at = NULL WHERE id = '…';`
- **Paid prints Prodigi doesn't have (M4):**
  `SELECT id, slug, paid_at FROM orders WHERE kind = 'print' AND paid_at IS NOT NULL AND pod_order_id IS NULL;`
  Each one has a log line saying why: `print: … not placed yet` (Stripe is still retrying) or `Prodigi refused
  order …` (fix it in Prodigi or refund).
- **The log lines that mean "refund"** name the order id, never the person:
  - `gift: order … not sent: …; refund it in Stripe`;
  - `print: Prodigi refused order …`;
  - `payment: … is a second payment, refund it in Stripe`.
- **Gift log lines that mean "fix the setup" (M4):**
  - `gift: order … not sent yet (brevo responded 400 (not about the recipient: check that EMAIL_FROM is a
    verified Brevo sender))`. Brevo is refusing *our* message: usually `EMAIL_FROM` isn't a verified sender.
    Fix it in Brevo; the gifts are retried by the next run (or run the job by hand).
  - `brevo responded 401`: a wrong key, or Brevo's "Authorised IPs" setting. Vercel's IPs change, so turn
    that setting off.
  - `gift: order … was emailed but not recorded as sent`. The database failed right after Brevo took the
    email. Run `UPDATE orders SET sent_at = now() WHERE id = '…';` so a later run doesn't send it again.
- **Paid previews (M3):**
  `SELECT slug, name, paid_at, stripe_session, regenerated_at FROM pets WHERE paid_at IS NOT NULL ORDER BY paid_at DESC;`
  The Stripe dashboard shows the same slug in each payment's metadata, so either side finds the other.
- **Refunds (M3):** refund in the Stripe dashboard. Access isn't revoked; it's $9 and the photo goes after 30
  days anyway. The log names payments to refund:
  - `payment: … is a second payment, refund it in Stripe` (someone paid twice);
  - `… names no valid preview` or `… is for unknown preview` (should never happen).
- **Unlock a preview by hand** (e.g. paid by other means):
  `UPDATE pets SET paid_at = now(), stripe_session = 'manual' WHERE slug = '…' AND paid_at IS NULL;`
- **Give a buyer a second rewrite:** `UPDATE pets SET regenerated_at = NULL WHERE slug = '…';`
- **Reported previews:**
  `SELECT slug, name, report_count, created_at FROM pets WHERE report_count > 0 ORDER BY report_count DESC;`
  (why: `SELECT reason, count(*) FROM reports WHERE slug = '…' GROUP BY reason;`). The function log also
  prints `report: preview <slug> reached 3 reports` when one is hidden. Hobby keeps logs only briefly, so
  run the query every few days until there's an email alert (see Review).
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
| The deletion job removes photos older than 30 days and the preview then shows an "expired" page | ✅ passing (`test/expiry.test.js`, on the memory store **and** PGlite). The 31-day photo is gone, the 29-day one is kept; the preview is 410 "expired" and noindex. Also tested: a second run deletes 0, the exact 30-day boundary, read-time expiry before the job runs, and auth (401/503). New in this run: uploads run the same deletion without `CRON_SECRET` (hourly per instance, never failing the upload). |

The M2 deliverables beyond the criteria are tested too:
- the "make your pet's" link on each preview and in each share image (`share.test.js`);
- the report link on each preview (`report.test.js`);
- the daily cron in `vercel.json` (`expiry.test.js`).

The share images were also checked by eye here. Renders with a typical pet and with every field at its
maximum length fit both formats, with no overflow and no clipped text.

## Exit criteria (M3)

| Exit criterion | Status |
|---|---|
| Before payment, the download endpoint returns 402 and previews are watermarked | ✅ passing (`test/bundle.test.js`). `bundle.zip` is 402 for an unpaid preview: a page with the pay form, JSON for JSON clients, HEAD too, and nothing is rendered. The unpaid preview has all 4 watermarks, and both share images keep "FREE PREVIEW". |
| A signed `checkout.session.completed` webhook marks the order paid; a repeated or unsigned one changes nothing | ✅ passing (`test/payments.test.js`, plus the store contract on memory **and** PGlite). Signed → paid, with the session stored. The same event again (byte for byte, and re-signed later) → the record is identical. A second session for the paid preview → unchanged, with a refund warning. No header, a wrong secret, a tampered body, a malformed header or a stale timestamp → 400, unpaid. Also tested: no secret configured, unpaid sessions, `async_payment_succeeded`, other event types, unknown slugs, a store failure, an oversized body and interleaved payments. Added after the review: another amount or currency, `client_reference_id` without `metadata.slug`, and a payment landing on an expired or taken-down preview (recorded, logged for a refund). |
| After payment, `GET /p/<slug>/bundle.zip` returns the 4 images and a PDF without a watermark | ✅ passing (`test/bundle.test.js`, real render). The zip has exactly 4 PNGs at 1800×2250 and a PDF; its CRCs and offsets are checked by a separate reader and by fflate. The photo is drawn whole on every card: the test shows the same check fails on the stamped free image. No card tree has "preview" or watermark text. The PDF has 4 pages of 8×10 in, each exactly its PNG's pixels, with no text drawn. |
| `POST /regenerate` succeeds once for a paid order and returns 409 the second time | ✅ passing (`test/regenerate.test.js`). The first call → 200, and the new text is stored and shown. The second → 409 with no model call. Also tested: unpaid → 402 with no model call; a model failure or bad JSON → 502 with the rewrite still available; two at once → one 200 and one 409; form posts → 303; cross-site → 403. |

The M3 deliverables beyond the criteria are tested too:
- **Stripe Checkout at $9:** the exact Stripe request, the 303 to Stripe, already-paid, unconfigured and
  Stripe-down cases, and the CSP `form-action` that lets the redirect happen (`payments.test.js`).
- **The paid page:** no watermark, the download link and deadline, the rewrite button, then "rewrite is
  used" (`bundle.test.js`, `regenerate.test.js`).
- **`/legal`** and its links (`payments.test.js`).
- **Env wiring and the dev server's offline checkout** (`config.test.js`).
- **Over a real socket through the Node adapter** (`http.test.js`): the pay form's 303 to Stripe, a signed
  webhook, then a 6 MB bundle that arrives whole with a matching `Content-Length`. It's above Vercel's
  4.5 MB buffered cap, so this checks the streamed path end to end.

All four cards were checked by eye at 1800×2250 with a typical pet and with every field at its maximum
length. Two layout fixes came out of that:
- the newspaper's second column lost text at 1,200 characters, so it now has smaller type and 15 lines;
- 24-character stat labels were cut short, so the label column is wider.

The PDF was checked with the repo's xref-validating reader only. No PDF viewer is installed in this sandbox
(see "Not verified").

## Exit criteria (M4)

| Exit criterion | Status |
|---|---|
| A gift order with a delivery date in the future sends nothing before that date and one email on it | ✅ passing (`test/gift.test.js`, fixed clock).<ul><li>Gift form → 303 to a $9 Checkout. A signed webhook marks the order paid and unlocks the preview, with **no email** at payment.</li><li>The daily runs on October 15 and 19, and one at 23:59:59.999 on October 19 in New York, send nothing. The run at midnight on October 20 in New York sends exactly one email to the recipient, with the link and the message.</li><li>Runs later that day, the next day and on November 1 send nothing more.</li></ul>**New in the second pass: on the date in every time zone, whenever in its hour Vercel fires the run.** The gift job's hour is read from `vercel.json` (now 16:00 UTC). It's checked at both edges of that hour against all 418 IANA zones, every day for a year, and end to end through the app in ten half-hour, quarter-hour and extreme zones (Darwin, Eucla, Kolkata, Kathmandu, Chatham, St John's, Marquesas, Kiritimati, Pago Pago, New York), with runs at the top of the hour, the end, and alternating: exactly one email, on the date. The old 14:00 run failed this in Darwin, Adelaide and Broken Hill.<br>**Also new in the second pass:** 121 gifts due on one day → all but a deliberately stuck one emailed in that day's run (it used to stop at 50), the stuck one tried once; an outage → at most 5 tries, then every gift sent once by the re-run; one gift's database error fails only that gift; "sent" not recordable after the email went → no second email that day; a Brevo 400 about our sender is retried, not cancelled.<br>Also: the same with Tokyo and Los Angeles against the scheduled run; a gift for today (sent at payment, once, even when Stripe repeats the event); a transient failure (retried, then one email); a permanent one (cancelled, logged for a refund); three concurrent runs (one email); a run that died after claiming (the lease expires, one email); unpaid (never); taken down (never, refund logged); a wrong amount or an order for another preview (nothing). The claim, lease, release, sent and cancel paths are in the store contract on memory **and** PGlite, with an interleaved claim. |
| A print order creates one print-on-demand order with the stored shipping address and rejects an incomplete address with 400 | ✅ passing (`test/print.test.js`).<ul><li>Paid preview → `/print` → 303 to a $29 Checkout. The address is stored before payment, and nothing is printed before it.</li><li>The signed webhook calls the printer **once**, with exactly the stored address, the order id and the print file URL. The Prodigi id is stored.</li><li>The event repeated three times, or three deliveries racing, still make **one** Prodigi order (the fake dedupes by order id, as Prodigi does by idempotency key).</li><li>Each of name, street, city, state and ZIP missing, empty or blank → **400** naming that field (JSON `fields`, or a page), with no order stored and no Stripe call. A bad ZIP, state, country or length → 400 too.</li><li>New in the second pass: a JSON field that isn't text (null, a number, a list, an object), or one made only of invisible characters (zero-width space, Hangul filler, word joiner; these used to pass), counts as missing → 400 naming it. On Postgres (PGlite), an address with a broken UTF-16 character is stored instead of failing with a 500.</li></ul>Also: unpaid → 402; no printer → 503; a Prodigi outage → 500, then one order on Stripe's retry; a permanent refusal → 200 and a refund log; the Prodigi request itself (sandbox URL, `X-API-Key`, recipient mapping, `GLOBAL-FAP-12X16`, `fillPrintArea`, asset URL, `alterpaw-<id>` idempotency key, `AlreadyExists`) and its error classes with no key in any message; the print file rendered for real at 3600×4800 with the photo drawn, 404 before payment, 410 when the preview is gone, HEAD without a render. |

The M4 deliverables beyond the criteria are tested too:
- **The buy-as-a-gift form** on unpaid previews only, and only when configured. The detected zone is
  pre-selected, the date range is right, and the page still has no script (`gift.test.js`). The home page's
  gift note is checked there too.
- **The print upsell** on paid previews only, with the US address form and the price (`print.test.js`).
- **"Your orders"**, with the masked email, the date, "Emailed", the poster and its city, and no street
  address on the page.
- **The gift email:** escaping, no line breaks in the subject, no name or no message.
- **`/legal`**, the Brevo client (`email.test.js`), the env wiring and the offline dev flow through the real
  webhook (`config.test.js`), the second cron, the nft trace of the new modules, and an M3 database upgraded in
  place.

The print poster was checked by eye at 600×800 (a half-scale render), with a typical pet and with every field at
its maximum length. One fix came out of that: a 30-character name of wide capitals ran past the frame. It's in
the shared `wantedPoster`, so the share images and the bundle had it too, and it's now clipped at the inner edge.

## What's left

- **Milestones:** M1–M4 are built, and both M4 exit criteria pass. This run re-verified M4 and fixed what
  didn't hold in production (see Plan and Review). M4 was built ahead of its "only if M3 sells" gate, so it
  ships switched off: its forms appear only once the Brevo and Prodigi keys exist (see Infrastructure).
  Leaving them unset keeps the gate.
- **M4 left open** (details in Review): a wall-clock budget for the gift run; more than 300 gifts on one day
  (Brevo's free cap); at-least-once delivery when the database fails right after a send.
- **Before taking real money** (see Deploy, "Before Stripe goes live"):
  - the commercial-use host decision (requested);
  - live Stripe keys;
  - Stripe receipts switched on;
  - David's read of `/terms` and `/privacy` (refund window, no warranty, the M4 terms);
  - M4 only: Prodigi's live key and card, one real test print, and a decision on sales tax for posters.

  Since go-live, both pages give the GitHub repo's issues as the contact, and refunds still go through the
  Stripe receipt. Add an email address there if David wants one on the page.
- **Host choice.** Share images take about 0.5 s of CPU each, and bundles about 4 s. That rules out the
  Cloudflare Workers *free* plan (10 ms of CPU per request). Two options remain: a Node host, or Workers Paid.
  Render, Fly and Koyeb run the app unchanged with `@hono/node-server`, but check their free-tier CPU: 0.1
  vCPU would make a bundle take most of a minute. See Deploy.
- **Not built in M3, on purpose:**
  - Order lookup by email. The preview link is the receipt; buyers should bookmark it, and David can find a
    slug from any Stripe payment's metadata.
  - Keeping the pre-rewrite text, and a "make it different" hint in the rewrite prompt. Check real rewrites
    first.
  - Verifying the session on return from Stripe. The webhook is the single source of truth; the page asks
    for a refresh if it's slow.
  - Stripe Tax, coupons, other currencies, and refund automation.
  - A bundle cache. Each download re-renders (about 4 s of CPU), and only paid previews can download.
- **Not built in M4, on purpose:**
  - Gifting an already-paid preview (forward the link), and editing or cancelling a scheduled gift from the
    page (SQL in Operations).
  - A confirmation email to the gift buyer: Stripe's receipt and the page cover it.
  - Shipping outside the US, other sizes or frames, and tracking or Prodigi's status callbacks. "Your orders"
    says "sent to the printer" and stops there.
  - A custom email domain. Brevo's free plan sends from one verified address and rewrites it to
    `…@brevosend.com`. A domain (a few dollars a year, so outside $0) plus Brevo's DKIM and DMARC records would
    keep the From address and help gift emails stay out of spam.
  - Delivery at a chosen time of day. One daily run is what Hobby allows, so a gift arrives at the run's local
    time on its date (see Deploy, "Timing").
- **PRD items in no milestone yet:**
  - The "refuse non-pet photos" check.
  - Analytics for the review's watch list: which alter ego, abandoned forms, regenerate rate, **share
    rate**. The PRD's "20% of previews shared" and the kill criterion "share rate under 10%" need a counter.
    The smallest version is a `share_count` column bumped on each `share.png` request; it's not built,
    because no exit criterion needs it.
- **Not built in M2, on purpose:**
  - Open Graph tags **on previews**, which would put the pet's poster in iMessage/WhatsApp link previews.
    They need a 1.91:1 crop of the poster. (Go-live gave the public pages their own tags and a site image.)
  - A moderation UI (SQL is enough; see Operations).
  - Email to David when something is reported. M4 now has an email client (Brevo), so this is one call in
    `/report`, but it needs David's address as config and isn't an exit criterion. The log line is still the
    signal.
- **Not verified here:**
  - Prompt quality with the real model. Run a handful of generations once `GOOGLE_API_KEY` exists and tune
    `buildMessages` in `src/character.js`. Humour quality is the product.
  - A real deploy, including Vercel Cron actually calling the job with `CRON_SECRET`.
  - Visual polish on real phones, and share images with real pet photos (tested with solid-colour JPEG
    and PNG). The bundle cards were checked with a synthetic gradient photo.
  - The Neon HTTP driver against a live database. The SQL itself, including the `DO $$` migration, the
    report CTE and the M3 conditional UPDATEs, runs on PGlite (real Postgres) in tests.
  - **M3, against real Stripe:**
    - a test-mode Checkout and webhook round trip (the request shape and the signature scheme follow
      Stripe's docs and are tested against independent implementations, not against Stripe);
    - a restricted key's exact permissions;
    - opening `alterpaw-bundle.pdf` in Acrobat, Preview and Chrome (no PDF viewer here);
    - the zip on iOS Files and Windows Explorer;
    - a streamed 10+ MB response on a real Vercel deploy.
  - **M4, against the real services:**
    - a Brevo send (the request follows Brevo's documented v3 API; it's tested against a fake);
    - how a gift email looks in Gmail and Outlook, and whether it lands in spam with a `brevosend.com` sender;
    - a Prodigi sandbox order. Check that `GLOBAL-FAP-12X16` exists and ships to the US, and that Prodigi
      accepts a 3600×4800 PNG with `fillPrintArea` on a 3:4 sheet;
    - Prodigi fetching the print file from a real deploy;
    - Vercel Cron calling `/jobs/deliver-gifts`;
    - `x-vercel-ip-timezone` on a real request (documented by Vercel; without it the form starts on New
      York).
- **Ops:**
  - No rate limit on `/generate`, and none on `share.png` renders (see Review). It's still open after M3;
    bundles aren't affected, because only paid previews can download them.
  - Photos live in Postgres. The 30-day deletion, run by the cron and by uploads, caps storage at about one
    month of uploads (~1,500 previews fit the free 0.5 GB). Move photos to object storage if volume grows
    past that.
  - Set `CRON_SECRET` in Vercel (requested in `.provision`). Without it, deletion still happens on
    uploads, but not during quiet periods.
  - Remove the stray `.scratch/` folder (`git rm -r .scratch`); this sandbox can't delete files.

## Infrastructure

Requested in `.provision`. The pipeline runs these lines through the credential broker after the build;
no values are in this repo. The file holds the full set:
- The first three lines are idempotent.
- The `CRON_SECRET` request is repeated from M2, because I can't confirm from here that it reached David.
  M4 rewords it: gift delivery needs it too.
- M3 adds the Stripe request and the two `vercel env` lines that push its values, plus the hosting
  decision.
- M4 adds the Brevo and Prodigi requests and three `vercel env` lines. Stripe needs nothing new, since gifts
  and prints use the same key and webhook.
- **This run:** `.provision` was missing (the pipeline consumed the last one), so it's written again with
  the full set below. The request texts are written out in full and name the 16:00 UTC gift job. The Stripe
  request also asks for receipt emails, which `/legal` relies on for refunds. Nothing new is requested.

| Line | Gives | Used by |
|---|---|---|
| `neon db alterpaw` | `DATABASE_URL` (Postgres, Neon free tier) | `src/index.js` → `PgStore` |
| `gcp key alterpaw generativelanguage.googleapis.com` | `GOOGLE_API_KEY` restricted to the Gemini API | `src/index.js` → model client |
| `vercel project alterpaw` | the Vercel project, with every stored value as env | hosting (M1–M4) and Vercel Cron (M2, M4) |
| `request "CRON_SECRET for alterpaw: …"` | a random letters-and-digits value as the Vercel production env var `CRON_SECRET` | `src/index.js` → `/jobs/expire-photos` and (M4) `/jobs/deliver-gifts`; Vercel Cron sends it automatically. Until it exists, uploads still run the deletion (hourly per instance), but **the gift form stays hidden**. |
| `request "Stripe for alterpaw (M3 $9 unlock, M4 $9 gift and $29 printed poster): …"` | a **test-mode** Stripe account, a restricted key with Checkout Sessions write stored as `STRIPE_SECRET_KEY`, a webhook endpoint `https://<domain>/stripe/webhook` (`checkout.session.completed`, `checkout.session.async_payment_succeeded`) whose signing secret is stored as `STRIPE_WEBHOOK_SECRET`, and receipt emails switched on | `src/index.js` → `createStripeCheckout` and the webhook. Until both exist, Unlock and the webhook answer 503 and the rest of the site works. Stripe is free to set up; it charges per payment only. |
| `vercel env alterpaw STRIPE_SECRET_KEY` | pushes the stored key to the Vercel env | same |
| `vercel env alterpaw STRIPE_WEBHOOK_SECRET` | pushes the stored signing secret to the Vercel env | same |
| `request "Commercial-use hosting for alterpaw, …"` | David's decision: Vercel Hobby forbids commercial use, so before live payments either a plan that allows it (paid) or a free host that allows it and gives a request ~5 s of CPU and ~650 MB (the M4 print file) | hosting. Test mode works on Hobby as it is. |
| `request "Brevo for alterpaw (M4, gift emails): …"` | a free Brevo account, one verified sender address, a v3 API key stored as `BREVO_API_KEY` and the sender stored as `EMAIL_FROM` | `src/index.js` → `createBrevoSender` (`src/email.js`). Until both exist, the gift form is hidden and `/gift` answers 503. |
| `vercel env alterpaw BREVO_API_KEY` | pushes the stored key to the Vercel env | same |
| `vercel env alterpaw EMAIL_FROM` | pushes the sender address to the Vercel env | same |
| `request "Prodigi for alterpaw (M4, the $29 printed poster): …"` | a free Prodigi account and a **sandbox** API key stored as `PRODIGI_API_KEY` (`PRODIGI_ENV` stays unset, so sandbox) | `src/index.js` → `createProdigiPrinter` (`src/print.js`). Until it exists, the print form is hidden and `/print` answers 503. |
| `vercel env alterpaw PRODIGI_API_KEY` | pushes the stored key to the Vercel env | same |

Nothing else is needed. The bundle and the print file render in the same function with no paid API or storage,
and the PNG, PDF and zip are written by our own code on `node:zlib`. Brevo and Prodigi are free to sign up for:
Brevo has a free plan, and Prodigi charges per printed order, paid out of the buyer's $29.

## Review

### M4 review, second pass (this run)

**How it was reviewed.** This run's `git status`:
- **Modified:**
  - code: `src/app.js`, `src/email.js`, `src/input.js`, `src/views.js`, `vercel.json`;
  - tests: `test/gift.test.js`, `test/print.test.js`, `test/email.test.js`;
  - other: `BUILD.md`, `docs/screenshots/*.png`.
- **New:** `.provision` (not committed; the pipeline consumes it).

The first build's M4 review stopped after Pass 1, so this pass covers **all of M4's code**, not just this
run's diff. Two reviews ran against gstack's checklist ("Review Categories", "Fix-First Heuristic"):
- my own pass over the M4 diff;
- a separate read-only reviewer over every M4 file, with targeted checks: Neon vs. PGlite, memory store vs.
  Postgres shapes, time windows, and type coercion at the form, JSON and Stripe boundaries.

I checked each of the reviewer's findings against the code before acting. It found nothing P1. It
independently found the 14:00 cron gap I'd already fixed test-first.

#### Pass 1 — CRITICAL (M4, second pass)

| Category | Outcome |
|---|---|
| SQL & data safety | Clean. No SQL changed in this run. All of M4's queries are parameterised, and every state change is one conditional UPDATE (see the first build's table below). Under Neon's HTTP driver every M4 operation is a single statement: no transaction or session state is relied on. |
| Races | Clean, and tightened. A gift that failed in a run now keeps its claim until the run ends, so the run's next batch can't take it straight back; then it's released. A gift that was emailed but couldn't be *recorded* as sent is never released, so no run re-sends it before the 15-minute lease (tested). Vercel's 300 s function limit means a run can't outlive its own lease. |
| XSS | Clean. The changed "Your orders" line goes through Hono's `html` escaping. The masked address is interpolated as text. |
| LLM output trust boundary | Clean. Model text never reaches the email address, its links, or Prodigi. |
| Shell / eval | None. |
| Enum & value completeness | Clean. `deliverGift`'s results (`sent`/`failed`/`cancelled`) ↔ the `counts` keys ↔ the job's JSON ↔ the webhook's `failed > 0 → 500`. `EmailError.permanent` now has three sources: recipient 400 → true, other 400 → false, the rest → false. Its two consumers are `deliverGift`'s cancel branch and the tests. |

No CRITICAL finding, by me or the reviewer, so there was no CRITICAL fix to make.

#### Pass 2 — fixed in this run (each test-first: the new tests failed, then passed)

- [P2] (confidence 10/10, mine and the reviewer's) `vercel.json`: **a gift for Darwin could arrive the day
  after its date.** Hobby fires a daily cron anywhere in its hour. At 14:00 UTC, a run firing before 14:30
  missed Darwin's midnight (UTC+9:30), and the next run was already the following day there. The same applied
  to Adelaide and Broken Hill in winter. **Fixed:** 16:00 UTC, the only hour that's on the date in every
  zone all year (see Plan). Tests:
  - every zone × every day for a year, at both edges of the hour;
  - an end-to-end gift in ten odd-offset zones.
- [P2] (confidence 9/10) `src/app.js` `deliverGifts`: **a busy day pushed gifts past their date.** The job
  claimed one batch of 50 and stopped, so gift 51 waited for tomorrow's run. **Fixed:**
  - It claims batch after batch until none are due, up to 300 a run (Brevo's free daily cap).
  - A gift that keeps failing is tried once per run and holds up nobody.
  - Three failures in a row look like an outage: the run stops after a few tries instead of waiting on 50
    timeouts, and releases everything for the next run.

  Tests: 121 gifts with one stuck → 120 sent, the stuck one tried once; a 60-gift outage → ≤ 5 tries,
  nothing left claimed, then 60 sent once each.
- [P2] (confidence 6/10, plausible) `src/email.js`: **an unverified sender would have cancelled every gift
  due that day.**
  - **The problem.** Any Brevo 400 counted as "this recipient can never be emailed", so the gift was
    cancelled for good. Brevo answers 400 `invalid_parameter` for a bad recipient ("email is not valid in
    to"), and, by Brevo's help pages and the reviewer's recollection, for an unverified sender too. One
    setup mistake would have cancelled a day of paid gifts, with no way back but SQL.
  - **The fix.** Only a 400 whose message names the recipient list cancels. Any other 400 is retried by the
    next run, with a log line saying to check `EMAIL_FROM`. Brevo's text is matched, never logged.
  - **The trade-off.** If Brevo words a recipient refusal differently, that gift is retried daily until its
    preview expires, then cancelled and logged for a refund. Late, but nothing is lost.

  Tests: the Brevo client, with the recipient wording, a sender rejection, another 400, and a non-JSON 400.
- [P3] (confidence 7/10) `src/app.js`: **one gift's database error stopped the whole run.** An error in
  `getPet`, `cancelGift` or `markGiftSent` aborted the job (500). The rest of that run's claimed gifts
  waited 15 minutes, which in practice is the next day. **Fixed:** each gift's error fails only that gift
  (logged, released at the end of the run). If `markGiftSent` fails *after* Brevo accepted the email, it
  counts as sent and isn't released, so a re-run that day doesn't email again (tested).
- [P3] (confidence 6/10) `src/input.js`: **memory could be grown through the gift form.** One cached
  date formatter per zone string as typed, and `Intl` accepts any letter case, so `aMeRiCa/NeW_yOrK` and
  friends each added one. **Fixed:** the cache key is lower-cased (tested with 256 casings → at most one
  new entry).
- [P3] (confidence 6/10) `src/input.js`: **a lone UTF-16 surrogate (a JSON client) made `/gift` or `/print`
  answer 500 on Postgres.** jsonb refuses it, and the memory store doesn't, so only Postgres failed.
  Nothing was charged. **Fixed:** `clean()` makes text well-formed (U+FFFD). Tested on PGlite.
- [P3] (confidence 9/10) `src/views.js`: **"Your orders" gave the wrong reason for a cancelled gift**
  ("this preview can no longer be shown"). The page is only shown while the preview *is* live, so the only
  cancellations a buyer can see are a refused address or erased details. **Fixed:** "Not sent: we couldn't
  deliver the email to j•••@example.com. It will be refunded." (tested).
- [P3] (confidence 8/10) `src/input.js`: **a field made only of invisible characters passed as filled in.**
  Zero-width spaces, joiners, the Hangul filler and word joiners aren't whitespace to JavaScript. An
  "address" whose street was a zero-width space got past the 400 and would have reached Prodigi. **Fixed:**
  those characters are ignored for the required-field check (and an optional field made only of them is
  empty), but kept inside real text, so emoji with joiners survive. Tested on the print form (name,
  street, city) and the gift form.
- From my own pass: the print form now has a test for JSON values that aren't text (null, a number, a list,
  an object). It passed from the start.

`npm test` after the fixes: **402/402 pass**.

#### Left open (M4)

- [P3] (confidence 6/10) **A run with many slow, non-consecutive Brevo failures can hit Vercel's 300 s
  limit.** Three failures *in a row* stop a run. But Brevo alternating success with 10-second timeouts over
  hundreds of gifts could run past 300 s. The gifts still claimed then wait out the 15-minute lease, which
  in practice is the next day's run. A wall-clock budget per run is a few lines; it's left until real
  volume exists, since a typical send takes well under a second.
- [P3] **At least once, not exactly once, in one window.** If Brevo accepts an email and the database then
  fails to record it, nothing re-sends it that day. A run after the 15-minute lease, though (in practice
  the next day's), may send it again. That beats never; it needs a database failure in that exact window.
- [P3] **Over 300 gifts due on one day** go over the following days. That's Brevo's free plan's daily
  cap. A paid Brevo plan and a higher `GIFT_MAX_BATCHES` lift it.
- [P3] **Brevo's recipient-refusal wording is matched, not contracted.** If Brevo changes it, a bad address
  is retried daily until its preview expires, then cancelled and logged for a refund. Late, but not lost.
- [P3] (from the first build) **Gifts arrive at a fixed hour, not a chosen time of day:** about noon in New
  York, 9 am in Los Angeles, overnight in Asia-Pacific. Hobby allows one run a day.
- **Not verified here** (unchanged from the first build): a real Brevo send and how it lands (inbox or spam,
  `brevosend.com` sender); a Prodigi sandbox order and Prodigi fetching the print file; Vercel Cron calling
  `/jobs/deliver-gifts` at 16:xx UTC.

### M4 review (first build, previous run)

**How it was reviewed.** That run's `git status`, M4 files only:
- **New:** `src/email.js`, `src/print.js`, `test/gift.test.js`, `test/print.test.js`, `test/email.test.js`.
- **Modified:**
  - code: `src/app.js`, `src/store.js`, `src/views.js`, `src/payments.js`, `src/bundle.js`, `src/files.js`,
    `src/input.js`, `src/share.js`, `src/index.js`, `scripts/dev.js`, `scripts/screenshots.mjs`,
    `vercel.json`;
  - tests: `test/helpers.js`, `test/store.test.js`, `test/config.test.js`;
  - other: `.provision`, `README.md`, `BUILD.md`, `docs/screenshots/*.png`.

  M2's and M3's own uncommitted changes from this session are in the same diff (see the M3 review below).

I read the M4 diff against gstack's checklist ("Review Categories", "Fix-First Heuristic"). A separate
read-only reviewer did the same pass over every M4 file, with targeted checks. I checked each of its
findings against the code before acting.

#### Pass 1 — CRITICAL (M4, first build)

| Category | Outcome |
|---|---|
| SQL & data safety | Clean. Every query is parameterised; `ORDER_COLUMNS` is a constant column list, not data. Every order state change is one conditional UPDATE:<ul><li>`markOrderPaid`: `paid_at IS NULL`, with the read-back in a second statement, as in M3;</li><li>`markGiftSent`: `sent_at IS NULL`;</li><li>`cancelGift`: unsent and uncancelled;</li><li>`releaseGift`: unsent;</li><li>`setPrintOrder`: `pod_order_id IS NULL`.</li></ul>The gift claim is a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`. `kind` has a CHECK constraint, and `orders.slug` is a foreign key (tested). The preview page adds one indexed query (`listOrders`). The job reads one preview per due gift, at most 50 per batch: bounded, so it's left as is. |
| Races | Clean. The gates, all tested:<ul><li>**Two deliveries of a payment:** one marks the order paid.</li><li>**Prints racing:** each call carries the same Prodigi idempotency key, so there's one Prodigi order (tested with three deliveries at once). The stored id stops later calls.</li><li>**Gift runs overlapping, or the webhook's immediate send racing the daily job:** the claim gives each gift to one caller (three concurrent runs, one email; interleaved claims on PGlite, each gift once, none lost).</li></ul>One accepted case: a send that succeeds and is followed by a crash before `markGiftSent` is sent again after the 15-minute lease, on the next run. That's at least once, rather than never, and it needs a crash in that window. |
| XSS | Clean. The gift form, print form, "Your orders", the 400/503 pages and the gift **email** HTML all go through Hono's `html` escaping, with no `raw()`. The email test puts `<script>`, a link and markup in the name and message, and they come out as text. `x-vercel-ip-timezone` is only used after `isTimeZone` (charset plus `Intl`) accepts it, and it's escaped anyway (tested with `"><script>`). The subject is one line, and Brevo's JSON API takes no raw headers. |
| LLM output trust boundary | Clean. Nothing the model writes goes into an address, a URL or the email's links. The pet name (user input) appears in the email as escaped text. |
| Payment trust boundary | Clean. An order is paid only through a verified event whose `metadata.order` exists, belongs to `metadata.slug` and matches the order's stored amount in `usd`. Wrong amount, unknown order, or an order for another preview → nothing (tested). `client_reference_id` is still ignored. Email is only ever sent for a **paid** gift, so the form can't mail strangers for free. |
| Shell / eval | None. |
| Enum & value completeness | Clean. Traced through every consumer:<ul><li>`kind` `gift`/`print`: the CHECK, `claimDueGifts` (gifts only), `orderPaid`'s branch, `orderLine`'s branch, the print-file route (`kind === 'print'`).</li><li>The products `bundle`/`gift`/`print`: `PRODUCTS`, `priceLabel`, `createStripeCheckout` (a `RangeError` on an unknown one), `devCheckout`, `payOrder` in the tests.</li><li>The order states (unpaid, paid, claimed, sent, cancelled, Prodigi id, details erased): `orderLine` handles each. Erased details can't reach the page in practice, because an order's details go only after its (older) preview has expired, so that branch is defensive. The erasure itself is tested on the store.</li></ul> |

### M3 review (earlier run)

**How it was reviewed.** This run's `git status`:
- **New:** `src/payments.js`, `src/files.js`, `src/bundle.js`; `test/payments.test.js`,
  `test/bundle.test.js`, `test/regenerate.test.js`, `test/files.test.js`, `test/formats.js`; `.provision`.
- **Modified:**
  - code: `src/app.js`, `src/store.js`, `src/views.js`, `src/share.js`, `src/index.js`, `scripts/dev.js`;
  - tests: `test/helpers.js`, `test/png.js`, `test/store.test.js`, `test/config.test.js`,
    `test/http.test.js`;
  - other: `package.json`, `package-lock.json`, `BUILD.md`.

  M2's own uncommitted changes from the earlier session are in the same diff: `.gitignore`, `test/expiry`,
  `test/report`, `test/share`.

I read the M3 diff against gstack's checklist ("Review Categories", "Fix-First Heuristic"). A separate
read-only reviewer did the same pass over every M3 file. I checked each of its findings against the code
before acting.

#### Pass 1 — CRITICAL (M3)

| Category | Outcome |
|---|---|
| SQL & data safety | Clean. Every query is parameterised. Each state change is one conditional UPDATE, never read-then-write: `markPaid` is `… WHERE paid_at IS NULL`, and `saveRegenerated` is `… WHERE paid_at IS NOT NULL AND regenerated_at IS NULL`. `markPaid` reads the recorded session back only when nothing changed, in a second statement, so it sees a concurrent winner's commit; a SELECT inside the same statement would have read the old snapshot (found while writing it). No N+1. `getPet` still never selects the photo, and it doesn't select `stripe_session` either. |
| Races | Clean. Concurrent webhook deliveries: exactly one records the payment (the row lock plus the recheck; tested interleaved on PGlite). Concurrent rewrites: one 200 and one 409 (tested in the app and the store); the loser's model call is spent, which is accepted. Two tabs paying: the second session changes nothing and is logged for a refund (tested). `/checkout` refuses an already-paid preview, so a second payment needs two checkouts opened before either completes. |
| XSS | Clean. The new sections and pages (`offerSection`, `bundleSection`, the 402, rewrite and payments pages, `/legal`) all go through Hono's `html` escaping, with no `raw()`. The only interpolated values are the slug (pattern-checked), fixed strings, the price constant and a date. Card text reaches the PNGs as satori glyph paths, never as markup. File names in the zip and in `Content-Disposition` are constants. |
| LLM output trust boundary | Clean. The rewrite goes through the same `generateCharacter` → `parseCharacter` shape check and length caps as `/generate`, before the store sees it. Card layouts clamp every model field, and the max-length render was checked by eye. |
| Payment trust boundary | Clean. Only a signed event marks a preview paid: the raw bytes are verified with constant-time Web Crypto, with a ±300 s window, any `v1`, and fail-closed with no secret. `?checkout=success` only changes a note on the page. The bundle and the rewrite both check `paid_at` on the server, and the rewrite checks it again inside its UPDATE. Since the review, the preview comes from `metadata.slug` only and the amount must be $9 in `usd` (see Pass 2). No user text goes to Stripe. The Stripe key is only in an `Authorization` header, and Stripe's error bodies are never logged (tested with a 401 that quotes the key). |
| Shell / eval | None. |
| Enum & value completeness | Clean. Traced through every consumer:<ul><li>`PAID_EVENT_TYPES`: the webhook only.</li><li>`BUNDLE_CARDS` ↔ `CARD_TREES`: `cardTree` throws `RangeError` on an unknown id, and a test runs every card.</li><li>The `lookup` problems (`missing`/`expired`/`removed`) ↔ `PROBLEMS` ↔ `previewStatus`.</li><li>The new `pets` columns ↔ `getPet` (both stores) ↔ the migration guard (5 columns) ↔ `unconfiguredStore` (`markPaid`, `saveRegenerated`).</li><li>`SPECIES_STYLE`, used by the new cards with an `other` fallback.</li></ul> |

Nothing critical was found, by me or by the reviewer, so there was no CRITICAL fix to make.

#### Pass 2 — fixed in this run (each test-first: the new tests failed, then passed)

- [P2] (confidence 8/10) `src/app.js`, `/checkout` and the webhook: **a buyer could pay for a preview that
  was already gone.**
  - **The problem.** Checkout only checked that the preview was live when the session was created. Stripe
    sessions stay open 24 h, and bank debits confirm days later. A preview 29 days 23 h old could be paid
    for at day 30. The reviewer reproduced this: the webhook logged "paid" at info level, and
    `bundle.zip` answered 410.
  - **The fix:**
    - the session's `expires_at` is now the earlier of 24 h and the preview's expiry;
    - with under an hour left, checkout answers 410;
    - a payment that lands on an expired or taken-down preview is still recorded, and logged as an
      **error**: "…can't download it; refund session cs_… in Stripe".
  - Three tests.
- [P3] (confidence 5/10) `src/app.js`, webhook: **`client_reference_id` was trusted, and the amount wasn't
  checked.**
  - **The problem.** A Payment Link on the same Stripe account (a tip jar, say) would let a buyer pay any
    amount with a slug in the URL and unlock the bundle.
  - **The fix:** the slug comes from `metadata.slug`, which only our own session request sets, and the
    session must be `amount_total === 900` in `usd`. A mismatch is logged for a check and unlocks nothing.
    Two tests.
- [P3] (confidence 6/10) `src/payments.js`: **any https URL from Stripe was accepted, but the CSP only
  allows `https://checkout.stripe.com`.** With a custom Checkout domain, the Pay button would silently do
  nothing. **Fixed:** anything outside that origin is a logged 502 (tested).
- [P3] (confidence 6/10) `src/views.js`: **share images are cached for 10 minutes on the same URL before and
  after paying or rewriting.** A buyer could download a cached "FREE PREVIEW" image, or the old jokes,
  after paying. **Fixed:** a paid preview's share links carry `v=<paid/rewrite time>`. The server ignores it
  and it busts the cache; unpaid links are unchanged (tested).
- [P3] (confidence 8/10) `package.json`: **`zlib.crc32` needs Node 22.2, but `engines` said `>=22`.** On
  22.0 or 22.1 the app wouldn't boot. **Fixed:** `>=22.2`.
- [P3] **Stale comments, all corrected:**
  - "400 tells Stripe not to retry": it retries every non-2xx.
  - Two comments named only `/report`.
  - Refunds and disputes now have a comment saying they deliberately change nothing.
- [P3] **Test gaps, all filled:**
  - `/checkout` with a non-string slug (`42`, an array);
  - the DOS date in the zip's central directory, not only the local header;
  - a malformed bundle slug never reaching the store;
  - a paying flow over a real socket with a 6 MB streamed bundle.
- [P3] **From my own pass:**
  - an `INK` export nothing used;
  - names on the trading and bio cards weren't clipped. A 30-character name of wide capitals ran past the
    card; it now clips at the inner edge, checked by eye.
  - Two layout fixes from the visual check (see "Exit criteria (M3)").

`npm test` after the fixes: **297/297 pass**.

#### Left open (M3)

- [P2] (confidence 9/10) **Live payments need a commercial-use host.** Vercel Hobby's terms forbid
  commercial use, so the build stays in Stripe test mode on Hobby until David decides (requested in
  `.provision`; see Deploy). This is a business decision, not a code change.
- [P2] (confidence 8/10, carried from M2) **No rate limit on `/generate` or `share.png`.**
  - M3 adds no anonymous CPU cost, since bundles are paid-only.
  - A paying buyer could loop `bundle.zip`, though: about 4 s of CPU each, against Hobby's monthly CPU
    allowance.
  - Fix with shared state: a Postgres counter, or Vercel's firewall rate-limit rule. Don't use a
    per-instance cache.
- [P3] **One preview, one order: the paid state lives on the `pets` row.** A second purchase of the same
  preview (gift copies, prints) needs an `orders` table. That's M4's print upsell; split it out then.
- [P3] **The rewrite replaces the text for good.** If the new jokes are worse there's no way back except
  SQL. Keeping `previous_character` is a small change, if real buyers ask for it.
- [P3] **A paid preview can still be taken down by 3 reports**, and its bundle goes 410 with it. The
  takedown log line names the slug; check `paid_at` before leaving a paid preview down.
- [P3] **The 410 page for "under an hour left" reuses the expired page** ("This preview has expired"), a
  few minutes early. It's rare, and the photo is about to go anyway.
- [P3] **`/legal` has no contact email**; it points buyers at the Stripe receipt. Turn receipts on before
  going live (Deploy, go-live step 3).
- **Not verified here:**
  - a real Stripe round trip;
  - the PDF in real viewers and the zip in OS unzippers;
  - streaming over 4.5 MB on a real Vercel deploy;
  - whether `c.req.url` is `https://` on Vercel. The success URL is built from it; an `http:` URL would
    still redirect to https on Vercel, at the cost of one extra hop.

### M2 review (earlier run)

**How it was reviewed.** The M2 code arrived already committed, so the diff under review is M2 as a whole
(`src/share.js`, the M2 routes in `src/app.js`, `reportPet`/`expirePhotos` and the migration in
`src/store.js`, the M2 views, `src/index.js`, `vercel.json`) plus this run's changes. This run's
`git status`:
- modified: `src/app.js`, `src/store.js`, `test/expiry.test.js`, `test/report.test.js`,
  `test/share.test.js`, `test/store.test.js`, `BUILD.md`, `.gitignore`;
- new: `.provision`.

I read all of it against gstack's checklist ("Review Categories", "Fix-First Heuristic"). A separate
read-only reviewer did the same pass, with targeted checks:
- Hono 4.13's CSRF middleware: a matrix of origins, `Sec-Fetch-Site` values and content types;
- the report CTE under concurrency;
- the M1→M2 migration, on PGlite databases left in each partial state;
- log hygiene, and the no-JS report form in older Safari.

It found nothing critical. I checked each of its seven P3 findings against the code before acting. Five
are fixed below; two are design or ops questions, left open.

#### Pass 1 — CRITICAL (M2)

| Category | Outcome |
|---|---|
| SQL & data safety | Clean. Every query is parameterised. `reportPet` and `expirePhotos` are single statements (CTEs), so there's no read-then-write. Each request makes one query per read, with no N+1. `getPet` never selects the photo. |
| Races | Clean. The report count is bumped in the same statement as the `INSERT … ON CONFLICT DO NOTHING` on `(slug, reporter)`, under the row lock. PGlite runs one query at a time, so the test interleaves calls rather than racing them; the safety on a real server comes from the single statement. Concurrent deletions are idempotent: `WHERE expired_at IS NULL` is rechecked after the lock. The upload-sweep throttle is set before its `await`, so two uploads on one instance can't both sweep. A photo deleted between `getPet` and `getPhoto` returns 410, not a broken image (test added this run). |
| XSS | Clean. The new pages and the report form go through Hono's `html` escaping. The report reason is allow-listed. Share-image text is drawn as glyph paths by satori, never as markup. Download names are fixed strings. |
| LLM output trust boundary | Clean. Model text reaches the share image only as text: it's filtered by `drawable()` and line-clamped. The only `img` source is our own `data:` URL of the stored photo; nothing is fetched from model output. |
| Shell / eval | None. |
| Enum & value completeness | Clean. `SHARE_SIZES` ↔ `LAYOUT` (checked at render time and by a test over every size), `REPORT_REASONS` ↔ form ↔ server allow-list, statuses `live`/`expired`/`removed` ↔ `findLive` (every `/p/*` route uses it), `SPECIES_STYLE` ↔ share image (falls back to `other`). |

#### Pass 2 — fixed in this run

- [P2] (confidence 9/10) `src/app.js` (`/jobs/expire-photos`): **photo deletion depended on one manual
  step.** The only trigger was Vercel Cron, which answers 503 until David sets `CRON_SECRET`. And M3's
  likely host move (Vercel Hobby bans commercial use) may drop the scheduler. Old photos were already hidden
  at read time, but their bytes stayed, against the PRD's "photo deleted after 30 days", and storage crept
  toward Neon's 0.5 GB. **Fixed:** uploads run the same deletion, at most hourly per instance, best effort.
  Three tests were written first; they failed, then passed.
- [P3] **Test gap:** no test covered the `photoGone` path (record live, photo already deleted). **Added**
  for `/photo` and both share sizes.
- [P3] (confidence 9/10) `src/app.js`, `share.png`: **HEAD rendered the full image.** Hono serves HEAD
  through the GET handler, so every link-checker or unfurler HEAD cost ~0.5 s of CPU. **Fixed:** HEAD
  answers the live/404/410 status and headers without rendering (tested).
- [P3] (confidence 9/10) `src/app.js`, `/report`: **CSRF only covered form content types.** In Hono 4.13.13,
  `csrf()` skips `application/json`; the reviewer got a 200 for a JSON post with
  `Origin: https://evil.example`. Browsers can't actually send that: it needs a CORS preflight, and
  `/report` answers none. The rule shouldn't rest on that, though, so this is a security hardening, not
  an exploit. **Fixed:** anything marked cross-site by `Origin` or `Sec-Fetch-Site` gets a 403, whatever
  its content type. Same-origin JSON still works (tested).
- [P3] (confidence 9/10) `src/app.js`, `/report`: **an oversized no-JS form post got JSON back.**
  **Fixed:** a page for forms, JSON for JSON clients (tested; the 413 had no test before).
- [P3] (confidence 8/10, unlikely) `src/store.js`: **the migration guard only checked `expired_at`.** A
  database with that column but no `report_count` 500'd every preview. One whose `photo` was still
  `NOT NULL` failed every deletion run. Only manual DDL or an early dev build could produce either state,
  since the code's own ALTER is atomic. **Fixed:** the guard checks both columns and the `photo`
  constraint; the ALTER itself was already idempotent. PGlite tests cover all three half-upgraded states.
- [P3] (confidence 6/10) `src/app.js`, `/generate`: **the new upload sweep was awaited with no bound**,
  and Neon's HTTP driver has no timeout. A stuck sweep would have held an upload that was already saved,
  inviting a retry that costs a second model call. **Fixed:** the upload waits at most 1 s; the sweep
  finishes in the background (tested with a sweep that never resolves).
- [P3] **Stale text:** the `renderShare` contract comment in `app.js` omitted `photoProblem`, and BUILD.md
  described the reporter key as "sha256(slug + client IP)". The code uses 24 bits over the slug and the
  IPv4 address or IPv6 /64. Both are corrected.
- [P3] **Dead files:** `.scratch/` (the earlier session's experiments, ~700 KB of scripts and PNGs) was
  committed and is used by nothing. It's now in `.gitignore`. File deletion is blocked in this sandbox, so
  **the caller should run `git rm -r .scratch`**.
- `.provision` was missing (consumed by the earlier pipeline run); it's written again (see Infrastructure).

`npm test` after the fixes: **202/202 pass**.

#### Left open (M2)

- [P2] (confidence 8/10) **No rate limit on `/generate` or on `share.png` renders.** Still open from M1.
  The roadmap never put it in a milestone. A share GET costs ~0.3–0.6 s of CPU warm (the reviewer
  measured 330 ms for a post and 570 ms for a story, 1.2 s cold). Anyone with a preview link can loop it.
  If the Hobby plan's monthly CPU allowance runs out, Vercel pauses the whole project (quota from memory;
  check the current Hobby limits). That's an availability and cost risk, not a data risk.
  - Why it's left open: the fix needs shared state (a Postgres counter per hashed IP, or Vercel's
    firewall rate-limit rule), so it belongs with M3's abuse controls, before money flows.
  - Not done instead: a per-instance render cache. M3's regenerate and paid clean images would make it
    a cache-invalidation trap.
  - Not done either: a public CDN cache. A removed preview's image would keep being served, and the
    test that pins `private` stays.
- [P2] (confidence 7/10) **Three IPs can take any preview down, and nobody is told.** The takedown rule
  is the exit criterion's own (410 after 3 reports). One person counts once and an IPv6 /64 is one
  person, but a phone, home Wi-Fi and a VPN count as three. The only alert is one `warn` log line, and
  Vercel Hobby keeps runtime logs only briefly (about an hour, from memory). A griefed preview could stay
  hidden unnoticed, while its page says "while we take a look".
  - Until there's an alert, David should run the "Reported previews" query in Operations every few days.
  - The real fix is an email to David on the third report. M4 needs an email service anyway (gift
    delivery); wire this in then, or in M3 if a free email tier is set up for receipts.
  - He restores a preview with one SQL line (Operations).
- [P3] **The client IP is trusted from `X-Forwarded-For`'s last entry.** That's correct behind Vercel or
  Cloudflare, but a host that passes the header through untouched would let a client choose its reporter
  identity. Check this when moving hosts in M3 (comment in `clientIp`).
- [P3] **Share rate isn't measured.** The PRD's 20% target and the review's 10% kill criterion need a
  counter. A `share_count` column bumped by `share.png` is the smallest version. It's not built, because
  no exit criterion asks for it; it could ride along with M3's order table.
- **Not verified in this sandbox:** Vercel Cron actually calling the job, the function bundle on a real
  Vercel deploy (the nft trace test covers the file list), share renders' memory and time on Vercel, and
  real phone downloads (iOS Safari `download` on a PNG).

### M1 review (kept for reference)

**How it was reviewed.** `git status` shows only new files (`.gitignore`, `.provision`, `BUILD.md`,
`package.json`, `package-lock.json`, `scripts/`, `src/`, `test/`); there were no edits to existing files.
I reviewed the code against gstack's checklist ("Review Categories", "Fix-First Heuristic"). An independent
read-only reviewer then went through `src/` and `scripts/` with the same checklist. Every finding below was
checked against the code, or against `node_modules`, before being fixed. `npm test` was rerun after the
fixes: 126/126 pass.

#### Pass 1 — CRITICAL (M1)

| Finding | Outcome |
|---|---|
| [P1] (confidence 9/10) `src/index.js`, logged in `src/app.js`: a malformed `DATABASE_URL` (a pasted `psql '…'` snippet, a password with a space) makes Neon's driver throw `…not a valid URL (connection string: <the whole string>)`. Confirmed in `node_modules/@neondatabase/serverless/index.mjs`. The app logged `err.message`, so the database password would be written to Vercel logs on every request. | **Fixed.** `depsFromEnv` checks the URL first and fails with a fixed message that never contains the value. Every logged error also goes through `redact()`, which masks database URLs to the end of the line and any `scheme://user:pass@…`. Tests check the actual logged lines. |
| SQL & data safety | Clean. Parameterised queries only, one query per request (no N+1), `getPet` never selects the photo. |
| Races | Clean after one fix. Slugs are 128-bit random with a primary key, and a duplicate is rejected, not overwritten. Two cold starts racing on `CREATE TABLE IF NOT EXISTS` now count as success (tested). |
| XSS | Clean. Every value goes through Hono's `html` escaping (checked in its source), with no `raw()` on data. CSP allows no inline script or style (stat bars are SVG attributes). Photos are typed by magic bytes, SVG is refused, `nosniff` is set. |
| LLM output trust boundary | Clean. Shape and type checks, length caps, unknown keys dropped, nothing fetched from model output. Pet details are sent as data with an instruction to treat them as data. |
| Shell / eval | None. The client test's `new Function` only parses our own served script. |
| Enum completeness | Clean. Species (`dog`/`cat`/`other`) and the six alter-ego ids are traced through input, prompt, views and the form. The species `<select>` is now built from `SPECIES` (it was hard-coded). |

#### Pass 2 — fixed (M1; mechanical fixes, or bugs with a clear fix)

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

#### Left open at M1 (judgement calls or later milestones; see the M2 review for their current state)

- [P2] (confidence 7/10) **No rate limit on `/generate`.** A script can burn the free model quota and fill the
  0.5 GB Neon tier: roughly 110 uploads at Vercel's 4.5 MB cap, or about 1,500 normal ones. An in-memory
  limit is useless across serverless instances; a real one needs shared state (a Postgres counter per hashed
  IP, or a KV store). It was planned for M2, but M2's roadmap entry doesn't include it, so it's still open.
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
