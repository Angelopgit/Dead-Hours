import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/** Slots for live lights (muzzle flashes, flashlights, fires), on top of the static lamps' own. */
export const LIVE_FOG_LIGHTS = 4;
/** Most static lamps the fog can take (high quality); see SceneFXOptions.fogLights. */
export const FOG_LAMPS = 12;
/** Most lights the fog scatters at once: the lamps' slots plus the live lights'. */
export const FOG_LIGHTS = FOG_LAMPS + LIVE_FOG_LIGHTS;

/** A light that scatters in the fog: static lamps from the map, plus live scene lights. */
export interface FogLight {
  pos: THREE.Vector3;
  range: number;
  /** Linear color × intensity (candela). */
  color: THREE.Color;
  decay: number;
  /** Spot aim (unit); cosOuter = -2 for point lights. */
  dir: THREE.Vector3;
  cosOuter: number;
  cosInner: number;
  /** World box the light is confined to (the room around an indoor lamp); null for none. */
  box: THREE.Box3 | null;
}

export interface SceneFXOptions {
  /** Screen-space ambient occlusion samples (0 = off). */
  aoSamples: number;
  /** Volumetric fog resolution as a fraction of the screen (0 = off). */
  fogScale: number;
  fogSteps: number;
  /** Static lamps the fog takes (live lights get LIVE_FOG_LIGHTS more). */
  fogLights: number;
  /** Camera motion blur taps (0 = off). */
  blurTaps: number;
  msaa: boolean;
}

const FULL_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/** Shared helpers: depth → view position, per-pixel noise. */
const DEPTH_COMMON = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform mat4 uProjInv;
  uniform float uNear, uFar;
  float viewZAt(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    return perspectiveDepthToViewZ(d, uNear, uFar);
  }
  vec3 viewPosAt(vec2 uv, float d) {
    vec4 p = uProjInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0);
    return p.xyz / p.w;
  }
  // Interleaved gradient noise (Jimenez 2014).
  float ign(vec2 px) { return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715)))); }
`;

/**
 * Depth-only SSAO: normals rebuilt from the depth buffer, a rotated spiral of hemisphere samples,
 * range-checked so silhouettes don't halo. Static surfaces already carry baked occlusion; this adds
 * the contact shadows the bake can't know about (zombies, bodies, doors, props on floors).
 */
function aoShader(samples: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: { SAMPLES: samples },
    uniforms: {
      tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uProj: { value: new THREE.Matrix4() },
      uNear: { value: 0.1 }, uFar: { value: 400 }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 0.55 },
      uStrength: { value: 1.1 },
    },
    vertexShader: FULL_VERT,
    fragmentShader: /* glsl */ `
      ${DEPTH_COMMON}
      uniform mat4 uProj;
      uniform vec2 uTexel;
      uniform float uRadius, uStrength;
      varying vec2 vUv;
      vec3 posAt(vec2 uv) { return viewPosAt(uv, texture2D(tDepth, uv).x); }
      void main() {
        float d = texture2D(tDepth, vUv).x;
        if (d >= 0.99999) { gl_FragColor = vec4(1.0, 1e4, 0.0, 1.0); return; }
        vec3 P = viewPosAt(vUv, d);
        // Normal from the smaller depth step on each axis (no smearing across silhouettes).
        vec3 l = posAt(vUv - vec2(uTexel.x, 0.0)), r = posAt(vUv + vec2(uTexel.x, 0.0));
        vec3 b = posAt(vUv - vec2(0.0, uTexel.y)), t = posAt(vUv + vec2(0.0, uTexel.y));
        vec3 dx = abs(r.z - P.z) < abs(P.z - l.z) ? r - P : P - l;
        vec3 dy = abs(t.z - P.z) < abs(P.z - b.z) ? t - P : P - b;
        vec3 n = cross(dx, dy);
        float nl = length(n);
        n = nl > 1e-8 ? n / nl : vec3(0.0, 0.0, 1.0);
        float rot = ign(gl_FragCoord.xy) * 6.2831853;
        float radius = uRadius * clamp(-P.z / 6.0, 0.6, 2.2);
        float occ = 0.0;
        for (int i = 0; i < SAMPLES; i++) {
          float fi = (float(i) + 0.5) / float(SAMPLES);
          float a = rot + float(i) * 2.39996323;
          // Kept at least ~20° off the surface: near-tangent samples band on grazing floors.
          vec3 h = normalize(vec3(cos(a) * sqrt(fi), sin(a) * sqrt(fi), mix(0.35, 1.0, sqrt(1.0 - fi))));
          // Hemisphere around n.
          vec3 up = abs(n.z) < 0.999 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
          vec3 tx = normalize(cross(up, n));
          vec3 ty = cross(n, tx);
          vec3 S = P + (tx * h.x + ty * h.y + n * h.z) * radius * mix(0.2, 1.0, fi * fi);
          vec4 c = uProj * vec4(S, 1.0);
          if (c.w <= 1e-4) continue;
          vec2 suv = c.xy / c.w * 0.5 + 0.5;
          if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
          float sz = viewZAt(suv);
          float range = smoothstep(0.0, 1.0, radius / max(abs(P.z - sz), 1e-3));
          // Depth-scaled bias: rebuilt normals on grazing floors would otherwise band.
          occ += (sz >= S.z + 0.03 + 0.006 * -P.z ? 1.0 : 0.0) * range;
        }
        float ao = 1.0 - occ / float(SAMPLES);
        ao = pow(clamp(ao, 0.0, 1.0), uStrength);
        // Far away the samples shrink below a pixel: fade out.
        ao = mix(ao, 1.0, smoothstep(30.0, 55.0, -P.z));
        gl_FragColor = vec4(ao, -P.z, 0.0, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

/**
 * Volumetric fog: marches each (low-resolution) pixel's view ray through height fog with drifting
 * 3D noise and gathers single scattering from the strongest nearby lights (Henyey-Greenstein phase,
 * spot cones, inverse-power falloff). Each light only spends work on the stretch of ray inside its
 * range sphere and its room box, so a street of lamps costs a few lights per pixel.
 */
function fogShader(steps: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: { STEPS: steps, MAX_LIGHTS: FOG_LIGHTS },
    uniforms: {
      tDepth: { value: null }, uProjInv: { value: new THREE.Matrix4() }, uNear: { value: 0.1 }, uFar: { value: 400 },
      uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() },
      tNoise: { value: null as THREE.Data3DTexture | null },
      uTime: { value: 0 }, uWind: { value: new THREE.Vector3(1.2, 0, 0.5) },
      uDensity: { value: 0.02 }, uStrength: { value: 1 }, uMaxDist: { value: 42 }, uFrame: { value: 0 },
      uCount: { value: 0 },
      tCover: { value: null as THREE.Texture | null }, uCoverRect: { value: new THREE.Vector4() },
      uPos: { value: Array.from({ length: FOG_LIGHTS }, () => new THREE.Vector4()) },
      uCol: { value: Array.from({ length: FOG_LIGHTS }, () => new THREE.Vector4()) },
      uDir: { value: Array.from({ length: FOG_LIGHTS }, () => new THREE.Vector4()) },
      uBoxMin: { value: Array.from({ length: FOG_LIGHTS }, () => new THREE.Vector4()) },
      uBoxMax: { value: Array.from({ length: FOG_LIGHTS }, () => new THREE.Vector4()) },
    },
    vertexShader: FULL_VERT,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      ${DEPTH_COMMON}
      uniform mat4 uCamWorld;
      uniform vec3 uCamPos, uWind;
      uniform sampler3D tNoise;
      uniform float uTime, uDensity, uStrength, uMaxDist, uFrame;
      uniform int uCount;
      uniform sampler2D tCover;
      uniform vec4 uCoverRect;
      uniform vec4 uPos[MAX_LIGHTS];   // xyz, range
      uniform vec4 uCol[MAX_LIGHTS];   // rgb × intensity, decay
      uniform vec4 uDir[MAX_LIGHTS];   // aim, cos outer (-2 = point)
      uniform vec4 uBoxMin[MAX_LIGHTS]; // xyz, cos inner
      uniform vec4 uBoxMax[MAX_LIGHTS];
      varying vec2 vUv;
      float density(vec3 p) {
        float n = texture(tNoise, p * vec3(0.045, 0.09, 0.045) + uWind * uTime * 0.012).r;
        float n2 = texture(tNoise, p * vec3(0.13, 0.2, 0.13) - uWind * uTime * 0.02).r;
        float h = exp(-max(p.y, 0.0) * 0.16);
        // Under a roof the air is clearer: a little dust in the lamp light, not street fog.
        float roof = texture2D(tCover, (p.xz - uCoverRect.xy) * uCoverRect.zw).r * 20.0 - 4.0;
        float indoor = p.y < roof ? 0.28 : 1.0;
        return uDensity * h * indoor * (0.35 + 1.3 * n * (0.6 + 0.8 * n2));
      }
      void main() {
        float d = texture2D(tDepth, vUv).x;
        vec3 vp = viewPosAt(vUv, min(d, 0.999999));
        float viewDist = length(vp);
        vec3 rd = normalize(mat3(uCamWorld) * vp);
        vec3 ro = uCamPos;
        float tEnd = min(d >= 0.99999 ? uMaxDist : viewDist, uMaxDist);
        float t0[MAX_LIGHTS];
        float t1[MAX_LIGHTS];
        bool any = false;
        for (int i = 0; i < MAX_LIGHTS; i++) {
          t0[i] = 1e9; t1[i] = -1.0;
          if (i >= uCount) continue;
          vec3 oc = uPos[i].xyz - ro;
          float b = dot(oc, rd);
          float c = dot(oc, oc) - uPos[i].w * uPos[i].w;
          float disc = b * b - c;
          if (disc <= 0.0) continue;
          float sq = sqrt(disc);
          float a0 = max(b - sq, 0.0), a1 = min(b + sq, tEnd);
          // Clip to the light's box (slab test).
          vec3 inv = 1.0 / vec3(abs(rd.x) < 1e-5 ? 1e-5 : rd.x, abs(rd.y) < 1e-5 ? 1e-5 : rd.y, abs(rd.z) < 1e-5 ? 1e-5 : rd.z);
          vec3 s0 = (uBoxMin[i].xyz - ro) * inv, s1 = (uBoxMax[i].xyz - ro) * inv;
          vec3 lo = min(s0, s1), hi = max(s0, s1);
          a0 = max(a0, max(max(lo.x, lo.y), lo.z));
          a1 = min(a1, min(min(hi.x, hi.y), hi.z));
          if (a1 > a0) { t0[i] = a0; t1[i] = a1; any = true; }
        }
        vec3 acc = vec3(0.0);
        if (any) {
          float stepLen = tEnd / float(STEPS);
          float j = ign(gl_FragCoord.xy + uFrame * 5.588238);
          float T = 1.0;
          for (int s = 0; s < STEPS; s++) {
            float t = (float(s) + j) * stepLen;
            vec3 p = ro + rd * t;
            float dens = density(p);
            vec3 ins = vec3(0.0);
            for (int i = 0; i < MAX_LIGHTS; i++) {
              if (i >= uCount) break;
              if (t < t0[i] || t > t1[i]) continue;
              vec3 lv = uPos[i].xyz - p;
              float dl = max(length(lv), 0.05);
              vec3 l = lv / dl;
              float win = 1.0 - pow(min(dl / uPos[i].w, 1.0), 4.0);
              float att = win * win / pow(max(dl, 0.35), uCol[i].w);
              float co = uDir[i].w;
              float cone = co < -1.0 ? 1.0 : smoothstep(co, uBoxMin[i].w, dot(-l, uDir[i].xyz));
              // Henyey-Greenstein, g = 0.35: light bends gently forward toward the eye.
              float mu = dot(l, rd);
              float ph = 0.0796 * (1.0 - 0.1225) / pow(max(1.1225 - 0.7 * mu, 1e-3), 1.5);
              ins += uCol[i].rgb * (att * cone * ph);
            }
            acc += T * dens * ins * stepLen;
            T *= exp(-dens * stepLen * 0.6);
          }
        }
        acc = clamp(acc * uStrength, vec3(0.0), vec3(32.0));
        gl_FragColor = vec4(acc, d >= 0.99999 ? 1e4 : -vp.z);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

/** Composite: scene color (with camera motion blur), × AO, + fog in-scattering, depth-aware upsampling. */
function compositeShader(taps: number, ao: boolean, fog: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: { TAPS: taps, USE_AO: ao ? 1 : 0, USE_FOG: fog ? 1 : 0 },
    uniforms: {
      tColor: { value: null }, tDepth: { value: null }, tAO: { value: null }, tFog: { value: null },
      uProjInv: { value: new THREE.Matrix4() }, uNear: { value: 0.1 }, uFar: { value: 400 },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() },
      uBlur: { value: 0 }, uAOTexel: { value: new THREE.Vector2() }, uFogTexel: { value: new THREE.Vector2() },
    },
    vertexShader: FULL_VERT,
    fragmentShader: /* glsl */ `
      ${DEPTH_COMMON}
      uniform sampler2D tColor, tAO, tFog;
      uniform mat4 uInvViewProj, uPrevViewProj;
      uniform float uBlur;
      uniform vec2 uAOTexel, uFogTexel;
      varying vec2 vUv;
      bool bad(vec3 c) { return any(greaterThanEqual(floatBitsToUint(c) & 0x7fffffffu, uvec3(0x7f800000u))); }
      vec3 safe(vec3 c) { return bad(c) ? vec3(0.0) : c; }
      // Depth-aware upsample: a 3×3 tent of low-res taps, each weighted by how close its depth is to
      // this pixel's, so fog and AO stay put at silhouettes and the per-pixel march jitter smooths out.
      vec4 upsample(sampler2D tex, vec2 texel, float z, int channel) {
        vec2 c = (floor(vUv / texel) + 0.5) * texel;
        vec4 sum = vec4(0.0);
        float wsum = 0.0;
        for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
          vec2 uv = c + vec2(float(x), float(y)) * texel;
          vec4 s = texture2D(tex, uv);
          float sz = channel == 1 ? s.g : s.a;
          vec2 f = max(1.5 - abs(vUv - uv) / texel, 0.0);
          float w = max(f.x * f.y, 1e-3) / (1e-3 + abs(sz - z) / max(z, 0.1));
          sum += s * w;
          wsum += w;
        }
        return sum / wsum;
      }
      void main() {
        float d = texture2D(tDepth, vUv).x;
        float z = d >= 0.99999 ? 1e4 : -perspectiveDepthToViewZ(d, uNear, uFar);
        vec3 c = safe(texture2D(tColor, vUv).rgb);
        #if TAPS > 0
        // Camera motion blur: where this pixel was last frame, from depth. Hands and gun (closer
        // than 0.7 m) move with the camera, so they neither blur nor smear into the background.
        if (uBlur > 0.0 && z > 0.7) {
          vec4 w = uInvViewProj * vec4(vec3(vUv, min(d, 0.99999)) * 2.0 - 1.0, 1.0);
          w /= w.w;
          vec4 pc = uPrevViewProj * w;
          vec2 prev = pc.w > 1e-4 ? pc.xy / pc.w * 0.5 + 0.5 : vUv;
          vec2 vel = (vUv - prev) * uBlur;
          float len = length(vel);
          if (len > 0.045) vel *= 0.045 / len;
          if (length(vel) > 0.0015) {
            vec3 sum = c;
            float n = 1.0;
            float j = ign(gl_FragCoord.xy) - 0.5;
            for (int i = 1; i <= TAPS; i++) {
              vec2 uv = vUv - vel * ((float(i) + j) / float(TAPS) - 0.5);
              if (-perspectiveDepthToViewZ(texture2D(tDepth, uv).x, uNear, uFar) < 0.7) continue;
              sum += safe(texture2D(tColor, uv).rgb);
              n += 1.0;
            }
            c = sum / n;
          }
        }
        #endif
        #if USE_AO
        c *= clamp(upsample(tAO, uAOTexel, z, 1).r, 0.0, 1.0);
        #endif
        #if USE_FOG
        c += max(upsample(tFog, uFogTexel, z, 3).rgb, 0.0);
        #endif
        gl_FragColor = vec4(c, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
}

/** Tileable 3D value noise for fog density, 32³. */
function noiseVolume(): THREE.Data3DTexture {
  const N = 32;
  const lattice = new Float32Array(8 * 8 * 8);
  let s = 987654321;
  for (let i = 0; i < lattice.length; i++) lattice[i] = (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const L = (x: number, y: number, z: number) => lattice[((z & 7) * 8 + (y & 7)) * 8 + (x & 7)];
  const fade = (t: number) => t * t * (3 - 2 * t);
  const data = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let v = 0, amp = 0.65, tot = 0;
    for (const oct of [1, 2]) {
      const fx = (x / N) * 8 * oct * 0.5, fy = (y / N) * 8 * oct * 0.5, fz = (z / N) * 8 * oct * 0.5;
      const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
      const tx = fade(fx - ix), ty = fade(fy - iy), tz = fade(fz - iz);
      const m = (a: number, b: number, t: number) => a + (b - a) * t;
      const per = 4 * oct;
      const g = (dx: number, dy: number, dz: number) => L((ix + dx) % per, (iy + dy) % per, (iz + dz) % per);
      const n = m(
        m(m(g(0, 0, 0), g(1, 0, 0), tx), m(g(0, 1, 0), g(1, 1, 0), tx), ty),
        m(m(g(0, 0, 1), g(1, 0, 1), tx), m(g(0, 1, 1), g(1, 1, 1), tx), ty), tz);
      v += n * amp;
      tot += amp;
      amp *= 0.55;
    }
    data[(z * N + y) * N + x] = Math.round((v / tot) * 255);
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/**
 * First pass of the post chain: draws the scene into its own target (so depth stays readable),
 * then SSAO and volumetric fog at reduced resolution, and composites them, with camera motion blur,
 * into the composer's buffer. With every effect off and no MSAA it draws the scene straight into
 * the composer's buffer: the phone preset pays nothing for it.
 */
export class ScenePass extends Pass {
  camera: THREE.PerspectiveCamera;
  private opts: SceneFXOptions = { aoSamples: 0, fogScale: 0, fogSteps: 0, fogLights: 0, blurTaps: 0, msaa: false };
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private aoRT: THREE.WebGLRenderTarget | null = null;
  private fogRT: THREE.WebGLRenderTarget | null = null;
  private aoMat: THREE.ShaderMaterial | null = null;
  private fogMat: THREE.ShaderMaterial | null = null;
  private compMat: THREE.ShaderMaterial | null = null;
  private readonly quad = new FullScreenQuad();
  private readonly noise = noiseVolume();
  private width = 1;
  private height = 1;
  private frame = 0;
  private readonly prevViewProj = new THREE.Matrix4();
  private readonly viewProj = new THREE.Matrix4();
  private readonly prevCamPos = new THREE.Vector3();
  private readonly prevCamDir = new THREE.Vector3();
  private havePrev = false;
  /** Lights the fog scatters this frame (filled by the owner before render). */
  readonly lights: FogLight[] = [];
  fogDensity = 0.02;
  /** Roof height map (see Rain.buildCoverMap): fog thins out indoors. */
  cover: THREE.Texture | null = null;
  readonly coverRect = new THREE.Vector4();
  fogStrength = 0.85;
  /** Seconds, for drifting fog. */
  time = 0;
  readonly wind = new THREE.Vector3(1.2, 0, 0.5);
  /** Motion blur strength (1 = a 1/60 s shutter at the current frame rate). */
  blurAmount = 1;
  private dt = 1 / 60;

  constructor(private readonly scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    super();
    this.camera = camera;
    this.needsSwap = true;
  }

  get fogOn(): boolean {
    return this.opts.fogScale > 0;
  }

  /** Static lamps the fog takes at this quality. */
  get fogLamps(): number {
    return Math.min(this.opts.fogLights, FOG_LAMPS);
  }

  configure(o: SceneFXOptions): void {
    const prev = this.opts;
    this.opts = { ...o };
    const effects = o.aoSamples > 0 || o.fogScale > 0 || o.blurTaps > 0;
    if (effects || o.msaa) {
      if (!this.sceneRT || prev.msaa !== o.msaa) {
        this.sceneRT?.dispose();
        this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
          type: THREE.HalfFloatType,
          samples: o.msaa ? 4 : 0,
          depthTexture: new THREE.DepthTexture(this.width, this.height, THREE.UnsignedIntType),
        });
      }
    } else {
      this.sceneRT?.dispose();
      this.sceneRT = null;
    }
    if (o.aoSamples !== prev.aoSamples) {
      this.aoMat?.dispose();
      this.aoMat = o.aoSamples > 0 ? aoShader(o.aoSamples) : null;
    }
    if (o.fogSteps !== prev.fogSteps || (o.fogScale > 0) !== (prev.fogScale > 0)) {
      this.fogMat?.dispose();
      this.fogMat = o.fogScale > 0 ? fogShader(o.fogSteps) : null;
      if (this.fogMat) this.fogMat.uniforms.tNoise.value = this.noise;
    }
    if (o.aoSamples > 0 && !this.aoRT) this.aoRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    if (o.aoSamples === 0 && this.aoRT) { this.aoRT.dispose(); this.aoRT = null; }
    if (o.fogScale > 0 && !this.fogRT) this.fogRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    if (o.fogScale === 0 && this.fogRT) { this.fogRT.dispose(); this.fogRT = null; }
    if (o.blurTaps !== prev.blurTaps || (o.aoSamples > 0) !== (prev.aoSamples > 0) || (o.fogScale > 0) !== (prev.fogScale > 0) || !this.compMat) {
      this.compMat?.dispose();
      this.compMat = compositeShader(o.blurTaps, o.aoSamples > 0, o.fogScale > 0);
    }
    this.havePrev = false;
    this.setSize(this.width, this.height);
  }

  setSize(w: number, h: number): void {
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    this.sceneRT?.setSize(this.width, this.height);
    this.aoRT?.setSize(Math.max(1, Math.round(this.width / 2)), Math.max(1, Math.round(this.height / 2)));
    if (this.fogRT) {
      const s = this.opts.fogScale;
      this.fogRT.setSize(Math.max(1, Math.round(this.width * s)), Math.max(1, Math.round(this.height * s)));
    }
  }

  setDelta(dt: number): void {
    this.dt = Math.max(dt, 1 / 240);
  }

  private setDepthUniforms(m: THREE.ShaderMaterial): void {
    const u = m.uniforms;
    u.tDepth.value = this.sceneRT!.depthTexture;
    u.uProjInv.value.copy(this.camera.projectionMatrixInverse);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget): void {
    const cam = this.camera;
    if (!this.sceneRT) {
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      renderer.clear();
      renderer.render(this.scene, cam);
      return;
    }
    renderer.setRenderTarget(this.sceneRT);
    renderer.clear();
    renderer.render(this.scene, cam);
    this.frame = (this.frame + 1) % 64;

    if (this.aoMat && this.aoRT) {
      this.setDepthUniforms(this.aoMat);
      const u = this.aoMat.uniforms;
      u.uProj.value.copy(cam.projectionMatrix);
      u.uTexel.value.set(1 / this.width, 1 / this.height);
      this.quad.material = this.aoMat;
      renderer.setRenderTarget(this.aoRT);
      this.quad.render(renderer);
    }
    if (this.fogMat && this.fogRT) {
      this.setDepthUniforms(this.fogMat);
      const u = this.fogMat.uniforms;
      u.uCamWorld.value.copy(cam.matrixWorld);
      u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
      u.uTime.value = this.time;
      u.uWind.value.copy(this.wind);
      u.uDensity.value = this.fogDensity;
      u.uStrength.value = this.fogStrength;
      u.uFrame.value = this.frame;
      u.tCover.value = this.cover;
      u.uCoverRect.value.copy(this.coverRect);
      const n = Math.min(this.lights.length, FOG_LIGHTS);
      for (let i = 0; i < n; i++) {
        const l = this.lights[i];
        u.uPos.value[i].set(l.pos.x, l.pos.y, l.pos.z, l.range);
        u.uCol.value[i].set(l.color.r, l.color.g, l.color.b, l.decay);
        u.uDir.value[i].set(l.dir.x, l.dir.y, l.dir.z, l.cosOuter);
        if (l.box) {
          u.uBoxMin.value[i].set(l.box.min.x, l.box.min.y, l.box.min.z, l.cosInner);
          u.uBoxMax.value[i].set(l.box.max.x, l.box.max.y, l.box.max.z, 0);
        } else {
          u.uBoxMin.value[i].set(-1e5, -1e5, -1e5, l.cosInner);
          u.uBoxMax.value[i].set(1e5, 1e5, 1e5, 0);
        }
      }
      u.uCount.value = n;
      this.quad.material = this.fogMat;
      renderer.setRenderTarget(this.fogRT);
      this.quad.render(renderer);
    }

    const c = this.compMat!;
    this.setDepthUniforms(c);
    const u = c.uniforms;
    u.tColor.value = this.sceneRT.texture;
    if (this.aoRT) {
      u.tAO.value = this.aoRT.texture;
      u.uAOTexel.value.set(1 / this.aoRT.width, 1 / this.aoRT.height);
    }
    if (this.fogRT) {
      u.tFog.value = this.fogRT.texture;
      u.uFogTexel.value.set(1 / this.fogRT.width, 1 / this.fogRT.height);
    }
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (this.opts.blurTaps > 0) {
      // A cut (teleport, respawn, a cinematic jump) would blur the whole screen: skip that frame.
      const pos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
      const cut = !this.havePrev || pos.distanceTo(this.prevCamPos) > 1.5 || dir.dot(this.prevCamDir) < 0.75;
      u.uBlur.value = cut ? 0 : this.blurAmount * Math.min(2, (1 / 60) / this.dt);
      u.uInvViewProj.value.copy(this.viewProj).invert();
      u.uPrevViewProj.value.copy(this.prevViewProj);
      this.prevCamPos.copy(pos);
      this.prevCamDir.copy(dir);
    }
    this.prevViewProj.copy(this.viewProj);
    this.havePrev = true;
    this.quad.material = c;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose(): void {
    this.sceneRT?.dispose();
    this.aoRT?.dispose();
    this.fogRT?.dispose();
    this.aoMat?.dispose();
    this.fogMat?.dispose();
    this.compMat?.dispose();
    this.noise.dispose();
    this.quad.dispose();
  }
}
