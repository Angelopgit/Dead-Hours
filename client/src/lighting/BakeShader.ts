import * as THREE from 'three';
import { GROUND_BAKE, GROUND_BAND } from './LightBaker';

/** Uniforms shared by every baked static material. */
export const bakeUniforms = {
  uGroundBake: { value: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1) as THREE.Texture },
  uGroundRect: { value: new THREE.Vector4(-GROUND_BAKE.half, -GROUND_BAKE.half, 1 / (GROUND_BAKE.half * 2), 1 / (GROUND_BAKE.half * 2)) },
  /** Scales baked light (debug / tuning). */
  uBakeGain: { value: 1 },
};
bakeUniforms.uGroundBake.value.needsUpdate = true;

export function chain(mat: THREE.Material, tag: string, patch: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const prev = mat.onBeforeCompile;
  const baseKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (shader, renderer) => {
    prev.call(mat, shader, renderer);
    patch(shader);
  };
  mat.customProgramCacheKey = () => `${baseKey}|${tag}`;
  mat.needsUpdate = true;
}

/**
 * Static surfaces: the hemisphere fill is scaled by the baked sky visibility and the baked
 * static-light irradiance is added as indirect diffuse. Up-facing ground-level surfaces read the
 * ground lightmap; everything else reads its `bake` vertex attribute. Meshes without the
 * attribute get WebGL's default (0, 0, 0, 1), i.e. unbaked.
 */
export function patchBaked(mat: THREE.Material): void {
  if (mat.userData.baked || !(mat instanceof THREE.MeshStandardMaterial)) return;
  mat.userData.baked = true;
  chain(mat, 'baked', (shader) => {
    Object.assign(shader.uniforms, bakeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 bake;\nvarying vec4 vBake;\nvarying vec3 vBakeWorld;\nvarying float vBakeUp;')
      .replace('#include <fog_vertex>', `#include <fog_vertex>
        vBake = bake;
        vBakeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vBakeUp = normalize(mat3(modelMatrix) * objectNormal).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uGroundBake;\nuniform vec4 uGroundRect;\nuniform float uBakeGain;\nvarying vec4 vBake;\nvarying vec3 vBakeWorld;\nvarying float vBakeUp;')
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        vec4 bk = vBake;
        if (vBakeUp > 0.9 && vBakeWorld.y < ${GROUND_BAND.max.toFixed(3)} && vBakeWorld.y > ${GROUND_BAND.min.toFixed(3)}) {
          bk = texture2D(uGroundBake, (vBakeWorld.xz - uGroundRect.xy) * uGroundRect.zw);
        }
        irradiance = irradiance * bk.a + bk.rgb * uBakeGain;`)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectSpecular *= bk.a;');
  });
}

/** Per-object probe state for dynamic objects (characters, doors), updated from the light field. */
export interface ProbeUniforms {
  uProbeAO: { value: number };
  uProbeAmbient: { value: THREE.Vector3 };
  uProbeDir0: { value: THREE.Vector3 };
  uProbeCol0: { value: THREE.Vector3 };
  uProbeDir1: { value: THREE.Vector3 };
  uProbeCol1: { value: THREE.Vector3 };
}

export function createProbeUniforms(): ProbeUniforms {
  return {
    uProbeAO: { value: 1 },
    uProbeAmbient: { value: new THREE.Vector3() },
    uProbeDir0: { value: new THREE.Vector3(0, 1, 0) },
    uProbeCol0: { value: new THREE.Vector3() },
    uProbeDir1: { value: new THREE.Vector3(0, 1, 0) },
    uProbeCol1: { value: new THREE.Vector3() },
  };
}

/**
 * Dynamic objects: sky visibility and baked lights sampled at the object. The two strongest
 * static lights become directional terms (view-space directions), the rest is ambient.
 */
export function patchProbe(mat: THREE.Material, u: ProbeUniforms): void {
  if (mat.userData.probe || !(mat instanceof THREE.MeshStandardMaterial)) return;
  mat.userData.probe = true;
  chain(mat, 'probe', (shader) => {
    Object.assign(shader.uniforms, u);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uProbeAO;
        uniform vec3 uProbeAmbient;
        uniform vec3 uProbeDir0;
        uniform vec3 uProbeCol0;
        uniform vec3 uProbeDir1;
        uniform vec3 uProbeCol1;`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        irradiance = irradiance * uProbeAO + uProbeAmbient;
        reflectedLight.directDiffuse += (max(dot(geometryNormal, uProbeDir0), 0.0) * uProbeCol0
          + max(dot(geometryNormal, uProbeDir1), 0.0) * uProbeCol1) * BRDF_Lambert(material.diffuseColor);`);
  });
}

/** A static light seen in puddles: position, linear color × intensity, spot aim and cone. */
export interface ReflectedLamp {
  pos: THREE.Vector3;
  color: THREE.Color;
  decay: number;
  range: number;
  dir: THREE.Vector3;
  /** cos(outer), cos(inner); outer = -2 for point lights. */
  cone: THREE.Vector2;
}

export const PUDDLE_LAMPS = 8;

/**
 * Puddles mirror the baked lamps around them. Baked light has no specular of its own, so the
 * nearest unoccluded static lamps are added as GGX highlights, widened by the bulb's size so a
 * puddle shows the lamp's reflection where a mirror would.
 */
export function patchPuddle(mat: THREE.Material, lamps: ReflectedLamp[]): void {
  if (mat.userData.puddle || !(mat instanceof THREE.MeshStandardMaterial) || lamps.length === 0) return;
  mat.userData.puddle = true;
  const n = Math.min(lamps.length, PUDDLE_LAMPS);
  const pick = <T>(f: (l: ReflectedLamp) => T) => lamps.slice(0, n).map(f);
  const u = {
    uLampPos: { value: pick((l) => l.pos) },
    uLampCol: { value: pick((l) => new THREE.Vector3(l.color.r, l.color.g, l.color.b)) },
    uLampDir: { value: pick((l) => l.dir) },
    uLampFall: { value: pick((l) => new THREE.Vector4(l.cone.x, l.cone.y, l.decay, l.range)) },
  };
  chain(mat, `puddle${n}`, (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPuddleWorld;')
      .replace('#include <fog_vertex>', '#include <fog_vertex>\nvPuddleWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vPuddleWorld;
        uniform vec3 uLampPos[${n}];
        uniform vec3 uLampCol[${n}];
        uniform vec3 uLampDir[${n}];
        uniform vec4 uLampFall[${n}];`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          vec3 pv = normalize(cameraPosition - vPuddleWorld);
          float nv = max(pv.y, 1e-3);
          for (int i = 0; i < ${n}; i++) {
            vec3 lv = uLampPos[i] - vPuddleWorld;
            float d = length(lv);
            vec3 l = lv / d;
            float nl = max(l.y, 0.0);
            vec3 h = normalize(l + pv);
            // Bulbs are about half a meter across: widen the lobe by their angular size.
            float a = clamp(pow2(material.roughness) + 0.14 / d, 0.0, 1.0);
            float spec = D_GGX(a, max(h.y, 0.0)) * V_GGX_SmithCorrelated(a, nl, nv) * nl;
            vec3 f = F_Schlick(vec3(0.02), 1.0, max(dot(pv, h), 0.0));
            vec4 k = uLampFall[i];
            float cone = k.x < -1.0 ? 1.0 : smoothstep(k.x, k.y, dot(-l, uLampDir[i]));
            float w = pow2(saturate(1.0 - pow4(d / k.w)));
            reflectedLight.directSpecular += uLampCol[i] * f * (spec * cone * w / pow(max(d, 0.5), k.z));
          }
        }`);
  });
}
