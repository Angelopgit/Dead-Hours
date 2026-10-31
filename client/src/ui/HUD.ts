import gsap from 'gsap';
import { h } from './dom';
import { actionLabel, inputDevice } from '../core/Input';
import { settings, type Action } from '../core/Settings';

export interface WeaponReadout {
  model: string;
  mag: number;
  magazine: number;
  reserve: number;
  mode: string;
  /** 0..1 while reloading, otherwise null. */
  reload: number | null;
  slot: 'primary' | 'secondary';
  primaryModel: string;
  secondaryModel: string;
  bandages: number;
  /** 0..1 while bandaging. */
  healing: number | null;
  /** Severed arm in hand: hits left, and that as a share of what it started with. */
  hits?: number | null;
  wear?: number | null;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const clock = (s: number) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;

/**
 * In-game HUD: vitals, weapon panel (model, magazine / reserve, fire mode, reload progress),
 * dynamic crosshair with hit confirmation, damage direction arcs, phase timer, warnings,
 * interaction prompt, contextual notices and FPS.
 */
export class HUD {
  readonly el: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly lag: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly stance: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly crosshair: HTMLElement;
  /** Rifle scope: black surround and a duplex reticle over the zoomed view. */
  private readonly scope: HTMLElement;
  private scopeShown = 0;
  private readonly marker: HTMLElement;
  private readonly hp: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly warning: HTMLElement;
  private readonly arcs: HTMLElement;
  private readonly wModel: HTMLElement;
  private readonly wMag: HTMLElement;
  private readonly wReserve: HTMLElement;
  private readonly wSep: HTMLElement;
  private readonly wMode: HTMLElement;
  private readonly wBar: HTMLElement;
  private readonly wBarFill: HTMLElement;
  private readonly slot1: HTMLElement;
  private readonly slot2: HTMLElement;
  private readonly bandages: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly waypoint: HTMLElement;
  private readonly waypointText: HTMLElement;
  private waypointShown = false;
  private promptKey = '';
  private health = 100;
  /** Lazarus serum armor: a teal bar under the health bar while it lasts. */
  private readonly armorRow: HTMLElement;
  private readonly armorFill: HTMLElement;
  private readonly armorText: HTMLElement;
  private armor = -1;
  private timerText = '';
  private warningText = '';
  private lastReadout = '';
  private gap = -1;

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
    this.marker = h('div', { class: 'hitmarker' }, h('i'), h('i'), h('i'), h('i'));
    this.scope = h('div', { class: 'scope', style: 'display:none' },
      h('div', { class: 'lens' },
        h('i', { class: 'h' }), h('i', { class: 'v' }),
        h('i', { class: 'post l' }), h('i', { class: 'post r' }), h('i', { class: 'post b' }),
        h('b')));
    this.timer = h('div', { class: 'phase-timer' });
    this.warning = h('div', { class: 'warning' });
    this.arcs = h('div', { class: 'damage-arcs' });
    this.feed = h('div', { class: 'feed' });
    this.waypointText = h('span', { class: 'wp-text' });
    this.waypoint = h('div', { class: 'waypoint' }, h('i', { class: 'wp-icon' }), this.waypointText);
    this.wModel = h('div', { class: 'w-model' });
    this.wMag = h('span', { class: 'w-mag' }, '0');
    this.wReserve = h('span', { class: 'w-reserve' }, '0');
    this.wSep = h('span', { class: 'w-sep' }, '/');
    this.wMode = h('div', { class: 'w-mode' });
    this.wBarFill = h('i');
    this.wBar = h('div', { class: 'w-bar' }, this.wBarFill);
    this.slot1 = h('div', { class: 'w-slot' });
    this.slot2 = h('div', { class: 'w-slot' });
    this.bandages = h('div', { class: 'w-heal' });
    this.armorFill = h('i');
    this.armorText = h('span', {}, '0');
    this.armorRow = h('div', { class: 'armor', style: 'display:none' },
      h('div', { class: 'armor-label' }, h('span', {}, 'LAZARUS SERUM'), this.armorText),
      h('div', { class: 'abar' }, this.armorFill));
    this.el = h('div', { class: 'hud' },
      this.scope,
      this.arcs,
      this.crosshair,
      this.marker,
      this.waypoint,
      this.prompt,
      this.timer,
      this.warning,
      this.notice,
      this.feed,
      h('div', { class: 'vitals' },
        h('div', { class: 'name' }, h('span', {}, name.toUpperCase()), this.hp),
        h('div', { class: 'hbar' }, this.lag, this.fill),
        this.armorRow,
        this.stance,
      ),
      h('div', { class: 'weapon-panel' },
        h('div', { class: 'w-slots' }, this.slot1, this.slot2),
        this.wModel,
        h('div', { class: 'w-ammo' }, this.wMag, this.wSep, this.wReserve),
        this.wMode,
        this.wBar,
        this.bandages,
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
    this.hp.classList.toggle('low', v / max < 0.3);
    gsap.to(this.fill, { width: `${pct}%`, duration: 0.2 });
    gsap.to(this.lag, { width: `${pct}%`, duration: 0.8, delay: dropped ? 0.35 : 0, ease: 'power2.out' });
  }

  /** Serum armor left out of `max` (0 hides the bar). */
  setArmor(v: number, max: number): void {
    const r = Math.ceil(v);
    if (r === this.armor) return;
    this.armor = r;
    this.armorRow.style.display = r > 0 ? '' : 'none';
    this.armorText.textContent = String(r);
    gsap.to(this.armorFill, { width: `${Math.max(0, v / max) * 100}%`, duration: 0.25 });
  }

  /** Crosshair gap in pixels (from the weapon's current spread). */
  setSpread(px: number): void {
    const g = Math.round((4 + px) * 2) / 2;
    if (g === this.gap) return;
    this.gap = g;
    const [, l, r, t, b] = Array.from(this.crosshair.children) as HTMLElement[];
    l.style.transform = `translateX(${-g - 7}px)`;
    r.style.transform = `translateX(${g}px)`;
    t.style.transform = `translateY(${-g - 7}px)`;
    b.style.transform = `translateY(${g}px)`;
  }

  /** 0..1 how far the rifle scope is up to the eye. */
  setScope(v: number): void {
    const k = Math.round(v * 50) / 50;
    if (k === this.scopeShown) return;
    this.scopeShown = k;
    this.scope.style.display = k > 0 ? '' : 'none';
    this.scope.style.opacity = String(k);
  }

  setCrosshairVisible(v: boolean): void {
    this.crosshair.style.opacity = v ? '1' : '0';
  }

  /** Hit confirmation: white tick, red on a kill, larger for headshots. */
  hitMarker(kind: 'hit' | 'kill' | 'head'): void {
    const m = this.marker;
    m.className = `hitmarker ${kind}`;
    gsap.killTweensOf(m);
    gsap.fromTo(m, { opacity: 1, scale: kind === 'hit' ? 0.9 : 1.25 }, { opacity: 0, scale: 1, duration: kind === 'hit' ? 0.25 : 0.5, ease: 'power2.out' });
  }

  /** Arc around the crosshair pointing toward where damage came from (radians, 0 = ahead). */
  damageFrom(angle: number, amount: number): void {
    const a = h('div', { class: 'arc' });
    a.style.transform = `rotate(${angle}rad)`;
    a.style.setProperty('--w', String(Math.min(1, 0.4 + amount / 30)));
    this.arcs.append(a);
    gsap.fromTo(a, { opacity: 1 }, { opacity: 0, duration: 1.3, delay: 0.25, ease: 'power1.in', onComplete: () => a.remove() });
  }

  weapon(r: WeaponReadout): void {
    const key = JSON.stringify(r);
    if (key === this.lastReadout) return;
    this.lastReadout = key;
    this.wModel.textContent = r.model;
    const club = r.hits != null && r.wear != null;
    this.wMag.textContent = club ? String(r.hits) : r.mode === 'MELEE' ? '—' : String(r.mag);
    this.wReserve.textContent = club ? (r.hits === 1 ? 'HIT LEFT' : 'HITS LEFT') : r.mode === 'MELEE' ? '' : String(r.reserve);
    this.wSep.style.display = club ? 'none' : '';
    this.wReserve.style.marginLeft = club ? '0.45em' : '';
    this.wMag.classList.toggle('low', club ? r.hits! <= 2 : r.magazine > 0 && r.mag <= Math.max(1, Math.floor(r.magazine * 0.25)));
    this.wReserve.classList.toggle('low', !club && r.reserve === 0);
    this.wMode.textContent = r.reload !== null ? 'RELOADING' : club ? 'MELEE · CLUB' : r.mode;
    // The bar: reload or bandage progress, or how much is left of the arm.
    const bar = r.reload ?? r.healing ?? (club && r.healing === null ? r.wear! : null);
    this.wBar.classList.toggle('show', bar !== null);
    this.wBarFill.style.width = `${Math.round((bar ?? 0) * 100)}%`;
    this.wBar.classList.toggle('heal', r.healing !== null);
    this.wBar.classList.toggle('wear', club && r.reload === null && r.healing === null);
    const keys = inputDevice() !== 'mouse';
    const key1 = keys ? '' : actionLabel('weapon1');
    const key2 = keys ? '' : actionLabel('weapon2');
    const keyH = actionLabel('heal');
    this.slot1.textContent = key1 ? `${key1}  ${r.primaryModel}` : r.primaryModel;
    this.slot2.textContent = key2 ? `${key2}  ${r.secondaryModel}` : r.secondaryModel;
    this.slot1.classList.toggle('on', r.slot === 'primary');
    this.slot2.classList.toggle('on', r.slot === 'secondary');
    this.bandages.textContent = r.healing !== null ? 'APPLYING BANDAGE' : `${keyH ? `${keyH}  ` : ''}BANDAGE × ${r.bandages}`;
    this.bandages.classList.toggle('none', r.bandages === 0 && r.healing === null);
  }

  /** "SURVIVED 18:42" or "OUTBREAK IMMINENT — 00:45". */
  setTimer(text: string, urgent = false): void {
    if (text === this.timerText) return;
    this.timerText = text;
    this.timer.textContent = text;
    this.timer.classList.toggle('urgent', urgent);
  }

  /** Persistent top-center warning (AMMUNITION CRITICAL), empty to clear. */
  setWarning(text: string): void {
    if (text === this.warningText) return;
    this.warningText = text;
    this.warning.textContent = text;
    this.warning.classList.toggle('show', text !== '');
  }

  /** Small line in the pickup feed (bottom right, above the weapon panel). */
  feedLine(text: string): void {
    const line = h('div', {}, text);
    this.feed.append(line);
    while (this.feed.children.length > 4) this.feed.firstElementChild?.remove();
    gsap.fromTo(line, { opacity: 0, x: 12 }, { opacity: 1, x: 0, duration: 0.25 });
    gsap.to(line, { opacity: 0, duration: 0.6, delay: 3, onComplete: () => line.remove() });
  }

  setStance(text: string): void {
    if (this.stance.textContent !== text) this.stance.textContent = text;
  }

  /** Told whenever the interaction prompt changes (the on-screen USE button follows it). */
  onPrompt: ((text: string | null) => void) | null = null;

  setPrompt(action: Action | null, text = ''): void {
    const label = action ? actionLabel(action) : '';
    const key = action ? `${action}:${text}:${label}` : '';
    if (key === this.promptKey) return;
    this.promptKey = key;
    this.onPrompt?.(action ? text : null);
    if (!action) {
      this.prompt.classList.remove('show');
      return;
    }
    this.prompt.replaceChildren(label ? h('span', { class: 'k' }, label) : '', text);
    this.prompt.classList.add('show');
  }

  /** Top-center contextual message, e.g. location titles or SUPPLY HELICOPTER INBOUND. */
  notify(title: string, sub = '', hold = 2.6, tone: '' | 'danger' | 'rare' = ''): void {
    this.notice.replaceChildren(title, sub ? h('small', {}, sub) : '');
    this.notice.classList.toggle('danger', tone === 'danger');
    this.notice.classList.toggle('rare', tone === 'rare');
    gsap.killTweensOf(this.notice);
    gsap.timeline()
      .fromTo(this.notice, { opacity: 0, letterSpacing: '0.6em' }, { opacity: 1, letterSpacing: '0.4em', duration: 0.9, ease: 'power2.out' })
      .to(this.notice, { opacity: 0, duration: 1.2, delay: hold });
  }

  /**
   * World waypoint (supply drop): at its screen position, or pinned to the screen edge with an
   * arrow when it is off screen or behind. `x`/`y` are 0..1 across the viewport.
   */
  setWaypoint(show: boolean, x = 0, y = 0, offscreen = false, angle = 0, text = ''): void {
    if (!show) {
      if (this.waypointShown) this.waypoint.classList.remove('show');
      this.waypointShown = false;
      return;
    }
    if (!this.waypointShown) this.waypoint.classList.add('show');
    this.waypointShown = true;
    this.waypoint.style.left = `${(x * 100).toFixed(2)}%`;
    this.waypoint.style.top = `${(y * 100).toFixed(2)}%`;
    this.waypoint.classList.toggle('edge', offscreen);
    this.waypoint.style.setProperty('--wp-angle', `${angle.toFixed(3)}rad`);
    if (this.waypointText.textContent !== text) this.waypointText.textContent = text;
  }

  /** Frame rate (and the round trip to the server online), when the setting shows them. */
  setFps(fps: number, rtt: number | null = null): void {
    const show = settings.value.graphics.showFps;
    this.fps.textContent = show ? `${Math.round(fps)} FPS${rtt !== null ? ` · ${Math.round(rtt * 1000)} MS` : ''}` : '';
  }

  setVisible(v: boolean): void {
    gsap.to(this.el, { opacity: v ? 1 : 0, duration: 0.4 });
  }

  dispose(): void {
    gsap.killTweensOf([this.notice, this.fill, this.lag, this.el, this.marker]);
    for (const c of [...Array.from(this.arcs.children), ...Array.from(this.feed.children)]) gsap.killTweensOf(c);
    this.el.remove();
  }
}
