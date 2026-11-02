import { RAPIER, GROUP, groups, type Physics } from '../physics/Physics';
import { VEHICLE, type VehicleDef } from '../config/vehicles';
import { clamp, type Vec3 } from './math';

/** What the driver is doing with the controls. Pedals 0..1; steer -1 (left) .. 1 (right). */
export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

/** A vehicle's motion: where it is, which way it points, how it is moving. */
export interface DriveBody {
  readonly def: VehicleDef;
  /** The road under its middle. */
  pos: Vec3;
  /** Rotation about up: the nose points along (cos yaw, 0, -sin yaw), the passenger side along (sin yaw, 0, cos yaw). */
  yaw: number;
  /** Forward speed (m/s; negative backing up) and velocity over the ground. */
  speed: number;
  vel: Vec3;
  /** Front wheels' angle (radians, + to the right). */
  steer: number;
  /** Its own body, which its sweeps look through. */
  body: RAPIER.RigidBody | null;
}

/** What a vehicle bumps into: the world, doors, crates and other vehicles (never people or the dead, which it runs into on purpose). */
const DRIVE_FILTER = groups(GROUP.vehicle, GROUP.static | GROUP.dynamic | GROUP.vehicle);
/** The road under the wheels. */
const GROUND = groups(0xffff, GROUP.static);
const SKIN = 0.02;

const hulls = new WeakMap<VehicleDef, RAPIER.Cuboid>();

/** The solid lower body as a shape (centred `hullY(def)` above the road). */
export function hullShape(def: VehicleDef): RAPIER.Cuboid {
  let h = hulls.get(def);
  if (!h) {
    h = new RAPIER.Cuboid(def.hx, (def.low - def.clear) / 2, def.hz);
    hulls.set(def, h);
  }
  return h;
}

export function hullY(def: VehicleDef): number {
  return def.clear + (def.low - def.clear) / 2;
}

export function bodyYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
}

/** Eases a speed toward zero by `d` (never past it). */
function toward0(v: number, d: number): number {
  return v > 0 ? Math.max(0, v - d) : Math.min(0, v + d);
}

/** Whether the hull at this pose overlaps anything it would bump into. */
export function hullBlocked(physics: Physics, b: DriveBody, x: number, y: number, z: number, yaw: number): boolean {
  let hit = false;
  physics.world.intersectionsWithShape(
    { x, y: y + hullY(b.def), z }, bodyYaw(yaw), hullShape(b.def),
    () => { hit = true; return false; }, undefined, DRIVE_FILTER, undefined, b.body ?? undefined,
  );
  return hit;
}

/**
 * One step of driving: an arcade car on four wheels. The engine pulls hard from a standstill and
 * runs out of pull near the top speed; the brake pedal backs up once stopped; the front wheels
 * turn less the faster it goes; the tyres hold sideways firmly (the handbrake lets the tail out).
 * The body is swept against the world and slides along what it meets; returns the speed lost
 * against it (a crash), in m/s. `engine` false: no pull, only coasting and brakes.
 */
export function driveStep(physics: Physics, b: DriveBody, input: DriveInput, dt: number, engine: boolean): number {
  const def = b.def;
  let c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  let vF = b.vel.x * c - b.vel.z * s;
  let vR = b.vel.x * s + b.vel.z * c;
  const thr = engine ? clamp(input.throttle, 0, 1) : 0;
  const brk = clamp(input.brake, 0, 1);

  // Pedals.
  if (thr > 0) {
    if (vF >= -0.5) vF += def.accel * thr * Math.max(0, 1 - Math.abs(vF / def.top) ** 3) * dt;
    else vF = toward0(vF, def.brake * thr * dt);
  }
  if (brk > 0) {
    if (vF > 0.5) vF = toward0(vF, def.brake * brk * dt);
    else if (engine && thr === 0) vF -= def.accel * 0.7 * brk * Math.max(0, 1 - (vF / def.reverse) ** 2) * dt;
    else vF = toward0(vF, def.brake * brk * dt);
  }
  if (input.handbrake) vF = toward0(vF, 7 * dt);
  // Rolling resistance, engine braking off the pedal, and the air.
  vF = toward0(vF, (0.35 + (engine && thr === 0 && brk === 0 ? 0.9 : 0) + 0.0015 * vF * vF) * dt);
  vF = clamp(vF, -VEHICLE.maxSpeed, VEHICLE.maxSpeed);

  // Steering: the wheels turn at a steady rate, less far at speed. Right turns the nose toward +side.
  const want = clamp(input.steer, -1, 1) * def.steer / (1 + Math.abs(vF) / 9);
  b.steer += clamp(want - b.steer, -3.2 * dt, 3.2 * dt);
  let yawRate = (-vF * Math.tan(b.steer)) / def.wheelbase;
  if (input.handbrake && Math.abs(vF) > 3) yawRate *= 1.35;
  const yaw = b.yaw + yawRate * dt;
  // A turn that would swing the body into a wall doesn't happen.
  if (Math.abs(yawRate) > 1e-4 && hullBlocked(physics, b, b.pos.x, b.pos.y, b.pos.z, yaw) && !hullBlocked(physics, b, b.pos.x, b.pos.y, b.pos.z, b.yaw)) {
    b.steer *= 0.5;
  } else {
    // The velocity stays put for the instant the body turns; the tyres then bite on the new heading.
    const vx = c * vF + s * vR, vz = -s * vF + c * vR;
    b.yaw = Math.atan2(Math.sin(yaw), Math.cos(yaw));
    c = Math.cos(b.yaw);
    s = Math.sin(b.yaw);
    vF = vx * c - vz * s;
    vR = vx * s + vz * c;
  }
  const grip = input.handbrake ? def.grip * 0.18 : Math.abs(vR) > 6 ? def.grip * 0.6 : def.grip;
  vR *= Math.exp(-grip * dt);
  b.vel.x = c * vF + s * vR;
  b.vel.z = -s * vF + c * vR;
  b.vel.y = 0;

  // Sweep the body along and slide off what it meets.
  let crash = 0;
  let mx = b.vel.x * dt, mz = b.vel.z * dt;
  const rot = bodyYaw(b.yaw);
  const shape = hullShape(def);
  const hy = hullY(def);
  for (let i = 0; i < 3 && mx * mx + mz * mz > 1e-10; i++) {
    const hit = physics.world.castShape(
      { x: b.pos.x, y: b.pos.y + hy, z: b.pos.z }, rot, { x: mx, y: 0, z: mz }, shape, 0, 1, false,
      undefined, DRIVE_FILTER, undefined, b.body ?? undefined,
    );
    if (!hit) {
      b.pos.x += mx;
      b.pos.z += mz;
      break;
    }
    const len = Math.hypot(mx, mz);
    const t = Math.max(0, hit.time_of_impact - SKIN / len);
    b.pos.x += mx * t;
    b.pos.z += mz * t;
    let nx = hit.normal1.x, nz = hit.normal1.z;
    const nl = Math.hypot(nx, nz);
    if (nl < 1e-3) break;
    nx /= nl;
    nz /= nl;
    // Speed into the wall is lost (a little of it bounces back).
    const vn = b.vel.x * nx + b.vel.z * nz;
    if (vn < 0) {
      crash = Math.max(crash, -vn);
      b.vel.x -= nx * vn * 1.15;
      b.vel.z -= nz * vn * 1.15;
    }
    let rx = mx * (1 - t), rz = mz * (1 - t);
    const rn = rx * nx + rz * nz;
    if (rn < 0) {
      rx -= nx * rn;
      rz -= nz * rn;
    }
    mx = rx;
    mz = rz;
  }
  b.speed = b.vel.x * c - b.vel.z * s;

  // Settle onto the road (up a curb, down off it).
  const g = physics.raycast(b.pos.x, b.pos.y + 1.2, b.pos.z, 0, -1, 0, 2.6, GROUND);
  if (g !== null) {
    const gy = b.pos.y + 1.2 - g;
    b.pos.y += (gy - b.pos.y) * Math.min(1, dt * 14);
  }
  return crash;
}
