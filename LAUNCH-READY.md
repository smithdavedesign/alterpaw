# alterpaw — launch-ready

What's in place for the public launch, how to check it, every setting the Worker reads, and what's left for
David. The product does what it did before: the same form, preview, share images, $9 bundle, gifts and printed
posters. Nobody was available to ask, so each judgement call is written down under "Decisions".

This is the second go-live pass (2026-11-13). The first (2026-10) added the search tags, the legal pages and
the visit beacon, and those still stand. This pass did four things:
- added the **Stripe Payment Link** Buy button (REVENUE.md now sets the price: $9 once);
- moved the share image to **build time**;
- added **`cf:build`** and `.provision` for the Cloudflare deploy;
- re-ran the **screenshots**.

## What's done

1. **Search and sharing.** `/`, `/privacy` and `/terms` are the public pages. Each has:
   - its own `<title>` and meta description;
   - a canonical URL (from `SITE_HOST`);
   - Open Graph and Twitter `summary_large_image` tags with a 1200×630 image;
   - `SoftwareApplication` JSON-LD with two offers: the free preview ($0) and the clean bundle ($9, described
     as "Paid once, no subscription").

   The rest:
   - **The share image, `/og.png`,** is drawn with the app's own renderer (`renderOgPng` in `src/share.js`: text
     and shapes, nothing copied from anywhere). It's drawn **at build time**: `npm run cf:build` writes
     `assets/og.png`. The file is committed and is the same bytes every time, so a deploy that skips the build
     still has it. The Worker bundles it and Node reads it from disk, so **no request draws it** (before, the
     first request on each instance spent ~0.5 s of CPU on it). A test fails if the file no longer matches the
     drawing code.
   - **robots.txt** allows everything and points at `/sitemap.xml`. The sitemap lists the three public pages.
   - **Previews** (`/p/…`), print files, error and 404 pages stay `noindex`, without these tags.
   - **Where it lives:** the page list and texts are in `src/site.js`; the tags come from `layout()` in
     `src/views.js`.
2. **Privacy and terms.** Both are linked from the footer of every page.
   - **`/privacy`** says what is stored and for how long, and who processes it (Stripe, Brevo, Prodigi,
     Gemini, Neon, Cloudflare). It says there are **no cookies**, describes the visit counter with its three
     events, how to switch it off, and the contact: GitHub issues. New: Stripe is told which preview a payment
     is for.
   - **`/terms`** covers the service, the price ("$9 (US dollars), paid once"), refunds (14 days, full), **no
     warranty**, changes, and the same contact.
   - Both are dated November 13, 2026.
3. **Payment: the Buy button.** It's "Unlock for $9", under the cards on every unpaid preview and on the
   "unlock the bundle" (402) page.
   - It links to **`STRIPE_PAYMENT_LINK`** with `?client_reference_id=<preview id>`, so the payment says which
     preview it's for. It opens in a new tab, and the note under it says to come back to the page.
   - The variable is **read on the server on every page view**: `paymentLink()` in `src/deps.js`, called by
     `buyOption()` in `src/app.js`. Setting the Worker secret shows the button with no rebuild.
   - **Hidden when the variable is unset,** or isn't an https URL without credentials. The page then says
     payments aren't switched on yet.
   - **Hidden in a preview's last hour** ("expires within the hour, too soon to buy it"). The link goes
     straight to Stripe, past the check that `/checkout` makes.
   - **If `STRIPE_SECRET_KEY` is set too,** the existing Stripe Checkout form is used instead (see Decisions).
   - **No payment link or key is in the code.**
   - **The webhook** (`/stripe/webhook`) now unlocks a preview from a Payment Link payment. It does that only
     when Stripe's session has `payment_link` set, its `client_reference_id` is a valid preview id, and it paid
     exactly $9 in USD. Repeats change nothing; a second payment is logged for a refund. Any other amount, or a
     missing or unknown preview, unlocks nothing and is logged.
4. **The visit beacon.** `/beacon.js` posts JSON `{"slug":"alterpaw","kind":…,"referrer":…}` to
   `https://idea-factory.1426davejobs.workers.dev/api/ideas/signal`. It's fire-and-forget: `keepalive`,
   `credentials: 'omit'`, no Referer header. The events:
   - **`visit`**: once per browser session (sessionStorage), on every page that loads it (the public pages and
     previews).
   - **`activate`**: once per browser (localStorage). **The core action is making a preview: pressing "Reveal
     the secret life" with `POST /generate` succeeding.** `upload.js` then dispatches `alterpaw:activate`.
   - **`checkout`**: a click on the Buy link (`a[data-checkout]`, new), or a submit of a pay form
     (`form[data-checkout]`: Checkout, gift, print). A form's own button isn't counted twice.

   The rules:
   - `referrer` is `document.referrer` only when its origin differs from `location.origin`, else `null`.
   - **Nothing is sent** when `navigator.webdriver` is true, when localStorage `repohq:notrack` is set, or when
     storage can't be read.
   - **Nothing is sent off production either.** The server adds the script only when `DEPLOY_ENV` (or else
     Vercel's `VERCEL_ENV`) is `production`. `wrangler.jsonc` sets `DEPLOY_ENV=production` on the Worker.
   - The CSP's `connect-src` allows that one origin off-site.
5. **Hosting: the Cloudflare Worker** (live since 2026-11-08), and the Vercel entry (`src/index.js`) still
   works.
   - **`wrangler.jsonc`** has `"name": "alterpaw"`, `"workers_dev": true`, `nodejs_compat` (zlib, Buffer for
     the bundle), no `build` section, and a Data rule for `.png`.
   - **`npm run cf:build`** draws the share image. The deploy is then wrangler's own bundling of
     `src/worker.js` (a Hono app's `fetch`).
   - **Free-plan rules:**
     - **Bundle size:** about **1.9 MiB gzipped**, measured here by compressing everything it bundles (the
       free cap is 3 MiB). Wrangler wasn't available to measure it exactly.
     - **Share image:** drawn at build time.
     - **Filesystem:** none at run time; assets are bundled.
     - **Database:** Neon's HTTP driver, one HTTPS request per query, no shared connection.
     - **Settings:** secrets for keys and the link, `wrangler.jsonc` vars for the rest.
   - **Plan: Workers Paid, not free.** The CPU limit is the exception: see Decisions.
   - **`.provision`** holds the two requests asked for: the Worker deploy and the Stripe payment link.
6. **Tests: 470 pass** (`npm test`, about 75 s; there were 451). New or changed in this pass:
   - `test/launch.test.js`:
     - the Buy button: hidden without `STRIPE_PAYMENT_LINK`, then shown;
     - read per request, so setting the variable shows it on a running app;
     - only https links count;
     - the preview id in `client_reference_id`;
     - Checkout wins when the key is set too;
     - hidden in the last hour, and on paid previews;
     - the share image served from `assets/og.png`, checked against the drawing code, read once, retried after
       a failure;
     - "paid once" in the JSON-LD and the terms.
   - `test/payments.test.js`: Payment Link sessions unlock the named preview at $9 and nothing else (repeats,
     second payments, other amounts and currencies, missing, malformed or unknown previews, metadata wins).
   - `test/beacon.test.js`: `checkout` on a Buy-link click, not on other clicks, never twice for a form.
   - `test/worker.test.js`, `test/share.test.js`, `test/config.test.js`:
     - the Worker bundles `assets/og.png`;
     - the link isn't a plain var;
     - Vercel's tracer ships the image;
     - the dev server shows the link when it's set.
   - Still covered from before: pages render, robots.txt, the sitemap, the footer, the privacy and terms
     contents.
7. **Screenshots.** `npm run screenshots` was run with `STRIPE_PAYMENT_LINK=https://example.com/pay`, and all
   six PNGs were opened and checked. They're at the top of the README:
   - the start page with the form filled in;
   - the end of the form with the footer's Privacy and Terms links;
   - the watermarked result;
   - the "Unlock for $9" Buy button;
   - both share images.

   The script now checks the Buy button links to the placeholder with this preview's id. It strips
   `DEPLOY_ENV`/`SITE_HOST` from the inherited environment, so a shell can't switch the beacon on.

## How to check it

- **Tests:** `npm ci`, then `npm test`.
- **The build:** `npm run cf:build`, then `git status`: `assets/og.png` is unchanged (the drawing is
  deterministic).
- **Locally:** `STRIPE_PAYMENT_LINK=https://example.com/pay npm run dev`, then open these.
  - <http://localhost:3000/>, `/privacy` and `/terms` (view the source for the tags), `/robots.txt`,
    `/sitemap.xml` and `/og.png`.
  - Make a preview: "Unlock for $9" should go to `https://example.com/pay?client_reference_id=…`.
  - Without the variable, the dev server's offline Stripe stand-in shows the Checkout form instead.
- **Screenshots:** `CHROMIUM_PATH=/path/to/chromium npm run screenshots`. It never downloads a browser.
- **After the deploy (all free):**
  - paste `https://alterpaw.1426davejobs.workers.dev/` into <https://www.opengraph.xyz/> (link preview) and
    Google's Rich Results Test (JSON-LD);
  - open `/robots.txt` and `/sitemap.xml`;
  - optionally submit the sitemap in Google Search Console.
- **The beacon:** open the network tab on the live site. You should see a `signal` POST at each of these:
  - the first page of a tab (`visit`);
  - your first preview (`activate`);
  - each "Unlock for $9" click (`checkout`).

  `localhost` sends none.
- **The payment, end to end** (REVENUE.md step 4): pay $9 through the live Buy button yourself, check the
  preview unlocks and the bundle downloads, then refund it in Stripe.

## Settings the Worker reads

Every environment value the app reads (`src/deps.js`, `src/site.js`). Secrets go through the credential broker
(`provision cloudflare secret alterpaw <KEY>`); never put them in `wrangler.jsonc`.

**Secrets, for the broker to set if it holds them:**

| Key | Needed? | What it does |
|---|---|---|
| `DATABASE_URL` | **required** (set) | Neon Postgres, over Neon's HTTP driver. Previews, payments, orders. |
| `GOOGLE_API_KEY` | **required** (set) | Gemini, which writes the jokes. |
| `STRIPE_PAYMENT_LINK` | **for selling** | The Buy button: a $9 one-time Stripe Payment Link. `provision stripe alterpaw … --host cloudflare` sets it. Hidden while unset. |
| `STRIPE_WEBHOOK_SECRET` | recommended | Signing secret of the Stripe webhook `https://alterpaw.1426davejobs.workers.dev/stripe/webhook`. With it, a paid preview unlocks by itself; without it, David unlocks by hand. |
| `STRIPE_SECRET_KEY` | optional | Uses Stripe Checkout instead of the link, and is what gifts and prints need. |
| `CRON_SECRET` | optional | Only to call `/jobs/*` over HTTP; the Worker's Cron Triggers don't need it. |
| `BREVO_API_KEY` | optional | Gift emails (with `EMAIL_FROM`). |
| `EMAIL_FROM` | optional | The verified Brevo sender address (not secret, but set beside the key). |
| `PRODIGI_API_KEY` | optional | Printed posters (prints need work before selling; see BUILD.md). |
| `LLM_API_KEY` | optional | A key for `LLM_BASE_URL`, if another model provider replaces Gemini. |

**Vars, in `wrangler.jsonc` (already set; not secrets):**

| Key | Value | What it does |
|---|---|---|
| `SITE_HOST` | `alterpaw.1426davejobs.workers.dev` | Canonical URLs, robots.txt and the sitemap. A custom domain goes here. |
| `DEPLOY_ENV` | `production` | Loads the visit beacon. |
| `LLM_MODEL` | `gemini-flash-lite-latest` | The model (Flash-Lite answers inside the 30 s timeout). |
| `LLM_BASE_URL` | unset | Optional OpenAI-compatible endpoint; Gemini's by default. |
| `PRODIGI_ENV` | unset | `live` sends prints to Prodigi's live API; anything else is its sandbox. |

Not used on the Worker: Vercel's own `VERCEL_ENV` and `VERCEL_PROJECT_PRODUCTION_URL` (which `DEPLOY_ENV` and
`SITE_HOST` override), and `PORT` (the dev server only).

## Decisions

- **Not Next.js.** alterpaw is a Hono app, so the framework conventions are plain routes and one `layout()`:
  - `/robots.txt`, `/sitemap.xml` and `/og.png` are ordinary routes;
  - there's no `metadata` export, `robots.ts` or OpenNext;
  - nothing is baked into a build. `DEPLOY_ENV`, `SITE_HOST` and `STRIPE_PAYMENT_LINK` are read by the server
     at request time, so `cf:build` sets no `NEXT_PUBLIC_DEPLOY_ENV`, because nothing would read it. The Worker
     is production because of its `DEPLOY_ENV` var.
- **Workers Paid stays.** The brief asks for the free plan, but the product's own images can't fit it:
  - a share image takes 0.1–1 s of CPU, the paid bundle about 3 s;
  - both are drawn from the buyer's photo, so they can't move to build time;
  - the free plan allows 10 ms per request.

  David moved the site to Workers Paid for exactly this on 2026-11-08 (commit `8e7fd8f`), and
  `limits.cpu_ms: 30000` stays. Everything that *can* follow the free plan's rules does (see What's done, item
  5). Dropping to the free plan would break share images and bundle downloads.
- **Payment Link and Stripe Checkout.** The app already had a Checkout integration, which needs
  `STRIPE_SECRET_KEY` and a webhook. The pipeline will provision a Payment Link, so the Buy button now uses
  that.
  - **When both exist, Checkout wins.** Its session carries the preview id in metadata, and Stripe returns the
    buyer to the preview by itself.
  - **The webhook trusts `client_reference_id` only on Payment Link sessions, and only at exactly $9 USD.** The
    buyer can edit that id in the URL, so all they can change is which preview their own $9 unlocks. A $5 tip
    link, or any other link on the account, unlocks nothing. On other sessions it's still ignored, as the M3
    review decided.
- **The Buy button lives on previews, not the home page.** There's nothing to buy before a preview exists. The
  home page says "$9 unlocks the clean, high-res bundle".
- **It opens in a new tab.** A Payment Link can't send the buyer back to their preview (its redirect URL is the
  same for everyone). The preview stays open in the first tab, and the note says to come back to it.
- **Gifts and prints stay off with only a Payment Link.** They need per-order Checkout Sessions
  (`STRIPE_SECRET_KEY`), as before. That's also why the screenshots show no gift option now.
- **REVENUE.md gives the price, not a refund rule.** The terms keep their 14-day full refund, with the $9
  written as "paid once".
- **`.provision` has exactly the two lines asked for.** The webhook secret isn't requested there; it's in
  What's left.
- **Old files I couldn't delete.** This sandbox refuses file deletion, so two things remain on disk; David
  removes them (What's left). The README shows only the six new screenshots.
  - The four `docs/screenshots/live-*.png` from 2026-11-08 are still there, so the folder has 10 PNGs, not
    the 6 asked for.
  - The stray `.scratch/` folder is still there too.

## Self-review (gstack pre-landing checklist)

**Pass 1, CRITICAL: none found, so nothing to fix.**
- **SQL and data safety.** No new queries. A Payment Link payment goes through the existing `markPaid`, a
  conditional `UPDATE … WHERE paid_at IS NULL` that is tested on PGlite.
- **Race conditions.** The same atomic `markPaid` makes "paid once" hold when Stripe sends an event twice or
  two payments race. Nothing does check-then-set.
- **XSS.** The Buy link's `href` goes through Hono's `html` escaping. It's built only from:
  - `STRIPE_PAYMENT_LINK`, which must parse as an https URL without credentials, so `javascript:` and
    `data:` are refused;
  - the stored preview id, URL-encoded by `URLSearchParams`.

  No user text reaches it.
- **Payment trust boundary.** `client_reference_id` is buyer-controlled. It's used only on Payment Link
  sessions at the exact bundle price, and only to pick which preview that payment unlocks (tested both ways).
- **LLM trust boundary, shell injection:** the diff touches neither.
- **Enum completeness.** I traced the new values through every consumer:
  - **`buy.via`** (`checkout` | `link` | `closed` | null): `buyButton` handles all four, and `offerSection`'s
    "one-time payment" line covers the two that sell. All four places that render the offer pass it: the
    preview, and the 402 pages for the bundle, rewrite and print.
  - **The `checkout` signal** has a new source (the link's click). `/privacy` already names "Unlock".
  - **The old `payments` flag** is gone everywhere (grep).

**Pass 2, informational: fixed two.**
- **Fixed:** the `/checkout` log said "payments are off" even with a Payment Link on. It now says Stripe
  Checkout is off.
- **Fixed, stale comments:** `app.js` (`checkout: null`), `share.js` (where `renderOgPng` runs), and the
  `wrangler.jsonc` and BUILD.md deploy notes (cf:build, the link, the plan).
- **Left as is:**
  - A middle-click on the Buy link fires `auxclick`, not `click`, so it isn't counted as `checkout`. That
    under-counts, which is the safe direction.
  - The Checkout form is still shown in a preview's last hour. `/checkout` answers 410 there with an
    explanation, unchanged.

## What's left for David

1. **The Stripe Payment Link.** `.provision` requests it, and `provision stripe alterpaw … --host cloudflare`
   puts it on the Worker as **`STRIPE_PAYMENT_LINK`**. No rebuild or redeploy is needed: the Buy button
   appears on the next page view. When creating it in Stripe:
   - **$9 USD, one-time, quantity fixed at 1, no promotion codes.** The webhook unlocks only an exact $9
     payment, so $18 for two, or a discounted $7, would need unlocking by hand.
   - **Turn on Stripe's receipt emails** ("Successful payments"). `/terms` says to reply to the receipt for
     refunds.
2. **The webhook, so a paid preview unlocks by itself (recommended).**
   - In Stripe, add the endpoint `https://alterpaw.1426davejobs.workers.dev/stripe/webhook` for
     `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
   - Store its signing secret as the Worker secret `STRIPE_WEBHOOK_SECRET` through the broker.
   - Until then, unlock each payment by hand. Stripe shows the preview id as the payment's "client reference
     ID", and the SQL is in BUILD.md, Operations, "Unlock a preview by hand".
3. **Test with real money once** (REVENUE.md step 4): pay $9 yourself through the live button, check the
   unlock and the download, then refund.
4. **A custom domain, if you want one** (it costs money, so it's optional):
   - attach it to the `alterpaw` Worker in Cloudflare;
   - set `SITE_HOST` in `wrangler.jsonc` to it, and the canonical URLs, sitemap and robots.txt follow.

   `alterpaw.1426davejobs.workers.dev` works as it is.
5. **The plan.** Keep Workers Paid; the free plan's 10 ms of CPU can't draw share images or bundles (Decisions).
6. **Housekeeping.** This sandbox can't delete files, so run:
   - `git rm docs/screenshots/live-*.png` (the README no longer shows them, and the screenshot folder should
     hold at most six);
   - `git rm -r .scratch` (old scratch files an earlier run committed).
7. **Read `/terms` and `/privacy` once.** They're yours to confirm: the 14-day refund promise, the no-warranty
   wording, the processor list.
8. **The contact link** works only if `github.com/smithdavedesign/alterpaw` is public with Issues on.
9. **Opt your own browser out** of the count: run `localStorage.setItem('repohq:notrack', '1')` in the console
   once, on the live site.
