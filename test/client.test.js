// The browser upload script, run against a small fake DOM. It is the only path real users take to
// POST /generate, so its resize → upload → redirect / error flow is tested like the server code.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { UPLOAD_SCRIPT } from '../src/views.js';
import { jpegBytes } from './helpers.js';

function fakeElement(props = {}) {
  const handlers = {};
  const classes = new Set();
  return {
    handlers,
    hidden: false,
    disabled: false,
    textContent: '',
    value: '',
    src: '',
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (n) => classes.has(n) },
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    ...props,
  };
}

function setup({ file, bitmap = { width: 4000, height: 3000 }, decodes = true, hasImageBitmap = true, respond }) {
  const traits = [fakeElement({ value: 'greedy' }), fakeElement(), fakeElement()];
  const photoInput = fakeElement({ files: file ? [file] : [] });
  const button = fakeElement();
  const statusLine = fakeElement();
  const preview = fakeElement();
  const fields = { name: 'Biscuit', species: 'dog', alterEgo: 'crime-boss' };
  const form = fakeElement({
    querySelector: (sel) => (sel.includes('submit') ? button : photoInput),
    querySelectorAll: () => traits,
  });
  const canvases = [];
  const requests = [];
  const navigations = [];
  const windowHandlers = {};

  const env = {
    document: {
      getElementById: (id) => ({ 'pet-form': form, 'form-status': statusLine, 'photo-preview': preview })[id],
      createElement: () => {
        const canvas = {
          width: 0,
          height: 0,
          getContext: () => ({ fillRect() {}, drawImage() {} }),
          toBlob: (cb, type) => cb(new Blob([jpegBytes(1000)], { type })),
        };
        canvases.push(canvas);
        return canvas;
      },
    },
    window: {
      location: { assign: (url) => navigations.push(url) },
      addEventListener: (type, fn) => {
        windowHandlers[type] = fn;
      },
    },
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL() {} },
    createImageBitmap: hasImageBitmap
      ? async () => {
          if (!decodes) throw new Error('cannot decode');
          return bitmap;
        }
      : undefined,
    // The real FormData(form) reads the form's fields; this stand-in does the same from the fakes.
    FormData: class extends FormData {
      constructor() {
        super();
        if (file) this.append('photo', file);
        for (const [k, v] of Object.entries(fields)) this.append(k, v);
        for (const t of traits) this.append('traits', t.value);
      }
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return respond();
    },
  };
  const run = new Function(...Object.keys(env), UPLOAD_SCRIPT);
  run(...Object.values(env));

  const submit = async () => {
    form.handlers.submit({ preventDefault() {} });
    // Let the promise chain (decode → encode → fetch → json) finish.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { form, traits, button, statusLine, preview, photoInput, canvases, requests, navigations, windowHandlers, submit };
}

const photoFile = () => new File([jpegBytes(5000)], 'IMG_0001.HEIC.jpg', { type: 'image/jpeg' });

describe('upload.js', () => {
  test('shrinks the photo to 1600px JPEG, posts every field to /generate, then opens the preview', async () => {
    const ui = setup({ file: photoFile(), respond: () => Response.json({ url: '/p/AAAAAAAAAAAAAAAAAAAAAA' }) });
    await ui.submit();

    assert.equal(ui.canvases.length, 1);
    assert.equal(ui.canvases[0].width, 1600);
    assert.equal(ui.canvases[0].height, 1200);
    assert.equal(ui.requests.length, 1);
    assert.equal(ui.requests[0].url, '/generate');
    assert.equal(ui.requests[0].init.method, 'POST');
    const body = ui.requests[0].init.body;
    const photo = body.get('photo');
    assert.equal(photo.type, 'image/jpeg');
    assert.equal(photo.size, 1000, 'the re-encoded photo was sent, not the original');
    assert.equal(body.get('name'), 'Biscuit');
    assert.equal(body.get('alterEgo'), 'crime-boss');
    assert.deepEqual(ui.navigations, ['/p/AAAAAAAAAAAAAAAAAAAAAA']);
    assert.equal(ui.button.disabled, true, 'stays disabled while navigating');
  });

  test('small photos are not upscaled', async () => {
    const ui = setup({ file: photoFile(), bitmap: { width: 800, height: 600 }, respond: () => Response.json({ url: '/p/x' }) });
    await ui.submit();
    assert.equal(ui.canvases[0].width, 800);
    assert.equal(ui.canvases[0].height, 600);
  });

  test("shows the server's error and re-enables the button", async () => {
    const ui = setup({
      file: photoFile(),
      respond: () => Response.json({ error: 'Our joke writer is stuck right now.' }, { status: 502 }),
    });
    await ui.submit();
    assert.equal(ui.statusLine.textContent, 'Our joke writer is stuck right now.');
    assert.ok(ui.statusLine.classList.contains('error'));
    assert.equal(ui.button.disabled, false);
    assert.deepEqual(ui.navigations, []);
  });

  test("explains a host's 413 (body too large) even without a JSON body", async () => {
    const ui = setup({ file: photoFile(), respond: () => new Response('Request Entity Too Large', { status: 413 }) });
    await ui.submit();
    assert.match(ui.statusLine.textContent, /too large/);
  });

  test("a network failure shows our retry message, not the browser's error text", async () => {
    for (const browserText of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
      const ui = setup({
        file: photoFile(),
        respond: () => {
          throw new TypeError(browserText);
        },
      });
      await ui.submit();
      assert.equal(ui.statusLine.textContent, 'Something went wrong. Please try again.');
      assert.equal(ui.button.disabled, false);
    }
  });

  test('a server error without a usable message falls back to the generic one', async () => {
    const ui = setup({ file: photoFile(), respond: () => Response.json({ error: { detail: 'x' } }, { status: 500 }) });
    await ui.submit();
    assert.equal(ui.statusLine.textContent, 'Something went wrong. Please try again.');
  });

  test('if the browser cannot decode the photo, nothing is uploaded (the original would carry EXIF/GPS)', async () => {
    const ui = setup({ file: photoFile(), decodes: false, respond: () => Response.json({ url: '/p/x' }) });
    await ui.submit();
    assert.equal(ui.requests.length, 0);
    assert.match(ui.statusLine.textContent, /couldn't read that photo/);
    assert.equal(ui.button.disabled, false);
  });

  test('a browser without createImageBitmap gets the same message instead of a stuck form', async () => {
    const ui = setup({ file: photoFile(), hasImageBitmap: false, respond: () => Response.json({ url: '/p/x' }) });
    await ui.submit();
    assert.equal(ui.requests.length, 0);
    assert.match(ui.statusLine.textContent, /couldn't read that photo/);
    assert.equal(ui.button.disabled, false);
  });

  test('coming back from the preview (back/forward cache) re-enables the form', async () => {
    const ui = setup({ file: photoFile(), respond: () => Response.json({ url: '/p/x' }) });
    await ui.submit();
    assert.equal(ui.button.disabled, true);
    ui.windowHandlers.pageshow({ persisted: false });
    assert.equal(ui.button.disabled, true, 'a normal load changes nothing');
    ui.windowHandlers.pageshow({ persisted: true });
    assert.equal(ui.button.disabled, false);
    assert.equal(ui.statusLine.textContent, '');
  });

  test('without a photo it asks for one and sends nothing', async () => {
    const ui = setup({ file: null, respond: () => Response.json({}) });
    await ui.submit();
    assert.match(ui.statusLine.textContent, /choose a photo/);
    assert.equal(ui.requests.length, 0);
  });

  test('a trait chip fills the first empty trait box, then replaces the last', () => {
    const ui = setup({ file: photoFile(), respond: () => Response.json({}) });
    const click = (trait) =>
      ui.form.handlers.click({ target: { closest: () => ({ getAttribute: () => trait }) } });
    click('loud');
    click('lazy');
    click('sneaky');
    assert.deepEqual(
      ui.traits.map((t) => t.value),
      ['greedy', 'loud', 'sneaky'],
    );
    ui.form.handlers.click({ target: { closest: () => null } });
  });

  test('choosing a photo shows a thumbnail; clearing it hides the thumbnail', () => {
    const ui = setup({ file: photoFile(), respond: () => Response.json({}) });
    ui.photoInput.handlers.change();
    assert.equal(ui.preview.src, 'blob:fake');
    assert.equal(ui.preview.hidden, false);
    ui.photoInput.files = [];
    ui.photoInput.handlers.change();
    assert.equal(ui.preview.hidden, true);
  });
});
