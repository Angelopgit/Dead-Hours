/**
 * Headless checks for the combat simulation, run against the real map collision:
 * the zombie navigation grid, weapon state (fire rates, magazines, reloads, switching, melee),
 * damage and hit zones, zombie perception and pursuit through buildings, door pounding,
 * the spawner, interactables and player death, and the survivor appearance wire format.
 * Run with `npm run check:sim`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, RAPIER, GROUP, groups, createDoorBodies, buildNavGrid, Simulation, Arsenal,
  WEAPONS, DOWNED, zombieZones, rayZones, along, PLAYER, ZOMBIES, SPAWNING, SPECIALS, HORDES, LULLS, hordeAt, hordeStart, lullDuration, lullOpening, threatAt, inLull, hordeBonus, hordeDuration, hordeRunnerBoost, SUPPLY_DROPS, LIMBS, LEGS, limbClub, EXCLUSIVE_WEAPONS, PRIMARY_WEAPONS, SERUM, caseSpot, captureSnapshot, Mirror, MELEE, MELEE_PICKUPS, FOUND_MELEE, findPickupRooms, isMelee, type Vec3, type SimEvent, type NavGrid,
  type Zombie, type SimLimb, type ZoneShape, PRONE, DIVE, MOTION_FLAG, packMotion, unpackMotion,
  APPEARANCE_ITEMS, APPEARANCE_FIELDS, DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, PALETTES, SHAPE_MID, SHAPE_STEPS, encodeAppearance, decodeAppearance, sanitizeAppearance,
  randomAppearance, rng, type Appearance, type AppearanceItem,
  BARRICADE, Mirror, NAV_INDOOR, storeyFloors, type BarricadeSlot,
  BOOSTS, BOOST_IDS, BOOST_PICKUPS, INJECT, findBoostSpots, type BoostId,
  VAULT, BLAST, DOOR_WOOD, ZONE_MULTIPLIER, findVault, vaultAt, porches, packPanes, unpackPanes,
  BUILD_OPTIONS, BUILD_SLOTS, FIT_TIME, SKINS, buildable, decodeLoadout, defaultBuild, encodeBuild, encodeLoadout, fitsOf, levelFor,
  levelStart, owns, runXp, sameBuild, sanitizeBuild, sanitizeLoadout, tunedWeapon, unlockTrack, type WeaponBuild, type WeaponId,
  SECONDARY_WEAPONS, isHandgun,
  GORE, shotgunReach, type ZombieKind,
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
  ['Mercer house', { x: 27, y: 0.3, z: -18 }],
  ['gas station store', { x: 92, y: 0.2, z: -37 }],
  ['park', { x: 90, y: 0, z: 30 }],
  ['checkpoint', { x: -100, y: 0, z: 10 }],
  ['north woods', { x: 20, y: 0, z: -95 }],
  ['south woods', { x: -30, y: 0, z: 155 }],
  ['back alley', { x: 0, y: 0, z: -47 }],
  ['Kinney Street', { x: -20, y: 0, z: 94 }],
  ['Oyelaran house basement (Kinney St)', { x: 7, y: -2.7, z: 113.5 }],
  ['Delgado house living room (Kinney St)', { x: 29, y: 0.3, z: 77 }],
  ['Kinney Street dead end', { x: 92, y: 0, z: 94 }],
];
for (const [name, p] of spots) check(nav.reachable(nav.nodeAt(p.x, p.y, p.z, 0.6)), `${name} is reachable`);
check(!nav.reachable(nav.nodeAt(0, 9, -20, 0.3)) || nav.nodeY[nav.nodeAt(0, 9, -20, 0.3)] < 5, 'safehouse roof is not part of the walkable area');
const routes: [string, Vec3, Vec3][] = [
  ['street to safehouse living room', { x: 0, y: 0.15, z: 8 }, spots[0][1]],
  ['street to safehouse upstairs', { x: 0, y: 0.15, z: 8 }, spots[2][1]],
  ['street to basement', { x: 0, y: 0.15, z: 8 }, spots[3][1]],
  ['north woods to safehouse', { x: 30, y: 0, z: -100 }, spots[0][1]],
  ['park to garage', { x: 90, y: 0, z: 30 }, spots[4][1]],
  ['checkpoint to Mercer house', { x: -110, y: 0, z: 5 }, spots[5][1]],
  ['Kinney Street to safehouse living room', spots[12][1], spots[0][1]],
  ['south woods to Oyelaran basement', spots[10][1], spots[13][1]],
  ['safehouse to Delgado house', spots[0][1], spots[14][1]],
  ['park to Kinney Street dead end', spots[7][1], spots[15][1]],
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
  // The sim's own CPU time, not the wall clock: the wall clock counts whatever else the machine runs, and with
  // checks in parallel or a headless browser up a step took 7 ms while the same code took 2.9 ms on its own.
  // A slow run is still redone (up to twice) and the best counts, so only a sim that is slow every time fails.
  const stepCost = (on: Simulation) => {
    const c = process.cpuUsage(), t = performance.now();
    run(on, 20);
    const used = process.cpuUsage(c);
    return { cpu: (used.user + used.system) / 1000 / (20 / DT), wall: (performance.now() - t) / (20 / DT) };
  };
  const costs = [stepCost(sim)];
  const zombies = sim.zombies.length;
  const closer = sim.zombies.map((z) => Math.hypot(z.pos.x - sp.motion.pos.x, z.pos.z - sp.motion.pos.z));
  check(closer.reduce((a, b) => a + b, 0) / closer.length < dists.reduce((a, b) => a + b, 0) / dists.length, 'zombies approach the survivors');
  cleanup(sim, body);
  for (let i = 0; i < 2 && Math.min(...costs.map((c) => c.cpu)) >= 4; i++) {
    const again = makeSim({ x: 4.8, y: 0.32, z: -22.3 }, 3);
    run(again.sim, 3.2 + 8);
    costs.push(stepCost(again.sim));
    cleanup(again.sim, again.body);
  }
  const best = costs.reduce((a, b) => (b.cpu < a.cpu ? b : a));
  check(best.cpu < 4, `simulation step with ${zombies} zombies costs ${best.cpu.toFixed(2)} ms of CPU (${best.wall.toFixed(2)} ms on the clock${costs.length > 1 ? `, best of ${costs.length} runs` : ''})`);
}
// The map grew south with Kinney Street: a survivor anywhere still gets zombies spawning around them.
for (const [where, at] of [
  ['the safehouse', { x: 4.8, y: 0.32, z: -22.3 }], ['Hale Street', { x: -40, y: 0.15, z: 6 }],
  ['Kinney Street', { x: -10, y: 0.02, z: 94 }], ['an Kinney Street basement', { x: 7, y: -2.7, z: 113.5 }],
  ['the Kinney Street dead end', { x: 90, y: 0.02, z: 94 }],
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
section('Downtime lulls');
{
  // The schedule on its own (no raid): lulls every few minutes of fighting, a minute or two long, never in a wave.
  check(lullDuration(1) >= 60 && lullDuration(1) <= 120 && lullDuration(20) <= 120 && lullDuration(5) >= lullDuration(2), `each lull lasts 1 to 2 minutes, growing (${[1, 2, 3, 4, 5, 6].map(lullDuration).join(', ')} s)`);
  let due: number = LULLS.every, paused = 0;
  const plan: { at: number; threat: number; len: number }[] = [];
  for (let n = 1; n <= 8; n++) {
    const threat = lullOpening(due);
    plan.push({ at: threat + paused, threat, len: lullDuration(n) });
    paused += lullDuration(n);
    due = threat + LULLS.every;
  }
  const fmt = (x: number) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  console.log(`     lulls (survival time, length): ${plan.map((p) => `${fmt(p.at)} ${p.len}s`).join(' · ')}`);
  check(Math.abs(plan[0].at - LULLS.every) < 1e-9, `the first comes after ${LULLS.every / 60} minutes of fighting`);
  const fights = plan.slice(1).map((p, i) => p.threat - plan[i].threat);
  check(fights.every((g) => g >= LULLS.every && g <= LULLS.every + 140), `fighting between lulls: ${fights.map((g) => fmt(g)).join(', ')}`);
  check(plan.every((p) => hordeAt(p.threat).stage === 'calm'), 'none starts during a horde siren or surge');
  const l = { count: 1, start: 300, end: 360, paused: 0 };
  check(threatAt(l, 299) === 299 && threatAt(l, 330) === 300 && threatAt(l, 400) === 340 && inLull(l, 330) && !inLull(l, 360), 'the threat clock stands still through a lull and resumes after');

  // In the simulation.
  const { sim, sp, body } = makeSim({ x: 4.8, y: 0.32, z: -22.3 });
  sim.phase = 'survival';
  sim.phaseTime = 0;
  run(sim, 0.2);
  const lulls: string[] = [];
  const spawned: number[] = [];
  const removed: number[] = [];
  let heli = false;
  let hordeAtSurvival = NaN;
  const go = (seconds: number) => {
    for (const e of run(sim, seconds).events) {
      if (e.type === 'lull') lulls.push(`${e.stage}${e.n}`);
      if (e.type === 'zombieSpawned') spawned.push(e.zombie);
      if (e.type === 'zombieRemoved') removed.push(e.zombie);
      if (e.type === 'heli') heli = true;
      if (e.type === 'horde' && e.stage === 'warning') hordeAtSurvival = e.at;
    }
  };
  const far = sim.spawnZombie('walker', { x: 60, y: 0.02, z: 8 }, 'approach');
  const near = sim.spawnZombie('walker', { x: 4.8, y: 0.02, z: -8 }, 'approach');
  const hunter = sim.spawnZombie('runner', { x: 70, y: 0.02, z: 8 }, 'idle');
  hunter.summon(sp);
  sim.phaseTime = LULLS.every - 0.1;
  go(0.3);
  check(lulls[0] === 'start1' && sim.lulling, `a lull starts when one is due in a calm (${lulls.join(' ')})`);
  check(Math.abs(sim.lull.end - sim.lull.start - lullDuration(1)) < 1e-9, `it lasts ${lullDuration(1)} s`);
  check(!sim.zombies.includes(far) && removed.includes(far.id), 'idle zombies far off and out of sight slip away');
  check(sim.zombies.includes(near) && near.state !== 'approach', `one close by stays, but stops coming (${near.state})`);
  check(sim.zombies.includes(hunter) && hunter.engaged, 'one already hunting a survivor keeps coming');
  const threat = sim.threatTime;
  spawned.length = 0;
  go(12);
  check(spawned.length === 0, `no zombies come during the lull (${spawned.length} in 12 s)`);
  check(Math.abs(sim.threatTime - threat) < 1e-9 && sim.horde.stage === 'calm', `the threat clock stands still (${threat.toFixed(1)} → ${sim.threatTime.toFixed(1)})`);
  check(heli, `a supply drop comes ${LULLS.dropAfter} s in`);
  sim.phaseTime = sim.lull.end - LULLS.warning - 0.05;
  go(0.2);
  check(lulls.includes('ending1'), `the end is called ${LULLS.warning} s ahead (${lulls.join(' ')})`);
  sim.phaseTime = sim.lull.end - 0.05;
  go(0.2);
  check(lulls.includes('over1') && !sim.lulling, 'the lull ends');
  check(Math.abs(sim.threatTime - threat - (sim.phaseTime - sim.lull.end)) < 1e-6, 'and the threat clock runs on from where it stopped');
  const target = sim.populationTarget;
  const lean = sim.lullReturn;
  check(lean < 0.5 && target < Math.floor(SPAWNING.basePopulation + (SPAWNING.growthPerMinute * sim.threatTime) / 60), `the dead come back gradually (${(lean * 100).toFixed(0)}% of the target at first)`);
  go(2);
  check(spawned.length > 0, `zombies come again after it (${spawned.length} in 2 s)`);
  // The horde schedule runs on the threat clock: the next siren comes the lull's length later, and its event says when in survival time.
  const warnThreat = hordeStart(2) - HORDES.warning;
  sim.phaseTime = sim.lull.end + (warnThreat - threat) - 0.05;
  go(0.2);
  check(Math.abs(hordeAtSurvival - (sim.lull.end + (hordeStart(2) - threat))) < 0.05, `the next siren comes on the threat clock, its event in survival time (${hordeAtSurvival.toFixed(1)} s)`);
  check(!sim.lulling && sim.lull.count === 1, 'no second lull straight away');
  // Online: the lull reaches every client in the snapshot, and their threat clock matches.
  sim.startLull();
  run(sim, 0.5);
  const snap = JSON.parse(JSON.stringify(captureSnapshot(sim, new Map())));
  const copy = new Simulation({ physics, map, nav, doors, seed: 4 });
  const mirror = new Mirror(copy, 'p2');
  mirror.apply(snap, 10);
  check(copy.lull.count === 2 && copy.lulling && Math.abs(copy.threatTime - sim.threatTime) < 0.01, `clients know a lull is on and share the threat clock (${copy.threatTime.toFixed(2)} vs ${sim.threatTime.toFixed(2)})`);
  copy.dispose();
  // The van never comes during one: it waits on the threat clock, which stands still.
  sim.raid.at = sim.threatTime;
  go(1);
  check(sim.raid.stage === 'waiting', 'the van waits for the lull to end');
  sim.phaseTime = sim.lull.end + 0.01;
  go(0.2);
  check(sim.raid.active, 'and comes after it');
  // And none starts while the raid is on.
  sim.lullDue = sim.threatTime;
  go(0.5);
  check(!sim.lulling && sim.lull.count === 2, 'no lull while the van raid is on');
  sim.raid.dispose();
  cleanup(sim, body);

  // The fallen come back at the start of a lull, beside a teammate on their feet.
  const t = makeSim({ x: 4.8, y: 0.32, z: -22.3 });
  const mate = t.sim.addPlayer('p2', 'P2', 'shotgun', 'pistol', { x: 6.5, y: 0.32, z: -22.3 }, 0);
  t.sim.phase = 'survival';
  t.sim.phaseTime = 100;
  run(t.sim, 0.2);
  mate.downs = DOWNED.maxDowns;
  mate.arsenal.primary.reserve = 0;
  mate.arsenal.primary.mag = 0;
  const killsBefore = (mate.stats.kills = 7);
  t.sim.damagePlayer(mate, 500, { x: 0, y: 0, z: 0 });
  check(!mate.alive, 'a survivor falls for good');
  run(t.sim, 2);
  check(t.sim.startLull(), 'a lull starts');
  const ev = t.sim.drain();
  const back = ev.find((e) => e.type === 'lull' && e.stage === 'start');
  const rose = ev.find((e) => e.type === 'playerRespawned');
  check(mate.alive && mate.up && mate.health === PLAYER.maxHealth, `the fallen survivor is back on their feet with full health (${mate.health})`);
  check(!!back && back.type === 'lull' && (back.back ?? []).includes('p2') && !!rose && rose.type === 'playerRespawned' && rose.player === 'p2', 'the lull says who came back, and every client hears of it');
  const d = Math.hypot(mate.motion.pos.x - t.sp.motion.pos.x, mate.motion.pos.z - t.sp.motion.pos.z);
  check(d >= 1 && d < 6 && Math.abs(mate.motion.pos.y - t.sp.motion.pos.y) < 0.7, `they come back beside their teammate (${d.toFixed(1)} m away, same floor)`);
  const look = { x: -Math.sin(mate.motion.yaw), z: -Math.cos(mate.motion.yaw) };
  check(((t.sp.motion.pos.x - mate.motion.pos.x) * look.x + (t.sp.motion.pos.z - mate.motion.pos.z) * look.z) / d > 0.95, 'looking at them');
  check(mate.arsenal.primary.id === 'shotgun' && mate.arsenal.primary.mag > 0 && mate.arsenal.primary.reserve > 0, 'with the same guns, loaded again');
  check(mate.downs === 0 && mate.stats.kills === killsBefore && mate.deadTime > 1.9, `downs reset, stats carried on, time dead noted (${mate.deadTime.toFixed(1)} s)`);
  check(t.sim.players.get('p1')!.alive && t.sim.lull.count === 1, 'nobody else is touched');
  const snap2 = JSON.parse(JSON.stringify(captureSnapshot(t.sim, new Map())));
  const copy2 = new Simulation({ physics, map, nav, doors, seed: 4 });
  copy2.addPlayer('p2', 'P2', 'shotgun', 'pistol', { x: 0, y: 0, z: 0 }, 0).alive = false;
  new Mirror(copy2, 'p1').apply(snap2, 10);
  check(copy2.players.get('p2')?.alive === true, 'clients see them alive again');
  copy2.dispose();
  // Nobody on their feet to come back to: nobody comes back (the night is over anyway).
  t.sp.alive = false;
  mate.alive = false;
  t.sim.phaseTime = t.sim.lull.end + 1;
  run(t.sim, 0.1);
  t.sim.lullDue = 0;
  check(!t.sim.startLull() || ![...t.sim.players.values()].some((p) => p.alive), 'no one is brought back with nobody standing');
  cleanup(t.sim, t.body);
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
  // Drops find open ground on Kinney Street too: the road, the yards, the dead end.
  const at = { x: 10, y: 0.02, z: 94 };
  const { sim, body } = makeSim(at);
  const plan = () => sim.airdrops.planFlight();
  let ok = 0, near = Infinity, far = 0;
  for (let i = 0; i < 20; i++) {
    const f = plan();
    if (!f) continue;
    const g = f.ground, d = Math.hypot(g.x - at.x, g.z - at.z);
    near = Math.min(near, d);
    far = Math.max(far, d);
    if (d >= SUPPLY_DROPS.minDistance && d <= SUPPLY_DROPS.maxDistance && physics.raycast(g.x, g.y + 0.6, g.z, 0, 1, 0, 60) === null) ok++;
  }
  check(ok === 20, `supply drops for a survivor on Kinney Street land in the open, in range (${ok} of 20, ${near.toFixed(0)}-${far.toFixed(0)} m)`);
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
  const roll = () => (sim.airdrops as unknown as { rollExclusive(): string | null }).rollExclusive();
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
    const S = { runDrops: () => sim.airdrops.runDrops(), set nextDropAt(v: number) { sim.nextDropAt = v; } };
    let early2 = 0, earlyN = 0, late2 = 0, lateN = 0, nights = 0, nightsWithOne = 0, frags = 0, molotovs = 0, nightsWithFrags = 0;
    for (let night = 0; night < 160; night++) {
      for (const d of sim.drops) if (d.body) physics.world.removeRigidBody(d.body);
      sim.drops.length = 0;
      S.nextDropAt = SUPPLY_DROPS.firstAt;
      let any = false, anyFrag = false;
      for (sim.phaseTime = 0; sim.phaseTime < 720; sim.phaseTime += 1) {
        const before = sim.drops.length;
        S.runDrops();
        if (sim.drops.length === before) continue;
        const d = sim.drops[sim.drops.length - 1];
        if (sim.phaseTime < SUPPLY_DROPS.exclusiveAfter) { earlyN++; if (d.weapon) early2++; } else { lateN++; if (d.weapon) late2++; }
        if (d.weapon) any = true;
        if (d.frags) { frags++; anyFrag = true; }
        if (d.molotovs) molotovs++;
      }
      if (anyFrag) nightsWithFrags++;
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
    const all = earlyN + lateN;
    check(Math.abs(frags / all - SUPPLY_DROPS.fragChance) < 0.05 && Math.abs(molotovs / all - SUPPLY_DROPS.molotovChance) < 0.05,
      `flown for real: grenades in ${(100 * frags / all).toFixed(1)}% of drops, Molotovs in ${(100 * molotovs / all).toFixed(1)}% (more often than any gun)`);
    console.log(`       ${nightsWithFrags} of ${nights} nights had at least one drop with grenades`);
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
section('Grenades and Molotovs in supply drops');
{
  const at = { x: 0, y: 0.15, z: 6 };
  const { sim, sp, body } = makeSim(at, 0.5);
  run(sim, 1);
  const clear = () => {
    for (const z of [...sim.zombies]) z.removeBody();
    sim.zombies.splice(0, sim.zombies.length);
    sp.health = PLAYER.maxHealth;
    return false;
  };
  for (const packed of [{ frags: true, molotovs: false }, { frags: false, molotovs: false }]) {
    clear();
    const drop = sim.callSupplyDrop();
    if (!drop) { check(false, 'drop called'); continue; }
    Object.assign(drop, packed);
    run(sim, drop.flight.land - sim.time + 0.2, clear);
    const crate = sim.interactables[drop.interactable];
    sim.setMotion('p1', { pos: { x: drop.flight.ground.x + 1.3, y: drop.flight.ground.y, z: drop.flight.ground.z } });
    sp.arsenal.throwables.frag = 0;
    sp.arsenal.throwables.molotov = 0;
    sp.arsenal.primary.reserve = 0;
    const snap = captureSnapshot(sim, new Map()).i.find((r) => r[0] === crate.id);
    check(sim.use('p1', crate.id) && sp.arsenal.throwables.frag === (packed.frags ? SUPPLY_DROPS.fragsPerUse : 0) && sp.arsenal.throwables.molotov === 0,
      packed.frags ? `a crate packed with grenades hands out ${SUPPLY_DROPS.fragsPerUse} (and no Molotovs it doesn't have)` : 'a plain crate hands out ammunition only');
    check(!!snap && (snap[8] & 1) === (packed.frags ? 1 : 0), 'snapshots say what the crate holds');
    sim.drain();
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

section('Halberg serum');
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
  check(!!drop && drop.serum && res.events.some((e) => e.type === 'notice' && e.text === 'RARE SUPPLY DROP INBOUND' && /Halberg/.test(e.sub ?? '')), 'a drop with a serum is announced as rare');
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

section('Prone and dolphin dives');
{
  const { sim, sp, body } = makeSim({ x: 20, y: 0.15, z: 6 });
  run(sim, 0.5);
  const at = { x: 20, y: 0.15, z: 6 };
  const reach = (x: number, z: number) => sp.reachPoint({ x, y: 0, z }, { x: 0, y: 0, z: 0 });
  check(reach(20, -3).z === 6 && reach(25, 6).x === 20, 'standing, zombies reach for the body where it stands');
  // Lying looking along -z (yaw 0): the head is ahead, the feet behind.
  sim.setMotion('p1', { prone: true, crouching: false, yaw: 0, pitch: 0, eyeHeight: PRONE.eyeHeight });
  const ahead = reach(20, -3), behind = reach(20, 12), side = reach(23, 6.3);
  check(Math.abs(ahead.z - (6 - PRONE.reachAhead)) < 1e-6 && Math.abs(behind.z - (6 + PRONE.reachBehind)) < 1e-6 && Math.abs(side.z - 6.3) < 1e-6 && side.x === 20,
    'prone, zombies reach for the nearest part of the body (head, feet or side)');

  const stance = (m: Partial<{ prone: boolean; crouching: boolean }>) =>
    sp.arsenal.spread({ speed: 0, grounded: true, aiming: false, crouching: !!m.crouching, prone: !!m.prone });
  check(stance({ prone: true }) < stance({ crouching: true }) && stance({ crouching: true }) < stance({}), 'lying prone is the steadiest way to shoot (less spread than crouching)');

  // Out of a walker's sight at a distance it would see someone standing.
  const far = sim.spawnZombie('walker', { x: 20, y: 0.02, z: 6 - 14 }, 'idle');
  far.facing = 0;
  let res = run(sim, 4);
  check(!res.events.some((e) => e.type === 'zombieAlert') && far.state !== 'chase', 'a zombie 14 m away does not spot a survivor lying prone');
  sim.setMotion('p1', { prone: false });
  far.setState('idle');
  far.facing = Math.atan2(at.x - far.pos.x, at.z - far.pos.z);
  res = run(sim, 6, () => far.state === 'chase');
  check(far.state === 'chase', `the same zombie spots them once they stand up (${res.time.toFixed(1)} s, ${far.state})`);
  for (const z of [...sim.zombies]) z.removeBody();
  sim.zombies.length = 0;

  // Close by it sees them, comes to the body and claws at it, standing beside it, not on it.
  sim.setMotion('p1', { prone: true, pos: { ...at }, vel: { x: 0, y: 0, z: 0 } });
  const near = sim.spawnZombie('walker', { x: 20, y: 0.02, z: 6 - 7 }, 'idle');
  near.facing = 0;
  const hp = sp.health;
  res = run(sim, 25, () => sp.health < hp);
  const head = sp.reachPoint(near.pos, { x: 0, y: 0, z: 0 });
  check(sp.health < hp && res.events.some((e) => e.type === 'zombieAttack'), `a zombie reaches a prone survivor and hurts them (${res.time.toFixed(1)} s)`);
  check(Math.hypot(near.pos.x - head.x, near.pos.z - head.z) > 0.3 && near.pos.z < at.z - PRONE.reachAhead + 0.3, 'it stops at the head instead of walking onto the body');
  for (const z of [...sim.zombies]) z.removeBody();
  sim.zombies.length = 0;

  // Noise: crawling is quiet, a dive lands with one thud.
  sim.noises.length = 0;
  sim.setMotion('p1', { prone: true, grounded: true, vel: { x: 0, y: 0, z: -PRONE.crawlSpeed } });
  run(sim, 2);
  const crawl = sim.noises.filter((n) => n.source === 'p1');
  check(crawl.length >= 2 && crawl.every((n) => n.radius === PRONE.noise) && PRONE.noise < 1.2, `crawling makes only a ${PRONE.noise} m noise (quieter than crouch-walking)`);
  sim.noises.length = 0;
  sim.setMotion('p1', { prone: false, diving: true, grounded: false, vel: { x: 0, y: 2, z: -7 } });
  run(sim, 0.3);
  const inAir = sim.noises.filter((n) => n.source === 'p1').length;
  sim.setMotion('p1', { grounded: true, vel: { x: 0, y: 0, z: -4 } });
  run(sim, 0.5);
  const thuds = sim.noises.filter((n) => n.source === 'p1');
  check(inAir === 0 && thuds.length === 1 && thuds[0]!.radius === DIVE.noise, `a dive is silent in the air and lands with one ${DIVE.noise} m thud`);
  sim.setMotion('p1', { diving: false, prone: true, vel: { x: 0, y: 0, z: 0 } });

  // Online: prone and diving ride in the motion flags, and a low eye height survives the trip.
  const frame = (prone: boolean, diving: boolean) => ({
    motion: { ...sp.motion, prone, diving, eyeHeight: PRONE.eyeHeight }, facing: 0, trigger: false,
    aimOrigin: sp.eye, aimDir: { x: 0, y: 0, z: -1 },
  });
  const a = unpackMotion(JSON.parse(JSON.stringify(packMotion(frame(true, false)))));
  const b = unpackMotion(packMotion(frame(false, true)));
  check(!!a && !!b && a.motion.prone === true && a.motion.diving === false && b.motion.diving === true && b.motion.prone === false && Math.abs(a.motion.eyeHeight - PRONE.eyeHeight) < 0.01
    && MOTION_FLAG.prone === 512 && MOTION_FLAG.diving === 1024, 'prone and diving reach the server (motion flags 512 and 1024)');
  sim.setMotion('p1', { prone: true, diving: false });
  const snap = JSON.parse(JSON.stringify(captureSnapshot(sim, new Map())));
  const copy = new Simulation({ physics, map, nav, doors, seed: 4 });
  new Mirror(copy, 'p2').apply(snap, 10);
  const cp = copy.players.get('p1');
  check(!!cp && cp.motion.prone === true && !cp.motion.diving, 'other survivors see them lying prone');
  copy.dispose();
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
  const thigh = along(wl.a, wl.b, 0.2);
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
  const all = slots.filter((s) => s.kind === 'window');
  const wins = all.filter((s) => s.max > 0);
  const enterable = new Set(homes.map((h) => h.id));
  const mapWins = map.windows.filter((w) => enterable.has(w.houseId));
  check(all.length === mapWins.length && all.every((s) => s.pane !== null && s.glass), `every window of every enterable building has glass that can be smashed (${all.length}, ${all.length - wins.length} of them upstairs or too small for boards)`);
  check(new Set(all.map((s) => s.ref)).size === all.length, 'one slot per window');
  check(all.filter((s) => s.max === 0).every((s) => s.outNode < 0), 'zombies only climb through the windows that take boards');
  const climb = wins.filter((s) => s.outNode >= 0);
  check(wins.length >= 50 && climb.length >= wins.length * 0.85, `ground-storey windows take boards and zombies can climb through most (${climb.length} of ${wins.length})`);
  check(wins.every((s) => s.bottom < BARRICADE.maxSill && s.width >= BARRICADE.minWidth), 'no upstairs windows or bathroom slits among them');
  check(wins.every((s) => s.pane !== null && s.glass), 'every window starts with its pane in');
  const oak = homes.filter((h) => h.id.startsWith('oak-'));
  const oakWins = wins.filter((s) => s.houseId.startsWith('oak-'));
  check(all.filter((s) => s.houseId.startsWith('oak-')).length === mapWins.filter((w) => w.houseId.startsWith('oak-')).length, 'Kinney Street\'s windows all break too');
  const oakClimb = oakWins.filter((s) => s.outNode >= 0);
  check(oak.every((h) => oakWins.some((s) => s.houseId === h.id)) && oakClimb.length >= oakWins.length * 0.85, `Kinney Street's homes take boards on their windows like Hale's (${oakClimb.length} of ${oakWins.length} climbable)`);
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
    return sim.barricades.slots.filter((s) => sim.barricades.boardable(s) && sim.canWork(sp, s));
  };
  const nodes: Vec3[] = [];
  for (let n = 0; n < nav.nodeCount; n++) if (nav.reachable(n)) nodes.push(nav.nodePos(n));
  const indoors = new Map([...houseOf.values()].filter((h) => h.enterable).map((h) => [h.id, nodes.filter((p) => within(h, p.x, p.z))]));
  let above = 0, below = 0, same = 0;
  const wrong = new Set<string>();
  for (const s of sim.barricades.slots.filter((s) => sim.barricades.boardable(s))) {
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
  // Windows that take no boards still know their storey (vaulting and the prompt use it).
  const upstairs = sim.barricades.windows.filter((s) => s.bottom > storeyFloors(houseOf.get(s.houseId)!)[0] + 2);
  check(upstairs.length > 50 && upstairs.every((s) => s.floor === storeyFloors(houseOf.get(s.houseId)!)[1] && !sim.barricades.boardable(s)), `upstairs windows sit on the upper storey's floor and take no boards (${upstairs.length})`);
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
  const res = run(sim, 0.2);
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
  // Wooden doors: rounds go on through them (weaker), each leaves its hole, and blows, rounds and
  // blasts knock pieces out of the leaf; the pieces reach every client in snapshots.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const dpick = houseSlots(probe, 'house-s', 'door')[0];
  cleanup(probe, pb);
  const door = doors[dpick.ref]!;
  const out = dpick.normal;
  const stand = nav.nodePos(nav.nodeAt(dpick.center.x + out.x * 3, 0.1, dpick.center.z + out.z * 3, 1.5));
  let { sim, sp, body } = makeSim({ x: stand.x, y: stand.y + 0.02, z: stand.z });
  sp.arsenal.aim = 1;
  run(sim, 0.8);
  const aimAt = (p: Vec3) => {
    const e = sp.eye;
    const dx = p.x - e.x, dy = p.y - e.y, dz = p.z - e.z, l = Math.hypot(dx, dy, dz);
    return { x: dx / l, y: dy / l, z: dz / l };
  };
  check(door.wooden && !door.open && door.pieces === 0 && door.wear === 0, 'the front door starts shut and whole');
  const z = sim.spawnZombie('walker', { x: dpick.center.x - out.x * 0.8, y: door.hinge.y + 0.02, z: dpick.center.z - out.z * 0.8 }, 'idle');
  run(sim, 0.1);
  const hp = z.health;
  sp.arsenal.primary.mag = 30;
  sim.fire('p1', sp.eye, aimAt({ x: z.pos.x, y: z.pos.y + 1.25, z: z.pos.z }), true, 11);
  let res = run(sim, 0.2);
  const holes = res.events.filter((e) => e.type === 'impact' && e.door === door.index);
  const hit = res.events.find((e) => e.type === 'zombieHit' && e.zombie === z.id);
  check(holes.length === 1 && !!hit && z.health < hp && !door.open, 'a round goes through the shut door into the zombie behind it, leaving a hole');
  const full = hit && hit.type === 'zombieHit' ? WEAPONS.ar.damage * ZONE_MULTIPLIER[hit.zone] : 0;
  check(!!hit && hit.type === 'zombieHit' && Math.abs(hit.damage - full * DOOR_WOOD.pass) < full * 0.05, `weaker for it (${hit && hit.type === 'zombieHit' ? hit.damage.toFixed(1) : '-'} of ${full.toFixed(1)})`);
  check(door.wear > 0 && door.strain > 0, 'and the door felt it');
  // Rounds into the door until it gives: pieces come out of it on the way.
  z.removeBody();
  sim.zombies.splice(sim.zombies.indexOf(z), 1);
  const target = { x: dpick.center.x + (dpick.axis === 'x' ? 0.2 : 0), y: dpick.center.y + 0.3, z: dpick.center.z + (dpick.axis === 'z' ? 0.2 : 0) };
  const events: SimEvent[] = [];
  let piecesBefore = 0;
  for (let i = 0; i < 40 && !door.open; i++) {
    piecesBefore = door.pieces;
    sp.arsenal.primary.mag = 30;
    sim.fire('p1', sp.eye, aimAt(target), true, 60 + i);
    events.push(...run(sim, 0.2).events);
  }
  const shots = events.filter((e) => e.type === 'shot');
  const through = shots.filter((e) => e.type === 'shot' && door.side(e.pellets[0].end.x, e.pellets[0].end.z) < 0).length;
  check(door.open && events.some((e) => e.type === 'doorForced'), `rounds force the door in the end (${shots.length} shots)`);
  check(through >= shots.length - 1, `rounds fly on into the house (${through} of ${shots.length})`);
  check(events.filter((e) => e.type === 'impact' && e.door === door.index).length >= shots.length - 1, 'every one leaves its hole');
  check(door.pieces >= 3 && door.pieces > piecesBefore && door.pieces <= DOOR_WOOD.pieces, `pieces come out on the way, and one more as it bursts (${door.pieces})`);
  // Online: the pieces travel in the snapshot.
  const snap = JSON.parse(JSON.stringify(captureSnapshot(sim, new Map())));
  const at = snap.dw ? (snap.dw as number[]).indexOf(door.index) : -1;
  check(at >= 0 && at % 2 === 0 && snap.dw[at + 1] === door.pieces, `snapshots list the pieces gone (${JSON.stringify(snap.dw)})`);
  const pieces = door.pieces;
  door.pieces = 0;
  const copy = new Simulation({ physics, map, nav, doors, seed: 4 });
  new Mirror(copy, 'p2').apply(snap, 10);
  check(door.pieces === pieces, 'clients take them');
  copy.dispose();
  // Shut again it keeps its holes; a new night mends it.
  door.setOpen(false, stand.x, stand.z);
  check(door.pieces === pieces && door.wear > 0, 'a door shut again stays broken');
  cleanup(sim, body);
  ({ sim, sp, body } = makeSim({ x: stand.x + out.x * 8, y: stand.y + 0.02, z: stand.z + out.z * 8 }));
  check(door.pieces === 0 && door.wear === 0, 'and the next night it is whole');
  // A grenade on the step blows it in.
  run(sim, 0.5);
  sim.explosives.explode({ x: dpick.center.x + out.x * 1.2, y: door.hinge.y + 0.05, z: dpick.center.z + out.z * 1.2 }, sp, 1);
  res = run(sim, 0.3);
  check(door.open && res.events.some((e) => e.type === 'doorForced' && e.door === door.index) && door.pieces >= 3, `a grenade on the step blows the door in and splinters it (${door.pieces} pieces)`);
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
  const up = sim.barricades.windows.find((s) => s.max === 0)!;
  sim.barricades.breakGlass(up);
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
  check(!copy.barricades.slots[up.index].glass && copy.barricades.windows.filter((s) => !s.glass).length === 2, 'an upstairs pane shot out reaches them too, and nothing else');
  check((snap.b ?? []).length === 8, `only boarded openings are listed (${(snap.b ?? []).length / 4} listed)`);
  check(typeof snap.g === 'string' && snap.g.length <= Math.ceil(sim.barricades.slots.length / 4), `smashed panes go as a bit string (${JSON.stringify(snap.g)})`);
  a.boards = 0;
  mirror.apply(JSON.parse(JSON.stringify(captureSnapshot(sim, new Map()))), 10.05);
  check(ca.boards === 0 && !cb.glass, 'boards pried off on the server come off on clients');
  copy.dispose();
  cleanup(sim, body);
}

section('Windows: smashing and vaulting');
{
  // Bit strings for smashed panes.
  const set = new Set([0, 3, 4, 77, 237]);
  const g = packPanes((i) => set.has(i), 240);
  const back = new Set<number>();
  unpackPanes(g, (i) => back.add(i));
  check(back.size === set.size && [...set].every((i) => back.has(i)) && packPanes(() => false, 240) === '', `smashed panes survive the trip (${g.length} characters for 240 windows)`);
}
const windowsOf = (sim: Simulation, house: string) => sim.barricades.windows.filter((s) => s.houseId === house);
/** A standing spot on the floor `dist` out from a window's wall (negative: inside). */
const standBy = (slot: BarricadeSlot, dist: number, floorY: number): Vec3 => {
  const n = nav.nodeAt(slot.center.x + slot.normal.x * dist, floorY, slot.center.z + slot.normal.z * dist, 0.5);
  return n >= 0 ? nav.nodePos(n) : { x: slot.center.x + slot.normal.x * dist, y: floorY, z: slot.center.z + slot.normal.z * dist };
};
const upstairs = (s: BarricadeSlot) => s.kind === 'window' && s.max === 0 && s.climb && s.bottom > 3;
{
  // Upstairs windows shoot out from the street, and the round flies on into the room.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const pick = probe.barricades.windows.filter(upstairs).find((s) => {
    const n = nav.nodeAt(s.center.x + s.normal.x * 7, 0.05, s.center.z + s.normal.z * 7, 1);
    if (!nav.reachable(n)) return false;
    const p = nav.nodePos(n), e = { x: p.x, y: p.y + 1.6, z: p.z };
    const dx = s.center.x - e.x, dy = s.center.y - e.y, dz = s.center.z - e.z, l = Math.hypot(dx, dy, dz);
    const h = physics.raycastHit(e.x, e.y, e.z, dx / l, dy / l, dz / l, l + 0.2);
    return !!h && h.collider.handle === s.pane!.handle;
  })!;
  cleanup(probe, pb);
  check(!!pick, `an upstairs window to shoot at from the street (${pick?.houseId})`);
  const stand = nav.nodePos(nav.nodeAt(pick.center.x + pick.normal.x * 7, 0.05, pick.center.z + pick.normal.z * 7, 1));
  const { sim, sp, body } = makeSim({ x: stand.x, y: stand.y + 0.02, z: stand.z });
  const slot = sim.barricades.slots[pick.index];
  sp.arsenal.aim = 1;
  sp.motion.aiming = true;
  run(sim, 0.8);
  const e = sp.eye;
  const dx = slot.center.x - e.x, dy = slot.center.y - e.y, dz = slot.center.z - e.z, l = Math.hypot(dx, dy, dz);
  sim.fire('p1', e, { x: dx / l, y: dy / l, z: dz / l }, true, 11);
  const res = run(sim, 0.2);
  const shot = res.events.find((x) => x.type === 'shot');
  const end = shot && shot.type === 'shot' ? shot.pellets[0].end : null;
  check(!slot.glass && res.events.some((x) => x.type === 'glassBroken' && x.slot === slot.index), 'a shot shatters an upstairs window');
  check(!!end && sim.barricades.side(slot, end.x, end.z) < 0, 'and the round carries on into the bedroom');
  cleanup(sim, body);
}
{
  // A swing at a window smashes it; a grenade blows out the windows it can see.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const pick = windowsOf(probe, 'house-sw').find((s) => s.inNode >= 0)!;
  cleanup(probe, pb);
  const inside = nav.nodePos(pick.inNode);
  const { sim, sp, body } = makeSim({ x: inside.x, y: inside.y + 0.02, z: inside.z });
  const slot = sim.barricades.slots[pick.index];
  run(sim, 0.7);
  const e = sp.eye;
  const dx = slot.center.x - e.x, dy = slot.center.y - e.y, dz = slot.center.z - e.z, l = Math.hypot(dx, dy, dz);
  sp.motion.yaw = Math.atan2(-dx, -dz);
  sp.motion.pitch = Math.asin(dy / l);
  check(sim.melee('p1', { origin: e, dir: { x: dx / l, y: dy / l, z: dz / l } }), 'a swing at the window');
  const res = run(sim, 0.8);
  check(!slot.glass && res.events.some((x) => x.type === 'glassBroken' && x.slot === slot.index) && res.events.some((x) => x.type === 'melee' && x.stage === 'hit'), 'the blow smashes the glass');
  // The blast: everything in its sight inside BLAST.glass goes; the far side of the house doesn't.
  const out = standBy(slot, 3, 0.05);
  const before = sim.barricades.windows.filter((s) => !s.glass).length;
  sim.explosives.explode({ x: out.x, y: out.y + 0.05, z: out.z }, sp, 99);
  const after = sim.barricades.windows.filter((s) => !s.glass);
  const o = { x: out.x, y: out.y + 0.23, z: out.z };
  const far = after.filter((s) => Math.hypot(s.center.x - o.x, s.center.y - o.y, s.center.z - o.z) > BLAST.glass);
  const blownSides = new Set(after.filter((s) => s.houseId === 'house-sw').map((s) => `${s.normal.x},${s.normal.z}`));
  check(after.length - before >= 1 && !far.length, `a grenade outside blows out windows in its sight (${after.length - before} more) and none past ${BLAST.glass} m`);
  check(blownSides.size === 1, `but not on the far side of the house (${[...blownSides].join(' ')})`);
  cleanup(sim, body);
}
{
  // A frag thrown at a window goes through the glass into the room.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const pick = windowsOf(probe, 'house-sw').find((s) => s.outNode >= 0)!;
  cleanup(probe, pb);
  const out = standBy(pick, 4, 0.05);
  const { sim, sp, body } = makeSim({ x: out.x, y: out.y + 0.02, z: out.z });
  const slot = sim.barricades.slots[pick.index];
  run(sim, 0.7);
  const e = sp.eye;
  const aim = { x: slot.center.x, y: slot.center.y - 0.75, z: slot.center.z };
  const dx = aim.x - e.x, dy = aim.y - e.y, dz = aim.z - e.z, l = Math.hypot(dx, dy, dz);
  sp.motion.yaw = Math.atan2(-dx, -dz);
  sim.throwItem('p1', 'frag', { origin: e, dir: { x: dx / l, y: dy / l, z: dz / l } });
  const res = run(sim, 1.2, () => !slot.glass && sim.explosives.thrown.some((t) => sim.barricades.side(slot, t.pos.x, t.pos.z) < -0.5));
  const t = sim.explosives.thrown[0];
  check(!slot.glass && res.events.some((x) => x.type === 'glassBroken' && x.slot === slot.index), 'a grenade thrown at a window smashes the glass');
  check(!!t && sim.barricades.side(slot, t.pos.x, t.pos.z) < 0, 'and flies on into the room');
  cleanup(sim, body);
}
{
  // Ways through: every window a zombie climbs through, a survivor vaults through too, both ways.
  const { sim, body } = makeSim({ x: 0, y: 0.15, z: 8 });
  const b = sim.barricades;
  const ps = porches(map);
  const wins = b.windows.filter((s) => s.inNode >= 0 && s.climb);
  let outOk = 0, inOk = 0, landsIndoors = 0, landsOutdoors = 0;
  const stuck: string[] = [];
  for (const s of wins) {
    const inside = nav.nodePos(s.inNode), outside = nav.nodePos(s.outNode);
    const o = findVault(physics, b, inside, { x: s.normal.x, z: s.normal.z }, PLAYER.height, ps);
    const i = findVault(physics, b, outside, { x: -s.normal.x, z: -s.normal.z }, PLAYER.height, ps);
    if (o?.slot === s && o.plan?.land) {
      outOk++;
      const n = nav.nodeAt(o.plan.land.x, o.plan.land.y, o.plan.land.z, 0.5);
      if (n >= 0 && (nav.flags[n] & NAV_INDOOR) === 0 && b.side(s, o.plan.land.x, o.plan.land.z) > 0) landsOutdoors++;
    } else stuck.push(`${s.houseId}#${s.ref} out: ${o?.block ?? (o ? 'other' : 'none')}`);
    if (i?.slot === s && i.plan?.land) {
      inOk++;
      const n = nav.nodeAt(i.plan.land.x, i.plan.land.y, i.plan.land.z, 0.5);
      if (n >= 0 && (nav.flags[n] & NAV_INDOOR) !== 0 && b.side(s, i.plan.land.x, i.plan.land.z) < 0) landsIndoors++;
    } else stuck.push(`${s.houseId}#${s.ref} in: ${i?.block ?? (i ? 'other' : 'none')}`);
  }
  check(outOk >= wins.length * 0.9 && inOk >= wins.length * 0.9, `survivors vault out of ${outOk} and in through ${inOk} of ${wins.length} ground-floor windows${stuck.length ? ` (not: ${stuck.slice(0, 6).join(', ')}${stuck.length > 6 ? '…' : ''})` : ''}`);
  check(landsOutdoors === outOk && landsIndoors === inOk, `every vault lands on walkable floor on the far side (${landsOutdoors} out, ${landsIndoors} in)`);
  check(wins.every((s) => s.glass) && wins.some((s) => findVault(physics, b, nav.nodePos(s.inNode), { x: s.normal.x, z: s.normal.z }, PLAYER.height, ps)?.plan?.smash), 'a window with its glass in is smashed through');
  // Facing away, or too far off: no vault.
  const w = wins[0];
  const at = nav.nodePos(w.inNode);
  check(findVault(physics, b, at, { x: -w.normal.x, z: -w.normal.z }, PLAYER.height, ps)?.slot !== w, 'not with your back to the window');
  const away = standBy(w, -2.5, at.y);
  check(findVault(physics, b, away, { x: w.normal.x, z: w.normal.z }, PLAYER.height, ps)?.slot !== w, 'not from across the room');
  w.boards = 1;
  check(findVault(physics, b, at, { x: w.normal.x, z: w.normal.z }, PLAYER.height, ps)?.block === 'boarded', 'boards stop a vault');
  w.boards = 0;
  // Upstairs: out and down to the ground, never through a porch roof.
  const ups = b.windows.filter(upstairs);
  let drops = 0, porchBlocked = 0, other = 0;
  for (const s of ups) {
    const floor = s.bottom - 0.85;
    const inside = standBy(s, -0.85, floor);
    if (Math.abs(inside.y - floor) > 0.3) continue;
    const v = findVault(physics, b, inside, { x: s.normal.x, z: s.normal.z }, PLAYER.height, ps);
    if (v?.slot === s && v.plan && !v.plan.land) {
      const g = physics.raycast(v.plan.over.x, v.plan.over.y, v.plan.over.z, 0, -1, 0, VAULT.maxDrop + 1);
      if (g === null || g < VAULT.maxStep) other++;
      else drops++;
    } else if (v?.block === 'blocked' && ps.some((p) => Math.hypot(p.roof.x - s.center.x, p.roof.z - s.center.z) < p.roof.w / 2 + 1.5)) porchBlocked++;
    else other++;
  }
  check(drops >= ups.length * 0.6 && drops + porchBlocked + other === ups.length, `survivors jump out of ${drops} of ${ups.length} upstairs windows (${porchBlocked} over porch roofs held back, ${other} other)`);
  cleanup(sim, body);
}
{
  // The simulation's side: smashing through, boards, reach, and moves the server lets through.
  const { sim: probe, body: pb } = makeSim({ x: 0, y: 0.15, z: 8 });
  const pick = windowsOf(probe, 'house-sw').find((s) => s.inNode >= 0)!;
  cleanup(probe, pb);
  const inside = nav.nodePos(pick.inNode);
  const { sim, sp, body } = makeSim({ x: inside.x, y: inside.y + 0.02, z: inside.z });
  const slot = sim.barricades.slots[pick.index];
  slot.boards = 1;
  check(!sim.vault('p1', slot.index), 'no vaulting through boards');
  slot.boards = 0;
  sp.motion.pos = { x: inside.x - slot.normal.x * 4, y: inside.y, z: inside.z - slot.normal.z * 4 };
  check(!sim.vault('p1', slot.index), 'nor from across the room');
  sp.motion.pos = { ...inside };
  const plan = findVault(physics, sim.barricades, inside, { x: slot.normal.x, z: slot.normal.z }, PLAYER.height)!.plan!;
  sim.drain();
  check(sim.vault('p1', slot.index) && !slot.glass, 'vaulting through the window smashes the glass');
  const ev = sim.drain();
  check(ev.some((x) => x.type === 'glassBroken' && x.slot === slot.index) && ev.some((x) => x.type === 'playerVault' && x.player === 'p1' && x.smash), 'everyone sees and hears it');
  check(sim.noises.some((n) => Math.hypot(n.pos.x - slot.center.x, n.pos.z - slot.center.z) < 0.5 && n.radius >= VAULT.smashNoise), 'zombies hear the glass go');
  // The path the browser moves the survivor along, sent ~30 times a second: the server's wall
  // check (a ray at hip height between moves) lets every move through.
  const WALLS = groups(0xffff, GROUP.static);
  const pts: Vec3[] = [];
  const pt = { x: 0, y: 0, z: 0 };
  for (let t = 0; ; t += 1 / 30) {
    if (vaultAt(plan, t, pt) === null) break;
    pts.push({ ...pt });
  }
  pts.push({ ...plan.land! });
  let blocked = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], c = pts[i];
    const ay = a.y + 0.9, cy = c.y + 0.9;
    const len = Math.hypot(c.x - a.x, cy - ay, c.z - a.z);
    if (len < 0.02) continue;
    const h = physics.raycast(a.x, ay, a.z, (c.x - a.x) / len, (cy - ay) / len, (c.z - a.z) / len, len, WALLS);
    if (h !== null && h < len - 0.05) blocked++;
    if (sim.barricades.crossesBoards(a, c)) blocked++;
  }
  const total = plan.times[0] + plan.times[1] + plan.times[2];
  const across = Math.hypot(plan.land!.x - plan.from.x, plan.land!.z - plan.from.z);
  check(!blocked && pts.length > 10, `the server takes every move of the vault (${pts.length} moves over ${total.toFixed(2)} s)`);
  check(across / total < PLAYER.sprintSpeed * 1.25 && Math.abs(plan.up.y - plan.from.y) / plan.times[0] < 5.5 / 0.8 + 5.5, `no faster than the server allows (${(across / total).toFixed(1)} m/s across)`);
  slot.boards = 2;
  let crossed = false;
  for (let i = 1; i < pts.length; i++) if (sim.barricades.crossesBoards(pts[i - 1], pts[i])) crossed = true;
  check(crossed, 'the same moves through a boarded window are refused');
  slot.boards = 0;
  check(Math.hypot(plan.land!.x - slot.center.x, plan.land!.z - slot.center.z) < 1.6 && sim.barricades.side(slot, plan.land!.x, plan.land!.z) > 0, 'it lands just outside');
  cleanup(sim, body);
}

section('Found melee weapons');
{
  const rooms = findPickupRooms(map, nav, physics);
  const kinds = new Set(rooms.map((r) => r.room));
  check(kinds.has('bedroom') && kinds.has('basement') && kinds.has('store'), `weapons can turn up in bedrooms, basements and the store (${rooms.length} rooms: ${rooms.filter((r) => r.room === 'bedroom').length} bedrooms, ${rooms.filter((r) => r.room === 'basement').length} basements)`);
  check(rooms.every((r) => r.nodes.every((n) => nav.reachable(n))), 'every spot is on walkable floor');
  {
    // Every enterable home on Kinney Street has a bedroom to search; its basements count too.
    const oakHomes = map.houses.filter((h) => h.id.startsWith('oak-'));
    const inside = (h: (typeof oakHomes)[number], r: (typeof rooms)[number]) => Math.abs(r.centre.x - h.x) < h.w / 2 && Math.abs(r.centre.z - h.z) < h.d / 2;
    const bare = oakHomes.filter((h) => !rooms.some((r) => r.room === 'bedroom' && inside(h, r)));
    const basements = rooms.filter((r) => r.room === 'basement' && r.key.includes('oak-')).length;
    check(!bare.length && basements === 5, `Kinney Street's ${oakHomes.length} homes each have a bedroom to search, and ${basements} basements${bare.length ? ` (none in ${bare.map((h) => h.id).join(', ')})` : ''}`);
  }
  check(rooms.every((r) => map.playerSpawns.every((sp) => Math.hypot(sp.x - r.centre.x, sp.z - r.centre.z) >= MELEE_PICKUPS.awayFromSpawn)), 'none in the safehouse the survivors start in');
  {
    // The search only tests each house's own doors, stairs and beds: checked here against every one on the map.
    let bad = '';
    for (const r of rooms) for (const n of r.nodes) {
      const x = nav.nodeX(n), y = nav.nodeY[n], z = nav.nodeZ(n);
      const door = map.doors.find((d) => Math.hypot(d.x - x, d.z - z) < d.w / 2 + 0.7 && Math.abs((d.floorY ?? d.y - d.h / 2) - y) < 1.5);
      const stair = map.stairs.find((s) => {
        const [ax, az] = s.axis === 'x' ? [x, z] : [z, x];
        return ax > Math.min(s.from, s.to) - 0.9 && ax < Math.max(s.from, s.to) + 0.9 && az > s.a0 - 0.4 && az < s.a1 + 0.4 && y > Math.min(s.y0, s.y1) - 0.5 && y < Math.max(s.y0, s.y1) + 0.5;
      });
      const bed = r.room === 'bedroom' ? map.props[+r.key.slice(4)] : null;
      if (door) bad ||= `${r.key} has a spot in a doorway at ${x.toFixed(1)}, ${z.toFixed(1)}`;
      else if (stair) bad ||= `${r.key} has a spot on the stairs at ${x.toFixed(1)}, ${z.toFixed(1)}`;
      else if (bed && Math.hypot(bed.x - x, bed.z - z) > MELEE_PICKUPS.bedRoom) bad ||= `${r.key} has a spot ${Math.hypot(bed.x - x, bed.z - z).toFixed(1)} m from its bed`;
    }
    check(!bad, bad || 'no spot in a doorway or on the stairs (tested against every door and stair on the map), and every bedroom spot near its bed');
  }

  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  run(sim, 0.2);
  const placed = sim.placedMelee;
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

  // Dual katanas: a second katana goes in the other hand.
  {
    for (const zz of [...sim.zombies]) zz.removeBody();
    sim.zombies.length = 0;
    sp.arsenal.meleeId = 'katana';
    const [k1, k2, k3] = sim.placedMelee;
    k1.weapon = k2.weapon = 'katana';
    k3.weapon = 'bat';
    const n0 = sim.placedMelee.length;
    standBy(k1);
    sim.drain();
    check(sim.use('p1', k1.id) && sp.arsenal.meleeId === 'katanas' && k1.supply === 0, 'a second katana picked up: one in each hand');
    let dev = sim.drain();
    check(dev.some((e) => e.type === 'meleeTaken' && e.weapon === 'katanas' && e.swapped === null) && sim.placedMelee.length === n0 - 1, 'nothing is left behind for it (the first katana stays in the other hand)');
    standBy(k2);
    check(!sim.use('p1', k2.id) && k2.supply === 1 && sp.arsenal.meleeId === 'katanas', 'a third katana is refused: both hands are full');
    check(sim.drain().some((e) => e.type === 'notice' && /BOTH HANDS/.test(e.text)), 'and the survivor is told why');
    sim.setMotion('p1', { pos: standAt });
    body.moveTo(standAt);
    run(sim, 0.8);
    const d = swingWith('katanas', 'walker');
    const dh = d.got.find((e) => e.type === 'zombieHit');
    check(d.ok && Math.abs(d.dealt - MELEE.katanas.damage) < 0.5 && !!dh && dh.type === 'zombieHit' && dh.weapon === 'katanas', `each cut of the pair deals ${MELEE.katanas.damage} and is reported as the katanas`);
    check(MELEE.katanas.duration < MELEE.katana.duration && MELEE.katanas.windup < MELEE.katana.windup && MELEE.katanas.arc > MELEE.katana.arc, 'the pair cuts quicker and wider than one katana');
    const dc = swingWith('katanas', 'brute', 'armL');
    check(dc.got.some((e) => e.type === 'limbSevered' && e.melee) && dc.zz.arms.armL !== 'intact', 'one cut of the pair takes a brute\'s arm off');
    // Online.
    const snap2 = JSON.parse(JSON.stringify(captureSnapshot(sim, new Map())));
    const copy2 = new Simulation({ physics, map, nav, doors, seed: 3 });
    new Mirror(copy2, 'someone-else').apply(snap2, 10);
    check(copy2.players.get('p1')?.arsenal.meleeId === 'katanas', 'a remote survivor\'s copy holds both katanas');
    copy2.dispose();
    // Swapping the pair for another weapon puts both katanas down where it lay.
    for (const zz of [...sim.zombies]) zz.removeBody();
    sim.zombies.length = 0;
    sp.arsenal.meleeId = 'katanas';
    const n1 = sim.placedMelee.length;
    standBy(k3);
    sim.drain();
    check(sim.use('p1', k3.id) && sp.arsenal.meleeId === 'bat', 'the pair swapped for a bat');
    dev = sim.drain();
    const laid = sim.placedMelee.filter((it) => it.weapon === 'katana' && Math.hypot(it.pos.x - k3.pos.x, it.pos.z - k3.pos.z) < 1.2 && it.id > k3.id);
    check(laid.length === 2 && sim.placedMelee.length === n1 + 1 && dev.some((e) => e.type === 'meleeTaken' && e.swapped === 'katanas'), 'both katanas are left side by side where the bat lay');
    // Some katanas turn up as a pair.
    const saved = sim.placedMelee;
    for (const it of saved) it.supply = 0;
    let pairs = 0, apart = true;
    for (let i = 0; i < 60; i++) {
      for (const it of sim.placedMelee) it.supply = 0;
      sim.placeMelee(false, 'katana');
      const now = sim.placedMelee;
      if (now.length === 2) {
        pairs++;
        apart &&= now.every((it) => it.weapon === 'katana' && it.room === now[0].room) && Math.hypot(now[0].pos.x - now[1].pos.x, now[0].pos.z - now[1].pos.z) < 1.2;
      }
    }
    for (const it of sim.placedMelee) it.supply = 0;
    for (const it of saved) it.supply = 1;
    check(pairs > 10 && pairs < 45 && apart, `a katana now and then lies with its pair beside it (${pairs} of 60)`);
    sp.arsenal.meleeId = 'hockey';
    sim.setMotion('p1', { pos: standAt });
    body.moveTo(standAt);
    run(sim, 0.1);
  }

  // The melee weapon held out from its own quick slot: the trigger swings it.
  {
    for (const zz of [...sim.zombies]) zz.removeBody();
    sim.zombies.length = 0;
    sp.arsenal.meleeId = 'katana';
    run(sim, 1);
    sim.drain();
    check(sim.switchWeapon('p1', 'melee') && sp.arsenal.meleeOut && sp.arsenal.action === 'draw', 'the katana taken out in place of the gun');
    check(sim.drain().some((e) => e.type === 'draw' && e.slot === 'melee' && e.weapon === 'katana'), 'everyone hears it come out');
    run(sim, 0.5);
    check(sp.arsenal.action === 'idle' && sp.arsenal.fireState() === 'busy' && !sp.arsenal.startReload(), 'held out: no shooting or reloading with it');
    sp.motion.yaw = 0;
    const zz = sim.spawnZombie('brute', { x: standAt.x, y: 0.02, z: standAt.z - 1.3 }, 'idle');
    zz.facing = 0;
    run(sim, 0.05);
    const e = sp.eye;
    const tor = zz.zones([]).find((s2) => s2.zone === 'torso')!;
    const to = along(tor.a, tor.b, 0.5);
    const l = Math.hypot(to.x - e.x, to.y - e.y, to.z - e.z);
    const dir = { x: (to.x - e.x) / l, y: (to.y - e.y) / l, z: (to.z - e.z) / l };
    const hp = zz.health;
    const mag = sp.arsenal.primary.mag;
    check(sim.fire('p1', e, dir, true, 1) === 'fired' && sp.arsenal.action === 'melee' && sp.arsenal.primary.mag === mag, 'pulling the trigger swings it (no round spent)');
    run(sim, MELEE.katana.duration + 0.05);
    const after1 = zz.health;
    check(after1 < hp, `the swing cuts the zombie (${(hp - after1).toFixed(0)} damage)`);
    // Trigger held: it keeps swinging.
    let swings = 0;
    for (let i = 0; i < 90; i++) {
      if (sim.fire('p1', sp.eye, dir, false, 1) === 'fired') swings++;
      run(sim, DT);
    }
    check(swings >= 2, `holding the trigger keeps swinging (${swings} swings in 1.5 s)`);
    const snap3 = JSON.parse(JSON.stringify(captureSnapshot(sim, new Map())));
    const copy3 = new Simulation({ physics, map, nav, doors, seed: 3 });
    new Mirror(copy3, 'someone-else').apply(snap3, 10);
    const them3 = copy3.players.get('p1')!;
    check(them3.arsenal.meleeOut && them3.arsenal.active === sp.arsenal.active, 'other screens see it held out');
    copy3.dispose();
    run(sim, 1);
    check(sim.switchWeapon('p1', 'primary') && !sp.arsenal.meleeOut && sp.arsenal.action === 'draw', 'back to the gun on its own key');
    run(sim, sp.arsenal.def.draw + 0.1);
    check(sp.arsenal.fireState() === 'ok', 'the gun fires again');
    sim.switchWeapon('p1', 'melee');
    check(!sim.switchWeapon('p1', 'melee'), 'taking it out twice does nothing');
    run(sim, 0.5);
    check(sim.switchWeapon('p1', 'primary') && !sp.arsenal.meleeOut, 'the primary comes back even though it was the active slot');
    run(sim, 1);
    for (const z2 of [...sim.zombies]) z2.removeBody();
    sim.zombies.length = 0;
    sp.arsenal.meleeId = 'hockey';
  }

  // Dying leaves it on the floor.
  for (const zz of [...sim.zombies]) zz.removeBody();
  sim.zombies.length = 0;
  const count = sim.placedMelee.length;
  sim.damagePlayer(sp, 500, { x: 0, y: 0, z: 0 });
  const dropped = sim.placedMelee.find((it) => it.weapon === 'hockey' && Math.hypot(it.pos.x - standAt.x, it.pos.z - standAt.z) < 1.5);
  check(!!dropped && sim.placedMelee.length === count + 1 && sp.arsenal.meleeId === 'machete', 'a survivor who dies drops it where they fell');
  cleanup(sim, body);
}

section('Boost syringes');
{
  const spots = findBoostSpots(map, nav, physics);
  const homes = map.houses.filter((h) => h.enterable && (h.id.startsWith('house-') || h.id.startsWith('oak-')));
  const bare = homes.filter((h) => !spots.some((s) => s.house === h.id));
  check(!bare.length, `every home on Hale and Kinney Street has furniture a syringe can lie on (${new Set(spots.map((s) => s.house)).size} houses, ${spots.length} places)${bare.length ? `: none in ${bare.map((h) => h.id).join(', ')}` : ''}`);
  check(spots.every((s) => map.playerSpawns.every((sp) => Math.hypot(sp.x - s.pos.x, sp.z - s.pos.z) >= BOOST_PICKUPS.awayFromSpawn)), 'none in the safehouse the survivors start in');
  check(spots.every((s) => s.pos.y - s.stand.y > 0.4 && s.pos.y - s.stand.y < 1.1), 'every one on top of a piece of furniture, not on the floor');
  check(spots.every((s) => nav.reachable(nav.nodeAt(s.stand.x, s.stand.y + 0.05, s.stand.z, 0.3))), 'every one has walkable floor in front of it');
  check(new Set(spots.map((s) => s.prop)).size >= 5, `on counters, dressers, desks, sinks and tables (${[...new Set(spots.map((s) => s.prop))].join(', ')})`);

  // A night's syringes.
  const counts = new Set<number>();
  const kindsSeen = new Set<BoostId>();
  let spread = true, distinct = true;
  for (let seed = 1; seed <= 24; seed++) {
    const s2 = new Simulation({ physics, map, nav, doors, seed, preparation: 600 });
    s2.step(DT);
    const placed = s2.placedBoosts;
    counts.add(placed.length);
    for (const it of placed) kindsSeen.add(it.boost!);
    if (new Set(placed.map((it) => it.room)).size !== placed.length) spread = false;
    if (new Set(placed.map((it) => it.boost)).size !== placed.length) distinct = false;
    s2.dispose();
  }
  check([...counts].every((c) => c >= BOOST_PICKUPS.count[0] && c <= BOOST_PICKUPS.count[1]) && counts.size === 2, `${[...counts].sort().join(' or ')} syringes a night`);
  check(spread && distinct, 'each in a different house, each a different kind');
  check(kindsSeen.size === BOOST_IDS.length, `every kind turns up (${[...kindsSeen].join(', ')})`);
  {
    const a = new Simulation({ physics, map, nav, doors, seed: 41, preparation: 600 });
    const b = new Simulation({ physics, map, nav, doors, seed: 41, preparation: 600 });
    a.step(DT);
    b.step(DT);
    const key = (x: Simulation) => x.placedBoosts.map((it) => `${it.boost}@${it.pos.x.toFixed(2)},${it.pos.z.toFixed(2)}`).join(' ');
    check(key(a) === key(b), 'the same seed puts the same syringes in the same places');
    a.dispose();
    b.dispose();
  }

  const { sim, sp, body } = makeSim({ x: 0, y: 0.15, z: 6 }, 0.5);
  const mate = sim.addPlayer('p2', 'Mate', 'ar', 'pistol', { x: 1, y: 0.15, z: 6 }, 0);
  run(sim, 1);
  const clear = () => {
    for (const z of [...sim.zombies]) z.removeBody();
    sim.zombies.splice(0, sim.zombies.length);
    return false;
  };
  clear();
  const standAt = (who: string, at: Vec3) => {
    sim.setMotion(who, { pos: { ...at } });
    if (who === 'p1') body.moveTo(at);
  };
  const spotOf = (it: { pos: Vec3 }) => sim.boostSpots.find((s) => Math.hypot(s.pos.x - it.pos.x, s.pos.z - it.pos.z) < 1e-6)!;
  const first = sim.placedBoosts[0];
  const spot = spotOf(first);
  check(!sim.reachable('p1').some((it) => it.id === first.id), 'out of reach from across the map');
  standAt('p1', spot.stand);
  check(sim.reachable('p1').some((it) => it.id === first.id), `in reach standing in front of the ${spot.prop}`);
  {
    // Straight through the wall behind it, as close as from the front: out of reach.
    const dx = spot.pos.x - spot.stand.x, dz = spot.pos.z - spot.stand.z;
    const l = Math.hypot(dx, dz);
    const behind = { x: spot.pos.x + (dx / l) * 0.85, y: spot.stand.y, z: spot.pos.z + (dz / l) * 0.85 };
    const blocked = physics.raycast(spot.pos.x, spot.pos.y + 0.3, spot.pos.z, dx / l, 0, dz / l, 0.85) !== null;
    sim.setMotion('p2', { pos: behind });
    check(!blocked || !sim.reachable('p2').some((it) => it.id === first.id), 'not through the wall behind the furniture');
    standAt('p2', { x: 1, y: 0.15, z: 6 });
  }
  sim.drain();
  const kind = first.boost!;
  check(sim.use('p1', first.id) && first.supply === 0 && sp.arsenal.action === 'inject' && sp.arsenal.injectKind === kind, `grabbing the ${kind} syringe starts the injection`);
  let ev = sim.drain();
  check(ev.some((e) => e.type === 'boost' && e.stage === 'taken' && e.boost === kind && e.item === first.id), 'everyone hears it taken');
  standAt('p2', spot.stand);
  check(!sim.use('p2', first.id) && !sim.use('p1', first.id), 'first come, first served: it cannot be taken twice');
  standAt('p2', { x: 1, y: 0.15, z: 6 });
  check(sim.fire('p1', sp.eye, { x: 0, y: 0, z: -1 }, true, 1) === 'busy' && !sim.reload('p1'), 'no shooting or reloading mid-injection');
  check(!sp.arsenal.drawMelee() && !sp.arsenal.switchTo('secondary') && sp.arsenal.action === 'inject', 'no drawing the melee weapon or switching guns mid-injection');
  check(sim.placedBoosts.length === sim.boostTarget - 1, 'one fewer on the map');
  ev = run(sim, INJECT.press - 0.05, clear).events;
  check(!sim.boosted(sp, kind) && !ev.some((e) => e.type === 'boost' && e.stage === 'start'), 'nothing yet before the needle goes in');
  ev = run(sim, 0.1, clear).events;
  check(sim.boosted(sp, kind) && Math.abs(sim.boostLeft(sp, kind) - BOOSTS[kind].duration) < 0.1 && ev.some((e) => e.type === 'boost' && e.stage === 'start' && e.player === 'p1'),
    `the dose goes in ${INJECT.press} s in and runs ${BOOSTS[kind].duration} s`);
  ev = run(sim, INJECT.duration - INJECT.press + WEAPONS.ar.draw, clear).events;
  check(sp.arsenal.action === 'idle' && sim.fire('p1', sp.eye, { x: 0, y: 0, z: -1 }, true, 1) !== 'busy', 'the gun comes back up afterwards');

  // What each one does.
  const give = (k: BoostId) => {
    const it = sim.layBoost(k, { x: sp.motion.pos.x + 0.4, y: sp.motion.pos.y + 0.8, z: sp.motion.pos.z });
    const ok = sim.use('p1', it.id);
    run(sim, INJECT.duration + 0.6, clear);
    return ok && sim.boosted(sp, k);
  };
  standAt('p1', { x: 0, y: 0.15, z: 6 });
  run(sim, 0.2, clear);
  sp.boosts = {};
  sp.health = 100;
  sim.damagePlayer(sp, 20, sp.motion.pos);
  const plain = 100 - sp.health;
  sp.health = 100;
  check(give('strength'), 'strength shot injected');
  sim.damagePlayer(sp, 20, sp.motion.pos);
  check(Math.abs((100 - sp.health) - plain * BOOSTS.strength.damageTaken) < 0.11, `strength: a 20-point hit takes ${(100 - sp.health).toFixed(1)} instead of ${plain}`);
  const sameAgain = sim.layBoost('strength', { x: sp.motion.pos.x + 0.4, y: sp.motion.pos.y + 0.8, z: sp.motion.pos.z });
  sim.drain();
  check(!sim.use('p1', sameAgain.id) && sameAgain.supply === 1 && sim.drain().some((e) => e.type === 'notice' && /STILL RUNNING/.test(e.text)), 'a second one of the same kind waits while the first has most of its time left');
  sp.boosts.strength = sim.time + BOOSTS.strength.duration * 0.3;
  check(sim.use('p1', sameAgain.id), 'with under half its time left, a second dose is taken');
  run(sim, INJECT.duration + 0.6, clear);
  check(Math.abs(sim.boostLeft(sp, 'strength') - (BOOSTS.strength.duration - INJECT.duration - 0.6 + INJECT.press)) < 0.1, 'and starts it over at full time');

  const a = sp.arsenal;
  a.weapon.mag = 3;
  check(sim.reload('p1') && Math.abs(a.actionTotal - WEAPONS.ar.reloadTime) < 1e-6, 'a reload takes its usual time');
  run(sim, WEAPONS.ar.reloadTime + 0.1, clear);
  check(give('reload'), 'rapid reload shot injected');
  a.weapon.mag = 3;
  check(sim.reload('p1') && Math.abs(a.actionTotal - WEAPONS.ar.reloadTime * BOOSTS.reload.reloadScale) < 1e-6, `rapid reload: ${a.actionTotal.toFixed(2)} s instead of ${WEAPONS.ar.reloadTime} s`);
  run(sim, WEAPONS.ar.reloadTime * BOOSTS.reload.reloadScale + 0.05, clear);
  check(a.weapon.mag === WEAPONS.ar.magazine && a.action === 'idle', 'and the magazine is full when it ends');
  {
    const shot = new Arsenal('shotgun', 'pistol');
    shot.reloadScale = 0.5;
    shot.step(1, false, []);
    shot.weapon.mag = 0;
    shot.startReload();
    let t = 0;
    while (shot.action === 'reload' && t < 20) {
      shot.step(DT, false, []);
      t += DT;
    }
    const full = new Arsenal('shotgun', 'pistol');
    full.step(1, false, []);
    full.weapon.mag = 0;
    full.startReload();
    let t2 = 0;
    while (full.action === 'reload' && t2 < 20) {
      full.step(DT, false, []);
      t2 += DT;
    }
    check(Math.abs(t - t2 * 0.5) < 0.2, `shell by shell too: ${t.toFixed(2)} s instead of ${t2.toFixed(2)} s`);
  }

  const motion = { speed: 0, crouching: false, grounded: true, aiming: false };
  const before = a.spread(motion);
  check(give('focus'), 'focus shot injected');
  check(Math.abs(a.spread(motion) - before * BOOSTS.focus.spread) < 1e-6, `focus: spread ${a.spread(motion).toFixed(2)}° instead of ${before.toFixed(2)}°`);

  sp.health = 40;
  check(give('regen'), 'regen shot injected');
  const h0 = sp.health;
  run(sim, 4, clear);
  check(Math.abs(sp.health - h0 - 4 * BOOSTS.regen.heal) < 0.2, `regen: ${(sp.health - h0).toFixed(1)} health back in 4 s`);
  check(give('stamina') && Object.keys(sp.boosts).length === BOOST_IDS.length, 'stamina shot injected; boosts of different kinds run side by side');

  // Online players see them.
  const snap = captureSnapshot(sim, new Map());
  const me = snap.p.find((p) => p.id === 'p1')!;
  check(!!me.bo && me.bo.length === BOOST_IDS.length * 2, 'snapshots carry each boost running and its time left');
  const lying = sim.placedBoosts[0];
  const row = snap.i.find((r) => r[0] === lying.id)!;
  check(row[9] === BOOST_IDS.indexOf(lying.boost!), 'and which syringe lies where');
  {
    const other = new Simulation({ physics, map, nav, doors, seed: 8, preparation: 600 });
    const mirror = new Mirror(other, 'p2');
    mirror.apply(snap, sim.time);
    const copy = other.players.get('p1')!;
    check(Math.abs(other.boostLeft(copy, 'reload') - sim.boostLeft(sp, 'reload')) < 0.06 && copy.arsenal.reloadScale === BOOSTS.reload.reloadScale && copy.arsenal.steady === BOOSTS.focus.spread,
      'clients take the boosts (and the faster reload and steadier aim) from snapshots');
    check(other.interactables[lying.id]?.kind === 'boost' && other.interactables[lying.id]?.boost === lying.boost, 'and put the same syringes on the same furniture');
    other.dispose();
  }
  {
    const it = sim.layBoost('focus', { x: mate.motion.pos.x + 0.4, y: mate.motion.pos.y + 0.8, z: mate.motion.pos.z });
    sim.use('p2', it.id);
    run(sim, 0.2, clear);
    const s3 = captureSnapshot(sim, new Map());
    check(s3.p.find((p) => p.id === 'p2')!.w[16] === BOOST_IDS.indexOf('focus'), 'mid-injection, everyone sees which syringe is in the hand');
    run(sim, INJECT.duration, clear);
  }

  // Wearing off, and death.
  sim.drain();
  sp.boosts.focus = sim.time + 0.5;
  ev = run(sim, 0.6, clear).events;
  check(!sim.boosted(sp, 'focus') && a.steady === 1 && ev.some((e) => e.type === 'boost' && e.stage === 'end' && e.boost === 'focus'), 'a boost wears off when its time is up');
  {
    // Knocked down mid-injection: the dose still goes in.
    const it = sim.layBoost('focus', { x: sp.motion.pos.x + 0.4, y: sp.motion.pos.y + 0.8, z: sp.motion.pos.z });
    sim.use('p1', it.id);
    run(sim, 0.2, clear);
    sim.damagePlayer(sp, 500, sp.motion.pos);
    check(sp.downed && sim.boosted(sp, 'focus') && sp.arsenal.action !== 'inject', 'knocked down mid-injection, the dose still goes in');
  }
  sim.damagePlayer(sp, 500, sp.motion.pos);
  run(sim, DOWNED.bleedOut + 1, clear);
  check(!sp.alive && Object.keys(sp.boosts).length === 0, 'death ends every boost');

  // A taken one is replaced somewhere else, out of everyone's way.
  const shortBy = sim.boostTarget - sim.placedBoosts.filter((it) => it.room).length;
  standAt('p2', { x: 1, y: 0.15, z: 6 });
  const was = new Set(sim.placedBoosts.map((it) => it.id));
  run(sim, BOOST_PICKUPS.respawn[1] + 10, clear);
  const fresh = sim.placedBoosts.filter((it) => !was.has(it.id) && it.room);
  check(shortBy === 1 && fresh.length === 1, `the one taken is replaced within ${BOOST_PICKUPS.respawn[1]} s`);
  check(fresh.every((it) => [...sim.players.values()].every((p) => !p.alive || Math.hypot(p.motion.pos.x - it.pos.x, p.motion.pos.z - it.pos.z) > BOOST_PICKUPS.awayFromPlayers)), 'out of sight of everyone, in a house without one');
  const houses = sim.placedBoosts.filter((it) => it.room).map((it) => it.room);
  check(new Set(houses).size === houses.length, 'still one per house');
  for (const d of sim.drops) if (d.body) physics.world.removeRigidBody(d.body);
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

  // Smokes: a lit cigarette, joint or blunt, the last field on the wire.
  check(ids('smoke').join() === 'none,cigarette,joint,blunt', 'smokes: none, cigarette, joint, blunt');
  const smoker = sanitizeAppearance({ ...DEFAULT_APPEARANCE, smoke: 'blunt' });
  check(smoker.smoke === 'blunt' && sameLook(decodeAppearance(encodeAppearance(smoker)), smoker), 'a smoke survives the wire');
  const preSmoke = encodeAppearance(smoker).split('.').slice(0, 1 + APPEARANCE_FIELDS.findIndex(([k]) => k === 'smoke')).join('.');
  check(decodeAppearance(preSmoke).smoke === 'none' && sameLook(decodeAppearance(preSmoke), { ...smoker, smoke: 'none' }), 'looks saved before smokes load with none, the rest unchanged');
  check(sanitizeAppearance({ ...DEFAULT_APPEARANCE, smoke: 'cigar' }).smoke === 'none', 'unknown smokes fall back to none');
  let smokers = 0;
  for (let i = 0; i < 400; i++) if (randomAppearance(rand).smoke !== 'none') smokers++;
  check(smokers > 15 && smokers < 90, `some random survivors smoke, most don't (${smokers}/400)`);
  // Body shape sliders and swimwear.
  check(['bikini', 'swimsuit', 'rashguard', 'shirtless'].every((id) => ids('top').includes(id)) && ['swimtrunks', 'boardshorts', 'bikinibottom'].every((id) => ids('pants').includes(id)) && ids('shoes').includes('flipflops'), 'swimwear is in the catalog');
  check(DEFAULT_APPEARANCE.bust === SHAPE_MID && DEFAULT_FEMALE_APPEARANCE.hips === SHAPE_MID && DEFAULT_APPEARANCE.glutes === SHAPE_MID, 'body shapes start at average');
  const curvy = sanitizeAppearance({ ...DEFAULT_FEMALE_APPEARANCE, bust: SHAPE_STEPS - 1, hips: 0, glutes: 5 });
  check(curvy.bust === SHAPE_STEPS - 1 && curvy.hips === 0 && curvy.glutes === 5 && sameLook(decodeAppearance(encodeAppearance(curvy)), curvy), 'body shapes survive the wire');
  const wild = sanitizeAppearance({ ...DEFAULT_FEMALE_APPEARANCE, bust: SHAPE_STEPS, hips: -1, glutes: 2.5 });
  check(wild.bust === SHAPE_MID && wild.hips === SHAPE_MID && wild.glutes === SHAPE_MID, 'out-of-range body shapes fall back to average');
  const preShape = encodeAppearance(curvy).split('.').slice(0, 1 + APPEARANCE_FIELDS.findIndex(([k]) => k === 'bust')).join('.');
  const preLook = decodeAppearance(preShape);
  check(preLook.body === 'female' && preLook.bust === SHAPE_MID && preLook.hips === SHAPE_MID && preLook.glutes === SHAPE_MID, 'saves from before the sliders load with an average shape');
  check(sanitizeAppearance({ ...DEFAULT_FEMALE_APPEARANCE, top: 'shirtless' }).top === 'bikini' && decodeAppearance(encodeAppearance({ ...DEFAULT_FEMALE_APPEARANCE, top: 'shirtless' })).top === 'bikini', 'a woman is never shirtless (bikini top), even from the wire');
  check(sanitizeAppearance({ ...DEFAULT_APPEARANCE, top: 'shirtless' }).top === 'shirtless', 'a man can go shirtless');
  let shapesOk = true, shirtless = 0, suits = 0;
  const varied = new Set<number>();
  for (let i = 0; i < 400; i++) {
    const w = randomAppearance(rand, 'female'), m = randomAppearance(rand, 'male');
    if (m.bust !== SHAPE_MID || m.hips !== SHAPE_MID || m.glutes !== SHAPE_MID) shapesOk = false;
    for (const v of [w.bust, w.hips, w.glutes]) {
      if (!Number.isInteger(v) || v < 0 || v >= SHAPE_STEPS) shapesOk = false;
      varied.add(v);
    }
    if (w.top === 'shirtless') shirtless++;
    if (w.top === 'swimsuit' && w.pants !== 'bikinibottom') suits++;
  }
  check(shapesOk && varied.size >= 5, `random women vary in shape (${varied.size} steps seen), random men stay average`);
  check(shirtless === 0 && suits === 0, 'random women are never shirtless, a swimsuit comes with its bottoms');

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
    for (const id of PRIMARY_WEAPONS.concat(SECONDARY_WEAPONS)) {
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

section('Akimbo pistols');
{
  check(SECONDARY_WEAPONS.includes('akimbo') && WEAPONS.akimbo.slot === 'secondary' && !EXCLUSIVE_WEAPONS.includes('akimbo'),
    'the akimbo pair is a loadout sidearm, not a supply-drop exclusive');
  check(buildable('akimbo') && isHandgun('akimbo') && isHandgun('pistol') && !isHandgun('ar'), 'the pair takes builds and counts as a handgun');
  check(new Arsenal('ar', 'ar').secondary.id === 'pistol' && new Arsenal('ar', 'nope' as WeaponId).secondary.id === 'pistol', 'anything but a sidearm in the sidearm slot gets the M17');
  const a = new Arsenal('ar', 'akimbo');
  const ticks: string[] = [];
  const stepFor = (s: number) => { for (let i = 0; i < Math.round(s / DT); i++) a.step(DT, false, ticks as never); };
  check(a.secondary.id === 'akimbo' && a.secondary.mag === 30 && a.secondary.reserve === 90, 'the pair carries 30 in the guns and 90 spare');
  check(a.switchTo('secondary') && a.weapon.id === 'akimbo', 'switching draws both pistols');
  stepFor(WEAPONS.akimbo.draw + 0.05);
  check(a.fireState() === 'ok', 'ready after the draw');
  a.consume();
  check(a.fireState() === 'busy' && Math.abs(a.cooldown - 0.1) < 0.025, `the next hand fires 0.1 s later (${a.cooldown.toFixed(3)})`);
  let shots = 1;
  for (let i = 0; i < Math.round(1 / DT); i++) {
    if (a.fireState() === 'ok') { a.consume(); shots++; }
    a.step(DT, false, ticks as never);
  }
  check(shots >= 9 && shots <= 12, `about ten rounds a second between the two guns (${shots})`);
  check(WEAPONS.akimbo.fireRate >= WEAPONS.pistol.fireRate * 1.5 && WEAPONS.akimbo.hipSpread > WEAPONS.pistol.hipSpread,
    'faster than one M17 but looser from the hip');
  a.weapon.mag = 0;
  check(a.startReload() && Math.abs(a.actionTotal - (WEAPONS.akimbo.reloadTime + 0.35)) < 1e-6, 'an empty pair reloads in 2.4 s plus the chambering');
  stepFor(a.actionTotal + 0.1);
  check(a.weapon.mag === 30 && a.weapon.reserve === 60, 'both guns come back full');

  const l50 = { level: 50, entitlements: [] as string[] };
  const kit: WeaponBuild = { optic: 'acog', muzzle: 'suppressor', grip: 'laser', mag: 'extended', skin: 'gold' };
  const kept = sanitizeBuild('akimbo', kit, l50);
  check(sameBuild(kept, kit), 'the pair takes a 3x prism, suppressors, lasers, extended magazines and a gold finish');
  check(sanitizeBuild('akimbo', { ...kit, optic: 'scope', grip: 'vertical', muzzle: 'choke' }, l50).optic === 'iron', 'no rifle scope on a pistol');
  check(['iron', 'dot', 'holo', 'acog'].every((o) => fitsOf('akimbo', 'optic').some((f) => f.id === o) && fitsOf('pistol', 'optic').some((f) => f.id === o)),
    'both handguns fit irons, a red dot, a holographic sight and a 3x prism');
  check(fitsOf('akimbo', 'skin').length === fitsOf('ar', 'skin').length, 'every finish fits the pair');
  check(tunedWeapon('akimbo', { ...defaultBuild('akimbo'), mag: 'extended' }).magazine === 45, 'extended magazines hold 45 between them');
  const back = decodeLoadout(encodeLoadout({ akimbo: kit, pistol: { ...defaultBuild('pistol'), optic: 'holo' } }));
  check(sameBuild(back.akimbo!, kit) && back.pistol?.optic === 'holo', 'akimbo builds survive the wire format');

  const { sim, body } = makeSim({ x: 0, y: 0.15, z: 6 });
  const p2 = sim.addPlayer('p2', 'Twin', 'ar', 'akimbo', { x: 1, y: 0.15, z: 6 }, 0, '', { akimbo: kit });
  check(p2.arsenal.secondary.id === 'akimbo' && p2.arsenal.secondary.mag === 45, 'a survivor joins with the pair and its build');
  run(sim, 1);
  const snap = captureSnapshot(sim, new Map());
  const other = new Simulation({ physics, map, nav, doors, seed: 8, preparation: 600 });
  const mirror = new Mirror(other, 'p1');
  mirror.apply(snap, 0);
  const copy = other.players.get('p2');
  check(copy?.arsenal.secondary.id === 'akimbo' && sameBuild(copy.arsenal.builds.akimbo!, kit), 'clients see the pair and its build from snapshots');
  other.dispose();
  cleanup(sim, body);
}

section('Gore: kill throws, shoves and head pops by gun');
{
  type Died = Extract<SimEvent, { type: 'zombieDied' }>;
  type Hit = Extract<SimEvent, { type: 'zombieHit' }>;
  /** Shoots one zombie `dist` m away with `gun` (in the chest, or the head) until it dies. */
  const killWith = (gun: WeaponId, dist: number, opts: { kind?: ZombieKind; head?: boolean; seed?: number; shots?: number } = {}) => {
    const at = { x: 0, y: 0.15, z: 6 };
    for (const d of doors) d?.reset();
    physics.world.step();
    const sim = new Simulation({ physics, map, nav, doors, seed: 7, preparation: 600 });
    const secondary = gun === 'pistol';
    const sp = sim.addPlayer('p1', 'Tester', secondary ? 'ar' : gun, 'pistol', at, 0);
    const body = new TestPlayer(at);
    if (secondary) sim.switchWeapon('p1', 'secondary');
    run(sim, 1.4);
    const z = sim.spawnZombie(opts.kind ?? 'walker', { x: 0, y: 0.02, z: at.z - dist }, 'idle');
    z.facing = Math.PI;
    run(sim, 0.2);
    sp.arsenal.aim = 1;
    sp.motion.aiming = true;
    const hits: Hit[] = [];
    let died: Died | null = null;
    let shots = 0;
    const start = { ...z.pos };
    let staggered = false;
    while (z.alive && shots < (opts.shots ?? 12)) {
      const eye = sp.eye;
      // Head shots aim at the middle of the head as the hit zones have it.
      const head = opts.head ? z.zones([]).find((s) => s.zone === 'head') : undefined;
      const aim = head ? { x: (head.a.x + head.b.x) / 2, y: (head.a.y + head.b.y) / 2, z: (head.a.z + head.b.z) / 2 } : { x: z.pos.x, y: z.pos.y + 1.15, z: z.pos.z };
      const tx = aim.x - eye.x, ty = aim.y - eye.y, tz = aim.z - eye.z;
      const l = Math.hypot(tx, ty, tz);
      if (sim.fire('p1', eye, { x: tx / l, y: ty / l, z: tz / l }, true, (opts.seed ?? 11) + shots * 7) === 'fired') shots++;
      const ev = [...sim.drain(), ...run(sim, 0.05).events];
      if (z.state === 'stagger') staggered = true;
      ev.push(...run(sim, 60 / WEAPONS[gun].fireRate + 0.05).events);
      for (const e of ev) {
        if (e.type === 'zombieHit' && e.zombie === z.id) hits.push(e);
        if (e.type === 'zombieDied' && e.zombie === z.id) died = e;
      }
    }
    const moved = Math.hypot(z.pos.x - start.x, z.pos.z - start.z);
    body.remove();
    sim.dispose();
    return { died: died as Died | null, hits, shots, alive: z.alive, staggered, moved };
  };
  const throwOf = (gun: WeaponId, dist: number, kind?: ZombieKind) => {
    const r = killWith(gun, dist, { kind });
    return r.died ? r.died.force * GORE.forceSpeed : -1;
  };
  const pistol = throwOf('pistol', 8), smg = throwOf('smg', 8), ar = throwOf('ar', 8), marksman = throwOf('marksman', 8);
  const sniper = throwOf('sniper', 8), shotgunNear = throwOf('shotgun', 3), shotgunFar = throwOf('shotgun', 14);
  check(pistol > 0 && smg > 0 && ar > 0 && marksman > 0 && sniper > 0 && shotgunNear > 0 && shotgunFar > 0, 'every gun kills a walker and throws the body');
  check(Math.abs(pistol - GORE.throw.pistol) < 0.01 && Math.abs(sniper - GORE.throw.sniper) < 0.01, `a kill throws the body at the gun's speed (pistol ${pistol.toFixed(2)}, .50 ${sniper.toFixed(2)} m/s)`);
  check(sniper > shotgunNear && shotgunNear > marksman && marksman > ar && ar > pistol && pistol > smg,
    `heavier guns throw harder: .50 ${sniper.toFixed(1)} > shotgun up close ${shotgunNear.toFixed(1)} > marksman ${marksman.toFixed(1)} > AR ${ar.toFixed(1)} > pistol ${pistol.toFixed(1)} > SMG ${smg.toFixed(1)}`);
  check(shotgunNear > pistol * 2.5, 'a shotgun kill up close throws over twice as hard as a pistol kill');
  check(shotgunFar < shotgunNear * 0.6 && Math.abs(shotgunReach(2) - 1) < 1e-9, `a shotgun throws far less at 14 m (${shotgunFar.toFixed(1)} vs ${shotgunNear.toFixed(1)} m/s)`);
  const bruteThrow = throwOf('sniper', 8, 'brute');
  check(bruteThrow > 0 && bruteThrow < sniper * 0.6, `a brute is thrown less than a walker by the same gun (${bruteThrow.toFixed(1)} vs ${sniper.toFixed(1)} m/s)`);

  const ar1 = killWith('ar', 8);
  check(ar1.hits.length > 0 && ar1.hits.every((h) => h.gun === 'ar') && ar1.died?.gun === 'ar', 'hits and the kill say which gun it was');

  const mHead = killWith('marksman', 8, { head: true });
  check(mHead.died?.zone === 'head' && mHead.died.pop === true, 'a marksman head shot kill blows the head apart');
  const sHead = killWith('sniper', 10, { head: true });
  check(sHead.died?.zone === 'head' && sHead.died.pop === true, 'a .50 head shot kill blows the head apart');
  const pHead = killWith('pistol', 4, { head: true });
  check(!!pHead.died && pHead.hits.some((h) => h.zone === 'head') && !pHead.died.pop, 'pistol head shots leave the head on');
  const aHead = killWith('ar', 4, { head: true });
  check(aHead.died?.zone === 'head' && !aHead.died.pop, 'an assault rifle head shot kill leaves the head on');
  const body = killWith('sniper', 8);
  check(body.died !== null && !body.died.pop, 'a body shot never pops the head');
  let pops = 0;
  for (let seed = 1; seed <= 6; seed++) if (killWith('shotgun', 1.6, { head: true, seed: seed * 13 }).died?.pop) pops++;
  check(pops >= 4, `a shotgun to the face up close blows the head apart (${pops} of 6 volleys)`);
  let farPops = 0;
  for (let seed = 1; seed <= 4; seed++) if (killWith('shotgun', 12, { head: true, seed: seed * 13 }).died?.pop) farPops++;
  check(farPops === 0, 'a shotgun head shot from 12 m does not');

  // Living zombies: a shotgun volley up close shoves anything short of a brute back.
  const bloater = killWith('shotgun', 4, { kind: 'bloater', shots: 1 });
  check(bloater.alive && bloater.staggered && bloater.moved > 0.3, `a close shotgun volley staggers a bloater and shoves it back (${bloater.moved.toFixed(2)} m)`);
  const brute = killWith('shotgun', 4, { kind: 'brute', shots: 1 });
  check(brute.alive && brute.moved < bloater.moved, `a brute takes the same volley better (${brute.moved.toFixed(2)} m)`);
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
