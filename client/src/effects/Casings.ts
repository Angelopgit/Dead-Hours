import * as THREE from 'three';

interface Casing {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  floor: number;
  life: number;
  bounces: number;
  shell: boolean;
}

/**
 * Ejected brass and shotgun hulls: tumbling instanced cylinders that bounce on the floor
 * they were ejected over and lie there for a while. The first bounces report back for a tink.
 */
export class Casings {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.MeshStandardMaterial;
  private readonly items: Casing[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly brass = new THREE.Color(0xb08a3a);
  private readonly hull = new THREE.Color(0x8a1c16);
  private readonly small = new THREE.Vector3(1, 1, 1);
  private readonly big = new THREE.Vector3(2.1, 2.6, 2.1);
  onBounce: ((pos: THREE.Vector3, shell: boolean, strength: number) => void) | null = null;

  constructor(private readonly capacity = 48) {
    const g = new THREE.CylinderGeometry(0.0048, 0.0048, 0.022, 6);
    this.material = new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.85 });
    this.mesh = new THREE.InstancedMesh(g, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    for (let i = 0; i < capacity; i++) this.mesh.setColorAt(i, this.brass);
  }

  eject(pos: THREE.Vector3, dir: THREE.Vector3, floor: number, shell: boolean, inherit: THREE.Vector3): void {
    let c: Casing;
    if (this.items.length < this.capacity) {
      c = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), floor, life: 0, bounces: 0, shell };
      this.items.push(c);
    } else {
      // Recycle the oldest.
      c = this.items.shift()!;
      this.items.push(c);
    }
    c.pos.copy(pos);
    c.vel.copy(dir).multiplyScalar(shell ? 1.8 + Math.random() : 2.6 + Math.random() * 1.4).add(inherit);
    c.vel.y += 0.8 + Math.random() * 0.8;
    c.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    c.spin.set((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 40);
    c.floor = floor;
    c.life = 9;
    c.bounces = 0;
    c.shell = shell;
  }

  clear(): void {
    this.items.length = 0;
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  update(dt: number): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const c = this.items[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.items.splice(i, 1);
        continue;
      }
      if (c.bounces < 4) {
        c.vel.y -= 9.8 * dt;
        c.pos.addScaledVector(c.vel, dt);
        c.rot.x += c.spin.x * dt;
        c.rot.y += c.spin.y * dt;
        c.rot.z += c.spin.z * dt;
        const rest = c.floor + 0.005;
        if (c.pos.y < rest) {
          c.pos.y = rest;
          const strength = Math.min(1, Math.abs(c.vel.y) / 3);
          if (c.bounces < 2 && strength > 0.15) this.onBounce?.(c.pos, c.shell, strength);
          c.vel.y = -c.vel.y * 0.35;
          c.vel.x *= 0.55;
          c.vel.z *= 0.55;
          c.spin.multiplyScalar(0.5);
          c.bounces++;
          if (c.bounces >= 4 || Math.abs(c.vel.y) < 0.25) {
            c.bounces = 4;
            // Settle lying on its side.
            c.rot.x = Math.PI / 2;
            c.rot.z = 0;
          }
        }
      }
    }
    const n = this.items.length;
    for (let i = 0; i < n; i++) {
      const c = this.items[i];
      this.q.setFromEuler(c.rot);
      this.m.compose(c.pos, this.q, c.shell ? this.big : this.small);
      this.mesh.setMatrixAt(i, this.m);
      this.mesh.setColorAt(i, c.shell ? this.hull : this.brass);
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    // Only the live slots go to the GPU, not the whole pool.
    const color = this.mesh.instanceColor;
    for (const [a, size] of [[this.mesh.instanceMatrix, 16], [color, 3]] as const) {
      if (!a) continue;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * size);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
