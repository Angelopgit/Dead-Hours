import gsap from 'gsap';
import type { PlayerStats } from '@dead-hours/shared';
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

/** End of a solo run: how long you lasted, what you did, and the way back in. */
export class ResultsScreen {
  readonly el: HTMLElement;

  constructor(r: RunSummary, onRetry: () => void, onMenu: () => void) {
    const s = r.stats;
    const acc = s.shotsFired > 0 ? `${Math.round((s.shotsHit / s.shotsFired) * 100)}%` : '—';
    const cell = (label: string, v: string) => h('div', {}, label, h('b', {}, v));
    let done = false;
    const item = (label: string, fn: () => void) =>
      h('button', {
        class: 'menu-item',
        onmouseenter: () => audio.ui('hover'),
        onclick: () => {
          if (done) return;
          done = true;
          audio.ui('click');
          fn();
        },
      }, label);
    this.el = h('div', { class: 'results', role: 'dialog', 'aria-label': 'Results' },
      h('div', { class: 'results-main' },
        h('h1', { class: 'title' }, 'YOU DIED'),
        h('div', { class: 'subtitle' }, r.outbreak ? 'Maple Hollow belongs to them now.' : 'The outbreak had not even begun.'),
        h('div', { class: 'results-time' }, 'SURVIVED', h('b', {}, clock(r.survived))),
        h('div', { class: 'results-stats' },
          cell('KILLS', String(s.kills)),
          cell('HEADSHOTS', String(s.headshots)),
          cell('ACCURACY', acc),
          cell('DAMAGE DEALT', String(Math.round(s.damageDealt))),
          cell('SUPPLIES', String(s.suppliesCollected)),
          cell('TIME IN SESSION', clock(r.total)),
        ),
        h('nav', { class: 'menu-list' },
          item('RETRY', onRetry),
          item('MAIN MENU', onMenu),
        ),
      ),
    );
  }

  show(parent: HTMLElement): void {
    parent.append(this.el);
    const main = this.el.querySelector('.results-main');
    gsap.fromTo(this.el, { opacity: 0 }, { opacity: 1, duration: 1.2, ease: 'power2.out' });
    if (main) gsap.fromTo(main.children, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, stagger: 0.12, delay: 0.4, ease: 'power2.out' });
  }

  dispose(): void {
    gsap.killTweensOf(this.el);
    const main = this.el.querySelector('.results-main');
    if (main) gsap.killTweensOf(main.children);
    this.el.remove();
  }
}
