import { COMBAT, WEAPONS, type WeaponDef, type WeaponId, type WeaponSlot } from '../config/weapons';
import { LIMBS, type LimbCut, type LimbZone } from '../config/limbs';
import { MELEE, type MeleeId } from '../config/melee';
import type { ZombieKind } from '../config/zombies';
import { FIT_TIME, defaultBuild, sameBuild, tunedWeapon, type Loadout, type WeaponBuild } from '../config/progression';
import { THROWABLES, THROWING, type ThrowKind } from '../config/throwables';
import { clamp } from './math';

export interface WeaponState {
  id: WeaponId;
  mag: number;
  reserve: number;
}

export type ArsenalAction = 'idle' | 'draw' | 'reload' | 'melee' | 'bandage' | 'throw';

/** What a player is doing with their hands that the arsenal finished or advanced this step. */
export type ArsenalTick = 'drawn' | 'shell' | 'reloaded' | 'meleeHit' | 'meleeDone' | 'bandaged' | 'thrown' | 'throwDone';

/** A severed arm in a survivor's hands. */
export interface HeldLimb {
  id: number;
  /** The limb (an arm, or a leg: the field kept its old name for the wire format). */
  arm: LimbZone;
  cut: LimbCut;
  /** The zombie it came from (renderers dress it the same). */
  kind: ZombieKind;
  look: number;
  scale: number;
  /** Hits left before it falls apart, out of `maxWear`. */
  wear: number;
  maxWear: number;
  /** Worn through mid-swing: gone from the hands, the swing still finishing. */
  broken: boolean;
}

export interface MotionForSpread {
  speed: number;
  crouching: boolean;
  grounded: boolean;
  aiming: boolean;
}

function fresh(id: WeaponId, builds: Loadout): WeaponState {
  const d = tunedWeapon(id, builds[id]);
  return { id, mag: d.magazine, reserve: d.startReserve };
}

/**
 * Server-authoritative weapon state for one player: magazines, reserves, fire rate, reloads,
 * weapon switching, melee timing and spread. Pure logic so solo and multiplayer agree.
 */
export class Arsenal {
  primary: WeaponState;
  secondary: WeaponState;
  readonly melee: WeaponState = fresh('machete', {});
  /** The melee weapon in hand for quick swings: the machete, or one found lying around. */
  meleeId: MeleeId = 'machete';
  /** Attachments and finishes fitted to each gun (checked against the player's unlocks before they get here). */
  builds: Loadout;
  active: 'primary' | 'secondary' = 'primary';
  action: ArsenalAction = 'draw';
  actionT: number;
  actionTotal: number;
  /** Time until the next round can fire (may go slightly negative to keep auto cadence). */
  cooldown = 0;
  /** Recoil bloom 0..1, decays when not firing. */
  bloom = 0;
  /** Aim blend 0..1 (spread follows this). */
  aim = 0;
  private meleeHitPending = false;
  private interruptedSlot: 'primary' | 'secondary' | null = null;
  /** A severed arm held as a club: while it is, the guns stay slung and every swing uses it. */
  limb: HeldLimb | null = null;
  /** What the current (or last) melee swing is made with. */
  meleeWith: 'machete' | 'limb' = 'machete';
  /** Grenades and Molotovs carried. */
  readonly throwables: Record<ThrowKind, number> = { frag: THROWABLES.frag.start, molotov: THROWABLES.molotov.start };
  /** What the current (or last) throw is. */
  throwKind: ThrowKind = 'frag';
  private releasePending = false;

  constructor(primary: WeaponId, secondary: WeaponId, builds: Loadout = {}) {
    this.builds = { ...builds };
    this.primary = fresh(WEAPONS[primary]?.slot === 'primary' ? primary : 'ar', this.builds);
    this.secondary = fresh(WEAPONS[secondary]?.slot === 'secondary' ? secondary : 'pistol', this.builds);
    this.actionTotal = this.actionT = this.def.draw;
  }

  get weapon(): WeaponState {
    return this.active === 'primary' ? this.primary : this.secondary;
  }

  get def(): WeaponDef {
    return this.defOf(this.weapon.id);
  }

  /** A weapon's numbers with this survivor's build fitted. */
  defOf(id: WeaponId): WeaponDef {
    return tunedWeapon(id, this.builds[id]);
  }

  /**
   * Fits a new build to one of the carried guns. The one in hand goes down for FIT_TIME while
   * it's done; rounds over a smaller magazine go back to the reserve. False when busy or unchanged.
   */
  refit(id: WeaponId, b: WeaponBuild): boolean {
    const w = this.primary.id === id ? this.primary : this.secondary.id === id ? this.secondary : null;
    if (!w || this.action === 'melee' || this.action === 'bandage') return false;
    if (sameBuild(this.builds[id] ?? defaultBuild(id), b)) return false;
    this.builds = { ...this.builds, [id]: { ...b } };
    const d = this.defOf(id);
    if (w.mag > d.magazine) {
      w.reserve += w.mag - d.magazine;
      w.mag = d.magazine;
    }
    if (w === this.weapon && !this.limb) {
      this.cancelReload();
      this.action = 'draw';
      this.actionTotal = this.actionT = FIT_TIME;
      this.cooldown = Math.max(this.cooldown, 0);
    }
    return true;
  }

  /** 0..1 progress of the current action (reload bar, draw). */
  get progress(): number {
    if (this.action === 'idle') return 1;
    if (this.action === 'reload' && this.def.perShell) {
      const w = this.weapon;
      return clamp(w.mag / this.def.magazine, 0, 1);
    }
    return this.actionTotal > 0 ? clamp(1 - this.actionT / this.actionTotal, 0, 1) : 1;
  }

  slotOf(id: WeaponId): WeaponSlot {
    return WEAPONS[id].slot;
  }

  /** Cone half-angle in degrees for the next round. */
  spread(m: MotionForSpread): number {
    if (this.limb) return 0;
    const d = this.def;
    const base = d.hipSpread + (d.aimSpread - d.hipSpread) * this.aim;
    const move = 1 + Math.min(1, m.speed / 6.2) * (this.aim > 0.5 ? 0.7 : 1.3);
    const stance = m.crouching ? 0.75 : 1;
    const air = m.grounded ? 1 : 2.2;
    return base * move * stance * air + this.bloom * d.recoil * 3.2;
  }

  /** Whether a round can be fired now; 'empty' means the trigger clicks dry. */
  fireState(): 'ok' | 'empty' | 'busy' {
    if (this.limb) return 'busy';
    if (this.action === 'draw' || this.action === 'melee' || this.action === 'bandage' || this.action === 'throw') return 'busy';
    if (this.action === 'reload') {
      // Shell-by-shell reloads can be interrupted to fire what is loaded.
      if (!(this.def.perShell && this.weapon.mag > 0)) return 'busy';
    }
    if (this.cooldown > 0) return 'busy';
    if (this.weapon.mag <= 0) return 'empty';
    return 'ok';
  }

  /** Spends a round. Call only after fireState() === 'ok'. */
  consume(): void {
    if (this.action === 'reload') this.action = 'idle';
    this.weapon.mag--;
    this.cooldown = Math.max(this.cooldown, -0.02) + 60 / this.def.fireRate;
    this.bloom = Math.min(1, this.bloom + this.def.recoil * 0.22);
  }

  /** Dry fire still needs a pause so the click doesn't repeat every frame. */
  dryFire(): void {
    this.cooldown = 0.25;
  }

  startReload(): boolean {
    if (this.action !== 'idle' || this.limb) return false;
    const d = this.def;
    const w = this.weapon;
    if (w.mag >= d.magazine || w.reserve <= 0) return false;
    this.action = 'reload';
    if (d.perShell) {
      this.actionTotal = this.actionT = 0.4;
    } else {
      this.actionTotal = this.actionT = d.reloadTime + (w.mag === 0 ? 0.35 : 0);
    }
    return true;
  }

  cancelReload(): boolean {
    if (this.action !== 'reload') return false;
    this.action = 'idle';
    this.actionT = 0;
    return true;
  }

  switchTo(slot: 'primary' | 'secondary'): boolean {
    if (slot === this.active && this.action !== 'draw') return false;
    if (this.action === 'melee' || this.action === 'bandage' || this.action === 'throw') return false;
    this.cancelReload();
    this.active = slot;
    this.action = 'draw';
    this.actionTotal = this.actionT = this.def.draw;
    this.cooldown = Math.max(this.cooldown, 0);
    return true;
  }

  /** Swings the machete, or the arm when one is in hand (not while still getting a grip on it). */
  startMelee(): boolean {
    if (this.action === 'melee' || this.action === 'bandage' || this.action === 'throw') return false;
    if (this.limb && (this.action === 'draw' || this.limb.broken)) return false;
    this.cancelReload();
    this.meleeWith = this.limb ? 'limb' : 'machete';
    this.interruptedSlot = this.action === 'draw' && !this.limb ? this.active : null;
    this.action = 'melee';
    this.actionTotal = this.actionT = this.limb ? LIMBS.duration : MELEE[this.meleeId].duration;
    this.meleeHitPending = true;
    return true;
  }

  /** Seconds into a swing at which the blow lands. */
  get meleeWindup(): number {
    return this.meleeWith === 'limb' ? LIMBS.windup : MELEE[this.meleeId].windup;
  }

  /** Takes a severed arm in hand: the gun is slung while the grip is taken. */
  grabLimb(limb: HeldLimb): boolean {
    if (this.action === 'melee' || this.action === 'bandage' || this.action === 'throw') return false;
    this.cancelReload();
    this.limb = limb;
    this.action = 'draw';
    this.actionTotal = this.actionT = LIMBS.grab;
    this.cooldown = Math.max(this.cooldown, 0);
    return true;
  }

  /** Lets go of the arm and brings the active gun back up. Returns what was held. */
  releaseLimb(): HeldLimb | null {
    const l = this.limb;
    if (!l) return null;
    this.limb = null;
    this.interruptedSlot = null;
    this.meleeHitPending = false;
    this.action = 'draw';
    this.actionTotal = this.actionT = this.def.draw;
    return l;
  }

  /**
   * Starts a throw: the gun goes down, the arm winds back and lets go `THROWING.release` seconds
   * in ('thrown' tick), one fewer carried. Not with an arm in the hands, mid-swing or bandaging.
   */
  startThrow(kind: ThrowKind): boolean {
    if (this.throwables[kind] <= 0 || this.limb) return false;
    if (this.action === 'melee' || this.action === 'bandage' || this.action === 'throw') return false;
    this.cancelReload();
    this.throwKind = kind;
    this.throwables[kind]--;
    this.interruptedSlot = this.action === 'draw' ? this.active : null;
    this.action = 'throw';
    this.actionTotal = this.actionT = THROWING.duration;
    this.releasePending = true;
    return true;
  }

  /** Adds grenades or Molotovs up to the carry limit; returns how many fit. */
  addThrowable(kind: ThrowKind, n: number): number {
    const take = Math.max(0, Math.min(n, THROWABLES[kind].max - this.throwables[kind]));
    this.throwables[kind] += take;
    return take;
  }

  startBandage(): boolean {
    if (this.action === 'melee' || this.action === 'bandage' || this.action === 'throw') return false;
    this.cancelReload();
    this.action = 'bandage';
    this.actionTotal = this.actionT = COMBAT.bandageTime;
    return true;
  }

  cancelBandage(): boolean {
    if (this.action !== 'bandage') return false;
    this.action = 'idle';
    return true;
  }

  /** Replaces the primary (weapon table). Keeps the same share of ammunition. */
  replacePrimary(id: WeaponId, full = false): void {
    const old = this.primary;
    const od = this.defOf(old.id);
    const share = full ? 1 : clamp((old.mag + old.reserve) / (od.magazine + od.startReserve), 0, 1);
    const nd = this.defOf(id);
    const total = Math.round(share * (nd.magazine + nd.startReserve));
    const mag = Math.min(nd.magazine, total);
    this.primary = { id, mag, reserve: total - mag };
    if (this.active === 'primary') {
      this.cancelReload();
      this.action = 'draw';
      this.actionTotal = this.actionT = nd.draw;
    }
  }

  /**
   * Back from the dead (a lull, see Simulation.respawnFallen): the same guns, each with at least a
   * full magazine and its starting reserve, at least the starting grenades and Molotovs, and the
   * primary drawn.
   */
  rearm(): void {
    for (const w of [this.primary, this.secondary]) {
      const d = this.defOf(w.id);
      w.mag = d.magazine;
      w.reserve = Math.max(w.reserve, d.startReserve);
    }
    for (const k of Object.keys(this.throwables) as ThrowKind[]) this.throwables[k] = Math.max(this.throwables[k], THROWABLES[k].start);
    this.limb = null;
    this.meleeWith = 'machete';
    this.releasePending = false;
    this.meleeHitPending = false;
    this.interruptedSlot = null;
    this.cooldown = 0;
    this.bloom = 0;
    this.aim = 0;
    this.active = 'primary';
    this.action = 'draw';
    this.actionTotal = this.actionT = this.def.draw;
  }

  /** Adds rounds to a weapon's reserve up to its carry limit; returns how many fit. */
  addReserve(slot: 'primary' | 'secondary', rounds: number): number {
    const w = slot === 'primary' ? this.primary : this.secondary;
    const room = Math.max(0, this.defOf(w.id).maxReserve - w.reserve);
    const take = Math.min(room, rounds);
    w.reserve += take;
    return take;
  }

  step(dt: number, aiming: boolean, out: ArsenalTick[]): void {
    this.cooldown -= dt;
    if (this.cooldown < -0.05) this.cooldown = -0.05;
    this.bloom = Math.max(0, this.bloom - dt * (this.cooldown > -0.04 ? 0.9 : 2.4));
    const canAim = aiming && !this.limb && this.action !== 'melee' && this.action !== 'bandage' && this.action !== 'draw' && this.action !== 'throw';
    this.aim = clamp(this.aim + (canAim ? dt : -dt) / COMBAT.aimTime, 0, 1);
    if (this.action === 'idle') return;
    this.actionT -= dt;
    if (this.action === 'melee') {
      const elapsed = this.actionTotal - this.actionT;
      if (this.meleeHitPending && elapsed >= this.meleeWindup) {
        this.meleeHitPending = false;
        out.push('meleeHit');
      }
      if (this.actionT <= 0) {
        // Back to the gun, re-drawing if the swing interrupted a draw.
        this.action = this.interruptedSlot ? 'draw' : 'idle';
        if (this.interruptedSlot) this.actionTotal = this.actionT = this.def.draw * 0.6;
        this.interruptedSlot = null;
        out.push('meleeDone');
      }
      return;
    }
    if (this.action === 'throw') {
      if (this.releasePending && this.actionTotal - this.actionT >= THROWING.release) {
        this.releasePending = false;
        out.push('thrown');
      }
      if (this.actionT <= 0) {
        // The gun comes back up.
        this.action = 'draw';
        this.actionTotal = this.actionT = this.def.draw * (this.interruptedSlot ? 0.6 : 0.45);
        this.interruptedSlot = null;
        out.push('throwDone');
      }
      return;
    }
    if (this.actionT > 0) return;
    if (this.action === 'draw') {
      this.action = 'idle';
      out.push('drawn');
    } else if (this.action === 'bandage') {
      this.action = 'idle';
      out.push('bandaged');
    } else if (this.action === 'reload') {
      const d = this.def;
      const w = this.weapon;
      if (d.perShell) {
        if (w.reserve > 0 && w.mag < d.magazine) {
          w.mag++;
          w.reserve--;
          out.push('shell');
        }
        if (w.mag < d.magazine && w.reserve > 0) {
          this.actionTotal = this.actionT = d.reloadTime / d.magazine;
        } else {
          this.action = 'idle';
          out.push('reloaded');
        }
      } else {
        const take = Math.min(d.magazine - w.mag, w.reserve);
        w.mag += take;
        w.reserve -= take;
        this.action = 'idle';
        out.push('reloaded');
      }
    }
  }
}
