// `npm run cf:build`: draws the site's 1200×630 link-preview image (Open Graph and Twitter cards) at build time,
// with the app's own renderer (renderOgPng in src/share.js: fixed text and shapes, no photo, nothing copied from
// the web), into assets/og.png. The Worker bundles that file and the Node entry reads it, so no request ever
// draws it. The output is deterministic and the file is committed, so a deploy that skips this step still has it;
// test/launch.test.js fails if the committed file no longer matches the drawing code.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderOgPng } from '../src/share.js';
import { OG_IMAGE } from '../src/site.js';

const png = await renderOgPng();
await mkdir(new URL('.', OG_IMAGE.file), { recursive: true });
await writeFile(OG_IMAGE.file, png);
console.log(`drew ${fileURLToPath(OG_IMAGE.file)}: ${OG_IMAGE.width}×${OG_IMAGE.height}, ${png.length} bytes`);
