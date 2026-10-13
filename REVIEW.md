# Verdict: PASS — score 5/10

Real price comparables on Etsy, but no volume evidence, no channel, a free substitute (ChatGPT) and a Oct–Dec window that a two-week test plus a build would mostly miss. Same "no channel, no moat" pattern that sank giftlet, pettycourt and squadwrap.

## Forcing questions

### Q1 Demand reality — 4/10
Evidence is Etsy listings at $9.25–$45 and review counts (236 on one wanted poster, 1.9k on a trading card). Reviews are not units, and Etsy buyers get a human-made, print-ready product. CardMyDog (from $17) launched May 2026 with 6 upvotes and no reviews, so it shows a price, not pull. The ChatGPT pet-to-person trend (siasat.com, April 2025) proves people love the joke, and that they get the plain version free. Nobody has paid David, asked when it ships, or been upset by its absence. This is a proven gift category, not proven demand for this product. What would change my mind: 5 strangers paying $9 for a hand-made bundle with no friend involved.

### Q2 Status quo — 5/10
Workarounds are real: pay an Etsy seller (slow, one format, generic jokes), use Adobe Express templates and write the jokes, or ask ChatGPT for a free image. The paid workaround costs $9–$45 and a few days' wait, so it is not painful. The free one costs nothing and is already viral. The real competitor is "post a ChatGPT image and move on."

### Q3 Desperate specificity — 3/10
The target is "an owner of a dog or cat who shares pet content" plus gift-givers. That is a category, not a person. No named buyer, no consequence if the problem stays unsolved. It is a vanity/gift purchase: the "pain" is wanting a funny present. Nothing in RESEARCH.md came from a person who said they'd pay. The pet-gift stats (Weenect, AP-Petside) are about gifts for pets, not funny personalized documents for owners.

### Q4 Narrowest wedge — 6/10
Good: one photo, one alter ego (crime boss wanted poster), a $9 unlock, no image model, no accounts. The wedge is genuinely small. The smallest paid test is hand-made: David makes 5 wanted posters for strangers with a free model and an HTML template and charges $9. Docked because the PRD still bundles four templates, six alter egos, a share loop and a deletion job before anything sells.

### Q6 Future-fit — 4/10
Image models keep getting better and free, and ChatGPT's templates will improve. The text and comedy are the claimed moat, but any weekend clone has the same free model. The printable bundle is the only durable piece, and that is a template library, not a moat. It gets less essential as general assistants gain "make a printable poster" skills.

### Q5 (observation, for M1) — not answerable yet
See the watch list below.

## Premises
1. Pet owners will pay $9 for a finished funny bundle when ChatGPT does the image free. Not supported: the evidence is Etsy human-made listings.
2. The comedy and story, not the art, is what people pay for. Unproven: the research found no test of this.
3. The share loop (watermarked preview with a "make your pet's" link) brings buyers without ads. Plausible for viral formats, but pet communities restrict self-promotion and no pet-specific channel was found.
4. Etsy review counts imply meaningful sales volume. Weak: reviews are not units.
5. Oct–Dec gift season helps. True, but a two-week test starting now plus an MVP build lands in late November.

## Alternatives
- **A. Hand-made concierge test (minimal):** a landing page with a $9 "pay now, I'll make it" button; David generates the bundle by hand for the first 5 buyers. Effort S, low risk. Tests willingness to pay before any code.
- **B. Full self-serve generator with preview/unlock (ideal):** the PRD as written, M1–M3. Effort M/L, medium risk, needs a commercial host and Stripe.
- **C. Extend giftlet (lateral):** giftlet already makes funny AI copy plus photos on a personal page. Add a "pet" template there instead of a new product. Effort S, reuses the repo and a possible audience. Giftlet was itself a pass, so this only helps if giftlet is built anyway.
- **D. Sell the template pack:** a $9–$15 Etsy/Gumroad pack of printable pet templates with joke prompts. No hosting or AI cost, but it is a seller crowded market.

Recommendation: A, and only if David wants it as a seasonal side experiment. As a pipeline product it does not clear the bar.

## Narrowest wedge
A single "Wanted: your dog" poster with an AI-written rap sheet, watermarked preview free, $9 clean download.

## M1 feasibility
- One person in a weekend: yes. Next.js, HTML/CSS template, one free-model call, JSON validation.
- Zero cost: M1 yes (free model via LiteLLM, free storage). M3 needs Stripe and a commercial-use host, so Vercel Hobby is out; that fits ownerBudget but is not $0.
- One test that proves M1: POST /generate with "Biscuit"/dog/3 traits/"crime boss" returns 200 with alias, 3+ rap-sheet items and five 1–99 stats; an invalid model response returns 502 and stores nothing.

## Risks
- Free ChatGPT substitute.
- Volume unproven; Etsy shows reviews not sales.
- Distribution: no ads, restricted communities, no pet-specific channel found.
- Seasonal window short; copycat risk high.
- Free-model humour is uneven.
- Photo hosting: user uploads, takedown and deletion obligations.
- David's interests (design, frontend, Webflow, family tree) show no pets or consumer-gift link.

## Kill criteria
Fewer than 5 paid $9 orders from the first 100 visitors or outreach contacts in 30 days; or buyers say "I'd just use ChatGPT"; or the preview share rate stays under 10%.

## What to watch M1 users doing
Do they pick the alter ego or abandon the form? Do they edit or regenerate the text (unfunny)? Do they share the watermarked preview or just screenshot it? Do they pay for the clean file or crop the watermark? Which of the four cards do they open first?

## Assignment
If wanted anyway: make 3 wanted posters by hand for friends' pets this week and ask each for $9. If none will pay, stop.
