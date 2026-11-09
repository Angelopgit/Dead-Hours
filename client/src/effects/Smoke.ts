import * as THREE from 'three';
import { VolumeBatch } from './Volume';
import type { SmokeKind } from '../characters/Outfit';
import type { SmokeSink } from '../characters/Smoking';

interface Puff {
  /** Size at birth and the range it grows to (metres). */
  size: number;
  size1: readonly [number, number];
  alpha: number;
  /** Albedo (lit by the batch's ambient). */
  rgb: readonly [number, number, number];
  life: readonly [number, number];
}

/**
 * Off the lit end: thin and bluish (cigarettes), thicker and greyer for joints and blunts.
 * Out of the mouth: a whiter, fuller cloud, biggest from a blunt.
 */
const SIDE: Record<SmokeKind, Puff> = {
  cigarette: { size: 0.022, size1: [0.12, 0.19], alpha: 0.3, rgb: [0.74, 0.8, 0.92], life: [2.0, 3.2] },
  joint: { size: 0.026, size1: [0.15, 0.24], alpha: 0.34, rgb: [0.8, 0.83, 0.88], life: [2.2, 3.4] },
  blunt: { size: 0.03, size1: [0.17, 0.27], alpha: 0.36, rgb: [0.78, 0.79, 0.8], life: [2.3, 3.6] },
};
const BREATH: Record<SmokeKind, Puff> = {
  cigarette: { size: 0.04, size1: [0.26, 0.36], alpha: 0.42, rgb: [0.86, 0.87, 0.9], life: [1.8, 2.8] },
  joint: { size: 0.05, size1: [0.36, 0.5], alpha: 0.46, rgb: [0.88, 0.88, 0.9], life: [2.2, 3.3] },
  blunt: { size: 0.055, size1: [0.42, 0.58], alpha: 0.5, rgb: [0.86, 0.86, 0.86], life: [2.4, 3.6] },
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);

/**
 * Survivors' cigarette, joint and blunt smoke: soft noise billows (the explosions' smoke shader,
 * one instanced draw) that curl up off the lit ends and roll out of mouths on a breath. Cheap by
 * design: a few billows a second per smoker, thinned with distance and the particle quality,
 * none past FAR. The smoke has no light of its own, so it stays well under the bloom threshold.
 */
export class SmokeWisps implements SmokeSink {
  readonly mesh: THREE.Mesh;
  private readonly batch: VolumeBatch;
  private readonly cam = new THREE.Vector3();
  private quality = 1;

  /** `ambient`: how bright the smoke reads (linear), for the lighting of the scene it is in. */
  constructor(capacity: number, ambient: THREE.Color) {
    this.batch = new VolumeBatch(capacity, false);
    (this.batch.material.uniforms.uAmbient.value as THREE.Color).copy(ambient);
    this.mesh = this.batch.mesh;
    this.mesh.name = 'smoke-wisps';
  }

  setQuality(fraction: number): void {
    this.quality = fraction;
    this.batch.setCapacity(fraction);
  }

  get active(): number {
    return this.batch.active;
  }

  /** Whether to emit a billow at `at`: always up close, thinning out with distance and quality. */
  private keep(at: THREE.Vector3): boolean {
    const d = at.distanceTo(this.cam);
    if (d > FAR) return false;
    return Math.random() < this.quality * THREE.MathUtils.clamp(1 - (d - 12) / (FAR - 12), 0.3, 1);
  }

  wisp(at: THREE.Vector3, kind: SmokeKind): void {
    if (!this.keep(at)) return;
    const p = SIDE[kind];
    this.batch.emit({
      x: at.x + rand(-0.003, 0.003), y: at.y + 0.004, z: at.z + rand(-0.003, 0.003),
      vx: rand(-0.035, 0.035), vy: rand(0.05, 0.12), vz: rand(-0.035, 0.035),
      life: rand(p.life[0], p.life[1]), size: p.size, size1: rand(p.size1[0], p.size1[1]),
      r: p.rgb[0], g: p.rgb[1], b: p.rgb[2], alpha: p.alpha,
      erode0: 0.25, erode1: 0.92, drag: 0.6, lift: 0.1, spin: rand(-0.8, 0.8),
    });
  }

  /** A thread of smoke off a hot barrel: thin, quick to rise and gone in a second or two. `k` is how hot (0..1). */
  barrel(at: THREE.Vector3, k: number): void {
    if (!this.keep(at)) return;
    this.batch.emit({
      x: at.x + rand(-0.004, 0.004), y: at.y + 0.006, z: at.z + rand(-0.004, 0.004),
      vx: rand(-0.05, 0.05), vy: rand(0.16, 0.3), vz: rand(-0.05, 0.05),
      life: rand(0.9, 1.6), size: 0.012, size1: rand(0.06, 0.11),
      r: 0.7, g: 0.71, b: 0.74, alpha: 0.13 + 0.11 * k,
      erode0: 0.2, erode1: 0.92, drag: 0.9, lift: 0.16, spin: rand(-1, 1),
    });
  }

  exhale(at: THREE.Vector3, dir: THREE.Vector3, kind: SmokeKind, k: number): void {
    if (!this.keep(at)) return;
    const p = BREATH[kind];
    // Strongest as the breath starts, tailing off; drifts up as it slows.
    const push = rand(0.45, 0.8) * (0.35 + 0.65 * k);
    this.batch.emit({
      x: at.x, y: at.y, z: at.z,
      vx: dir.x * push + rand(-0.05, 0.05), vy: dir.y * push + rand(0, 0.06), vz: dir.z * push + rand(-0.05, 0.05),
      life: rand(p.life[0], p.life[1]), size: p.size, size1: rand(p.size1[0], p.size1[1]) * (0.7 + 0.3 * k),
      r: p.rgb[0], g: p.rgb[1], b: p.rgb[2], alpha: p.alpha * (0.45 + 0.55 * k),
      erode0: 0.12, erode1: 0.88, drag: 2.2, lift: 0.14, spin: rand(-0.6, 0.6),
    });
  }

  update(dt: number, camera: THREE.Camera): void {
    camera.getWorldPosition(this.cam);
    this.batch.update(dt, camera);
  }

  clear(): void {
    this.batch.clear();
  }

  dispose(): void {
    this.batch.dispose();
  }
}

/** No smoke drawn farther than this from the camera (metres). */
const FAR = 38;
