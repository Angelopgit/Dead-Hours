/**
 * Headless checks for the van raid, against the real map collision: both roads in are clear
 * for the van's box, it comes once after seven minutes, drives in and parks, five raiders get
 * out with a mix of guns, they hunt and shoot survivors (in the street, through a window, inside
 * a house), survivors' rounds and machetes kill them, the van's cargo is left, the snapshot
 * carries all of it to a network client. Run with `npm run check:raid`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, RAPIER, GROUP, groups, createDoorBodies, buildNavGrid, Simulation, Mirror,
  RAID, RAID_ROUTES, sampleRoute, routeAt, captureSnapshot, NAV_INDOOR, WEAPONS, decodeAppearance,
  type Vec3, type SimEvent, type NavGrid, type SimPlayer, type Raider,
} from '../src/index';

let failures = 0;
let passes = 0;
const check = (ok: boolean, msg: string) => {
  if (ok) passes++;
  else failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`);
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

section('Roads in');
{
  const V = RAID.van;
  // The van's box lifted clear of the road and the curbs: anything else it would touch is a car, a sign, a tree.
  const shape = new RAPIER.Cuboid(V.width / 2 + 0.05, (V.height - 0.35) / 2, V.length / 2 + 0.05);
  for (const route of RAID_ROUTES) {
    const R = sampleRoute(route);
    const blocked: string[] = [];
    let curb = 0;
    for (let s = 0; s <= R.length; s += 0.5) {
      const at = routeAt(R, s);
      const edge = map.bounds;
      if (at.x < edge.x0 + 3.2 || at.x > edge.x1 - 3.2 || at.z < edge.z0 + 3.2 || at.z > edge.z1 - 3.2) continue;
      physics.world.intersectionsWithShape(
        { x: at.x, y: 0.35 + (V.height - 0.35) / 2, z: at.z }, { x: 0, y: Math.sin(at.yaw / 2), z: 0, w: Math.cos(at.yaw / 2) }, shape,
        (c) => {
          const t = c.translation();
          if (blocked.length < 6) blocked.push(`${at.x.toFixed(1)},${at.z.toFixed(1)} hits ${t.x.toFixed(1)},${t.z.toFixed(1)}`);
          return true;
        }, undefined, groups(0xffff, GROUP.static),
      );
      // Wheels stay on the asphalt.
      const ground = physics.raycast(at.x, 2, at.z, 0, -1, 0, 3);
      if (ground !== null && 2 - ground > 0.05) curb++;
    }
    check(blocked.length === 0, `${route.name}: the van clears every car, sign and tree (${R.length.toFixed(0)} m)${blocked.length ? ': ' + blocked.join('; ') : ''}`);
    check(curb < 30, `${route.name}: stays on the road (${curb} half-metre samples over a curb)`);
    const top = Math.max(...R.speed);
    let tt = 0;
    for (let i = 1; i < R.x.length; i++) tt += R.step / Math.max(0.7, (R.speed[i] + R.speed[i - 1]) / 2);
    check(top <= V.cruise + 1e-3 && tt > 10 && tt < 40, `${route.name}: about ${tt.toFixed(0)} s to drive in, top speed ${top.toFixed(1)} m/s`);
    const end = route.points[route.points.length - 1];
    check(Math.hypot(end.x, end.z) < 25, `${route.name}: parks in the middle of the neighbourhood (${end.x}, ${end.z})`);
  }
}

interface World { sim: Simulation; events: SimEvent[]; run: (s: number, each?: () => void) => void }
function world(seed: number): World {
  for (const d of doors) d?.reset();
  const sim = new Simulation({ physics, map, nav, doors, seed, preparation: 0.05 });
  // The clock jumps about here: no downtime lull in the way (lulls are checked in sim.check).
  sim.lullDue = Infinity;
  const events: SimEvent[] = [];
  const run = (secs: number, each?: () => void) => {
    for (let i = 0; i < Math.round(secs / DT); i++) {
      each?.();
      sim.step(DT);
      physics.step();
      for (const e of sim.drain()) events.push(e);
    }
  };
  // Keep the zombies out of it: they are not what is tested here.
  sim.step(DT);
  return { sim, events, run };
}
const noZombies = (sim: Simulation) => {
  for (const z of sim.zombies) z.removeBody();
  sim.zombies.length = 0;
};
const god = (p: SimPlayer) => () => {
  p.health = 100;
};
const of = <T extends SimEvent['type']>(events: SimEvent[], t: T) => events.filter((e) => e.type === t) as Extract<SimEvent, { type: T }>[];
/** Where the survivor stands in the street, in the open. */
const STREET: Vec3 = { x: 6, y: 0.15, z: 9 };
/** Damage a second the first crew does to them there (judged with other crews under "How hard they hit"). */
let streetDps = 0;

section('The van comes once, after seven minutes');
{
  const { sim, events, run } = world(3);
  const p = sim.addPlayer('A', 'Alice', 'ar', 'pistol', STREET, 0);
  run(0.2);
  sim.phaseTime = RAID.at - 3;
  run(2, () => noZombies(sim));
  check(sim.raid.stage === 'waiting' && !of(events, 'raid').length, 'nothing before 7:00');
  run(1.5, () => noZombies(sim));
  const inbound = of(events, 'raid').find((e) => e.stage === 'inbound');
  check(!!inbound && sim.raid.stage === 'inbound', `at 7:00 the van starts in (${RAID_ROUTES[inbound?.route ?? 0].name})`);
  check(of(events, 'notice').some((e) => e.text === 'VEHICLE APPROACHING'), 'everyone is warned it is coming');
  const start = sim.raid.van ? { ...sim.raid.van.pos } : null;
  const far = start ? Math.hypot(start.x - p.motion.pos.x, start.z - p.motion.pos.z) : 0;
  check(far > 120, `it enters from the far edge of the map (${far.toFixed(0)} m from the survivor)`);
  let t = 0;
  while (sim.raid.stage === 'inbound' && t < 60) {
    run(0.5, () => { noZombies(sim); god(p)(); });
    t += 0.5;
  }
  const van = sim.raid.van!;
  check(sim.raid.stage === 'arrived', `it drives in and parks (${t.toFixed(1)} s, at ${van.pos.x.toFixed(1)}, ${van.pos.z.toFixed(1)})`);
  run(RAID.deployEvery * RAID.raiders + 1.5, () => { noZombies(sim); god(p)(); });
  const spawned = of(events, 'raiderSpawned');
  const kinds = new Set(spawned.map((e) => e.weapon));
  check(spawned.length === RAID.raiders && sim.raid.raiders.length === RAID.raiders, `${spawned.length} raiders get out`);
  check(kinds.size >= 2 && [...kinds].every((k) => ['ar', 'shotgun', 'pistol'].includes(k)), `armed with a mix: ${spawned.map((e) => WEAPONS[e.weapon].model).join(', ')}`);
  const looks = new Set(sim.raid.raiders.map((x) => x.appearance));
  check(looks.size === RAID.raiders && sim.raid.raiders.every((x) => decodeAppearance(x.appearance).face !== 'none'), 'each looks different, every one masked');
  // In the open, they find the survivor and open fire.
  let hurt = 0;
  run(14, () => {
    noZombies(sim);
    hurt += 100 - p.health;
    p.health = 100;
  });
  const shots = of(events, 'shot').filter((e) => e.player.startsWith('raider:'));
  check(shots.length > 5 && hurt > 0, `they shoot at the survivor in the street (${shots.length} shots, ${hurt.toFixed(0)} damage taken)`);
  check(of(events, 'playerHurt').some((e) => e.player === 'A'), 'and hit them');
  streetDps = hurt / 14;
  // Fight back: aim at each raider in turn.
  let killed = 0;
  let k = 0;
  run(40, () => {
    noZombies(sim);
    p.health = 100;
    if (sim.raid.stage === 'over') return;
    const t = sim.raid.raiders.find((x) => x.alive);
    if (!t) return;
    const e = p.eye, c = t.chest;
    const d = { x: c.x - e.x, y: c.y - e.y, z: c.z - e.z };
    const l = Math.hypot(d.x, d.y, d.z);
    p.motion.aiming = true;
    if (p.arsenal.weapon.mag === 0) sim.reload('A');
    sim.fire('A', e, { x: d.x / l, y: d.y / l, z: d.z / l }, true, ++k);
  });
  killed = of(events, 'raiderDied').length;
  check(killed === RAID.raiders && sim.raid.stage === 'over', `the survivor kills all ${killed} (raid over)`);
  check(of(events, 'raiderHit').every((e) => e.by === 'A') && p.stats.damageDealt > RAID.health * RAID.raiders * 0.9, 'every hit is credited to the shooter');
  check(of(events, 'notice').some((e) => e.text === 'RAIDERS ELIMINATED'), 'everyone hears the raid is over');
  const cargo = sim.interactables.filter((it) => it.kind === 'supply' || it.kind === 'medical').filter((it) => Math.hypot(it.pos.x - van.pos.x, it.pos.z - van.pos.z) < 5);
  check(cargo.length === 2, 'their van holds universal ammo and bandages');
  run(1.2, () => noZombies(sim));
  check(sim.raid.raiders.length === 0 && of(events, 'raiderRemoved').length === RAID.raiders, 'the dead are cleared from the simulation');
  sim.phaseTime += 600;
  run(3, () => noZombies(sim));
  check(of(events, 'raid').filter((e) => e.stage === 'inbound').length === 1 && !sim.callRaid(), 'it only ever happens once');
  sim.dispose();
}

/** A raid on one survivor at `at`, run until `until` or `secs`; returns damage taken and what happened. */
function raidOn(seed: number, at: Vec3, secs: number, until: (sim: Simulation, raiders: Raider[], events: SimEvent[]) => boolean, setup?: (sim: Simulation) => void) {
  const w = world(seed);
  const { sim, events, run } = w;
  const p = sim.addPlayer('A', 'Alice', 'ar', 'pistol', at, 0);
  run(0.2);
  setup?.(sim);
  sim.callRaid();
  let hurt = 0, t = 0, done = false;
  while (t < secs && !done) {
    run(0.25, () => {
      noZombies(sim);
      hurt += 100 - p.health;
      p.health = 100;
    });
    t += 0.25;
    done = sim.raid.stage === 'arrived' && sim.raid.raiders.length > 0 && until(sim, sim.raid.raiders, events);
  }
  return { ...w, p, hurt, t, done };
}

section('How hard they hit');
{
  // One crew is a small sample: which guns it carries and where each raider stops to shoot swing
  // it from about 12 to 38 damage a second, so a small change to the map (an open car door one of
  // them stands behind) moves a single crew by more than any margin. The balance is the average
  // over a dozen crews, each shooting at a survivor standing still in the street.
  const rates = [streetDps];
  for (const seed of [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const { sim, p, run, done } = raidOn(seed, STREET, 60, (s) => s.raid.raiders.length === RAID.raiders);
    run(1.5, () => { noZombies(sim); god(p)(); });
    let hurt = 0;
    run(14, () => {
      noZombies(sim);
      hurt += 100 - p.health;
      p.health = 100;
    });
    rates.push(done ? hurt / 14 : NaN);
    sim.dispose();
  }
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  check(rates.every((x) => x > 0), `every crew hits a survivor in the open (${rates.length} crews, ${Math.min(...rates).toFixed(1)} to ${Math.max(...rates).toFixed(1)} damage a second)`);
  check(mean > 3 && mean < 25, `they can be survived for a while: ${mean.toFixed(1)} damage a second on average on a survivor standing still in the open (${(100 / mean).toFixed(1)} s to go down)`);
}

section('Survivors in a house');
{
  // At the Mercer house's front window, looking out at the street.
  const front = map.windows.find((w) => w.houseId === 'house-ne' && w.axis === 'x' && w.outward === 1);
  check(!!front, `found the Mercer house front window (${front?.id})`);
  if (front) {
    const inside = { x: front.x, y: 0.3, z: front.z - (front.axis === 'x' ? front.outward : 0) * 1.0 };
    const res = raidOn(5, inside, 60, (_s, _r, ev) => ev.some((e) => e.type === 'playerHurt'));
    const { sim, events } = res;
    const shotIn = of(events, 'shot').filter((e) => e.player.startsWith('raider:'));
    const outside = sim.raid.raiders.filter((x) => x.alive && !(nav.flags[nav.nodeAt(x.pos.x, x.pos.y, x.pos.z, 0.6)] & NAV_INDOOR));
    check(of(events, 'glassBroken').length > 0, 'their rounds shatter the window glass');
    check(of(events, 'playerHurt').some((e) => e.player === 'A') && shotIn.length > 0, `raiders outside shoot them through the window (${shotIn.length} shots, ${res.hurt.toFixed(0)} damage, ${outside.length} outside)`);
    sim.dispose();
  }
  // Deeper in, out of sight of every window: they come in after them.
  const deep = { x: 27, y: 0.3, z: -18 };
  const res2 = raidOn(9, deep, 90, (sim, rs) => rs.some((x) => x.alive && (nav.flags[nav.nodeAt(x.pos.x, x.pos.y, x.pos.z, 0.6)] & NAV_INDOOR) !== 0 && Math.hypot(x.pos.x - deep.x, x.pos.z - deep.z) < 12));
  const opened = res2.sim.doors.filter((d) => d && d.open && d.spec.houseId === map.doors.find((dd) => Math.hypot(dd.x - deep.x, dd.z - deep.z) < 12)?.houseId);
  check(res2.done, `raiders enter the house after them (${res2.t.toFixed(0)} s after the van was called, ${opened.length} door(s) opened)`);
  check(of(res2.events, 'playerHurt').some((e) => e.player === 'A'), `and shoot them inside (${res2.hurt.toFixed(0)} damage)`);
  res2.sim.dispose();

  // Boarded up: they kick the boards off the door, then the door in.
  const res3 = raidOn(9, deep, 150, (sim, rs) => {
    if (sim.time < 1) return false;
    return rs.some((x) => x.alive && (nav.flags[nav.nodeAt(x.pos.x, x.pos.y, x.pos.z, 0.6)] & NAV_INDOOR) !== 0 && Math.hypot(x.pos.x - deep.x, x.pos.z - deep.z) < 12);
  }, (sim) => {
    for (const sl of sim.barricades.slots) if (sl.kind === 'door' && sl.houseId === 'house-ne') sl.boards = sl.max;
  });
  const broke = of(res3.events, 'barricade').filter((e) => e.change === 'broken').length;
  const kicks = of(res3.events, 'doorPound').length;
  check(res3.done && broke > 0 && kicks > 0, `a boarded-up door holds them a while, then they kick it in (${kicks} kicks, ${broke} boards broken, inside after ${res3.t.toFixed(0)} s)`);
  res3.sim.dispose();
}

section('Network copy');
{
  const { sim, run } = raidOn(11, { x: 6, y: 0.15, z: 9 }, 40, (s) => s.raid.raiders.length === RAID.raiders);
  const snap = captureSnapshot(sim, new Map());
  check(!!snap.v && snap.r?.length === RAID.raiders, 'the snapshot carries the van and every raider');
  const size = JSON.stringify({ v: snap.v, r: snap.r }).length;
  check(size < 900, `small on the wire (${size} bytes for van and crew)`);
  const client = new Simulation({ physics, map, nav, doors, seed: 1 });
  const mirror = new Mirror(client, 'A');
  mirror.apply(JSON.parse(JSON.stringify(snap)), 100);
  const a = sim.raid.raiders[0], b = client.raid.raiders.find((x) => x.num === a.num);
  check(!!b && client.raid.raiders.length === RAID.raiders && b.appearance === a.appearance && b.weapon === a.weapon, 'the client builds the same crew (look and gun)');
  check(!!client.raid.van && Math.hypot(client.raid.van.pos.x - sim.raid.van!.pos.x, client.raid.van.pos.z - sim.raid.van!.pos.z) < 0.02 && client.raid.stage === 'arrived', 'and the van where it parked');
  run(0.5);
  const killer = sim.raid.raiders[0];
  sim.raid.kill(killer, null, 'head', { x: 0, y: 0, z: 1 });
  mirror.event({ type: 'raiderDied', raider: killer.id, zone: 'head', dir: { x: 0, y: 0, z: 1 }, by: null, weapon: killer.weapon, left: 4 });
  check(client.raid.raider(killer.id)?.alive === false, 'a death shows on the client at once');
  mirror.apply(JSON.parse(JSON.stringify(captureSnapshot(sim, new Map()))), 100.05);
  check(client.raid.raiders.length === RAID.raiders - 1, 'and the body leaves its copy with the next snapshot');
  client.dispose();
  sim.dispose();
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
