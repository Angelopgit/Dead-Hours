/**
 * Headless checks for getting in and out of cars as the game session keeps it (GameSession's
 * syncSeat and onVehicle, with ExitSpot), on the real map, the real simulation and, online, the
 * client's real copy of the server's (Mirror): out of one car, into another and out of that one
 * stands the survivor by the door of the car they just left, never the first one's. A solo night
 * hears the 'out' event after the seat sync has already put them out; online it is heard first.
 * Then sitting: in every seat of every kind of vehicle, a survivor posed as the game poses them
 * (Humanoid.seat) has their soles on the cabin floor, never through the bottom of the car, and
 * their head under the roof.
 * Run with `npx tsx client/tests/vehicles.check.ts` (part of `npm run check:vehicles`).
 */
import * as THREE from 'three';
import {
  MAPLE_HOLLOW as map, Physics, initPhysics, createDoorBodies, buildNavGrid, Simulation, Mirror, captureSnapshot, seatWorld,
  DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE, VEHICLES, seatDrop,
  type NavGrid, type SimEvent, type SimPlayer, type Vec3, type Vehicle, type VehicleKind,
} from '@dead-hours/shared';
import { ExitSpot } from '../src/gameplay/ExitSpot';
import { Humanoid, survivorLook } from '../src/characters/Humanoid';

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
const ME = 'me';
const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/** Stands a survivor beside a vehicle's driver door. */
function besideDoor(p: SimPlayer, v: Vehicle) {
  const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
  const lz = -(v.def.hz + 0.6);
  p.motion.pos = { x: v.pos.x + 0.1 * c + lz * s, y: v.pos.y, z: v.pos.z - 0.1 * s + lz * c };
}

/**
 * The session's side of it: which car it shows this survivor in (PlayerController.seated) and
 * where it stood them on getting out (leaveSeat), from the simulation's word on who sits where.
 */
class Session {
  shownIn: number | null = null;
  stood: Vec3 | null = null;
  readonly spot = new ExitSpot();
  constructor(readonly sim: Simulation) {}
  /** GameSession.syncSeat. */
  sync(): void {
    const me = this.sim.players.get(ME)!;
    const at = me.alive ? this.sim.vehicles.seatOf(ME) : null;
    if (at) {
      if (this.shownIn === at[0].id) return;
      this.shownIn = at[0].id;
      this.spot.sat();
      return;
    }
    if (this.shownIn === null) return;
    this.stood = { ...this.spot.take(me.motion.pos) };
    this.shownIn = null;
  }
  /** GameSession.onVehicle. */
  hear(events: SimEvent[]): void {
    for (const e of events) if (e.type === 'vehicle') this.spot.heard(e, ME, this.shownIn);
  }
}

/** Two cars far enough apart to tell their doors apart, both with a clear driver's door. */
function twoCars(sim: Simulation): [Vehicle, Vehicle] | null {
  const ok = sim.vehicles.list.filter((v) => v.kind === 'car' && sim.vehicles.exitSpot(v, 0));
  for (const a of ok) for (const b of ok) if (a !== b && flat(a.pos, b.pos) > 8) return [a, b];
  return null;
}

const outPos = (events: SimEvent[], v: Vehicle): Vec3 | null => {
  for (const e of events) if (e.type === 'vehicle' && e.stage === 'out' && e.player === ME && e.vehicle === v.id && e.pos) return e.pos;
  return null;
};

section('A solo night: out of one car, into another, out of that');
{
  const sim = new Simulation({ physics, map, nav, doors, seed: 11, preparation: 600 });
  physics.advance(DT);
  const cars = twoCars(sim);
  check(!!cars, 'two cars apart, each with a clear driver\'s door');
  if (cars) {
    const [a, b] = cars;
    const me = sim.addPlayer(ME, 'Me', 'ar', 'pistol', a.pos, 0);
    const session = new Session(sim);
    /** One frame: what was pressed, the seat sync right after, then the events heard at the end of the frame. */
    const frame = (act: () => boolean): SimEvent[] => {
      const ok = act();
      if (ok) session.sync();
      sim.step(DT);
      physics.advance(DT);
      session.sync();
      const ev = sim.drain();
      session.hear(ev);
      return ev;
    };
    const ride = (v: Vehicle) => {
      besideDoor(me, v);
      frame(() => sim.enterVehicle(ME, v.id));
      check(session.shownIn === v.id && sim.vehicles.seatOf(ME)?.[0] === v, `in car ${v.id}`);
      const ev = frame(() => sim.exitVehicle(ME));
      const spot = outPos(ev, v);
      return spot;
    };
    const atA = ride(a);
    check(!!atA && !!session.stood && flat(session.stood, atA) < 0.05, 'out of the first car: by its door');
    const atB = ride(b);
    check(!!atB && !!session.stood && flat(session.stood, atB) < 0.05, `out of the second car: by its door (${session.stood && atB ? flat(session.stood, atB).toFixed(2) : '?'} m from it)`);
    check(!!atA && !!session.stood && flat(session.stood, atA) > 5, `not by the first car's door (${session.stood && atA ? flat(session.stood, atA).toFixed(1) : '?'} m from it)`);
    check(a.seats.every((s) => s === null) && b.seats.every((s) => s === null) && !sim.vehicles.seatOf(ME), 'both cars empty, and nobody thinks they sit in one');
    const again = ride(a);
    check(!!again && !!session.stood && flat(session.stood, again) < 0.05 && !!atB && flat(session.stood, atB) > 5, 'back into the first car and out: by the first car\'s door again');
    const seat = seatWorld(b, 0);
    besideDoor(me, b);
    frame(() => sim.enterVehicle(ME, b.id));
    check(flat(me.motion.pos, seat) < 0.05, 'in the second car again, sitting in its seat');
  }
  sim.dispose();
}

section('Online: the same, through the client\'s copy of the server\'s night');
{
  const server = new Simulation({ physics, map, nav, doors, seed: 23, preparation: 600 });
  const copy = new Simulation({ physics, map, nav, doors, seed: 23, preparation: 600 });
  physics.advance(DT);
  const mirror = new Mirror(copy, ME);
  const cars = twoCars(server);
  check(!!cars, 'two cars apart, each with a clear driver\'s door');
  if (cars) {
    const [a, b] = cars;
    const me = server.addPlayer(ME, 'Me', 'ar', 'pistol', a.pos, 0);
    let now = 10;
    // The first snapshot brings this survivor into the copy.
    mirror.apply(captureSnapshot(server, new Map()), now);
    const session = new Session(copy);
    check(!!copy.players.get(ME), 'the copy has this survivor');
    /** One server step after an act, then what the client does with it: events (copy, then session), the snapshot, the seat sync. */
    const frame = (act: () => boolean): SimEvent[] => {
      act();
      server.step(DT);
      physics.advance(DT);
      const ev = server.drain();
      for (const e of ev) mirror.event(e);
      session.hear(ev);
      mirror.apply(captureSnapshot(server, new Map()), (now += 0.05));
      session.sync();
      // The client's own moves: in a seat it reports the seat, on foot where it stood them.
      const mine = copy.players.get(ME)!;
      const at = copy.vehicles.seatOf(ME);
      mine.motion.pos = at ? seatWorld(at[0], at[1]) : { ...(session.stood ?? mine.motion.pos) };
      return ev;
    };
    const ride = (v: Vehicle) => {
      besideDoor(me, v);
      frame(() => server.enterVehicle(ME, v.id));
      check(session.shownIn === v.id && copy.vehicles.seatOf(ME)?.[0].id === v.id, `in car ${v.id}`);
      return outPos(frame(() => server.exitVehicle(ME)), v);
    };
    const atA = ride(a);
    check(!!atA && !!session.stood && flat(session.stood, atA) < 0.05, 'out of the first car: at the spot the server gave');
    const atB = ride(b);
    check(!!atB && !!session.stood && flat(session.stood, atB) < 0.05, 'out of the second car: at the spot the server gave for it');
    check(!!atA && !!session.stood && flat(session.stood, atA) > 5, 'not by the first car\'s door');
    const ca = copy.vehicles.vehicle(a.id)!, cb = copy.vehicles.vehicle(b.id)!;
    check(ca.seats.every((s) => s === null) && cb.seats.every((s) => s === null) && !copy.vehicles.seatOf(ME), 'the copy shows both cars empty');
  }
  server.dispose();
  copy.dispose();
}

section('What is kept');
{
  const spot = new ExitSpot();
  const here = { x: 1, y: 0, z: 2 };
  const ev = (player: string, vehicle: number, stage: 'out' | 'thrown' | 'in'): Extract<SimEvent, { type: 'vehicle' }> =>
    ({ type: 'vehicle', vehicle, stage, player, seat: 0, pos: { x: 50, y: 0, z: 60 } });
  spot.heard(ev('them', 3, 'out'), ME, 3);
  check(flat(spot.take(here), here) < 1e-9, 'someone else getting out is not kept');
  spot.heard(ev(ME, 3, 'out'), ME, null);
  check(flat(spot.take(here), here) < 1e-9, 'an exit heard once already out of the seat is not kept');
  spot.heard(ev(ME, 3, 'out'), ME, 4);
  check(flat(spot.take(here), here) < 1e-9, 'an exit from a car other than the one shown is not kept');
  spot.heard(ev(ME, 3, 'thrown'), ME, 3);
  check(flat(spot.take(here), { x: 50, y: 0, z: 60 }) < 1e-9, 'thrown out of the car shown: kept');
  check(flat(spot.take(here), here) < 1e-9, 'and used once only');
  spot.heard(ev(ME, 3, 'out'), ME, 3);
  spot.sat();
  check(flat(spot.take(here), here) < 1e-9, 'getting into a seat forgets an exit not yet used');
}

section('Sitting: feet on the floor, heads under the roof');
{
  /** The underside of each body as drawn (Props: the car's body box, the truck's chassis), and the inside of its roof over the seats. */
  const SHELL: Record<VehicleKind, { under: number; roof: (seat: number) => number }> = {
    car: { under: 0.31, roof: () => 1.52 },
    police: { under: 0.31, roof: () => 1.52 },
    wreck: { under: 0.31, roof: () => 1.52 },
    // The cab's roof (outdoor.ts truckCab) over the front seats; the back is the armored box.
    truck: { under: 0.45, roof: (s) => (s < 2 ? 2.12 : 2.6) },
  };
  const pose = { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0, moveAngle: 0, turn: 0 };
  const sole = new THREE.Vector3(), head = new THREE.Vector3();
  for (const kind of ['car', 'truck'] as VehicleKind[]) {
    const def = VEHICLES[kind];
    const shell = SHELL[kind];
    check(def.floor > shell.under && def.floor < def.seats[0].y, `${kind}: the cabin floor (${def.floor} m) is inside the body, under the seats`);
    for (let s = 0; s < def.seats.length; s++) {
      for (const look of [DEFAULT_APPEARANCE, DEFAULT_FEMALE_APPEARANCE]) {
        const h = new Humanoid(survivorLook(look));
        const seat = def.seats[s];
        h.root.position.set(seat.x, seat.y - 0.88, seat.z);
        h.root.rotation.y = Math.PI / 2;
        h.seat = { yaw: 0, drop: seatDrop(def, s) };
        for (let i = 0; i < 30; i++) h.update(1 / 60, pose);
        h.root.updateMatrixWorld(true);
        // The soles (Outfit's shoes): 0.52 under the knee, from the heel 0.07 behind the shin to the toe 0.18 ahead.
        let low = Infinity;
        for (const leg of [h.legL, h.legR]) {
          for (const f of [-0.07, 0.18]) {
            sole.set(0, -0.52, f).applyMatrix4(leg.lower.matrixWorld);
            low = Math.min(low, sole.y);
          }
        }
        head.set(0, 0.24, 0).applyMatrix4(h.head.matrixWorld);
        const who = `${kind} seat ${s} (${look === DEFAULT_APPEARANCE ? 'man' : 'woman'})`;
        check(low > shell.under + 0.01 && Math.abs(low - def.floor) < 0.04, `${who}: soles at ${low.toFixed(2)} m, on the floor (${def.floor}), not under the car (${shell.under})`);
        check(head.y < shell.roof(s), `${who}: head top ${head.y.toFixed(2)} m, under the roof (${shell.roof(s)})`);
      }
    }
  }
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
