import { nodeFileTrace } from '@vercel/nft';
const { fileList, warnings, reasons } = await nodeFileTrace([process.argv[2]], { base: process.cwd() });
const files = [...fileList].filter((f) => /\.(wasm|woff|ttf)$/.test(f) || f.startsWith('src/'));
console.log(files.join('\n'));
console.log('warnings', [...warnings].map((w) => w.message).slice(0, 5));
