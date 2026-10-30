import * as THREE from 'three';
import type { Simulation } from '@dead-hours/shared';
import { SeveredArm } from '../characters/Severed';
import type { Effects } from '../effects/Effects';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';

interface View {
  arm: SeveredArm;
  probe: DynamicProbe;
  /** Seconds to the next drop of blood off the torn end. */
  drip: number;
  falling: boolean;
  pooled: boolean;
  /** Seconds into sinking away (cleared from the world), or -1. */
  sinkT: number;
}

const _p = new THREE.Vector3(), _d = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

/**
 * Severed arms lying around (or still tumbling through the air): each one is the zombie's
 * own arm, following its physics body in the simulation, trailing and dripping blood from the
 * torn end, splatting where it lands. Arms in someone's hands are drawn by their weapon view.
 */
export class LimbView {
  private readonly views = new Map<number, View>();
  private readonly sinking: View[] = [];
  private readonly root = new THREE.Group();
  gore = true;
  /** Something heavy and wet hit the ground (sound). */
  onLand: ((pos: THREE.Vector3, speed: number) => void) | null = null;

  constructor(scene: THREE.Scene, private readonly field: LightField, private readonly effects: Effects) {
    this.root.name = 'limbs';
    scene.add(this.root);
  }

  get count(): number {
    return this.views.size;
  }

  /** Root of a loose arm on screen (tests). */
  object(id: number): THREE.Object3D | null {
    return this.views.get(id)?.arm.root ?? null;
  }

  /** Where a loose arm lies, as the pose of one held by the wrist (picking it up starts there). */
  liftPose(id: number, pos: THREE.Vector3, q: THREE.Quaternion): boolean {
    const v = this.views.get(id);
    if (!v) return false;
    v.arm.heldPose(pos, q);
    return true;
  }

  /** The simulation cleared an arm away: it sinks out of sight. */
  gone(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    this.views.delete(id);
    v.sinkT = 0;
    this.sinking.push(v);
  }

  update(dt: number, sim: Simulation, alpha: number, camera: THREE.Camera, stepDt: number): void {
    const seen = new Set<number>();
    for (const l of sim.limbs) {
      if (l.holder || !l.body) continue;
      seen.add(l.id);
      let v = this.views.get(l.id);
      if (!v) {
        const arm = new SeveredArm({ kind: l.kind, look: l.look, arm: l.arm, cut: l.cut, scale: l.scale }, 'world');
        arm.setWear(l.wear / l.maxWear);
        const probe = new DynamicProbe(this.field, 0.15);
        probe.attach(arm.materials);
        this.root.add(arm.root);
        v = { arm, probe, drip: 0, falling: false, pooled: false, sinkT: -1 };
        this.views.set(l.id, v);
      }
      v.arm.setGore(this.gore);
      // Between the last two physics poses.
      const r = v.arm.root;
      r.position.copy(_a.set(l.prevPos.x, l.prevPos.y, l.prevPos.z)).lerp(_b.set(l.pos.x, l.pos.y, l.pos.z), alpha);
      r.quaternion.copy(_qa.set(l.prevRot.x, l.prevRot.y, l.prevRot.z, l.prevRot.w)).slerp(_qb.set(l.rot.x, l.rot.y, l.rot.z, l.rot.w), alpha);
      v.probe.update(dt, r.position, camera, 0.2);

      // Landing: was dropping fast, now stopped.
      const vy = (l.pos.y - l.prevPos.y) / stepDt;
      const speed = Math.hypot(l.pos.x - l.prevPos.x, l.pos.y - l.prevPos.y, l.pos.z - l.prevPos.z) / stepDt;
      if (vy < -2.2) v.falling = true;
      else if (v.falling && vy > -0.6) {
        v.falling = false;
        this.effects.splat(r.position, 0.22 + Math.min(0.25, speed * 0.04) * l.scale);
        this.onLand?.(r.position, Math.min(1, speed / 6));
      }
      // Fresh arms bleed: a trail while flying, drips for a while after.
      const age = sim.time - l.bornAt;
      const fresh = THREE.MathUtils.clamp(1 - age / 45, 0, 1);
      v.drip -= dt;
      if (fresh > 0 && v.drip <= 0) {
        v.drip = speed > 1.5 ? 0.035 : 0.15 + (1 - fresh) * 2.2 + Math.random() * 0.3;
        v.arm.cutEnd(_p, _d);
        _p.addScaledVector(_d, 0.02);
        this.effects.drip(_p, _d.set(l.pos.x - l.prevPos.x, l.pos.y - l.prevPos.y, l.pos.z - l.prevPos.z).divideScalar(stepDt));
      }
      if (!v.pooled && l.body.isSleeping()) {
        v.pooled = true;
        if (fresh > 0.4) this.effects.pool(v.arm.cutEnd(_p).setY(r.position.y - l.radius + 0.01), 0.3 * l.scale, 120);
      }
    }
    for (const [id, v] of this.views) {
      if (seen.has(id)) continue;
      // Picked up (now in someone's hands) or gone without notice.
      this.views.delete(id);
      this.free(v);
    }
    for (let i = this.sinking.length - 1; i >= 0; i--) {
      const v = this.sinking[i];
      v.sinkT += dt;
      v.arm.root.position.y -= dt * 0.22;
      if (v.sinkT > 1.4) {
        this.sinking.splice(i, 1);
        this.free(v);
      }
    }
  }

  private free(v: View): void {
    v.arm.dispose();
  }

  dispose(): void {
    for (const v of this.views.values()) this.free(v);
    for (const v of this.sinking) this.free(v);
    this.views.clear();
    this.sinking.length = 0;
    this.root.removeFromParent();
  }
}
