import type { HitZone } from '../config/weapons';
import type { Vec3 } from './math';

/** Distance along a ray (unit dir) to a sphere, or -1. */
export function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  if (t >= 0) return t;
  return cc <= 0 ? 0 : -1;
}

/** Distance along a ray (unit dir) to a capsule a→b of radius r, or -1. */
export function rayCapsule(o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: number): number {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const oax = o.x - a.x, oay = o.y - a.y, oaz = o.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;
  if (h >= 0 && A > 1e-9) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t >= 0) return t;
  }
  // Caps.
  let best = -1;
  for (const c of [a, b]) {
    const t = raySphere(o, d, c, r);
    if (t >= 0 && (best < 0 || t < best)) best = t;
  }
  return best;
}

export interface ZoneShape {
  zone: HitZone;
  a: Vec3;
  b: Vec3;
  r: number;
}

/** Posture the hit zones are built for. */
export type HitPosture = 'standing' | 'down';

/**
 * World-space hit zones for a zombie standing at `pos` facing `facing`. Matches the hunched
 * reaching pose the client animates: head forward of the hips, arms out in front. Local +X is
 * the zombie's left (it faces +Z), so 'armL' sits at +X.
 */
export function zombieZones(pos: Vec3, facing: number, scale: number, posture: HitPosture, out: ZoneShape[], girth = 1): ZoneShape[] {
  const fx = Math.sin(facing), fz = Math.cos(facing);
  const rx = Math.cos(facing), rz = -Math.sin(facing);
  // Girth widens the body sideways and front to back (brutes), not the height.
  const w = scale * girth;
  const P = (lx: number, ly: number, lz: number): Vec3 => ({
    x: pos.x + (rx * lx + fx * lz) * w,
    y: pos.y + ly * scale,
    z: pos.z + (rz * lx + fz * lz) * w,
  });
  out.length = 0;
  if (posture === 'down') {
    // Lying on its back, head away from the feet.
    out.push({ zone: 'torso', a: P(0, 0.22, -0.25), b: P(0, 0.24, -0.8), r: 0.24 * w });
    out.push({ zone: 'head', a: P(0, 0.24, -0.98), b: P(0, 0.24, -0.98), r: 0.15 * scale });
    out.push({ zone: 'legL', a: P(0.15, 0.15, 0.6), b: P(0.1, 0.18, -0.16), r: 0.1 * w });
    out.push({ zone: 'legR', a: P(-0.15, 0.15, 0.6), b: P(-0.1, 0.18, -0.16), r: 0.1 * w });
    return out;
  }
  out.push({ zone: 'head', a: P(0, 1.62, 0.3), b: P(0, 1.62, 0.3), r: 0.15 * scale });
  out.push({ zone: 'torso', a: P(0, 0.97, 0.02), b: P(0, 1.4, 0.2), r: 0.21 * w });
  out.push({ zone: 'armL', a: P(0.21, 1.43, 0.2), b: P(0.12, 1.14, 0.71), r: 0.08 * w });
  out.push({ zone: 'armR', a: P(-0.21, 1.43, 0.2), b: P(-0.12, 1.14, 0.71), r: 0.08 * w });
  out.push({ zone: 'legL', a: P(0.1, 0.88, 0), b: P(0.1, 0.06, 0), r: 0.095 * w });
  out.push({ zone: 'legR', a: P(-0.1, 0.88, 0), b: P(-0.1, 0.06, 0), r: 0.095 * w });
  return out;
}

/** Nearest zone a ray enters, or null. */
export function rayZones(o: Vec3, d: Vec3, zones: ZoneShape[], maxDist: number): { zone: HitZone; t: number } | null {
  let best: { zone: HitZone; t: number } | null = null;
  for (const z of zones) {
    const t = z.a === z.b || (z.a.x === z.b.x && z.a.y === z.b.y && z.a.z === z.b.z) ? raySphere(o, d, z.a, z.r) : rayCapsule(o, d, z.a, z.b, z.r);
    if (t < 0 || t > maxDist) continue;
    // Prefer the head when two zones are entered at nearly the same depth.
    if (!best || t < best.t - (z.zone === 'head' ? 0.04 : 0)) best = { zone: z.zone, t };
  }
  return best;
}
