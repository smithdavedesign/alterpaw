# alterpaw — launch-ready

What changed for the public launch, how to check it, and what's left for David. The product does what it did
before: the same form, preview, share images, $9 bundle, gifts and printed posters. Nobody was available to ask, so
each judgement call is written down under "Decisions".

## What was done

1. **Search and sharing.** `/`, `/privacy` and `/terms` are the public pages. Each has:
   - its own `<title>` and meta description;
   - a canonical URL;
   - Open Graph and Twitter `summary_large_image` tags pointing at a 1200×630 share image;
   - `SoftwareApplication` JSON-LD with two offers, the free preview ($0) and the clean bundle ($9).

   The details:
   - **Share image.** `/og.png` is drawn with code by the app's own renderer (satori + resvg, `renderOgPng` in
     `src/share.js`): the headline beside a sample wanted poster with a paw print. No image was copied from
     anywhere. It's rendered once per server instance, cached for a day, and is the one resource other sites may
     embed (`Cross-Origin-Resource-Policy: cross-origin`).
   - **robots.txt** allows everything and points at `/sitemap.xml`. The sitemap lists the three public pages.
   - **Private pages** get none of these tags. Previews (`/p/…`), print files, error and 404 pages stay
     `noindex` as before.
   - **Where it lives.** The page list, titles and descriptions are in `src/site.js`, and the tags are rendered
     in `layout()` in `src/views.js`.
2. **Privacy and terms.** M3's single `/legal` page is now two pages, and `/legal` redirects (301) to
   `/terms`:
   - **`/privacy`**: what is stored and for how long; who processes it (Stripe, Brevo, Prodigi, Gemini, Neon,
     Vercel); **no cookies**; the visit counter, naming its three events; how to switch the counter off; and
     contact through the GitHub repo's issues.
   - **`/terms`**: the service, prices, refunds, a **no-warranty** section, changes, and the same contact.
   - **Footer.** Every page now ends with a footer linking **Privacy · Terms**.
3. **Payments.** No new payment code (see Decisions). The existing "Unlock for $9" button, which goes to
   Stripe Checkout, is now **hidden until `STRIPE_SECRET_KEY` is set**, the way the gift and print forms already
   were. Until then the preview shows "Payments aren't switched on yet" instead of a button that would answer
   503. No payment link or key is in the code.
4. **Visit beacon.** `/beacon.js` sends `POST https://idea-factory.1426davejobs.workers.dev/api/ideas/signal` with JSON
   `{"slug":"alterpaw","kind":…,"referrer":…}`. It's fire-and-forget: `keepalive`, `credentials: 'omit'`, no
   Referer header. The events:
   - **`visit`**: once per browser session (sessionStorage), on every page that loads the beacon: the three
     public pages and the previews.
   - **`activate`**: once per browser (localStorage). **The core action is making a preview:** pressing
     "Reveal the secret life" on the home page, with `POST /generate` succeeding. `upload.js` then dispatches
     `alterpaw:activate`, which the beacon counts.
   - **`checkout`**: each time a pay form is submitted: "Unlock for $9", "Buy it as a gift" or "Order the
     poster" (forms marked `data-checkout`).

   What goes in `referrer`, and when nothing is sent:
   - **`referrer`** is `document.referrer` only when its origin differs from `location.origin`. Otherwise it's
     `null`, so a preview's link never leaves the page.
   - **Nothing is sent:**
     - when `navigator.webdriver` is true (bots, screenshot runs);
     - when localStorage `repohq:notrack` is set (to any value);
     - when storage can't be read;
     - on any deployment that isn't production. The server adds the `<script>` only when Vercel's
       `VERCEL_ENV` is `production`, so preview deployments and local runs never load it.
   - **CSP.** `connect-src` allows `https://idea-factory.1426davejobs.workers.dev` and nothing else off-site.
5. **Deployment.** `.provision` holds `vercel project alterpaw`.
6. **Tests.** 436 pass (`npm test`, about 40 s; there were 402). New: `test/launch.test.js` and
   `test/beacon.test.js`. They cover:
   - the pages rendering, with unique titles and descriptions;
   - every sharing tag, the canonical URL and the JSON-LD;
   - robots.txt, and the sitemap's pages answering 200;
   - the share image's 1200×630 size, its caching and retry, and its CORP header;
   - the footer links on every kind of page;
   - the privacy and terms content, and the `/legal` redirect;
   - **the Buy button hidden without `STRIPE_SECRET_KEY`** and shown with it;
   - the beacon loaded only for `VERCEL_ENV=production`, and the CSP;
   - the beacon's rules in a fake browser: the payload, once per session or browser, the referrer rule,
     webdriver, notrack, blocked storage;
   - `upload.js` signalling `activate` only on success.

   Three older tests were updated, because `/legal` became `/terms` + `/privacy` and the Buy button now needs
   payments configured.
7. **Screenshots.** `npm run screenshots` was run and every PNG opened and checked. It starts the dev server
   itself, drives Chromium from `CHROMIUM_PATH`, and never downloads a browser. The six shots are:
   - the filled-in start page;
   - the end of the form with the footer links;
   - the watermarked result;
   - the $9 offer with the "Unlock for $9" Buy button;
   - both share images.

   They're at the top of the README.

## How to check it

- **Tests:** `npm install`, then `npm test`.
- **Locally:** `npm run dev`, then open these (the dev server fakes Stripe, so the Buy button shows on a
  preview):
  - <http://localhost:3000/>, `/privacy` and `/terms`. View the source for the tags.
  - `/robots.txt`, `/sitemap.xml` and `/og.png`.
- **After the deploy (all free):**
  - paste the production URL into <https://www.opengraph.xyz/> (link preview) and Google's Rich Results Test
    (JSON-LD);
  - open `https://<domain>/robots.txt` and `/sitemap.xml`;
  - optionally submit the sitemap in Google Search Console.
- **The beacon:** on the production domain, open the browser's network tab. You should see:
  - one `signal` POST on the first page of a tab (`visit`);
  - one when you make your first preview (`activate`);
  - one each time you press a pay button (`checkout`).

  On a Vercel preview deployment or `localhost` there should be none.
- **Your own browser:** to keep your visits out of the count, run
  `localStorage.setItem('repohq:notrack', '1')` in the console once, on the production domain.

## Decisions

- **Not Next.js.** alterpaw is a Hono app on Vercel with no build step. So the framework's conventions here are
  plain routes (`/robots.txt`, `/sitemap.xml`, `/og.png`) and one `layout()` for the head tags. There is no
  `metadata` export or `robots.ts`.
- **No `STRIPE_PAYMENT_LINK`.** There's no plan with a price for a payment link (no REVENUE.md), so per the brief
  payments were skipped. More to the point, alterpaw already takes payment through its own Stripe Checkout
  integration:
  - each session carries the preview's slug, and a signed webhook unlocks that preview (M3), and the gifts and
    prints (M4);
  - a Payment Link can't say which preview was paid for. The webhook deliberately ignores
    `client_reference_id`, which a buyer could edit, so a Payment Link would take money and unlock nothing.

  So:
  - the "Buy button" is the existing "Unlock for $9", and the env var that shows it is `STRIPE_SECRET_KEY`;
  - the screenshot run gets no placeholder `STRIPE_PAYMENT_LINK`, because nothing would read it. The dev
    server's local Stripe stand-in shows the button instead.
- **The Buy button is hidden without Stripe.** This is the one visible behaviour change, and only for a site
  without Stripe. A public site shouldn't show a button that answers "payments are not switched on" (503).
  The gift and print forms already worked this way.
- **The beacon also runs on previews.** Shared preview links are where most visitors land. The pay buttons
  live there too, which the `checkout` event needs. It sends nothing from the preview except the event name
  and an outside referrer.
- **Unreadable storage means no signal.** Without sessionStorage or localStorage the beacon can't count
  once, or read the opt-out, so it sends nothing rather than over-count.
- **Canonical origin.** It comes from Vercel's `VERCEL_PROJECT_PRODUCTION_URL`: the shortest custom domain,
  else the `vercel.app` one. It's checked to be a plain host name. Off Vercel, the request's own origin is used.
- **`/p/` isn't disallowed in robots.txt.** Crawlers must fetch a preview to see its `noindex`. A disallowed
  URL can still be indexed from links.
- **Contact is GitHub issues** (`github.com/smithdavedesign/alterpaw/issues`), as asked. The pages warn that
  issues are public, so people shouldn't post a preview link or an address there. Removal requests still go
  through "Report this page" or the Stripe receipt.
- **`.provision` has only the line asked for.** Earlier runs requested the database, the model key,
  `CRON_SECRET`, Stripe, Brevo and Prodigi (BUILD.md, Infrastructure). They aren't repeated here; see "What's
  left" if any never arrived.
- **Screenshot names.** This sandbox can't delete files and there may be at most six PNGs. So the six existing
  names were kept, each now showing what its name says.

## Self-review (gstack pre-landing checklist)

**Pass 1, CRITICAL: none found, so nothing to fix.**
- **SQL and data, race conditions, the LLM trust boundary, shell injection:** the diff touches none of these.
  There are no queries, no new writes, no model output and no subprocess.
- **XSS.** Every new value goes through Hono's `html` escaping. The one `raw()` is the JSON-LD, and it's built
  only from constants and the origin, with every `<` written as a JSON unicode escape. The origin is either a host-name-checked
  env value or a parsed request URL, which can't hold `<` or a newline. So it can't close the `<script>`
  element or break robots.txt.
- **Enum completeness.** I traced the new values to every consumer:
  - the three event kinds: the beacon sends them, `/privacy` names them, and the tests cover them;
  - `data-checkout`: all three pay forms have it (the 402 page reuses the same offer);
  - the `payments` flag: passed at all four places that render the offer.

**Pass 2, informational: one fixed.**
- **Fixed:** `secureHeaders` overwrote `/og.png`'s cross-origin resource policy after the route ran, so other
  sites couldn't have embedded the share image. It's now set by a middleware that runs after it. A test was
  added first and failed before the fix.
- **Fixed, stale docs:** BUILD.md's go-live checklist pointed at the removed `legalPage`; it now points at
  `/terms` and `/privacy`.
- **Left as is:**
  - The beacon checks the opt-out twice on a `visit` (in `once()` and in `send()`). It's cheap, and it keeps
    an opted-out browser from getting storage flags written.
  - Older milestone notes in BUILD.md still say `/legal`. They describe history, and the route redirects.

## What's left for David

1. **Payments: Stripe keys, not a payment link.**
   - Paste nothing into `STRIPE_PAYMENT_LINK`; the app doesn't use one.
   - Set up Stripe as BUILD.md's Infrastructure section describes:
     - a restricted key, stored as **`STRIPE_SECRET_KEY`**;
     - a webhook at `https://<domain>/stripe/webhook` for `checkout.session.completed` and
       `checkout.session.async_payment_succeeded`, its signing secret stored as **`STRIPE_WEBHOOK_SECRET`**;
     - both in the Vercel env through the credential broker.
   - Until then the free preview and share images work and the Buy button stays hidden.
   - **Before taking real money:** Vercel Hobby forbids commercial use. Either move the project to a plan that
     allows it, or move to another host (BUILD.md, "Before Stripe goes live").
2. **A custom domain, if you want one.** Add it in Vercel → Project → Domains. The canonical URLs, sitemap and
   robots.txt follow on their own via `VERCEL_PROJECT_PRODUCTION_URL`. Keep "Automatically expose System
   Environment Variables" on (Vercel's default). A domain costs money, so it's optional; `alterpaw.vercel.app`
   works.
3. **Check the infrastructure from earlier runs.** The site only works with **`DATABASE_URL`** (Neon) and
   **`GOOGLE_API_KEY`** (Gemini) in the Vercel env. `CRON_SECRET` runs the daily photo deletion and gift
   delivery. Brevo and Prodigi are optional (gifts, prints).
4. **The contact link.** It only works if `github.com/smithdavedesign/alterpaw` is public with Issues enabled.
5. **Read `/terms` and `/privacy` once.** They're yours to confirm: the 14-day refund promise, the no-warranty
   wording, and the processor list.
6. **Opt your own browser out** of the count (see "How to check it").
7. **Housekeeping:** `git rm -r .scratch` removes old scratch files committed by an earlier run. This sandbox
   can't delete files.
