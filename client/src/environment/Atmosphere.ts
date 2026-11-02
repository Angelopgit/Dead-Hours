import * as THREE from 'three';
import { createSoftSprite } from '../rendering/ProceduralTextures';
import type { Quality } from '../core/Settings';

const WISPS: Record<Quality, number> = { low: 14, medium: 28, high: 44 };
const LEAVES: Record<Quality, number> = { low: 60, medium: 140, high: 260 };

/** Drifting ground fog wisps and wind-blown leaves that recycle around the focus point. */
export class Atmosphere {
  readonly group = new THREE.Group();
  private wisps: THREE.Sprite[] = [];
  private wispData: { vx: number; vz: number; base: number; phase: number }[] = [];
  private leaves: THREE.InstancedMesh | null = null;
  private leafData: { p: THREE.Vector3; v: THREE.Vector3; rot: THREE.Euler; spin: THREE.Vector3; ground: number }[] = [];
  private readonly sprite = createSoftSprite();
  private readonly dummy = new THREE.Object3D();
  readonly wind = new THREE.Vector3(1.2, 0, 0.5);
  private gust = 0;
  private quality: Quality = 'high';
  private readonly radius = 42;

  constructor() {
    this.group.name = 'atmosphere';
  }

  setQuality(q: Quality, focus: THREE.Vector3): void {
    this.quality = q;
    this.rebuild(focus);
  }

  private rebuild(focus: THREE.Vector3): void {
    for (const s of this.wisps) {
      this.group.remove(s);
      s.material.dispose();
    }
    this.wisps = [];
    this.wispData = [];
    const wispMat = () => new THREE.SpriteMaterial({
      map: this.sprite, color: 0x8796ad, transparent: true, opacity: 0.075, depthWrite: false, fog: true,
    });
    for (let i = 0; i < WISPS[this.quality]; i++) {
      const s = new THREE.Sprite(wispMat());
      const size = 9 + Math.random() * 12;
      s.scale.set(size, size * 0.35, 1);
      s.position.set(focus.x + (Math.random() - 0.5) * this.radius * 2, 0.6 + Math.random() * 1.4, focus.z + (Math.random() - 0.5) * this.radius * 2);
      s.renderOrder = 3;
      this.group.add(s);
      this.wisps.push(s);
      this.wispData.push({ vx: 0.3 + Math.random() * 0.4, vz: (Math.random() - 0.5) * 0.2, base: 0.04 + Math.random() * 0.05, phase: Math.random() * 10 });
    }

    if (this.leaves) {
      this.group.remove(this.leaves);
      this.leaves.geometry.dispose();
      (this.leaves.material as THREE.Material).dispose();
    }
    const n = LEAVES[this.quality];
    const g = new THREE.PlaneGeometry(0.09, 0.06);
    const m = new THREE.MeshStandardMaterial({ color: 0x5a4126, roughness: 0.9, side: THREE.DoubleSide });
    this.leaves = new THREE.InstancedMesh(g, m, n);
    this.leaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.leaves.frustumCulled = false;
    this.leaves.castShadow = false;
    const tints = [0x5a4126, 0x6b4a22, 0x463521, 0x6a5a2c];
    const color = new THREE.Color();
    this.leafData = [];
    for (let i = 0; i < n; i++) {
      this.leaves.setColorAt(i, color.setHex(tints[i % tints.length]));
      this.leafData.push({
        p: new THREE.Vector3(focus.x + (Math.random() - 0.5) * 60, Math.random() * 3, focus.z + (Math.random() - 0.5) * 60),
        v: new THREE.Vector3(),
        rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        spin: new THREE.Vector3(Math.random() * 4, Math.random() * 4, Math.random() * 4),
        ground: 0.02 + Math.random() * 0.03,
      });
    }
    this.group.add(this.leaves);
  }

  update(dt: number, t: number, focus: THREE.Vector3): void {
    if (!this.leaves) this.rebuild(focus);
    this.gust = Math.max(0, Math.sin(t * 0.21) * Math.sin(t * 0.53 + 1) * 1.6);
    const windScale = 1 + this.gust;
    const r = this.radius;
    this.wisps.forEach((s, i) => {
      const d = this.wispData[i];
      s.position.x += d.vx * windScale * dt;
      s.position.z += d.vz * dt;
      if (s.position.x - focus.x > r) s.position.x -= r * 2;
      if (s.position.x - focus.x < -r) s.position.x += r * 2;
      if (s.position.z - focus.z > r) s.position.z -= r * 2;
      if (s.position.z - focus.z < -r) s.position.z += r * 2;
      // Wisps wrap from behind to ahead as the survivor moves; fade them out toward the edge so
      // one never pops into the street ahead (in front of the lamps) when running or skating.
      const edge = Math.max(Math.abs(s.position.x - focus.x), Math.abs(s.position.z - focus.z)) / r;
      const mat = s.material;
      mat.opacity = d.base * (0.7 + 0.3 * Math.sin(t * 0.3 + d.phase)) * (1 - THREE.MathUtils.smoothstep(edge, 0.7, 1));
    });

    const leaves = this.leaves!;
    for (let i = 0; i < this.leafData.length; i++) {
      const L = this.leafData[i];
      const airborne = L.p.y > L.ground + 0.01;
      const gustLift = this.gust > 0.9 && Math.random() < 0.004 ? 2 + Math.random() * 2 : 0;
      if (airborne || gustLift) {
        L.v.x += (this.wind.x * windScale - L.v.x) * dt * 1.5;
        L.v.z += (this.wind.z * windScale - L.v.z) * dt * 1.5;
        L.v.y += (-0.6 + Math.sin(t * 3 + i) * 0.5) * dt + gustLift;
        L.v.y = Math.max(L.v.y, -0.8);
        L.rot.x += L.spin.x * dt;
        L.rot.y += L.spin.y * dt;
        L.rot.z += L.spin.z * dt;
      } else {
        // Skitter along the ground in gusts.
        const k = this.gust > 0.6 ? 0.5 : 0;
        L.v.set(this.wind.x * k, 0, this.wind.z * k);
        L.rot.x = -Math.PI / 2;
      }
      L.p.addScaledVector(L.v, dt);
      if (L.p.y < L.ground) L.p.y = L.ground;
      if (L.p.y > 6) L.v.y = -0.3;
      const dx = L.p.x - focus.x;
      const dz = L.p.z - focus.z;
      if (dx > 30) L.p.x -= 60; else if (dx < -30) L.p.x += 60;
      if (dz > 30) L.p.z -= 60; else if (dz < -30) L.p.z += 60;
      this.dummy.position.copy(L.p);
      this.dummy.rotation.copy(L.rot);
      this.dummy.updateMatrix();
      leaves.setMatrixAt(i, this.dummy.matrix);
    }
    leaves.instanceMatrix.needsUpdate = true;
  }

  get windStrength(): number {
    return 1 + this.gust;
  }

  dispose(): void {
    for (const s of this.wisps) s.material.dispose();
    this.sprite.dispose();
    if (this.leaves) {
      this.leaves.geometry.dispose();
      (this.leaves.material as THREE.Material).dispose();
    }
  }
}
