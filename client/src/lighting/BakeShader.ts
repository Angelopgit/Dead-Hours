import * as THREE from 'three';
import { GROUND_BAND } from './LightBaker';

/** Uniforms shared by every baked static material. */
export const bakeUniforms = {
  uGroundBake: { value: new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1) as THREE.Texture },
  /** Where the ground lightmap lies: (x0, z0, 1 / width, 1 / depth), set by the bake. */
  uGroundRect: { value: new THREE.Vector4(-128, -128, 1 / 256, 1 / 256) },
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
