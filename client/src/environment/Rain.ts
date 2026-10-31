import * as THREE from 'three';
import type { MapDefinition } from '@dead-hours/shared';
import type { Quality } from '../core/Settings';
import { weather } from './Weather';
import { COVER, weatherUniforms } from '../lighting/WetShader';

/** Drops in the box around the camera, by particle quality. */
const DROPS: Record<Quality, number> = { low: 900, medium: 4000, high: 8000 };
const RADIUS: Record<Quality, number> = { low: 13, medium: 17, high: 21 };
const HEIGHT = 16;

/**
 * Builds the cover height map from the map's boxes and house footprints. Rain stops at the roof
 * above it, so it never falls through ceilings, and the rain shader reads it on the GPU.
 */
export function buildCoverMap(map: MapDefinition): THREE.DataTexture {
  const { maxH } = COVER;
  // The whole map with a margin, and never less than the original square around the origin.
  const b = map.bounds, m = COVER.minHalf;
  const ox = Math.min(-m, Math.floor(b.x0 - 8)), oz = Math.min(-m, Math.floor(b.z0 - 8));
  const w = Math.max(m, Math.ceil(b.x1 + 8)) - ox, d = Math.max(m, Math.ceil(b.z1 + 8)) - oz;
  const resX = Math.ceil(w / COVER.texel), resZ = Math.ceil(d / COVER.texel);
  const data = new Uint8Array(resX * resZ * 4);
  const k = 1 / COVER.texel;
  weatherUniforms.uCoverRect.value.set(ox, oz, 1 / (resX * COVER.texel), 1 / (resZ * COVER.texel));
  const raise = (x0: number, x1: number, z0: number, z1: number, top: number) => {
    const v = Math.max(0, Math.min(255, Math.round(((top + 4) / (maxH + 4)) * 255)));
    const i0 = Math.max(0, Math.floor((x0 - ox) * k)), i1 = Math.min(resX - 1, Math.ceil((x1 - ox) * k) - 1);
    const j0 = Math.max(0, Math.floor((z0 - oz) * k)), j1 = Math.min(resZ - 1, Math.ceil((z1 - oz) * k) - 1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const o = (j * resX + i) * 4;
      if (v > data[o]) data[o] = v;
    }
  };
  for (const s of map.solids) {
    if (s.visible === false || s.w * s.d < 0.6) continue;
    raise(s.x - s.w / 2, s.x + s.w / 2, s.z - s.d / 2, s.z + s.d / 2, s.y + s.h / 2);
  }
  for (const h of map.houses) {
    const top = (h.slab ?? 0.3) + (h.groundHeight ?? 3) + (h.floors - 1) * 3 + 0.5;
    raise(h.x - h.w / 2, h.x + h.w / 2, h.z - h.d / 2, h.z + h.d / 2, top);
  }
  // Open ground reads as "no cover" (the encoded floor of the range).
  const t = new THREE.DataTexture(data, resX, resZ, THREE.RGBAFormat);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * GPU rain: thin streaks that live in a box around the camera and fall, wrap and drift entirely in
 * the vertex shader (no per-frame CPU work). Drops stop under roofs (cover map), fade with distance
 * and catch the light of nearby lamps and the flashlight, which is what makes rain visible at night.
 */
export class Rain {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private quality: Quality = 'high';
  private readonly uniforms = {
    uCam: { value: new THREE.Vector3() },
    uRadius: { value: RADIUS.high },
    uAmount: { value: 0 },
    uFogDensity: { value: 0.02 },
    uFlash: { value: 0 },
  };

  constructor() {
    this.geometry = new THREE.InstancedBufferGeometry();
    // One quad: x across (-1..1), y along the streak (0 top .. 1 bottom).
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
    this.geometry.setIndex([0, 2, 1, 0, 3, 2]);
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, ...weatherUniforms },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform vec3 uCam;
        uniform float uRadius, uAmount, uWxTime, uFogDensity, uFlash;
        uniform vec2 uWxWind;
        uniform sampler2D uCover;
        uniform vec4 uCoverRect;
        uniform int uLampCount;
        uniform vec4 uLampPos[8];
        uniform vec4 uLampCol[8];
        uniform vec4 uLampDir[8];
        uniform vec4 uTorchPos;
        uniform vec4 uTorchDir;
        uniform vec3 uTorchCol;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vU;
        const float H = ${HEIGHT.toFixed(1)};
        void main() {
          vAlpha = 0.0;
          vColor = vec3(0.0);
          vU = position.x;
          // Thin out the rain by dropping instances (seed.w is uniform in 0..1).
          if (seed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          float speed = 9.0 + seed.w * 3.0;
          float fall = uWxTime * speed;
          vec2 drift = uWxWind * (uWxTime * 0.6 + seed.y * 2.0);
          float span = uRadius * 2.0;
          vec3 base;
          base.x = (uCam.x - uRadius) + mod(seed.x * span + drift.x - (uCam.x - uRadius), span);
          base.z = (uCam.z - uRadius) + mod(seed.z * span + drift.y - (uCam.z - uRadius), span);
          base.y = (uCam.y - H * 0.4) + mod(seed.y * H - fall - (uCam.y - H * 0.4), H);
          // Under a roof: hidden.
          vec2 cuv = (base.xz - uCoverRect.xy) * uCoverRect.zw;
          float cover = texture2D(uCover, cuv).r * 20.0 - 4.0;
          bool inside = cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0;
          if (inside && base.y < cover) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          // Streak along the fall velocity, a little wider far away so it doesn't alias to nothing.
          vec3 vel = normalize(vec3(uWxWind.x * 0.6, -speed, uWxWind.y * 0.6));
          float len = 0.38 + seed.w * 0.3;
          vec3 toCam = uCam - base;
          float dist = length(toCam);
          vec3 side = normalize(cross(vel, toCam / max(dist, 1e-3)));
          float width = 0.006 + dist * 0.0011;
          vec3 p = base + vel * (position.y * len) + side * (position.x * width);

          // Light on the drop: lamps (spot cones), the flashlight, a lightning flash, faint sky.
          vec3 light = vec3(0.08, 0.09, 0.12) + vec3(0.6, 0.7, 0.9) * uFlash;
          for (int i = 0; i < 8; i++) {
            if (i >= uLampCount) break;
            vec3 lv = uLampPos[i].xyz - base;
            float d = length(lv);
            float w = clamp(1.0 - d / uLampPos[i].w, 0.0, 1.0);
            float cone = uLampDir[i].w < -1.0 ? 1.0 : smoothstep(uLampDir[i].w, uLampDir[i].w + 0.25, dot(-lv / max(d, 1e-3), uLampDir[i].xyz));
            light += uLampCol[i].rgb * (w * w * cone / max(d * d, 1.0));
          }
          if (uTorchPos.w > 0.0) {
            vec3 lv = base - uTorchPos.xyz;
            float d = length(lv);
            float cone = smoothstep(uTorchDir.w, uTorchDir.w + 0.08, dot(lv / max(d, 1e-3), uTorchDir.xyz));
            light += uTorchCol * (cone / max(d * d, 0.6)) * clamp(1.0 - d / 22.0, 0.0, 1.0);
          }
          float near = smoothstep(0.35, 1.4, dist);
          float far = 1.0 - smoothstep(uRadius * 0.6, uRadius, dist);
          float fog = exp(-uFogDensity * uFogDensity * dist * dist);
          vAlpha = near * far * fog * (0.5 + 0.5 * seed.w);
          vColor = min(light, vec3(6.0));
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        varying float vU;
        void main() {
          float a = clamp(vAlpha, 0.0, 1.0) * (1.0 - abs(clamp(vU, -1.0, 1.0)));
          vec3 c = clamp(vColor, 0.0, 6.0) * a * 0.8;
          gl_FragColor = vec4(c, 0.0);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.name = 'rain';
    this.setQuality('high');
  }

  setQuality(q: Quality): void {
    this.quality = q;
    const n = DROPS[q];
    const seeds = new Float32Array(n * 4);
    let s = 1234567;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n; i++) {
      seeds[i * 4] = rnd();
      seeds[i * 4 + 1] = rnd();
      seeds[i * 4 + 2] = rnd();
      seeds[i * 4 + 3] = rnd();
    }
    this.geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geometry.instanceCount = n;
    this.uniforms.uRadius.value = RADIUS[q];
  }

  update(camera: THREE.Camera, fogDensity: number, flash: number): void {
    this.uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    // Some drops always show while it rains at all; heavy rain shows them all.
    this.uniforms.uAmount.value = weather.rain <= 0.02 ? 0 : 0.15 + weather.rain * 0.85;
    this.uniforms.uFogDensity.value = fogDensity;
    this.uniforms.uFlash.value = flash;
    this.mesh.visible = this.uniforms.uAmount.value > 0;
  }

  get drops(): number {
    return DROPS[this.quality];
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
