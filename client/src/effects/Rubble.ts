import * as THREE from 'three';
import { RAPIER } from '../core/Physics';

/** Most pieces drawn at once (the oldest make room), and most still falling at once. */
const CAPACITY = 900;
const LIVE = 320;
/** A falling piece that has not come to rest by then is stopped where it is (s). */
const SETTLE = 9;
const STEP = 1 / 60;

interface Piece {
  /** Its body while it falls; null once it lies still (or was only ever placed). */
  body: RAPIER.RigidBody | null;
  age: number;
  /** What it is part of: pieces are taken away by tag (the ragged edge of a hole when the wall beside it goes). */
  tag: number;
  x: number;
  y: number;
  z: number;
  used: boolean;
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * What is left of walls and buildings: chunks of siding, plaster, roof and steel as one instanced
 * mesh. Pieces thrown or dropped fall as rigid bodies in a small physics world of their own (the
 * ground, the floor slabs they land on, and each other), tumble, pile up, and are left lying where
 * they stop; nothing in the game collides with them. Pieces can also be set down still (the
 * ragged edge of a hole).
 */
export class Rubble {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly world: RAPIER.World;
  private readonly fixed: RAPIER.RigidBody;
  private readonly floors = new Set<string>();
  private readonly pieces: Piece[] = [];
  private readonly sizes = new Float32Array(CAPACITY * 3);
  private next = 0;
  private live = 0;
  private acc = 0;
  /** A piece came down hard (for its sound): where, and how hard 0..1. */
  onLand: ((pos: THREE.Vector3, strength: number) => void) | null = null;
  private landBudget = 0;

  constructor() {
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, flatShading: true });
    this.material.name = 'rubble';
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.material, CAPACITY);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = true;
    const grey = new THREE.Color(0x777777);
    for (let i = 0; i < CAPACITY; i++) {
      this.mesh.setColorAt(i, grey);
      this.pieces.push({ body: null, age: 0, tag: 0, x: 0, y: 0, z: 0, used: false });
    }
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = STEP;
    this.fixed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    // The ground everything comes down on.
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(400, 2, 400).setTranslation(0, -2, 0).setFriction(0.9), this.fixed);
  }

  /** Something flat pieces land on (a building's floor slab), added once per `id`. */
  floor(id: string, x: number, z: number, w: number, d: number, top: number): void {
    if (this.floors.has(id) || top <= 0.01) return;
    this.floors.add(id);
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(w / 2, top / 2, d / 2).setTranslation(x, top / 2, z).setFriction(0.9), this.fixed);
  }

  private take(): number {
    const i = this.next;
    this.next = (this.next + 1) % CAPACITY;
    const p = this.pieces[i];
    if (p.body) {
      this.world.removeRigidBody(p.body);
      p.body = null;
      this.live--;
    }
    p.used = true;
    p.age = 0;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.visible = true;
    return i;
  }

  private write(i: number, pos: THREE.Vector3, quat: THREE.Quaternion): void {
    _m.compose(pos, quat, _s.set(this.sizes[i * 3], this.sizes[i * 3 + 1], this.sizes[i * 3 + 2]));
    this.mesh.setMatrixAt(i, _m);
  }

  /** Sets a piece down where it is to stay. */
  place(pos: THREE.Vector3, size: THREE.Vector3, quat: THREE.Quaternion, color: THREE.Color, tag = 0): void {
    const i = this.take();
    const p = this.pieces[i];
    p.tag = tag;
    p.x = pos.x;
    p.y = pos.y;
    p.z = pos.z;
    this.sizes.set([size.x, size.y, size.z], i * 3);
    this.write(i, pos, quat);
    this.mesh.setColorAt(i, color);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Lets a piece go: it falls, tumbles and lies where it stops. With too many falling already it is set down instead. */
  drop(pos: THREE.Vector3, size: THREE.Vector3, quat: THREE.Quaternion, vel: THREE.Vector3, spin: THREE.Vector3, color: THREE.Color, tag = 0): void {
    if (this.live >= LIVE) return;
    const i = this.take();
    const p = this.pieces[i];
    p.tag = tag;
    p.x = pos.x;
    p.y = pos.y;
    p.z = pos.z;
    this.sizes.set([size.x, size.y, size.z], i * 3);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(pos.x, pos.y, pos.z).setRotation(quat).setLinvel(vel.x, vel.y, vel.z).setAngvel(spin)
        .setLinearDamping(0.05).setAngularDamping(0.6),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(Math.max(0.02, size.x / 2), Math.max(0.02, size.y / 2), Math.max(0.02, size.z / 2)).setFriction(0.85).setRestitution(0.08).setDensity(1),
      body,
    );
    p.body = body;
    this.live++;
    this.write(i, pos, quat);
    this.mesh.setColorAt(i, color);
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Takes away the pieces with `tag` inside a box. */
  removeIn(tag: number, min: THREE.Vector3, max: THREE.Vector3): void {
    let any = false;
    for (let i = 0; i < this.mesh.count; i++) {
      const p = this.pieces[i];
      if (!p.used || p.tag !== tag) continue;
      if (p.x < min.x || p.x > max.x || p.y < min.y || p.y > max.y || p.z < min.z || p.z > max.z) continue;
      this.kill(i);
      any = true;
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }

  private kill(i: number): void {
    const p = this.pieces[i];
    if (p.body) {
      this.world.removeRigidBody(p.body);
      p.body = null;
      this.live--;
    }
    p.used = false;
    this.mesh.setMatrixAt(i, _zero);
  }

  /** How many pieces are still falling. */
  get falling(): number {
    return this.live;
  }

  update(dt: number): void {
    if (!this.live) return;
    this.acc = Math.min(this.acc + dt, STEP * 3);
    let stepped = false;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.world.step();
      stepped = true;
    }
    if (!stepped) return;
    this.landBudget = Math.min(3, this.landBudget + dt * 14);
    for (let i = 0; i < this.mesh.count; i++) {
      const p = this.pieces[i];
      const body = p.body;
      if (!body) continue;
      p.age += dt;
      const t = body.translation();
      const r = body.rotation();
      // The first hard knock on the way down.
      if (this.onLand && this.landBudget >= 1 && p.age > 0.15) {
        const v = body.linvel();
        const fell = p.y - t.y;
        if (fell > 0.5 && Math.abs(v.y) < 0.6 && Math.random() < 0.3) {
          this.landBudget -= 1;
          this.onLand(_p.set(t.x, t.y, t.z), Math.min(1, fell / 4) * Math.min(1, (this.sizes[i * 3] + this.sizes[i * 3 + 1] + this.sizes[i * 3 + 2]) / 2));
          p.y = t.y;
        }
      }
      p.x = t.x;
      p.z = t.z;
      if (!(Math.abs(v0(t.y)) < 1e4)) {
        this.kill(i);
        continue;
      }
      this.write(i, _p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w));
      if (body.isSleeping() || p.age > SETTLE || t.y < -1) {
        p.y = t.y;
        this.world.removeRigidBody(body);
        p.body = null;
        this.live--;
      }
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** One piece in front of the camera while the night loads, so its shader is compiled with the rest. */
  sample(at: THREE.Vector3): () => void {
    const i = this.next;
    this.place(at, _s.set(0.3, 0.2, 0.25).clone(), _q.identity(), new THREE.Color(0x777777), -1);
    return () => {
      this.kill(i);
      this.mesh.instanceMatrix.needsUpdate = true;
    };
  }

  clear(): void {
    for (let i = 0; i < CAPACITY; i++) {
      const p = this.pieces[i];
      if (p.body) this.world.removeRigidBody(p.body);
      p.body = null;
      p.used = false;
    }
    this.live = 0;
    this.next = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.clear();
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.world.free();
  }
}

function v0(n: number): number {
  return Number.isFinite(n) ? n : Infinity;
}
