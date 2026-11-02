import gsap from 'gsap';
import { h } from './dom';

/** What is being got ready, in order, and roughly how much of the wait each one is. */
export const LOAD_STEPS = {
  sounds: { label: 'LOADING SOUNDS', weight: 0.25 },
  /** The night's scene, every zombie body included (GameSession's constructor). */
  night: { label: 'BUILDING THE NIGHT', weight: 0.2 },
  shaders: { label: 'COMPILING SHADERS', weight: 0.4 },
  textures: { label: 'UPLOADING TEXTURES', weight: 0.1 },
  ready: { label: 'READY', weight: 0.05 },
} as const;
export type LoadStep = keyof typeof LOAD_STEPS;
const ORDER = Object.keys(LOAD_STEPS) as LoadStep[];

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

  constructor(caption: string) {
    this.fill = h('div', { class: 'loading-fill' });
    this.bar = h('div', { class: 'loading-bar', role: 'progressbar', 'aria-label': 'Loading', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': 0 }, this.fill);
    this.status = h('div', { class: 'loading-status' }, LOAD_STEPS.sounds.label);
    this.el = h('div', { class: 'loading' },
      h('div', { class: 'loading-card' },
        h('div', { class: 'loading-title' }, 'MAPLE HOLLOW'),
        h('div', { class: 'loading-caption' }, caption),
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
    const text = step === 'ready' ? LOAD_STEPS.ready.label : `${LOAD_STEPS[step].label} · ${pct}%`;
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  hide(): void {
    gsap.to(this.el, { opacity: 0, duration: 0.35, onComplete: () => this.el.remove() });
  }
}
