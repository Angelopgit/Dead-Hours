/**
 * Fits melee swing keys (PlayerWeapon, MeleeGrip.ArmPose) to where a key should put the
 * weapon: for each target, the arm pose whose fist lands on `P` with the weapon pointing along `D`
 * (and its edge, -Y, along `E`; the right elbow near `El`), spine space (+X the survivor's left, +Y
 * up, +Z ahead), keeping the forearm's turn and the wrist near neutral and the elbow out of the
 * chest. A pose the hand can't make shows as a large dirErr: move the target, don't force it.
 * Prints each fit as a key to paste. `npx tsx client/tests/melee-fit.ts client/tests/melee-targets.json`
 * (style names katana and dual fit for the sword grip, the rest the hammer grip).
 */
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { GRIP, armPose, elbowInChest, type ArmPose } from '../src/weapons/MeleeGrip';

type Target = { name: string; P: number[]; D: number[]; E?: number[]; El?: number[] };
const TARGETS: Record<string, Target[]> = JSON.parse(readFileSync(process.argv[2] ?? 'client/tests/melee-targets.json', 'utf8'));
const LIM = { reach: [0.4, 0.97], elbow: [-0.7, 1.7], turn: [-1.2, 1.3], dev: [-0.15, 0.46], flex: [-0.8, 0.8] };
let tilt = GRIP.tilt;
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

function pose(k: ArmPose) {
  const at = new THREE.Vector3(), q = new THREE.Quaternion(), elbow = new THREE.Vector3();
  armPose({ ...k, tilt }, -1, at, q, elbow);
  return { at, q, elbow, dir: new THREE.Vector3(0, 0, 1).applyQuaternion(q), edge: new THREE.Vector3(0, -1, 0).applyQuaternion(q) };
}
function cost(k: ArmPose, t: Target): number {
  const r = pose(k);
  let c = 5 * r.at.distanceTo(v3(t.P)) + r.dir.angleTo(v3(t.D).normalize());
  if (t.E) c += 0.5 * r.edge.angleTo(v3(t.E).normalize());
  if (t.El) c += 2 * r.elbow.distanceTo(v3(t.El));
  c += 6 * elbowInChest(r.elbow);
  return c + 0.06 * Math.abs(k.turn) + 0.06 * Math.abs((k.dev ?? 0) - 0.15) + 0.03 * Math.abs(k.flex ?? 0) + 0.02 * Math.abs(k.elbow - 0.5);
}
const clamp = (v: number, [a, b]: number[]) => Math.min(b, Math.max(a, v));
function randomPose(t: Target): ArmPose {
  const toFist = v3(t.P).sub(new THREE.Vector3(-0.22, 0.48, 0));
  return {
    arm: [toFist.x + (rnd() - 0.5) * 0.4, toFist.y + (rnd() - 0.5) * 0.4, toFist.z + (rnd() - 0.5) * 0.4],
    reach: 0.4 + rnd() * 0.57, elbow: -0.7 + rnd() * 2.4, turn: -1.2 + rnd() * 2.5, dev: -0.15 + rnd() * 0.6, flex: -0.8 + rnd() * 1.6,
  };
}
function jitter(k: ArmPose, s: number): ArmPose {
  return {
    arm: k.arm.map((v) => v + (rnd() - 0.5) * s) as [number, number, number],
    reach: clamp(k.reach + (rnd() - 0.5) * s * 0.5, LIM.reach), elbow: clamp(k.elbow + (rnd() - 0.5) * s * 2, LIM.elbow),
    turn: clamp(k.turn + (rnd() - 0.5) * s * 2, LIM.turn), dev: clamp((k.dev ?? 0) + (rnd() - 0.5) * s, LIM.dev),
    flex: clamp((k.flex ?? 0) + (rnd() - 0.5) * s * 2, LIM.flex),
  };
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const deg = (a: number) => THREE.MathUtils.radToDeg(a).toFixed(0);
for (const [style, list] of Object.entries(TARGETS)) {
  tilt = style === 'katana' || style === 'dual' ? GRIP.swordTilt : GRIP.tilt;
  console.log(style);
  for (const t of list) {
    // A wide random look, then narrowing jitter round the best.
    let best: ArmPose = { arm: [0, -1, 0.5], reach: 0.8, elbow: 0.5, turn: 0, dev: 0.15, flex: 0 }, bc = cost(best, t);
    for (let i = 0; i < 4000; i++) { const k = randomPose(t); const c = cost(k, t); if (c < bc) { bc = c; best = k; } }
    for (let s = 0.3; s > 0.005; s *= 0.93) for (let i = 0; i < 120; i++) { const k = jitter(best, s); const c = cost(k, t); if (c < bc) { bc = c; best = k; } }
    const r = pose(best);
    const n = Math.hypot(...best.arm);
    console.log(`  ${t.name.padEnd(8)} cost ${bc.toFixed(3)} fist ${r.at.toArray().map(r2)} dirErr ${deg(r.dir.angleTo(v3(t.D).normalize()))}° edgeErr ${t.E ? deg(r.edge.angleTo(v3(t.E).normalize())) + '°' : '-'} elbow ${r.elbow.toArray().map(r2)}`);
    console.log(`    arm: [${best.arm.map((v) => r2(v / n)).join(', ')}], reach: ${r2(best.reach)}, elbow: ${r2(best.elbow)}, turn: ${r2(best.turn)}, flex: ${r2(best.flex ?? 0)}, dev: ${r2(best.dev ?? 0)},`);
  }
}
