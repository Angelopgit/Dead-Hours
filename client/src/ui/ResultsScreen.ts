import gsap from 'gsap';
import { hordeAt, levelFor, runXp, unlockedBetween, type OverMsg, type PlayerStats } from '@dead-hours/shared';
import { h } from './dom';
import { levelBar } from './GunsmithPanel';
import { clock } from './HUD';
import { audio } from '../audio/AudioEngine';

export interface RunSummary {
  /** Seconds survived after the outbreak began (0 if it never did). */
  survived: number;
  /** Seconds in the session overall, preparation included. */
  total: number;
  stats: PlayerStats;
  outbreak: boolean;
}

/** Places on the boards a run reached. */
export interface RunRanks {
  rankSurvival: number | null;
  rankKills: number | null;
}

/** Menu buttons that each work once (the screen is on its way out after a click). */
function actionList(actions: [string, () => void][]): HTMLElement {
  let done = false;
  return h('nav', { class: 'menu-list' }, ...actions.map(([label, fn]) =>
    h('button', {
      class: 'menu-item',
      onmouseenter: () => audio.ui('hover'),
      onclick: () => {
        if (done) return;
        done = true;
        audio.ui('click');
        fn();
      },
    }, label)));
}

function reveal(el: HTMLElement): void {
  const main = el.querySelector('.results-main');
  gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 1.2, ease: 'power2.out' });
  if (main) gsap.fromTo(main.children, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, stagger: 0.12, delay: 0.4, ease: 'power2.out' });
}

function conceal(el: HTMLElement): void {
  gsap.killTweensOf(el);
  const main = el.querySelector('.results-main');
  if (main) gsap.killTweensOf(main.children);
  el.remove();
}

/**
 * What a run earned: the XP and where it came from, the level bar after it, and anything the
 * new level unlocked.
 */
function xpLine(el: HTMLElement, gained: number, before: number, after: number, run: { survived: number; stats: PlayerStats }, offline: boolean): void {
  if (gained <= 0) {
    el.textContent = offline ? '' : 'NO XP SAVED FOR THIS RUN';
    return;
  }
  const parts = runXp(run.survived, run.stats).parts.map((p) => `${p.label} +${p.xp}`).join(' · ');
  const from = levelFor(before), to = levelFor(after);
  const opened = unlockedBetween(from, to);
  el.replaceChildren(
    h('span', { class: 'xp-gain' }, `+${gained.toLocaleString()} XP`),
    ...(to > from ? [h('span', {}, `LEVEL UP · ${to}`)] : []),
    ...(offline ? [h('span', {}, ' · SAVED IN THIS BROWSER (OFFLINE)')] : []),
    h('span', { class: 'xp-parts' }, parts),
    levelBar(after),
    ...(opened.length ? [h('span', { class: 'xp-unlocks' }, `UNLOCKED: ${opened.map((o) => o.label.toUpperCase()).join(' · ')} — FIT THEM IN THE LOADOUT OR WITH THE GUNSMITH`)] : []),
  );
  gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.6 });
}

const placeText = (r: RunRanks): string => [
  r.rankSurvival ? `#${r.rankSurvival} LONGEST SURVIVAL` : '',
  r.rankKills ? `#${r.rankKills} MOST KILLS` : '',
].filter(Boolean).join(' · ');

/** How many horde waves a survival time outlasted, as a line. */
function hordeLine(survived: number): string {
  const n = hordeAt(survived).survived;
  return n === 0 ? 'No horde held off' : n === 1 ? '1 horde held off' : `${n} hordes held off`;
}

/** End of a run: how long you lasted, what you did, and what to do next. */
export class ResultsScreen {
  readonly el: HTMLElement;
  private readonly ranks = h('div', { class: 'results-ranks' });
  private readonly xp = h('div', { class: 'results-xp' });

  constructor(r: RunSummary, actions: [string, () => void][], subtitle?: string) {
    const s = r.stats;
    const acc = s.shotsFired > 0 ? `${Math.round((s.shotsHit / s.shotsFired) * 100)}%` : '—';
    const cell = (label: string, v: string) => h('div', {}, label, h('b', {}, v));
    this.el = h('div', { class: 'results', role: 'dialog', 'aria-label': 'Results' },
      h('div', { class: 'results-main' },
        h('h1', { class: 'title' }, 'YOU DIED'),
        h('div', { class: 'subtitle' }, subtitle ?? (r.outbreak ? 'Maple Hollow belongs to them now.' : 'The outbreak had not even begun.')),
        h('div', { class: 'results-time' }, 'SURVIVED', h('b', {}, clock(r.survived)), h('div', { class: 'results-hordes' }, hordeLine(r.outbreak ? r.survived : 0)), this.ranks),
        h('div', { class: 'results-stats' },
          cell('KILLS', String(s.kills)),
          cell('HEADSHOTS', String(s.headshots)),
          cell('ACCURACY', acc),
          cell('DAMAGE DEALT', String(Math.round(s.damageDealt))),
          cell('SUPPLIES', String(s.suppliesCollected)),
          cell('ARMS TORN OFF', String(s.limbsSevered)),
          cell('ARM KILLS', String(s.limbKills)),
          ...(s.revives ? [cell('REVIVES', String(s.revives))] : []),
          cell('DAMAGE TAKEN', String(Math.round(s.damageTaken))),
          cell('TIME IN SESSION', clock(r.total)),
        ),
        this.xp,
        actionList(actions),
      ),
    );
  }

  /** Where the run landed on the leaderboards, once the server has answered. */
  setRanks(r: RunRanks): void {
    const t = placeText(r);
    if (!t) return;
    this.ranks.textContent = t;
    gsap.fromTo(this.ranks, { opacity: 0 }, { opacity: 1, duration: 0.6 });
  }

  setXp(gained: number, before: number, after: number, run: { survived: number; stats: PlayerStats }, offline = false): void {
    xpLine(this.xp, gained, before, after, run, offline);
  }

  show(parent: HTMLElement): void {
    parent.append(this.el);
    reveal(this.el);
  }

  dispose(): void {
    gsap.killTweensOf(this.ranks);
    gsap.killTweensOf(this.xp);
    conceal(this.el);
  }
}

/** End of an online night: every survivor's run side by side, with leaderboard places. */
export class TeamResults {
  readonly el: HTMLElement;
  private readonly xp = h('div', { class: 'results-xp' });

  constructor(over: OverMsg, me: string, actions: [string, () => void][]) {
    const best = over.results.reduce((a, r) => Math.max(a, r.survived), 0);
    const rows = over.results.map((r) => {
      const place = placeText(r);
      return h('div', { class: `team-row ${r.id === me ? 'me' : ''}` },
        h('div', { class: 'team-name' }, r.name.toUpperCase(), place ? h('small', {}, place) : null),
        h('div', {}, 'SURVIVED', h('b', {}, clock(r.survived))),
        h('div', {}, 'KILLS', h('b', {}, String(r.stats.kills))),
        h('div', {}, 'HEADSHOTS', h('b', {}, String(r.stats.headshots))),
        h('div', {}, 'ARMS', h('b', {}, String(r.stats.limbsSevered))),
        h('div', {}, 'XP', h('b', {}, r.xp ? `+${r.xp}` : '—')),
      );
    });
    this.el = h('div', { class: 'results', role: 'dialog', 'aria-label': 'Results' },
      h('div', { class: 'results-main team' },
        h('h1', { class: 'title' }, 'NIGHT OVER'),
        h('div', { class: 'subtitle' }, best > 0 ? `The last of you fell after ${clock(best)}. ${hordeLine(best)}.` : 'None of you saw the outbreak through.'),
        h('div', { class: 'team-table' }, ...rows),
        this.xp,
        actionList(actions),
      ),
    );
  }

  /** This player's XP and level once the server has the new total. */
  setXp(gained: number, before: number, after: number, run: { survived: number; stats: PlayerStats }): void {
    xpLine(this.xp, gained, before, after, run, false);
  }

  show(parent: HTMLElement): void {
    parent.append(this.el);
    reveal(this.el);
  }

  dispose(): void {
    gsap.killTweensOf(this.xp);
    conceal(this.el);
  }
}
