// The visit beacon (/beacon.js), run against a small fake browser: what it sends to RepoHQ, when, and when
// it stays silent. The page only loads it on the production deployment (see launch.test.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { BEACON_SCRIPT, SIGNAL_ENDPOINT } from '../src/site.js';
import { UPLOAD_SCRIPT } from '../src/views.js';

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

const throwing = () => ({
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('SecurityError');
  },
});

// One page load. `session` and `local` carry over between loads to model one tab and one browser.
function load({
  href = 'https://alterpaw.example/',
  referrer = '',
  webdriver = false,
  session = fakeStorage(),
  local = fakeStorage(),
  sends = [],
  fetchThrows = false,
} = {}) {
  const listeners = {};
  const document = {
    referrer,
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    dispatch: (type, event = {}) => (listeners[type] ?? []).forEach((fn) => fn(event)),
  };
  const window = {
    get sessionStorage() {
      if (session === 'blocked') throw new Error('SecurityError');
      return session;
    },
    get localStorage() {
      if (local === 'blocked') throw new Error('SecurityError');
      return local;
    },
  };
  const fetch = (url, init) => {
    if (fetchThrows) throw new TypeError('Failed to fetch');
    sends.push({ url, init, body: JSON.parse(init.body) });
    return Promise.reject(new TypeError('offline')); // fire-and-forget: a failure must not surface
  };
  const env = { window, document, navigator: { webdriver }, location: new URL(href), fetch };
  new Function(...Object.keys(env), BEACON_SCRIPT)(...Object.values(env));
  return { document, sends, session, local };
}

const kinds = (sends) => sends.map((s) => s.body.kind);

describe('beacon.js: what it sends', () => {
  test('a visit: POST JSON {slug, kind, referrer} to the signal endpoint, keepalive, no cookies, no referrer header', () => {
    const { sends } = load();
    assert.equal(sends.length, 1);
    const [{ url, init, body }] = sends;
    assert.equal(url, SIGNAL_ENDPOINT);
    assert.equal(url, 'https://idea-factory.1426davejobs.workers.dev/api/ideas/signal');
    assert.equal(init.method, 'POST');
    assert.equal(init.keepalive, true);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.referrerPolicy, 'no-referrer');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.deepEqual(body, { slug: 'alterpaw', kind: 'visit', referrer: null });
  });

  test('the referrer is sent only when it is another site', () => {
    const outside = load({ referrer: 'https://www.reddit.com/r/dogs/' });
    assert.equal(outside.sends[0].body.referrer, 'https://www.reddit.com/r/dogs/');
    const inside = load({ referrer: 'https://alterpaw.example/p/AAAAAAAAAAAAAAAAAAAAAA' });
    assert.equal(inside.sends[0].body.referrer, null, 'a preview link never leaves the page');
    const otherPort = load({ href: 'http://localhost:3000/', referrer: 'http://localhost:4000/x' });
    assert.equal(otherPort.sends[0].body.referrer, 'http://localhost:4000/x', 'origin, not host name, decides');
    const junk = load({ referrer: 'not a url' });
    assert.equal(junk.sends[0].body.referrer, null);
  });

  test('visit: once per browser session (sessionStorage), across page loads', () => {
    const session = fakeStorage();
    const local = fakeStorage();
    const sends = [];
    load({ session, local, sends });
    load({ session, local, sends, href: 'https://alterpaw.example/terms' });
    assert.deepEqual(kinds(sends), ['visit']);
    load({ session: fakeStorage(), local, sends }); // a new session
    assert.deepEqual(kinds(sends), ['visit', 'visit']);
  });

  test('activate: on the first preview made in this browser only (localStorage)', () => {
    const local = fakeStorage();
    const sends = [];
    const first = load({ local, sends });
    first.document.dispatch('alterpaw:activate');
    first.document.dispatch('alterpaw:activate');
    const later = load({ local, sends, session: fakeStorage() });
    later.document.dispatch('alterpaw:activate');
    assert.deepEqual(kinds(sends), ['visit', 'activate', 'visit']);
  });

  test('checkout: each time a pay form is submitted, and only pay forms', () => {
    const { document, sends } = load();
    const payForm = { hasAttribute: (name) => name === 'data-checkout' };
    const reportForm = { hasAttribute: () => false };
    document.dispatch('submit', { target: payForm });
    document.dispatch('submit', { target: reportForm });
    document.dispatch('submit', { target: payForm });
    document.dispatch('submit', { target: null });
    assert.deepEqual(kinds(sends), ['visit', 'checkout', 'checkout']);
  });
});

describe('beacon.js: when it stays silent', () => {
  test('automated browsers (navigator.webdriver): nothing, for any event', () => {
    const { document, sends } = load({ webdriver: true });
    document.dispatch('alterpaw:activate');
    document.dispatch('submit', { target: { hasAttribute: () => true } });
    assert.deepEqual(sends, []);
  });

  test('the owner\'s browser (localStorage "repohq:notrack" set, to any value): nothing', () => {
    for (const value of ['1', 'true', '']) {
      const { document, sends, session } = load({ local: fakeStorage({ 'repohq:notrack': value }) });
      document.dispatch('alterpaw:activate');
      document.dispatch('submit', { target: { hasAttribute: () => true } });
      assert.deepEqual(sends, [], JSON.stringify(value));
      assert.equal(session.data.size, 0, 'nothing is written either');
    }
  });

  test('storage that is blocked or throws: nothing sent, and no error thrown', () => {
    for (const options of [{ local: 'blocked' }, { session: 'blocked' }, { local: throwing() }, { session: throwing() }]) {
      const { document, sends } = load(options);
      document.dispatch('alterpaw:activate');
      if (options.local) document.dispatch('submit', { target: { hasAttribute: () => true } });
      if (options.local) assert.deepEqual(sends, [], 'without localStorage the opt-out cannot be read, so nothing goes');
      else assert.ok(!kinds(sends).includes('visit'), 'without sessionStorage a visit cannot be counted once');
    }
  });

  test('a fetch that throws at once is swallowed', () => {
    assert.doesNotThrow(() => load({ fetchThrows: true }));
  });
});

describe('upload.js signals the core action', () => {
  function runUpload({ ok }) {
    const events = [];
    const handlers = {};
    const el = (props = {}) => ({
      handlers: {},
      classList: { toggle() {} },
      addEventListener(type, fn) {
        this.handlers[type] = fn;
      },
      ...props,
    });
    const button = el();
    const photoInput = el({ files: [new File([new Uint8Array(10)], 'p.jpg', { type: 'image/jpeg' })] });
    const form = el({ querySelector: (s) => (s.includes('submit') ? button : photoInput), querySelectorAll: () => [] });
    const navigations = [];
    const env = {
      document: {
        getElementById: (id) => ({ 'pet-form': form, 'form-status': el(), 'photo-preview': el() })[id],
        createElement: () => ({ getContext: () => ({ fillRect() {}, drawImage() {} }), toBlob: (cb, type) => cb(new Blob([new Uint8Array(4)], { type })) }),
        dispatchEvent: (event) => events.push(event.type),
      },
      window: { location: { assign: (url) => navigations.push(url) }, addEventListener: (t, fn) => (handlers[t] = fn) },
      URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
      createImageBitmap: async () => ({ width: 10, height: 10 }),
      // The real FormData(form) needs a real form element.
      FormData: class extends FormData {
        constructor() {
          super();
        }
      },
      fetch: async () => (ok ? Response.json({ url: '/p/AAAAAAAAAAAAAAAAAAAAAA' }) : Response.json({ error: 'stuck' }, { status: 502 })),
    };
    new Function(...Object.keys(env), UPLOAD_SCRIPT)(...Object.values(env));
    return {
      events,
      navigations,
      submit: async () => {
        form.handlers.submit({ preventDefault() {} });
        for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
      },
    };
  }

  test('a preview made: "alterpaw:activate" is dispatched before the page moves to it', async () => {
    const ui = runUpload({ ok: true });
    await ui.submit();
    assert.deepEqual(ui.events, ['alterpaw:activate']);
    assert.deepEqual(ui.navigations, ['/p/AAAAAAAAAAAAAAAAAAAAAA']);
  });

  test('a failed generate dispatches nothing', async () => {
    const ui = runUpload({ ok: false });
    await ui.submit();
    assert.deepEqual(ui.events, []);
  });
});
