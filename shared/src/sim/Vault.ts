import type { Physics } from '../physics/Physics';
import { PLAYER } from '../config/player';
import { VAULT } from '../config/barricades';
import type { Porch } from '../map/porches';
import type { Barricades, BarricadeSlot } from './Barricades';
import { clamp, type Vec3 } from './math';

/**
 * A survivor's way through a window: up onto the sill on this side, across it, and down on the
 * far side (or off the sill into a drop, from upstairs). Positions are the feet.
 */
export interface VaultPlan {
  slot: number;
  from: Vec3;
  up: Vec3;
  over: Vec3;
  /** Where the feet come down on the far side; null drops from `over` and falls the rest. */
  land: Vec3 | null;
  /** The way across (unit, level). */
  dir: { x: number; z: number };
  /** The pane is still in: it smashes on the way through. */
  smash: boolean;
  /** Seconds onto the sill, across, and down (0 for a drop). */
  times: [number, number, number];
}

/** Why a window in front of a survivor can't be vaulted. */
export type VaultBlock = 'boarded' | 'blocked';

export interface VaultChoice {
  slot: BarricadeSlot;
  /** The way through, or null when `block` says why not. */
  plan: VaultPlan | null;
  block: VaultBlock | null;
}

/** Unit vector along a window's wall. */
function along(s: BarricadeSlot): { x: number; z: number } {
  return s.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
}

/**
 * Where a survivor stands relative to a window: how far out from the middle of the wall on their
 * side (`dn`), along the wall from its centre (`la`), and the normal pointing to their side.
 */
function placeOf(b: Barricades, s: BarricadeSlot, feet: Vec3): { n: { x: number; z: number }; dn: number; la: number } {
  const side = b.side(s, feet.x, feet.z);
  const n = { x: s.normal.x * side, z: s.normal.z * side };
  const dx = feet.x - s.center.x, dz = feet.z - s.center.z;
  const a = along(s);
  return { n, dn: dx * n.x + dz * n.z, la: dx * a.x + dz * a.z };
}

/**
 * The window a survivor at `feet` would vault through, heading `facing` (unit, level: where they
 * look or move): one they fit through, in reach, in front of them, its sill not too high. Null
 * when there is none.
 */
export function findVault(physics: Physics, b: Barricades, feet: Vec3, facing: { x: number; z: number }, height: number, porches: readonly Porch[] = []): VaultChoice | null {
  let best: BarricadeSlot | null = null;
  let bestScore = Infinity;
  for (const s of b.windows) {
    if (!s.climb) continue;
    const rise = s.bottom - feet.y;
    if (rise > VAULT.maxRise || rise < VAULT.minRise) continue;
    const { n, dn, la } = placeOf(b, s, feet);
    if (dn < VAULT.near || dn > VAULT.reach || Math.abs(la) > s.width / 2 + VAULT.side) continue;
    const toward = -(facing.x * n.x + facing.z * n.z);
    if (toward < 0.5) continue;
    const score = dn + Math.max(0, Math.abs(la) - s.width / 2) * 2 - toward * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  if (!best) return null;
  const r = planVault(physics, b, best, feet, height, porches);
  return typeof r === 'string' ? { slot: best, plan: null, block: r } : { slot: best, plan: r, block: null };
}

/**
 * How a survivor at `feet`, `height` tall (crouched or not), gets through window `s`: the far
 * side must have room to land (or, upstairs, room to drop with nothing but air below the sill).
 */
export function planVault(physics: Physics, b: Barricades, s: BarricadeSlot, feet: Vec3, height: number, porches: readonly Porch[] = []): VaultPlan | VaultBlock {
  if (s.boards > 0) return 'boarded';
  const { n, la } = placeOf(b, s, feet);
  const a = along(s);
  const room = Math.max(0, s.width / 2 - 0.3);
  const lc = clamp(la, -room, room);
  const sill = s.bottom + 0.02;
  const at = (d: number, y: number): Vec3 => ({ x: s.center.x + n.x * d + a.x * lc, y, z: s.center.z + n.z * d + a.z * lc });
  const up = at(VAULT.clear, sill);
  const over = at(-VAULT.clear, sill);
  const r = PLAYER.radius - 0.03;
  const pane = s.glass ? s.pane : null;
  // Crouched on the sill, on both sides of the wall, and nothing across the opening but the pane.
  const tuck = PLAYER.crouchHeight;
  if (!physics.capsuleFree(up.x, up.y, up.z, tuck, r, pane) || !physics.capsuleFree(over.x, over.y, over.z, tuck, r, pane)) return 'blocked';
  const span = VAULT.clear * 2;
  for (const h of [0.35, 0.85]) {
    const hit = physics.raycastExcept(up.x, sill + h, up.z, -n.x, 0, -n.z, span, pane);
    if (hit !== null) return 'blocked';
  }
  const dir = { x: -n.x, z: -n.z };
  const times = (down: number): [number, number, number] => [VAULT.upTime, VAULT.overTime, down];
  const plan = (land: Vec3 | null, down: number): VaultPlan => ({
    slot: s.index, from: { ...feet }, up, over, land, dir, smash: s.glass, times: times(down),
  });
  for (const d of VAULT.land) {
    const p = at(-d, sill);
    const top = sill + 0.5;
    const hit = physics.raycast(p.x, top, p.z, 0, -1, 0, VAULT.maxDrop + 0.5);
    if (hit === null) continue;
    const floor = top - hit;
    // Something standing there reaches above the sill (a wardrobe, a fridge).
    if (floor > sill + 0.3) continue;
    const drop = sill - floor;
    if (drop <= VAULT.maxStep) {
      if (!physics.capsuleFree(p.x, floor + 0.03, p.z, height, r)) continue;
      return plan({ x: p.x, y: floor, z: p.z }, VAULT.downTime + Math.max(0, drop) * 0.06);
    }
    // A drop (out of an upstairs window): straight down from the sill, clear of the porch roofs.
    for (const pr of porches) {
      const f = pr.roof;
      if (f.top > sill) continue;
      const nx = clamp(over.x, f.x - f.w / 2, f.x + f.w / 2), nz = clamp(over.z, f.z - f.d / 2, f.z + f.d / 2);
      if (Math.hypot(over.x - nx, over.z - nz) < PLAYER.radius + 0.1) return 'blocked';
    }
    if (!physics.capsuleFree(over.x, over.y, over.z, height, r, pane)) return 'blocked';
    return plan(null, 0);
  }
  return 'blocked';
}

/** Where the feet are `t` seconds into a vault, and how tucked the body is (0..1); null once it is over. */
export function vaultAt(v: VaultPlan, t: number, out: Vec3): number | null {
  const [a, b, c] = v.times;
  if (t < a) {
    const k = t / a;
    const e = 1 - (1 - k) * (1 - k);
    out.x = v.from.x + (v.up.x - v.from.x) * k;
    out.z = v.from.z + (v.up.z - v.from.z) * k;
    out.y = v.from.y + (v.up.y - v.from.y) * e;
    return k;
  }
  if (t < a + b) {
    const k = (t - a) / b;
    out.x = v.up.x + (v.over.x - v.up.x) * k;
    out.z = v.up.z + (v.over.z - v.up.z) * k;
    out.y = v.up.y + Math.sin(k * Math.PI) * 0.06;
    return 1;
  }
  if (v.land && t < a + b + c) {
    const k = (t - a - b) / c;
    out.x = v.over.x + (v.land.x - v.over.x) * k;
    out.z = v.over.z + (v.land.z - v.over.z) * k;
    out.y = v.over.y + (v.land.y - v.over.y) * k * k;
    return 1 - k;
  }
  return null;
}
