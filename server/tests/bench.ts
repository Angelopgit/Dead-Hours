// npx tsx tests/bench.ts — one room's server work without the network: four survivors circling in the
// safehouse, ZOMBIES zombies (default 24) on them, SECONDS of night (default 20). Prints the CPU each
// part takes per second of play, so changes to the per-room tick can be compared.
import { packMotion } from '@dead-hours/shared';
import { Night } from '../src/game/Night';
import { initWorld } from '../src/game/world';

const ZOMBIES = Number(process.env.ZOMBIES ?? 24);
const SECONDS = Number(process.env.SECONDS ?? 20);

await initWorld();
const night = new Night(7, 0);
const spawns = [0, 1, 2, 3].map((i) => night.addSurvivor({ id: `p${i}`, name: `P${i}`, primary: 'ar', appearance: '' }, i));
for (let i = 0; i < 4; i++) night.debug(`p${i}`, { cmd: 'god', on: true });
night.debug('p0', { cmd: 'skipPreparation' });
night.advance(1 / 60);
for (let z = 0; z < ZOMBIES; z++) night.debug(`p${z % 4}`, { cmd: 'spawn', dist: 8 + (z % 6), angle: z, kind: (['walker', 'runner', 'brute'] as const)[z % 3] });

// Time spent in the physics world step and the simulation step, beside the whole advance().
const parts = { physics: 0, sim: 0, snapshot: 0 };
const wrap = <T extends object>(o: T, k: keyof T, part: keyof typeof parts) => {
  const f = (o[k] as (...a: unknown[]) => unknown).bind(o);
  (o as Record<keyof T, unknown>)[k] = (...a: unknown[]) => {
    const t0 = performance.now();
    const r = f(...a);
    parts[part] += performance.now() - t0;
    return r;
  };
};
wrap(night.physics, 'step', 'physics');
wrap(night.sim, 'step', 'sim');

let t = 0, total = 0, snaps = 0, events = 0;
const steps = SECONDS * 60;
for (let i = 0; i < steps; i++) {
  t += 1 / 60;
  if (i % 3 === 0) {
    for (let p = 0; p < 4; p++) {
      const s = spawns[p];
      const pos = { x: s.x + Math.sin(t) * 1.5, y: s.y, z: s.z + Math.cos(t) * 1.5 };
      night.motion(`p${p}`, packMotion({
        motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw: t, pitch: 0, eyeHeight: 1.6, grounded: true, crouching: false, sprinting: false } as never,
        trigger: Math.sin(t * 3) > 0.6, facing: t, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: Math.sin(t), y: 0, z: Math.cos(t) },
      }));
    }
  }
  const t0 = performance.now();
  const r = night.advance(1 / 60);
  total += performance.now() - t0;
  if (r.snapshot) snaps++;
  events += r.events.length;
}
const per = (ms: number) => `${((ms / SECONDS) / 10).toFixed(1)}%`;
console.log(`${ZOMBIES} zombies (${night.sim.zombies.length} alive at the end), ${SECONDS} s of night: ` +
  `${per(total)} of a core (physics step ${per(parts.physics)}, simulation ${per(parts.sim)}, rest ${per(total - parts.physics - parts.sim)}), ` +
  `${snaps} snapshots, ${events} events`);
night.dispose();
