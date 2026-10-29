import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { HitZone } from '@dead-hours/shared';
import { chain } from '../lighting/BakeShader';

export interface HumanoidLook {
  skin: number;
  top: number;
  pants: number;
  shoes: number;
  hair?: number;
  /** Zombies: hunched posture, reaching arms, limp. */
  zombie?: boolean;
  /** Optional accessory color (backpack / vest). */
  vest?: number;
}

export interface LocomotionState {
  /** Horizontal speed in m/s. */
  speed: number;
  /** 0 standing .. 1 fully crouched. */
  crouch: number;
  /** 0..1 aim pose blend. */
  aim: number;
  grounded: boolean;
  /** Body-relative lateral velocity sign for strafing lean (-1..1). */
  strafe: number;
  /** Direction of travel relative to the body's facing (radians, 0 = forward). */
  moveAngle?: number;
  /** Signed turn speed of the body in rad/s (turn-in-place shuffle). */
  turn?: number;
}

export interface Limb {
  upper: THREE.Bone;
  lower: THREE.Bone;
  /** Wrist / ankle: end of the lower segment. */
  end: THREE.Object3D;
  upperLen: number;
  lowerLen: number;
}

/**
 * Bone order of the skeleton (skinIndex values). The character faces +Z, so local +X is its
 * left side: armL/legL sit at +X.
 */
export const BONE = {
  hips: 0, spine: 1, head: 2,
  armLUpper: 3, armLLower: 4, armRUpper: 5, armRLower: 6,
  legLUpper: 7, legLLower: 8, legRUpper: 9, legRLower: 10,
} as const;
const BONE_COUNT = 11;

/** Bones that show wounds for each hit zone. */
export const ZONE_BONES: Record<HitZone, number[]> = {
  head: [BONE.head],
  torso: [BONE.spine, BONE.hips],
  armL: [BONE.armLUpper, BONE.armLLower],
  armR: [BONE.armRUpper, BONE.armRLower],
  legL: [BONE.legLUpper, BONE.legLLower],
  legR: [BONE.legRUpper, BONE.legRLower],
};

/** Damped spring used for hit flinches. */
class Spring {
  x = 0;
  v = 0;
  kick(amount: number): void {
    this.v += amount;
  }
  step(dt: number, k = 170, c = 15): void {
    this.v += (-k * this.x - c * this.v) * dt;
    this.x += this.v * dt;
  }
}

const geometryCache = new Map<string, THREE.BufferGeometry>();

/** Merged, skinned body geometry for a look (shared by every character wearing it). */
function bodyGeometry(look: HumanoidLook, bones: THREE.Bone[]): THREE.BufferGeometry {
  const key = JSON.stringify(look);
  const cached = geometryCache.get(key);
  if (cached) return cached;
  const parts: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  const grime = look.zombie;
  let seed = 0x9e3779b9 ^ key.length * 2654435761;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const add = (g: THREE.BufferGeometry, bone: number, hex: number, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1) => {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute('uv');
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
    geo.applyMatrix4(m.premultiply(bones[bone].matrixWorld));
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    color.setHex(hex);
    for (let i = 0; i < n; i += 3) {
      // Zombies: per-face grime so clothes and skin read as filthy, not flat.
      const k = grime ? 0.72 + rand() * 0.32 : 0.94 + rand() * 0.08;
      for (let j = i; j < i + 3 && j < n; j++) {
        col[j * 3] = color.r * k;
        col[j * 3 + 1] = color.g * k;
        col[j * 3 + 2] = color.b * k;
        si[j * 4] = bone;
        sw[j * 4] = 1;
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    parts.push(geo);
  };

  add(new THREE.CylinderGeometry(0.17, 0.15, 0.2, 6), BONE.hips, look.pants, 0, 0, 0, 1, 1, 0.7);
  add(new THREE.CylinderGeometry(0.21, 0.16, 0.5, 6), BONE.spine, look.top, 0, 0.27, 0, 1, 1, 0.62);
  if (look.vest !== undefined) add(new THREE.BoxGeometry(0.34, 0.36, 0.12), BONE.spine, look.vest, 0, 0.29, -0.15);
  add(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 5), BONE.head, look.skin, 0, -0.04, 0);
  add(new THREE.IcosahedronGeometry(0.13, 1), BONE.head, look.skin, 0, 0.12, 0, 0.9, 1.08, 1);
  if (look.hair !== undefined) add(new THREE.IcosahedronGeometry(0.135, 1), BONE.head, look.hair, 0, 0.18, -0.015, 0.95, 0.75, 1.02);
  const sleeve = look.zombie ? look.skin : look.top;
  for (const [u, l] of [[BONE.armLUpper, BONE.armLLower], [BONE.armRUpper, BONE.armRLower]]) {
    add(new THREE.CylinderGeometry(0.055, 0.045, 0.31, 6), u, look.top, 0, -0.155, 0);
    add(new THREE.CylinderGeometry(0.045, 0.038, 0.29, 6), l, sleeve, 0, -0.145, 0);
    add(new THREE.BoxGeometry(0.07, 0.09, 0.05), l, look.skin, 0, -0.33, 0);
  }
  for (const [u, l] of [[BONE.legLUpper, BONE.legLLower], [BONE.legRUpper, BONE.legRLower]]) {
    add(new THREE.CylinderGeometry(0.08, 0.06, 0.44, 6), u, look.pants, 0, -0.22, 0);
    add(new THREE.CylinderGeometry(0.06, 0.051, 0.44, 6), l, look.pants, 0, -0.22, 0);
    add(new THREE.BoxGeometry(0.1, 0.08, 0.24), l, look.shoes, 0, -0.48, 0.05);
  }
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  geometryCache.set(key, merged);
  return merged;
}

/**
 * Wound shading: each bone carries a 0..1 blood amount; splotchy patches (noise in bind-pose
 * space, so they stick to the body) spread over the surface as the amount grows.
 */
function patchWounds(mat: THREE.MeshStandardMaterial, wounds: Float32Array): void {
  chain(mat, 'wounds', (shader) => {
    shader.uniforms.uWounds = { value: wounds };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uWounds[${BONE_COUNT}];
        varying float vWound;
        varying vec3 vWoundP;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWound = uWounds[int(skinIndex.x + 0.5)];
        vWoundP = position;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vWound;
        varying vec3 vWoundP;
        float wHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float wNoise(vec3 x) {
          vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(wHash(i), wHash(i + vec3(1, 0, 0)), f.x), mix(wHash(i + vec3(0, 1, 0)), wHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(wHash(i + vec3(0, 0, 1)), wHash(i + vec3(1, 0, 1)), f.x), mix(wHash(i + vec3(0, 1, 1)), wHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (vWound > 0.001) {
          float wn = wNoise(vWoundP * 9.0) * 0.65 + wNoise(vWoundP * 23.0) * 0.35;
          float wc = smoothstep(wn - 0.06, wn + 0.06, vWound * 0.95);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.085, 0.007, 0.005) * (0.6 + 0.6 * wn), wc * 0.94);
        }`);
  });
}

/**
 * Low-poly character: one skinned mesh (a single draw call) on an 11-bone rig, animated
 * procedurally (idle, walk, run, crouch, strafe, turn in place, airborne) from one locomotion
 * state. Survivors' arms are placed by two-bone IK onto their weapon; zombies add attack,
 * door bashing, stagger, knockdown and per-zone hit flinches. Ragdolls drive the bones directly.
 */
export class Humanoid {
  readonly root = new THREE.Group();
  readonly hips = new THREE.Bone();
  readonly spine = new THREE.Bone();
  readonly head = new THREE.Bone();
  readonly armL: Limb;
  readonly armR: Limb;
  readonly legL: Limb;
  readonly legR: Limb;
  readonly bones: THREE.Bone[];
  readonly mesh: THREE.SkinnedMesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly eyes: THREE.Mesh | null = null;
  private readonly eyeMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly skeleton: THREE.Skeleton;
  readonly wounds = new Float32Array(BONE_COUNT);
  private phase = Math.random() * 10;
  private smoothed: LocomotionState = { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 };
  /** Fired at each foot plant with a 0..1 loudness. */
  onFootstep: ((loudness: number) => void) | null = null;
  private lastStepSign = 0;
  readonly zombie: boolean;
  private readonly seed = Math.random() * 100;
  private hipYaw = 0;
  private moveDir = 1;
  private shuffle = 0;

  // Upper-body channels, set by the owner every frame.
  /** Camera pitch (up positive); split between spine and head. */
  lookPitch = 0;
  /** Extra spine yaw (bladed stance while shouldering a rifle). */
  twist = 0;
  /** Spine pitch kick from recoil (radians, decays in the owner). */
  kick = 0;

  // Zombie channels.
  /** Swipe progress 0..1, or -1 when not attacking. */
  attack = -1;
  /** Door pounding cycle 0..1, or -1. */
  bash = -1;
  /** Knocked down (0 standing .. 1 lying on its back). */
  downTarget = 0;
  private down = 0;
  /** 0..1 while staggering, with the local direction it was pushed. */
  staggerTarget = 0;
  private stagger = 0;
  private readonly staggerDir = new THREE.Vector2();
  private readonly flinchHead = [new Spring(), new Spring()];
  private readonly flinchTorso = [new Spring(), new Spring()];
  private readonly flinchLimb = [new Spring(), new Spring(), new Spring(), new Spring()];
  /** True while a ragdoll owns the bones. */
  ragdoll = false;

  constructor(look: HumanoidLook) {
    this.zombie = !!look.zombie;
    const limb = (parent: THREE.Bone, x: number, y: number, upperLen: number, lowerLen: number): Limb => {
      const upper = new THREE.Bone();
      upper.position.set(x, y, 0);
      parent.add(upper);
      const lower = new THREE.Bone();
      lower.position.y = -upperLen;
      upper.add(lower);
      const end = new THREE.Object3D();
      end.position.y = -lowerLen;
      lower.add(end);
      return { upper, lower, end, upperLen, lowerLen };
    };
    this.root.add(this.hips);
    this.hips.position.y = 0.95;
    this.hips.add(this.spine);
    this.spine.position.y = 0.08;
    this.spine.add(this.head);
    this.head.position.y = 0.58;
    this.armL = limb(this.spine, 0.22, 0.48, 0.31, 0.29);
    this.armR = limb(this.spine, -0.22, 0.48, 0.31, 0.29);
    this.legL = limb(this.hips, 0.1, -0.04, 0.44, 0.44);
    this.legR = limb(this.hips, -0.1, -0.04, 0.44, 0.44);
    this.bones = [
      this.hips, this.spine, this.head,
      this.armL.upper, this.armL.lower, this.armR.upper, this.armR.lower,
      this.legL.upper, this.legL.lower, this.legR.upper, this.legR.lower,
    ];
    this.root.updateMatrixWorld(true);

    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, flatShading: true });
    patchWounds(this.material, this.wounds);
    this.mesh = new THREE.SkinnedMesh(bodyGeometry(look, this.bones), this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
    this.root.add(this.mesh);
    this.skeleton = new THREE.Skeleton(this.bones);
    this.mesh.bind(this.skeleton);

    if (this.zombie) {
      this.eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xc8d27a, emissiveIntensity: 1.2 });
      const l = new THREE.SphereGeometry(0.014, 4, 3).translate(-0.045, 0.13, 0.12);
      const r = new THREE.SphereGeometry(0.014, 4, 3).translate(0.045, 0.13, 0.12);
      const g = mergeGeometries([l, r])!;
      l.dispose();
      r.dispose();
      this.eyes = new THREE.Mesh(g, this.eyeMaterial);
      this.head.add(this.eyes);
    }
  }

  /** Adds blood to the bones of a hit zone (0..1 per bone). */
  wound(zone: HitZone, amount: number): void {
    for (const b of ZONE_BONES[zone]) this.wounds[b] = Math.min(1, this.wounds[b] + amount * (b === BONE.hips ? 0.5 : 1));
  }

  clearWounds(): void {
    this.wounds.fill(0);
  }

  /** Hit reaction: `dx/dz` is the bullet direction in world space. */
  flinch(zone: HitZone, dx: number, dz: number, amount: number): void {
    // World direction into body space.
    const yaw = this.root.rotation.y;
    const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const a = 6 + amount * 10;
    if (zone === 'head') {
      this.flinchHead[0].kick(lz * a * 1.4);
      this.flinchHead[1].kick(-lx * a * 1.4);
      this.flinchTorso[0].kick(lz * a * 0.3);
    } else if (zone === 'torso') {
      this.flinchTorso[0].kick(lz * a);
      this.flinchTorso[1].kick(-lx * a);
    } else {
      const i = { armL: 0, armR: 1, legL: 2, legR: 3 }[zone];
      this.flinchLimb[i].kick(a * 1.6);
      this.flinchTorso[1].kick(-lx * a * 0.3);
    }
  }

  /** Pushed off balance (zombie stagger): local direction from a world direction. */
  setStaggerDir(dx: number, dz: number): void {
    const yaw = this.root.rotation.y;
    this.staggerDir.set(dx * Math.cos(yaw) - dz * Math.sin(yaw), dx * Math.sin(yaw) + dz * Math.cos(yaw));
  }

  update(dt: number, target: LocomotionState): void {
    if (this.ragdoll) return;
    const s = this.smoothed;
    const k = 1 - Math.exp(-dt * 10);
    s.speed += (target.speed - s.speed) * k;
    s.crouch += (target.crouch - s.crouch) * k;
    s.aim += (target.aim - s.aim) * (1 - Math.exp(-dt * 14));
    s.strafe += (target.strafe - s.strafe) * k;
    s.grounded = target.grounded;
    const z = this.zombie;

    const speed = s.speed;
    const run = THREE.MathUtils.smoothstep(speed, z ? 1.3 : 3.6, z ? 2.2 : 6);
    let moving = THREE.MathUtils.smoothstep(speed, 0.1, 1.0);

    // Travel direction: hips swing toward it (strafing), and walk backwards when backpedalling.
    const ang = moving > 0.2 ? target.moveAngle ?? 0 : 0;
    const back = Math.abs(ang) > 1.9;
    const dir = back ? -1 : 1;
    if (dir !== this.moveDir && moving > 0.2) this.moveDir = dir;
    let hipTarget = back ? Math.atan2(Math.sin(ang - Math.PI), Math.cos(ang - Math.PI)) : ang;
    hipTarget = THREE.MathUtils.clamp(hipTarget, -0.8, 0.8) * moving;
    this.hipYaw += (hipTarget - this.hipYaw) * (1 - Math.exp(-dt * 8));

    // Turning on the spot shuffles the feet.
    const turn = Math.abs(target.turn ?? 0);
    const shuffleTarget = speed < 0.4 ? THREE.MathUtils.clamp((turn - 0.8) / 2, 0, 1) : 0;
    this.shuffle += (shuffleTarget - this.shuffle) * (1 - Math.exp(-dt * 8));
    moving = Math.max(moving, this.shuffle * 0.45);

    const strideFreq = z ? 0.9 + speed * 0.55 : 1.35 + speed * 0.32;
    this.phase += dt * strideFreq * Math.PI * 2 * (moving > 0.01 ? 1 : 0.25) * this.moveDir;
    const p = this.phase;
    const sin = Math.sin(p);
    const cos = Math.cos(p);

    const legAmp = (0.42 + run * 0.35) * moving;
    const kneeAmp = (0.55 + run * 0.6) * moving;
    const armAmp = (0.35 + run * 0.6) * moving;
    const crouch = s.crouch;

    this.down += (this.downTarget - this.down) * (1 - Math.exp(-dt * (this.downTarget > this.down ? 7 : 3)));
    this.stagger += (this.staggerTarget - this.stagger) * (1 - Math.exp(-dt * (this.staggerTarget > this.stagger ? 18 : 5)));
    // Springs are stepped at 120 Hz or finer: one big explicit step at a low frame rate diverges.
    const subs = Math.min(12, Math.ceil(dt * 120));
    const h = dt / Math.max(1, subs);
    for (let i = 0; i < subs; i++) {
      for (const sp of this.flinchHead) sp.step(h);
      for (const sp of this.flinchTorso) sp.step(h);
      for (const sp of this.flinchLimb) sp.step(h, 120, 12);
    }
    const fh = this.flinchHead, ft = this.flinchTorso, fl = this.flinchLimb;

    // Hips bob and crouch.
    const bob = Math.abs(cos) * 0.045 * moving * (1 + run);
    const lean = run * (z ? 0.3 : 0.22) + moving * 0.05 + crouch * 0.35;
    const zLean = z ? 0.34 + Math.sin(p * 0.5 + this.seed) * 0.03 : 0;
    const sv = this.stagger;
    this.hips.position.set(0, 0.95 - crouch * 0.33 + bob - (z ? 0.05 : 0), 0);
    this.hips.rotation.set(0, -sin * 0.1 * moving + this.hipYaw, 0);
    // Spine: lean, look pitch, bladed stance, recoil, flinches and stagger.
    let spineX = lean + zLean - s.aim * 0.05 - this.lookPitch * 0.45 + this.kick + ft[0].x * 0.08 - sv * this.staggerDir.y * 0.45;
    let spineZ = -s.strafe * 0.06 * moving + ft[1].x * 0.08 + sv * this.staggerDir.x * 0.3;
    const swingY = z ? Math.sin(p * 0.5) * 0.1 : sin * 0.08 * moving * (1 - s.aim);
    let spineY = swingY + this.twist - this.hipYaw;
    if (z && this.attack >= 0) {
      const a = this.attack;
      // Windup leans back, the strike lunges forward, then recovers.
      spineX += a < 0.5 ? -a * 0.3 : a < 0.66 ? THREE.MathUtils.lerp(-0.15, 0.4, (a - 0.5) / 0.16) : THREE.MathUtils.lerp(0.4, 0, (a - 0.66) / 0.34);
      spineY += a < 0.5 ? a * 0.3 : (1 - a) * 0.3;
    }
    if (z && this.bash >= 0) spineX += Math.sin(this.bash * Math.PI) * 0.25 - 0.1;
    this.spine.rotation.set(spineX, spineY, spineZ);

    // Legs.
    const limp = z ? 0.55 : 1;
    this.legL.upper.rotation.set(-sin * legAmp - crouch * 0.9, 0, 0);
    this.legR.upper.rotation.set(sin * legAmp * limp - crouch * 0.9, 0, 0);
    this.legL.lower.rotation.set(Math.max(0, cos) * kneeAmp + crouch * 1.5 + (s.grounded ? 0 : 0.6), 0, 0);
    this.legR.lower.rotation.set(Math.max(0, -cos) * kneeAmp * limp + crouch * 1.5 + (s.grounded ? 0 : 0.3), 0, 0);
    if (!s.grounded) {
      this.legL.upper.rotation.x -= 0.5;
      this.legR.upper.rotation.x += 0.1;
    }
    this.legL.upper.rotation.x -= fl[2].x * 0.06;
    this.legR.upper.rotation.x -= fl[3].x * 0.06;

    // Arms: free swing (survivors' are overridden by IK when holding a weapon).
    if (z) {
      const reach = 1.25 + Math.sin(p * 0.7 + this.seed) * 0.12 + run * 0.25;
      // `spread` swings the arms outward (negative converges the reaching hands).
      let ux = -reach, lx = -0.3, spread = -0.12;
      if (this.attack >= 0) {
        const a = this.attack;
        if (a < 0.5) { ux = THREE.MathUtils.lerp(-reach, -2.5, a / 0.5); lx = THREE.MathUtils.lerp(-0.3, -1.1, a / 0.5); spread = 0.25; }
        else if (a < 0.66) { const t = (a - 0.5) / 0.16; ux = THREE.MathUtils.lerp(-2.5, -0.7, t); lx = THREE.MathUtils.lerp(-1.1, -0.05, t); spread = -0.05; }
        else { const t = (a - 0.66) / 0.34; ux = THREE.MathUtils.lerp(-0.7, -reach, t); lx = -0.3 * t; spread = -0.12 * t; }
      }
      if (this.bash >= 0) {
        const b = this.bash;
        ux = b < 0.6 ? THREE.MathUtils.lerp(-1.4, -2.3, b / 0.6) : THREE.MathUtils.lerp(-2.3, -1.2, (b - 0.6) / 0.4);
        lx = b < 0.6 ? -1.0 : -0.25;
        spread = 0.15;
      }
      // Staggering throws the arms out.
      ux = THREE.MathUtils.lerp(ux, -0.6, sv * 0.6);
      spread += sv * 0.8;
      this.armL.upper.rotation.set(ux + sin * 0.1 - fl[0].x * 0.05, 0, spread);
      this.armR.upper.rotation.set(ux * 0.92 - sin * 0.1 - fl[1].x * 0.05, 0, -spread);
      this.armL.lower.rotation.set(lx, 0, 0);
      this.armR.lower.rotation.set(lx - 0.1, 0, 0);
      this.head.rotation.set(
        0.12 + Math.sin(p * 0.3) * 0.1 - zLean * 0.4 + fh[0].x * 0.1 - sv * this.staggerDir.y * 0.4,
        Math.sin(p * 0.21 + this.seed) * 0.3,
        0.25 * Math.sin(this.seed) + fh[1].x * 0.1,
      );
    } else {
      const swingL = sin * armAmp;
      const swingR = -sin * armAmp;
      this.armL.upper.rotation.set(swingL - crouch * 0.2 - fl[0].x * 0.05, 0, 0.08);
      this.armR.upper.rotation.set(swingR - crouch * 0.2 - fl[1].x * 0.05, 0, -0.08);
      this.armL.lower.rotation.set(-0.25 - run * 0.9, 0, 0);
      this.armR.lower.rotation.set(-0.25 - run * 0.9, 0, 0);
      const breathe = Math.sin(performance.now() * 0.0018 + this.seed) * 0.02 * (1 - moving);
      // The head keeps looking where the body faces whatever the hips and shoulders do.
      this.head.rotation.set(-lean * 0.6 + breathe - this.lookPitch * 0.4 + fh[0].x * 0.1, -this.twist - (swingY - sin * 0.1 * moving) * 0.7, fh[1].x * 0.08);
    }

    // Knocked down: fall onto the back, feet toward the facing direction, arms splayed.
    const d = this.down;
    if (d > 0.001) {
      const ease = d * d * (3 - 2 * d);
      this.hips.position.y = THREE.MathUtils.lerp(this.hips.position.y, 0.2, ease);
      this.hips.position.z = -0.2 * ease;
      this.hips.rotation.x = THREE.MathUtils.lerp(this.hips.rotation.x, -1.5, ease);
      this.spine.rotation.x *= 1 - ease;
      this.spine.rotation.z += 0.15 * ease;
      for (const [leg, spread] of [[this.legL, 0.12], [this.legR, -0.12]] as const) {
        leg.upper.rotation.x *= 1 - ease;
        leg.upper.rotation.z = spread * ease;
        leg.lower.rotation.x = THREE.MathUtils.lerp(leg.lower.rotation.x, 0.25, ease);
      }
      this.armL.upper.rotation.z = THREE.MathUtils.lerp(this.armL.upper.rotation.z, 1.1, ease);
      this.armR.upper.rotation.z = THREE.MathUtils.lerp(this.armR.upper.rotation.z, -1.1, ease);
      this.armL.upper.rotation.x *= 1 - ease * 0.7;
      this.armR.upper.rotation.x *= 1 - ease * 0.7;
      this.head.rotation.x = THREE.MathUtils.lerp(this.head.rotation.x, -0.3, ease);
    }

    // Footstep events at each plant.
    const sign = Math.sign(sin);
    if (sign !== this.lastStepSign && moving > 0.3 && s.grounded && d < 0.2) {
      this.onFootstep?.(Math.min(1, speed / 6) * (1 - crouch * 0.6));
    }
    this.lastStepSign = sign;
  }

  /**
   * Two-bone IK: puts the wrist of `limb` on a world-space target, bending the elbow toward
   * `pole` (world direction). `blend` mixes with the current (FK) pose.
   */
  reach(limb: Limb, target: THREE.Vector3, pole: THREE.Vector3, blend = 1): void {
    if (blend <= 0.001) return;
    const shoulder = limb.upper.getWorldPosition(_a);
    const L1 = limb.upperLen, L2 = limb.lowerLen;
    const toT = _b.subVectors(target, shoulder);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(L1 - L2) + 0.02, L1 + L2 - 0.002);
    const dir = toT.normalize();
    const cosA = THREE.MathUtils.clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1);
    const a = Math.acos(cosA);
    const po = _c.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (po.lengthSq() < 1e-6) po.set(0, -1, 0).addScaledVector(dir, dir.y).normalize();
    else po.normalize();
    const elbowDir = _d.copy(dir).multiplyScalar(Math.cos(a)).addScaledVector(po, Math.sin(a)).normalize();
    const elbow = _e.copy(shoulder).addScaledVector(elbowDir, L1);
    const wrist = _f.copy(shoulder).addScaledVector(dir, d);

    const parentQ = limb.upper.parent!.getWorldQuaternion(_q1);
    const rest = _g.set(0, -1, 0).applyQuaternion(parentQ);
    const upperW = _q2.setFromUnitVectors(rest, elbowDir).multiply(parentQ);
    const upperLocal = _q3.copy(parentQ).invert().multiply(upperW);
    limb.upper.quaternion.slerp(upperLocal, blend);

    const fore = _h.subVectors(wrist, elbow).normalize();
    const rest2 = _g.set(0, -1, 0).applyQuaternion(upperW);
    const lowerW = _q4.setFromUnitVectors(rest2, fore).multiply(upperW);
    const lowerLocal = _q3.copy(upperW).invert().multiply(lowerW);
    limb.lower.quaternion.slerp(lowerLocal, blend);
    limb.upper.updateMatrixWorld(true);
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  /** Surface materials, for lighting patches (light probes). */
  surfaces(): THREE.Material[] {
    return [this.material];
  }

  /** Standing rest pose (pool reuse, after a ragdoll). */
  resetPose(): void {
    this.ragdoll = false;
    this.down = this.downTarget = 0;
    this.stagger = this.staggerTarget = 0;
    this.attack = this.bash = -1;
    this.kick = this.twist = this.lookPitch = 0;
    for (const sp of [...this.flinchHead, ...this.flinchTorso, ...this.flinchLimb]) sp.x = sp.v = 0;
    for (const b of this.bones) b.rotation.set(0, 0, 0);
    this.hips.position.set(0, 0.95, 0);
    this.root.position.y = 0;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.material.dispose();
    this.skeleton.dispose();
    if (this.eyes) {
      this.eyes.geometry.dispose();
      this.eyeMaterial?.dispose();
    }
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3(), _h = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();

export const SURVIVOR_LOOKS: HumanoidLook[] = [
  { skin: 0xb08a6e, top: 0x3a4a3a, pants: 0x2b2f38, shoes: 0x1c1a18, hair: 0x2a1f17, vest: 0x4a3c2a },
  { skin: 0x8a6248, top: 0x5a3a2a, pants: 0x32363c, shoes: 0x222020, hair: 0x111111, vest: 0x2f3a2b },
  { skin: 0xc9a385, top: 0x2f3e52, pants: 0x3a3a33, shoes: 0x1c1a18, hair: 0x6b4a2a },
  { skin: 0x6e4a36, top: 0x4b4b4b, pants: 0x2a2a2e, shoes: 0x161616, hair: 0x0d0d0d, vest: 0x3a3226 },
];

/** Number of distinct zombie looks (looks repeat beyond this). */
export const ZOMBIE_LOOK_COUNT = 8;

export function zombieLook(i: number): HumanoidLook {
  const skins = [0x7d8a72, 0x8b8a76, 0x6f7a6a, 0x948f7e, 0x86806c, 0x6a7466];
  const tops = [0x4a3f3a, 0x3c4450, 0x5a4a3a, 0x3a3a35, 0x6a5a50, 0x5b2e2a, 0x2f3a46, 0x7a7466];
  const pants = [0x2e3138, 0x3b3530, 0x2a2c2a, 0x46423a];
  const hair = [0x2a241f, undefined, 0x4a3a2a, undefined, 0x1a1715, 0x6a6258, undefined, 0x2a241f];
  const k = i % ZOMBIE_LOOK_COUNT;
  return { skin: skins[k % skins.length], top: tops[(k * 3) % tops.length], pants: pants[k % pants.length], shoes: 0x1a1816, hair: hair[k], zombie: true };
}
