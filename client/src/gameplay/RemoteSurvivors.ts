import * as THREE from 'three';
import { BICYCLE, DOWNED, PLAYER, SKATEBOARD, SKATE_TRICKS, TRICK_DELAY, VEHICLE, decodeAppearance, type Bicycle, type Mirror, type SimPlayer, type Simulation, type SkateTrick, type Skateboard } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import { Humanoid, survivorLook, type BikeRig, type SeatPose, type SkatePose } from '../characters/Humanoid';
import { trickProgress, type BoardPose } from './Skateboards';
import { barAngle, type BikePose } from './Bicycles';
import { Ragdoll, ZONE_PARTICLES } from '../characters/Ragdoll';
import { PlayerWeapon } from '../weapons/PlayerWeapon';
import { DynamicProbe } from '../lighting/Probes';
import type { LightField } from '../lighting/LightField';
import { audio } from '../audio/AudioEngine';
import { ChestLamp, flashlight, type Beam } from './Flashlight';
import { h } from '../ui/dom';

interface Remote {
  id: string;
  body: Humanoid;
  weapon: PlayerWeapon;
  probe: DynamicProbe;
  pos: THREE.Vector3;
  facing: number;
  ragdoll: Ragdoll | null;
  tag: HTMLElement;
  tagHp: HTMLElement;
  /** Direction the last hit came from (the fall goes the other way). */
  hurtDir: THREE.Vector3;
  downed: boolean;
  /** Their flashlight, the switch as last reported (null before the first report), and its beam. */
  lamp: ChestLamp;
  lightOn: boolean | null;
  beam: Beam;
  /** On a skateboard: the deck as drawn (yaw eased between snapshots, the kick run here), else null. */
  ride: RemoteRide | null;
  /** A flip trick the server said they popped, waiting (seconds left) for them to leave the ground. */
  trickWait: { kind: SkateTrick; t: number } | null;
  /** In a vehicle: the seat pose (hips the way the seat faces). */
  seat: SeatPose;
  /**
   * On a bicycle, in the saddle or on the pegs: the bike as drawn (its heading eased between
   * snapshots, the lean, bars and cranks worked out here from how they move), else null.
   */
  cycle: Cycling | null;
  /** Lying prone and diving as last drawn (their sounds play on the changes), and whether the dive has come down. */
  prone: boolean;
  diving: boolean;
  diveDown: boolean;
}

interface RemoteRide {
  yaw: number;
  lean: number;
  push: number;
  pop: number;
  air: boolean;
  /** The flip trick in the air and seconds since its pop (-1 none). */
  trick: SkateTrick | null;
  trickT: number;
  pose: SkatePose;
  board: BoardPose;
}

interface Cycling {
  seat: 'rider' | 'peg';
  yaw: number;
  lean: number;
  steer: number;
  crank: number;
  stand: number;
  /** Smoothed speed and slowing (m/s, m/s²): hard slowing at speed is the brakes. */
  speed: number;
  slowing: number;
  rig: BikeRig;
  pose: BikePose;
}

const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _aim = new THREE.Vector3(), _want = new THREE.Vector3();
const _wl = new THREE.Vector3(), _wr = new THREE.Vector3();
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Where vehicles' seats and steering wheels are drawn (the session's VehicleView). */
export interface SeatSource {
  seatPoint(id: number, seat: number, out: THREE.Vector3): number | null;
  wheelPoints(id: number, left: THREE.Vector3, right: THREE.Vector3): boolean;
  seatDrop(id: number, seat: number): number;
  /** Whether that seat is stood in (a roof gun's hatch), and where its gun's grips are. */
  stands(id: number, seat: number): boolean;
  turretGrips(id: number, left: THREE.Vector3, right: THREE.Vector3): boolean;
}

/**
 * The other survivors in an online game: each one's own character in their own look, carrying
 * what they carry, moving where the server says (smoothed between snapshots), animated from
 * their reported movement and aim, with a name tag. They fall as ragdolls when they die.
 */
export class RemoteSurvivors {
  private readonly remotes = new Map<string, Remote>();
  private readonly tags = h('div', { class: 'name-tags' });
  /** Their lamps' beams this frame (the session hands them to the flashlight pool with the headlights). */
  readonly beams: Beam[] = [];
  gore = true;
  /** Where survivors sitting in vehicles go. */
  seats: SeatSource | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly physics: Physics,
    private readonly field: LightField,
    ui: HTMLElement,
    private readonly me: string,
  ) {
    ui.append(this.tags);
  }

  private create(p: SimPlayer): Remote {
    const body = new Humanoid(survivorLook(decodeAppearance(p.appearance)));
    body.weathering = true;
    this.scene.add(body.root);
    const probe = new DynamicProbe(this.field);
    probe.attach(body.surfaces());
    const weapon = new PlayerWeapon(this.scene, body);
    probe.attach(weapon.materials());
    weapon.onMaterials = (m) => probe.attach(m);
    weapon.gore = this.gore;
    const lamp = new ChestLamp(body);
    probe.attach(lamp.materials());
    const tagHp = h('i');
    const tag = h('div', { class: 'name-tag' }, h('span', {}, p.name.toUpperCase()), h('b', {}, tagHp));
    this.tags.append(tag);
    const m = p.motion;
    const r: Remote = {
      id: p.id, body, weapon, probe, pos: new THREE.Vector3(m.pos.x, m.pos.y, m.pos.z), facing: m.yaw + Math.PI,
      ragdoll: null, tag, tagHp, hurtDir: new THREE.Vector3(0, 0, 1), downed: false,
      lamp, lightOn: null, beam: { origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), level: 0, dim: 1 },
      ride: null, trickWait: null, seat: { yaw: 0, drop: 0.5 },
      cycle: null,
      prone: !!m.prone, diving: !!m.diving, diveDown: false,
    };
    body.onFootstep = (l) => audio.footstep(l * 0.9, false, r.pos);
    weapon.onCue = (cue, w, inS) => audio.foley(cue, this.hand(r, _q), w, inS);
    return r;
  }

  private hand(r: Remote, out: THREE.Vector3): THREE.Vector3 {
    return r.body.armR.end.getWorldPosition(out);
  }

  /** Where the others press the grass down (x, y, z, radius), standing or fallen. */
  feet(out: (x: number, y: number, z: number, r: number) => void): void {
    for (const r of this.remotes.values()) {
      if (r.ragdoll) {
        r.ragdoll.center(_p);
        out(_p.x, r.ragdoll.floorY, _p.z, 0.95);
      } else out(r.pos.x, r.pos.y, r.pos.z, 0.55);
    }
  }

  /** `myBike`: the bike this survivor rides as drawn (whoever is on its pegs stands on it). */
  update(dt: number, sim: Simulation, mirror: Mirror, camera: THREE.PerspectiveCamera, myBike: BikePose | null = null): void {
    // Passengers last: they stand on the pegs of the bike as drawn this frame.
    const pegs: [Remote, SimPlayer, Bicycle][] = [];
    for (const p of sim.players.values()) {
      if (p.id === this.me) continue;
      let r = this.remotes.get(p.id);
      if (!r) {
        r = this.create(p);
        this.remotes.set(p.id, r);
      }
      const seat = sim.vehicles.seatOf(p.id);
      if (seat && this.seated(r, p, dt, camera, seat[0].id, seat[1])) continue;
      const carried = p.alive ? sim.bicycles.carrying(p.id) : null;
      if (carried) pegs.push([r, p, carried]);
      else this.animate(r, p, dt, mirror, camera, sim.skateboards.ridden(p.id), p.alive ? sim.bicycles.ridden(p.id) : null, null);
    }
    for (const [r, p, b] of pegs) {
      const under = !b.rider ? null : b.rider === this.me ? myBike : this.bikePose(b.rider);
      this.animate(r, p, dt, mirror, camera, null, null, under);
    }
    for (const [id, r] of this.remotes) {
      if (sim.players.has(id)) continue;
      this.remotes.delete(id);
      this.free(r);
    }
    this.beams.length = 0;
    for (const r of this.remotes.values()) this.beams.push(r.beam);
  }

  /**
   * Someone sitting in a vehicle: on its seat as the vehicle is drawn, the hips the way the seat
   * faces; at the wheel their hands are on it and they look down the road, a passenger turns to
   * aim out of the windows. False when the vehicle can't be drawn (then they're drawn as usual).
   */
  private seated(r: Remote, p: SimPlayer, dt: number, camera: THREE.PerspectiveCamera, vehicle: number, seat: number): boolean {
    if (!p.alive || !this.seats) return false;
    const yaw = this.seats.seatPoint(vehicle, seat, r.pos);
    if (yaw === null) return false;
    const b = r.body;
    const m = p.motion;
    r.ride = null;
    b.skate = null;
    if (r.cycle) b.root.rotation.z = 0;
    r.cycle = null;
    b.bike = null;
    const ahead = yaw + Math.PI / 2;
    const driver = seat === 0;
    // At a roof gun they stand in the hatch and turn with it, both hands on its grips.
    const stand = this.seats.stands(vehicle, seat);
    const facing = stand ? m.yaw + Math.PI : driver || !m.aiming ? ahead : m.yaw + Math.PI;
    r.facing += wrap(facing - r.facing) * (1 - Math.exp(-dt * 14));
    b.root.position.copy(r.pos);
    if (!stand) b.root.position.y -= 0.88;
    b.root.rotation.y = r.facing;
    r.seat.yaw = wrap(ahead - r.facing);
    r.seat.drop = this.seats.seatDrop(vehicle, seat);
    b.seat = stand ? null : r.seat;
    if (r.downed) {
      r.downed = false;
      b.downTarget = 0;
      r.weapon.setVisible(true);
    }
    b.lookPitch += ((m.aiming ? m.pitch : m.pitch * 0.35) - b.lookPitch) * (1 - Math.exp(-dt * 12));
    b.update(dt, { speed: 0, crouch: 0, aim: m.aiming && !driver ? 1 : 0, grounded: true, strafe: 0, moveAngle: 0, turn: 0 });
    const cp = Math.cos(m.pitch);
    const eye = r.pos.y + (stand ? PLAYER.eyeHeight : VEHICLE.seatEye);
    _aim.set(r.pos.x - Math.sin(m.yaw) * cp * 30, eye + Math.sin(m.pitch) * 30, r.pos.z - Math.cos(m.yaw) * cp * 30);
    const wheel = (driver && this.seats.wheelPoints(vehicle, _wl, _wr)) || (stand && this.seats.turretGrips(vehicle, _wl, _wr)) ? { left: _wl, right: _wr } : null;
    r.weapon.update(dt, p.arsenal, { aim: wheel ? 0 : p.arsenal.aim, sprinting: false, aimPoint: _aim, wheel });
    this.light(r, p, dt, _aim, camera);
    r.probe.update(dt, r.pos, camera);
    this.placeTag(r, _q.copy(r.pos).setY(eye + 0.45), camera, p, false);
    return true;
  }

  /**
   * Their lamp: on while they say it is and they live, aimed where they look (`aimPoint`), with
   * the click heard when they flip it nearby.
   */
  private light(r: Remote, p: SimPlayer, dt: number, aimPoint: THREE.Vector3 | null, camera: THREE.PerspectiveCamera): void {
    const on = !!p.motion.light;
    if (r.lightOn !== null && on !== r.lightOn && p.alive) {
      const at = r.lamp.origin(_q);
      if (at.distanceTo(camera.position) < 18) audio.flashlight(on, at);
    }
    r.lightOn = on;
    const b = r.beam;
    b.level = on && p.alive ? 1 : Math.max(0, b.level - dt * 6);
    if (aimPoint) {
      _want.subVectors(aimPoint, r.lamp.origin(_q));
      if (_want.lengthSq() > 1e-4) b.dir.copy(r.lamp.follow(_want.normalize(), dt));
    }
    r.lamp.source(b.origin);
    r.lamp.show(b.level, camera);
  }

  /**
   * `bike`: the one they pedal; `pegs`: the drawn bike whose pegs they stand on (their feet go
   * there whatever the last snapshot said, so they never trail behind it).
   */
  private animate(r: Remote, p: SimPlayer, dt: number, mirror: Mirror, camera: THREE.PerspectiveCamera, deck: Skateboard | null, bike: Bicycle | null, pegs: BikePose | null): void {
    const b = r.body;
    const m = p.motion;
    b.seat = null;
    if (!p.alive || !deck) r.ride = null;
    if (!p.alive || (!bike && !pegs)) {
      if (r.cycle) b.root.rotation.z = 0;
      r.cycle = null;
    }
    // Brought back by a lull: up off the ground where the server put them.
    if (p.alive && r.ragdoll) {
      r.ragdoll = null;
      b.resetPose();
      r.downed = false;
      r.weapon.setVisible(true);
      mirror.playerPose(p.id, _p);
      r.pos.set(_p.x, _p.y, _p.z);
    }
    if (!p.alive) {
      if (!r.ragdoll) this.fall(r, p);
      if (!r.ragdoll!.asleep) r.ragdoll!.update(dt);
      r.probe.update(dt, r.ragdoll!.center(_p), camera);
      this.placeTag(r, r.ragdoll!.center(_p).setY(r.ragdoll!.floorY + 0.6), camera, p, true);
      this.light(r, p, dt, null, camera);
      return;
    }
    const facing = mirror.playerPose(p.id, _p) ?? m.yaw + Math.PI;
    r.pos.set(_p.x, _p.y, _p.z);
    if (pegs) {
      r.pos.set(pegs.pos.x - Math.sin(pegs.yaw) * BICYCLE.pegBack, pegs.pos.y + BICYCLE.pegHeight, pegs.pos.z - Math.cos(pegs.yaw) * BICYCLE.pegBack);
    }
    const diff = Math.atan2(Math.sin(facing - r.facing), Math.cos(facing - r.facing));
    const turned = diff * (1 - Math.exp(-dt * 14));
    r.facing += turned;
    b.root.position.copy(r.pos);
    b.root.rotation.y = r.facing;
    const hv = Math.hypot(m.vel.x, m.vel.z);
    const rx = Math.cos(r.facing), rz = -Math.sin(r.facing);
    const strafe = hv > 0.1 ? (m.vel.x * rx + m.vel.z * rz) / hv : 0;
    const travel = Math.atan2(m.vel.x, m.vel.z) - r.facing;
    const moveAngle = hv > 0.3 ? Math.atan2(Math.sin(travel), Math.cos(travel)) : 0;
    b.lookPitch += ((m.aiming ? m.pitch : m.pitch * 0.35) - b.lookPitch) * (1 - Math.exp(-dt * 12));
    // Downed: on their back with the gun gone from their hands until someone gets them up.
    if (r.downed !== p.downed) {
      r.downed = p.downed;
      b.downTarget = p.downed ? 1 : 0;
      r.weapon.setVisible(!p.downed);
    }
    const ride = deck ? this.skate(r, deck, m, dt) : null;
    b.skate = ride ? ride.pose : null;
    b.vault = m.vaulting && !p.downed ? 1 : 0;
    const cyc = bike ? this.pedal(r, bike, m, dt) : pegs ? this.standOn(r, pegs) : null;
    b.bike = cyc ? cyc.rig : null;
    // The whole body leans with the bike (about the tyres' line); on the pegs, high over the street, that swings it out sideways.
    b.root.rotation.order = 'YXZ';
    b.root.rotation.z = cyc ? -cyc.lean : 0;
    if (cyc && pegs) {
      const k = Math.sin(cyc.lean) * BICYCLE.pegHeight;
      b.root.position.x += Math.cos(cyc.yaw) * k;
      b.root.position.z -= Math.sin(cyc.yaw) * k;
    }
    const still = !!ride || !!cyc;
    this.stance(r, p);
    b.update(dt, {
      speed: still ? 0 : hv, crouch: m.crouching ? 1 : 0, aim: m.aiming ? 1 : 0, grounded: m.grounded || !!pegs,
      strafe: still ? 0 : strafe, moveAngle: still ? 0 : moveAngle, turn: still || dt <= 0 ? 0 : turned / dt,
    });
    // Where they are looking, far out: the arms and gun line up on it.
    const cp = Math.cos(m.pitch);
    _aim.set(r.pos.x - Math.sin(m.yaw) * cp * 30, r.pos.y + m.eyeHeight + Math.sin(m.pitch) * 30, r.pos.z - Math.cos(m.yaw) * cp * 30);
    r.weapon.update(dt, p.arsenal, { aim: p.arsenal.aim, sprinting: m.sprinting, aimPoint: _aim });
    this.light(r, p, dt, _aim, camera);
    r.probe.update(dt, r.pos, camera);
    this.placeTag(r, _q.copy(r.pos).setY(r.pos.y + (p.downed || m.prone ? 0.8 : m.crouching ? PLAYER.crouchHeight : PLAYER.height) + 0.25), camera, p, false);
  }

  /**
   * Lying prone or diving, as they report it: the body goes down (held up off the ground while a
   * dive is in the air), and the dive, the landing, getting down and up are heard where they are.
   */
  private stance(r: Remote, p: SimPlayer): void {
    const b = r.body;
    const m = p.motion;
    const prone = !!m.prone && !p.downed;
    const diving = !!m.diving && !p.downed;
    b.prone = prone || diving ? 1 : 0;
    b.dive = diving && !m.grounded && !m.prone ? 1 : 0;
    const a = p.arsenal.action;
    b.rise = a === 'melee' || a === 'throw' || a === 'bandage' || a === 'inject' ? 1 : 0;
    if (diving && !r.diving) {
      r.diveDown = false;
      audio.stance('leap', r.pos);
    }
    if (diving && !r.diveDown && (m.grounded || m.prone)) {
      r.diveDown = true;
      audio.stance('land', r.pos);
    }
    if (!diving && !r.diving) {
      if (prone && !r.prone) audio.stance('down', r.pos);
      else if (!prone && r.prone && !p.downed) audio.stance('up', r.pos);
    }
    r.prone = prone;
    r.diving = diving;
  }

  /**
   * Their skateboard: the deck turns toward the heading the server last gave (smoothly, between
   * snapshots), leans with how fast it turns, pops up when they leave the ground, and their back
   * foot kicks along while they say they are pushing.
   */
  private skate(r: Remote, deck: Skateboard, m: SimPlayer['motion'], dt: number): RemoteRide {
    let s = r.ride;
    if (!s) {
      s = {
        yaw: deck.yaw, lean: 0, push: -1, pop: -1, air: false, trick: null, trickT: -1,
        pose: { yaw: 0, deck: SKATEBOARD.deck, push: -1, lean: 0, air: false, low: false, trickU: -1, flip: 0, spin: 0 },
        board: { pos: new THREE.Vector3(), yaw: deck.yaw, lean: 0, pop: -1, air: false, push: -1, trick: null, trickU: -1, toe: 1 },
      };
      r.ride = s;
    }
    const diff = Math.atan2(Math.sin(deck.yaw - s.yaw), Math.cos(deck.yaw - s.yaw));
    const turn = diff * (1 - Math.exp(-dt * 12));
    s.yaw += turn;
    const rate = dt > 0 ? turn / dt : 0;
    s.lean += (THREE.MathUtils.clamp(rate / 1.6, -1, 1) - s.lean) * (1 - Math.exp(-dt * 6));
    if (s.push >= 0 || m.pushing) {
      s.push += dt / SKATEBOARD.pushPeriod;
      if (s.push >= 1) s.push = m.pushing ? 0 : -1;
    }
    const air = !m.grounded;
    if (air && !s.air) s.pop = 0;
    else if (s.pop >= 0) s.pop = s.pop + dt > 0.7 ? -1 : s.pop + dt;
    s.air = air;
    // A flip trick the server told of starts with their pop (it usually comes before their jump
    // shows: they are drawn a moment behind), or at once, as far through, if they already left the ground.
    const w = r.trickWait;
    if (w) {
      w.t -= dt;
      if (air && s.pop >= 0 && s.pop < 0.3) {
        s.trick = w.kind;
        s.trickT = s.pop;
        r.trickWait = null;
      } else if (w.t <= 0) r.trickWait = null;
    }
    if (s.trick) {
      s.trickT += dt * (!air && s.trickT > TRICK_DELAY + 0.06 ? 5 : 1);
      if (s.trickT >= TRICK_DELAY + SKATE_TRICKS[s.trick].time) {
        s.trick = null;
        s.trickT = -1;
      }
    }
    const trickU = trickProgress(s.trick, s.trickT);
    const T = s.trick ? SKATE_TRICKS[s.trick] : null;
    const pose = s.pose;
    pose.yaw = Math.atan2(Math.sin(s.yaw - r.facing), Math.cos(s.yaw - r.facing));
    pose.push = s.push;
    pose.lean = s.lean;
    pose.air = air;
    pose.low = m.crouching;
    pose.trickU = trickU;
    pose.flip = T ? T.flip : 0;
    pose.spin = T ? T.spin : 0;
    const bp = s.board;
    bp.pos.copy(r.pos);
    bp.yaw = s.yaw;
    bp.lean = s.lean;
    bp.pop = s.pop;
    bp.air = air;
    bp.push = s.push;
    bp.trick = s.trick;
    bp.trickU = trickU;
    bp.toe = r.body.skateToe;
    return s;
  }

  /** The server says this survivor popped a flip trick: it plays as they leave the ground. */
  trick(id: string, kind: SkateTrick): void {
    const r = this.remotes.get(id);
    if (r) r.trickWait = { kind, t: 0.8 };
  }

  /**
   * Their bicycle: the heading eases toward the one the server last gave, the lean is what a real
   * bike needs for how fast it turns at that speed, the bars turn by how hard it turns, the cranks
   * go round while they say they pedal (level when coasting), and hard slowing at speed is braking.
   */
  private pedal(r: Remote, bike: Bicycle, m: SimPlayer['motion'], dt: number): Cycling {
    const S = BICYCLE;
    let c = r.cycle;
    if (!c || c.seat !== 'rider') {
      c = {
        seat: 'rider', yaw: bike.yaw, lean: 0, steer: 0, crank: Math.PI / 2, stand: 0, speed: 0, slowing: 0,
        rig: { seat: 'rider', yaw: 0, crank: Math.PI / 2, stand: 0, steer: 0 },
        pose: { pos: new THREE.Vector3(), yaw: bike.yaw, lean: 0, steer: 0, crank: Math.PI / 2, pedalling: false, brake: 0, air: false },
      };
      r.cycle = c;
    }
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const diff = Math.atan2(Math.sin(bike.yaw - c.yaw), Math.cos(bike.yaw - c.yaw));
    const turn = diff * k(12);
    c.yaw += turn;
    const rate = dt > 0 ? turn / dt : 0;
    const v = Math.hypot(m.vel.x, m.vel.z);
    if (dt > 0) c.slowing += (Math.max(0, (c.speed - v) / dt) - c.slowing) * k(5);
    c.speed += (v - c.speed) * k(10);
    const leanTo = m.grounded ? THREE.MathUtils.clamp(Math.atan((c.speed * rate) / 9.8), -S.maxLean, S.maxLean) : c.lean * 0.9;
    c.lean += (leanTo - c.lean) * k(6);
    const full = c.speed < 1 ? THREE.MathUtils.lerp(S.turnStill, S.turnSlow, c.speed) : THREE.MathUtils.lerp(S.turnSlow, S.turnFast, THREE.MathUtils.smoothstep(c.speed, 2, 11));
    c.steer += (THREE.MathUtils.clamp(rate / full, -1, 1) - c.steer) * k(7);
    if (m.pushing) c.crank += Math.max(c.speed / S.wheel / S.gear, S.minCadence) * dt;
    else {
      const level = Math.round((c.crank - Math.PI / 2) / Math.PI) * Math.PI + Math.PI / 2;
      c.crank += (level - c.crank) * k(5);
    }
    // Out of the saddle near the top of a sprint.
    c.stand += ((m.pushing && c.speed > S.pedalTop * 0.9 ? 1 : 0) - c.stand) * k(4);
    const rig = c.rig;
    rig.seat = 'rider';
    rig.yaw = Math.atan2(Math.sin(c.yaw - r.facing), Math.cos(c.yaw - r.facing));
    rig.crank = c.crank;
    rig.stand = c.stand;
    rig.steer = barAngle(c.steer, c.speed);
    const o = c.pose;
    o.pos.copy(r.pos);
    o.yaw = c.yaw;
    o.lean = c.lean;
    o.steer = rig.steer;
    o.crank = c.crank;
    o.pedalling = !!m.pushing;
    o.brake = c.speed > 1 ? THREE.MathUtils.clamp((c.slowing - 1) / (S.brake - 1), 0, 1) : 0;
    o.air = !m.grounded;
    return c;
  }

  /** On someone's pegs: the feet stay on them, the bike's way and lean are the drawn bike's. */
  private standOn(r: Remote, under: BikePose): Cycling {
    let c = r.cycle;
    if (!c || c.seat !== 'peg') {
      c = {
        seat: 'peg', yaw: under.yaw, lean: 0, steer: 0, crank: 0, stand: 0, speed: 0, slowing: 0,
        rig: { seat: 'peg', yaw: 0, crank: 0, stand: 0, steer: 0 },
        pose: { pos: new THREE.Vector3(), yaw: under.yaw, lean: 0, steer: 0, crank: 0, pedalling: false, brake: 0, air: false },
      };
      r.cycle = c;
    }
    c.yaw = under.yaw;
    c.lean = under.lean;
    c.rig.seat = 'peg';
    c.rig.yaw = Math.atan2(Math.sin(under.yaw - r.facing), Math.cos(under.yaw - r.facing));
    return c;
  }

  /** Where another survivor's bike is drawn (under them, in the saddle), or null when they aren't pedalling one. */
  bikePose(id: string): BikePose | null {
    const r = this.remotes.get(id);
    if (!r || r.ragdoll || r.cycle?.seat !== 'rider') return null;
    return r.cycle.pose;
  }

  /**
   * Where another survivor's bike will be drawn this frame: where the mirror has them at its time
   * now (the frame's survivors are drawn from the same time), the way and lean as last drawn.
   */
  bikeNow(id: string, mirror: Mirror, out: BikePose): BikePose | null {
    const r = this.remotes.get(id);
    const c = r?.cycle;
    if (!r || r.ragdoll || !c || c.seat !== 'rider') return null;
    if (mirror.playerPose(id, out.pos) === null) out.pos.copy(r.pos);
    const o = c.pose;
    out.yaw = o.yaw;
    out.lean = o.lean;
    out.steer = o.steer;
    out.crank = o.crank;
    out.pedalling = o.pedalling;
    out.brake = o.brake;
    out.air = o.air;
    return out;
  }

  /** Where another survivor's board is drawn (under their feet), or null when they aren't riding one. */
  boardPose(id: string, deck: Skateboard): BoardPose | null {
    const r = this.remotes.get(id);
    if (!r || r.ragdoll || !r.ride) return null;
    void deck;
    return r.ride.board;
  }

  /** Name and health over their head (seen through walls: they are on your side). */
  private placeTag(r: Remote, at: THREE.Vector3, camera: THREE.PerspectiveCamera, p: SimPlayer, down: boolean): void {
    const dist = at.distanceTo(camera.position);
    const v = at.project(camera);
    // A downed teammate is shown farther out: they need finding.
    const show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 && dist < (p.downed ? 160 : 70);
    r.tag.style.display = show ? '' : 'none';
    if (!show) return;
    r.tag.style.transform = `translate(${((v.x + 1) / 2) * window.innerWidth}px, ${((1 - v.y) / 2) * window.innerHeight}px) translate(-50%, -100%)`;
    r.tag.style.opacity = String(THREE.MathUtils.clamp(1.4 - dist / 50, 0.35, 1));
    r.tag.classList.toggle('down', down);
    r.tag.classList.toggle('downed', p.downed);
    r.tag.classList.toggle('reviving', p.downed && !!p.reviver);
    // Downed, the bar is how long they have left (or how far along the revive is).
    const k = p.downed ? (p.reviver ? p.revive / DOWNED.reviveTime : p.bleed / DOWNED.bleedOut) : p.health / PLAYER.maxHealth;
    r.tagHp.style.width = `${Math.max(0, Math.min(100, Math.round(k * 100)))}%`;
    if (p.downed) r.tag.style.opacity = '1';
  }

  private fall(r: Remote, p: SimPlayer): void {
    r.weapon.setVisible(false);
    const rag = new Ragdoll(this.physics, r.body);
    const v = new THREE.Vector3(p.motion.vel.x, 0, p.motion.vel.z);
    rag.start(v, [{ joints: ZONE_PARTICLES.torso, impulse: r.hurtDir.clone().setY(0.2).multiplyScalar(1.6) }]);
    r.ragdoll = rag;
  }

  /** Muzzle of a survivor's gun (their hand when nothing is out). */
  muzzle(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    return r ? r.weapon.muzzleWorld(out) : null;
  }

  muzzleDir(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    return r ? r.weapon.muzzleDir(out) : null;
  }

  handOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    return r ? this.hand(r, out) : null;
  }

  weaponOf(id: string): PlayerWeapon | null {
    return this.remotes.get(id)?.weapon ?? null;
  }

  bodyOf(id: string): Humanoid | null {
    return this.remotes.get(id)?.body ?? null;
  }

  /** Where a survivor is drawn (sound of their actions). */
  positionOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    return r ? out.copy(r.pos).setY(r.pos.y + 1.2) : null;
  }

  /** Lights the name tag while they speak (radio in another color). */
  speaking(id: string, on: boolean, radio: boolean): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.tag.classList.toggle('speaking', on);
    r.tag.classList.toggle('radio', on && radio);
  }

  /** Where their mouth is (alive) or null. */
  mouthOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const r = this.remotes.get(id);
    if (!r || r.ragdoll) return null;
    return out.copy(r.pos).setY(r.pos.y + PLAYER.height - 0.12);
  }

  hurt(id: string, from: THREE.Vector3, amount: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    const d = _p.subVectors(r.pos, from).setY(0);
    if (d.lengthSq() < 1e-6) return;
    d.normalize();
    r.hurtDir.copy(d);
    r.body.flinch('torso', d.x, d.z, Math.min(1, amount / 25));
    r.body.splatter(Math.min(0.12, amount * 0.004));
  }

  setGore(on: boolean): void {
    this.gore = on;
    for (const r of this.remotes.values()) r.weapon.gore = on;
  }

  private free(r: Remote): void {
    r.lamp.dispose();
    r.weapon.dispose();
    r.body.root.removeFromParent();
    r.body.dispose();
    r.tag.remove();
  }

  dispose(): void {
    for (const r of this.remotes.values()) this.free(r);
    this.remotes.clear();
    flashlight()?.placeRemotes([], new THREE.Vector3());
    this.tags.remove();
  }
}
