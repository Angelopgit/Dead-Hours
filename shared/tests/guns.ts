// npx tsx shared/tests/guns.ts — what each gun does to the dead, from the real spread cone, bloom
// and hit zones. A survivor stands still, fully aimed, trigger held, tracking perfectly, so these
// are ceilings: real players miss more. Try a retune without touching the config with overrides,
// e.g. `GUN=shotgun aimSpread=2.8 damage=18 npx tsx shared/tests/guns.ts`.
import { WEAPONS, ZONE_MULTIPLIER, COMBAT, ZOMBIES, zombieZones, rayZones, type WeaponDef, type WeaponId, type ZombieKind, type ZoneShape, type Vec3 } from '../src/index';

const GUNS: WeaponId[] = ['ar', 'smg', 'shotgun', 'marksman', 'pistol', 'akimbo', 'lmg', 'battle', 'sniper', 'wraith'];
const KINDS: ZombieKind[] = ['walker', 'runner', 'crawler', 'screamer', 'bloater', 'brute'];
const DISTS = [5, 10, 20, 35];
const TRIALS = Number(process.env.TRIALS ?? 2000);

const defs = new Map<WeaponId, WeaponDef>(GUNS.map((id) => [id, { ...WEAPONS[id] }]));
if (process.env.GUN) {
  const d = defs.get(process.env.GUN as WeaponId) as unknown as Record<string, number>;
  if (!d) throw new Error(`unknown gun ${process.env.GUN}`);
  for (const key of Object.keys(d)) if (typeof d[key] === 'number' && process.env[key] !== undefined) d[key] = Number(process.env[key]);
}

const falloff = (range: number, t: number): number => {
  if (t <= range * COMBAT.falloffStart) return 1;
  if (t <= range) return 1 - (1 - COMBAT.falloffMin) * ((t - range * COMBAT.falloffStart) / (range * (1 - COMBAT.falloffStart)));
  return COMBAT.falloffMin * 0.5;
};

let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

/** Simulation's cone(): a random direction inside a cone of half-angle `deg` around `d`. */
function cone(d: Vec3, deg: number): Vec3 {
  const a = (deg * Math.PI) / 180 * Math.sqrt(rand());
  const phi = rand() * Math.PI * 2;
  const ux = Math.abs(d.y) < 0.95 ? 0 : 1, uy = Math.abs(d.y) < 0.95 ? 1 : 0;
  let bx = uy * d.z, by = -ux * d.z, bz = ux * d.y - uy * d.x;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  const cx = d.y * bz - d.z * by, cy = d.z * bx - d.x * bz, cz = d.x * by - d.y * bx;
  const s = Math.sin(a), c = Math.cos(a);
  const x = d.x * c + (bx * Math.cos(phi) + cx * Math.sin(phi)) * s;
  const y = d.y * c + (by * Math.cos(phi) + cy * Math.sin(phi)) * s;
  const z = d.z * c + (bz * Math.cos(phi) + cz * Math.sin(phi)) * s;
  const l = Math.hypot(x, y, z) || 1;
  return { x: x / l, y: y / l, z: z / l };
}

/** Mean rounds and seconds to kill one zombie facing the shooter at `dist` m, and the share of pellets that land. */
function engage(w: WeaponDef, kind: ZombieKind, dist: number, target: 'chest' | 'head') {
  const scale = ZOMBIES[kind].height / 1.75;
  const zones: ZoneShape[] = [];
  zombieZones({ x: 0, y: 0, z: 0 }, 0, scale, 'standing', zones, ZOMBIES[kind].girth);
  const eye = { x: 0, y: 1.62, z: dist };
  const at = target === 'head' ? zones.find((s) => s.zone === 'head')!.a : { x: 0, y: 1.2 * scale, z: 0.1 };
  const L = Math.hypot(at.x - eye.x, at.y - eye.y, at.z - eye.z);
  const dir = { x: (at.x - eye.x) / L, y: (at.y - eye.y) / L, z: (at.z - eye.z) / L };
  const gap = 60 / w.fireRate;
  let rounds = 0, time = 0, hits = 0, pellets = 0;
  for (let t = 0; t < TRIALS; t++) {
    let hp = ZOMBIES[kind].health, bloom = 0, n = 0;
    while (hp > 0 && n < 400) {
      if (n > 0) bloom = Math.max(0, bloom - gap * 0.9);
      const spread = w.aimSpread + bloom * w.recoil * 3.2;
      for (let p = 0; p < w.pellets; p++) {
        const h = rayZones(eye, cone(dir, spread), zones, 400);
        pellets++;
        if (h) {
          hits++;
          hp -= w.damage * ZONE_MULTIPLIER[h.zone] * falloff(w.range, h.t);
        }
      }
      bloom = Math.min(1, bloom + w.recoil * 0.22);
      n++;
      if (hp > 0 && n % w.magazine === 0) time += w.perShell ? 0.4 + w.reloadTime / w.magazine : w.reloadTime + 0.35;
    }
    rounds += n;
    time += (n - 1) * gap;
  }
  return { rounds: rounds / TRIALS, time: time / TRIALS, hit: hits / pellets };
}

console.log('Shots to kill with no falloff, body / head');
console.log('gun       ' + KINDS.map((k) => `${k} ${ZOMBIES[k].health}`.padEnd(14)).join(''));
for (const id of GUNS) {
  const w = defs.get(id)!;
  const per = w.damage * w.pellets;
  console.log(id.padEnd(10) + KINDS.map((k) => `${Math.ceil(ZOMBIES[k].health / per - 1e-9)} / ${Math.ceil(ZOMBIES[k].health / (per * ZONE_MULTIPLIER.head) - 1e-9)}`.padEnd(14)).join(''));
}
for (const target of ['chest', 'head'] as const) {
  console.log(`\nWalker, aimed at the ${target}: rounds, seconds, pellets landing`);
  console.log('gun       ' + DISTS.map((d) => `${d} m`.padEnd(20)).join('') + 'walkers per starting load at 10 m');
  for (const id of GUNS) {
    const w = defs.get(id)!;
    const cells = DISTS.map((d) => engage(w, 'walker', d, target));
    console.log(id.padEnd(10) + cells.map((e) => `${e.rounds.toFixed(1)}r ${e.time.toFixed(2)}s ${(e.hit * 100).toFixed(0)}%`.padEnd(20)).join('') + ((w.magazine + w.startReserve) / cells[1].rounds).toFixed(0));
  }
}
