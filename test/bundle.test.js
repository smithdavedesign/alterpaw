// M3: the paid download. 402 before payment, then a zip of 4 clean high-res card images and a PDF.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { nodeFileTrace } from '@vercel/nft';
import {
  makeApp,
  createPreview,
  petForm,
  payFor,
  fakeWebhookSecret,
  petRecord,
  validCharacter,
  DAY_MS,
} from './helpers.js';
import { pngSize, decodePng, countColour, colourBox, solidJpeg, isPng, pngIdat, pngChunksValid } from './png.js';
import { readPdf, pdfPages, readZipDirectory } from './formats.js';
import { BUNDLE_CARDS, BUNDLE_PDF, BUNDLE_IMAGE_SIZE, CARD_LAYOUT_SIZE, PRINT_SCALE, PDF_PAGE, cardTree, renderBundle } from '../src/bundle.js';
import { shareTree, renderSharePng } from '../src/share.js';
import { BUNDLE_FILE_NAME, REPORT_LIMIT } from '../src/app.js';

const SECRET = fakeWebhookSecret();
const BLUE = [30, 90, 200];
const blueJpeg = () => new File([solidJpeg(400, 300, BLUE)], 'pet.jpg', { type: 'image/jpeg' });

// Every string in a satori tree, in order.
function texts(node) {
  if (node == null || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

// A renderBundle stand-in that counts calls and returns tiny files.
function countingRenderer() {
  const seen = [];
  const renderBundle = async (pet, photo) => {
    seen.push({ pet, photo });
    return { files: [{ name: 'x.png', bytes: new Uint8Array([1]) }], photoShown: true };
  };
  return { renderBundle, seen };
}

async function paidPreview(options = {}, form = petForm()) {
  const ctx = makeApp({ webhookSecret: SECRET, ...options });
  const slug = await createPreview(ctx.app, form);
  await payFor(ctx.app, slug, SECRET);
  return { ...ctx, slug };
}

describe('before payment (M3 exit criterion 1)', () => {
  test('GET bundle.zip returns 402 with a page offering the $9 checkout, and renders nothing', async () => {
    const { renderBundle, seen } = countingRenderer();
    const { app } = makeApp({ renderBundle });
    const slug = await createPreview(app);
    const res = await app.request(`/p/${slug}/bundle.zip`);
    assert.equal(res.status, 402);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/checkout"/);
    assert.ok(html.includes(`name="slug" value="${slug}"`));
    assert.ok(html.includes('$9'));
    assert.match(html, /<meta name="robots" content="[^"]*noindex/);
    assert.equal(seen.length, 0);
  });

  test('a JSON client gets 402 as JSON; HEAD gets 402 too', async () => {
    const { renderBundle, seen } = countingRenderer();
    const { app } = makeApp({ renderBundle });
    const slug = await createPreview(app);
    const json = await app.request(`/p/${slug}/bundle.zip`, { headers: { accept: 'application/json' } });
    assert.equal(json.status, 402);
    assert.ok((await json.json()).error);
    assert.equal((await app.request(`/p/${slug}/bundle.zip`, { method: 'HEAD' })).status, 402);
    assert.equal(seen.length, 0);
  });

  test('the preview is watermarked: every card carries the watermark and the share image its FREE PREVIEW stamp', async () => {
    const { app, store } = makeApp();
    const slug = await createPreview(app);
    const html = await (await app.request(`/p/${slug}`)).text();
    assert.equal(html.split('class="watermark"').length - 1, 4);
    const pet = await store.getPet(slug);
    assert.equal(pet.paidAt, null);
    for (const size of ['post', 'story']) assert.ok(texts(shareTree(pet, { size, host: 'h' })).includes('FREE PREVIEW'), size);
  });

  test('unknown → 404, malformed → 404 without a lookup; expired or taken down → 410 even when paid', async () => {
    const { renderBundle, seen } = countingRenderer();
    const now = new Date();
    const { app, store } = makeApp({ renderBundle, now: () => now });
    assert.equal((await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA/bundle.zip')).status, 404);
    const getPet = store.getPet.bind(store);
    let lookups = 0;
    store.getPet = async (slug) => (lookups++, getPet(slug));
    assert.equal((await app.request('/p/short/bundle.zip')).status, 404);
    assert.equal(lookups, 0, 'a malformed slug never reaches the store');
    await store.createPet(petRecord({ slug: 'expired-paid-slug-0001', createdAt: new Date(now.getTime() - 31 * DAY_MS) }));
    await store.createPet(petRecord({ slug: 'removed-paid-slug-0001' }));
    for (const slug of ['expired-paid-slug-0001', 'removed-paid-slug-0001']) {
      await store.markPaid(slug, { sessionId: 'cs_x', at: now });
    }
    store.records.get('removed-paid-slug-0001').reports = REPORT_LIMIT;
    assert.equal((await app.request('/p/expired-paid-slug-0001/bundle.zip')).status, 410);
    assert.equal((await app.request('/p/removed-paid-slug-0001/bundle.zip')).status, 410);
    assert.equal(seen.length, 0);
  });
});

describe('after payment: GET /p/<slug>/bundle.zip (M3 exit criterion 3)', () => {
  // One real render (fonts, wasm, a real JPEG), shared by the tests below: ~3 s.
  let res;
  let zip;
  let entries;
  let pet;
  before(async () => {
    const ctx = await paidPreview({}, petForm({ photo: blueJpeg() }));
    pet = await ctx.store.getPet(ctx.slug);
    res = await ctx.app.request(`/p/${ctx.slug}/bundle.zip`);
    zip = new Uint8Array(await res.arrayBuffer());
    entries = unzipSync(zip);
  });

  test('returns a private, no-store zip attachment with its exact length', () => {
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(res.headers.get('content-disposition'), `attachment; filename="${BUNDLE_FILE_NAME}"`);
    assert.match(res.headers.get('cache-control') ?? '', /private/);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.equal(Number(res.headers.get('content-length')), zip.length);
    readZipDirectory(zip); // throws on a bad CRC, offset or header
  });

  test('contains exactly the 4 card images and a PDF', () => {
    assert.equal(BUNDLE_CARDS.length, 4);
    assert.deepEqual(BUNDLE_CARDS.map((c) => c.id), ['wanted', 'newspaper', 'trading', 'bio']);
    assert.deepEqual(Object.keys(entries), [...BUNDLE_CARDS.map((c) => c.file), BUNDLE_PDF]);
    assert.ok(BUNDLE_PDF.endsWith('.pdf'));
    for (const card of BUNDLE_CARDS) {
      const png = entries[card.file];
      assert.ok(card.file.endsWith('.png'), card.file);
      assert.ok(isPng(png) && pngChunksValid(png), card.file);
      assert.deepEqual(pngSize(png), BUNDLE_IMAGE_SIZE, card.file);
    }
  });

  test('the images are high-res: 1800×2250, the 1200×1500 layout at 1.5×, 8×10 in at 225 dpi', () => {
    assert.deepEqual(CARD_LAYOUT_SIZE, { width: 1200, height: 1500 });
    assert.equal(PRINT_SCALE, 1.5);
    assert.deepEqual(BUNDLE_IMAGE_SIZE, { width: 1800, height: 2250 });
    assert.deepEqual(PDF_PAGE, { width: 576, height: 720 });
    assert.equal(BUNDLE_IMAGE_SIZE.width / (PDF_PAGE.width / 72), 225);
  });

  test("no watermark: the owner's photo is drawn whole on every card, with nothing stamped over it", () => {
    for (const card of BUNDLE_CARDS) {
      const image = decodePng(entries[card.file]);
      const box = colourBox(image, BLUE);
      assert.ok(box.width >= 500 && box.height >= 400, `${card.id}: the photo is large (${box.width}×${box.height})`);
      if (card.id === 'bio') {
        // A round photo fills π/4 of its box.
        assert.ok(Math.abs(box.fill - Math.PI / 4) < 0.02, `${card.id}: round photo, fill ${box.fill.toFixed(3)}`);
      } else {
        // Only the anti-aliased edge (and rounded corners) may be missing.
        assert.ok(box.fill > 0.99, `${card.id}: nothing drawn over the photo, fill ${box.fill.toFixed(4)}`);
      }
    }
  });

  test('the same check catches a stamp: the free share image fails it', async () => {
    const unpaid = { ...pet, paidAt: null };
    const { png } = await renderSharePng(unpaid, { bytes: solidJpeg(400, 300, BLUE), type: 'image/jpeg' }, { size: 'post', host: 'h' });
    assert.ok(colourBox(decodePng(png), BLUE).fill < 0.98, 'the FREE PREVIEW stamp leaves a hole in the photo');
  });

  test('no card has any preview or watermark text, and each tells the story', () => {
    const c = validCharacter();
    const expected = {
      wanted: ['WANTED', 'BISCUIT', `a.k.a. ${c.alias}`, c.rapSheet[0], c.rapSheet[2]],
      newspaper: ['THE DAILY BARK', c.headline],
      trading: ['BISCUIT', c.alias, c.stats[0].label.toUpperCase(), String(c.stats[4].value)],
      bio: ['CHARACTER PROFILE', 'Biscuit', c.alias, c.bio, 'greedy'],
    };
    for (const card of BUNDLE_CARDS) {
      const all = texts(cardTree(pet, card.id, { photoSrc: null }));
      for (const text of all) assert.doesNotMatch(text, /preview|watermark/i, `${card.id}: "${text}"`);
      for (const text of expected[card.id]) assert.ok(all.includes(text), `${card.id} shows "${text}"`);
    }
  });

  test('the PDF has one 8×10 in page per card, each exactly that card image, with nothing drawn on top', () => {
    const pages = pdfPages(readPdf(entries[BUNDLE_PDF]));
    assert.equal(pages.length, 4);
    for (const [i, card] of BUNDLE_CARDS.entries()) {
      const page = pages[i];
      assert.deepEqual(page.mediaBox, [0, 0, 576, 720]);
      assert.equal(page.images.length, 1);
      assert.doesNotMatch(page.content, /\bBT\b|\bTj\b/, 'no text operators');
      assert.match(page.images[0].object.dict, /\/Width 1800 \/Height 2250/);
      assert.deepEqual(inflateSync(page.images[0].object.stream), inflateSync(pngIdat(entries[card.file])), `page ${i + 1} is ${card.file}`);
    }
  });
});

describe('after payment: other cases', () => {
  test('a photo the decoder cannot read still gives 4 images and a PDF, and logs a warning', async () => {
    const { app, slug, logs } = await paidPreview(); // magic bytes + filler: not a decodable JPEG
    const res = await app.request(`/p/${slug}/bundle.zip`);
    assert.equal(res.status, 200);
    const entries = unzipSync(new Uint8Array(await res.arrayBuffer()));
    assert.equal(Object.keys(entries).length, 5);
    for (const card of BUNDLE_CARDS) assert.deepEqual(pngSize(entries[card.file]), BUNDLE_IMAGE_SIZE);
    assert.ok(logs.some((l) => l.startsWith('warn') && l.includes('bundle: photo not drawn')));
  });

  test('passes the stored record and photo to the renderer (so a rewrite is in the next download)', async () => {
    const { renderBundle, seen } = countingRenderer();
    const { app, slug } = await paidPreview({ renderBundle }, petForm({ photo: blueJpeg() }));
    const res = await app.request(`/p/${slug}/bundle.zip`);
    assert.equal(res.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].pet.slug, slug);
    assert.ok(seen[0].pet.paidAt);
    assert.equal(seen[0].photo.type, 'image/jpeg');
    assert.deepEqual(Object.keys(unzipSync(new Uint8Array(await res.arrayBuffer()))), ['x.png']);
  });

  test('HEAD gives the status and headers without rendering', async () => {
    const { renderBundle, seen } = countingRenderer();
    const { app, slug } = await paidPreview({ renderBundle });
    const res = await app.request(`/p/${slug}/bundle.zip`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.equal(seen.length, 0);
  });

  test('a renderer failure is a 500 page, logged, with no internals leaked', async () => {
    const renderBundle = async () => {
      throw new Error('wasm out of memory');
    };
    const { app, slug, logs } = await paidPreview({ renderBundle });
    const res = await app.request(`/p/${slug}/bundle.zip`);
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes('wasm'));
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('wasm out of memory')));
  });

  test('a photo deleted between the two reads gives the expired page (410)', async () => {
    const { renderBundle, seen } = countingRenderer();
    const { app, slug, store } = await paidPreview({ renderBundle });
    store.getPhoto = async () => null;
    const res = await app.request(`/p/${slug}/bundle.zip`);
    assert.equal(res.status, 410);
    assert.match(await res.text(), /expired/i);
    assert.equal(seen.length, 0);
  });
});

describe('the paid preview page', () => {
  test('drops the watermark and offers the download, the one rewrite and the deadline', async () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const ctx = makeApp({ webhookSecret: SECRET, now: () => now });
    const slug = await createPreview(ctx.app);
    await payFor(ctx.app, slug, SECRET, now.getTime() / 1000);
    const html = await (await ctx.app.request(`/p/${slug}`)).text();
    assert.equal(html.split('class="watermark"').length - 1, 0, 'no watermark once paid');
    assert.ok(html.includes(`href="/p/${slug}/bundle.zip" download="${BUNDLE_FILE_NAME}"`));
    assert.match(html, /<form[^>]*method="post"[^>]*action="\/regenerate"/);
    assert.match(html, /November 12, 2026/, 'the download deadline: 30 days after upload');
    assert.doesNotMatch(html, /action="\/checkout"/, 'no second payment offered');
  });

  test("the paid share images lose the FREE PREVIEW stamp but keep the make-your-pet's line", async () => {
    const ctx = await paidPreview();
    const pet = await ctx.store.getPet(ctx.slug);
    for (const size of ['post', 'story']) {
      const all = texts(shareTree(pet, { size, host: 'alterpaw.example' }));
      assert.ok(!all.includes('FREE PREVIEW'), size);
      assert.ok(all.includes("Make your pet's at alterpaw.example"), size);
    }
  });
});

describe('deploy bundle (M3)', () => {
  test("Vercel's file tracer ships the lazily loaded bundle renderer and its encoders", async () => {
    const base = fileURLToPath(new URL('..', import.meta.url));
    const { fileList } = await nodeFileTrace(['src/index.js'], { base });
    for (const file of ['src/bundle.js', 'src/files.js', 'src/payments.js', 'src/share.js']) assert.ok(fileList.has(file), file);
  });
});

describe('card layouts', () => {
  test('every card tree is exactly the layout size', () => {
    const pet = petRecord();
    for (const card of BUNDLE_CARDS) {
      const tree = cardTree(pet, card.id, { photoSrc: null });
      assert.equal(tree.props.style.width, CARD_LAYOUT_SIZE.width, card.id);
      assert.equal(tree.props.style.height, CARD_LAYOUT_SIZE.height, card.id);
    }
    assert.throws(() => cardTree(pet, 'constructor', { photoSrc: null }), RangeError);
  });

  test('every field at its maximum length, emoji and markup render without failing', async () => {
    const long = (n, word = 'Sausage ') => word.repeat(Math.ceil(n / word.length)).slice(0, n).trim();
    const pet = petRecord({
      name: 'Łatka 🐶 <b>Zoë</b> von Biscuit',
      traits: [long(40, 'afraid of the vacuum '), long(40), '<script>alert(1)</script>'],
      character: validCharacter({
        alias: long(60, 'The Crumb '),
        rapSheet: Array.from({ length: 6 }, (_, i) => `${i + 1} ${long(137)}`),
        stats: Array.from({ length: 5 }, (_, i) => ({ label: long(24, 'Treat Theft '), value: i * 24 + 1 })),
        headline: long(110, 'DOG DENIES HEIST '),
        article: [long(400, 'Witnesses report a blur. '), long(400, 'The suspect slept. '), long(398, 'Paprika was detected. ')].join('\n\n'),
        bio: long(600, 'Biscuit rose from humble puppyhood. '),
      }),
    });
    const { files, photoShown, photoProblem } = await renderBundle(pet, null);
    assert.equal(photoShown, false);
    assert.equal(photoProblem, 'no photo');
    assert.equal(files.length, 5);
    for (const card of BUNDLE_CARDS) assert.deepEqual(pngSize(files.find((f) => f.name === card.file).bytes), BUNDLE_IMAGE_SIZE);
  });
});
