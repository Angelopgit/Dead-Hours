import gsap from 'gsap';
import {
  PRIMARY_WEAPONS, SECONDARY_WEAPONS, SLOT_LABELS, WEAPONS, defaultBuild, levelFor, owns, unlockTrack,
  type WeaponId,
} from '@dead-hours/shared';
import { h } from './dom';
import { settings } from '../core/Settings';
import { codeLabel, inputDevice } from '../core/Input';
import { PAD, PAD_PLAY, glyph, physicalOf } from '../core/PadLayout';
import { richNodes } from './Glyphs';
import { padTurner } from './PadMenus';
import { audio } from '../audio/AudioEngine';
import { account } from '../network/Account';
import { GunsmithPanel } from './GunsmithPanel';
import { WeaponPreview } from '../weapons/WeaponPreview';

const GUNS: WeaponId[] = [...PRIMARY_WEAPONS, ...SECONDARY_WEAPONS];

/**
 * The armory: every gun on a turntable with its attachments and finish, the primary to carry
 * into the night, the player's level and what the next levels unlock. Builds are saved to the
 * profile (the server keeps only what the profile has unlocked) and are what the survivor
 * brings into every night; they can be changed again in the field or at the safehouse bench.
 */
export class LoadoutPanel {
  readonly el: HTMLElement;
  private readonly preview = new WeaponPreview();
  /** The right stick turns the gun on show. */
  private readonly offTurn = padTurner({ el: () => this.el, turn: (dx, dy) => { this.preview.stage.turnBy(dx, dy); return true; } });
  private readonly gunsmith: GunsmithPanel;
  private readonly carry = h('div', { class: 'armory-carry' });
  private readonly track = h('div', { class: 'armory-track' });
  private readonly unsub: () => void;

  constructor(private readonly onClose: () => void) {
    const build = (id: WeaponId) => account.loadout[id] ?? defaultBuild(id);
    const primary = settings.value.profile.primary as WeaponId;
    this.gunsmith = new GunsmithPanel(GUNS, build, () => account.unlocks, () => account.xp, {
      onWeapon: (id) => {
        this.preview.show(id, build(id));
        this.renderCarry();
      },
      onPreview: (id, b) => {
        this.preview.show(id, b ?? build(id));
      },
      onApply: (id, b) => {
        account.setLoadout({ ...account.loadout, [id]: b });
        this.preview.show(id, b);
      },
      onSlot: (s) => this.preview.stage.face(s),
    }, 'ARMORY');
    if (PRIMARY_WEAPONS.includes(primary)) this.gunsmith.selectWeapon(primary);
    this.preview.show(this.gunsmith.current, build(this.gunsmith.current));
    this.preview.onFrame = (spots) => this.gunsmith.place(spots);
    this.preview.onPick = (slot) => { audio.ui('click'); this.gunsmith.selectSlot(slot); };

    const stage = h('div', { class: 'armory-stage' }, this.preview.canvas, this.gunsmith.labels,
      h('div', { class: 'armory-top' },
        h('button', { class: 'creator-btn', onclick: () => { audio.ui('back'); this.onClose(); } }, '◂ BACK'),
      ),
      this.carry,
    );
    this.el = h('div', { class: 'armory', role: 'dialog', 'aria-label': 'Armory' },
      stage,
      h('div', { class: 'armory-side' },
        this.gunsmith.el,
        h('p', { class: 'gs-hint' }, ...richNodes(inputDevice() === 'pad'
          ? `The right stick turns the gun. In a night, hold ${glyph(physicalOf(PAD_PLAY.gunsmith?.button ?? PAD.Y))} anywhere or use the safehouse workbench to change them on the fly.`
          : `Drag the gun to turn it, click a label or a part to pick that fitting. In a night, press ${codeLabel(settings.value.controls.bindings.gunsmith[0] ?? '') || 'the gunsmith key'} anywhere or use the safehouse workbench to change them on the fly.`)),
        this.track,
      ),
    );
    this.renderCarry();
    this.renderTrack();
    // XP from a run reported in the background, or the server's copy arriving.
    this.unsub = account.onChange(() => {
      this.gunsmith.render();
      this.renderTrack();
    });
    this.preview.start();
    gsap.fromTo(this.el, { opacity: 0 }, { opacity: 1, duration: 0.35 });
  }

  /** Which primary and which sidearm (the M17 or the akimbo pair) go into the night (the machete always does). */
  private renderCarry(): void {
    const id = this.gunsmith.current;
    const isPrimary = PRIMARY_WEAPONS.includes(id);
    const profile = settings.value.profile;
    const cur = isPrimary ? profile.primary : SECONDARY_WEAPONS.includes(profile.secondary as WeaponId) ? profile.secondary : 'pistol';
    const what = isPrimary ? 'PRIMARY' : 'SIDEARM';
    this.carry.replaceChildren(
      h('span', { class: 'lbl' }, `${WEAPONS[id].name.toUpperCase()}, ${WEAPONS[id].model}`),
      h('button', {
        class: `creator-btn ${cur === id ? 'primary' : ''}`,
        onclick: () => {
          if (cur === id) return;
          audio.ui('click');
          settings.update((s) => { if (isPrimary) s.profile.primary = id; else s.profile.secondary = id; });
          this.renderCarry();
        },
      }, cur === id ? `CARRIED AS ${what}` : `CARRY AS ${what}`),
    );
  }

  /** The levels ahead and what each opens. */
  private renderTrack(): void {
    const u = account.unlocks;
    const level = levelFor(account.xp);
    const rows = unlockTrack().map((t) => h('li', { class: owns(t.option, u) ? 'got' : '' },
      h('b', {}, `LV ${t.level}`), h('span', {}, SLOT_LABELS[t.slot]), h('span', {}, t.option.label)));
    this.track.replaceChildren(
      h('h3', {}, `Unlocks (you are level ${level})`),
      h('ol', {}, ...rows),
      h('p', { class: 'gs-hint' }, account.profile
        ? 'XP comes from every night: time survived, kills, headshots, arms torn off and supplies found. Supporter finishes come with the Supporter Pack.'
        : 'Not connected to the game server: XP from solo nights is kept in this browser until it is.'),
    );
  }

  dispose(): void {
    this.unsub();
    this.offTurn();
    this.preview.dispose();
    this.el.remove();
  }
}
