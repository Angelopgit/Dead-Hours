import type { HitZone, WeaponId, WeaponSlot } from '../config/weapons';
import type { ZombieKind } from '../config/zombies';
import type { ArmZone, LimbCut } from '../config/limbs';
import type { Surface } from '../physics/Physics';
import type { Vec3 } from './math';

export type SimPhase = 'preparation' | 'survival' | 'over';

/** One pellet/bullet of a shot, for tracers and impact effects. */
export interface PelletTrace {
  end: Vec3;
  /** What stopped it (or 'none' when it flew to max range). */
  hit: 'world' | 'zombie' | 'none';
}

/**
 * Everything observable that happened during a simulation step. The solo client renders these
 * directly; in Phase 4 the server broadcasts them to every client.
 */
export type SimEvent =
  | { type: 'phase'; phase: SimPhase }
  | { type: 'shot'; player: string; weapon: WeaponId; origin: Vec3; pellets: PelletTrace[] }
  | { type: 'dryFire'; player: string; weapon: WeaponId }
  | { type: 'impact'; pos: Vec3; normal: Vec3; surface: Surface; dir: Vec3 }
  | {
    type: 'zombieHit'; zombie: number; zone: HitZone; pos: Vec3; dir: Vec3; damage: number; killed: boolean; by: string; melee: boolean;
    exit: { pos: Vec3; normal: Vec3 } | null;
    /** The severed arm it was clubbed with, if any. */
    limb?: number;
  }
  | { type: 'zombieDied'; zombie: number; zone: HitZone; dir: Vec3; force: number; by: string }
  | { type: 'zombieSpawned'; zombie: number; kind: ZombieKind }
  | { type: 'zombieRemoved'; zombie: number }
  | { type: 'zombieAlert'; zombie: number; pos: Vec3 }
  | { type: 'zombieAttack'; zombie: number; target: string }
  | { type: 'zombieGroan'; zombie: number; pos: Vec3 }
  | { type: 'playerHurt'; player: string; damage: number; from: Vec3; health: number }
  | { type: 'playerDied'; player: string }
  | { type: 'playerHealed'; player: string; amount: number; health: number }
  | { type: 'reload'; player: string; weapon: WeaponId; stage: 'start' | 'shell' | 'end' | 'cancel' }
  | { type: 'draw'; player: string; slot: WeaponSlot; weapon: WeaponId }
  | { type: 'melee'; player: string; stage: 'swing' | 'hit' | 'miss'; limb?: boolean }
  | { type: 'bandage'; player: string; stage: 'start' | 'end' | 'cancel' }
  | { type: 'pickup'; player: string; item: 'ammo' | 'bandage' | 'weapon' | 'supply'; amount: number; source: number; weapon?: WeaponId }
  | { type: 'doorPound'; door: number; pos: Vec3 }
  | { type: 'doorForced'; door: number; pos: Vec3 }
  | { type: 'notice'; player: string | null; text: string; sub?: string }
  /**
   * A horde wave: `warning` (it starts at survival second `at`), `surge` (it lasts until `at`),
   * `over` (outlasted at `at`).
   */
  | { type: 'horde'; wave: number; stage: 'warning' | 'surge' | 'over'; at: number }
  | { type: 'heli'; drop: number; flight: HeliFlight }
  | { type: 'supplyDrop'; drop: number; stage: 'released' | 'landed' | 'empty' | 'gone'; pos: Vec3 }
  /** An arm came off: `pos` is the cut, `dir` the way the blow was going. */
  | { type: 'limbSevered'; zombie: number; limb: number; arm: ArmZone; cut: LimbCut; pos: Vec3; dir: Vec3; by: string; melee: boolean; killed: boolean }
  | { type: 'limbGrabbed'; player: string; limb: number }
  /** Let go of (`thrown` when tossed aside to draw a gun). */
  | { type: 'limbDropped'; player: string; limb: number; thrown: boolean }
  /** Worn through: it comes apart in the survivor's hands at `pos`. */
  | { type: 'limbBroke'; player: string; limb: number; pos: Vec3; dir: Vec3 }
  /** A loose arm was cleared away. */
  | { type: 'limbGone'; limb: number };

/**
 * A supply helicopter's flight, in simulation time: in from `from` to the hover point `over`,
 * crate out at `release`, away to `to`. Clients animate the aircraft and the falling crate
 * from this alone, so every screen shows the same flight.
 */
export interface HeliFlight {
  from: Vec3;
  over: Vec3;
  to: Vec3;
  start: number;
  /** Arrives over the drop (decelerating into the hover). */
  arrive: number;
  release: number;
  /** Starts flying away. */
  leave: number;
  end: number;
  /** Ground under the hover point (where the crate lands) and when it touches down. */
  ground: Vec3;
  land: number;
  releaseHeight: number;
}
