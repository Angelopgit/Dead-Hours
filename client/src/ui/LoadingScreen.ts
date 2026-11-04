import gsap from 'gsap';
import { GAME } from '@dead-hours/shared';
import { h } from './dom';

/** What is being got ready, in order, and roughly how much of the wait each one is. */
export const LOAD_STEPS = {
  sounds: { label: 'Loading the sounds', weight: 0.25 },
  /** The night's scene, every zombie body included (GameSession's constructor). */
  night: { label: 'Building the street', weight: 0.2 },
  shaders: { label: 'Getting the lights and the dead ready', weight: 0.4 },
  textures: { label: 'Loading the textures', weight: 0.1 },
  ready: { label: 'Ready', weight: 0.05 },
} as const;
export type LoadStep = keyof typeof LOAD_STEPS;
const ORDER = Object.keys(LOAD_STEPS) as LoadStep[];

/** One of these is read out while a night loads. Keep them true to the tuning (shared/src/config). */
export const TIPS = [
  'A bandage takes 2.6 seconds and gives back 40 health. You can\'t shoot while you wrap it.',
  'Board the ground-floor windows before the first horde. They pound on boards before they get through.',
  'A suppressor lets you shoot without calling every zombie on the street.',
  'Brutes take most of a magazine. Back off while you shoot, and don\'t let them corner you.',
  'Screamers call the others. A single hit cuts the scream short.',
  'Every few minutes the dead fall back for a while. Use the quiet to restock and heal.',
  'Shoot an arm off a zombie and pick it up. It makes a decent club.',
  'Take a crawler\'s legs and it still comes for you. Finish it.',
  'Supply drops refill every gun you carry. The rare ones bring something better.',
  'A van of armed raiders comes later in the night. Their van has supplies in the back.',
  'A downed teammate can be picked up. Get to them and hold interact.',
  'Wooden doors stop zombies, not bullets. You can shoot through them.',
];

/**
 * Full-screen loading card shown while a night is got ready (sounds, the night's scene, shaders,
 * textures) so nothing loads mid-fight. Sits over the fade and the menu, swallows clicks, and
 * reads out as a progress bar to assistive tech.
 */
export class LoadingScreen {
  readonly el: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly status: HTMLElement;
  private shown = 0;

  /** `backdrop`: the menu street as it was when the night was picked, shown dark behind the card. */
  constructor(caption: string, backdrop: HTMLCanvasElement | null = null, tip = TIPS[Math.floor(Math.random() * TIPS.length)]) {
    this.fill = h('div', { class: 'loading-fill' });
    this.bar = h('div', { class: 'loading-bar', role: 'progressbar', 'aria-label': 'Loading', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, this.fill);
    this.status = h('div', { class: 'loading-status' }, LOAD_STEPS.sounds.label);
    if (backdrop) backdrop.className = 'loading-backdrop';
    this.el = h('div', { class: 'loading' },
      backdrop,
      h('div', { class: 'loading-card' },
        h('div', { class: 'loading-title' }, GAME.town.toUpperCase()),
        h('div', { class: 'loading-caption' }, caption),
        h('p', { class: 'loading-tip' }, tip),
        this.bar,
        this.status,
      ),
    );
  }

  /** Fades in by CSS, which keeps running while the page is busy building the night. */
  show(): void {
    document.body.append(this.el);
  }

  /** `step` is `f` (0..1) done: the bar shows the steps before it as done. */
  step(step: LoadStep, f: number): void {
    let at = 0;
    for (const s of ORDER) {
      if (s === step) break;
      at += LOAD_STEPS[s].weight;
    }
    const total = Math.min(1, at + LOAD_STEPS[step].weight * Math.min(1, Math.max(0, f)));
    // Never goes backwards (a step can report a smaller fraction than a fast one before it).
    this.shown = Math.max(this.shown, total);
    const pct = Math.round(this.shown * 100);
    this.fill.style.transform = `scaleX(${this.shown})`;
    this.bar.setAttribute('aria-valuenow', String(pct));
    const text = step === 'ready' ? LOAD_STEPS.ready.label : `${LOAD_STEPS[step].label}… ${pct}%`;
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  hide(): void {
    gsap.to(this.el, { opacity: 0, duration: 0.35, onComplete: () => this.el.remove() });
  }
}
