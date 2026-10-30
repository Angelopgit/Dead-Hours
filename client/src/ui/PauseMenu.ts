import gsap from 'gsap';
import { h } from './dom';
import { SettingsPanel } from './SettingsPanel';
import { audio } from '../audio/AudioEngine';
import type { Input } from '../core/Input';
import type { NetLink } from '../network/NetLink';
import { playerComms } from './PlayerComms';

export class PauseMenu {
  readonly el: HTMLElement;
  private panel: HTMLElement | null = null;
  private readonly main: HTMLElement;
  private refresh: ReturnType<typeof setInterval> | null = null;

  /** Online the night goes on behind the menu, quitting means leaving the room, and PLAYERS has voice and chat controls. */
  constructor(private readonly input: Input, onResume: () => void, onQuit: () => void, online = false, private readonly link: NetLink | null = null) {
    const item = (label: string, fn: () => void) =>
      h('button', { class: 'menu-item', onmouseenter: () => audio.ui('hover'), onclick: () => { audio.ui('click'); fn(); } }, label);
    this.main = h('div', { class: 'menu-main' },
      h('h1', { class: 'title' }, 'PAUSED'),
      h('div', { class: 'subtitle' }, online ? 'The others play on. So do they.' : 'The night does not wait.'),
      h('nav', { class: 'menu-list' },
        item('RESUME', onResume),
        link ? item('PLAYERS', () => this.openPlayers()) : null,
        item('SETTINGS', () => this.openSettings()),
        item(online ? 'LEAVE GAME' : 'QUIT TO MENU', onQuit),
      ),
    );
    this.el = h('div', { class: 'pause' }, this.main);
  }

  /** Everyone in the room: speaking lights, voice mute and volume, hiding chat, blocking. */
  private openPlayers(): void {
    const link = this.link;
    if (!link) return;
    this.closeSettings();
    const list = h('div', { class: 'lobby-list' });
    const draw = () => {
      const rows = (link.lobby?.players ?? []).map((p) => {
        const c = playerComms(link, p, draw);
        return { el: h('div', { class: 'lobby-entry' }, h('div', { class: 'lobby-player' }, h('span', {}, p.name.toUpperCase()), p.id === link.id ? h('em', { class: 'dim' }, 'YOU') : null), c.el), refresh: c.refresh };
      });
      list.replaceChildren(...rows.map((r) => r.el));
      if (this.refresh) clearInterval(this.refresh);
      this.refresh = setInterval(() => rows.forEach((r) => r.refresh()), 150);
    };
    draw();
    this.panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Players' },
      h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); this.closeSettings(); } }, 'CLOSE ✕'),
      h('h2', {}, 'PLAYERS'),
      list,
      h('p', { class: 'lobby-hint' }, 'Blocking keeps a player\'s chat and voice away from you, and yours from them, in every game. Unblock in Settings → Voice.'),
    );
    this.el.append(this.panel);
    gsap.fromTo(this.panel, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.4, ease: 'power3.out' });
  }

  private openSettings(): void {
    this.closeSettings();
    this.panel = new SettingsPanel(this.input, () => { this.panel?.remove(); this.panel = null; }).el;
    this.el.append(this.panel);
    gsap.fromTo(this.panel, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.4, ease: 'power3.out' });
  }

  get settingsOpen(): boolean {
    return this.panel !== null;
  }

  closeSettings(): void {
    if (this.refresh) clearInterval(this.refresh);
    this.refresh = null;
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
