import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ArmState, ArmZone, HitZone, LegState, LegZone, LimbZone, ZombieKind } from '@dead-hours/shared';
import { chain } from '../lighting/BakeShader';
import { BODY_KNEE, GLOSS_CAP_GLSL, GLOSS_CEIL } from '../lighting/GlossCap';
import { rng, randomAppearance, paletteColor, type Appearance } from '@dead-hours/shared';
import { BONE, BONE_COUNT } from './rig';
import { ARM, EYE_Y, HEAD_K, LEG, SHOULDER_X, dress, eyeParts, type DressResult, type Mutation, type PartSink } from './Outfit';
import { goreMaterial, stumpGeometry, tintGore } from './Gore';
import { DECAY_BLOOD, DECAY_COMMON, DECAY_SURFACE, MAX_HITS, SURF, createDecayUniforms, decayNoise, trackDecayMaterial, untrackDecayMaterial, zombieDetail, type DecayUniforms } from './Decay';
import { RIM, SURVIVOR_COMMON, SURVIVOR_WEAR, type BodyShading } from './Wear';

export interface HumanoidLook {
  /** What the character wears and looks like. */
  outfit: Appearance;
  /** Zombies: hunched posture, reaching arms, limp, grimy clothes, glowing eyes. */
  zombie?: boolean;
  /** Skin color override (zombies' palette isn't a living one). */
  skin?: number;
  /** Zombie kind's way of moving: shambling walker, sprinting runner, lumbering brute. */
  gait?: ZombieGait;
  /** Body width beyond the broadest build; shoulders and hips sit wider to match. */
  girth?: number;
  /** Zombie eye glow color. */
  eyeGlow?: number;
  /** Special zombies' bodies (see Outfit's Mutation). */
  mutation?: Mutation;
  /** Zombies: how far gone the flesh is, 0 freshly turned .. 1 rotten through. */
  decay?: number;
}

export type ZombieGait = 'walker' | 'runner' | 'brute';

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

/** Standing on a skateboard (Humanoid.skate): the owner fills this in every frame while riding. */
export interface SkatePose {
  /** Which way the deck points, relative to the body's facing (radians). */
  yaw: number;
  /** Height of the deck's top above the root (metres). */
  deck: number;
  /** Kick cycle 0..1 while pushing along, or -1 (feet both on the deck). */
  push: number;
  /** Carving: -1..1, leaning into the turn (positive: toward the body's left). */
  lean: number;
  /** In the air (an ollie): knees tucked up. */
  air: boolean;
  /** Crouched low on the deck. */
  low: boolean;
}

export interface Limb {
  upper: THREE.Bone;
  lower: THREE.Bone;
  /** Wrist / ankle: end of the lower segment. */
  end: THREE.Object3D;
  upperLen: number;
  lowerLen: number;
}

export { BONE };

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

interface BodyEntry {
  geometry: THREE.BufferGeometry;
  dress: DressResult;
  refs: number;
  /** Bind-pose vertex positions per bone (built on the first wound). */
  byBone?: Float32Array[];
}

/** Bind-pose vertices of each bone, for putting wounds on the body's surface. */
function verticesByBone(e: BodyEntry): Float32Array[] {
  if (e.byBone) return e.byBone;
  const pos = e.geometry.getAttribute('position');
  const si = e.geometry.getAttribute('skinIndex');
  const lists: number[][] = Array.from({ length: BONE_COUNT }, () => []);
  for (let i = 0; i < pos.count; i++) lists[si.getX(i)]?.push(pos.getX(i), pos.getY(i), pos.getZ(i));
  return (e.byBone = lists.map((l) => new Float32Array(l)));
}

/** Close enough to the skin color to be skin (ears, nose and swollen guts are shaded from it). */
function nearHex(a: number, b: number, tol: number): boolean {
  return Math.abs((a >> 16) - (b >> 16)) <= tol && Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= tol && Math.abs((a & 255) - (b & 255)) <= tol;
}

const MUD = new THREE.Color(0x4a4236);

/** Merged body geometry per look, shared by every character wearing it and freed with the last one. */
const bodyCache = new Map<string, BodyEntry>();

function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function acquireBody(key: string, look: HumanoidLook, bones: THREE.Bone[]): BodyEntry {
  let e = bodyCache.get(key);
  if (!e) {
    e = buildBody(key, look, bones);
    bodyCache.set(key, e);
  }
  e.refs++;
  return e;
}

function releaseBody(key: string): void {
  const e = bodyCache.get(key);
  if (!e || --e.refs > 0) return;
  e.geometry.dispose();
  bodyCache.delete(key);
}

/** Merged, skinned body: every primitive of the outfit, colored per face, with its fabric pattern. */
function buildBody(key: string, look: HumanoidLook, bones: THREE.Bone[]): BodyEntry {
  const parts: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  const accent = new THREE.Color();
  const tint = new THREE.Color();
  const grime = look.zombie;
  const skinHex = look.skin ?? paletteColor('skin', look.outfit.skin);
  const rand = rng(hashString(key));
  const sink: PartSink = (g, bone, hex, m, surf, blend) => {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute('uv');
    // Bone space first: soft shading and joint weights are laid out there.
    geo.applyMatrix4(m);
    const P = geo.getAttribute('position');
    const n = P.count;
    const col = new Float32Array(n * 3);
    const pat = new Float32Array(n * 4);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    // The dead's clothes are muddied and faded; their skin is already the right color.
    const muddy = grime && hex !== look.skin ? 0.4 : 0;
    color.setHex(hex).lerp(MUD, muddy);
    accent.setHex(surf?.accent ?? hex).lerp(MUD, muddy);
    // Which surface this is: skin (rots on zombies, gets grubby on survivors), cloth (tears,
    // creases, wears and gets dirty) or hard gear and hair (doesn't).
    const cls = grime
      ? look.skin !== undefined && nearHex(hex, look.skin, 40) ? SURF.skin : bone === BONE.head ? SURF.hard : SURF.cloth
      : hex === skinHex || (bone === BONE.head && nearHex(hex, skinHex, 14)) ? SURF.skin : bone === BONE.head ? SURF.hard : SURF.cloth;
    const type = (surf?.pattern ?? 0) + cls * 8;
    const shadeFn = surf?.shade;
    for (let i = 0; i < n; i += 3) {
      // Per-face variation (zombies: grime, so clothes and skin read as filthy, not flat).
      const k = grime ? 0.72 + rand() * 0.32 : 0.94 + rand() * 0.08;
      for (let j = i; j < i + 3 && j < n; j++) {
        tint.setRGB(k, k, k);
        if (shadeFn) shadeFn(P.getX(j), P.getY(j), P.getZ(j), tint);
        col[j * 3] = color.r * tint.r;
        col[j * 3 + 1] = color.g * tint.g;
        col[j * 3 + 2] = color.b * tint.b;
        pat[j * 4] = accent.r * tint.r;
        pat[j * 4 + 1] = accent.g * tint.g;
        pat[j * 4 + 2] = accent.b * tint.b;
        pat[j * 4 + 3] = type;
        si[j * 4] = bone;
        if (blend) {
          // Toward a joint the skin follows both bones, evenly at the joint itself.
          const u = Math.min(1, Math.abs(P.getY(j) - blend.y) / blend.band);
          const w = 0.5 * (1 - u * u * (3 - 2 * u));
          si[j * 4 + 1] = blend.bone;
          sw[j * 4] = 1 - w;
          sw[j * 4 + 1] = w;
        } else {
          sw[j * 4] = 1;
        }
      }
    }
    geo.applyMatrix4(bones[bone].matrixWorld);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('pattern', new THREE.BufferAttribute(pat, 4));
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    parts.push(geo);
  };
  const result = dress(sink, look.outfit, { zombie: !!look.zombie, skin: look.skin, rand, girth: look.girth, mutation: look.mutation });
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  merged.computeBoundingSphere();
  return { geometry: merged, dress: result, refs: 0 };
}

/**
 * Survivors' eyes: their own small meshes on the head bone, so they can blink, the whites and
 * lashes in one and the irises (with pupils and glints) in another that moves as they look about.
 */
function buildEyes(a: Appearance): { whites: THREE.BufferGeometry; irises: THREE.BufferGeometry } {
  const color = new THREE.Color();
  const whites: THREE.BufferGeometry[] = [], irises: THREE.BufferGeometry[] = [];
  for (const { g, hex, m, iris } of eyeParts(a)) {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute('uv');
    geo.applyMatrix4(m);
    const n = geo.getAttribute('position').count;
    const col = new Float32Array(n * 3);
    color.setHex(hex);
    for (let i = 0; i < n; i++) color.toArray(col, i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    (iris ? irises : whites).push(geo);
  }
  const merge = (ps: THREE.BufferGeometry[]) => {
    const merged = mergeGeometries(ps, false)!;
    for (const p of ps) p.dispose();
    return merged;
  };
  return { whites: merge(whites), irises: merge(irises) };
}

/**
 * Fabric patterns and wound shading, both in bind-pose space so they stick to the body.
 * Patterns (plaid, stripes, camo, flowers, knit, denim) mix the vertex color with the part's
 * accent. Each bone carries a 0..1 blood amount; splotchy patches spread as it grows.
 */
export function patchWounds(mat: THREE.MeshStandardMaterial, wounds: Float32Array, decay?: DecayUniforms, look?: BodyShading): void {
  const shading = look ?? { uGrime: { value: new THREE.Vector4() }, uRim: { value: decay ? RIM.zombie : RIM.survivor } };
  chain(mat, decay ? 'wounds-z' : 'wounds-s', (shader) => {
    shader.uniforms.uWounds = { value: wounds };
    Object.assign(shader.uniforms, shading);
    let defs = '';
    if (decay) {
      Object.assign(shader.uniforms, decay);
      defs = `#define ZOMBIE_DECAY\n${zombieDetail() === 'lite' ? '#define DECAY_LITE\n' : ''}`;
    } else {
      shader.uniforms.uZNoise = { value: decayNoise() };
    }
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uWounds[${BONE_COUNT}];
        attribute vec4 pattern;
        varying float vWound;
        varying float vBone;
        varying vec3 vWoundP;
        varying vec4 vPat;
        varying vec3 vPatN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWound = uWounds[int(skinIndex.x + 0.5)];
        vBone = skinIndex.x;
        vWoundP = position;
        vPat = pattern;
        vPatN = normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${defs}
        uniform vec4 uRim;
        varying float vWound;
        varying float vBone;
        varying vec3 vWoundP;
        varying vec4 vPat;
        varying vec3 vPatN;
        float wHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
        float wNoise(vec3 x) {
          vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(wHash(i), wHash(i + vec3(1, 0, 0)), f.x), mix(wHash(i + vec3(0, 1, 0)), wHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(wHash(i + vec3(0, 0, 1)), wHash(i + vec3(1, 0, 1)), f.x), mix(wHash(i + vec3(0, 1, 1)), wHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }
        #ifdef ZOMBIE_DECAY
        ${DECAY_COMMON}
        // Zombies read their noise from the noise texture (far cheaper with hundreds on screen).
        #define WN(P_) zN(P_).x
        #define WN2(P_) zN(P_).y
        #else
        #define WN(P_) wNoise(P_)
        #define WN2(P_) wNoise(P_)
        ${SURVIVOR_COMMON}
        #endif
        ${GLOSS_CAP_GLSL}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // A body beside a fire's light (its own, when it burns) stays fire-lit, not white (GlossCap).
        reflectedLight.directDiffuse = softCeil(reflectedLight.directDiffuse, ${BODY_KNEE.toFixed(3)}, ${GLOSS_CEIL.toFixed(3)});
        reflectedLight.directSpecular = softCeil(reflectedLight.directSpecular, ${BODY_KNEE.toFixed(3)}, ${GLOSS_CEIL.toFixed(3)});`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float zWet = 0.0;
        // pattern.w = fabric pattern + 8 * surface class.
        float vZSurf = floor((vPat.w + 0.5) / 8.0);
        float pType = vPat.w - vZSurf * 8.0;
        if (pType > 0.5) {
          vec3 q = vWoundP;
          vec3 an = abs(normalize(vPatN));
          // Horizontal coordinate across whichever way the surface faces.
          float u = an.z > an.x ? q.x : q.z;
          vec3 base = diffuseColor.rgb;
          vec3 acc = vPat.rgb;
          float t = pType;
          if (t < 1.5) {
            vec2 f = fract(vec2(u, q.y) * 10.0);
            float a = step(f.x, 0.36) + step(f.y, 0.36);
            diffuseColor.rgb = mix(base, acc, a * 0.45);
            float line = max(step(abs(f.x - 0.68), 0.03), step(abs(f.y - 0.68), 0.03));
            diffuseColor.rgb = mix(diffuseColor.rgb, base * 1.5 + 0.06, line * 0.4);
          } else if (t < 2.5) {
            diffuseColor.rgb = mix(base, acc, step(0.5, fract(q.y * 16.0)));
          } else if (t < 3.5) {
            float n = WN(q * 7.0) * 0.65 + WN2(q * 17.0) * 0.35;
            diffuseColor.rgb = mix(base, acc, smoothstep(0.45, 0.47, n));
            diffuseColor.rgb = mix(diffuseColor.rgb, base * 0.42, smoothstep(0.62, 0.64, n));
          } else if (t < 4.5) {
            float n = WN(q * 46.0);
            diffuseColor.rgb = mix(base, acc, smoothstep(0.66, 0.68, n));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.85, 0.62, 0.12), smoothstep(0.86, 0.88, n));
          } else if (t < 5.5) {
            diffuseColor.rgb *= 0.86 + 0.16 * step(0.5, fract(u * 60.0));
          } else {
            diffuseColor.rgb *= 0.9 + 0.18 * WN(vec3((u + q.y) * 70.0, q.y * 14.0, u * 9.0));
          }
        }
        #ifdef ZOMBIE_DECAY
        ${DECAY_SURFACE}
        #else
        ${SURVIVOR_WEAR}
        #endif
        if (vWound > 0.001) {
          #ifdef DECAY_LITE
          vec4 wq = zN(vWoundP * 12.0);
          float wn = wq.x * 0.65 + wq.y * 0.35;
#else
          float wn = WN(vWoundP * 9.0) * 0.65 + WN2(vWoundP * 23.0) * 0.35;
#endif
          float wc = smoothstep(wn - 0.06, wn + 0.06, vWound * 0.95);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.085, 0.007, 0.005) * (0.6 + 0.6 * wn), wc * 0.94);
          zWet = max(zWet, wc * 0.4);
        }
        #ifdef ZOMBIE_DECAY
        ${DECAY_BLOOD}
        #endif`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // Blood and raw flesh glisten.
        roughnessFactor = mix(roughnessFactor, 0.3, clamp(zWet, 0.0, 1.0));`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          // A faint cool rim round the silhouette and a little fill, so a body reads against
          // the dark and its face and folds don't sink into black away from the lamps.
          float rimF = 1.0 - saturate(dot(geometryNormal, geometryViewDir));
          rimF *= rimF * rimF;
          reflectedLight.indirectDiffuse += uRim.rgb * rimF * (0.25 + 2.0 * material.diffuseColor) + uRim.w * material.diffuseColor;
        }`);
  });
  if (decay) {
    // The detail level is part of the program: switching it recompiles (see setZombieDetail).
    const key = mat.customProgramCacheKey;
    mat.customProgramCacheKey = () => `${key.call(mat)}|${zombieDetail()}`;
    trackDecayMaterial(mat);
  }
}

/** How much of the look pitch bends the spine (at the waist): looking down leans the survivor forward. */
export const LOOK_BEND = 0.45;

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
  /** Survivors: whites and irises together (squashed to blink); zombies: the glowing eyes. */
  private readonly eyes: THREE.Object3D | null = null;
  /** Survivors' irises, shifted as they glance about. */
  private readonly irises: THREE.Mesh | null = null;
  private readonly eyeGeometries: THREE.BufferGeometry[] = [];
  private readonly eyeMaterial: THREE.MeshStandardMaterial | null = null;
  /** Where the eyes look (head space offset of the irises), where they are going, and when they move next. */
  private readonly gaze = new THREE.Vector2();
  private readonly gazeTo = new THREE.Vector2();
  private gazeT = Math.random() * 2;
  private readonly skeleton: THREE.Skeleton;
  private readonly bodyKey: string;
  /** How far gear on the back sticks out (a slung rifle rides on top of a backpack). */
  readonly backDepth: number;
  private blinkT = 1 + Math.random() * 3;
  readonly wounds = new Float32Array(BONE_COUNT);
  private phase = Math.random() * 10;
  private smoothed: LocomotionState = { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 };
  /** Fired at each foot plant with a 0..1 loudness. */
  onFootstep: ((loudness: number) => void) | null = null;
  private lastStepSign = 0;
  readonly zombie: boolean;
  readonly gait: ZombieGait;
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

  /** Collapses the head (and everything worn on it) while the camera looks out of its eyes. */
  set headHidden(v: boolean) {
    this.head.scale.setScalar(v ? 0.001 : 1);
  }

  // Zombie channels.
  /** Swipe progress 0..1, or -1 when not attacking. */
  attack = -1;
  /** Door pounding cycle 0..1, or -1. */
  bash = -1;
  /** Screamers: scream progress 0..1, or -1. */
  scream = -1;
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
  /** Legless (0 upright .. 1 face down, dragging itself on its arms). */
  crawlTarget = 0;
  private crawl = 0;
  /** True while a ragdoll owns the bones. */
  ragdoll = false;
  /** On a skateboard (null on foot): the legs stand on the deck instead of walking. */
  skate: SkatePose | null = null;
  private skateW = 0;
  private readonly lastSkate: SkatePose = { yaw: Math.PI / 2, deck: 0.11, push: -1, lean: 0, air: false, low: false };
  /** +1 regular (left foot forward), -1 goofy. */
  private stance = 1;
  private pushK = 0;
  private airK = 0;
  private leanK = 0;
  /** Zombies: what is left of each arm, and the torn ends where they came off. */
  private readonly arms: Record<ArmZone, ArmState> = { armL: 'intact', armR: 'intact' };
  private readonly legs: Record<LegZone, LegState> = { legL: 'intact', legR: 'intact' };
  private readonly stumps = new Map<string, THREE.Mesh>();
  private readonly gore: THREE.MeshStandardMaterial | null = null;
  /** Zombies: rot, torn clothes and local wounds (shader uniforms). */
  readonly decay: DecayUniforms | null = null;
  /** Soak radius each local wound is spreading toward. */
  private readonly soakTo = new Float32Array(MAX_HITS);
  private nextHit = 0;
  private readonly body: BodyEntry;
  /**
   * Survivors' grime (shader uniform): x dirt and y blood, 0..1 each, z a per-body seed. Dirt
   * builds up by itself while `weathering` (in a night); blood comes from splatter().
   */
  readonly grime = new THREE.Vector4(0, 0, Math.random() * 40, 0);
  weathering = false;
  // Idle life: breathing (faster after a run), shifting weight, settling into a ready stance.
  private breathP = Math.random() * 6;
  private winded = 0;
  private shiftP = Math.random() * 13;
  private still = 0;

  constructor(look: HumanoidLook) {
    this.zombie = !!look.zombie;
    this.gait = look.gait ?? 'walker';
    const girth = look.girth ?? 1;
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
    // Women's shoulders sit a little closer in.
    const shoulder = SHOULDER_X[look.outfit.body === 'female' ? 'female' : 'male'] * girth;
    this.armL = limb(this.spine, shoulder, 0.48, ARM.upper, ARM.lower);
    this.armR = limb(this.spine, -shoulder, 0.48, ARM.upper, ARM.lower);
    this.legL = limb(this.hips, 0.1 * girth, -0.04, LEG.upper, LEG.lower);
    this.legR = limb(this.hips, -0.1 * girth, -0.04, LEG.upper, LEG.lower);
    this.bones = [
      this.hips, this.spine, this.head,
      this.armL.upper, this.armL.lower, this.armR.upper, this.armR.lower,
      this.legL.upper, this.legL.lower, this.legR.upper, this.legR.lower,
    ];
    this.root.updateMatrixWorld(true);

    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, flatShading: true });
    this.bodyKey = JSON.stringify(look);
    if (this.zombie) this.decay = decayOf(look, (hashString(this.bodyKey) % 97) * 1.37, true);
    patchWounds(this.material, this.wounds, this.decay ?? undefined, { uGrime: { value: this.grime }, uRim: { value: this.zombie ? RIM.zombie : RIM.survivor } });
    const body = acquireBody(this.bodyKey, look, this.bones);
    this.body = body;
    this.backDepth = body.dress.backDepth;
    this.mesh = new THREE.SkinnedMesh(body.geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.9, 0), 1.6);
    this.root.add(this.mesh);
    this.skeleton = new THREE.Skeleton(this.bones);
    this.mesh.bind(this.skeleton);

    if (this.zombie) {
      this.gore = goreMaterial();
      this.eyeMaterial = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: look.eyeGlow ?? 0xc8d27a, emissiveIntensity: 1.2 });
      const l = new THREE.SphereGeometry(0.014, 4, 3).translate(-0.045, 0.13, 0.12);
      const r = new THREE.SphereGeometry(0.014, 4, 3).translate(0.045, 0.13, 0.12);
      const g = mergeGeometries([l, r])!;
      l.dispose();
      r.dispose();
      this.eyeGeometries.push(g);
      this.eyes = new THREE.Mesh(g, this.eyeMaterial);
      this.eyes.scale.setScalar(HEAD_K);
      this.head.add(this.eyes);
    } else if (body.dress.eyesVisible) {
      this.eyeMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.28 });
      const { whites, irises } = buildEyes(look.outfit);
      this.eyeGeometries.push(whites, irises);
      const eyes = new THREE.Mesh(whites, this.eyeMaterial);
      this.irises = new THREE.Mesh(irises, this.eyeMaterial);
      eyes.add(this.irises);
      // The head is drawn HEAD_K of its built size (see Outfit's headSink).
      eyes.position.y = EYE_Y * HEAD_K;
      eyes.scale.setScalar(HEAD_K);
      this.eyes = eyes;
      this.head.add(eyes);
    }
  }

  /**
   * Takes an arm off (zombies): everything past the cut collapses to nothing and a torn end
   * takes its place. 'intact' puts it back (pooled bodies).
   */
  setArm(arm: ArmZone, state: ArmState): void {
    if (this.arms[arm] === state) return;
    this.arms[arm] = state;
    const l = arm === 'armL' ? this.armL : this.armR;
    l.upper.scale.setScalar(state === 'shoulder' ? 0.001 : 1);
    l.lower.scale.setScalar(state === 'elbow' ? 0.001 : 1);
    for (const cut of ['shoulder', 'elbow'] as const) {
      const key = `${arm}:${cut}`;
      let m = this.stumps.get(key);
      if (cut !== state) {
        if (m) m.visible = false;
        continue;
      }
      if (!m && this.gore) {
        const bone = arm === 'armL' ? (cut === 'shoulder' ? BONE.armLUpper : BONE.armLLower) : cut === 'shoulder' ? BONE.armRUpper : BONE.armRLower;
        m = new THREE.Mesh(stumpGeometry(this.cutRadius(bone), this.seed * 1000 + bone, 1), this.gore);
        // A shoulder stump sits on the torso and turns with the arm that was there; an elbow
        // stump is the end of the upper arm.
        if (cut === 'shoulder') {
          m.position.copy(l.upper.position);
          this.spine.add(m);
        } else {
          m.position.y = -l.upperLen;
          l.upper.add(m);
        }
        this.stumps.set(key, m);
      }
      if (m) m.visible = true;
    }
  }

  /** What is left of an arm. */
  armState(arm: ArmZone): ArmState {
    return this.arms[arm];
  }

  /**
   * Takes a leg off (zombies): the thigh and shin, or just the shin, collapse to nothing and a
   * torn end with the bone showing takes their place. 'intact' puts it back (pooled bodies).
   */
  setLeg(leg: LegZone, state: LegState): void {
    if (this.legs[leg] === state) return;
    this.legs[leg] = state;
    const l = leg === 'legL' ? this.legL : this.legR;
    l.upper.scale.setScalar(state === 'hip' ? 0.001 : 1);
    l.lower.scale.setScalar(state === 'knee' ? 0.001 : 1);
    for (const cut of ['hip', 'knee'] as const) {
      const key = `${leg}:${cut}`;
      let m = this.stumps.get(key);
      if (cut !== state) {
        if (m) m.visible = false;
        continue;
      }
      if (!m && this.gore) {
        const upper = leg === 'legL' ? BONE.legLUpper : BONE.legRUpper;
        const bone = cut === 'hip' ? upper : upper + 1;
        // Ragged, with more meat torn out than an arm (the thigh is the thickest thing on it).
        m = new THREE.Mesh(stumpGeometry(this.cutRadius(bone), this.seed * 1000 + bone, cut === 'hip' ? 1 : 2), this.gore);
        if (cut === 'hip') {
          // A little below the joint, so the torn meat shows out of what is left of the trousers.
          m.position.copy(l.upper.position).y -= 0.05;
          this.hips.add(m);
        } else {
          m.position.y = -l.upperLen;
          l.upper.add(m);
        }
        this.stumps.set(key, m);
      }
      if (m) m.visible = true;
    }
  }

  /** What is left of a leg. */
  legState(leg: LegZone): LegState {
    return this.legs[leg];
  }

  /** World position and outward direction of a limb's torn end; false while it is whole. */
  stump(arm: LimbZone, pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    const state = arm === 'legL' || arm === 'legR' ? this.legs[arm] : this.arms[arm];
    if (state === 'intact') return false;
    const m = this.stumps.get(`${arm}:${state}`);
    if (!m) return false;
    m.updateWorldMatrix(true, false);
    pos.setFromMatrixPosition(m.matrixWorld);
    dir.set(0, -1, 0).transformDirection(m.matrixWorld);
    return true;
  }

  /** Zombies: head or legs blown off (by a blast): collapsed to nothing, a torn end left. */
  private readonly torn = new Set<'head' | 'legL' | 'legR'>();

  /**
   * Blows the head or a leg off: it collapses to nothing (with anything worn on it) and a torn,
   * bleeding end is left at the neck or hip. Call after the ragdoll has read the whole body.
   */
  tearOff(part: 'head' | 'legL' | 'legR'): void {
    if (this.torn.has(part)) return;
    this.torn.add(part);
    const leg = part === 'legL' ? this.legL : part === 'legR' ? this.legR : null;
    (leg ? leg.upper : this.head).scale.setScalar(0.001);
    if (!this.gore) return;
    let m = this.stumps.get(part);
    if (!m) {
      // The neck is about as thick as the forearm; a hip as the thigh.
      const bone = part === 'head' ? BONE.head : part === 'legL' ? BONE.legLUpper : BONE.legRUpper;
      const r = part === 'head' ? 0.065 : 0.088;
      m = new THREE.Mesh(stumpGeometry(r, this.seed * 1000 + bone + 50, 1), this.gore);
      if (leg) {
        m.position.copy(leg.upper.position);
        this.hips.add(m);
      } else {
        // The torn neck faces up, out of the shoulders.
        m.position.copy(this.head.position);
        m.rotation.x = Math.PI;
        this.spine.add(m);
      }
      this.stumps.set(part, m);
    }
    m.visible = true;
  }

  /** What has been blown off. */
  isTorn(part: 'head' | 'legL' | 'legR'): boolean {
    return this.torn.has(part);
  }

  /** World position and outward direction of a torn neck or hip (false while whole). */
  tornEnd(part: 'head' | 'legL' | 'legR', pos: THREE.Vector3, dir: THREE.Vector3): boolean {
    const m = this.torn.has(part) ? this.stumps.get(part) : undefined;
    if (!m) return false;
    m.updateWorldMatrix(true, false);
    pos.setFromMatrixPosition(m.matrixWorld);
    dir.set(0, -1, 0).transformDirection(m.matrixWorld);
    return true;
  }

  /** Puts blown-off parts back (pooled bodies). */
  private mend(): void {
    for (const part of this.torn) {
      const leg = part === 'legL' ? this.legL : part === 'legR' ? this.legR : null;
      (leg ? leg.upper : this.head).scale.setScalar(1);
      const m = this.stumps.get(part);
      if (m) m.visible = false;
    }
    this.torn.clear();
  }

  /** Runs `fn` with every arm and leg at full size (a ragdoll reads the real joint positions). */
  withWholeArms(fn: () => void): void {
    const ls = [this.armL, this.armR, this.legL, this.legR];
    const saved = ls.map((l) => [l.upper.scale.x, l.lower.scale.x]);
    for (const l of ls) {
      l.upper.scale.setScalar(1);
      l.lower.scale.setScalar(1);
    }
    this.root.updateMatrixWorld(true);
    try {
      fn();
    } finally {
      ls.forEach((l, i) => {
        l.upper.scale.setScalar(saved[i][0]);
        l.lower.scale.setScalar(saved[i][1]);
      });
      this.root.updateMatrixWorld(true);
    }
  }

  /** Gore off: stumps go dark instead of red, and no wounds or blood show on the body. */
  set goreShown(on: boolean) {
    if (this.gore) tintGore(this.gore, on);
    if (this.decay) this.decay.uZ.value.w = on ? 1 : 0;
  }

  /** Thickness of the body at a joint: how wide the stump left there must be. */
  private cutRadius(bone: number): number {
    const geo = this.mesh.geometry;
    const pos = geo.getAttribute('position');
    const si = geo.getAttribute('skinIndex');
    const joint = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().copy(this.skeleton.boneInverses[bone]).invert());
    // A shoulder cut is measured on the upper arm just below the joint; an elbow cut just above.
    const upper = bone === BONE.armLUpper || bone === BONE.armRUpper || bone === BONE.legLUpper || bone === BONE.legRUpper;
    const which = upper ? bone : bone - 1;
    const y0 = upper ? joint.y - 0.08 : joint.y, y1 = upper ? joint.y - 0.02 : joint.y + 0.06;
    let r = 0;
    for (let i = 0; i < pos.count; i++) {
      if (si.getX(i) !== which) continue;
      const y = pos.getY(i);
      if (y < y0 || y > y1) continue;
      r = Math.max(r, Math.hypot(pos.getX(i) - joint.x, pos.getZ(i) - joint.z));
    }
    const leg = bone >= BONE.legLUpper;
    return leg ? THREE.MathUtils.clamp((r || 0.09) * 1.08, 0.065, 0.14) : THREE.MathUtils.clamp(r || 0.05, 0.035, 0.09);
  }

  /** Adds blood to the bones of a hit zone (0..1 per bone). */
  wound(zone: HitZone, amount: number): void {
    for (const b of ZONE_BONES[zone]) this.wounds[b] = Math.min(1, this.wounds[b] + amount * (b === BONE.hips ? 0.5 : 1));
  }

  clearWounds(): void {
    this.wounds.fill(0);
    if (!this.decay) return;
    for (const h of this.decay.uHits.value) h.set(0, 0, 0, 0);
    this.decay.uHitK.value.fill(0);
    this.soakTo.fill(0);
    this.nextHit = 0;
  }

  /**
   * A local wound where a hit landed (world space): a hole with a raw ring, its blood soaking
   * outward over the next seconds. `severity` 0..1 (exit wounds and blades go higher). A hit
   * next to an earlier wound opens that one further instead.
   */
  woundAt(world: THREE.Vector3, zone: HitZone, severity: number): void {
    if (!this.decay) return;
    const p = this.toBind(world, zone, _a);
    if (!p) return;
    this.addHit(p, severity, false);
  }

  /** Older wounds it turned up with (already soaked through), placed by `seed`. */
  oldWounds(seed: number, count: number): void {
    if (!this.decay) return;
    const lists = verticesByBone(this.body);
    let r = (seed * 2654435761) >>> 0;
    const next = () => ((r = Math.imul(r ^ (r >>> 15), 0x2c1b3c6d) + 0x6d2b79f5 >>> 0) / 4294967296);
    for (let i = 0; i < count; i++) {
      const bone = [BONE.spine, BONE.spine, BONE.hips, BONE.armLUpper, BONE.armRLower, BONE.legLUpper, BONE.legRLower, BONE.head][Math.floor(next() * 8)];
      const l = lists[bone];
      if (!l.length) continue;
      const v = Math.floor(next() * (l.length / 3)) * 3;
      this.addHit(_a.set(l[v], l[v + 1], l[v + 2]), 0.3 + next() * 0.7, true);
    }
  }

  private addHit(p: THREE.Vector3, severity: number, settled: boolean): void {
    const d = this.decay!;
    const hits = d.uHits.value, k = d.uHitK.value;
    const reach = 0.05 + 0.07 * severity;
    for (let i = 0; i < MAX_HITS; i++) {
      if (hits[i].w <= 0 || p.distanceToSquared(_b.set(hits[i].x, hits[i].y, hits[i].z)) > 0.05 * 0.05) continue;
      k[i] = Math.min(1.6, k[i] + severity * 0.4);
      this.soakTo[i] = Math.min(0.3, this.soakTo[i] + reach * 0.5);
      return;
    }
    const i = this.nextHit;
    this.nextHit = (i + 1) % MAX_HITS;
    k[i] = severity;
    this.soakTo[i] = reach;
    hits[i].set(p.x, p.y, p.z, settled ? reach : 0.012 + 0.012 * severity);
  }

  /** Blood spreads through the cloth around each wound (also on the dead). */
  private soak(dt: number): void {
    if (!this.decay) return;
    const hits = this.decay.uHits.value;
    const k = 1 - Math.exp(-dt * 0.45);
    for (let i = 0; i < MAX_HITS; i++) {
      const h = hits[i];
      if (h.w > 0 && h.w < this.soakTo[i]) h.w += (this.soakTo[i] - h.w) * k + dt * 0.002;
    }
  }

  /**
   * A world point on this body into bind-pose space: through whichever of the zone's bones
   * it is nearest, then onto that bone's surface (hit capsules are not the mesh).
   */
  private toBind(world: THREE.Vector3, zone: HitZone, out: THREE.Vector3): THREE.Vector3 | null {
    const lists = verticesByBone(this.body);
    let best = Infinity;
    let found = false;
    for (const b of ZONE_BONES[zone]) {
      const bone = this.bones[b];
      bone.updateWorldMatrix(true, false);
      if (bone.matrixWorld.determinant() < 1e-6) continue; // collapsed (severed)
      _m.multiplyMatrices(bone.matrixWorld, this.skeleton.boneInverses[b]).invert();
      _c.copy(world).applyMatrix4(_m);
      const l = lists[b];
      for (let i = 0; i < l.length; i += 3) {
        const dx = l[i] - _c.x, dy = l[i + 1] - _c.y, dz = l[i + 2] - _c.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < best) {
          best = d2;
          out.set(l[i], l[i + 1], l[i + 2]);
          found = true;
        }
      }
    }
    return found ? out : null;
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
    this.soak(dt);
    if (!this.zombie && this.eyes) {
      // Blink every few seconds; a ragdoll's eyes stay shut.
      this.blinkT -= dt;
      if (this.blinkT < -0.14) this.blinkT = 1.5 + Math.random() * 4;
      this.eyes.scale.y = HEAD_K * (this.ragdoll ? 0.12 : this.blinkT < 0 ? 0.12 + Math.abs(this.blinkT + 0.07) * 12 : 1);
      this.glance(dt, target);
      if (this.weathering) this.weather(dt, target);
    }
    if (this.ragdoll) return;
    const s = this.smoothed;
    const k = 1 - Math.exp(-dt * 10);
    s.speed += (target.speed - s.speed) * k;
    s.crouch += (target.crouch - s.crouch) * k;
    s.aim += (target.aim - s.aim) * (1 - Math.exp(-dt * 14));
    s.strafe += (target.strafe - s.strafe) * k;
    s.grounded = target.grounded;
    const z = this.zombie;
    const runner = z && this.gait === 'runner';
    const brute = z && this.gait === 'brute';

    const speed = s.speed;
    const run = runner ? THREE.MathUtils.smoothstep(speed, 2.0, 4.2) : THREE.MathUtils.smoothstep(speed, z ? 1.3 : 3.6, z ? 2.2 : 6);
    let moving = THREE.MathUtils.smoothstep(speed, 0.1, 1.0);

    // Travel direction: hips swing toward it (strafing), and walk backwards when backpedalling.
    const ang = moving > 0.2 ? target.moveAngle ?? 0 : 0;
    const back = Math.abs(ang) > 1.9;
    const dir = back ? -1 : 1;
    if (dir !== this.moveDir && moving > 0.2) this.moveDir = dir;
    let hipTarget = back ? Math.atan2(Math.sin(ang - Math.PI), Math.cos(ang - Math.PI)) : ang;
    hipTarget = THREE.MathUtils.clamp(hipTarget, -0.8, 0.8) * moving;
    // On a skateboard the hips stand side-on to the deck, the shoulders turning back toward the facing.
    if (this.skate) Object.assign(this.lastSkate, this.skate);
    this.skateW += ((this.skate ? 1 : 0) - this.skateW) * (1 - Math.exp(-dt * 12));
    if (!this.skate && this.skateW < 0.003) this.skateW = 0;
    if (this.skateW > 0) hipTarget = THREE.MathUtils.lerp(hipTarget, this.skateHip(dt), this.skateW);
    this.hipYaw += (hipTarget - this.hipYaw) * (1 - Math.exp(-dt * (this.skateW > 0 ? 12 : 8)));

    // Turning on the spot shuffles the feet.
    const turn = Math.abs(target.turn ?? 0);
    const shuffleTarget = speed < 0.4 ? THREE.MathUtils.clamp((turn - 0.8) / 2, 0, 1) : 0;
    this.shuffle += (shuffleTarget - this.shuffle) * (1 - Math.exp(-dt * 8));
    moving = Math.max(moving, this.shuffle * 0.45);

    const strideFreq = runner ? 1.0 + speed * 0.42 : brute ? 0.72 + speed * 0.42 : z ? 0.9 + speed * 0.55 : 1.35 + speed * 0.32;
    this.phase += dt * strideFreq * Math.PI * 2 * (moving > 0.01 ? 1 : 0.25) * this.moveDir;
    const p = this.phase;
    const sin = Math.sin(p);
    const cos = Math.cos(p);

    const legAmp = (0.42 + run * (runner ? 0.55 : 0.35)) * moving * (brute ? 0.85 : 1);
    const kneeAmp = (0.55 + run * (runner ? 0.95 : 0.6)) * moving;
    const armAmp = (0.35 + run * 0.6) * moving;
    const crouch = s.crouch;

    this.down += (this.downTarget - this.down) * (1 - Math.exp(-dt * (this.downTarget > this.down ? 7 : 3)));
    this.crawl += (this.crawlTarget - this.crawl) * (1 - Math.exp(-dt * 6));
    if (Math.abs(this.crawlTarget - this.crawl) < 1e-3) this.crawl = this.crawlTarget;
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
    const lean = run * (runner ? 0.5 : z ? 0.3 : 0.22) + moving * 0.05 + crouch * 0.35;
    // Walkers stoop, runners hunt low, brutes hunch over their own bulk.
    const zLean = z ? (runner ? 0.24 : brute ? 0.46 : 0.34) + Math.sin(p * 0.5 + this.seed) * 0.03 : 0;
    const sv = this.stagger;
    this.hips.position.set(0, 0.95 - crouch * 0.33 + bob - (z ? 0.05 : 0), 0);
    // A brute rolls its weight from foot to foot.
    this.hips.rotation.set(0, -sin * 0.1 * moving + this.hipYaw, brute ? sin * 0.07 * moving : 0);
    // Spine: lean, look pitch, bladed stance, recoil, flinches and stagger.
    let spineX = lean + zLean - s.aim * 0.05 - this.lookPitch * LOOK_BEND + this.kick + ft[0].x * 0.08 - sv * this.staggerDir.y * 0.45;
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
    const limp = runner ? 0.94 : brute ? 0.8 : z ? 0.55 : 1;
    this.legL.upper.rotation.set(-sin * legAmp - crouch * 0.9, 0, 0);
    this.legR.upper.rotation.set(sin * legAmp * limp - crouch * 0.9, 0, 0);
    this.legL.lower.rotation.set(Math.max(0, cos) * kneeAmp + crouch * 1.5 + (s.grounded ? 0 : 0.6), 0, 0);
    this.legR.lower.rotation.set(Math.max(0, -cos) * kneeAmp * limp + crouch * 1.5 + (s.grounded ? 0 : 0.3), 0, 0);
    if (brute) {
      // Wide, heavy stance.
      this.legL.upper.rotation.z = 0.09;
      this.legR.upper.rotation.z = -0.09;
    }
    if (!s.grounded) {
      this.legL.upper.rotation.x -= 0.5;
      this.legR.upper.rotation.x += 0.1;
    }
    this.legL.upper.rotation.x -= fl[2].x * 0.06;
    this.legR.upper.rotation.x -= fl[3].x * 0.06;

    // Arms: free swing (survivors' are overridden by IK when holding a weapon).
    if (z) {
      const reach = brute ? 0.55 + Math.sin(p * 0.7 + this.seed) * 0.08 : 1.25 + Math.sin(p * 0.7 + this.seed) * 0.12 + run * 0.25;
      // `spread` swings the arms outward (negative converges the reaching hands).
      let ux = -reach, lx = brute ? -0.45 : -0.3, spread = brute ? 0.32 : -0.12;
      let swing = 0.1;
      if (runner && run > 0.01) {
        // Sprinting: arms pump and flail instead of reaching.
        ux = THREE.MathUtils.lerp(ux, -0.75, run * 0.85);
        lx = THREE.MathUtils.lerp(lx, -1.35, run);
        spread = THREE.MathUtils.lerp(spread, 0.18, run);
        swing = 0.1 + run * 0.95;
      } else if (brute) {
        swing = 0.28 * moving + 0.04;
      }
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
      if (this.scream >= 0) {
        // Rears back with arms flung wide and down, then holds the call.
        const k = THREE.MathUtils.smoothstep(this.scream, 0, 0.3) * (1 - THREE.MathUtils.smoothstep(this.scream, 0.85, 1));
        ux = THREE.MathUtils.lerp(ux, 0.35, k);
        lx = THREE.MathUtils.lerp(lx, -0.25, k);
        spread = THREE.MathUtils.lerp(spread, 0.75, k);
        swing *= 1 - k;
      }
      // Staggering throws the arms out.
      ux = THREE.MathUtils.lerp(ux, -0.6, sv * 0.6);
      spread += sv * 0.8;
      this.armL.upper.rotation.set(ux + sin * swing - fl[0].x * 0.05, 0, spread);
      this.armR.upper.rotation.set(ux * 0.92 - sin * swing - fl[1].x * 0.05, 0, -spread);
      this.armL.lower.rotation.set(lx, 0, 0);
      this.armR.lower.rotation.set(lx - 0.1, 0, 0);
      this.head.rotation.set(
        (runner ? -0.08 * run : brute ? 0.1 : 0) + 0.12 + Math.sin(p * 0.3) * 0.1 - zLean * 0.4 + fh[0].x * 0.1 - sv * this.staggerDir.y * 0.4,
        Math.sin(p * 0.21 + this.seed) * 0.3,
        0.25 * Math.sin(this.seed) + fh[1].x * 0.1,
      );
      if (this.scream >= 0) {
        // Chest out, head thrown back, shaking with the effort.
        const k = THREE.MathUtils.smoothstep(this.scream, 0, 0.3) * (1 - THREE.MathUtils.smoothstep(this.scream, 0.85, 1));
        const shake = this.scream > 0.3 ? Math.sin(performance.now() * 0.09) * 0.04 * k : 0;
        this.spine.rotation.x -= (zLean + 0.38) * k;
        this.head.rotation.x = THREE.MathUtils.lerp(this.head.rotation.x, -0.42 + shake, k);
        this.head.rotation.y *= 1 - k;
        this.head.rotation.z = THREE.MathUtils.lerp(this.head.rotation.z, shake, k);
      }
    } else {
      const swingL = sin * armAmp;
      const swingR = -sin * armAmp;
      this.armL.upper.rotation.set(swingL - crouch * 0.2 - fl[0].x * 0.05, 0, 0.08);
      this.armR.upper.rotation.set(swingR - crouch * 0.2 - fl[1].x * 0.05, 0, -0.08);
      this.armL.lower.rotation.set(-0.25 - run * 0.9, 0, 0);
      this.armR.lower.rotation.set(-0.25 - run * 0.9, 0, 0);
      // The head keeps looking where the body faces whatever the hips and shoulders do.
      this.head.rotation.set(-lean * 0.6 - this.lookPitch * 0.4 + fh[0].x * 0.1, -this.twist - (swingY - sin * 0.1 * moving) * 0.7, fh[1].x * 0.08);
      this.idleLife(dt, speed, moving, crouch, s.aim);
    }

    if (z && this.crawl > 0.001) this.crawlPose(p, moving, sv);
    if (this.skateW > 0.001) this.skatePose(crouch);

    // Knocked down: fall onto the back, feet toward the facing direction, arms splayed.
    const d = this.crawl > 0.5 ? 0 : this.down;
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
    if (sign !== this.lastStepSign && moving > 0.3 && s.grounded && d < 0.2 && this.crawl < 0.5) {
      this.onFootstep?.(Math.min(1, speed / 6) * (1 - crouch * 0.6));
    }
    this.lastStepSign = sign;
    if (this.stumps.size) this.syncStumps();
  }

  /**
   * Survivors standing about: they breathe (quicker and deeper for a while after a run), shift
   * their weight from foot to foot every several seconds (hips swaying over the standing leg,
   * the other knee easing), and settle into a ready stance, feet apart with the left a little
   * forward and the knees soft. The feet stay where they are planted.
   */
  private idleLife(dt: number, speed: number, moving: number, crouch: number, aim: number): void {
    const run = THREE.MathUtils.smoothstep(speed, 3.5, 6);
    this.winded = THREE.MathUtils.clamp(this.winded + (run * 0.14 - (1 - run) * 0.07) * dt, 0, 1);
    this.breathP += dt * Math.PI * 2 * (0.23 + 0.4 * this.winded);
    const settle = (1 - moving) * (1 - this.skateW) * (this.smoothed.grounded ? 1 : 0) * (1 - this.down);
    this.still += (settle - this.still) * (1 - Math.exp(-dt * 3));
    const st = this.still;

    // Breath: the chest lifts (the head holds its gaze).
    // (Less while aiming, so the gun on the shoulder doesn't bob with it.)
    const b = (Math.sin(this.breathP) + 0.25 * Math.sin(this.breathP * 2)) * (1 + this.winded * 1.6) * (0.35 + 0.65 * st) * (1 - aim * 0.6);
    this.spine.rotation.x -= b * 0.012;
    this.head.rotation.x += b * 0.008;

    if (st < 0.002) return;
    // A slight lean into the stance, the head drifting about a little when not aiming.
    this.spine.rotation.x += 0.05 * st;
    this.head.rotation.x -= 0.03 * st;
    const t = this.breathP * 0.37 + this.seed;
    this.head.rotation.y += (Math.sin(t * 0.31) * 0.09 + Math.sin(t * 0.13 + 1.7) * 0.06) * st * (1 - aim);

    // Weight shift: mostly resting on one leg, moving across now and then.
    this.shiftP += dt * (Math.PI * 2) / 13;
    const w = Math.tanh(Math.sin(this.shiftP) * 2.5) / Math.tanh(2.5) * st * (1 - aim * 0.6) * (1 - crouch);
    const sway = w * 0.018, roll = w * 0.035;
    this.hips.position.x += sway;
    this.hips.rotation.z += roll;
    this.spine.rotation.z -= roll * 0.8;

    // Feet apart, left foot forward, knees soft (the free one more so), hips down to match.
    const legLen = LEG.upper + LEG.lower;
    const plant = -roll - Math.asin(sway / legLen);
    const soft = 0.1 * st * (1 - crouch);
    const kL = soft + Math.max(0, -w) * 0.12, kR = soft + Math.max(0, w) * 0.12;
    this.legL.upper.rotation.z += 0.075 * st + plant;
    this.legR.upper.rotation.z += -0.075 * st + plant;
    this.legL.upper.rotation.x += -0.08 * st - kL / 2;
    this.legR.upper.rotation.x += 0.05 * st - kR / 2;
    this.legL.lower.rotation.x += kL;
    this.legR.lower.rotation.x += kR;
    this.hips.position.y -= legLen * (1 - Math.cos(Math.min(kL, kR) / 2)) + legLen * (1 - Math.cos(0.075 * st)) * 0.5;
  }

  /** Eyes: a dart aside every second or few and back, leading the head into a turn, ahead while aiming. */
  private glance(dt: number, target: LocomotionState): void {
    if (!this.irises) return;
    this.gazeT -= dt;
    if (this.gazeT <= 0) {
      this.gazeT = 0.5 + Math.random() * 2.6;
      if (Math.random() < 0.35) this.gazeTo.set(0, 0);
      else this.gazeTo.set((Math.random() * 2 - 1) * 0.0034, (Math.random() * 2 - 1) * 0.002);
    }
    const free = 1 - THREE.MathUtils.smoothstep(target.aim, 0.3, 0.7);
    const tx = THREE.MathUtils.clamp(this.gazeTo.x * free + (target.turn ?? 0) * 0.0016, -0.0042, 0.0042);
    const ty = this.gazeTo.y * free;
    const k = 1 - Math.exp(-dt * 30);
    this.gaze.x += (tx - this.gaze.x) * k;
    this.gaze.y += (ty - this.gaze.y) * k;
    this.irises.position.set(this.gaze.x, this.gaze.y, 0);
  }

  /** Dirt builds up through a night: faster on the move, crouching, and most of all on the ground. */
  private weather(dt: number, target: LocomotionState): void {
    const rate = 0.0006 + target.speed * 0.00016 + target.crouch * 0.0012 + this.down * 0.02;
    this.grime.x = Math.min(1, this.grime.x + rate * dt);
  }

  /** Blood on the survivor's clothes and skin (a hit taken, a kill up close): adds up to 1. */
  splatter(amount: number): void {
    this.grime.y = Math.min(1, this.grime.y + amount);
  }

  /**
   * Which way the hips turn on a skateboard (relative to the facing): side-on to the deck, the
   * left foot forward (regular) or the right (goofy), whichever leaves the shoulders less to turn
   * toward where the survivor faces (switching only past a margin, so it doesn't flicker); pushing
   * opens them toward the nose. The shoulders only turn so far from the hips: past that the hips
   * come round too.
   */
  private skateHip(dt: number): number {
    const sk = this.lastSkate;
    const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
    const reg = wrap(sk.yaw - Math.PI / 2), goofy = wrap(sk.yaw + Math.PI / 2);
    if (this.stance > 0 ? Math.abs(goofy) < Math.abs(reg) - 1.1 : Math.abs(reg) < Math.abs(goofy) - 1.1) this.stance = -this.stance;
    const ease = (cur: number, to: number, rate: number) => cur + (to - cur) * (1 - Math.exp(-dt * rate));
    this.pushK = ease(this.pushK, sk.push >= 0 ? 1 : 0, 9);
    this.airK = ease(this.airK, sk.air ? 1 : 0, 14);
    this.leanK = ease(this.leanK, sk.lean, 8);
    const hip = (this.stance > 0 ? reg : goofy) + this.stance * 0.55 * this.pushK;
    return THREE.MathUtils.clamp(wrap(hip), -1.25, 1.25);
  }

  /**
   * Feet on the deck: the front foot over the front bolts, the back foot on the tail (or kicking
   * along the ground beside the board while pushing), knees bent, lower when crouched or in the
   * air, the body leaning into a carve. The feet are put there with leg IK, so they stay on the
   * board whichever way the shoulders turn to aim.
   */
  private skatePose(crouch: number): void {
    const w = this.skateW;
    const e = w * w * (3 - 2 * w);
    const sk = this.lastSkate;
    const L = THREE.MathUtils.lerp;
    const hipsY = sk.deck + 0.84 - crouch * 0.2 - this.pushK * 0.07 - this.airK * 0.12;
    // Board axes in the root's space: forward (nose) and its left side.
    const bx = Math.sin(sk.yaw), bz = Math.cos(sk.yaw);
    const sx = Math.cos(sk.yaw), sz = -Math.sin(sk.yaw);
    this.hips.position.y = L(this.hips.position.y, hipsY, e);
    // A little forward over the deck, and the shoulders leaning in toward the middle of a carve.
    this.spine.rotation.x += (0.1 * (1 - crouch) + sz * this.leanK * 0.16) * e;
    this.spine.rotation.z -= sx * this.leanK * 0.16 * e;
    // Looking down the street over the front shoulder (aiming, the head follows the gun).
    const ahead = THREE.MathUtils.clamp(Math.atan2(Math.sin(sk.yaw), Math.cos(sk.yaw)), -1.6, 1.6) * 0.55;
    this.head.rotation.y += ahead * (1 - this.smoothed.aim) * e;
    this.root.updateMatrixWorld(true);
    // The toe side: the side of the board the hips face.
    const fx = Math.sin(this.hipYaw), fz = Math.cos(this.hipYaw);
    const toe = fx * sx + fz * sz >= 0 ? 1 : -1;
    const ankle = sk.deck + 0.035;
    const front = this.stance > 0 ? this.legL : this.legR;
    const rear = this.stance > 0 ? this.legR : this.legL;
    const put = (out: THREE.Vector3, along: number, side: number, y: number) =>
      out.set(bx * along + sx * side * toe, y, bz * along + sz * side * toe);
    put(_sk1, 0.2, 0.015, ankle + this.airK * 0.02);
    // Back foot: on the tail, or the kick (down beside the board ahead, push back along the ground, up onto the tail).
    const p = sk.push;
    if (p >= 0 && !sk.air) {
      const a = 0.18, b = 0.62;
      const tail = { along: -0.21, side: 0, y: ankle };
      const down0 = { along: 0.1, side: 0.17, y: 0.035 };
      const down1 = { along: -0.36, side: 0.17, y: 0.035 };
      let from = tail, to = down0, u = 0, lift = 0;
      if (p < a) { u = p / a; lift = 0.06; }
      else if (p < b) { from = down0; to = down1; u = (p - a) / (b - a); }
      else { from = down1; to = tail; u = (p - b) / (1 - b); lift = 0.1; }
      const k = u * u * (3 - 2 * u);
      put(_sk2, L(from.along, to.along, k), L(from.side, to.side, k), L(from.y, to.y, k) + Math.sin(u * Math.PI) * lift);
      // Blend in and out of the push with the hips.
      const tl = put(_sk3, -0.21, 0, ankle);
      _sk2.lerpVectors(tl, _sk2, this.pushK);
    } else {
      put(_sk2, -0.21, 0, ankle + this.airK * 0.03);
    }
    this.root.localToWorld(_sk1);
    this.root.localToWorld(_sk2);
    // Knees bend the way the hips face, a little out over the toes.
    const pole = _sk4.set(fx, -0.15, fz).applyQuaternion(this.root.getWorldQuaternion(_skq)).normalize();
    this.reach(front, _sk1, pole, e);
    this.reach(rear, _sk2, pole, e);
  }

  /** Shoulder and hip stumps turn with the (collapsed) upper limb, so they flail like the stub they are. */
  private syncStumps(): void {
    for (const arm of ['armL', 'armR'] as const) {
      if (this.arms[arm] !== 'shoulder') continue;
      const m = this.stumps.get(`${arm}:shoulder`);
      if (m) m.quaternion.copy((arm === 'armL' ? this.armL : this.armR).upper.quaternion);
    }
    for (const leg of ['legL', 'legR'] as const) {
      if (this.legs[leg] !== 'hip') continue;
      const m = this.stumps.get(`${leg}:hip`);
      if (m) m.quaternion.copy((leg === 'legL' ? this.legL : this.legR).upper.quaternion);
    }
  }

  /**
   * Legless: face down with the chest propped up and the head raised toward its prey, hauling
   * itself along one arm at a time (reach out, dig in, drag the body up to the hand) with what
   * is left of its legs trailing behind. Blended in by `crawl` over the standing pose; a swipe
   * rears up on the arms and lunges, a stagger writhes on the spot.
   */
  private crawlPose(p: number, moving: number, sv: number): void {
    const c = this.crawl;
    const e = c * c * (3 - 2 * c);
    const L = THREE.MathUtils.lerp;
    const cyc = Math.sin(p);
    const heave = Math.abs(Math.cos(p)) * moving;
    // Lunging at someone: rears up on the arms, then throws itself forward.
    let lunge = 0;
    if (this.attack >= 0) {
      const a = this.attack;
      lunge = a < 0.5 ? a / 0.5 : a < 0.66 ? 1 - ((a - 0.5) / 0.16) * 1.6 : -0.6 * (1 - (a - 0.66) / 0.34);
    }
    const writhe = sv * Math.sin(performance.now() * 0.021 + this.seed) * 0.22;
    const hipsY = 0.2 + heave * 0.035 + Math.max(0, lunge) * 0.07;
    this.hips.position.set(L(this.hips.position.x, 0, e), L(this.hips.position.y, hipsY, e), L(this.hips.position.z, -0.3 + lunge * 0.06, e));
    // Pitched forward until the spine runs ahead along the ground; rolls side to side with each pull.
    this.hips.rotation.x = L(this.hips.rotation.x, 1.25 - Math.max(0, lunge) * 0.12, e);
    this.hips.rotation.z = L(this.hips.rotation.z, cyc * 0.07 * moving + writhe * 0.6, e);
    this.hips.rotation.y = L(this.hips.rotation.y, cyc * 0.06 * moving, e);
    this.spine.rotation.x = L(this.spine.rotation.x, -0.2 - Math.max(0, lunge) * 0.12 + (this.bash >= 0 ? Math.sin(this.bash * Math.PI) * 0.15 : 0), e);
    this.spine.rotation.z = L(this.spine.rotation.z, -cyc * 0.1 * moving + writhe, e);
    this.spine.rotation.y = L(this.spine.rotation.y, cyc * 0.12 * moving, e);
    // Arms: each one reaches ahead and claws back in turn (both forward when it stops).
    for (const [arm, side] of [[this.armL, 1], [this.armR, -1]] as const) {
      let t = moving > 0.05 ? 0.5 + 0.5 * cyc * side : 0.65;
      t = L(0.65, t, Math.min(1, moving * 1.5));
      let ux = L(-0.95, -2.05, t) - (t > 0.5 ? Math.max(0, Math.cos(p) * side) * 0.25 * moving : 0);
      let lx = L(-1.15, -0.3, t);
      if (this.attack >= 0) {
        ux = L(ux, -1.75 - lunge * 0.35, Math.min(1, Math.abs(lunge) * 1.4));
        lx = L(lx, -0.2, Math.min(1, Math.abs(lunge)));
      }
      if (this.bash >= 0) {
        ux = L(ux, -2.3 + Math.sin(this.bash * Math.PI) * 0.5, 0.8);
        lx = L(lx, -0.5, 0.8);
      }
      ux += writhe * side * 1.5;
      arm.upper.rotation.set(L(arm.upper.rotation.x, ux, e), L(arm.upper.rotation.y, 0, e), L(arm.upper.rotation.z, 0.28 * side + sv * 0.4 * side, e));
      arm.lower.rotation.set(L(arm.lower.rotation.x, lx, e), 0, 0);
    }
    // What is left of the legs drags behind, twitching, rolled out onto their sides (feet flopped outward).
    for (const [leg, side] of [[this.legL, 1], [this.legR, -1]] as const) {
      const twitch = Math.sin(p * 0.5 + side * 1.7 + this.seed) * 0.06 * moving + writhe * 0.8;
      leg.upper.rotation.set(L(leg.upper.rotation.x, 0.3 + twitch, e), L(leg.upper.rotation.y, 1.35 * side, e), L(leg.upper.rotation.z, 0.14 * side, e));
      leg.lower.rotation.set(L(leg.lower.rotation.x, 0.12 + Math.max(0, twitch), e), 0, 0);
    }
    // Chin up, eyes on its prey.
    this.head.rotation.x = L(this.head.rotation.x, -0.85 + Math.sin(p * 0.5) * 0.06 - Math.max(0, lunge) * 0.15, e);
    this.head.rotation.z = L(this.head.rotation.z, this.head.rotation.z + writhe, e);
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
    if (this.gore) return [this.material, this.gore];
    return this.eyeMaterial && !this.zombie ? [this.material, this.eyeMaterial] : [this.material];
  }

  /** Standing rest pose (pool reuse, after a ragdoll). */
  resetPose(): void {
    this.ragdoll = false;
    this.skate = null;
    this.skateW = 0;
    this.down = this.downTarget = 0;
    this.stagger = this.staggerTarget = 0;
    this.attack = this.bash = this.scream = -1;
    this.kick = this.twist = this.lookPitch = 0;
    for (const sp of [...this.flinchHead, ...this.flinchTorso, ...this.flinchLimb]) sp.x = sp.v = 0;
    for (const b of this.bones) b.rotation.set(0, 0, 0);
    this.hips.position.set(0, 0.95, 0);
    this.root.position.y = 0;
    this.setArm('armL', 'intact');
    this.setArm('armR', 'intact');
    this.mend();
    this.setLeg('legL', 'intact');
    this.setLeg('legR', 'intact');
    this.crawl = this.crawlTarget = 0;
  }

  dispose(): void {
    this.root.removeFromParent();
    untrackDecayMaterial(this.material);
    this.material.dispose();
    for (const m of this.stumps.values()) m.geometry.dispose();
    this.stumps.clear();
    this.gore?.dispose();
    this.skeleton.dispose();
    releaseBody(this.bodyKey);
    for (const g of this.eyeGeometries) g.dispose();
    this.eyeMaterial?.dispose();
  }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _e = new THREE.Vector3(), _f = new THREE.Vector3(), _g = new THREE.Vector3(), _h = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const _m = new THREE.Matrix4();
/** Skate pose scratch (reach() uses the ones above). */
const _sk1 = new THREE.Vector3(), _sk2 = new THREE.Vector3(), _sk3 = new THREE.Vector3(), _sk4 = new THREE.Vector3();
const _skq = new THREE.Quaternion();

/** Decay uniforms for a zombie look (`body` false for a severed arm cut from it). */
export function decayOf(look: HumanoidLook, seed: number, body: boolean): DecayUniforms {
  const mutation = look.mutation === 'screamer' ? 1 : look.mutation === 'bloater' ? 2 : 0;
  return createDecayUniforms(look.skin ?? 0x7d8a72, look.decay ?? 0.6, mutation, seed, body);
}

/** Number of distinct zombie looks per kind (looks repeat beyond this). */
export const ZOMBIE_LOOK_COUNT = 12;
export const ZOMBIE_LOOKS: Record<ZombieGait, number> = { walker: ZOMBIE_LOOK_COUNT, runner: 6, brute: 4 };

/** How each kind moves: crawlers (not spawned yet) walk, screamers run, bloaters lumber. */
export const gaitOf = (kind: ZombieKind): ZombieGait =>
  kind === 'runner' || kind === 'screamer' ? 'runner' : kind === 'brute' || kind === 'bloater' ? 'brute' : 'walker';

/** Distinct looks per kind. */
export const kindLooks = (kind: ZombieKind): number => (kind === 'screamer' ? 4 : kind === 'bloater' ? 4 : ZOMBIE_LOOKS[gaitOf(kind)]);

/** A zombie of `kind` wearing its look number `i`. */
export function zombieLookOf(kind: ZombieKind, i: number): HumanoidLook {
  if (kind === 'screamer') return screamerLook(i);
  if (kind === 'bloater') return bloaterLook(i);
  return zombieLook(i, gaitOf(kind));
}

/** Screamers: gaunt, grey-white and hairless but for straggles, jaw hanging open, pale glowing eyes. */
function screamerLook(i: number): HumanoidLook {
  const k = i % 4;
  const rand = rng(0x5c4ea + k * 7727);
  const a = randomAppearance(rand, k % 2 ? 'female' : 'male');
  a.build = 'slim';
  a.top = (['tank', 'longsleeve', 'tee', 'tank'] as const)[k];
  a.topColor = [0, 2, 14, 3][k];
  a.pants = (['jeans', 'joggers', 'work', 'jeans'] as const)[k];
  a.shoes = 'sneakers';
  a.hair = k % 2 ? 'messy' : 'bald';
  a.hairColor = 3;
  a.headwear = 'none';
  a.facialHair = 'none';
  a.face = a.neck = a.gloves = a.back = a.gear = 'none';
  return { outfit: a, zombie: true, skin: [0xb4b4a8, 0xa9aca2, 0xbab6aa, 0xa5a59a][k], gait: 'runner', girth: 0.9, eyeGlow: 0xe8f4ff, mutation: 'screamer', decay: 0.7 };
}

/** Bloaters: swollen with gas, sallow yellow-green skin, in what still fits, sickly yellow eyes. */
function bloaterLook(i: number): HumanoidLook {
  const k = i % 4;
  const rand = rng(0xb10a7 + k * 6007);
  const a = randomAppearance(rand, 'male');
  a.build = 'broad';
  a.top = (['tank', 'tee', 'tank', 'tee'] as const)[k];
  a.topColor = [0, 7, 14, 10][k];
  a.pants = (['work', 'jeans', 'joggers', 'cargo'] as const)[k];
  a.shoes = 'work';
  a.hair = k === 2 ? 'buzz' : 'bald';
  a.headwear = k === 3 ? 'cap' : 'none';
  a.face = a.neck = a.gloves = a.back = a.gear = 'none';
  return { outfit: a, zombie: true, skin: [0x8f9468, 0x9a9a6a, 0x868c62, 0x939060][k], gait: 'brute', girth: 1.32, eyeGlow: 0xd8e040, mutation: 'bloater', decay: 0.7 };
}

const ZOMBIE_SKINS = [0x7d8a72, 0x8b8a76, 0x6f7a6a, 0x948f7e, 0x86806c, 0x6a7466];
const ZOMBIE_HATS = ['cap', 'beanie', 'hardhat', 'army', 'bandana', 'fire', 'capback', 'bike'] as const;

/**
 * The neighborhood's dead wear what the living wear: men and women in everyday clothes from the
 * same catalog, now filthy and torn, with the odd work helmet. One in twelve died at a party.
 */
export function zombieLook(i: number, kind: ZombieGait = 'walker'): HumanoidLook {
  if (kind === 'runner') return runnerLook(i);
  if (kind === 'brute') return bruteLook(i);
  const k = i % ZOMBIE_LOOK_COUNT;
  const rand = rng(0x5eed + k * 7919);
  const a = randomAppearance(rand);
  a.headwear = k === 11 ? 'party' : rand() < 0.35 ? ZOMBIE_HATS[Math.floor(rand() * ZOMBIE_HATS.length)] : 'none';
  if (a.hair === 'afro' || a.hair === 'mohawk') a.hair = 'messy';
  a.face = k === 4 ? 'surgical' : 'none';
  a.back = k === 6 ? 'backpack' : 'none';
  a.gear = k === 2 ? 'hivis' : k === 9 ? 'tactical' : 'none';
  a.neck = 'none';
  a.gloves = 'none';
  return { outfit: a, zombie: true, skin: ZOMBIE_SKINS[k % ZOMBIE_SKINS.length], decay: 0.5 + (k % 4) * 0.12 };
}

/**
 * Runners turned recently and fast: lean, light clothes (gym kit, joggers, sneakers), less rot,
 * and rabid red eyes.
 */
function runnerLook(i: number): HumanoidLook {
  const k = i % ZOMBIE_LOOKS.runner;
  const rand = rng(0x7a11 + k * 104729);
  const a = randomAppearance(rand);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  a.build = 'slim';
  a.top = (['tank', 'tee', 'track', 'hoodie', 'longsleeve', 'tee'] as const)[k];
  a.pants = pick(['joggers', 'shorts', 'joggers', 'jeans'] as const);
  a.shoes = pick(['sneakers', 'hightops'] as const);
  a.headwear = k === 2 ? 'sweatband' : k === 4 ? 'capback' : 'none';
  if (a.hair === 'afro' || a.hair === 'mohawk') a.hair = 'short';
  a.facialHair = 'none';
  a.face = a.neck = a.gloves = a.back = a.gear = 'none';
  return { outfit: a, zombie: true, skin: [0x9a9684, 0x8e8a7a, 0xa39d8a][k % 3], gait: 'runner', eyeGlow: 0xff3a22, decay: 0.3 };
}

/**
 * Brutes were big to begin with and something made them bigger: broad and bulky, in the
 * heavy gear they died in (riot police, road crew, firefighter, biker), with orange eyes.
 */
function bruteLook(i: number): HumanoidLook {
  const k = i % ZOMBIE_LOOKS.brute;
  const rand = rng(0xb2a7e + k * 15485863);
  const a = randomAppearance(rand, 'male');
  a.build = 'broad';
  a.face = a.neck = a.gloves = a.back = 'none';
  a.hair = 'buzz';
  if (k === 0) {
    Object.assign(a, { headwear: 'army', headwearColor: 1, top: 'longsleeve', topColor: 1, pants: 'cargo', pantsColor: 1, shoes: 'combat', shoesColor: 1, gear: 'tactical', gearColor: 0 });
  } else if (k === 1) {
    Object.assign(a, { headwear: 'hardhat', headwearColor: 15, top: 'flannel', topColor: 13, topAccent: 1, pants: 'work', pantsColor: 9, shoes: 'work', shoesColor: 10, gear: 'hivis', gearColor: 16 });
  } else if (k === 2) {
    Object.assign(a, { headwear: 'fire', headwearColor: 13, top: 'raincoat', topColor: 15, pants: 'overalls', pantsColor: 15, shoes: 'rain', shoesColor: 1, gear: 'none' });
  } else {
    Object.assign(a, { headwear: 'none', hair: 'bald', facialHair: 'beard', top: 'leather', topColor: 1, topAccent: 3, pants: 'jeans', pantsColor: 4, shoes: 'combat', shoesColor: 11, gear: 'none' });
  }
  return { outfit: a, zombie: true, skin: [0x6d7563, 0x7a7766, 0x69705f, 0x75705f][k], gait: 'brute', girth: 1.15, eyeGlow: 0xff9a2a, decay: 0.9 };
}

/** A survivor wearing an appearance. */
export function survivorLook(a: Appearance): HumanoidLook {
  return { outfit: a };
}
