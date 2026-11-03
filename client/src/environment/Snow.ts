import * as THREE from 'three';
import type { Quality } from '../core/Settings';
import { weatherUniforms } from '../lighting/WetShader';
import { rainAt } from './Weather';

/** Flakes in the box around the camera, by particle quality. */
const FLAKES: Record<Quality, number> = { low: 1800, medium: 5000, high: 9000 };
const RADIUS: Record<Quality, number> = { low: 10, medium: 12, high: 13 };
const HEIGHT = 12;
/** Snowfall runs on the rain's wall-clock curve, a quarter hour ahead (ms). */
const SNOW_CLOCK_SHIFT = 900_000;
/** How much of the wind the flakes ride (m/s per unit of wind): a gentle slant, faster in gusts. */
const WIND_CARRY = 0.25;
/** The wind drift wraps at a whole number of boxes for every quality (2 * RADIUS), so wrapping never moves a flake. */
const DRIFT_WRAP = 1560;

/**
 * Holiday snow over the main menu and through the nights: soft round flakes that drift down slowly
 * in a box around the camera, riding the wind and fluttering, all in the vertex shader like the
 * rain (the CPU only adds up the wind). They stop under roofs (the rain's cover map), so there is none
 * indoors, thin out in the fog and catch the street lamps and the flashlight, so they glow in each
 * beam and read as faint white specks in the dark between them.
 *
 * How hard it snows follows the wall clock (the rain's curve, shifted), so everyone in an online
 * room sees the same flurries and heavier spells without any network traffic.
 */
export class Snow {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  /** 0..1: how much of the snow falls (eases in and out). */
  amount = 0;
  private target = 0;
  private time = 0;
  private readonly uniforms = {
    uCam: { value: new THREE.Vector3() },
    uRadius: { value: RADIUS.high },
    uAmount: { value: 0 },
    uSnowTime: { value: 0 },
    /** How far the wind has carried the snow so far (m), integrated frame by frame. */
    uDrift: { value: new THREE.Vector2() },
    uFogDensity: { value: 0.02 },
  };

  constructor() {
    this.geometry = new THREE.InstancedBufferGeometry();
    // One quad, -1..1 both ways, turned to face the camera in the shader.
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.material = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, ...weatherUniforms },
      vertexShader: /* glsl */ `
        attribute vec4 seed;
        uniform vec3 uCam;
        uniform float uRadius, uAmount, uSnowTime, uFogDensity;
        uniform vec2 uDrift;
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
        varying vec2 vUv;
        const float H = ${HEIGHT.toFixed(1)};
        void main() {
          vAlpha = 0.0;
          vColor = vec3(0.0);
          vUv = position.xy;
          if (seed.w > uAmount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
          // Big flakes fall a little faster. All of them ride the wind together (uDrift: gusts speed
          // the drift up, never swing it back); on top, each flake flutters in small quick loops
          // of its own (a few centimetres, its own direction, pace and phase) and wanders slowly.
          float speed = 0.6 + seed.w * 0.55;
          float t = uSnowTime;
          float h1 = fract(seed.x * 91.7 + seed.z * 13.3);
          float h2 = fract(seed.y * 57.1 + seed.w * 29.9);
          float h3 = fract(seed.z * 37.3 + seed.x * 71.1);
          float ang = h1 * 6.2832;
          vec2 dirA = vec2(cos(ang), sin(ang));
          vec2 dirB = vec2(-dirA.y, dirA.x);
          float w = 1.6 + h2 * 1.6;
          float amp = 0.03 + h3 * 0.06;
          vec2 flutter = (dirA * sin(t * w + h3 * 40.0) + dirB * (0.6 * sin(t * w * 1.37 + h1 * 40.0))) * amp;
          vec2 wander = vec2(sin(t * (0.17 + h3 * 0.15) + h2 * 30.0), sin(t * (0.13 + h1 * 0.15) + h3 * 30.0)) * (0.08 + h2 * 0.1);
          vec2 sway = flutter + wander;
          float span = uRadius * 2.0;
          vec3 base;
          base.x = (uCam.x - uRadius) + mod(seed.x * span + uDrift.x - (uCam.x - uRadius), span) + sway.x;
          base.z = (uCam.z - uRadius) + mod(seed.z * span + uDrift.y - (uCam.z - uRadius), span) + sway.y;
          base.y = (uCam.y - H * 0.35) + mod(seed.y * H - t * speed - (uCam.y - H * 0.35), H);
          vec2 cuv = (base.xz - uCoverRect.xy) * uCoverRect.zw;
          float cover = texture2D(uCover, cuv).r * 20.0 - 4.0;
          bool inside = cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0;
          if (inside && base.y < cover) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }

          // Big, soft holiday flakes (a few centimetres across); far ones keep a pixel or two of
          // width (dimmer to match) so they don't shimmer away.
          vec3 toCam = uCam - base;
          float dist = length(toCam);
          float r = 0.013 + seed.w * seed.w * 0.024;
          float size = max(r, dist * 0.0019);
          float dim = r / size;

          // Moonlight and fog glow everywhere, plus the lamps and the flashlight near them.
          vec3 light = vec3(0.3, 0.33, 0.4);
          for (int i = 0; i < 8; i++) {
            if (i >= uLampCount) break;
            vec3 lv = uLampPos[i].xyz - base;
            float d = length(lv);
            float w = clamp(1.0 - d / uLampPos[i].w, 0.0, 1.0);
            float cone = uLampDir[i].w < -1.0 ? 1.0 : smoothstep(uLampDir[i].w, uLampDir[i].w + 0.25, dot(-lv / max(d, 1e-3), uLampDir[i].xyz));
            light += uLampCol[i].rgb * (w * w * cone / max(d * d, 1.0)) * 0.55;
          }
          if (uTorchPos.w > 0.0) {
            vec3 lv = base - uTorchPos.xyz;
            float d = length(lv);
            float cone = smoothstep(uTorchDir.w, uTorchDir.w + 0.08, dot(lv / max(d, 1e-3), uTorchDir.xyz));
            light += uTorchCol * (cone / max(d * d, 0.6)) * clamp(1.0 - d / 22.0, 0.0, 1.0) * 0.5;
          }
          float near = smoothstep(0.7, 2.2, dist);
          float far = 1.0 - smoothstep(uRadius * 0.65, uRadius, dist);
          float fog = exp(-uFogDensity * uFogDensity * dist * dist);
          // Flakes that just appeared at the top of the box fade in instead of popping.
          float top = 1.0 - smoothstep(H * 0.85, H, base.y - (uCam.y - H * 0.35));
          // A flake turning as it falls catches the light on and off, softly.
          float turn = 0.82 + 0.18 * sin(t * (2.0 + h1 * 3.0) + h2 * 50.0);
          vAlpha = near * far * fog * top * dim * turn * (0.6 + 0.4 * seed.z);
          vColor = min(light, vec3(1.1));
          vec4 mv = viewMatrix * vec4(base, 1.0);
          mv.xy += position.xy * size;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        varying float vAlpha;
        varying vec3 vColor;
        varying vec2 vUv;
        void main() {
          float d = length(vUv);
          float a = clamp(vAlpha, 0.0, 1.0) * (1.0 - smoothstep(0.35, 1.0, d));
          if (a <= 0.002) discard;
          // Additive blending scales by the source alpha (SRC_ALPHA, ONE): the coverage goes there.
          gl_FragColor = vec4(vColor, a);
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
    this.mesh.name = 'snow';
    this.mesh.visible = false;
    this.setQuality('high');
  }

  setQuality(q: Quality): void {
    const n = FLAKES[q];
    const seeds = new Float32Array(n * 4);
    let s = 7654321;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < n * 4; i++) seeds[i] = rnd();
    this.geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4));
    this.geometry.instanceCount = n;
    this.uniforms.uRadius.value = RADIUS[q];
  }

  /** Starts or stops the snow: gently, or at once (behind a fade or a loading screen). */
  set(on: boolean, instant = false): void {
    this.target = on ? 1 : 0;
    if (instant) {
      this.amount = this.target;
      this.mesh.visible = this.amount > 0;
    }
  }

  get falling(): boolean {
    return this.target > 0;
  }

  update(dt: number, camera: THREE.Camera, fogDensity: number): void {
    // Never stops while it is on: from a light flurry (60% of the flakes) to all of them.
    const want = this.target * (0.6 + 0.4 * rainAt(Date.now() + SNOW_CLOCK_SHIFT));
    this.amount += (want - this.amount) * Math.min(1, dt * 0.6);
    if (this.amount < 0.005 && this.target === 0) this.amount = 0;
    this.mesh.visible = this.amount > 0;
    if (!this.mesh.visible) return;
    this.time += dt;
    // The wind is integrated, not multiplied by the time: a gust then speeds the snow up for a
    // while instead of swinging the whole snowfall back and forth (worse the longer it ran).
    const wind = weatherUniforms.uWxWind.value, d = this.uniforms.uDrift.value;
    const step = Math.min(dt, 0.1) * WIND_CARRY;
    d.set((d.x + wind.x * step) % DRIFT_WRAP, (d.y + wind.y * step) % DRIFT_WRAP);
    this.uniforms.uCam.value.setFromMatrixPosition(camera.matrixWorld);
    this.uniforms.uAmount.value = this.amount;
    this.uniforms.uSnowTime.value = this.time;
    this.uniforms.uFogDensity.value = fogDensity;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
