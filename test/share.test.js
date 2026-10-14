import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { relative, sep } from 'node:path';
import { nodeFileTrace } from '@vercel/nft';
import { makeApp, createPreview, petForm, validCharacter } from './helpers.js';
import { pngSize, decodePng, countColour, solidJpeg, solidPng, isPng } from './png.js';
import satori from 'satori';
import { shareTree, renderSharePng, SHARE_SIZES, ASSET_URLS, MAX_PHOTO_PIXELS, imageSize, drawable, loadFonts } from '../src/share.js';

const BLUE = [30, 90, 200];
const photoFile = (bytes, type) => new File([bytes], 'pet', { type });
const blueJpeg = () => photoFile(solidJpeg(400, 300, BLUE), 'image/jpeg');

async function sharePng(app, slug, query = '') {
  const res = await app.request(`/p/${slug}/share.png${query}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes };
}

// Every string in a satori tree, in order.
function texts(node) {
  if (node == null || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return texts(node.props?.children);
}

describe('GET /p/<slug>/share.png (M2 exit criterion 1)', () => {
  test('returns a PNG of the stated size: 1080×1350 by default (Instagram post)', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app, petForm({ photo: blueJpeg() }));
    const { res, bytes } = await sharePng(app, slug);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.ok(isPng(bytes), 'PNG signature');
    assert.deepEqual(pngSize(bytes), { width: 1080, height: 1350 });
    assert.deepEqual(SHARE_SIZES.post, { width: 1080, height: 1350 });
  });

  test('?size=story returns 1080×1920 (Stories, Reels, TikTok); ?size=post is the default', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app, petForm({ photo: blueJpeg() }));
    const story = await sharePng(app, slug, '?size=story');
    assert.equal(story.res.status, 200);
    assert.deepEqual(pngSize(story.bytes), { width: 1080, height: 1920 });
    const post = await sharePng(app, slug, '?size=post');
    assert.deepEqual(pngSize(post.bytes), { width: 1080, height: 1350 });
  });

  test("the owner's real photo is in the image (a JPEG, as the browser uploads it)", async () => {
    const { app } = makeApp();
    const slug = await createPreview(app, petForm({ photo: blueJpeg() }));
    const post = decodePng((await sharePng(app, slug)).bytes);
    assert.ok(countColour(post, BLUE) > 150_000, 'a 440 px square of the photo in the post');
    const story = decodePng((await sharePng(app, slug, '?size=story')).bytes);
    assert.ok(countColour(story, BLUE) > 400_000, 'a 700 px square of the photo in the story');
  });

  test('a PNG photo is drawn too', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app, petForm({ photo: photoFile(solidPng(60, 80, BLUE), 'image/png') }));
    const image = decodePng((await sharePng(app, slug)).bytes);
    assert.ok(countColour(image, BLUE) > 150_000);
  });

  test("a photo the decoder can't read still gives a share image of the right size, and a warning is logged", async () => {
    const { app, logs } = makeApp();
    const slug = await createPreview(app); // magic bytes + filler: passes the upload check, not a real JPEG
    const { res, bytes } = await sharePng(app, slug);
    assert.equal(res.status, 200);
    assert.deepEqual(pngSize(bytes), { width: 1080, height: 1350 });
    assert.equal(countColour(decodePng(bytes), BLUE), 0);
    assert.ok(logs.some((l) => l.startsWith('warn') && l.includes('photo not drawn (unreadable')), 'logged with the reason');
  });

  test('a photo whose header declares a huge canvas is never decoded (wasm memory never shrinks)', async () => {
    // A valid JPEG start declaring 20000×20000 px, then filler: a few KB on the wire, 1.6 GB if decoded.
    const header = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x4e, 0x20, 0x4e, 0x20, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
    const bytes = new Uint8Array(4096);
    bytes.set(header);
    assert.deepEqual(imageSize(bytes, 'image/jpeg'), { width: 20000, height: 20000 });
    const { app, logs } = makeApp();
    const slug = await createPreview(app, petForm({ photo: photoFile(bytes, 'image/jpeg') }));
    const { res, bytes: png } = await sharePng(app, slug);
    assert.equal(res.status, 200);
    assert.deepEqual(pngSize(png), { width: 1080, height: 1350 });
    assert.ok(logs.some((l) => l.includes('too large to decode (20000×20000)')));
  });

  test('an unknown size is refused with 400 before anything is rendered', async () => {
    let renders = 0;
    const { app } = makeApp({ renderShare: async () => (renders++, { png: new Uint8Array(), photoShown: true }) });
    const slug = await createPreview(app);
    for (const query of ['?size=huge', '?size=', '?size=1080x1920', '?size=constructor', '?size=__proto__', '?size=toString']) {
      const res = await app.request(`/p/${slug}/share.png${query}`);
      assert.equal(res.status, 400, query);
    }
    assert.equal(renders, 0);
  });

  test('an unknown slug is 404; a malformed one is 404 without touching the store', async () => {
    const { app, store } = makeApp();
    assert.equal((await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA/share.png')).status, 404);
    let lookups = 0;
    store.getPet = async () => (lookups++, null);
    assert.equal((await app.request('/p/short/share.png')).status, 404);
    assert.equal(lookups, 0);
  });

  test('is private, noindex and nosniff, served inline with a download name', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app, petForm({ photo: blueJpeg() }));
    const { res } = await sharePng(app, slug, '?size=story');
    assert.match(res.headers.get('cache-control') ?? '', /private/);
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-disposition') ?? '', /^inline; filename="alterpaw-wanted-story\.png"$/);
  });

  test('the image carries the host the request came to, for the "make your pet\'s" line', async () => {
    const seen = [];
    const { app } = makeApp({
      renderShare: async (pet, photo, options) => {
        seen.push({ pet, photo, options });
        return { png: solidPng(1, 1, [0, 0, 0]), photoShown: true };
      },
    });
    const slug = await createPreview(app);
    const res = await app.request(`https://alterpaw.example/p/${slug}/share.png?size=story`);
    assert.equal(res.status, 200);
    assert.deepEqual(seen[0].options, { size: 'story', host: 'alterpaw.example' });
    assert.equal(seen[0].pet.name, 'Biscuit');
    assert.equal(seen[0].photo.type, 'image/jpeg');
  });

  test('a HEAD request (link checkers, unfurlers) gets the status and headers without a render', async () => {
    let renders = 0;
    const { app } = makeApp({ renderShare: async () => (renders++, { png: solidPng(1, 1, [0, 0, 0]), photoShown: true }) });
    const slug = await createPreview(app);
    const res = await app.request(`/p/${slug}/share.png?size=story`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.match(res.headers.get('cache-control') ?? '', /private/);
    assert.match(res.headers.get('content-disposition') ?? '', /alterpaw-wanted-story\.png/);
    assert.equal((await app.request('/p/AAAAAAAAAAAAAAAAAAAAAA/share.png', { method: 'HEAD' })).status, 404);
    assert.equal((await app.request(`/p/${slug}/share.png?size=huge`, { method: 'HEAD' })).status, 400);
    assert.equal(renders, 0, 'nothing rendered for HEAD');
    assert.equal((await sharePng(app, slug)).res.status, 200);
    assert.equal(renders, 1, 'GET still renders');
  });

  test('a renderer failure returns a 500 page, logged, with no internals leaked', async () => {
    const { app, logs } = makeApp({
      renderShare: async () => {
        throw new Error('wasm out of memory');
      },
    });
    const slug = await createPreview(app);
    const res = await app.request(`/p/${slug}/share.png`);
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes('wasm out of memory'));
    assert.ok(logs.some((l) => l.startsWith('error') && l.includes('wasm out of memory')));
  });
});

describe('share image content', () => {
  const pet = {
    slug: 'AbCdEfGhIjKlMnOpQrStUv',
    name: 'Biscuit',
    species: 'dog',
    traits: ['greedy'],
    alterEgo: 'crime-boss',
    character: validCharacter({ rapSheet: ['one', 'two', 'three', 'four', 'five'] }),
  };

  test('the post shows the name, alias, top charges, the preview stamp and "make your pet\'s" with the host', () => {
    const all = texts(shareTree(pet, { size: 'post', host: 'alterpaw.example' }));
    for (const expected of ['WANTED', 'BISCUIT', 'a.k.a. Biscuit "The Crumb" Corleone', 'one', 'two', 'FREE PREVIEW', "Make your pet's at alterpaw.example"]) {
      assert.ok(all.includes(expected), expected);
    }
    assert.ok(!all.includes('three'), 'the post has room for two charges');
    assert.ok(!all.includes(validCharacter().headline), 'no headline in the post');
  });

  test('the story adds the front-page headline and more charges', () => {
    const all = texts(shareTree(pet, { size: 'story', host: 'alterpaw.example' }));
    assert.ok(all.includes(validCharacter().headline));
    assert.ok(all.includes('THE DAILY BARK'));
    assert.ok(all.includes('four') && !all.includes('five'));
  });

  test('with no photo the frame says so instead of drawing an image', () => {
    const tree = JSON.stringify(shareTree(pet, { size: 'post', host: 'h' }));
    assert.ok(!tree.includes('"img"'));
    assert.ok(tree.includes('PHOTO ON FILE'));
  });

  test('renders names and aliases with emoji, accents and markup without failing', async () => {
    const odd = {
      ...pet,
      name: 'Łatka 🐶 <b>Zoë</b>',
      character: validCharacter({ alias: '<script>alert(1)</script> «Le Chat» 猫' }),
    };
    const { png, photoShown } = await renderSharePng(odd, null, { size: 'post', host: 'h' });
    assert.deepEqual(pngSize(png), { width: 1080, height: 1350 });
    assert.equal(photoShown, false);
  });

  test('an unknown size is a RangeError, not a silently wrong image', async () => {
    await assert.rejects(renderSharePng(pet, null, { size: 'square', host: 'h' }), RangeError);
    await assert.rejects(renderSharePng(pet, null, { size: '__proto__', host: 'h' }), RangeError);
  });

  test('every share size has a layout, and the tree is exactly that size', () => {
    for (const [size, { width, height }] of Object.entries(SHARE_SIZES)) {
      const tree = shareTree(pet, { size, host: 'h' });
      assert.equal(tree.props.style.width, width, size);
      assert.equal(tree.props.style.height, height, size);
    }
  });

  test('emoji and scripts the fonts lack are left out of the image instead of drawn as boxes', () => {
    assert.equal(drawable('Biscuit 🐶'), 'Biscuit');
    assert.equal(drawable('👨‍👩‍👧 Fam 🇺🇸 1️⃣'), 'Fam 1');
    assert.equal(drawable('猫 Mochi'), 'Mochi');
    assert.equal(drawable('Барсик Λέων Ngọc Łatka Zoë'), 'Барсик Λέων Ngọc Łatka Zoë');
    const all = texts(shareTree({ ...pet, name: '🐶猫' }, { size: 'post', host: 'h' }));
    assert.ok(all.includes('UNKNOWN SUSPECT'), 'a name with nothing drawable still gets a poster');
  });

  test('Cyrillic, Greek, Vietnamese and Latin-extended names get real glyphs, not missing-glyph boxes', async () => {
    const fonts = await loadFonts();
    const glyph = async (ch) => {
      const tree = { type: 'div', props: { style: { display: 'flex', fontFamily: 'Slab', fontSize: 40 }, children: ch } };
      const svg = await satori(tree, { width: 80, height: 80, fonts });
      return [...svg.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]).join('');
    };
    const box = await glyph(String.fromCodePoint(0xe000)); // private use: in no font
    for (const ch of [...'БжЯΛέωọĐŁşğ', 'A']) assert.notEqual(await glyph(ch), box, `${ch} is drawn`);
  });

  test('reads JPEG, PNG and GIF sizes from the header; WebP and junk give null', () => {
    assert.deepEqual(imageSize(solidJpeg(40, 30, BLUE), 'image/jpeg'), { width: 40, height: 30 });
    assert.deepEqual(imageSize(solidPng(60, 80, BLUE), 'image/png'), { width: 60, height: 80 });
    const gif = new Uint8Array([...Buffer.from('GIF89a'), 0x2c, 0x01, 0xc8, 0x00, 0, 0, 0]);
    assert.deepEqual(imageSize(gif, 'image/gif'), { width: 300, height: 200 });
    assert.equal(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6, 7, 8, 9, 10, 11]), 'image/jpeg'), null);
    assert.equal(imageSize(new Uint8Array(64), 'image/webp'), null);
    assert.ok(MAX_PHOTO_PIXELS >= 6000 * 4000, 'a 24 MP phone photo is still drawn');
  });
});

describe('preview page share links (M2 deliverable: "make your pet\'s" link)', () => {
  test('each preview links back to the form with "Make your pet\'s" and offers both share sizes', async () => {
    const { app } = makeApp();
    const slug = await createPreview(app);
    const html = await (await app.request(`/p/${slug}`)).text();
    assert.match(html, /<a class="make-yours" href="\/">Make your pet(?:'|&#39;)s[^<]*<\/a>/);
    assert.ok(html.includes(`href="/p/${slug}/share.png" download="alterpaw-wanted-post.png"`));
    assert.ok(html.includes(`href="/p/${slug}/share.png?size=story" download="alterpaw-wanted-story.png"`));
    assert.ok(html.includes('1080×1350') && html.includes('1080×1920'));
  });
});

describe('deploy bundle', () => {
  test("Vercel's file tracer ships the wasm and every font the renderer loads", async () => {
    const base = fileURLToPath(new URL('..', import.meta.url));
    const { fileList } = await nodeFileTrace(['src/index.js'], { base });
    assert.ok(ASSET_URLS.length >= 4);
    for (const url of ASSET_URLS) {
      const file = relative(base, fileURLToPath(url)).split(sep).join('/');
      assert.ok(fileList.has(file), `${file} is in the function bundle`);
    }
  });
});
