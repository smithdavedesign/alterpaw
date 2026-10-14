// Share images: the wanted poster as a PNG sized for Instagram (1080×1350) and Stories/Reels/TikTok
// (1080×1920), with the real photo, a "free preview" stamp (until the bundle is paid for) and a "make your
// pet's" line.
//
//   shareTree(pet, …)     → satori element tree (plain objects, no JSX); pure, so tests can read the text
//   renderSharePng(pet, photo, { size, host }) → { png: Uint8Array, photoShown: boolean, photoProblem?: string }
//
// The paid bundle (bundle.js) reuses the poster, the tree helpers, the fonts and the rasteriser from here.
//
// satori lays the tree out and turns every glyph into an SVG path, so user and model text never becomes markup.
// resvg (WebAssembly) rasterises the SVG. Both are pure JS/WASM: no install scripts, no native binaries.
// Assets are loaded with literal `new URL(…, import.meta.url)` paths because that is the form Vercel's file
// tracer follows (`createRequire().resolve()` and computed paths are not); test/share.test.js traces the
// entry and checks every URL in ASSET_URLS.
import { readFile } from 'node:fs/promises';
import satori from 'satori';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { SPECIES_STYLE, SHARE_SIZES } from './views.js';

export { SHARE_SIZES };

// Per-size layout, budgeted so the longest allowed text still fits: a 30-character name on one line, a
// 60-character alias on two, every charge clamped to two lines. The tall format has room for a bigger photo,
// more charges and the front-page headline. One entry per SHARE_SIZES key (checked in renderSharePng).
const LAYOUT = {
  post: { photo: 440, wanted: 132, charges: 2, headline: false },
  story: { photo: 700, wanted: 168, charges: 4, headline: true },
};

// Photos above this are not decoded: a small file can declare a huge canvas, and wasm memory never shrinks.
// The form sends ≤1600 px; a 24 MP phone photo posted straight to /generate still fits.
export const MAX_PHOTO_PIXELS = 25_000_000;

const MARGIN = 32;
const FOOTER = 92;
const INK = '#3b2a14';
const PAPER = '#ead9b5';
const NIGHT = '#1d1a16';
const STAMP = '#b91c1c';
const BRAND = '#f97316';
const NO_NAME = 'UNKNOWN SUSPECT';

const WASM_URL = new URL('../node_modules/@resvg/resvg-wasm/index_bg.wasm', import.meta.url);
// Satori only falls back to a font with a *different* name when a glyph is missing (same-name fonts give
// boxes), so each extra script is its own family. Together they draw Latin (incl. extended and Vietnamese),
// Greek and Cyrillic names; anything else is dropped from the image by drawable() below.
// Rows are objects, not arrays: the tracer widens a static `new URL` to the largest static expression around
// it, and an array of [name, weight, url] arrays widens to the whole list, which it then can't read as paths
// (no font shipped). A `url:` property stops it at each URL.
const FONT_FILES = [
  { name: 'Rye', weight: 400, url: new URL('../node_modules/@fontsource/rye/files/rye-latin-400-normal.woff', import.meta.url) },
  { name: 'Slab', weight: 400, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-latin-400-normal.woff', import.meta.url) },
  { name: 'Slab', weight: 700, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff', import.meta.url) },
  { name: 'SlabLatinExt', weight: 400, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-latin-ext-400-normal.woff', import.meta.url) },
  { name: 'SlabLatinExt', weight: 700, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-latin-ext-700-normal.woff', import.meta.url) },
  { name: 'SlabVietnamese', weight: 400, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-vietnamese-400-normal.woff', import.meta.url) },
  { name: 'SlabVietnamese', weight: 700, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-vietnamese-700-normal.woff', import.meta.url) },
  { name: 'SlabCyrillic', weight: 400, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-cyrillic-400-normal.woff', import.meta.url) },
  { name: 'SlabCyrillic', weight: 700, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-cyrillic-700-normal.woff', import.meta.url) },
  { name: 'SlabGreek', weight: 400, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-greek-400-normal.woff', import.meta.url) },
  { name: 'SlabGreek', weight: 700, url: new URL('../node_modules/@fontsource/roboto-slab/files/roboto-slab-greek-700-normal.woff', import.meta.url) },
];
export const ASSET_URLS = [WASM_URL, ...FONT_FILES.map(({ url }) => url)];

// resvg can be initialised once per process, so its promise is kept once it succeeds; the fonts have their
// own memo. A failed read of either is retried on the next request without re-initialising the other.
let resvgReady = null;
function initResvg(read) {
  resvgReady ??= read(WASM_URL)
    .then((wasm) => initWasm(wasm))
    .catch((err) => {
      resvgReady = null;
      throw err;
    });
  return resvgReady;
}

let fontsReady = null;
export function loadFonts(read = readFile) {
  fontsReady ??= Promise.all(
    FONT_FILES.map(({ name, weight, url }) => read(url).then((data) => ({ name, data, weight, style: 'normal' }))),
  ).catch((err) => {
    fontsReady = null;
    throw err;
  });
  return fontsReady;
}

// resvg and the fonts, ready to render; resolves to the fonts satori needs.
export async function loadRenderer(read = readFile) {
  const [, fonts] = await Promise.all([initResvg(read), loadFonts(read)]);
  return fonts;
}

// Keeps the characters the fonts above can draw. Emoji, CJK and other scripts would come out as boxes
// (satori has no fallback for them without a network fetch), so they're left out of the image; the
// preview page itself still shows the text as typed.
const UNDRAWABLE = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}/gu;
// Zero-width joiner, emoji variation selector and keycap: the invisible glue emoji leave behind.
const EMOJI_GLUE = new RegExp(`[${String.fromCharCode(0x200d, 0xfe0f, 0x20e3)}]`, 'g');
const DRAWABLE_SCRIPT = /[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]/u;
export function drawable(value) {
  return [...String(value).replace(UNDRAWABLE, '').replace(EMOJI_GLUE, '')]
    .filter((ch) => DRAWABLE_SCRIPT.test(ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

// Width and height from the file header, without decoding. JPEG, PNG and GIF are what resvg draws; anything
// else (WebP included) or an unreadable header gives null and the photo-less image.
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
export function imageSize(bytes, type) {
  const b = bytes;
  const be16 = (i) => (b[i] << 8) | b[i + 1];
  const be32 = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  let size = null;
  if (type === 'image/png' && b.length >= 24) size = { width: be32(16), height: be32(20) };
  else if (type === 'image/gif' && b.length >= 10) size = { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) };
  else if (type === 'image/jpeg') {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) break;
      const marker = b[i + 1];
      if (marker === 0xff) i += 1; // fill byte
      else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) i += 2; // markers without a length
      else if (JPEG_SOF.has(marker)) {
        size = { width: be16(i + 7), height: be16(i + 5) };
        break;
      } else {
        const length = be16(i + 2);
        if (length < 2) break;
        i += 2 + length;
      }
    }
  }
  return size && size.width > 0 && size.height > 0 ? size : null;
}

// Satori wants React-shaped nodes; a div with more than one child must say how to lay them out.
// Satori sizes boxes like a browser (content-box); border-box keeps the fixed widths below honest.
export const el = (type, style, children = []) => ({
  type,
  props: { style: { display: 'flex', boxSizing: 'border-box', ...style }, children },
});
export const text = (style, value) => el('div', style, String(value));
// Long model text is cut with an ellipsis after `lines` lines instead of pushing the layout around.
export const clamp = (lines, style, value) => ({
  type: 'div',
  props: {
    style: { display: 'block', lineClamp: lines, overflow: 'hidden', wordBreak: 'break-word', boxSizing: 'border-box', ...style },
    children: String(value),
  },
});
// Names are capped at 30 characters (input.js); shrink long ones so they stay on one line.
export const nameSize = (name) => (name.length <= 12 ? 72 : name.length <= 20 ? 56 : 42);
export const posterName = (pet) => drawable(pet.name).toUpperCase() || NO_NAME;

// The photo, or a "PHOTO ON FILE" panel when there is none to draw.
export function photoOrPlaceholder(photoSrc, width, height, style = {}) {
  return photoSrc
    ? { type: 'img', props: { src: photoSrc, width, height, style: { objectFit: 'cover', ...style } } }
    : el('div', { width, height, background: '#cbb68f', alignItems: 'center', justifyContent: 'center', ...style }, [
        text({ fontSize: 40, color: INK, fontWeight: 700 }, 'PHOTO ON FILE'),
      ]);
}

function photoBlock(photoSrc, side, stamp) {
  return el('div', { position: 'relative', border: `6px solid ${INK}`, padding: 8, background: '#f3e6c8', flexShrink: 0 }, [
    photoOrPlaceholder(photoSrc, side, side),
    ...(stamp
      ? [
          text(
            {
              position: 'absolute',
              top: 26,
              right: -40,
              transform: 'rotate(14deg)',
              border: `6px solid ${STAMP}`,
              color: STAMP,
              background: 'rgba(234, 217, 181, 0.85)',
              padding: '6px 18px',
              fontSize: 34,
              fontWeight: 700,
              letterSpacing: 4,
            },
            'FREE PREVIEW',
          ),
        ]
      : []),
  ]);
}

// The share images frame the poster on a dark background with the "make your pet's" footer. The stamp
// goes once the bundle is paid for: a buyer's own share shouldn't say "free preview".
export function shareTree(pet, { size = 'post', host = 'alterpaw', photoSrc = null } = {}) {
  const { width, height } = SHARE_SIZES[size];
  const posterWidth = width - 2 * MARGIN;
  const poster = wantedPoster(pet, {
    width: posterWidth,
    height: height - 2 * MARGIN - FOOTER,
    layout: LAYOUT[size],
    photoSrc,
    stamp: !pet.paidAt,
  });

  const footer = el('div', { width: posterWidth, height: FOOTER, alignItems: 'center', justifyContent: 'space-between', paddingTop: 12, color: '#fff' }, [
    text({ fontFamily: 'Rye', fontSize: 44, color: BRAND }, 'alterpaw'),
    text({ fontSize: 30, fontWeight: 700 }, `Make your pet's at ${host}`),
  ]);

  return el('div', { flexDirection: 'column', width, height, background: NIGHT, padding: MARGIN, fontFamily: 'Slab' }, [poster, footer]);
}

// The poster on its own, `width`×`height`. `layout` is { photo, wanted, charges, headline }: the photo side,
// the WANTED size, how many charges and whether the front-page headline fits.
export function wantedPoster(pet, { width, height, layout, photoSrc = null, stamp = true }) {
  const c = pet.character;
  const style = SPECIES_STYLE[pet.species] ?? SPECIES_STYLE.other;
  const name = posterName(pet);
  const alias = drawable(c.alias);
  const charges = c.rapSheet.slice(0, layout.charges).map(drawable).filter(Boolean);
  const textWidth = width - 2 * 10 - 2 * 44; // borders and padding

  const heading = el('div', { flexDirection: 'column', alignItems: 'center', flexShrink: 0 }, [
    text({ fontFamily: 'Rye', fontSize: layout.wanted, lineHeight: 1, letterSpacing: 8 }, 'WANTED'),
    text({ fontSize: 26, fontWeight: 700, letterSpacing: 6, marginTop: 6 }, 'FOR CRIMES AGAINST THE HOUSEHOLD'),
  ]);

  // The name is one line; a name of 30 wide capitals (W) would run past the frame, so it's clipped at the edge.
  const identity = el('div', { flexDirection: 'column', alignItems: 'center', width: textWidth, flexShrink: 0 }, [
    text({ fontSize: nameSize(name), fontWeight: 700, lineHeight: 1.1, whiteSpace: 'nowrap', maxWidth: textWidth, overflow: 'hidden' }, name),
    ...(alias ? [clamp(2, { fontSize: 32, lineHeight: 1.2, marginTop: 4, textAlign: 'center', width: textWidth }, `a.k.a. ${alias}`)] : []),
  ]);

  const headlineText = drawable(c.headline);
  const headline =
    layout.headline && headlineText
      ? [
          el('div', { flexDirection: 'column', width: textWidth, background: '#f4f1ea', color: '#111', padding: '12px 18px', flexShrink: 0 }, [
            text({ fontSize: 20, fontWeight: 700, letterSpacing: 4, borderBottom: '2px solid #111', paddingBottom: 4, marginBottom: 6 }, style.paper.toUpperCase()),
            clamp(2, { fontSize: 34, fontWeight: 700, lineHeight: 1.15 }, headlineText),
          ]),
        ]
      : [];

  // overflow: hidden is the safety net if a font renders wider than budgeted: clip, never push the reward off.
  const rapSheet = el('div', { flexDirection: 'column', width: textWidth, borderTop: `3px solid ${INK}`, paddingTop: 12, flexShrink: 1, overflow: 'hidden' }, [
    text({ fontSize: 24, fontWeight: 700, letterSpacing: 5, marginBottom: 8 }, 'RAP SHEET'),
    ...charges.map((charge, i) =>
      el('div', { fontSize: 26, lineHeight: 1.3, marginBottom: 8, width: textWidth }, [
        text({ fontWeight: 700, width: 44, flexShrink: 0 }, `${i + 1}.`),
        clamp(2, { width: textWidth - 44 }, charge),
      ]),
    ),
  ]);

  const reward = text(
    { fontSize: 26, fontWeight: 700, borderTop: `3px solid ${INK}`, paddingTop: 12, width: textWidth, justifyContent: 'center', flexShrink: 0 },
    `REWARD: ${style.reward.toUpperCase()}`,
  );

  // Blocks are spread evenly down the poster, so short text leaves even gaps rather than one hole.
  return el(
    'div',
    {
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'space-between',
      width,
      height,
      background: PAPER,
      color: INK,
      border: '10px solid #6b4e26',
      padding: '26px 44px 22px',
      overflow: 'hidden',
    },
    [heading, photoBlock(photoSrc, layout.photo, stamp), identity, ...headline, rapSheet, reward],
  );
}

export const dataUrl = (photo) => `data:${photo.type};base64,${Buffer.from(photo.bytes).toString('base64')}`;

// Lays the tree out at `width`×`height` and rasterises it `zoom` times larger (text is vector, so it stays
// sharp). Calls `use(image)` with resvg's image (`width`, `height`, `pixels` RGBA, `asPng()`) and frees it
// afterwards: wasm memory is not garbage-collected.
export async function rasterise(tree, { width, height }, fonts, { zoom = 1, use = (image) => image.asPng() } = {}) {
  const svg = await satori(tree, { width, height, fonts });
  const resvg = new Resvg(svg, { fitTo: zoom === 1 ? { mode: 'original' } : { mode: 'zoom', value: zoom } });
  try {
    const image = resvg.render();
    try {
      return use(image);
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}

// Why a photo can't be drawn, or null if it can.
export function photoProblemOf(photo) {
  if (!photo) return 'no photo';
  const size = imageSize(photo.bytes, photo.type);
  if (!size) return `unreadable or unsupported ${photo.type} header`;
  if (size.width * size.height > MAX_PHOTO_PIXELS) return `too large to decode (${size.width}×${size.height})`;
  return null;
}

// A photo that can't be drawn (unreadable, unsupported, oversized, or rejected by the decoder) must not cost
// the owner their share image: it renders without it, and `photoProblem` says why so the caller can log it.
// `read` is injectable so tests can make asset loading fail.
export async function renderSharePng(pet, photo, { size = 'post', host, read = readFile } = {}) {
  if (!Object.hasOwn(SHARE_SIZES, size) || !Object.hasOwn(LAYOUT, size)) throw new RangeError(`unknown share size: ${size}`);
  const fonts = await loadRenderer(read);
  let photoProblem = photoProblemOf(photo);
  if (!photoProblem) {
    const tree = shareTree(pet, { size, host, photoSrc: dataUrl(photo) });
    try {
      return { png: await rasterise(tree, SHARE_SIZES[size], fonts), photoShown: true };
    } catch (err) {
      photoProblem = `decoder failed: ${err?.message ?? err}`;
    }
  }
  const png = await rasterise(shareTree(pet, { size, host }), SHARE_SIZES[size], fonts);
  return { png, photoShown: false, photoProblem };
}
