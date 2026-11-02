import gsap from 'gsap';
import { COMBAT, LIMB_NAME, MELEE, WEAPONS, isMelee, type SimPlayer, type WeaponId } from '@dead-hours/shared';
import { h } from './dom';
import { codeLabel } from '../core/Input';
import { settings, ACTION_LABELS, type Action } from '../core/Settings';

const KEYS: Action[] = ['fire', 'aim', 'reload', 'interact', 'melee', 'weapon1', 'weapon2', 'weapon3', 'heal', 'flashlight', 'sprint', 'crouch', 'prone', 'jump', 'shoulder'];

/**
 * Hold-to-view inventory: carried weapons with their ammunition, bandages, this run's numbers
 * and the current key bindings. Read-only; it never pauses the game.
 */
export class Inventory {
  readonly el: HTMLElement;
  private readonly title: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly supplies: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly keys: HTMLElement;
  private shown = false;
  private last = '';

  constructor() {
    this.title = h('small');
    this.cards = h('div', { class: 'inv-grid' });
    this.supplies = h('div', { class: 'inv-card' });
    this.stats = h('div', { class: 'inv-card inv-stats' });
    this.keys = h('div', { class: 'inv-keys' });
    this.el = h('div', { class: 'inventory', style: 'opacity:0' },
      h('div', { class: 'inv-box' },
        h('h2', {}, 'INVENTORY', this.title),
        this.cards,
        h('div', { class: 'inv-row' }, this.supplies, this.stats),
        this.keys,
      ),
    );
  }

  get visible(): boolean {
    return this.shown;
  }

  show(parent: HTMLElement, p: SimPlayer, survived: string): void {
    if (!this.shown) {
      this.shown = true;
      this.last = '';
      this.renderKeys();
      parent.append(this.el);
      gsap.killTweensOf(this.el);
      gsap.to(this.el, { opacity: 1, duration: 0.15 });
    }
    this.update(p, survived);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    gsap.killTweensOf(this.el);
    gsap.to(this.el, { opacity: 0, duration: 0.15, onComplete: () => this.el.remove() });
  }

  private update(p: SimPlayer, survived: string): void {
    const a = p.arsenal;
    const s = p.stats;
    const limb = a.limb && !a.limb.broken ? a.limb : null;
    const key = JSON.stringify([a.primary, a.secondary, a.active, p.bandages, p.health, s, survived, limb && [limb.id, limb.wear]]);
    if (key === this.last) return;
    this.last = key;
    this.title.textContent = survived;
    const k = (action: Action) => {
      const code = settings.value.controls.bindings[action][0];
      return code ? codeLabel(code) : '—';
    };
    // The key after a slot name is its own span: phones and pads have no keyboard, so they hide it.
    const slot = (name: string, action: Action) => h('div', { class: 'slot' }, name, h('span', { class: 'inv-k' }, ` · ${k(action)}`));
    const card = (slotEl: HTMLElement, id: WeaponId, ammo: { mag: number; reserve: number } | null, active: boolean) => {
      const w = WEAPONS[id];
      const stat = (label: string, v: number) => h('div', { class: 'stat' }, label, h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(v * 100)}%` })));
      return h('div', { class: `inv-card ${active ? 'active' : ''}` },
        slotEl,
        h('span', { class: 'wname' }, w.name.toUpperCase()),
        h('span', { class: 'wmodel' }, `${w.model} · ${w.mode}`),
        h('div', { class: 'ammo' }, ammo ? `${ammo.mag} / ${ammo.reserve}` : '—', h('small', {}, ammo ? `MAX ${w.maxReserve}` : isMelee(id) && MELEE[id].sever > 0 ? 'BLADE' : 'BLUNT')),
        stat('Damage', w.stats.damage), stat('Fire rate', w.stats.fireRate), stat('Handling', w.stats.handling), stat('Range', w.stats.range),
      );
    };
    this.cards.replaceChildren(
      card(slot('PRIMARY', 'weapon1'), a.primary.id, a.primary, a.active === 'primary' && !a.meleeOut && !limb),
      card(slot('SECONDARY', 'weapon2'), a.secondary.id, a.secondary, a.active === 'secondary' && !a.meleeOut && !limb),
      limb
        ? h('div', { class: 'inv-card active' },
          slot('MELEE', 'melee'),
          h('span', { class: 'wname' }, LIMB_NAME[limb.cut]),
          h('span', { class: 'wmodel' }, `TORN OFF A ${limb.kind.toUpperCase()} · CLUB`),
          h('div', { class: 'ammo' }, `${limb.wear} / ${limb.maxWear}`, h('small', {}, 'HITS LEFT')),
          h('div', { class: 'stat' }, 'Condition', h('div', { class: 'bar' }, h('i', { style: `width:${Math.round((limb.wear / limb.maxWear) * 100)}%` }))),
        )
        : card(slot('MELEE', 'weapon3'), a.meleeId, null, a.meleeOut),
    );
    this.supplies.replaceChildren(
      slot('MEDICAL', 'heal'),
      h('span', { class: 'wname' }, 'BANDAGES'),
      h('div', { class: 'ammo' }, `${p.bandages} / ${COMBAT.maxBandages}`, h('small', {}, `+${COMBAT.bandageHeal} HP EACH`)),
      h('span', { class: 'wmodel' }, `HEALTH ${Math.ceil(p.health)}`),
    );
    const acc = s.shotsFired > 0 ? `${Math.round((s.shotsHit / s.shotsFired) * 100)}%` : '—';
    const cell = (label: string, v: string) => h('div', {}, label, h('b', {}, v));
    this.stats.replaceChildren(
      cell('KILLS', String(s.kills)),
      cell('HEADSHOTS', String(s.headshots)),
      cell('ACCURACY', acc),
      cell('DAMAGE DEALT', String(Math.round(s.damageDealt))),
      cell('SUPPLIES', String(s.suppliesCollected)),
      cell('DAMAGE TAKEN', String(Math.round(s.damageTaken))),
      cell('ARMS TORN OFF', String(s.limbsSevered)),
      cell('LIMB KILLS', String(s.limbKills)),
      ...(s.revives ? [cell('REVIVES', String(s.revives))] : []),
      cell('SHOTS FIRED', String(s.shotsFired)),
    );
  }

  private renderKeys(): void {
    const b = settings.value.controls.bindings;
    this.keys.replaceChildren(...KEYS.map((a) => h('div', {}, h('span', {}, b[a][0] ? codeLabel(b[a][0]) : '—'), ACTION_LABELS[a])));
  }

  dispose(): void {
    gsap.killTweensOf(this.el);
    this.el.remove();
  }
}
