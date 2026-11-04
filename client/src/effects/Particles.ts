import * as THREE from 'three';

/** Particle look: soft puff (dust, smoke, mist), hard round (droplets, chips), spark (hot core). */
export const SHAPE = { soft: 0, hard: 1, spark: 2, flash: 3 } as const;

export interface ParticleSpec {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  size: number;
  /** Size at the end of life (puffs grow, sparks shrink). */
  size1?: number;
  r: number; g: number; b: number;
  alpha: number;
  /** Multiplier on gravity (0 floats, 1 falls). */
  gravity?: number;
  /** Velocity damping per second. */
  drag?: number;
  /** Streak length per m/s of screen-space speed. */
  stretch?: number;
  shape?: number;
  rotation?: number;
  /** Particles below this height stop (and may leave a mark). */
  floor?: number;
  /** Called once when the particle reaches its floor. */
  onLand?: number;
}

const VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iVel;
  attribute vec4 iColor;
  attribute vec4 iParams;
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vShape;
  #include <fog_pars_vertex>
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(iPos, 1.0);
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    float size = iParams.x;
    float vl = length(vv.xy);
    vec2 ax = vl > 1e-3 && iParams.z > 0.0 ? vv.xy / vl : vec2(cos(iParams.y), sin(iParams.y));
    vec2 ay = vec2(-ax.y, ax.x);
    float len = size + vl * iParams.z;
    mvPosition.xy += ax * position.x * len + ay * position.y * size;
    gl_Position = projectionMatrix * mvPosition;
    vUv = position.xy * 2.0;
    vColor = iColor;
    vShape = iParams.w;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */ `
  varying vec2 vUv;
  varying vec4 vColor;
  varying float vShape;
  #include <fog_pars_fragment>
  void main() {
    float r = length(vUv);
    float a;
    vec3 col = vColor.rgb;
    if (vShape < 0.5) {
      // Soft puff with a lumpy edge.
      float ang = atan(vUv.y, vUv.x);
      float edge = 0.82 + 0.12 * sin(ang * 5.0 + vColor.a * 17.0) + 0.06 * sin(ang * 11.0);
      a = smoothstep(edge, 0.1, r);
    } else if (vShape < 1.5) {
      a = smoothstep(1.0, 0.75, r);
    } else if (vShape < 2.5) {
      a = smoothstep(1.0, 0.0, r);
      col *= 1.0 + 2.0 * smoothstep(0.5, 0.0, r);
    } else {
      // Muzzle flash star.
      float ang = atan(vUv.y, vUv.x);
      float rays = pow(abs(cos(ang * 2.5)), 6.0) * 0.6 + 0.4;
      a = smoothstep(rays, 0.0, r);
      col *= 1.0 + 3.0 * smoothstep(0.35, 0.0, r);
    }
    if (a <= 0.002) discard;
    gl_FragColor = vec4(col, a * clamp(vColor.a, 0.0, 1.0));
    #include <fog_fragment>
  }
`;

/**
 * Pool of camera-facing particles drawn in one instanced draw call. Simulated on the CPU
 * (gravity, drag, floors); streaks stretch along their screen-space velocity.
 */
export class ParticleBatch {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly iPos: Float32Array;
  private readonly iVel: Float32Array;
  private readonly iColor: Float32Array;
  private readonly iParams: Float32Array;
  // Simulation state (struct of arrays).
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly color: Float32Array;
  private readonly misc: Float32Array; // gravity, drag, stretch, shape, rotation, floor, onLand
  private count = 0;
  private capacity: number;
  /** Receives landing callbacks (blood drops leave marks). */
  onLand: ((kind: number, x: number, y: number, z: number) => void) | null = null;

  constructor(private readonly maxCapacity: number, additive: boolean) {
    this.capacity = maxCapacity;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const attr = (n: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(maxCapacity * n), n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const aPos = attr(3), aVel = attr(3), aColor = attr(4), aParams = attr(4);
    g.setAttribute('iPos', aPos);
    g.setAttribute('iVel', aVel);
    g.setAttribute('iColor', aColor);
    g.setAttribute('iParams', aParams);
    this.iPos = aPos.array as Float32Array;
    this.iVel = aVel.array as Float32Array;
    this.iColor = aColor.array as Float32Array;
    this.iParams = aParams.array as Float32Array;
    g.instanceCount = 0;
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      fog: true,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 3 : 2;
    const n = maxCapacity;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.color = new Float32Array(n * 4);
    this.misc = new Float32Array(n * 7);
  }

  /** Lower quality settings use part of the pool. */
  setCapacity(fraction: number): void {
    this.capacity = Math.max(16, Math.floor(this.maxCapacity * fraction));
    if (this.count > this.capacity) this.count = this.capacity;
  }

  emit(p: ParticleSpec): void {
    let i = this.count;
    if (i >= this.capacity) {
      // Full: replace the oldest-looking slot (random, cheap) so new effects always show.
      i = Math.floor(Math.random() * this.capacity);
    } else {
      this.count++;
    }
    const o3 = i * 3, o4 = i * 4, o7 = i * 7;
    this.pos[o3] = p.x; this.pos[o3 + 1] = p.y; this.pos[o3 + 2] = p.z;
    this.vel[o3] = p.vx; this.vel[o3 + 1] = p.vy; this.vel[o3 + 2] = p.vz;
    this.life[i] = p.life;
    this.maxLife[i] = p.life;
    this.size0[i] = p.size;
    this.size1[i] = p.size1 ?? p.size;
    this.color[o4] = p.r; this.color[o4 + 1] = p.g; this.color[o4 + 2] = p.b; this.color[o4 + 3] = p.alpha;
    this.misc[o7] = p.gravity ?? 0;
    this.misc[o7 + 1] = p.drag ?? 0;
    this.misc[o7 + 2] = p.stretch ?? 0;
    this.misc[o7 + 3] = p.shape ?? SHAPE.soft;
    this.misc[o7 + 4] = p.rotation ?? Math.random() * Math.PI * 2;
    this.misc[o7 + 5] = p.floor ?? -1e9;
    this.misc[o7 + 6] = p.onLand ?? 0;
  }

  get active(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
    this.geometry.instanceCount = 0;
    this.mesh.visible = false;
  }

  update(dt: number): void {
    const P = this.pos, V = this.vel, M = this.misc;
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.kill(i);
        i--;
        continue;
      }
      const o3 = i * 3, o7 = i * 7;
      const drag = Math.exp(-M[o7 + 1] * dt);
      V[o3] *= drag; V[o3 + 1] *= drag; V[o3 + 2] *= drag;
      V[o3 + 1] -= 9.8 * M[o7] * dt;
      P[o3] += V[o3] * dt; P[o3 + 1] += V[o3 + 1] * dt; P[o3 + 2] += V[o3 + 2] * dt;
      if (P[o3 + 1] < M[o7 + 5]) {
        P[o3 + 1] = M[o7 + 5];
        if (M[o7 + 6] > 0) {
          this.onLand?.(M[o7 + 6], P[o3], P[o3 + 1], P[o3 + 2]);
          this.kill(i);
          i--;
          continue;
        }
        V[o3] = V[o3 + 1] = V[o3 + 2] = 0;
      }
    }
    // Upload.
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const o3 = i * 3, o4 = i * 4, o7 = i * 7;
      const t = 1 - this.life[i] / this.maxLife[i];
      this.iPos[o3] = P[o3]; this.iPos[o3 + 1] = P[o3 + 1]; this.iPos[o3 + 2] = P[o3 + 2];
      this.iVel[o3] = V[o3]; this.iVel[o3 + 1] = V[o3 + 1]; this.iVel[o3 + 2] = V[o3 + 2];
      // Fade in fast, out over the last 60% of life.
      const fade = Math.min(1, t * 12) * Math.min(1, (1 - t) / 0.6);
      this.iColor[o4] = this.color[o4];
      this.iColor[o4 + 1] = this.color[o4 + 1];
      this.iColor[o4 + 2] = this.color[o4 + 2];
      this.iColor[o4 + 3] = this.color[o4 + 3] * fade;
      this.iParams[o4] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      this.iParams[o4 + 1] = M[o7 + 4];
      this.iParams[o4 + 2] = M[o7 + 2];
      this.iParams[o4 + 3] = M[o7 + 3];
    }
    const g = this.geometry;
    g.instanceCount = n;
    // Empty: not drawn (three would still bind its program and uniforms in every pass), and nothing to
    // send (a zero-length update range would make three upload the whole pool).
    this.mesh.visible = n > 0;
    if (n === 0) return;
    for (const name of ['iPos', 'iVel', 'iColor', 'iParams']) {
      const a = g.getAttribute(name) as THREE.InstancedBufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
  }

  private kill(i: number): void {
    const last = --this.count;
    if (i === last) return;
    const c3 = (a: Float32Array) => { a[i * 3] = a[last * 3]; a[i * 3 + 1] = a[last * 3 + 1]; a[i * 3 + 2] = a[last * 3 + 2]; };
    c3(this.pos);
    c3(this.vel);
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.size0[i] = this.size0[last];
    this.size1[i] = this.size1[last];
    for (let k = 0; k < 4; k++) this.color[i * 4 + k] = this.color[last * 4 + k];
    for (let k = 0; k < 7; k++) this.misc[i * 7 + k] = this.misc[last * 7 + k];
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
