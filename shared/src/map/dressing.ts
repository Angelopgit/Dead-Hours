import type { MapBuilder } from './builder';

/**
 * Street furniture and yard fencing shared by every street of the neighbourhood, so every street
 * is dressed alike.
 */

const STREETLIGHT = { color: 0xffb36b, intensity: 260, range: 24, angle: 0.95, penumbra: 0.65, decay: 1.6 } as const;

/** A point `(lx, lz)` in the frame of something at `(x, z)` turned by `rotY`. */
export function rotate(x: number, z: number, rotY: number, lx: number, lz: number): [number, number] {
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  return [x + lx * c + lz * s, z - lx * s + lz * c];
}

/** A streetlight whose arm reaches along its local +Z. Working ones are baked; the flickering one stays realtime. */
export function streetlight(b: MapBuilder, x: number, z: number, rotY: number, mode: 'on' | 'flicker' | 'dead' = 'on'): void {
  b.prop('streetlight', x, z, rotY, { flag: mode === 'flicker', variant: mode === 'dead' ? 1 : 0 });
  if (mode !== 'on') return;
  const [hx, hz] = rotate(x, z, rotY, 0, 1.65);
  const [tx, tz] = rotate(x, z, rotY, 0, 2.4);
  b.light({ kind: 'spot', x: hx, y: 5.8, z: hz, tx, ty: 0, tz, ...STREETLIGHT, fixture: 'none' });
}

/** A back fence along X from x0 to x1 with 1.4 m gates at the given X positions. */
export function fenceLine(b: MapBuilder, z: number, x0: number, x1: number, gates: number[]): void {
  const edges = [x0, ...gates.flatMap((g) => [g - 0.7, g + 0.7]), x1];
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i], c = edges[i + 1];
    if (c - a < 0.3) continue;
    b.prop('fence', (a + c) / 2, z, 0, { length: c - a, variant: i % 4 === 2 ? 1 : 0 });
  }
}

/** A lot divider along Z at x, with a 1.3 m gap centred on `gap` (or none). */
export function divider(b: MapBuilder, x: number, z0: number, z1: number, gap: number | null): void {
  if (gap === null) {
    b.prop('fence', x, (z0 + z1) / 2, Math.PI / 2, { length: Math.abs(z1 - z0) });
    return;
  }
  const lo = Math.min(z0, z1), hi = Math.max(z0, z1);
  b.prop('fence', x, (lo + gap - 0.65) / 2, Math.PI / 2, { length: gap - 0.65 - lo });
  b.prop('fence', x, (gap + 0.65 + hi) / 2, Math.PI / 2, { length: hi - gap - 0.65, variant: 1 });
}
