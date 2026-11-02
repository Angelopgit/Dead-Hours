import {
  DRIVE_FLAG, VEHICLE, driveStep,
  type DriveBody, type DriveInput, type DriveState, type Simulation, type Vec3, type Vehicle,
} from '@dead-hours/shared';
import type { Input } from '../core/Input';
import type { Physics } from '../core/Physics';

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * The car this survivor drives, moved here like their feet are: every fixed step the controls
 * drive it (shared driveStep: the same pedals, steering, tyres and collisions everywhere), and
 * where it went is told to the simulation (solo) or the server (online, which checks it). The
 * dead it ploughs into are felt here at once (the car loses a little way through each one, more
 * through a brute, and shoving through a crowd at walking pace holds it back); the simulation
 * decides what the hit does to them.
 */
export class Driving {
  readonly body: DriveBody;
  readonly input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  /** The horn held, and the headlights' switch (on by default: it's night). */
  horn = false;
  lights = true;
  /** Where it was at the previous fixed step (drawn in between). */
  private readonly prev: Vec3;
  private prevYaw: number;
  /** Speed lost against something hard since the last report to the server. */
  private crash = 0;
  /** The hardest hit since the session last looked (camera jolt, rumble). */
  jolt = 0;
  /** The hardest zombie hit since the session last looked (m/s closing). */
  thud = 0;
  private readonly hits = new Map<number, number>();
  private t = 0;

  constructor(private readonly physics: Physics, private readonly sim: Simulation, readonly vehicle: Vehicle) {
    const v = vehicle;
    this.body = {
      def: v.def, pos: { ...v.pos }, yaw: v.yaw, speed: v.speed, vel: { ...v.vel }, steer: v.steer, body: v.body,
    };
    this.prev = { ...v.pos };
    this.prevYaw = v.yaw;
    this.lights = v.engine ? (v.input & DRIVE_FLAG.lights) !== 0 : true;
  }

  /**
   * The controls this frame. Keys and sticks: forward is the gas, back the brake (and reverse
   * once stopped), sideways steers; a controller's triggers work the pedals too (right gas, left
   * brake). Jump is the handbrake, melee the horn, the flashlight key the headlights.
   */
  read(input: Input): void {
    const m = input.move;
    let throttle = Math.max(0, m.y), brake = Math.max(0, -m.y);
    if (input.device === 'pad') {
      throttle = Math.max(throttle, input.triggers.r);
      brake = Math.max(brake, input.triggers.l);
    }
    this.input.throttle = throttle > 0.04 ? throttle : 0;
    this.input.brake = brake > 0.04 ? brake : 0;
    this.input.steer = Math.abs(m.x) > 0.04 ? m.x : 0;
    this.input.handbrake = input.held('jump');
    this.horn = input.held('melee');
    if (input.pressed('flashlight')) this.lights = !this.lights;
  }

  /** Lets go of everything (paused, typing in the chat, the menu open). */
  release(): void {
    this.input.throttle = this.input.brake = this.input.steer = 0;
    this.input.handbrake = false;
    this.horn = false;
  }

  /** The DRIVE_FLAG bits for the controls now: brake lights, horn, headlights. */
  flags(): number {
    const i = this.input;
    let f = 0;
    if (i.throttle > 0.1) f |= DRIVE_FLAG.throttle;
    if (i.brake > 0.1 && this.body.speed > 0.3) f |= DRIVE_FLAG.brake;
    if (i.handbrake) f |= DRIVE_FLAG.handbrake;
    if (this.horn) f |= DRIVE_FLAG.horn;
    if (this.lights) f |= DRIVE_FLAG.lights;
    return f;
  }

  /** One fixed step. The crash (m/s lost against something hard) is kept for the report. */
  step(dt: number): void {
    const b = this.body;
    this.t += dt;
    this.prev.x = b.pos.x;
    this.prev.y = b.pos.y;
    this.prev.z = b.pos.z;
    this.prevYaw = b.yaw;
    const lost = driveStep(this.physics, b, this.input, dt, this.vehicle.engine);
    this.crash = Math.max(this.crash, lost);
    this.jolt = Math.max(this.jolt, lost);
    this.bump(dt);
  }

  /**
   * The dead in the way: run down at speed, each costs the car a share of its way (a brute three
   * times as much); at walking pace the car shoves into them and is held back.
   */
  private bump(dt: number): void {
    const b = this.body;
    const def = b.def;
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    for (const z of this.sim.zombies) {
      if (!z.alive) continue;
      const dx = z.pos.x - b.pos.x, dz = z.pos.z - b.pos.z;
      if (Math.abs(dx) > def.hx + 2 || Math.abs(dz) > def.hx + 2) continue;
      if (z.pos.y > b.pos.y + def.low || z.pos.y + z.bodyHeight < b.pos.y + def.clear) continue;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      const r = z.def.radius;
      const px = def.hx + r - Math.abs(lx), pz = def.hz + r - Math.abs(lz);
      if (px <= 0 || pz <= 0) continue;
      let nx: number, nz: number;
      if (px < pz) {
        const k = lx >= 0 ? 1 : -1;
        nx = c * k;
        nz = -s * k;
      } else {
        const k = lz >= 0 ? 1 : -1;
        nx = s * k;
        nz = c * k;
      }
      const closing = b.vel.x * nx + b.vel.z * nz;
      if (closing <= 0) continue;
      if (closing >= VEHICLE.hitMin) {
        if (this.t - (this.hits.get(z.id) ?? -Infinity) < VEHICLE.hitCooldown) continue;
        this.hits.set(z.id, this.t);
        const keep = 1 - def.slow * (z.kind === 'brute' ? 3 : 1);
        b.vel.x *= keep;
        b.vel.z *= keep;
        this.thud = Math.max(this.thud, closing);
      } else {
        // Shoving: the way into them bleeds off.
        const lose = closing * (1 - Math.exp(-dt * 5));
        b.vel.x -= nx * lose;
        b.vel.z -= nz * lose;
      }
      b.speed = b.vel.x * c - b.vel.z * s;
    }
    if (this.hits.size > 32) for (const [id, at] of this.hits) if (this.t - at > 5) this.hits.delete(id);
  }

  /** What to tell the simulation or the server; the crash is counted once. */
  report(): DriveState {
    const b = this.body;
    const d: DriveState = {
      vehicle: this.vehicle.id, pos: { ...b.pos }, yaw: wrap(b.yaw), vel: { x: b.vel.x, y: 0, z: b.vel.z },
      speed: b.speed, steer: b.steer, input: this.flags(), crash: this.crash,
    };
    this.crash = 0;
    return d;
  }

  /** Online: the client's copy of the car follows (its body is what this client's shots and camera see). */
  follow(): void {
    const v = this.vehicle, b = this.body;
    v.prev.x = v.pos.x;
    v.prev.y = v.pos.y;
    v.prev.z = v.pos.z;
    v.prevYaw = v.yaw;
    v.pos.x = b.pos.x;
    v.pos.y = b.pos.y;
    v.pos.z = b.pos.z;
    v.yaw = b.yaw;
    v.vel.x = b.vel.x;
    v.vel.z = b.vel.z;
    v.speed = b.speed;
    v.steer = b.steer;
    v.input = this.flags() | (v.input & (DRIVE_FLAG.engine | DRIVE_FLAG.cranking));
    this.sim.vehicles.moveBody(v);
  }

  /** Where it is drawn now, between fixed steps (`out`: the road under its middle); returns the heading. */
  drawn(alpha: number, out: Vec3): number {
    const b = this.body;
    out.x = this.prev.x + (b.pos.x - this.prev.x) * alpha;
    out.y = this.prev.y + (b.pos.y - this.prev.y) * alpha;
    out.z = this.prev.z + (b.pos.z - this.prev.z) * alpha;
    return this.prevYaw + wrap(b.yaw - this.prevYaw) * alpha;
  }

  /** The server put it back (its move was refused): there, at a standstill. */
  reset(pos: Vec3, yaw: number): void {
    const b = this.body;
    b.pos.x = this.prev.x = pos.x;
    b.pos.y = this.prev.y = pos.y;
    b.pos.z = this.prev.z = pos.z;
    b.yaw = this.prevYaw = yaw;
    b.vel.x = b.vel.z = 0;
    b.speed = 0;
    this.crash = 0;
  }
}
