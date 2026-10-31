import * as THREE from 'three';
import { FIRE_RAMP_GLSL, noiseTexture } from './Noise';

/** One billow of fire or smoke. */
export interface VolumeSpec {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  size: number;
  size1: number;
  /** Fire temperature 0..1 at birth, and how fast it cools (per second, exponential). */
  heat?: number;
  cool?: number;
  /** Smoke albedo and opacity. */
  r?: number; g?: number; b?: number;
  alpha?: number;
  /** Erosion at birth and at death (0 solid .. 1 eaten away): billows thin out and break up. */
  erode0?: number;
  erode1?: number;
  drag?: number;
  /** Upward acceleration (hot gas rises; negative sinks). */
  lift?: number;
  /** Fades out where it meets this floor height. */
  floor?: number;
  /** Lit from inside/below by fire (0..1). */
  glow?: number;
  spin?: number;
}

const VERT = /* glsl */ `
  attribute vec4 a0; // pos, size
  attribute vec4 a1; // rotation, seed, heat, erosion
  attribute vec4 a2; // colour, alpha
  attribute vec4 a3; // floor, glow
  varying vec2 vUv;
  varying vec2 vUvR;
  varying float vSeed, vHeat, vErode, vAlpha, vGlow, vFloor, vSize, vWorldY;
  varying vec3 vColor;
  #include <fog_pars_vertex>
  void main() {
    vec4 mvPosition = viewMatrix * vec4(a0.xyz, 1.0);
    // A billow the camera is inside would cover the whole screen: it thins out as the camera nears it.
    float near = smoothstep(0.25 * a0.w + 0.3, 0.6 * a0.w + 1.5, -mvPosition.z);
    float c = cos(a1.x), s = sin(a1.x);
    vec2 corner = position.xy * 2.0;
    vec2 rc = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    mvPosition.xy += corner * a0.w * 0.5;
    gl_Position = projectionMatrix * mvPosition;
    vUv = corner;
    vUvR = rc;
    vSeed = a1.y;
    vHeat = a1.z;
    vErode = a1.w;
    vColor = a2.rgb;
    vAlpha = a2.a * near;
    vFloor = a3.x;
    vGlow = a3.y;
    vSize = a0.w;
    // The camera's up is near enough to the world's for fading where it meets the floor.
    vWorldY = a0.y + corner.y * a0.w * 0.5;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D tNoise;
  uniform vec3 uAmbient;
  uniform float uTime;
  varying vec2 vUv;
  varying vec2 vUvR;
  varying float vSeed, vHeat, vErode, vAlpha, vGlow, vFloor, vSize, vWorldY;
  varying vec3 vColor;
  #include <fog_pars_fragment>
  ${FIRE_RAMP_GLSL}
  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    vec2 q = vUvR * 0.5;
    vec4 n0 = texture2D(tNoise, q * 0.55 + vec2(vSeed, vSeed * 0.37));
    vec4 n1 = texture2D(tNoise, q * 1.3 + vec2(vSeed * 1.7, uTime * 0.025 + vSeed));
    float noise = n0.r * 0.6 + n1.b * 0.4;
    // A lumpy ball, eaten away from its thin parts first.
    float shape = 1.0 - smoothstep(0.3, 1.0, r + (noise - 0.5) * 0.75);
    float d = clamp(shape * (0.5 + noise * 0.95) - vErode, 0.0, 1.0);
    d = smoothstep(0.0, 0.32, d);
    float soft = clamp((vWorldY - vFloor) / max(0.05, vSize * 0.22), 0.0, 1.0);
    float a = d * vAlpha * soft;
    if (a < 0.003) discard;
    // Hottest where the billow is thickest.
    float temp = vHeat * smoothstep(0.1, 0.9, shape * (0.35 + noise * 0.9));
    vec3 fire = fireRamp(temp);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogF = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #else
      float fogF = 0.0;
    #endif
    #ifdef ADDITIVE
      gl_FragColor = vec4(fire * a * (1.0 - fogF), 1.0);
    #else
      // Lit from above by the sky, from inside by the fire that made it.
      float lit = 0.55 + 0.45 * clamp(vUv.y * 0.55 + 0.45 + (n1.g - 0.5) * 0.5, 0.0, 1.0);
      vec3 glow = vGlow * vec3(1.6, 0.6, 0.16) * (0.35 + 0.65 * clamp(0.6 - vUv.y * 0.5, 0.0, 1.0)) * (0.5 + noise);
      vec3 col = vColor * (uAmbient * lit + glow) + fire * 0.7;
      col = mix(col, fogColor, fogF);
      gl_FragColor = vec4(col, a);
    #endif
  }
`;

/**
 * Billowing fire and smoke drawn as noise-shaded billboards in one instanced draw: fireballs
 * that cool from white-hot through orange to soot as they expand and erode, and smoke lit by
 * the sky and by the fire inside it, softened where it meets the ground. `additive` batches are
 * pure light (fire); the others are smoke, sorted back to front every frame.
 */
export class VolumeBatch {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  readonly material: THREE.ShaderMaterial;
  private readonly a0: Float32Array;
  private readonly a1: Float32Array;
  private readonly a2: Float32Array;
  private readonly a3: Float32Array;
  // Simulation state, struct of arrays.
  private readonly p: Float32Array;
  private readonly v: Float32Array;
  private readonly life: Float32Array;
  private readonly max: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly rot: Float32Array;
  private readonly spin: Float32Array;
  private readonly seed: Float32Array;
  private readonly heat: Float32Array;
  private readonly cool: Float32Array;
  private readonly col: Float32Array;
  private readonly er: Float32Array;
  private readonly misc: Float32Array; // drag, lift, floor, glow
  private count = 0;
  private capacity: number;
  private readonly order: number[] = [];
  private readonly depth: Float32Array;

  constructor(private readonly maxCapacity: number, private readonly additive: boolean) {
    this.capacity = maxCapacity;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (name: string) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(maxCapacity * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(name, a);
      return a.array as Float32Array;
    };
    this.a0 = attr('a0');
    this.a1 = attr('a1');
    this.a2 = attr('a2');
    this.a3 = attr('a3');
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        tNoise: { value: noiseTexture() },
        uAmbient: { value: new THREE.Color(0.11, 0.115, 0.13) },
        uTime: { value: 0 },
      },
      defines: additive ? { ADDITIVE: '' } : {},
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 4 : 3;
    const n = maxCapacity;
    const f = (k: number) => new Float32Array(n * k);
    this.p = f(3); this.v = f(3); this.life = f(1); this.max = f(1); this.s0 = f(1); this.s1 = f(1);
    this.rot = f(1); this.spin = f(1); this.seed = f(1); this.heat = f(1); this.cool = f(1); this.col = f(4); this.er = f(2); this.misc = f(4);
    this.depth = f(1);
  }

  setCapacity(fraction: number): void {
    this.capacity = Math.max(16, Math.floor(this.maxCapacity * fraction));
    if (this.count > this.capacity) this.count = this.capacity;
  }

  get active(): number {
    return this.count;
  }

  emit(s: VolumeSpec): void {
    let i = this.count;
    if (i >= this.capacity) i = Math.floor(Math.random() * this.capacity);
    else this.count++;
    const i3 = i * 3, i4 = i * 4;
    this.p[i3] = s.x; this.p[i3 + 1] = s.y; this.p[i3 + 2] = s.z;
    this.v[i3] = s.vx; this.v[i3 + 1] = s.vy; this.v[i3 + 2] = s.vz;
    this.life[i] = this.max[i] = s.life;
    this.s0[i] = s.size;
    this.s1[i] = s.size1;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.spin[i] = s.spin ?? (Math.random() - 0.5) * 0.6;
    this.seed[i] = Math.random();
    this.heat[i] = s.heat ?? 0;
    this.cool[i] = s.cool ?? 0;
    this.col[i4] = s.r ?? 0.2; this.col[i4 + 1] = s.g ?? 0.2; this.col[i4 + 2] = s.b ?? 0.2; this.col[i4 + 3] = s.alpha ?? 1;
    this.er[i * 2] = s.erode0 ?? 0;
    this.er[i * 2 + 1] = s.erode1 ?? 0.6;
    this.misc[i4] = s.drag ?? 1;
    this.misc[i4 + 1] = s.lift ?? 0;
    this.misc[i4 + 2] = s.floor ?? -1e6;
    this.misc[i4 + 3] = s.glow ?? 0;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
  }

  update(dt: number, camera: THREE.Camera): void {
    this.material.uniforms.uTime.value += dt;
    const P = this.p, V = this.v, M = this.misc;
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        i--;
        continue;
      }
      const i3 = i * 3, i4 = i * 4;
      const drag = Math.exp(-M[i4] * dt);
      V[i3] *= drag; V[i3 + 1] = V[i3 + 1] * drag + M[i4 + 1] * dt; V[i3 + 2] *= drag;
      P[i3] += V[i3] * dt; P[i3 + 1] += V[i3 + 1] * dt; P[i3 + 2] += V[i3 + 2] * dt;
      if (P[i3 + 1] < M[i4 + 2]) {
        P[i3 + 1] = M[i4 + 2];
        if (V[i3 + 1] < 0) V[i3 + 1] = 0;
      }
      this.rot[i] += this.spin[i] * dt;
      this.heat[i] *= Math.exp(-this.cool[i] * dt);
    }
    const n = this.count;
    // Smoke is drawn far to near so nearer billows cover farther ones.
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) order[i] = i;
    if (!this.additive && n > 1) {
      const e = camera.matrixWorldInverse.elements;
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        this.depth[i] = e[2] * P[i3] + e[6] * P[i3 + 1] + e[10] * P[i3 + 2] + e[14];
      }
      const d = this.depth;
      order.sort((a, b) => d[a] - d[b]);
    }
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const i3 = i * 3, i4 = i * 4, o = k * 4;
      const t = 1 - this.life[i] / this.max[i];
      // Grows fast at first and slows (billows), fades in quickly, out over the last half.
      const grow = 1 - (1 - t) * (1 - t);
      const fade = Math.min(1, t * 10) * Math.min(1, (1 - t) / 0.5);
      this.a0[o] = P[i3]; this.a0[o + 1] = P[i3 + 1]; this.a0[o + 2] = P[i3 + 2];
      this.a0[o + 3] = this.s0[i] + (this.s1[i] - this.s0[i]) * grow;
      this.a1[o] = this.rot[i];
      this.a1[o + 1] = this.seed[i];
      this.a1[o + 2] = this.heat[i];
      this.a1[o + 3] = this.er[i * 2] + (this.er[i * 2 + 1] - this.er[i * 2]) * t;
      this.a2[o] = this.col[i4]; this.a2[o + 1] = this.col[i4 + 1]; this.a2[o + 2] = this.col[i4 + 2];
      this.a2[o + 3] = this.col[i4 + 3] * fade;
      this.a3[o] = M[i4 + 2];
      // Lit from inside only while the fire that made it is close: fades within a second or two.
      this.a3[o + 1] = M[i4 + 3] * Math.exp(-(this.max[i] - this.life[i]) * 1.6);
    }
    const g = this.geometry;
    g.instanceCount = n;
    for (const name of ['a0', 'a1', 'a2', 'a3']) {
      const a = g.getAttribute(name) as THREE.InstancedBufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const cp = (a: Float32Array, k: number) => { for (let j = 0; j < k; j++) a[i * k + j] = a[last * k + j]; };
    cp(this.p, 3); cp(this.v, 3); cp(this.life, 1); cp(this.max, 1); cp(this.s0, 1); cp(this.s1, 1); cp(this.rot, 1);
    cp(this.spin, 1); cp(this.seed, 1); cp(this.heat, 1); cp(this.cool, 1); cp(this.col, 4); cp(this.er, 2); cp(this.misc, 4);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
