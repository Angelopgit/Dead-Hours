import gsap from 'gsap';
import { GAME, type BeginMsg } from '@dead-hours/shared';
import { h } from './dom';
import { SettingsPanel } from './SettingsPanel';
import { LoadoutPanel } from './LoadoutPanel';
import { CharacterCreator } from './CharacterCreator';
import { OnlineMenu } from './OnlineMenu';
import { LeaderboardPanel, type Tab } from './LeaderboardPanel';
import { audio } from '../audio/AudioEngine';
import type { Input } from '../core/Input';
import { net } from '../network/Net';
import { account } from '../network/Account';
import type { NetLink } from '../network/NetLink';

export interface MainMenuCallbacks {
  onSolo: () => void;
  /** An online room's host started the night. */
  onBegin: (link: NetLink, begin: BeginMsg) => void;
  /** The character creator covers the street: the game can stop drawing it meanwhile. */
  onCreator?: (open: boolean) => void;
}

/** Cinematic main menu overlay. The 3D street behind it is driven by MenuCinematic. */
export class MainMenu {
  readonly el: HTMLElement;
  private panel: HTMLElement | null = null;
  private panelDispose: (() => void) | null = null;
  private online: OnlineMenu | null = null;
  private creator: CharacterCreator | null = null;
  /** Items that need the game server: enabled only once it has answered. */
  private readonly needServer: HTMLButtonElement[] = [];
  private playOpen = false;
  private readonly sub: HTMLElement;
  private readonly main: HTMLElement;
  private accountItem!: HTMLButtonElement;
  private readonly offAccount: () => void;

  constructor(private readonly input: Input, private readonly cb: MainMenuCallbacks) {
    const item = (label: string, onClick: () => void, opts: { tag?: string; online?: boolean } = {}) => {
      const b: HTMLButtonElement = h('button', {
        class: 'menu-item',
        onmouseenter: () => { if (!b.disabled) audio.ui('hover'); },
        onclick: () => { audio.unlock(); if (!b.disabled) { audio.ui('click'); onClick(); } },
      }, label, h('span', { class: 'tag' }, opts.tag ?? ''));
      if (opts.online) {
        b.dataset.tag = opts.tag ?? '';
        this.needServer.push(b);
      }
      return b;
    };

    this.sub = h('div', { class: 'menu-sub', style: 'height:0' },
      item('SOLO', () => this.cb.onSolo(), { tag: 'SURVIVE ALONE' }),
      item('HOST GAME', () => this.openOnline('host'), { tag: 'PLAY WITH FRIENDS', online: true }),
      item('JOIN GAME', () => this.openOnline('browse'), { tag: 'CODE OR OPEN GAMES', online: true }),
    );

    this.main = h('div', { class: 'menu-main' },
      h('h1', { class: 'title' }, GAME.title),
      h('div', { class: 'subtitle' }, GAME.subtitle),
      h('nav', { class: 'menu-list' },
        item('PLAY', () => this.togglePlay()),
        this.sub,
        item('SURVIVOR', () => this.openCreator(), { tag: 'CUSTOMIZE' }),
        item('LOADOUT', () => this.openPanel(new LoadoutPanel(() => this.closePanel()).el)),
        item('LEADERBOARDS', () => this.openBoards('survival'), { online: true }),
        this.accountItem = item('ACCOUNT', () => this.openBoards('you'), { tag: 'GUEST · SIGN IN', online: true }),
        item('SETTINGS', () => this.openPanel(new SettingsPanel(this.input, () => this.closePanel()).el)),
        item('CREDITS', () => this.openPanel(this.credits())),
      ),
    );

    this.el = h('div', { class: 'menu' },
      h('div', { class: 'menu-shade' }),
      this.main,
      h('div', { class: 'menu-footer' }, 'BUILD 0.4.0 — MAPLE HOLLOW'),
      h('div', { class: 'menu-hint' }, h('span', { class: 'touch' }, 'NEEDS A KEYBOARD AND MOUSE'), 'HEADPHONES RECOMMENDED'),
    );
    window.addEventListener('keydown', this.onKey);
    this.offAccount = account.onChange(() => this.accountTag());
    this.refreshServer(false);
  }

  /** The account item says who is signed in (or that they play as a guest). */
  private accountTag(show = true): void {
    const me = account.signedIn;
    const b = this.accountItem;
    b.dataset.tag = me ? (me.name || 'SIGNED IN').toUpperCase() : 'GUEST · SIGN IN';
    if (show && !b.disabled) b.querySelector('.tag')!.textContent = b.dataset.tag;
  }

  private openBoards(tab: Tab): void {
    const p = new LeaderboardPanel(() => this.closePanel(), tab);
    this.openPanel(p.el, () => p.dispose());
  }

  /** Online items work only with the game server there; until it answers they say why not. */
  private refreshServer(force: boolean): void {
    const set = () => {
      const st = net.status;
      this.accountTag(false);
      for (const b of this.needServer) {
        b.disabled = st !== 'online';
        const tag = b.querySelector('.tag')!;
        tag.textContent = st === 'online' ? b.dataset.tag ?? '' : st === 'unknown' ? 'CONNECTING…' : 'SERVER OFFLINE';
      }
    };
    set();
    void net.check(force).then(() => {
      set();
      if (net.status === 'online') void account.sync();
    });
  }

  private openOnline(start: 'browse' | 'host', link?: NetLink): void {
    const o = new OnlineMenu(start, {
      onBegin: (l, b) => {
        // The room now belongs to the game; the panel goes without leaving it.
        o.release();
        this.closePanel();
        this.cb.onBegin(l, b);
      },
      onClose: () => this.closePanel(),
      onSolo: () => {
        this.closePanel();
        this.cb.onSolo();
      },
    }, link);
    this.online = o;
    this.openPanel(o.el, () => {
      if (this.online === o) this.online = null;
      o.dispose();
    });
  }

  /** A line under the menu for a few seconds (the connection dropped, ...). */
  notice(text: string): void {
    const n = h('div', { class: 'menu-notice' }, text);
    this.el.append(n);
    gsap.fromTo(n, { opacity: 0 }, { opacity: 1, duration: 0.4 });
    gsap.to(n, { opacity: 0, duration: 0.8, delay: 5, onComplete: () => n.remove() });
  }

  /** Back from a night: straight into the room's lobby. */
  openLobby(link: NetLink): void {
    if (!this.playOpen) this.togglePlay();
    this.openOnline('browse', link);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.code !== 'Escape' || !this.el.isConnected || this.input.captureNext) return;
    if (this.creator) this.closeCreator();
    else if (this.online) this.online.back();
    else if (this.panel) this.closePanel();
  };

  private openCreator(): void {
    if (this.creator) return;
    this.closePanel();
    this.creator = new CharacterCreator(() => this.closeCreator());
    this.creator.show(this.el);
    gsap.to([this.main, this.el.querySelector('.menu-footer'), this.el.querySelector('.menu-hint')], { opacity: 0, duration: 0.3 });
    this.main.style.pointerEvents = 'none';
    this.cb.onCreator?.(true);
  }

  private closeCreator(): void {
    const c = this.creator;
    if (!c) return;
    this.creator = null;
    this.cb.onCreator?.(false);
    gsap.to(c.el, { opacity: 0, duration: 0.3, ease: 'power2.in', onComplete: () => c.dispose() });
    gsap.to([this.main, this.el.querySelector('.menu-footer'), this.el.querySelector('.menu-hint')], { opacity: 1, duration: 0.45, delay: 0.1 });
    this.main.style.pointerEvents = '';
  }

  private togglePlay(): void {
    this.playOpen = !this.playOpen;
    gsap.to(this.sub, { height: this.playOpen ? 'auto' : 0, duration: 0.45, ease: 'power3.out' });
    gsap.fromTo(this.sub.children, { opacity: 0, x: -10 }, { opacity: 1, x: 0, stagger: 0.05, duration: 0.4, delay: 0.05, ease: 'power2.out' });
  }

  private credits(): HTMLElement {
    return h('div', { class: 'panel credits' },
      h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); this.closePanel(); } }, 'CLOSE ✕'),
      h('h2', {}, 'CREDITS'),
      h('p', { class: 'role' }, 'Design'), h('p', {}, 'Angelo'),
      h('p', { class: 'role' }, 'Engineering, art & audio'), h('p', {}, 'Built with Claude Code'),
      h('p', { class: 'role' }, 'Technology'), h('p', {}, 'Three.js · Rapier · Colyseus · GSAP · Vite · TypeScript'),
      h('p', { class: 'role' }, 'Audio'), h('p', {}, 'All sound and music is synthesized live with the Web Audio API.'),
      h('p', { class: 'role' }, 'Typefaces'), h('p', {}, 'Oswald (Vernon Adams) · Inter (Rasmus Andersson), SIL Open Font License'),
    );
  }

  private openPanel(el: HTMLElement, dispose?: () => void): void {
    if (this.panel) this.panel.remove();
    this.panelDispose?.();
    this.panelDispose = dispose ?? null;
    this.panel = el;
    this.el.append(el);
    gsap.fromTo(el, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.45, ease: 'power3.out' });
    gsap.to(this.main, { opacity: 0.35, duration: 0.4 });
  }

  private closePanel(): void {
    const p = this.panel;
    if (!p) return;
    this.panel = null;
    this.panelDispose?.();
    this.panelDispose = null;
    gsap.to(p, { opacity: 0, x: 16, duration: 0.25, ease: 'power2.in', onComplete: () => p.remove() });
    gsap.to(this.main, { opacity: 1, duration: 0.4 });
  }

  show(parent: HTMLElement): void {
    parent.append(this.el);
    this.refreshServer(net.status !== 'online');
    gsap.fromTo(this.main.querySelector('.title'), { opacity: 0, letterSpacing: '0.5em' }, { opacity: 1, letterSpacing: '0.22em', duration: 2.4, ease: 'power3.out' });
    gsap.fromTo(this.main.querySelectorAll('.subtitle, .menu-list > .menu-item'), { opacity: 0, y: 8 },
      { opacity: 1, y: 0, duration: 0.8, stagger: 0.08, delay: 0.7, ease: 'power2.out' });
  }

  hide(): Promise<void> {
    return new Promise((resolve) => {
      gsap.to(this.el, { opacity: 0, duration: 0.6, onComplete: () => { this.el.remove(); this.el.style.opacity = '1'; resolve(); } });
    });
  }

  dispose(): void {
    this.panelDispose?.();
    this.creator?.dispose();
    this.creator = null;
    window.removeEventListener('keydown', this.onKey);
    this.offAccount();
    this.el.remove();
  }
}
