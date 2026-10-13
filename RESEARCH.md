# alterpaw — research

## Summary
Pet owners upload one photo, pick an alter ego (crime boss, corrupt CEO, washed-up rock star, celebrity chef) and get a funny bundle built around the real photo: wanted poster with rap sheet, fake newspaper front page, trading card with stats, plus a character bio. Templates carry the owner's real photo; a free model writes the text, so there is no image generation and near-zero cost.
The competing products sell the *look* (AI portraits, sports cards). The differentiator is the *comedy and story* about a pet the buyer knows, which an owner can screenshot and post.
Honest read: the paid format exists today (Etsy wanted posters $17–$45, pet trading cards $14–$38, CardMyDog from $17), but free ChatGPT image tricks are the main threat and the evidence of volume is thin. This should be tested by hand before anything is built.

## Evidence of the problem
There is no "problem" so much as a proven gift/vanity purchase:
- Etsy shows many custom "criminal pet" wanted posters, about $17.50–$45, one marked down from $23.07 to $19.61 with 236 reviews on that listing; custom pet trading cards $14–$38, one listing with 1.9k reviews at a $18.45 sale price. Etsy shows reviews, not units sold, so volume is unproven. https://www.etsy.com/market/wanted_dog_poster?page=4 · https://www.etsy.com/market/pet_trading_card · https://www.etsy.com/listing/866753323/custom-pet-wanted-poster-funny-pet-lover
- Another Etsy listing: a Western outlaw pet wanted poster from $9.25, made to order from a pet photo plus a chosen funny "crime", reviewed by a person before printing. https://www.etsy.com/listing/4517971224 (search snippet only; page returned 403 when fetched)
- The "turn your pet into a person" trend went viral on TikTok, Reddit and X in April 2025 using ChatGPT's free image tool, and ChatGPT's own Instagram posted about it. This shows people love pet alter egos and share them, and also that the plain image version is free. https://www.siasat.com/turn-your-pet-photo-into-a-person-chatgpts-latest-viral-fun-3212717/
- Pet gifting is normal: Weenect (2024) found about 77% of owners planned a Christmas present for their pet (France and neighbours; US figures differ); an AP-Petside poll found 51% of US owners buying holiday gifts, average budget $46; APPA says 89% of small-animal owners buy gifts for pets. https://www.weenect.com/us/en/lab/pets-christmas-gifts-study/ · https://www.petfoodindustry.com/pet-food-marketing-and-branding/article/15710630/gifts-for-pets-fuel-seasonal-dog-cat-food-sales
- US pet industry spending was projected at $152B in 2024 (APPA, quoted by a market-report site, secondhand). https://cn.gii.tw/report/omr1882950-global-pet-care-apps-market.html

## Who pays
- **Buyer:** pet owners buying for themselves, and friends/family buying a gift for a pet owner (also pet-gift season, Oct–Dec).
- **Price point:** $7–$20 per bundle (digital); optional printed poster or card through print-on-demand. A free preview with pay-to-unlock is the norm in this niche.
- **Evidence they pay for something like it today:** Etsy wanted posters $17.50–$45 and trading cards $14–$38 (above); CardMyDog (AI sports trading card from a dog photo) lists paid plans from $17 with a free preview, launched May 2026, only 6 upvotes and no reviews on PeerPush, so it shows the price, not traction. https://peerpush.com/p/cardmydog
- Weak spots: Etsy digital newspaper-style pet prints sell for about $9.67; Etsy shows review counts, not sales; nothing found proves a conversion rate for a text-driven, instant, self-serve version.

## Competitors & alternatives
| Name | Price | Gap |
|---|---|---|
| Etsy custom pet wanted posters / mugshots | $9.25–$45, made to order by a person | Slow (a person edits), one format per listing, no story across formats |
| Etsy pet trading cards | $14–$38 | Same; stats are often generic |
| CardMyDog | from $17, free preview | Sports theme only, image-focused, no narrative bundle |
| PetVerse, Pets AI, Pete AI, My Talking Pet AI (app-store apps) | free with subscriptions or credits | Fantasy costumes, singing or video clips; not a funny document bundle. Listings are developer claims. https://mwm.ai/apps/petverse-pet-post-tool/6770901984 · https://apps.apple.com/us/app/-/id6752623916 |
| ChatGPT image tool (free) | $0 | Does the "pet as a person" look free; no printable bundle, no consistent templates, results vary (dark-coated pets come out wrong) |
| Adobe Express wanted/newspaper templates | free/subscription | DIY; owner writes all the jokes. https://www.adobe.com/fi/express/templates/poster/wanted |
| AI pet portraits (many, sold as turnkey businesses) | varies, artists $80–$300 | Crowded; competes on art, which this idea avoids. https://wael-nasef-reviews.beehiiv.com/p/ai-pet-portrait-studio-review-2025-the-ultimate-ai-pet-art-creator-for-pet-lovers-and-entrepreneurs |

## Technical notes
- Rendering: HTML/CSS (or SVG) templates with the real photo dropped in (sepia/halftone filters for the newspaper and poster look), exported to PNG and PDF. No image model needed. Photo quality and cropping are the main craft; a pet-face crop helper may help.
- Text: one free-model call returns JSON (name, alias, crimes, rap sheet, stats, bio, headline, article) from the pet name, species, a few traits, and the chosen alter ego. Validate the JSON and length-cap fields.
- Print: print-on-demand per order, nothing in stock. Printful lists posters from about $5.39 (8×10) plus shipping from $4.99 (blog figures, not verified against Printful). Prodigi 12×18 shipping to the US was $8.79 via Printify's table. So a printed poster has a real cost of about $10–$15 before the product, meaning a printed upsell should be priced $24–$30. https://podvector.ai/articles/printful/costs-and-charges/printful-poster-pricing-full-breakdown-for-pod-sellers · https://printify.com/shipping-rates/prodigi/
- Payments need Stripe; a commercial-use host is needed (not Vercel Hobby).
- Photos of pets only: reject photos that look like people with a basic check and a report/takedown link, and delete uploads after 30 days.

## Risks & open questions
- Free substitute: ChatGPT already does pet-to-persona images; the bet is that a finished, funny, printable bundle beats a one-off image. Unproven.
- Seasonal: pet-gift peak Oct–Dec, so a hand-run test has a short window.
- Distribution: pet communities restrict self-promotion; the guides found are general Reddit advice (90/10 participation, no sockpuppets), nothing pet-specific. Reaching owners without ads likely means the product's own share loop plus friendly outreach to small pet-account creators. https://redship.io/blog/reddit-self-promotion-rules-2026
- Previous verdicts: giftlet, pettycourt and squadwrap all passed for "no price evidence, no channel, no moat". This idea has better price comparables (Etsy listings) but still lacks volume data.
- Copycat risk is high; a weekend clone is possible.
- Humor quality from free models is uneven; needs a curated alter-ego library and examples.
- Real-person likeness: pets only, so lower legal risk than celebrity-style products; still needs a takedown path for uploaded photos.

## Sources
- https://www.etsy.com/market/wanted_dog_poster?page=4
- https://www.etsy.com/market/pet_trading_card
- https://www.etsy.com/listing/866753323/custom-pet-wanted-poster-funny-pet-lover
- https://www.etsy.com/listing/4517971224
- https://peerpush.com/p/cardmydog
- https://www.siasat.com/turn-your-pet-photo-into-a-person-chatgpts-latest-viral-fun-3212717/
- https://www.weenect.com/us/en/lab/pets-christmas-gifts-study/
- https://www.petfoodindustry.com/pet-food-marketing-and-branding/article/15710630/gifts-for-pets-fuel-seasonal-dog-cat-food-sales
- https://cn.gii.tw/report/omr1882950-global-pet-care-apps-market.html
- https://mwm.ai/apps/petverse-pet-post-tool/6770901984
- https://apps.apple.com/us/app/-/id6752623916
- https://www.adobe.com/fi/express/templates/poster/wanted
- https://podvector.ai/articles/printful/costs-and-charges/printful-poster-pricing-full-breakdown-for-pod-sellers
- https://printify.com/shipping-rates/prodigi/
- https://redship.io/blog/reddit-self-promotion-rules-2026
