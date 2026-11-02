import * as THREE from 'three';

interface Chunk {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  size: THREE.Vector3;
  color: THREE.Color;
  floor: number;
  life: number;
  resting: boolean;
}

/**
 * Pieces of a door knocked out by a blow, a burst or a blast: tumbling instanced slivers and
 * chunks of painted wood (raw on the broken faces) that bounce on the floor they fly over and
 * lie there a while. One draw call for all of them.
 */
export class WoodDebris {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly items: Chunk[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly paint = new THREE.Color(0x3a2a1e);
  private readonly raw = new THREE.Color(0x96704a);
  /** The floor under a point (null over nothing). */
  floorAt: ((x: number, y: number, z: number) => number | null) | null = null;
  onLand: ((pos: THREE.Vector3, strength: number) => void) | null = null;

  constructor(private readonly capacity = 64) {
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, this.paint);
  }

  /**
   * `count` pieces from a hole around `at` (spread over `rx` by `ry` m in the leaf's plane, whose
   * width runs along `along`), flung along `dir`.
   */
  burst(at: THREE.Vector3, dir: THREE.Vector3, along: THREE.Vector3, rx: number, ry: number, count: number, speed = 1): void {
    for (let i = 0; i < count; i++) {
      let c: Chunk;
      if (this.items.length < this.capacity) {
        c = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), size: new THREE.Vector3(), color: new THREE.Color(), floor: 0, life: 0, resting: false };
        this.items.push(c);
      } else {
        c = this.items.shift()!;
        this.items.push(c);
      }
      const u = (Math.random() * 2 - 1) * rx, v = (Math.random() * 2 - 1) * ry;
      c.pos.copy(at).addScaledVector(along, u);
      c.pos.y += v;
      const s = speed * (1.2 + Math.random() * 2.6);
      c.vel.copy(dir).multiplyScalar(s).addScaledVector(along, (Math.random() - 0.5) * 1.6 * speed);
      c.vel.y += 0.4 + Math.random() * 1.4;
      c.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      c.spin.set((Math.random() - 0.5) * 22, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 22);
      // Long thin slivers split along the grain, with now and then a fist-sized chunk.
      const big = Math.random() < 0.25;
      c.size.set(big ? 0.06 + Math.random() * 0.08 : 0.012 + Math.random() * 0.02, big ? 0.1 + Math.random() * 0.14 : 0.06 + Math.random() * 0.16, big ? 0.03 : 0.006 + Math.random() * 0.01);
      c.color.copy(Math.random() < 0.55 ? this.paint : this.raw).multiplyScalar(0.85 + Math.random() * 0.3);
      // Where it comes down: the floor under where it will be in a moment, or a step below the leaf.
      const fx = c.pos.x + c.vel.x * 0.35, fz = c.pos.z + c.vel.z * 0.35;
      const f = this.floorAt?.(fx, c.pos.y, fz);
      c.floor = f ?? c.pos.y - 1.2;
      c.life = 14 + Math.random() * 6;
      c.resting = false;
    }
  }

  clear(): void {
    this.items.length = 0;
    this.mesh.count = 0;
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.items.splice(i, 1);
        continue;
      }
      if (c.resting) continue;
      c.vel.y -= 9.8 * dt;
      c.vel.multiplyScalar(1 - 0.4 * dt);
      c.pos.addScaledVector(c.vel, dt);
      c.rot.x += c.spin.x * dt;
      c.rot.y += c.spin.y * dt;
      c.rot.z += c.spin.z * dt;
      const rest = c.floor + c.size.z * 0.5;
      if (c.pos.y < rest) {
        c.pos.y = rest;
        const strength = Math.min(1, Math.abs(c.vel.y) / 4);
        if (strength > 0.25 && c.size.x > 0.05) this.onLand?.(c.pos, strength);
        c.vel.y = -c.vel.y * 0.25;
        c.vel.x *= 0.45;
        c.vel.z *= 0.45;
        c.spin.multiplyScalar(0.4);
        if (Math.abs(c.vel.y) < 0.35) {
          // Lies flat.
          c.resting = true;
          c.rot.x = Math.PI / 2;
          c.rot.y = Math.random() * 6;
          c.rot.z = 0;
          c.pos.y = c.floor + 0.004;
        }
      }
    }
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      const c = this.items[i];
      // Sinks out of sight at the end rather than popping.
      const k = Math.min(1, c.life / 1.5);
      this.q.setFromEuler(c.rot);
      this.m.compose(c.pos, this.q, this.tmpS.copy(c.size).multiplyScalar(k));
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, c.color);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private readonly tmpS = new THREE.Vector3();

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
