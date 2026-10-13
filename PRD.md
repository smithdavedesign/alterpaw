# alterpaw — PRD

## Problem
Pet owners love joking about their pet's "secret life" and gift-givers buy funny personalized pet items (Etsy wanted posters $17.50–$45, pet trading cards $14–$38), but the made-to-order versions are slow, one format at a time, and the writing is generic. The free alternative, ChatGPT's pet-to-person image trick, gives one image and no finished, printable, story-driven set. Source: RESEARCH.md.

## Target user
An owner of a dog or cat (the pet's own photo on hand) who shares pet content, and the friend or family member buying a funny gift for that owner, mostly in the Oct–Dec pet-gift season. Not a developer audience.

## Competitors & gap
Etsy sellers (hand-made, $9–$45, slow), CardMyDog (AI sports cards from $17, one theme), app-store pet AI apps (costumes, singing videos), free ChatGPT images, Adobe Express templates (DIY). Gap: instant, self-serve, the *real photo* in several formats with one coherent funny backstory. The comedy and story are the product, not the art.

## MVP scope
- Upload one pet photo, enter name, species and 3 traits (picked from chips or free text).
- Pick one of 6 alter egos (crime boss, corrupt CEO, washed-up rock star, celebrity chef, plus two more).
- One free-model call writes the character: alias, rap sheet, stats, bio, front-page headline and article, all in a validated JSON shape.
- Four templates render the owner's real photo: wanted poster, newspaper front page, trading card, character bio card; free low-res watermarked preview.
- Pay $9 to unlock clean high-res PNG and PDF of the bundle; one regenerate of the text included.
- Unique share link and share images sized for Instagram/TikTok; each preview carries a "make your pet's" link.
- Photo deleted after 30 days, a report link, and a basic check to refuse non-pet photos.

## Non-goals
- Generated or stylized images of the pet (no image model).
- Pet portraits, video, singing or talking pets.
- Print-on-demand in M1 (offered after the digital bundle sells).
- Accounts, subscriptions, or a mobile app.
- Real people or celebrities.

## Success metrics
Numbers are test thresholds, not forecasts.
- Hand-fulfilled test: at least 5 paid $9+ orders from 100 landing visitors or outreach contacts within 30 days. Etsy comparables suggest buyers will pay $9–$20, so a 5% floor is a reasonable bar.
- Preview-to-paid conversion of at least 5% once self-serve.
- At least 20% of previews shared (share link clicked or image downloaded).
- Under 10% of generated texts regenerated for being unfunny.
- Cost per order under $0.10 for the AI call, hosting and Stripe fee excluded.

## Open questions
- Will buyers pay $9 when ChatGPT does a similar thing free?
- Does the bundle sell more as a self-purchase or as a gift (and does a gift-send flow matter)?
- Which alter egos sell best?
- Can a first 100 visitors be reached without ads in pet communities that restrict promotion?
- Is a printed upsell worth the $10–$15 print and shipping cost?
