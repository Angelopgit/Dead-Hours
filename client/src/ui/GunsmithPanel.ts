import {
  SLOT_LABELS, WEAPONS, buildEffects, fitsOf, levelProgress, owns,
  type BuildOption, type BuildSlot, type UnlockState, type WeaponBuild, type WeaponId,
} from '@dead-hours/shared';
import { h } from './dom';
import { audio } from '../audio/AudioEngine';
import type { Hotspot } from '../weapons/GunsmithStage';

export interface GunsmithCallbacks {
  /** The gun being worked on changed (weapon tabs). */
  onWeapon: (id: WeaponId) => void;
  /** Hovering an option: show it on the gun (null: back to what is fitted). */
  onPreview: (id: WeaponId, build: WeaponBuild | null) => void;
  /** An option was picked: fit it for real. */
  onApply: (id: WeaponId, build: WeaponBuild) => void;
  /** A slot was chosen (the stage turns to show it). */
  onSlot?: (slot: BuildSlot) => void;
}

const SKIN_SWATCH = (o: BuildOption & { colors?: number[] }) => {
  const c = o.colors ?? [];
  if (!c.length) return 'linear-gradient(135deg, #2a2b2e, #141516)';
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
  return c.length === 1 ? hex(c[0]) : `linear-gradient(135deg, ${c.map((x, i) => `${hex(x)} ${(i / c.length) * 100}% ${((i + 1) / c.length) * 100}%`).join(', ')})`;
};

/** "LEVEL 7 · 1,240 / 2,100 XP" with a bar. */
export function levelBar(xp: number): HTMLElement {
  const p = levelProgress(xp);
  const pct = p.span ? Math.round((p.into / p.span) * 100) : 100;
  return h('div', { class: 'xp-bar' },
    h('span', { class: 'xp-level' }, `LEVEL ${p.level}`),
    h('div', { class: 'bar' }, h('i', { style: `width:${pct}%` })),
    h('span', { class: 'xp-num' }, p.span ? `${p.into.toLocaleString()} / ${p.span.toLocaleString()} XP` : 'MAX LEVEL'),
  );
}

/**
 * The gunsmith's controls: which gun, which fitting, and every option for it with what it
 * does and what unlocks it. Hovering an option previews it on the gun, clicking fits it.
 * Also owns the labels that float over the gun's fittings (placed each frame from hotspots).
 */
export class GunsmithPanel {
  readonly el: HTMLElement;
  /** Clickable labels over the gun: append to a full-size overlay. */
  readonly labels = h('div', { class: 'gs-labels' });
  private weapon: WeaponId;
  private slot: BuildSlot = 'optic';
  private readonly weaponTabs = h('div', { class: 'tabs gs-weapons' });
  private readonly slotTabs = h('div', { class: 'gs-slots' });
  private readonly list = h('div', { class: 'gs-options' });
  private readonly effects = h('div', { class: 'gs-effects' });
  private readonly level = h('div', {});
  private readonly labelEls = new Map<BuildSlot, HTMLElement>();
  /** Shown on the next options render: a refit the game refused, a fitting in progress. */
  private note = '';

  constructor(
    private weapons: WeaponId[],
    private builds: (id: WeaponId) => WeaponBuild,
    private unlocks: () => UnlockState,
    private xp: () => number,
    private readonly cb: GunsmithCallbacks,
    title = 'GUNSMITH',
  ) {
    this.weapon = weapons[0];
    this.el = h('div', { class: 'gunsmith' },
      h('div', { class: 'gs-head' }, h('h2', {}, title), this.level),
      this.weaponTabs,
      this.slotTabs,
      this.list,
      this.effects,
    );
    this.render();
  }

  get current(): WeaponId {
    return this.weapon;
  }

  get currentSlot(): BuildSlot {
    return this.slot;
  }

  setWeapons(ids: WeaponId[]): void {
    this.weapons = ids;
    if (!ids.includes(this.weapon)) this.weapon = ids[0];
    this.render();
  }

  selectWeapon(id: WeaponId): void {
    if (id === this.weapon) return;
    this.weapon = id;
    if (fitsOf(id, this.slot).length < 2) this.slot = 'skin';
    this.cb.onWeapon(id);
    this.render();
  }

  selectSlot(slot: BuildSlot): void {
    this.slot = slot;
    this.cb.onSlot?.(slot);
    this.render();
  }

  setNote(text: string): void {
    this.note = text;
    this.render();
  }

  /** Redraws everything (after a refit, an unlock or a level change). */
  render(): void {
    const u = this.unlocks();
    this.level.replaceChildren(levelBar(this.xp()));
    this.weaponTabs.replaceChildren(...this.weapons.map((id) => h('button', {
      class: `tab ${id === this.weapon ? 'active' : ''}`,
      onclick: () => { audio.ui('click'); this.selectWeapon(id); },
    }, WEAPONS[id].model)));
    const slots = (Object.keys(SLOT_LABELS) as BuildSlot[]).filter((s) => fitsOf(this.weapon, s).length > 1);
    if (!slots.includes(this.slot)) this.slot = slots[0] ?? 'skin';
    const build = this.builds(this.weapon);
    this.slotTabs.replaceChildren(...slots.map((s) => {
      const fitted = fitsOf(this.weapon, s).find((o) => o.id === build[s]);
      return h('button', {
        class: `gs-slot ${s === this.slot ? 'on' : ''}`,
        onclick: () => { audio.ui('click'); this.selectSlot(s); },
        onmouseenter: () => audio.ui('hover'),
      }, h('small', {}, SLOT_LABELS[s].toUpperCase()), fitted?.label ?? '');
    }));
    const opts = fitsOf(this.weapon, this.slot);
    this.list.replaceChildren(...opts.map((o, i) => {
      const mine = i === 0 || owns(o, u);
      const on = build[this.slot] === o.id;
      const lock = mine ? '' : o.source === 'supporter' ? 'SUPPORTER PACK' : `LEVEL ${o.level}`;
      const want = { ...build, [this.slot]: o.id };
      return h('button', {
        class: `gs-option ${on ? 'on' : ''} ${mine ? '' : 'locked'}`,
        'aria-disabled': mine ? 'false' : 'true',
        onmouseenter: () => { audio.ui('hover'); this.cb.onPreview(this.weapon, want); this.showEffects(want); },
        onmouseleave: () => { this.cb.onPreview(this.weapon, null); this.showEffects(this.builds(this.weapon)); },
        onclick: () => {
          if (!mine || on) {
            if (!mine) audio.ui('back');
            return;
          }
          audio.ui('click');
          this.note = '';
          this.cb.onApply(this.weapon, want);
          this.render();
        },
      },
        this.slot === 'skin' ? h('i', { class: 'gs-swatch', style: `background:${SKIN_SWATCH(o)}` }) : null,
        h('span', { class: 'gs-name' }, o.label, on ? h('em', {}, 'FITTED') : null, lock ? h('em', { class: 'lock' }, `🔒 ${lock}`) : null),
        h('span', { class: 'gs-desc' }, o.description),
      );
    }));
    this.showEffects(build);
    // Fitting labels over the gun.
    this.labels.replaceChildren();
    this.labelEls.clear();
    for (const s of slots) {
      const el = h('button', {
        class: `gs-label ${s === this.slot ? 'on' : ''}`,
        // Hidden until the stage has placed it over its fitting: new labels all sat in the top corner until then.
        style: 'display:none',
        onclick: () => { audio.ui('click'); this.selectSlot(s); },
        onmouseenter: () => audio.ui('hover'),
      }, h('i'), SLOT_LABELS[s].toUpperCase());
      this.labelEls.set(s, el);
      this.labels.append(el);
    }
  }

  private showEffects(b: WeaponBuild): void {
    const lines = buildEffects(this.weapon, b);
    this.effects.replaceChildren(
      ...(this.note ? [h('div', { class: 'gs-note' }, this.note)] : []),
      ...(lines.length ? lines : ['Stock handling.']).map((l) => h('div', { class: l.startsWith('▼') ? 'worse' : l.startsWith('▲') ? 'better' : '' }, l)),
    );
  }

  /** Places the labels over the fittings (screen points from the stage). */
  place(spots: Hotspot[]): void {
    for (const [slot, el] of this.labelEls) {
      const s = spots.find((x) => x.slot === slot);
      if (!s || !s.visible) {
        el.style.display = 'none';
        continue;
      }
      el.style.display = '';
      el.style.transform = `translate(${Math.round(s.x)}px, ${Math.round(s.y)}px)`;
    }
  }
}
