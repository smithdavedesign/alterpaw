// The paid bundle: the preview's four cards at print size, with no watermark, as PNGs, plus the same four
// as a PDF. And (M4) the file for the printed poster.
//
//   cardTree(pet, id, { photoSrc }) → satori tree for one card, CARD_LAYOUT_SIZE; pure, so tests can read it
//   renderBundle(pet, photo)        → { files: [{ name, bytes }], photoShown, photoProblem? }
//   renderPrintPoster(pet, photo)   → { png, photoShown, photoProblem? }: the wanted poster for a 12×16 in print
//
// Each card is laid out at 1200×1500 and rasterised at 1.5× to 1800×2250 px: 8×10 in at 225 dpi. Uploads are
// at most 1600 px on the long side, so 2× would only upscale the photo while making each image ~1.7× larger.
// Text is drawn as vector glyphs (satori), so it stays sharp at any zoom. The fonts, wasm and layout helpers
// come from share.js.
import { readFile } from 'node:fs/promises';
import {
  el,
  text,
  clamp,
  nameSize,
  posterName,
  drawable,
  photoOrPlaceholder,
  wantedPoster,
  dataUrl,
  rasterise,
  photoProblemOf,
  loadRenderer,
} from './share.js';
import { encodePng, buildPdf } from './files.js';
import { SPECIES_STYLE } from './views.js';
import { findAlterEgo } from './character.js';

export const CARD_LAYOUT_SIZE = { width: 1200, height: 1500 };
export const PRINT_SCALE = 1.5;
export const BUNDLE_IMAGE_SIZE = { width: CARD_LAYOUT_SIZE.width * PRINT_SCALE, height: CARD_LAYOUT_SIZE.height * PRINT_SCALE };
export const PDF_PAGE = { width: 576, height: 720 }; // 8×10 in, in points

// The order of the files in the zip and of the pages in the PDF. Names are fixed, never built from user text.
export const BUNDLE_CARDS = [
  { id: 'wanted', file: 'alterpaw-1-wanted-poster.png' },
  { id: 'newspaper', file: 'alterpaw-2-front-page.png' },
  { id: 'trading', file: 'alterpaw-3-trading-card.png' },
  { id: 'bio', file: 'alterpaw-4-character-bio.png' },
];
export const BUNDLE_PDF = 'alterpaw-bundle.pdf';

const { width: W, height: H } = CARD_LAYOUT_SIZE;
const styleOf = (pet) => SPECIES_STYLE[pet.species] ?? SPECIES_STYLE.other;
const egoOf = (pet) => findAlterEgo(pet.alterEgo) ?? { label: String(pet.alterEgo) };

// The print poster has room for a bigger photo and five charges.
const PRINT_POSTER = { photo: 540, wanted: 156, charges: 5, headline: false };

function wantedCard(pet, photoSrc) {
  return el('div', { width: W, height: H, fontFamily: 'Slab' }, [
    wantedPoster(pet, { width: W, height: H, layout: PRINT_POSTER, photoSrc, stamp: false }),
  ]);
}

// Two columns from one text: split at the space nearest the middle (satori has no CSS columns).
function splitInTwo(value) {
  const middle = Math.floor(value.length / 2);
  const before = value.lastIndexOf(' ', middle);
  const after = value.indexOf(' ', middle);
  const at = before === -1 ? after : after === -1 || middle - before <= after - middle ? before : after;
  return at === -1 ? [value, ''] : [value.slice(0, at), value.slice(at + 1)];
}

const NEWS_PADDING = 48;
const NEWS_COLUMN_GAP = 48;
function newspaperCard(pet, photoSrc) {
  const c = pet.character;
  const inner = W - 2 * NEWS_PADDING;
  const column = (inner - NEWS_COLUMN_GAP) / 2;
  const date = new Date(pet.createdAt ?? Date.now())
    .toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
    .toUpperCase();
  const [left, right] = splitInTwo(drawable(c.article.split(/\n{2,}/).join(' ')));
  // 15 lines of ~48 characters per column: room for the longest article (1200 characters, character.js).
  const columnStyle = { width: column, fontSize: 22, lineHeight: 1.4, flexShrink: 0 };
  return el('div', { width: W, height: H, flexDirection: 'column', background: '#f4f1ea', color: '#111', padding: `44px ${NEWS_PADDING}px`, fontFamily: 'Slab' }, [
    el('div', { flexDirection: 'column', alignItems: 'center', width: inner, flexShrink: 0 }, [
      text({ fontSize: 92, fontWeight: 700, lineHeight: 1 }, styleOf(pet).paper.toUpperCase()),
      el('div', { width: inner, justifyContent: 'space-between', marginTop: 14, padding: '6px 0', borderTop: '3px solid #111', borderBottom: '3px solid #111', fontSize: 20, fontWeight: 700, letterSpacing: 2 }, [
        text({}, date),
        text({}, 'LATE EDITION'),
        text({}, 'PRICE: ONE TREAT'),
      ]),
    ]),
    clamp(3, { width: inner, marginTop: 24, fontSize: 62, fontWeight: 700, lineHeight: 1.05, flexShrink: 0 }, drawable(c.headline)),
    el('div', { flexDirection: 'column', width: inner, marginTop: 22, flexShrink: 0 }, [
      photoOrPlaceholder(photoSrc, inner, 440),
      clamp(2, { width: inner, marginTop: 8, fontSize: 22, color: '#333' }, `${drawable(pet.name) || 'The suspect'}, also known as ${drawable(c.alias)}, photographed at home.`),
    ]),
    // Whatever height is left goes to the article; the columns are clamped to it.
    el('div', { width: inner, marginTop: 22, justifyContent: 'space-between', flexGrow: 1, flexShrink: 1, overflow: 'hidden', borderTop: '1px solid #111', paddingTop: 14 }, [
      clamp(15, columnStyle, left),
      clamp(15, columnStyle, right),
    ]),
  ]);
}

const GOLD = '#facc15';
const TRADING_BORDER = 24;
const TRADING_PADDING = 44;
function tradingCard(pet, photoSrc) {
  const c = pet.character;
  const ego = egoOf(pet);
  const inner = W - 2 * TRADING_BORDER - 2 * TRADING_PADDING;
  const name = posterName(pet);
  const stat = ({ label, value }) =>
    el('div', { width: inner, alignItems: 'center', height: 56 }, [
      // Wide enough for the longest label (24 characters, character.js) in capitals.
      clamp(1, { width: 430, fontSize: 24, fontWeight: 700 }, drawable(label).toUpperCase()),
      el('div', { flexGrow: 1, height: 22, margin: '0 24px', borderRadius: 11, background: 'rgba(255, 255, 255, 0.25)' }, [
        el('div', { width: `${value}%`, height: 22, borderRadius: 11, background: GOLD }),
      ]),
      text({ width: 80, justifyContent: 'flex-end', fontSize: 40, fontWeight: 700 }, value),
    ]);
  // A white sheet behind the rounded card, so the corners print white.
  return el('div', { width: W, height: H, background: '#ffffff', fontFamily: 'Slab' }, [
    el(
      'div',
      {
        width: W,
        height: H,
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: TRADING_PADDING,
        border: `${TRADING_BORDER}px solid ${GOLD}`,
        borderRadius: 56,
        backgroundImage: 'linear-gradient(160deg, #1e3a8a, #7c3aed)',
        color: '#ffffff',
      },
      [
        el('div', { width: inner, justifyContent: 'space-between', alignItems: 'center' }, [
          text({ background: GOLD, color: '#1e1b4b', borderRadius: 999, padding: '6px 20px', fontSize: 24, fontWeight: 700, letterSpacing: 2 }, ego.label.toUpperCase()),
          text({ fontSize: 24, fontWeight: 700, letterSpacing: 4 }, styleOf(pet).label.toUpperCase()),
        ]),
        text({ maxWidth: inner, overflow: 'hidden', fontSize: nameSize(name) + 8, fontWeight: 700, lineHeight: 1.1, whiteSpace: 'nowrap', letterSpacing: 1 }, name),
        el('div', { border: `8px solid ${GOLD}`, borderRadius: 20, overflow: 'hidden', flexShrink: 0 }, [photoOrPlaceholder(photoSrc, inner - 16, 600)]),
        clamp(2, { width: inner, fontSize: 34, lineHeight: 1.2, textAlign: 'center' }, drawable(c.alias)),
        el('div', { flexDirection: 'column', width: inner }, c.stats.map(stat)),
        text({ fontSize: 22, fontWeight: 700, letterSpacing: 4, color: 'rgba(255, 255, 255, 0.8)' }, `${styleOf(pet).label} · ${ego.label} series`.toUpperCase()),
      ],
    ),
  ]);
}

const ACCENT = '#c2410c';
const MUTED = '#6b6257';
const CREAM = '#f6efe1';
const BIO_PADDING = 64;
const BIO_PHOTO = 440;
function bioCard(pet, photoSrc) {
  const c = pet.character;
  const ego = egoOf(pet);
  const inner = W - 2 * BIO_PADDING;
  const name = drawable(pet.name) || 'Unknown suspect';
  const fact = (label, value) =>
    el('div', { flexDirection: 'column', alignItems: 'center', margin: '0 36px' }, [
      text({ fontSize: 20, fontWeight: 700, letterSpacing: 4, color: MUTED }, label),
      text({ fontSize: 30, fontWeight: 700 }, value),
    ]);
  const traits = pet.traits.map(drawable).filter(Boolean);
  return el('div', { width: W, height: H, flexDirection: 'column', alignItems: 'center', background: '#ffffff', color: '#1d1a16', borderTop: `28px solid ${ACCENT}`, padding: `44px ${BIO_PADDING}px`, fontFamily: 'Slab' }, [
    text({ fontSize: 28, fontWeight: 700, letterSpacing: 8, color: ACCENT }, 'CHARACTER PROFILE'),
    el('div', { marginTop: 26, padding: 12, borderRadius: 9999, background: CREAM, flexShrink: 0 }, [
      photoOrPlaceholder(photoSrc, BIO_PHOTO, BIO_PHOTO, { borderRadius: BIO_PHOTO / 2 }),
    ]),
    text({ maxWidth: inner, overflow: 'hidden', marginTop: 22, fontSize: nameSize(name) + 8, fontWeight: 700, lineHeight: 1.1, whiteSpace: 'nowrap' }, name),
    clamp(2, { width: inner, marginTop: 6, fontSize: 34, lineHeight: 1.2, color: MUTED, textAlign: 'center' }, drawable(c.alias)),
    el('div', { marginTop: 22, flexShrink: 0 }, [fact('SPECIES', styleOf(pet).label), fact('ALTER EGO', ego.label)]),
    el(
      'div',
      { width: inner, marginTop: 16, flexWrap: 'wrap', justifyContent: 'center', flexShrink: 0 },
      traits.map((trait) => text({ margin: 6, padding: '8px 22px', borderRadius: 999, background: CREAM, fontSize: 26 }, trait)),
    ),
    clamp(10, { width: inner, marginTop: 22, fontSize: 30, lineHeight: 1.45, flexShrink: 1 }, drawable(c.bio)),
  ]);
}

const CARD_TREES = { wanted: wantedCard, newspaper: newspaperCard, trading: tradingCard, bio: bioCard };

export function cardTree(pet, id, { photoSrc = null } = {}) {
  if (!Object.hasOwn(CARD_TREES, id)) throw new RangeError(`unknown card: ${id}`);
  return CARD_TREES[id](pet, photoSrc);
}

// Every card has an opaque background, so the RGBA from resvg is RGB plus an alpha of 255.
function rgbOf(image) {
  const rgba = image.pixels;
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return { width: image.width, height: image.height, rgb };
}

// About 0.75 s and 16 MB of wasm memory per card (freed after each). Each card's compression runs on the
// thread pool while the next one renders. A photo the decoder rejects is left out of the remaining cards,
// as on the share images, and `photoProblem` says why.
export async function renderBundle(pet, photo, { read = readFile } = {}) {
  const fonts = await loadRenderer(read);
  let photoProblem = photoProblemOf(photo);
  let photoSrc = photoProblem ? null : dataUrl(photo);
  const draw = (id) => rasterise(cardTree(pet, id, { photoSrc }), CARD_LAYOUT_SIZE, fonts, { zoom: PRINT_SCALE, use: rgbOf });
  const encoded = [];
  for (const card of BUNDLE_CARDS) {
    let image;
    try {
      image = await draw(card.id);
    } catch (err) {
      if (!photoSrc) throw err;
      photoProblem = `decoder failed: ${err?.message ?? err}`;
      photoSrc = null;
      image = await draw(card.id);
    }
    if (image.width !== BUNDLE_IMAGE_SIZE.width || image.height !== BUNDLE_IMAGE_SIZE.height) {
      throw new Error(`card ${card.id} rendered at ${image.width}×${image.height}`);
    }
    encoded.push(encodePng(image.width, image.height, image.rgb).then((png) => ({ ...png, ...BUNDLE_IMAGE_SIZE })));
  }
  const pngs = await Promise.all(encoded);
  const files = BUNDLE_CARDS.map((card, i) => ({ name: card.file, bytes: pngs[i].png }));
  files.push({ name: BUNDLE_PDF, bytes: buildPdf(pngs, PDF_PAGE) });
  return photoProblem ? { files, photoShown: false, photoProblem } : { files, photoShown: true };
}

// M4: the printed poster (Prodigi GLOBAL-FAP-12X16, print.js). The same wanted poster, laid out at 1200×1600
// (3:4, the paper's shape) and rasterised at 3× to 3600×4800 px: 300 dpi, Prodigi's recommendation. Uploads are
// ≤1600 px and the photo prints about 6 in wide, so 300 dpi is also where the photo stops being the limit.
export const PRINT_POSTER_LAYOUT_SIZE = { width: 1200, height: 1600 };
export const PRINT_POSTER_SCALE = 3;
export const PRINT_POSTER_SIZE = {
  width: PRINT_POSTER_LAYOUT_SIZE.width * PRINT_POSTER_SCALE,
  height: PRINT_POSTER_LAYOUT_SIZE.height * PRINT_POSTER_SCALE,
};
// The taller sheet fits a bigger photo and the whole rap sheet (up to 6 charges, character.js).
const PRINT_TALL_POSTER = { photo: 620, wanted: 168, charges: 6, headline: false };

export function printPosterTree(pet, { photoSrc = null } = {}) {
  const { width, height } = PRINT_POSTER_LAYOUT_SIZE;
  return el('div', { width, height, fontFamily: 'Slab' }, [
    wantedPoster(pet, { width, height, layout: PRINT_TALL_POSTER, photoSrc, stamp: false }),
  ]);
}

// About 17 MP: a few seconds of CPU, once per print order (when Prodigi fetches the file).
export async function renderPrintPoster(pet, photo, { read = readFile } = {}) {
  const fonts = await loadRenderer(read);
  let photoProblem = photoProblemOf(photo);
  let photoSrc = photoProblem ? null : dataUrl(photo);
  const draw = () => rasterise(printPosterTree(pet, { photoSrc }), PRINT_POSTER_LAYOUT_SIZE, fonts, { zoom: PRINT_POSTER_SCALE, use: rgbOf });
  let image;
  try {
    image = await draw();
  } catch (err) {
    if (!photoSrc) throw err;
    photoProblem = `decoder failed: ${err?.message ?? err}`;
    photoSrc = null;
    image = await draw();
  }
  if (image.width !== PRINT_POSTER_SIZE.width || image.height !== PRINT_POSTER_SIZE.height) {
    throw new Error(`print poster rendered at ${image.width}×${image.height}`);
  }
  const { png } = await encodePng(image.width, image.height, image.rgb);
  return photoProblem ? { png, photoShown: false, photoProblem } : { png, photoShown: true };
}
