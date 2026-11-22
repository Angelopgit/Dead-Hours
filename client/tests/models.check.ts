/**
 * Model checks (docs/art-style.md): every held weapon and every body is built as the game builds
 * it, then held against its budget (triangles, draw calls) and, for the guns that exist, against
 * the real one's published length. A rebuilt model must land within 2% of the real thing; the
 * ones still waiting for their rebuild are listed with how far off they are.
 * Run with `npm run check:models`.
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, OUTFIT_KITS, WEAPONS, defaultBuild, type WeaponId } from '@dead-hours/shared';
import { createWeaponModel } from '../src/weapons/WeaponModels';
import { bakeOcclusion, occlusionBakes } from '../src/rendering/Solid';
import { Humanoid, survivorLook, zombieLook } from '../src/characters/Humanoid';

let failures = 0, passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};
const count = (root: THREE.Object3D) => {
  let tris = 0, draws = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    // A hidden mesh is not drawn (survivors' shut lids show only for a blink).
    if (!m.isMesh || !m.visible) return;
    draws++;
    tris += (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3;
  });
  return { tris, draws };
};

/** Budgets, as in docs/art-style.md. */
const BUDGET = {
  gun: { tris: 4500, draws: 5 },
  melee: { tris: 1500, draws: 3 },
  survivor: { tris: 11000, draws: 3 },
  zombie: { tris: 6500, average: 4200, draws: 2 },
};

/**
 * Overall length in millimetres, from the makers' and the services' own figures: M4A1 with the
 * stock out (TM 9-1005-319-10), MP5A2 with the fixed stock (HK operator's manual), Remington 870
 * Police with an 18 inch barrel, Mk 14 Mod 0 EBR (889 mm with the stock run in, held here with it pulled out 90 mm), SIG M17 (TM 9-1005-470-10), M249 (TM 9-1005-201-10),
 * FN SCAR-H with a 16 inch barrel and the stock out, Barrett M107 with a 29 inch barrel (TM 9-1005-239-10), M136 AT4 (TM 9-1315-886-12), Browning M2HB (TM 9-1005-213-10).
 */
const REAL_LENGTH: Partial<Record<WeaponId, number>> = { ar: 838, smg: 680, shotgun: 978, marksman: 979, pistol: 203, lmg: 1041, battle: 965, sniper: 1448, at4: 1016, m2: 1654 };
/** Guns rebuilt from measurements so far: these must match. */
const REBUILT = new Set<WeaponId>(['ar', 'pistol', 'smg', 'shotgun', 'marksman', 'lmg', 'battle', 'sniper', 'at4', 'm2']);

console.log('\nHeld weapons');
for (const id of Object.keys(WEAPONS) as WeaponId[]) {
  if (id === 'akimbo' || id === 'katanas') continue;
  const m = createWeaponModel(id, defaultBuild(id));
  const c = count(m.root);
  const b = WEAPONS[id].slot === 'melee' ? BUDGET.melee : BUDGET.gun;
  check(c.tris <= b.tris && c.draws <= b.draws, `${id}: ${c.tris} triangles, ${c.draws} draw calls (budget ${b.tris}, ${b.draws})`);
  const real = REAL_LENGTH[id];
  if (real) {
    const box = new THREE.Box3().setFromObject(m.root);
    const len = (box.max.z - box.min.z) * 1000;
    const off = ((len - real) / real) * 100;
    const line = `${id}: ${len.toFixed(0)} mm long, the real ${WEAPONS[id].model} is ${real} mm (${off >= 0 ? '+' : ''}${off.toFixed(1)}%)`;
    if (REBUILT.has(id)) check(Math.abs(off) <= 2, line);
    else console.log(`  wait ${line}, not rebuilt yet`);
  }
  m.dispose();
}

// A model's shading bake is most of the work of building it (20 to 35 ms of a rifle's 30 to 45), and the same gun
// is built again and again: in the hands, in a supply case (the frame a drop was called froze for it), on a rack,
// lying about. Each bake is kept by what went in, so only the first build of a model pays for it.
console.log('\nShading bakes are kept');
{
  const colors = (id: WeaponId): number[] => {
    const m = createWeaponModel(id, defaultBuild(id));
    const out: number[] = [];
    m.root.traverse((o) => {
      const c = (o as THREE.Mesh).geometry?.getAttribute('color');
      if (c) for (let i = 0; i < c.array.length; i++) out.push(c.array[i]);
    });
    m.dispose();
    return out;
  };
  const ids = (Object.keys(WEAPONS) as WeaponId[]).filter((id) => id !== 'akimbo' && id !== 'katanas');
  const first = ids.map(colors);
  const run = occlusionBakes.run, kept = occlusionBakes.kept;
  const again = ids.map(colors);
  check(occlusionBakes.run === run && occlusionBakes.kept > kept, `every weapon built again works out no bake (${occlusionBakes.run - run} worked out, ${occlusionBakes.kept - kept} answered from the ones kept)`);
  const differs = ids.filter((_, k) => first[k].length !== again[k].length || first[k].some((v, i) => v !== again[k][i]));
  check(differs.length === 0, `a model built from kept bakes has the same colors, vertex for vertex${differs.length ? ` (not ${differs.join(', ')})` : ''}`);
  // Two facing squares 12 mm apart shade each other; pulled 1 mm further apart they are another bake.
  const squares = (gap: number) => {
    const pos: number[] = [], nor: number[] = [];
    for (const [y, n] of [[0, 1], [gap, -1]]) {
      const quad = n > 0 ? [[0, 0], [0, 0.02], [0.02, 0], [0.02, 0], [0, 0.02], [0.02, 0.02]] : [[0, 0], [0.02, 0], [0, 0.02], [0.02, 0], [0.02, 0.02], [0, 0.02]];
      for (const [x, z] of quad) {
        pos.push(x, y, z);
        nor.push(0, n, 0);
      }
    }
    return [new Float32Array(pos), new Float32Array(nor)] as const;
  };
  const [p1, n1] = squares(0.012);
  const a = bakeOcclusion(p1, n1, 0.02);
  const mark = occlusionBakes.run;
  const [p2, n2] = squares(0.012);
  a[0] = -5;
  const b = bakeOcclusion(p2, n2, 0.02);
  check(occlusionBakes.run === mark && b[0] !== -5 && b.some((v) => v < 1), 'the same shape again is answered from the kept bake, whatever was done to the answer given before');
  const [p3, n3] = squares(0.013);
  bakeOcclusion(p3, n3, 0.02);
  bakeOcclusion(p2, n2, 0.03);
  check(occlusionBakes.run === mark + 2, 'a shape 1 mm different, or the same shape with another reach, is worked out afresh');
}

console.log('\nBodies');
for (const [name, look] of [['man', DEFAULT_APPEARANCE], ['woman', DEFAULT_FEMALE_APPEARANCE]] as const) {
  const c = count(new Humanoid(survivorLook(look)).root);
  check(c.tris <= BUDGET.survivor.tris && c.draws <= BUDGET.survivor.draws, `survivor (${name}): ${c.tris} triangles, ${c.draws} draw calls (budget ${BUDGET.survivor.tris}, ${BUDGET.survivor.draws})`);
}
// Whole outfits pile the most gear on one body: the heaviest still has to fit.
{
  let worst = { name: '', tris: 0, draws: 0 };
  for (const k of OUTFIT_KITS) {
    for (const base of [DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE]) {
      const c = count(new Humanoid(survivorLook({ ...base, ...k.look })).root);
      if (c.tris > worst.tris) worst = { name: `${k.label}, ${base.body === 'female' ? 'woman' : 'man'}`, ...c };
      if (c.draws > BUDGET.survivor.draws) worst = { name: k.label, ...c, tris: Infinity };
    }
  }
  check(worst.tris <= BUDGET.survivor.tris, `outfits: the heaviest of ${OUTFIT_KITS.length} is ${worst.tris} triangles, ${worst.draws} draw calls (${worst.name})`);
}
// Proportions: a real foot is about 15% of a person's height (the shoe a little more).
{
  const bare = new Humanoid(survivorLook({ ...DEFAULT_APPEARANCE, headwear: 'none' }));
  bare.root.updateMatrixWorld(true);
  let top = 0, heel = Infinity, toe = -Infinity;
  bare.root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const p = m.geometry.getAttribute('position'), bone = m.geometry.getAttribute('skinIndex');
    for (let i = 0; i < p.count; i++) {
      top = Math.max(top, p.getY(i));
      // Left shin and foot (bone 8), below the ankle.
      if (bone.getX(i) === 8 && p.getY(i) < 0.06) {
        heel = Math.min(heel, p.getZ(i));
        toe = Math.max(toe, p.getZ(i));
      }
    }
  });
  const ratio = (toe - heel) / top;
  check(ratio > 0.145 && ratio < 0.165, `survivor: shoe ${((toe - heel) * 100).toFixed(1)} cm on a ${(top * 100).toFixed(0)} cm body, ${(ratio * 100).toFixed(1)}% of the height (a real one is 15 to 16%)`);
}
// Every triangle of a body is one flat plane with its own three corners (docs/art-style.md), whatever its parts were
// built from. The torso and pelvis used to be welded for smooth normals first, which the part sink took apart again
// and threw away with the normals and texture coordinates it had carried along: a fifth of the 35 ms a new look
// takes to build (a raider's, as each gets out of the van; every zombie look behind the loading card).
{
  let bad = '';
  let tris = 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), face = new THREE.Vector3(), n = new THREE.Vector3();
  for (const [name, look] of [['man', survivorLook(DEFAULT_APPEARANCE)], ['woman', survivorLook(DEFAULT_FEMALE_APPEARANCE)], ['walker', zombieLook(3)]] as const) {
    const g = new Humanoid(look).mesh.geometry;
    const p = g.getAttribute('position'), nor = g.getAttribute('normal');
    if (g.index || p.count % 3 || g.getAttribute('uv')) {
      bad ||= `${name}: corners are shared, or texture coordinates are carried along`;
      continue;
    }
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(p, i + 1);
      c.fromBufferAttribute(p, i + 2);
      face.subVectors(c, b).cross(n.subVectors(a, b));
      // A sliver has no direction to speak of.
      if (face.length() < 1e-9) continue;
      face.normalize();
      tris++;
      for (let k = 0; k < 3; k++) {
        if (Math.abs(n.fromBufferAttribute(nor, i + k).dot(face)) < 0.999) bad ||= `${name}: triangle ${i / 3} is not flat (corner ${k} leans ${(Math.acos(Math.min(1, Math.abs(n.dot(face)))) * 180 / Math.PI).toFixed(1)} degrees off its face)`;
      }
    }
  }
  if (/mergeVertices/.test(readFileSync(new URL('../src/characters/Outfit.ts', import.meta.url), 'utf8'))) bad ||= 'Outfit.ts welds corners again (the part sink only takes them apart)';
  if (!/g\.deleteAttribute\('uv'\);\s*g\.deleteAttribute\('normal'\);\s*const geo = g\.index \? g\.toNonIndexed\(\) : g;/.test(readFileSync(new URL('../src/characters/Humanoid.ts', import.meta.url), 'utf8'))) {
    bad ||= 'the part sink takes normals and texture coordinates apart before dropping them';
  }
  check(!bad, bad || `bodies: all ${tris} triangles of a man, a woman and a walker are flat, with nothing welded or carried along to get there`);
}
let sum = 0, worst = 0, draws = 0;
const LOOKS = 30;
for (let i = 0; i < LOOKS; i++) {
  const c = count(new Humanoid(zombieLook(i)).root);
  sum += c.tris;
  worst = Math.max(worst, c.tris);
  draws = Math.max(draws, c.draws);
}
check(sum / LOOKS <= BUDGET.zombie.average, `walkers: ${(sum / LOOKS).toFixed(0)} triangles on average over ${LOOKS} looks (budget ${BUDGET.zombie.average}): ${(sum / LOOKS * 90 / 1000).toFixed(0)}k for a full street of 90`);
check(worst <= BUDGET.zombie.tris && draws <= BUDGET.zombie.draws, `walkers: the heaviest look is ${worst} triangles, ${draws} draw calls (budget ${BUDGET.zombie.tris}, ${BUDGET.zombie.draws})`);

console.log(failures ? `\n${failures} of ${passes + failures} model checks failed` : `\nall ${passes} model checks passed`);
process.exit(failures ? 1 : 0);
