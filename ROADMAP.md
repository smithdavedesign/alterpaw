# alterpaw — roadmap

Suggested stack: Next.js (one app for pages and API routes, weekend speed); free model via LiteLLM (matches the $0 policy); HTML/CSS templates rendered to PNG with Playwright or satori (real photo, no image model); Cloudflare R2 or Supabase storage free tier for photos; Stripe Checkout for payment (M3); a commercial-use host such as Cloudflare Pages (Vercel Hobby forbids commercial use).

## M1 — Free generator (a weekend)
Deliverables: upload form (photo, name, species, 3 traits, alter ego); POST /generate that calls the model and returns validated JSON; the four templates rendering the real photo with a watermark; a preview page at an unguessable slug, noindex.
Exit criteria:
- POST /generate with a name "Biscuit", species "dog", 3 traits and alter ego "crime boss" returns 200 with non-empty alias, rap sheet (3+ items), stats (5 numbers 1–99), headline and bio.
- A model response that is invalid JSON or missing a field returns 502 and stores nothing.
- A trait containing `<script>` appears escaped in the rendered page and not as an element.
- GET /p/<slug> returns the pet name, the photo, 4 rendered cards and a `noindex` robots tag; slug is 12+ chars.
- Uploading a file over 10 MB or a non-image returns 400.

## M2 — Share loop
Deliverables: share-sized PNGs (1080×1350 and 1080×1920); "make your pet's" link on each preview; report link; 30-day photo deletion job.
Exit criteria:
- GET /p/<slug>/share.png returns an image of the stated dimensions.
- POST /report with a slug flags the record and the preview returns 410 after 3 reports.
- The deletion job removes photos older than 30 days and the preview then shows a "expired" page.

## M3 — Paid unlock
Deliverables: Stripe Checkout at $9; webhook that marks the order paid; clean high-res PNG and PDF download; one included text regenerate.
Exit criteria:
- Before payment, the download endpoint returns 402 and previews are watermarked.
- A signed `checkout.session.completed` webhook marks the order paid; a repeated or unsigned one changes nothing.
- After payment, GET /p/<slug>/bundle.zip returns the 4 images and a PDF without a watermark.
- POST /regenerate succeeds once for a paid order and returns 409 the second time.

## M4 — Gift flow and print (only if M3 sells)
Deliverables: buy-as-a-gift form (recipient's pet photo uploaded by the buyer, delivery by email on a chosen date); print-on-demand poster upsell at $24–$30.
Exit criteria:
- A gift order with a delivery date in the future sends nothing before that date and one email on it.
- A print order creates one print-on-demand order with the stored shipping address and rejects an incomplete address with 400.
