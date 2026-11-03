import * as THREE from 'three';

/**
 * three lights every pixel with every point and spot light in the scene, and the game keeps a lot of
 * them there at zero (muzzle flash, fire pool, flashlights of every survivor slot, police bars,
 * hazards, the supply flare and searchlight: a light added later would recompile every material).
 * Each one cost a full GGX evaluation on every pixel of every lit surface, lit or not.
 *
 * Here a light only shades a pixel it reaches: three already works out `directLight.visible` (the
 * light's colour after distance and cone falloff is nonzero), and the full evaluation is skipped
 * where it is false. A light at zero, or a pixel past a light's range or outside its cone, adds
 * exactly nothing either way, so the image is unchanged. For a light at zero the branch goes the
 * same way on every pixel, so the GPU skips the work outright.
 *
 * Patches the shared chunk once, at import, before any material compiles.
 */
const CALL = 'RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );';

function patch(chunk: string): string {
  const point = chunk.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
  const sun = chunk.indexOf('#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )');
  if (point < 0 || sun < point) return chunk;
  // Point and spot loops only: the moon (directional) always reaches.
  const head = chunk.slice(0, point);
  const lights = chunk.slice(point, sun).split(CALL).join(`if ( directLight.visible ) ${CALL}`);
  return head + lights + chunk.slice(sun);
}

const before = THREE.ShaderChunk.lights_fragment_begin;
const after = patch(before);
if (after === before || after.split('if ( directLight.visible ) RE_Direct').length !== 3) {
  console.warn('LightLoop: three lights_fragment_begin changed, lights are not culled per pixel');
} else {
  (THREE.ShaderChunk as Record<string, string>).lights_fragment_begin = after;
}

export const LIGHT_LOOP_PATCHED = after !== before;
