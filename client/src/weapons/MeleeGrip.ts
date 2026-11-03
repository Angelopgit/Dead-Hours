import * as THREE from 'three';
import type { Humanoid, Limb } from '../characters/Humanoid';
import { ARM, SHOULDER_X } from '../characters/Outfit';

/**
 * How a hand closes on a melee weapon's handle. The rig has no wrist joint: the hand is part of the
 * forearm, so a handle only looks held when it runs through the fist at the angle a fist holds one.
 * Frames below are the lower arm's own (the right arm; the left mirrors x): the bone runs down its
 * -Y past the wrist (Limb.end) into the hand, the thumb is on +Z and the right palm faces +X.
 *
 * Melee models put their origin on the lead hand's grip with +Z toward the striking end and +Y the
 * back of the edge (WeaponModels). Held, the handle crosses the fist along the thumb axis, raked
 * toward the fingers by `tilt` (as a pistol grip is), and an edge faces the knuckles.
 */
export const GRIP = {
  /** Where the handle runs through the closed fingers, from the wrist (right hand). */
  fist: new THREE.Vector3(0.028, -0.082, 0.004),
  /**
   * The handle's rake in the fist toward the fingers (radians): a hammer grip's, the handle across
   * the fingers (a club, a tool, a machete), and a sword grip's, the hilt lying diagonally across
   * the palm from the forefinger's root to its heel so the blade runs on nearer the forearm's line.
   */
  tilt: 0.38,
  swordTilt: 0.75,
  /** How far the wrist tips the handle further toward the little finger, or back toward the thumb. */
  ulnar: 0.48,
  radial: 0.18,
  /**
   * Wrist flexion and extension turn the fist about the handle itself, so they never show at the
   * grip: the lead hand may use this much either way to keep the elbow somewhere natural.
   */
  flex: 1.05,
  /** A support hand closes anywhere round the handle within this of the lead hand's line. */
  wrap: 1.7,
  /** Most the forearm turns about itself to bring the thumb round (half of it in the upper arm). */
  roll: 1.6,
  /** Most the weapon is bent off the fist at the wrist to come closer to the keyed angle. */
  slack: 0.16,
};

/** What a hand's solve came to (checks and tuning). */
export interface GripResult {
  /** The hand turned about the handle (flexion), and the wrist's tip of it (deviation), radians. */
  phi: number;
  dev: number;
  /** How far from a reachable arm the best hold was (m): 0 when the keyed pose can be held exactly. */
  miss: number;
  /** Forearm roll used, and what it fell short of bringing the thumb round (radians). */
  roll: number;
  rollShort: number;
  /** The weapon's turn away from its keyed angle (lead hand) or the fist's distance off its grip point (support, m). */
  error: number;
}

const _W = new THREE.Vector3(), _E = new THREE.Vector3(), _S = new THREE.Vector3();
const _f = new THREE.Vector3(), _t = new THREE.Vector3(), _u = new THREE.Vector3(), _v = new THREE.Vector3();
const _H = new THREE.Quaternion(), _Hb = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _q5 = new THREE.Quaternion();
const _X = new THREE.Vector3(1, 0, 0), _Y = new THREE.Vector3(0, 1, 0), _Z = new THREE.Vector3(0, 0, 1), _fs = new THREE.Vector3();
const _G2 = new THREE.Vector3(), _n = new THREE.Vector3(), _eb = new THREE.Vector3(), _inv = new THREE.Matrix4();

/**
 * How far an elbow (spine space) is buried in the chest, which it can't pass into: the torso taken
 * as an upright column round the spine, the elbow joint's own thickness included (m, 0 when clear).
 */
export function elbowInChest(e: THREE.Vector3): number {
  if (e.y < -0.12 || e.y > 0.5) return 0;
  return Math.max(0, CHEST_R - Math.hypot(e.x, e.z));
}
const CHEST_R = 0.15;
/** The wrist tips a full search tries (and a narrow one's, filled in). */
const DEVS = [-GRIP.radial, -GRIP.radial / 2, 0, GRIP.ulnar / 3, (GRIP.ulnar * 2) / 3, GRIP.ulnar];
const _devs = [0, 0, 0];
const fistOf = (side: 1 | -1, out: THREE.Vector3) => out.set(-side * GRIP.fist.x, GRIP.fist.y, GRIP.fist.z);

/** The hand's frame holding a weapon turned `q`, closed round it at `phi` with the wrist tipped by `dev`. */
function handFrame(q: THREE.Quaternion, phi: number, dev: number, tilt: number, out: THREE.Quaternion): THREE.Quaternion {
  return out.copy(q).multiply(_q1.setFromAxisAngle(_Z, phi)).multiply(_q2.setFromAxisAngle(_X, -(tilt + dev)));
}

export class MeleeGrip {
  constructor(private readonly body: Humanoid) {}

  /** The rake of the handle in the fist for the weapon now held (GRIP.tilt or GRIP.swordTilt). */
  tilt = GRIP.tilt;

  /**
   * The hand that leads on the weapon (the right, or each hand on its own blade of a pair). The
   * weapon's keyed pose (`pos`, its origin on this hand's grip, and `q`) says where the fist must be
   * and, give or take the wrist, which way the forearm comes in; the arm is solved to that, the
   * forearm turned to bring the thumb round, and the weapon then set in the fist as it actually
   * landed (bent at the wrist toward the keyed angle by at most GRIP.slack). Writes the weapon pose
   * back into `pos` and `q`. `hint`: the hold the keyed pose was made with (its ArmPose flex and
   * dev), so the arm comes out as keyed rather than some other way round the same grip; `exact`
   * when the weapon is at that key's pose, so only holds close to it need a look.
   */
  lead(limb: Limb, side: 1 | -1, pos: THREE.Vector3, q: THREE.Quaternion, w = 1, hint?: { phi: number; dev: number; exact?: boolean }): GripResult {
    const phi0 = hint?.phi ?? 0, dev0 = hint?.dev ?? 0;
    const best = this.search(limb, side, pos, q, phi0, GRIP.flex, 9, dev0, hint?.exact ? this.near(phi0, 0.3, 5, dev0, 0.1) : undefined);
    this.place(limb, side, pos, q, best.phi, best.dev, w);
    const r = this.lastRoll;
    // The weapon as the fist actually holds it, then turned at the wrist toward the keyed angle.
    const Ha = limb.lower.getWorldQuaternion(_q3);
    const held = _q4.copy(Ha).multiply(_q1.setFromAxisAngle(_X, this.tilt + best.dev)).multiply(_q2.setFromAxisAngle(_Z, -best.phi));
    const delta = _q5.copy(held).invert().multiply(q);
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    const angle = 2 * Math.acos(Math.min(1, delta.w));
    if (angle > GRIP.slack) delta.slerp(_q1.identity(), 1 - GRIP.slack / angle).normalize();
    held.multiply(delta);
    const error = held.angleTo(q);
    q.copy(held);
    limb.end.getWorldPosition(pos).add(fistOf(side, _u).applyQuaternion(Ha));
    return { phi: best.phi, dev: best.dev, miss: best.miss, roll: r.roll, rollShort: r.short, error };
  }

  /**
   * A second hand on the same handle (`at`, a point on it in weapon space; the weapon already
   * placed at `pos`/`q`): it closes round the handle wherever round it suits the arm best, and is
   * nudged until the fist sits on the point.
   */
  support(limb: Limb, side: 1 | -1, pos: THREE.Vector3, q: THREE.Quaternion, at: THREE.Vector3, phi0: number, w = 1): GripResult {
    const target = this.target.copy(at).applyQuaternion(q).add(pos);
    // Near last frame's hold first (a swing moves little in a frame), all the way round if that's poor.
    const last = this.last.get(limb);
    let best = last ? this.search(limb, side, target, q, phi0, GRIP.wrap, 13, 0, this.near(last.phi, 0.5, 7, last.dev, 0.12)) : null;
    if (!best || best.cost > 0.08) best = this.search(limb, side, target, q, phi0, GRIP.wrap, 13);
    this.place(limb, side, target, q, best.phi, best.dev, w);
    // The arm may not land the forearm quite where asked: move the wrist until the fist is on the point.
    const fist = this.fist;
    for (let i = 0; i < 2; i++) {
      limb.end.getWorldPosition(fist).add(fistOf(side, _u).applyQuaternion(limb.lower.getWorldQuaternion(_q3)));
      const shift = _t.subVectors(target, fist);
      if (shift.lengthSq() < 1e-6) break;
      this.wrist.add(shift);
      this.body.reach(limb, this.wrist, this.pole, w);
      this.turn(limb, this.thumb, w);
    }
    limb.end.getWorldPosition(fist).add(fistOf(side, _u).applyQuaternion(limb.lower.getWorldQuaternion(_q3)));
    const r = this.lastRoll;
    return { phi: best.phi, dev: best.dev, miss: best.miss, roll: r.roll, rollShort: r.short, error: fist.distanceTo(target) };
  }

  private readonly wrist = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly fist = new THREE.Vector3();
  private readonly pole = new THREE.Vector3();
  private readonly thumb = new THREE.Vector3();
  private lastRoll = { roll: 0, short: 0 };
  /** The forearm turn the last search's hold needs from neutral (radians, checks). */
  pron = 0;

  /**
   * The hold the arm takes most naturally: the fist on `G`, the forearm coming in the way the hand
   * frame wants it (the elbow an upper arm's length from the shoulder), the forearm turned no
   * further than a real one turns, the elbow out of the chest, and near the wanted hold (`phi0`,
   * `dev0`) and last frame's. Searches the turn about the handle (`phi0` ± `range`) and the wrist's
   * tip of it over its whole range; or only `near` some hold (MeleeGrip.near), scored the same.
   */
  private search(
    limb: Limb, side: 1 | -1, G: THREE.Vector3, q: THREE.Quaternion, phi0: number, range: number, steps: number, dev0 = 0,
    near?: MeleeGrip['look'],
  ): { phi: number; dev: number; miss: number; cost: number } {
    const S = limb.upper.getWorldPosition(_S);
    const toSpine = _inv.copy(this.body.spine.matrixWorld).invert();
    const L1 = limb.upperLen, L2 = limb.lowerLen;
    const fist = fistOf(side, _fs);
    const last = this.last.get(limb);
    let best = { phi: phi0, dev: 0, miss: Infinity, cost: Infinity };
    let devs = DEVS, from = phi0 - range, to = phi0 + range, n = steps;
    if (near) {
      devs = _devs;
      for (let i = 0; i < 3; i++) devs[i] = THREE.MathUtils.clamp(near.dev + (i - 1) * near.devSpan, -GRIP.radial, GRIP.ulnar);
      from = Math.max(from, near.phi - near.range);
      to = Math.min(to, near.phi + near.range);
      n = near.steps;
    }
    const tryAt = (phi: number, dev: number) => {
      handFrame(q, phi, dev, this.tilt, _H);
      _W.copy(fist).applyQuaternion(_H).negate().add(G);
      // Where reach() would put the elbow, bent toward the forearm's wanted line.
      _E.set(0, L2, 0).applyQuaternion(_H).add(_W).sub(S);
      const toW = _t.subVectors(_W, S);
      const dist = toW.length();
      const far = Math.max(0, dist - (L1 + L2 - 0.004));
      const d = THREE.MathUtils.clamp(dist, Math.abs(L1 - L2) + 0.02, L1 + L2 - 0.002);
      toW.divideScalar(dist || 1);
      const a = Math.acos(THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
      const po = _E.addScaledVector(toW, -_E.dot(toW));
      if (po.lengthSq() < 1e-8) po.set(0, -1, 0).addScaledVector(toW, toW.y);
      po.normalize();
      const elbow = _u.copy(toW).multiplyScalar(Math.cos(a)).addScaledVector(po, Math.sin(a)).multiplyScalar(L1);
      const buried = elbowInChest(_eb.copy(elbow).add(S).applyMatrix4(toSpine));
      // The forearm as it lands, against the line the hand wants.
      const fore = _f.copy(toW).multiplyScalar(d).sub(elbow).normalize();
      const want = _v.set(0, -1, 0).applyQuaternion(_H);
      const off = Math.acos(THREE.MathUtils.clamp(fore.dot(want), -1, 1));
      // How far the forearm must turn from neutral (thumb toward the shoulder side) to bring the thumb round.
      const n0 = elbow.negate().addScaledVector(fore, -elbow.dot(fore));
      const bend = Math.min(1, n0.length() / L1);
      let pron = 0;
      if (bend > 0.05) {
        n0.normalize();
        const th = _G2.copy(_Z).applyQuaternion(_H);
        th.addScaledVector(fore, -th.dot(fore)).normalize();
        pron = Math.atan2(fore.dot(_n.crossVectors(n0, th)), n0.dot(th));
      }
      const miss = off * 0.1 + 3 * far;
      const cost = 0.25 * off + 3 * far + 20 * buried + (0.06 * Math.max(0, Math.abs(pron) - 1.1) + 0.3 * Math.max(0, Math.abs(pron) - GRIP.roll + 0.1)) * bend
        + 0.02 * Math.abs(phi - phi0) / range + 0.015 * Math.abs(dev - dev0) / GRIP.ulnar
        + (last ? 0.012 * Math.abs(phi - last.phi) + 0.01 * Math.abs(dev - last.dev) : 0);
      if (cost < best.cost) {
        best = { phi, dev, miss, cost };
        this.pron = pron;
      }
    };
    for (let i = 0; i < n; i++) {
      const phi = from + ((to - from) * i) / (n - 1);
      for (const dev of devs) tryAt(phi, dev);
    }
    // A finer look round the best.
    const step = (to - from) / (n - 1);
    const coarse = best;
    for (let i = -3; i <= 3; i++) {
      const phi = THREE.MathUtils.clamp(coarse.phi + (i * step) / 4, from, to);
      for (const dev of [coarse.dev - 0.06, coarse.dev, coarse.dev + 0.06]) tryAt(phi, THREE.MathUtils.clamp(dev, -GRIP.radial, GRIP.ulnar));
    }
    this.last.set(limb, { phi: best.phi, dev: best.dev });
    return best;
  }

  /** Where a narrow search looks (round a hold: its turn ± range in steps, its wrist tip ± devSpan). */
  private readonly look = { phi: 0, range: 0, steps: 0, dev: 0, devSpan: 0 };
  private near(phi: number, range: number, steps: number, dev: number, devSpan: number): MeleeGrip['look'] {
    const l = this.look;
    l.phi = phi;
    l.range = range;
    l.steps = steps;
    l.dev = dev;
    l.devSpan = devSpan;
    return l;
  }

  /** Each hand's last hold, so a swing's frames don't flick between two equally good ones. */
  private readonly last = new Map<Limb, { phi: number; dev: number }>();

  /** Solves the arm for a hold: wrist, elbow toward where the forearm wants it, thumb brought round. */
  private place(limb: Limb, side: 1 | -1, G: THREE.Vector3, q: THREE.Quaternion, phi: number, dev: number, w: number): void {
    handFrame(q, phi, dev, this.tilt, _Hb);
    this.wrist.copy(fistOf(side, _u).applyQuaternion(_Hb)).negate().add(G);
    const S = limb.upper.getWorldPosition(_S);
    this.pole.set(0, limb.lowerLen, 0).applyQuaternion(_Hb).add(this.wrist).sub(S);
    this.thumb.copy(_Z).applyQuaternion(_Hb);
    this.body.reach(limb, this.wrist, this.pole, w);
    this.turn(limb, this.thumb, w);
  }

  /**
   * Turns the arm about itself the way a real one does: first the upper arm, so the elbow bends
   * like a hinge (the forearm swings forward of it, thumb toward the shoulder side: a neutral
   * forearm), then the forearm turned from there to bring the thumb along `thumb`, as far as
   * GRIP.roll (pronation, supination). Half that turn goes into the upper arm (which carries the
   * forearm round with it without moving the elbow or the wrist), half at the elbow, so the skin
   * there twists little.
   */
  private turn(limb: Limb, thumb: THREE.Vector3, w: number): void {
    const parentW = limb.upper.parent!.getWorldQuaternion(_q4);
    const upperW = limb.upper.getWorldQuaternion(_q5);
    const lowerW = limb.lower.getWorldQuaternion(_q3);
    const e = _t.set(0, -1, 0).applyQuaternion(upperW);
    const f = _f.set(0, -1, 0).applyQuaternion(lowerW);
    // The hinge: the forearm on the upper arm's front (+Z) side, in its own frame.
    const fl = _u.copy(f).applyQuaternion(_q1.copy(upperW).invert());
    const side = Math.hypot(fl.x, fl.z);
    const hinge = Math.atan2(fl.x, fl.z) * THREE.MathUtils.smoothstep(side, 0.05, 0.25) * w;
    upperW.multiply(_q1.setFromAxisAngle(_Y, hinge));
    lowerW.copy(_q2.setFromUnitVectors(e, f)).multiply(upperW);
    // The forearm turned to bring the thumb round.
    const zc = _v.set(0, 0, 1).applyQuaternion(lowerW);
    const zd = _u.copy(thumb).addScaledVector(f, -thumb.dot(f));
    let roll = 0, short = 0;
    if (zd.lengthSq() > 1e-6) {
      zd.normalize();
      const want = Math.atan2(f.dot(_n.crossVectors(zc, zd)), zc.dot(zd));
      roll = THREE.MathUtils.clamp(want, -GRIP.roll, GRIP.roll) * w;
      short = Math.abs(want - roll);
    }
    this.lastRoll = { roll, short };
    upperW.premultiply(_q1.setFromAxisAngle(e, roll * 0.5));
    lowerW.premultiply(_q2.setFromAxisAngle(f, roll));
    limb.upper.quaternion.copy(parentW.invert().multiply(upperW));
    limb.lower.quaternion.copy(upperW.invert().multiply(lowerW));
    limb.upper.updateMatrixWorld(true);
  }
}

/**
 * A melee pose written from the shoulder out (spine space: +X the survivor's left, +Y up, +Z
 * ahead), so it is one a real arm can make: which way the arm reaches (`arm`, shoulder toward the
 * wrist) and how far (`reach`, of its full length), where the elbow hangs round that line
 * (`elbow`: 0 below it, +1.57 out to the side, -1.57 in across the body), how far the forearm is
 * turned from neutral (`turn`: + pronation, palm toward the floor; - supination), and the wrist:
 * `flex` turns the fist about the handle, `dev` tips the handle further from the thumb. `tilt`: the
 * grip's rake (GRIP.tilt, a hammer grip, unless given).
 */
export interface ArmPose { arm: [number, number, number]; reach: number; elbow: number; turn: number; flex?: number; dev?: number; tilt?: number }

const _aS = new THREE.Vector3(), _aU = new THREE.Vector3(), _aW = new THREE.Vector3(), _aD = new THREE.Vector3();
const _aO = new THREE.Vector3(), _aE = new THREE.Vector3(), _aF = new THREE.Vector3(), _aT = new THREE.Vector3();
const _aX = new THREE.Vector3(), _aY = new THREE.Vector3(), _aM = new THREE.Matrix4(), _aQ = new THREE.Quaternion();

/**
 * The fist (weapon origin, into `at`) and the weapon's turn (into `q`) that an ArmPose gives the
 * right (`side` -1) or left hand, spine space; optionally the elbow and wrist. The left hand's
 * mirror of a right-hand pose has `arm` x and `flex` negated.
 */
export function armPose(k: ArmPose, side: 1 | -1, at: THREE.Vector3, q: THREE.Quaternion, elbow?: THREE.Vector3, wrist?: THREE.Vector3): void {
  const L1 = ARM.upper, L2 = ARM.lower;
  const S = _aS.set(side * SHOULDER_X.male, 0.48, 0);
  const u = _aU.set(k.arm[0], k.arm[1], k.arm[2]).normalize();
  const d = THREE.MathUtils.clamp(k.reach, 0.3, 0.995) * (L1 + L2);
  const W = _aW.copy(S).addScaledVector(u, d);
  // Round the reach line: "down" from it, and "out" to the arm's own side.
  const down = _aD.set(0, -1, 0).addScaledVector(u, u.y);
  if (down.lengthSq() < 1e-4) down.set(0, 0, -1).addScaledVector(u, -u.z);
  down.normalize();
  const out = _aO.crossVectors(u, down).normalize();
  if (out.x * side < 0) out.negate();
  const perp = down.multiplyScalar(Math.cos(k.elbow)).addScaledVector(out, Math.sin(k.elbow));
  const a = Math.acos(THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));
  const E = _aE.copy(u).multiplyScalar(Math.cos(a)).addScaledVector(perp, Math.sin(a)).multiplyScalar(L1).add(S);
  const F = _aF.subVectors(W, E).normalize();
  // Neutral forearm: thumb toward the side the elbow bends away from; then turned.
  const thumb = _aT.copy(perp).negate().addScaledVector(F, perp.dot(F)).normalize();
  thumb.applyAxisAngle(F, side * k.turn);
  const Y = _aY.copy(F).negate();
  const X = _aX.crossVectors(Y, thumb);
  const H = _aQ.setFromRotationMatrix(_aM.makeBasis(X, Y, thumb));
  q.copy(H).multiply(_q1.setFromAxisAngle(_X, (k.tilt ?? GRIP.tilt) + (k.dev ?? 0))).multiply(_q2.setFromAxisAngle(_Z, -(k.flex ?? 0)));
  fistOf(side, at).applyQuaternion(H).add(W);
  elbow?.copy(E);
  wrist?.copy(W);
}
