import { GROUP, groups, type Physics, type Surface } from '@dead-hours/shared';
import type { Enclosure } from './GunSynth';

/** Where a sound happens, as far as its echo goes. */
export type Space = 'street' | Enclosure;

/** What gets through a wall of each material: level (linear) and the highest frequency left (Hz). */
const TRANSMISSION: Record<Surface, [number, number]> = {
  glass: [0.5, 5000],
  fabric: [0.8, 6000],
  flesh: [0.9, 8000],
  wood: [0.32, 1400],
  plaster: [0.25, 1000],
  metal: [0.2, 900],
  brick: [0.1, 500],
  concrete: [0.08, 450],
  asphalt: [0.06, 300],
  grass: [0.06, 300],
  dirt: [0.06, 300],
};

/** A sound's path through the walls between it and the listener. */
export interface Muffle {
  gain: number;
  cutoff: number;
  walls: number;
}

export const CLEAR: Muffle = { gain: 1, cutoff: 20000, walls: 0 };

const STATIC_ONLY = groups(0xffff, GROUP.static);
const AROUND = Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2)]);
/** Farther than this, a horizontal ray counts as open air. */
const REACH = 15;

/**
 * The map as the ear knows it, from the same collision the bullets use: what kind of space a
 * point is in (open street, a furnished room, a bare hard room such as the store or a garage,
 * a concrete basement), and what a sound loses going through the walls on its way to the
 * listener.
 */
export class Acoustics {
  private readonly spaces = new Map<string, Space>();

  constructor(private readonly physics: Physics) {}

  /** The space around a point (cached per metre: the buildings don't move). */
  spaceAt(x: number, y: number, z: number): Space {
    const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
    let s = this.spaces.get(key);
    if (!s) {
      s = this.classify(x, y, z);
      if (this.spaces.size > 20000) this.spaces.clear();
      this.spaces.set(key, s);
    }
    return s;
  }

  private classify(x: number, y: number, z: number): Space {
    const ph = this.physics;
    // Sky overhead: the street (porches and the gazebo too, they're open at the sides).
    if (ph.raycast(x, y, z, 0, 1, 0, 12, STATIC_ONLY) === null) return 'street';
    let open = 0, sum = 0;
    for (const [dx, dz] of AROUND) {
      const d = ph.raycast(x, y, z, dx, 0, dz, REACH, STATIC_ONLY);
      if (d === null) open++;
      sum += d ?? REACH;
    }
    if (open >= 4) return 'street';
    if (y < -0.5) return 'basement';
    // Bare concrete underfoot (the store, garages) rings like a hall; wooden floors are furnished rooms.
    const floor = ph.raycastHit(x, y, z, 0, -1, 0, 4, STATIC_ONLY)?.surface;
    return floor === 'concrete' || floor === 'metal' || sum / AROUND.length > 12 ? 'hall' : 'room';
  }

  /** What a sound at `from` loses through the walls (and closed doors) on its way to `to`. */
  occlusion(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): Muffle {
    const hits = this.physics.crossings(fx, fy, fz, tx, ty, tz);
    if (!hits.length) return CLEAR;
    let gain = 1, cutoff = 20000;
    for (const s of hits) {
      const [g, c] = TRANSMISSION[s];
      gain *= g;
      // Every further wall darkens it more than the last.
      cutoff = Math.min(cutoff * 0.7, c);
    }
    return { gain: Math.max(0.015, gain), cutoff: Math.max(180, cutoff), walls: hits.length };
  }
}
