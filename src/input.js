// Validation of the upload form. Runs before the model is called, so bad input never spends model quota.
import { SPECIES, findAlterEgo } from './character.js';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
// Room for the text fields and multipart boundaries on top of the photo.
export const MAX_BODY_BYTES = MAX_PHOTO_BYTES + 64 * 1024;
export const MAX_NAME_LENGTH = 30;
export const MAX_TRAIT_LENGTH = 40;
export const MAX_TRAITS = 3;

export const PHOTO_TOO_BIG = 'Photo must be 10 MB or smaller.';
export const PHOTO_NOT_IMAGE = 'Photo must be a JPEG, PNG, WebP or GIF image.';

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
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
