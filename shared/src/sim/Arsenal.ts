import { COMBAT, WEAPONS, type WeaponDef, type WeaponId, type WeaponSlot } from '../config/weapons';
import { clamp } from './math';

export interface WeaponState {
  id: WeaponId;
  mag: number;
  reserve: number;
}

export type ArsenalAction = 'idle' | 'draw' | 'reload' | 'melee' | 'bandage';

/** What a player is doing with their hands that the arsenal finished or advanced this step. */
export type ArsenalTick = 'drawn' | 'shell' | 'reloaded' | 'meleeHit' | 'meleeDone' | 'bandaged';

export interface MotionForSpread {
  speed: number;
  crouching: boolean;
  grounded: boolean;
  aiming: boolean;
}

function fresh(id: WeaponId): WeaponState {
  const d = WEAPONS[id];
  return { id, mag: d.magazine, reserve: d.startReserve };
}

/**
 * Server-authoritative weapon state for one player: magazines, reserves, fire rate, reloads,
 * weapon switching, melee timing and spread. Pure logic so solo and multiplayer agree.
 */
export class Arsenal {
  primary: WeaponState;
  secondary: WeaponState;
  readonly melee: WeaponState = fresh('machete');
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

  constructor(primary: WeaponId, secondary: WeaponId) {
    this.primary = fresh(WEAPONS[primary]?.slot === 'primary' ? primary : 'ar');
    this.secondary = fresh(WEAPONS[secondary]?.slot === 'secondary' ? secondary : 'pistol');
    this.actionTotal = this.actionT = this.def.draw;
  }

  get weapon(): WeaponState {
    return this.active === 'primary' ? this.primary : this.secondary;
  }

  get def(): WeaponDef {
    return WEAPONS[this.weapon.id];
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
    const d = this.def;
    const base = d.hipSpread + (d.aimSpread - d.hipSpread) * this.aim;
    const move = 1 + Math.min(1, m.speed / 6.2) * (this.aim > 0.5 ? 0.7 : 1.3);
    const stance = m.crouching ? 0.75 : 1;
    const air = m.grounded ? 1 : 2.2;
    return base * move * stance * air + this.bloom * d.recoil * 3.2;
  }

  /** Whether a round can be fired now; 'empty' means the trigger clicks dry. */
  fireState(): 'ok' | 'empty' | 'busy' {
    if (this.action === 'draw' || this.action === 'melee' || this.action === 'bandage') return 'busy';
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
    if (this.action !== 'idle') return false;
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
    if (this.action === 'melee' || this.action === 'bandage') return false;
    this.cancelReload();
    this.active = slot;
    this.action = 'draw';
    this.actionTotal = this.actionT = this.def.draw;
    this.cooldown = Math.max(this.cooldown, 0);
    return true;
  }

  startMelee(): boolean {
    if (this.action === 'melee' || this.action === 'bandage') return false;
    this.cancelReload();
    this.interruptedSlot = this.action === 'draw' ? this.active : null;
    this.action = 'melee';
    this.actionTotal = this.actionT = COMBAT.meleeDuration;
    this.meleeHitPending = true;
    return true;
  }

  startBandage(): boolean {
    if (this.action === 'melee' || this.action === 'bandage') return false;
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
  replacePrimary(id: WeaponId): void {
    const old = this.primary;
    const od = WEAPONS[old.id];
    const share = clamp((old.mag + old.reserve) / (od.magazine + od.startReserve), 0, 1);
    const nd = WEAPONS[id];
    const total = Math.round(share * (nd.magazine + nd.startReserve));
    const mag = Math.min(nd.magazine, total);
    this.primary = { id, mag, reserve: total - mag };
    if (this.active === 'primary') {
      this.cancelReload();
      this.action = 'draw';
      this.actionTotal = this.actionT = nd.draw;
    }
  }

  /** Adds rounds to a weapon's reserve up to its carry limit; returns how many fit. */
  addReserve(slot: 'primary' | 'secondary', rounds: number): number {
    const w = slot === 'primary' ? this.primary : this.secondary;
    const room = Math.max(0, WEAPONS[w.id].maxReserve - w.reserve);
    const take = Math.min(room, rounds);
    w.reserve += take;
    return take;
  }

  step(dt: number, aiming: boolean, out: ArsenalTick[]): void {
    this.cooldown -= dt;
    if (this.cooldown < -0.05) this.cooldown = -0.05;
    this.bloom = Math.max(0, this.bloom - dt * (this.cooldown > -0.04 ? 0.9 : 2.4));
    const canAim = aiming && this.action !== 'melee' && this.action !== 'bandage' && this.action !== 'draw';
    this.aim = clamp(this.aim + (canAim ? dt : -dt) / COMBAT.aimTime, 0, 1);
    if (this.action === 'idle') return;
    this.actionT -= dt;
    if (this.action === 'melee') {
      const elapsed = this.actionTotal - this.actionT;
      if (this.meleeHitPending && elapsed >= COMBAT.meleeWindup) {
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
