import type { HitZone, WeaponId } from './weapons';
import {
  APPEARANCE_ITEMS, CLOTH_COLORS, randomAppearance, sanitizeAppearance, type Appearance, type AppearanceSlot,
} from './appearance';

/**
 * The van raid: once a night, after `at` seconds survived, a white van drives in from the far
 * end of the map to the middle of the neighbourhood and a crew of armed survivors gets out to
 * hunt the players. Tuning lives here; the event itself is shared/src/sim/Raid.ts.
 */
export const RAID = {
  /** Seconds of fighting before the van comes, once (the threat clock: it stands still during a lull, see LULLS). */
  at: 420,
  raiders: 5,
  /** What each raider carries, by weight (every crew has at least two kinds). */
  weapons: [['ar', 0.4], ['shotgun', 0.3], ['pistol', 0.3]] as [WeaponId, number][],
  health: 110,
  /** Damage multipliers on a raider (a head shot from any rifle drops one). */
  zones: { head: 4, torso: 1, armL: 0.6, armR: 0.6, legL: 0.7, legR: 0.7 } as Record<HitZone, number>,
  /** Their rounds hit a survivor for this share of the gun's damage. */
  damageScale: 0.26,
  /**
   * Odds a round is on target (else it is a near miss that cracks past), less against a survivor
   * on the move or crouched; and the small aiming error either way (degrees).
   */
  hitChance: 0.26,
  movingPenalty: 0.06,
  crouchFactor: 0.75,
  aimError: 0.5,
  /** The first round after spotting someone waits this long (seconds, low..high). */
  reaction: [0.55, 0.95] as [number, number],
  /** Rounds per burst from an automatic, and the pause between bursts (s). */
  burst: [2, 4] as [number, number],
  burstPause: [0.9, 1.8] as [number, number],
  /** Pause between single shots (pistol, shotgun), on top of the gun's own cycle. */
  shotPause: [0.45, 1.1] as [number, number],
  /** A shotgunner takes longer over each shot. */
  pumpPause: 0.6,
  /** How close each weapon wants to be before it stops to shoot (m), and how far it opens fire. */
  engage: { ar: [12, 42], shotgun: [6, 15], pistol: [8, 26] } as Record<string, [number, number]>,
  sight: 70,
  walkSpeed: 3.1,
  runSpeed: 4.6,
  radius: 0.32,
  height: 1.78,
  eyeHeight: 1.62,
  /** How long it takes to get out of the van, each (s), and how far they spread out. */
  deployEvery: 0.6,
  spread: [4, 9] as [number, number],
  /** Kicking in a door: one kick every (s), and its strength against the door's strain. */
  kickEvery: 1.1,
  kick: 0.34,
  /** Stopping to shoot through a window costs them this long before they move on (s). */
  holdTime: 6,
  /** Gunfire carries (zombies hear it). */
  noise: 60,
  van: {
    length: 5.4,
    width: 2.05,
    height: 2.3,
    cruise: 11,
    /** Fastest it takes a corner: lateral m/s². */
    lateral: 2.6,
    accel: 3,
    brake: 3.2,
    /** Zombies in its way are run down. */
    ramDamage: 600,
    /** Where the crew gets out (local: +x right, +z forward), and the cargo once it is cleared. */
    door: { x: 1.4, z: 0.4 },
    cargo: { x: 0, z: -3.2 },
  },
  /** Universal ammo and bandages left in the van for whoever cleared it. */
  cargoUses: 2,
  cargoBandages: 3,
} as const;

/** A road the van can come in by: a smooth line through these points, ending where it parks. */
export interface RaidRoute {
  name: string;
  points: { x: number; z: number }[];
}

/**
 * Both ends of Birch Lane (the south one past the Oak Street junction), weaving past the roadblocks
 * and the abandoned cars, then east along Elm Street to park in front of the safehouse. The route
 * check (check:raid) sweeps the van's box along each one against the map's collision.
 */
export const RAID_ROUTES: RaidRoute[] = [
  {
    name: 'Birch Lane south',
    points: [
      { x: -71.2, z: 200 }, { x: -71.2, z: 172 }, { x: -71.2, z: 150 }, { x: -71.2, z: 122 }, { x: -71.2, z: 108 },
      { x: -71.0, z: 80 }, { x: -70.2, z: 52 },
      { x: -65.6, z: 40 }, { x: -65.4, z: 24 }, { x: -65.6, z: 10 }, { x: -63.8, z: 2.4 }, { x: -58, z: -1.6 },
      { x: -48, z: -2.4 }, { x: -30, z: -2.4 }, { x: -18, z: -2.3 },
    ],
  },
  {
    name: 'Birch Lane north',
    points: [
      { x: -63.2, z: -150 }, { x: -63.2, z: -128 }, { x: -62.8, z: -120 }, { x: -63.6, z: -114 }, { x: -64.6, z: -110 }, { x: -66.5, z: -104 },
      { x: -70.6, z: -92 }, { x: -70.7, z: -60 }, { x: -70.6, z: -30 }, { x: -70.4, z: -14 }, { x: -68.6, z: -5.6 },
      { x: -62, z: -2.6 }, { x: -48, z: -2.4 }, { x: -30, z: -2.4 }, { x: -18, z: -2.3 },
    ],
  },
];

/** A sampled route: positions every `step` metres with the heading and the fastest safe speed there. */
export interface RouteSamples {
  step: number;
  x: Float32Array;
  z: Float32Array;
  yaw: Float32Array;
  speed: Float32Array;
  length: number;
}

/** Catmull-Rom through the route's points, sampled evenly, with a speed for every sample. */
export function sampleRoute(route: RaidRoute, step = 0.25): RouteSamples {
  const P = route.points;
  const dense: { x: number; z: number }[] = [];
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    const n = Math.max(4, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / 0.1));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push({ x: f(p0.x, p1.x, p2.x, p3.x), z: f(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  dense.push({ ...P[P.length - 1] });
  // Even spacing along the curve.
  const xs: number[] = [dense[0].x], zs: number[] = [dense[0].z];
  let carry = 0;
  for (let i = 1; i < dense.length; i++) {
    let ax = dense[i - 1].x, az = dense[i - 1].z;
    const bx = dense[i].x, bz = dense[i].z;
    let seg = Math.hypot(bx - ax, bz - az);
    while (carry + seg >= step) {
      const k = (step - carry) / seg;
      ax += (bx - ax) * k;
      az += (bz - az) * k;
      xs.push(ax);
      zs.push(az);
      seg = Math.hypot(bx - ax, bz - az);
      carry = 0;
    }
    carry += seg;
  }
  const n = xs.length;
  const out: RouteSamples = {
    step, x: Float32Array.from(xs), z: Float32Array.from(zs), yaw: new Float32Array(n), speed: new Float32Array(n), length: (n - 1) * step,
  };
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    out.yaw[i] = Math.atan2(xs[b] - xs[a], zs[b] - zs[a]);
  }
  // Fastest safe speed from how sharply the road turns (over a couple of metres), then braking
  // into each bend and to a stop at the end, accelerating out of them.
  const V = RAID.van;
  const span = Math.max(1, Math.round(2 / step));
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - span), b = Math.min(n - 1, i + span);
    let turn = Math.abs(Math.atan2(Math.sin(out.yaw[b] - out.yaw[a]), Math.cos(out.yaw[b] - out.yaw[a])));
    turn = Math.max(turn, 1e-4);
    const radius = ((b - a) * step) / turn;
    out.speed[i] = Math.min(V.cruise, Math.sqrt(V.lateral * radius));
  }
  out.speed[n - 1] = 0;
  for (let i = n - 2; i >= 0; i--) out.speed[i] = Math.min(out.speed[i], Math.sqrt(out.speed[i + 1] ** 2 + 2 * V.brake * step));
  for (let i = 1; i < n; i++) out.speed[i] = Math.min(out.speed[i], Math.sqrt(out.speed[i - 1] ** 2 + 2 * V.accel * step) + (i < 4 ? V.cruise : 0));
  return out;
}

/** Where along a sampled route (metres travelled): position, heading and speed limit. */
export function routeAt(r: RouteSamples, s: number): { x: number; z: number; yaw: number; speed: number } {
  const f = Math.max(0, Math.min(r.x.length - 1, s / r.step));
  const i = Math.min(r.x.length - 2, Math.floor(f)), k = f - i;
  const dy = Math.atan2(Math.sin(r.yaw[i + 1] - r.yaw[i]), Math.cos(r.yaw[i + 1] - r.yaw[i]));
  return {
    x: r.x[i] + (r.x[i + 1] - r.x[i]) * k,
    z: r.z[i] + (r.z[i + 1] - r.z[i]) * k,
    yaw: r.yaw[i] + dy * k,
    speed: r.speed[i] + (r.speed[i + 1] - r.speed[i]) * k,
  };
}

const pickFrom = (slot: AppearanceSlot, ids: string[], rand: () => number): string => {
  const known = (APPEARANCE_ITEMS[slot] as readonly { id: string }[]).map((i) => i.id);
  const ok = ids.filter((id) => known.includes(id));
  return ok.length ? ok[Math.floor(rand() * ok.length) % ok.length] : 'none';
};

/**
 * A raider's look from their seed: anyone at all under the gear, but masked, in dark work and
 * combat clothes, so they read as hostile at a glance.
 */
export function raiderAppearance(rand: () => number): Appearance {
  const a = randomAppearance(rand);
  const DARK = [0, 1, 3, 7, 8, 11].filter((i) => i < CLOTH_COLORS.length);
  const dark = () => DARK[Math.floor(rand() * DARK.length) % DARK.length];
  return sanitizeAppearance({
    ...a,
    headwear: rand() < 0.65 ? pickFrom('headwear', ['beanie', 'army', 'capback', 'bandana', 'cap'], rand) : 'none',
    headwearColor: dark(),
    face: pickFrom('face', ['bandanamask', 'gasmask', 'hockey', 'bandanamask', 'goggles'], rand),
    faceColor: dark(),
    top: pickFrom('top', ['leather', 'camo', 'hoodie', 'puffer', 'ziphoodie', 'flannel'], rand),
    topColor: dark(),
    pants: pickFrom('pants', ['cargo', 'camo', 'work', 'jeans'], rand),
    pantsColor: dark(),
    shoes: pickFrom('shoes', ['combat', 'work'], rand),
    gloves: pickFrom('gloves', ['fingerless', 'leather', 'work'], rand),
    glovesColor: dark(),
  } as Appearance);
}
