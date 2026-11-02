import * as THREE from 'three';
import { chain } from '../lighting/BakeShader';

/**
 * Lamp heads seen from afar. A streetlight's lens is a 48 cm disc facing down, so from down the
 * street it is a sliver a few centimetres tall: past ~25 m it is thinner than a pixel. A sliver
 * that thin lands on a pixel centre in one frame and between two in the next, so while the camera
 * moves (running, skating) the lamp head blinks between dark and full brightness, and bloom turns
 * every blink into a flash of the whole glow.
 *
 * So each lens hands its light to a glare as it shrinks on screen: the lens mesh dims as its height
 * drops from 4 to 1.5 pixels, and a soft screen-aligned ellipse, never less than ~3 pixels across,
 * carries the light it gave up (same total, so the lamp keeps its brightness). The ellipse's
 * coverage changes smoothly with sub-pixel motion, so neither it nor its bloom can blink.
 */

/** Radians per rendered pixel (vertically), refreshed each frame as the glare draws. */
export const glareUniforms = { uPxAngle: { value: 0.002 } };

/** GLSL: how much of a down-facing lens' light its own mesh keeps, and its projected size. */
const LENS_GLSL = /* glsl */ `
  // A lens disc of the given radius and thickness, seen along toCam (lens to camera, world).
  // Returns (projected height, projected area) in metres.
  vec2 lensSize(vec3 toCam, float radius, float thick) {
    float d = max(length(toCam), 1e-3);
    float below = clamp(-toCam.y / d, 0.0, 1.0);
    float side = sqrt(1.0 - below * below);
    return vec2(2.0 * radius * below + thick * side, 3.14159265 * radius * radius * below + 2.0 * radius * thick * side);
  }
  // The mesh's share: all of it from 4 pixels tall up, none below 1.5.
  float lensShare(float heightM, float dist) {
    return smoothstep(1.5, 4.0, heightM / max(dist * uPxAngle, 1e-6));
  }
`;

/**
 * Dims a lens material as its lens shrinks below a few pixels (the glare takes over). The lens is a
 * disc facing down, `radius` × `thick` metres.
 */
export function patchLens(mat: THREE.MeshStandardMaterial, radius: number, thick: number): void {
  chain(mat, `lens${radius}-${thick}`, (shader) => {
    shader.uniforms.uPxAngle = glareUniforms.uPxAngle;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uPxAngle;\n${LENS_GLSL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // vViewPosition points from this fragment to the camera in view space; turn it to world.
          vec3 toCam = vViewPosition * mat3(viewMatrix);
          totalEmissiveRadiance *= lensShare(lensSize(toCam, ${radius.toFixed(3)}, ${thick.toFixed(3)}).x, length(toCam));
        }`);
  });
}

interface Entry {
  pos: THREE.Vector3;
  /** Linear radiance of the lens (emissive color × intensity). */
  color: THREE.Color;
  radius: number;
  thick: number;
}

/** All lamp-head glares in one instanced draw. */
export class LampGlare {
  private readonly entries: Entry[] = [];
  private gain: THREE.InstancedBufferAttribute | null = null;
  mesh: THREE.Mesh | null = null;

  /** Adds a lamp head; returns its index (for `setGain`). */
  add(pos: THREE.Vector3, color: THREE.Color, radius: number, thick: number): number {
    this.entries.push({ pos: pos.clone(), color: color.clone(), radius, thick });
    return this.entries.length - 1;
  }

  /** Brightness of one lamp (a failing lamp's flicker), 1 = steady. */
  setGain(i: number, g: number): void {
    if (!this.gain) return;
    this.gain.setX(i, g);
    this.gain.needsUpdate = true;
  }

  build(): THREE.Mesh | null {
    const n = this.entries.length;
    if (n === 0) return null;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const center = new Float32Array(n * 3), color = new Float32Array(n * 3), lens = new Float32Array(n * 2), gain = new Float32Array(n).fill(1);
    this.entries.forEach((e, i) => {
      e.pos.toArray(center, i * 3);
      color.set([e.color.r, e.color.g, e.color.b], i * 3);
      lens.set([e.radius, e.thick], i * 2);
    });
    g.setAttribute('aCenter', new THREE.InstancedBufferAttribute(center, 3));
    g.setAttribute('aColor', new THREE.InstancedBufferAttribute(color, 3));
    g.setAttribute('aLens', new THREE.InstancedBufferAttribute(lens, 2));
    this.gain = new THREE.InstancedBufferAttribute(gain, 1);
    this.gain.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aGain', this.gain);
    g.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), uPxAngle: glareUniforms.uPxAngle },
      vertexShader: /* glsl */ `
        uniform float uPxAngle;
        attribute vec3 aCenter;
        attribute vec3 aColor;
        attribute vec2 aLens;
        attribute float aGain;
        varying vec2 vUv;
        varying vec3 vCol;
        #include <fog_pars_vertex>
        ${LENS_GLSL}
        void main() {
          vec3 toCam = cameraPosition - aCenter;
          float d = max(length(toCam), 1e-3);
          vec2 size = lensSize(toCam, aLens.x, aLens.y);
          float px = d * uPxAngle;
          float energy = size.y * (1.0 - lensShare(size.x, d)) * aGain;
          // An ellipse as wide as the lens and as tall as its sliver, but never under ~3 px across.
          float a = max(aLens.x, 1.6 * px);
          float b = max(0.5 * size.x, 1.6 * px);
          // (1 - r^2)^2 over the ellipse integrates to PI * a * b / 3: same light as the lens gave up.
          vCol = aColor * (energy * 3.0 / (3.14159265 * a * b));
          vUv = position.xy;
          // Nudged toward the camera so the lamp's own housing doesn't clip it.
          vec4 mv = viewMatrix * vec4(aCenter + toCam * (min(0.3, 0.5 * d) / d), 1.0);
          mv.xy += position.xy * vec2(a, b);
          gl_Position = energy > 1e-5 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
          #ifdef USE_FOG
            vFogDepth = -mv.z;
          #endif
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vCol;
        #include <fog_pars_fragment>
        void main() {
          float r2 = dot(vUv, vUv);
          if (r2 >= 1.0) discard;
          float f = (1.0 - r2) * (1.0 - r2);
          vec3 c = vCol * f;
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              c *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            #else
              c *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
            #endif
          #endif
          gl_FragColor = vec4(min(c, vec3(64.0)), 1.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    mesh.castShadow = mesh.receiveShadow = false;
    const size = new THREE.Vector2();
    mesh.onBeforeRender = (renderer, _scene, camera) => {
      const target = renderer.getRenderTarget();
      const h = target ? target.height : renderer.getDrawingBufferSize(size).y;
      // projectionMatrix[5] = zoom / tan(fov / 2): this follows aim-down-sights zoom too.
      const p5 = camera.projectionMatrix.elements[5];
      if (h > 0 && p5 > 0) glareUniforms.uPxAngle.value = 2 / (p5 * h);
    };
    this.mesh = mesh;
    return mesh;
  }
}
