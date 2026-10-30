import gsap from 'gsap';
import type { OverMsg, PlayerStats } from '@dead-hours/shared';
import { h } from './dom';
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

const placeText = (r: RunRanks): string => [
  r.rankSurvival ? `#${r.rankSurvival} LONGEST SURVIVAL` : '',
  r.rankKills ? `#${r.rankKills} MOST KILLS` : '',
].filter(Boolean).join(' · ');

/** End of a run: how long you lasted, what you did, and what to do next. */
export class ResultsScreen {
  readonly el: HTMLElement;
  private readonly ranks = h('div', { class: 'results-ranks' });

  constructor(r: RunSummary, actions: [string, () => void][], subtitle?: string) {
    const s = r.stats;
    const acc = s.shotsFired > 0 ? `${Math.round((s.shotsHit / s.shotsFired) * 100)}%` : '—';
    const cell = (label: string, v: string) => h('div', {}, label, h('b', {}, v));
    this.el = h('div', { class: 'results', role: 'dialog', 'aria-label': 'Results' },
      h('div', { class: 'results-main' },
        h('h1', { class: 'title' }, 'YOU DIED'),
        h('div', { class: 'subtitle' }, subtitle ?? (r.outbreak ? 'Maple Hollow belongs to them now.' : 'The outbreak had not even begun.')),
        h('div', { class: 'results-time' }, 'SURVIVED', h('b', {}, clock(r.survived)), this.ranks),
        h('div', { class: 'results-stats' },
          cell('KILLS', String(s.kills)),
          cell('HEADSHOTS', String(s.headshots)),
          cell('ACCURACY', acc),
          cell('DAMAGE DEALT', String(Math.round(s.damageDealt))),
          cell('SUPPLIES', String(s.suppliesCollected)),
          cell('ARMS TORN OFF', String(s.limbsSevered)),
          cell('ARM KILLS', String(s.limbKills)),
          cell('DAMAGE TAKEN', String(Math.round(s.damageTaken))),
          cell('TIME IN SESSION', clock(r.total)),
        ),
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

  show(parent: HTMLElement): void {
    parent.append(this.el);
    reveal(this.el);
  }

  dispose(): void {
    gsap.killTweensOf(this.ranks);
    conceal(this.el);
  }
}

/** End of an online night: every survivor's run side by side, with leaderboard places. */
export class TeamResults {
  readonly el: HTMLElement;

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
      );
    });
    this.el = h('div', { class: 'results', role: 'dialog', 'aria-label': 'Results' },
      h('div', { class: 'results-main team' },
        h('h1', { class: 'title' }, 'NIGHT OVER'),
        h('div', { class: 'subtitle' }, best > 0 ? `The last of you fell after ${clock(best)}.` : 'None of you saw the outbreak through.'),
        h('div', { class: 'team-table' }, ...rows),
        actionList(actions),
      ),
    );
  }

  show(parent: HTMLElement): void {
    parent.append(this.el);
    reveal(this.el);
  }

  dispose(): void {
    conceal(this.el);
  }
}
