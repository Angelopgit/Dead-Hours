/**
 * Model checks (docs/art-style.md): every held weapon and every body is built as the game builds
 * it, then held against its budget (triangles, draw calls) and, for the guns that exist, against
 * the real one's published length. A rebuilt model must land within 2% of the real thing; the
 * ones still waiting for their rebuild are listed with how far off they are.
 * Run with `npm run check:models`.
 */
import * as THREE from 'three';
import { DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, WEAPONS, defaultBuild, type WeaponId } from '@dead-hours/shared';
import { createWeaponModel } from '../src/weapons/WeaponModels';
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

console.log('\nBodies');
for (const [name, look] of [['man', DEFAULT_APPEARANCE], ['woman', DEFAULT_FEMALE_APPEARANCE]] as const) {
  const c = count(new Humanoid(survivorLook(look)).root);
  check(c.tris <= BUDGET.survivor.tris && c.draws <= BUDGET.survivor.draws, `survivor (${name}): ${c.tris} triangles, ${c.draws} draw calls (budget ${BUDGET.survivor.tris}, ${BUDGET.survivor.draws})`);
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
