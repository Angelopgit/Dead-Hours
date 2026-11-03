import * as THREE from 'three';
import { LIMBS, MELEE, THROWING, WEAPONS, defaultBuild, encodeBuild, isHandgun, isMelee, type BoostId, type HeldLimb, type Loadout, type MeleeId, type MeleeStyle, type ThrowKind, type WeaponDef, type WeaponId } from '@dead-hours/shared';
import type { Humanoid, Limb } from '../characters/Humanoid';
import { SeveredArm } from '../characters/Severed';
import { createWeaponModel, type WeaponModel } from './WeaponModels';
import { createThrowableModel, type ThrowableModel } from './ThrowableModels';
import { PUMP_HITS, dueCues } from './reloadScript';
import type { FoleyKind } from '../audio/GunSynth';
import { SyringeModel } from '../gameplay/Syringes';
import { GRIP, MeleeGrip, armPose, type ArmPose, type GripResult } from './MeleeGrip';

/** What the hands are doing, read from the authoritative arsenal (or a network snapshot). */
export interface HeldState {
  primary: { id: WeaponId; mag: number };
  secondary: { id: WeaponId; mag: number };
  active: 'primary' | 'secondary';
  action: 'idle' | 'draw' | 'reload' | 'melee' | 'bandage' | 'throw' | 'inject';
  actionT: number;
  actionTotal: number;
  /** A severed arm in the hands (the guns slung while it is). */
  limb?: HeldLimb | null;
  /** What the current melee swing is made with. */
  meleeWith?: 'machete' | 'limb';
  /** The melee weapon quick swings use: the machete, or one found lying around. */
  meleeId?: WeaponId;
  /** The melee weapon held out in place of the gun (its own quick slot): the guns are slung. */
  meleeOut?: boolean;
  /** Attachments and finishes on the guns (models are rebuilt when one changes). */
  builds?: Loadout;
  /** What the current throw is. */
  throwKind?: ThrowKind;
  /** The boost syringe being injected. */
  injectKind?: BoostId | null;
}

export interface HandsInput {
  /** 0..1 aim blend (the arsenal's, so the pose matches spread). */
  aim: number;
  sprinting: boolean;
  /** World point under the crosshair. */
  aimPoint: THREE.Vector3;
  /** 0..1 first-person aim down the sights (local player only). */
  ads?: number;
  /** Camera eye and view orientation (unshaken) the sights line up with. */
  eye?: THREE.Vector3;
  view?: THREE.Quaternion;
  /** Holding a grenade or Molotov ready (aiming the throw, local player only). */
  priming?: ThrowKind | null;
  /** Driving: both hands on the steering wheel at these points (world), the gun put away. */
  wheel?: { left: THREE.Vector3; right: THREE.Vector3 } | null;
}

/** Turns camera space (looking down -Z) into weapon space (barrel along +Z). */
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

/** Sound cues the animation reaches (reload steps, the pump, holstering): see reloadScript.ts. */
export type WeaponCue = FoleyKind;

type V3 = [number, number, number];
interface PoseDef { at: V3; rot?: V3 }

type Hold = 'rifle' | 'pistol' | 'akimbo';

/**
 * Spine-space poses of the weapon's anchor (stock butt for long guns, grip for pistols). Akimbo is
 * the right gun of the pair; the left one takes the same poses mirrored (+X is the survivor's left).
 */
export const POSES: Record<Hold, Record<'aim' | 'ready' | 'sprint' | 'reload' | 'melee', PoseDef>> = {
  rifle: {
    aim: { at: [-0.12, 0.38, 0.12] },
    ready: { at: [-0.08, 0.4, 0.05], rot: [0.42, 0.5, 0.13] },
    sprint: { at: [-0.06, 0.18, 0.15], rot: [-0.55, 0.95, 0.45] },
    reload: { at: [-0.1, 0.22, 0.12], rot: [-0.12, 0.35, 0.55] },
    melee: { at: [0.16, 0.5, -0.04], rot: [1.0, -0.1, 0] },
  },
  pistol: {
    aim: { at: [-0.03, 0.36, 0.4] },
    ready: { at: [-0.08, 0.18, 0.3], rot: [0.6, 0.1, 0] },
    sprint: { at: [-0.22, 0.06, 0.08], rot: [1.3, 0, 0] },
    reload: { at: [-0.04, 0.22, 0.3], rot: [-0.35, 0.2, 0.5] },
    melee: { at: [0.16, 0.12, 0.2], rot: [1.2, 0, 0] },
  },
  // Both arms out, a gun in each hand a shoulder's width apart.
  akimbo: {
    aim: { at: [-0.18, 0.36, 0.42] },
    ready: { at: [-0.2, 0.15, 0.3], rot: [0.6, 0.04, 0] },
    sprint: { at: [-0.22, 0.06, 0.08], rot: [1.3, 0, 0] },
    reload: { at: [-0.15, 0.2, 0.32], rot: [0.25, 0.1, 0] },
    melee: { at: [-0.2, 0.15, 0.3], rot: [0.6, 0.04, 0] },
  },
};

/**
 * Reloading a pair (spine space, the right gun; the left runs the same mirrored, a beat behind):
 * both muzzles come up so the empties drop free, each gun goes down to the belt and is pushed onto
 * a fresh magazine (the right seats at 0.5, the left at 0.62), they come back up and the slides
 * are released (0.82, 0.86) if they were locked back.
 */
const AKIMBO_RELOAD: Record<'right' | 'left', { t: number; at: V3; rot: V3 }[]> = {
  right: [
    { t: 0, at: [-0.15, 0.2, 0.33], rot: [0.25, 0.1, 0] },
    { t: 0.1, at: [-0.13, 0.27, 0.3], rot: [-0.75, 0.25, 0.35] },
    { t: 0.2, at: [-0.14, 0.25, 0.3], rot: [-0.65, 0.25, 0.3] },
    { t: 0.38, at: [-0.2, 0.05, 0.22], rot: [0.05, 0.05, 0] },
    { t: 0.5, at: [-0.2, -0.01, 0.21], rot: [0.08, 0.05, 0] },
    { t: 0.62, at: [-0.17, 0.12, 0.27], rot: [0.15, 0.08, 0] },
    { t: 0.82, at: [-0.15, 0.2, 0.33], rot: [0.05, 0.1, 0] },
    { t: 1, at: [-0.15, 0.2, 0.33], rot: [0.25, 0.1, 0] },
  ],
  left: [
    { t: 0, at: [-0.15, 0.2, 0.33], rot: [0.25, 0.1, 0] },
    { t: 0.12, at: [-0.13, 0.27, 0.3], rot: [-0.75, 0.25, 0.35] },
    { t: 0.3, at: [-0.14, 0.25, 0.3], rot: [-0.65, 0.25, 0.3] },
    { t: 0.5, at: [-0.2, 0.05, 0.22], rot: [0.05, 0.05, 0] },
    { t: 0.62, at: [-0.2, -0.01, 0.21], rot: [0.08, 0.05, 0] },
    { t: 0.74, at: [-0.17, 0.12, 0.27], rot: [0.15, 0.08, 0] },
    { t: 0.86, at: [-0.15, 0.2, 0.33], rot: [0.05, 0.1, 0] },
    { t: 1, at: [-0.15, 0.2, 0.33], rot: [0.25, 0.1, 0] },
  ],
};
/** Each gun of a pair: when its magazine drops free, when the new one seats, when the slide goes home. */
export const AKIMBO_TIMES = { right: { drop: 0.12, seat: 0.5, slide: 0.82 }, left: { drop: 0.14, seat: 0.62, slide: 0.86 } } as const;

/**
 * A pair down the sights (first person). There is no one sight to look down: both guns are held
 * out at arm's length either side of the crosshair, level with each other, muzzles toed in a touch
 * and the tops canted in the way wrists turn holding two guns out. `at` is where the right gun's
 * grip sits in camera space (+X right, +Y up, -Z ahead); the left gun mirrors it.
 */
const TWIN_ADS = { at: [0.128, -0.152, -0.43] as V3, toe: 0.045, cant: 0.1 };
/**
 * How the pair moves with the survivor down the sights (twinMotion): the guns lag a turn and a
 * look up or down and swing back (`lag` m and rad per rad/s), bob with the steps (`bob`, per m/s
 * of walking pace), breathe while standing still, and each kicks up, back and out when it fires.
 */
const TWIN_FEEL = {
  lag: { x: 0.011, y: 0.009, yaw: 0.032, pitch: 0.03, max: 0.035, maxRot: 0.1 },
  /** Lift as the eye rises or drops (per m/s). */
  lift: 0.005,
  bob: { x: 0.015, y: 0.012, roll: 0.03, pitch: 0.016, stride: 2.4 },
  breath: { y: 0.003, x: 0.0015, pitch: 0.008, rate: 1.6 },
  /** `other`: how much of one gun's kick the other feels through the body. */
  kick: { pitch: 0.72, back: 0.24, up: 0.026, roll: 0.17, yaw: 0.1, other: 0.14 },
};
/** Each M17's grip in its own model space: the middle of where the fist closes round it, and its axis up. */
export const GRIP_AT = new THREE.Vector3(0, -0.006, 0.043);
const GRIP_UP = new THREE.Vector3(0, 0.955, -0.296);
/**
 * Where a grip sits in a closed hand, from the wrist (lower arm bone space, the hand built as in
 * Outfit's hand(): fingers along -Y, the palm toward -side X, thumb along +Z). Side: +1 left, -1 right.
 */
export const HAND_GRIP = [0.027, -0.072, 0.004] as const;

/**
 * Lying prone, in the body's own frame (+Z ahead along it, +X its left, from the middle of it on
 * the ground): the stock in the shoulder beside the cheek and the gun out ahead resting low on the
 * hands; aimed, it turns onto the crosshair from there. Reloading rolls it onto its side.
 */
export const PRONE_POSES: Record<Hold, Record<'ready' | 'aim' | 'reload', PoseDef>> = {
  rifle: {
    ready: { at: [-0.13, 0.3, 0.62], rot: [0.12, 0.06, 0] },
    aim: { at: [-0.09, 0.39, 0.64] },
    reload: { at: [-0.13, 0.25, 0.58], rot: [0.05, 0.25, 0.9] },
  },
  pistol: {
    ready: { at: [-0.06, 0.25, 0.98], rot: [0.25, 0, 0] },
    aim: { at: [-0.03, 0.4, 1.02] },
    reload: { at: [-0.05, 0.27, 0.9], rot: [-0.2, 0.2, 0.5] },
  },
  // The right gun of a pair (the left mirrors it): out ahead on both elbows, a shoulder apart.
  akimbo: {
    ready: { at: [-0.16, 0.24, 0.95], rot: [0.25, 0.04, 0] },
    aim: { at: [-0.15, 0.4, 1.0] },
    reload: { at: [-0.14, 0.24, 0.85], rot: [-0.2, 0.15, 0.3] },
  },
};
/** Slung on the back while prone: along the spine, muzzle (or blade) toward the feet (spine space). */
const FLAT_BACK = basis([-0.12, -1, -0.3], [0, 0, -1]);
const FLAT_BLADE = basis([0.12, -1, 0], [0, 0, -1]);
const FLAT_BLADE2 = basis([-0.12, -1, 0], [0, 0, -1]);
/** Elbows down on the ground and out to the sides while prone (body frame). */
const PRONE_ELBOWS = { r: [-0.5, -0.85, -0.15] as V3, l: [0.5, -0.85, -0.05] as V3 };

/**
 * Down the sights (first person): which way each elbow goes (the gun's frame turned level: +Z
 * along the barrel, +X the gun's left, +Y up) and how far past the wrist the palm sits on the
 * grip. The hands run on along their forearms (the rig has no wrist joint), so this decides
 * whether they wrap round under the gun or reach up into the sight picture. Tuned against
 * `npm run check:sights`.
 */
export const ADS_ARMS: Record<Hold, { elbowR: V3; elbowL: V3; palm: number }> = {
  rifle: { elbowR: [-0.73, -0.27, 0.01], elbowL: [0.5, -0.6, -0.62], palm: 0.084 },
  pistol: { elbowR: [-1.4, -1.1, 0.44], elbowL: [0.16, -0.51, 0.13], palm: 0.071 },
  // Each hand on its own gun: the left elbow hangs out the way the right one does.
  akimbo: { elbowR: [-1.4, -1.1, 0.44], elbowL: [1.4, -1.1, 0.44], palm: 0.071 },
};
/**
 * The same lying prone (blended in by the body's prone weight): the support elbow out to the side,
 * both wrists drawn further back, and the support hand cupping the fore-end from underneath (CUP, m)
 * so it stays out of the sight picture. Tuned against `npm run check:sights` (prone cases).
 */
const CUP = 0.025;
export const PRONE_ADS_ARMS: Record<Hold, { elbowR: V3; elbowL: V3; palm: number }> = {
  rifle: { elbowR: [-0.73, -0.27, 0.01], elbowL: [0.9, -0.3, -0.3], palm: 0.12 },
  pistol: { elbowR: [-1.4, -1.1, 0.44], elbowL: [0.16, -0.51, 0.13], palm: 0.071 },
  akimbo: { elbowR: [-1.4, -1.1, 0.44], elbowL: [1.4, -1.1, 0.44], palm: 0.071 },
};

/**
 * A melee key: the lead arm's pose (MeleeGrip.ArmPose, written from the shoulder out so it is one
 * a real arm can make: the weapon follows from where it puts the fist), the torso's twist, and
 * whether the motion stops here (`stop`: the top of a wind-up, the end of a follow-through) or
 * sweeps on through it. `npm run check:melee` says how well each is held; client/tests/melee-fit.ts
 * fits keys to where the weapon should be (client/tests/melee-targets.json).
 */
interface MKey extends ArmPose { t: number; twist: number; stop?: boolean }
/**
 * A melee key ready to play: its numbers (`v`: the arm's reach direction as a unit vector, reach,
 * elbow, turn, flex and dev, then the torso's twist) and which arm.
 */
interface SwingKey { t: number; v: number[]; side: 1 | -1; stop: boolean; tilt: number }
const V_TWIST = 8;

const swing = (keys: MKey[], tilt = GRIP.tilt): SwingKey[] => {
  return keys.map((k) => {
    const n = Math.hypot(...k.arm);
    const v = [k.arm[0] / n, k.arm[1] / n, k.arm[2] / n, k.reach, k.elbow, k.turn, k.flex ?? 0, k.dev ?? 0, k.twist];
    return { t: k.t, v, side: -1, stop: !!k.stop, tilt };
  });
};

/**
 * Machete: one hand. A low guard, the blade up; wound up beside the head with the blade back over
 * the shoulder; a diagonal chop down across the front (the edge leading); through to the left hip.
 */
const BLADE_SWING = swing([
  { t: 0, arm: [-0.08, -0.8, 0.59], reach: 0.72, elbow: 0.45, turn: -0.17, flex: 0.1, dev: 0.07, twist: 0, stop: true },
  { t: 0.17, arm: [-0.69, 0.72, -0.08], reach: 0.5, elbow: 0.77, turn: -1.2, flex: 0.21, dev: 0.46, twist: -0.45, stop: true },
  { t: 0.29, arm: [0.23, -0.23, 0.95], reach: 0.96, elbow: -0.41, turn: -0.22, flex: 0, dev: 0.4, twist: 0.4 },
  { t: 0.55, arm: [0.49, -0.74, 0.45], reach: 0.93, elbow: 0.52, turn: 1.15, flex: -0.8, dev: 0.22, twist: 0.45, stop: true },
  { t: 1, arm: [-0.08, -0.8, 0.59], reach: 0.72, elbow: 0.45, turn: -0.17, flex: 0.1, dev: 0.07, twist: 0, stop: true },
]);

/**
 * Katana: both hands (the left at the pommel), a sword grip. A middle guard, the point at a throat;
 * wound up over the right shoulder; a diagonal cut down through the zombie, stopped out in front
 * with the point still on it (a low finish across to the left would fold the left arm into the
 * chest: the left hand can't reach round that far on the hilt).
 */
const KATANA_SWING = swing([
  { t: 0, arm: [0.25, -0.63, 0.74], reach: 0.84, elbow: 0.1, turn: -0.53, flex: 0.54, dev: 0.11, twist: 0, stop: true },
  { t: 0.17, arm: [-0.1, 0.79, 0.61], reach: 0.45, elbow: 0.25, turn: -0.67, flex: 0.43, dev: 0.46, twist: -0.5, stop: true },
  { t: 0.28, arm: [0.31, -0.29, 0.91], reach: 0.97, elbow: -0.34, turn: -0.29, flex: 0.02, dev: -0.09, twist: 0.45 },
  { t: 0.5, arm: [0.33, -0.53, 0.79], reach: 0.97, elbow: 0.16, turn: -1.2, flex: 0.8, dev: 0.46, twist: 0.5, stop: true },
  { t: 1, arm: [0.25, -0.63, 0.74], reach: 0.84, elbow: 0.1, turn: -0.53, flex: 0.54, dev: 0.11, twist: 0, stop: true },
], GRIP.swordTilt);

/**
 * Dual katanas, the right blade's cut (one hand, a sword grip): held low and out in a guard, flicked
 * up beside the head and drawn hard across. The left blade cuts the mirror of it, the two in turn.
 */
const DUAL_SWING = swing([
  { t: 0, arm: [-0.11, -0.67, 0.73], reach: 0.81, elbow: -0.4, turn: 0.61, flex: -0.45, dev: 0.09, twist: 0, stop: true },
  { t: 0.2, arm: [-0.71, 0.71, 0], reach: 0.48, elbow: -0.69, turn: -1.2, flex: 0.21, dev: 0.17, twist: -0.4, stop: true },
  { t: 0.3, arm: [0.25, -0.23, 0.94], reach: 0.96, elbow: -0.32, turn: -0.34, flex: 0.07, dev: -0.02, twist: 0.45 },
  { t: 0.55, arm: [0.51, -0.7, 0.51], reach: 0.93, elbow: 1.6, turn: -0.06, flex: -0.53, dev: 0.03, twist: 0.4, stop: true },
  { t: 1, arm: [-0.11, -0.67, 0.73], reach: 0.81, elbow: -0.4, turn: 0.61, flex: -0.45, dev: 0.09, twist: 0, stop: true },
], GRIP.swordTilt);
/** The same moves for the other hand: across the body's middle the other way. */
const mirrorKeys = (keys: SwingKey[]): SwingKey[] => keys.map((k) => ({
  ...k, v: k.v.map((x, j) => (j === 0 || j === 6 || j === V_TWIST ? -x : x)), side: -k.side as 1 | -1,
}));
const DUAL_SWING_L = mirrorKeys(DUAL_SWING);
/** The blade not cutting waits in guard. */
const DUAL_GUARD_R: SwingKey[] = [DUAL_SWING[0], { ...DUAL_SWING[0], t: 1 }];
const DUAL_GUARD_L = mirrorKeys(DUAL_GUARD_R);

/** Crowbar and wrench: one hand, held low ahead; raised high behind the head, brought straight down. */
const TOOL_SWING = swing([
  { t: 0, arm: [-0.05, -0.93, 0.37], reach: 0.88, elbow: 0.2, turn: 0.03, flex: -0.1, dev: 0.22, twist: 0, stop: true },
  { t: 0.2, arm: [-0.23, 0.97, -0.1], reach: 0.66, elbow: 1.39, turn: -0.83, flex: 0.38, dev: 0.46, twist: -0.3, stop: true },
  { t: 0.3, arm: [0.1, -0.22, 0.97], reach: 0.96, elbow: 0.86, turn: -1.16, flex: 0.42, dev: 0.46, twist: 0.25 },
  { t: 0.55, arm: [0.16, -0.84, 0.52], reach: 0.97, elbow: -0.25, turn: -0.02, flex: 0, dev: 0.46, twist: 0.2, stop: true },
  { t: 1, arm: [-0.05, -0.93, 0.37], reach: 0.88, elbow: 0.2, turn: 0.03, flex: -0.1, dev: 0.22, twist: 0, stop: true },
]);

/**
 * Bat and hockey stick: both hands, a level swing like a batter's. Held up by the right shoulder,
 * loaded back over it, swung flat across the front and wrapped round over the left shoulder. At
 * contact the hands are out in front of the chest, the right palm up and the left down, and the
 * barrel points off to the right of the body's line: the torso's twist carries it round onto the
 * zombie ahead.
 */
const CLUB_SWING = swing([
  { t: 0, arm: [0.24, -0.63, 0.74], reach: 0.5, elbow: 0.03, turn: -0.08, flex: -0.15, dev: -0.15, twist: 0, stop: true },
  { t: 0.18, arm: [-0.07, -0.29, 0.96], reach: 0.4, elbow: 0.37, turn: -0.38, flex: 0.67, dev: -0.12, twist: -0.45, stop: true },
  { t: 0.35, arm: [0.41, -0.59, 0.7], reach: 0.81, elbow: -0.44, turn: -1.1, flex: -0.38, dev: 0.02, twist: 0.6 },
  { t: 0.62, arm: [0.82, -0.2, 0.54], reach: 0.68, elbow: 0.49, turn: 0.66, flex: -0.25, dev: 0.15, twist: 0.55, stop: true },
  { t: 1, arm: [0.24, -0.63, 0.74], reach: 0.5, elbow: 0.03, turn: -0.08, flex: -0.15, dev: -0.15, twist: 0, stop: true },
]);

/**
 * Clubbing with a severed arm (spine space): where the grip is (the zombie's wrist) and how
 * the arm points (+Z toward the torn end). Heavier than the machete: a long wind-up over the
 * shoulder, a fast blow across, a slow recovery.
 */
const LIMB_SWING: { t: number; at: V3; rot: V3; twist: number }[] = [
  { t: 0, at: [-0.2, 0.32, 0.18], rot: [-1.8, -0.3, 0], twist: 0 },
  { t: 0.16, at: [-0.28, 0.55, -0.05], rot: [-2.6, 0.45, 0.2], twist: -0.5 },
  { t: 0.27, at: [0.12, 0.3, 0.45], rot: [0.2, 0.7, 1.2], twist: 0.55 },
  { t: 0.42, at: [0.26, 0.12, 0.3], rot: [0.9, 1.1, 1.3], twist: 0.4 },
  { t: LIMBS.duration, at: [-0.2, 0.32, 0.18], rot: [-1.8, -0.3, 0], twist: 0 },
];

/**
 * Each style's keyframes (0..1 of the swing); the third key is where the blow lands. A weapon with
 * a quicker or slower windup has its swing stretched so the weapon meets the zombie when the hit does.
 */
const STYLES: Record<MeleeStyle, { keys: SwingKey[]; impact: number; twoHands: boolean; holster: 'hip' | 'blade' }> = {
  blade: { keys: BLADE_SWING, impact: BLADE_SWING[2].t, twoHands: false, holster: 'hip' },
  katana: { keys: KATANA_SWING, impact: KATANA_SWING[2].t, twoHands: true, holster: 'blade' },
  club: { keys: CLUB_SWING, impact: CLUB_SWING[2].t, twoHands: true, holster: 'blade' },
  tool: { keys: TOOL_SWING, impact: TOOL_SWING[2].t, twoHands: false, holster: 'hip' },
  // A blade in each hand: the gun is put away and both are out for the swing.
  dual: { keys: DUAL_SWING, impact: DUAL_SWING[2].t, twoHands: true, holster: 'blade' },
};

/** Swing progress 0..1 to keyframe time, so the weapon's impact key lands on its windup. */
function swingClock(p: number, id: MeleeId): number {
  const d = MELEE[id];
  const st = STYLES[d.style];
  const w = d.windup / d.duration;
  return p < w ? (p / w) * st.impact : st.impact + ((p - w) / (1 - w)) * (1 - st.impact);
}
/** The keys either side of `t` and how far between them it is. */
function keySpan(keys: { t: number }[], t: number): { i: number; u: number } {
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  return { i, u: THREE.MathUtils.clamp((t - keys[i].t) / (keys[i + 1].t - keys[i].t), 0, 1) };
}
/**
 * One value of the keys at time `t` on a smooth curve through them (Catmull-Rom): sweeping through
 * a key at speed, easing to a halt only at keys that stop (a wind-up's top, the end of the
 * follow-through) and at the ends.
 */
function swingCurve(keys: SwingKey[], t: number, j: number): number {
  const { i, u } = keySpan(keys, t);
  const a = keys[i], b = keys[i + 1], h = b.t - a.t;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a.v[j] + (u3 - 2 * u2 + u) * h * keyTangent(keys, i, j)
    + (-2 * u3 + 3 * u2) * b.v[j] + (u3 - u2) * h * keyTangent(keys, i + 1, j);
}
function keyTangent(keys: SwingKey[], k: number, j: number): number {
  if (keys[k].stop || k === 0 || k === keys.length - 1) return 0;
  return (keys[k + 1].v[j] - keys[k - 1].v[j]) / (keys[k + 1].t - keys[k - 1].t);
}

/** Swing progress (0..1) at which a weapon's swing reaches a keyframe time `t` (inverse of swingClock). */
function swingProgress(t: number, id: MeleeId): number {
  const d = MELEE[id];
  const st = STYLES[d.style];
  const w = d.windup / d.duration;
  return t <= st.impact ? (t / st.impact) * w : w + ((t - st.impact) / (1 - st.impact)) * (1 - w);
}

/**
 * Swing progress at the moments worth looking at (dev/melee.html, checks): wound up, the blow
 * landing, the follow-through and the recovery.
 */
export function MELEE_PHASES(id: MeleeId): { ready: number; up: number; hit: number; through: number; end: number } {
  const keys = STYLES[MELEE[id].style].keys;
  return {
    ready: 0,
    up: swingProgress(keys[1].t, id),
    hit: MELEE[id].windup / MELEE[id].duration,
    through: swingProgress(keys[3].t, id),
    end: 0.9,
  };
}

/**
 * Overarm throw (spine space): the right hand brings it up, cocks it back over the shoulder,
 * whips it forward and lets go at THROWING.release, follows through across the body.
 */
/**
 * Injecting a boost syringe (progress 0..1, the needle in at 0.5): the right hand brings it up in
 * front, the left pulls the cap off, then it is driven into the outside of the right thigh, the
 * thumb pushes the plunger home and it comes out again. `rot` turns the syringe (needle +Z).
 */
const INJECT_KEYS: { t: number; at: V3; rot: V3 }[] = [
  { t: 0, at: [-0.16, 0.12, 0.3], rot: [-0.5, 0.3, 0] },
  { t: 0.2, at: [-0.11, 0.28, 0.33], rot: [-1.15, 0.25, 0] },
  { t: 0.3, at: [-0.13, 0.3, 0.31], rot: [-1.2, 0.2, 0] },
  { t: 0.42, at: [-0.25, 0.17, 0.17], rot: [1.25, -0.25, 0] },
  { t: 0.5, at: [-0.28, -0.05, 0.08], rot: [1.45, -0.3, 0] },
  { t: 0.78, at: [-0.28, -0.04, 0.085], rot: [1.45, -0.3, 0] },
  { t: 0.9, at: [-0.21, 0.07, 0.2], rot: [1.0, -0.2, 0] },
  { t: 1, at: [-0.18, 0.1, 0.25], rot: [0.6, 0, 0] },
];

const THROW_KEYS: { t: number; at: V3; rot: V3; twist: number }[] = [
  { t: 0, at: [-0.2, 0.46, 0.14], rot: [-0.4, 0, 0], twist: -0.1 },
  { t: 0.15, at: [-0.27, 0.62, -0.2], rot: [-1.2, 0.2, 0], twist: -0.5 },
  { t: THROWING.release, at: [-0.12, 0.62, 0.44], rot: [0.6, 0, 0], twist: 0.35 },
  { t: 0.44, at: [0.1, 0.2, 0.42], rot: [1.2, 0.4, 0], twist: 0.45 },
  { t: THROWING.duration, at: [-0.18, 0.2, 0.2], rot: [0.4, 0, 0], twist: 0 },
];

/** Ready: resting over the right shoulder like a bat. */
const LIMB_READY: PoseDef = LIMB_SWING[0];
/** Sprinting: dragged along by the wrist at the side. */
const LIMB_CARRY: PoseDef = { at: [-0.26, 0.06, 0.06], rot: [1.57, 0, 0] };
/** Picking it up when nothing says where it lay: low by the feet. */
const LIMB_GRAB: PoseDef = { at: [-0.2, -0.45, 0.35], rot: [1.4, 0, 0] };
/** How far up the arm the second hand closes. */
const LIMB_HANDS = 0.09;

/** Builds a rotation whose +Z is `z` and whose +Y is as close to `up` as possible. */
function basis(z: V3, up: V3): THREE.Quaternion {
  const zv = new THREE.Vector3(...z).normalize();
  const yv = new THREE.Vector3(...up).addScaledVector(zv, -new THREE.Vector3(...up).dot(zv)).normalize();
  const xv = new THREE.Vector3().crossVectors(yv, zv);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xv, yv, zv));
}

/** Where weapons ride when not in the hands (bone-space anchor of the model origin). */
const HOLSTERS = {
  back: { pos: new THREE.Vector3(0.09, 0.42, -0.2), quat: basis([-0.45, -0.88, 0], [0, 0, -1]) },
  thigh: { pos: new THREE.Vector3(-0.115, -0.06, -0.02), quat: basis([0, -1, 0], [0, 0, 1]) },
  /** The left gun of an akimbo pair, on the other thigh. */
  thighL: { pos: new THREE.Vector3(0.115, -0.06, -0.02), quat: basis([0, -1, 0], [0, 0, 1]) },
  hip: { pos: new THREE.Vector3(0.19, 0.05, -0.08), quat: basis([0.08, -0.9, -0.42], [1, 0, 0]) },
  /** Long melee weapons across the back the other way from a slung rifle, grip over the left shoulder. */
  blade: { pos: new THREE.Vector3(-0.1, 0.4, -0.24), quat: basis([0.42, -0.9, 0], [0, 0, -1]) },
  /** The second of a pair of katanas, crossed over the first (grip over the other shoulder). */
  blade2: { pos: new THREE.Vector3(0.1, 0.4, -0.25), quat: basis([-0.42, -0.9, 0], [0, 0, -1]) },
};

const smooth = (t: number) => t * t * (3 - 2 * t);
const seg = (p: number, a: number, b: number) => THREE.MathUtils.clamp((p - a) / (b - a), 0, 1);

/**
 * Third-person weapon handling for one character: places the held weapon from the aim,
 * ready, sprint, reload, draw, melee and bandage poses, adds recoil, and puts both wrists on
 * it with IK. Holstered weapons ride on the back, thigh and hip. Used for the local player
 * now and for remote players and AI teammates in Phase 4.
 */
export class PlayerWeapon {
  private readonly models = new Map<WeaponId, WeaponModel>();
  private readonly bandageRoll: THREE.Mesh;
  /** The boost syringe in the hand while injecting. */
  private readonly syringe: SyringeModel;
  private primaryId: WeaponId | null = null;
  private secondaryId: WeaponId | null = null;
  private aimW = 0;
  private sprintW = 0;
  private reloadW = 0;
  private meleeW = 0;
  /** The gun put away for a two-handed swing (katana, bat, hockey stick). */
  private meleeTwoW = 0;
  /** The gun put away while the melee weapon is held out. */
  private outW = 0;
  private meleeShown: MeleeId = 'machete';
  /** Dual katanas: the left blade cuts this swing (they take turns). */
  private dualLeft = true;
  private stowW = 0;
  private raised = 0;
  private readonly recoil = { z: 0, vz: 0, pitch: 0, vp: 0, yaw: 0, vy: 0 };
  /** The left gun of an akimbo pair: its own recoil and slide. */
  private readonly recoilL = { z: 0, vz: 0, pitch: 0, vp: 0, yaw: 0, vy: 0 };
  private actionCycleL = -1;
  /** Akimbo: the gun of the pair that fired last (1 right, -1 left): flash, case and tracer come from it. */
  private hand: 1 | -1 = -1;
  /** The left gun of an akimbo pair (same build as the right one, which is the model in `models`). */
  private offhand: WeaponModel | null = null;
  private readonly anchorL = new THREE.Vector3();
  private readonly quatL = new THREE.Quaternion();
  private actionCycle = -1;
  private actionKind: 'pump' | 'slide' = 'pump';
  private lastProgress = 0;
  private lastAction: HeldState['action'] = 'idle';
  private lastActive: WeaponId | null = null;
  private time = 0;
  /** Hides the weapon in the hands (looking through a scope). */
  hideHeld = false;
  private shown = true;
  /** Called when new weapon materials appear (light probe patching). */
  onMaterials: ((m: THREE.Material[]) => void) | null = null;
  /**
   * A handling sound is due: `inS` is how long until its main hit lands (the magazine seats as the
   * hand pushes it home), so the sound can start early enough to lead up to it.
   */
  onCue: ((cue: WeaponCue, weapon: WeaponId, inS: number) => void) | null = null;
  /** The reload under way started on an empty gun (the bolt has to go home; a pump gun is racked after). */
  private reloadEmpty = false;

  private readonly anchor = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly spineQ = new THREE.Quaternion();
  /** The body's frame (prone holds), and a spare point. */
  private readonly rootQ = new THREE.Quaternion();
  private readonly proneAt = new THREE.Vector3();
  private readonly leftTarget = new THREE.Vector3();
  private readonly rightTarget = new THREE.Vector3();
  private readonly poleL = new THREE.Vector3();
  private readonly poleR = new THREE.Vector3();
  private readonly e = new THREE.Euler();
  private held: WeaponModel | null = null;
  /** Severed arm in the hands. */
  private limbModel: SeveredArm | null = null;
  private limbId = -1;
  /** 0..1 how far the gun has gone to its holster for the arm. */
  private limbW = 0;
  /** Where the arm being picked up lay (held-mode root pose, world). */
  private liftId = -1;
  private readonly liftPos = new THREE.Vector3();
  private readonly liftQ = new THREE.Quaternion();
  private readonly limbPos = new THREE.Vector3();
  private readonly limbQ = new THREE.Quaternion();
  /** Gore setting for the arm in hand. */
  gore = true;
  private readonly throwModels = new Map<ThrowKind, ThrowableModel>();
  private throwW = 0;
  /** 0..1 how far the arms have taken the shooter's hold down the sights (shooterArms). */
  private shooterW = 0;
  /** The pair's first-person sway: lag springs, walking pace and stride phase (twinMotion). */
  private readonly feel = { x: 0, vx: 0, y: 0, vy: 0, yaw: 0, vyaw: 0, pitch: 0, vpitch: 0, speed: 0, phase: 0, primed: false };
  private readonly lastEye = new THREE.Vector3();
  private readonly lastView = new THREE.Quaternion();
  /** 0..1 how far the hands have gone to the steering wheel, and where it was last. */
  private wheelW = 0;
  private readonly wheelL = new THREE.Vector3();
  private readonly wheelR = new THREE.Vector3();

  /** Hands closing on melee handles (see MeleeGrip). */
  private readonly grip: MeleeGrip;
  /**
   * The melee weapon(s) in the hands this frame, at their keyed poses: the hands are solved onto
   * them last (MeleeGrip), and they are set in the fists as the hands land. `support` is the left
   * hand's share on a two-handed grip, `place` blends the weapon from where the keys put it (0:
   * still in its holster on a draw) to the fist, and the hints are the keyed hold of each lead hand.
   */
  private readonly grips = {
    right: null as WeaponModel | null, left: null as WeaponModel | null, support: 0, place: 1,
    hintR: { phi: 0, dev: 0, tilt: GRIP.tilt, exact: false }, hintL: { phi: 0, dev: 0, tilt: GRIP.tilt, exact: false },
  };
  /** The last frame's hand solves (checks): lead right, lead left (a pair's left blade), support left. */
  readonly gripResults: { right: GripResult | null; left: GripResult | null; support: GripResult | null } = { right: null, left: null, support: null };

  constructor(private readonly scene: THREE.Object3D, private readonly body: Humanoid) {
    this.grip = new MeleeGrip(body);
    const g = new THREE.CylinderGeometry(0.03, 0.03, 0.07, 8).rotateZ(Math.PI / 2);
    this.bandageRoll = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.95 }));
    this.bandageRoll.visible = false;
    scene.add(this.bandageRoll);
    this.syringe = new SyringeModel('strength');
    this.syringe.root.visible = false;
    scene.add(this.syringe.root);
    this.ensure('machete');
  }

  /** The melee weapon quick swings use. */
  private meleeOf(s: HeldState): MeleeId {
    const id = s.meleeId;
    return id && isMelee(id) ? id : 'machete';
  }
  private builds: Loadout = {};

  private ensure(id: WeaponId): WeaponModel {
    let m = this.models.get(id);
    const build = this.builds[id] ?? defaultBuild(id);
    if (m && m.code !== encodeBuild(build)) {
      if (this.held === m) this.held = null;
      m.dispose();
      this.models.delete(id);
      m = undefined;
    }
    if (!m) {
      m = createWeaponModel(id, build);
      this.models.set(id, m);
      this.scene.add(m.root);
      this.onMaterials?.(m.materials);
    }
    return m;
  }

  /** The left gun of an akimbo pair, built (or rebuilt) to match the right one's build. */
  private ensureOffhand(): WeaponModel | null {
    const id = this.secondaryId;
    const want = id && WEAPONS[id].hold === 'akimbo' ? this.builds[id] ?? defaultBuild(id) : null;
    const off = this.offhand;
    if (off && (!want || off.id !== id || off.code !== encodeBuild(want))) {
      off.dispose();
      this.offhand = null;
    }
    if (want && id && !this.offhand) {
      const m = createWeaponModel(id, want);
      m.root.name = `weapon:${id}:left`;
      // Mirrored, so its ejection port and slide catch face out to the left like a left-handed gun's.
      m.root.scale.x = -1;
      this.offhand = m;
      this.scene.add(m.root);
      this.onMaterials?.(m.materials);
    }
    return this.offhand;
  }

  materials(): THREE.Material[] {
    return [...[...this.models.values()].flatMap((m) => m.materials), ...(this.offhand?.materials ?? []), this.bandageRoll.material as THREE.Material, ...this.syringe.materials];
  }

  private setLoadout(primary: WeaponId, secondary: WeaponId): void {
    if (primary === this.primaryId && secondary === this.secondaryId) return;
    for (const [id, m] of this.models) {
      if (id !== primary && id !== secondary && WEAPONS[id].slot !== 'melee') {
        m.dispose();
        this.models.delete(id);
      }
    }
    this.primaryId = primary;
    this.secondaryId = secondary;
    this.ensure(primary);
    this.ensure(secondary);
    this.ensureOffhand();
  }

  /**
   * A round left the active weapon. An akimbo pair fires its guns in turn: `mag` (the rounds left
   * after this one) says which, the right gun on odd counts (30 → 29), so the hand matches the
   * ammunition; without it (someone else's shot) the guns simply alternate.
   */
  fired(def: WeaponDef, mag?: number): void {
    const pair = def.hold === 'akimbo';
    if (pair) this.hand = mag !== undefined ? (mag % 2 === 1 ? 1 : -1) : this.hand === 1 ? -1 : 1;
    const left = pair && this.hand === -1;
    const r = left ? this.recoilL : this.recoil;
    const k = def.recoil;
    r.vz += 1.6 + k * 1.4;
    r.vp += 3.5 + k * 6;
    r.vy += (Math.random() - 0.5) * k * 3;
    this.raised = 0.7;
    if (def.id === 'shotgun') {
      this.actionCycle = 0;
      this.actionKind = 'pump';
      this.pumpCues(0);
    } else if (isHandgun(def.id)) {
      if (left) this.actionCycleL = 0;
      else {
        this.actionCycle = 0;
        this.actionKind = 'slide';
      }
    }
  }

  /** Pump after a reload that started empty. */
  cycleAction(): void {
    this.actionCycle = 0.08;
    this.actionKind = 'pump';
    this.pumpCues(0.08);
  }

  /** The rack's two hits, timed to the animation (the forend reaches the back stop, then locks forward). */
  private pumpCues(from: number): void {
    this.onCue?.('pumpBack', 'shotgun', PUMP_HITS.back - from);
    this.onCue?.('pumpFwd', 'shotgun', PUMP_HITS.forward - from);
  }

  /** A reload finished: a pump gun loaded from empty racks a shell into the chamber. */
  finishReload(): void {
    if (this.reloadEmpty && this.lastActive && WEAPONS[this.lastActive].perShell) this.cycleAction();
    this.reloadEmpty = false;
  }

  /** Last IK targets (tests and debugging). */
  get targets(): { right: THREE.Vector3; left: THREE.Vector3 } {
    return { right: this.rightTarget, left: this.leftTarget };
  }

  /** The gun in the hands (null while they hold a severed arm); the right one of a pair. */
  get heldModel(): WeaponModel | null {
    return this.held;
  }

  /** The left gun of an akimbo pair while it is in the hand. */
  get offhandModel(): WeaponModel | null {
    return this.held && this.held.id === this.offhand?.id ? this.offhand : null;
  }

  /** The gun the last round came from (the left of a pair after its shot), or the one in hand. */
  private get firing(): WeaponModel | null {
    return this.hand === -1 ? this.offhandModel ?? this.held : this.held;
  }

  /** The severed arm in the hands, if any (its torn end drips and splashes). */
  get heldLimb(): SeveredArm | null {
    return this.limbModel;
  }

  /** The arm about to be picked up lay like this (held-mode root pose): the lift starts there. */
  liftFrom(id: number, pos: THREE.Vector3, q: THREE.Quaternion): void {
    this.liftId = id;
    this.liftPos.copy(pos);
    this.liftQ.copy(q);
  }

  private syncLimb(limb: HeldLimb | null): void {
    if (this.limbModel && (!limb || limb.id !== this.limbId)) {
      this.limbModel.dispose();
      this.limbModel = null;
      this.limbId = -1;
    }
    if (limb && !this.limbModel) {
      const m = new SeveredArm({ kind: limb.kind, look: limb.look, arm: limb.arm, cut: limb.cut, scale: limb.scale }, 'held');
      this.limbModel = m;
      this.limbId = limb.id;
      this.scene.add(m.root);
      this.onMaterials?.(m.materials);
    }
  }

  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    const m = this.firing;
    if (!m) return this.body.armR.end.getWorldPosition(out);
    return m.root.localToWorld(out.copy(m.muzzle));
  }

  /** Barrel direction (world). */
  muzzleDir(out: THREE.Vector3): THREE.Vector3 {
    const m = this.firing;
    if (!m) return out.set(0, 0, 1);
    return out.set(0, 0, 1).applyQuaternion(m.root.quaternion);
  }

  ejectWorld(out: THREE.Vector3, dir: THREE.Vector3): void {
    const m = this.firing;
    if (!m) return;
    m.root.localToWorld(out.copy(m.eject));
    // Cases leave to the right; the left gun of a pair throws them out over its own side.
    dir.set(m === this.offhand ? 1 : -1, 0.6, -0.2).normalize().applyQuaternion(m.root.quaternion);
  }

  /** Call after Humanoid.update (body pose final) and before rendering. */
  update(dt: number, s: HeldState, input: HandsInput): void {
    this.time += dt;
    const body = this.body;
    if (s.builds && s.builds !== this.builds) {
      this.builds = s.builds;
      this.ensure(s.primary.id);
      this.ensure(s.secondary.id);
      this.ensureOffhand();
    }
    this.setLoadout(s.primary.id, s.secondary.id);
    const activeId = s.active === 'primary' ? s.primary.id : s.secondary.id;
    const def = WEAPONS[activeId];
    const model = this.ensure(activeId);
    const hold: Hold = def.hold === 'pistol' || def.hold === 'akimbo' ? def.hold : 'rifle';
    const poses = POSES[hold];
    // A pair in the hands: the left gun follows its own copy of every pose (placeOffhand).
    const off = hold === 'akimbo' ? this.ensureOffhand() : null;
    const progress = s.actionTotal > 0 ? THREE.MathUtils.clamp(1 - s.actionT / s.actionTotal, 0, 1) : 1;
    if (activeId !== this.lastActive) {
      if (this.lastActive) {
        this.onCue?.('holster', this.lastActive, 0);
        // Both guns of a pair go back in their holsters.
        if (WEAPONS[this.lastActive].hold === 'akimbo') this.onCue?.('holster', this.lastActive, 0.09);
      }
      this.lastActive = activeId;
    }
    this.cues(s, def, progress);
    // A severed arm in hand (gone the moment it bursts; the swing it burst in still finishes).
    const limb = s.limb && !s.limb.broken ? s.limb : null;
    const clubbing = s.action === 'melee' && s.meleeWith === 'limb';
    this.syncLimb(limb);
    const meleeId = this.meleeOf(s);
    if (meleeId !== this.meleeShown) {
      // Put away what was carried (a pair's second blade is the 'katana' model: kept if one stays).
      const gone: MeleeId[] = this.meleeShown === 'katanas' ? ['katanas', 'katana'] : [this.meleeShown];
      for (const id of gone) {
        const old = this.models.get(id);
        if (!old || id === 'machete' || id === meleeId || (id === 'katana' && meleeId === 'katanas')) continue;
        old.dispose();
        this.models.delete(id);
      }
      this.meleeShown = meleeId;
    }
    const meleeModel = this.ensure(meleeId);
    const style = STYLES[MELEE[meleeId].style];
    const dual = meleeId === 'katanas';
    // The off hand's blade of a pair.
    const offModel = dual ? this.ensure('katana') : null;
    // Each new swing of a pair is cut by the other hand.
    if (dual && s.action === 'melee' && s.meleeWith !== 'limb' && (this.lastAction !== 'melee' || 1 - s.actionT / Math.max(0.01, s.actionTotal) < this.lastProgress - 0.3)) {
      this.dualLeft = !this.dualLeft;
    }

    // Blend weights.
    const ease = (cur: number, target: number, rate: number) => cur + (target - cur) * (1 - Math.exp(-dt * rate));
    this.raised = Math.max(0, this.raised - dt);
    const injecting = s.action === 'inject';
    const throwing = s.action === 'throw' || (!!input.priming && !limb && s.action !== 'melee' && s.action !== 'bandage' && !injecting);
    const busy = s.action === 'reload' || s.action === 'melee' || s.action === 'bandage' || injecting || throwing;
    const aimTarget = busy || s.action === 'draw' ? 0 : Math.max(input.aim, this.raised > 0 ? 1 : 0);
    this.aimW = ease(this.aimW, aimTarget, 16);
    this.sprintW = ease(this.sprintW, input.sprinting && !busy && this.raised <= 0 ? 1 : 0, 9);
    this.reloadW = ease(this.reloadW, s.action === 'reload' ? 1 : 0, 12);
    this.meleeW = ease(this.meleeW, s.action === 'melee' ? 1 : 0, 22);
    this.meleeTwoW = ease(this.meleeTwoW, s.action === 'melee' && !clubbing && style.twoHands ? 1 : 0, 26);
    // (Put away while injecting: that hand holds the syringe.)
    const out = !!s.meleeOut && !limb && !injecting;
    this.outW = ease(this.outW, out ? 1 : 0, 16);
    // Drawing brings the gun out of its holster (not while the draw is getting a grip on an arm,
    // or taking the melee weapon out).
    const drawing = s.action === 'draw' && !limb && !out;
    // At the wheel the gun goes to its holster (driving takes both hands).
    if (input.wheel) {
      this.wheelL.copy(input.wheel.left);
      this.wheelR.copy(input.wheel.right);
    }
    this.wheelW = ease(this.wheelW, input.wheel ? 1 : 0, 10);
    if (this.wheelW < 0.002) this.wheelW = 0;
    const stowTarget = s.action === 'bandage' || injecting || throwing || input.wheel ? 1 : drawing ? 1 - smooth(seg(progress, 0.1, 0.85)) : 0;
    this.stowW = drawing ? stowTarget : ease(this.stowW, stowTarget, 9);
    // The gun goes over the shoulder (or into the holster) while the hands hold an arm.
    this.limbW = limb || clubbing ? ease(this.limbW, 1, 14) : 0;

    // In a bike's saddle the hands are on the bars: the gun goes to its holster.
    const bars = body.onBars;
    // Body channels.
    const twistRifle = THREE.MathUtils.lerp(-0.4, -0.55, this.aimW) * (1 - this.sprintW) * (1 - this.stowW) * (1 - this.reloadW * 0.5);
    let twist = hold === 'rifle' ? twistRifle : 0;
    twist *= (1 - this.meleeW) * (1 - this.limbW) * (1 - bars);
    // Both hands on a long weapon, a bike's bars, or the melee weapon held out: the gun goes to its
    // holster (the right gun of a pair for any swing: that hand takes the blade).
    const away = Math.max(this.limbW, this.meleeTwoW, this.outW, bars, off ? this.meleeW : 0);

    body.root.updateMatrixWorld(true);
    const spine = body.spine;
    spine.getWorldQuaternion(this.spineQ);
    body.root.getWorldQuaternion(this.rootQ);
    const stockLocal = model.stock;
    // Lying prone the holds are the body's own, not the chest's (the torso lies along the ground).
    const pw = body.proneWeight;
    twist *= 1 - pw;

    // Ready → aim → sprint → reload → melee → holster.
    this.spinePose(poses.ready, this.anchor, this.quat);
    if (pw > 0.001) {
      this.bodyPose(PRONE_POSES[hold].ready, this.tmpA, this.tmpQ);
      this.mix(this.tmpA, this.tmpQ, pw);
    }
    if (this.aimW > 0.001) {
      spine.localToWorld(this.tmpA.set(...poses.aim.at));
      if (pw > 0.001) this.tmpA.lerp(this.bodyPoint(PRONE_POSES[hold].aim.at, this.proneAt), pw);
      const dir = new THREE.Vector3().subVectors(input.aimPoint, this.tmpA);
      if (dir.lengthSq() < 0.25) dir.set(0, 0, 1).applyQuaternion(this.spineQ);
      dir.normalize();
      this.tmpQ.setFromRotationMatrix(new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));
      this.mix(this.tmpA, this.tmpQ, this.aimW);
    }
    const ads = busy ? 0 : input.ads ?? 0;
    if (off) this.twinMotion(dt, input);
    if (ads > 0.001 && model.sight && input.eye && input.view) {
      if (off) {
        // A pair: the right gun held out to the right of the crosshair (twinPose); its anchor is
        // wherever that puts the grip.
        this.twinPose(1, input, this.recoil, this.tmpA, this.tmpQ);
        this.tmpA.sub(_tg.copy(GRIP_AT).sub(stockLocal).applyQuaternion(this.tmpQ));
      } else {
        // Down the sights: the sight line on the camera axis, the stock wherever that puts it,
        // with a slow breathing sway.
        const t = this.time;
        this.tmpQ.copy(input.view).multiply(FLIP)
          .multiply(this.e2q(Math.sin(t * 1.3) * 0.0016, Math.sin(t * 0.9 + 1) * 0.002, 0));
        this.tmpA.copy(stockLocal).sub(model.sight.eye).applyQuaternion(this.tmpQ).add(input.eye);
      }
      this.mix(this.tmpA, this.tmpQ, ads);
    }
    body.headHidden = ads > 0.35;
    if (this.sprintW > 0.001) {
      this.spinePose(poses.sprint, this.tmpA, this.tmpQ);
      this.mix(this.tmpA, this.tmpQ, this.sprintW * (1 - this.aimW));
    }
    if (this.reloadW > 0.001) {
      if (off) this.keyPose(AKIMBO_RELOAD.right, s.action === 'reload' ? progress : 1, this.tmpA, this.tmpQ);
      else this.spinePose(poses.reload, this.tmpA, this.tmpQ);
      if (pw > 0.001) {
        this.bodyPose(PRONE_POSES[hold].reload, this.proneAt, _pq);
        this.tmpA.lerp(this.proneAt, pw);
        this.tmpQ.slerp(_pq, pw);
      }
      this.mix(this.tmpA, this.tmpQ, this.reloadW);
    }
    if (this.meleeW > 0.001 && !off) {
      this.spinePose(poses.melee, this.tmpA, this.tmpQ);
      this.mix(this.tmpA, this.tmpQ, this.meleeW);
    }
    if (this.stowW > 0.001) {
      this.holsterPose(def.slot === 'primary' ? 'back' : 'thigh', this.tmpA, this.tmpQ);
      // Holster anchors the model origin, the hand poses anchor the stock: convert.
      this.tmpA.add(new THREE.Vector3().copy(stockLocal).applyQuaternion(this.tmpQ));
      this.mix(this.tmpA, this.tmpQ, this.stowW);
    }
    if (away > 0.001) {
      this.holsterPose(def.slot === 'primary' ? 'back' : 'thigh', this.tmpA, this.tmpQ);
      this.tmpA.add(new THREE.Vector3().copy(stockLocal).applyQuaternion(this.tmpQ));
      this.mix(this.tmpA, this.tmpQ, away);
    }

    // Recoil springs (weapon space): kick back, muzzle climb, a little sideways wander.
    const r = this.recoil;
    spring(r, dt);
    const kickScale = 0.5 + 0.5 * this.aimW;
    // A handgun of a pair flips harder; down the sights twinPose has its own kick.
    const flip = off ? HIP_FLIP * (1 - ads) : 0.05, push = off ? HIP_PUSH * (1 - ads) : 0.022;
    this.quat.multiply(this.tmpQ.setFromEuler(this.e.set(-r.pitch * flip * kickScale, r.yaw * 0.03, 0)));
    const rootPos = model.root.position;
    rootPos.copy(stockLocal).applyQuaternion(this.quat).negate().add(this.anchor);
    rootPos.addScaledVector(this.tmpA.set(0, 0, -1).applyQuaternion(this.quat), r.z * push * kickScale);
    model.root.quaternion.copy(this.quat);
    model.root.visible = this.shown && !this.hideHeld;
    model.root.updateMatrixWorld(true);
    body.kick = -Math.max(r.pitch, off ? this.recoilL.pitch : 0) * 0.012;
    body.twist = twist + this.swingTwist(s) + this.throwTwist(s, input);
    if (off) this.placeOffhand(dt, off, s, input, progress, ads, kickScale);

    // Moving parts (a handgun's slide stays locked back once its gun is empty).
    const rounds = s.active === 'primary' ? s.primary.mag : s.secondary.mag;
    if (off) {
      this.animateAction(dt, model, false, this.slideLocked(s, Math.floor(rounds / 2), AKIMBO_TIMES.right.slide, progress));
      this.animateAction(dt, off, true, this.slideLocked(s, Math.ceil(rounds / 2), AKIMBO_TIMES.left.slide, progress));
    } else {
      this.animateAction(dt, model, false, hold === 'pistol' && this.slideLocked(s, rounds, 0.8, progress));
    }

    // Holstered weapons.
    for (const [id, m] of this.models) {
      if (m === model) continue;
      if (WEAPONS[id].slot === 'melee') continue;
      m.root.visible = this.shown;
      this.holsterPose(WEAPONS[id].slot === 'primary' ? 'back' : 'thigh', m.root.position, m.root.quaternion);
      m.root.updateMatrixWorld(true);
    }
    const spareL = this.offhand;
    if (spareL && spareL !== off) {
      spareL.root.visible = this.shown;
      this.holsterPose('thighL', spareL.root.position, spareL.root.quaternion);
      spareL.root.updateMatrixWorld(true);
      this.animateAction(dt, spareL, true, false);
    }
    this.held = this.limbW > 0.5 ? null : model;

    // Hands.
    const spineM = spine.matrixWorld;
    this.poleR.set(-0.6, -0.65, -0.25).transformDirection(spineM);
    this.poleL.set(0.6, -0.7, -0.1).transformDirection(spineM);
    if (pw > 0.001) {
      // Propped on the elbows.
      this.poleR.lerp(_pp.set(...PRONE_ELBOWS.r).normalize().applyQuaternion(this.rootQ), pw).normalize();
      this.poleL.lerp(_pp.set(...PRONE_ELBOWS.l).normalize().applyQuaternion(this.rootQ), pw).normalize();
    }
    model.root.localToWorld(this.rightTarget.set(0, 0, 0));
    let leftW = 1;
    if (off) {
      // Each hand on its own gun's grip, the magazines dropping and going in gun by gun.
      off.root.localToWorld(this.leftTarget.set(0, 0, 0));
      this.poleL.set(0.6, -0.65, -0.25).transformDirection(spineM);
      this.akimboMags(s, model, off, progress);
    } else this.leftHand(s, def, model, progress, this.leftTarget);
    if ((s.action === 'idle' || s.action === 'draw') && !off) {
      // Pistol sprint frees the support hand; drawing grabs it at the end.
      if (hold === 'pistol') leftW = 1 - this.sprintW;
      if (s.action === 'draw') leftW *= smooth(seg(progress, 0.55, 0.95));
    }
    // The melee weapon: swung, or riding on the hip or across the back (the machete stays home
    // while a found weapon is carried).
    const spare = this.models.get('machete');
    if (spare && spare !== meleeModel) spare.root.visible = false;
    meleeModel.root.visible = this.shown;
    if (offModel) offModel.root.visible = this.shown;
    const grips = this.grips;
    grips.right = grips.left = null;
    grips.support = 0;
    grips.place = 1;
    if (s.action === 'melee' && !clubbing && offModel) {
      // A blade in each hand: one cuts while the other waits in guard; each hand on its own grip.
      const t = swingClock(progress, meleeId);
      this.swingPose(this.dualLeft ? DUAL_GUARD_R : DUAL_SWING, t, meleeModel.root.position, meleeModel.root.quaternion, grips.hintR);
      this.swingPose(this.dualLeft ? DUAL_SWING_L : DUAL_GUARD_L, t, offModel.root.position, offModel.root.quaternion, grips.hintL);
      grips.right = meleeModel;
      grips.left = offModel;
      leftW = 1;
    } else if (s.action === 'melee' && !clubbing) {
      this.swingPose(style.keys, swingClock(progress, meleeId), meleeModel.root.position, meleeModel.root.quaternion, grips.hintR);
      grips.right = meleeModel;
      // The other hand on the grip below the right.
      if (style.twoHands) {
        grips.support = 1;
        leftW = 1;
      }
    } else if (out) {
      // Held out, ready to swing (the swing's own first key), brought from the holster on a draw.
      const lift = s.action === 'draw' ? smooth(seg(progress, 0.05, 0.9)) : 1;
      const readyKeys = offModel ? DUAL_GUARD_R : style.keys;
      this.swingPose(readyKeys, 0, this.tmpA, this.tmpQ, grips.hintR);
      this.holsterPose(style.holster, meleeModel.root.position, meleeModel.root.quaternion);
      meleeModel.root.position.lerp(this.tmpA, lift);
      meleeModel.root.quaternion.slerp(this.tmpQ, lift);
      grips.hintR.exact = lift >= 1;
      grips.right = meleeModel;
      // The hand closes on it in the holster before it moves.
      grips.place = smooth(seg(lift, 0, 0.3));
      leftW = 0;
      if (offModel) {
        this.swingPose(DUAL_GUARD_L, 0, this.tmpA, this.tmpQ, grips.hintL);
        this.holsterPose('blade2', offModel.root.position, offModel.root.quaternion);
        offModel.root.position.lerp(this.tmpA, lift);
        offModel.root.quaternion.slerp(this.tmpQ, lift);
        grips.hintL.exact = lift >= 1;
        grips.left = offModel;
        leftW = 1;
      } else if (style.twoHands) {
        grips.support = lift;
        leftW = lift;
      }
    } else {
      this.holsterPose(style.holster, meleeModel.root.position, meleeModel.root.quaternion);
      meleeModel.root.updateMatrixWorld(true);
      if (offModel) {
        // Crossed on the back.
        this.holsterPose('blade2', offModel.root.position, offModel.root.quaternion);
        offModel.root.updateMatrixWorld(true);
      }
    }
    for (const m of [grips.right, grips.left]) {
      if (!m) continue;
      m.root.updateMatrixWorld(true);
      // Until the hands are solved (or if something else has them), they go for the grips.
      m.root.localToWorld((m === grips.left ? this.leftTarget : this.rightTarget).set(0, 0, 0));
    }
    if (grips.right && grips.support > 0) grips.right.root.localToWorld(this.leftTarget.copy(grips.right.fore));
    if (s.action === 'bandage') {
      // Wrap the left forearm: left arm across the chest, right hand circling it.
      const t = this.time * Math.PI * 2 * 1.5;
      const settle = smooth(seg(progress, 0, 0.12)) * (1 - smooth(seg(progress, 0.9, 1)));
      spine.localToWorld(this.leftTarget.set(0.02, 0.26, 0.3));
      spine.localToWorld(this.tmpA.set(-0.06 + Math.sin(t * 0.5) * 0.03, 0.27 + Math.sin(t) * 0.055, 0.27 + Math.cos(t) * 0.055));
      this.rightTarget.lerp(this.tmpA, settle);
      this.poleL.set(0.5, -0.8, -0.2).transformDirection(spineM);
      this.bandageRoll.visible = settle > 0.3;
      this.bandageRoll.position.copy(this.rightTarget);
      this.bandageRoll.quaternion.copy(this.spineQ);
      leftW = settle;
    } else {
      this.bandageRoll.visible = false;
    }
    let injectQ: THREE.Quaternion | null = null;
    if (injecting) {
      // From the gun's grip to the syringe and back to it at the end (then the draw takes over).
      this.keyPose(INJECT_KEYS, progress, this.tmpA, _iq);
      const settle = smooth(seg(progress, 0, 0.12)) * (1 - smooth(seg(progress, 0.9, 1)));
      this.rightTarget.lerp(this.tmpA, settle);
      this.poleR.set(-0.9, -0.35, -0.25).transformDirection(spineM);
      // The other hand meets the needle end and pulls the cap off.
      this.leftTarget.copy(this.tmpA).addScaledVector(_ld.set(0, 0, 0.14).applyQuaternion(_iq), 1);
      this.poleL.set(0.6, -0.7, -0.1).transformDirection(spineM);
      leftW = smooth(seg(progress, 0.06, 0.17)) * (1 - smooth(seg(progress, 0.25, 0.36)));
      injectQ = _iq;
    }
    if (limb || clubbing) leftW = this.holdLimb(dt, s, limb, progress, spineM);
    this.throwW = throwing ? Math.min(1, this.throwW + dt * 8) : 0;
    const kind = s.action === 'throw' ? s.throwKind ?? 'frag' : input.priming ?? null;
    let inHand: ThrowableModel | null = null;
    if (throwing && kind) {
      // Overarm: the other arm points where it is going while winding up.
      const t = s.action === 'throw' ? progress * THROWING.duration : 0;
      this.keyPose(THROW_KEYS, t, this.tmpA, this.tmpQ);
      this.rightTarget.lerp(this.tmpA, this.throwW);
      this.poleR.set(-0.9, -0.2, -0.5).transformDirection(spineM);
      const point = s.action === 'throw' ? 1 - smooth(seg(t, THROWING.release, 0.55)) : 0.6;
      spine.localToWorld(this.leftTarget.set(0.16, 0.42, 0.46));
      this.poleL.set(0.8, -0.5, -0.1).transformDirection(spineM);
      leftW = point * this.throwW;
      if (s.action !== 'throw' || t < THROWING.release) {
        inHand = this.throwModel(kind);
        inHand.root.position.copy(this.rightTarget).addScaledVector(_ld.set(0, 0.03, 0.04).applyQuaternion(this.tmpQ), 1);
        inHand.root.quaternion.copy(this.tmpQ);
      }
    }
    for (const m of this.throwModels.values()) {
      m.root.visible = m === inHand && this.shown;
      if (m.root.visible) m.root.updateMatrixWorld(true);
    }
    this.shooterW = ease(this.shooterW, model.sight && s.action === 'idle' && !limb && !throwing ? ads : 0, 20);
    if (this.shooterW > 0.001) this.shooterArms(model, hold, this.shooterW, leftW);
    if (this.wheelW > 0) {
      // Hands on the rim, elbows down and out.
      const k = this.wheelW;
      this.rightTarget.lerp(this.wheelR, k);
      this.leftTarget.lerp(this.wheelL, k);
      leftW += (1 - leftW) * k;
      this.poleR.lerp(_ld.set(-0.7, -0.7, 0).transformDirection(spineM), k).normalize();
      this.poleL.lerp(_ld.set(0.7, -0.7, 0).transformDirection(spineM), k).normalize();
    }
    if (bars > 0.001) {
      // Hands on the grips, elbows out and down.
      this.rightTarget.lerp(body.grips.right, bars);
      this.leftTarget.lerp(body.grips.left, bars);
      leftW += (1 - leftW) * bars;
      this.poleR.lerp(_ld.set(-0.75, -0.6, -0.1).transformDirection(spineM), bars).normalize();
      this.poleL.lerp(_ld.set(0.75, -0.6, -0.1).transformDirection(spineM), bars).normalize();
    }
    // A pair: each fist closed round its own gun's grip, the thumb up the back of it, whenever that
    // hand is holding its gun (not swinging a blade, throwing, bandaging, driving...).
    let gripR = 0, gripL = 0;
    if (off) {
      const free = (1 - this.throwW) * (1 - this.wheelW) * (1 - bars) * (s.action === 'bandage' || injecting ? 0 : 1);
      gripR = free * (1 - away);
      gripL = free * (1 - Math.max(this.limbW, this.meleeTwoW, this.outW)) * THREE.MathUtils.clamp(leftW, 0, 1);
      if (gripR > 0.01) this.gripTarget(body.armR, model, this.rightTarget, this.poleR, gripR, -1);
      if (gripL > 0.01) this.gripTarget(body.armL, off, this.leftTarget, this.poleL, gripL, 1);
    }
    // A melee weapon in the hands (and nothing else has them): the hands close on its grips.
    const gripping = !!grips.right && this.wheelW === 0 && bars <= 0.001 && !injecting && !throwing && s.action !== 'bandage';
    const leftOnMelee = gripping && (!!grips.left || grips.support > 0);
    this.gripResults.right = this.gripResults.left = this.gripResults.support = null;
    if (gripping && grips.right) {
      this.holdMelee(grips.right, grips.left, grips.support, grips.place);
      if (!leftOnMelee) body.reach(body.armL, this.leftTarget, this.poleL, leftW);
    } else {
      body.reach(body.armR, this.rightTarget, this.poleR, 1);
      body.reach(body.armL, this.leftTarget, this.poleL, leftW);
    }
    if (gripR > 0.01 && !gripping) this.wrapHand(body.armR, model, gripR);
    if (gripL > 0.01 && !leftOnMelee) this.wrapHand(body.armL, off!, gripL);
    this.holdSyringe(s, injectQ, progress);
    this.lastProgress = progress;
    this.lastAction = s.action;
  }

  /**
   * Closes the hands on the melee weapon(s) at their keyed poses: the lead hand's fist goes round
   * the grip and the weapon is set in it as the arm lands (MeleeGrip.lead); a pair's left blade
   * the same in the left hand; a two-handed weapon's second hand goes round the handle below
   * (MeleeGrip.support, weight `support`). `place` < 1 leaves the weapon partly where the keys put
   * it (still coming out of its holster).
   */
  private holdMelee(right: WeaponModel, left: WeaponModel | null, support: number, place: number): void {
    const body = this.body;
    for (const [m, limb, side] of [[right, body.armR, -1], [left, body.armL, 1]] as const) {
      if (!m) continue;
      const pos = m.root.position, q = m.root.quaternion;
      _hp.copy(pos);
      _hq.copy(q);
      const hint = side < 0 ? this.grips.hintR : this.grips.hintL;
      this.grip.tilt = hint.tilt;
      const r = this.grip.lead(limb, side, pos, q, 1, hint);
      if (place < 1) {
        pos.lerpVectors(_hp, pos, place);
        q.slerpQuaternions(_hq, q, place);
      }
      m.root.updateMatrixWorld(true);
      if (side < 0) this.gripResults.right = r;
      else this.gripResults.left = r;
    }
    if (!left && support > 0.001) {
      this.grip.tilt = this.grips.hintR.tilt;
      this.gripResults.support = this.grip.support(body.armL, 1, right.root.position, right.root.quaternion, right.fore, 0, support);
    }
  }

  /** The syringe in the fist while injecting: cap off, plunger pushed home once the needle is in. */
  private holdSyringe(s: HeldState, q: THREE.Quaternion | null, p: number): void {
    const sy = this.syringe;
    if (!q || !s.injectKind) {
      sy.root.visible = false;
      return;
    }
    if (sy.kind !== s.injectKind) sy.setKind(s.injectKind);
    const arm = this.body.armR;
    arm.end.getWorldPosition(_iw);
    arm.lower.getWorldPosition(_ie);
    // In the fist, a hand's length on from the wrist.
    sy.root.position.copy(_iw).addScaledVector(_ie.subVectors(_iw, _ie).normalize(), 0.075);
    sy.root.quaternion.copy(q);
    sy.setCap(p < 0.24);
    sy.setFill(1 - smooth(seg(p, 0.52, 0.78)));
    sy.setGlow(1);
    sy.root.visible = this.shown && p < 0.96;
    sy.root.updateMatrixWorld(true);
  }

  /**
   * Down the sights: elbows out and down (ADS_ARMS) and each wrist drawn back along its forearm
   * so the palm, not the wrist, is on the grip: the hands wrap round under the gun instead of
   * reaching up across the sights.
   */
  private shooterArms(model: WeaponModel, hold: Hold, w: number, leftW: number): void {
    const arms = ADS_ARMS[hold];
    const body = this.body;
    // Elbows hang the same way however far up or down the gun points.
    _sd.set(0, 0, 1).applyQuaternion(model.root.quaternion);
    _lv.makeRotationY(Math.atan2(_sd.x, _sd.z));
    const pw = body.proneWeight, lying = PRONE_ADS_ARMS[hold];
    _sp.set(...arms.elbowR).normalize().lerp(_sq.set(...lying.elbowR).normalize(), pw);
    this.poleR.lerp(_sp.normalize().applyMatrix4(_lv), w).normalize();
    _sp.set(...arms.elbowL).normalize().lerp(_sq.set(...lying.elbowL).normalize(), pw);
    this.poleL.lerp(_sp.normalize().applyMatrix4(_lv), w).normalize();
    for (const [limb, target, pole] of [[body.armR, this.rightTarget, this.poleR], [body.armL, this.leftTarget, this.poleL]] as const) {
      // A support hand only partly on the gun keeps the rest of its own pose.
      if (limb === body.armL && leftW < 0.999) continue;
      // Where the forearm points with the wrist on the grip, then the wrist back along it.
      body.reach(limb, target, pole, 1);
      limb.end.getWorldPosition(_sd).sub(limb.lower.getWorldPosition(_sp)).normalize();
      target.addScaledVector(_sd, -THREE.MathUtils.lerp(arms.palm, lying.palm, pw) * w);
      // Lying prone the support hand cups the fore-end from underneath.
      if (limb === body.armL && pw > 0.001) target.addScaledVector(_sq.set(0, 1, 0).applyQuaternion(model.root.quaternion), -CUP * pw * w);
    }
  }

  /**
   * Both hands on the severed arm, like a bat: the left at the zombie's wrist, the right just
   * above it. Places the arm and the hand targets; returns the left hand's weight.
   */
  private holdLimb(dt: number, s: HeldState, limb: HeldLimb | null, p: number, spineM: THREE.Matrix4): number {
    const pos = this.limbPos, q = this.limbQ;
    let leftW = 1;
    if (s.action === 'melee') {
      this.keyPose(LIMB_SWING, p * LIMBS.duration, pos, q);
      this.poleR.set(-0.8, -0.4, -0.4).transformDirection(spineM);
    } else {
      this.spinePose(LIMB_READY, pos, q);
      if (this.sprintW > 0.001) {
        this.spinePose(LIMB_CARRY, _lp, _lq);
        pos.lerp(_lp, this.sprintW);
        q.slerp(_lq, this.sprintW);
        leftW = 1 - this.sprintW;
      }
      if (s.action === 'draw' && limb) {
        // Lifting it from where it lay (or from low by the feet) up into the hands.
        if (this.liftId === limb.id) {
          _lp.copy(this.liftPos);
          _lq.copy(this.liftQ);
        } else {
          this.spinePose(LIMB_GRAB, _lp, _lq);
        }
        const w = smooth(seg(p, 0.1, 0.95));
        pos.copy(_lp.lerp(pos, w));
        q.copy(_lq.slerp(q, w));
        leftW *= smooth(seg(p, 0.55, 0.95));
      }
    }
    const m = this.limbModel;
    const scale = limb?.scale ?? 1;
    if (m && limb) {
      m.root.position.copy(pos);
      m.root.quaternion.copy(q);
      m.root.visible = this.shown;
      m.root.updateMatrixWorld(true);
      m.setGore(this.gore);
      m.setWear(limb.wear / limb.maxWear);
      m.updateFlop(dt);
    }
    this.leftTarget.copy(pos);
    this.rightTarget.copy(pos).addScaledVector(_ld.set(0, 0, 1).applyQuaternion(q), LIMB_HANDS * scale);
    return leftW;
  }

  /** Spine-space keyframes at time `t` (`mirror`: on the left side, for the left gun of a pair). */
  private keyPose(keys: { t: number; at: V3; rot: V3 }[], t: number, pos: THREE.Vector3, q: THREE.Quaternion, mirror = false): void {
    let i = 1;
    while (i < keys.length - 1 && t > keys[i].t) i++;
    const a = keys[i - 1], b = keys[i];
    const u = smooth(THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1));
    const m = mirror ? -1 : 1;
    this.body.spine.localToWorld(pos.set(a.at[0] * m, a.at[1], a.at[2]).lerp(_ka.set(b.at[0] * m, b.at[1], b.at[2]), u));
    q.setFromEuler(this.e.set(a.rot[0], a.rot[1] * m, a.rot[2] * m));
    _kq.setFromEuler(this.e.set(b.rot[0], b.rot[1] * m, b.rot[2] * m));
    q.slerp(_kq, u).premultiply(this.spineQ);
  }

  /**
   * The weapon's pose at time `t` of a swing: the arm's pose run along a smooth curve through the
   * keys (swingCurve), so every in-between is an arm a real one could make too, and the weapon
   * where that arm's fist holds it (world space).
   */
  private swingPose(keys: SwingKey[], t: number, pos: THREE.Vector3, q: THREE.Quaternion, hint?: { phi: number; dev: number; tilt: number; exact: boolean }): void {
    const p = this.swingArm;
    p.arm[0] = swingCurve(keys, t, 0);
    p.arm[1] = swingCurve(keys, t, 1);
    p.arm[2] = swingCurve(keys, t, 2);
    p.reach = swingCurve(keys, t, 3);
    p.elbow = swingCurve(keys, t, 4);
    p.turn = swingCurve(keys, t, 5);
    p.flex = swingCurve(keys, t, 6);
    p.dev = swingCurve(keys, t, 7);
    p.tilt = keys[0].tilt;
    armPose(p, keys[0].side, pos, q);
    if (hint) {
      hint.phi = p.flex;
      hint.dev = p.dev;
      hint.tilt = p.tilt;
      hint.exact = true;
    }
    this.body.spine.localToWorld(pos);
    q.premultiply(this.spineQ);
  }
  private readonly swingArm: Required<ArmPose> = { arm: [0, 0, 1], reach: 0.8, elbow: 0, turn: 0, flex: 0, dev: 0, tilt: GRIP.tilt };

  private readonly swayQ = new THREE.Quaternion();
  private e2q(x: number, y: number, z: number): THREE.Quaternion {
    return this.swayQ.setFromEuler(this.e.set(x, y, z));
  }

  private mix(pos: THREE.Vector3, q: THREE.Quaternion, w: number): void {
    this.anchor.lerp(pos, w);
    this.quat.slerp(q, w);
  }

  /** A spine-space pose (`mirror`: across to the left side, for the left gun of a pair). */
  private spinePose(p: PoseDef, pos: THREE.Vector3, q: THREE.Quaternion, mirror = false): void {
    const m = mirror ? -1 : 1;
    this.body.spine.localToWorld(pos.set(p.at[0] * m, p.at[1], p.at[2]));
    const r = p.rot ?? [0, 0, 0];
    q.setFromEuler(this.e.set(r[0], r[1] * m, r[2] * m)).premultiply(this.spineQ);
  }

  /** A point in the body's frame (prone holds), lifted with a diving body. */
  private bodyPoint(at: V3, out: THREE.Vector3): THREE.Vector3 {
    return this.body.root.localToWorld(out.set(at[0], at[1] + this.body.proneLift, at[2]));
  }

  /** A pose in the body's frame (prone holds; `mirror`: across to the left side, for the left gun of a pair). */
  private bodyPose(p: PoseDef, pos: THREE.Vector3, q: THREE.Quaternion, mirror = false): void {
    const m = mirror ? -1 : 1;
    this.bodyPoint(_mv.set(p.at[0] * m, p.at[1], p.at[2]).toArray() as V3, pos);
    const r = p.rot ?? [0, 0, 0];
    q.setFromEuler(this.e.set(r[0], r[1] * m, r[2] * m)).premultiply(this.rootQ);
  }

  private holsterPose(kind: keyof typeof HOLSTERS, pos: THREE.Vector3, q: THREE.Quaternion): void {
    const h = HOLSTERS[kind];
    const back = kind === 'back' || kind === 'blade' || kind === 'blade2';
    const bone = back ? this.body.spine : kind === 'thigh' ? this.body.legR.upper : kind === 'thighL' ? this.body.legL.upper : this.body.hips;
    pos.copy(h.pos);
    // A rifle slung over a backpack rides on top of it.
    if (back) pos.z -= this.body.backDepth;
    // Lying prone, a slung gun lies flat along the back instead of standing up off it.
    const pw = back ? this.body.proneWeight : 0;
    pos.z += 0.07 * pw;
    bone.localToWorld(pos);
    bone.getWorldQuaternion(q);
    if (pw > 0.001) _pq.copy(q).multiply(kind === 'back' ? FLAT_BACK : kind === 'blade2' ? FLAT_BLADE2 : FLAT_BLADE);
    q.multiply(h.quat);
    if (pw > 0.001) q.slerp(_pq, pw);
  }

  private swingTwist(s: HeldState): number {
    if (s.action !== 'melee' || s.actionTotal <= 0) return 0;
    const p = THREE.MathUtils.clamp(1 - s.actionT / s.actionTotal, 0, 1);
    if (s.meleeWith === 'limb') {
      const t = p * LIMBS.duration;
      for (let i = 1; i < LIMB_SWING.length; i++) {
        if (t <= LIMB_SWING[i].t) {
          const a = LIMB_SWING[i - 1], b = LIMB_SWING[i];
          return THREE.MathUtils.lerp(a.twist, b.twist, smooth((t - a.t) / (b.t - a.t)));
        }
      }
      return 0;
    }
    const id = this.meleeOf(s);
    const keys = id === 'katanas' && this.dualLeft ? DUAL_SWING_L : STYLES[MELEE[id].style].keys;
    return swingCurve(keys, swingClock(p, id), V_TWIST);
  }

  private throwTwist(s: HeldState, input: HandsInput): number {
    if (s.action !== 'throw') return input.priming ? THROW_KEYS[0].twist : 0;
    const t = (1 - s.actionT / Math.max(0.01, s.actionTotal)) * THROWING.duration;
    for (let i = 1; i < THROW_KEYS.length; i++) {
      if (t <= THROW_KEYS[i].t) {
        const a = THROW_KEYS[i - 1], b = THROW_KEYS[i];
        return THREE.MathUtils.lerp(a.twist, b.twist, smooth((t - a.t) / (b.t - a.t)));
      }
    }
    return 0;
  }

  private throwModel(kind: ThrowKind): ThrowableModel {
    let m = this.throwModels.get(kind);
    if (!m) {
      m = createThrowableModel(kind);
      this.throwModels.set(kind, m);
      this.scene.add(m.root);
      this.onMaterials?.(m.materials);
    }
    return m;
  }

  /** Where the Molotov's rag is while in the hand (null when nothing is held ready). */
  wickWorld(out: THREE.Vector3): THREE.Vector3 | null {
    const m = this.throwModels.get('molotov');
    if (!m || !m.root.visible) return null;
    return m.root.localToWorld(out.copy(m.wick));
  }

  /** Left wrist target for the current action (support grip, reload choreography). */
  private leftHand(s: HeldState, def: WeaponDef, m: WeaponModel, p: number, out: THREE.Vector3): void {
    const fore = m.root.localToWorld(this.tmpA.copy(m.fore));
    out.copy(fore);
    if (m.mag) m.mag.visible = true;
    if (m.mag) m.mag.position.copy(m.magRest);
    if (s.action !== 'reload') return;
    const spine = this.body.spine;
    const W = (x: number, y: number, z: number) => m.root.localToWorld(new THREE.Vector3(x, y, z));
    const S = (x: number, y: number, z: number) => spine.localToWorld(new THREE.Vector3(x, y, z));
    const pouch = S(0.12, 0.1, 0.16);
    if (def.perShell) {
      // Shell by shell: pouch → loading port, once per shell.
      const u = THREE.MathUtils.clamp(1 - s.actionT / Math.max(0.01, s.actionTotal), 0, 1);
      const port = W(0.02, -0.03, 0.1);
      const k = u < 0.55 ? smooth(seg(u, 0, 0.55)) : 1 - smooth(seg(u, 0.6, 1));
      out.copy(pouch).lerp(port, k);
      return;
    }
    const magAt = W(m.magRest.x + 0.035, m.magRest.y - 0.07, m.magRest.z);
    const pulled = W(m.magRest.x + 0.04, m.magRest.y - 0.26, m.magRest.z - 0.02);
    const bolt = W(m.bolt.x + 0.02, m.bolt.y, m.bolt.z);
    const keys: { t: number; at: THREE.Vector3 }[] = def.hold === 'pistol'
      ? [{ t: 0, at: fore }, { t: 0.15, at: magAt }, { t: 0.35, at: pouch }, { t: 0.5, at: pouch }, { t: 0.66, at: magAt }, { t: 0.8, at: bolt }, { t: 1, at: fore }]
      : [{ t: 0, at: fore }, { t: 0.16, at: magAt }, { t: 0.3, at: pulled }, { t: 0.42, at: pouch }, { t: 0.52, at: pouch }, { t: 0.68, at: pulled }, { t: 0.74, at: magAt }, { t: 0.86, at: bolt }, { t: 1, at: fore }];
    let i = 1;
    while (i < keys.length - 1 && p > keys[i].t) i++;
    const a = keys[i - 1], b = keys[i];
    out.copy(a.at).lerp(b.at, smooth(THREE.MathUtils.clamp((p - a.t) / (b.t - a.t), 0, 1)));
    if (!m.mag) return;
    // The magazine leaves with the hand, is stowed, and a fresh one goes in.
    const outT = def.hold === 'pistol' ? 0.15 : 0.17;
    const stowT = def.hold === 'pistol' ? 0.3 : 0.42;
    const backT = def.hold === 'pistol' ? 0.5 : 0.52;
    const inT = def.hold === 'pistol' ? 0.66 : 0.74;
    if (p > outT && p < inT) {
      if (p > stowT && p < backT) {
        m.mag.visible = false;
      } else if (def.hold === 'pistol' && p < stowT) {
        // Pistol magazines drop free.
        m.mag.visible = false;
      } else {
        const local = m.root.worldToLocal(this.tmpA.copy(out).add(new THREE.Vector3(0, 0.05, 0)));
        m.mag.position.copy(local).add(new THREE.Vector3(-0.035, 0.02, 0));
      }
    }
  }

  /**
   * Moving parts: the pistol slide cycling after a shot (and held back while `locked`: the gun is
   * empty), the pump racked. `left`: the left gun of a pair (its own slide cycle).
   */
  private animateAction(dt: number, m: WeaponModel, left = false, locked = false): void {
    if (!m.action) return;
    m.action.position.copy(m.actionRest);
    const cycle = left ? this.actionCycleL : this.actionCycle;
    if (cycle < 0) {
      if (locked) m.action.position.z -= SLIDE_TRAVEL;
      return;
    }
    const t = cycle + dt;
    if (left) this.actionCycleL = t;
    else this.actionCycle = t;
    if (left || this.actionKind === 'slide') {
      // Pistol slide: snaps back and returns (or stays back on the last round).
      const k = t < 0.03 ? t / 0.03 : locked ? 1 : 1 - THREE.MathUtils.clamp((t - 0.03) / 0.06, 0, 1);
      m.action.position.z -= k * SLIDE_TRAVEL;
      if (t > 0.1) {
        if (left) this.actionCycleL = -1;
        else this.actionCycle = -1;
      }
      return;
    }
    // Pump: rack back then forward.
    const k = t < 0.12 ? 0 : t < 0.26 ? smooth((t - 0.12) / 0.14) : t < 0.4 ? 1 - smooth((t - 0.26) / 0.14) : 0;
    m.action.position.z -= k * 0.085;
    if (t > 0.42) this.actionCycle = -1;
  }

  /** A handgun with no rounds left has its slide locked back, until a reload's slide release (`release`, 0..1) sends it home. */
  private slideLocked(s: HeldState, rounds: number, release: number, p: number): boolean {
    if (rounds > 0) return false;
    return !(s.action === 'reload' && p >= release);
  }

  /**
   * The left gun of a pair: every pose the right one takes, mirrored to the left side, with its
   * own aim line, its own recoil, and held out beside the right gun's sight line down the sights.
   */
  private placeOffhand(dt: number, off: WeaponModel, s: HeldState, input: HandsInput, p: number, ads: number, kickScale: number): void {
    const poses = POSES.akimbo;
    const pos = this.anchorL, q = this.quatL;
    const mixL = (w: number) => {
      pos.lerp(this.tmpA, w);
      q.slerp(this.tmpQ, w);
    };
    this.spinePose(poses.ready, pos, q, true);
    // Lying prone: the body's own holds, mirrored.
    const pw = this.body.proneWeight, lying = PRONE_POSES.akimbo;
    if (pw > 0.001) {
      this.bodyPose(lying.ready, this.tmpA, this.tmpQ, true);
      mixL(pw);
    }
    if (this.aimW > 0.001) {
      this.body.spine.localToWorld(this.tmpA.set(-poses.aim.at[0], poses.aim.at[1], poses.aim.at[2]));
      if (pw > 0.001) this.tmpA.lerp(this.bodyPoint([-lying.aim.at[0], lying.aim.at[1], lying.aim.at[2]], _od), pw);
      const dir = _od.subVectors(input.aimPoint, this.tmpA);
      if (dir.lengthSq() < 0.25) dir.set(0, 0, 1).applyQuaternion(this.spineQ);
      dir.normalize();
      this.tmpQ.setFromRotationMatrix(_om.lookAt(dir, _o0, _oy));
      mixL(this.aimW);
    }
    if (ads > 0.001 && input.eye && input.view) {
      // Down the sights: out to the left of the crosshair, level with the right gun (its model is
      // mirrored in X, which GRIP_AT, on the middle line, doesn't feel).
      this.twinPose(-1, input, this.recoilL, this.tmpA, this.tmpQ);
      this.tmpA.sub(_tg.copy(GRIP_AT).applyQuaternion(this.tmpQ));
      mixL(ads);
    }
    if (this.sprintW > 0.001) {
      this.spinePose(poses.sprint, this.tmpA, this.tmpQ, true);
      mixL(this.sprintW * (1 - this.aimW));
    }
    if (this.reloadW > 0.001) {
      this.keyPose(AKIMBO_RELOAD.left, s.action === 'reload' ? p : 1, this.tmpA, this.tmpQ, true);
      if (pw > 0.001) {
        this.bodyPose(lying.reload, this.proneAt, _pq, true);
        this.tmpA.lerp(this.proneAt, pw);
        this.tmpQ.slerp(_pq, pw);
      }
      mixL(this.reloadW);
    }
    // Two hands on a long melee weapon, a severed arm, a bike's bars or the melee weapon held out:
    // holstered; otherwise it stays in the left hand.
    const awayL = Math.max(this.limbW, this.meleeTwoW, this.outW, this.body.onBars);
    for (const w of [this.stowW, awayL]) {
      if (w <= 0.001) continue;
      this.holsterPose('thighL', this.tmpA, this.tmpQ);
      mixL(w);
    }
    const r = this.recoilL;
    spring(r, dt);
    const flip = HIP_FLIP * (1 - ads), push = HIP_PUSH * (1 - ads);
    q.multiply(this.tmpQ.setFromEuler(this.e.set(-r.pitch * flip * kickScale, -r.yaw * 0.03, 0)));
    off.root.position.copy(pos).addScaledVector(this.tmpA.set(0, 0, -1).applyQuaternion(q), r.z * push * kickScale);
    off.root.quaternion.copy(q);
    off.root.visible = this.shown && !this.hideHeld;
    off.root.updateMatrixWorld(true);
  }

  /**
   * Moves `target` (the wrist) so the closed hand lands on the gun's grip (GRIP_AT in HAND_GRIP),
   * turned as wrapHand will turn it: solved by trying the arm there and correcting, then put back.
   * `side` +1 left hand, -1 right.
   */
  private gripTarget(limb: Limb, gun: WeaponModel, target: THREE.Vector3, pole: THREE.Vector3, w: number, side: 1 | -1): void {
    _su.copy(limb.upper.quaternion);
    _sl.copy(limb.lower.quaternion);
    gun.root.localToWorld(_gg.copy(GRIP_AT));
    _gt.copy(target);
    for (let i = 0; i < 3; i++) {
      this.body.reach(limb, _gt, pole, 1);
      this.wrapHand(limb, gun, 1);
      limb.end.localToWorld(_gh.set(-side * HAND_GRIP[0], HAND_GRIP[1], HAND_GRIP[2]));
      _gt.add(_gh.subVectors(_gg, _gh));
    }
    limb.upper.quaternion.copy(_su);
    limb.lower.quaternion.copy(_sl);
    limb.upper.updateMatrixWorld(true);
    target.lerp(_gt, w);
  }

  /**
   * Turns the forearm about its own length so the hand's thumb edge runs up the gun's grip
   * (GRIP_UP): the fingers then wrap round the grip instead of the fist lying flat beside it.
   */
  private wrapHand(limb: Limb, gun: WeaponModel, w: number): void {
    limb.lower.getWorldQuaternion(_wq);
    limb.end.getWorldPosition(_wa);
    const f = _wf.subVectors(_wa, limb.lower.getWorldPosition(_wb)).normalize();
    const z = _wz.set(0, 0, 1).applyQuaternion(_wq);
    z.addScaledVector(f, -z.dot(f)).normalize();
    const u = _wu.copy(GRIP_UP).applyQuaternion(gun.root.quaternion);
    u.addScaledVector(f, -u.dot(f));
    if (u.lengthSq() < 1e-6) return;
    u.normalize();
    const turn = Math.atan2(f.dot(_wb.crossVectors(z, u)), z.dot(u));
    // The bone's own +Y runs back up the forearm (-f): a turn about f is the opposite turn about it.
    limb.lower.quaternion.multiply(_wr.setFromAxisAngle(_Y, -turn * w));
    limb.lower.updateMatrixWorld(true);
  }

  /**
   * The pair's first-person feel, once a frame from the camera's own movement: how fast the view
   * turns and pitches (the guns lag behind and swing back on springs), how fast the eye travels
   * (stride phase and pace for the bob) and how fast it rises or drops.
   */
  private twinMotion(dt: number, input: HandsInput): void {
    const f = this.feel;
    if (!input.eye || !input.view || dt <= 0) return;
    if (!f.primed) {
      this.lastEye.copy(input.eye);
      this.lastView.copy(input.view);
      f.primed = true;
    }
    const inv = 1 / Math.max(dt, 1 / 240);
    _tq.copy(this.lastView).invert().multiply(input.view);
    _te.setFromQuaternion(_tq, 'YXZ');
    const clamp = THREE.MathUtils.clamp;
    const yawRate = clamp(_te.y * inv, -12, 12), pitchRate = clamp(_te.x * inv, -12, 12);
    _tv.subVectors(input.eye, this.lastEye);
    const rise = clamp(_tv.y * inv, -6, 6);
    _tv.y = 0;
    // Only steps bob: not riding a board, a bike or a seat, and not a teleport (respawn) of metres in a frame.
    const b = this.body;
    const pace = b.skate || b.bike || b.seat ? 0 : _tv.length() * inv;
    f.speed += ((pace > 12 ? 0 : pace) - f.speed) * (1 - Math.exp(-dt * 8));
    f.phase = (f.phase + dt * f.speed * TWIN_FEEL.bob.stride) % (Math.PI * 4);
    this.lastEye.copy(input.eye);
    this.lastView.copy(input.view);
    const L = TWIN_FEEL.lag;
    // Turning left (positive yaw) leaves the guns to the right, pointing a little right; looking up leaves them low.
    const tx = clamp(yawRate * L.x, -L.max, L.max);
    const ty = clamp(-pitchRate * L.y - rise * TWIN_FEEL.lift, -L.max, L.max);
    const tyaw = clamp(-yawRate * L.yaw, -L.maxRot, L.maxRot);
    const tpitch = clamp(pitchRate * L.pitch, -L.maxRot, L.maxRot);
    // Springs a little under critical damping: the guns overshoot once and settle, like arms do.
    const subs = Math.min(8, Math.ceil(dt * 240)), h = dt / subs;
    for (let i = 0; i < subs; i++) {
      f.vx += (140 * (tx - f.x) - 15 * f.vx) * h; f.x += f.vx * h;
      f.vy += (140 * (ty - f.y) - 15 * f.vy) * h; f.y += f.vy * h;
      f.vyaw += (120 * (tyaw - f.yaw) - 14 * f.vyaw) * h; f.yaw += f.vyaw * h;
      f.vpitch += (120 * (tpitch - f.pitch) - 14 * f.vpitch) * h; f.pitch += f.vpitch * h;
    }
  }

  /**
   * One gun of a pair down the sights (`side` 1 right, -1 left): where its grip goes (world) and
   * how it is turned, from TWIN_ADS plus the lag, bob, breathing and its own kick (`own`, with a
   * little of the other gun's).
   */
  private twinPose(side: 1 | -1, input: HandsInput, own: typeof this.recoil, pos: THREE.Vector3, q: THREE.Quaternion): void {
    const f = this.feel, T = TWIN_ADS, B = TWIN_FEEL.bob, Br = TWIN_FEEL.breath, K = TWIN_FEEL.kick;
    const other = own === this.recoil ? this.recoilL : this.recoil;
    const r = _tk;
    r.z = own.z + other.z * K.other;
    r.pitch = own.pitch + other.pitch * K.other;
    r.yaw = own.yaw;
    const t = this.time;
    const move = THREE.MathUtils.clamp(f.speed / 3.5, 0, 1.3);
    // Each arm a beat apart, so the two guns never move as one block.
    const ph = f.phase + (side < 0 ? 0.45 : 0);
    const still = 1 - 0.7 * Math.min(1, move);
    const b = t * Br.rate + side * 0.9;
    const x = side * T.at[0] + f.x + Math.sin(ph) * B.x * move + Math.sin(t * 0.7 + side) * Br.x * still;
    const y = T.at[1] + f.y - (1 - Math.cos(2 * ph)) * 0.5 * B.y * move + Math.sin(b) * Br.y * still + r.pitch * K.up;
    const z = T.at[2] + r.z * K.back;
    // Gun space after FLIP: +X pitch dips the muzzle, +Y yaw swings it to the screen's left, +Z roll leans the top left.
    const pitch = f.pitch + Math.sin(2 * ph + 0.6) * B.pitch * move + Math.sin(b + 0.5) * Br.pitch * still - r.pitch * K.pitch;
    const yaw = f.yaw + side * T.toe + Math.sin(ph) * 0.4 * B.roll * move + r.yaw * K.yaw;
    const roll = side * (T.cant - r.pitch * K.roll) + Math.sin(ph) * B.roll * move;
    pos.set(x, y, z).applyQuaternion(input.view!).add(input.eye!);
    q.copy(input.view!).multiply(FLIP).multiply(this.e2q(pitch, yaw, roll));
  }

  /** A pair's magazines: each drops free as its muzzle comes up, and the gun is pushed down onto a fresh one at the belt. */
  private akimboMags(s: HeldState, right: WeaponModel, left: WeaponModel, p: number): void {
    for (const [m, side] of [[right, 'right'], [left, 'left']] as const) {
      if (!m.mag) continue;
      m.mag.visible = true;
      m.mag.position.copy(m.magRest);
      if (s.action !== 'reload') continue;
      const k = AKIMBO_TIMES[side];
      if (p > k.drop && p < k.seat - 0.1) m.mag.visible = false;
      else if (p >= k.seat - 0.1 && p < k.seat) m.mag.position.y -= 0.09 * (1 - smooth(seg(p, k.seat - 0.1, k.seat)));
    }
  }

  /**
   * Reload and draw sounds at the animation's milestones (reloadScript.ts). Each goes out CUE_LEAD s
   * before its hit with the time left until it lands, so the take's lead-in plays first and the hit
   * meets the hand. Shell-by-shell reloads start over for every shell.
   */
  private cues(s: HeldState, def: WeaponDef, p: number): void {
    const id = def.id;
    // Taking hold of a severed arm is its own sound, not a gun coming out.
    if (s.action === 'draw' && this.lastAction !== 'draw' && !s.limb && !s.meleeOut) {
      this.onCue?.('draw', id, 0);
      // A pair: the second gun clears its holster a beat later.
      if (def.hold === 'akimbo') this.onCue?.('draw', id, 0.09);
    }
    if (s.action !== 'reload') return;
    const fresh = this.lastAction !== 'reload';
    if (fresh) this.reloadEmpty = (s.active === 'primary' ? s.primary.mag : s.secondary.mag) === 0;
    // A reload (or the next shell) just begun: everything due so far plays now. Caught halfway
    // (someone else's, first seen mid-reload), it carries on from here.
    const restart = fresh || (!!def.perShell && p < this.lastProgress - 0.2);
    const prev = restart ? (p < 0.25 ? -Infinity : p) : this.lastProgress;
    for (const c of dueCues(id, this.reloadEmpty, prev, p, Math.max(0.05, s.actionTotal))) this.onCue?.(c.cue, id, c.inS);
  }

  /** Hides every weapon model (death, cutscenes). */
  setVisible(v: boolean): void {
    this.shown = v;
    for (const m of this.models.values()) m.root.visible = v;
    if (this.offhand) this.offhand.root.visible = v;
    if (this.limbModel) this.limbModel.root.visible = v;
    if (!v) for (const m of this.throwModels.values()) m.root.visible = false;
    if (!v) this.bandageRoll.visible = false;
    if (!v) this.syringe.root.visible = false;
  }

  dispose(): void {
    for (const m of this.models.values()) m.dispose();
    this.models.clear();
    this.offhand?.dispose();
    this.offhand = null;
    this.limbModel?.dispose();
    this.limbModel = null;
    for (const m of this.throwModels.values()) m.dispose();
    this.throwModels.clear();
    this.bandageRoll.removeFromParent();
    this.bandageRoll.geometry.dispose();
    (this.bandageRoll.material as THREE.Material).dispose();
    this.syringe.dispose();
  }
}

/** How far a pistol slide travels back (cycling, and locked open on an empty gun). */
const SLIDE_TRAVEL = 0.035;

/** Steps a gun's recoil springs (weapon space): kick back, muzzle climb, a little sideways wander. */
function spring(r: { z: number; vz: number; pitch: number; vp: number; yaw: number; vy: number }, dt: number): void {
  const subs = Math.min(12, Math.ceil(dt * 120));
  const h = dt / Math.max(1, subs);
  for (let i = 0; i < subs; i++) {
    r.vz += (-90 * r.z - 14 * r.vz) * h; r.z += r.vz * h;
    r.vp += (-120 * r.pitch - 16 * r.vp) * h; r.pitch += r.vp * h;
    r.vy += (-100 * r.yaw - 15 * r.vy) * h; r.yaw += r.vy * h;
  }
}

const _od = new THREE.Vector3(), _o0 = new THREE.Vector3(), _oy = new THREE.Vector3(0, 1, 0), _om = new THREE.Matrix4();
const _lp = new THREE.Vector3(), _ld = new THREE.Vector3(), _ka = new THREE.Vector3();
const _lq = new THREE.Quaternion(), _kq = new THREE.Quaternion();
const _sd = new THREE.Vector3(), _sp = new THREE.Vector3(), _sq = new THREE.Vector3(), _lv = new THREE.Matrix4();
const _iq = new THREE.Quaternion(), _iw = new THREE.Vector3(), _ie = new THREE.Vector3();
const _pp = new THREE.Vector3(), _pq = new THREE.Quaternion();
const _tg = new THREE.Vector3(), _tv = new THREE.Vector3(), _tq = new THREE.Quaternion(), _te = new THREE.Euler();
const _tk = { z: 0, pitch: 0, yaw: 0 };
const _gg = new THREE.Vector3(), _gt = new THREE.Vector3(), _gh = new THREE.Vector3(), _su = new THREE.Quaternion(), _sl = new THREE.Quaternion();
const _wq = new THREE.Quaternion(), _wr = new THREE.Quaternion(), _wa = new THREE.Vector3(), _wb = new THREE.Vector3(), _wf = new THREE.Vector3();
const _wz = new THREE.Vector3(), _wu = new THREE.Vector3(), _Y = new THREE.Vector3(0, 1, 0);
/** Hip-fire kick of a pair (rad of muzzle flip and m of push per unit of recoil spring). */
const HIP_FLIP = 0.38, HIP_PUSH = 0.07;
const _mv = new THREE.Vector3();
const _hp = new THREE.Vector3(), _hq = new THREE.Quaternion();
