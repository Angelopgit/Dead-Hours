import * as THREE from 'three';

let shared: THREE.DataTexture | null = null;

/**
 * A tiling 128² noise texture shared by the fire and smoke shaders: four independent channels
 * of fractal value noise (R/G broad billows, B finer detail, A cell-like wisps). Sampling it is
 * far cheaper per pixel than computing noise in the shader, which matters with screens full of
 * flames and smoke.
 */
export function noiseTexture(): THREE.DataTexture {
  if (shared) return shared;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  let seed = 1234567;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const lattice = (cells: number) => {
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    return g;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  /** Tiling value noise with `cells` lattice cells across the texture. */
  const layer = (cells: number) => {
    const g = lattice(cells);
    const out = new Float32Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * cells, fy = (y / N) * cells;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = smooth(fx - x0), ty = smooth(fy - y0);
        const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
        const a = g[y0 * cells + x0], b = g[y0 * cells + x1], c = g[y1 * cells + x0], d = g[y1 * cells + x1];
        out[y * N + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
      }
    }
    return out;
  };
  const fbm = (base: number, octaves: number, ridge = false) => {
    const sum = new Float32Array(N * N);
    let amp = 0.5, total = 0;
    for (let o = 0; o < octaves; o++) {
      const l = layer(base << o);
      for (let i = 0; i < sum.length; i++) sum[i] += (ridge ? 1 - Math.abs(l[i] * 2 - 1) : l[i]) * amp;
      total += amp;
      amp *= 0.5;
    }
    // Stretch to the full range.
    let lo = Infinity, hi = -Infinity;
    for (const v of sum) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] - lo) / (hi - lo || 1);
    void total;
    return sum;
  };
  const ch = [fbm(4, 5), fbm(4, 4), fbm(8, 4), fbm(4, 5, true)];
  for (let i = 0; i < N * N; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = Math.round(ch[c][i] * 255);
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  shared = tex;
  return tex;
}

/**
 * Blackbody-like fire colour for a temperature 0..1 (in linear HDR: the hot end is far above 1
 * so the bloom picks it up): soot red, deep orange, orange-yellow, near-white core.
 */
export const FIRE_RAMP_GLSL = /* glsl */ `
  vec3 fireRamp(float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 c = mix(vec3(0.0), vec3(0.55, 0.04, 0.005), smoothstep(0.0, 0.25, t));
    c = mix(c, vec3(2.4, 0.62, 0.06), smoothstep(0.2, 0.55, t));
    c = mix(c, vec3(4.6, 2.5, 0.55), smoothstep(0.5, 0.82, t));
    c = mix(c, vec3(7.0, 5.6, 3.4), smoothstep(0.8, 1.0, t));
    return c;
  }
`;
