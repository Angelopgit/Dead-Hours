import gsap from 'gsap';
import { h } from './dom';
import { codeLabel } from '../core/Input';
import { settings, type Action } from '../core/Settings';

/** Minimal in-game HUD: vitals, crosshair, interaction prompt, contextual notices, FPS. */
export class HUD {
  readonly el: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly lag: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly stance: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hp: HTMLElement;
  private promptKey = '';
  private health = 100;

  constructor(name: string) {
    this.fill = h('div', { class: 'fill', style: 'width:100%' });
    this.lag = h('div', { class: 'lag', style: 'width:100%' });
    this.hp = h('span', {}, '100');
    this.prompt = h('div', { class: 'prompt' });
    this.notice = h('div', { class: 'notice', style: 'opacity:0' });
    this.stance = h('div', { class: 'stance' });
    this.fps = h('div', { class: 'fps' });
    this.crosshair = h('div', { class: 'crosshair' },
      h('i', { class: 'dot' }), h('i', { class: 'l' }), h('i', { class: 'r' }), h('i', { class: 't' }), h('i', { class: 'b' }));
    this.el = h('div', { class: 'hud' },
      this.crosshair,
      this.prompt,
      this.notice,
      h('div', { class: 'vitals' },
        h('div', { class: 'name' }, h('span', {}, name.toUpperCase()), this.hp),
        h('div', { class: 'hbar' }, this.lag, this.fill),
        this.stance,
      ),
      this.fps,
    );
    this.setSpread(0);
  }

  setHealth(v: number, max: number): void {
    if (v === this.health) return;
    const pct = Math.max(0, v / max) * 100;
    const dropped = v < this.health;
    this.health = v;
    this.hp.textContent = String(Math.ceil(v));
    gsap.to(this.fill, { width: `${pct}%`, duration: 0.2 });
    gsap.to(this.lag, { width: `${pct}%`, duration: 0.8, delay: dropped ? 0.35 : 0, ease: 'power2.out' });
  }

  /** Crosshair gap in pixels from movement/aim state. */
  setSpread(px: number): void {
    const g = 5 + px;
    const [, l, r, t, b] = Array.from(this.crosshair.children) as HTMLElement[];
    l.style.transform = `translateX(${-g - 7}px)`;
    r.style.transform = `translateX(${g}px)`;
    t.style.transform = `translateY(${-g - 7}px)`;
    b.style.transform = `translateY(${g}px)`;
  }

  setStance(text: string): void {
    if (this.stance.textContent !== text) this.stance.textContent = text;
  }

  setPrompt(action: Action | null, text = ''): void {
    const key = action ? `${action}:${text}` : '';
    if (key === this.promptKey) return;
    this.promptKey = key;
    if (!action) {
      this.prompt.classList.remove('show');
      return;
    }
    const code = settings.value.controls.bindings[action][0];
    this.prompt.replaceChildren(h('span', { class: 'k' }, code ? codeLabel(code) : '?'), text);
    this.prompt.classList.add('show');
  }

  /** Top-center contextual message, e.g. location titles or SUPPLY HELICOPTER INBOUND. */
  notify(title: string, sub = '', hold = 2.6): void {
    this.notice.replaceChildren(title, sub ? h('small', {}, sub) : '');
    gsap.killTweensOf(this.notice);
    gsap.timeline()
      .fromTo(this.notice, { opacity: 0, letterSpacing: '0.6em' }, { opacity: 1, letterSpacing: '0.4em', duration: 0.9, ease: 'power2.out' })
      .to(this.notice, { opacity: 0, duration: 1.2, delay: hold });
  }

  setFps(fps: number): void {
    this.fps.textContent = settings.value.graphics.showFps ? `${Math.round(fps)} FPS` : '';
  }

  setVisible(v: boolean): void {
    gsap.to(this.el, { opacity: v ? 1 : 0, duration: 0.4 });
  }

  dispose(): void {
    gsap.killTweensOf([this.notice, this.fill, this.lag, this.el]);
    this.el.remove();
  }
}
