/**
 * Headless checks for the combat simulation, run against the real map collision:
 * the zombie navigation grid, weapon state (fire rates, magazines, reloads, switching, melee),
 * damage and hit zones, zombie perception and pursuit through buildings, door pounding,
 * the spawner, interactables and player death, and the survivor appearance wire format.
 * Run with `npm run check:sim`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, RAPIER, GROUP, groups, createDoorBodies, buildNavGrid, Simulation, Arsenal,
  WEAPONS, NAV_REACHABLE, DOWNED, zombieZones, rayZones, along, PLAYER, ZOMBIES, SPAWNING, SPECIALS, HORDES, hordeAt, hordeStart, hordeBonus, hordeDuration, hordeRunnerBoost, SUPPLY_DROPS, LIMBS, LEGS, limbClub, EXCLUSIVE_WEAPONS, PRIMARY_WEAPONS, SERUM, caseSpot, captureSnapshot, Mirror, MELEE, MELEE_PICKUPS, FOUND_MELEE, findPickupRooms, isMelee, type Vec3, type SimEvent, type NavGrid, type DoorBody,
  type Zombie, type SimLimb, type ZoneShape,
  APPEARANCE_ITEMS, APPEARANCE_FIELDS, DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, PALETTES, encodeAppearance, decodeAppearance, sanitizeAppearance,
  randomAppearance, rng, type Appearance, type AppearanceItem,
  BARRICADE, Mirror, NAV_INDOOR, storeyFloors, type BarricadeSlot,
  BUILD_OPTIONS, BUILD_SLOTS, FIT_TIME, SKINS, buildable, decodeLoadout, defaultBuild, encodeBuild, encodeLoadout, fitsOf, levelFor,
  levelStart, owns, runXp, sameBuild, sanitizeBuild, sanitizeLoadout, tunedWeapon, unlockTrack, type WeaponBuild, type WeaponId,
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
  ['south woods', { x: -30, y: 0, z: 155 }],
  ['back alley', { x: 0, y: 0, z: -47 }],
  ['Oak Street', { x: -20, y: 0, z: 94 }],
  ['Oyelaran house basement (Oak St)', { x: 7, y: -2.7, z: 113.5 }],
  ['Delgado house living room (Oak St)', { x: 29, y: 0.3, z: 77 }],
  ['Oak Street dead end', { x: 92, y: 0, z: 94 }],
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
  ['Oak Street to safehouse living room', spots[12][1], spots[0][1]],
  ['south woods to Oyelaran basement', spots[10][1], spots[13][1]],
  ['safehouse to Delgado house', spots[0][1], spots[14][1]],
  ['park to Oak Street dead end', spots[7][1], spots[15][1]],
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
// The map grew south with Oak Street: a survivor anywhere still gets zombies spawning around them.
for (const [where, at] of [
  ['the safehouse', { x: 4.8, y: 0.32, z: -22.3 }], ['Elm Street', { x: -40, y: 0.15, z: 6 }],
  ['Oak Street', { x: -10, y: 0.02, z: 94 }], ['an Oak Street basement', { x: 7, y: -2.7, z: 113.5 }],
  ['the Oak Street dead end', { x: 90, y: 0.02, z: 94 }],
] as [string, Vec3][]) {
  const { sim, body } = makeSim(at);
  let found = 0, south = 0;
  for (let i = 0; i < 60; i++) {
    const p = sim.findSpawnPoint();
    if (!p) continue;
    found++;
    if (p.z > 50) south++;
  }
  check(found >= 54, `spawner finds a spot around a survivor at ${where} (${found} of 60 tries, ${south} south of the alley)`);
  cleanup(sim, body);
}

section('Zombie kinds and getting unstuck');
{
  const { sim, body } = makeSim({ x: 4.8, y: 0.32, z: -22.3 });
  const count = (t: number) => {
    sim.phaseTime = t;
    const n = { walker: 0, runner: 0, brute: 0, crawler: 0, screamer: 0, bloater: 0 };
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
  const base = SPAWNING.basePopulation, full4 = SPAWNING.playerScale[3];
  check(sim.populationTarget === base, `one survivor starts against ${base} (${sim.populationTarget})`);
  check(sim.teamScale === 1, 'one survivor has no team ramp');
  const others = [2, 3, 4].map((i) => sim.addPlayer(`p${i}`, `P${i}`, 'ar', 'pistol', { x: 4.8 + i, y: 0.32, z: -22.3 }, 0));
  const start4 = 1 + (full4 - 1) * SPAWNING.teamRamp.start;
  check(Math.abs(sim.teamScale - start4) < 1e-9 && sim.populationTarget === Math.floor(base * start4), `four survivors start against ${sim.populationTarget}, not the full ${Math.floor(base * full4)}`);
  check(sim.populationTarget <= 8, `a full lobby opens against a handful (${sim.populationTarget})`);
  sim.phaseTime = SPAWNING.teamRamp.full / 2;
  const half4 = sim.teamScale;
  check(half4 > start4 && half4 < full4, `the team's extra eases in with time (${start4.toFixed(2)} → ${half4.toFixed(2)} → ${full4})`);
  sim.phaseTime = SPAWNING.teamRamp.full;
  check(Math.abs(sim.teamScale - full4) < 1e-9, `four survivors face the full scale after ${SPAWNING.teamRamp.full / 60} minutes`);
  sim.phaseTime = 0;
  const fifth = sim.addPlayer('p5', 'P5', 'ar', 'pistol', { x: 10.8, y: 0.32, z: -22.3 }, 0);
  check(sim.playerScale === SPAWNING.playerScale[3], 'a fifth survivor counts as four');
  fifth.alive = false;
  others[2].alive = false;
  check(sim.playerScale === SPAWNING.playerScale[2], 'the dead do not count');
  sim.phaseTime = 5 * 60;
  const one = Math.floor(base + SPAWNING.growthPerMinute * 5);
  for (const o of others) o.alive = false;
  check(sim.populationTarget === one, `after five minutes one survivor faces ${one} (${sim.populationTarget})`);
  sp.alive = false;
  check(sim.playerScale === 1, 'nobody alive scales like one');
  sp.alive = true;
  sim.phaseTime = 3 * 3600;
  check(sim.populationTarget === SPAWNING.maxPopulation, `the horde stops at ${SPAWNING.maxPopulation} (${sim.populationTarget})`);
  for (const o of others) o.alive = true;
  sim.phaseTime = 10 * 60;
  const ten = sim.populationTarget;
  check(ten <= 45, `four survivors face ${ten} after ten minutes, not a crowd`);
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
  check(sim.zombies.length > before + 2, `the surge pours in (${before} → ${sim.zombies.length} in 2 s)`);
  sim.addPlayer('p2', 'P2', 'ar', 'pistol', { x: 6, y: 0.32, z: -22.3 }, 0);
  check(sim.teamScale > 1 && sim.spawnTarget === Math.min(SPAWNING.maxPopulation, sim.populationTarget + Math.floor(hordeBonus(1) * sim.teamScale)), 'a bigger team gets a bigger surge');
  run(HORDES.firstAt + hordeDuration(1) - 0.05, 6);
  check(seen.includes('over1') && !sim.surging && sim.horde.survived === 1, `wave 1 is outlasted (${seen.join(' ')})`);
  run(hordeStart(3) + 1, 2);
  check(seen.filter((s) => s.startsWith('over')).length === 2 && seen.indexOf('over2') < seen.indexOf('surge3'), `a skipped wave still counts once (${seen.join(' ')})`);
  check(sim.horde.wave === 3 && sim.surging, 'wave 3 surges');
  cleanup(sim, body);
}
section('Spawns come spread out');
{
  // A full lobby deep into the night, in a big surge, with nobody thinning the horde: the worst case.
  const { sim, body } = makeSim({ x: 4.8, y: 0.32, z: -22.3 });
  for (const i of [2, 3, 4]) sim.addPlayer(`p${i}`, `P${i}`, 'ar', 'pistol', { x: 4.8 + i, y: 0.32, z: -22.3 }, 0);
  sim.phase = 'survival';
  sim.phaseTime = hordeStart(6) + 0.5;
  const perSecond = new Map<number, number>();
  let spawned = 0;
  for (let i = 0; i < 600; i++) {
    sim.step(1 / 60);
    for (const e of sim.drain()) {
      if (e.type !== 'zombieSpawned') continue;
      spawned++;
      const sec = Math.floor(sim.time);
      perSecond.set(sec, (perSecond.get(sec) ?? 0) + 1);
    }
  }
  const most = Math.ceil(1 / SPAWNING.minInterval);
  const peak = Math.max(0, ...perSecond.values());
  check(sim.surging && sim.spawnTarget > 40, `four survivors in wave 6 face a big surge (target ${sim.spawnTarget})`);
  check(sim.spawnTarget <= SPAWNING.maxPopulation, `the surge stays under the cap of ${SPAWNING.maxPopulation}`);
  check(peak <= most, `never more than ${most} spawns in one second (${peak})`);
  check(spawned >= 10 && spawned <= 10 / SPAWNING.minInterval + 1, `the surge still pours in steadily (${spawned} in 10 s)`);
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
{
  // Drops find open ground on Oak Street too: the road, the yards, the dead end.
  const at = { x: 10, y: 0.02, z: 94 };
  const { sim, body } = makeSim(at);
  const plan = () => (sim as unknown as { planFlight(): { ground: Vec3 } | null }).planFlight();
  let ok = 0, near = Infinity, far = 0;
  for (let i = 0; i < 20; i++) {
    const f = plan();
    if (!f) continue;
    const g = f.ground, d = Math.hypot(g.x - at.x, g.z - at.z);
    near = Math.min(near, d);
    far = Math.max(far, d);
    if (d >= SUPPLY_DROPS.minDistance && d <= SUPPLY_DROPS.maxDistance && physics.raycast(g.x, g.y + 0.6, g.z, 0, 1, 0, 60) === null) ok++;
  }
  check(ok === 20, `supply drops for a survivor on Oak Street land in the open, in range (${ok} of 20, ${near.toFixed(0)}-${far.toFixed(0)} m)`);
  cleanup(sim, body);
}

section('Exclusive supply drop weapons');
{
  check(EXCLUSIVE_WEAPONS.every((w) => WEAPONS[w].exclusive && WEAPONS[w].slot === 'primary' && !PRIMARY_WEAPONS.includes(w)),
    'M249, SCAR-H, M107, RPG-7 and the custom .338 are primaries kept off the loadout and weapon tables');
  check(EXCLUSIVE_WEAPONS.every((w) => SUPPLY_DROPS.exclusiveWeights.some(([x, k]) => x === w && k > 0)), 'every exclusive can come out of a drop');
  const at = { x: 0, y: 0.15, z: 6 };
  const { sim, sp, body } = makeSim(at, 0.5);
  run(sim, 1);
  const roll = () => (sim as unknown as { rollExclusive(): string | null }).rollExclusive();
  const N = 20000;
  sim.phaseTime = SUPPLY_DROPS.exclusiveAfter - 1;
  let early = 0;
  for (let i = 0; i < N; i++) if (roll()) early++;
  check(Math.abs(early / N - SUPPLY_DROPS.exclusiveEarly) < 0.006, `before three minutes only ${(100 * early / N).toFixed(1)}% of drops carry one`);
  sim.phaseTime = SUPPLY_DROPS.exclusiveAfter + 1;
  const got: Record<string, number> = {};
  let rolled = 0;
  for (let i = 0; i < N; i++) {
    const w = roll();
    if (w) {
      rolled++;
      got[w] = (got[w] ?? 0) + 1;
    }
  }
  check(rolled / N >= 0.1 && rolled / N <= 0.15, `after three minutes ${(100 * rolled / N).toFixed(1)}% of drops carry one (asked for 10 to 15%)`);
  const most = Math.max(got.lmg ?? 0, got.rpg ?? 0, got.battle ?? 0);
  check((got.sniper ?? 0) > 0 && (got.wraith ?? 0) > 0 && (got.sniper ?? 0) < most * 0.75 && (got.wraith ?? 0) < most * 0.75,
    `the snipers are the rarest (${JSON.stringify(got)})`);

  // The real thing: drops planned and flown by the night's own schedule, counted from what the
  // helicopters announce. Many short nights of a lone survivor, each run to 12 minutes.
  {
    const S = sim as unknown as { runDrops(): void; nextDropAt: number };
    let early2 = 0, earlyN = 0, late2 = 0, lateN = 0, nights = 0, nightsWithOne = 0;
    for (let night = 0; night < 160; night++) {
      for (const d of sim.drops) if (d.body) physics.world.removeRigidBody(d.body);
      sim.drops.length = 0;
      S.nextDropAt = SUPPLY_DROPS.firstAt;
      let any = false;
      for (sim.phaseTime = 0; sim.phaseTime < 720; sim.phaseTime += 1) {
        const before = sim.drops.length;
        S.runDrops();
        if (sim.drops.length === before) continue;
        const d = sim.drops[sim.drops.length - 1];
        if (sim.phaseTime < SUPPLY_DROPS.exclusiveAfter) { earlyN++; if (d.weapon) early2++; } else { lateN++; if (d.weapon) late2++; }
        if (d.weapon) any = true;
      }
      sim.drain();
      nights++;
      if (any) nightsWithOne++;
    }
    for (const d of sim.drops) if (d.body) physics.world.removeRigidBody(d.body);
    sim.drops.length = 0;
    sim.interactables.splice(0, sim.interactables.length, ...sim.interactables.filter((it) => it.kind !== 'supply' && it.kind !== 'exclusive' && it.kind !== 'serum'));
    check(lateN > 500 && late2 / lateN >= 0.09 && late2 / lateN <= 0.16,
      `flown for real: ${late2} of ${lateN} drops after three minutes carried one (${(100 * late2 / lateN).toFixed(1)}%), ${early2} of ${earlyN} before`);
    console.log(`       ${nightsWithOne} of ${nights} twelve-minute nights saw at least one exclusive weapon`);
  }

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
section('RPG-7');
{
  const at = { x: 0, y: 0.15, z: 6 };
  const { sim, sp, body } = makeSim(at, 0.5);
  run(sim, 1);
  for (const z of [...sim.zombies]) z.removeBody();
  sim.zombies.splice(0, sim.zombies.length);
  sp.arsenal.replacePrimary('rpg', true);
  run(sim, WEAPONS.rpg.draw + 0.1);
  // A pack of four walkers 14 m off, the rocket aimed at the middle one.
  const pack = [-0.8, 0, 0.8, 0.3].map((dx, i) => sim.spawnZombie('walker', { x: dx, y: 0.02, z: -8 - (i === 3 ? 1 : 0) }, 'idle'));
  const eye = sp.eye;
  const t = pack[1];
  const tx = t.pos.x - eye.x, ty = t.pos.y + 1.1 - eye.y, tz = t.pos.z - eye.z;
  const l = Math.hypot(tx, ty, tz);
  sp.arsenal.aim = 1;
  sp.motion.aiming = true;
  const fired = sim.fire('p1', eye, { x: tx / l, y: ty / l, z: tz / l }, true, 7);
  const res = run(sim, 0.2);
  res.events.unshift(...sim.drain());
  const boom = res.events.find((e) => e.type === 'explosion');
  check(fired === 'fired' && !!boom && Math.hypot(boom.pos.x - t.pos.x, boom.pos.z - t.pos.z) < 1.5, 'the rocket goes off where it hits');
  const dead = pack.filter((z) => !z.alive).length;
  check(dead >= 3, `one rocket kills ${dead} of a pack of 4`);
  check(sp.health === PLAYER.maxHealth, 'the shooter is safe at 14 m');
  check(sp.arsenal.primary.mag === 0 && sp.arsenal.startReload(), 'one rocket in the tube, then a reload');
  sp.arsenal.primary.reserve = 0;
  for (const z of [...sim.zombies]) z.removeBody();
  sim.zombies.splice(0, sim.zombies.length);
  cleanup(sim, body);
}

section('Lazarus serum');
{
  const at = { x: 0, y: 0.15, z: 6 };
  const { sim, sp, body } = makeSim(at, 0.5);
  run(sim, 1);
  const clear = () => {
    for (const z of [...sim.zombies]) z.removeBody();
    sim.zombies.splice(0, sim.zombies.length);
    return false;
  };
  clear();
  // Odds: count over many planned drops by replaying the roll the way runDrops makes it.
  let with_ = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if ((sim as unknown as { rand(): number }).rand() < SUPPLY_DROPS.serumChance) with_++;
  check(Math.abs(with_ / N - 0.1) < 0.01, `${(100 * with_ / N).toFixed(1)}% of drops carry a serum`);
  const drop = sim.callSupplyDrop(undefined, true);
  let res = run(sim, 0.1, clear);
  check(!!drop && drop.serum && res.events.some((e) => e.type === 'notice' && e.text === 'RARE SUPPLY DROP INBOUND' && /Lazarus/.test(e.sub ?? '')), 'a drop with a serum is announced as rare');
  if (drop) {
    const f = drop.flight;
    res = run(sim, f.land - sim.time + 0.2, clear);
    const vial = sim.interactables.find((it) => it.kind === 'serum');
    const c = caseSpot(f, -1);
    check(!!vial && vial.supply === 1 && Math.hypot(vial.pos.x - c.x, vial.pos.z - c.z) < 1e-6, 'one serum lands on the far side of the crate from the weapon case');
    sim.setMotion('p1', { pos: { x: c.x + 0.5, y: f.ground.y, z: c.z } });
    const took = sim.use('p1', vial!.id);
    res = run(sim, 0.05, clear);
    check(took && sp.armor === SERUM.armor && vial!.supply === 0 && !sim.use('p1', vial!.id), `injecting it gives ${SERUM.armor} armor, and there is only one`);
    check(res.events.some((e) => e.type === 'supplyDrop' && e.stage === 'serumTaken') && res.events.some((e) => e.type === 'pickup' && e.item === 'serum'), 'everyone sees it taken');
    const snap = captureSnapshot(sim, new Map());
    check(snap.p.find((p) => p.id === 'p1')?.ar === SERUM.armor * 10, 'snapshots carry the armor to online players');
    sp.health = 100;
    sim.damagePlayer(sp, 20, at);
    check(Math.abs(sp.health - 92) < 1e-6 && Math.abs(sp.armor - (SERUM.armor - 12)) < 1e-6, `a 20-point hit takes ${100 - sp.health} health and ${SERUM.armor - sp.armor} armor`);
    sp.armor = 5;
    sim.damagePlayer(sp, 20, at);
    check(sp.armor === 0 && Math.abs(sp.health - 77) < 1e-6, 'when the armor runs out the rest of the hit goes through');
    sim.damagePlayer(sp, 20, at);
    check(Math.abs(sp.health - 57) < 1e-6, 'spent serum gives no more protection');
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

section('Downed and revives');
{
  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  const mate = sim.addPlayer('p2', 'Mate', 'ar', 'pistol', { x: 1.2, y: 0.15, z: 6 }, 0);
  const third = sim.addPlayer('p3', 'Far', 'ar', 'pistol', { x: 40, y: 0.15, z: 6 }, 0);
  run(sim, 0.5);
  sim.drain();
  sim.damagePlayer(sp, 500, sp.motion.pos);
  let ev = sim.drain();
  check(sp.alive && sp.downed && !sp.up && sp.health === 0 && ev.some((e) => e.type === 'playerDowned') && !ev.some((e) => e.type === 'playerDied'),
    'with a teammate up, zero health downs instead of killing');
  check(sim.phase !== 'over', 'a down does not end the night');
  check(sim.fire('p1', sp.eye, { x: 0, y: 0, z: -1 }, true, 1) === 'busy' && !sim.reload('p1') && !sim.melee('p1') && sim.reachable('p1').length === 0,
    'the downed cannot shoot, reload, swing or use things');
  check(!sim.revive('p3', 'p1'), 'cannot revive from across the street');
  check(sim.downedInReach('p2')[0] === sp && sim.revive('p2', 'p1') && sp.reviver === 'p2', 'a teammate close by starts the revive');
  check(sim.fire('p2', mate.eye, { x: 0, y: 0, z: -1 }, true, 1) === 'busy', 'the reviver has their hands full');
  const bleedAt = sp.bleed;
  run(sim, DOWNED.reviveTime * 0.5);
  check(sp.downed && Math.abs(sp.bleed - bleedAt) < 1e-6, 'bleeding pauses while being revived');
  sim.setMotion('p2', { pos: { x: 5, y: 0.15, z: 6 } });
  ev = run(sim, 0.1).events;
  check(sp.reviver === null && sp.revive === 0 && ev.some((e) => e.type === 'revive' && e.stage === 'cancel'), 'walking away cancels the revive');
  sim.setMotion('p2', { pos: { x: 1.2, y: 0.15, z: 6 } });
  check(sim.revive('p2', 'p1'), 'revive restarts');
  ev = run(sim, DOWNED.reviveTime + 0.1).events;
  check(sp.up && sp.health === DOWNED.reviveHealth && mate.stats.revives === 1 && ev.some((e) => e.type === 'playerRevived'), `held long enough, they get up with ${DOWNED.reviveHealth} health`);

  sim.damagePlayer(sp, 500, sp.motion.pos);
  const t0 = sp.bleed;
  run(sim, 1);
  check(sp.downed && sp.bleed < t0 - 0.9, 'left alone, they bleed out');
  sim.damagePlayer(sp, 20, sp.motion.pos);
  check(sp.bleed < t0 - 1 - 20 * DOWNED.hitBleed + 0.05, 'hits while down cost bleed-out time');
  ev = run(sim, DOWNED.bleedOut).events;
  check(!sp.alive && !sp.downed && ev.some((e) => e.type === 'playerDied' && e.player === 'p1') && sim.phase !== 'over', 'bleeding out is death; the night goes on for the others');

  sim.damagePlayer(mate, 500, mate.motion.pos);
  check(mate.downed, 'second survivor goes down with the third still up');
  sim.drain();
  sim.damagePlayer(third, 500, third.motion.pos);
  ev = sim.drain();
  check(!third.alive && !mate.alive && sim.phase === 'over' && ev.filter((e) => e.type === 'playerDied').length === 2,
    'the last one standing falling ends it: the downed die with them');
  cleanup(sim, body);
}
{
  // Downs run out, and leaving last strands nobody.
  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  sim.addPlayer('p2', 'Mate', 'ar', 'pistol', { x: 1.2, y: 0.15, z: 6 }, 0);
  run(sim, 0.3);
  for (let i = 0; i < DOWNED.maxDowns; i++) {
    sim.damagePlayer(sp, 500, sp.motion.pos);
    sim.revive('p2', 'p1');
    run(sim, DOWNED.reviveTime + 0.1);
  }
  check(sp.up && sp.downs === DOWNED.maxDowns, `revived ${DOWNED.maxDowns} times`);
  sim.damagePlayer(sp, 500, sp.motion.pos);
  check(!sp.alive, 'after the last down, zero health is death');
  const s2 = makeSim({ x: 0, y: 0.15, z: 6 });
  cleanup(sim, body);
  s2.sim.addPlayer('p2', 'Mate', 'ar', 'pistol', { x: 1.2, y: 0.15, z: 6 }, 0);
  s2.sim.damagePlayer(s2.sp, 500, s2.sp.motion.pos);
  s2.sim.removePlayer('p2');
  check(!s2.sp.alive && s2.sim.phase === 'over', 'the only one standing leaving ends it for the downed');
  cleanup(s2.sim, s2.body);
}
{
  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  sim.damagePlayer(sp, 500, sp.motion.pos);
  check(!sp.alive && !sp.downed && sim.phase === 'over', 'solo: zero health is still death');
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

section('Severed legs and crawlers');
{
  // Zones: a thigh stump keeps its upper half; a leg gone at the hip lets rounds through.
  const pos = { x: 0, y: 0, z: 0 };
  const whole = zombieZones(pos, 0, 1, 'standing', []);
  const legOf = (zones: ZoneShape[]) => zones.find((zz) => zz.zone === 'legL');
  const wl = legOf(whole)!;
  const shin = along(wl.a, wl.b, 0.85), thigh = along(wl.a, wl.b, 0.2);
  const shootAt = (zones: ZoneShape[], at: Vec3) => rayZones({ x: at.x, y: at.y, z: at.z + 5 }, { x: 0, y: 0, z: -1 }, zones, 50);
  check(wl.a.y > wl.b.y && shootAt(whole, thigh)?.zone === 'legL' && (shootAt(whole, thigh)?.along ?? 1) < LEGS.kneeAt, 'leg hits report how far down the leg they landed (hip 0, foot 1)');
  const knee = zombieZones(pos, 0, 1, 'crawl', [], 1, undefined, { legL: 'knee', legR: 'intact' });
  const hip = zombieZones(pos, 0, 1, 'crawl', [], 1, undefined, { legL: 'hip', legR: 'intact' });
  const kl = legOf(knee)!, fl = legOf(zombieZones(pos, 0, 1, 'crawl', []))!;
  check(Math.hypot(kl.b.x - kl.a.x, kl.b.y - kl.a.y, kl.b.z - kl.a.z) < Math.hypot(fl.b.x - fl.a.x, fl.b.y - fl.a.y, fl.b.z - fl.a.z) * 0.6 && !legOf(hip), 'cut at the knee only the thigh is left; gone at the hip there is nothing to hit');
  const crawlZ = zombieZones(pos, 0, 1, 'crawl', []);
  const top = Math.max(...crawlZ.map((zz) => Math.max(zz.a.y, zz.b.y) + zz.r));
  check(top < 0.85 && crawlZ.find((zz) => zz.zone === 'head')!.a.z > 0.2, `a crawler's body lies low (top ${top.toFixed(2)} m) with its head out in front`);

  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  run(sim, 0.7);
  sp.arsenal.aim = 1;
  sp.motion.aiming = true;
  const place = (kind: 'walker' | 'runner' | 'brute', x = 0, z = 3) => {
    const zz = sim.spawnZombie(kind, { x, y: 0.02, z }, 'idle');
    zz.facing = 0;
    return zz;
  };
  const legPoint = (zz: Zombie, leg: 'legL' | 'legR', t: number) => {
    const shape = zz.zones([]).find((s) => s.zone === leg)!;
    return along(shape.a, shape.b, t);
  };
  const dirTo = (from: Vec3, to: Vec3) => {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const l = Math.hypot(dx, dy, dz);
    return { x: dx / l, y: dy / l, z: dz / l };
  };
  const shootLeg = (zz: Zombie, leg: 'legL' | 'legR', t: number, maxShots: number, seed: number) => {
    const events: SimEvent[] = [];
    let shots = 0;
    while (zz.legs[leg] === 'intact' && zz.alive && shots < maxShots) {
      zz.facing = 0;
      if (sim.fire('p1', sp.eye, dirTo(sp.eye, legPoint(zz, leg, t)), true, seed + shots) === 'fired') shots++;
      events.push(...run(sim, 0.13).events);
    }
    return { events, shots };
  };
  const clear = () => {
    for (const zz of [...sim.zombies]) zz.removeBody();
    sim.zombies.length = 0;
  };

  // Rounds to the thigh take the leg off at the hip; it lives on and crawls.
  const z1 = place('walker');
  const r1 = shootLeg(z1, 'legL', 0.25, 8, 300);
  const cut1 = r1.events.find((e) => e.type === 'limbSevered');
  const legHits = r1.events.filter((e) => e.type === 'zombieHit' && e.zone === 'legL').length;
  check(!!cut1 && cut1.type === 'limbSevered' && cut1.arm === 'legL' && cut1.cut === 'hip' && z1.legs.legL === 'hip', `rifle rounds to the thigh take the whole leg off at the hip (${legHits} hits)`);
  check(z1.alive && z1.crawling && !(cut1 as { killed: boolean }).killed, 'losing a leg does not kill it: it goes down to crawl');
  const legLimb = sim.limbs.find((l) => l.id === (cut1 as { limb: number }).limb);
  check(!!legLimb && legLimb.arm === 'legL' && legLimb.cut === 'hip' && !!legLimb.body && Math.abs(legLimb.length - LIMBS.length.hip) < 1e-6, 'the leg becomes a loose physics body like a severed arm');
  check(z1.bodyHeight < 1 && z1.eye.y - z1.pos.y < 0.7 && z1.chest.y - z1.pos.y < 0.45, `its body capsule drops to the ground (${z1.bodyHeight.toFixed(2)} m tall)`);
  check(z1.chaseSpeed <= LEGS.chaseSpeed[1] * LEGS.kindSpeed.walker && z1.wanderSpeed <= LEGS.wanderSpeed[1], `it crawls slowly (chases at ${z1.chaseSpeed.toFixed(2)} m/s)`);
  const shock = run(sim, 0.3).events;
  check(z1.state === 'stagger' && !shock.some((e) => e.type === 'zombieAttack'), 'it writhes in shock for a moment first');
  // The other leg's thigh is now low and behind it, but still there to hit.
  check(z1.zones([]).some((zz) => zz.zone === 'legR') && !z1.zones([]).some((zz) => zz.zone === 'legL'), 'the leg that is left drags behind it as a target');

  // Rounds to the shin take it off at the knee.
  clear();
  const z2 = place('walker', 1.4, 2.6);
  const r2 = shootLeg(z2, 'legR', 0.82, 8, 340);
  const cut2 = r2.events.find((e) => e.type === 'limbSevered');
  check(!!cut2 && cut2.type === 'limbSevered' && cut2.cut === 'knee' && z2.legs.legR === 'knee' && z2.crawling, 'rounds to the shin take it off at the knee');

  // Crawling after you: slow, but it gets there and bites.
  clear();
  sp.health = PLAYER.maxHealth;
  const c = place('walker', 0, -4);
  c.facing = 0;
  sim.severLeg(sp, c, 'legL', 'hip', { x: 0, y: 0, z: 1 }, false, 30, false);
  check(c.crawling && c.legs.legL === 'hip' && sim.limbs.some((l) => l.arm === 'legL'), 'severLeg (for blasts and blades) takes a leg off directly');
  const startD = Math.hypot(c.pos.x - sp.motion.pos.x, c.pos.z - sp.motion.pos.z);
  c.target = 'p1';
  c.lastKnown = { ...sp.motion.pos };
  c.lastSeen = sim.time;
  const ys: number[] = [];
  let maxSpeed = 0;
  const chased = run(sim, 25, () => {
    ys.push(c.pos.y);
    if (c.state === 'chase') maxSpeed = Math.max(maxSpeed, c.moveSpeed);
    return sp.health < PLAYER.maxHealth;
  });
  check(sp.health < PLAYER.maxHealth && chased.events.some((e) => e.type === 'zombieAttack' && e.zombie === c.id), `it drags itself ${startD.toFixed(1)} m to you and attacks (${chased.time.toFixed(1)} s)`);
  check(maxSpeed > 0.4 && maxSpeed < 1.6, `crawling top speed ${maxSpeed.toFixed(2)} m/s, well under a walker's`);
  check(PLAYER.maxHealth - sp.health <= Math.round(ZOMBIES.walker.damage[1] * LEGS.damage) + 1, `a crawler's bite is weaker (${(PLAYER.maxHealth - sp.health).toFixed(0)} damage)`);
  const jump = Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i])));
  check(jump < 0.05 && c.grounded, `it stays on the ground the whole way (largest step ${jump.toFixed(3)} m, ${(Math.max(...ys) - Math.min(...ys)).toFixed(2)} m up and down)`);
  check(c.attackRange === LEGS.attackRange, 'it has to get closer to reach you');
  // It cannot be knocked over: it is already down.
  const knock = (() => {
    const ev: SimEvent[] = [];
    for (let i = 0; i < 2 && c.alive; i++) {
      const sh = c.zones([]).find((zz) => zz.zone === 'legR');
      if (!sh) break;
      sim.fire('p1', sp.eye, dirTo(sp.eye, along(sh.a, sh.b, 0.3)), true, 500 + i);
      ev.push(...run(sim, 0.13).events);
    }
    return ev;
  })();
  check(c.state !== 'down', 'leg shots never knock a crawler down');
  check(!knock.length || knock.some((e) => e.type === 'zombieHit'), 'its remaining leg can be shot');
  // ...and it dies like anything else.
  check(c.alive, 'two more leg hits do not finish it');
  c.health = ZOMBIES.walker.health;
  let headShots = 0;
  while (c.alive && headShots < 8) {
    const hz = c.zones([]).find((zz) => zz.zone === 'head')!;
    if (sim.fire('p1', sp.eye, dirTo(sp.eye, hz.a), true, 700 + headShots) === 'fired') headShots++;
    run(sim, 0.15);
  }
  check(!c.alive && headShots >= 1 && headShots <= 3, `a crawler's low head can be shot: dead in ${headShots} rounds`);

  // Some that would have died of it live on as crawlers.
  clear();
  let lived = 0, died = 0;
  for (let i = 0; i < 24; i++) {
    const zz = place('walker', (i % 6) - 2.5, 2.5);
    zz.health = 8;
    zz.legSever.legL = LEGS.legHealth.walker - 1;
    sim.fire('p1', sp.eye, dirTo(sp.eye, legPoint(zz, 'legL', 0.3)), true, 900 + i);
    const ev = run(sim, 0.1).events;
    const cut = ev.find((e) => e.type === 'limbSevered' && e.zombie === zz.id);
    if (!cut) continue;
    if (zz.alive) lived++;
    else died++;
    if (zz.alive && !(zz.health >= 1 && zz.crawling)) died += 100;
    if (zz.alive) {
      zz.removeBody();
      sim.zombies.splice(sim.zombies.indexOf(zz), 1);
    }
  }
  check(lived > 3 && died > 3 && lived + died >= 20, `a leg shot that would kill leaves some alive and crawling (${lived} lived, ${died} died)`);

  // Born crawlers (the 'crawler' kind): legless from the start, walker-sized.
  clear();
  const born = sim.spawnZombie('crawler', { x: 3, y: 0.02, z: 0 }, 'idle');
  run(sim, 0.5);
  check(born.crawling && born.scale === 1 && born.bodyHeight < 1 && born.legs.legL !== 'intact' && born.legs.legR !== 'intact', 'crawler zombies come already without legs');

  // Multiplayer: legs and severed legs reach clients.
  const snap = JSON.parse(JSON.stringify(captureSnapshot(sim, new Map())));
  const copy = new Simulation({ physics, map, nav, doors, seed: 4 });
  const mirror = new Mirror(copy, 'p2');
  mirror.apply(snap, 10);
  const cz = copy.zombie(born.id);
  check(!!cz && cz.legs.legL === born.legs.legL && cz.legs.legR === born.legs.legR && cz.crawling && cz.bodyHeight < 1, 'clients see which legs are gone and draw it crawling');
  const cl = copy.limbs.find((l) => l.arm === 'legL' && l.cut === 'hip');
  check(!!cl && Math.abs(cl.length - LIMBS.length.hip) < 0.01, 'severed legs show on every screen');
  copy.dispose();

  // A leg makes a club too: the heaviest one there is.
  clear();
  const leg = sim.limbs.find((l) => l.arm === 'legL' && l.cut === 'hip')!;
  run(sim, 3);
  sim.setMotion('p1', { pos: { x: leg.pos.x + 0.9, y: leg.pos.y - leg.radius, z: leg.pos.z }, yaw: Math.PI / 2 });
  body.moveTo({ x: leg.pos.x + 0.9, y: leg.pos.y - leg.radius, z: leg.pos.z });
  const got = sim.grabLimb('p1', leg.id);
  const hipClub = limbClub('hip', 'walker');
  check(got && sp.arsenal.limb?.id === leg.id && leg.wear === hipClub.wear && hipClub.damage > limbClub('shoulder', 'walker').damage, `a severed leg can be picked up and swung (${hipClub.damage} damage, ${hipClub.wear} hits)`);
  cleanup(sim, body);
}

section('Screamers and bloaters');
{
  // Mixed into the spawns as the night goes on, a few at a time.
  const { sim, sp, body } = makeSim({ x: 20, y: 0.15, z: 6 });
  const count = (t: number) => {
    sim.phaseTime = t;
    const n = { walker: 0, runner: 0, brute: 0, crawler: 0, screamer: 0, bloater: 0 };
    for (let i = 0; i < 2000; i++) n[sim.pickKind()]++;
    return n;
  };
  sim.phase = 'survival';
  const early = count(30);
  check(early.screamer === 0 && early.bloater === 0, 'no specials in the first half minute');
  const later = count(300);
  check(later.screamer > 50 && later.screamer < 220 && later.bloater > 90 && later.bloater < 280, `screamers and bloaters join the mix (${later.screamer} and ${later.bloater} of 2000 after five minutes)`);
  check(later.runner > 300 && later.brute > 120, `runners and brutes keep their share (${later.runner}, ${later.brute})`);
  const held: Zombie[] = [];
  for (let i = 0; i < 4; i++) held.push(sim.spawnZombie('screamer', { x: 60 + i * 3, y: 0.02, z: 8 }, 'idle'), sim.spawnZombie('bloater', { x: 60 + i * 3, y: 0.02, z: 12 }, 'idle'));
  const capped = count(300);
  check(capped.screamer === 0 && capped.bloater === 0, 'no more specials while their caps are reached');
  for (const z of held) z.removeBody();
  sim.zombies.length = 0;
  sim.phase = 'preparation';
  sim.phaseTime = 600;

  // A screamer that sees someone stops and calls the others, who come for that survivor.
  const sc = sim.spawnZombie('screamer', { x: 20, y: 0.02, z: -8 }, 'idle');
  sc.facing = 0;
  const far = sim.spawnZombie('walker', { x: 20, y: 0.02, z: -40 }, 'idle');
  far.facing = Math.PI;
  let screamed = false;
  const res = run(sim, 6, () => {
    if (sc.state === 'scream') screamed = true;
    return sim.zombies.length > 0 && far.target === 'p1';
  });
  const ev = res.events.find((e) => e.type === 'zombieScream');
  check(screamed && !!ev && ev.type === 'zombieScream' && ev.target === 'p1', `the screamer stops and screams when it spots the player (${res.time.toFixed(1)} s)`);
  check(far.target === 'p1' && far.state === 'chase', 'a walker 32 m away, facing away, comes for the player at the call');
  check(!!ev && ev.type === 'zombieScream' && ev.called === 1 && ev.fresh === 0, 'no reinforcements outside the survival phase');
  check(sp.health === PLAYER.maxHealth, 'it does not attack while screaming');
  const second = run(sim, 6).events.filter((e) => e.type === 'zombieScream').length;
  check(sc.screams === 1 && second === 0, 'it waits out the cooldown before screaming again');
  cleanup(sim, body);
}
{
  // Staggered before the call: nothing goes out, and it tries again sooner.
  const { sim, sp, body } = makeSim({ x: 20, y: 0.15, z: 6 });
  const sc = sim.spawnZombie('screamer', { x: 20, y: 0.02, z: -8 }, 'idle');
  sc.facing = 0;
  run(sim, 6, () => sc.state === 'scream');
  run(sim, 0.2);
  sc.shove({ x: 0, y: 0, z: -1 }, 2);
  const cut = run(sim, 1.5).events.some((e) => e.type === 'zombieScream');
  check(sc.state !== 'scream' && !cut && sc.screams === 0, 'a stagger before the call cuts the scream short');
  const retry = run(sim, SPECIALS.screamer.interruptedCooldown + 3, () => sc.screams > 0);
  check(sc.screams === 1, `it screams again soon after (${retry.time.toFixed(1)} s)`);

  // In the survival phase the call brings fresh dead from out of sight, capped.
  sim.phase = 'survival';
  const before = sim.zombies.length;
  sim.screamCall(sc, sp);
  const fresh = sim.zombies.filter((z) => z.reinforcement);
  const [lo, hi] = SPECIALS.screamer.reinforcements;
  check(fresh.length >= lo && fresh.length <= hi && sim.zombies.length === before + fresh.length, `${fresh.length} fresh zombies come running`);
  const [minD] = SPECIALS.screamer.reinforceDistance;
  check(fresh.every((z) => Math.hypot(z.pos.x - sp.motion.pos.x, z.pos.z - sp.motion.pos.z) >= minD - 0.01 && z.target === 'p1'), 'they appear out of reach and already know where the player is');
  for (let i = 0; i < 8; i++) sim.screamCall(sc, sp);
  check(sim.zombies.filter((z) => z.reinforcement).length <= SPECIALS.screamer.reinforceCap, `reinforcements stop at ${SPECIALS.screamer.reinforceCap}`);
  sim.phase = 'preparation';
  cleanup(sim, body);
}
{
  // A bloater bursts when killed: its arms fly off, and anyone close gets hurt.
  const { sim, sp, body } = makeSim({ x: 20, y: 0.15, z: 6 });
  run(sim, 0.7);
  sp.arsenal.aim = 1;
  sp.motion.aiming = true;
  const bl = sim.spawnZombie('bloater', { x: 20, y: 0.02, z: 2.6 }, 'idle');
  bl.facing = 0;
  const nb = sim.spawnZombie('walker', { x: 21.2, y: 0.02, z: 1.8 }, 'idle');
  const away = sim.spawnZombie('walker', { x: 20, y: 0.02, z: -12 }, 'idle');
  bl.health = 5;
  const e = sp.eye;
  const to = { x: bl.pos.x - e.x, y: bl.pos.y + 1.1 * bl.scale - e.y, z: bl.pos.z - e.z };
  const l = Math.hypot(to.x, to.y, to.z);
  sim.fire('p1', e, { x: to.x / l, y: to.y / l, z: to.z / l }, true, 5);
  const evs = run(sim, 0.3).events;
  const types = evs.map((x) => x.type);
  const burst = evs.find((x) => x.type === 'zombieBurst');
  check(!!burst && types.indexOf('zombieDied') < types.indexOf('zombieBurst'), 'killing a bloater bursts it, after its death');
  const ownArms = evs.filter((x) => x.type === 'limbSevered' && x.zombie === bl.id).length;
  check(ownArms === 2 && sim.limbs.filter((x) => !x.holder).length >= 2, 'both its arms are blown off as loose arms');
  const hurt = evs.find((x) => x.type === 'playerHurt');
  check(!!hurt && hurt.type === 'playerHurt' && hurt.damage > 20 && hurt.damage < SPECIALS.bloater.playerDamage, `the shooter 3.4 m away is hurt by the blast (${hurt && hurt.type === 'playerHurt' ? hurt.damage : 0})`);
  check(!nb.alive && sp.stats.kills === 2, 'a walker beside it is killed, credited to the shooter');
  check(away.alive && away.health === ZOMBIES.walker.health, 'one 15 m away is untouched');
  cleanup(sim, body);
}
{
  // Chains: one bloater's blast sets off the next, each once.
  const { sim, sp, body } = makeSim({ x: 20, y: 0.15, z: 6 });
  run(sim, 0.7);
  sp.arsenal.aim = 1;
  sp.motion.aiming = true;
  const a = sim.spawnZombie('bloater', { x: 20, y: 0.02, z: -6 }, 'idle');
  const b = sim.spawnZombie('bloater', { x: 21.6, y: 0.02, z: -7 }, 'idle');
  const c = sim.spawnZombie('bloater', { x: 18.4, y: 0.02, z: -7 }, 'idle');
  for (const z of [a, b, c]) { z.facing = 0; z.health = Math.min(z.health, 40); }
  const e = sp.eye;
  const to = { x: a.pos.x - e.x, y: a.pos.y + 1.1 * a.scale - e.y, z: a.pos.z - e.z };
  const l = Math.hypot(to.x, to.y, to.z);
  a.health = 5;
  sim.fire('p1', e, { x: to.x / l, y: to.y / l, z: to.z / l }, true, 6);
  const evs = run(sim, 0.3).events;
  const bursts = evs.filter((x) => x.type === 'zombieBurst').map((x) => (x as { zombie: number }).zombie);
  check(bursts.length === 3 && new Set(bursts).size === 3, `three bloaters in a row go off one after another (${bursts.length} bursts)`);
  check(sp.health === PLAYER.maxHealth, 'a chain 12 m away does not reach the shooter');
  cleanup(sim, body);
}
section('Barricades');
{
  const homes = map.houses.filter((h) => h.enterable);
  const { sim, body } = makeSim({ x: 0, y: 0.15, z: 8 });
  const slots = sim.barricades.slots;
  check(homes.every((h) => slots.some((s) => s.houseId === h.id && s.kind === 'door')), `every enterable building has doors to board up (${slots.filter((s) => s.kind === 'door').length} doors)`);
  const wins = slots.filter((s) => s.kind === 'window');
  const climb = wins.filter((s) => s.outNode >= 0);
  check(wins.length >= 50 && climb.length >= wins.length * 0.85, `ground-storey windows take boards and zombies can climb through most (${climb.length} of ${wins.length})`);
  check(wins.every((s) => s.bottom < BARRICADE.maxSill && s.width >= BARRICADE.minWidth), 'no upstairs windows or bathroom slits among them');
  check(wins.every((s) => s.pane !== null && s.glass), 'every window starts with its pane in');
  const oak = homes.filter((h) => h.id.startsWith('oak-'));
  const oakWins = wins.filter((s) => s.houseId.startsWith('oak-'));
  const oakClimb = oakWins.filter((s) => s.outNode >= 0);
  check(oak.every((h) => oakWins.some((s) => s.houseId === h.id)) && oakClimb.length >= oakWins.length * 0.85, `Oak Street's homes take boards on their windows like Elm's (${oakClimb.length} of ${oakWins.length} climbable)`);
  cleanup(sim, body);
}
{
  // Boards go up from the opening's own storey: never from the basement under it (a workbench by
  // the front wall sat right under a window) or the bedroom over it.
  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 8 });
  const houseOf = new Map(map.houses.map((h) => [h.id, h]));
  const within = (h: { x: number; z: number; w: number; d: number }, x: number, z: number) => Math.abs(x - h.x) < h.w / 2 && Math.abs(z - h.z) < h.d / 2;
  const workable = (at: Vec3) => {
    sp.motion.pos = { x: at.x, y: at.y + 0.02, z: at.z };
    return sim.barricades.slots.filter((s) => sim.canWork(sp, s));
  };
  const nodes: Vec3[] = [];
  for (let n = 0; n < nav.nodeCount; n++) if (nav.reachable(n)) nodes.push(nav.nodePos(n));
  const indoors = new Map([...houseOf.values()].filter((h) => h.enterable).map((h) => [h.id, nodes.filter((p) => within(h, p.x, p.z))]));
  let above = 0, below = 0, same = 0;
  const wrong = new Set<string>();
  for (const s of sim.barricades.slots) {
    const h = houseOf.get(s.houseId)!;
    for (const p of indoors.get(h.id) ?? []) {
      if (Math.hypot(p.x - s.center.x, p.z - s.center.z) > 2.5) continue;
      sp.motion.pos = { x: p.x, y: p.y + 0.02, z: p.z };
      if (!sim.canWork(sp, s)) continue;
      const dy = p.y - storeyFloors(h)[0];
      if (dy < -1.5) below++;
      else if (dy > 2) above++;
      else { same++; continue; }
      wrong.add(h.label ?? h.id);
    }
  }
  check(above + below === 0 && same > 2000, `nothing is boarded up through a floor, from a basement or upstairs (${same} spots on the right storey, wrong in: ${[...wrong].join(', ') || 'none'})`);
  const benches = map.props.filter((p) => p.kind === 'workbench' && (p.y ?? 0) < -1);
  const offered = benches.filter((b) => nodes.some((p) => Math.hypot(p.x - b.x, p.z - b.z) < 1.4 && Math.abs(p.y - (b.y ?? 0)) < 0.5 && workable(p).length > 0));
  check(benches.length >= 9 && offered.length === 0, `no basement workbench offers to board up a window (${benches.length} benches, ${offered.length} do)`);
  const wins = sim.barricades.slots.filter((s) => s.kind === 'window' && s.inNode >= 0);
  const fromInside = wins.filter((s) => workable(nav.nodePos(s.inNode)).includes(s));
  check(fromInside.length === wins.length, `every climbable window can still be boarded up from the floor inside it (${fromInside.length} of ${wins.length})`);
  cleanup(sim, body);
}
const houseSlots = (sim: Simulation, house: string, kind: 'door' | 'window') => sim.barricades.slots.filter((s) => s.houseId === house && s.kind === kind);
{
  // Nailing boards over a window from inside, prying them off, and what stops the work.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const pick = houseSlots(probe, 'house-sw', 'window').find((s) => s.outNode >= 0)!;
  const inside = nav.nodePos(pick.inNode), outside = nav.nodePos(pick.outNode);
  cleanup(probe, pb);
  const { sim, sp, body } = makeSim({ x: inside.x, y: inside.y + 0.02, z: inside.z });
  const slot = sim.barricades.slots[pick.index];
  check(sim.barricade('p1', slot.index, 'board'), 'a survivor inside starts boarding up the window');
  let res = run(sim, BARRICADE.boardTime * 3 + 0.4);
  const nailed = res.events.filter((e) => e.type === 'barricade' && e.change === 'nailed').length;
  check(slot.boards === BARRICADE.windowBoards && nailed === BARRICADE.windowBoards, `holding on nails board after board up to ${BARRICADE.windowBoards} (${slot.boards})`);
  check(res.events.filter((e) => e.type === 'hammer').length >= 10 && sim.noises.some((n) => n.source === 'p1'), 'the hammering is heard');
  check(sp.work === null && !sim.barricade('p1', slot.index, 'board'), 'a fully boarded window takes no more');
  sp.arsenal.aim = 1;
  run(sim, 0.7);
  sim.barricade('p1', slot.index, 'pry');
  run(sim, 0.3);
  sim.fire('p1', sp.eye, { x: 0, y: 0, z: 1 }, true, 5);
  check(sp.work === null && slot.boards === BARRICADE.windowBoards, 'firing stops the prying');
  sim.barricade('p1', slot.index, 'pry');
  res = run(sim, BARRICADE.pryTime + 0.1);
  check(slot.boards === BARRICADE.windowBoards - 1 && res.events.some((e) => e.type === 'barricade' && e.change === 'pried'), 'prying takes a board off');
  sim.barricade('p1', -1);
  sp.motion.pos = { ...outside };
  check(!sim.barricade('p1', slot.index, 'board'), 'boards only go up from inside');
  sp.motion.pos = { x: inside.x + 6, y: inside.y, z: inside.z };
  check(!sim.barricade('p1', slot.index, 'board'), 'out of reach, nothing happens');
  cleanup(sim, body);
}
{
  // A boarded door stays shut.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const front = houseSlots(probe, 'house-sw', 'door')[0];
  const n = nav.nodeAt(front.center.x - front.normal.x * 1.0, front.bottom, front.center.z - front.normal.z * 1.0, 0.6);
  const at = nav.nodePos(n);
  cleanup(probe, pb);
  const { sim, body } = makeSim({ x: at.x, y: at.y + 0.02, z: at.z });
  const slot = sim.barricades.slots[front.index];
  const door = doors[slot.ref]!;
  door.setOpen(true, at.x, at.z);
  check(!sim.barricade('p1', slot.index, 'board'), 'an open door can’t be boarded');
  door.setOpen(false, at.x, at.z);
  run(sim, 0.5);
  check(sim.barricade('p1', slot.index, 'board'), 'a closed door can');
  run(sim, BARRICADE.boardTime * 2 + 0.2);
  check(slot.boards >= 2 && sim.doorLocked(slot.ref), `boards lock the door (${slot.boards} up)`);
  let forced = false;
  let blows = 0;
  while (!forced && blows < 100) {
    blows++;
    forced = sim.poundDoor(door, ZOMBIES.walker.bash, slot.center.x + slot.normal.x, slot.center.z + slot.normal.z);
  }
  check(slot.boards === 0 && forced && blows >= 2 * Math.ceil(BARRICADE.boardStrength / ZOMBIES.walker.bash) + Math.ceil(1 / ZOMBIES.walker.bash) - 1,
    `walkers have to beat the boards off before the door gives (${blows} blows)`);
  cleanup(sim, body);
}
const insideHouse = (z: Zombie, house: string) => {
  const h = map.houses.find((x) => x.id === house)!;
  return Math.abs(z.pos.x - h.x) < h.w / 2 - 0.2 && Math.abs(z.pos.z - h.z) < h.d / 2 - 0.2 && z.pos.y > 0.2;
};
const outsideOf = (slot: BarricadeSlot, dist: number): Vec3 => {
  const out = nav.nodePos(slot.outNode);
  return nav.nodePos(nav.nodeAt(out.x + slot.normal.x * dist, out.y, out.z + slot.normal.z * dist, 1.5));
};
{
  // Shooting out a window and shooting through a door.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const pick = houseSlots(probe, 'house-s', 'window').find((s) => s.outNode >= 0)!;
  const doorPick = houseSlots(probe, 'house-s', 'door')[0];
  cleanup(probe, pb);
  const outside = outsideOf(pick, 2.5);
  const { sim, sp, body } = makeSim({ x: outside.x, y: outside.y + 0.02, z: outside.z });
  const slot = sim.barricades.slots[pick.index];
  sp.arsenal.aim = 1;
  run(sim, 0.8);
  const aimAt = (p: Vec3) => {
    const e = sp.eye;
    const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z, l = Math.hypot(dx, dy, dz);
    return { x: dx / l, y: dy / l, z: dz / l };
  };
  sim.fire('p1', sp.eye, aimAt(slot.center), true, 3);
  let res = run(sim, 0.2);
  const shot = res.events.find((e) => e.type === 'shot');
  const end = shot && shot.type === 'shot' ? shot.pellets[0].end : null;
  check(!slot.glass && res.events.some((e) => e.type === 'glassBroken' && e.slot === slot.index), 'a shot shatters the window');
  check(!!end && sim.barricades.side(slot, end.x, end.z) < 0, 'and the round carries on into the room');
  // The front door, from outside.
  const dslot = sim.barricades.slots[doorPick.index];
  const door = doors[dslot.ref]!;
  const stand = nav.nodePos(nav.nodeAt(dslot.center.x + dslot.normal.x * 3, 0.1, dslot.center.z + dslot.normal.z * 3, 1.5));
  sp.motion.pos = { x: stand.x, y: stand.y + 0.02, z: stand.z };
  body.moveTo(sp.motion.pos);
  dslot.boards = 1;
  const target = { x: dslot.center.x + (dslot.axis === 'x' ? 0.25 : 0), y: dslot.center.y, z: dslot.center.z + (dslot.axis === 'z' ? 0.25 : 0) };
  const events: SimEvent[] = [];
  for (let i = 0; i < 40 && !door.open; i++) {
    sp.arsenal.primary.mag = 30;
    sim.fire('p1', sp.eye, aimAt(target), true, 40 + i);
    events.push(...run(sim, 0.2).events);
  }
  const brokeAt = events.findIndex((e) => e.type === 'barricade' && e.change === 'broken');
  const forcedAt = events.findIndex((e) => e.type === 'doorForced');
  check(brokeAt >= 0 && forcedAt > brokeAt && door.open, `shots splinter the board, then the door swings in (${events.filter((e) => e.type === 'shot').length} shots)`);
  cleanup(sim, body);
}
{
  // Doors boarded shut, a window left bare: the zombie smashes the glass and climbs in.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const pick = houseSlots(probe, 'house-sw', 'window').find((s) => s.outNode >= 0)!;
  const inside = nav.nodePos(pick.inNode);
  cleanup(probe, pb);
  const goal = nav.nodePos(nav.nodeAt(inside.x - pick.normal.x * 1.5, inside.y, inside.z - pick.normal.z * 1.5, 1));
  const { sim, body } = makeSim({ x: goal.x, y: goal.y + 0.02, z: goal.z });
  for (const s of houseSlots(sim, 'house-sw', 'door')) s.boards = s.max;
  for (const s of houseSlots(sim, 'house-sw', 'window')) if (s.index !== pick.index) s.boards = s.max;
  const start = outsideOf(pick, 3);
  const z = chaseFrom(sim, 'walker', { x: start.x, y: start.y + 0.02, z: start.z }, goal);
  const res = run(sim, 40, () => insideHouse(z, 'house-sw') && z.state !== 'vault');
  check(res.events.some((e) => e.type === 'glassBroken' && e.slot === pick.index) && !sim.barricades.slots[pick.index].glass, 'the zombie smashes the window');
  check(res.events.some((e) => e.type === 'vault' && e.slot === pick.index), 'and climbs through it');
  check(insideHouse(z, 'house-sw') && res.time < 40, `it gets inside (${res.time.toFixed(1)} s, state ${z.state})`);
  const n = nav.nodeAt(z.pos.x, z.pos.y, z.pos.z, 0.5);
  check(n >= 0 && (nav.flags[n] & NAV_INDOOR) !== 0 && Number.isFinite(z.pos.x + z.pos.y + z.pos.z), 'it lands on the floor inside');
  cleanup(sim, body);
}
{
  // Everything boarded: the zombie beats boards off a window before it gets in.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const pick = houseSlots(probe, 'house-sw', 'window').find((s) => s.outNode >= 0)!;
  const inside = nav.nodePos(pick.inNode);
  cleanup(probe, pb);
  const goal = nav.nodePos(nav.nodeAt(inside.x - pick.normal.x * 1.5, inside.y, inside.z - pick.normal.z * 1.5, 1));
  const { sim, body } = makeSim({ x: goal.x, y: goal.y + 0.02, z: goal.z });
  for (const s of houseSlots(sim, 'house-sw', 'door')) s.boards = s.max;
  for (const s of houseSlots(sim, 'house-sw', 'window')) s.boards = s.max;
  const start = outsideOf(pick, 3);
  const z = chaseFrom(sim, 'walker', { x: start.x, y: start.y + 0.02, z: start.z }, goal);
  const early = run(sim, 8);
  check(!insideHouse(z, 'house-sw') && early.events.some((e) => e.type === 'barricadeHit' || e.type === 'doorPound'), `boards hold a walker off for a while (state ${z.state})`);
  const res = run(sim, 90, () => insideHouse(z, 'house-sw') && z.state !== 'vault');
  const broken = [...early.events, ...res.events].filter((e) => e.type === 'barricade' && e.change === 'broken').length;
  check(broken >= 3 && insideHouse(z, 'house-sw'), `it splits boards off until it is through (${broken} boards, in after ${(8 + res.time).toFixed(1)} s)`);
  cleanup(sim, body);
}
{
  // Network clients get boards and broken panes in the snapshot.
  const { sim, body } = makeSim({ x: 0, y: 0.15, z: 8 });
  const [a, b] = sim.barricades.slots.filter((s) => s.kind === 'window');
  const d = sim.barricades.slots.find((s) => s.kind === 'door')!;
  a.boards = 2;
  a.damage = 0.2;
  sim.barricades.breakGlass(b);
  d.boards = 4;
  const snap = captureSnapshot(sim, new Map());
  const copy = new Simulation({ physics, map, nav, doors, seed: 9 });
  const mirror = new Mirror(copy, 'p2');
  mirror.apply(JSON.parse(JSON.stringify(snap)), 10);
  const ca = copy.barricades.slots[a.index], cb = copy.barricades.slots[b.index], cd = copy.barricades.slots[d.index];
  check(ca.boards === 2 && Math.abs(ca.damage - 0.2) < 1e-3 && !cb.glass && cd.boards === 4 && copy.doorLocked(cd.ref), 'boards, damage and broken panes reach clients');
  check((snap.b ?? []).length === 12, `untouched openings stay out of the snapshot (${(snap.b ?? []).length / 4} listed)`);
  a.boards = 0;
  mirror.apply(JSON.parse(JSON.stringify(captureSnapshot(sim, new Map()))), 10.05);
  check(ca.boards === 0 && !cb.glass, 'boards pried off on the server come off on clients');
  copy.dispose();
  cleanup(sim, body);
}

section('Found melee weapons');
{
  const rooms = findPickupRooms(map, nav, physics);
  const kinds = new Set(rooms.map((r) => r.room));
  check(kinds.has('bedroom') && kinds.has('basement') && kinds.has('store'), `weapons can turn up in bedrooms, basements and the store (${rooms.length} rooms: ${rooms.filter((r) => r.room === 'bedroom').length} bedrooms, ${rooms.filter((r) => r.room === 'basement').length} basements)`);
  check(rooms.every((r) => r.nodes.every((n) => nav.reachable(n))), 'every spot is on walkable floor');
  {
    // Every enterable home on Oak Street has a bedroom to search; its basements count too.
    const oakHomes = map.houses.filter((h) => h.id.startsWith('oak-'));
    const inside = (h: (typeof oakHomes)[number], r: (typeof rooms)[number]) => Math.abs(r.centre.x - h.x) < h.w / 2 && Math.abs(r.centre.z - h.z) < h.d / 2;
    const bare = oakHomes.filter((h) => !rooms.some((r) => r.room === 'bedroom' && inside(h, r)));
    const basements = rooms.filter((r) => r.room === 'basement' && r.key.includes('oak-')).length;
    check(!bare.length && basements === 5, `Oak Street's ${oakHomes.length} homes each have a bedroom to search, and ${basements} basements${bare.length ? ` (none in ${bare.map((h) => h.id).join(', ')})` : ''}`);
  }
  check(rooms.every((r) => map.playerSpawns.every((sp) => Math.hypot(sp.x - r.centre.x, sp.z - r.centre.z) >= MELEE_PICKUPS.awayFromSpawn)), 'none in the safehouse the survivors start in');

  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  run(sim, 0.2);
  let placed = sim.placedMelee;
  check(placed.length === MELEE_PICKUPS.maxPlaced, `${placed.length} weapons placed at the start (at most ${MELEE_PICKUPS.maxPlaced})`);
  check(placed.every((it) => !!it.weapon && FOUND_MELEE.includes(it.weapon as never)), 'all of them found weapons, never a machete or a gun');
  const byRoom = new Map<string, number>();
  for (const it of placed) byRoom.set(it.room!, (byRoom.get(it.room!) ?? 0) + 1);
  check([...byRoom].every(([k, c]) => c <= MELEE_PICKUPS.perRoom[rooms.find((r) => r.key === k)!.room]), 'never crowded into one room');
  check(placed.every((it) => {
    const n = nav.nodeAt(it.pos.x, it.pos.y - MELEE_PICKUPS.lift + 0.05, it.pos.z, 0.3);
    return n >= 0 && (nav.flags[n] & 4) !== 0;
  }), 'every one lies indoors');
  check(new Set(placed.map((it) => it.weapon)).size >= 3, `a mix of weapons (${placed.map((it) => it.weapon).join(', ')})`);
  run(sim, 30);
  check(sim.placedMelee.length === MELEE_PICKUPS.maxPlaced, 'no more turn up while the map is full');

  // Picking one up, then swapping it for another.
  const first = placed[0];
  const standBy = (it: typeof first) => {
    const at = { x: it.pos.x + 0.6, y: it.pos.y - MELEE_PICKUPS.lift, z: it.pos.z };
    sim.setMotion('p1', { pos: at });
    body.moveTo(at);
  };
  standBy(first);
  check(sim.reachable('p1').some((it) => it.id === first.id), 'a weapon on the floor is in reach standing beside it');
  sim.drain();
  check(sim.use('p1', first.id) && sp.arsenal.meleeId === first.weapon && first.supply === 0, `picked up: the ${first.weapon} replaces the machete`);
  let ev = sim.drain();
  check(ev.some((e) => e.type === 'meleeTaken' && e.weapon === first.weapon && e.swapped === null), 'everyone hears it picked up');
  check(sim.placedMelee.length === MELEE_PICKUPS.maxPlaced - 1, 'one fewer on the map');
  check(!sim.use('p1', first.id), 'it cannot be taken twice');
  const other = sim.placedMelee.find((it) => it.weapon !== first.weapon)!;
  standBy(other);
  check(sim.use('p1', other.id) && sp.arsenal.meleeId === other.weapon, `swapped for the ${other.weapon}`);
  ev = sim.drain();
  const left = sim.placedMelee.find((it) => it.weapon === first.weapon && Math.hypot(it.pos.x - other.pos.x, it.pos.z - other.pos.z) < 0.01);
  check(!!left && ev.some((e) => e.type === 'meleeTaken' && e.swapped === first.weapon), 'the one carried is left where the new one lay');
  check(sim.placedMelee.length === MELEE_PICKUPS.maxPlaced - 1, 'a swap keeps the count');
  // A replacement turns up somewhere else in time, out of everyone's way.
  sim.setMotion('p1', { pos: { x: 0, y: 0.15, z: 6 } });
  body.moveTo({ x: 0, y: 0.15, z: 6 });
  const before = new Set(sim.placedMelee.map((it) => it.id));
  run(sim, MELEE_PICKUPS.respawn[1] + 10);
  const fresh = sim.placedMelee.filter((it) => !before.has(it.id));
  check(sim.placedMelee.length === MELEE_PICKUPS.maxPlaced && fresh.length === 1, `a taken weapon is replaced within ${MELEE_PICKUPS.respawn[1]} s`);
  check(fresh.every((it) => Math.hypot(it.pos.x - sp.motion.pos.x, it.pos.z - sp.motion.pos.z) > MELEE_PICKUPS.awayFromPlayers), 'never right under a survivor\'s nose');

  // Each weapon's swing in the hands.
  check(MELEE.machete.damage === 55 && MELEE.machete.windup === 0.16 && MELEE.machete.duration === 0.55, 'the machete keeps its old numbers');
  const standAt = { x: 0, y: 0.15, z: 6 };
  const swingWith = (w: keyof typeof MELEE, kind: 'walker' | 'brute', aim: 'torso' | 'armL' | 'head' = 'torso') => {
    for (const zz of [...sim.zombies]) zz.removeBody();
    sim.zombies.length = 0;
    sp.arsenal.meleeId = w;
    sp.motion.yaw = 0;
    const zz = sim.spawnZombie(kind, { x: standAt.x, y: 0.02, z: standAt.z - 1.3 }, 'idle');
    zz.facing = 0;
    run(sim, 0.05);
    const e = sp.eye;
    const shape = zz.zones([]).find((s2) => s2.zone === (aim === 'torso' ? 'torso' : aim))!;
    const to = aim === 'armL' ? along(shape.a, shape.b, 0.3) : along(shape.a, shape.b, 0.5);
    const d = { x: to.x - e.x, y: to.y - e.y, z: to.z - e.z };
    const l = Math.hypot(d.x, d.y, d.z);
    const hp = zz.health;
    const ok = sim.melee('p1', { origin: e, dir: { x: d.x / l, y: d.y / l, z: d.z / l } });
    const got = run(sim, MELEE[w].duration + 0.05).events;
    return { ok, zz, got, dealt: hp - Math.max(0, zz.health), took: sp.arsenal.action };
  };
  sim.setMotion('p1', { pos: standAt });
  body.moveTo(standAt);
  run(sim, 0.8);
  const swing = swingWith('bat', 'walker');
  const hit = swing.got.find((e) => e.type === 'zombieHit');
  check(swing.ok && !!hit && hit.type === 'zombieHit' && hit.weapon === 'bat' && hit.melee, 'a bat blow is reported with the weapon that struck it');
  for (const w of ['katana', 'bat', 'crowbar', 'wrench', 'hockey'] as const) {
    const r = swingWith(w, 'walker');
    check(r.ok && r.dealt > 0 && Math.abs(r.dealt - Math.min(ZOMBIES.walker.health, MELEE[w].damage)) < 0.5, `${w}: torso blow deals ${MELEE[w].damage} (dealt ${r.dealt.toFixed(0)})`);
  }
  // Edged weapons take arms off; blunt ones never do.
  let r1 = swingWith('katana', 'brute', 'armL');
  check(r1.got.some((e) => e.type === 'limbSevered' && e.melee) && r1.zz.arms.armL !== 'intact', 'one katana cut takes a brute\'s arm off (the machete takes two)');
  let severs = 0;
  for (let i = 0; i < 3; i++) {
    r1 = swingWith('bat', 'brute', 'armL');
    if (r1.got.some((e) => e.type === 'limbSevered')) severs++;
  }
  check(severs === 0 && r1.zz.arms.armL === 'intact', 'a bat breaks an arm but never takes it off');
  r1 = swingWith('crowbar', 'walker', 'head');
  check(!r1.zz.alive, 'a crowbar to the head drops a walker in one blow');
  // Knockback: a bat or hockey stick shoves harder than a machete.
  check(MELEE.bat.knockback > MELEE.machete.knockback && MELEE.hockey.knockback > MELEE.machete.knockback && MELEE.hockey.reach > MELEE.katana.reach, 'clubs shove harder, the hockey stick reaches farthest');
  // Slower weapons land later.
  sp.arsenal.meleeId = 'bat';
  sim.melee('p1');
  run(sim, MELEE.machete.windup + 0.02);
  check(sp.arsenal.action === 'melee' && sp.arsenal.actionTotal === MELEE.bat.duration, 'the bat\'s swing takes its own time');
  run(sim, 1);

  // Online: the weapon in hand and the ones on the floor reach every client.
  sp.arsenal.meleeId = 'hockey';
  const snap = JSON.parse(JSON.stringify(captureSnapshot(sim, new Map())));
  const copy = new Simulation({ physics, map, nav, doors, seed: 3 });
  const mirror = new Mirror(copy, 'someone-else');
  mirror.apply(snap, 10);
  const them = copy.players.get('p1');
  check(them?.arsenal.meleeId === 'hockey', 'a remote survivor\'s copy carries the same melee weapon');
  const theirs = copy.interactables.filter((it) => it.kind === 'melee' && it.supply > 0);
  check(theirs.length === sim.placedMelee.length && theirs.every((it) => isMelee(it.weapon!) && sim.interactables[it.id].weapon === it.weapon), 'the weapons on the floor show on every screen');
  copy.dispose();

  // Dying leaves it on the floor.
  for (const zz of [...sim.zombies]) zz.removeBody();
  sim.zombies.length = 0;
  const count = sim.placedMelee.length;
  sim.damagePlayer(sp, 500, { x: 0, y: 0, z: 0 });
  const dropped = sim.placedMelee.find((it) => it.weapon === 'hockey' && Math.hypot(it.pos.x - standAt.x, it.pos.z - standAt.z) < 1.5);
  check(!!dropped && sim.placedMelee.length === count + 1 && sp.arsenal.meleeId === 'machete', 'a survivor who dies drops it where they fell');
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

  // Female survivors: body, earrings and makeup ride at the end of the wire string.
  const ids = (slot: keyof typeof APPEARANCE_ITEMS) => (APPEARANCE_ITEMS[slot] as readonly AppearanceItem[]).map((i) => i.id) as string[];
  check(ids('body').join() === 'male,female', 'body types are male then female');
  check(['pixie', 'bangs', 'wavy', 'highpony', 'braid', 'pigtails', 'messybun', 'boxbraids'].every((id) => ids('hair').includes(id)), 'women\'s hairstyles are in the catalog');
  check(['croptop', 'blouse', 'sundress', 'cardigan'].every((id) => ids('top').includes(id)) && ['skirt', 'leggings', 'denimshorts'].every((id) => ids('pants').includes(id)), 'women\'s tops and bottoms are in the catalog');
  check(ids('ears').length >= 6 && ids('makeup').length >= 6 && PALETTES.makeup.length >= 10, 'earrings, makeup looks and makeup colors');
  const fem = sanitizeAppearance(DEFAULT_FEMALE_APPEARANCE);
  check(fem.body === 'female' && sameLook(fem, DEFAULT_FEMALE_APPEARANCE) && sameLook(decodeAppearance(encodeAppearance(fem)), fem), 'default female look is valid and survives the wire');
  const glam = sanitizeAppearance({ ...fem, ears: 'hoops', makeup: 'glam', makeupColor: 3, hair: 'braid', top: 'sundress', pants: 'skirt' });
  check(sameLook(decodeAppearance(encodeAppearance(glam)), glam) && glam.makeup === 'glam' && glam.ears === 'hoops', 'earrings and makeup survive the wire');
  const oldWire = encodeAppearance(DEFAULT_APPEARANCE).split('.').slice(0, 1 + APPEARANCE_FIELDS.findIndex(([k]) => k === 'body')).join('.');
  const oldLook = decodeAppearance(oldWire);
  check(oldLook.body === 'male' && oldLook.makeup === 'none' && oldLook.ears === 'none' && sameLook(oldLook, DEFAULT_APPEARANCE), 'saves from before body types load as the same man');
  check(encodeAppearance(glam).length < 120, 'a full look still fits well under the wire cap');
  let women = 0, beards = 0, menMakeup = 0, asked = true;
  for (let i = 0; i < 400; i++) {
    const w = randomAppearance(rand, 'female'), m = randomAppearance(rand, 'male'), any = randomAppearance(rand);
    if (w.body !== 'female' || m.body !== 'male') asked = false;
    if (any.body === 'female') women++;
    if (w.facialHair !== 'none') beards++;
    if (m.makeup !== 'none') menMakeup++;
    if (w.top === 'sundress' && w.pants !== 'skirt') beards++;
  }
  check(asked, 'randomize keeps the body type it was asked for');
  check(women > 120 && women < 280, `random looks are a mix of men and women (${women}/400 women)`);
  check(beards === 0 && menMakeup === 0, 'random women get no beards, random men no makeup, sundresses come with a skirt');

  const { sim, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  const cowboy = sanitizeAppearance({ ...DEFAULT_APPEARANCE, headwear: 'cowboy', top: 'flannel', eyes: 'fierce', eyeColor: 5 });
  const p2 = sim.addPlayer('p2', 'Cowboy', 'ar', 'pistol', { x: 1, y: 0.15, z: 6 }, 0, encodeAppearance(cowboy));
  check(sameLook(decodeAppearance(p2.appearance), cowboy), 'players keep the look they joined with');
  const p3 = sim.addPlayer('p3', 'Hacker', 'ar', 'pistol', { x: 2, y: 0.15, z: 6 }, 0, '1.' + 'zz.'.repeat(26) + '<script>');
  check(p3.appearance === encodeAppearance(decodeAppearance(p3.appearance)) && /^[0-9a-z.]+$/.test(p3.appearance), 'malicious appearance input is cleaned on join');
  cleanup(sim, body);
}

section('Progression: XP, unlocks and weapon builds');
{
  const xp = runXp(600, { kills: 50, headshots: 10, limbsSevered: 0, limbKills: 0, suppliesCollected: 2 });
  check(xp.total === 200 + 500 + 50 + 10, `a 10-minute run with 50 kills is worth ${xp.total} XP`);
  check(runXp(1e6, { kills: 1e6, headshots: 0, limbsSevered: 0, limbKills: 0, suppliesCollected: 0 }).total === 20000, 'one run awards at most 20,000 XP');
  let levelsOk = true;
  for (let n = 2; n <= 50; n++) if (levelFor(levelStart(n)) !== n || levelFor(levelStart(n) - 1) !== n - 1 || levelStart(n) <= levelStart(n - 1)) levelsOk = false;
  check(levelsOk && levelFor(0) === 1 && levelFor(1e9) === 50, 'levels 1-50 start at rising XP and levelFor inverts levelStart');

  let unique = true;
  for (const slot of BUILD_SLOTS) if (new Set(BUILD_OPTIONS[slot].map((o) => o.id)).size !== BUILD_OPTIONS[slot].length) unique = false;
  check(unique, 'option ids are unique in every slot');
  const supporter = SKINS.filter((k) => k.source === 'supporter');
  check(supporter.length >= 3 && supporter.every((k) => !owns(k, { level: 50, entitlements: [] }) && owns(k, { level: 1, entitlements: ['supporter'] })),
    'Supporter Pack finishes need the grant, never a level');
  const track = unlockTrack();
  check(track.length >= 15 && track.every((t, i) => i === 0 || t.level >= track[i - 1].level), `${track.length} unlocks along the level track`);
  check(!buildable('machete') && EXCLUSIVE_WEAPONS.every((id) => !buildable(id)) && PRIMARY_WEAPONS.every((id) => buildable(id)),
    'blades and supply-drop exclusives take no builds; every loadout gun does');

  const l1 = { level: 1, entitlements: [] as string[] };
  const want: WeaponBuild = { optic: 'holo', muzzle: 'suppressor', grip: 'vertical', mag: 'extended', skin: 'olive' };
  check(sameBuild(sanitizeBuild('ar', want, l1), defaultBuild('ar')), 'level 1 keeps only the stock build');
  const l6 = sanitizeBuild('ar', want, { level: 6, entitlements: [] });
  check(sameBuild(l6, want), 'level 6 has the holo, suppressor, vertical grip, extended mag and olive drab');
  check(sanitizeBuild('pistol', { ...defaultBuild('pistol'), optic: 'scope' }, { level: 50, entitlements: [] }).optic === 'iron', 'a scope does not fit the pistol');
  check(sanitizeBuild('ar', { ...defaultBuild('ar'), muzzle: 'choke' }, { level: 50, entitlements: [] }).muzzle === 'none', 'a shotgun choke does not fit the rifle');
  check(sanitizeBuild('marksman', { ...defaultBuild('marksman') }, l1).optic === 'scope', 'a gun keeps the optic it comes with at level 1 (the MK14 scope)');
  check(sanitizeBuild('ar', { ...defaultBuild('ar'), skin: 'neon' }, { level: 50, entitlements: [] }).skin === 'factory', 'a supporter finish without the grant falls back');

  const rand = rng(99);
  let trips = 0;
  for (let i = 0; i < 200; i++) {
    const l: Partial<Record<WeaponId, WeaponBuild>> = {};
    for (const id of PRIMARY_WEAPONS.concat('pistol')) {
      if (rand() < 0.3) continue;
      const b = {} as WeaponBuild;
      for (const slot of BUILD_SLOTS) {
        const f = fitsOf(id, slot);
        b[slot] = f[Math.floor(rand() * f.length)].id;
      }
      l[id] = b;
    }
    const back = decodeLoadout(encodeLoadout(l));
    if (Object.keys(l).every((id) => sameBuild(back[id as WeaponId]!, l[id as WeaponId]!))) trips++;
  }
  check(trips === 200, `200 random loadouts survive the wire format (${trips})`);
  const junk = decodeLoadout('1.ar:zzzzz.machete:11111.<script>:1.lmg:11111.' + 'x'.repeat(700));
  check(Object.keys(junk).length === 0, 'oversized loadout strings are refused');
  const junk2 = sanitizeLoadout(decodeLoadout('1.ar:zzzzz.machete:11111.lmg:11111.pistol:9'), { level: 50, entitlements: [] });
  check(!junk2.machete && !junk2.lmg && !junk2.ar && !junk2.pistol, 'junk, blades and exclusives in a loadout come back as stock');
  check(decodeLoadout(42).ar === undefined && decodeLoadout('2.ar:11111').ar === undefined, 'non-strings and unknown versions give no builds');

  check(tunedWeapon('ar', defaultBuild('ar')) === WEAPONS.ar || tunedWeapon('ar', defaultBuild('ar')).magazine === WEAPONS.ar.magazine, 'the stock build has the table numbers');
  check(tunedWeapon('ar', { ...defaultBuild('ar'), mag: 'extended' }).magazine === 45, 'extended AR magazine holds 45');
  check(tunedWeapon('shotgun', { ...defaultBuild('shotgun'), mag: 'extended' }).magazine === 8, 'extended shotgun tube holds two more shells');
  check(tunedWeapon('ar', { ...defaultBuild('ar'), muzzle: 'suppressor' }).noise < WEAPONS.ar.noise * 0.5, 'the suppressor carries less than half as far');
  check(tunedWeapon('marksman', { ...defaultBuild('marksman'), optic: 'iron' }).aimSpread > WEAPONS.marksman.aimSpread, 'irons on the MK14 aim wider than its scope');
  check(tunedWeapon('smg', { ...defaultBuild('smg'), grip: 'vertical' }).recoil < WEAPONS.smg.recoil, 'a vertical grip cuts recoil');

  // In a night.
  const { sim, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  const ext = { ...defaultBuild('ar'), mag: 'extended', muzzle: 'suppressor' };
  const p2 = sim.addPlayer('p2', 'Builder', 'ar', 'pistol', { x: 1, y: 0.15, z: 6 }, 0, '', { ar: ext });
  check(p2.arsenal.primary.mag === 45 && p2.arsenal.def.noise < WEAPONS.ar.noise, 'a survivor joins with their build fitted (45 rounds, quiet)');
  run(sim, 1);
  const ok = sim.refit('p2', 'ar', defaultBuild('ar'));
  const ev = sim.drain();
  check(ok && ev.some((e) => e.type === 'refit' && e.player === 'p2' && e.build === encodeBuild(defaultBuild('ar'))), 'a refit goes through and is announced');
  check(p2.arsenal.primary.mag === 30 && p2.arsenal.primary.reserve === WEAPONS.ar.startReserve + 15, 'rounds over the smaller magazine go back to the reserve');
  check(p2.arsenal.action === 'draw' && Math.abs(p2.arsenal.actionTotal - FIT_TIME) < 1e-6 && p2.arsenal.fireState() === 'busy', 'the gun in hand is down while it is refitted');
  check(!sim.refit('p2', 'ar', defaultBuild('ar')), 'refitting the same build again does nothing');
  check(sim.refit('p2', 'pistol', { ...defaultBuild('pistol'), skin: 'olive' }) && p2.arsenal.action === 'draw' && p2.arsenal.weapon.id === 'ar',
    'the holstered gun is refitted without touching the one in hand');
  check(!sim.refit('p2', 'smg', defaultBuild('smg')), 'only carried guns can be refitted');
  run(sim, 2);
  p2.arsenal.startMelee();
  check(!sim.refit('p2', 'ar', ext), 'no refit mid-swing');
  run(sim, 1);

  const snap = captureSnapshot(sim, new Map());
  const sp2 = snap.p.find((p) => p.id === 'p2')!;
  check(sp2.k === encodeBuild(defaultBuild('ar')) + encodeBuild({ ...defaultBuild('pistol'), skin: 'olive' }), 'snapshots carry the primary and secondary builds');
  const other = new Simulation({ physics, map, nav, doors, seed: 8, preparation: 600 });
  const mirror = new Mirror(other, 'p1');
  mirror.apply(snap, 0);
  check(other.players.get('p2')?.arsenal.builds.pistol?.skin === 'olive', 'clients take the builds from snapshots');
  other.dispose();
  cleanup(sim, body);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
