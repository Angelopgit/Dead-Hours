import * as THREE from 'three';
import type { Simulation } from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import type { AimAssist as Level } from '../core/Settings';

const RANGE = 45;
/** Cone (radians) around the crosshair where a zombie is helped onto: hip fire, aiming. */
const CONE_HIP = THREE.MathUtils.degToRad(4.5);
const CONE_AIM = THREE.MathUtils.degToRad(7);
/** Aiming within this long after pressing aim snaps harder (the classic "aim at what you face"). */
const SNAP_TIME = 0.22;

const STRENGTH: Record<Level, number> = { off: 0, low: 0.55, standard: 1 };

/**
 * Aim assist for sticks and thumbs, which are far less precise than a mouse. Near the crosshair a
 * zombie slows turning (friction) and, while the player is moving or turning, the view drifts onto
 * its chest (magnetism). It never turns the view on its own when the player is still, never looks
 * through walls, and is off for the mouse.
 */
export class AimAssist {
  private snapT = 0;
  private readonly to = new THREE.Vector3();

  constructor(private readonly physics: Physics) {}

  /** The aim button was just pressed. */
  aimPressed(): void {
    this.snapT = SNAP_TIME;
  }

  /**
   * Returns the friction for this frame's turning and the pull to apply (radians), or null with
   * nothing in reach.
   */
  update(dt: number, sim: Simulation, origin: THREE.Vector3, dir: THREE.Vector3, yaw: number, pitch: number,
    aiming: boolean, active: boolean, level: Level): { friction: number; yaw: number; pitch: number } | null {
    this.snapT = Math.max(0, this.snapT - dt);
    const k = STRENGTH[level];
    if (k === 0) return null;
    const cone = aiming ? CONE_AIM : CONE_HIP;
    let best = Infinity;
    let bx = 0, by = 0, bz = 0, bd = 0;
    for (const z of sim.zombies) {
      if (!z.alive) continue;
      // Chest height (crawlers are low to the ground).
      const h = z.def.height * z.scale;
      const x = z.pos.x - origin.x, y = z.pos.y + h * 0.68 - origin.y, zz = z.pos.z - origin.z;
      const d = Math.hypot(x, y, zz);
      if (d > RANGE || d < 0.6) continue;
      const cos = (x * dir.x + y * dir.y + zz * dir.z) / d;
      // The body's own width counts, so close zombies are easier to stay on.
      const ang = Math.acos(Math.min(1, cos)) - Math.atan((z.def.radius * z.scale) / d);
      if (ang > cone || ang >= best) continue;
      best = ang;
      bx = x; by = y; bz = zz; bd = d;
    }
    if (best === Infinity) return null;
    this.to.set(bx, by, bz).divideScalar(bd);
    const hit = this.physics.raycast(origin.x, origin.y, origin.z, this.to.x, this.to.y, this.to.z, bd);
    if (hit !== null && hit < bd - 0.6) return null;

    const near = 1 - Math.max(0, best) / cone;
    const friction = 1 - (aiming ? 0.55 : 0.4) * near * k;
    if (!active && this.snapT <= 0) return { friction, yaw: 0, pitch: 0 };
    const wantYaw = Math.atan2(-bx, -bz);
    const wantPitch = Math.atan2(by, Math.hypot(bx, bz));
    let dy = wantYaw - yaw;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const dp = wantPitch - pitch;
    const rate = this.snapT > 0 ? 14 : aiming ? 4.5 : 2.2;
    const f = (1 - Math.exp(-dt * rate)) * k;
    return { friction, yaw: dy * f, pitch: dp * f * 0.6 };
  }
}
