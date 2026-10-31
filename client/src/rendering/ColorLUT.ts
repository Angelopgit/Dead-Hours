import * as THREE from 'three';

/** LUT edge length; 32³ is plenty for a smooth grade and costs 128 KB. */
export const LUT_SIZE = 32;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * The night grade, in display space: muted color, teal-blue shadows against warm sodium highlights,
 * a gentle filmic S-curve with lifted blacks, and highlights that roll off toward white instead of
 * clipping to saturated orange. Baked into a 3D LUT so the shader pays one lookup for all of it, and
 * so the grade can be retuned (or swapped per area) without touching the shader.
 */
export function nightGrade(r: number, g: number, b: number, out: number[]): void {
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Saturation, a little lower in the shadows where film loses color first.
  const sat = 0.8 + 0.08 * smooth(0.05, 0.5, l);
  r = l + (r - l) * sat;
  g = l + (g - l) * sat;
  b = l + (b - l) * sat;
  // Split tone.
  const k = smooth(0.04, 0.62, l);
  r *= 0.9 + (1.07 - 0.9) * k;
  g *= 1.0 + (1.0 - 1.0) * k;
  b *= 1.12 + (0.88 - 1.12) * k;
  // S-curve around mid grey, lifted toe.
  const curve = (x: number) => {
    x = Math.min(1, Math.max(0, x));
    const s = x * x * (3 - 2 * x);
    return 0.014 + (x + (s - x) * 0.32) * (1 - 0.014);
  };
  r = curve(r);
  g = curve(g);
  b = curve(b);
  // Highlight roll-off toward white.
  const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const w = smooth(0.72, 1.0, l2) * 0.35;
  out[0] = r + (l2 - r) * w;
  out[1] = g + (l2 - g) * w;
  out[2] = b + (l2 - b) * w;
}

export function createNightLUT(): THREE.Data3DTexture {
  const N = LUT_SIZE;
  const data = new Uint8Array(N * N * N * 4);
  const o = [0, 0, 0];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    nightGrade(x / (N - 1), y / (N - 1), z / (N - 1), o);
    const i = ((z * N + y) * N + x) * 4;
    data[i] = Math.round(Math.min(1, Math.max(0, o[0])) * 255);
    data[i + 1] = Math.round(Math.min(1, Math.max(0, o[1])) * 255);
    data[i + 2] = Math.round(Math.min(1, Math.max(0, o[2])) * 255);
    data[i + 3] = 255;
  }
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
