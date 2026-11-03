// npm run bench:physics -w server — what the collision world costs on its own and inside a night, so a
// Rapier upgrade (or a change to how the world is built) can be compared on the same numbers.
//   build:   a room's world (map colliders, door leaves) from scratch
//   world:   Physics.step (solo, every 1/60 s) and Physics.advance(3/60) (server, every snapshot) on the map alone
//   queries: the ray, sphere and capsule casts bullets, sight lines, the camera and vaulting use
//   nights:  ZOMBIES zombies (default 24) on four survivors for SECONDS (default 20), the server's way
//            (Night.advance, zombies at 20 Hz) and the solo way (Simulation.step + Physics.step at 60 Hz)
import { packMotion } from '@dead-hours/shared';
import type { Physics } from '@dead-hours/shared';
import { Night } from '../src/game/Night';
import { createWorld, initWorld } from '../src/game/world';

const ZOMBIES = Number(process.env.ZOMBIES ?? 24);
const SECONDS = Number(process.env.SECONDS ?? 20);

await initWorld();
const ms = (v: number) => `${v.toFixed(3)} ms`;
const time = (n: number, f: (i: number) => void) => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) f(i);
  return (performance.now() - t0) / n;
};

// Build.
for (let i = 0; i < 2; i++) createWorld().physics.dispose();
const builds: number[] = [];
let world!: ReturnType<typeof createWorld>;
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  world = createWorld();
  builds.push(performance.now() - t0);
  if (i < 4) world.physics.dispose();
}
const physics = world.physics;
let colliders = 0;
physics.world.colliders.forEach(() => colliders++);
console.log(`build: ${ms(Math.min(...builds))} (best of 5), ${colliders} colliders`);

// World on its own.
time(60, () => physics.step());
const step = time(600, () => physics.step());
time(60, () => physics.advance(3 / 60));
const advance = time(600, () => physics.advance(3 / 60));
console.log(`world: step ${ms(step)}, advance ${ms(advance)}`);

// Queries, from street and room height in a fixed spread of directions.
let s = 7;
const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
const b = physics.map.bounds;
const pts = Array.from({ length: 4096 }, () => {
  const yaw = rand() * Math.PI * 2, pitch = (rand() - 0.6) * 0.8;
  return {
    x: b.x0 + rand() * (b.x1 - b.x0), y: 0.4 + rand() * 4, z: b.z0 + rand() * (b.z1 - b.z0),
    dx: Math.sin(yaw) * Math.cos(pitch), dy: Math.sin(pitch), dz: Math.cos(yaw) * Math.cos(pitch),
  };
});
const at = (i: number) => pts[i & 4095];
const q = (p: Physics) => ({
  ray: time(20000, (i) => { const r = at(i); p.raycast(r.x, r.y, r.z, r.dx, r.dy, r.dz, 80); }),
  rayHit: time(20000, (i) => { const r = at(i); p.raycastHit(r.x, r.y, r.z, r.dx, r.dy, r.dz, 80); }),
  crossings: time(5000, (i) => { const r = at(i); p.crossings(r.x, r.y, r.z, r.x + r.dx * 40, r.y + r.dy * 40, r.z + r.dz * 40); }),
  sphere: time(5000, (i) => { const r = at(i); p.sphereCast(r.x, r.y, r.z, r.dx, r.dy, r.dz, 0.2, 4); }),
  capsule: time(5000, (i) => { const r = at(i); p.capsuleFree(r.x, 0.02, r.z, 1.8, 0.32); }),
});
q(physics);
const qr = q(physics);
console.log(`queries: ray ${ms(qr.ray)}, ray+normal ${ms(qr.rayHit)}, crossings ${ms(qr.crossings)}, sphere cast ${ms(qr.sphere)}, capsule free ${ms(qr.capsule)}`);
physics.dispose();

// Nights.
function night(solo: boolean) {
  const n = new Night(7, 0);
  const spawns = [0, 1, 2, 3].map((i) => n.addSurvivor({ id: `p${i}`, name: `P${i}`, primary: 'ar', appearance: '' }, i));
  for (let i = 0; i < 4; i++) n.debug(`p${i}`, { cmd: 'god', on: true });
  n.debug('p0', { cmd: 'skipPreparation' });
  n.advance(1 / 60);
  for (let z = 0; z < ZOMBIES; z++) n.debug(`p${z % 4}`, { cmd: 'spawn', dist: 8 + (z % 6), angle: z, kind: (['walker', 'runner', 'brute'] as const)[z % 3] });
  let t = 0, total = 0, phys = 0;
  // The server's world catch-up runs inside Night.advance.
  const advance = n.physics.advance.bind(n.physics);
  n.physics.advance = (dt: number) => {
    const t1 = performance.now();
    advance(dt);
    phys += performance.now() - t1;
  };
  const steps = SECONDS * 60;
  for (let i = 0; i < steps; i++) {
    t += 1 / 60;
    if (i % 3 === 0) {
      for (let p = 0; p < 4; p++) {
        const sp = spawns[p];
        const pos = { x: sp.x + Math.sin(t) * 1.5, y: sp.y, z: sp.z + Math.cos(t) * 1.5 };
        n.motion(`p${p}`, packMotion({
          motion: { pos, vel: { x: 0, y: 0, z: 0 }, yaw: t, pitch: 0, eyeHeight: 1.6, grounded: true, crouching: false, sprinting: false } as never,
          trigger: Math.sin(t * 3) > 0.6, facing: t, aimOrigin: { x: pos.x, y: pos.y + 1.6, z: pos.z }, aimDir: { x: Math.sin(t), y: 0, z: Math.cos(t) },
        }));
      }
    }
    const t0 = performance.now();
    if (solo) {
      n.sim.step(1 / 60);
      n.sim.drain();
      const t1 = performance.now();
      n.physics.step();
      phys += performance.now() - t1;
    } else {
      n.advance(1 / 60);
    }
    total += performance.now() - t0;
  }
  const alive = n.sim.zombies.length;
  n.dispose();
  return { perTick: total / steps, phys: phys / steps, core: total / SECONDS / 10, alive };
}
const server = night(false);
console.log(`server night: ${ms(server.perTick)} per tick (world catch-up ${ms(server.phys)}), ${server.core.toFixed(1)}% of a core (${ZOMBIES} zombies, ${server.alive} alive at the end)`);
const solo = night(true);
console.log(`solo night: ${ms(solo.perTick)} per tick (physics step ${ms(solo.phys)}), ${solo.core.toFixed(1)}% of a core (${solo.alive} alive at the end)`);
