import * as THREE from 'three';
import {
  DOWNED, DRIVE_FLAG, NEIGHBORHOOD, PLAYER, SQUAD_LOADOUTS, SQUAD_NAMES, SquadBot, driveStep, encodeAppearance, randomAppearance, rng, yawToward,
  type BotOrders, type DriveBody, type DriveInput, type ThrowKind, type Vec3, type Vehicle, type Zombie, type ZombieKind,
} from '@dead-hours/shared';
import type { Engine } from '../core/Engine';
import type { Physics } from '../core/Physics';
import type { Neighborhood } from '../environment/Neighborhood';
import { weather } from '../environment/Weather';
import { AudioEngine, audio } from '../audio/AudioEngine';
import { Acoustics } from '../audio/Acoustics';
import type { GameSession, TrailerHooks } from './GameSession';
import { SHOTS, type CamKey, type Shot } from './TrailerShots';

/**
 * The trailer's director (development only, `?trailer`): a solo night with four computer-driven
 * survivors (shared Squad bots, drawn like online teammates) that a script walks through a list
 * of shots. Each shot sets its cast (bots placed and ordered, zombies spawned, a car started, a
 * Molotov thrown...) and moves the camera along keys. client/tools/trailer/render.mjs drives it
 * frame by frame through `window.__trailer`: `begin()`, then `step()` until it says done, each
 * step rendering one frame and returning its pixels; then `renderAudio()` plays every sound the
 * frames made again through the game's own audio engine, offline, into a WAV in sync with them.
 */

/** Film rate: every frame is a software-rendered second or more, and 24 reads as cinema. */
const FPS = 24;
const FRAME = 1 / FPS;
/** Lead-in frames run at this rate (the fixed loop allows five steps a frame). */
const LEAD_DT = 1 / 12;

/** The game's sounds the frames are logged with (every one-shot and every per-frame state call the night makes). */
const SOUNDS = [
  'thunder', 'footstep', 'door', 'groan', 'helicopters', 'van', 'raidSting', 'crateLand', 'flashlight', 'gunshot', 'dryFire', 'foley',
  'casing', 'impact', 'flesh', 'headPop', 'bodyFall', 'chunkLand', 'meleeSwing', 'heavySwing', 'sever', 'clubHit', 'limbBreak', 'limbGrab',
  'limbLand', 'zombieStep', 'zombieAlert', 'zombieAttack', 'zombieHurt', 'zombieDeath', 'zombieScream', 'bloaterBurst', 'doorPound',
  'doorBurst', 'hammer', 'board', 'vault', 'stance', 'glassBreak', 'playerHurt', 'bandage', 'pickup', 'syringe', 'outbreak', 'hordeWarning',
  'hordeSurge', 'hordeOver', 'lullStart', 'lullEnding', 'death', 'setVitals', 'meleeWhoosh', 'meleeHit', 'meleePickup', 'throwReady',
  'throwWhoosh', 'thrownBounce', 'explosion', 'molotov', 'ignite', 'fires', 'skateRoll', 'skateSeam', 'skatePop', 'skateLand', 'skateKick',
  'skateFlick', 'skateCatch', 'skateMount', 'skateOff', 'skateBail', 'engines', 'carDoor', 'starter', 'engineCatch', 'sputter', 'carCrash',
  'carHit', 'bikeRoll', 'bikeSeam', 'bikeMount', 'bikePeg', 'bikeDrop', 'bikeLand', 'bikeCrash', 'bikeBell',
] as const;

type Logged = unknown;

interface AudioFrame {
  /** Camera: position and quaternion. */
  cam: number[];
  tension: number;
  calls: [string, Logged[]][];
}

/** Sound arguments as plain data (vectors, maps and objects), to be built again for the replay. */
function pack(v: unknown): Logged {
  if (v instanceof THREE.Vector3) return { $v: [v.x, v.y, v.z] };
  if (v instanceof Map) return { $m: [...v.entries()].map(([k, x]) => [pack(k), pack(x)]) };
  if (Array.isArray(v)) return v.map(pack);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)]));
  if (typeof v === 'function') return null;
  return v;
}

function unpack(v: Logged): unknown {
  if (Array.isArray(v)) return v.map(unpack);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.$v)) return new THREE.Vector3(o.$v[0] as number, o.$v[1] as number, o.$v[2] as number);
    if (Array.isArray(o.$m)) return new Map((o.$m as [Logged, Logged][]).map(([k, x]) => [unpack(k), unpack(x)]));
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, unpack(x)]));
  }
  return v;
}

/** A bot at a car's wheel: the shared drive model steered along a path, reported to the simulation like a browser would. */
class BotDriver {
  readonly body: DriveBody;
  readonly input: DriveInput = { throttle: 0, brake: 0, steer: 0, handbrake: false };
  private leg = 0;
  crash = 0;

  constructor(private readonly physics: Physics, private readonly sim: GameSession['sim'], readonly id: string, readonly vehicle: Vehicle, readonly path: Vec3[], readonly speed: number) {
    const v = vehicle;
    this.body = { def: v.def, pos: { ...v.pos }, yaw: v.yaw, speed: v.speed, vel: { ...v.vel }, steer: v.steer, body: v.body };
  }

  step(dt: number): void {
    const b = this.body;
    const v = this.vehicle;
    // Steering toward the next point of the path.
    while (this.leg < this.path.length && Math.hypot(this.path[this.leg].x - b.pos.x, this.path[this.leg].z - b.pos.z) < 3.5) this.leg++;
    const goal = this.path[Math.min(this.leg, this.path.length - 1)];
    const want = Math.atan2(-(goal.z - b.pos.z), goal.x - b.pos.x);
    const err = Math.atan2(Math.sin(want - b.yaw), Math.cos(want - b.yaw));
    this.input.steer = Math.max(-1, Math.min(1, -err * 1.6));
    const done = this.leg >= this.path.length;
    this.input.throttle = done ? 0 : b.speed < this.speed ? 1 : 0.15;
    this.input.brake = done ? 0.7 : 0;
    const lost = driveStep(this.physics, b, this.input, dt, v.engine);
    this.crash = Math.max(this.crash, lost);
    let flags = DRIVE_FLAG.lights;
    if (this.input.throttle > 0.1) flags |= DRIVE_FLAG.throttle;
    if (this.input.brake > 0.1 && b.speed > 0.3) flags |= DRIVE_FLAG.brake;
    this.sim.drive(this.id, {
      vehicle: v.id, pos: { ...b.pos }, yaw: Math.atan2(Math.sin(b.yaw), Math.cos(b.yaw)), vel: { x: b.vel.x, y: 0, z: b.vel.z },
      speed: b.speed, steer: b.steer, input: flags, crash: this.crash,
    });
    this.crash = 0;
  }
}

export class TrailerDirector implements TrailerHooks {
  readonly bots: SquadBot[] = [];
  readonly fps = FPS;
  readonly shots: Shot[];
  private shotIndex = -1;
  shot: Shot | null = null;
  /** Seconds into the shot, and frames captured in all. */
  shotT = 0;
  frame = 0;
  private cam: CamKey[] = [];
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private camFov = 50;
  private readonly tracked = new THREE.Vector3();
  private drivers: BotDriver[] = [];
  /** Per-step work a shot asked for (a Molotov at 1.5 s, a car started at 0...). */
  private cues: { at: number; run: () => void }[] = [];
  private recording = false;
  readonly log: AudioFrame[] = [];
  private current: AudioFrame | null = null;
  tension = 0;
  done = false;
  private readonly rand = rng(0x7a11e7);

  constructor(readonly engine: Engine, readonly session: GameSession, readonly world: Neighborhood, readonly physics: Physics) {
    const only = new URLSearchParams(location.search).get('shots');
    this.shots = only ? SHOTS.filter((s) => only.split(',').includes(s.name)) : SHOTS;
  }

  get sim(): GameSession['sim'] {
    return this.session.sim;
  }

  /** Stops the live loop, puts the night at the outbreak with the squad in it, starts logging. Then `step`. */
  begin(): { shots: string[]; frames: number; fps: number } {
    this.engine.stop();
    const s = this.session;
    s.trailer = this;
    s.hideSelf();
    this.sim.skipPreparation();
    // Rain that never changes between frames (it follows the wall clock otherwise), wet streets.
    weather.rain = 0.55;
    weather.wetness = 1;
    this.world.lighting.calm = true;
    audio.unlock();
    // Night, not the preparation: one step turns the phase over.
    this.sim.step(1 / 60);
    this.sim.drain();
    const spawn = NEIGHBORHOOD.playerSpawns[0];
    for (let i = 0; i < 4; i++) {
      const [primary, secondary] = SQUAD_LOADOUTS[i];
      const look = randomAppearance(rng(0x5a1ad + i * 977));
      const id = `bot${i}`;
      this.sim.addPlayer(id, SQUAD_NAMES[i], primary, secondary, { x: spawn.x + i, y: spawn.y, z: spawn.z }, 0, encodeAppearance(look));
      this.bots.push(new SquadBot(this.sim, id, 0xb07 + i * 31));
    }
    this.hookAudio();
    const frames = this.shots.reduce((n, sh) => n + Math.round(sh.seconds * FPS), 0);
    return { shots: this.shots.map((sh) => sh.name), frames, fps: FPS };
  }

  private hookAudio(): void {
    const a = audio as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of SOUNDS) {
      const orig = a[name];
      if (typeof orig !== 'function') continue;
      a[name] = (...args: unknown[]) => {
        if (this.recording && this.current) this.current.calls.push([name, args.map(pack)]);
        return orig.apply(audio, args);
      };
    }
  }

  // ------------------------------------------------------------------ the cast

  /** Ground height under a point (the road, a floor, a car roof). */
  groundAt(x: number, z: number, from = 6): number {
    const hit = this.physics.raycast(x, from, z, 0, -1, 0, from + 8);
    return hit === null ? 0 : from - hit;
  }

  /** Bot `i` standing at (x, z) on the ground, facing `at` (or the point it looks at). */
  place(i: number, x: number, z: number, at: Vec3 | number = 0, y?: number): SquadBot {
    const b = this.bots[i];
    const pos = { x, y: y ?? this.groundAt(x, z), z };
    const yaw = typeof at === 'number' ? at : yawToward(pos, at);
    b.place(pos, yaw);
    b.order({});
    return b;
  }

  order(i: number, o: BotOrders): SquadBot {
    const b = this.bots[i];
    b.order(o);
    return b;
  }

  /** The whole squad in a line across `across` (a unit direction) centred on (x, z), `gap` apart. */
  line(x: number, z: number, across: [number, number], gap: number, face: Vec3, orders: BotOrders): void {
    const n = this.bots.length;
    for (let i = 0; i < n; i++) {
      const k = i - (n - 1) / 2;
      this.place(i, x + across[0] * k * gap, z + across[1] * k * gap, face);
      this.order(i, { face, ...orders });
    }
  }

  /** A zombie at (x, z), on the ground; `chase`: which bot it comes for straight away. */
  spawn(kind: ZombieKind, x: number, z: number, opts: { chase?: number; mode?: 'approach' | 'wander' | 'idle'; y?: number } = {}): Zombie {
    const y = opts.y ?? this.groundAt(x, z);
    const zombie = this.sim.spawnZombie(kind, { x, y, z }, opts.mode ?? 'approach');
    if (opts.chase !== undefined) {
      const p = this.bots[opts.chase].player;
      if (p) zombie.summon(p);
    }
    return zombie;
  }

  /** `n` zombies scattered within `radius` of (x, z), mostly walkers with runners and the odd brute. */
  crowd(n: number, x: number, z: number, radius: number, opts: { chase?: number; runners?: number; brutes?: number; mode?: 'approach' | 'wander' | 'idle'; spread?: [number, number] } = {}): Zombie[] {
    const out: Zombie[] = [];
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2;
      const d = Math.sqrt(this.rand()) * radius;
      const sx = opts.spread ? opts.spread[0] : 1, sz = opts.spread ? opts.spread[1] : 1;
      const r = this.rand();
      const kind: ZombieKind = r < (opts.brutes ?? 0.08) ? 'brute' : r < (opts.brutes ?? 0.08) + (opts.runners ?? 0.25) ? 'runner' : 'walker';
      out.push(this.spawn(kind, x + Math.cos(a) * d * sx, z + Math.sin(a) * d * sz, { chase: opts.chase, mode: opts.mode }));
    }
    return out;
  }

  /** Every zombie gone (the next shot starts clean; corpses stay where they fell). */
  clearZombies(): void {
    for (const z of this.sim.zombies) z.removeBody();
    this.sim.zombies.length = 0;
  }

  /** Bot `i` into the driver's seat of vehicle `id` (placed beside the door first), then along `path` at `speed`. */
  drive(i: number, id: number, path: Vec3[], speed: number): BotDriver | null {
    const v = this.sim.vehicles.list[id];
    const b = this.bots[i];
    if (!v || !b.player) return null;
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    // Beside the driver's door (the passenger side is +z local; the driver's is -z).
    const dz = -(v.def.hz + 0.8);
    b.place({ x: v.pos.x + dz * s, y: v.pos.y, z: v.pos.z + dz * c }, 0);
    b.order({});
    if (!this.sim.enterVehicle(b.id, id, 0)) return null;
    const d = new BotDriver(this.physics, this.sim, b.id, v, path, speed);
    this.drivers.push(d);
    return d;
  }

  /** Bot `i` into a passenger seat of vehicle `id`, fighting out of the window. */
  ride(i: number, id: number, seat: number, range = 30): boolean {
    const v = this.sim.vehicles.list[id];
    const b = this.bots[i];
    if (!v || !b.player) return false;
    const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
    const dz = v.def.hz + 0.8;
    b.place({ x: v.pos.x + dz * s, y: v.pos.y, z: v.pos.z + dz * c }, 0);
    b.order({ range, aim: true });
    return this.sim.enterVehicle(b.id, id, seat);
  }

  /** Everyone out of every car (a moving one too: the seat is simply forgotten) and every driver let go. */
  park(): void {
    this.drivers = [];
    for (const b of this.bots) {
      if (!this.sim.vehicles.seatOf(b.id)) continue;
      if (!this.sim.exitVehicle(b.id)) this.sim.vehicles.forget(b.id);
    }
  }

  /** Bot `i` throws a grenade or a Molotov at `at`. */
  throwAt(i: number, kind: ThrowKind, at: Vec3): boolean {
    const b = this.bots[i];
    if (b.player) b.player.arsenal.throwables[kind] = Math.max(1, b.player.arsenal.throwables[kind]);
    return b.throwAt(kind, at);
  }

  /** Bot `i` goes down (bleeding out) where they stand, for a teammate to pick up. */
  down(i: number): void {
    const p = this.bots[i].player;
    if (!p || p.downed) return;
    p.downed = true;
    p.downs++;
    p.health = 0;
    p.bleed = DOWNED.bleedOut;
    p.work = null;
    this.bots[i].order({});
    this.sim.emit({ type: 'playerDowned', player: p.id, bleed: p.bleed, last: false });
  }

  /** Bot `i` keeps trying to pick bot `j` up (once in reach). */
  revive(i: number, j: number): void {
    this.cues.push({ at: -1, run: () => { this.sim.revive(this.bots[i].id, this.bots[j].id); } });
  }

  /** Something at `t` seconds into the shot (`at` -1: every step). */
  cue(at: number, run: () => void): void {
    this.cues.push({ at, run });
  }

  /** The ammunition and health of the squad never run out (a trailer, not a night). */
  private topUp(): void {
    const me = this.session.me;
    me.health = PLAYER.maxHealth;
    for (const b of this.bots) {
      const p = b.player;
      if (!p) continue;
      if (!p.downed) p.health = Math.max(p.health, PLAYER.maxHealth * 0.6);
      const a = p.arsenal;
      a.primary.reserve = Math.max(a.primary.reserve, 400);
      a.secondary.reserve = Math.max(a.secondary.reserve, 200);
    }
  }

  // ------------------------------------------------------------------ hooks

  fixedUpdate(step: number): void {
    this.topUp();
    for (const c of this.cues) {
      if (c.at < 0) c.run();
      else if (c.at <= this.shotT && c.at > this.shotT - step - 1e-6) c.run();
    }
    for (const b of this.bots) b.update(step);
    for (const d of this.drivers) d.step(step);
    this.shotT += step;
  }

  placeCamera(camera: THREE.PerspectiveCamera, focus: THREE.Vector3): void {
    if (!this.shot) return;
    this.evalCamera(this.shotT / this.shot.seconds);
    camera.position.copy(this.camPos);
    camera.lookAt(this.camLook);
    if (camera.fov !== this.camFov) {
      camera.fov = this.camFov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    focus.copy(this.camLook);
  }

  private evalCamera(u: number): void {
    const keys = this.cam;
    if (!keys.length) return;
    u = Math.max(0, Math.min(1, u));
    let k = 0;
    while (k < keys.length - 2 && u > keys[k + 1].t) k++;
    const a = keys[k], b = keys[Math.min(k + 1, keys.length - 1)];
    let f = b.t > a.t ? (u - a.t) / (b.t - a.t) : 0;
    f = Math.max(0, Math.min(1, f));
    if (this.shot?.ease !== 'linear') f = f * f * (3 - 2 * f);
    this.camPos.set(a.pos[0] + (b.pos[0] - a.pos[0]) * f, a.pos[1] + (b.pos[1] - a.pos[1]) * f, a.pos[2] + (b.pos[2] - a.pos[2]) * f);
    this.camLook.set(a.look[0] + (b.look[0] - a.look[0]) * f, a.look[1] + (b.look[1] - a.look[1]) * f, a.look[2] + (b.look[2] - a.look[2]) * f);
    const tracked = this.shot?.track?.(this);
    if (tracked) {
      this.camLook.add(this.tracked.set(tracked.x, tracked.y, tracked.z));
      if (this.shot?.follow) this.camPos.add(this.tracked);
    }
    const fa = a.fov ?? 50, fb = b.fov ?? 50;
    this.camFov = fa + (fb - fa) * f;
    // A little handheld drift so a still frame breathes.
    const t = this.shotT;
    const drift = this.shot?.drift ?? 0.03;
    this.camPos.x += Math.sin(t * 0.7) * drift;
    this.camPos.y += Math.sin(t * 1.1 + 1) * drift * 0.7;
    this.camLook.y += Math.sin(t * 0.9 + 2) * drift * 0.5;
  }

  // ------------------------------------------------------------------ frames

  private startShot(sh: Shot): void {
    this.shot = sh;
    this.shotT = 0;
    this.cues = [];
    this.drivers = [];
    this.recording = false;
    this.tension = sh.tension ?? 0.3;
    // The cast starts the shot on foot and idle (a seat would keep moving them with the car).
    this.park();
    for (const b of this.bots) b.order({});
    sh.setup(this);
    this.cam = typeof sh.cam === 'function' ? sh.cam(this) : sh.cam;
    // The lead: the cast gets going before the first frame (a car up to speed, a crowd on the move),
    // or until what the shot waits for has come (the van in sight, the crate released).
    // Nothing is drawn until the first frame (the simulation is what matters here).
    if (sh.until) {
      for (let t = 0; t < (sh.maxLead ?? 30) && !sh.until(this); t += LEAD_DT) this.engine.step(LEAD_DT, false);
    }
    const lead = sh.lead ?? 0.5;
    const n = Math.max(1, Math.round(lead / LEAD_DT));
    for (let i = 0; i < n; i++) this.engine.step(LEAD_DT, false);
    this.shotT = 0;
    this.recording = true;
  }

  /**
   * Runs the next frame and, with `draw`, renders it: `rgba` is the frame's raw pixels (rows from the
   * bottom up, base64), null for a black frame (the title cards' background) or a frame not drawn (a
   * quick look at every Nth). Black frames still make sound (the night goes on under them).
   */
  async step(draw = true): Promise<{ done: boolean; shot: string; frame: number; shotFrame: number; black: boolean; width: number; height: number; rgba: string | null; cast: string[] }> {
    const gl = this.engine.renderer.getContext();
    const size = { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
    if (this.done) return { done: true, shot: '', frame: this.frame, shotFrame: 0, black: true, ...size, rgba: null, cast: [] };
    if (!this.shot || this.shotT >= this.shot.seconds - 1e-6) {
      this.shotIndex++;
      if (this.shotIndex >= this.shots.length) {
        this.done = true;
        this.recording = false;
        return { done: true, shot: '', frame: this.frame, shotFrame: 0, black: true, ...size, rgba: null, cast: [] };
      }
      this.startShot(this.shots[this.shotIndex]);
    }
    const sh = this.shot!;
    const shotFrame = Math.round(this.shotT * FPS);
    this.current = { cam: [], tension: this.tension, calls: [] };
    const drawn = draw && !sh.black;
    this.engine.step(FRAME, drawn);
    const c = this.engine.camera;
    this.current.cam = [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w];
    this.log.push(this.current);
    this.current = null;
    const rgba = drawn ? await this.engine.readFrame() : null;
    return { done: false, shot: sh.name, frame: this.frame++, shotFrame, black: !!sh.black, ...size, rgba, cast: this.cast() };
  }

  /** Where the squad is (a line per bot, for the renderer's log). */
  cast(): string[] {
    return this.bots.map((b) => {
      const p = b.player;
      if (!p) return `${b.id} gone`;
      const m = p.motion;
      return `${b.id} (${m.pos.x.toFixed(1)}, ${m.pos.y.toFixed(1)}, ${m.pos.z.toFixed(1)}) v${Math.hypot(m.vel.x, m.vel.z).toFixed(1)}${p.downed ? ' downed' : ''}${p.alive ? '' : ' dead'}`;
    });
  }

  // ------------------------------------------------------------------ sound

  /**
   * Every sound the frames logged, played again through a fresh audio engine into an offline
   * context, the listener following the camera frame by frame: a 48 kHz stereo WAV (base64).
   */
  async renderAudio(): Promise<string> {
    const frames = this.log;
    const SR = 48000;
    const seconds = frames.length * FRAME;
    const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
    const eng = new AudioEngine();
    eng.unlock(ctx);
    await eng.recordingsReady;
    eng.setAcoustics(new Acoustics(this.physics));
    for (const a of this.world.props.anchors) eng.addEmitter(a.kind, a.position, a.level);
    const cam = new THREE.PerspectiveCamera();
    const e = eng as unknown as Record<string, (...args: unknown[]) => unknown>;
    frames.forEach((fr, f) => {
      const at = Math.round((f * FRAME * SR) / 128) * 128 / SR;
      void ctx.suspend(at).then(() => {
        cam.position.set(fr.cam[0], fr.cam[1], fr.cam[2]);
        cam.quaternion.set(fr.cam[3], fr.cam[4], fr.cam[5], fr.cam[6]);
        cam.updateMatrixWorld();
        eng.tension = fr.tension;
        eng.update(FRAME, cam);
        for (const [name, args] of fr.calls) {
          try {
            e[name](...args.map(unpack));
          } catch (err) {
            console.warn('replay', name, err);
          }
        }
        void ctx.resume();
      });
    });
    const out = await ctx.startRendering();
    eng.dispose();
    return wav(out);
  }
}

function wav(buf: AudioBuffer): string {
  const n = buf.length, ch = buf.numberOfChannels;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); data.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, buf.sampleRate, true); data.setUint32(28, buf.sampleRate * ch * 2, true);
  data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true); str(36, 'data'); data.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buf.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) data.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 0x7fff, true);
  const bytes = new Uint8Array(data.buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
