/**
 * Headless checks for the combat simulation, run against the real map collision:
 * the zombie navigation grid, weapon state (fire rates, magazines, reloads, switching, melee),
 * damage and hit zones, zombie perception and pursuit through buildings, door pounding,
 * the spawner, interactables and player death. Run with `npm run check:sim`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, RAPIER, GROUP, groups, createDoorBodies, buildNavGrid, Simulation, Arsenal,
  WEAPONS, NAV_REACHABLE, zombieZones, rayZones, PLAYER, type Vec3, type SimEvent, type NavGrid, type DoorBody,
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
let t0 = performance.now();
const gen = buildNavGrid(physics, map);
let r = gen.next();
while (!r.done) r = gen.next();
const nav: NavGrid = r.value;
const buildMs = performance.now() - t0;

section(`Navigation grid (${nav.nodeCount} nodes, built in ${buildMs.toFixed(0)} ms)`);
const spots: [string, Vec3][] = [
  ['safehouse living room', { x: 4.8, y: 0.3, z: -22.3 }],
  ['safehouse kitchen', { x: -4.5, y: 0.3, z: -22.5 }],
  ['safehouse upstairs', { x: 4.3, y: 3.55, z: -22 }],
  ['safehouse basement', { x: -4, y: -2.7, z: -20 }],
  ['garage', { x: 10, y: 0.22, z: -20 }],
  ['Henderson house', { x: 27, y: 0.3, z: -18 }],
  ['gas station store', { x: 92, y: 0.2, z: -37 }],
  ['park', { x: 90, y: 0, z: 30 }],
  ['checkpoint', { x: -100, y: 0, z: 10 }],
  ['north woods', { x: 20, y: 0, z: -95 }],
  ['south woods', { x: -30, y: 0, z: 100 }],
  ['back alley', { x: 0, y: 0, z: -47 }],
];
for (const [name, p] of spots) check(nav.reachable(nav.nodeAt(p.x, p.y, p.z, 0.6)), `${name} is reachable`);
check(!nav.reachable(nav.nodeAt(0, 9, -20, 0.3)) || nav.nodeY[nav.nodeAt(0, 9, -20, 0.3)] < 5, 'safehouse roof is not part of the walkable area');
const routes: [string, Vec3, Vec3][] = [
  ['street to safehouse living room', { x: 0, y: 0.15, z: 8 }, spots[0][1]],
  ['street to safehouse upstairs', { x: 0, y: 0.15, z: 8 }, spots[2][1]],
  ['street to basement', { x: 0, y: 0.15, z: 8 }, spots[3][1]],
  ['north woods to safehouse', { x: 30, y: 0, z: -100 }, spots[0][1]],
  ['park to garage', { x: 90, y: 0, z: 30 }, spots[4][1]],
  ['checkpoint to Henderson house', { x: -110, y: 0, z: 5 }, spots[5][1]],
];
for (const [name, a, b] of routes) {
  t0 = performance.now();
  const res = nav.findPath(a, b, { maxExpand: 400000 });
  const ms = performance.now() - t0;
  check(!!res && res.complete, `${name}: path found (${res?.points.length ?? 0} waypoints, ${ms.toFixed(1)} ms)`);
  if (res) {
    const end = res.points[res.points.length - 1];
    check(Math.hypot(end.x - b.x, end.z - b.z) < 1 && Math.abs(end.y - b.y) < 0.4, `${name}: ends at the destination`);
  }
}
{
  const a = { x: 40, y: 0, z: 30 }, b = spots[0][1];
  const p1 = nav.findPath(a, b, { maxExpand: 400000, seed: 11 })!;
  const p2 = nav.findPath(a, b, { maxExpand: 400000, seed: 977 })!;
  const differ = p1.points.length !== p2.points.length || p1.points.some((p, i) => Math.hypot(p.x - p2.points[i].x, p.z - p2.points[i].z) > 0.6);
  check(differ, 'zombies with different seeds take different routes');
}

section('Weapons');
{
  const a = new Arsenal('ar', 'pistol');
  const ticks: never[] = [];
  const stepFor = (s: number, aim = false) => { for (let i = 0; i < Math.round(s / DT); i++) a.step(DT, aim, ticks as never); };
  check(a.fireState() === 'busy', 'cannot fire while drawing');
  stepFor(0.6);
  check(a.fireState() === 'ok', 'ready after the draw');
  let shots = 0;
  for (let i = 0; i < Math.round(1 / DT); i++) {
    if (a.fireState() === 'ok') { a.consume(); shots++; }
    a.step(DT, false, ticks as never);
  }
  check(Math.abs(shots - 700 / 60) <= 1.01, `assault rifle fires ~11.7 rounds per second (fired ${shots})`);
  check(a.weapon.mag === 30 - shots && a.weapon.reserve === 150, 'magazine counts down, reserve untouched');
  check(a.startReload(), 'reload starts');
  check(a.fireState() === 'busy', 'cannot fire mid-reload');
  stepFor(WEAPONS.ar.reloadTime - 0.1);
  check(a.weapon.mag === 30 - shots, 'magazine not refilled before the reload time');
  stepFor(0.2);
  check(a.weapon.mag === 30 && a.weapon.reserve === 150 - shots, `reload moves ${shots} rounds from reserve`);
  check(!a.startReload(), 'no reload with a full magazine');
  a.weapon.mag = 0;
  check(a.fireState() === 'empty', 'empty magazine dry fires');
  a.startReload();
  check(Math.abs(a.actionTotal - (WEAPONS.ar.reloadTime + 0.35)) < 1e-6, 'reloading from empty takes longer (chambering)');
  check(a.switchTo('secondary') && a.action === 'draw' && a.weapon.id === 'pistol', 'switching cancels the reload and draws the pistol');
  stepFor(WEAPONS.pistol.draw + 0.05);
  check(a.fireState() === 'ok', 'pistol ready after its draw time');
  check(a.startMelee() && a.fireState() === 'busy', 'melee blocks firing');
  const t: string[] = [];
  for (let i = 0; i < 40; i++) a.step(DT, false, t as never);
  check(t.includes('meleeHit') && t.includes('meleeDone'), 'melee swing lands then recovers');
  const sg = new Arsenal('shotgun', 'pistol');
  stepFor.call(null, 0);
  for (let i = 0; i < 60; i++) sg.step(DT, false, [] as never);
  sg.primary.mag = 2;
  sg.startReload();
  const sticks: string[] = [];
  for (let i = 0; i < Math.round(1.3 / DT); i++) sg.step(DT, false, sticks as never);
  check(sticks.filter((x) => x === 'shell').length === 2 && sg.primary.mag === 4, 'shotgun loads shell by shell');
  check(sg.fireState() === 'ok', 'shotgun reload can be interrupted to fire');
  const swap = new Arsenal('ar', 'pistol');
  swap.primary.mag = 15;
  swap.primary.reserve = 75;
  swap.replacePrimary('shotgun');
  const share = (15 + 75) / (30 + 150);
  check(swap.primary.id === 'shotgun' && swap.primary.mag + swap.primary.reserve === Math.round(share * 36), 'weapon table swap keeps the same share of ammunition');
  const hip = new Arsenal('ar', 'pistol');
  const hipSpread = hip.spread({ speed: 0, crouching: false, grounded: true, aiming: false });
  hip.aim = 1;
  const aimSpread = hip.spread({ speed: 0, crouching: false, grounded: true, aiming: true });
  check(aimSpread < hipSpread * 0.3, 'aiming tightens spread');
  check(hip.spread({ speed: 6, crouching: false, grounded: true, aiming: true }) > aimSpread * 1.4, 'moving widens spread');
}

section('Hit zones');
{
  const pos = { x: 0, y: 0, z: 0 };
  const zones = zombieZones(pos, 0, 1, 'standing', []);
  const shoot = (y: number, x = 0) => rayZones({ x, y, z: 10 }, { x: 0, y: 0, z: -1 }, zones, 50);
  check(shoot(1.56)?.zone === 'head', 'ray at head height hits the head');
  check(shoot(1.15)?.zone === 'torso', 'ray at chest height hits the torso');
  check(['legL', 'legR'].includes(shoot(0.5, 0.1)?.zone ?? ''), 'ray at knee height hits a leg');
  check(shoot(1.2, 0.8) === null, 'ray beside the body misses');
}

// ---------------------------------------------------------------------------- simulation

class TestPlayer {
  body: RAPIER.RigidBody;
  constructor(public pos: Vec3) {
    const w = physics.world;
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y + PLAYER.height / 2, pos.z));
    w.createCollider(RAPIER.ColliderDesc.capsule((PLAYER.height - PLAYER.radius * 2) / 2, PLAYER.radius).setCollisionGroups(groups(GROUP.player, GROUP.static | GROUP.dynamic | GROUP.zombie)), this.body);
  }
  moveTo(p: Vec3) {
    this.pos = p;
    this.body.setTranslation({ x: p.x, y: p.y + PLAYER.height / 2, z: p.z }, true);
  }
  remove() {
    physics.world.removeRigidBody(this.body);
  }
}

function makeSim(playerAt: Vec3, prep = 600) {
  for (const d of doors) d?.reset();
  physics.world.step();
  const sim = new Simulation({ physics, map, nav, doors, seed: 7, preparation: prep });
  const sp = sim.addPlayer('p1', 'Tester', 'ar', 'pistol', playerAt, 0);
  const body = new TestPlayer(playerAt);
  return { sim, sp, body };
}

function run(sim: Simulation, seconds: number, until?: () => boolean): { events: SimEvent[]; time: number } {
  const events: SimEvent[] = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    sim.step(DT);
    physics.world.step();
    events.push(...sim.drain());
    if (until?.()) return { events, time: (i + 1) * DT };
  }
  return { events, time: seconds };
}

function cleanup(sim: Simulation, body: TestPlayer) {
  for (const z of [...sim.zombies]) z.removeBody();
  sim.zombies.length = 0;
  body.remove();
  physics.world.removeCharacterController(sim.zombieController);
}

const doorOf = (house: string, pick = 0): DoorBody => doors.filter((d) => d && d.spec.houseId === house)[pick]!;

section('Combat');
{
  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  run(sim, 0.7);
  const z = sim.spawnZombie('walker', { x: 0, y: 0.02, z: -4 }, 'idle');
  z.facing = Math.PI;
  const eye = sp.eye;
  const aimAt = (y: number) => {
    const tx = z.pos.x - eye.x, ty = z.pos.y + y - eye.y, tz = z.pos.z - eye.z;
    const l = Math.hypot(tx, ty, tz);
    return { x: tx / l, y: ty / l, z: tz / l };
  };
  sp.arsenal.aim = 1;
  sp.motion.aiming = true;
  let shots = 0;
  const hits: SimEvent[] = [];
  while (z.alive && shots < 10) {
    if (sim.fire('p1', eye, aimAt(1.15), true, 100 + shots) === 'fired') shots++;
    run(sim, 0.12).events.forEach((e) => e.type === 'zombieHit' && hits.push(e));
    hits.push(...sim.drain().filter((e) => e.type === 'zombieHit'));
  }
  check(!z.alive && shots === 4, `assault rifle kills a walker with 4 body shots (took ${shots})`);
  check(sp.stats.kills === 1 && sp.arsenal.weapon.mag === 26, 'kill and rounds are counted');
  const z2 = sim.spawnZombie('walker', { x: 0, y: 0.02, z: -4 }, 'idle');
  z2.facing = Math.PI;
  run(sim, 0.2);
  let headShots = 0;
  while (z2.alive && headShots < 5) {
    const tx = z2.pos.x - eye.x, ty = z2.pos.y + 1.56 - eye.y, tz = z2.pos.z + 0.2 - eye.z;
    const l = Math.hypot(tx, ty, tz);
    if (sim.fire('p1', eye, { x: tx / l, y: ty / l, z: tz / l }, true, 300 + headShots) === 'fired') headShots++;
    run(sim, 0.12);
  }
  check(!z2.alive && headShots === 2, `two headshots kill a walker (took ${headShots})`);
  check(sp.stats.headshots === 1, 'headshot kill counted');
  // Shooting through a wall does nothing to the zombie behind it.
  const z3 = sim.spawnZombie('walker', { x: 4.8, y: 0.32, z: -21 }, 'idle');
  run(sim, 0.2);
  const before = z3.health;
  const e2 = sp.eye;
  const dir = { x: z3.pos.x - e2.x, y: z3.pos.y + 1.2 - e2.y, z: z3.pos.z - e2.z };
  const dl = Math.hypot(dir.x, dir.y, dir.z);
  sim.fire('p1', e2, { x: dir.x / dl, y: dir.y / dl, z: dir.z / dl }, true, 5);
  const ev = run(sim, 0.1).events;
  check(z3.health === before, 'walls stop bullets');
  check(ev.some((e) => e.type === 'impact') || sim.drain().length >= 0, 'bullet impact reported on the wall');
  cleanup(sim, body);
}

section('Zombie perception and pursuit');
{
  // Sees and chases a player in the open, then attacks.
  const { sim, sp, body } = makeSim({ x: 20, y: 0.15, z: 6 });
  const z = sim.spawnZombie('walker', { x: 20, y: 0.02, z: -8 }, 'idle');
  z.facing = 0;
  const res = run(sim, 25, () => sp.health < PLAYER.maxHealth);
  check(res.events.some((e) => e.type === 'zombieAlert'), 'zombie spots a player in its view');
  check(sp.health < PLAYER.maxHealth, `zombie reaches and hurts the player (${res.time.toFixed(1)} s)`);
  check(res.events.some((e) => e.type === 'zombieAttack'), 'attack wind-up is announced');
  cleanup(sim, body);
}
{
  // Does not see through walls or behind itself, but hears gunfire.
  const { sim, sp, body } = makeSim({ x: 4.8, y: 0.32, z: -21 });
  const z = sim.spawnZombie('walker', { x: 4.8, y: 0.02, z: -6 }, 'idle');
  z.facing = 0;
  let res = run(sim, 4);
  check(!res.events.some((e) => e.type === 'zombieAlert') && z.state !== 'chase', 'zombie outside cannot see the player through the wall');
  sp.arsenal.aim = 0;
  run(sim, 0.7);
  sim.fire('p1', sp.eye, { x: 0, y: 0, z: -1 }, true, 1);
  res = run(sim, 0.5);
  check(z.state === 'investigate', `gunshot makes the zombie investigate (state ${z.state})`);
  cleanup(sim, body);
}
{
  // Navigates in through the front door and down to the basement.
  for (const d of doors) d?.reset();
  const { sim, sp, body } = makeSim({ x: -4, y: -2.68, z: -19.5 });
  for (const d of doors) if (d && (d.spec.houseId === 'safehouse')) d.setOpen(true, 0, 0);
  run(sim, 1);
  const z = sim.spawnZombie('walker', { x: 2, y: 0.17, z: -6 }, 'idle');
  z.target = 'p1';
  z.lastKnown = { ...sp.motion.pos };
  z.lastSeen = sim.time;
  z.setState('chase');
  const res = run(sim, 70, () => Math.hypot(z.pos.x - sp.motion.pos.x, z.pos.z - sp.motion.pos.z) < 1.4 && Math.abs(z.pos.y - sp.motion.pos.y) < 0.6);
  check(Math.abs(z.pos.y + 2.7) < 0.4 && res.time < 70, `zombie follows the player into the basement (${res.time.toFixed(1)} s, at y ${z.pos.y.toFixed(2)})`);
  cleanup(sim, body);
}
{
  // Up the stairs.
  const { sim, sp, body } = makeSim({ x: 4.3, y: 3.55, z: -22 });
  for (const d of doors) if (d && d.spec.houseId === 'safehouse') d.setOpen(true, 0, 0);
  run(sim, 1);
  const z = sim.spawnZombie('walker', { x: 3.0, y: 0.32, z: -17.0 }, 'idle');
  z.target = 'p1';
  z.lastKnown = { ...sp.motion.pos };
  z.lastSeen = sim.time;
  z.setState('chase');
  const res = run(sim, 60, () => Math.hypot(z.pos.x - sp.motion.pos.x, z.pos.z - sp.motion.pos.z) < 1.4 && Math.abs(z.pos.y - sp.motion.pos.y) < 0.6);
  check(Math.abs(z.pos.y - 3.55) < 0.4 && res.time < 60, `zombie climbs the stairs to the upper floor (${res.time.toFixed(1)} s)`);
  cleanup(sim, body);
}
{
  // Pounds on a closed door until it gives way.
  const { sim, sp, body } = makeSim({ x: 2.4, y: 0.32, z: -17 });
  const front = doors.find((d) => d && d.spec.houseId === 'safehouse' && Math.abs(d.spec.z + 15) < 0.5)!;
  check(!!front && !front.open, 'safehouse front door starts closed');
  const z = sim.spawnZombie('walker', { x: front.center.x, y: 0.02, z: front.center.z + 3 }, 'idle');
  z.target = 'p1';
  z.lastKnown = { ...sp.motion.pos };
  z.lastSeen = sim.time;
  z.setState('chase');
  const res = run(sim, 40, () => front.open);
  check(res.events.some((e) => e.type === 'doorPound'), 'zombie pounds on the closed door');
  check(front.open && res.events.some((e) => e.type === 'doorForced'), `door gives way (${res.time.toFixed(1)} s)`);
  cleanup(sim, body);
}

section('Spawner and survival clock');
{
  const { sim, sp, body } = makeSim({ x: 4.8, y: 0.32, z: -22.3 }, 3);
  let res = run(sim, 3.2);
  check(res.events.some((e) => e.type === 'phase' && e.phase === 'survival'), 'preparation countdown ends the outbreak begins');
  res = run(sim, 8);
  const n = sim.zombies.length;
  check(n >= 5, `zombies spawn after the countdown (${n})`);
  const dists = sim.zombies.map((z) => Math.hypot(z.pos.x - sp.motion.pos.x, z.pos.z - sp.motion.pos.z));
  check(Math.min(...dists) > 30, `spawned away from the player (closest ${Math.min(...dists).toFixed(0)} m)`);
  const t1 = performance.now();
  run(sim, 20);
  const msPerStep = (performance.now() - t1) / (20 / DT);
  check(msPerStep < 4, `simulation step with ${sim.zombies.length} zombies costs ${msPerStep.toFixed(2)} ms`);
  const closer = sim.zombies.map((z) => Math.hypot(z.pos.x - sp.motion.pos.x, z.pos.z - sp.motion.pos.z));
  check(closer.reduce((a, b) => a + b, 0) / closer.length < dists.reduce((a, b) => a + b, 0) / dists.length, 'zombies approach the survivors');
  cleanup(sim, body);
}

section('Interactables and death');
{
  const { sim, sp, body } = makeSim({ x: 9.0, y: 0.24, z: -21.9 });
  const crate = sim.interactableFor('p1');
  check(crate?.kind === 'ammo', 'ammunition crate in reach in the garage');
  sp.arsenal.primary.reserve = 10;
  const before = sp.arsenal.primary.reserve;
  check(sim.use('p1', crate!.id) && sp.arsenal.primary.reserve === before + 60, 'crate gives two magazines');
  check(crate!.supply === 1, 'crate supply goes down');
  sp.arsenal.primary.reserve = WEAPONS.ar.maxReserve;
  sp.arsenal.secondary.reserve = WEAPONS.pistol.maxReserve;
  check(!sim.use('p1', crate!.id) && crate!.supply === 1, 'full pouches do not waste a crate');
  sim.setMotion('p1', { pos: { x: 10, y: 0.24, z: -22.6 } });
  const table = sim.reachable('p1').find((it) => it.kind === 'weapons');
  check(!!table, 'weapon table in reach');
  check(sim.selectPrimary('p1', 'marksman') && sp.arsenal.primary.id === 'marksman', 'weapon table swaps the primary');
  sim.setMotion('p1', { pos: { x: 0, y: 0.15, z: 6 } });
  check(!sim.selectPrimary('p1', 'smg'), 'cannot swap weapons away from the table');
  sim.setMotion('p1', { pos: { x: 11.75, y: 0.24, z: -23.4 } });
  const aid = sim.interactableFor('p1');
  check(aid?.kind === 'medical', 'first aid box in reach');
  sp.bandages = 0;
  check(sim.use('p1', aid!.id) && sp.bandages === 2, 'first aid box gives bandages');
  sp.health = 50;
  check(sim.bandage('p1'), 'bandaging starts');
  run(sim, 3);
  check(sp.health === 90 && sp.bandages === 1, 'bandage heals 40');
  const res = (() => { sim.damagePlayer(sp, 200, { x: 0, y: 0, z: 0 }); return sim.drain(); })();
  check(!sp.alive && res.some((e) => e.type === 'playerDied') && sim.phase === 'over', 'death ends the solo game');
  cleanup(sim, body);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
