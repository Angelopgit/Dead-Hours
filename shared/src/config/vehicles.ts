import type { PropSpec } from '../types/world';

/** What a drivable vehicle is: a family car, a police cruiser, a beaten-up wreck, or the armored truck. */
export type VehicleKind = 'car' | 'police' | 'wreck' | 'truck';

/** A seat, in the vehicle's own frame: +x toward the nose, +z the passenger side, y up from the road. */
export interface SeatSpec {
  x: number;
  /** Height of the cushion (where the hips sit). */
  y: number;
  z: number;
}

export interface VehicleDef {
  kind: VehicleKind;
  /** What prompts call it. */
  name: string;
  /** Half the body's length (x) and width (z). */
  hx: number;
  hz: number;
  /** Top of the solid lower body (doors, hood, trunk): bullets, sight lines and swipes stop on it. */
  low: number;
  /** Height of the body's underside above the road (curbs pass under it). */
  clear: number;
  /** The greenhouse over it (glass and roof): only bodies collide with it, rounds and claws go through. */
  cabin: { x0: number; x1: number; top: number; hz: number };
  /** Seat 0 is the driver's. */
  seats: SeatSpec[];
  /** Height of the cabin floor over the road: where the feet of the people inside rest. */
  floor: number;
  /** The steering wheel's rim, ahead of the driver (hands go on it). */
  wheel: { x: number; y: number };
  /** Distance between the axles, and where they sit along the body. */
  wheelbase: number;
  axles: [number, number];
  wheelRadius: number;
  /** Half the distance between the left and right wheels. */
  track: number;

  // ---- driving
  /** Top speed forward and in reverse (m/s). */
  top: number;
  reverse: number;
  /** Pull from a standstill (m/s²); it tails off toward the top speed. */
  accel: number;
  /** Braking (m/s²). */
  brake: number;
  /** Front wheels' largest angle (radians) at walking pace; less at speed. */
  steer: number;
  /** How hard the tyres hold the road sideways (1/s): lower slides more. */
  grip: number;

  // ---- fuel
  /** What is left in the tank when the night starts (share of a full tank). */
  fuel: [number, number];
  /** Tank burned per metre driven, and per second with the engine running. */
  burn: number;
  idle: number;
  /** Seconds the starter turns before it catches. */
  crank: number;

  // ---- against the dead
  /** Damage dealt by a hit scales with this (a heavy truck hits harder). */
  ram: number;
  /** Share of the speed lost for each zombie run down (brutes cost more). */
  slow: number;
}

const CAR_SEATS: SeatSpec[] = [
  { x: 0.12, y: 0.5, z: -0.4 },
  { x: 0.12, y: 0.5, z: 0.4 },
  { x: -0.88, y: 0.52, z: -0.4 },
  { x: -0.88, y: 0.52, z: 0.4 },
];

const CAR_BODY = {
  hx: 2.22, hz: 0.93, low: 0.95, clear: 0.22,
  cabin: { x0: -1.35, x1: 0.95, top: 1.58, hz: 0.86 },
  seats: CAR_SEATS,
  floor: 0.36,
  wheel: { x: 0.52, y: 0.93 },
  wheelbase: 2.7, axles: [1.35, -1.35] as [number, number], wheelRadius: 0.36, track: 0.86,
};

export const VEHICLES: Record<VehicleKind, VehicleDef> = {
  car: {
    kind: 'car', name: 'CAR', ...CAR_BODY,
    top: 24, reverse: 7, accel: 7.2, brake: 13, steer: 0.62, grip: 11,
    fuel: [0.16, 0.5], burn: 0.00034, idle: 0.0006, crank: 0.9,
    ram: 1, slow: 0.07,
  },
  police: {
    kind: 'police', name: 'POLICE CAR', ...CAR_BODY,
    top: 28, reverse: 8, accel: 8.6, brake: 15, steer: 0.62, grip: 12,
    fuel: [0.24, 0.6], burn: 0.00034, idle: 0.0006, crank: 0.7,
    ram: 1.1, slow: 0.06,
  },
  wreck: {
    kind: 'wreck', name: 'WRECKED CAR', ...CAR_BODY,
    top: 16, reverse: 5, accel: 4.6, brake: 10, steer: 0.55, grip: 8.5,
    fuel: [0.05, 0.2], burn: 0.00042, idle: 0.0008, crank: 2.1,
    ram: 0.9, slow: 0.09,
  },
  truck: {
    kind: 'truck', name: 'ARMORED TRUCK',
    hx: 3.1, hz: 1.2, low: 1.45, clear: 0.3,
    cabin: { x0: -3.1, x1: 3.1, top: 2.6, hz: 1.18 },
    seats: [
      { x: 2.0, y: 1.12, z: -0.55 },
      { x: 2.0, y: 1.12, z: 0.55 },
      { x: -0.4, y: 1.08, z: -0.6 },
      { x: -0.4, y: 1.08, z: 0.6 },
    ],
    floor: 0.95,
    wheel: { x: 2.45, y: 1.55 },
    wheelbase: 4.4, axles: [2.2, -2.2], wheelRadius: 0.5, track: 1.05,
    top: 17, reverse: 5, accel: 3.8, brake: 9, steer: 0.5, grip: 9,
    fuel: [0.4, 0.75], burn: 0.0005, idle: 0.0009, crank: 1.4,
    ram: 2.2, slow: 0.025,
  },
};

/**
 * Drivable vehicles: some of the cars and cruisers parked about each street, and the armored truck,
 * can be started and driven (the map marks which; the rest, and every wreck, stay parked). Each
 * has whatever was left in its tank; when it runs dry the engine dies and it rolls to a stop.
 * Survivors get in by any free seat, the driver steers, the others lean out and shoot. The
 * driver's own browser moves the car (like walking); the simulation keeps the fuel, the seats,
 * and what the car does to the dead it hits.
 */
export const VEHICLE = {
  /** How close to the body a survivor must be to get in (metres from the bodywork). */
  reach: 1.5,
  /** Nobody gets out of a car going faster than this (m/s). */
  exitSpeed: 4,
  /** Eye height above the seat cushion. */
  seatEye: 0.72,
  /** Shooting from a moving car: this share of its speed counts toward the spread. */
  spreadSpeed: 0.3,
  /** A swipe at someone through a window does this share of its damage... */
  clawScale: 0.65,
  /** ...and misses altogether while the car moves faster than this (m/s). */
  clawSpeed: 4,

  // ---- running the dead down
  /** Slower than this (m/s) a zombie is only shoved aside. */
  hitMin: 3.2,
  /** Damage: this × speed² (× the vehicle's ram). 8 m/s takes a walker down, 17 a brute. */
  impact: 1.6,
  /** A zombie can't be hit by the same car again this soon (seconds). */
  hitCooldown: 0.7,

  // ---- crashing
  /** Speed lost against a wall in an instant (m/s) above which the people inside get hurt. */
  crashHurt: 13,
  /** Damage per m/s past it. */
  crashDamage: 2.4,
  /** A loss of this much is heard as a crash. */
  crashSound: 4.5,

  // ---- what it sounds like to the dead
  /** Engine heard this far idling, and at full speed (metres), every `noiseEvery` seconds. */
  noise: [9, 30] as const,
  noiseEvery: 0.5,
  /** The horn carries far: every zombie on the block comes. */
  hornNoise: 45,

  /** Hard cap on any vehicle's speed (the server allows a little over this). */
  maxSpeed: 30,
} as const;

/**
 * Which vehicle a map prop is, or null when it can't be driven: anything else, a car the map leaves
 * parked for good (only the ones it marks `drive` still run), or a wreck on its roof.
 */
export function vehicleKindOf(p: PropSpec): VehicleKind | null {
  if (!p.drive) return null;
  switch (p.kind) {
    case 'car':
      return 'car';
    case 'policeCar':
      return 'police';
    case 'armoredTruck':
      return 'truck';
    case 'wreckedCar':
      return (p.variant ?? 0) >= 10 ? null : 'wreck';
    default:
      return null;
  }
}

/** How high a seat's cushion is over the cabin floor (the legs reach down that far to it). */
export function seatDrop(def: VehicleDef, seat: number): number {
  const s = def.seats[seat] ?? def.seats[0];
  return Math.max(0, s.y - def.floor);
}

/** Whether a map prop is a vehicle that can be driven (it is built and moved as one, not as scenery). */
export function isDrivable(p: PropSpec): boolean {
  return vehicleKindOf(p) !== null;
}
