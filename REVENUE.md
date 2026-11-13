# alterpaw: road to first revenue

**Buyer and price:** a dog or cat owner (or the friend or relative buying them a gag gift) pays **$9 once** for a clean, high-res "wanted poster" bundle of their own pet.

**Honest read:** the evidence that anyone will pay is weak. Nobody has paid David or asked for this. The review gave it 5/10 and a PASS, and David chose to build it anyway. The only thing it proves is that the category sells. So the plan is the cheapest test of whether a stranger pays $9, not a growth plan.

## Forcing questions, applied to money

**Who pays?** Not "pet owners". The best case is a person with a gift budget of $10–$25 and a deadline. Two concrete versions:
1. A dog or cat owner who posts their pet often on Instagram, TikTok or Reddit and wants one funny shareable image of it.
2. A friend or family member shopping for a gag gift for that owner. Gift season runs Oct–Dec, and today is 14 Oct. This is the likelier buyer, because a gift has a deadline and a budget. I found no named person who said they would pay. Evidence strength: weak.

**What do they pay today?**
- Etsy made-to-order wanted posters: from $9.25 for an outlaw-style poster (the seller prints and ships it), and $17.50–$45 for others. (Etsy listing 4517971224; the rest comes from the research file.)
- Etsy digital pet-poster files: about $16 for a movie-poster style download (marked down from $32), $22.50 for a magazine-cover download, and $8.25–$9.67 for newspaper-style templates.
- CardMyDog: "paid from $17" with a free preview. This figure comes from a third-party directory and I could not confirm it on their own site. It launched May 2026 with 6 upvotes and no reviews, so it shows a price and nothing about demand.
- ChatGPT: free. This is the real competitor, because it handles "pet as a person" with no purchase.

I could not find unit sales anywhere. The Etsy review counts (236 and 1.9k) are the strongest sign that demand exists. They are not sales figures.

**Narrowest version worth paying for:** the wanted poster only. Photo in, a funny written rap sheet, a watermarked preview, and $9 for the clean PNG and PDF. The four-template bundle and the gift flow are already built, so they stay as optional extras. Don't ask people to pay for the bundle until the poster has sold.

**Why $9:** it matches the cheapest made-to-order Etsy poster ($9.25) and the Etsy newspaper-style print files (about $9.67). It is half of CardMyDog's $17 and of Etsy's typical $16–$20. The printed poster is a separate upsell at $24–$30, because print and shipping cost $10–$15.

## Shortest path (nothing needs to be built; the MVP exists)

1. **Deploy** on a commercial-use free tier. The research says Vercel Hobby forbids commercial use. Cloudflare Pages is the suggested alternative, but the project's own deploy step names Vercel via the credential broker, so check that choice before charging.
2. **Legal pages:** privacy policy and terms, plus the report link and 30-day photo deletion that are already built.
3. **Stripe:** David creates one $9 one-time product and a Checkout link, then maps it to the repo in RepoHQ. The plan needs no accounts. The agents hold no card, so this is David's step.
4. **Test it with real money first:** David pays $9 himself and checks that the unwatermarked download works end to end. Then refund it.
5. **Hand-sell to 10 people** (below) before posting anywhere public.
6. **Watch what happens.** Do they pay, crop the watermark, or say "I'd just use ChatGPT"?

## First ten users

- 3 from people David knows: friends or family with a dog or cat. Make the poster for them first (free) and ask whether they'd have paid $9. The review's assignment was: make 3 by hand for friends' pets and ask for $9. If none pay, stop.
- 3–4 from the pet owners' communities below, posting a finished poster as content, not a link.
- 3 from small pet accounts on Instagram or TikTok: send each a free poster of their own pet and ask for a repost.

The ten are a guess. None of these channels has been checked for rules this week, so read each community's rules before posting.

## Risks

- ChatGPT does the same trick free, and a clone is a weekend's work.
- No volume evidence at all.
- Pet communities restrict self-promotion, and I found no pet-specific channel guide.
- The season is short: the poster is only a good gift through December.
- Free-model jokes can be flat, and the product depends on them.
- Uploaded photos bring takedown and deletion obligations.

## Stop if

Fewer than 5 paid $9 orders from the first 100 visitors or contacts in 30 days. Stop early if the first 10 hand-sold contacts include zero buyers, or if buyers keep saying they'd use ChatGPT. Stop if fewer than 10% of previews are shared.

Sources: [Etsy outlaw poster](https://www.etsy.com/listing/4517971224), [Etsy magazine-cover template](https://www.etsy.com/listing/4337690806/custom-dog-magazine-cover-template), [CardMyDog on PeerPush](https://peerpush.com/p/cardmydog), and the rest from RESEARCH.md.
