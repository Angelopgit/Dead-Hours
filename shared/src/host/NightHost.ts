import type { WeaponBuild } from '../config/progression';
import type { WeaponId } from '../config/weapons';
import { C2S, S2C, type BeginMsg, type HostMember, type HostRun } from '../protocol/messages';
import { Night, type NightWorld } from './Night';

/** Where a host's messages go: one message for some of the players (by id). */
export interface HostOut {
  send(to: readonly string[], type: string, msg: unknown): void;
}

interface Seat {
  member: HostMember;
  /** Has the night's scene up: snapshots and events go only to loaded players (no backlog while it builds). */
  loaded: boolean;
  spawn: BeginMsg['spawn'];
  /** Survival seconds already gone when they dropped into this night (0: there from the start). */
  joinedAt: number;
  /** This night's run once it ended for them (died with everyone, or left). */
  run: HostRun | null;
}

/**
 * Whoever runs a night for a room: starts it, lets latecomers drop in, takes each player's moves
 * and actions, steps it, sends everyone the events and snapshots, and counts each survivor's run.
 * The game server's rooms use it, and so does the worker in a player host's browser, so a night
 * plays the same wherever it is hosted. It knows nothing of lobbies, sockets or leaderboards.
 */
export class NightHost {
  night: Night | null = null;
  /** A night is under way (false again once it is over). */
  playing = false;
  /** A survivor's refit that went through (kept for their next night by whoever keeps the room). */
  onRefit: ((id: string, weapon: WeaponId, build: WeaponBuild) => void) | null = null;
  private readonly seats = new Map<string, Seat>();
  private paused = false;
  /** Everyone with the scene up, kept between steps (rebuilt when someone loads or leaves). */
  private audience: string[] = [];

  /**
   * `world` builds a night's collision world; `debugAllowed` lets test commands through
   * (DEAD_HOURS_DEBUG on the server that keeps the room).
   */
  constructor(private readonly world: () => NightWorld, private readonly out: HostOut, private debugAllowed = false) {}

  setDebug(on: boolean): void {
    this.debugAllowed = on;
  }

  /** Starts a night with these survivors and tells each where they begin. */
  start(members: readonly HostMember[], seed: number): void {
    this.night?.dispose();
    const night = new Night(this.world(), seed);
    night.onRefit = (id, weapon, build) => this.onRefit?.(id, weapon, build);
    this.night = night;
    this.playing = true;
    this.paused = false;
    this.seats.clear();
    this.audience = [];
    let i = 0;
    for (const m of members) this.seats.set(m.id, { member: m, loaded: false, spawn: night.addSurvivor(m, i++), joinedAt: 0, run: null });
    for (const [id, s] of this.seats) this.out.send([id], S2C.begin, { seed, t: night.time, spawn: s.spawn } satisfies BeginMsg);
  }

  /** Puts a player who joined mid-night into it at the safehouse; they load the scene and the stream starts. */
  dropIn(m: HostMember): boolean {
    const night = this.night;
    if (!night || !this.playing || this.seats.has(m.id)) return false;
    const sim = night.sim;
    const seat: Seat = { member: m, loaded: false, spawn: night.addSurvivor(m, sim.players.size), joinedAt: sim.phase === 'survival' ? sim.phaseTime : 0, run: null };
    this.seats.set(m.id, seat);
    this.out.send([m.id], S2C.begin, { seed: night.seed, t: night.time, spawn: seat.spawn, late: true } satisfies BeginMsg);
    return true;
  }

  /** Survival seconds already gone when this player dropped in (0: there from the start, or not in the night). */
  joinedAt(id: string): number {
    return this.seats.get(id)?.joinedAt ?? 0;
  }

  /** One of a player's messages about the night (loaded, motion, drive, act, debug); anything else is ignored. */
  message(id: string, type: string, msg: unknown): void {
    const night = this.night;
    const seat = this.seats.get(id);
    if (!night || !this.playing || !seat) return;
    switch (type) {
      case C2S.loaded: {
        if (seat.loaded) return;
        seat.loaded = true;
        this.audience = [...this.seats].filter(([, s]) => s.loaded).map(([k]) => k);
        // Dropped in late (or slow to load): first what is already going on that a snapshot doesn't carry.
        const missed = night.catchUp();
        if (missed.length) this.out.send([id], S2C.ev, missed);
        break;
      }
      case C2S.motion: {
        const back = night.motion(id, msg);
        if (back) this.out.send([id], S2C.pos, back);
        break;
      }
      case C2S.drive: {
        const back = night.drive(id, msg);
        if (back) this.out.send([id], S2C.vpos, back);
        break;
      }
      case C2S.act:
        night.act(id, msg);
        break;
      case C2S.debug:
        if (this.debugAllowed) night.debug(id, msg);
        break;
      default:
        break;
    }
  }

  /** Holds the night still (nothing steps, nothing is sent) until let go: a player host that lost everyone. */
  pause(on: boolean): void {
    this.paused = on;
  }

  /**
   * Runs the steps `ms` of real time call for and sends what they made to everyone loaded.
   * True when the night is over (the clock ran out, or everyone still in it is dead): call finish().
   */
  tick(ms: number): boolean {
    const night = this.night;
    if (!night || !this.playing || this.paused) return false;
    const { events, snapshot } = night.advance(ms / 1000);
    if (this.audience.length) {
      if (events.length) this.out.send(this.audience, S2C.ev, events);
      // (A death is not a finished run here: the next lull can bring them back. Runs are counted
      // when they leave or the night ends.)
      if (snapshot) this.out.send(this.audience, S2C.snap, snapshot);
    }
    return night.sim.phase === 'over' || night.allDead;
  }

  /** How a survivor's night stands right now (null when they aren't in it). */
  standing(id: string): HostRun | null {
    const seat = this.seats.get(id);
    const night = this.night;
    const p = night?.sim.players.get(id);
    if (!seat || !night || !p) return null;
    if (seat.run) return seat.run;
    const sim = night.sim;
    // Seconds since the outbreak (or since they dropped in), at the moment they fell (or now, still
    // alive), less any time spent dead before a lull brought them back.
    const since = p.alive ? 0 : Math.max(0, sim.time - p.diedAt);
    const survived = sim.phase === 'preparation' ? 0 : Math.max(0, sim.phaseTime - since - seat.joinedAt - p.deadTime);
    return { id, survived, stats: { ...p.stats } };
  }

  /** A survivor's run for the night, counted once: when they leave, or when the night ends. */
  record(id: string): HostRun | null {
    const seat = this.seats.get(id);
    if (!seat) return null;
    seat.run ??= this.standing(id);
    return seat.run;
  }

  /** Takes a player out (they left for good). True when that ended the night: nobody alive is left in it. */
  remove(id: string): boolean {
    const night = this.night;
    const had = this.seats.delete(id);
    this.audience = this.audience.filter((k) => k !== id);
    if (!had || !night || !this.playing || !night.sim.players.has(id)) return false;
    night.removeSurvivor(id);
    return night.allDead || night.sim.players.size === 0;
  }

  /** Seconds survived so far (0 before the outbreak, and with no night). */
  get survived(): number {
    const sim = this.night?.sim;
    return this.playing && sim?.phase === 'survival' ? sim.phaseTime : 0;
  }

  /** Horde waves the night has outlasted. */
  get hordes(): number {
    return this.night?.sim.horde.survived ?? 0;
  }

  /** How everyone still in the night stands right now. */
  progress(): HostRun[] {
    const runs: HostRun[] = [];
    for (const id of this.seats.keys()) {
      const r = this.standing(id);
      if (r) runs.push(r);
    }
    return runs;
  }

  /** The night is over: everyone's run, counted. */
  finish(): HostRun[] {
    const runs: HostRun[] = [];
    for (const id of this.seats.keys()) {
      const r = this.record(id);
      if (r) runs.push(r);
    }
    this.playing = false;
    this.audience = [];
    return runs;
  }

  dispose(): void {
    this.playing = false;
    this.night?.dispose();
    this.night = null;
    this.seats.clear();
    this.audience = [];
  }
}
