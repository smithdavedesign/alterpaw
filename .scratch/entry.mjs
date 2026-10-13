import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const a = () => readFile(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
export const b = () => readFile(new URL('../node_modules/@fontsource/rye/files/rye-latin-400-normal.woff', import.meta.url));
export const c = () => readFile(require.resolve('@fontsource/roboto-slab/files/roboto-slab-latin-700-normal.woff'));
