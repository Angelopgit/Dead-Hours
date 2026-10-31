import * as THREE from 'three';
import { GROUP, RAID, decodeAppearance, groups, type HitZone, type Raider, type Simulation } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import { Humanoid, survivorLook } from '../characters/Humanoid';
import { Ragdoll, ZONE_PARTICLES } from '../characters/Ragdoll';
import { PlayerWeapon } from '../weapons/PlayerWeapon';
import { DynamicProbe } from '../lighting/Probes';
import type { LightField } from '../lighting/LightField';
import { audio } from '../audio/AudioEngine';

interface RaiderBody {
  id: string;
  body: Humanoid;
  weapon: PlayerWeapon;
  probe: DynamicProbe;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  facing: number;
  ragdoll: Ragdoll | null;
  deadT: number;
}

const CORPSE_TIME = 90;
/** Ground under the van (not the van itself). */
const STATIC_ONLY = groups(0xffff, GROUP.static);
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _aim = new THREE.Vector3();

/** The white van: a boxy panel van built from parts, local +Z forward, origin on the ground. */
function buildVan(): { root: THREE.Group; door: THREE.Object3D; wheels: THREE.Object3D[]; materials: THREE.Material[]; lights: THREE.MeshStandardMaterial } {
  const V = RAID.van;
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xc4c3bd, roughness: 0.62, metalness: 0.12 });
  const grime = new THREE.MeshStandardMaterial({ color: 0x8d8b84, roughness: 0.9, metalness: 0.05 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0e1215, roughness: 0.08, metalness: 0.7 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.7, metalness: 0.1 });
  const tire = new THREE.MeshStandardMaterial({ color: 0x0f0f10, roughness: 0.95 });
  const hub = new THREE.MeshStandardMaterial({ color: 0x9a9da2, roughness: 0.4, metalness: 0.7 });
  const lights = new THREE.MeshStandardMaterial({ color: 0xfff4d8, emissive: 0xfff0c8, emissiveIntensity: 2.4, roughness: 0.2 });
  const tail = new THREE.MeshStandardMaterial({ color: 0x5a0606, emissive: 0xff1a10, emissiveIntensity: 1.6, roughness: 0.3 });
  const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = root) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const W = V.width, L = V.length, H = V.height;
  const floor = 0.42;
  const back = -L / 2, front = L / 2;
  const cabZ = front - 1.05;
  // Cargo box and cab roof, the hood, the bumper and the rocker panels.
  box(W, H - floor, cabZ - back, paint, 0, floor + (H - floor) / 2, (back + cabZ) / 2);
  box(W - 0.04, 0.62, front - cabZ, paint, 0, floor + 0.31, (cabZ + front) / 2 - 0.02);
  box(W + 0.02, 0.22, 0.16, trim, 0, floor + 0.05, front - 0.02);
  box(W + 0.02, 0.22, 0.14, trim, 0, floor + 0.05, back + 0.03);
  box(W + 0.03, 0.14, L - 0.3, grime, 0, floor + 0.05, 0);
  // Raked windscreen between the hood and the roof.
  const ws = box(W - 0.12, 1.06, 0.06, glass, 0, floor + 0.62 + 0.46, cabZ + 0.36);
  ws.rotation.x = -0.62;
  // Cab side windows, a small rear pair, the rear door seam.
  for (const sx of [-1, 1]) {
    box(0.04, 0.56, 0.9, glass, sx * (W / 2 + 0.005), floor + 1.18, cabZ - 0.42);
    box(0.03, 0.04, 1.2, trim, sx * (W / 2 + 0.01), floor + 0.8, cabZ - 0.5);
  }
  box(0.02, H - floor - 0.3, 0.03, trim, 0, floor + (H - floor) / 2, back - 0.01);
  for (const sx of [-1, 1]) box(0.72, 0.44, 0.03, glass, sx * 0.44, floor + 1.25, back - 0.012);
  // Lamps.
  for (const sx of [-1, 1]) {
    box(0.34, 0.16, 0.04, lights, sx * (W / 2 - 0.3), floor + 0.48, front + 0.005);
    box(0.12, 0.42, 0.04, tail, sx * (W / 2 - 0.1), floor + 0.9, back - 0.012);
  }
  // Sliding side door on the right (-X when facing +Z): slides back along the body when open.
  const door = new THREE.Group();
  root.add(door);
  box(0.05, H - floor - 0.22, 1.25, paint, 0, floor + (H - floor - 0.22) / 2 + 0.06, 0, door);
  box(0.03, 0.44, 0.8, glass, -0.02, floor + 1.3, 0, door);
  box(0.035, H - floor - 0.25, 0.03, trim, 0, floor + (H - floor) / 2, 0.64, door);
  door.position.set(-(W / 2 + 0.01), 0, RAID.van.door.z);
  // Wheels.
  const wheels: THREE.Object3D[] = [];
  const tg = new THREE.CylinderGeometry(0.37, 0.37, 0.26, 18);
  tg.rotateZ(Math.PI / 2);
  const hg = new THREE.CylinderGeometry(0.21, 0.21, 0.27, 10);
  hg.rotateZ(Math.PI / 2);
  for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const w = new THREE.Group();
    w.position.set(x * (W / 2 - 0.18), 0.37, z * (L / 2 - 0.95));
    const t = new THREE.Mesh(tg, tire);
    t.castShadow = true;
    w.add(t, new THREE.Mesh(hg, hub));
    root.add(w);
    wheels.push(w);
  }
  return { root, door, wheels, materials: [paint, grime, glass, trim, tire, hub, tail], lights };
}

/**
 * The van raid on screen: the white van driving in and parked (its side door sliding open as
 * the crew gets out), and each raider as a survivor-built character in their gear, carrying
 * their gun, moving where the simulation says. They fall as ragdolls and lie there a while.
 */
export class RaidView {
  private readonly bodies = new Map<string, RaiderBody>();
  private readonly corpses: RaiderBody[] = [];
  private van: ReturnType<typeof buildVan> | null = null;
  private vanProbe: DynamicProbe | null = null;
  private readonly vanPos = new THREE.Vector3();
  private vanYaw = 0;
  private doorOpen = 0;
  private roll = 0;
  gore = true;

  constructor(private readonly scene: THREE.Scene, private readonly physics: Physics, private readonly field: LightField) {}

  private create(r: Raider): RaiderBody {
    const body = new Humanoid(survivorLook(decodeAppearance(r.appearance)));
    this.scene.add(body.root);
    const probe = new DynamicProbe(this.field);
    probe.attach(body.surfaces());
    const weapon = new PlayerWeapon(this.scene, body);
    probe.attach(weapon.materials());
    weapon.onMaterials = (m) => probe.attach(m);
    weapon.gore = this.gore;
    const v: RaiderBody = {
      id: r.id, body, weapon, probe, pos: new THREE.Vector3(r.pos.x, r.pos.y, r.pos.z), vel: new THREE.Vector3(), facing: r.facing, ragdoll: null, deadT: 0,
    };
    body.onFootstep = (l) => audio.footstep(l, false, v.pos);
    weapon.onCue = (cue, w, inS) => audio.foley(cue, body.armR.end.getWorldPosition(_q), w, inS);
    return v;
  }

  update(dt: number, sim: Simulation, renderTime: number, camera: THREE.Camera, online: boolean): void {
    this.updateVan(dt, sim, camera, online);
    for (const r of sim.raid.raiders) {
      if (!r.alive) continue;
      let v = this.bodies.get(r.id);
      if (!v) {
        v = this.create(r);
        this.bodies.set(r.id, v);
      }
      this.animate(v, r, dt, renderTime, camera);
    }
    for (const [id, v] of this.bodies) {
      if (sim.raid.raiders.some((r) => r.id === id && r.alive)) continue;
      // Gone without a death (a reconnect): just go.
      this.bodies.delete(id);
      if (!v.ragdoll) this.free(v);
    }
    for (let i = this.corpses.length - 1; i >= 0; i--) {
      const c = this.corpses[i];
      c.deadT += dt;
      if (c.ragdoll && !c.ragdoll.asleep) c.ragdoll.update(dt);
      c.probe.update(dt, c.ragdoll ? c.ragdoll.center(_p) : c.pos, camera);
      if (c.deadT > CORPSE_TIME) {
        this.corpses.splice(i, 1);
        this.free(c);
      }
    }
  }

  private animate(v: RaiderBody, r: Raider, dt: number, t: number, camera: THREE.Camera): void {
    const b = v.body;
    const u = THREE.MathUtils.clamp((t - (r.updatedAt - r.lastDt)) / Math.max(1e-4, r.lastDt), 0, 1);
    v.pos.set(r.prev.x + (r.pos.x - r.prev.x) * u, r.prev.y + (r.pos.y - r.prev.y) * u, r.prev.z + (r.pos.z - r.prev.z) * u);
    const m = r.motion;
    v.vel.set(m.vel.x, 0, m.vel.z);
    const diff = Math.atan2(Math.sin(r.facing - v.facing), Math.cos(r.facing - v.facing));
    const turned = diff * (1 - Math.exp(-dt * 12));
    v.facing += turned;
    b.root.position.copy(v.pos);
    b.root.rotation.y = v.facing;
    const hv = Math.hypot(m.vel.x, m.vel.z);
    const rx = Math.cos(v.facing), rz = -Math.sin(v.facing);
    const strafe = hv > 0.1 ? (m.vel.x * rx + m.vel.z * rz) / hv : 0;
    const travel = Math.atan2(m.vel.x, m.vel.z) - v.facing;
    const moveAngle = hv > 0.3 ? Math.atan2(Math.sin(travel), Math.cos(travel)) : 0;
    b.lookPitch += ((m.aiming ? m.pitch : m.pitch * 0.35) - b.lookPitch) * (1 - Math.exp(-dt * 10));
    b.update(dt, { speed: hv, crouch: 0, aim: m.aiming ? 1 : 0, grounded: true, strafe, moveAngle, turn: dt > 0 ? turned / dt : 0 });
    const cp = Math.cos(m.pitch);
    _aim.set(v.pos.x + Math.sin(v.facing) * cp * 30, v.pos.y + m.eyeHeight + Math.sin(m.pitch) * 30, v.pos.z + Math.cos(v.facing) * cp * 30);
    v.weapon.update(dt, r.arsenal, { aim: m.aiming ? 1 : 0.15, sprinting: m.sprinting, aimPoint: _aim });
    v.probe.update(dt, v.pos, camera);
  }

  private updateVan(dt: number, sim: Simulation, camera: THREE.Camera, online: boolean): void {
    const van = sim.raid.van;
    if (!van) {
      if (this.van) this.removeVan();
      audio.van(null);
      return;
    }
    if (!this.van) {
      this.van = buildVan();
      this.scene.add(this.van.root);
      this.vanProbe = new DynamicProbe(this.field);
      this.vanProbe.attach(this.van.materials);
      this.vanPos.set(van.pos.x, 0, van.pos.z);
      this.vanYaw = van.yaw;
    }
    const v = this.van;
    // Online it glides from snapshot to snapshot; solo it is drawn where the simulation has it.
    const k = online ? 1 - Math.exp(-dt * 10) : 1;
    const ahead = online ? van.speed * 0.05 : 0;
    const tx = van.pos.x + Math.sin(van.yaw) * ahead, tz = van.pos.z + Math.cos(van.yaw) * ahead;
    this.vanPos.x += (tx - this.vanPos.x) * k;
    this.vanPos.z += (tz - this.vanPos.z) * k;
    this.vanYaw += Math.atan2(Math.sin(van.yaw - this.vanYaw), Math.cos(van.yaw - this.vanYaw)) * k;
    // Up over a curb where the road narrows.
    const g = this.physics.raycast(this.vanPos.x, 2, this.vanPos.z, 0, -1, 0, 3, STATIC_ONLY);
    const y = g !== null ? Math.max(0, 2 - g) : 0;
    this.vanPos.y += (y - this.vanPos.y) * (1 - Math.exp(-dt * 8));
    v.root.position.copy(this.vanPos);
    v.root.rotation.y = this.vanYaw;
    // A little body roll and pitch with the speed.
    this.roll += ((van.speed > 0.5 ? Math.sin(sim.time * 7) * 0.004 * van.speed : 0) - this.roll) * Math.min(1, dt * 4);
    v.root.rotation.z = this.roll;
    for (const w of v.wheels) w.rotation.x += (van.speed * dt) / 0.37;
    this.doorOpen += ((van.door ? 1 : 0) - this.doorOpen) * (1 - Math.exp(-dt * 5));
    v.door.position.set(-(RAID.van.width / 2 + 0.01) - this.doorOpen * 0.09, 0, RAID.van.door.z - this.doorOpen * 1.15);
    v.lights.emissiveIntensity = sim.raid.stage === 'over' ? 0.1 : 2.4;
    this.vanProbe!.update(dt, this.vanPos, camera, 1.2);
    audio.van(sim.raid.stage === 'over' ? null : { pos: _p.set(this.vanPos.x, 0.8, this.vanPos.z), speed: van.speed, idle: sim.raid.stage === 'arrived' });
  }

  /** Muzzle of a raider's gun. */
  muzzle(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.bodies.get(id);
    return v ? v.weapon.muzzleWorld(out) : null;
  }

  muzzleDir(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.bodies.get(id);
    return v ? v.weapon.muzzleDir(out) : null;
  }

  weaponOf(id: string): PlayerWeapon | null {
    return this.bodies.get(id)?.weapon ?? null;
  }

  handOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.bodies.get(id);
    return v ? v.body.armR.end.getWorldPosition(out) : null;
  }

  headOf(id: string, out: THREE.Vector3): THREE.Vector3 | null {
    const v = this.bodies.get(id);
    return v ? out.copy(v.pos).setY(v.pos.y + RAID.eyeHeight) : null;
  }

  hit(id: string, zone: HitZone, dir: THREE.Vector3, damage: number): void {
    const v = this.bodies.get(id);
    if (!v) return;
    v.body.flinch(zone, dir.x, dir.z, Math.min(1, damage / 40));
    if (this.gore) v.body.wound(zone, Math.min(0.6, damage / 80));
  }

  died(id: string, zone: HitZone, dir: THREE.Vector3): void {
    const v = this.bodies.get(id);
    if (!v || v.ragdoll) return;
    this.bodies.delete(id);
    v.weapon.setVisible(false);
    const r = new Ragdoll(this.physics, v.body);
    const push = dir.clone().setY(Math.max(dir.y, 0) + 0.2).multiplyScalar(2.2);
    r.start(v.vel, [{ joints: ZONE_PARTICLES[zone] ?? ZONE_PARTICLES.torso, impulse: push }]);
    v.ragdoll = r;
    v.deadT = 0;
    this.corpses.push(v);
  }

  setGore(on: boolean): void {
    this.gore = on;
    for (const v of this.bodies.values()) v.weapon.gore = on;
  }

  private free(v: RaiderBody): void {
    v.weapon.dispose();
    v.body.root.removeFromParent();
    v.body.dispose();
  }

  private removeVan(): void {
    if (!this.van) return;
    this.van.root.removeFromParent();
    this.van.root.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of [...this.van.materials, this.van.lights]) m.dispose();
    this.van = null;
  }

  dispose(): void {
    for (const v of this.bodies.values()) this.free(v);
    for (const v of this.corpses) this.free(v);
    this.bodies.clear();
    this.corpses.length = 0;
    this.removeVan();
    audio.van(null);
  }
}
