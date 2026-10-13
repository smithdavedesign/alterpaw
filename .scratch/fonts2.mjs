import satori from 'satori';
import { readFileSync } from 'node:fs';
const f = (s, w, name) => ({ name, data: readFileSync(`node_modules/@fontsource/roboto-slab/files/roboto-slab-${s}-${w}-normal.woff`), weight: w, style: 'normal' });
const fonts = [f('latin', 400, 'Slab'), f('cyrillic', 400, 'SlabCyr')];
const tree = (t) => ({ type: 'div', props: { style: { display: 'flex', fontFamily: 'Slab', fontSize: 40, width: 600, height: 80 }, children: t } });
const calls = [];
for (const [label, opts] of [
  ['default', {}],
  ['asset → [] / ""', { loadAdditionalAsset: async (code, seg) => (calls.push([code, seg]), code === 'emoji' ? '' : []) }],
]) {
  for (const t of ['A🐶B', 'A猫B', 'AБB']) {
    try {
      const svg = await satori(tree(t), { width: 600, height: 80, fonts, ...opts });
      const d = [...svg.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]).join('');
      console.log(label.padEnd(18), t.padEnd(6), d.length, svg.includes('<image') ? 'IMAGE' : '');
    } catch (err) {
      console.log(label, t, 'ERR', err.message);
    }
  }
}
console.log(calls);
