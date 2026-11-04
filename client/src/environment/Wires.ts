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

/** Where the wires leave a pole (its top) and across its crossarm; they sag half of WIRE_DIP midway. */
export const WIRE_TOP = 8.4;
export const WIRE_OFFSETS = [-0.7, 0, 0.7];
/** How far below the two ends each span's curve control point sits. */
export const WIRE_DIP = 0.9;

/** The wires along one line of poles, pole to pole in order of x. */
export function wireCurves(poles: { x: number; z: number }[]): THREE.QuadraticBezierCurve3[] {
  const tops = poles.map((p) => new THREE.Vector3(p.x, WIRE_TOP, p.z)).sort((a, b) => a.x - b.x);
  const out: THREE.QuadraticBezierCurve3[] = [];
  for (let i = 0; i < tops.length - 1; i++) {
    for (const off of WIRE_OFFSETS) {
      const a = tops[i].clone().add(new THREE.Vector3(0, 0, off));
      const b = tops[i + 1].clone().add(new THREE.Vector3(0, 0, off));
      const mid = a.clone().lerp(b, 0.5);
      mid.y -= WIRE_DIP;
      out.push(new THREE.QuadraticBezierCurve3(a, mid, b));
    }
  }
  return out;
}

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
