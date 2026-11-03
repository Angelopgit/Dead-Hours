import type { Vec3 } from '@dead-hours/shared';
import type { TrailerDirector } from './Trailer';

/** A camera key: where it is and what it looks at, at `t` (0..1 of the shot), with the lens angle. */
export interface CamKey {
  t: number;
  pos: [number, number, number];
  /** The point looked at; with `track` on the shot, an offset from the tracked point instead. */
  look: [number, number, number];
  fov?: number;
}

export interface Shot {
  name: string;
  seconds: number;
  /** Seconds the cast gets going before the first frame (default 0.5). */
  lead?: number;
  /** Keeps leading in until this holds (at most `maxLead` seconds), then the plain lead. */
  until?: (d: TrailerDirector) => boolean;
  maxLead?: number;
  cam: CamKey[] | ((d: TrailerDirector) => CamKey[]);
  /** Something the camera follows (a car, a crate): the keys' `look` are offsets from it. */
  track?: (d: TrailerDirector) => Vec3 | null;
  /** The keys' `pos` are offsets from the tracked point too (a chase camera). */
  follow?: boolean;
  ease?: 'linear' | 'smooth';
  /** Handheld drift amplitude (m). */
  drift?: number;
  /** The music's tension under the shot (0..1). */
  tension?: number;
  /** A black frame (title cards go over it); the night's sound goes on. */
  black?: boolean;
  setup(d: TrailerDirector): void;
}

/** Elm Street's road runs along x at z in -4.5..4.5; the safehouse stands north of it at (0, -20), its door at (2.4, -15). */
const ROAD = -1;

/** The police car in front of the safehouse (its nose points east), found where it is parked. */
function policeCar(d: TrailerDirector): number {
  return d.sim.vehicles.list.findIndex((v) => Math.abs(v.pos.x + 5.5) < 2 && Math.abs(v.pos.z - 1.6) < 2);
}
/** The car the drive shot follows (its index, kept once it has left the kerb). */
let car = -1;

export const SHOTS: Shot[] = [
  {
    // Elm Street at night, drifting west over the road past the flickering lamp, a few of the dead about.
    name: 'street',
    seconds: 6,
    lead: 2,
    tension: 0.1,
    drift: 0.02,
    cam: [
      { t: 0, pos: [39, 5.0, 9.0], look: [-8, 1.4, -3], fov: 46 },
      { t: 1, pos: [37, 4.5, 8.4], look: [-6, 1.3, -3.5], fov: 45 },
    ],
    setup(d) {
      d.clearZombies();
      for (const [x, z] of [[14, -2], [20, 2.5], [8, 5.5], [-6, -3], [0, 6], [-14, 1]]) d.spawn('walker', x, z, { mode: 'wander' });
      for (let i = 0; i < 4; i++) d.place(i, 40 + i, -30, 0);
    },
  },
  {
    // The squad on the safehouse lawn, a crowd coming up the street from the west; over the right shoulder, pushing in.
    name: 'stand',
    seconds: 6,
    lead: 1.5,
    tension: 0.7,
    cam: [
      { t: 0, pos: [9.5, 2.3, -10.5], look: [-14, 1.2, -3], fov: 42 },
      { t: 1, pos: [6.5, 1.9, -9.5], look: [-14, 1.2, -3], fov: 40 },
    ],
    setup(d) {
      d.clearZombies();
      d.line(1, -7.5, [0.25, -1], 2.2, { x: -30, y: 1.4, z: -2 }, { range: 48, aim: true, light: true });
      d.crowd(26, -27, ROAD, 8, { chase: 0, runners: 0.35, brutes: 0.08, spread: [1.6, 0.5] });
    },
  },
  {
    // Among the dead, low, looking back at the muzzle flashes.
    name: 'horde-pov',
    seconds: 5,
    lead: 0.3,
    tension: 0.85,
    cam: [
      { t: 0, pos: [-27, 0.8, 2.6], look: [2, 1.5, -7], fov: 38 },
      { t: 1, pos: [-23, 0.7, 1.4], look: [3, 1.5, -7.5], fov: 38 },
    ],
    setup(d) {
      d.crowd(14, -30, ROAD, 6, { chase: 1, runners: 0.4, spread: [1.4, 0.6] });
    },
  },
  {
    // The Okafor house's front: one survivor nailing boards over a window while two cover the lawn, the dead coming up it.
    name: 'windows',
    seconds: 6,
    lead: 3,
    tension: 0.6,
    drift: 0.015,
    cam: [
      { t: 0, pos: [-20.5, 1.7, -8.5], look: [-27.5, 1.3, -14.5], fov: 46 },
      { t: 1, pos: [-21.5, 1.6, -9.5], look: [-27.8, 1.3, -14.5], fov: 44 },
    ],
    setup(d) {
      d.clearZombies();
      const sim = d.sim;
      // The window slots of this house's front wall.
      const slots = sim.barricades.slots.filter((s) => s.kind === 'window' && Math.abs(s.center.z + 14.5) < 1 && s.center.x > -33 && s.center.x < -23);
      const board = slots.find((s) => s.center.x > -27) ?? slots[0];
      const wx = board ? board.center.x : -24.4;
      d.place(0, wx + 0.3, -13.0, { x: wx, y: 1.3, z: -14.5 });
      d.place(1, wx + 2.6, -12.2, { x: wx - 4, y: 1.2, z: -5 });
      d.place(2, -31.5, -12.6, { x: -34, y: 1.2, z: -4 });
      d.place(3, -30, -30, 0);
      // Flashlights only where they point away from the lens (one into it is a white disc over the frame):
      // the hammer's on the window, the far cover's across the lawn.
      d.order(0, { light: true, face: { x: wx, y: 1.3, z: -14.5 } });
      d.order(1, { range: 16, aim: true, face: { x: wx - 4, y: 1.2, z: -5 } });
      d.order(2, { range: 16, aim: true, light: true, face: { x: -34, y: 1.2, z: -4 } });
      if (board) d.cue(-1, () => { sim.barricade('bot0', board.index, 'board'); });
      for (const [x, z] of [[-31, -9], [-33, -11], [-29, -7], [-35, -9.5], [-27, -6], [-32, -6.5]]) d.spawn('walker', x, z, { chase: 1 });
      d.spawn('runner', -28, 2, { chase: 2 });
    },
  },
  {
    // A Molotov into the crowd, then a grenade; from the far sidewalk.
    name: 'fire',
    seconds: 6,
    lead: 0.8,
    tension: 0.8,
    cam: [
      { t: 0, pos: [-20, 1.5, 9], look: [-25, 1.0, -1], fov: 44 },
      { t: 1, pos: [-20.8, 1.55, 9.2], look: [-25.5, 1.0, -1.5], fov: 43 },
    ],
    setup(d) {
      d.clearZombies();
      d.line(-6, -6.5, [0.3, -1], 2.2, { x: -24, y: 1.3, z: -1 }, { range: 0, aim: true });
      d.crowd(16, -25, ROAD, 5, { chase: 0, runners: 0.2, spread: [1.5, 0.6] });
      d.cue(0.2, () => { d.throwAt(1, 'molotov', { x: -24, y: 0, z: -1 }); });
      d.cue(2.6, () => { d.throwAt(2, 'frag', { x: -29, y: 0, z: 1.5 }); });
      d.cue(1.5, () => { for (let i = 0; i < 4; i++) d.bots[i].orders.range = 40; });
    },
  },
  {
    // The police car down Elm Street through the dead, a passenger firing out of the window; a chase camera behind it.
    name: 'drive',
    seconds: 7,
    lead: 3,
    tension: 0.75,
    track: (d) => {
      const v = d.sim.vehicles.list[car];
      return v ? { x: v.pos.x, y: v.pos.y + 1.0, z: v.pos.z } : null;
    },
    follow: true,
    cam: [
      { t: 0, pos: [-9, 2.2, -2.5], look: [5, -0.6, 0], fov: 50 },
      { t: 1, pos: [-8, 2.0, -2.2], look: [6, -0.6, 0], fov: 50 },
    ],
    setup(d) {
      d.clearZombies();
      car = policeCar(d);
      d.drive(0, car, [{ x: 20, y: 0, z: 0 }, { x: 50, y: 0, z: -1 }, { x: 140, y: 0, z: -1 }], 15);
      d.ride(1, car, 1, 30);
      d.place(2, -6, -8, 0);
      d.place(3, -3, -8, 0);
      for (const [x, z] of [[24, -1], [30, 2], [34, -2.5], [40, 0.5], [44, -1], [50, 2], [56, -3], [62, 1], [37, 3.5], [47, -3.5], [70, 0]]) d.spawn('walker', x, z, { mode: 'wander' });
      d.spawn('runner', 42, 3, { chase: 1 });
      d.spawn('runner', 54, -3, { chase: 1 });
    },
  },
  {
    // A supply drop: the helicopter overhead, the crate down on its chute, two survivors running for it.
    name: 'drop',
    seconds: 7.5,
    lead: 0.5,
    tension: 0.4,
    until: (d) => {
      const drop = d.sim.drops[d.sim.drops.length - 1];
      return !!drop && d.sim.time >= drop.flight.release - 0.4;
    },
    maxLead: 40,
    cam: (d) => {
      const drop = d.sim.drops[d.sim.drops.length - 1];
      const g = drop ? drop.flight.ground : { x: 0, y: 0, z: 0 };
      // The crate lands wherever the night puts it: the camera stands 15 m off, on the first side
      // (the road's first) with a clear line to it and open ground under it, not in someone's kitchen.
      const toRoad = Math.atan2(-g.z, 0.001);
      let cx = g.x - 15, cz = g.z;
      for (const off of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.5, -2.5, Math.PI]) {
        const a = toRoad + off;
        const x = g.x + Math.cos(a) * 15, z = g.z + Math.sin(a) * 15;
        if (d.groundAt(x, z) > 0.8) continue;
        const dx = g.x - x, dz = g.z - z;
        const l = Math.hypot(dx, dz);
        // A clear line from the lens to the crate on the ground (not over a parked car's roof).
        if (d.physics.raycast(x, 1.7, z, dx / l, -0.07, dz / l, l - 1) !== null) continue;
        cx = x;
        cz = z;
        break;
      }
      const nx = (g.x - cx) / 15, nz = (g.z - cz) / 15;
      return [
        { t: 0, pos: [cx, 2.2, cz], look: [g.x, 2.5, g.z], fov: 50 },
        { t: 1, pos: [cx + nx * 2.5, 1.6, cz + nz * 2.5], look: [g.x, 1.4, g.z], fov: 46 },
      ];
    },
    setup(d) {
      d.clearZombies();
      for (let i = 0; i < 4; i++) d.place(i, -2 + i * 2, -8, 0);
      const drop = d.sim.callSupplyDrop('lmg');
      if (!drop) return;
      const g = drop.flight.ground;
      // Two run for it once the crate is off the helicopter (the shot starts just before), not during the wait.
      d.cue(0.3, () => { d.order(0, { path: [{ x: g.x - 3, y: g.y, z: g.z + 2 }], run: true }); d.order(1, { path: [{ x: g.x + 3, y: g.y, z: g.z + 3 }], run: true }); });
      for (const [x, z] of [[g.x + 18, g.z - 4], [g.x - 16, g.z - 8], [g.x + 12, g.z + 14]]) d.spawn('walker', x, z, { chase: 0 });
    },
  },
  {
    // The van raid: headlights down Elm Street, the crew out and shooting.
    name: 'raid',
    seconds: 8,
    lead: 0.3,
    tension: 0.9,
    until: (d) => {
      const van = d.sim.raid.van;
      return !!van && van.pos.x > -52 && Math.abs(van.pos.z) < 8;
    },
    maxLead: 60,
    cam: [
      { t: 0, pos: [-6, 1.9, -9.5], look: [-45, 1.3, -1], fov: 40 },
      { t: 1, pos: [-5, 1.7, -8.5], look: [-24, 1.2, -2], fov: 44 },
    ],
    setup(d) {
      d.clearZombies();
      d.line(2, -7, [1, -0.2], 2.4, { x: -30, y: 1.3, z: -2 }, { range: 0, aim: true, light: true });
      d.sim.callRaid();
    },
  },
  {
    // The horde: the whole street full of the dead pouring west at the squad.
    name: 'horde',
    seconds: 6,
    lead: 2,
    tension: 1,
    cam: [
      { t: 0, pos: [0, 2.8, 10], look: [18, 1.0, -2], fov: 50 },
      { t: 1, pos: [3, 2.5, 8.5], look: [20, 1.0, -2], fov: 48 },
    ],
    setup(d) {
      d.clearZombies();
      d.line(10, -1.5, [0.15, -1], 2.2, { x: 30, y: 1.3, z: -1 }, { range: 55, aim: true, light: true });
      d.crowd(60, 30, ROAD, 12, { chase: 0, runners: 0.35, brutes: 0.1, spread: [1.5, 0.45] });
    },
  },
  {
    // One down on the sidewalk, a teammate pulling them up while the others hold the street.
    name: 'revive',
    seconds: 5,
    lead: 1,
    tension: 0.5,
    cam: [
      { t: 0, pos: [8.8, 1.4, -9.0], look: [5.3, 0.6, -6.5], fov: 44 },
      { t: 1, pos: [8.3, 1.3, -8.8], look: [5.3, 0.6, -6.5], fov: 42 },
    ],
    setup(d) {
      d.clearZombies();
      d.place(2, 5, -6.8, { x: -10, y: 1, z: -2 });
      d.down(2);
      d.place(0, 6.2, -5.8, { x: 5, y: 0.5, z: -6.8 });
      d.revive(0, 2);
      d.place(1, 3, -7.5, { x: -20, y: 1.3, z: -1 });
      d.place(3, 9, -4, { x: 30, y: 1.3, z: -1 });
      d.order(1, { range: 40, aim: true, light: true, face: { x: -20, y: 1.3, z: -1 } });
      d.order(3, { range: 40, aim: true, light: true, face: { x: 30, y: 1.3, z: -1 } });
      for (const [x, z] of [[-18, -2], [-24, 2], [28, 0], [-20, 5]]) d.spawn('walker', x, z, { chase: 1 });
    },
  },
  {
    // The squad walking up the middle of the street toward the lens, lamps behind them.
    name: 'walk',
    seconds: 6,
    lead: 1,
    tension: 0.2,
    drift: 0.02,
    cam: [
      // West of the raid's van (it stays where it stopped), under the lamps at -40 and -62.
      // The camera backs off down the street as they come, so they close in without walking through it.
      { t: 0, pos: [-33, 1.35, -1.5], look: [-52, 1.5, -1.2], fov: 42 },
      { t: 1, pos: [-26, 1.3, -1.5], look: [-45, 1.5, -1.2], fov: 42 },
    ],
    ease: 'linear',
    setup(d) {
      d.clearZombies();
      const xs = [-53, -51.5, -52.5, -51];
      const zs = [-3.6, -1.8, 0.2, 2.2];
      for (let i = 0; i < 4; i++) {
        d.place(i, xs[i], zs[i], { x: -26, y: 1.4, z: zs[i] });
        d.order(i, { path: [{ x: -33, y: 0, z: zs[i] }], light: i % 2 === 0 });
      }
      for (const [x, z] of [[-74, -2], [-78, 3]]) d.spawn('walker', x, z, { mode: 'wander' });
    },
  },
  {
    // Black: the title and the call to play, the night's sound carrying on.
    name: 'title',
    seconds: 9,
    lead: 0.2,
    tension: 0.25,
    black: true,
    cam: [{ t: 0, pos: [-26, 1.3, -1.5], look: [-45, 1.5, -1.2], fov: 42 }],
    setup(d) {
      for (let i = 0; i < 4; i++) d.order(i, {});
    },
  },
];
