import gsap from 'gsap';
import { GAME, type BeginMsg } from '@dead-hours/shared';
import { h, panelCoversMenu } from './dom';
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
import { HOLIDAY } from '../core/Holiday';
import { logo } from './Logo';
import { nameField, unnamed, type NameField } from './NameField';

const PEN = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.3 2.2a1.5 1.5 0 0 1 2.1 0l.4.4a1.5 1.5 0 0 1 0 2.1L6 12.5 2.5 13.5l1-3.5z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 3.5l2.5 2.5" stroke="currentColor" stroke-width="1.2"/></svg>';

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
  /** Whether the open panel slices through the menu's words, so the menu is hidden (null: not worked out yet). */
  private covered: boolean | null = null;
  /**
   * The window and the open panel change size after it opened (leaving fullscreen, a phone turning, a settings
   * tab): the menu is re-checked then, or a panel opened in a big window sliced through it once the window shrank.
   */
  private readonly sizes = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => this.coverMenu()) : null;
  private online: OnlineMenu | null = null;
  private creator: CharacterCreator | null = null;
  private armory: LoadoutPanel | null = null;
  /** Items that need the game server: enabled only once it has answered. */
  private readonly needServer: HTMLButtonElement[] = [];
  private playOpen = false;
  private readonly sub: HTMLElement;
  private readonly main: HTMLElement;
  private accountItem!: HTMLButtonElement;
  private readonly offAccount: () => void;
  /** The survivor's name, right on the menu (the creator has the same box). */
  private readonly name: NameField;
  private readonly nameRow: HTMLElement;

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
      item('SOLO', () => this.cb.onSolo(), { tag: 'on your own' }),
      item('HOST GAME', () => this.openOnline('host'), { tag: 'with friends', online: true }),
      item('JOIN GAME', () => this.openOnline('browse'), { tag: 'by code, or an open game', online: true }),
    );

    // Other players and the leaderboards see the name, so it sits on the menu where it is hard to miss.
    this.name = nameField('menu-name-input', () => this.nameHint());
    this.nameRow = h('label', { class: 'menu-name', title: 'Other players and the leaderboards see this name' },
      // Both labels take the same room, so the box doesn't shift when the name is picked.
      h('span', { class: 'menu-name-label' }, h('span', { class: 'ask' }, 'Pick a name'), h('span', { class: 'have' }, 'Your name')),
      h('span', { class: 'menu-name-box' },
        this.name.el,
        h('span', { class: 'menu-name-pen', html: PEN }),
      ),
      h('span', { class: 'menu-name-hint' }, 'Other players and the leaderboards see it.'),
    );
    this.name.el.addEventListener('mouseenter', () => audio.ui('hover'));
    this.name.el.addEventListener('focus', () => audio.unlock());
    this.nameHint();

    this.main = h('div', { class: 'menu-main' },
      logo(GAME.title, HOLIDAY),
      h('div', { class: 'subtitle' }, GAME.subtitle),
      this.nameRow,
      h('nav', { class: 'menu-list' },
        item('PLAY', () => this.togglePlay()),
        this.sub,
        item('SURVIVOR', () => this.openCreator()),
        item('LOADOUT', () => this.openArmory()),
        item('LEADERBOARDS', () => this.openBoards('survival'), { online: true }),
        this.accountItem = item('ACCOUNT', () => this.openBoards('you'), { tag: 'guest, sign in', online: true }),
        item('SETTINGS', () => this.openPanel(new SettingsPanel(this.input, () => this.closePanel()).el)),
        item('CREDITS', () => this.openPanel(this.credits())),
      ),
    );

    this.el = h('div', { class: HOLIDAY ? 'menu holiday' : 'menu' },
      h('div', { class: 'menu-shade' }),
      this.main,
      h('div', { class: 'menu-footer' }, `Build ${GAME.version}`),
      h('div', { class: 'menu-hint' }, h('span', { class: 'touch' }, 'Touch controls on.', h('span', { class: 'upright' }, ' Turn your phone sideways.')), 'Best with headphones.'),
    );
    window.addEventListener('keydown', this.onKey);
    this.sizes?.observe(this.el);
    this.offAccount = account.onChange(() => this.accountTag());
    this.refreshServer(false);
  }

  /** Until a name is picked, the box asks for one (and says why, where there is room). */
  private nameHint(): void {
    this.nameRow.classList.toggle('unnamed', unnamed());
  }

  /** The account item says who is signed in (or that they play as a guest). */
  private accountTag(show = true): void {
    const me = account.signedIn;
    const b = this.accountItem;
    b.dataset.tag = me ? (me.name || 'signed in') : 'guest, sign in';
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
        tag.textContent = st === 'online' ? b.dataset.tag ?? '' : st === 'unknown' ? 'connecting…' : 'server offline';
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
    else if (this.armory) this.closeArmory();
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

  /** The armory covers the menu like the creator (and the street stops drawing behind it). */
  private openArmory(): void {
    if (this.armory || this.creator) return;
    this.closePanel();
    this.armory = new LoadoutPanel(() => this.closeArmory());
    this.el.append(this.armory.el);
    gsap.to([this.main, this.el.querySelector('.menu-footer'), this.el.querySelector('.menu-hint')], { opacity: 0, duration: 0.3 });
    this.main.style.pointerEvents = 'none';
    this.cb.onCreator?.(true);
  }

  private closeArmory(): void {
    const a = this.armory;
    if (!a) return;
    this.armory = null;
    this.cb.onCreator?.(false);
    gsap.to(a.el, { opacity: 0, duration: 0.3, ease: 'power2.in', onComplete: () => a.dispose() });
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
      h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); this.closePanel(); } }, 'Close ✕'),
      h('h2', {}, 'CREDITS'),
      h('p', { class: 'role' }, 'A game by'), h('p', {}, 'Angelo'),
      h('p', { class: 'role' }, 'Recorded sound'), h('p', {},
        'Gunshots, hits and the flashlight click from Freesound (CC0): DledeSOUND, michorvath, kyles, mrrap4food, areniporgen, kvgarlic, '
        + 'ajhartman42295, u1769092, nebulasnails, magnuswaker, Pablobd, janbezouska, realgtro. Reloads from The Free '
        + 'Firearm Sound Library (CC0). Everything else is synthesized in the browser.'),
      h('p', { class: 'role' }, 'Built with'), h('p', {}, 'Three.js, Rapier, Colyseus, GSAP, Vite and TypeScript'),
      h('p', { class: 'role' }, 'Typefaces'), h('p', {}, 'Big Shoulders Display (Patric King), Barlow Semi Condensed (Jeremy Tribby), Special Elite (Astigmatic), SIL Open Font License'),
    );
  }

  private openPanel(el: HTMLElement, dispose?: () => void): void {
    if (this.panel) { this.sizes?.unobserve(this.panel); this.panel.remove(); }
    this.panelDispose?.();
    this.panelDispose = dispose ?? null;
    this.panel = el;
    this.el.append(el);
    this.covered = null;
    this.coverMenu();
    // Panels centre themselves with a CSS translate(-50%). Animating the transform, GSAP keeps that as -50% only when
    // it reads exactly half the height and as fixed pixels otherwise, so a panel that grew afterwards (the leaderboard
    // once its rows came in) sat far below centre with its bottom cut off. The stylesheet takes it back at the end.
    // Its size is watched from then on (mid-slide it sits off to the side).
    gsap.fromTo(el, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.45, ease: 'power3.out', clearProps: 'transform',
      onComplete: () => { if (this.panel === el) this.sizes?.observe(el); } });
  }

  /** Dimmed menu words beside a panel read fine; words the panel slices through (phones, narrow windows) don't. */
  private coverMenu(): void {
    if (!this.panel) return;
    const covered = panelCoversMenu(this.panel, this.main, (e) => !this.playOpen && !!e.closest('.menu-sub'));
    if (covered === this.covered) return;
    this.covered = covered;
    gsap.to(this.main, { opacity: covered ? 0 : 0.35, duration: 0.4 });
    this.main.style.pointerEvents = covered ? 'none' : '';
  }

  private closePanel(): void {
    const p = this.panel;
    if (!p) return;
    this.panel = null;
    this.covered = null;
    this.sizes?.unobserve(p);
    this.panelDispose?.();
    this.panelDispose = null;
    gsap.to(p, { opacity: 0, x: 16, duration: 0.25, ease: 'power2.in', onComplete: () => p.remove() });
    gsap.to(this.main, { opacity: 1, duration: 0.4 });
    this.main.style.pointerEvents = '';
  }

  show(parent: HTMLElement): void {
    parent.append(this.el);
    this.refreshServer(net.status !== 'online');
    gsap.fromTo(this.main.querySelector('.title'), { opacity: 0, letterSpacing: '0.12em' }, { opacity: 1, letterSpacing: '0.01em', duration: 2.4, ease: 'power3.out' });
    gsap.fromTo(this.main.querySelectorAll('.subtitle, .menu-name, .menu-list > .menu-item'), { opacity: 0, y: 8 },
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
    this.armory?.dispose();
    this.armory = null;
    window.removeEventListener('keydown', this.onKey);
    this.sizes?.disconnect();
    this.offAccount();
    this.name.dispose();
    this.el.remove();
  }
}

