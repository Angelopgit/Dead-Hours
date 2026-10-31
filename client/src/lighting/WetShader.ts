import * as THREE from 'three';
import { GROUND_BAND } from './LightBaker';

/** Top-down cover map for rain: 0.5 m texels, the highest roof or slab over each spot. */
export const COVER = { texel: 0.5, minHalf: 128, maxH: 16 } as const;

/** Most outdoor lamps a wet surface (or a rain drop) reflects at once. */
export const WET_LAMPS = 8;

/** An outdoor static lamp, in the form the wet and rain shaders read. */
export interface WetLamp {
  pos: THREE.Vector3;
  /** Linear color × intensity. */
  color: THREE.Color;
  range: number;
  decay: number;
  /** Spot aim (unit) and cos(outer cone); outer = -2 for point lights. */
  dir: THREE.Vector3;
  cosOuter: number;
}

const vec4s = (n: number) => Array.from({ length: n }, () => new THREE.Vector4());

/**
 * Uniforms shared by every wet surface and by the rain: weather state, the nearest outdoor lamps
 * (refreshed each frame around the camera) and the survivor's flashlight.
 */
export const weatherUniforms = {
  /** Named apart from the foliage sway uniforms: both patches can land on one material. */
  uWxTime: { value: 0 },
  uWxWind: { value: new THREE.Vector2(1.2, 0.5) },
  uWetness: { value: 0 },
  uRainAmt: { value: 0 },
  /** What wet ground mirrors away from lamps: the fog-lit sky near the horizon (linear). */
  uSkyRefl: { value: new THREE.Color(0x252e3c).convertSRGBToLinear().multiplyScalar(2.2) },
  uCover: { value: null as THREE.Texture | null },
  /** x0, z0, 1/width, 1/depth of the cover map (set when it is built). */
  uCoverRect: { value: new THREE.Vector4(-COVER.minHalf, -COVER.minHalf, 1 / (COVER.minHalf * 2), 1 / (COVER.minHalf * 2)) },
  uLampCount: { value: 0 },
  uLampPos: { value: vec4s(WET_LAMPS) },
  uLampCol: { value: vec4s(WET_LAMPS) },
  uLampDir: { value: vec4s(WET_LAMPS) },
  /** xyz position, w > 0 when on. */
  uTorchPos: { value: new THREE.Vector4() },
  /** xyz aim, w = cos(outer cone). */
  uTorchDir: { value: new THREE.Vector4(0, 0, -1, 0.9) },
  uTorchCol: { value: new THREE.Vector3() },
};

let lamps: WetLamp[] = [];
let lampBudget = WET_LAMPS;
const order: { lamp: WetLamp; score: number }[] = [];

export function setWetLamps(list: WetLamp[]): void {
  lamps = list;
}

/** How many lamps wet surfaces reflect (graphics quality). */
export function setWetLampBudget(n: number): void {
  lampBudget = Math.max(0, Math.min(WET_LAMPS, n));
}

/** Picks the lamps nearest the camera for this frame's reflections and rain glints. */
export function updateWetLamps(cam: THREE.Vector3): void {
  order.length = 0;
  for (const l of lamps) {
    const d = l.pos.distanceTo(cam) - l.range;
    if (d > 45) continue;
    order.push({ lamp: l, score: d });
  }
  order.sort((a, b) => a.score - b.score);
  const n = Math.min(order.length, lampBudget);
  const u = weatherUniforms;
  for (let i = 0; i < n; i++) {
    const l = order[i].lamp;
    u.uLampPos.value[i].set(l.pos.x, l.pos.y, l.pos.z, l.range);
    u.uLampCol.value[i].set(l.color.r, l.color.g, l.color.b, l.decay);
    u.uLampDir.value[i].set(l.dir.x, l.dir.y, l.dir.z, l.cosOuter);
  }
  u.uLampCount.value = n;
}

/** How readily each ground material holds puddles. */
const PUDDLES: Record<string, number> = { asphalt: 1, sidewalk: 0.8, concrete: 0.8, gravel: 0.5, dirt: 0.6, grass: 0.3, roofFlat: 0.6 };

const WET_COMMON = /* glsl */ `
  uniform float uWetness, uRainAmt, uWxTime;
  uniform vec3 uSkyRefl;
  uniform int uLampCount;
  uniform vec4 uLampPos[${WET_LAMPS}];
  uniform vec4 uLampCol[${WET_LAMPS}];
  uniform vec4 uLampDir[${WET_LAMPS}];
  float wetHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wetNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(wetHash(i), wetHash(i + vec2(1.0, 0.0)), u.x), mix(wetHash(i + vec2(0.0, 1.0)), wetHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Raindrop rings on standing water: one ring per 0.6 m cell, two offset layers. Returns the
  // height gradient on the ground plane.
  vec2 wetRipples(vec2 p, float t) {
    vec2 g = vec2(0.0);
    for (int k = 0; k < 2; k++) {
      vec2 q = p * 1.7 + float(k) * vec2(0.37, 0.71);
      vec2 cell = floor(q);
      vec2 f = fract(q);
      float h = wetHash(cell + float(k) * 17.0);
      vec2 c = 0.5 + 0.36 * (vec2(h, wetHash(cell + 3.7)) - 0.5);
      float ph = fract(t * (0.9 + 0.4 * h) + h);
      vec2 d = f - c;
      float r = length(d);
      float ring = r - ph * 0.42;
      float amp = (1.0 - ph) * (1.0 - smoothstep(0.0, 0.06, abs(ring)));
      g += (r > 1e-3 ? d / r : vec2(0.0)) * cos(ring * 75.0) * amp;
    }
    return g;
  }
`;

/**
 * Rain on static surfaces (after patchBaked, whose varyings it reuses). Exposure to the sky comes
 * from the baked sky visibility, so roofs, roads and lawns soak while rooms, porches and basements
 * stay dry. Wet surfaces darken and turn glossy; low flat spots collect puddles with raindrop
 * ripples; and the nearest outdoor lamps (baked, so they have no specular of their own) are added
 * as GGX highlights, giving the long lamp reflections of a wet street.
 */
/**
 * How much of the wet shading is compiled in: none while rain is off (dry materials cost nothing),
 * a cheap version on low fog quality (darkening, gloss, puddles, baked sheen), everything otherwise
 * (ripples, sky sheen and per-lamp reflections). Changing it recompiles the wet materials.
 */
export type WetTier = 'off' | 'cheap' | 'full';
let wetTier: WetTier = 'full';
const wetMaterials = new Set<THREE.Material>();

export function setWetTier(t: WetTier): void {
  if (t === wetTier) return;
  wetTier = t;
  for (const m of wetMaterials) m.needsUpdate = true;
}

export function patchWet(mat: THREE.Material): void {
  if (mat.userData.wet || !mat.userData.baked || !(mat instanceof THREE.MeshStandardMaterial)) return;
  if (mat.name === 'puddle' || mat.transparent) return;
  mat.userData.wet = true;
  wetMaterials.add(mat);
  // Standing water collects on hard flat ground, less on lawns and dirt, never on floors.
  const pool = PUDDLES[mat.name] ?? 0;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey()}|wet${pool}${wetTier}`;
  mat.needsUpdate = true;
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    if (wetTier === 'off') return;
    const full = wetTier === 'full';
    Object.assign(shader.uniforms, weatherUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${WET_COMMON}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        // Dry (no rain, or indoors per the baked sky visibility): skip all of it.
        float wetSky = vBake.a;
        float wet = 0.0;
        float puddle = 0.0;
        if (uWetness > 0.001) {
          bool wetGround = vBakeUp > 0.9 && vBakeWorld.y < ${GROUND_BAND.max.toFixed(3)} && vBakeWorld.y > ${GROUND_BAND.min.toFixed(3)};
          if (wetGround) wetSky = texture2D(uGroundBake, (vBakeWorld.xz - uGroundRect.xy) * uGroundRect.zw).a;
          wet = uWetness * smoothstep(0.42, 0.8, wetSky) * mix(0.3, 1.0, smoothstep(0.1, 0.85, vBakeUp));
        }
        if (${pool.toFixed(2)} > 0.0 && vBakeUp > 0.9 && vBakeWorld.y < 0.35 && wet > 0.01) {
          vec2 q = vBakeWorld.xz;
          float n = wetNoise(q * 0.21) * 0.62 + wetNoise(q * 0.83 + 3.1) * 0.38;
          float lo = 0.67 - 0.1 * uWetness;
          puddle = smoothstep(lo, lo + 0.05, n) * wet * ${pool.toFixed(2)};
        }
        diffuseColor.rgb *= (1.0 - 0.3 * wet) * (1.0 - 0.15 * puddle);
        roughnessFactor = mix(roughnessFactor, min(roughnessFactor, mix(0.38, 0.17, smoothstep(0.5, 0.95, vBakeUp))), wet);
        roughnessFactor = mix(roughnessFactor, 0.04, puddle);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        if (${full ? 'true' : 'false'} && puddle > 0.02 && uRainAmt > 0.01) {
          vec2 rg = wetRipples(vBakeWorld.xz, uWxTime) * puddle * uRainAmt * 0.35;
          normal = normalize(normal + (viewMatrix * vec4(-rg.x, 0.0, -rg.y, 0.0)).xyz);
        }`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        if (wet > 0.02) {
          vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
          vec3 pv = normalize(cameraPosition - vBakeWorld);
          float nv = max(dot(wN, pv), 1e-3);
          // Wet ground spreads the lamp pools into a broad glossy sheen rather than going dark:
          // a share of the baked light comes back as reflection.
          reflectedLight.indirectSpecular += bk.rgb * uBakeGain * RECIPROCAL_PI * wet * (0.03 + 0.07 * puddle) * (0.3 + 2.0 * F_Schlick(vec3(0.04), 1.0, nv));
          #if ${full ? 1 : 0}
          // Sky sheen: water mirrors the glowing fog, strongly at grazing angles (Fresnel).
          reflectedLight.indirectSpecular += uSkyRefl * F_Schlick(vec3(0.02), 1.0, nv) * (puddle + 0.35 * wet * (1.0 - puddle)) * mix(0.25, 1.0, smoothstep(0.6, 0.95, wetSky));
          float rough = pow2(material.roughness);
          for (int i = 0; i < ${WET_LAMPS}; i++) {
            if (i >= uLampCount) break;
            vec3 lv = uLampPos[i].xyz - vBakeWorld;
            float d = max(length(lv), 1e-3);
            vec3 l = lv / d;
            float nl = max(dot(wN, l), 0.0);
            vec3 hv = l + pv;
            vec3 h = dot(hv, hv) > 1e-8 ? normalize(hv) : wN;
            // Bulbs are about half a meter across: widen the lobe by their angular size.
            float a = clamp(rough + 0.14 / d, 0.002, 1.0);
            float spec = D_GGX(a, max(dot(wN, h), 0.0)) * V_GGX_SmithCorrelated(a, nl, nv) * nl;
            vec3 f = F_Schlick(vec3(0.02), 1.0, max(dot(pv, h), 0.0));
            float co = uLampDir[i].w;
            float cone = co < -1.0 ? 1.0 : smoothstep(co, mix(co, 1.0, 0.75), dot(-l, uLampDir[i].xyz));
            float w = pow2(saturate(1.0 - pow4(d / uLampPos[i].w)));
            reflectedLight.directSpecular += min(uLampCol[i].rgb * f * (spec * cone * w * wet / pow(max(d, 0.5), uLampCol[i].w)), vec3(64.0));
          }
          #endif
        }`);
  };
}
