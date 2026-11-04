import * as THREE from 'three';
import { FIRE_RAMP_GLSL, noiseTexture } from './Noise';

const FLAME_VERT = /* glsl */ `
  attribute vec4 a0; // base position, width
  attribute vec4 a1; // height, seed, heat, alpha
  varying vec2 vUv;
  varying float vSeed, vHeat, vAlpha;
  #include <fog_pars_vertex>
  void main() {
    // Turned about its upright axis to face the camera, standing on its base.
    vec3 base = a0.xyz;
    vec3 toCam = cameraPosition - base;
    vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + vec3(1e-4, 0.0, 0.0));
    vec3 p = base + right * position.x * a0.w + vec3(0.0, (position.y + 0.5) * a1.x, 0.0);
    // Leans slightly toward the camera at the top so it never shows as a flat card from above.
    vec3 lean = normalize(toCam) * (position.y + 0.5) * a1.x * 0.18;
    vec4 mvPosition = viewMatrix * vec4(p + lean, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vUv = vec2(position.x + 0.5, position.y + 0.5);
    vSeed = a1.y;
    vHeat = a1.z;
    // Flames right in front of the camera would fill the screen with glare: they thin out.
    vAlpha = a1.w * mix(0.35, 1.0, smoothstep(1.2, 4.5, length(toCam)));
    #include <fog_vertex>
  }
`;

const FLAME_FRAG = /* glsl */ `
  uniform sampler2D tNoise;
  uniform float uTime;
  varying vec2 vUv;
  varying float vSeed, vHeat, vAlpha;
  #include <fog_pars_fragment>
  ${FIRE_RAMP_GLSL}
  void main() {
    vec2 uv = vUv;
    float t = uTime + vSeed * 17.0;
    // Two layers of noise rushing upward, the second faster and finer; the first bends the second.
    vec4 a = texture2D(tNoise, vec2(uv.x * 0.55 + vSeed, uv.y * 0.42 - t * 0.55));
    vec2 warp = (a.rg - 0.5) * 0.28;
    vec4 b = texture2D(tNoise, vec2(uv.x * 1.1 + vSeed * 3.1, uv.y * 0.9 - t * 1.35) + warp);
    float n = a.r * 0.45 + b.b * 0.55;
    // Tongue shape: wide at the base, licking to a point, swaying.
    float x = (uv.x - 0.5) * 2.0 + (a.g - 0.5) * 0.7 * uv.y;
    float width = mix(0.92, 0.12, pow(uv.y, 0.75));
    float body = 1.0 - smoothstep(width * 0.35, width, abs(x));
    float h = uv.y + (n - 0.5) * 0.7;
    float flame = body * (1.0 - smoothstep(0.32, 0.95, h)) * smoothstep(0.0, 0.1, uv.y);
    flame *= 0.55 + n * 0.9;
    flame = smoothstep(0.12, 0.75, flame);
    if (flame < 0.004) discard;
    // White-yellow at the root, orange through the body, dull red at the tips.
    float temp = clamp(flame * (1.25 - uv.y * 0.85) * vHeat, 0.0, 1.0);
    // Blended over (not added): a field of overlapping tongues stays fire-coloured instead of
    // summing to white. Only the white-hot roots reach the bloom (luminance ~1, threshold 0.9): a
    // little glare there, not a white ball over the whole street.
    vec3 col = fireRamp(temp * 0.92) * 0.22;
    float alpha = clamp(flame * vAlpha * 1.4, 0.0, 1.0);
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        alpha *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        alpha *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #endif
    gl_FragColor = vec4(col, alpha);
  }
`;

const GLOW_VERT = /* glsl */ `
  attribute vec4 a0; // centre, radius
  attribute vec4 a1; // strength, seed
  varying vec2 vUv;
  varying float vStrength, vSeed;
  #include <fog_pars_vertex>
  void main() {
    vec3 p = a0.xyz + vec3(position.x, 0.0, position.y) * a0.w * 2.0;
    vec4 mvPosition = viewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    vUv = position.xy * 2.0;
    vStrength = a1.x;
    vSeed = a1.y;
    #include <fog_vertex>
  }
`;

const GLOW_FRAG = /* glsl */ `
  uniform sampler2D tNoise;
  uniform float uTime;
  varying vec2 vUv;
  varying float vStrength, vSeed;
  #include <fog_pars_fragment>
  ${FIRE_RAMP_GLSL}
  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    // Burning fuel on the floor: a bright, rippling sheet with cooler patches.
    vec4 n = texture2D(tNoise, vUv * 0.35 + vec2(vSeed, uTime * 0.07));
    vec4 m = texture2D(tNoise, vUv * 0.9 + vec2(-uTime * 0.11, vSeed * 2.0));
    float edge = 1.0 - smoothstep(0.35, 1.0, r + (n.r - 0.5) * 0.5);
    float heat = edge * (0.45 + m.b * 0.75) * vStrength;
    // Kept under the bloom: the flames above it carry the glare.
    vec3 col = fireRamp(heat * 0.8) * edge * 0.16;
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        col *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        col *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
      #endif
    #endif
    gl_FragColor = vec4(col, 1.0);
  }
`;

function batch(capacity: number, vert: string, frag: string, quad: number[], blending: THREE.Blending = THREE.AdditiveBlending): { mesh: THREE.Mesh; a0: Float32Array; a1: Float32Array; geo: THREE.InstancedBufferGeometry; mat: THREE.ShaderMaterial } {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(quad), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const mk = (name: string) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, a);
    return a.array as Float32Array;
  };
  const a0 = mk('a0'), a1 = mk('a1');
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), tNoise: { value: noiseTexture() }, uTime: { value: 0 } },
    fog: true,
    transparent: true,
    depthWrite: false,
    blending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return { mesh, a0, a1, geo, mat };
}

/**
 * Live flames: tongues of fire (upright cards turned to the camera, shaded by scrolling noise
 * into licking, flickering shapes, their white-hot roots just bright enough to glare) and the sheet
 * of burning fuel on the floor under them. Filled from scratch every frame by whoever owns
 * fires: spills, burning zombies, a Molotov's rag.
 */
export class Flames {
  readonly root = new THREE.Group();
  private readonly flames: ReturnType<typeof batch>;
  private readonly glows: ReturnType<typeof batch>;
  private n = 0;
  private g = 0;
  private cap: number;
  private glowCap: number;

  constructor(private readonly maxFlames = 700, private readonly maxGlows = 64) {
    this.cap = maxFlames;
    this.glowCap = maxGlows;
    this.flames = batch(maxFlames, FLAME_VERT, FLAME_FRAG, [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], THREE.NormalBlending);
    this.glows = batch(maxGlows, GLOW_VERT, GLOW_FRAG, [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
    this.flames.mesh.renderOrder = 5;
    this.glows.mesh.renderOrder = 2;
    this.root.add(this.glows.mesh, this.flames.mesh);
  }

  setQuality(fraction: number): void {
    this.cap = Math.max(32, Math.floor(this.maxFlames * fraction));
    this.glowCap = Math.max(8, Math.floor(this.maxGlows * Math.max(0.5, fraction)));
  }

  begin(): void {
    this.n = 0;
    this.g = 0;
  }

  /** A tongue of flame standing at (x, y, z): width, height, 0..1 heat and opacity. */
  flame(x: number, y: number, z: number, w: number, h: number, seed: number, heat: number, alpha: number): void {
    if (this.n >= this.cap || alpha <= 0.01) return;
    const o = this.n++ * 4;
    const a0 = this.flames.a0, a1 = this.flames.a1;
    a0[o] = x; a0[o + 1] = y; a0[o + 2] = z; a0[o + 3] = w;
    a1[o] = h; a1[o + 1] = seed; a1[o + 2] = heat; a1[o + 3] = alpha;
  }

  /** Burning fuel on the floor. */
  pool(x: number, y: number, z: number, r: number, strength: number, seed: number): void {
    if (this.g >= this.glowCap || strength <= 0.01) return;
    const o = this.g++ * 4;
    const a0 = this.glows.a0, a1 = this.glows.a1;
    a0[o] = x; a0[o + 1] = y + 0.025; a0[o + 2] = z; a0[o + 3] = r;
    a1[o] = strength; a1[o + 1] = seed;
  }

  get count(): number {
    return this.n;
  }

  end(dt: number): void {
    for (const [b, n] of [[this.flames, this.n], [this.glows, this.g]] as const) {
      b.mat.uniforms.uTime.value += dt;
      b.geo.instanceCount = n;
      // Empty: not drawn, and nothing to send (a zero-length update range would upload the whole pool).
      b.mesh.visible = n > 0;
      if (n === 0) continue;
      for (const name of ['a0', 'a1']) {
        const a = b.geo.getAttribute(name) as THREE.InstancedBufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 4);
        a.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const b of [this.flames, this.glows]) {
      b.geo.dispose();
      b.mat.dispose();
    }
  }
}
