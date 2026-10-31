import * as THREE from 'three';
import { DOWNED, PLAYER, decodeAppearance, type Mirror, type SimPlayer, type Simulation } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import { Humanoid, survivorLook } from '../characters/Humanoid';
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
      lamp, lightOn: null, beam: { origin: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), level: 0 },
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
      this.animate(r, p, dt, mirror, camera);
    }
    for (const [id, r] of this.remotes) {
      if (sim.players.has(id)) continue;
      this.remotes.delete(id);
      this.free(r);
    }
    this.beams.length = 0;
    for (const r of this.remotes.values()) this.beams.push(r.beam);
    flashlight()?.placeRemotes(this.beams, camera.position);
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

  private animate(r: Remote, p: SimPlayer, dt: number, mirror: Mirror, camera: THREE.PerspectiveCamera): void {
    const b = r.body;
    const m = p.motion;
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
    b.update(dt, {
      speed: hv, crouch: m.crouching ? 1 : 0, aim: m.aiming ? 1 : 0, grounded: m.grounded, strafe, moveAngle,
      turn: dt > 0 ? turned / dt : 0,
    });
    // Where they are looking, far out: the arms and gun line up on it.
    const cp = Math.cos(m.pitch);
    _aim.set(r.pos.x - Math.sin(m.yaw) * cp * 30, r.pos.y + m.eyeHeight + Math.sin(m.pitch) * 30, r.pos.z - Math.cos(m.yaw) * cp * 30);
    r.weapon.update(dt, p.arsenal, { aim: p.arsenal.aim, sprinting: m.sprinting, aimPoint: _aim });
    this.light(r, p, dt, _aim, camera);
    r.probe.update(dt, r.pos, camera);
    this.placeTag(r, _q.copy(r.pos).setY(r.pos.y + (p.downed ? 0.8 : m.crouching ? PLAYER.crouchHeight : PLAYER.height) + 0.25), camera, p, false);
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
