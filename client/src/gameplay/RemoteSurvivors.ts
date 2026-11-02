import * as THREE from 'three';
import { DOWNED, PLAYER, SKATEBOARD, SKATE_TRICKS, TRICK_DELAY, decodeAppearance, type Mirror, type SimPlayer, type Simulation, type SkateTrick, type Skateboard } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import { Humanoid, survivorLook, type SkatePose } from '../characters/Humanoid';
import { trickProgress, type BoardPose } from './Skateboards';
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

const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _aim = new THREE.Vector3(), _want = new THREE.Vector3();

/**
 * The other survivors in an online game: each one's own character in their own look, carrying
 * what they carry, moving where the server says (smoothed between snapshots), animated from
 * their reported movement and aim, with a name tag. They fall as ragdolls when they die.
 */
export class RemoteSurvivors {
  private readonly remotes = new Map<string, Remote>();
  private readonly tags = h('div', { class: 'name-tags' });
  private readonly beams: Beam[] = [];
  gore = true;

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
      ride: null, trickWait: null,
    };
    body.onFootstep = (l) => audio.footstep(l * 0.9, false, r.pos);
    weapon.onCue = (cue, w, inS) => audio.foley(cue, this.hand(r, _q), w, inS);
    return r;
  }

  private hand(r: Remote, out: THREE.Vector3): THREE.Vector3 {
    return r.body.armR.end.getWorldPosition(out);
  }

  update(dt: number, sim: Simulation, mirror: Mirror, camera: THREE.PerspectiveCamera): void {
    for (const p of sim.players.values()) {
      if (p.id === this.me) continue;
      let r = this.remotes.get(p.id);
      if (!r) {
        r = this.create(p);
        this.remotes.set(p.id, r);
      }
      this.animate(r, p, dt, mirror, camera, sim.skateboards.ridden(p.id));
    }
    for (const [id, r] of this.remotes) {
      if (sim.players.has(id)) continue;
      this.remotes.delete(id);
      this.free(r);
    }
    this.beams.length = 0;
    for (const r of this.remotes.values()) this.beams.push(r.beam);
    flashlight()?.placeRemotes(this.beams, camera.position, dt);
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

  private animate(r: Remote, p: SimPlayer, dt: number, mirror: Mirror, camera: THREE.PerspectiveCamera, deck: Skateboard | null): void {
    const b = r.body;
    const m = p.motion;
    if (!p.alive || !deck) r.ride = null;
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
    b.update(dt, {
      speed: ride ? 0 : hv, crouch: m.crouching ? 1 : 0, aim: m.aiming ? 1 : 0, grounded: m.grounded,
      strafe: ride ? 0 : strafe, moveAngle: ride ? 0 : moveAngle, turn: ride || dt <= 0 ? 0 : turned / dt,
    });
    // Where they are looking, far out: the arms and gun line up on it.
    const cp = Math.cos(m.pitch);
    _aim.set(r.pos.x - Math.sin(m.yaw) * cp * 30, r.pos.y + m.eyeHeight + Math.sin(m.pitch) * 30, r.pos.z - Math.cos(m.yaw) * cp * 30);
    r.weapon.update(dt, p.arsenal, { aim: p.arsenal.aim, sprinting: m.sprinting, aimPoint: _aim });
    this.light(r, p, dt, _aim, camera);
    r.probe.update(dt, r.pos, camera);
    this.placeTag(r, _q.copy(r.pos).setY(r.pos.y + (p.downed ? 0.8 : m.crouching ? PLAYER.crouchHeight : PLAYER.height) + 0.25), camera, p, false);
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
