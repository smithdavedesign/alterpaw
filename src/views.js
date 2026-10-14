// HTML, CSS and the browser script. This is the only place user and model text meets markup:
// every value goes through Hono's `html` tag, which escapes & < > " ' — never `raw()` on data.
// User text only ever lands in element text or quoted attributes, never in <script>, <style> or URLs.
import { html } from 'hono/html';
import { ALTER_EGOS, SPECIES, findAlterEgo } from './character.js';
import { MAX_NAME_LENGTH, MAX_TRAIT_LENGTH, MAX_GIFT_NAME_LENGTH, MAX_GIFT_MESSAGE_LENGTH, US_STATES, isTimeZone } from './input.js';
import { PRICE_LABEL, PRINT_PRICE_LABEL, priceLabel } from './payments.js';
import { PRINT_SIZE_LABEL } from './print.js';

// Enough repeats to tile the tallest card once rotated.
const WATERMARK_REPEATS = 36;

const TRAIT_CHIPS = [
  'greedy',
  'dramatic',
  'loyal',
  'lazy',
  'sneaky',
  'clingy',
  'loud',
  'food-obsessed',
  'afraid of the vacuum',
  'thinks they are a person',
  'zoomies at 3 a.m.',
  'judgmental',
];

// One entry per SPECIES value (character.js); `option` is the form label, `label` the card label.
// Also used by the share image (share.js).
export const SPECIES_STYLE = {
  dog: { option: 'Dog', label: 'Dog', paper: 'The Daily Bark', reward: 'one (1) slightly chewed tennis ball' },
  cat: { option: 'Cat', label: 'Cat', paper: 'The Purrington Post', reward: 'an empty cardboard box, no questions asked' },
  other: { option: 'Other', label: 'Pet', paper: 'The Critter Chronicle', reward: 'a lifetime supply of snacks' },
};

// `referrer` relaxes the site-wide no-referrer header for one page. The preview needs `same-origin`: under
// no-referrer, browsers send `Origin: null` on its report form, and older ones (no Sec-Fetch-Site, e.g.
// Safari before 16.4) would fail the CSRF check. same-origin still never sends the slug to another site.
function layout({ title, robots, body, script = false, referrer = null }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="${robots}">
${referrer ? html`<meta name="referrer" content="${referrer}">` : ''}
<title>${title}</title>
<link rel="stylesheet" href="/styles.css">
${script ? html`<script src="/upload.js" defer></script>` : ''}
</head>
<body>
${body}
</body>
</html>`;
}

export function homePage() {
  const body = html`<main class="home">
  <header class="hero">
    <p class="brand">alterpaw</p>
    <h1>Your pet's secret life, exposed.</h1>
    <p class="lede">Upload one photo, pick an alter ego, and get a wanted poster, a newspaper front page, a trading card and a character bio starring your actual pet.</p>
    <p class="gift-note">Making it as a gift? Upload a photo of their pet, then choose "Buy it as a gift" on the next page and we'll email it to them on the day you pick.</p>
  </header>
  <form id="pet-form" class="pet-form" action="/generate" method="post" enctype="multipart/form-data">
    <label class="field">
      <span class="field-label">Photo of your pet</span>
      <input type="file" name="photo" accept="image/*" required>
      <img id="photo-preview" class="photo-preview" alt="" hidden>
    </label>
    <div class="row">
      <label class="field">
        <span class="field-label">Name</span>
        <input type="text" name="name" maxlength="${MAX_NAME_LENGTH}" required autocomplete="off" placeholder="Biscuit">
      </label>
      <label class="field">
        <span class="field-label">Species</span>
        <select name="species" required>
          ${SPECIES.map((s) => html`<option value="${s}">${SPECIES_STYLE[s]?.option ?? s}</option>`)}
        </select>
      </label>
    </div>
    <fieldset class="field">
      <legend class="field-label">Three traits</legend>
      <div class="trait-inputs">
        <input type="text" name="traits" maxlength="${MAX_TRAIT_LENGTH}" required placeholder="greedy" aria-label="Trait 1">
        <input type="text" name="traits" maxlength="${MAX_TRAIT_LENGTH}" placeholder="loyal" aria-label="Trait 2">
        <input type="text" name="traits" maxlength="${MAX_TRAIT_LENGTH}" placeholder="afraid of the vacuum" aria-label="Trait 3">
      </div>
      <div class="chips">
        ${TRAIT_CHIPS.map((trait) => html`<button type="button" class="chip" data-trait="${trait}">${trait}</button>`)}
      </div>
    </fieldset>
    <fieldset class="field">
      <legend class="field-label">Alter ego</legend>
      <div class="egos">
        ${ALTER_EGOS.map(
          (ego, i) => html`<label class="ego">
          <input type="radio" name="alterEgo" value="${ego.id}" required${i === 0 ? html` checked` : ''}>
          <span class="ego-label">${ego.label}</span>
          <span class="ego-brief">${ego.brief}</span>
        </label>`,
        )}
      </div>
    </fieldset>
    <button type="submit" class="submit">Reveal the secret life</button>
    <p id="form-status" class="status" role="status" aria-live="polite"></p>
    <noscript><p class="status error">alterpaw needs JavaScript to shrink your photo before it uploads.</p></noscript>
  </form>
  <footer class="foot">Free preview. Your photo stays on an unlisted page that search engines are told not to index. ${PRICE_LABEL} unlocks the clean, high-res bundle. <a href="/legal">Terms, refunds and privacy</a></footer>
</main>`;
  return layout({ title: "alterpaw — your pet's secret life", robots: 'index, follow', body, script: true });
}

// Only unpaid previews are watermarked; the bundle unlocks clean cards.
const watermark = (pet) =>
  pet.paidAt
    ? ''
    : html`<div class="watermark" aria-hidden="true">${Array.from({ length: WATERMARK_REPEATS }, () => html`<span>alterpaw preview</span>`)}</div>`;

const photo = (pet) => html`<img class="photo" src="/p/${pet.slug}/photo" alt="${pet.name}">`;

function wantedCard(pet, style) {
  const c = pet.character;
  return html`<article class="card card-wanted" data-card="wanted">
  <p class="wanted-title">Wanted</p>
  <p class="wanted-sub">for crimes against the household</p>
  <div class="frame">${photo(pet)}</div>
  <h2 class="wanted-name">${pet.name}</h2>
  <p class="wanted-alias">a.k.a. ${c.alias}</p>
  <h3 class="wanted-rap">Rap sheet</h3>
  <ol class="rap-sheet">${c.rapSheet.map((item) => html`<li>${item}</li>`)}</ol>
  <p class="reward">Reward: ${style.reward}</p>
  ${watermark(pet)}
</article>`;
}

function newspaperCard(pet, style) {
  const c = pet.character;
  const date = pet.createdAt.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
  return html`<article class="card card-newspaper" data-card="newspaper">
  <header class="masthead">
    <p class="paper-name">${style.paper}</p>
    <p class="paper-meta"><span>${date}</span><span>Late edition</span><span>Price: one treat</span></p>
  </header>
  <h2 class="headline">${c.headline}</h2>
  <figure class="news-photo">${photo(pet)}<figcaption>${pet.name}, also known as ${c.alias}, photographed at home.</figcaption></figure>
  <div class="article">${c.article.split(/\n{2,}/).map((p) => html`<p>${p}</p>`)}</div>
  ${watermark(pet)}
</article>`;
}

function tradingCard(pet, style, ego) {
  const c = pet.character;
  return html`<article class="card card-trading" data-card="trading">
  <header class="tc-head"><h2 class="tc-name">${pet.name}</h2><span class="tc-type">${ego.label}</span></header>
  <div class="tc-photo">${photo(pet)}</div>
  <p class="tc-alias">${c.alias}</p>
  <ul class="stats">
    ${c.stats.map(
      (s) => html`<li><span class="stat-label">${s.label}</span><svg class="stat-bar" viewBox="0 0 99 6" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="99" height="6"></rect><rect class="fill" width="${s.value}" height="6"></rect></svg><b class="stat-value">${s.value}</b></li>`,
    )}
  </ul>
  <p class="tc-foot">${style.label} · ${ego.label} series</p>
  ${watermark(pet)}
</article>`;
}

function bioCard(pet, style, ego) {
  const c = pet.character;
  return html`<article class="card card-bio" data-card="bio">
  <p class="bio-kicker">Character profile</p>
  <div class="bio-photo">${photo(pet)}</div>
  <h2 class="bio-name">${pet.name}</h2>
  <p class="bio-alias">${c.alias}</p>
  <dl class="bio-facts"><dt>Species</dt><dd>${style.label}</dd><dt>Alter ego</dt><dd>${ego.label}</dd></dl>
  <ul class="bio-traits">${pet.traits.map((t) => html`<li>${t}</li>`)}</ul>
  <p class="bio-text">${c.bio}</p>
  ${watermark(pet)}
</article>`;
}

// Share image sizes (rendered by share.js). Defined here so app.js can check `?size=` without loading the
// renderer, which costs ~200 ms of cold start that /generate and the preview page shouldn't pay.
export const SHARE_SIZES = {
  post: { width: 1080, height: 1350 }, // Instagram feed, portrait 4:5
  story: { width: 1080, height: 1920 }, // Stories, Reels, TikTok 9:16
};

// Download names are fixed, never built from user text.
export const shareFileName = (size) => `alterpaw-wanted-${size}.png`;

const SHARE_LINKS = [
  { size: 'post', params: [], label: 'Instagram post' },
  { size: 'story', params: ['size=story'], label: 'Story, Reels or TikTok' },
];

// Share images are cached by the browser for 10 minutes. Paying (no more stamp) and rewriting (new text)
// change the image, so they change the link too: `v` is ignored by the server and only busts the cache.
const shareVersion = (pet) =>
  pet.paidAt ? [`v=${[pet.paidAt, pet.regeneratedAt].filter(Boolean).map((d) => d.getTime().toString(36)).join('-')}`] : [];

function shareSection(pet, retentionDays) {
  return html`<section class="share" aria-labelledby="share-title">
  <h2 id="share-title">Share the wanted poster</h2>
  <div class="share-links">
    ${SHARE_LINKS.map(({ size, params, label }) => {
      const { width, height } = SHARE_SIZES[size];
      const query = [...params, ...shareVersion(pet)].join('&');
      return html`<a class="share-link" href="/p/${pet.slug}/share.png${query ? `?${query}` : ''}" download="${shareFileName(size)}">${label} <span>${width}×${height}</span></a>`;
    })}
  </div>
  <p class="share-note">Anyone with this page's link can see it. After ${retentionDays} days the page expires and the photo is deleted in the next daily clean-up.</p>
</section>`;
}

const makeYoursLink = () => html`<a class="make-yours" href="/">Make your pet's secret life</a>`;

// A plain form inside <details>: no script needed, and the page keeps its no-inline-script CSP.
function reportForm(pet, reasons) {
  return html`<details class="report">
  <summary>Report this page</summary>
  <form method="post" action="/report">
    <input type="hidden" name="slug" value="${pet.slug}">
    <label class="field"><span class="field-label">What's wrong?</span>
      <select name="reason">
        ${reasons.map((r) => html`<option value="${r.id}">${r.label}</option>`)}
      </select>
    </label>
    <button type="submit">Send report</button>
  </form>
</details>`;
}

// The bundle's download name. Fixed, never built from user text.
export const BUNDLE_FILE_NAME = 'alterpaw-bundle.zip';

const DAY_MS = 24 * 60 * 60 * 1000;
const longDate = (date) => date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// M4: the zones the gift form offers. The one Vercel detected (x-vercel-ip-timezone) is added if it's missing,
// so every buyer can pick their own; any valid IANA name is accepted by the server.
export const GIFT_TIME_ZONES = [
  ['America/New_York', 'Eastern time (New York)'],
  ['America/Chicago', 'Central time (Chicago)'],
  ['America/Denver', 'Mountain time (Denver)'],
  ['America/Phoenix', 'Arizona (Phoenix)'],
  ['America/Los_Angeles', 'Pacific time (Los Angeles)'],
  ['America/Anchorage', 'Alaska (Anchorage)'],
  ['Pacific/Honolulu', 'Hawaii (Honolulu)'],
  ['Europe/London', 'UK and Ireland (London)'],
  ['Europe/Paris', 'Central Europe (Paris, Berlin)'],
  ['Asia/Kolkata', 'India (Kolkata)'],
  ['Asia/Tokyo', 'Japan (Tokyo)'],
  ['Australia/Sydney', 'Eastern Australia (Sydney)'],
  ['Pacific/Auckland', 'New Zealand (Auckland)'],
  ['UTC', 'UTC'],
];

function zoneOptions(selected) {
  const zones = GIFT_TIME_ZONES.some(([zone]) => zone === selected) ? GIFT_TIME_ZONES : [[selected, selected.replaceAll('_', ' ')], ...GIFT_TIME_ZONES];
  return zones.map(([zone, label]) => html`<option value="${zone}"${zone === selected ? html` selected` : ''}>${label}</option>`);
}

// A plain form inside <details> (no script on this page): the bundle, bought for someone else and emailed to them
// on a date. `gift` is { zone, minDate, maxDate, downloadBy } from app.js, or null when gifts are off.
function giftForm(pet, gift) {
  return html`<details class="gift">
  <summary>Or buy it as a gift: we email it to them on the day you choose (${priceLabel('gift')})</summary>
  <form method="post" action="/gift" class="gift-form">
    <input type="hidden" name="slug" value="${pet.slug}">
    <div class="row">
      <label class="field"><span class="field-label">Their email</span>
        <input type="email" name="recipientEmail" required maxlength="254" autocomplete="off" placeholder="name@example.com"></label>
      <label class="field"><span class="field-label">Their name <span class="optional">(optional)</span></span>
        <input type="text" name="recipientName" maxlength="${MAX_GIFT_NAME_LENGTH}" autocomplete="off"></label>
    </div>
    <label class="field"><span class="field-label">From</span>
      <input type="text" name="fromName" required maxlength="${MAX_GIFT_NAME_LENGTH}" placeholder="Your name"></label>
    <label class="field"><span class="field-label">Message <span class="optional">(optional)</span></span>
      <textarea name="message" maxlength="${MAX_GIFT_MESSAGE_LENGTH}" rows="3" placeholder="Happy birthday! I always knew."></textarea></label>
    <div class="row">
      <label class="field"><span class="field-label">Email it on</span>
        <input type="date" name="deliverOn" required min="${gift.minDate}" max="${gift.maxDate}"></label>
      <label class="field"><span class="field-label">In this time zone</span>
        <select name="timeZone">${zoneOptions(gift.zone)}</select></label>
    </div>
    <button type="submit" class="pay">Buy it as a gift for ${priceLabel('gift')}</button>
    <p class="fine">They get one email that day with the link to this page, unlocked, to download until ${longDate(gift.downloadBy)}. You can see and download it too.</p>
  </form>
</details>`;
}

// The $9 offer: a plain form to /checkout, which answers with a redirect to Stripe Checkout.
// `confirming` is set when the buyer is back from Stripe but the webhook hasn't marked the preview paid yet.
function offerSection(pet, { confirming = false, gift = null } = {}) {
  return html`<section class="unlock" aria-labelledby="unlock-title">
  <h2 id="unlock-title">Get the clean bundle: ${PRICE_LABEL}</h2>
  ${confirming
    ? html`<p class="notice" role="status">Thanks! We're confirming your payment with Stripe. <a href="/p/${pet.slug}?checkout=success">Refresh this page</a> in a few seconds.</p>`
    : ''}
  <ul class="unlock-list">
    <li>All four cards as high-res images (1800×2250 px, 8×10 in), no watermark</li>
    <li>A printable PDF with all four</li>
    <li>One free rewrite of the jokes if they don't land</li>
  </ul>
  <form method="post" action="/checkout">
    <input type="hidden" name="slug" value="${pet.slug}">
    <button type="submit" class="pay">Unlock for ${PRICE_LABEL}</button>
  </form>
  ${gift ? giftForm(pet, gift) : ''}
  <p class="fine">One-time payment through Stripe, no account. <a href="/legal">Terms, refunds and privacy</a></p>
</section>`;
}

// M4: the printed poster, offered once the bundle is paid for. A plain form; the address goes to the printer.
function printSection(pet) {
  return html`<section class="unlock print" aria-labelledby="print-title">
  <h2 id="print-title">Hang it on the wall: a printed poster, ${PRINT_PRICE_LABEL}</h2>
  <p>The wanted poster on ${PRINT_SIZE_LABEL} matte art paper, printed and shipped by our print partner. US addresses only; shipping included.</p>
  <details class="print-details">
    <summary>Order the printed poster</summary>
    <form method="post" action="/print" class="address-form">
      <input type="hidden" name="slug" value="${pet.slug}">
      <label class="field"><span class="field-label">Full name</span>
        <input type="text" name="name" required maxlength="60" autocomplete="shipping name"></label>
      <label class="field"><span class="field-label">Street address</span>
        <input type="text" name="line1" required maxlength="100" autocomplete="shipping address-line1"></label>
      <label class="field"><span class="field-label">Apartment, suite, etc. <span class="optional">(optional)</span></span>
        <input type="text" name="line2" maxlength="100" autocomplete="shipping address-line2"></label>
      <div class="row row-3">
        <label class="field"><span class="field-label">City</span>
          <input type="text" name="city" required maxlength="60" autocomplete="shipping address-level2"></label>
        <label class="field"><span class="field-label">State</span>
          <select name="state" required autocomplete="shipping address-level1">
            <option value="">Choose…</option>
            ${US_STATES.map((s) => html`<option value="${s.code}">${s.name}</option>`)}
          </select></label>
        <label class="field"><span class="field-label">ZIP code</span>
          <input type="text" name="zip" required maxlength="10" inputmode="numeric" pattern="[0-9]{5}(-[0-9]{4})?" autocomplete="shipping postal-code"></label>
      </div>
      <p class="fine">Country: United States</p>
      <button type="submit" class="pay">Order the poster for ${PRINT_PRICE_LABEL}</button>
    </form>
  </details>
</section>`;
}

// What's been bought for this preview (M4). The page is visible to anyone with the link, so the recipient's
// address is masked and a shipping address shows only its city.
const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};
const weekdayDate = (date) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dateInZone = (instant, timeZone) =>
  instant.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: isTimeZone(timeZone) ? timeZone : 'UTC' });

function orderLine(order) {
  const d = order.details;
  if (order.kind === 'gift') {
    if (order.sentAt) return html`<li><b>Gift.</b> Emailed to ${d ? maskEmail(d.recipientEmail) : 'the recipient'} on ${dateInZone(order.sentAt, d?.timeZone)}.</li>`;
    // Cancelled: the address was refused, or its details are gone. (A taken-down preview cancels it too, but then
    // this page isn't shown at all.)
    if (order.cancelledAt) return html`<li><b>Gift.</b> Not sent: we couldn't deliver the email${d ? ` to ${maskEmail(d.recipientEmail)}` : ''}. It will be refunded.</li>`;
    if (!d) return html`<li><b>Gift.</b> Paid.</li>`;
    return html`<li><b>Gift.</b> We'll email ${maskEmail(d.recipientEmail)} on ${weekdayDate(d.deliverOn)}${d.timeZone === 'UTC' ? ' (UTC)' : ''}, with the link to this page.</li>`;
  }
  const where = d ? `, shipping to ${d.city}, ${d.state}` : '';
  return order.podOrderId
    ? html`<li><b>Printed poster (${PRINT_SIZE_LABEL}).</b> Sent to the printer${where}. It usually arrives within two weeks.</li>`
    : html`<li><b>Printed poster (${PRINT_SIZE_LABEL}).</b> Paid, on its way to the printer${where}.</li>`;
}

function ordersSection(orders) {
  return html`<section class="orders" aria-labelledby="orders-title">
  <h2 id="orders-title">Your orders</h2>
  <ul>${orders.map(orderLine)}</ul>
</section>`;
}

// What a paid preview gets: the download, the one rewrite, and until when.
function bundleSection(pet, retentionDays) {
  const deadline = longDate(new Date(pet.createdAt.getTime() + retentionDays * DAY_MS));
  return html`<section class="unlock paid" aria-labelledby="bundle-title">
  <h2 id="bundle-title">Your bundle is ready</h2>
  <p><a class="download" href="/p/${pet.slug}/bundle.zip" download="${BUNDLE_FILE_NAME}">Download the bundle (.zip)</a></p>
  <p class="fine">Four high-res images and a printable PDF. Download it before ${deadline}: the photo is deleted ${retentionDays} days after upload, and the bundle with it.</p>
  ${pet.regeneratedAt
    ? html`<p class="fine">Your one free rewrite is used.</p>`
    : html`<form method="post" action="/regenerate">
    <input type="hidden" name="slug" value="${pet.slug}">
    <button type="submit">Rewrite the jokes (one free rewrite)</button>
  </form>
  <p class="fine">The new text replaces this one, on the cards and in the bundle.</p>`}
</section>`;
}

// Policy numbers and lists (retention, report reasons) come from app.js, the one place they're defined.
// `checkoutReturn` is true on Stripe's success URL. M4: `orders` are the preview's paid orders, `gift` the gift
// form's settings (null when gifts are off or it's too late for one), `prints` whether the poster is on offer.
export function previewPage(pet, { reportReasons, retentionDays, checkoutReturn = false, orders = [], gift = null, prints = false }) {
  const style = SPECIES_STYLE[pet.species] ?? SPECIES_STYLE.other;
  const ego = findAlterEgo(pet.alterEgo) ?? { label: pet.alterEgo };
  const body = html`<main class="preview">
  <header class="preview-head">
    <a class="brand" href="/">alterpaw</a>
    <h1>The secret life of ${pet.name}</h1>
    <p class="lede">Alter ego: ${ego.label}. ${pet.paidAt ? 'Unlocked: no watermark.' : 'Free preview, watermarked.'}</p>
  </header>
  ${orders.length ? ordersSection(orders) : ''}
  <section class="cards">
    ${wantedCard(pet, style)}
    ${newspaperCard(pet, style)}
    ${tradingCard(pet, style, ego)}
    ${bioCard(pet, style, ego)}
  </section>
  ${pet.paidAt ? bundleSection(pet, retentionDays) : offerSection(pet, { confirming: checkoutReturn, gift })}
  ${pet.paidAt && prints ? printSection(pet) : ''}
  ${shareSection(pet, retentionDays)}
  <section class="cta">${makeYoursLink()}</section>
  <footer class="foot">${reportForm(pet, reportReasons)}</footer>
</main>`;
  return layout({ title: `The secret life of ${pet.name} — alterpaw`, robots: 'noindex, nofollow', body, referrer: 'same-origin' });
}

function messagePage(title, heading, paragraphs) {
  const body = html`<main class="message">
  <a class="brand" href="/">alterpaw</a>
  <h1>${heading}</h1>
  ${paragraphs.map((p) => html`<p>${p}</p>`)}
  <p>${makeYoursLink()}</p>
</main>`;
  return layout({ title: `${title} — alterpaw`, robots: 'noindex, nofollow', body });
}

// 410 pages. Neither shows anything from the preview: an expired photo is gone, a removed one is hidden.
export const expiredPage = ({ retentionDays }) =>
  messagePage('Expired', 'This preview has expired', [
    `Previews last ${retentionDays} days and then the photo is deleted, so this secret life is now a closed case.`,
  ]);

export const removedPage = () =>
  messagePage('Taken down', 'This preview was taken down', [
    'Several people reported it, so it is hidden while we take a look.',
  ]);

export const reportThanksPage = () =>
  messagePage('Report received', 'Thanks, we got your report', [
    'Previews that several people report are taken down until we have looked at them.',
  ]);

// 402 for the bundle before payment: the offer itself, so the page is one click from paying. `print` is set when
// it answers a printed-poster order, which comes after the bundle.
export function paymentRequiredPage(pet, { print = false } = {}) {
  const body = html`<main class="message">
  <a class="brand" href="/">alterpaw</a>
  <h1>The clean bundle is ${PRICE_LABEL}</h1>
  <p>${print ? 'The printed poster is offered once the bundle for this preview is paid for.' : 'The download unlocks once the bundle for this preview is paid for.'}</p>
  ${offerSection(pet)}
  <p><a href="/p/${pet.slug}">Back to the preview</a></p>
</main>`;
  return layout({ title: 'Unlock the bundle — alterpaw', robots: 'noindex, nofollow', body, referrer: 'same-origin' });
}

// Answers to a rewrite form post that didn't rewrite. Both lead back to the preview.
function backToPreviewPage(pet, title, heading, paragraph) {
  const body = html`<main class="message">
  <a class="brand" href="/">alterpaw</a>
  <h1>${heading}</h1>
  <p>${paragraph}</p>
  <p><a href="/p/${pet.slug}">Back to the preview</a></p>
</main>`;
  return layout({ title: `${title} — alterpaw`, robots: 'noindex, nofollow', body });
}

export const rewriteUsedPage = (pet) =>
  backToPreviewPage(pet, 'Rewrite used', "This preview's rewrite is used", 'Each bundle includes one rewrite of the jokes, and this one has had it.');

export const rewriteFailedPage = (pet) =>
  backToPreviewPage(pet, 'Try again', 'Our joke writer is stuck right now', 'Your rewrite is still available. Please try again in a minute.');

// M4: a gift or print form that didn't validate (400). `problems` are the messages to fix; Back keeps the form.
export function formProblemPage(pet, { title, heading, problems }) {
  const body = html`<main class="message">
  <a class="brand" href="/">alterpaw</a>
  <h1>${heading}</h1>
  <ul class="problems">${problems.map((p) => html`<li>${p}</li>`)}</ul>
  <p>Nothing was charged. Go back to fix it, or <a href="/p/${pet.slug}">return to the preview</a>.</p>
</main>`;
  return layout({ title: `${title} — alterpaw`, robots: 'noindex, nofollow', body });
}

// M4: gifts or prints aren't switched on (their keys aren't set). The forms are hidden then; this answers a
// direct post.
export const featureUnavailablePage = (what) =>
  messagePage(`${what} unavailable`, `${what} aren't available yet`, ['Nothing was charged. Please come back soon.']);

// M4: the email a gift's recipient gets on the delivery date. Plain text and HTML; every value from the buyer
// or the pet is escaped in the HTML (Hono's html tag), and the subject is one line.
const oneLine = (value) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function giftEmail({ pet, details, link, downloadBy }) {
  const from = oneLine(details.fromName) || 'Someone';
  const name = oneLine(pet.name);
  const to = oneLine(details.recipientName);
  const message = oneLine(details.message);
  const until = dateInZone(downloadBy, details.timeZone);
  const subject = `${from} sent you the secret life of ${name}`.slice(0, 150);
  const text = [
    `Hi ${to || 'there'},`,
    '',
    `${from} made you something: the secret life of ${name}, as a wanted poster, a newspaper front page, a trading card and a character bio.`,
    ...(message ? ['', `"${message}"`, `- ${from}`] : []),
    '',
    'See it, and download the high-res images and the printable PDF:',
    link,
    '',
    `The link works until ${until}. After that the photo is deleted, so download the bundle before then.`,
    '',
    'alterpaw',
  ].join('\n');
  const body = html`<!doctype html>
<html lang="en">
<body style="margin:0;padding:24px;background:#fbf8f3;color:#1d1a16;font-family:Georgia,'Times New Roman',serif;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #eadfcd;border-radius:12px;padding:28px;">
  <p style="margin:0 0 4px;color:#c2410c;font-weight:bold;letter-spacing:2px;">ALTERPAW</p>
  <h1 style="margin:0 0 16px;font-size:26px;line-height:1.2;">${from} sent you the secret life of ${name}</h1>
  <p style="font-size:16px;line-height:1.5;">Hi ${to || 'there'}, ${from} made you something: ${name}'s secret life, as a wanted poster, a newspaper front page, a trading card and a character bio.</p>
  ${message ? html`<blockquote style="margin:16px 0;padding:12px 16px;border-left:4px solid #c2410c;background:#fff6ee;font-size:16px;line-height:1.5;">${message}<br>- ${from}</blockquote>` : ''}
  <p style="margin:24px 0;"><a href="${link}" style="display:inline-block;background:#c2410c;color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:10px;font-family:Arial,sans-serif;">See ${name}'s secret life</a></p>
  <p style="font-size:14px;line-height:1.5;color:#6b6257;">Download the high-res images and the printable PDF there. The link works until ${until}; after that the photo is deleted.</p>
  <p style="font-size:13px;color:#6b6257;word-break:break-all;">${link}</p>
</div>
</body>
</html>`;
  return { subject, text, html: String(body) };
}

// Checkout couldn't start: Stripe failed (`retry`), or payments aren't configured yet.
export const paymentsUnavailablePage = ({ retry }) =>
  messagePage(
    'Payments unavailable',
    'Payments are unavailable right now',
    retry
      ? ["We couldn't reach our payment provider. Nothing was charged. Please try again in a minute."]
      : ["Payments aren't switched on yet. Nothing was charged. Please come back soon."],
  );

// Terms, refunds and privacy on one page: what Stripe asks a merchant's site to show, and what a buyer
// needs before paying. Keep it in step with the code (retention, processors, what the model receives).
export function legalPage({ retentionDays }) {
  const body = html`<main class="message legal">
  <a class="brand" href="/">alterpaw</a>
  <h1>Terms, refunds and privacy</h1>
  <p class="fine">Last updated October 14, 2026.</p>

  <h2 id="terms">Terms</h2>
  <p>alterpaw turns one photo of your pet and a few details into a funny, made-up "secret life": a wanted poster, a newspaper front page, a trading card and a character bio. The text is written by an AI model. It is parody, not fact.</p>
  <p>Upload only a photo of a pet that you have the right to use, and no photos of people. Previews that break these rules or are reported by several people may be taken down.</p>
  <p>The preview is free and watermarked. The bundle costs ${PRICE_LABEL} (US dollars), paid once through Stripe, for one preview. It unlocks the four cards as high-res images and a printable PDF without the watermark, plus one rewrite of the text. It is delivered at once on the preview page, for your personal use, including printing and sharing.</p>
  <p>Previews and their downloads are available until the photo is deleted, ${retentionDays} days after upload, so download the bundle before then. The service is provided as is.</p>
  <p><b>Gifts.</b> You can buy the bundle as a gift (${priceLabel('gift')}) for a pet whose photo you have the right to use. We email the recipient one message with the link on the delivery date you choose, in the time zone you choose, and the link works until the photo is deleted. You can pick a date up to about a week before that. If the preview is taken down before the date, the email isn't sent and you get a refund.</p>
  <p><b>Printed posters.</b> Once the bundle is paid for, you can order the wanted poster printed on ${PRINT_SIZE_LABEL} matte art paper for ${PRINT_PRICE_LABEL}, shipping included, to an address in the United States. It's printed and shipped by our print partner, usually within two weeks.</p>

  <h2 id="refunds">Refunds</h2>
  <p>If the bundle doesn't download, or you're unhappy with it, ask within 14 days of paying and you'll get a full refund. Reply to your Stripe receipt to ask.</p>
  <p>If a printed poster arrives damaged or misprinted, or doesn't arrive, reply to your Stripe receipt within 30 days of ordering and we'll reprint it or refund it.</p>

  <h2 id="privacy">Privacy</h2>
  <p>We store your pet's photo, name, species, traits and alter ego, the generated text and the time of upload. The photo is deleted ${retentionDays} days after upload; the text stays so the link can say it has expired.</p>
  <p>Payments are handled by Stripe: we never see your card details. We keep the Stripe session id and the time of payment, to match payments to previews and to handle refunds.</p>
  <p>For a gift we store the recipient's email address and name, your name, your message and the delivery date, and send the email through Brevo, which receives those to deliver it. For a printed poster we store the shipping address and send it, with the poster, to our print partner Prodigi, which prints and ships it. We erase these details ${retentionDays} days after the order, along with the photo; Stripe, Brevo and Prodigi keep their own records under their own policies.</p>
  <p>Text is written by Google's Gemini API. It receives the name, species, traits and alter ego, never the photo. On its free tier Google may use that text to improve its products, so don't put anything private in those fields.</p>
  <p>The database is hosted by Neon and the site by Vercel. When someone reports a page we keep a short hash of their network address for that page, never the address itself, and delete it after ${retentionDays} days.</p>
  <p>No accounts, no ads, no tracking cookies. Previews are unlisted and search engines are told not to index them, but anyone with the link can see one. To have a preview deleted sooner, reply to your Stripe receipt or use "Report this page" on it.</p>
  <p>${makeYoursLink()}</p>
</main>`;
  return layout({ title: 'Terms, refunds and privacy — alterpaw', robots: 'index, follow', body });
}

export function notFoundPage() {
  const body = html`<main class="message">
  <a class="brand" href="/">alterpaw</a>
  <h1>Nothing here</h1>
  <p>This preview doesn't exist, or the link is incomplete.</p>
  <p><a href="/">Make your pet's</a></p>
</main>`;
  return layout({ title: 'Not found — alterpaw', robots: 'noindex, nofollow', body });
}

export function errorPage() {
  const body = html`<main class="message">
  <a class="brand" href="/">alterpaw</a>
  <h1>Something went wrong</h1>
  <p>Please try again in a minute.</p>
</main>`;
  return layout({ title: 'Error — alterpaw', robots: 'noindex, nofollow', body });
}

// Runs in the browser. Kept as a real function so it is linted and parsed like the rest of the code;
// it is served as `(${fn})()` and must not reference anything outside itself.
function uploadScript() {
  'use strict';
  var MAX_SIDE = 1600;
  var JPEG_QUALITY = 0.85;
  var form = document.getElementById('pet-form');
  if (!form) return;
  var statusLine = document.getElementById('form-status');
  var button = form.querySelector('button[type="submit"]');
  var photoInput = form.querySelector('input[name="photo"]');
  var preview = document.getElementById('photo-preview');
  var traitInputs = Array.prototype.slice.call(form.querySelectorAll('input[name="traits"]'));

  function setStatus(text, isError) {
    statusLine.textContent = text;
    statusLine.classList.toggle('error', Boolean(isError));
  }

  // A chip fills the first empty trait box (or replaces the last one).
  form.addEventListener('click', function (event) {
    var chip = event.target.closest('[data-trait]');
    if (!chip) return;
    var empty = traitInputs.filter(function (input) {
      return !input.value.trim();
    })[0];
    (empty || traitInputs[traitInputs.length - 1]).value = chip.getAttribute('data-trait');
  });

  photoInput.addEventListener('change', function () {
    var file = photoInput.files && photoInput.files[0];
    if (preview.src) URL.revokeObjectURL(preview.src);
    if (!file) {
      preview.hidden = true;
      return;
    }
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
  });

  // Only messages made here or sent by the server are shown; a browser's own text
  // ("Failed to fetch", "Load failed") becomes the generic one.
  var GENERIC_ERROR = 'Something went wrong. Please try again.';
  function shown(message) {
    var err = new Error(message);
    err.shown = true;
    return err;
  }

  // Redraw at most 1600px on the long side as JPEG: a small upload (under any host's body limit)
  // with the EXIF data, including GPS, left behind.
  function shrink(file) {
    if (typeof createImageBitmap !== 'function') return Promise.reject(new Error('no createImageBitmap'));
    return createImageBitmap(file).then(function (bitmap) {
      var scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      var ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return new Promise(function (resolve, reject) {
        canvas.toBlob(
          function (blob) {
            if (blob) resolve(blob);
            else reject(new Error('encode failed'));
          },
          'image/jpeg',
          JPEG_QUALITY,
        );
      });
    });
  }

  // Coming back with the Back button restores the page from the back/forward cache as it was left:
  // button disabled, "Digging up…" showing. Reset it.
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    button.disabled = false;
    setStatus('');
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var file = photoInput.files && photoInput.files[0];
    if (!file) {
      setStatus('Please choose a photo of your pet.', true);
      return;
    }
    button.disabled = true;
    setStatus('Preparing the photo…');
    Promise.resolve()
      .then(function () {
        return shrink(file);
      })
      .catch(function () {
        // Never fall back to the original file: it would upload the EXIF/GPS data the redraw removes,
        // and a photo this browser can't read wouldn't show on the preview either.
        throw shown("This browser couldn't read that photo. Please choose a JPEG or PNG.");
      })
      .then(function (photo) {
        var data = new FormData(form);
        data.set('photo', photo, 'photo.jpg');
        setStatus('Digging up ' + (data.get('name') || 'your pet') + "'s secret past… (about 10 seconds)");
        return fetch('/generate', { method: 'POST', body: data, headers: { accept: 'application/json' } });
      })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return {};
          })
          .then(function (body) {
            if (res.ok && body.url) {
              window.location.assign(body.url);
              return;
            }
            if (res.status === 413) throw shown('That photo is too large. Please choose a smaller one.');
            throw shown(typeof body.error === 'string' && body.error ? body.error : GENERIC_ERROR);
          });
      })
      .catch(function (err) {
        setStatus(err && err.shown ? err.message : GENERIC_ERROR, true);
        button.disabled = false;
      });
  });
}

export const UPLOAD_SCRIPT = `(${uploadScript.toString()})();\n`;

export const STYLES = `
:root {
  --ink: #1d1a16;
  --paper: #f6efe1;
  --accent: #c2410c;
  --muted: #6b6257;
  --card-w: 340px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: var(--ink);
  background: #fbf8f3;
}
* { box-sizing: border-box; }
body { margin: 0; }
a { color: var(--accent); }
.brand { font-weight: 800; letter-spacing: .04em; text-transform: lowercase; color: var(--accent); text-decoration: none; margin: 0; }
h1 { font-size: clamp(1.8rem, 5vw, 2.8rem); line-height: 1.1; margin: .3em 0; }
.lede { color: var(--muted); font-size: 1.1rem; max-width: 40em; }
.foot { color: var(--muted); font-size: .9rem; padding: 2rem 0; }

/* Upload form */
.home { max-width: 720px; margin: 0 auto; padding: 2rem 1.25rem; }
.pet-form { display: grid; gap: 1.25rem; background: #fff; border: 1px solid #eadfcd; border-radius: 16px; padding: 1.5rem; }
.field { display: grid; gap: .5rem; border: 0; padding: 0; margin: 0; min-width: 0; }
.field-label { font-weight: 700; padding: 0; }
.row { display: grid; grid-template-columns: 2fr 1fr; gap: 1rem; }
input[type=text], select { font: inherit; padding: .65rem .75rem; border: 1px solid #d6cab6; border-radius: 10px; background: #fff; width: 100%; }
input[type=file] { font: inherit; }
.photo-preview { max-width: 160px; max-height: 160px; border-radius: 12px; object-fit: cover; }
.trait-inputs { display: grid; grid-template-columns: repeat(3, 1fr); gap: .5rem; }
.chips { display: flex; flex-wrap: wrap; gap: .4rem; }
.chip { font: inherit; font-size: .85rem; border: 1px solid #d6cab6; background: var(--paper); border-radius: 999px; padding: .3rem .75rem; cursor: pointer; }
.chip:hover { border-color: var(--accent); }
.egos { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: .6rem; }
.ego { display: grid; grid-template-columns: auto 1fr; gap: .1rem .5rem; align-items: start; border: 1px solid #e3d8c6; border-radius: 12px; padding: .75rem; cursor: pointer; }
.ego:has(input:checked) { border-color: var(--accent); background: #fff6ee; }
.ego input { grid-row: span 2; margin-top: .25rem; }
.ego-label { font-weight: 700; }
.ego-brief { color: var(--muted); font-size: .85rem; }
.submit { font: inherit; font-weight: 800; font-size: 1.1rem; color: #fff; background: var(--accent); border: 0; border-radius: 12px; padding: .9rem 1.2rem; cursor: pointer; }
.submit:disabled { opacity: .6; cursor: progress; }
.status { margin: 0; min-height: 1.4em; color: var(--muted); }
.status.error { color: #b91c1c; font-weight: 600; }
@media (max-width: 560px) { .row, .trait-inputs { grid-template-columns: 1fr; } }

/* Preview page */
.preview { max-width: 1480px; margin: 0 auto; padding: 2rem 1.25rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--card-w), 1fr)); gap: 1.5rem; align-items: start; }
.card { position: relative; overflow: hidden; border-radius: 6px; box-shadow: 0 10px 30px rgba(40, 28, 10, .18); padding: 1.25rem; }
.card .photo { display: block; width: 100%; aspect-ratio: 1; object-fit: cover; }
.watermark { position: absolute; inset: -50%; display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: 2.5rem 2rem; transform: rotate(-28deg); pointer-events: none; user-select: none; }
.watermark span { font: 800 1.3rem/1 system-ui, sans-serif; letter-spacing: .12em; text-transform: uppercase; color: rgba(255, 255, 255, .55); text-shadow: 0 0 2px rgba(0, 0, 0, .35); white-space: nowrap; }

/* Wanted poster */
.card-wanted { background: #ead9b5; color: #3b2a14; text-align: center; font-family: Rockwell, "Roboto Slab", "Courier New", Georgia, serif; border: 10px double #6b4e26; }
.wanted-title { font-size: 3.4rem; font-weight: 900; letter-spacing: .12em; text-transform: uppercase; margin: 0; line-height: 1; }
.wanted-sub { margin: .2rem 0 .8rem; text-transform: uppercase; font-size: .8rem; letter-spacing: .15em; }
.card-wanted .frame { border: 4px solid #3b2a14; padding: 4px; background: #f3e6c8; }
.card-wanted .photo { filter: sepia(.75) contrast(1.1); }
.wanted-name { font-size: 2rem; margin: .6rem 0 0; text-transform: uppercase; }
.wanted-alias { font-style: italic; margin: .2rem 0 .8rem; }
.wanted-rap { margin: 0; text-transform: uppercase; letter-spacing: .1em; font-size: .9rem; border-top: 2px solid #3b2a14; padding-top: .5rem; }
.rap-sheet { text-align: left; margin: .5rem 0; padding-left: 1.4rem; font-size: .9rem; }
.rap-sheet li { margin: .25rem 0; }
.reward { font-weight: 900; text-transform: uppercase; border-top: 2px solid #3b2a14; padding-top: .5rem; margin: .5rem 0 0; }

/* Newspaper */
.card-newspaper { background: #f4f1ea; color: #111; font-family: Georgia, "Times New Roman", serif; }
.masthead { border-bottom: 3px double #111; text-align: center; margin-bottom: .6rem; }
.paper-name { font-family: "Old English Text MT", "UnifrakturMaguntia", Georgia, serif; font-size: 2.1rem; margin: 0; }
.paper-meta { display: flex; justify-content: space-between; gap: .5rem; font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; border-top: 1px solid #111; margin: .3rem 0 .3rem; padding-top: .2rem; }
.headline { font-size: 1.6rem; line-height: 1.05; margin: .3rem 0 .6rem; text-transform: uppercase; font-weight: 900; }
.news-photo { margin: 0 0 .6rem; }
.card-newspaper .photo { filter: grayscale(1) contrast(1.15); }
.news-photo figcaption { font-size: .75rem; font-style: italic; margin-top: .3rem; }
.article { columns: 2; column-gap: 1rem; font-size: .82rem; line-height: 1.4; text-align: justify; hyphens: auto; }
.article p { margin: 0 0 .5em; text-indent: 1em; }

/* Trading card */
.card-trading { background: linear-gradient(160deg, #1e3a8a, #7c3aed); color: #fff; border: 8px solid #facc15; border-radius: 16px; }
.tc-head { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; }
.tc-name { margin: 0; font-size: 1.6rem; text-transform: uppercase; letter-spacing: .03em; }
.tc-type { font-size: .7rem; text-transform: uppercase; background: #facc15; color: #1e1b4b; padding: .2rem .5rem; border-radius: 999px; font-weight: 800; white-space: nowrap; }
.tc-photo { margin: .6rem 0; border: 3px solid #facc15; border-radius: 10px; overflow: hidden; }
.tc-alias { font-style: italic; margin: 0 0 .6rem; text-align: center; }
.stats { list-style: none; padding: 0; margin: 0; display: grid; gap: .35rem; }
.stats li { display: grid; grid-template-columns: 7.5rem 1fr 2rem; align-items: center; gap: .5rem; font-size: .8rem; }
.stat-label { font-weight: 700; text-transform: uppercase; overflow-wrap: anywhere; }
.stat-bar { width: 100%; height: 8px; }
.stat-bar .track { fill: rgba(255, 255, 255, .25); }
.stat-bar .fill { fill: #facc15; }
.stat-value { text-align: right; font-size: 1rem; }
.tc-foot { margin: .8rem 0 0; font-size: .7rem; text-transform: uppercase; letter-spacing: .1em; opacity: .8; text-align: center; }

/* Character bio */
.card-bio { background: #fff; border-top: 10px solid var(--accent); }
.bio-kicker { margin: 0 0 .6rem; text-transform: uppercase; letter-spacing: .15em; font-size: .75rem; color: var(--accent); font-weight: 800; }
.bio-photo { width: 60%; margin: 0 auto; }
.bio-photo .photo { border-radius: 50%; border: 5px solid var(--paper); }
.bio-name { text-align: center; margin: .6rem 0 0; font-size: 1.7rem; }
.bio-alias { text-align: center; font-style: italic; color: var(--muted); margin: .2rem 0 .6rem; }
.bio-facts { display: grid; grid-template-columns: auto 1fr; gap: .2rem .8rem; font-size: .85rem; margin: 0 0 .6rem; }
.bio-facts dt { font-weight: 700; }
.bio-facts dd { margin: 0; }
.bio-traits { display: flex; flex-wrap: wrap; gap: .35rem; list-style: none; padding: 0; margin: 0 0 .6rem; }
.bio-traits li { background: var(--paper); border-radius: 999px; padding: .2rem .65rem; font-size: .8rem; }
.bio-text { line-height: 1.5; margin: 0; }

/* Share, make-yours and report (under the cards) */
.share { margin: 2.5rem 0 0; padding: 1.5rem; background: #fff; border: 1px solid #eadfcd; border-radius: 16px; }
.share h2 { margin: 0 0 .8rem; font-size: 1.3rem; }
.share-links { display: flex; flex-wrap: wrap; gap: .75rem; }
.share-link { display: inline-flex; gap: .5rem; align-items: baseline; font-weight: 800; color: #fff; background: var(--ink); border-radius: 12px; padding: .75rem 1.1rem; text-decoration: none; }
.share-link span { font-weight: 400; font-size: .85rem; opacity: .75; }
.share-note { color: var(--muted); font-size: .9rem; margin: .8rem 0 0; }
.cta { margin: 1.5rem 0 0; text-align: center; }
.make-yours { display: inline-block; font-weight: 800; font-size: 1.2rem; color: #fff; background: var(--accent); border-radius: 12px; padding: .9rem 1.4rem; text-decoration: none; }
.message .make-yours { font-size: 1rem; }
.report summary { cursor: pointer; color: var(--muted); }
.report form { display: flex; flex-wrap: wrap; gap: .75rem; align-items: end; margin-top: .75rem; }
.report button { font: inherit; border: 1px solid #d6cab6; background: #fff; border-radius: 10px; padding: .6rem 1rem; cursor: pointer; }

/* The $9 offer and the paid bundle */
.unlock { margin: 2.5rem 0 0; padding: 1.5rem; background: #fff6ee; border: 2px solid var(--accent); border-radius: 16px; }
.unlock h2 { margin: 0 0 .6rem; font-size: 1.4rem; }
.unlock-list { margin: 0 0 1rem; padding-left: 1.2rem; line-height: 1.6; }
.unlock form { margin: .8rem 0 0; }
.unlock button { font: inherit; font-weight: 700; border: 1px solid #d6cab6; background: #fff; border-radius: 10px; padding: .7rem 1.1rem; cursor: pointer; }
.unlock .pay, .download { display: inline-block; font: inherit; font-weight: 800; font-size: 1.15rem; color: #fff; background: var(--accent); border: 0; border-radius: 12px; padding: .9rem 1.4rem; text-decoration: none; cursor: pointer; }
.unlock.paid { background: #f0fdf4; border-color: #15803d; }
.unlock.paid .download { background: #15803d; }
.notice { background: #fff; border-left: 4px solid var(--accent); padding: .6rem .8rem; margin: 0 0 1rem; }
.fine { color: var(--muted); font-size: .9rem; margin: .6rem 0 0; }

/* Plain message pages */
.message { max-width: 560px; margin: 4rem auto; padding: 0 1.25rem; }
.legal { max-width: 720px; line-height: 1.55; }
.legal h2 { margin: 2rem 0 .4rem; font-size: 1.3rem; }
.problems { color: #b91c1c; font-weight: 600; line-height: 1.5; }

/* M4: gifts, printed posters and the orders box */
.gift-note { color: var(--muted); margin: .4rem 0 0; max-width: 40em; }
input[type=email], input[type=date], textarea { font: inherit; padding: .65rem .75rem; border: 1px solid #d6cab6; border-radius: 10px; background: #fff; width: 100%; }
textarea { resize: vertical; }
.optional { font-weight: 400; color: var(--muted); }
.gift, .print-details { margin: 1.2rem 0 0; border-top: 1px dashed #e3c9b3; padding-top: 1rem; }
.gift summary, .print-details summary { cursor: pointer; font-weight: 700; color: var(--accent); }
.gift-form, .address-form { display: grid; gap: .9rem; margin-top: 1rem; max-width: 720px; }
.gift-form .row, .address-form .row { grid-template-columns: 1fr 1fr; }
.address-form .row-3 { grid-template-columns: 2fr 1.4fr 1fr; }
.unlock.print { background: #fff; border-color: var(--ink); }
.orders { margin: 0 0 1.5rem; padding: 1rem 1.25rem; background: #f0fdf4; border: 2px solid #15803d; border-radius: 16px; }
.orders h2 { margin: 0 0 .4rem; font-size: 1.2rem; }
.orders ul { margin: 0; padding-left: 1.2rem; line-height: 1.6; }
@media (max-width: 560px) { .gift-form .row, .address-form .row, .address-form .row-3 { grid-template-columns: 1fr; } }
`;
