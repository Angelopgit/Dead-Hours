import gsap from 'gsap';
import { h } from './dom';
import { SettingsPanel } from './SettingsPanel';
import { audio } from '../audio/AudioEngine';
import type { Input } from '../core/Input';

export class PauseMenu {
  readonly el: HTMLElement;
  private panel: HTMLElement | null = null;
  private readonly main: HTMLElement;

  constructor(private readonly input: Input, onResume: () => void, onQuit: () => void) {
    const item = (label: string, fn: () => void) =>
      h('button', { class: 'menu-item', onmouseenter: () => audio.ui('hover'), onclick: () => { audio.ui('click'); fn(); } }, label);
    this.main = h('div', { class: 'menu-main' },
      h('h1', { class: 'title' }, 'PAUSED'),
      h('div', { class: 'subtitle' }, 'The night does not wait.'),
      h('nav', { class: 'menu-list' },
        item('RESUME', onResume),
        item('SETTINGS', () => this.openSettings()),
        item('QUIT TO MENU', onQuit),
      ),
    );
    this.el = h('div', { class: 'pause' }, this.main);
  }

  private openSettings(): void {
    this.panel?.remove();
    this.panel = new SettingsPanel(this.input, () => { this.panel?.remove(); this.panel = null; }).el;
    this.el.append(this.panel);
    gsap.fromTo(this.panel, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.4, ease: 'power3.out' });
  }

  get settingsOpen(): boolean {
    return this.panel !== null;
  }

  closeSettings(): void {
    this.panel?.remove();
    this.panel = null;
  }

  show(parent: HTMLElement): void {
    parent.append(this.el);
    gsap.fromTo(this.el, { opacity: 0 }, { opacity: 1, duration: 0.25 });
  }

  hide(): void {
    this.closeSettings();
    this.el.remove();
  }
}
