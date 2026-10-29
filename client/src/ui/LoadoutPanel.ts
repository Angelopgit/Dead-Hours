import { h } from './dom';
import { WEAPONS, PRIMARY_WEAPONS, type WeaponDef } from '@dead-hours/shared';
import { settings } from '../core/Settings';
import { audio } from '../audio/AudioEngine';

function card(w: WeaponDef, selected: boolean, onPick: (() => void) | null): HTMLElement {
  const stat = (label: string, v: number) => h('div', { class: 'stat' }, label, h('div', { class: 'bar' }, h('i', { style: `width:${Math.round(v * 100)}%` })));
  return h('button', {
    class: `weapon ${selected ? 'selected' : ''} ${onPick ? '' : 'fixed'}`,
    onclick: () => { if (onPick) { onPick(); audio.ui('click'); } },
    onmouseenter: () => { if (onPick) audio.ui('hover'); },
  },
    h('div', {}, h('span', { class: 'wname' }, w.name.toUpperCase()), h('span', { class: 'wmodel' }, w.model)),
    h('div', { class: 'wdesc' }, w.description),
    stat('Damage', w.stats.damage), stat('Fire rate', w.stats.fireRate), stat('Handling', w.stats.handling), stat('Range', w.stats.range),
  );
}

/** Starting loadout selection. The choice persists and is what the weapon table hands out in-game. */
export class LoadoutPanel {
  readonly el: HTMLElement;
  private readonly grid = h('div', { class: 'weapons' });
  private readonly fixed = h('div', { class: 'weapons' });

  constructor(onClose: () => void) {
    this.el = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Loadout' },
      h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); onClose(); } }, 'CLOSE ✕'),
      h('h2', {}, 'LOADOUT'),
      h('h3', {}, 'Primary'),
      this.grid,
      h('h3', {}, 'Secondary & melee'),
      this.fixed,
      h('p', { style: 'font-size:0.8em;margin-top:1.6em' }, 'Saved to your profile as your starting primary.'),
    );
    this.render();
  }

  private render(): void {
    const cur = settings.value.profile.primary;
    this.grid.replaceChildren(...PRIMARY_WEAPONS.map((id) =>
      card(WEAPONS[id], cur === id, () => { settings.update((s) => { s.profile.primary = id; }); this.render(); })));
    this.fixed.replaceChildren(card(WEAPONS.pistol, false, null), card(WEAPONS.machete, false, null));
  }
}
