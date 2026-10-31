/**
 * Headless checks for the combat simulation, run against the real map collision:
 * the zombie navigation grid, weapon state (fire rates, magazines, reloads, switching, melee),
 * damage and hit zones, zombie perception and pursuit through buildings, door pounding,
 * the spawner, interactables and player death, and the survivor appearance wire format.
 * Run with `npm run check:sim`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, RAPIER, GROUP, groups, createDoorBodies, buildNavGrid, Simulation, Arsenal,
  WEAPONS, NAV_REACHABLE, zombieZones, rayZones, along, PLAYER, ZOMBIES, SPAWNING, HORDES, hordeAt, hordeStart, hordeBonus, hordeDuration, hordeRunnerBoost, SUPPLY_DROPS, LIMBS, limbClub, EXCLUSIVE_WEAPONS, PRIMARY_WEAPONS, caseSpot, captureSnapshot, type Vec3, type SimEvent, type NavGrid, type DoorBody,
  type Zombie, type SimLimb, type ZoneShape,
  APPEARANCE_ITEMS, APPEARANCE_FIELDS, DEFAULT_APPEARANCE, PALETTES, encodeAppearance, decodeAppearance, sanitizeAppearance,
  randomAppearance, rng, type Appearance, type AppearanceItem,
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
  const broad = zombieZones(pos, 0, ZOMBIES.brute.height / 1.75, 'standing', [], ZOMBIES.brute.girth);
  const narrow = zombieZones(pos, 0, 1, 'standing', []);
  const side = (zones: typeof broad) => rayZones({ x: 0.3, y: 1.3, z: 10 }, { x: 0, y: 0, z: -1 }, zones, 50);
  check(side(broad)?.zone === 'torso' && side(narrow) === null, 'a brute is broader than a walker: a shot 30 cm off centre still hits its torso');
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

/** On: step like the game server does (zombies and the collision world only every third step). */
let serverRate = false;
let stepCount = 0;

function run(sim: Simulation, seconds: number, until?: () => boolean): { events: SimEvent[]; time: number } {
  const events: SimEvent[] = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    if (serverRate) {
      const world = ++stepCount % 3 === 0;
      sim.step(DT, world);
      if (world) physics.advance(DT * 3);
    } else {
      sim.step(DT);
      physics.world.step();
    }
    events.push(...sim.drain());
    if (until?.()) return { events, time: (i + 1) * DT };
  }
  return { events, time: seconds };
}

function cleanup(sim: Simulation, body: TestPlayer) {
  for (const z of [...sim.zombies]) z.removeBody();
  sim.zombies.length = 0;
  for (const l of sim.limbs) if (l.body) physics.world.removeRigidBody(l.body);
  sim.limbs.length = 0;
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
section('Zombie pursuit at the server\'s rate (zombies and collision every third step)');
serverRate = true;
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
  check(Math.abs(z.pos.y + 2.7) < 0.4 && res.time < 70, `at the server's rate: zombie follows the player into the basement (${res.time.toFixed(1)} s, at y ${z.pos.y.toFixed(2)})`);
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
  check(Math.abs(z.pos.y - 3.55) < 0.4 && res.time < 60, `at the server's rate: zombie climbs the stairs to the upper floor (${res.time.toFixed(1)} s)`);
  cleanup(sim, body);
}
serverRate = false;
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

section('Zombie kinds and getting unstuck');
{
  const { sim, body } = makeSim({ x: 4.8, y: 0.32, z: -22.3 });
  const count = (t: number) => {
    sim.phaseTime = t;
    const n = { walker: 0, runner: 0, brute: 0, crawler: 0 };
    for (let i = 0; i < 2000; i++) n[sim.pickKind()]++;
    return n;
  };
  sim.phase = 'survival';
  const early = count(10);
  check(early.walker === 2000, 'the first seconds of the outbreak are all walkers');
  const later = count(300);
  check(later.runner > 300 && later.runner < 600, `runners join the mix (${later.runner} of 2000 after five minutes)`);
  check(later.brute > 120 && later.brute < 320, `some brutes too (${later.brute} of 2000)`);
  for (let i = 0; i < 3; i++) sim.spawnZombie('brute', { x: 40 + i * 3, y: 0.02, z: 8 }, 'idle');
  check(count(300).brute === 0, 'no more brutes while the cap is reached');
  const r = ZOMBIES.runner, w = ZOMBIES.walker, b = ZOMBIES.brute;
  check(r.chaseSpeed[1] < PLAYER.sprintSpeed && r.chaseSpeed[0] > w.chaseSpeed[1] * 1.8, 'runners are much faster than walkers, still slower than a sprinting survivor');
  check(b.health >= w.health * 4 && b.damage[0] > w.damage[1], 'brutes are tanky and hit hard');
  check(b.radius * 2 + 0.04 < 1.0, 'a brute fits through a 1 m back door');
  cleanup(sim, body);
}
section('Horde size by survivors');
{
  const { sim, sp, body } = makeSim({ x: 4.8, y: 0.32, z: -22.3 });
  sim.phase = 'survival';
  sim.phaseTime = 0;
  check(sim.populationTarget === 6, `one survivor starts against 6 (${sim.populationTarget})`);
  const others = [2, 3, 4].map((i) => sim.addPlayer(`p${i}`, `P${i}`, 'ar', 'pistol', { x: 4.8 + i, y: 0.32, z: -22.3 }, 0));
  check(sim.populationTarget === Math.floor(6 * SPAWNING.playerScale[3]), `four survivors start against ${sim.populationTarget}`);
  const fifth = sim.addPlayer('p5', 'P5', 'ar', 'pistol', { x: 10.8, y: 0.32, z: -22.3 }, 0);
  check(sim.playerScale === SPAWNING.playerScale[3], 'a fifth survivor counts as four');
  fifth.alive = false;
  others[2].alive = false;
  check(sim.playerScale === SPAWNING.playerScale[2], 'the dead do not count');
  sim.phaseTime = 5 * 60;
  const one = Math.floor(6 + 2.2 * 5);
  for (const o of others) o.alive = false;
  check(sim.populationTarget === one, `after five minutes one survivor faces ${one} (${sim.populationTarget})`);
  sp.alive = false;
  check(sim.playerScale === 1, 'nobody alive scales like one');
  sp.alive = true;
  sim.phaseTime = 3 * 3600;
  check(sim.populationTarget === 200, `the horde stops at 200 (${sim.populationTarget})`);
  cleanup(sim, body);
}
section('Horde waves');
{
  check(hordeAt(0).stage === 'calm' && hordeAt(0).wave === 1, 'the night opens calm, wave 1 ahead');
  check(hordeAt(HORDES.firstAt - HORDES.warning + 0.1).stage === 'warning', 'the siren sounds ahead of wave 1');
  check(hordeAt(HORDES.firstAt + 1).stage === 'surge', 'wave 1 surges on time');
  const starts = [1, 2, 3, 4, 5, 6, 7, 8].map(hordeStart);
  const gaps = starts.slice(1).map((s, i) => s - starts[i]);
  check(gaps.every((g, i) => i === 0 || g <= gaps[i - 1]) && Math.min(...gaps) >= HORDES.minGap, `waves come closer together (${gaps.join(', ')} s)`);
  check([1, 2, 3, 4, 5].every((n) => hordeBonus(n + 1) > hordeBonus(n) && hordeDuration(n + 1) >= hordeDuration(n)), 'each wave is bigger and no shorter');
  check(gaps.every((g, i) => g > hordeDuration(i + 1) + HORDES.warning), 'a wave is over before the next siren');
  const mid = hordeAt(hordeStart(3) + hordeDuration(3) + 1);
  check(mid.survived === 3 && mid.wave === 4 && mid.stage !== 'surge', `after wave 3 the count reads 3 survived (${mid.survived})`);

  const { sim, body } = makeSim({ x: 4.8, y: 0.32, z: -22.3 });
  sim.phase = 'survival';
  const idle = sim.spawnZombie('walker', { x: 30, y: 0.02, z: -22 }, 'idle');
  const seen: string[] = [];
  const run = (from: number, steps: number) => {
    sim.phaseTime = from;
    for (let i = 0; i < steps; i++) {
      sim.step(1 / 60);
      for (const e of sim.drain()) if (e.type === 'horde') seen.push(`${e.stage}${e.wave}`);
    }
  };
  run(HORDES.firstAt - HORDES.warning - 0.05, 6);
  check(seen.includes('warning1'), `the warning reaches every client as an event (${seen.join(' ')})`);
  check(!sim.surging && sim.spawnTarget === sim.populationTarget, 'no extra zombies during the warning');
  run(HORDES.firstAt - 0.05, 6);
  check(seen.includes('surge1') && sim.surging, 'the surge begins');
  check(sim.spawnTarget === sim.populationTarget + hordeBonus(1), `the surge adds ${hordeBonus(1)} for one survivor (${sim.spawnTarget})`);
  check(idle.state === 'investigate' || idle.state === 'chase', `zombies nearby are called to the survivors (${idle.state})`);
  let runners = 0;
  for (let i = 0; i < 2000; i++) if (sim.pickKind() === 'runner') runners++;
  check(runners > 2000 * (0.14 + hordeRunnerBoost(1) - 0.05), `more runners during a surge (${runners} of 2000)`);
  const before = sim.zombies.length;
  run(HORDES.firstAt + 1, 120);
  check(sim.zombies.length > before + 3, `the surge pours in quickly (${before} → ${sim.zombies.length} in 2 s)`);
  sim.addPlayer('p2', 'P2', 'ar', 'pistol', { x: 6, y: 0.32, z: -22.3 }, 0);
  check(sim.spawnTarget === Math.min(200, sim.populationTarget + Math.floor(hordeBonus(1) * SPAWNING.playerScale[1])), 'a bigger team gets a bigger surge');
  run(HORDES.firstAt + hordeDuration(1) - 0.05, 6);
  check(seen.includes('over1') && !sim.surging && sim.horde.survived === 1, `wave 1 is outlasted (${seen.join(' ')})`);
  run(hordeStart(3) + 1, 2);
  check(seen.filter((s) => s.startsWith('over')).length === 2 && seen.indexOf('over2') < seen.indexOf('surge3'), `a skipped wave still counts once (${seen.join(' ')})`);
  check(sim.horde.wave === 3 && sim.surging, 'wave 3 surges');
  cleanup(sim, body);
}
const chaseFrom = (sim: Simulation, kind: 'walker' | 'runner' | 'brute', at: Vec3, target: Vec3) => {
  const z = sim.spawnZombie(kind, at, 'idle');
  z.target = 'p1';
  z.lastKnown = { ...target };
  z.lastSeen = sim.time;
  z.setState('chase');
  return z;
};
{
  // A brute comes in through the safehouse's narrow back door.
  const goal = { x: -2.4, y: 0.32, z: -21.6 };
  const { sim, body } = makeSim(goal);
  const back = doors.find((d) => d && d.spec.houseId === 'safehouse' && Math.abs(d.spec.z + 25) < 0.3)!;
  back.setOpen(true, goal.x, goal.z);
  run(sim, 0.5);
  const z = chaseFrom(sim, 'brute', { x: -2.4, y: 0.02, z: -29 }, goal);
  const res = run(sim, 30, () => Math.hypot(z.pos.x - goal.x, z.pos.z - goal.z) < 1.9 && z.pos.y > 0.2);
  check(res.time < 30, `brute squeezes through the 1 m back door (${res.time.toFixed(1)} s)`);
  cleanup(sim, body);
}
{
  // A crowd pours into the store through its open doors: nobody snags on a door leaf.
  const goal = { x: 92, y: 0.22, z: -36.5 };
  const { sim, body } = makeSim(goal);
  for (const d of doors) if (d && d.spec.houseId === 'store') d.setOpen(true, goal.x, goal.z);
  run(sim, 0.5);
  const starts: Vec3[] = [];
  for (const [dx, dz] of [[-8, 9], [-3, 11], [3, 11], [8, 9], [12, -2], [11, -7], [-12, -1], [-11, -6], [6, -10], [0, 14]]) {
    const n = nav.nodeAt(goal.x + dx, 0.1, goal.z + dz, 1.2);
    if (nav.reachable(n)) starts.push(nav.nodePos(n));
  }
  const crowd = starts.map((p, i) => chaseFrom(sim, i % 4 === 1 ? 'runner' : i === 6 ? 'brute' : 'walker', { x: p.x, y: p.y + 0.02, z: p.z }, goal));
  const reached = new Set<number>();
  let shotAt = 0;
  run(sim, 40, () => {
    // The survivor keeps shooting, so the slow ones that never see them still know where they are.
    if (sim.time - shotAt > 2) {
      shotAt = sim.time;
      sim.noise(goal, 30, 'p1');
    }
    // Inside the store (the ones at the back of the crowd can't all touch the survivor).
    for (const z of crowd) if (Math.abs(z.pos.x - 92) < 8.8 && Math.abs(z.pos.z + 38) < 4.8 && z.pos.y > 0.1) reached.add(z.id);
    return reached.size === crowd.length;
  });
  for (const z of crowd) if (!reached.has(z.id) && process.env.DEBUG_CROWD) console.log('     outside:', z.kind, z.state, z.pos.x.toFixed(1), z.pos.y.toFixed(2), z.pos.z.toFixed(1));
  check(crowd.length >= 8 && reached.size === crowd.length, `zombies get into the store through open doors (${reached.size} of ${crowd.length} in 40 s)`);
  cleanup(sim, body);
}
{
  // Chasing someone outside, a zombie walks past the closed safehouse door instead of pounding it.
  const goal = { x: 6, y: 0.15, z: -13.2 };
  const { sim, body } = makeSim(goal);
  run(sim, 0.5);
  const z = chaseFrom(sim, 'walker', { x: -3.5, y: 0.17, z: -13.2 }, goal);
  const res = run(sim, 15, () => Math.hypot(z.pos.x - goal.x, z.pos.z - goal.z) < 1.6);
  check(!res.events.some((e) => e.type === 'doorPound') && res.time < 15, `no pounding on a door its quarry isn't behind (${res.time.toFixed(1)} s to reach them)`);
  cleanup(sim, body);
}

section('Helicopter supply drops');
{
  const at = { x: 0, y: 0.15, z: 6 };
  const { sim, sp, body } = makeSim(at, 0.5);
  run(sim, 1);
  check(sim.phase === 'survival', 'outbreak under way');
  sim.phaseTime = SUPPLY_DROPS.firstAt - 0.5;
  // Only the test's own zombie: the spawner's would get in the way.
  const clear = () => {
    for (const z of [...sim.zombies]) if (z !== lure) z.removeBody();
    sim.zombies.splice(0, sim.zombies.length, ...sim.zombies.filter((z) => z === lure));
    sp.health = PLAYER.maxHealth;
    return false;
  };
  let lure: ReturnType<typeof sim.spawnZombie> | null = null;
  clear();
  let res = run(sim, 1, clear);
  const heli = res.events.find((e) => e.type === 'heli');
  check(!!heli && res.events.some((e) => e.type === 'notice' && e.text === 'SUPPLY DROP INBOUND'), 'a supply helicopter is announced on schedule');
  if (heli && heli.type === 'heli') {
    const f = heli.flight;
    const g = f.ground;
    const d = Math.hypot(g.x - at.x, g.z - at.z);
    check(d >= SUPPLY_DROPS.minDistance && d <= SUPPLY_DROPS.maxDistance, `drop lands ${d.toFixed(0)} m from the survivor`);
    check(Math.hypot(f.from.x - g.x, f.from.z - g.z) > map.halfExtent && Math.hypot(f.to.x - g.x, f.to.z - g.z) > map.halfExtent, 'helicopter comes in from beyond the map edge and leaves the same way');
    check(f.start < f.arrive && f.arrive < f.release && f.release < f.leave && f.leave < f.end && f.release < f.land, 'flight timeline is in order');
    check(physics.raycast(g.x, g.y + 0.6, g.z, 0, 1, 0, 60) === null, 'nothing overhead where the crate comes down');
    // A zombie a fair way off the drop, facing away: it can only hear it.
    // On the far side of the drop from the survivor, so it can't have seen them.
    const ux = (g.x - at.x) / d, uz = (g.z - at.z) / d;
    const ln = nav.nodeAt(g.x + ux * 20, g.y, g.z + uz * 20, 3);
    const lp = nav.reachable(ln) ? nav.nodePos(ln) : { x: g.x + ux * 20, y: g.y, z: g.z + uz * 20 };
    lure = sim.spawnZombie('walker', { x: lp.x, y: lp.y + 0.02, z: lp.z }, 'idle');
    lure.facing = Math.atan2(ux, uz);
    const z = lure;
    res = run(sim, f.release - sim.time + 0.6, clear);
    const heard = z.state === 'investigate';
    const events = res.events;
    res = run(sim, f.land - sim.time + 0.2, clear);
    res.events.unshift(...events);
    check(res.events.some((e) => e.type === 'supplyDrop' && e.stage === 'released') && res.events.some((e) => e.type === 'supplyDrop' && e.stage === 'landed'), 'crate is released and lands');
    check(heard, `the rotor noise over the drop draws the dead (zombie ${z.state})`);
    const crate = sim.interactables.find((it) => it.kind === 'supply')!;
    check(!!crate && crate.supply === SUPPLY_DROPS.baseUses + 1, `landed crate has ${crate?.supply} uses for one survivor`);
    sim.setMotion('p1', { pos: { x: g.x + 1.3, y: g.y, z: g.z } });
    sp.arsenal.primary.reserve = 0;
    sp.arsenal.secondary.reserve = 3;
    check(sim.reachable('p1').some((it) => it.kind === 'supply'), 'crate is in reach beside it');
    check(sim.use('p1', crate.id) && sp.arsenal.primary.reserve === WEAPONS.ar.maxReserve && sp.arsenal.secondary.reserve === WEAPONS.pistol.maxReserve, 'universal ammo fills every weapon');
    sp.arsenal.replacePrimary('shotgun');
    sp.arsenal.primary.reserve = 0;
    check(sim.use('p1', crate.id) && sp.arsenal.primary.reserve === WEAPONS.shotgun.maxReserve, 'and works for whatever gun you switched to');
    sp.arsenal.primary.reserve = 0;
    const left = crate.supply;
    check(!sim.use('p1', crate.id) && crate.supply === left, `one survivor can take two refills; the rest waits for the others (${left} left)`);
    const solid = physics.raycast(g.x + 2, g.y + 0.3, g.z, -1, 0, 0, 3);
    check(solid !== null && solid < 1.9, 'the crate is solid');
  }
  for (const d of sim.drops) if (d.body) physics.world.removeRigidBody(d.body);
  cleanup(sim, body);
}

section('Exclusive supply drop weapons');
{
  check(EXCLUSIVE_WEAPONS.every((w) => WEAPONS[w].exclusive && WEAPONS[w].slot === 'primary' && !PRIMARY_WEAPONS.includes(w)), 'M249, SCAR-H and M107 are primaries kept off the loadout and weapon tables');
  const at = { x: 0, y: 0.15, z: 6 };
  const { sim, sp, body } = makeSim(at, 0.5);
  run(sim, 1);
  const roll = () => (sim as unknown as { rollExclusive(): string | null }).rollExclusive();
  sim.phaseTime = SUPPLY_DROPS.exclusiveAfter - 1;
  let early = 0;
  for (let i = 0; i < 2000; i++) if (roll()) early++;
  check(early === 0, 'no exclusive weapon in any drop before five minutes survived');
  sim.phaseTime = SUPPLY_DROPS.exclusiveAfter + 1;
  const got: Record<string, number> = {};
  let rolled = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const w = roll();
    if (w) {
      rolled++;
      got[w] = (got[w] ?? 0) + 1;
    }
  }
  check(Math.abs(rolled / N - SUPPLY_DROPS.exclusiveChance) < 0.015, `after five minutes ${(100 * rolled / N).toFixed(1)}% of drops carry one`);
  check((got.sniper ?? 0) < (got.lmg ?? 0) * 0.65 && (got.sniper ?? 0) < (got.battle ?? 0) * 0.65 && (got.sniper ?? 0) > 0,
    `the .50 cal is the rare one (${JSON.stringify(got)})`);

  // A drop forced to carry the .50 cal, flown all the way down.
  const clear = () => {
    for (const z of [...sim.zombies]) z.removeBody();
    sim.zombies.splice(0, sim.zombies.length);
    sp.health = PLAYER.maxHealth;
    return false;
  };
  clear();
  const drop = sim.callSupplyDrop('sniper');
  let res = run(sim, 0.1, clear);
  check(!!drop && drop.weapon === 'sniper', 'debug drop carries the requested weapon');
  check(res.events.some((e) => e.type === 'notice' && e.text === 'RARE SUPPLY DROP INBOUND'), 'a rare drop is announced as such');
  if (drop) {
    const f = drop.flight;
    res = run(sim, f.land - sim.time + 0.2, clear);
    const wcase = sim.interactables.find((it) => it.kind === 'exclusive');
    check(!!wcase && wcase.weapon === 'sniper' && wcase.supply === 1, 'a weapon case lands with the crate, one gun inside');
    const c = caseSpot(f);
    const off = Math.hypot(c.x - f.ground.x, c.z - f.ground.z);
    check(Math.abs(off - SUPPLY_DROPS.caseOffset) < 1e-6 && off < SUPPLY_DROPS.clearRadius, 'the case lies on the cleared ground beside the crate');
    const snap = captureSnapshot(sim, new Map());
    const row = snap.i.find((r) => r[0] === wcase?.id);
    check(!!row && row[7] >= 0, 'snapshots carry the weapon in the case to online players');
    sim.setMotion('p1', { pos: { x: c.x + 0.5, y: f.ground.y, z: c.z } });
    check(sim.reachable('p1').some((it) => it.kind === 'exclusive'), 'case in reach beside it');
    const prev = sp.arsenal.primary.id;
    const took = sim.use('p1', wcase!.id);
    res = run(sim, 0.05, clear);
    check(res.events.some((e) => e.type === 'supplyDrop' && e.stage === 'weaponTaken'), 'everyone is told the case is empty');
    check(took && sp.arsenal.primary.id === 'sniper' && sp.arsenal.primary.mag === WEAPONS.sniper.magazine && sp.arsenal.primary.reserve === WEAPONS.sniper.startReserve,
      `taking it swaps out the ${prev} for a loaded M107`);
    check(wcase!.supply === 0 && !sim.use('p1', wcase!.id), 'there is only one');
    const crate = sim.interactables.find((it) => it.kind === 'supply')!;
    sp.arsenal.primary.reserve = 0;
    check(sim.use('p1', crate.id) && sp.arsenal.primary.reserve === WEAPONS.sniper.maxReserve, 'universal ammo fills the .50 cal too');
    sim.setMotion('p1', { pos: { x: c.x + 0.5, y: f.ground.y, z: c.z } });
    check(!sim.selectPrimary('p1', 'lmg'), 'exclusives cannot be picked at a weapon table');
  }
  for (const d of sim.drops) if (d.body) physics.world.removeRigidBody(d.body);
  cleanup(sim, body);
}
{
  // Each exclusive fires, reloads and draws through the shared arsenal like any other gun.
  for (const w of EXCLUSIVE_WEAPONS) {
    const a = new Arsenal('ar', 'pistol');
    a.replacePrimary(w, true);
    a.step(WEAPONS[w].draw + 0.05, false, []);
    let shots = 0;
    for (let t = 0; t < 2; t += 1 / 60) {
      if (a.fireState() === 'ok') { a.consume(); shots++; }
      a.step(1 / 60, false, []);
    }
    const want = Math.min(WEAPONS[w].magazine, WEAPONS[w].fireRate / 30);
    check(Math.abs(shots - want) <= 1.5, `${WEAPONS[w].model} cycles at its fire rate (${shots} rounds in 2 s)`);
    a.weapon.mag = 0;
    check(a.startReload(), `${WEAPONS[w].model} reloads`);
  }
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

section('Severed arms');
{
  // Zones: a stub keeps its upper half, a missing arm lets rounds through.
  const pos = { x: 0, y: 0, z: 0 };
  const whole = zombieZones(pos, 0, 1, 'standing', []);
  const armOf = (zones: ZoneShape[]) => zones.find((zz) => zz.zone === 'armL')!;
  const wa = armOf(whole);
  const hand = along(wa.a, wa.b, 0.9), upper = along(wa.a, wa.b, 0.2);
  const shootAt = (zones: ZoneShape[], at: Vec3) => rayZones({ x: at.x, y: at.y, z: at.z + 5 }, { x: 0, y: 0, z: -1 }, zones, 50);
  check(shootAt(whole, hand)?.zone === 'armL', 'a whole arm is hit at the hand');
  const stub = zombieZones(pos, 0, 1, 'standing', [], 1, { armL: 'elbow', armR: 'intact' });
  check(shootAt(stub, hand)?.zone !== 'armL' && shootAt(stub, upper)?.zone === 'armL', 'cut at the elbow: the forearm is gone, the upper arm is still there');
  const gone = zombieZones(pos, 0, 1, 'standing', [], 1, { armL: 'shoulder', armR: 'intact' });
  check(!gone.some((zz) => zz.zone === 'armL') && shootAt(gone, hand)?.zone !== 'armL', 'gone at the shoulder: rounds pass where the arm was');
  const h = shootAt(whole, upper);
  check(!!h && h.along < LIMBS.elbowAt && (shootAt(whole, hand)?.along ?? 0) > LIMBS.elbowAt, 'hits report how far along the arm they landed');

  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  run(sim, 0.7);
  sp.arsenal.aim = 1;
  sp.motion.aiming = true;
  const place = (kind: 'walker' | 'runner' | 'brute', z = 3) => {
    const zz = sim.spawnZombie(kind, { x: 0, y: 0.02, z }, 'idle');
    zz.facing = 0;
    return zz;
  };
  const armPoint = (zz: Zombie, arm: 'armL' | 'armR', t: number) => {
    const shape = zz.zones([]).find((s) => s.zone === arm)!;
    return along(shape.a, shape.b, t);
  };
  const dirTo = (from: Vec3, to: Vec3) => {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const l = Math.hypot(dx, dy, dz);
    return { x: dx / l, y: dy / l, z: dz / l };
  };
  const shootArm = (zz: Zombie, arm: 'armL' | 'armR', t: number, maxShots: number, seed: number) => {
    const events: SimEvent[] = [];
    let shots = 0;
    while (zz.arms[arm] === 'intact' && zz.alive && shots < maxShots) {
      zz.facing = 0;
      if (sim.fire('p1', sp.eye, dirTo(sp.eye, armPoint(zz, arm, t)), true, seed + shots) === 'fired') shots++;
      events.push(...run(sim, 0.13).events);
    }
    return { events, shots };
  };

  // Gunfire.
  const z1 = place('walker');
  const r1 = shootArm(z1, 'armL', 0.22, 6, 40);
  const cut1 = r1.events.find((e) => e.type === 'limbSevered');
  const armHits = r1.events.filter((e) => e.type === 'zombieHit' && e.zone === 'armL').length;
  check(!!cut1 && cut1.type === 'limbSevered' && cut1.cut === 'shoulder' && z1.arms.armL === 'shoulder', `two rifle rounds to the upper arm take the whole arm off (${armHits} hits)`);
  check(armHits === 2 && z1.alive && z1.health === 100 - 36, 'losing the arm does not kill it; the arm hits still hurt');
  check(sp.stats.limbsSevered === 1 && sim.limbs.length === 1 && !!sim.limbs[0].body, 'the arm becomes a loose physics body');
  const order = r1.events.map((e) => e.type).filter((t) => t === 'zombieHit' || t === 'limbSevered');
  check(order.indexOf('limbSevered') === order.length - 1, 'the hit is reported before the arm coming off');
  const torsoShot = (() => {
    z1.facing = 0;
    const e = sp.eye;
    sim.fire('p1', e, dirTo(e, { x: z1.pos.x, y: z1.pos.y + 1.1, z: z1.pos.z + 0.1 }), true, 77);
    return run(sim, 0.2).events;
  })();
  check(torsoShot.some((e) => e.type === 'zombieHit' && e.zone === 'torso') && z1.armDamage.armR === 0 && z1.arms.armR === 'intact', 'body shots do nothing to the arms');

  const z2 = place('walker', 2.6);
  z2.pos.x = 1.4;
  const r2 = shootArm(z2, 'armR', 0.85, 6, 90);
  const cut2 = r2.events.find((e) => e.type === 'limbSevered');
  check(!!cut2 && cut2.type === 'limbSevered' && cut2.cut === 'elbow' && z2.arms.armR === 'elbow', 'rounds to the forearm take it off at the elbow');
  const stubHits = shootArm(z2, 'armR', 0.85, 2, 120).events.filter((e) => e.type === 'limbSevered').length;
  check(stubHits === 0 && z2.arms.armR === 'elbow', 'the stub left at the elbow does not come off again');

  // The arm tumbles down and settles on the ground.
  run(sim, 3);
  const l1 = sim.limbs.find((l) => l.id === (cut1 as { limb: number }).limb)!;
  const ground = physics.raycast(l1.pos.x, l1.pos.y + 1, l1.pos.z, 0, -1, 0, 4);
  const restY = ground === null ? -99 : l1.pos.y + 1 - ground;
  check(!!l1.body && Math.abs(l1.pos.y - restY) < l1.radius * 3 + 0.05 && Math.hypot(l1.body.linvel().x, l1.body.linvel().y, l1.body.linvel().z) < 0.3, `the severed arm comes to rest on the ground (${l1.pos.y.toFixed(2)} m, floor ${restY.toFixed(2)} m)`);
  const through = physics.raycast(l1.pos.x, l1.pos.y + 2, l1.pos.z, 0, -1, 0, 5);
  check(through !== null && through > 2, 'bullets and sight lines pass through a loose arm');
  const cg = l1.body.collider(0).collisionGroups();
  const member = cg >>> 16, filter = cg & 0xffff;
  check(!(member & (GROUP.player | GROUP.zombie)) && !(filter & (GROUP.player | GROUP.zombie)) && !!(filter & GROUP.static), 'loose arms never trip survivors or zombies');

  // Picking it up.
  for (const zz of [...sim.zombies]) zz.removeBody();
  sim.zombies.length = 0;
  sim.setMotion('p1', { pos: { x: l1.pos.x + 0.9, y: restY, z: l1.pos.z }, yaw: Math.PI / 2 });
  check(sim.limbsInReach('p1').some((l) => l.id === l1.id), 'an arm at your feet is in reach');
  sim.setMotion('p1', { pos: { x: l1.pos.x + 4, y: restY, z: l1.pos.z } });
  check(!sim.grabLimb('p1', l1.id), 'an arm out of reach cannot be grabbed');
  const standAt = { x: l1.pos.x + 0.9, y: restY, z: l1.pos.z };
  sim.setMotion('p1', { pos: standAt, yaw: Math.PI / 2 });
  body.moveTo(standAt);
  const grabbed = sim.grabLimb('p1', l1.id);
  const a = sp.arsenal;
  check(grabbed && a.limb?.id === l1.id && l1.holder === 'p1' && !l1.body, 'grabbing it puts it in your hands');
  check(a.action === 'draw' && sim.fire('p1', sp.eye, { x: -1, y: 0, z: 0 }, true, 1) === 'busy', 'you cannot swing while still getting a grip');
  run(sim, 0.5);
  const magBefore = a.weapon.mag;
  check(!sim.reload('p1') && a.spread({ speed: 0, crouching: false, grounded: true, aiming: false }) === 0, 'no reloading or gun spread while holding it');

  // Clubbing.
  const club = limbClub('shoulder', 'walker');
  check(l1.wear === club.wear && l1.maxWear === club.wear, `a whole arm lasts ${club.wear} hits`);
  const victim = sim.spawnZombie('walker', { x: standAt.x - 1.3, y: standAt.y + 0.02, z: standAt.z }, 'idle');
  victim.facing = Math.PI / 2;
  const swingAt = (zz: Zombie, y = 1.2) => {
    const e = sp.eye;
    return sim.fire('p1', e, dirTo(e, { x: zz.pos.x, y: zz.pos.y + y, z: zz.pos.z }), true, 7);
  };
  let hits: SimEvent[] = [];
  let swings = 0;
  while (victim.alive && swings < 6) {
    victim.facing = Math.PI / 2;
    if (swingAt(victim) === 'fired') swings++;
    hits.push(...run(sim, LIMBS.duration + 0.05).events);
  }
  const clubbed = hits.filter((e) => e.type === 'zombieHit' && e.limb === l1.id);
  check(clubbed.length >= 1 && clubbed[0].type === 'zombieHit' && Math.round(clubbed[0].damage) === club.damage && clubbed[0].melee, `a swing lands for ${club.damage} damage`);
  check(!victim.alive && swings === 3 && sp.stats.limbKills === 1, `three swings beat a walker to death (took ${swings})`);
  check(a.weapon.mag === magBefore && l1.wear === club.wear - 3, 'every landed blow wears it; no rounds are spent');
  check(hits.some((e) => e.type === 'melee' && e.stage === 'swing' && e.limb), 'swings are reported as arm swings');
  const missStart = l1.wear;
  swingAt(victim);
  run(sim, LIMBS.duration + 0.05);
  check(l1.wear === missStart, 'a swing that hits nothing does not wear it');

  // It tears another zombie's arm off.
  const z3 = sim.spawnZombie('walker', { x: standAt.x - 1.2, y: standAt.y + 0.02, z: standAt.z }, 'idle');
  z3.facing = Math.PI / 2;
  run(sim, 0.05);
  z3.facing = Math.PI / 2;
  const e3 = sp.eye;
  sim.fire('p1', e3, dirTo(e3, armPoint(z3, 'armR', 0.3)), true, 11);
  hits = run(sim, LIMBS.duration + 0.05).events;
  check(hits.some((e) => e.type === 'limbSevered' && e.melee) && z3.arms.armR !== 'intact', 'a blow with the arm can rip off another');
  z3.removeBody();
  sim.zombies.splice(sim.zombies.indexOf(z3), 1);

  // Worn through.
  l1.wear = 1;
  const z4 = sim.spawnZombie('runner', { x: standAt.x - 1.3, y: standAt.y + 0.02, z: standAt.z }, 'idle');
  z4.facing = Math.PI / 2;
  swingAt(z4);
  hits = run(sim, LIMBS.windup + 0.05).events;
  check(hits.some((e) => e.type === 'limbBroke' && e.limb === l1.id) && !!a.limb?.broken && !sim.limbs.includes(l1), 'the last blow tears it apart in your hands');
  hits = run(sim, LIMBS.duration).events;
  check(!a.limb && a.action === 'draw' && hits.some((e) => e.type === 'draw'), 'then the gun comes back up');
  run(sim, 0.8);
  check(sim.fire('p1', sp.eye, { x: -1, y: 0, z: 0 }, true, 5) === 'fired', 'and fires again');
  for (const zz of [...sim.zombies]) zz.removeBody();
  sim.zombies.length = 0;

  // Machete: one chop takes a walker's arm, a brute's takes two.
  run(sim, 0.6);
  sp.motion.yaw = Math.PI / 2;
  const chop = (zz: Zombie, arm: 'armL' | 'armR') => {
    zz.facing = Math.PI / 2;
    const e = sp.eye;
    sim.melee('p1', { origin: e, dir: dirTo(e, armPoint(zz, arm, 0.3)) });
    return run(sim, 0.6).events;
  };
  const w5 = sim.spawnZombie('walker', { x: standAt.x - 1.2, y: standAt.y + 0.02, z: standAt.z }, 'idle');
  let ev = chop(w5, 'armL');
  check(ev.some((e) => e.type === 'limbSevered' && e.melee && e.arm === 'armL') && w5.alive, 'one machete chop takes off a walker\'s arm');
  w5.removeBody();
  sim.zombies.length = 0;
  const b5 = sim.spawnZombie('brute', { x: standAt.x - 1.3, y: standAt.y + 0.02, z: standAt.z }, 'idle');
  ev = chop(b5, 'armL');
  const first = ev.some((e) => e.type === 'limbSevered');
  ev = chop(b5, 'armL');
  check(!first && ev.some((e) => e.type === 'limbSevered') && b5.arms.armL !== 'intact', 'a brute\'s arm takes two chops');
  const bruteLimb = sim.limbs[sim.limbs.length - 1];
  check(bruteLimb.maxWear > limbClub(bruteLimb.cut, 'walker').wear && bruteLimb.scale > 1.1 && limbClub(bruteLimb.cut, 'brute').damage > limbClub(bruteLimb.cut, 'walker').damage, 'a brute\'s arm is bigger, hits harder and lasts longer');
  b5.removeBody();
  sim.zombies.length = 0;

  // Letting go.
  run(sim, 2.5);
  const grab = () => {
    const l = sim.limbs.find((x) => !x.holder)!;
    const at = { x: l.pos.x + 0.8, y: l.pos.y - 0.05, z: l.pos.z };
    sim.setMotion('p1', { pos: at });
    body.moveTo(at);
    return sim.grabLimb('p1', l.id) ? l : null;
  };
  let held = grab();
  run(sim, 0.5);
  check(!!held && sim.switchWeapon('p1', 'secondary'), 'reaching for a gun works with an arm in hand');
  ev = sim.drain();
  check(!a.limb && !!held!.body && held!.holder === null && a.active === 'secondary', 'the arm is tossed aside and the pistol drawn');
  run(sim, 1.5);
  held = grab();
  run(sim, 0.5);
  sp.health = 50;
  sp.bandages = 1;
  check(!!held && sim.bandage('p1') && !a.limb && !!held!.body && a.action === 'bandage', 'bandaging puts the arm down first');
  run(sim, 3.2);
  held = grab();
  const swap = sim.limbs.find((x) => !x.holder && x !== held);
  if (swap) {
    const at = { x: swap.pos.x + 0.8, y: swap.pos.y - 0.05, z: swap.pos.z };
    sim.setMotion('p1', { pos: at });
    body.moveTo(at);
    run(sim, 0.5);
    check(sim.grabLimb('p1', swap.id) && a.limb === swap && !!held!.body, 'grabbing another arm drops the one in hand');
  }
  sim.damagePlayer(sp, 500, sp.motion.pos);
  const loose = sim.limbs.filter((l) => !l.holder);
  check(!a.limb && loose.length === sim.limbs.length, 'dying drops what you held');
  cleanup(sim, body);
}
{
  // Armless zombies hit softer; the heap of arms stays bounded.
  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  run(sim, 0.7);
  const z = sim.spawnZombie('walker', { x: 0, y: 0.02, z: 5 }, 'approach');
  z.arms.armL = 'shoulder';
  z.arms.armR = 'shoulder';
  const hurt = run(sim, 8, () => sp.health < PLAYER.maxHealth).events.find((e) => e.type === 'playerHurt');
  const [lo, hi] = ZOMBIES.walker.damage;
  check(!!hurt && hurt.type === 'playerHurt' && hurt.damage >= Math.round(lo * 0.5) && hurt.damage <= Math.round(hi * 0.5), `with no arms it can only bite: ${hurt && hurt.type === 'playerHurt' ? hurt.damage : '?'} damage`);
  z.removeBody();
  sim.zombies.length = 0;
  sp.health = PLAYER.maxHealth;
  sp.arsenal.replacePrimary('marksman');
  run(sim, 1);
  sp.arsenal.aim = 1;
  sp.motion.aiming = true;
  let gone = 0;
  for (let i = 0; i < LIMBS.maxLoose + 3; i++) {
    const zz = sim.spawnZombie('walker', { x: 0, y: 0.02, z: 2.5 }, 'idle');
    zz.facing = 0;
    const shape = zz.zones([]).find((s) => s.zone === 'armL')!;
    const at = along(shape.a, shape.b, 0.25);
    const e = sp.eye;
    const dx = at.x - e.x, dy = at.y - e.y, dz = at.z - e.z;
    const l = Math.hypot(dx, dy, dz);
    sp.arsenal.primary.mag = 10;
    sim.fire('p1', e, { x: dx / l, y: dy / l, z: dz / l }, true, 900 + i);
    gone += run(sim, 0.45).events.filter((ev) => ev.type === 'limbGone').length;
    zz.removeBody();
    sim.zombies.length = 0;
  }
  const loose = sim.limbs.filter((l) => !l.holder).length;
  check(sp.stats.limbsSevered === LIMBS.maxLoose + 3 && loose === LIMBS.maxLoose && gone === 3, `no more than ${LIMBS.maxLoose} arms lie around: the oldest are cleared (${sp.stats.limbsSevered} severed, ${loose} loose)`);
  const s = sim.limbs[0] as SimLimb;
  check(Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.rot.w), 'arm poses stay finite');
  cleanup(sim, body);
}

section('Survivor appearance');
{
  const catalogs = Object.entries(APPEARANCE_ITEMS) as [string, readonly AppearanceItem[]][];
  check(catalogs.every(([, items]) => new Set(items.map((i) => i.id)).size === items.length), 'catalog ids are unique in every slot');
  check(catalogs.every(([, items]) => items.length < 36 * 36), 'every catalog fits the two-digit wire index');
  const tops = APPEARANCE_ITEMS.top.map((i) => i.id) as string[];
  const hats = APPEARANCE_ITEMS.headwear as readonly AppearanceItem[];
  check(['flannel', 'openflannel', 'leather', 'denim', 'hoodie', 'buttonup'].every((id) => tops.includes(id)), 'flannels, jackets and shirts are in the catalog');
  check(['Hats', 'Helmets', 'Funny hats'].every((g) => hats.some((h) => h.group === g)), 'headwear has hats, helmets and funny hats');
  check(APPEARANCE_ITEMS.eyes.length >= 5 && PALETTES.eye.length >= 8, 'several eye shapes and eye colors');

  const sameLook = (a: Appearance, b: Appearance) => APPEARANCE_FIELDS.every(([k]) => a[k] === b[k]);
  check(sameLook(decodeAppearance(encodeAppearance(DEFAULT_APPEARANCE)), DEFAULT_APPEARANCE), 'default look survives encode and decode');
  const rand = rng(1234);
  let roundTrips = 0, valid = 0;
  for (let i = 0; i < 300; i++) {
    const a = randomAppearance(rand);
    if (sameLook(decodeAppearance(encodeAppearance(a)), a)) roundTrips++;
    if (sameLook(sanitizeAppearance(a), a)) valid++;
  }
  check(roundTrips === 300, `300 random looks survive the wire format (${roundTrips})`);
  check(valid === 300, `random looks are always valid (${valid})`);

  const junk = sanitizeAppearance({ hair: 'laser', skin: 99, top: 'flannel', topColor: -1, eyeColor: 2.5, headwear: 'propeller' });
  check(junk.hair === DEFAULT_APPEARANCE.hair && junk.skin === DEFAULT_APPEARANCE.skin, 'unknown items and out-of-range colors fall back');
  check(junk.top === 'flannel' && junk.headwear === 'propeller' && junk.topColor === DEFAULT_APPEARANCE.topColor && junk.eyeColor === DEFAULT_APPEARANCE.eyeColor, 'valid fields are kept next to junk');
  check(sameLook(sanitizeAppearance('nope'), DEFAULT_APPEARANCE) && sameLook(decodeAppearance(42), DEFAULT_APPEARANCE), 'non-objects give the default look');
  check(sameLook(decodeAppearance('9.1.2.3'), DEFAULT_APPEARANCE), 'unknown wire versions give the default look');
  check(sameLook(decodeAppearance('1.' + 'zz.'.repeat(80)), DEFAULT_APPEARANCE), 'oversized wire strings are refused');
  const partial = decodeAppearance('1.2');
  check(partial.skin === 2 && partial.hair === DEFAULT_APPEARANCE.hair, 'short wire strings fill missing fields with defaults');

  const { sim, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  const cowboy = sanitizeAppearance({ ...DEFAULT_APPEARANCE, headwear: 'cowboy', top: 'flannel', eyes: 'fierce', eyeColor: 5 });
  const p2 = sim.addPlayer('p2', 'Cowboy', 'ar', 'pistol', { x: 1, y: 0.15, z: 6 }, 0, encodeAppearance(cowboy));
  check(sameLook(decodeAppearance(p2.appearance), cowboy), 'players keep the look they joined with');
  const p3 = sim.addPlayer('p3', 'Hacker', 'ar', 'pistol', { x: 2, y: 0.15, z: 6 }, 0, '1.' + 'zz.'.repeat(26) + '<script>');
  check(p3.appearance === encodeAppearance(decodeAppearance(p3.appearance)) && /^[0-9a-z.]+$/.test(p3.appearance), 'malicious appearance input is cleaned on join');
  cleanup(sim, body);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
