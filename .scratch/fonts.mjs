import satori from 'satori';
import { readFileSync } from 'node:fs';
const f = (s, w, name = 'Slab') => ({ name, data: readFileSync(`node_modules/@fontsource/roboto-slab/files/roboto-slab-${s}-${w}-normal.woff`), weight: w, style: 'normal' });
const tree = (t) => ({ type: 'div', props: { style: { display: 'flex', fontFamily: 'Slab', fontSize: 40, width: 600, height: 80 }, children: t } });
const sets = [
  ['latin only', [f('latin', 400)]],
  ['cyrillic only', [f('cyrillic', 400)]],
  ['latin, cyr (same name)', [f('latin', 400), f('cyrillic', 400)]],
  ['latin, cyr (other name)', [f('latin', 400), f('cyrillic', 400, 'SlabCyr')]],
];
for (const [label, fonts] of sets) {
  for (const t of ['Б', 'Барсик', 'A', '猫']) {
    const svg = await satori(tree(t), { width: 600, height: 80, fonts });
    const d = [...svg.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]).join('');
    console.log(label.padEnd(26), t.padEnd(8), d.length, d.slice(0, 60));
  }
}
