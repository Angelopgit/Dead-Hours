import * as THREE from 'three';

/**
 * One wind for everything that sways (trees, grass): direction and gust strength from the
 * Atmosphere (the same wind that blows the leaves and the fog wisps), filled once per frame by
 * Neighborhood.update. Names stay clear of `uTime` / `uWind` (other patches on the same materials).
 */
export const windUniforms = {
  /** World time in seconds (Neighborhood.update's `t`). */
  uWindTime: { value: 0 },
  /** Unit direction the wind blows toward, on the ground plane (x, z). */
  uWindDir: { value: new THREE.Vector2(1, 0) },
  /** Atmosphere.windStrength: 1 in a calm, up to ~2.6 in a gust. */
  uWindStrength: { value: 1 },
};

/**
 * Declarations plus `windGust(xz)`: gust waves rolling across the ground along the wind
 * (0 between waves, 1 on a crest), with a slow sideways wobble so the fronts are not straight.
 */
export const WIND_GLSL = /* glsl */ `
uniform float uWindTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
float windGust(vec2 xz) {
  float phase = dot(xz, uWindDir) * 0.42 - uWindTime * 1.9
    + sin(dot(xz, vec2(-uWindDir.y, uWindDir.x)) * 0.21 + uWindTime * 0.27) * 1.7;
  float g = 0.5 + 0.5 * sin(phase);
  return g * g;
}
`;

/** Adds the wind uniforms to a shader in onBeforeCompile (same objects, so they update together). */
export function bindWind(shader: { uniforms: Record<string, THREE.IUniform> }): void {
  Object.assign(shader.uniforms, windUniforms);
}

/** Copies the Atmosphere's wind into the uniforms (Neighborhood.update). */
export function updateWind(t: number, wind: THREE.Vector3, strength: number): void {
  windUniforms.uWindTime.value = t;
  const d = windUniforms.uWindDir.value.set(wind.x, wind.z);
  if (d.lengthSq() > 1e-6) d.normalize();
  windUniforms.uWindStrength.value = strength;
}
