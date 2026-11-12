import * as THREE from 'three';

/**
 * Zombie flesh, all in the body shader so it costs no textures, no extra meshes and no extra
 * draw calls: rotting skin (mottling, necrotic patches with raw rims, dark veins, boils on
 * bloaters), clothes torn open onto that skin, a mouth that has been feeding, and up to
 * MAX_HITS local wounds. Each wound is a hole with a ring of raw meat whose blood soaks outward
 * (further down than up) over the seconds after the hit, darker and wider in cloth than on skin.
 *
 * Everything is placed in bind-pose space (the body as built, standing at the origin facing +Z),
 * so it sticks to the body however it moves or ragdolls.
 */

/** Local wounds tracked per body; the oldest is replaced when full. */
export const MAX_HITS = 8;

/** Surface classes, packed into the `pattern` attribute's w (pattern type + 8 * class). */
export const SURF = { cloth: 0, skin: 1, hard: 2 } as const;

/**
 * Four independent channels of smooth, tiling value noise in one small 3D texture: one fetch
 * stands in for four procedural noise calls (8 hashes each), which is what keeps 200 rotting,
 * bleeding bodies affordable. 8 noise cells per tile, 4 texels per cell.
 */
let noiseTex: THREE.Data3DTexture | null = null;
/** The shared noise texture (survivors' cloth wear and grime read it too). */
export function decayNoise(): THREE.Data3DTexture {
  if (noiseTex) return noiseTex;
  const N = 32, CELLS = 8, PER = N / CELLS;
  const data = new Uint8Array(N * N * N * 4);
  let seed = 0x9e3779b9;
  const rand = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296);
  const lattice = Array.from({ length: 4 }, () => Float32Array.from({ length: CELLS ** 3 }, rand));
  const L = (c: number, x: number, y: number, z: number) => lattice[c][((z % CELLS) * CELLS + (y % CELLS)) * CELLS + (x % CELLS)];
  const sm = (t: number) => t * t * (3 - 2 * t);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const cx = Math.floor(x / PER), cy = Math.floor(y / PER), cz = Math.floor(z / PER);
    const fx = sm((x % PER) / PER), fy = sm((y % PER) / PER), fz = sm((z % PER) / PER);
    for (let c = 0; c < 4; c++) {
      const a = L(c, cx, cy, cz) + (L(c, cx + 1, cy, cz) - L(c, cx, cy, cz)) * fx;
      const b = L(c, cx, cy + 1, cz) + (L(c, cx + 1, cy + 1, cz) - L(c, cx, cy + 1, cz)) * fx;
      const d = L(c, cx, cy, cz + 1) + (L(c, cx + 1, cy, cz + 1) - L(c, cx, cy, cz + 1)) * fx;
      const e = L(c, cx, cy + 1, cz + 1) + (L(c, cx + 1, cy + 1, cz + 1) - L(c, cx, cy + 1, cz + 1)) * fx;
      const v = (a + (b - a) * fy) + ((d + (e - d) * fy) - (a + (b - a) * fy)) * fz;
      data[((z * N + y) * N + x) * 4 + c] = Math.round(v * 255);
    }
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return (noiseTex = t);
}

export interface DecayUniforms {
  /** Shared noise (see decayNoise). */
  uZNoise: { value: THREE.Data3DTexture };
  /** xyz: bind-pose position; w: current soak radius (0 = unused). */
  uHits: { value: THREE.Vector4[] };
  /** Per wound: how bad it is (hole and raw ring size), 0..1.6. */
  uHitK: { value: Float32Array };
  /** x: per-body seed, y: decay 0..1, z: mutation (0 none, 1 screamer, 2 bloater), w: gore shown (0/1). */
  uZ: { value: THREE.Vector4 };
  /** The body's skin color (linear), seen through torn clothes. */
  uZSkin: { value: THREE.Color };
  /** 1 for a whole body (mouth and wounds are placed in its space), 0 for a severed arm. */
  uZBody: { value: number };
}

export function createDecayUniforms(skinHex: number, decay: number, mutation: number, seed: number, body: boolean): DecayUniforms {
  return {
    uZNoise: { value: decayNoise() },
    uHits: { value: Array.from({ length: MAX_HITS }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uHitK: { value: new Float32Array(MAX_HITS) },
    uZ: { value: new THREE.Vector4(seed, decay, mutation, 1) },
    uZSkin: { value: new THREE.Color(skinHex) },
    uZBody: { value: body ? 1 : 0 },
  };
}

// ── Detail level ───────────────────────────────────────────────────────────────────────────

/** 'lite' (phone and low presets) skips the fine noise octaves and veins. */
let detail: 'full' | 'lite' = 'full';
const materials = new Set<THREE.Material>();

export function zombieDetail(): 'full' | 'lite' {
  return detail;
}

/** Switches every zombie material's shader detail (recompiles them once). */
export function setZombieDetail(d: 'full' | 'lite'): void {
  if (d === detail) return;
  detail = d;
  for (const m of materials) m.needsUpdate = true;
}

export function trackDecayMaterial(m: THREE.Material): void {
  materials.add(m);
}

export function untrackDecayMaterial(m: THREE.Material): void {
  materials.delete(m);
}

// ── GLSL ───────────────────────────────────────────────────────────────────────────────────

/** Fragment declarations (after the wound noise helpers wHash/wNoise). */
export const DECAY_COMMON = /* glsl */ `
  precision highp sampler3D;
  uniform sampler3D uZNoise;
  uniform vec4 uHits[${MAX_HITS}];
  uniform float uHitK[${MAX_HITS}];
  uniform vec4 uZ;
  uniform vec3 uZSkin;
  uniform float uZBody;

  // Four independent smooth noises (0..1) with unit-sized cells, from the noise texture.
  vec4 zN(vec3 x) { return texture(uZNoise, x * 0.125); }

  // Rotting skin at bind-pose point q: mottled bruise and bile, necrotic patches with raw wet
  // rims, dark veins (pronounced on screamers), pus-yellow boils on bloaters.
  vec3 zRot(vec3 c, vec3 q, float near, inout float wet) {
    float d = uZ.y;
#ifdef DECAY_LITE
    // One fetch: both octaves at the broad scale.
    vec4 nn = zN(q * 7.0);
    float n1 = nn.x, n2 = nn.y;
#else
    float n1 = zN(q * 5.0).x;
    float n2 = zN(q * 13.0 + 7.1).x;
#endif
    vec3 bruise = vec3(0.27, 0.15, 0.2);
    vec3 bile = vec3(0.3, 0.32, 0.2);
    c = mix(c, c * mix(bile, bruise, n2) * 2.4, smoothstep(0.45, 0.72, n1) * 0.5 * d);
    // Grey, sunken, bloodless overall.
    c *= 0.82 + 0.18 * n2;
    float nec = n1 * 0.62 + n2 * 0.38;
    float th = 0.73 - 0.11 * d;
    float rim = smoothstep(th - 0.1, th - 0.04, nec);
    if (rim > 0.0) {
      float core = smoothstep(th - 0.01, th + 0.015, nec);
#ifdef DECAY_LITE
      float raw = n2;
#else
      float raw = zN(q * 31.0).y;
#endif
      // Old wounds: dark, dried meat with a black middle, not fresh red.
      c = mix(c, mix(vec3(0.085, 0.03, 0.036), vec3(0.2, 0.065, 0.055), raw), rim * (0.5 + 0.4 * raw));
      c = mix(c, vec3(0.03, 0.016, 0.012), core);
      wet = max(wet, rim * (1.0 - core) * 0.55);
    }
#ifndef DECAY_LITE
    if (near > 0.01) {
      float v = abs(zN(q * vec3(11.0, 4.5, 11.0) + 3.3).z - 0.5);
      float vein = 1.0 - smoothstep(0.0, uZ.z > 0.5 && uZ.z < 1.5 ? 0.05 : 0.025, v);
      c = mix(c, vec3(0.1, 0.07, 0.13), vein * (uZ.z > 0.5 && uZ.z < 1.5 ? 0.85 : 0.55 * d) * near);
    }
#endif
    if (uZ.z > 1.5) {
      float bn = zN(q * 40.0 + 1.7).w;
      float boil = smoothstep(0.76, 0.79, bn);
      // Pus under tight skin, an angry ring round each.
      c = mix(c, vec3(0.5, 0.45, 0.27), boil * 0.85);
      c = mix(c, vec3(0.2, 0.05, 0.04), smoothstep(0.71, 0.75, bn) * (1.0 - boil) * 0.8);
      wet = max(wet, boil * 0.45);
    }
    return c;
  }
`;

/**
 * Fragment body, part 1 (inside main, after the fabric patterns and before the blood):
 * rotting skin and torn clothes. `vZSurf` is the surface class, `vWoundP` the bind-pose
 * position, `vPatN` the bind-pose normal, `zWet` the wetness out.
 */
export const DECAY_SURFACE = /* glsl */ `
  vec3 zq = vWoundP + uZ.x;
  vec3 zp = vWoundP;
  float zNear = 1.0 - smoothstep(16.0, 34.0, length(vViewPosition));
  bool zSkin = vZSurf > 0.5 && vZSurf < 1.5;
  bool zHard = vZSurf > 1.5;
  float zFront = smoothstep(0.15, 0.55, normalize(vPatN).z);
  if (zSkin) {
    diffuseColor.rgb = zRot(diffuseColor.rgb, zq, zNear, zWet);
  } else if (!zHard && (zp.y > 0.17 || uZBody < 0.5)) {
    // Clothes torn open (more where it has been hurt), the rotten body showing through, with
    // frayed, filthy edges. Rips run up and down the fabric more than across it; grime runs
    // down it in streaks.
    vec4 t1 = zN(zq * vec3(11.0, 4.0, 11.0) + 11.0);
#ifdef DECAY_LITE
    float tn = t1.x;
#else
    float tn = t1.x * 0.6 + zN(zq * 23.0).y * 0.4;
#endif
    float th = 0.735 - 0.08 * uZ.y - vWound * 0.14;
    float hole = smoothstep(th, th + 0.012, tn);
    float fray = smoothstep(th - 0.045, th, tn) * (1.0 - hole);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.3 + vec3(0.05, 0.012, 0.0), fray * 0.9);
    diffuseColor.rgb *= 1.0 - smoothstep(0.6, 0.8, t1.w) * 0.35;
    // What shows through is in the cloth's shade.
    if (hole > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, zRot(uZSkin * 0.6, zq, zNear, zWet), hole);
  }
`;

/** Fragment body, part 2 (after the per-bone blood): the feeding mouth and the local wounds. */
export const DECAY_BLOOD = /* glsl */ `
  if (uZ.w > 0.5 && uZBody > 0.5) {
    // Feeding: blood from the mouth down the chin and the front of the chest.
    float yy = 1.668 - zp.y;  // the mouth (bind pose: the head bone at 1.61, the mouth HEAD_K * 0.06 above it)
    float len = 0.14 + 0.32 * fract(uZ.x * 0.173);
    if (!zHard && yy > -0.012 && yy < len && zFront > 0.0) {
      vec4 mn = zN(vec3(zp.y * 7.0, uZ.x, 1.0));
      float sx = abs(zp.x - (mn.x - 0.5) * 0.05);
      float w = mix(0.05, 0.013, sqrt(clamp(yy / len, 0.0, 1.0))) + (mn.y - 0.5) * 0.025;
      float m = 1.0 - smoothstep(w * 0.6, w, sx);
      // Below the chin it runs in separate streaks.
      float streak = smoothstep(0.45, 0.6, zN(vec3(zp.x * 70.0, uZ.x * 3.0, 2.0)).z);
      m *= mix(1.0, streak, smoothstep(0.05, 0.1, yy));
      m *= zFront * (1.0 - smoothstep(len * 0.6, len, yy));
      // Mostly dried, days old.
      vec3 bl = zSkin ? vec3(0.085, 0.01, 0.008) : vec3(0.05, 0.008, 0.006);
      diffuseColor.rgb = mix(diffuseColor.rgb, bl, m * 0.9);
      zWet = max(zWet, m * (zSkin ? 0.45 : 0.25));
    }

    // Local wounds: hole, raw ring, and blood soaking out from them. A cheap pass first: most
    // of the body is nowhere near one.
    float reach = 0.0;
    for (int i = 0; i < ${MAX_HITS}; i++) {
      vec4 h = uHits[i];
      vec3 dv = zp - h.xyz;
      dv.y *= dv.y < 0.0 ? 0.42 : 1.4;
      reach = max(reach, step(0.0001, h.w) * step(length(dv), max(h.w, 0.06) + 0.02));
    }
    if (reach > 0.0) {
      vec4 wn = zN(zp * 34.0);
      float en = (wn.x - 0.5) * 0.026;
      float soak = 0.0, core = 0.0, meat = 0.0;
      for (int i = 0; i < ${MAX_HITS}; i++) {
        vec4 h = uHits[i];
        if (h.w <= 0.0) continue;
        vec3 dv = zp - h.xyz;
        // Blood runs down far more than up.
        dv.y *= dv.y < 0.0 ? 0.42 : 1.4;
        float e = length(dv) + en;
        float cr = 0.011 + 0.011 * uHitK[i];
        core = max(core, 1.0 - smoothstep(cr * 0.55, cr, e));
        meat = max(meat, 1.0 - smoothstep(cr * 1.2, cr * 2.3, e));
        soak = max(soak, (1.0 - smoothstep(h.w * 0.7, h.w, e)) * (0.75 + 0.25 * smoothstep(h.w, cr, e)));
      }
      // Cloth drinks it up dark and wide; skin is smeared and runs.
      vec3 soaked = zSkin ? vec3(0.24, 0.015, 0.012) : vec3(0.12, 0.012, 0.008);
      diffuseColor.rgb = mix(diffuseColor.rgb, soaked * (0.8 + 0.4 * wn.y), soak * (zSkin ? 0.7 : 0.95));
#ifdef DECAY_LITE
      float tex = wn.z;
#else
      float tex = zN(zp * 70.0).z;
#endif
      diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.3, 0.02, 0.02), vec3(0.55, 0.09, 0.07), tex), meat * (0.7 + 0.3 * tex));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.0, 0.0), core);
      zWet = max(zWet, max(meat, soak * (zSkin ? 0.8 : 0.55)));
    }
  }
`;
