import * as THREE from 'three';
import { LIMBS, type ArmZone, type LimbCut, type ZombieKind } from '@dead-hours/shared';
import { Humanoid, patchWounds, zombieLook, ZOMBIE_LOOKS, type ZombieGait } from './Humanoid';
import { BONE, BONE_COUNT } from './rig';
import { goreMaterial, stumpGeometry, tintGore } from './Gore';

/** What a severed arm looks like: the zombie's own arm, cut out of its body. */
export interface SeveredSpec {
  kind: ZombieKind;
  look: number;
  arm: ArmZone;
  cut: LimbCut;
  /** The zombie's size (brutes are bigger). */
  scale: number;
}

interface ArmGeometry {
  /** Origin at the elbow, hanging down -Y as in the bind pose; skinIndex 0 = forearm, 1 = upper arm. */
  geometry: THREE.BufferGeometry;
  upperLen: number;
  /** Radius of the torn end. */
  radius: number;
}

const gaitOf = (kind: ZombieKind): ZombieGait => (kind === 'runner' || kind === 'brute' ? kind : 'walker');
const cache = new Map<string, ArmGeometry>();

/**
 * Cuts a zombie's arm out of its body mesh: every triangle skinned to the arm's bones (sleeve,
 * skin, hand, whatever it wore there), moved so the elbow is the origin. Cached per look.
 */
function armGeometry(spec: SeveredSpec): ArmGeometry {
  const gait = gaitOf(spec.kind);
  const look = spec.look % ZOMBIE_LOOKS[gait];
  const key = `${gait}:${look}:${spec.arm}:${spec.cut}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const body = new Humanoid(zombieLook(look, gait));
  const src = body.mesh.geometry;
  const upper = spec.arm === 'armL' ? BONE.armLUpper : BONE.armRUpper;
  const lower = spec.arm === 'armL' ? BONE.armLLower : BONE.armRLower;
  const jointOf = (bone: number) => new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(body.mesh.skeleton.boneInverses[bone]).invert());
  const shoulder = jointOf(upper), elbow = jointOf(lower);
  const keep: number[] = spec.cut === 'shoulder' ? [lower, upper] : [lower];
  const pos = src.getAttribute('position'), nor = src.getAttribute('normal'), col = src.getAttribute('color'), pat = src.getAttribute('pattern'), si = src.getAttribute('skinIndex');
  const P: number[] = [], N: number[] = [], C: number[] = [], T: number[] = [], S: number[] = [], W: number[] = [];
  let radius = 0;
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const bone = si.getX(i);
    const k = keep.indexOf(bone);
    if (k < 0) continue;
    for (let j = i; j < i + 3; j++) {
      const x = pos.getX(j) - elbow.x, y = pos.getY(j) - elbow.y, z = pos.getZ(j) - elbow.z;
      P.push(x, y, z);
      N.push(nor.getX(j), nor.getY(j), nor.getZ(j));
      C.push(col.getX(j), col.getY(j), col.getZ(j));
      T.push(pat.getX(j), pat.getY(j), pat.getZ(j), pat.getW(j));
      S.push(k, 0, 0, 0);
      W.push(1, 0, 0, 0);
      // Thickness at the cut: just below the shoulder, or just below the elbow.
      const cutY = spec.cut === 'shoulder' ? shoulder.y - elbow.y : 0;
      if (y < cutY - 0.02 && y > cutY - 0.08) radius = Math.max(radius, Math.hypot(x, z));
    }
  }
  body.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.setAttribute('pattern', new THREE.Float32BufferAttribute(T, 4));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(S, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(W, 4));
  g.computeBoundingSphere();
  const out = { geometry: g, upperLen: shoulder.y - elbow.y, radius: THREE.MathUtils.clamp(radius || 0.05, 0.035, 0.09) };
  cache.set(key, out);
  return out;
}

/** Frees every cached arm (end of a session). */
export function clearSeveredCache(): void {
  for (const a of cache.values()) a.geometry.dispose();
  cache.clear();
}

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3();
/** Forearm length: the wrist (where it is held) below the elbow. */
const FORE = 0.29;
/** World-mode root (+Y to the torn end) to held-mode root (+Z to the torn end). */
const TO_HELD = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);

/**
 * A zombie's arm, torn off: its own sleeve and skin and hand, soaked in blood, with a ragged
 * end and the bone sticking out. The elbow of a whole arm is a hinge that flops when swung.
 *
 * 'world': the root is the physics capsule's centre with +Y toward the torn end.
 * 'held': the root is the grip (the wrist, where a survivor's hand closes) with +Z running up
 * the arm toward the torn end, the end you hit with.
 */
export class SeveredArm {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly materials: THREE.MeshStandardMaterial[];
  private readonly fore = new THREE.Bone();
  private readonly upper: THREE.Bone | null = null;
  private readonly stump: THREE.Mesh;
  private readonly skin: THREE.MeshStandardMaterial;
  private readonly gore: THREE.MeshStandardMaterial;
  private readonly wounds = new Float32Array(BONE_COUNT);
  private readonly bloodBase: number;
  private gored = true;
  /** Elbow hinge (held whole arms): angle and its rate. */
  private flop = 0;
  private flopV = 0;
  private stiffness = 1;
  private readonly lastQ = new THREE.Quaternion();
  private primed = false;

  constructor(readonly spec: SeveredSpec, readonly mode: 'world' | 'held') {
    const arm = armGeometry(spec);
    this.skin = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, flatShading: true });
    patchWounds(this.skin, this.wounds);
    this.gore = goreMaterial();
    this.materials = [this.skin, this.gore];
    this.mesh = new THREE.SkinnedMesh(arm.geometry, this.skin);
    const bones = [this.fore];
    this.mesh.add(this.fore);
    if (spec.cut === 'shoulder') {
      this.upper = new THREE.Bone();
      this.fore.add(this.upper);
      bones.push(this.upper);
    }
    this.mesh.updateMatrixWorld(true);
    this.mesh.bind(new THREE.Skeleton(bones));
    // Bones move; the box from the bind pose would cull it while still on screen.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;

    // The torn end faces where the body was.
    const seed = spec.look * 31 + (spec.arm === 'armL' ? 3 : 7) + (spec.cut === 'shoulder' ? 11 : 0);
    this.stump = new THREE.Mesh(stumpGeometry(arm.radius, seed, spec.cut === 'shoulder' ? 1 : 2), this.gore);
    this.stump.rotation.x = Math.PI;
    if (this.upper) {
      this.stump.position.y = arm.upperLen;
      this.upper.add(this.stump);
    } else {
      this.fore.add(this.stump);
    }
    // Freshly torn: soaked near the cut, splashed further down.
    this.bloodBase = 0.55 + (seed % 7) * 0.03;
    this.setWear(1);

    if (mode === 'world') {
      // Capsule centre: the torn end half a length up, a slight bend at the elbow.
      const half = LIMBS.length[spec.cut] / 2;
      this.mesh.position.y = half - (spec.cut === 'shoulder' ? arm.upperLen : 0);
      if (this.upper) this.upper.rotation.x = 0.12 + (seed % 5) * 0.04;
    } else {
      // Grip at the wrist, the arm running up +Z.
      this.mesh.rotation.x = Math.PI / 2;
      this.mesh.position.z = FORE;
    }
    this.root.add(this.mesh);
    this.root.scale.setScalar(spec.scale);
  }

  /** 1 fresh off the body .. 0 about to fall apart: bloodier and looser as it wears. */
  setWear(fraction: number): void {
    const worn = 1 - THREE.MathUtils.clamp(fraction, 0, 1);
    const blood = this.gored ? Math.min(1, this.bloodBase + worn * 0.5) : 0;
    this.wounds[0] = blood;
    this.wounds[1] = Math.min(1, blood + 0.1);
    this.stiffness = 1 - worn * 0.6;
    this.stump.scale.setScalar(1 + worn * 0.35);
  }

  setGore(on: boolean): void {
    if (on === this.gored) return;
    this.gored = on;
    tintGore(this.gore, on);
    this.wounds.fill(on ? this.bloodBase : 0);
  }

  /**
   * World mode: the root pose an arm held by the wrist would need to lie exactly where this one
   * does (picking it up starts from there).
   */
  heldPose(pos: THREE.Vector3, q: THREE.Quaternion): void {
    this.root.updateWorldMatrix(true, true);
    this.mesh.localToWorld(pos.set(0, -FORE, 0));
    this.root.getWorldQuaternion(q).multiply(TO_HELD);
  }

  /** Torn end in world space, and the direction it faces. */
  cutEnd(pos: THREE.Vector3, dir?: THREE.Vector3): THREE.Vector3 {
    this.stump.updateWorldMatrix(true, false);
    pos.setFromMatrixPosition(this.stump.matrixWorld);
    dir?.set(0, -1, 0).transformDirection(this.stump.matrixWorld);
    return pos;
  }

  /**
   * Held whole arms: the upper arm swings on the elbow, thrown by how the grip turns and
   * dragged down by its weight. Call once per frame after the root is placed.
   */
  updateFlop(dt: number): void {
    if (!this.upper || dt <= 0) return;
    this.root.updateWorldMatrix(true, false);
    const q = this.root.getWorldQuaternion(_q);
    if (!this.primed) {
      this.primed = true;
      this.lastQ.copy(q);
    }
    // Turn since last frame in root space (inverse(last) * now): its rate about the hinge (X).
    const d = _q2.copy(this.lastQ).invert().multiply(q);
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const angle = 2 * Math.acos(Math.min(1, d.w));
    const s = Math.sqrt(Math.max(1e-12, 1 - d.w * d.w));
    const wx = angle > 1e-5 ? ((d.x / s) * angle) / dt : 0;
    this.lastQ.copy(q);
    // Gravity pulls the upper arm toward the ground: its direction in root space.
    const down = _v.set(0, -1, 0).applyQuaternion(_q2.copy(q).invert());
    const grav = -down.y * 6;
    const k = 140 * this.stiffness, c = 9;
    const subs = Math.min(8, Math.ceil(dt * 240));
    const h = dt / subs;
    for (let i = 0; i < subs; i++) {
      this.flopV += (-k * this.flop - c * this.flopV + grav - wx * 2.2) * h;
      this.flop += this.flopV * h;
    }
    this.flop = THREE.MathUtils.clamp(this.flop, -0.9, 0.9);
    this.upper.rotation.x = this.flop;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.mesh.skeleton.dispose();
    this.stump.geometry.dispose();
    this.skin.dispose();
    this.gore.dispose();
  }
}
