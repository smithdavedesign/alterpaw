# alterpaw — your pet's secret life, as a funny wanted poster, newspaper and trading card

## Screenshots

![Home page on desktop with the form filled in for Biscuit the dog](docs/screenshots/home-desktop.png)
The start page takes a photo (shrunk in the browser), a name, species, three traits and an alter ego, and tells gift buyers to upload the recipient's pet.

![The "Buy it as a gift" form on an iPhone 13, filled in for Jamie with a delivery date six days ahead](docs/screenshots/preview-mobile.png)
On the generated preview, a gift buyer enters the recipient's email, a message, the delivery date and its time zone, then pays $9.

![Biscuit's paid preview on desktop: "Your orders" lists the scheduled gift email and the poster sent to the printer, above the unwatermarked cards](docs/screenshots/preview-desktop.png)
After paying for the gift and a $29 printed poster, the preview is unlocked, the gift email is scheduled for its date and the print order has been placed.

![Home page on an iPhone 13 with the photo chosen](docs/screenshots/home-mobile.png)
On a phone the same form stacks into one column, and the chosen photo shows before upload.

![The paid wanted-poster share image at Instagram post size](docs/screenshots/share-post-desktop.png)
The share link returns a 1080×1350 wanted-poster PNG rendered on the server with the pet's photo, without the "free preview" stamp once paid.

![The paid wanted-poster share image at Stories size on an iPhone 13](docs/screenshots/share-story-mobile.png)
The 1080×1920 Stories/Reels/TikTok version adds the newspaper headline and the full rap sheet.

_Made by `npm run screenshots` with a drawn sample dog, sample people (`example.com`) and a fictional address. It uses the app's offline stand-ins: no database, no model call, and Stripe, the gift email and the printer are simulated locally, through the app's real signed-webhook path. So the jokes are canned text, no money moves, no email is sent and nothing is printed. The UI font is the sandbox Chromium's fallback; phones and desktops use their own system font._

For pet owners and the friends who buy them gifts, it turns one pet photo into a funny alter-ego bundle (wanted poster with rap sheet, newspaper front page, trading card, bio) for $9–$20 instead of a slow $17–$45 Etsy order.

- [Research](RESEARCH.md) — findings and sources
- [PRD](PRD.md)
- [Roadmap](ROADMAP.md)

Effort: Low · Confidence: Low

_Researched by the idea pipeline on 2026-10-13 ([original record](https://github.com/smithdavedesign/idea-factory/tree/main/ideas/alterpaw)); repo created on David's go-ahead 2026-10-13._
