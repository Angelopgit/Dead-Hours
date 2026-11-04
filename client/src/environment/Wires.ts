import * as THREE from 'three';
import { chain } from '../lighting/BakeShader';
import type { MaterialLibrary } from '../rendering/Materials';

/**
 * Power lines between the poles. A wire is 3.6 cm thick, so from 10 to 20 m away (phone to desktop
 * resolution) it is thinner than a pixel and the rasterizer only catches it where it crosses a
 * pixel centre: against the sky it broke into a trail of dots that crawled as the camera moved.
 * The vertex shader keeps each wire at least a pixel wide instead, the way a real one still reads
 * as a thin line from down the street. Up close nothing changes.
 */
export const WIRE_RADIUS = 0.018;

/**
 * Smallest drawn radius, in pixels. The tube has 3 sides, and a triangle is 1.5 to 1.73 times its
 * corner radius across depending on which way it is seen, so 0.67 px keeps it at least a pixel wide.
 */
export const WIRE_MIN_PX = 0.67;

/** The shared wire material: dark metal, grown in the vertex shader to stay a pixel wide. */
export function wireMaterial(lib: MaterialLibrary): THREE.MeshStandardMaterial {
  return lib.custom('power-wire', () => {
    const mat = new THREE.MeshStandardMaterial({ color: 0x101214, roughness: 0.6, metalness: 0.3, flatShading: true });
    patchWire(mat, WIRE_RADIUS);
    return mat;
  });
}

/** Grows a tube of `radius` metres so it is never under WIRE_MIN_PX pixels in radius on screen. */
export function patchWire(mat: THREE.Material, radius: number): void {
  // Radians per rendered pixel, from whichever camera draws it (the puddles' mirror too).
  const uWirePx = { value: 0.002 };
  const viewport = new THREE.Vector4();
  mat.onBeforeRender = (renderer, _scene, camera) => {
    const h = renderer.getCurrentViewport(viewport).w;
    // projectionMatrix[5] = zoom / tan(fov / 2), so aim-down-sights zoom is followed too.
    const p5 = camera.projectionMatrix.elements[5];
    if (h > 0 && p5 > 0) uWirePx.value = 2 / (p5 * h);
  };
  chain(mat, 'wire', (shader) => {
    shader.uniforms.uWirePx = uWirePx;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWirePx;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          // Out along the tube's own normal (view space) until it is WIRE_MIN_PX at this depth.
          float grow = max(0.0, ${WIRE_MIN_PX.toFixed(2)} * uWirePx * -mvPosition.z - ${radius.toFixed(4)});
          mvPosition.xyz += normalize(transformedNormal) * grow;
          gl_Position = projectionMatrix * mvPosition;
        }`);
  });
}
