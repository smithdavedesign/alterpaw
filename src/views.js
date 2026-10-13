// HTML, CSS and the browser script. This is the only place user and model text meets markup:
// every value goes through Hono's `html` tag, which escapes & < > " ' — never `raw()` on data.
// User text only ever lands in element text or quoted attributes, never in <script>, <style> or URLs.
import { html } from 'hono/html';
import { ALTER_EGOS, SPECIES, findAlterEgo } from './character.js';
import { MAX_NAME_LENGTH, MAX_TRAIT_LENGTH } from './input.js';

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
  <footer class="foot">Free preview. Your photo stays on an unlisted page that search engines are told not to index.</footer>
</main>`;
  return layout({ title: "alterpaw — your pet's secret life", robots: 'index, follow', body, script: true });
}

const watermark = () =>
  html`<div class="watermark" aria-hidden="true">${Array.from({ length: WATERMARK_REPEATS }, () => html`<span>alterpaw preview</span>`)}</div>`;

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
  ${watermark()}
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
  ${watermark()}
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
  ${watermark()}
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
  ${watermark()}
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
  { size: 'post', query: '', label: 'Instagram post' },
  { size: 'story', query: '?size=story', label: 'Story, Reels or TikTok' },
];

function shareSection(pet, retentionDays) {
  return html`<section class="share" aria-labelledby="share-title">
  <h2 id="share-title">Share the wanted poster</h2>
  <div class="share-links">
    ${SHARE_LINKS.map(({ size, query, label }) => {
      const { width, height } = SHARE_SIZES[size];
      return html`<a class="share-link" href="/p/${pet.slug}/share.png${query}" download="${shareFileName(size)}">${label} <span>${width}×${height}</span></a>`;
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

// Policy numbers and lists (retention, report reasons) come from app.js, the one place they're defined.
export function previewPage(pet, { reportReasons, retentionDays }) {
  const style = SPECIES_STYLE[pet.species] ?? SPECIES_STYLE.other;
  const ego = findAlterEgo(pet.alterEgo) ?? { label: pet.alterEgo };
  const body = html`<main class="preview">
  <header class="preview-head">
    <a class="brand" href="/">alterpaw</a>
    <h1>The secret life of ${pet.name}</h1>
    <p class="lede">Alter ego: ${ego.label}. Free preview, watermarked.</p>
  </header>
  <section class="cards">
    ${wantedCard(pet, style)}
    ${newspaperCard(pet, style)}
    ${tradingCard(pet, style, ego)}
    ${bioCard(pet, style, ego)}
  </section>
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

/* Plain message pages */
.message { max-width: 560px; margin: 4rem auto; padding: 0 1.25rem; }
`;
