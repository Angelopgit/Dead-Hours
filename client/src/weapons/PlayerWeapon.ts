import * as THREE from 'three';
import { LIMBS, MELEE, THROWING, WEAPONS, defaultBuild, encodeBuild, isMelee, type HeldLimb, type Loadout, type MeleeId, type MeleeStyle, type ThrowKind, type WeaponDef, type WeaponId } from '@dead-hours/shared';
import type { Humanoid } from '../characters/Humanoid';
import { SeveredArm } from '../characters/Severed';
import { createWeaponModel, type WeaponModel } from './WeaponModels';
import { createThrowableModel, type ThrowableModel } from './ThrowableModels';
import { PUMP_HITS, dueCues } from './reloadScript';
import type { FoleyKind } from '../audio/GunSynth';

/** What the hands are doing, read from the authoritative arsenal (or a network snapshot). */
export interface HeldState {
  primary: { id: WeaponId; mag: number };
  secondary: { id: WeaponId; mag: number };
  active: 'primary' | 'secondary';
  action: 'idle' | 'draw' | 'reload' | 'melee' | 'bandage' | 'throw';
  actionT: number;
  actionTotal: number;
  /** A severed arm in the hands (the guns slung while it is). */
  limb?: HeldLimb | null;
  /** What the current melee swing is made with. */
  meleeWith?: 'machete' | 'limb';
  /** The melee weapon quick swings use: the machete, or one found lying around. */
  meleeId?: WeaponId;
  /** Attachments and finishes on the guns (models are rebuilt when one changes). */
  builds?: Loadout;
  /** What the current throw is. */
  throwKind?: ThrowKind;
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
}

/** Turns camera space (looking down -Z) into weapon space (barrel along +Z). */
const FLIP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

/** Sound cues the animation reaches (reload steps, the pump, holstering): see reloadScript.ts. */
export type WeaponCue = FoleyKind;

type V3 = [number, number, number];
interface PoseDef { at: V3; rot?: V3 }

/** Spine-space poses of the weapon's anchor (stock butt for long guns, grip for pistols). */
export const POSES: Record<'rifle' | 'pistol', Record<'aim' | 'ready' | 'sprint' | 'reload' | 'melee', PoseDef>> = {
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
};

/**
 * Down the sights (first person): which way each elbow goes (the gun's frame turned level: +Z
 * along the barrel, +X the gun's left, +Y up) and how far past the wrist the palm sits on the
 * grip. The hands run on along their forearms (the rig has no wrist joint), so this decides
 * whether they wrap round under the gun or reach up into the sight picture. Tuned against
 * `npm run check:sights`.
 */
export const ADS_ARMS: Record<'rifle' | 'pistol', { elbowR: V3; elbowL: V3; palm: number }> = {
  rifle: { elbowR: [-0.73, -0.27, 0.01], elbowL: [0.5, -0.6, -0.62], palm: 0.084 },
  pistol: { elbowR: [-1.4, -1.1, 0.44], elbowL: [0.16, -0.51, 0.13], palm: 0.071 },
};

/** Machete swing keyframes (spine space): grip position and blade orientation. */
const SWING: { t: number; at: V3; rot: V3; twist: number }[] = [
  { t: 0, at: [-0.2, 0.25, 0.12], rot: [0.5, 0, 0], twist: 0 },
  { t: 0.14, at: [-0.3, 0.58, -0.02], rot: [-2.3, 0.3, 0], twist: -0.45 },
  { t: 0.24, at: [0.2, 0.26, 0.4], rot: [0.45, 0.95, 1.4], twist: 0.5 },
  { t: 0.4, at: [0.18, 0.16, 0.26], rot: [0.9, 1.0, 1.2], twist: 0.35 },
  { t: 0.55, at: [-0.2, 0.22, 0.12], rot: [0.6, 0, 0], twist: 0 },
];

type Key = { t: number; at: V3; rot: V3; twist: number };

/** Katana: both hands, wound up over the right shoulder, a long diagonal cut down across. */
const KATANA_SWING: Key[] = [
  { t: 0, at: [-0.06, 0.24, 0.26], rot: [-0.55, 0.05, 0], twist: 0 },
  { t: 0.2, at: [-0.24, 0.56, 0.04], rot: [-2.25, 0.5, 0.1], twist: -0.5 },
  { t: 0.31, at: [0.04, 0.36, 0.44], rot: [0.15, 0.95, 1.25], twist: 0.45 },
  { t: 0.5, at: [0.26, 0.08, 0.26], rot: [1.05, 1.2, 1.4], twist: 0.5 },
  { t: 1, at: [-0.06, 0.24, 0.26], rot: [-0.55, 0.05, 0], twist: 0 },
];

/**
 * Dual katanas, the right blade's cut (one hand): held low and out in a guard, flicked up over
 * the shoulder and drawn hard across. The left blade cuts the mirror of it, the two in turn.
 */
const DUAL_SWING: Key[] = [
  { t: 0, at: [-0.22, 0.18, 0.26], rot: [0.1, -0.25, 0], twist: 0 },
  { t: 0.22, at: [-0.32, 0.56, 0.02], rot: [-2.2, 0.4, 0.1], twist: -0.4 },
  { t: 0.34, at: [0.02, 0.32, 0.46], rot: [0.2, 0.95, 1.3], twist: 0.45 },
  { t: 0.55, at: [0.22, 0.1, 0.28], rot: [1.0, 1.15, 1.35], twist: 0.4 },
  { t: 1, at: [-0.22, 0.18, 0.26], rot: [0.1, -0.25, 0], twist: 0 },
];
/** The same moves for the other hand: across the body's middle the other way. */
const mirrorKeys = (keys: Key[]): Key[] => keys.map((k) => ({
  t: k.t, at: [-k.at[0], k.at[1], k.at[2]], rot: [k.rot[0], -k.rot[1], -k.rot[2]], twist: -k.twist,
}));
const DUAL_SWING_L = mirrorKeys(DUAL_SWING);
/** The blade not cutting waits in guard. */
const DUAL_GUARD_R: Key[] = [DUAL_SWING[0], { ...DUAL_SWING[0], t: 1 }];
const DUAL_GUARD_L = mirrorKeys(DUAL_GUARD_R);

/** Crowbar and wrench: one hand, raised high behind the head, brought straight down. */
const TOOL_SWING: Key[] = [
  { t: 0, at: [-0.2, 0.25, 0.14], rot: [0.55, 0, 0], twist: 0 },
  { t: 0.2, at: [-0.22, 0.68, -0.02], rot: [-2.55, 0.15, 0], twist: -0.3 },
  { t: 0.36, at: [-0.04, 0.34, 0.5], rot: [0.35, 0.15, 0.1], twist: 0.25 },
  { t: 0.55, at: [-0.02, 0.06, 0.36], rot: [1.25, 0.2, 0.15], twist: 0.2 },
  { t: 1, at: [-0.2, 0.25, 0.14], rot: [0.55, 0, 0], twist: 0 },
];

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
/** Bat and hockey stick: the same big two-handed swing as an arm, in that weapon's own time. */
const CLUB_SWING: Key[] = LIMB_SWING.map((k) => ({ ...k, t: k.t / LIMBS.duration }));
/** The machete's swing on a 0..1 clock. */
const BLADE_SWING: Key[] = SWING.map((k) => ({ ...k, t: k.t / SWING[SWING.length - 1].t }));

/**
 * Each style's keyframes (0..1 of the swing) and where in them the blow lands; a weapon with a
 * quicker or slower windup has its swing stretched so the blade meets the zombie when the hit does.
 */
const STYLES: Record<MeleeStyle, { keys: Key[]; impact: number; twoHands: boolean; holster: 'hip' | 'blade' }> = {
  blade: { keys: BLADE_SWING, impact: MELEE.machete.windup / MELEE.machete.duration, twoHands: false, holster: 'hip' },
  katana: { keys: KATANA_SWING, impact: 0.28, twoHands: true, holster: 'blade' },
  club: { keys: CLUB_SWING, impact: LIMBS.windup / LIMBS.duration, twoHands: true, holster: 'blade' },
  tool: { keys: TOOL_SWING, impact: 0.3, twoHands: false, holster: 'hip' },
  // A blade in each hand: the gun is put away and both are out for the swing.
  dual: { keys: DUAL_SWING, impact: 0.3, twoHands: true, holster: 'blade' },
};

/** Swing progress 0..1 to keyframe time, so the weapon's impact key lands on its windup. */
function swingClock(p: number, id: MeleeId): number {
  const d = MELEE[id];
  const st = STYLES[d.style];
  const w = d.windup / d.duration;
  return p < w ? (p / w) * st.impact : st.impact + ((p - w) / (1 - w)) * (1 - st.impact);
}
/**
 * Overarm throw (spine space): the right hand brings it up, cocks it back over the shoulder,
 * whips it forward and lets go at THROWING.release, follows through across the body.
 */
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
  private primaryId: WeaponId | null = null;
  private secondaryId: WeaponId | null = null;
  private aimW = 0;
  private sprintW = 0;
  private reloadW = 0;
  private meleeW = 0;
  /** The gun put away for a two-handed swing (katana, bat, hockey stick). */
  private meleeTwoW = 0;
  private meleeShown: MeleeId = 'machete';
  /** Dual katanas: the left blade cuts this swing (they take turns). */
  private dualLeft = true;
  private stowW = 0;
  private raised = 0;
  private readonly recoil = { z: 0, vz: 0, pitch: 0, vp: 0, yaw: 0, vy: 0 };
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

  constructor(private readonly scene: THREE.Object3D, private readonly body: Humanoid) {
    const g = new THREE.CylinderGeometry(0.03, 0.03, 0.07, 8).rotateZ(Math.PI / 2);
    this.bandageRoll = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.95 }));
    this.bandageRoll.visible = false;
    scene.add(this.bandageRoll);
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

  materials(): THREE.Material[] {
    return [...[...this.models.values()].flatMap((m) => m.materials), this.bandageRoll.material as THREE.Material];
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
  }

  /** A round left the active weapon. */
  fired(def: WeaponDef): void {
    const r = this.recoil;
    const k = def.recoil;
    r.vz += 1.6 + k * 1.4;
    r.vp += 3.5 + k * 6;
    r.vy += (Math.random() - 0.5) * k * 3;
    this.raised = 0.7;
    if (def.id === 'shotgun') {
      this.actionCycle = 0;
      this.actionKind = 'pump';
      this.pumpCues(0);
    } else if (def.id === 'pistol') {
      this.actionCycle = 0;
      this.actionKind = 'slide';
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

  /** The gun in the hands (null while they hold a severed arm). */
  get heldModel(): WeaponModel | null {
    return this.held;
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
    const m = this.held;
    if (!m) return this.body.armR.end.getWorldPosition(out);
    return m.root.localToWorld(out.copy(m.muzzle));
  }

  /** Barrel direction (world). */
  muzzleDir(out: THREE.Vector3): THREE.Vector3 {
    const m = this.held;
    if (!m) return out.set(0, 0, 1);
    return out.set(0, 0, 1).applyQuaternion(m.root.quaternion);
  }

  ejectWorld(out: THREE.Vector3, dir: THREE.Vector3): void {
    const m = this.held;
    if (!m) return;
    m.root.localToWorld(out.copy(m.eject));
    dir.set(-1, 0.6, -0.2).normalize().applyQuaternion(m.root.quaternion);
  }

  /** Call after Humanoid.update (body pose final) and before rendering. */
  update(dt: number, s: HeldState, input: HandsInput): void {
    this.time += dt;
    const body = this.body;
    if (s.builds && s.builds !== this.builds) {
      this.builds = s.builds;
      this.ensure(s.primary.id);
      this.ensure(s.secondary.id);
    }
    this.setLoadout(s.primary.id, s.secondary.id);
    const activeId = s.active === 'primary' ? s.primary.id : s.secondary.id;
    const def = WEAPONS[activeId];
    const model = this.ensure(activeId);
    const hold = def.hold === 'pistol' ? 'pistol' : 'rifle';
    const poses = POSES[hold];
    const progress = s.actionTotal > 0 ? THREE.MathUtils.clamp(1 - s.actionT / s.actionTotal, 0, 1) : 1;
    if (activeId !== this.lastActive) {
      if (this.lastActive) this.onCue?.('holster', this.lastActive, 0);
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
    const throwing = s.action === 'throw' || (!!input.priming && !limb && s.action !== 'melee' && s.action !== 'bandage');
    const busy = s.action === 'reload' || s.action === 'melee' || s.action === 'bandage' || throwing;
    const aimTarget = busy || s.action === 'draw' ? 0 : Math.max(input.aim, this.raised > 0 ? 1 : 0);
    this.aimW = ease(this.aimW, aimTarget, 16);
    this.sprintW = ease(this.sprintW, input.sprinting && !busy && this.raised <= 0 ? 1 : 0, 9);
    this.reloadW = ease(this.reloadW, s.action === 'reload' ? 1 : 0, 12);
    this.meleeW = ease(this.meleeW, s.action === 'melee' ? 1 : 0, 22);
    this.meleeTwoW = ease(this.meleeTwoW, s.action === 'melee' && !clubbing && style.twoHands ? 1 : 0, 26);
    // Drawing brings the gun out of its holster (not while the draw is getting a grip on an arm).
    const drawing = s.action === 'draw' && !limb;
    const stowTarget = s.action === 'bandage' || throwing ? 1 : drawing ? 1 - smooth(seg(progress, 0.1, 0.85)) : 0;
    this.stowW = drawing ? stowTarget : ease(this.stowW, stowTarget, 9);
    // The gun goes over the shoulder (or into the holster) while the hands hold an arm.
    this.limbW = limb || clubbing ? ease(this.limbW, 1, 14) : 0;

    // Body channels.
    const twistRifle = THREE.MathUtils.lerp(-0.4, -0.55, this.aimW) * (1 - this.sprintW) * (1 - this.stowW) * (1 - this.reloadW * 0.5);
    let twist = hold === 'rifle' ? twistRifle : 0;
    twist *= (1 - this.meleeW) * (1 - this.limbW);
    // Both hands on a long weapon: the gun goes to its holster for the swing.
    const away = Math.max(this.limbW, this.meleeTwoW);

    body.root.updateMatrixWorld(true);
    const spine = body.spine;
    spine.getWorldQuaternion(this.spineQ);
    const stockLocal = model.stock;

    // Ready → aim → sprint → reload → melee → holster.
    this.spinePose(poses.ready, this.anchor, this.quat);
    if (this.aimW > 0.001) {
      spine.localToWorld(this.tmpA.set(...poses.aim.at));
      const dir = new THREE.Vector3().subVectors(input.aimPoint, this.tmpA);
      if (dir.lengthSq() < 0.25) dir.set(0, 0, 1).applyQuaternion(this.spineQ);
      dir.normalize();
      this.tmpQ.setFromRotationMatrix(new THREE.Matrix4().lookAt(dir, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)));
      this.mix(this.tmpA, this.tmpQ, this.aimW);
    }
    const ads = busy ? 0 : input.ads ?? 0;
    if (ads > 0.001 && model.sight && input.eye && input.view) {
      // Down the sights: the sight line on the camera axis, the stock wherever that puts it,
      // with a slow breathing sway.
      const t = this.time;
      this.tmpQ.copy(input.view).multiply(FLIP)
        .multiply(this.e2q(Math.sin(t * 1.3) * 0.0016, Math.sin(t * 0.9 + 1) * 0.002, 0));
      this.tmpA.copy(stockLocal).sub(model.sight.eye).applyQuaternion(this.tmpQ).add(input.eye);
      this.mix(this.tmpA, this.tmpQ, ads);
    }
    body.headHidden = ads > 0.35;
    if (this.sprintW > 0.001) {
      this.spinePose(poses.sprint, this.tmpA, this.tmpQ);
      this.mix(this.tmpA, this.tmpQ, this.sprintW * (1 - this.aimW));
    }
    if (this.reloadW > 0.001) {
      this.spinePose(poses.reload, this.tmpA, this.tmpQ);
      this.mix(this.tmpA, this.tmpQ, this.reloadW);
    }
    if (this.meleeW > 0.001) {
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
    const subs = Math.min(12, Math.ceil(dt * 120));
    const h = dt / Math.max(1, subs);
    for (let i = 0; i < subs; i++) {
      r.vz += (-90 * r.z - 14 * r.vz) * h; r.z += r.vz * h;
      r.vp += (-120 * r.pitch - 16 * r.vp) * h; r.pitch += r.vp * h;
      r.vy += (-100 * r.yaw - 15 * r.vy) * h; r.yaw += r.vy * h;
    }
    const kickScale = 0.5 + 0.5 * this.aimW;
    this.quat.multiply(this.tmpQ.setFromEuler(this.e.set(-r.pitch * 0.05 * kickScale, r.yaw * 0.03, 0)));
    const rootPos = model.root.position;
    rootPos.copy(stockLocal).applyQuaternion(this.quat).negate().add(this.anchor);
    rootPos.addScaledVector(this.tmpA.set(0, 0, -1).applyQuaternion(this.quat), r.z * 0.022 * kickScale);
    model.root.quaternion.copy(this.quat);
    model.root.visible = this.shown && !this.hideHeld;
    model.root.updateMatrixWorld(true);
    body.kick = -r.pitch * 0.012;
    body.twist = twist + this.swingTwist(s) + this.throwTwist(s, input);

    // Moving parts.
    this.animateAction(dt, model);

    // Holstered weapons.
    for (const [id, m] of this.models) {
      if (m === model) continue;
      if (WEAPONS[id].slot === 'melee') continue;
      m.root.visible = this.shown;
      this.holsterPose(WEAPONS[id].slot === 'primary' ? 'back' : 'thigh', m.root.position, m.root.quaternion);
      m.root.updateMatrixWorld(true);
    }
    this.held = this.limbW > 0.5 ? null : model;

    // Hands.
    const spineM = spine.matrixWorld;
    this.poleR.set(-0.6, -0.65, -0.25).transformDirection(spineM);
    this.poleL.set(0.6, -0.7, -0.1).transformDirection(spineM);
    model.root.localToWorld(this.rightTarget.set(0, 0, 0));
    let leftW = 1;
    this.leftHand(s, def, model, progress, this.leftTarget);
    if (s.action === 'idle' || s.action === 'draw') {
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
    if (s.action === 'melee' && !clubbing && offModel) {
      // A blade in each hand: one cuts while the other waits in guard; each hand on its own grip.
      const t = swingClock(progress, meleeId);
      this.keyPose(this.dualLeft ? DUAL_GUARD_R : DUAL_SWING, t, meleeModel.root.position, meleeModel.root.quaternion);
      this.keyPose(this.dualLeft ? DUAL_SWING_L : DUAL_GUARD_L, t, offModel.root.position, offModel.root.quaternion);
      meleeModel.root.updateMatrixWorld(true);
      offModel.root.updateMatrixWorld(true);
      meleeModel.root.localToWorld(this.rightTarget.set(0, 0, 0));
      offModel.root.localToWorld(this.leftTarget.set(0, 0, 0));
      this.poleR.set(-0.8, -0.4, -0.4).transformDirection(spineM);
      this.poleL.set(0.8, -0.4, -0.4).transformDirection(spineM);
      leftW = 1;
    } else if (s.action === 'melee' && !clubbing) {
      this.keyPose(style.keys, swingClock(progress, meleeId), meleeModel.root.position, meleeModel.root.quaternion);
      meleeModel.root.updateMatrixWorld(true);
      meleeModel.root.localToWorld(this.rightTarget.set(0, 0, 0));
      this.poleR.set(-0.8, -0.4, -0.4).transformDirection(spineM);
      if (style.twoHands) {
        // The other hand on the grip below the right.
        meleeModel.root.localToWorld(this.leftTarget.copy(meleeModel.fore));
        this.poleL.set(0.7, -0.5, -0.3).transformDirection(spineM);
        leftW = 1;
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
    body.reach(body.armR, this.rightTarget, this.poleR, 1);
    body.reach(body.armL, this.leftTarget, this.poleL, leftW);
    this.lastProgress = progress;
    this.lastAction = s.action;
  }

  /**
   * Down the sights: elbows out and down (ADS_ARMS) and each wrist drawn back along its forearm
   * so the palm, not the wrist, is on the grip: the hands wrap round under the gun instead of
   * reaching up across the sights.
   */
  private shooterArms(model: WeaponModel, hold: 'rifle' | 'pistol', w: number, leftW: number): void {
    const arms = ADS_ARMS[hold];
    const body = this.body;
    // Elbows hang the same way however far up or down the gun points.
    _sd.set(0, 0, 1).applyQuaternion(model.root.quaternion);
    _lv.makeRotationY(Math.atan2(_sd.x, _sd.z));
    this.poleR.lerp(_sp.set(...arms.elbowR).normalize().applyMatrix4(_lv), w).normalize();
    this.poleL.lerp(_sp.set(...arms.elbowL).normalize().applyMatrix4(_lv), w).normalize();
    for (const [limb, target, pole] of [[body.armR, this.rightTarget, this.poleR], [body.armL, this.leftTarget, this.poleL]] as const) {
      // A support hand only partly on the gun keeps the rest of its own pose.
      if (limb === body.armL && leftW < 0.999) continue;
      // Where the forearm points with the wrist on the grip, then the wrist back along it.
      body.reach(limb, target, pole, 1);
      limb.end.getWorldPosition(_sd).sub(limb.lower.getWorldPosition(_sp)).normalize();
      target.addScaledVector(_sd, -arms.palm * w);
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

  /** Spine-space keyframes at time `t`, as a world position and rotation. */
  private keyPose(keys: { t: number; at: V3; rot: V3 }[], t: number, pos: THREE.Vector3, q: THREE.Quaternion): void {
    let i = 1;
    while (i < keys.length - 1 && t > keys[i].t) i++;
    const a = keys[i - 1], b = keys[i];
    const u = smooth(THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1));
    this.body.spine.localToWorld(pos.set(...a.at).lerp(_ka.set(...b.at), u));
    q.setFromEuler(this.e.set(...a.rot));
    _kq.setFromEuler(this.e.set(...b.rot));
    q.slerp(_kq, u).premultiply(this.spineQ);
  }

  private readonly swayQ = new THREE.Quaternion();
  private e2q(x: number, y: number, z: number): THREE.Quaternion {
    return this.swayQ.setFromEuler(this.e.set(x, y, z));
  }

  private mix(pos: THREE.Vector3, q: THREE.Quaternion, w: number): void {
    this.anchor.lerp(pos, w);
    this.quat.slerp(q, w);
  }

  private spinePose(p: PoseDef, pos: THREE.Vector3, q: THREE.Quaternion): void {
    this.body.spine.localToWorld(pos.set(...p.at));
    const r = p.rot ?? [0, 0, 0];
    q.setFromEuler(this.e.set(r[0], r[1], r[2])).premultiply(this.spineQ);
  }

  private holsterPose(kind: keyof typeof HOLSTERS, pos: THREE.Vector3, q: THREE.Quaternion): void {
    const h = HOLSTERS[kind];
    const bone = kind === 'back' || kind === 'blade' || kind === 'blade2' ? this.body.spine : kind === 'thigh' ? this.body.legR.upper : this.body.hips;
    pos.copy(h.pos);
    // A rifle slung over a backpack rides on top of it.
    if (kind === 'back' || kind === 'blade' || kind === 'blade2') pos.z -= this.body.backDepth;
    bone.localToWorld(pos);
    bone.getWorldQuaternion(q).multiply(h.quat);
  }

  private swingTwist(s: HeldState): number {
    if (s.action !== 'melee' || s.actionTotal <= 0) return 0;
    const club = s.meleeWith === 'limb';
    const p = THREE.MathUtils.clamp(1 - s.actionT / s.actionTotal, 0, 1);
    const id = this.meleeOf(s);
    const keys = club ? LIMB_SWING : id === 'katanas' && this.dualLeft ? DUAL_SWING_L : STYLES[MELEE[id].style].keys;
    const t = club ? p * LIMBS.duration : swingClock(p, id);
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) {
        const a = keys[i - 1], b = keys[i];
        return THREE.MathUtils.lerp(a.twist, b.twist, smooth((t - a.t) / (b.t - a.t)));
      }
    }
    return 0;
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

  private animateAction(dt: number, m: WeaponModel): void {
    if (!m.action) return;
    m.action.position.copy(m.actionRest);
    if (this.actionCycle < 0) return;
    this.actionCycle += dt;
    const t = this.actionCycle;
    if (this.actionKind === 'slide') {
      // Pistol slide: snaps back and returns.
      const k = t < 0.03 ? t / 0.03 : 1 - THREE.MathUtils.clamp((t - 0.03) / 0.06, 0, 1);
      m.action.position.z -= k * 0.035;
      if (t > 0.1) this.actionCycle = -1;
      return;
    }
    // Pump: rack back then forward.
    const k = t < 0.12 ? 0 : t < 0.26 ? smooth((t - 0.12) / 0.14) : t < 0.4 ? 1 - smooth((t - 0.26) / 0.14) : 0;
    m.action.position.z -= k * 0.085;
    if (t > 0.42) this.actionCycle = -1;
  }

  /**
   * Reload and draw sounds at the animation's milestones (reloadScript.ts). Each goes out CUE_LEAD s
   * before its hit with the time left until it lands, so the take's lead-in plays first and the hit
   * meets the hand. Shell-by-shell reloads start over for every shell.
   */
  private cues(s: HeldState, def: WeaponDef, p: number): void {
    const id = def.id;
    // Taking hold of a severed arm is its own sound, not a gun coming out.
    if (s.action === 'draw' && this.lastAction !== 'draw' && !s.limb) this.onCue?.('draw', id, 0);
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
    if (this.limbModel) this.limbModel.root.visible = v;
    if (!v) for (const m of this.throwModels.values()) m.root.visible = false;
    if (!v) this.bandageRoll.visible = false;
  }

  dispose(): void {
    for (const m of this.models.values()) m.dispose();
    this.models.clear();
    this.limbModel?.dispose();
    this.limbModel = null;
    for (const m of this.throwModels.values()) m.dispose();
    this.throwModels.clear();
    this.bandageRoll.removeFromParent();
    this.bandageRoll.geometry.dispose();
    (this.bandageRoll.material as THREE.Material).dispose();
  }
}

const _lp = new THREE.Vector3(), _ld = new THREE.Vector3(), _ka = new THREE.Vector3();
const _lq = new THREE.Quaternion(), _kq = new THREE.Quaternion();
const _sd = new THREE.Vector3(), _sp = new THREE.Vector3(), _lv = new THREE.Matrix4();
