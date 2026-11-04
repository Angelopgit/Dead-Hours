import { rng } from './math';
import type { SimEvent } from './events';
import type { Simulation } from './Simulation';

/**
 * Night goals: three team goals picked from the night's seed, so every night asks for something a
 * little different. They are counted from the simulation's own events (on the server online, in
 * the browser solo), progress goes out in each snapshot (`ct`), and finishing one gives everyone
 * in the night a goal on their stats, which `runXp` pays out (XP.goal each).
 */

export type GoalKind = 'boards' | 'headshots' | 'melee' | 'arms' | 'screamers' | 'hordes' | 'drops' | 'raiders' | 'blasts' | 'brutes';

/** Index table for the wire format (append only). */
export const GOAL_KINDS: GoalKind[] = ['boards', 'headshots', 'melee', 'arms', 'screamers', 'hordes', 'drops', 'raiders', 'blasts', 'brutes'];

interface GoalDef {
  /** What the goal card says, with the target filled in. */
  text: (n: number) => string;
  /** Solo target; each survivor after the first adds `perPlayer`. */
  target: number;
  perPlayer: number;
}

export const GOALS: Record<GoalKind, GoalDef> = {
  boards: { text: (n) => `Nail up ${n} boards`, target: 8, perPlayer: 2 },
  headshots: { text: (n) => `Kill ${n} with head shots`, target: 20, perPlayer: 10 },
  melee: { text: (n) => `Kill ${n} up close with a blade, a bat or an arm`, target: 12, perPlayer: 6 },
  arms: { text: (n) => `Tear off ${n} arms`, target: 10, perPlayer: 4 },
  screamers: { text: (n) => `Kill ${n} screamers`, target: 3, perPlayer: 1 },
  hordes: { text: (n) => (n === 1 ? 'Hold off a horde' : `Hold off ${n} hordes`), target: 2, perPlayer: 0 },
  drops: { text: (n) => (n === 1 ? 'Empty a supply drop' : `Empty ${n} supply drops`), target: 2, perPlayer: 0 },
  raiders: { text: () => 'Take out the raiders', target: 1, perPlayer: 0 },
  blasts: { text: (n) => `Kill ${n} with grenades or fire`, target: 12, perPlayer: 4 },
  brutes: { text: (n) => (n === 1 ? 'Put down a brute' : `Put down ${n} brutes`), target: 2, perPlayer: 1 },
};

export interface Goal {
  kind: GoalKind;
  progress: number;
  target: number;
}

export const GOALS_PER_NIGHT = 3;

export class Contracts {
  readonly goals: Goal[];
  /** A copy kept in step from snapshots (online clients): counts nothing itself. */
  mirrored = false;
  private scaled = false;

  constructor(private readonly sim: Simulation, seed: number) {
    const r = rng(((seed * 2246822519) >>> 0) || 1);
    // Always one to do before they come (boarding up), then two others, never the same twice.
    const pool = GOAL_KINDS.filter((k) => k !== 'boards');
    const picked: GoalKind[] = ['boards'];
    while (picked.length < GOALS_PER_NIGHT && pool.length) picked.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
    this.goals = picked.map((kind) => ({ kind, progress: 0, target: GOALS[kind].target }));
  }

  text(g: Goal): string {
    return GOALS[g.kind].text(g.target);
  }

  done(g: Goal): boolean {
    return g.progress >= g.target;
  }

  /** Targets grow with the team, set once when the outbreak begins (players have joined by then). */
  private scale(): void {
    if (this.scaled) return;
    this.scaled = true;
    const extra = Math.max(0, this.sim.players.size - 1);
    for (const g of this.goals) {
      if (this.done(g)) continue;
      g.target = Math.max(g.progress, GOALS[g.kind].target + GOALS[g.kind].perPlayer * extra);
    }
  }

  /** Counts one event towards the goals (Simulation.emit calls it for every event). */
  observe(e: SimEvent): void {
    if (this.mirrored || this.sim.phase === 'over') return;
    if (e.type === 'phase' && e.phase === 'survival') this.scale();
    for (const g of this.goals) {
      if (this.done(g)) continue;
      const n = this.counts(g.kind, e);
      if (!n) continue;
      g.progress = Math.min(g.target, g.progress + n);
      if (this.done(g)) this.finish(g);
    }
  }

  private counts(kind: GoalKind, e: SimEvent): number {
    switch (kind) {
      case 'boards': return e.type === 'barricade' && e.change === 'nailed' && e.player !== null ? 1 : 0;
      case 'headshots': return e.type === 'zombieDied' && e.zone === 'head' && !e.cause ? 1 : 0;
      case 'melee': return e.type === 'zombieHit' && e.killed && e.melee ? 1 : 0;
      case 'arms': return e.type === 'limbSevered' && (e.arm === 'armL' || e.arm === 'armR') ? 1 : 0;
      case 'screamers': return e.type === 'zombieDied' && this.kindOf(e.zombie) === 'screamer' ? 1 : 0;
      case 'brutes': return e.type === 'zombieDied' && this.kindOf(e.zombie) === 'brute' ? 1 : 0;
      case 'hordes': return e.type === 'horde' && e.stage === 'over' ? 1 : 0;
      case 'drops': return e.type === 'supplyDrop' && e.stage === 'empty' ? 1 : 0;
      case 'raiders': return e.type === 'raiderDied' && e.left === 0 ? 1 : 0;
      case 'blasts': return e.type === 'zombieDied' && (e.cause === 'blast' || e.cause === 'fire') ? 1 : 0;
    }
  }

  private kindOf(id: number): string | undefined {
    return this.sim.zombies.find((z) => z.id === id)?.kind;
  }

  private finish(g: Goal): void {
    for (const p of this.sim.players.values()) p.stats.goals++;
    const left = this.goals.filter((x) => !this.done(x)).length;
    this.sim.emit({
      type: 'notice', player: null, text: 'GOAL DONE',
      sub: `${this.text(g)}. ${left ? `${left} to go tonight.` : 'That was the last one tonight.'}`,
    });
  }

  /** For a snapshot: [kind, progress, target] for each goal. */
  pack(): number[] {
    return this.goals.flatMap((g) => [GOAL_KINDS.indexOf(g.kind), g.progress, g.target]);
  }

  /** From a snapshot (online clients). */
  sync(ct: number[]): void {
    const goals: Goal[] = [];
    for (let i = 0; i + 2 < ct.length; i += 3) {
      const kind = GOAL_KINDS[ct[i]];
      if (kind) goals.push({ kind, progress: ct[i + 1], target: ct[i + 2] });
    }
    if (goals.length) this.goals.splice(0, this.goals.length, ...goals);
  }
}
