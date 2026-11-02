/**
 * Tree models (npm run check:trees): every model and level of detail is well formed and inside its
 * triangle budget, the middle level is much lighter than the near one, wind weights are sane, the
 * trunks fit the trunk colliders players and zombies bump into, leaves stay above head height
 * under the maples, the tree shaders still recognise three's light chunk, and the map's trees,
 * pines and shrubs all get a model.
 */
import * as THREE from 'three';
import { MAPLE_HOLLOW, propHalfExtents } from '@dead-hours/shared';
import { broadleaf, bush, pine, pineOutlineHalf, type TreeModel } from '../src/environment/trees/TreeGen';
import { TREE_VERTEX_LIGHTS } from '../src/environment/trees/TreeMaterials';

let failed = 0;
const ok = (msg: string) => console.log(`  ok  ${msg}`);
const fail = (msg: string) => {
  failed++;
  console.log(`  FAIL ${msg}`);
};
const check = (cond: boolean, msg: string) => (cond ? ok(msg) : fail(msg));

const tris = (g: THREE.BufferGeometry | null) => (g ? g.index!.count / 3 : 0);
/** Triangle budgets per model (near, middle). */
const BUDGET: Record<TreeModel['species'], [number, number]> = { broadleaf: [4200, 1100], pine: [4200, 1100], bush: [140, 60] };

const models: [string, TreeModel][] = [
  ...[0, 1, 2].map((v) => [`maple ${v}`, broadleaf(v)] as [string, TreeModel]),
  ...[0, 1, 2].map((v) => [`pine ${v}`, pine(v)] as [string, TreeModel]),
  ...[0, 1].map((v) => [`shrub ${v}`, bush(v)] as [string, TreeModel]),
];

console.log('Models');
for (const [name, m] of models) {
  const [near, mid] = m.lods.map((p) => tris(p.bark) + tris(p.leaves));
  const [bn, bm] = BUDGET[m.species];
  check(near > 0 && near <= bn, `${name}: ${near} triangles near (budget ${bn})`);
  const lighter = m.species === 'bush' ? near : near * 0.5;
  check(mid > 0 && mid <= bm && mid < lighter, `${name}: ${mid} triangles in the middle distance (budget ${bm}, under ${m.species === 'bush' ? 'the near model' : 'half of near'})`);
  let bad = 0, maxSway = 0, lowLeaf = Infinity, trunkR = 0;
  for (const parts of m.lods) {
    for (const [g, leaf] of [[parts.bark, false], [parts.leaves, true]] as const) {
      if (!g) continue;
      const pos = g.getAttribute('position'), nor = g.getAttribute('normal'), wind = g.getAttribute('aWind'), uv = g.getAttribute('uv'), col = g.getAttribute('color');
      for (const a of [pos, nor, wind, uv, col]) if (!a || a.count !== pos.count) bad++;
      for (let i = 0; i < pos.count; i++) {
        const vals = [pos.getX(i), pos.getY(i), pos.getZ(i), wind.getX(i), wind.getY(i), wind.getZ(i), wind.getW(i), uv.getX(i), uv.getY(i)];
        if (vals.some((v) => !Number.isFinite(v))) bad++;
        const nl = Math.hypot(nor.getX(i), nor.getY(i), nor.getZ(i));
        if (Math.abs(nl - 1) > 0.02) bad++;
        maxSway = Math.max(maxSway, wind.getX(i), wind.getW(i));
        if (leaf) lowLeaf = Math.min(lowLeaf, pos.getY(i));
        else if (pos.getY(i) > 0.4 && pos.getY(i) < 1.0 && Math.hypot(pos.getX(i), pos.getZ(i)) < 0.6) trunkR = Math.max(trunkR, Math.hypot(pos.getX(i), pos.getZ(i)));
      }
      const idx = g.index!;
      for (let i = 0; i < idx.count; i++) if (idx.getX(i) >= pos.count) bad++;
    }
  }
  check(bad === 0, `${name}: attributes complete, finite, unit normals, indices in range`);
  check(maxSway <= 1.25, `${name}: wind weights within 0..1.2 (max ${maxSway.toFixed(2)})`);
  if (m.species === 'broadleaf') check(lowLeaf > 2.0, `${name}: lowest leaves at ${lowLeaf.toFixed(2)} m (above head height)`);
  if (m.species !== 'bush') {
    // The trunk collider is a 0.3 m half-width box; the trunk must not stick out of it at chest height.
    const half = propHalfExtents(m.species === 'pine' ? 'pine' : 'tree')[0];
    check(trunkR > 0.1 && trunkR <= half + 0.05, `${name}: trunk radius ${trunkR.toFixed(2)} m below 1 m fits the ${half} m collider`);
  }
  check(m.height > 0 && m.radius > 0 && m.probeLow < m.probeHigh && m.probeHigh < m.height, `${name}: ${m.height.toFixed(1)} m tall, ${m.radius.toFixed(1)} m reach, probes inside`);
  if (m.species === 'pine') {
    // The impostor billboard spans 2 x radius by height + 0.2 m; its tapered outline must hold the tree from every side.
    let worst = -Infinity;
    for (const g of [m.lods[0].bark, m.lods[0].leaves]) {
      const pos = g!.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        const over = Math.hypot(pos.getX(i), pos.getZ(i)) / (2 * m.radius) - pineOutlineHalf(pos.getY(i) / (m.height + 0.2));
        worst = Math.max(worst, over);
      }
    }
    check(worst <= 0.01, `${name}: inside the tapered impostor outline (margin ${(-worst * 100).toFixed(1)}% of the width)`);
  }
}

console.log('Shaders');
// three's light chunk still has the point/spot loops where the tree patch cuts them out.
check(TREE_VERTEX_LIGHTS, 'point and spot lights move to the vertex shader on trees (three light chunk recognised)');

console.log('Map');
const kinds = new Map<string, number>();
for (const p of MAPLE_HOLLOW.props) if (p.kind === 'tree' || p.kind === 'pine' || p.kind === 'bush') kinds.set(p.kind, (kinds.get(p.kind) ?? 0) + 1);
check((kinds.get('tree') ?? 0) > 0 && (kinds.get('pine') ?? 0) > 500 && (kinds.get('bush') ?? 0) > 0, `trees ${kinds.get('tree')}, pines ${kinds.get('pine')} (woods included), shrubs ${kinds.get('bush')}`);

if (failed) {
  console.log(`\n${failed} tree check(s) failed`);
  process.exit(1);
}
console.log('\nAll tree checks passed');
