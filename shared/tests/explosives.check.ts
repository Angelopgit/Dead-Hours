/**
 * Headless checks for grenades and Molotovs on the real map collision: carrying and throwing,
 * the flight (bounces, resting, the fuse), blast damage with falloff and cover, directional
 * dismemberment, survivors hurt by their own grenades, Molotov fires (spill, catching, burning
 * to death, spreading, hurting survivors, burning out), resupply, and the wire format.
 * Run with `npm run check:explosives`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, Mirror, captureSnapshot,
  THROWABLES, THROWING, BLAST, FIRE, flightStep, throwLaunch, fireStrength,
  type Vec3, type SimEvent, type NavGrid, type Zombie,
} from '../src/index';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) {
    passes++;
    console.log('  ok   ' + msg);
  } else {
    failures++;
    console.log('  FAIL ' + msg);
  }
};
const section = (s: string) => console.log(`\n${s}`);
const DT = 1 / 60;

await initPhysics();
const physics = new Physics(map);
const doors = createDoorBodies(map, physics);
const gen = buildNavGrid(physics, map);
let r = gen.next();
while (!r.done) r = gen.next();
const nav: NavGrid = r.value;

/** Open street in front of the safehouse. */
const STREET: Vec3 = { x: 0, y: 0, z: 8 };
const ground = (x: number, z: number, from = 3) => {
  const d = physics.raycast(x, from, z, 0, -1, 0, 10);
  return d === null ? 0 : from - d;
};
STREET.y = ground(STREET.x, STREET.z);

function fresh(seed = 7) {
  const sim = new Simulation({ physics, map, nav, doors, seed, preparation: 0.05 });
  sim.addPlayer('p1', 'One', 'ar', 'pistol', { ...STREET }, 0);
  for (let i = 0; i < 10; i++) sim.step(DT);
  sim.drain();
  return sim;
}
const run = (sim: Simulation, seconds: number, events: SimEvent[] = []) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(DT);
    physics.world.step();
    for (const e of sim.drain()) events.push(e);
  }
  return events;
};
/** A zombie standing still (idle, nobody in sight to chase) at an offset from the street spot. */
const place = (sim: Simulation, dx: number, dz: number, kind: 'walker' | 'brute' | 'runner' = 'walker'): Zombie => {
  const z = sim.spawnZombie(kind, { x: STREET.x + dx, y: ground(STREET.x + dx, STREET.z + dz) + 0.02, z: STREET.z + dz }, 'idle');
  return z;
};
const cleanup = (sim: Simulation) => sim.dispose();

section('Carrying and throwing');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  const a = p.arsenal;
  check(a.throwables.frag === THROWABLES.frag.start && a.throwables.molotov === THROWABLES.molotov.start, `starts with ${THROWABLES.frag.start} frags and ${THROWABLES.molotov.start} Molotov`);
  run(sim, 1);
  const aim = { origin: p.eye, dir: { x: 0, y: 0.1, z: 1 } };
  check(sim.throwItem('p1', 'frag', aim), 'a frag can be thrown');
  check(a.throwables.frag === THROWABLES.frag.start - 1, 'one fewer carried');
  check(a.action === 'throw', 'the hands are busy throwing');
  check(sim.fire('p1', p.eye, aim.dir, true, 1) === 'busy', 'no firing mid-throw');
  check(!sim.throwItem('p1', 'molotov', aim), 'no second throw mid-throw');
  const ev = run(sim, THROWING.release + 0.05);
  const thrown = ev.find((e) => e.type === 'thrown');
  check(!!thrown, `it leaves the hand ${THROWING.release}s in`);
  if (thrown?.type === 'thrown') check(thrown.vel.z > 10 && thrown.vel.y > 1, `thrown forward and lobbed up (${thrown.vel.z.toFixed(1)} m/s forward, ${thrown.vel.y.toFixed(1)} up)`);
  run(sim, THROWING.duration);
  check(a.action === 'draw' || a.action === 'idle', 'the gun comes back up after');
  a.throwables.molotov = 0;
  run(sim, 1);
  check(!sim.throwItem('p1', 'molotov', aim), 'none left: nothing thrown');
  cleanup(sim);
}

section('Flight');
{
  // Lobbed down the street: comes down, bounces, rolls to a stop on the ground.
  const f = { pos: { x: STREET.x, y: STREET.y + 1.6, z: STREET.z }, vel: { x: 0, y: 4, z: 12 }, rest: false };
  let bounces = 0;
  let t = 0;
  for (; t < 8 && !f.rest; t += DT) if (flightStep(physics, f, THROWABLES.frag, DT)) bounces++;
  const g = ground(f.pos.x, f.pos.z, f.pos.y + 1);
  check(f.rest, `comes to rest (${t.toFixed(2)}s, ${bounces} bounces)`);
  check(bounces >= 1, 'bounces on landing');
  check(Math.abs(f.pos.y - THROWABLES.frag.radius - g) < 0.06, `lies on the ground (${(f.pos.y - g).toFixed(3)} m above it)`);
  // Thrown at the safehouse wall from close by: it does not pass through.
  const sim = fresh();
  const wallZ = (() => {
    const d = physics.raycast(STREET.x, STREET.y + 1.2, STREET.z, 0, 0, -1, 40);
    return d === null ? null : STREET.z - d;
  })();
  check(wallZ !== null, 'there is a wall north of the street spot');
  if (wallZ !== null) {
    const w = { pos: { x: STREET.x, y: STREET.y + 1.4, z: wallZ + 3 }, vel: { x: 0, y: 1, z: -18 }, rest: false };
    let min = Infinity;
    for (let i = 0; i < 240; i++) {
      flightStep(physics, w, THROWABLES.frag, DT);
      min = Math.min(min, w.pos.z);
    }
    check(min > wallZ - 0.01, `bounces off a wall instead of passing through (closest ${(min - wallZ).toFixed(3)} m)`);
    // Throwing with the face against the wall: it starts on this side.
    const eye = { x: STREET.x, y: STREET.y + 1.6, z: wallZ + 0.2 };
    const l = throwLaunch(physics, eye, { x: 0, y: 0, z: -1 }, 0, 'frag', { x: 0, y: 0, z: 0 });
    check(l.pos.z > wallZ, `a throw pressed against a wall starts on this side of it (${(l.pos.z - wallZ).toFixed(3)} m)`);
  }
  cleanup(sim);
}

section('Frag grenade');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  p.motion.pos = { x: STREET.x, y: STREET.y, z: STREET.z - 14 };
  const close = [place(sim, 1.2, 0), place(sim, -0.9, 0.8), place(sim, 0, -1.5)];
  const mid = place(sim, 6.5, 0);
  const far = place(sim, 12, 0);
  const ev: SimEvent[] = [];
  sim.explosives.explode({ x: STREET.x, y: STREET.y + 0.05, z: STREET.z }, p, 1);
  for (const e of sim.drain()) ev.push(e);
  check(ev.some((e) => e.type === 'explosion'), 'explosion event');
  check(close.every((z) => !z.alive), 'zombies within a couple of metres die');
  check(mid.alive && mid.health < mid.def.health, `one 6.5 m away is hurt but lives (${mid.health.toFixed(0)} hp left)`);
  check(far.alive && far.health === far.def.health, 'one 12 m away is untouched');
  check(['down', 'stagger'].includes(mid.state), `the survivor of it is knocked about (${mid.state})`);
  const died = ev.filter((e) => e.type === 'zombieDied');
  check(died.length === 3 && died.every((e) => e.type === 'zombieDied' && e.cause === 'blast'), 'deaths are marked as blast kills');
  check(p.stats.kills === 3, 'kills count to the thrower');
  check(sim.noises.some((n) => n.radius >= BLAST.noise), 'the whole neighbourhood hears it');
  cleanup(sim);
}

section('Cover');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  p.motion.pos = { x: STREET.x + 20, y: STREET.y, z: STREET.z };
  // A zombie inside the safehouse, the blast outside its front wall.
  const wallD = physics.raycast(STREET.x, STREET.y + 1.2, STREET.z, 0, 0, -1, 40)!;
  const wallZ = STREET.z - wallD;
  const inside = sim.spawnZombie('walker', { x: STREET.x, y: ground(STREET.x, wallZ - 1.6, 2.5) + 0.02, z: wallZ - 1.6 }, 'idle');
  sim.explosives.explode({ x: STREET.x, y: STREET.y + 0.05, z: wallZ + 1.4 }, p, 1);
  sim.drain();
  check(inside.alive && inside.health === inside.def.health, `a wall between them shields it completely (${(wallZ - 1.6 - (wallZ + 1.4)).toFixed(1)} m apart)`);
  cleanup(sim);
}

section('Dismemberment');
{
  // Many trials at different distances and sides: what comes off depends on how close.
  const tally = (dist: number, trials: number) => {
    let arms = 0, legs = 0, heads = 0, deaths = 0, sideOk = 0, sideN = 0, upOk = 0, upN = 0;
    for (let i = 0; i < trials; i++) {
      const sim = fresh(100 + i);
      const p = sim.players.get('p1')!;
      p.motion.pos = { x: STREET.x, y: STREET.y, z: STREET.z - 30 };
      const ang = (i / trials) * Math.PI * 2;
      const z = place(sim, Math.cos(ang) * dist, Math.sin(ang) * dist);
      z.facing = sim.random() * Math.PI * 2;
      const o = { x: STREET.x, y: STREET.y + 0.05, z: STREET.z };
      sim.explosives.explode(o, p, 1);
      for (const e of sim.drain()) {
        if (e.type === 'limbSevered') {
          arms++;
          // Thrown away from the blast.
          sideN++;
          if ((e.dir.x * (z.pos.x - o.x) + e.dir.z * (z.pos.z - o.z)) > 0) sideOk++;
        }
        if (e.type === 'zombieDied') {
          deaths++;
          for (const g of e.gibs ?? []) {
            if (g.part === 'head') heads++;
            else legs++;
            upN++;
            if (g.dir.y > 0 && g.dir.x * (z.pos.x - o.x) + g.dir.z * (z.pos.z - o.z) > -0.05) upOk++;
          }
        }
      }
      cleanup(sim);
    }
    return { arms, legs, heads, deaths, sideOk, sideN, upOk, upN };
  };
  const near = tally(0.7, 16);
  const mid = tally(3.2, 16);
  const edge = tally(6.8, 16);
  console.log(`    0.7 m: ${near.deaths} dead, ${near.arms} arms, ${near.legs} legs, ${near.heads} heads`);
  console.log(`    3.2 m: ${mid.deaths} dead, ${mid.arms} arms, ${mid.legs} legs, ${mid.heads} heads`);
  console.log(`    6.8 m: ${edge.deaths} dead, ${edge.arms} arms, ${edge.legs} legs, ${edge.heads} heads`);
  check(near.deaths === 16, 'point blank kills every time');
  check(near.arms >= 16 && near.legs >= 12 && near.heads >= 6, 'point blank tears off arms, legs and heads');
  check(mid.arms > 0 && mid.arms < near.arms, 'a few metres off: fewer parts come off');
  check(mid.legs + mid.heads < near.legs + near.heads, 'heads and legs need a closer blast than arms');
  check(edge.legs + edge.heads === 0, 'at the edge of the blast nothing but maybe an arm comes off');
  check(near.sideOk === near.sideN && near.sideN > 0, 'severed arms fly away from the blast');
  check(near.upOk === near.upN && near.upN > 0, 'heads and legs fly up and away from the blast');
}

section('Survivors and grenades');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  const q = sim.addPlayer('p2', 'Two', 'ar', 'pistol', { x: STREET.x + 3, y: STREET.y, z: STREET.z }, 0);
  sim.explosives.explode({ x: STREET.x + 1.5, y: STREET.y + 0.05, z: STREET.z }, p, 1);
  sim.drain();
  check(!p.alive || p.health < 30, `the thrower standing on it is killed or nearly (${p.health.toFixed(0)} hp)`);
  check(q.alive && q.health < 100 && q.health > 100 - BLAST.playerDamage * BLAST.teamShare - 1, `a teammate as close takes a share (${q.health.toFixed(0)} hp)`);
  cleanup(sim);
}

section('A thrown frag, end to end');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  const targets = [place(sim, -0.6, 11), place(sim, 0.7, 11.6)];
  for (const z of targets) z.facing = Math.PI;
  run(sim, 0.8);
  sim.throwItem('p1', 'frag', { origin: p.eye, dir: { x: 0, y: -0.05, z: 1 } });
  const ev = run(sim, THROWING.release + THROWING.fuse + 0.2);
  const thrown = ev.find((e) => e.type === 'thrown');
  const boom = ev.find((e) => e.type === 'explosion');
  check(!!boom, 'goes off after the fuse');
  if (thrown?.type === 'thrown' && boom?.type === 'explosion') {
    const d = Math.hypot(boom.pos.x - p.motion.pos.x, boom.pos.z - p.motion.pos.z);
    check(d > 7 && d < 20, `lands ${d.toFixed(1)} m away down the street`);
    check(ev.some((e) => e.type === 'bounce'), 'bounce events for the clients');
  }
  check(sim.explosives.thrown.length === 0, 'gone once it went off');
  check(p.alive, 'the thrower is out of the blast');
  cleanup(sim);
}

section('Molotov');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  const inFire = [place(sim, 0.4, 9), place(sim, -0.6, 9.6)];
  const brute = place(sim, 0.9, 10.2, 'brute');
  const bystander = place(sim, 9, 9);
  run(sim, 0.8);
  sim.throwItem('p1', 'molotov', { origin: p.eye, dir: { x: 0, y: -0.12, z: 1 } });
  const ev = run(sim, THROWING.release + 1.6);
  const fire = ev.find((e) => e.type === 'fire');
  check(!!fire, 'breaks and catches');
  if (fire?.type === 'fire') {
    check(fire.patches.length >= 4, `fuel spreads in ${fire.patches.length} burning patches`);
    const g = fire.ground;
    check(fire.patches.every((q) => Math.hypot(q[0] - g.x, q[2] - g.z) < FIRE.spread * 1.7 + 0.1 && Math.abs(q[1] - g.y) <= FIRE.maxDrop + 0.05), 'patches stay within the spill');
    check(fire.end - fire.start === FIRE.duration, `burns ${FIRE.duration}s`);
    check(fireStrength(fire, fire.start + 1) === 1 && fireStrength(fire, fire.end - 0.1) < 0.1, 'flares up and dies down');
  }
  const ignited = ev.filter((e) => e.type === 'ignite').length;
  check(inFire.every((z) => z.burning || !z.alive), 'zombies in the spill catch fire');
  check(ignited >= 2, `ignite events (${ignited})`);
  check(!bystander.burning, 'one well clear of it does not');
  const more = run(sim, FIRE.burnTime);
  check(inFire.every((z) => !z.alive), 'walkers burn to death');
  check(more.some((e) => e.type === 'zombieDied' && e.cause === 'fire'), 'deaths marked as burned');
  check(!more.some((e) => e.type === 'zombieHit'), 'burning makes no hit events (no blood or hit markers)');
  run(sim, FIRE.burnTime);
  check(!brute.alive, 'a brute standing in it burns down too, slower');
  check(p.stats.kills >= 3, 'burn kills count to the thrower');
  run(sim, FIRE.duration);
  check(sim.explosives.fires.length === 0, 'the fire burns out');
  cleanup(sim);
}

section('Fire and survivors');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  const at = { x: STREET.x, y: STREET.y, z: STREET.z };
  sim.explosives.release(p, 'molotov', { origin: p.eye, dir: { x: 0, y: -1, z: 0.01 } });
  run(sim, 0.6);
  check(sim.explosives.fires.length === 1, 'a Molotov dropped at the feet catches there');
  const before = p.health;
  run(sim, 1);
  check(p.health < before - FIRE.playerDps * 0.4, `standing in the flames hurts (${(before - p.health).toFixed(1)} in a second)`);
  p.motion.pos = { x: at.x + 8, y: at.y, z: at.z };
  const h = p.health;
  run(sim, 1);
  check(p.health === h, 'stepping out of it stops the burning');
  cleanup(sim);
}

section('Fire spreading between zombies');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  p.motion.pos = { x: STREET.x, y: STREET.y, z: STREET.z - 30 };
  const a = place(sim, 20, 0);
  const pack = [place(sim, 20.45, 0.1), place(sim, 19.6, 0.3), place(sim, 20.2, -0.5), place(sim, 19.7, -0.4), place(sim, 20.1, 0.55), place(sim, 20.6, -0.3)];
  a.ignite(sim.time + FIRE.burnTime, p);
  run(sim, 3);
  const caught = pack.filter((z) => z.burning || !z.alive).length;
  check(caught > 0, `a burning zombie sets those pressed against it alight (${caught} of ${pack.length})`);
  cleanup(sim);
}

section('Resupply');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  const a = p.arsenal;
  a.throwables.frag = 0;
  a.throwables.molotov = 0;
  const crate = sim.interactables.find((i) => i.kind === 'ammo')!;
  p.motion.pos = { x: crate.pos.x, y: crate.pos.y - 1, z: crate.pos.z + 0.6 };
  check(sim.use('p1', crate.id), 'an ammunition crate can be used');
  check(a.throwables.frag === 1 && a.throwables.molotov === 1, 'a crate gives one frag and one Molotov');
  a.throwables.frag = THROWABLES.frag.max;
  a.throwables.molotov = THROWABLES.molotov.max;
  check(a.addThrowable('frag', 1) === 0, 'never more than the carry limit');
  cleanup(sim);
}

section('Wire format');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  const z = place(sim, 4, 4);
  z.ignite(sim.time + 3, p);
  p.arsenal.throwables.frag = 3;
  p.arsenal.throwables.molotov = 0;
  sim.throwItem('p1', 'frag', { origin: p.eye, dir: { x: 0, y: 0, z: 1 } });
  const snap = JSON.parse(JSON.stringify(captureSnapshot(sim, new Map())));
  const copy = new Simulation({ physics, map, nav, doors, seed: 1 });
  const m = new Mirror(copy, 'other');
  m.apply(snap, 10);
  const cp = copy.players.get('p1')!;
  check(cp.arsenal.throwables.frag === 2 && cp.arsenal.throwables.molotov === 0, 'carried throwables reach the clients');
  check(cp.arsenal.action === 'throw', 'a throw in progress reaches the clients');
  check(copy.zombie(z.id)?.burning === true, 'a burning zombie shows burning on the clients');
  copy.dispose();
  cleanup(sim);
}

section('A horde and a blast (cost)');
{
  const sim = fresh();
  const p = sim.players.get('p1')!;
  p.motion.pos = { x: STREET.x, y: STREET.y, z: STREET.z - 40 };
  for (let i = 0; i < 60; i++) place(sim, (i % 10) * 0.9 - 4, Math.floor(i / 10) * 0.9 - 2);
  const t0 = performance.now();
  sim.explosives.explode({ x: STREET.x, y: STREET.y + 0.05, z: STREET.z }, p, 1);
  const ms = performance.now() - t0;
  const ev = sim.drain();
  const dead = ev.filter((e) => e.type === 'zombieDied').length;
  console.log(`    60 packed zombies: ${dead} killed in ${ms.toFixed(1)} ms`);
  check(ms < 40, 'one blast into a packed horde costs under 40 ms');
  cleanup(sim);
}
{
  // A big fire under a crowd.
  const sim = fresh();
  const p = sim.players.get('p1')!;
  p.motion.pos = { x: STREET.x, y: STREET.y, z: STREET.z - 7 };
  for (let i = 0; i < 60; i++) place(sim, (i % 10) * 0.9 - 4, Math.floor(i / 10) * 0.9 - 2);
  run(sim, 0.2);
  sim.explosives.release(p, 'molotov', { origin: p.eye, dir: { x: 0, y: -0.25, z: 1 } });
  const f0 = performance.now();
  const burnEv = run(sim, 3);
  const per = (performance.now() - f0) / (3 / DT);
  console.log(`    60 zombies, fire under them: ${per.toFixed(2)} ms per step, ${burnEv.filter((e) => e.type === 'ignite').length} caught, ${burnEv.filter((e) => e.type === 'zombieDied').length} burned to death`);
  check(burnEv.filter((e) => e.type === 'ignite').length >= 15, 'a fire under a packed crowd sets many alight');
  cleanup(sim);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
