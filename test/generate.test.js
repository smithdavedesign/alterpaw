import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import {
  MB,
  makeApp,
  generate,
  petForm,
  validCharacter,
  jpegBytes,
  pngBytes,
  gifBytes,
  webpBytes,
  SpyStore,
} from './helpers.js';

describe('POST /generate — happy path', () => {
  test('exit criterion 1: Biscuit / dog / 3 traits / "crime boss" returns 200 with a complete character', async () => {
    const { app } = makeApp();
    const { res, body } = await generate(app, petForm({ name: 'Biscuit', species: 'dog', alterEgo: 'crime boss' }));

    assert.equal(res.status, 200);
    const c = body.character;
    assert.equal(typeof c.alias, 'string');
    assert.ok(c.alias.trim().length > 0, 'alias is non-empty');
    assert.ok(Array.isArray(c.rapSheet) && c.rapSheet.length >= 3, 'rap sheet has 3+ items');
    for (const item of c.rapSheet) assert.ok(typeof item === 'string' && item.trim().length > 0);
    assert.equal(c.stats.length, 5, 'exactly 5 stats');
    for (const stat of c.stats) {
      assert.ok(Number.isInteger(stat.value), `stat ${stat.label} is an integer`);
      assert.ok(stat.value >= 1 && stat.value <= 99, `stat ${stat.label} is within 1–99`);
      assert.ok(stat.label.trim().length > 0);
    }
    assert.ok(c.headline.trim().length > 0, 'headline is non-empty');
    assert.ok(c.bio.trim().length > 0, 'bio is non-empty');
    assert.ok(c.article.trim().length > 0, 'article is non-empty');
  });

  test('returns an unguessable slug and the preview url, and stores exactly one record', async () => {
    const { app, store } = makeApp();
    const { res, body } = await generate(app);
    assert.equal(res.status, 200);
    assert.match(body.slug, /^[A-Za-z0-9_-]{12,}$/);
    assert.equal(body.url, `/p/${body.slug}`);
    assert.equal(store.creates, 1);
    const saved = await store.getPet(body.slug);
    assert.equal(saved.name, 'Biscuit');
    assert.equal(saved.species, 'dog');
    assert.deepEqual(saved.traits, ['greedy', 'loyal', 'afraid of the vacuum']);
    assert.equal(saved.alterEgo, 'crime-boss');
    assert.equal(saved.character.alias, validCharacter().alias);
    assert.deepEqual(body.pet, { name: 'Biscuit', species: 'dog', traits: saved.traits, alterEgo: 'crime-boss' });
  });

  test('accepts the alter-ego id form and any case', async () => {
    for (const alterEgo of ['crime-boss', 'Crime Boss', '  CRIME   boss ']) {
      const { app } = makeApp();
      const { res, body } = await generate(app, petForm({ alterEgo }));
      assert.equal(res.status, 200, alterEgo);
      assert.equal(body.pet.alterEgo, 'crime-boss');
    }
  });

  test('all six alter egos generate', async () => {
    const ids = ['crime-boss', 'corrupt-ceo', 'washed-up-rock-star', 'celebrity-chef', 'retired-spy', 'reality-tv-villain'];
    for (const alterEgo of ids) {
      const { app } = makeApp();
      const { res } = await generate(app, petForm({ alterEgo }));
      assert.equal(res.status, 200, alterEgo);
    }
  });

  test('the model is called once, with the name, species, traits and alter ego in the prompt', async () => {
    const { app, calls } = makeApp();
    await generate(app);
    assert.equal(calls.length, 1);
    const prompt = calls[0].map((m) => m.content).join('\n');
    for (const needle of ['Biscuit', 'dog', 'greedy', 'loyal', 'afraid of the vacuum', 'Crime boss']) {
      assert.ok(prompt.includes(needle), `prompt mentions ${needle}`);
    }
  });

  test('a fenced JSON reply is accepted', async () => {
    const { app } = makeApp({ reply: 'Here you go!\n```json\n' + JSON.stringify(validCharacter()) + '\n```' });
    const { res } = await generate(app);
    assert.equal(res.status, 200);
  });

  test('accepts JPEG, PNG, WebP and GIF, detected from the bytes', async () => {
    const cases = [
      [jpegBytes(), 'image/jpeg'],
      [pngBytes(), 'image/png'],
      [webpBytes(), 'image/webp'],
      [gifBytes(), 'image/gif'],
    ];
    for (const [bytes, type] of cases) {
      const { app, store } = makeApp();
      // The client-declared type and filename are deliberately wrong: only the bytes count.
      const photo = new File([bytes], 'whatever.bin', { type: 'application/octet-stream' });
      const { res, body } = await generate(app, petForm({ photo }));
      assert.equal(res.status, 200, type);
      const saved = await store.getPhoto(body.slug);
      assert.equal(saved.type, type);
      assert.deepEqual(Buffer.from(saved.bytes), Buffer.from(bytes));
    }
  });
});

describe('POST /generate — bad model output (exit criterion 2)', () => {
  async function expect502(reply) {
    const { app, store } = makeApp({ reply });
    const { res, body } = await generate(app);
    assert.equal(res.status, 502);
    assert.equal(typeof body.error, 'string');
    assert.equal(store.creates, 0, 'nothing stored');
  }

  test('invalid JSON returns 502 and stores nothing', async () => {
    await expect502('Sure! Biscuit is a crime boss who loves sausages.');
  });

  test('truncated JSON returns 502 and stores nothing', async () => {
    await expect502(JSON.stringify(validCharacter()).slice(0, 120));
  });

  test('a JSON array or a bare string returns 502', async () => {
    await expect502(JSON.stringify([validCharacter()]));
    await expect502(JSON.stringify('alias'));
  });

  for (const field of ['alias', 'rapSheet', 'stats', 'headline', 'article', 'bio']) {
    test(`missing "${field}" returns 502 and stores nothing`, async () => {
      const character = validCharacter();
      delete character[field];
      await expect502(JSON.stringify(character));
    });
  }

  test('empty strings count as missing', async () => {
    await expect502(JSON.stringify(validCharacter({ alias: '   ' })));
    await expect502(JSON.stringify(validCharacter({ headline: '' })));
  });

  test('a rap sheet with fewer than 3 items returns 502', async () => {
    await expect502(JSON.stringify(validCharacter({ rapSheet: ['one', 'two'] })));
    await expect502(JSON.stringify(validCharacter({ rapSheet: ['one', 'two', '  '] })));
  });

  test('fewer than 5 stats, or a non-numeric stat, returns 502', async () => {
    const stats = validCharacter().stats;
    await expect502(JSON.stringify(validCharacter({ stats: stats.slice(0, 4) })));
    await expect502(JSON.stringify(validCharacter({ stats: [...stats.slice(0, 4), { label: 'Chaos', value: 'lots' }] })));
    await expect502(JSON.stringify(validCharacter({ stats: [...stats.slice(0, 4), { label: '', value: 50 }] })));
  });

  test('wrong types return 502', async () => {
    await expect502(JSON.stringify(validCharacter({ alias: 42 })));
    await expect502(JSON.stringify(validCharacter({ rapSheet: 'stole a sausage' })));
    await expect502(JSON.stringify(validCharacter({ rapSheet: ['a', 'b', { crime: 'c' }] })));
  });

  test('a model call that throws (timeout, quota, network) returns 502 and stores nothing', async () => {
    const { app, store } = makeApp({
      reply: () => {
        throw new Error('upstream timed out');
      },
    });
    const { res, body } = await generate(app);
    assert.equal(res.status, 502);
    assert.doesNotMatch(body.error, /upstream timed out/, 'internal error text is not leaked');
    assert.equal(store.creates, 0);
  });
});

describe('POST /generate — model output is normalised before storing', () => {
  test('stats are rounded and clamped to 1–99; only the first 5 are kept', async () => {
    const stats = [
      { label: 'Menace', value: 0 },
      { label: 'Charm', value: 150 },
      { label: 'Speed', value: 42.6 },
      { label: 'Naps', value: '77' },
      { label: 'Chaos', value: -3 },
      { label: 'Extra', value: 50 },
    ];
    const { app } = makeApp({ reply: JSON.stringify(validCharacter({ stats })) });
    const { res, body } = await generate(app);
    assert.equal(res.status, 200);
    assert.deepEqual(
      body.character.stats.map((s) => s.value),
      [1, 99, 43, 77, 1],
    );
  });

  test('over-long fields are capped and unknown keys are dropped', async () => {
    const long = 'ha'.repeat(2000);
    const rapSheet = Array.from({ length: 12 }, (_, i) => `crime ${i + 1}`);
    const reply = JSON.stringify({ ...validCharacter({ alias: long, bio: long, article: long, rapSheet }), evil: '<script>' });
    const { app } = makeApp({ reply });
    const { res, body } = await generate(app);
    assert.equal(res.status, 200);
    assert.ok(body.character.alias.length <= 60);
    assert.ok(body.character.bio.length <= 600);
    assert.ok(body.character.article.length <= 1200);
    assert.equal(body.character.rapSheet.length, 6);
    assert.equal(body.character.evil, undefined);
  });
});

describe('POST /generate — bad uploads (exit criterion 5)', () => {
  async function expect400(form, pattern) {
    const { app, store, calls } = makeApp();
    const { res, body } = await generate(app, form);
    assert.equal(res.status, 400);
    assert.equal(typeof body.error, 'string');
    if (pattern) assert.match(body.error, pattern);
    assert.equal(calls.length, 0, 'model not called');
    assert.equal(store.creates, 0, 'nothing stored');
  }

  test('a photo just over 10 MB returns 400', async () => {
    const photo = new File([jpegBytes(10 * MB + 1)], 'big.jpg', { type: 'image/jpeg' });
    await expect400(petForm({ photo }), /10 MB/);
  });

  test('a 12 MB upload returns 400 (rejected while streaming)', async () => {
    const photo = new File([jpegBytes(12 * MB)], 'huge.jpg', { type: 'image/jpeg' });
    await expect400(petForm({ photo }), /10 MB/);
  });

  test('a photo of exactly 10 MB is accepted', async () => {
    const { app } = makeApp();
    const photo = new File([jpegBytes(10 * MB)], 'ok.jpg', { type: 'image/jpeg' });
    const { res } = await generate(app, petForm({ photo }));
    assert.equal(res.status, 200);
  });

  test('a text file posing as a JPEG returns 400', async () => {
    const photo = new File(['just some text, not an image'], 'pet.jpg', { type: 'image/jpeg' });
    await expect400(petForm({ photo }), /image/i);
  });

  test('an SVG returns 400 (scriptable, never accepted)', async () => {
    const photo = new File(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], 'pet.svg', {
      type: 'image/svg+xml',
    });
    await expect400(petForm({ photo }), /image/i);
  });

  test('an empty file returns 400', async () => {
    await expect400(petForm({ photo: new File([], 'empty.jpg', { type: 'image/jpeg' }) }), /photo/i);
  });

  test('a missing photo returns 400', async () => {
    await expect400(petForm({ photo: null }), /photo/i);
  });

  test('a photo sent as a plain text field returns 400', async () => {
    const form = petForm({ photo: null });
    form.append('photo', 'not-a-file');
    await expect400(form, /photo/i);
  });

  test('a non-multipart body returns 400', async () => {
    const { app, calls } = makeApp();
    const res = await app.request('/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Biscuit' }),
    });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });
});

describe('POST /generate — field validation', () => {
  async function expect400(form, pattern) {
    const { app, store, calls } = makeApp();
    const { res, body } = await generate(app, form);
    assert.equal(res.status, 400);
    assert.match(body.error, pattern);
    assert.equal(calls.length, 0, 'model not called');
    assert.equal(store.creates, 0);
  }

  test('a missing or blank name returns 400', async () => {
    await expect400(petForm({ name: null }), /name/i);
    await expect400(petForm({ name: '   ' }), /name/i);
  });

  test('a name over 30 characters returns 400', async () => {
    await expect400(petForm({ name: 'B'.repeat(31) }), /name/i);
  });

  test('an unknown species returns 400', async () => {
    await expect400(petForm({ species: 'dragon' }), /species/i);
    await expect400(petForm({ species: null }), /species/i);
  });

  test('an unknown or missing alter ego returns 400', async () => {
    await expect400(petForm({ alterEgo: 'astronaut' }), /alter ego/i);
    await expect400(petForm({ alterEgo: null }), /alter ego/i);
  });

  test('no traits, or only blank traits, returns 400', async () => {
    await expect400(petForm({ traits: [] }), /trait/i);
    await expect400(petForm({ traits: [' ', ''] }), /trait/i);
  });

  test('more than 3 traits returns 400', async () => {
    await expect400(petForm({ traits: ['a', 'b', 'c', 'd'] }), /trait/i);
  });

  test('a trait over 40 characters returns 400', async () => {
    await expect400(petForm({ traits: ['x'.repeat(41)] }), /trait/i);
  });

  test('one or two traits are fine; blanks are dropped and whitespace tidied', async () => {
    const { app } = makeApp();
    const { res, body } = await generate(app, petForm({ name: '  Sir\n Biscuit ', traits: ['  greedy ', '', 'loud'] }));
    assert.equal(res.status, 200);
    assert.equal(body.pet.name, 'Sir Biscuit');
    assert.deepEqual(body.pet.traits, ['greedy', 'loud']);
  });

  test('species is case-insensitive', async () => {
    const { app } = makeApp();
    const { res, body } = await generate(app, petForm({ species: 'CAT' }));
    assert.equal(res.status, 200);
    assert.equal(body.pet.species, 'cat');
  });
});

describe('POST /generate — storage failure', () => {
  test('a database error returns 500 and does not report success', async () => {
    class BrokenStore extends SpyStore {
      async createPet() {
        throw new Error('connection refused');
      }
    }
    const { app } = makeApp({ store: new BrokenStore() });
    const { res, body } = await generate(app);
    assert.equal(res.status, 500);
    assert.equal(typeof body.error, 'string');
    assert.doesNotMatch(body.error, /connection refused/);
  });

  test('any unexpected error on POST still answers with JSON the form can show', async () => {
    const store = new SpyStore();
    const app = createApp({
      store,
      complete: async () => JSON.stringify(validCharacter()),
      logger: { error() {} },
      slug: () => {
        throw new Error('no entropy');
      },
    });
    const { res, body } = await generate(app);
    assert.equal(res.status, 500);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.doesNotMatch(body.error, /entropy/);
    assert.equal(store.creates, 0);
  });
});
