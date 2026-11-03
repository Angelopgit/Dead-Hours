/**
 * Headless melee grip and swing checks: every melee weapon, held out and through its swing, posed
 * exactly as the game poses it (Humanoid + PlayerWeapon + MeleeGrip), for men and women and bulky
 * builds. Fails when:
 *  - a hand can't close on its grip: the weapon had to turn far off its keyed angle to stay in the
 *    lead fist, or a support hand's fist sits off the handle;
 *  - the forearm couldn't turn far enough to bring the thumb round the handle;
 *  - the weapon passes through the survivor's own head or chest, a wrist does, or an elbow sinks into it;
 *  - the blow lands (MELEE windup) with the striking end anywhere but out in front at a zombie's height.
 * Run with `npm run check:melee` (`-- --verbose` prints every sample, `-- --only katana`).
 */
import * as THREE from 'three';
import { DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, MELEE, type Appearance, type MeleeId, type WeaponId } from '@dead-hours/shared';
import { Humanoid, survivorLook } from '../src/characters/Humanoid';
import { MELEE_PHASES, PlayerWeapon, type HeldState } from '../src/weapons/PlayerWeapon';
import type { WeaponModel } from '../src/weapons/WeaponModels';
import { elbowInChest, type GripResult } from '../src/weapons/MeleeGrip';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
let failures = 0;
let checks = 0;
const check = (cond: boolean, msg: string) => {
  checks++;
  if (cond) { if (verbose) console.log('  ok   ' + msg); }
  else { failures++; console.log('  FAIL ' + msg); }
};

/** Limits. */
const LIMIT = {
  /** Lead hand: the weapon turned this far off its keyed angle to stay in the fist (radians). */
  turn: 0.5,
  /** Support hand: fist this far off its point on the handle (m). */
  support: 0.03,
  /** Thumb left this far from round the handle (radians). */
  roll: 0.35,
  /** Clearance the weapon keeps from the head and chest (m; the grip end near the hands is exempt). */
  clear: 0.02,
  /** Most an elbow sinks into the chest (MeleeGrip.elbowInChest, m). */
  elbow: 0.01,
  /** Where the striking end is when the blow lands: this far out in front at least (m), and between these heights. */
  ahead: 0.45,
  low: 0.75,
  high: 2.0,
};

const BODIES: { name: string; look: Appearance }[] = [
  { name: 'man', look: DEFAULT_APPEARANCE },
  { name: 'woman', look: DEFAULT_FEMALE_APPEARANCE },
  { name: 'broad, work gloves, puffer', look: { ...DEFAULT_APPEARANCE, build: 'broad', gloves: 'work', top: 'puffer' } },
];
const WEAPONS: MeleeId[] = (['machete', 'katana', 'katanas', 'bat', 'hockey', 'crowbar', 'wrench'] as MeleeId[]).filter((id) => !only || id === only);

type Pose = { body: Humanoid; weapon: PlayerWeapon; s: HeldState };
function rig(look: Appearance, id: MeleeId): Pose {
  const body = new Humanoid(survivorLook(look));
  const weapon = new PlayerWeapon(new THREE.Scene(), body);
  const s: HeldState = {
    primary: { id: 'ar' as WeaponId, mag: 30 }, secondary: { id: 'pistol' as WeaponId, mag: 15 },
    active: 'primary', action: 'idle', actionT: 0, actionTotal: 0, meleeId: id, meleeOut: true,
  };
  return { body, weapon, s };
}
const aim = new THREE.Vector3(0, 1.4, 20);
function pose(r: Pose, frames: number): void {
  for (let i = 0; i < frames; i++) {
    r.body.root.position.set(0, 0, 0);
    r.body.root.rotation.y = 0;
    r.body.update(1 / 60, { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 });
    r.weapon.update(1 / 60, r.s, { aim: 0, sprinting: false, aimPoint: aim });
  }
}
function models(r: Pose): WeaponModel[] {
  const w = r.weapon as unknown as { models: Map<WeaponId, WeaponModel> };
  const id = r.s.meleeId as MeleeId;
  const out = [w.models.get(id)!];
  if (id === 'katanas') out.push(w.models.get('katana')!);
  return out;
}

/** Points along a weapon from just past the grip to its striking end (world). */
function along(m: WeaponModel, n = 8): THREE.Vector3[] {
  const tip = m.muzzle;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const u = 0.25 + (0.75 * i) / n;
    pts.push(m.root.localToWorld(new THREE.Vector3(tip.x * u, tip.y * u, tip.z * u)));
  }
  return pts;
}

/** Distance from p to segment ab. */
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = new THREE.Vector3().subVectors(b, a);
  const t = THREE.MathUtils.clamp(new THREE.Vector3().subVectors(p, a).dot(ab) / ab.lengthSq(), 0, 1);
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}
/** How far p is outside the survivor's head and chest (negative: inside). */
function clearance(r: Pose, p: THREE.Vector3): number {
  const head = r.body.head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.1, 0));
  const chestA = r.body.spine.localToWorld(new THREE.Vector3(0, 0.08, 0.0));
  const chestB = r.body.spine.localToWorld(new THREE.Vector3(0, 0.42, 0.0));
  return Math.min(p.distanceTo(head) - 0.12, segDist(p, chestA, chestB) - 0.15);
}

const fmt = (g: GripResult | null) => (g ? `phi ${g.phi.toFixed(2)} dev ${g.dev.toFixed(2)} miss ${g.miss.toFixed(3)} roll ${g.roll.toFixed(2)} short ${g.rollShort.toFixed(2)} err ${g.error.toFixed(3)}` : '-');

for (const id of WEAPONS) {
  const d = MELEE[id];
  console.log(`${id}`);
  const phases = MELEE_PHASES(id);
  const samples: { label: string; p: number | null }[] = [{ label: 'held out', p: null }];
  for (let i = 0; i <= 20; i++) samples.push({ label: `swing ${(i / 20).toFixed(2)}`, p: i / 20 });
  for (const [k, p] of Object.entries(phases)) if (k !== 'ready' && k !== 'end') samples.push({ label: `${k} ${p.toFixed(2)}`, p });
  samples.sort((a, b) => (a.p ?? -1) - (b.p ?? -1));
  for (const b of BODIES) {
    const r = rig(b.look, id);
    pose(r, 60);
    let worstTurn = 0, worstSupport = 0, worstRoll = 0, worstClear = Infinity, worstElbow = 0;
    const worstAt = { turn: '', support: '', roll: '', clear: '', elbow: '' };
    for (const smp of samples) {
      if (smp.p === null) r.s = { ...r.s, action: 'idle', actionT: 0, actionTotal: 0 };
      else r.s = { ...r.s, action: 'melee', meleeWith: 'machete', actionTotal: d.duration, actionT: d.duration * (1 - smp.p) };
      pose(r, smp.p === null ? 30 : 12);
      const g = r.weapon.gripResults;
      if (verbose) console.log(`    ${b.name} ${smp.label}: R ${fmt(g.right)} | L ${fmt(g.left)} | S ${fmt(g.support)}`);
      for (const lead of [g.right, g.left]) {
        if (!lead) continue;
        if (lead.error > worstTurn) { worstTurn = lead.error; worstAt.turn = smp.label; }
        if (lead.rollShort > worstRoll) { worstRoll = lead.rollShort; worstAt.roll = smp.label; }
      }
      if (g.support) {
        if (g.support.error > worstSupport) { worstSupport = g.support.error; worstAt.support = smp.label; }
        if (g.support.rollShort > worstRoll) { worstRoll = g.support.rollShort; worstAt.roll = smp.label + ' (support)'; }
      }
      for (const m of models(r)) {
        for (const p of along(m)) {
          const c = clearance(r, p);
          if (c < worstClear) { worstClear = c; worstAt.clear = smp.label; }
        }
      }
      // Forearms through the chest, elbows buried in it.
      for (const arm of [r.body.armR, r.body.armL]) {
        const wrist = arm.end.getWorldPosition(new THREE.Vector3());
        const c = clearance(r, wrist);
        if (c < worstClear) { worstClear = c; worstAt.clear = smp.label + ' (wrist)'; }
        const elbow = r.body.spine.worldToLocal(arm.lower.getWorldPosition(new THREE.Vector3()));
        const buried = elbowInChest(elbow);
        if (buried > worstElbow) { worstElbow = buried; worstAt.elbow = smp.label; }
      }
    }
    if (!g0(r)) continue;
    check(worstTurn <= LIMIT.turn, `${id} ${b.name}: weapon stays in the lead fist within ${LIMIT.turn} of its keyed angle (worst ${worstTurn.toFixed(2)} at ${worstAt.turn})`);
    check(worstRoll <= LIMIT.roll, `${id} ${b.name}: thumbs come round the handle (worst short ${worstRoll.toFixed(2)} at ${worstAt.roll})`);
    if (MELEE[id].style !== 'blade' && MELEE[id].style !== 'tool' && id !== 'katanas') {
      check(worstSupport <= LIMIT.support, `${id} ${b.name}: support fist on the handle (worst ${(worstSupport * 100).toFixed(1)} cm at ${worstAt.support})`);
    }
    check(worstClear >= LIMIT.clear, `${id} ${b.name}: weapon and wrists clear of head and chest (worst ${(worstClear * 100).toFixed(1)} cm at ${worstAt.clear})`);
    check(worstElbow <= LIMIT.elbow, `${id} ${b.name}: elbows out of the chest (worst ${(worstElbow * 100).toFixed(1)} cm in at ${worstAt.elbow || '-'})`);

    // The blow landing: the striking end out in front at a zombie's height.
    r.s = { ...r.s, action: 'melee', meleeWith: 'machete', actionTotal: d.duration, actionT: d.duration * (1 - phases.hit) };
    pose(r, 12);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(r.body.root.quaternion);
    for (const m of models(r)) {
      if (id === 'katanas' && m !== models(r)[1]) continue;
      const tip = m.root.localToWorld(m.muzzle.clone());
      const ahead = tip.clone().sub(r.body.root.position).dot(fwd);
      check(ahead >= LIMIT.ahead && tip.y >= LIMIT.low && tip.y <= LIMIT.high,
        `${id} ${b.name}: striking end out in front when the blow lands (${ahead.toFixed(2)} m ahead, ${tip.y.toFixed(2)} m up)`);
    }
  }
}
function g0(r: Pose): boolean {
  return !!r.weapon.gripResults;
}

console.log(`\n${checks - failures}/${checks} melee checks passed`);
if (failures) process.exit(1);
