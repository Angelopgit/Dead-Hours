/**
 * Headless checks for skateboards on the real map collision: where the night's boards are laid
 * (pavement, outdoors, one by the safehouse, spread out, the same for the same seed), hopping on
 * and off (reach, one rider a board, one board a rider, where it comes to rest), being thrown off
 * (hard hits, going down, dying, leaving), the rolling noise zombies hear, and the wire format
 * (snapshot rows, the client's copy, the motion message's heading), and flip tricks (which way
 * the stick is held picks one, each is caught before the ollie lands, everyone is told of it).
 * Run with `npm run check:skate`.
 */
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, Mirror, captureSnapshot, packMotion, unpackMotion,
  SKATEBOARD, SKATE_TRICKS, TRICK_DELAY, NAV_INDOOR, PLAYER, isSkateTrick, rng, skateTrickFor, type SimEvent, type NavGrid, type SkateTrick, type Vec3,
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

const sims: Simulation[] = [];
function fresh(seed = 11): Simulation {
  const sim = new Simulation({ physics, map, nav, doors, seed, preparation: 600 });
  sims.push(sim);
  return sim;
}
const run = (sim: Simulation, seconds: number, events: SimEvent[] = []) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    sim.step(DT);
    for (const e of sim.drain()) events.push(e);
  }
  return events;
};
const d2 = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);
const spawn = map.playerSpawns[0];

section('Where the boards lie');
{
  // Enough nights that a rare miss of the safehouse board would show.
  const seeds = Array.from({ length: 40 }, (_, i) => ((i + 1) * 2654435761) >>> 0);
  let allPaved = true, allOutdoor = true, allSpaced = true, allNear = true, allBounds = true, allFlat = true;
  let counts = '';
  for (const seed of seeds) {
    const sim = fresh(seed);
    const bs = sim.skateboards.boards;
    counts += `${bs.length} `;
    if (bs.length !== SKATEBOARD.count) check(false, `seed ${seed}: ${SKATEBOARD.count} boards (got ${bs.length})`);
    const first = bs[0];
    const dn = first ? d2(first.pos, spawn) : Infinity;
    if (!(dn >= SKATEBOARD.nearSafehouse[0] - 0.5 && dn <= SKATEBOARD.nearSafehouse[1] + 0.5)) allNear = false;
    for (const b of bs) {
      const hit = physics.raycastHit(b.pos.x, b.pos.y + 0.5, b.pos.z, 0, -1, 0, 1);
      if (!hit || (hit.surface !== 'asphalt' && hit.surface !== 'concrete')) allPaved = false;
      if (!hit || Math.abs(0.5 - hit.distance) > 0.05) allFlat = false;
      const n = nav.nodeAt(b.pos.x, b.pos.y, b.pos.z, 0.6);
      if (n < 0 || nav.flags[n] & NAV_INDOOR) allOutdoor = false;
      const B = map.bounds;
      if (b.pos.x < B.x0 || b.pos.x > B.x1 || b.pos.z < B.z0 || b.pos.z > B.z1) allBounds = false;
      for (const o of bs) {
        if (o === b || b === first || o === first) continue;
        if (d2(o.pos, b.pos) < SKATEBOARD.spacing - 0.01) allSpaced = false;
      }
      if (b !== first && d2(b.pos, spawn) < SKATEBOARD.spacing - 0.01) allSpaced = false;
    }
  }
  check(counts.trim().split(' ').every((c) => Number(c) === SKATEBOARD.count), `${SKATEBOARD.count} boards every night (${seeds.length} nights)`);
  check(allPaved, 'every board lies on asphalt or concrete (streets, sidewalks, driveways, lots)');
  check(allFlat, 'every board rests on the surface under it');
  check(allOutdoor, 'every board is outdoors');
  check(allNear, `one lies ${SKATEBOARD.nearSafehouse[0]}-${SKATEBOARD.nearSafehouse[1]} m from the safehouse spawn`);
  check(allSpaced, `the others are at least ${SKATEBOARD.spacing} m from the spawn and from each other`);
  check(allBounds, 'all inside the map');
  const a = fresh(77).skateboards.boards.map((b) => `${b.pos.x.toFixed(2)},${b.pos.z.toFixed(2)},${b.yaw.toFixed(3)}`).join('|');
  const b = fresh(77).skateboards.boards.map((b) => `${b.pos.x.toFixed(2)},${b.pos.z.toFixed(2)},${b.yaw.toFixed(3)}`).join('|');
  const c = fresh(78).skateboards.boards.map((b) => `${b.pos.x.toFixed(2)},${b.pos.z.toFixed(2)},${b.yaw.toFixed(3)}`).join('|');
  check(a === b, 'the same seed lays them in the same spots (every machine agrees)');
  check(a !== c, 'another seed lays them somewhere else');
  // Placing them takes nothing from the zombies' random numbers.
  const z1 = fresh(5).random(), z2 = rng(5)();
  check(z1 === z2, 'placing boards leaves the simulation\'s own random numbers alone');
  // Reachable on foot from the safehouse.
  const sim = fresh(11);
  const near = sim.skateboards.boards[0];
  const path = nav.findPath({ x: spawn.x, y: spawn.y, z: spawn.z }, near.pos, { maxExpand: 200000 });
  check(!!path && path.complete, 'the safehouse board can be walked to from the spawn');
}

section('Hopping on and off');
{
  const sim = fresh(11);
  const b = sim.skateboards.boards[1];
  const p = sim.addPlayer('p1', 'One', 'ar', 'pistol', { x: b.pos.x + 3, y: b.pos.y, z: b.pos.z }, 0);
  const q = sim.addPlayer('p2', 'Two', 'ar', 'pistol', { x: b.pos.x - 1, y: b.pos.y, z: b.pos.z }, 0);
  check(!sim.rideBoard('p1', b.id), 'out of reach (3 m): can\'t hop on');
  check(!sim.skateboards.inReach(p).includes(b), 'and it isn\'t offered');
  p.motion.pos = { x: b.pos.x + 1.2, y: b.pos.y, z: b.pos.z };
  check(sim.skateboards.inReach(p)[0] === b, 'within reach it is offered');
  const ev: SimEvent[] = [];
  check(sim.rideBoard('p1', b.id), 'hops on in reach');
  for (const e of sim.drain()) ev.push(e);
  check(ev.some((e) => e.type === 'skate' && e.stage === 'on' && e.player === 'p1' && e.board === b.id), 'a skate event says so');
  check(b.rider === 'p1' && !b.flipped, 'the board is theirs (and right side up)');
  check(!sim.rideBoard('p2', b.id), 'nobody else can take it from under them');
  const other = sim.skateboards.boards[2];
  p.motion.pos = { x: other.pos.x + 0.5, y: other.pos.y, z: other.pos.z };
  check(!sim.rideBoard('p1', other.id), 'one board at a time');
  // Riding: the board goes where they go and points where their browser says.
  p.motion.pos = { x: b.pos.x + 5, y: b.pos.y, z: b.pos.z + 2 };
  p.motion.vel = { x: 6, y: 0, z: 0 };
  p.motion.board = 1.2;
  run(sim, 0.1);
  check(d2(b.pos, p.motion.pos) < 0.01, 'the board stays under the rider');
  check(Math.abs(b.yaw - 1.2) < 1e-6, 'and points the way the rider\'s browser says');
  p.motion.board = undefined;
  p.motion.vel = { x: 0, y: 0, z: 5 };
  run(sim, 0.05);
  check(Math.abs(b.yaw - 0) < 1e-6, 'without a heading it follows the way they roll');
  // Stepping off: it comes to rest where the browser put it when that is close.
  const at = { x: p.motion.pos.x + 0.3, y: p.motion.pos.y, z: p.motion.pos.z };
  ev.length = 0;
  check(sim.leaveBoard('p1', at, 0.4), 'steps off');
  for (const e of sim.drain()) ev.push(e);
  check(b.rider === null && d2(b.pos, at) < 0.01 && Math.abs(b.yaw - 0.4) < 1e-6, 'the board rests where they left it, pointing their way');
  check(ev.some((e) => e.type === 'skate' && e.stage === 'off'), 'a skate event says they stepped off');
  const g = physics.raycast(b.pos.x, b.pos.y + 1, b.pos.z, 0, -1, 0, 3);
  check(g !== null && Math.abs(b.pos.y + 1 - g - b.pos.y) < 0.02, 'on the ground under it');
  // A spot far from where the server has them is not believed.
  p.motion.pos = { x: b.pos.x + 0.5, y: b.pos.y, z: b.pos.z };
  check(sim.rideBoard('p1', b.id), 'back on');
  sim.leaveBoard('p1', { x: b.pos.x + 30, y: b.pos.y, z: b.pos.z }, 0);
  check(d2(b.pos, p.motion.pos) < 0.01, 'a step-off spot far from the rider is ignored: the board stays with them');
  check(!sim.leaveBoard('p1'), 'stepping off with no board does nothing');
  check(q.alive, 'the other survivor is fine');
}

section('Thrown off');
{
  const sim = fresh(11);
  const b = sim.skateboards.boards[0];
  const p = sim.addPlayer('p1', 'One', 'ar', 'pistol', { ...b.pos }, 0);
  sim.addPlayer('p2', 'Two', 'ar', 'pistol', { x: b.pos.x + 30, y: b.pos.y, z: b.pos.z }, 0);
  sim.rideBoard('p1', b.id);
  sim.drain();
  sim.damagePlayer(p, 0.5, b.pos);
  check(b.rider === 'p1', 'a scratch (fire, 0.5) leaves them riding');
  const ev: SimEvent[] = [];
  sim.damagePlayer(p, SKATEBOARD.knockDamage + 3, b.pos);
  for (const e of sim.drain()) ev.push(e);
  check(b.rider === null, `a hard hit (${SKATEBOARD.knockDamage + 3}) throws them off`);
  check(ev.some((e) => e.type === 'skate' && e.stage === 'bail' && e.player === 'p1'), 'as a bail');
  // Going down drops the board.
  p.health = PLAYER.maxHealth;
  sim.rideBoard('p1', b.id);
  sim.damagePlayer(p, 2, b.pos);
  check(b.rider === 'p1', 'still riding after a light hit');
  sim.damagePlayer(p, 500, b.pos);
  check(p.downed && b.rider === null, 'going down drops the board');
  // Leaving the game drops it too.
  const sim2 = fresh(11);
  const b2 = sim2.skateboards.boards[0];
  sim2.addPlayer('p1', 'One', 'ar', 'pistol', { ...b2.pos }, 0);
  sim2.rideBoard('p1', b2.id);
  sim2.removePlayer('p1');
  check(b2.rider === null, 'leaving the game drops the board');
  // Dying alone.
  const sim3 = fresh(11);
  const b3 = sim3.skateboards.boards[0];
  const p3 = sim3.addPlayer('p1', 'One', 'ar', 'pistol', { ...b3.pos }, 0);
  sim3.rideBoard('p1', b3.id);
  sim3.damagePlayer(p3, 500, b3.pos);
  check(!p3.alive && b3.rider === null, 'dying drops the board');
  check(!sim3.rideBoard('p1', b3.id), 'the dead don\'t ride');
}

section('Noise');
{
  const sim = fresh(11);
  const b = sim.skateboards.boards[1];
  const p = sim.addPlayer('p1', 'One', 'ar', 'pistol', { ...b.pos }, 0);
  sim.rideBoard('p1', b.id);
  p.motion.vel = { x: SKATEBOARD.pushTop, y: 0, z: 0 };
  p.motion.grounded = true;
  sim.noises.length = 0;
  run(sim, 1.5);
  const mine = sim.noises.filter((n) => n.source === 'p1');
  const loudest = Math.max(0, ...mine.map((n) => n.radius));
  check(mine.length >= 3, `rolling is heard (${mine.length} noises in 1.5 s)`);
  check(loudest <= SKATEBOARD.noise * 1.2 && loudest >= SKATEBOARD.noise * 0.8, `about ${SKATEBOARD.noise} m at top speed (${loudest.toFixed(1)} m), quieter than sprinting feet (11 m)`);
  sim.leaveBoard('p1');
  p.motion.vel = { x: PLAYER.sprintSpeed, y: 0, z: 0 };
  p.motion.sprinting = true;
  sim.noises.length = 0;
  run(sim, 1.5);
  const feet = Math.max(0, ...sim.noises.filter((n) => n.source === 'p1').map((n) => n.radius));
  check(feet > loudest, `sprinting on foot carries farther (${feet.toFixed(1)} m)`);
  sim.rideBoard('p1', b.id);
  p.motion.vel = { x: 0.3, y: 0, z: 0 };
  sim.noises.length = 0;
  run(sim, 1.5);
  check(sim.noises.filter((n) => n.source === 'p1').length === 0, 'standing still on the deck is silent');
}

section('Wire format');
{
  const sim = fresh(11);
  const b = sim.skateboards.boards[3];
  sim.addPlayer('p1', 'One', 'ar', 'pistol', { ...b.pos }, 0);
  sim.rideBoard('p1', b.id);
  const snap = captureSnapshot(sim, new Map());
  check(Array.isArray(snap.sk) && snap.sk.length === SKATEBOARD.count, 'snapshots list every board');
  const row = snap.sk!.find((x) => x[0] === b.id)!;
  check(row[5] === 'p1', 'with its rider');
  // A client's copy, placed from another seed, takes the server's boards.
  const copy = fresh(999);
  copy.addPlayer('me', 'Me', 'ar', 'pistol', { x: 0, y: 0, z: 0 }, 0);
  const mirror = new Mirror(copy, 'me');
  mirror.apply(JSON.parse(JSON.stringify(snap)), 1);
  const cb = copy.skateboards.boards[b.id];
  check(cb.rider === 'p1' && d2(cb.pos, b.pos) < 0.02 && Math.abs(cb.yaw - b.yaw) < 0.002, 'the client copy has the rider, spot and heading');
  const free = sim.skateboards.boards.find((x) => x.rider === null)!;
  const cf = copy.skateboards.boards[free.id];
  check(cf.rider === null && cf.look === free.look && cf.flipped === free.flipped && d2(cf.pos, free.pos) < 0.02, 'and the lying boards as they lie (look, flipped over)');
  // A board the client just hopped on is held as it showed it until the server has heard.
  mirror.holdBoard(free.id, 5);
  cf.rider = 'me';
  mirror.apply(JSON.parse(JSON.stringify({ ...snap, t: snap.t + 0.05 })), 2);
  check(cf.rider === 'me', 'a board this client just hopped on is held as predicted');
  mirror.apply(JSON.parse(JSON.stringify({ ...snap, t: snap.t + 0.1 })), 6);
  check(cf.rider === null, 'after the hold the server\'s word stands');
  // Another rider thrown off shows at once.
  mirror.event({ type: 'skate', player: 'p1', board: b.id, stage: 'bail', pos: { x: 1, y: 0, z: 2 }, yaw: 0.5 });
  check(cb.rider === null && cb.pos.x === 1, 'a bail shows before the next snapshot');
  // Motion: the heading rides along while on a board, and old 17-number messages still read.
  const frame = {
    motion: { pos: { x: 1, y: 0, z: 2 }, vel: { x: 7, y: 0, z: 0 }, yaw: 0, pitch: 0, eyeHeight: 1.6, crouching: false, sprinting: false, aiming: false, grounded: true, board: 1.25, pushing: true },
    facing: 0, trigger: false, aimOrigin: { x: 0, y: 1, z: 0 }, aimDir: { x: 0, y: 0, z: 1 },
  };
  const packed = packMotion(frame);
  const back = unpackMotion(packed);
  check(packed.length === 18 && !!back && Math.abs((back.motion.board ?? 0) - 1.25) < 0.002 && back.motion.pushing === true, 'the motion message carries the heading and the push');
  const foot = unpackMotion(packMotion({ ...frame, motion: { ...frame.motion, board: undefined, pushing: false } }));
  check(!!foot && foot.motion.board === undefined && foot.motion.pushing === false, 'on foot it carries neither (17 numbers, as before)');
}

section('Flip tricks');
{
  // The stick (or keys: diagonals come in at 0.71) as the rider pops.
  const want: [number, number, SkateTrick][] = [
    [0, 0, 'ollie'], [0, 1, 'ollie'], [0.3, 0.9, 'ollie'], [-1, 0, 'kickflip'], [1, 0, 'heelflip'], [-0.71, 0.71, 'kickflip'], [0.71, 0.71, 'heelflip'],
    [0, -1, 'shuvit'], [-0.71, -0.71, 'treflip'], [0.71, -0.71, 'varialheel'], [0.2, -1, 'shuvit'],
  ];
  const wrong = want.filter(([x, y, k]) => skateTrickFor(x, y) !== k);
  check(!wrong.length, `held left kickflips, right heelflips, back shove-its, back-left 360 flips, back-right varial heelflips, else an ollie${wrong.length ? ` (wrong: ${JSON.stringify(wrong)})` : ''}`);
  // Every flip is caught before an ollie on the flat comes down.
  const air = (2 * SKATEBOARD.ollie) / -PLAYER.gravity;
  const late = Object.entries(SKATE_TRICKS).filter(([, t]) => TRICK_DELAY + t.time > air - 0.03);
  check(!late.length, `every trick is caught before the wheels land (${air.toFixed(2)} s in the air; slowest ${Math.max(...Object.values(SKATE_TRICKS).map((t) => TRICK_DELAY + t.time)).toFixed(2)} s)`);
  check(isSkateTrick('kickflip') && !isSkateTrick('toString') && !isSkateTrick('backflip') && !isSkateTrick(3), 'only real trick names pass');
  const sim = fresh(11);
  const b = sim.skateboards.boards[2];
  sim.addPlayer('p1', 'One', 'ar', 'pistol', { ...b.pos }, 0);
  check(!sim.skateTrick('p1', 'kickflip'), 'on foot there is no trick');
  sim.rideBoard('p1', b.id);
  sim.drain();
  check(sim.skateTrick('p1', 'treflip'), 'on a board there is');
  const ev = sim.drain().find((e) => e.type === 'skate' && e.stage === 'trick');
  check(!!ev && ev.type === 'skate' && ev.player === 'p1' && ev.board === b.id && ev.trick === 'treflip', 'and everyone is told which (a skate event, stage trick)');
  check(b.rider === 'p1', 'it leaves the rider on the board');
  // A client's copy: someone's trick doesn't change who rides what (not even this client's own).
  const copy = fresh(11);
  copy.addPlayer('me', 'Me', 'ar', 'pistol', { ...b.pos }, 0);
  const mirror = new Mirror(copy, 'me');
  const cb = copy.skateboards.boards[b.id];
  cb.rider = 'me';
  mirror.event({ type: 'skate', player: 'me', board: b.id, stage: 'trick', pos: { x: 50, y: 0, z: 50 }, yaw: 2, trick: 'kickflip' });
  check(cb.rider === 'me' && cb.pos.x !== 50, 'a client\'s copy takes a trick as just that (the board stays under its rider)');
}

for (const s of sims) s.dispose();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
