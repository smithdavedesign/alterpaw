// Shared fixtures for the test suite. No network, no keys, no database.
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

export const MB = 1024 * 1024;

export function validCharacter(overrides = {}) {
  return {
    alias: 'Biscuit "The Crumb" Corleone',
    rapSheet: [
      'Grand theft sausage (three counts)',
      'Running an unlicensed tennis-ball ring out of the laundry room',
      'Intimidating the mail carrier, daily, for eleven years',
    ],
    stats: [
      { label: 'Treat Theft', value: 97 },
      { label: 'Menace', value: 88 },
      { label: 'Loyalty', value: 64 },
      { label: 'Nap Power', value: 91 },
      { label: 'Charm', value: 99 },
    ],
    headline: 'LOCAL DOG DENIES ROLE IN SAUSAGE HEIST',
    article:
      'Witnesses report a golden blur near the barbecue moments before six sausages vanished. ' +
      'The suspect, who goes by Biscuit, was later found asleep on the couch, smelling faintly of paprika.',
    bio: 'Biscuit rose from humble puppyhood to run the most feared treat syndicate on Maple Street.',
    ...overrides,
  };
}

// Magic-byte prefixes padded with filler; enough for type sniffing, not real images.
function withPrefix(prefix, size) {
  const bytes = new Uint8Array(size);
  bytes.set(prefix);
  for (let i = prefix.length; i < size; i++) bytes[i] = i % 251;
  return bytes;
}

export const jpegBytes = (size = 2048) => withPrefix([0xff, 0xd8, 0xff, 0xe0], size);
export const pngBytes = (size = 2048) =>
  withPrefix([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size);
export const gifBytes = (size = 2048) => withPrefix([...Buffer.from('GIF89a')], size);
export const webpBytes = (size = 2048) =>
  withPrefix([...Buffer.from('RIFF'), 0x00, 0x10, 0x00, 0x00, ...Buffer.from('WEBP')], size);

// Pass null for a field to leave it out of the form entirely.
export function petForm({
  name = 'Biscuit',
  species = 'dog',
  traits = ['greedy', 'loyal', 'afraid of the vacuum'],
  alterEgo = 'crime boss',
  photo = new File([jpegBytes()], 'biscuit.jpg', { type: 'image/jpeg' }),
} = {}) {
  const form = new FormData();
  if (photo !== null) form.append('photo', photo);
  if (name !== null) form.append('name', name);
  if (species !== null) form.append('species', species);
  for (const trait of traits) form.append('traits', trait);
  if (alterEgo !== null) form.append('alterEgo', alterEgo);
  return form;
}

// A store wrapper that records writes, so "stores nothing" can be asserted.
export class SpyStore extends MemoryStore {
  constructor() {
    super();
    this.creates = 0;
  }
  async createPet(record) {
    this.creates += 1;
    return super.createPet(record);
  }
}

// Builds an app with a fake model. `reply` is the raw model text, or a function of the messages.
// Anything else (now, renderShare, cronSecret…) is passed straight to createApp. Log lines land in `logs`.
export function makeApp({ reply = JSON.stringify(validCharacter()), store = new SpyStore(), ...options } = {}) {
  const calls = [];
  const complete = async (messages) => {
    calls.push(messages);
    return typeof reply === 'function' ? reply(messages) : reply;
  };
  const logs = [];
  const logger = {
    error: (m) => logs.push(`error ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    info: (m) => logs.push(`info ${m}`),
  };
  const app = createApp({ store, complete, logger, ...options });
  return { app, store, calls, logs };
}

// Creates one preview through POST /generate and returns its slug.
export async function createPreview(app, form = petForm()) {
  const { res, body } = await generate(app, form);
  if (res.status !== 200) throw new Error(`generate failed: ${res.status} ${JSON.stringify(body)}`);
  return body.slug;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

// A stored record built directly, for tests that need control over its age.
export function petRecord(overrides = {}) {
  return {
    slug: 'AbCdEfGhIjKlMnOpQrStUv',
    name: 'Biscuit',
    species: 'dog',
    traits: ['greedy', 'loyal', 'afraid of the vacuum'],
    alterEgo: 'crime-boss',
    character: validCharacter(),
    photo: jpegBytes(),
    photoType: 'image/jpeg',
    createdAt: new Date(),
    ...overrides,
  };
}

// POST /report the way the preview page's form does: same-origin, urlencoded, from one client IP.
// Pass null for slug, reason or origin to leave it out.
export function reportForm(app, slug, { ip = '203.0.113.1', reason = 'offensive', origin = 'http://localhost', headers = {} } = {}) {
  const body = new URLSearchParams();
  if (slug !== null) body.set('slug', slug);
  if (reason !== null) body.set('reason', reason);
  return app.request('/report', {
    method: 'POST',
    body,
    headers: { ...(origin !== null ? { origin } : {}), 'x-forwarded-for': ip, accept: 'text/html', ...headers },
  });
}

export async function generate(app, form = petForm()) {
  const res = await app.request('/generate', { method: 'POST', body: form });
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text();
  return { res, body };
}

// Fake credentials are assembled at runtime so secret scanners don't flag the repo.
export const fakeApiKey = () => ['test', 'key', 'A1b2C3d4'.repeat(4)].join('-');
