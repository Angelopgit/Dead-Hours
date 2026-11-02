import type { HitZone, WeaponId, WeaponSlot } from '../config/weapons';
import type { ZombieKind } from '../config/zombies';
import type { LimbCut, LimbZone } from '../config/limbs';
import type { MeleeId } from '../config/melee';
import type { ThrowKind } from '../config/throwables';
import type { Surface } from '../physics/Physics';
import type { Vec3 } from './math';
import type { SkateTrick } from '../config/skateboards';

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
    /** The melee weapon it was struck with (not set for arms or bullets). */
    weapon?: MeleeId;
  }
  | {
    type: 'zombieDied'; zombie: number; zone: HitZone; dir: Vec3; force: number; by: string;
    /** Killed by a grenade (with the parts it tore off) or burned to death. */
    cause?: 'blast' | 'fire';
    gibs?: GibPart[];
    /** Caught at the heart of a blast: it comes apart. */
    shred?: boolean;
    /** Where the blast was (bodies are thrown away from it). */
    blast?: Vec3;
  }
  | { type: 'zombieSpawned'; zombie: number; kind: ZombieKind }
  | { type: 'zombieRemoved'; zombie: number }
  | { type: 'zombieAlert'; zombie: number; pos: Vec3 }
  | { type: 'zombieAttack'; zombie: number; target: string }
  | { type: 'zombieGroan'; zombie: number; pos: Vec3 }
  /** A screamer let out its call: `called` zombies turned toward `target`, `fresh` more are coming. */
  | { type: 'zombieScream'; zombie: number; pos: Vec3; target: string; called: number; fresh: number }
  /** A bloater burst at `pos` (after its zombieDied), killed by `by`. */
  | { type: 'zombieBurst'; zombie: number; pos: Vec3; by: string }
  | { type: 'playerHurt'; player: string; damage: number; from: Vec3; health: number }
  | { type: 'playerDied'; player: string }
  /** At zero health with a teammate still standing: on the ground, `bleed` seconds to be picked up (`last`: no more downs after this). */
  | { type: 'playerDowned'; player: string; bleed: number; last: boolean }
  | { type: 'playerRevived'; player: string; by: string; health: number }
  /** `player` working on downed `target`: started, got them up, or let go. */
  | { type: 'revive'; player: string; target: string; stage: 'start' | 'end' | 'cancel' }
  | { type: 'playerHealed'; player: string; amount: number; health: number }
  | { type: 'reload'; player: string; weapon: WeaponId; stage: 'start' | 'shell' | 'end' | 'cancel' }
  | { type: 'draw'; player: string; slot: WeaponSlot; weapon: WeaponId }
  /** New attachments or finish on a carried gun (encodeBuild). */
  | { type: 'refit'; player: string; weapon: WeaponId; build: string }
  | { type: 'melee'; player: string; stage: 'swing' | 'hit' | 'miss'; limb?: boolean }
  | { type: 'bandage'; player: string; stage: 'start' | 'end' | 'cancel' }
  | { type: 'pickup'; player: string; item: 'ammo' | 'bandage' | 'weapon' | 'supply' | 'serum'; amount: number; source: number; weapon?: WeaponId }
  | { type: 'doorPound'; door: number; pos: Vec3 }
  | { type: 'doorForced'; door: number; pos: Vec3 }
  /** A board went up, was pried off or split off under pounding (`boards` is how many are left). */
  | { type: 'barricade'; slot: number; boards: number; change: 'nailed' | 'pried' | 'broken'; player: string | null; pos: Vec3 }
  /** A survivor's hammer blow while nailing a board up. */
  | { type: 'hammer'; slot: number; player: string; pos: Vec3 }
  /** A zombie's blow on a boarded window. */
  | { type: 'barricadeHit'; slot: number; pos: Vec3 }
  /** A window pane smashed in (`dir` the way the shards fly). */
  | { type: 'glassBroken'; slot: number; pos: Vec3; dir: Vec3 }
  /** A zombie climbs in (or out) through a window. */
  | { type: 'vault'; zombie: number; slot: number }
  | { type: 'notice'; player: string | null; text: string; sub?: string }
  /**
   * A horde wave: `warning` (it starts at survival second `at`), `surge` (it lasts until `at`),
   * `over` (outlasted at `at`).
   */
  | { type: 'horde'; wave: number; stage: 'warning' | 'surge' | 'over'; at: number }
  /**
   * Downtime (see Lulls.ts): lull `n` `start`s (and ends at survival second `at`; `back`: the dead
   * it brought back), is `ending` (LULLS.warning seconds left, ends at `at`), or is `over` (at `at`).
   */
  | { type: 'lull'; n: number; stage: 'start' | 'ending' | 'over'; at: number; back?: string[] }
  /** A lull brought a dead survivor back, at `pos` facing `yaw` (on their feet, full health, rearmed). */
  | { type: 'playerRespawned'; player: string; pos: Vec3; yaw: number }
  | { type: 'heli'; drop: number; flight: HeliFlight; weapon?: WeaponId; serum?: boolean }
  | { type: 'supplyDrop'; drop: number; stage: 'released' | 'landed' | 'empty' | 'weaponTaken' | 'serumTaken' | 'gone'; pos: Vec3 }
  /** An arm came off: `pos` is the cut, `dir` the way the blow was going. */
  | { type: 'limbSevered'; zombie: number; limb: number; arm: LimbZone; cut: LimbCut; pos: Vec3; dir: Vec3; by: string; melee: boolean; killed: boolean }
  | { type: 'limbGrabbed'; player: string; limb: number }
  /** Let go of (`thrown` when tossed aside to draw a gun). */
  | { type: 'limbDropped'; player: string; limb: number; thrown: boolean }
  /** Worn through: it comes apart in the survivor's hands at `pos`. */
  | { type: 'limbBroke'; player: string; limb: number; pos: Vec3; dir: Vec3 }
  /** A found melee weapon was picked up at `pos` (floor); `swapped` is the one left there in its place. */
  | { type: 'meleeTaken'; player: string; item: number; weapon: MeleeId; swapped: MeleeId | null; pos: Vec3 }
  /** A loose arm was cleared away. */
  | { type: 'limbGone'; limb: number }
  /**
   * The van raid: `inbound` (the van starts in along route `route`), `arrived` (parked at `pos`,
   * `count` raiders about to get out), `over` (the last one is down).
   */
  | { type: 'raid'; stage: 'inbound' | 'arrived' | 'over'; route: number; pos: Vec3; count: number }
  | { type: 'raiderSpawned'; raider: string; weapon: WeaponId }
  | { type: 'raiderHit'; raider: string; zone: HitZone; pos: Vec3; dir: Vec3; damage: number; killed: boolean; by: string; melee: boolean }
  /** `left`: raiders still standing or still in the van. */
  | { type: 'raiderDied'; raider: string; zone: HitZone; dir: Vec3; by: string | null; weapon: WeaponId; left: number }
  /** A dead raider's body was cleared from the simulation (renderers keep the corpse). */
  | { type: 'raiderRemoved'; raider: string }
  /** A survivor started a throw (the hand comes back with it in `release` seconds). */
  | { type: 'throwStart'; player: string; kind: ThrowKind }
  /** A grenade or Molotov left the hand: where from, how fast, and (frags) when it goes off. */
  | { type: 'thrown'; id: number; kind: ThrowKind; player: string; pos: Vec3; vel: Vec3; fuseAt: number }
  /** It bounced (or came to rest, speed 0): its new state, for clients drawing the flight. */
  | { type: 'bounce'; id: number; pos: Vec3; vel: Vec3; surface: Surface; speed: number }
  /** A grenade went off (`id` 0 for blasts not from a thrown grenade). */
  | { type: 'explosion'; id: number; kind: 'frag'; pos: Vec3; player: string }
  /**
   * A Molotov broke (`pos`) and its fuel caught on the floor (`ground`): burning patches
   * [x, y, z, radius] from `start` to `end` (simulation time).
   */
  | { type: 'fire'; id: number; player: string; pos: Vec3; ground: Vec3; patches: [number, number, number, number][]; start: number; end: number }
  /** A zombie caught fire. */
  | { type: 'ignite'; zombie: number }
  /**
   * A survivor hopped on a skateboard, stepped off, or was thrown off it (a hit, a wall, going
   * down), or popped a flip trick (`trick`) off an ollie.
   */
  | { type: 'skate'; player: string; board: number; stage: 'on' | 'off' | 'bail' | 'trick'; pos: Vec3; yaw: number; trick?: SkateTrick };

/** A head or leg blown off a zombie a blast killed (arms come off as real limbs, see limbSevered). */
export interface GibPart {
  part: 'head' | 'legL' | 'legR';
  /** Where it was on the body, which way it flies, and how fast (m/s). */
  pos: Vec3;
  dir: Vec3;
  speed: number;
}

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
