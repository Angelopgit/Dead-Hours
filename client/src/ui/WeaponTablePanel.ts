import { h } from './dom';
import { WEAPONS, PRIMARY_WEAPONS, type WeaponId } from '@dead-hours/shared';
import { audio } from '../audio/AudioEngine';
import { actionLabel, inputDevice } from '../core/Input';

/** How to pick a gun and step away, in the words of the device in hand (a phone or a pad has no [E] or [Esc]). */
function tableHint(): string {
  const d = inputDevice();
  if (d === 'touch') return 'Tap a card to equip it. CLOSE to step away.';
  if (d === 'pad') return 'A on a card equips it. B to step away.';
  const use = actionLabel('interact');
  return `Click a weapon on the bench or a card to equip it. ${use ? `[${use}] or ` : ''}[Esc] to step away.`;
}

/**
 * Side panel of the in-world weapon table: the four primaries with their stats. Hovering a
 * card (or a model on the bench) highlights it; clicking equips it. The secondary and the
 * machete stay with the survivor.
 */
export class WeaponTablePanel {
  readonly el: HTMLElement;
  private readonly cards = new Map<WeaponId, HTMLElement>();
  private carried: WeaponId;

  constructor(carried: WeaponId, cb: { onHover: (id: WeaponId | null) => void; onPick: (id: WeaponId) => void; onClose: () => void; onGunsmith?: () => void }) {
    this.carried = carried;
    const grid = h('div', { class: 'weapons table-weapons' });
    for (const id of PRIMARY_WEAPONS) {
      const w = WEAPONS[id];
      const stat = (label: string, v: number) => h('div', { class: 'stat' }, label, h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(v * 100)}%` })));
      const card = h('button', {
        class: 'weapon',
        onclick: () => cb.onPick(id),
        onmouseenter: () => { cb.onHover(id); this.mark(id); audio.ui('hover'); },
        onmouseleave: () => { cb.onHover(null); this.mark(null); },
      },
        h('div', {}, h('span', { class: 'wname' }, w.name.toUpperCase()), h('span', { class: 'wmodel' }, w.model), h('span', { class: 'carried' }, 'CARRIED')),
        h('div', { class: 'wdesc' }, w.description),
        h('div', { class: 'wspec' }, `${w.magazine} rounds, ${w.mode.toLowerCase()}, ${w.fireRate} rounds a minute`),
        stat('Damage', w.stats.damage), stat('Fire rate', w.stats.fireRate), stat('Handling', w.stats.handling), stat('Range', w.stats.range),
      );
      this.cards.set(id, card);
      grid.append(card);
    }
    this.el = h('div', { class: 'panel weapon-table', role: 'dialog', 'aria-label': 'Weapon table' },
      h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); cb.onClose(); } }, 'CLOSE ✕'),
      h('h2', {}, 'WEAPON TABLE'),
      h('p', {}, 'Swap your primary. Ammunition carries over in proportion. Your M17 pistol and machete stay holstered.'),
      grid,
      cb.onGunsmith ? h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => cb.onGunsmith?.(), onmouseenter: () => audio.ui('hover') }, 'GUNSMITH ▸'),
      ) : null,
      h('p', { class: 'table-hint' }, tableHint()),
    );
    this.setCarried(carried);
  }

  setCarried(id: WeaponId): void {
    this.carried = id;
    for (const [wid, card] of this.cards) card.classList.toggle('selected', wid === id);
  }

  /** Hover from the 3D bench. */
  mark(id: WeaponId | null): void {
    for (const [wid, card] of this.cards) card.classList.toggle('hover', wid === id);
  }

  get current(): WeaponId {
    return this.carried;
  }
}
