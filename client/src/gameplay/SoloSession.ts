import * as THREE from 'three';
import gsap from 'gsap';
import {
  GAME, NEIGHBORHOOD, PLAYER, PRIMARY_WEAPONS, Simulation, WEAPONS, encodeAppearance, sanitizeAppearance,
  type ArmZone, type Interactable, type LimbCut, type MapDefinition, type NavGrid, type SimEvent, type SimLimb, type SimPlayer, type Vec3,
  type WeaponId, type ZombieKind,
} from '@dead-hours/shared';
import type { Engine } from '../core/Engine';
import { codeLabel, type Input } from '../core/Input';
import type { Physics } from '../core/Physics';
import { settings } from '../core/Settings';
import { PlayerController } from './PlayerController';
import { ThirdPersonCamera } from './ThirdPersonCamera';
import type { Door, DoorSystem } from './Doors';
import { WeaponRack } from './WeaponRack';
import { SupplyDrops } from './SupplyDrops';
import { survivorLook } from '../characters/Humanoid';
import { Ragdoll, ZONE_PARTICLES } from '../characters/Ragdoll';
import { PlayerWeapon } from '../weapons/PlayerWeapon';
import { clearSeveredCache } from '../characters/Severed';
import { createWeaponModel, sightOf, type Sight, type WeaponModel } from '../weapons/WeaponModels';
import { Effects } from '../effects/Effects';
import { ZombieView } from '../zombies/ZombieView';
import { LimbView } from '../zombies/LimbView';
import { HUD, clock } from '../ui/HUD';
import { PauseMenu } from '../ui/PauseMenu';
import { Inventory } from '../ui/Inventory';
import { ResultsScreen } from '../ui/ResultsScreen';
import { WeaponTablePanel } from '../ui/WeaponTablePanel';
import { audio } from '../audio/AudioEngine';
import { h } from '../ui/dom';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';

type Phase = 'intro' | 'playing' | 'paused' | 'table' | 'dead';

/** Name of the map area containing a point (areas are ordered most specific first). */
export function areaAt(map: MapDefinition, p: THREE.Vector3): string {
  for (const a of map.areas) {
    if (p.x < a.x0 || p.x > a.x1 || p.z < a.z0 || p.z > a.z1) continue;
    if (a.y0 !== undefined && p.y < a.y0) continue;
    if (a.y1 !== undefined && p.y > a.y1) continue;
    return a.name;
  }
  return map.name.toUpperCase();
}

const ME = 'p1';
const v3 = (v: Vec3, out: THREE.Vector3) => out.set(v.x, v.y, v.z);

export interface SessionOptions {
  /** Retry: straight into play, no establishing shot. */
  skipIntro?: boolean;
}

interface Candidate {
  kind: 'door' | 'limb' | Interactable['kind'];
  pos: THREE.Vector3;
  door?: Door;
  it?: Interactable;
  limb?: SimLimb;
  /** How near it counts as (default: straight-line distance from the chest). */
  near?: number;
}

/** A dropped weapon tumbling to the floor when its owner dies. */
interface Dropped {
  model: WeaponModel;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  floor: number;
  rest: THREE.Quaternion;
  landed: boolean;
}

/**
 * A local play session: one survivor in the neighborhood running the authoritative simulation
 * in the browser. The client sends the same intents the Phase 4 room will receive over the
 * network (fire, reload, switch, melee, heal, use) and renders the simulation's events.
 */
export class SoloSession {
  readonly player: PlayerController;
  readonly cam: ThirdPersonCamera;
  readonly sim: Simulation;
  readonly me: SimPlayer;
  private readonly hud: HUD;
  private readonly pause: PauseMenu;
  private readonly inventory = new Inventory();
  private readonly weapon: PlayerWeapon;
  private readonly effects: Effects;
  private readonly zombies: ZombieView;
  private readonly limbs: LimbView;
  private readonly drops: SupplyDrops;
  private readonly helis = new Map<number, { pos: THREE.Vector3; hover: number }>();
  private readonly rack: WeaponRack | null = null;
  private table: WeaponTablePanel | null = null;
  private results: ResultsScreen | null = null;
  private phase: Phase = 'intro';
  private accumulator = 0;
  private intro: gsap.core.Timeline | null = null;
  private readonly introCam = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
  private readonly letterbox: HTMLElement[];
  private readonly skip: HTMLElement;
  private readonly clickToPlay: HTMLElement;
  private area = '';
  private areaCooldown = 0;
  private readonly probe: DynamicProbe;
  readonly focus = new THREE.Vector3();
  private readonly abort = new AbortController();
  private readonly fill = new THREE.PointLight(0xa8b8d0, 1.6, 9, 1.5);
  private readonly unsubSettings: () => void;
  private readonly doorColliders = new Set<number>();

  // Intents gathered per frame, sent to the simulation in the next fixed step.
  private fireHeld = false;
  private fireBuffer = 0;
  private wantReload = false;
  private wantSlot: 'primary' | 'secondary' | null = null;
  private wantMelee = false;
  private wantHeal = false;
  private reloadFromEmpty = false;

  private readonly later: { t: number; fn: () => void }[] = [];
  private hurtFlash = 0;
  private impactSoundAt = 0;
  private lastHurtDir = new THREE.Vector3(0, 0, 1);
  private ragdoll: Ragdoll | null = null;
  private readonly sights = new Map<WeaponId, Sight | null>();
  private dropped: Dropped | null = null;
  private deathT = 0;
  private deathYaw = 0;
  private readonly tablePose = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
  private tableTween: gsap.core.Tween | null = null;
  private hovered: WeaponId | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouse = new THREE.Vector2();
  private outbreakAnnounced = false;
  /** First arm torn off / first picked up: say once what can be done with it. */
  private limbHinted = false;
  private gripHinted = false;
  /** Blood off the arm in hand: seconds to the next drop, and where its torn end was. */
  private limbDrip = 0;
  private readonly limbEnd = new THREE.Vector3();
  private limbEndValid = false;
  private readonly liftQ = new THREE.Quaternion();

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly tmpD = new THREE.Vector3();

  constructor(
    private readonly engine: Engine,
    private readonly input: Input,
    private readonly physics: Physics,
    private readonly doors: DoorSystem,
    field: LightField,
    nav: NavGrid,
    private readonly ui: HTMLElement,
    private readonly onQuit: () => void,
    private readonly onRetry: () => void,
    startPose: { position: THREE.Vector3; target: THREE.Vector3 },
    opts: SessionOptions = {},
  ) {
    const spawn = NEIGHBORHOOD.playerSpawns[0];
    doors.reset();
    for (const b of doors.bodies) if (b) this.doorColliders.add(b.collider.handle);

    // Authoritative simulation.
    this.sim = new Simulation({
      physics, map: NEIGHBORHOOD, nav, doors: doors.bodies,
      seed: (Math.random() * 2 ** 31) | 0, preparation: GAME.preparationSeconds,
    });
    const profile = settings.value.profile;
    const primary = (PRIMARY_WEAPONS as string[]).includes(profile.primary) ? (profile.primary as WeaponId) : 'ar';
    const look = sanitizeAppearance(profile.appearance);
    this.me = this.sim.addPlayer(ME, profile.name, primary, 'pistol', { x: spawn.x, y: spawn.y, z: spawn.z }, spawn.yaw, encodeAppearance(look));

    // Survivor, dressed as the profile's character.
    this.player = new PlayerController(physics, spawn, survivorLook(look));
    engine.scene.add(this.player.character.root);
    this.probe = new DynamicProbe(field);
    this.probe.attach(this.player.character.surfaces());
    this.player.character.onFootstep = (l) => audio.footstep(l, this.indoors);
    this.weapon = new PlayerWeapon(engine.scene, this.player.character);
    this.probe.attach(this.weapon.materials());
    this.weapon.onMaterials = (m) => this.probe.attach(m);
    this.weapon.onCue = (cue, weapon) => audio.foley(cue, this.handPos(), weapon);
    this.cam = new ThirdPersonCamera(engine.camera, physics);
    this.cam.yaw = spawn.yaw;
    this.focus.copy(this.player.position);
    this.area = areaAt(NEIGHBORHOOD, this.player.position);
    // Soft fill that travels with the camera so the survivor stays readable at night.
    this.fill.position.set(0, 0.4, 0.6);
    engine.camera.add(this.fill);
    if (!engine.camera.parent) engine.scene.add(engine.camera);

    // World feedback.
    this.effects = new Effects(engine.scene, physics);
    this.effects.isMoving = (pos, n) => {
      const hit = physics.raycastHit(pos.x + n.x * 0.06, pos.y + n.y * 0.06, pos.z + n.z * 0.06, -n.x, -n.y, -n.z, 0.15);
      return hit !== null && this.doorColliders.has(hit.collider.handle);
    };
    this.effects.casings.onBounce = (pos, shell, strength) => audio.casing(pos, shell, strength);
    this.zombies = new ZombieView(engine.scene, physics, field, this.effects);
    this.zombies.onCorpseSettled = (pos) => this.effects.pool(pos, 0.9 + Math.random() * 0.5, 120);
    this.limbs = new LimbView(engine.scene, field, this.effects);
    this.limbs.onLand = (pos, strength) => audio.limbLand(pos, strength);
    this.drops = new SupplyDrops(engine.scene);
    this.drops.onSmoke = (pos, strong) => this.effects.flareSmoke(pos, strong);
    this.drops.onLand = (pos) => {
      this.effects.landingDust(pos);
      audio.crateLand(pos);
    };
    const bench = NEIGHBORHOOD.props.find((p) => p.use === 'weapons');
    if (bench) {
      this.rack = new WeaponRack(engine.scene, bench, field);
      this.rack.highlight(null, this.me.arsenal.primary.id);
    }
    this.applySettings();
    this.unsubSettings = settings.subscribe(() => this.applySettings());

    // Interface.
    this.hud = new HUD(profile.name);
    this.hud.el.style.opacity = '0';
    ui.append(this.hud.el);
    this.pause = new PauseMenu(input, () => this.resume(), () => this.quit());
    this.letterbox = [h('div', { class: 'letterbox top' }), h('div', { class: 'letterbox bottom' })];
    this.skip = h('div', { class: 'skip' }, 'PRESS ANY KEY TO SKIP');
    this.clickToPlay = h('div', { class: 'click-to-play' }, 'CLICK TO CONTINUE');
    const sig = { signal: this.abort.signal };
    document.addEventListener('pointerlockchange', this.onLockChange, sig);
    window.addEventListener('keydown', this.onKeyDown, sig);
    engine.canvas.addEventListener('click', this.onCanvasClick, sig);
    engine.canvas.addEventListener('mousemove', this.onCanvasMove, sig);
    if (opts.skipIntro) this.quickStart();
    else this.runIntro(startPose);
  }

  private applySettings(): void {
    const g = settings.value.graphics;
    this.effects.setQuality(g.particleQuality, g.gore, settings.value.accessibility.reducedFlashing);
    this.zombies.gore = g.gore !== 'off';
    this.limbs.gore = g.gore !== 'off';
    this.weapon.gore = g.gore !== 'off';
  }

  /** Under a roof: sky mostly hidden (drives footstep and gunshot acoustics). */
  get indoors(): boolean {
    return this.probe.sample.ao < 0.35;
  }

  private handPos(): THREE.Vector3 {
    return this.player.character.armR.end.getWorldPosition(this.tmpD);
  }

  // ------------------------------------------------------------------ phases

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.phase === 'intro') {
      this.finishIntro();
      return;
    }
    if (this.phase === 'table') {
      const interact = settings.value.controls.bindings.interact;
      if (e.code === 'Escape' || interact.includes(e.code)) this.closeTable();
      return;
    }
    if (e.code === 'Escape' && this.phase === 'paused') {
      if (this.pause.settingsOpen) this.pause.closeSettings();
      else this.resume();
    }
  };

  private onLockChange = (): void => {
    if (this.phase === 'playing' && !this.input.locked) this.openPause();
    if (this.input.locked) this.clickToPlay.remove();
  };

  private onCanvasClick = (e: MouseEvent): void => {
    if (this.phase === 'playing' && !this.input.locked) this.input.requestLock();
    if (this.phase === 'table' && this.rack) {
      const id = this.pickRack(e);
      if (id) this.choose(id);
    }
  };

  private onCanvasMove = (e: MouseEvent): void => {
    if (this.phase !== 'table' || !this.rack) return;
    const id = this.pickRack(e);
    if (id !== this.hovered) {
      this.hovered = id;
      this.rack.highlight(id, this.me.arsenal.primary.id);
      this.table?.mark(id);
      this.engine.canvas.style.cursor = id ? 'pointer' : '';
      if (id) audio.ui('hover');
    }
  };

  private pickRack(e: MouseEvent): WeaponId | null {
    const r = this.engine.canvas.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.engine.camera);
    return this.rack?.pick(this.raycaster) ?? null;
  }

  /** Fade from black → exterior establishing shot → glide to the safehouse → hand over control. */
  private runIntro(from: { position: THREE.Vector3; target: THREE.Vector3 }): void {
    this.phase = 'intro';
    this.ui.append(...this.letterbox, this.skip);
    const c = this.introCam;
    const p = this.player.position;
    Object.assign(c, { px: -18, py: 9, pz: 14, tx: 0, ty: 3, tz: -18 });
    const fade = document.getElementById('fade')!;
    gsap.set(fade, { opacity: 1 });
    void from;
    this.intro = gsap.timeline({ onComplete: () => this.finishIntro() })
      .to(fade, { opacity: 0, duration: 1.4, ease: 'power2.out' }, 0)
      .to(c, { px: -6, py: 5.5, pz: 6, duration: 4.5, ease: 'sine.inOut' }, 0)
      .to(c, { tx: 1, ty: 2.2, tz: -15, duration: 4.5, ease: 'sine.inOut' }, 0)
      .to(c, { px: 2.8, py: 2.1, pz: -11.5, tx: p.x, ty: 1.4, tz: p.z, duration: 2.6, ease: 'power2.inOut' }, 4.2)
      .to(fade, { opacity: 1, duration: 0.45, ease: 'power1.in' }, 6.4)
      .to(fade, { opacity: 0, duration: 0.6, ease: 'power1.out' }, 6.95);
    this.engine.camera.fov = 48;
    this.engine.camera.updateProjectionMatrix();
  }

  private quickStart(): void {
    gsap.set(document.getElementById('fade'), { opacity: 1 });
    this.phase = 'intro';
    this.finishIntro();
  }

  finishIntro(): void {
    if (this.phase !== 'intro') return;
    this.intro?.kill();
    this.intro = null;
    gsap.to(document.getElementById('fade'), { opacity: 0, duration: 0.6 });
    for (const el of [...this.letterbox, this.skip]) el.remove();
    this.phase = 'playing';
    this.cam.snapNext();
    this.hud.setVisible(true);
    this.hud.notify('MAPLE HOLLOW', 'THE SAFEHOUSE · 21:47 · GEAR UP BEFORE THEY ARRIVE', 3.2);
    this.input.enabled = true;
    this.input.requestLock();
    this.promptClick();
  }

  /** If the browser refused pointer lock (no gesture), wait for a click. */
  private promptClick(): void {
    setTimeout(() => {
      if (this.phase === 'playing' && !this.input.locked) this.ui.append(this.clickToPlay);
    }, 250);
  }

  private openPause(): void {
    this.phase = 'paused';
    this.input.clear();
    this.player.clearInput();
    this.clearIntents();
    this.inventory.hide();
    this.pause.show(this.ui);
  }

  private resume(): void {
    this.pause.hide();
    this.phase = 'playing';
    this.input.requestLock();
    this.promptClick();
  }

  private quit(): void {
    this.pause.hide();
    this.onQuit();
  }

  private clearIntents(): void {
    this.fireHeld = false;
    this.fireBuffer = 0;
    this.wantReload = this.wantMelee = this.wantHeal = false;
    this.wantSlot = null;
  }

  // ------------------------------------------------------------------ weapon table

  private openTable(): void {
    if (!this.rack || this.phase !== 'playing') return;
    this.phase = 'table';
    this.input.clear();
    this.player.clearInput();
    this.clearIntents();
    this.inventory.hide();
    this.input.releaseLock();
    this.hud.setPrompt(null);
    this.hud.setVisible(false);
    this.player.character.setVisible(false);
    this.weapon.setVisible(false);
    const cam = this.engine.camera;
    const look = this.tmpA.set(0, 0, -1).applyQuaternion(cam.quaternion).multiplyScalar(2).add(cam.position);
    Object.assign(this.tablePose, { px: cam.position.x, py: cam.position.y, pz: cam.position.z, tx: look.x, ty: look.y, tz: look.z });
    const v = this.rack.view;
    this.tableTween = gsap.to(this.tablePose, {
      px: v.position.x, py: v.position.y, pz: v.position.z, tx: v.target.x, ty: v.target.y, tz: v.target.z,
      duration: 0.75, ease: 'power2.inOut',
    });
    this.table = new WeaponTablePanel(this.me.arsenal.primary.id, {
      onHover: (id) => this.rack?.highlight(id, this.me.arsenal.primary.id),
      onPick: (id) => this.choose(id),
      onClose: () => this.closeTable(),
    });
    this.ui.append(this.table.el);
    gsap.fromTo(this.table.el, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.4, delay: 0.25, ease: 'power3.out' });
    audio.ui('click');
  }

  private choose(id: WeaponId): void {
    if (id === this.me.arsenal.primary.id) return;
    if (this.sim.selectPrimary(ME, id)) {
      settings.update((s) => { s.profile.primary = id; });
      this.table?.setCarried(id);
      this.rack?.highlight(this.hovered, id);
      audio.ui('click');
    }
  }

  private closeTable(): void {
    if (this.phase !== 'table') return;
    this.tableTween?.kill();
    this.tableTween = null;
    this.table?.el.remove();
    this.table = null;
    this.hovered = null;
    this.engine.canvas.style.cursor = '';
    this.rack?.highlight(null, this.me.arsenal.primary.id);
    this.player.character.setVisible(true);
    this.weapon.setVisible(true);
    this.hud.setVisible(true);
    this.phase = 'playing';
    this.cam.snapNext();
    this.input.requestLock();
    this.promptClick();
  }

  // ------------------------------------------------------------------ frame

  update(dt: number): void {
    const p = this.player;
    if (this.phase === 'intro') {
      const c = this.introCam;
      this.engine.camera.position.set(c.px, c.py, c.pz);
      this.engine.camera.lookAt(c.tx, c.ty, c.tz);
      p.render(dt, 1);
      this.weapon.update(dt, this.me.arsenal, { aim: 0, sprinting: false, aimPoint: this.cam.aimPoint });
      this.probe.update(dt, p.renderPosition, this.engine.camera);
      this.focus.set(c.tx, 0, c.tz);
      return;
    }

    if (this.phase === 'playing') this.gatherInput();

    // Fixed-step simulation, rendered with interpolation.
    const step = this.physics.fixedDt;
    const running = this.phase !== 'paused';
    if (running) this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= step && steps < 5) {
      p.fixedUpdate(step, this.cam.yaw);
      this.sim.setMotion(ME, p.motion(this.cam.yaw, this.cam.pitch));
      if (this.phase === 'playing') this.sendIntents(step);
      this.sim.step(step);
      this.doors.update(step, this.engine.camera, false);
      this.physics.step();
      this.accumulator -= step;
      steps++;
    }
    if (steps === 5) this.accumulator = 0;
    if (running) for (const e of this.sim.drain()) this.onEvent(e);
    const alpha = this.accumulator / step;
    // Frozen while paused: effects, corpses and timers wait too.
    const live = running ? dt : 0;

    for (let i = this.later.length - 1; i >= 0; i--) {
      const l = this.later[i];
      l.t -= live;
      if (l.t <= 0) {
        this.later.splice(i, 1);
        l.fn();
      }
    }

    p.render(dt, alpha);
    if (p.landed) {
      p.landed = false;
      this.cam.addTrauma(0.12);
      audio.footstep(0.8, this.indoors);
    }

    // Camera.
    if (this.phase === 'table') {
      const c = this.tablePose;
      this.engine.camera.position.set(c.px, c.py, c.pz);
      this.engine.camera.lookAt(c.tx, c.ty, c.tz);
      this.fovTo(dt, 50);
    } else if (this.phase === 'dead') {
      this.deathCamera(live);
    } else {
      this.cam.update(dt, p.renderPosition, p.eyeHeight, p.aiming && this.canAim, p.sprinting, this.adsSight());
    }
    this.focus.copy(p.renderPosition);

    // Body and hands.
    const a = this.me.arsenal;
    p.lookPitch = this.cam.pitch;
    if (this.phase === 'dead') {
      this.ragdoll?.update(live);
      this.updateDropped(live);
    } else {
      // First-person sights (the camera only moves into the eye while playing).
      const ads = this.phase === 'playing' || this.phase === 'paused' ? this.cam.ads : 0;
      const scope = this.sightFor(a.weapon.id)?.optic === 'scope' ? THREE.MathUtils.smoothstep(ads, 0.7, 0.95) : 0;
      this.weapon.hideHeld = scope > 0.5;
      // The fill light rides with the camera to keep the survivor readable; down the sights it
      // would only glare off the sights an inch from the eye.
      this.fill.intensity = 1.6 * (1 - 0.8 * ads);
      this.hud.setScope(scope);
      this.weapon.update(dt, a, { aim: a.aim, sprinting: p.sprinting, aimPoint: this.cam.aimPoint, ads, eye: this.cam.eye, view: this.cam.view });
    }
    this.probe.update(dt, this.ragdoll ? this.ragdoll.center(this.tmpA).setY(this.ragdoll.floorY) : p.renderPosition, this.engine.camera);

    // World.
    const renderTime = this.sim.time - step + alpha * step;
    this.zombies.update(live, this.sim, renderTime, this.engine.camera);
    this.limbs.update(live, this.sim, alpha, this.engine.camera, step);
    this.bleedHeldLimb(live);
    if (running) this.drops.update(live, renderTime);
    this.drops.helicopters(this.helis);
    audio.helicopters(this.phase === 'paused' ? new Map() : this.helis);
    this.effects.update(live, this.engine.camera);
    this.rack?.update(dt, this.engine.camera);

    this.updateHud(dt);

    // Location notices when crossing into a named area.
    this.areaCooldown -= dt;
    const area = areaAt(NEIGHBORHOOD, p.position);
    if (area !== this.area && this.areaCooldown <= 0 && this.phase === 'playing') {
      this.area = area;
      this.areaCooldown = 2.5;
      this.hud.notify(area, '', 1.6);
    }
  }

  private sightFor(id: WeaponId): Sight | null {
    let s = this.sights.get(id);
    if (s === undefined) {
      s = sightOf(id);
      this.sights.set(id, s);
    }
    return s;
  }

  /** The active weapon's sights when aiming should look down them (first person). */
  private adsSight(): Sight | null {
    if (settings.value.controls.aimView !== 'sights' || this.phase !== 'playing') return null;
    const a = this.me.arsenal;
    if (a.action === 'reload' || a.action === 'draw' || a.limb) return null;
    return this.sightFor(a.weapon.id);
  }

  private get canAim(): boolean {
    const a = this.me.arsenal;
    // Nothing to aim down while both hands are on a severed arm.
    return a.action !== 'melee' && a.action !== 'bandage' && !a.limb;
  }

  private fovTo(dt: number, fov: number): void {
    const c = this.engine.camera;
    if (Math.abs(c.fov - fov) < 0.01) return;
    c.fov += (fov - c.fov) * (1 - Math.exp(-dt * 6));
    c.updateProjectionMatrix();
  }

  private gatherInput(): void {
    const input = this.input;
    const p = this.player;
    this.cam.look(input);
    p.sampleInput(input, this.cam.yaw);
    const a = this.me.arsenal;
    if (a.action === 'bandage') p.blockSprint(0.1);

    this.fireHeld = input.held('fire');
    if (input.pressed('fire')) this.fireBuffer = 0.18;
    if (this.fireHeld || this.fireBuffer > 0) p.blockSprint(0.35);
    if (input.pressed('reload')) this.wantReload = true;
    if (input.pressed('weapon1')) this.wantSlot = 'primary';
    if (input.pressed('weapon2')) this.wantSlot = 'secondary';
    const wheel = input.consumeWheel();
    if (wheel !== 0) this.wantSlot = a.active === 'primary' ? 'secondary' : 'primary';
    if (input.pressed('melee')) this.wantMelee = true;
    if (input.pressed('heal')) {
      if (this.me.bandages <= 0) this.hud.feedLine('NO BANDAGES');
      else if (this.me.health >= PLAYER.maxHealth) this.hud.feedLine('HEALTH FULL');
      else this.wantHeal = true;
    }

    if (input.held('inventory')) this.inventory.show(this.ui, this.me, this.timerText());
    else this.inventory.hide();

    this.handleInteraction();
  }

  /** Intents for this fixed step (the Phase 4 client sends these as messages). */
  private sendIntents(step: number): void {
    const sim = this.sim;
    if (this.wantSlot) {
      sim.switchWeapon(ME, this.wantSlot);
      this.wantSlot = null;
    }
    if (this.wantMelee) {
      this.wantMelee = false;
      // The blow goes where the crosshair is (which arm, the head).
      const o = this.cam.aimOrigin, d = this.cam.aimDir;
      sim.melee(ME, { origin: { x: o.x, y: o.y, z: o.z }, dir: { x: d.x, y: d.y, z: d.z } });
    }
    if (this.wantHeal) {
      this.wantHeal = false;
      sim.bandage(ME);
    }
    if (this.wantReload) {
      this.wantReload = false;
      const w = this.me.arsenal.weapon;
      const empty = w.mag === 0;
      if (sim.reload(ME)) this.reloadFromEmpty = empty;
    }
    const a = this.me.arsenal;
    const pressed = this.fireBuffer > 0;
    this.fireBuffer = Math.max(0, this.fireBuffer - step);
    if (!this.fireHeld && !pressed) return;
    // Holding the trigger on an empty magazine clicks once, not every step.
    if (a.weapon.mag <= 0 && !pressed) return;
    if (!a.def.auto && !pressed) return;
    const o = this.cam.aimOrigin;
    const d = this.cam.aimDir;
    const r = sim.fire(ME, { x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, pressed, (Math.random() * 2 ** 31) | 1);
    if (r !== 'busy') this.fireBuffer = 0;
    if (r === 'dry' && a.action === 'reload') this.reloadFromEmpty = true;
  }

  private handleInteraction(): void {
    const best = this.pickInteraction();
    if (!best) {
      this.hud.setPrompt(null);
      return;
    }
    if (best.kind === 'door') this.hud.setPrompt('interact', best.door!.open ? 'CLOSE DOOR' : 'OPEN DOOR');
    else if (best.kind === 'ammo') this.hud.setPrompt('interact', `TAKE AMMUNITION · ${best.it!.supply} LEFT`);
    else if (best.kind === 'medical') this.hud.setPrompt('interact', `TAKE BANDAGES · ${best.it!.supply} LEFT`);
    else if (best.kind === 'supply') this.hud.setPrompt('interact', `TAKE UNIVERSAL AMMO · ${best.it!.supply} LEFT`);
    else if (best.kind === 'limb') {
      const l = best.limb!;
      const what = l.cut === 'shoulder' ? 'SEVERED ARM' : 'SEVERED FOREARM';
      this.hud.setPrompt('interact', `${this.me.arsenal.limb ? 'SWAP FOR' : 'PICK UP'} ${what} · ${l.wear} HIT${l.wear === 1 ? '' : 'S'}`);
    } else this.hud.setPrompt('interact', 'SELECT WEAPON');
    if (!this.input.pressed('interact')) return;
    if (best.kind === 'door') {
      best.door!.toggle(this.player.position);
      audio.door(best.door!.open);
    } else if (best.kind === 'weapons') {
      this.openTable();
    } else if (best.kind === 'limb') {
      this.sim.grabLimb(ME, best.limb!.id);
    } else {
      this.sim.use(ME, best.it!.id);
    }
  }

  /** What [E] acts on: the reachable thing closest to where the camera looks. */
  private pickInteraction(): Candidate | null {
    if (!this.me.alive) return null;
    const p = this.player.position;
    const eye = this.tmpA.set(p.x, p.y + 1.1, p.z);
    const cands: Candidate[] = [];
    const door = this.doors.nearest(eye, 1.9);
    if (door) cands.push({ kind: 'door', pos: door.center, door });
    for (const it of this.sim.reachable(ME)) {
      if (it.supply <= 0) continue;
      cands.push({ kind: it.kind, pos: new THREE.Vector3(it.pos.x, it.pos.y, it.pos.z), it });
    }
    // Severed arms within reach (not mid-swing or mid-bandage, when the hands are busy).
    const busy = this.me.arsenal.action === 'melee' || this.me.arsenal.action === 'bandage';
    if (!busy) {
      for (const l of this.sim.limbsInReach(ME)) {
        // Lying on the floor they are never close to the chest: count how near they are underfoot.
        cands.push({ kind: 'limb', pos: new THREE.Vector3(l.pos.x, l.pos.y, l.pos.z), limb: l, near: Math.hypot(l.pos.x - p.x, l.pos.z - p.z) });
      }
    }
    if (!cands.length) return null;
    const camPos = this.engine.camera.position;
    const fwd = this.cam.aimDir;
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of cands) {
      const toC = this.tmpB.subVectors(c.pos, camPos);
      const dist = toC.length();
      const angle = Math.acos(THREE.MathUtils.clamp(toC.divideScalar(dist || 1).dot(fwd), -1, 1));
      const near = c.near ?? c.pos.distanceTo(eye);
      // What the crosshair is on wins; something right beside you still counts.
      if (angle > 0.75 && near > 1.0) continue;
      const score = -angle * 3 - near * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ events

  private onEvent(e: SimEvent): void {
    const A = this.tmpA, B = this.tmpB, C = this.tmpC;
    switch (e.type) {
      case 'shot': {
        if (e.player !== ME) break;
        const def = WEAPONS[e.weapon];
        const muzzle = this.weapon.muzzleWorld(A);
        const dir = this.weapon.muzzleDir(B);
        this.effects.muzzle(muzzle, dir, e.weapon);
        for (let i = 0; i < e.pellets.length; i++) {
          // A shotgun's pellets would be a solid sheet of light; a few streaks read better.
          if (e.pellets.length > 1 && i % 3 !== 0) continue;
          this.effects.tracer(muzzle, v3(e.pellets[i].end, C));
        }
        audio.gunshot(e.weapon, muzzle, this.indoors, true);
        this.weapon.fired(def);
        const kick = (0.006 + def.recoil * 0.014) * (this.player.aiming ? 0.75 : 1) * (this.player.crouching ? 0.8 : 1);
        this.cam.addRecoil(kick, (Math.random() - 0.5) * def.recoil * 0.008);
        this.cam.addTrauma(0.04 + def.recoil * 0.05);
        this.player.faceCamera(0.7);
        if (e.weapon === 'shotgun') this.later.push({ t: 0.3, fn: () => this.ejectCasing(true) });
        else this.ejectCasing(false);
        break;
      }
      case 'dryFire':
        if (e.player === ME) audio.dryFire(this.handPos(), e.weapon);
        break;
      case 'impact': {
        v3(e.pos, A);
        this.effects.impact(A, v3(e.normal, B), e.surface, v3(e.dir, C));
        const now = performance.now();
        if (now - this.impactSoundAt > 35) {
          this.impactSoundAt = now;
          audio.impact(e.surface, A);
        }
        break;
      }
      case 'zombieHit': {
        v3(e.pos, A);
        v3(e.dir, B);
        const exit = e.exit ? { pos: new THREE.Vector3(e.exit.pos.x, e.exit.pos.y, e.exit.pos.z), normal: new THREE.Vector3(e.exit.normal.x, e.exit.normal.y, e.exit.normal.z) } : null;
        this.effects.blood(A, B, e.damage, { exit, killed: e.killed, head: e.zone === 'head', melee: e.melee });
        this.zombies.hit(e.zombie, e.zone, B, e.damage, e.melee);
        if (e.limb !== undefined) {
          // Clubbed with a severed arm: a wet, heavy thud, blood flung off its torn end.
          audio.clubHit(A, Math.min(1, e.damage / 50));
          this.effects.clubSplash(A, B);
          const held = e.by === ME ? this.weapon.heldLimb : null;
          if (held) this.effects.clubSplash(held.cutEnd(C), B);
          if (e.by === ME) this.cam.addTrauma(0.1 + Math.min(0.1, e.damage / 400));
        } else {
          audio.flesh(A, Math.min(1, e.damage / 60) + (e.melee ? 0.4 : 0));
        }
        if (e.by === ME) {
          const kind = e.killed ? (e.zone === 'head' ? 'head' : 'kill') : 'hit';
          this.hud.hitMarker(kind);
          audio.hitMarker(kind);
        }
        if (!e.killed && Math.random() < 0.4) audio.zombieHurt(this.zombies.headOf(e.zombie, C) ?? A, this.zombies.pitchOf(e.zombie));
        break;
      }
      case 'limbSevered':
        this.onSevered(e.zombie, e.arm, e.cut, v3(e.pos, A), v3(e.dir, B), e.melee, e.by === ME);
        break;
      case 'limbGrabbed':
        if (e.player !== ME) break;
        // Lifted from where it lay.
        if (this.limbs.liftPose(e.limb, A, this.liftQ)) this.weapon.liftFrom(e.limb, A, this.liftQ);
        audio.limbGrab(this.handPos());
        this.limbEndValid = false;
        if (!this.gripHinted) {
          this.gripHinted = true;
          const b = settings.value.controls.bindings;
          const key = (codes: string[]) => (codes[0] ? codeLabel(codes[0]) : '?');
          this.hud.notify('BEAT THEM WITH IT', `${key(b.fire)} OR ${key(b.melee)} SWING · ${key(b.weapon1)} / ${key(b.weapon2)} DROP IT FOR A GUN`, 3.2);
        }
        break;
      case 'limbDropped':
        break;
      case 'limbBroke': {
        v3(e.pos, A);
        v3(e.dir, B);
        this.effects.gibs(A, B);
        audio.limbBreak(A);
        if (e.player === ME) {
          this.hud.feedLine('THE ARM CAME APART');
          this.cam.addTrauma(0.12);
        }
        break;
      }
      case 'limbGone':
        this.limbs.gone(e.limb);
        break;
      case 'zombieDied': {
        const head = this.zombies.headOf(e.zombie, C);
        if (head) audio.zombieDeath(head, this.zombies.pitchOf(e.zombie));
        this.zombies.died(e.zombie, e.zone, v3(e.dir, B), e.force);
        break;
      }
      case 'zombieRemoved':
        this.zombies.removed(e.zombie);
        break;
      case 'zombieAlert':
        audio.zombieAlert(this.zombies.headOf(e.zombie, C) ?? v3(e.pos, A), this.zombies.pitchOf(e.zombie));
        break;
      case 'zombieAttack': {
        const head = this.zombies.headOf(e.zombie, C);
        if (head) audio.zombieAttack(head, this.zombies.pitchOf(e.zombie));
        break;
      }
      case 'zombieGroan':
        audio.groan(this.zombies.headOf(e.zombie, C) ?? v3(e.pos, A), 0.8, this.zombies.pitchOf(e.zombie));
        break;
      case 'doorPound':
        audio.doorPound(v3(e.pos, A));
        break;
      case 'doorForced': {
        v3(e.pos, A);
        audio.doorBurst(A);
        const d = this.doors.byIndex(e.door);
        if (d) {
          const n = d.body.normal;
          B.set(n.x, 0, n.z);
          // Splinters fly into the room the zombie broke into.
          if (B.dot(this.tmpC.subVectors(this.player.position, A)) < 0) B.negate();
          this.effects.splinters(A, B);
        }
        break;
      }
      case 'playerHurt':
        if (e.player === ME) this.onHurt(e.damage, e.from);
        break;
      case 'playerDied':
        if (e.player === ME) this.onDeath();
        break;
      case 'playerHealed':
        if (e.player === ME) this.hud.feedLine(`HEALTH +${Math.round(e.amount)}`);
        break;
      case 'reload':
        if (e.player !== ME) break;
        if (e.stage === 'shell') audio.foley('shellIn', this.handPos(), e.weapon);
        if (e.stage === 'end' && e.weapon === 'shotgun' && this.reloadFromEmpty) {
          this.weapon.cycleAction();
          this.later.push({ t: 0.12, fn: () => audio.foley('pump', this.handPos(), 'shotgun') });
        }
        if (e.stage === 'end' || e.stage === 'cancel') this.reloadFromEmpty = false;
        break;
      case 'melee':
        if (e.player !== ME) break;
        if (e.stage === 'swing') {
          if (e.limb) audio.heavySwing(this.handPos());
          else audio.meleeSwing(this.handPos());
          this.player.faceCamera(0.6);
          this.player.blockSprint(e.limb ? 0.85 : 0.6);
        }
        break;
      case 'bandage':
        if (e.player !== ME) break;
        if (e.stage === 'start') audio.bandage();
        if (e.stage === 'cancel') this.hud.feedLine('BANDAGE INTERRUPTED');
        break;
      case 'pickup':
        if (e.player !== ME) break;
        audio.pickup(e.item);
        if (e.item === 'ammo') this.hud.feedLine(`AMMUNITION +${e.amount}`);
        else if (e.item === 'supply') {
          this.hud.feedLine(`UNIVERSAL AMMO +${e.amount}`);
          this.hud.notify('ALL WEAPONS RESUPPLIED', 'Every gun you carry is full', 2.2);
        }
        else if (e.item === 'bandage') this.hud.feedLine(`BANDAGE +${e.amount}`);
        else if (e.weapon) this.hud.feedLine(`${WEAPONS[e.weapon].model} EQUIPPED`);
        break;
      case 'notice':
        if (e.player === ME || e.player === null) {
          if (e.text === 'SUPPLY DROP INBOUND') this.hud.notify(e.text, e.sub ?? '', 3.2);
          else this.hud.feedLine(e.text);
        }
        break;
      case 'heli':
        this.drops.flight(e.drop, e.flight);
        break;
      case 'supplyDrop':
        if (e.stage === 'empty') this.drops.emptied(e.drop, this.sim.time);
        else if (e.stage === 'gone') this.drops.gone(e.drop);
        break;
      case 'phase':
        if (e.phase === 'survival' && !this.outbreakAnnounced) {
          this.outbreakAnnounced = true;
          this.hud.notify('THE OUTBREAK HAS BEGUN', 'SURVIVE AS LONG AS YOU CAN', 3.6, 'danger');
          audio.outbreak();
        }
        break;
      default:
        break;
    }
  }

  /**
   * An arm torn off: the stump shows, blood bursts out of it both ways, the arm goes flying
   * (drawn from the simulation as it tumbles).
   */
  private onSevered(zombie: number, arm: ArmZone, cut: LimbCut, at: THREE.Vector3, dir: THREE.Vector3, melee: boolean, mine: boolean): void {
    // The torn end as drawn, where there is one on screen.
    this.zombies.severed(zombie, arm, cut, at, this.tmpC);
    this.effects.sever(at, dir, melee);
    audio.sever(at, melee);
    if (!mine) return;
    this.cam.addTrauma(melee ? 0.12 : 0.06);
    this.hud.feedLine(cut === 'shoulder' ? 'ARM TORN OFF' : 'FOREARM TORN OFF');
    if (!this.limbHinted) {
      this.limbHinted = true;
      this.hud.notify('ARM TORN OFF', 'PICK IT UP AND BEAT THEM WITH IT', 2.8);
    }
  }

  /** The arm in hand bleeds from its torn end, and flings blood off it when swung. */
  private bleedHeldLimb(dt: number): void {
    const held = this.phase !== 'dead' ? this.weapon.heldLimb : null;
    if (!held || dt <= 0) {
      this.limbEndValid = false;
      return;
    }
    const a = this.me.arsenal;
    const end = held.cutEnd(this.tmpA, this.tmpB);
    const vel = this.tmpC.subVectors(end, this.limbEnd).divideScalar(dt);
    const moving = this.limbEndValid && vel.lengthSq() > 9;
    this.limbEnd.copy(end);
    this.limbEndValid = true;
    const l = a.limb ? this.sim.limb(a.limb.id) : undefined;
    const fresh = l ? THREE.MathUtils.clamp(1 - (this.sim.time - l.bornAt) / 60, 0.2, 1) : 0.3;
    if (a.action === 'melee' && moving) {
      this.effects.fling(end, vel, 1.2 + fresh * 1.5);
      return;
    }
    this.limbDrip -= dt;
    if (this.limbDrip > 0) return;
    this.limbDrip = 0.14 + (1 - fresh) * 0.9 + Math.random() * 0.25;
    this.effects.drip(end.addScaledVector(this.tmpB, 0.02), this.player.velocity);
  }

  private ejectCasing(shell: boolean): void {
    if (!this.me.alive) return;
    const pos = this.tmpC;
    const dir = this.tmpD;
    this.weapon.ejectWorld(pos, dir);
    const p = this.player.position;
    const floor = this.physics.raycast(pos.x, pos.y, pos.z, 0, -1, 0, 3);
    this.effects.eject(pos, dir, floor !== null ? pos.y - floor : p.y, shell, this.player.velocity);
  }

  private onHurt(damage: number, from: Vec3): void {
    const p = this.player.position;
    const dx = from.x - p.x, dz = from.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const yaw = this.cam.yaw;
    const fwd = dx / len * -Math.sin(yaw) + dz / len * -Math.cos(yaw);
    const right = dx / len * Math.cos(yaw) + dz / len * -Math.sin(yaw);
    this.hud.damageFrom(Math.atan2(right, fwd), damage);
    this.lastHurtDir.set(-dx / len, 0, -dz / len);
    this.player.character.flinch('torso', -dx / len, -dz / len, Math.min(1, damage / 25));
    this.cam.addTrauma(0.22 + Math.min(0.4, damage / 60));
    this.hurtFlash = Math.min(1, this.hurtFlash + 0.35 + damage / 50);
    audio.playerHurt(Math.min(1, damage / 30));
    if (this.phase === 'table') this.closeTable();
  }

  private onDeath(): void {
    if (this.phase === 'dead') return;
    if (this.phase === 'table') this.closeTable();
    this.phase = 'dead';
    this.survivedAtDeath = this.outbreakAnnounced ? this.sim.phaseTime : 0;
    this.deathT = 0;
    this.deathYaw = this.cam.yaw;
    this.inventory.hide();
    this.input.enabled = false;
    this.input.clear();
    this.clearIntents();
    this.input.releaseLock();
    this.hud.setPrompt(null);
    this.hud.setVisible(false);
    audio.death();

    // The held weapon falls; the survivor goes limp.
    const held = this.weapon.heldModel;
    if (held) {
      const model = createWeaponModel(held.id);
      model.root.position.copy(held.root.position);
      model.root.quaternion.copy(held.root.quaternion);
      this.engine.scene.add(model.root);
      this.probe.attach(model.materials);
      const at = model.root.position;
      const hit = this.physics.raycast(at.x, at.y, at.z, 0, -1, 0, 3);
      const lie = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)),
      );
      const rest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2).multiply(lie);
      this.dropped = {
        model,
        vel: this.player.velocity.clone().multiplyScalar(0.5).add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 1, (Math.random() - 0.5) * 1.5)),
        spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8),
        floor: hit !== null ? at.y - hit + 0.035 : this.player.position.y + 0.035,
        rest,
        landed: false,
      };
    }
    this.weapon.setVisible(false);
    this.hud.setScope(0);
    const body = this.player.character;
    body.headHidden = false;
    const vel = this.player.velocity.clone().setY(0);
    this.player.kill();
    this.ragdoll = new Ragdoll(this.physics, body);
    this.ragdoll.start(vel, [{ joints: ZONE_PARTICLES.torso, impulse: this.lastHurtDir.clone().setY(0.2).multiplyScalar(1.6) }]);
    this.later.push({ t: 4.2, fn: () => this.showResults() });
  }

  private updateDropped(dt: number): void {
    const d = this.dropped;
    if (!d || d.landed) return;
    const r = d.model.root;
    d.vel.y -= 9.8 * dt;
    r.position.addScaledVector(d.vel, dt);
    r.rotateX(d.spin.x * dt);
    r.rotateY(d.spin.y * dt);
    r.rotateZ(d.spin.z * dt);
    if (r.position.y <= d.floor) {
      r.position.y = d.floor;
      if (Math.abs(d.vel.y) > 1.2) {
        audio.impact('metal', r.position);
        d.vel.set(d.vel.x * 0.4, -d.vel.y * 0.25, d.vel.z * 0.4);
        d.spin.multiplyScalar(0.3);
      } else {
        d.landed = true;
        gsap.to({ t: 0 }, {
          t: 1, duration: 0.25, ease: 'power2.out',
          onUpdate: function (this: gsap.core.Tween) { r.quaternion.slerp(d.rest, (this.targets()[0] as { t: number }).t); },
        });
      }
    }
  }

  private deathCamera(dt: number): void {
    this.deathT += dt;
    const c = this.ragdoll ? this.ragdoll.center(this.tmpA) : this.tmpA.copy(this.player.position);
    const t = this.deathT;
    const ease = 1 - Math.exp(-t * 0.8);
    const yaw = this.deathYaw + t * 0.12;
    const dist = 3.2 + ease * 1.2;
    const height = 1.4 + ease * 2.4;
    const cam = this.engine.camera;
    // Behind where the camera looked (camera forward is -Z rotated by yaw), drifting up and around,
    // held inside rooms by a sphere cast from the body.
    const dir = this.tmpC.set(Math.sin(yaw) * dist, height, Math.cos(yaw) * dist);
    const len = dir.length();
    dir.divideScalar(len);
    const oy = c.y + 0.4;
    const hit = this.physics.sphereCast(c.x, oy, c.z, dir.x, dir.y, dir.z, 0.25, len);
    const reach = hit !== null ? Math.max(0.6, hit - 0.1) : len;
    const target = this.tmpB.set(c.x + dir.x * reach, oy + dir.y * reach, c.z + dir.z * reach);
    const k = 1 - Math.exp(-dt * 2.5);
    cam.position.lerp(target, k);
    cam.lookAt(c.x, c.y + 0.2, c.z);
    this.fovTo(dt, 52);
  }

  private showResults(): void {
    if (this.results) return;
    this.input.releaseLock();
    this.results = new ResultsScreen({
      survived: this.survivedAtDeath,
      total: this.me.diedAt,
      stats: { ...this.me.stats },
      outbreak: this.outbreakAnnounced,
    }, () => this.onRetry(), () => this.onQuit());
    this.results.show(this.ui);
  }

  /** Seconds survived since the outbreak, frozen at death. */
  private survivedAtDeath = 0;

  // ------------------------------------------------------------------ HUD

  private timerText(): string {
    const s = this.sim;
    if (s.phase === 'preparation') return `OUTBREAK IMMINENT — ${clock(Math.ceil(s.phaseTime))}`;
    return `SURVIVED ${clock(s.phaseTime)}`;
  }

  private updateHud(dt: number): void {
    const hud = this.hud;
    const me = this.me;
    const a = me.arsenal;
    const def = a.def;
    const p = this.player;

    hud.setHealth(me.health, PLAYER.maxHealth);
    const limb = a.limb && !a.limb.broken ? a.limb : null;
    hud.weapon({
      model: limb ? (limb.cut === 'shoulder' ? 'SEVERED ARM' : 'SEVERED FOREARM') : def.model,
      mag: a.weapon.mag,
      magazine: def.magazine,
      reserve: a.weapon.reserve,
      mode: def.mode,
      reload: a.action === 'reload' ? a.progress : null,
      slot: a.active,
      primaryModel: WEAPONS[a.primary.id].model,
      secondaryModel: WEAPONS[a.secondary.id].model,
      bandages: me.bandages,
      healing: a.action === 'bandage' ? a.progress : null,
      hits: limb ? limb.wear : null,
      wear: limb ? limb.wear / limb.maxWear : null,
    });
    const s = this.sim;
    hud.setTimer(this.timerText(), s.phase === 'preparation' && s.phaseTime <= 10);

    this.updateWaypoint();

    // Ammunition warning: the active gun is down to its last magazine in total.
    const total = (w: { mag: number; reserve: number }) => w.mag + w.reserve;
    const allEmpty = total(a.primary) === 0 && total(a.secondary) === 0;
    const critical = total(a.weapon) <= def.magazine && def.mode !== 'MELEE';
    // (Not while the hands are full of something else to fight with.)
    hud.setWarning(limb ? '' : allEmpty ? 'OUT OF AMMUNITION · USE YOUR MACHETE' : critical && me.alive ? 'AMMUNITION CRITICAL' : '');

    // Dynamic crosshair: gap follows the real spread cone.
    const hv = Math.hypot(p.velocity.x, p.velocity.z);
    const spread = a.spread({ speed: hv, crouching: p.crouching, grounded: p.grounded, aiming: p.aiming });
    const cam = this.engine.camera;
    const px = (Math.tan((spread * Math.PI) / 180) / Math.tan((cam.fov * Math.PI) / 360)) * (window.innerHeight / 2);
    hud.setSpread(Math.min(70, px));
    // Down the sights, the sights are the crosshair.
    hud.setCrosshairVisible(this.phase === 'playing' && !p.sprinting && a.action !== 'bandage' && this.cam.ads < 0.4);
    hud.setStance(a.action === 'bandage' ? 'BANDAGING' : p.crouching ? 'CROUCHED' : p.sprinting ? 'SPRINTING' : '');
    hud.setFps(this.engine.fps);

    // Pain: hits flash the screen edges red; low health keeps a pulse there.
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.6);
    const hp = me.health / PLAYER.maxHealth;
    const low = me.alive ? THREE.MathUtils.clamp((0.4 - hp) / 0.4, 0, 1) : 1;
    const pulse = low > 0 ? 0.75 + 0.25 * Math.sin(performance.now() * 0.006) : 0;
    this.engine.post.uniforms.uDamage.value = Math.min(1, Math.max(this.hurtFlash * 0.9, low * 0.65 * pulse));
    audio.setVitals(me.alive ? low : 0);
  }

  /** Points the HUD at the newest supply drop that still has ammunition. */
  private updateWaypoint(): void {
    const m = this.phase === 'playing' && this.me.alive ? this.drops.marker() : null;
    if (!m) {
      this.hud.setWaypoint(false);
      return;
    }
    const cam = this.engine.camera;
    const dist = m.pos.distanceTo(this.player.position);
    if (dist < 2.6) {
      this.hud.setWaypoint(false);
      return;
    }
    const v = this.tmpA.copy(m.pos).project(cam);
    const behind = this.tmpB.subVectors(m.pos, cam.position).dot(cam.getWorldDirection(this.tmpC)) < 0;
    let x = v.x, y = v.y;
    if (behind) {
      x = -x;
      y = -y;
    }
    const off = behind || Math.abs(x) > 0.92 || Math.abs(y) > 0.88;
    let angle = 0;
    if (off) {
      // Pin to the screen edge in the direction of the drop.
      const k = 1 / Math.max(Math.abs(x) / 0.92, Math.abs(y) / 0.88, 1e-3);
      if (behind && Math.abs(x) < 0.2) x = x < 0 ? -0.2 : 0.2;
      x *= k;
      y *= k;
      angle = Math.atan2(x, y);
    }
    const label = m.stage === 'landed' ? 'UNIVERSAL AMMO' : 'SUPPLY DROP';
    this.hud.setWaypoint(true, (x + 1) / 2, (1 - y) / 2, off, angle, `${label} · ${Math.round(dist)} M`);
  }

  // ------------------------------------------------------------------ debugging (dev hook)

  /** Dev/test helpers: jump to the outbreak, place zombies around the survivor. */
  readonly debug = {
    skipPreparation: () => this.sim.skipPreparation(),
    spawnZombie: (dist = 8, angle = 0, kind: ZombieKind = 'walker') => {
      const p = this.player.position;
      const yaw = this.cam.yaw + angle;
      const at = { x: p.x - Math.sin(yaw) * dist, y: p.y + 0.02, z: p.z - Math.cos(yaw) * dist };
      return this.sim.spawnZombie(kind, at, 'approach').id;
    },
    phase: () => this.phase,
    /** Calls a supply helicopter now (during the outbreak). */
    supplyDrop: () => this.sim.callSupplyDrop()?.flight ?? null,
  };

  dispose(): void {
    this.abort.abort();
    this.unsubSettings();
    this.intro?.kill();
    this.tableTween?.kill();
    for (const el of [...this.letterbox, this.skip, this.clickToPlay]) el.remove();
    this.table?.el.remove();
    this.results?.dispose();
    this.inventory.dispose();
    this.engine.canvas.style.cursor = '';
    this.input.enabled = false;
    this.input.releaseLock();
    this.input.clear();
    this.hud.dispose();
    this.pause.hide();
    this.sim.dispose();
    this.zombies.dispose();
    this.limbs.dispose();
    this.drops.dispose();
    audio.helicopters(new Map());
    this.effects.dispose();
    this.rack?.dispose();
    this.weapon.dispose();
    clearSeveredCache();
    if (this.dropped) {
      this.dropped.model.dispose();
      this.dropped.model.root.removeFromParent();
    }
    this.player.dispose();
    this.fill.removeFromParent();
    this.fill.dispose();
    this.engine.post.uniforms.uDamage.value = 0;
    audio.setVitals(0);
  }
}
