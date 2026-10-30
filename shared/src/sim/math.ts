/** Plain vector type for simulation code (no Three.js on the server). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export function dist2D(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

export function angleDiff(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Small fast seeded PRNG (mulberry32). Returns a function producing [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Plain rotation quaternion. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Rotation taking +Y onto the unit vector `v`. */
export function quatFromUp(v: Vec3): Quat {
  const w = 1 + v.y;
  if (w < 1e-6) return { x: 1, y: 0, z: 0, w: 0 };
  const l = Math.hypot(v.z, v.x, w);
  return { x: v.z / l, y: 0, z: -v.x / l, w: w / l };
}

/** `v` rotated by `q`. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  // v + 2w(q × v) + 2 q × (q × v)
  const cx = q.y * v.z - q.z * v.y, cy = q.z * v.x - q.x * v.z, cz = q.x * v.y - q.y * v.x;
  const dx = q.y * cz - q.z * cy, dy = q.z * cx - q.x * cz, dz = q.x * cy - q.y * cx;
  return { x: v.x + 2 * (q.w * cx + dx), y: v.y + 2 * (q.w * cy + dy), z: v.z + 2 * (q.w * cz + dz) };
}
