// Validation of the forms. The upload form's runs before the model is called, so bad input never spends model
// quota; the gift and print forms' (M4) before anything is stored or charged.
import { SPECIES, findAlterEgo } from './character.js';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// Room for the text fields and multipart boundaries on top of the photo.
export const MAX_BODY_BYTES = MAX_PHOTO_BYTES + 64 * 1024;
export const MAX_NAME_LENGTH = 30;
export const MAX_TRAIT_LENGTH = 40;
export const MAX_TRAITS = 3;

export const PHOTO_TOO_BIG = 'Photo must be 10 MB or smaller.';
export const PHOTO_NOT_IMAGE = 'Photo must be a JPEG, PNG, WebP or GIF image.';

// `fields` (shipping address only) maps each bad field to what's wrong with it.
export class InputError extends Error {
  constructor(message, { fields } = {}) {
    super(message);
    this.name = 'InputError';
    if (fields) this.fields = fields;
  }
}

const startsWith = (bytes, signature, offset = 0) => signature.every((b, i) => bytes[offset + i] === b);
const ascii = (text) => [...text].map((ch) => ch.charCodeAt(0));

// The photo's type comes from its first bytes, never from the client's filename or declared type.
// SVG (scriptable) and everything else is refused.
export function sniffImageType(bytes) {
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (bytes.length >= 6 && (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a')))) return 'image/gif';
  if (bytes.length >= 12 && startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return null;
}

// Strip control characters and collapse runs of whitespace.
function clean(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function parsePetForm(form) {
  const name = clean(form.get('name'));
  if (!name) throw new InputError("Please enter your pet's name.");
  if (name.length > MAX_NAME_LENGTH) throw new InputError(`Pet name must be ${MAX_NAME_LENGTH} characters or fewer.`);

  const species = clean(form.get('species')).toLowerCase();
  if (!SPECIES.includes(species)) throw new InputError(`Species must be one of: ${SPECIES.join(', ')}.`);

  const traits = form.getAll('traits').map(clean).filter(Boolean);
  if (traits.length === 0) throw new InputError('Please give at least one trait.');
  if (traits.length > MAX_TRAITS) throw new InputError(`Please give at most ${MAX_TRAITS} traits.`);
  if (traits.some((t) => t.length > MAX_TRAIT_LENGTH)) {
    throw new InputError(`Each trait must be ${MAX_TRAIT_LENGTH} characters or fewer.`);
  }

  const ego = findAlterEgo(form.get('alterEgo'));
  if (!ego) throw new InputError('Please pick an alter ego.');

  const file = form.get('photo');
  if (!file || typeof file === 'string') throw new InputError('Please choose a photo of your pet.');
  if (file.size === 0) throw new InputError('The photo is empty. Please choose another.');
  if (file.size > MAX_PHOTO_BYTES) throw new InputError(PHOTO_TOO_BIG);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) throw new InputError(PHOTO_NOT_IMAGE);

  return {
    pet: { name, species, traits, alterEgo: ego.id },
    photo: { bytes, type },
  };
}

// ---- M4: the gift form ---------------------------------------------------------------------------------------

export const MAX_GIFT_NAME_LENGTH = 40;
export const MAX_GIFT_MESSAGE_LENGTH = 300;
const MAX_EMAIL_LENGTH = 254;
// One plain address: no display name, no list, a dotted domain with a letter TLD. Brevo checks it again.
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ZONE_NAME = /^[A-Za-z0-9_+\-/]{1,64}$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// An IANA time zone name this runtime knows ("America/New_York", "UTC").
export function isTimeZone(value) {
  if (typeof value !== 'string' || !ZONE_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const zoneFormats = new Map();
function partsIn(instant, timeZone) {
  if (!zoneFormats.has(timeZone)) {
    zoneFormats.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    );
  }
  return Object.fromEntries(zoneFormats.get(timeZone).formatToParts(instant).map((p) => [p.type, p.value]));
}

// The calendar date ("2026-10-20") at `instant` in `timeZone`.
export function dateIn(instant, timeZone) {
  const p = partsIn(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

// How far `timeZone`'s wall clock is ahead of UTC at `instant` (ms since the epoch), in ms.
function offsetAt(instant, timeZone) {
  const p = partsIn(new Date(instant), timeZone);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(instant / 1000) * 1000;
}

function isRealDate(value) {
  const match = typeof value === 'string' && value.match(DATE_PATTERN);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2100 && day.getUTCFullYear() === y && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

// The first instant of `date` ("YYYY-MM-DD") in `timeZone`: local midnight, or where the clocks jump over
// midnight (Chile's DST start) the first time that exists. null if the zone skipped the whole day.
// Local midnight is UTC midnight minus the zone's offset, so each offset the zone has around that day gives a
// candidate; the start is the earliest one whose local date is `date` while the millisecond before is the day
// before. Odd transitions that no candidate hits fall back to a search for the first instant of the date.
export function startOfDayIn(date, timeZone) {
  if (!isRealDate(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  const localDate = (t) => dateIn(new Date(t), timeZone);
  const candidates = [...new Set([-DAY_MS, 0, DAY_MS].map((shift) => midnightUtc - offsetAt(midnightUtc + shift, timeZone)))].sort((a, b) => a - b);
  const exact = candidates.find((t) => localDate(t) === date && localDate(t - 1) < date);
  if (exact !== undefined) return new Date(exact);
  let before = candidates[0] - 3 * HOUR_MS;
  let within = candidates.at(-1) + 3 * HOUR_MS;
  if (!(localDate(before) < date && localDate(within) >= date)) return null;
  while (within - before > 1) {
    const middle = Math.floor((before + within) / 2);
    if (localDate(middle) >= date) within = middle;
    else before = middle;
  }
  return localDate(within) === date ? new Date(within) : null;
}

const longDate = (date) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// The gift form → { details, deliverAt }. `now` decides "today" (in the chosen zone); `latest` is the last
// instant a gift may be due (app.js: about a week before the photo is deleted). No zone (an API client) is UTC.
export function parseGiftForm(input, { now, latest }) {
  const recipientEmail = clean(input.recipientEmail).toLowerCase();
  if (!recipientEmail) throw new InputError("Please enter the recipient's email address.");
  if (recipientEmail.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(recipientEmail)) {
    throw new InputError("That doesn't look like one email address. Please check it.");
  }
  const recipientName = clean(input.recipientName);
  if (recipientName.length > MAX_GIFT_NAME_LENGTH) throw new InputError(`The recipient's name must be ${MAX_GIFT_NAME_LENGTH} characters or fewer.`);
  const fromName = clean(input.fromName);
  if (!fromName) throw new InputError('Please enter your name, so they know who it is from.');
  if (fromName.length > MAX_GIFT_NAME_LENGTH) throw new InputError(`Your name must be ${MAX_GIFT_NAME_LENGTH} characters or fewer.`);
  const message = clean(input.message);
  if (message.length > MAX_GIFT_MESSAGE_LENGTH) throw new InputError(`The message must be ${MAX_GIFT_MESSAGE_LENGTH} characters or fewer.`);

  const timeZone = input.timeZone === undefined || input.timeZone === '' ? 'UTC' : input.timeZone;
  if (!isTimeZone(timeZone)) throw new InputError('Please pick a time zone from the list.');
  const deliverOn = typeof input.deliverOn === 'string' ? input.deliverOn.trim() : '';
  if (!isRealDate(deliverOn)) throw new InputError('Please pick a delivery date.');
  if (deliverOn < dateIn(now, timeZone)) throw new InputError('That delivery date is in the past. Please pick today or later.');
  const last = dateIn(latest, timeZone);
  if (deliverOn > last) {
    throw new InputError(`The latest delivery date is ${longDate(last)}: the recipient needs about a week to download the bundle before the photo is deleted.`);
  }
  const deliverAt = startOfDayIn(deliverOn, timeZone);
  if (!deliverAt) throw new InputError("That date doesn't exist in that time zone. Please pick another.");
  return { details: { recipientName, recipientEmail, fromName, message, deliverOn, timeZone }, deliverAt };
}

// ---- M4: the shipping address for a printed poster (US only) ---------------------------------------------------

export const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'],
  ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'],
  ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
  ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
].map(([code, name]) => ({ code, name }));
const STATE_CODES = new Set(US_STATES.map((s) => s.code));
const ZIP_PATTERN = /^\d{5}(?:-\d{4})?$/;
const ADDRESS_FIELDS = [
  { key: 'name', label: 'Name', max: 60, missing: "Please enter the recipient's name." },
  { key: 'line1', label: 'Street address', max: 100, missing: 'Please enter the street address.' },
  { key: 'line2', label: 'The second address line', max: 100 },
  { key: 'city', label: 'City', max: 60, missing: 'Please enter the city.' },
];

// The print form → { name, line1, line2, city, state, zip, country: 'US' }, or an InputError whose `fields`
// names every missing or invalid field at once.
export function parseShippingAddress(input) {
  const address = {};
  const fields = {};
  for (const { key, label, max, missing } of ADDRESS_FIELDS) {
    address[key] = clean(input[key]);
    if (missing && !address[key]) fields[key] = missing;
    else if (address[key].length > max) fields[key] = `${label} must be ${max} characters or fewer.`;
  }
  address.state = clean(input.state).toUpperCase();
  if (!address.state) fields.state = 'Please pick the state.';
  else if (!STATE_CODES.has(address.state)) fields.state = 'Please pick a US state.';
  address.zip = clean(input.zip);
  if (!address.zip) fields.zip = 'Please enter the ZIP code.';
  else if (!ZIP_PATTERN.test(address.zip)) fields.zip = 'Please enter a 5-digit ZIP code (or ZIP+4).';
  const country = clean(input.country).toUpperCase();
  if (country && country !== 'US') fields.country = 'Printed posters ship to US addresses only.';
  address.country = 'US';
  const problems = Object.values(fields);
  if (problems.length) throw new InputError(`Please check the shipping address. ${problems.join(' ')}`, { fields });
  return address;
}
