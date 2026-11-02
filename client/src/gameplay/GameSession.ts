import * as THREE from 'three';
import gsap from 'gsap';
import {
  BARRICADE, DOWNED, GAME, HORDES, MELEE, Mirror, NEIGHBORHOOD, hordeAt, PLAYER, PRIMARY_WEAPONS, SERUM, SKATEBOARD, Simulation, WEAPONS, LIMB_NAME, encodeAppearance, isLeg, packMotion, sanitizeAppearance,
  buildable, defaultBuild, encodeBuild, sanitizeBuild, type WeaponBuild,
  type ActMsg, type BarricadeSlot, type ArsenalTick, type BeginMsg, type Interactable, type LimbCut, type LimbZone, type MapDefinition, type NavGrid,
  type OverMsg, type PlayerMotion, type SimEvent, type SimLimb, type SimPlayer, type Skateboard, type ThrowKind, type Vec3, type WeaponId, type ZombieKind,
} from '@dead-hours/shared';
import type { Engine } from '../core/Engine';
import { actionLabel, onDeviceChange, typing, type Input } from '../core/Input';
import type { Physics } from '../core/Physics';
import { settings, type Action } from '../core/Settings';
import { PlayerController } from './PlayerController';
import { ThirdPersonCamera } from './ThirdPersonCamera';
import type { Door, DoorSystem } from './Doors';
import { WeaponRack } from './WeaponRack';
import { SupplyDrops } from './SupplyDrops';
import { RemoteSurvivors } from './RemoteSurvivors';
import type { NetLink } from '../network/NetLink';
import { account } from '../network/Account';
import { survivorLook } from '../characters/Humanoid';
import { Ragdoll, ZONE_PARTICLES } from '../characters/Ragdoll';
import { PlayerWeapon } from '../weapons/PlayerWeapon';
import { clearSeveredCache } from '../characters/Severed';
import { setZombieDetail } from '../characters/Decay';
import { createWeaponModel, sightOf, type Sight, type WeaponModel } from '../weapons/WeaponModels';
import { Effects } from '../effects/Effects';
import { Pyro, type BurnPoint } from '../effects/Pyro';
import { Throwables } from './Throwables';
import { clearGibCache } from '../characters/Gibs';
import { ZombieView } from '../zombies/ZombieView';
import { RaidView } from './RaidView';
import { LimbView } from '../zombies/LimbView';
import { BarricadeView } from './BarricadeView';
import { MeleePickups } from './MeleePickups';
import { SkateboardView, type BoardPose } from './Skateboards';
import { HUD, clock } from '../ui/HUD';
import { PauseMenu } from '../ui/PauseMenu';
import { ChatBox } from '../ui/ChatBox';
import { Inventory } from '../ui/Inventory';
import { ResultsScreen, TeamResults } from '../ui/ResultsScreen';
import { WeaponTablePanel } from '../ui/WeaponTablePanel';
import { TouchControls } from '../ui/TouchControls';
import { AimAssist } from './AimAssist';
import { GunsmithPanel } from '../ui/GunsmithPanel';
import { GunsmithStage } from '../weapons/GunsmithStage';
import { audio } from '../audio/AudioEngine';
import { ChestLamp, flashlight } from './Flashlight';
import { Acoustics } from '../audio/Acoustics';
import { h } from '../ui/dom';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';

/** 'gunsmith': customizing the guns in the field (the night goes on around the survivor). */
type Phase = 'intro' | 'playing' | 'paused' | 'table' | 'gunsmith' | 'dead';

interface Smith {
  stage: GunsmithStage;
  panel: GunsmithPanel;
  el: HTMLElement;
  /** Opened from the workbench (the weapon table's panel comes back on closing). */
  bench: boolean;
}

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

const v3 = (v: Vec3, out: THREE.Vector3) => out.set(v.x, v.y, v.z);
/** Motion messages a second to the server. */
const MOTION_RATE = 30;

export interface SessionOptions {
  /** Retry: straight into play, no establishing shot. */
  skipIntro?: boolean;
  /** An online night: the room it is played in and how it began. */
  online?: { link: NetLink; begin: BeginMsg };
  /** Online: back to the room's lobby after the night (otherwise only leaving is offered). */
  onLobby?: () => void;
}

interface Candidate {
  kind: 'door' | 'limb' | 'revive' | 'board' | Interactable['kind'];
  pos: THREE.Vector3;
  door?: Door;
  it?: Interactable;
  limb?: SimLimb;
  mate?: SimPlayer;
  board?: Skateboard;
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
 * A play session. Solo: the survivor's browser runs the simulation itself. Online: the
 * simulation runs on the server and this keeps a mirror of it (never stepped here); the
 * survivor's own movement is simulated locally and sent ~30 times a second, actions go up as
 * messages and are shown at once (fire, swing, reload, switch, bandage), and everything else
 * is drawn from the server's snapshots and events, exactly as solo draws its own simulation.
 */
export class GameSession {
  readonly player: PlayerController;
  readonly cam: ThirdPersonCamera;
  readonly sim: Simulation;
  readonly me: SimPlayer;
  /** This survivor's id in the simulation ('p1' solo, the room session id online). */
  readonly myId: string;
  private readonly link: NetLink | null;
  readonly mirror: Mirror | null;
  private readonly remotes: RemoteSurvivors | null;
  private motionT = 0;
  private teamResults: TeamResults | null = null;
  /** Online, after dying: whose fight the camera follows. */
  private watching: string | null = null;
  private readonly hud: HUD;
  private readonly pause: PauseMenu;
  private readonly inventory = new Inventory();
  private readonly weapon: PlayerWeapon;
  private readonly effects: Effects;
  private readonly pyro: Pyro;
  private readonly throws: Throwables;
  private readonly burnPoints: BurnPoint[] = [];
  private wantThrow: ThrowKind | null = null;
  private readonly zombies: ZombieView;
  private readonly raid: RaidView;
  private readonly limbs: LimbView;
  private readonly barricades: BarricadeView;
  /** Boarding up or prying off: which opening, and how far into this board (this survivor's own estimate online). */
  private work: { slot: number; kind: 'board' | 'pry'; t: number } | null = null;
  /** Found melee weapons lying around indoors. */
  private readonly pickups: MeleePickups;
  private meleeHinted = false;
  /** Skateboards lying about and under riders' feet. */
  private readonly skates: SkateboardView;
  private skateHinted = false;
  /** Online: when this survivor asked to hop on (the server may have given the board to someone else). */
  private rideAskedAt = 0;
  /** Online: when this survivor said a wall threw them (the server's echo of it is not shown twice). */
  private bailSentAt = -Infinity;
  private readonly myBoard: BoardPose = { pos: new THREE.Vector3(), yaw: 0, lean: 0, pop: -1, air: false, push: -1 };
  private readonly drops: SupplyDrops;
  private readonly helis = new Map<number, { pos: THREE.Vector3; hover: number }>();
  private readonly rack: WeaponRack | null = null;
  private table: WeaponTablePanel | null = null;
  private smith: Smith | null = null;
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
  /** On-screen thumb controls (shown on touch screens while playing). */
  private readonly touch: TouchControls;
  private readonly assist: AimAssist;
  private readonly fill = new THREE.PointLight(0xa8b8d0, 1.6, 9, 1.5);
  /** The flashlight clipped to the survivor's chest. */
  private readonly lamp: ChestLamp;
  private readonly tmpTorchDir = new THREE.Vector3();
  private readonly tmpTorchAt = new THREE.Vector3();
  private readonly unsubSettings: () => void;
  private readonly doorColliders = new Set<number>();

  // Intents gathered per frame, sent to the simulation in the next fixed step.
  private fireHeld = false;
  private fireBuffer = 0;
  private wantReload = false;
  private wantSlot: 'primary' | 'secondary' | null = null;
  private wantMelee = false;
  private wantHeal = false;

  private readonly later: { t: number; fn: () => void }[] = [];
  private hurtFlash = 0;
  private impactSoundAt = 0;
  private lastHurtDir = new THREE.Vector3(0, 0, 1);
  private ragdoll: Ragdoll | null = null;
  private readonly sights = new Map<string, Sight | null>();
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
  private crawlHinted = false;
  private screamHinted = false;
  /** When a bloater last burst (the arms it tears off then go unannounced). */
  private burstAt = -1;
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
  private readonly tmpE = new THREE.Vector3();
  private readonly tmpVoice = new THREE.Vector3();
  /** Online: the room's chat over the game, and who is talking. */
  private chatBox: ChatBox | null = null;
  private voxList: HTMLElement | null = null;
  /** The speaking list over the chat lines, in one column (they printed over each other). */
  private commsHud: HTMLElement | null = null;
  private voxKey = '';

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
    private readonly opts: SessionOptions = {},
  ) {
    const online = opts.online ?? null;
    const spawn = online ? online.begin.spawn : NEIGHBORHOOD.playerSpawns[0];
    doors.reset();
    for (const b of doors.bodies) if (b) this.doorColliders.add(b.collider.handle);
    // Shots echo by the space they're in and are muffled by the walls they come through.
    audio.setAcoustics(new Acoustics(physics));

    // The simulation: authoritative here (solo), or the copy of the server's (online).
    this.sim = new Simulation({
      physics, map: NEIGHBORHOOD, nav, doors: doors.bodies,
      seed: online ? online.begin.seed : (Math.random() * 2 ** 31) | 0, preparation: GAME.preparationSeconds,
    });
    this.link = online?.link ?? null;
    this.myId = online ? online.link.id : 'p1';
    const profile = settings.value.profile;
    const primary = (PRIMARY_WEAPONS as string[]).includes(profile.primary) ? (profile.primary as WeaponId) : 'ar';
    const look = sanitizeAppearance(profile.appearance);
    this.me = this.sim.addPlayer(this.myId, profile.name, primary, 'pistol', { x: spawn.x, y: spawn.y, z: spawn.z }, spawn.yaw, encodeAppearance(look), account.loadout);
    this.mirror = online ? new Mirror(this.sim, this.myId) : null;
    this.remotes = online ? new RemoteSurvivors(engine.scene, physics, field, ui, this.myId) : null;

    // Survivor, dressed as the profile's character.
    this.player = new PlayerController(physics, spawn, survivorLook(look));
    engine.scene.add(this.player.character.root);
    this.probe = new DynamicProbe(field);
    this.probe.attach(this.player.character.surfaces());
    this.player.character.onFootstep = (l) => audio.footstep(l, this.indoors);
    this.weapon = new PlayerWeapon(engine.scene, this.player.character);
    this.probe.attach(this.weapon.materials());
    this.weapon.onMaterials = (m) => this.probe.attach(m);
    this.weapon.onCue = (cue, weapon, inS) => audio.foley(cue, this.handPos(), weapon, inS, true);
    this.lamp = new ChestLamp(this.player.character);
    this.probe.attach(this.lamp.materials());
    this.cam = new ThirdPersonCamera(engine.camera, physics);
    this.cam.yaw = spawn.yaw;
    this.focus.copy(this.player.position);
    this.area = areaAt(NEIGHBORHOOD, this.player.position);
    // Soft fill that travels with the camera so the survivor stays readable at night.
    this.fill.position.set(0, 0.4, 0.6);
    // A soft readability light: it would only add a glowing ball around the camera in the fog.
    this.fill.userData.noFog = true;
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
    // Every zombie look built and its shaders compiled now, while the screen is dark, so the first
    // horde doesn't stutter (each new look costs a frame 10-80 ms otherwise).
    this.zombies.warm(engine.renderer, engine.camera, engine.scene);
    this.raid = new RaidView(engine.scene, physics, field);
    this.zombies.onCorpseSettled = (pos) => this.effects.pool(pos, 0.9 + Math.random() * 0.5, 120);
    this.zombies.onStep = (pos, gait, loudness) => audio.zombieStep(pos, gait, loudness);
    this.zombies.gibs.onLand = (pos, strength) => audio.limbLand(pos, strength);
    // Grenades and Molotovs: the blasts, the fires and the throws.
    this.pyro = new Pyro(engine.scene, physics, this.effects.decals);
    this.pyro.onBlastNear = (k) => this.cam.addTrauma(0.15 + k * 0.75);
    this.throws = new Throwables(engine.scene, physics, this.pyro);
    this.limbs = new LimbView(engine.scene, field, this.effects);
    this.pickups = new MeleePickups(engine.scene, field);
    this.skates = new SkateboardView(engine.scene, field, physics);
    this.limbs.onLand = (pos, strength) => audio.limbLand(pos, strength);
    this.barricades = new BarricadeView(engine.scene, this.sim, field);
    this.drops = new SupplyDrops(engine.scene);
    this.drops.onSmoke = (pos, strong) => this.effects.flareSmoke(pos, strong);
    this.drops.onLand = (pos) => {
      this.effects.landingDust(pos);
      audio.crateLand(pos);
    };
    const bench = NEIGHBORHOOD.props.find((p) => p.use === 'weapons');
    if (bench) {
      this.rack = new WeaponRack(engine.scene, bench, field);
      this.rack.setBuilds(this.me.arsenal.builds);
      this.rack.highlight(null, this.me.arsenal.primary.id);
    }
    this.applySettings();
    this.unsubSettings = settings.subscribe(() => this.applySettings());

    // Interface.
    this.hud = new HUD(profile.name);
    this.hud.el.style.opacity = '0';
    ui.append(this.hud.el);
    this.pause = new PauseMenu(input, () => this.resume(), () => this.quit(), !!online, online?.link ?? null);
    if (online) {
      this.chatBox = new ChatBox(online.link, 'game', () => this.input.clear());
      this.voxList = h('div', { class: 'vox-list' });
      this.commsHud = h('div', { class: 'comms-hud' }, this.voxList, this.chatBox.el);
      ui.append(this.commsHud);
      online.link.voice.setInGame(true);
    }
    this.touch = new TouchControls(input, !!online);
    this.touch.setVisible(false);
    this.touch.setLight(flashlight()?.on ?? true);
    ui.append(this.touch.el);
    this.hud.onPrompt = (action, text) => this.touch.setUse(action, text);
    this.assist = new AimAssist(physics);
    this.letterbox = [h('div', { class: 'letterbox top' }), h('div', { class: 'letterbox bottom' })];
    this.skip = h('div', { class: 'skip' });
    this.clickToPlay = h('div', { class: 'click-to-play' }, 'CLICK TO CONTINUE');
    const sig = { signal: this.abort.signal };
    document.addEventListener('pointerlockchange', this.onLockChange, sig);
    window.addEventListener('keydown', this.onKeyDown, sig);
    engine.canvas.addEventListener('click', this.onCanvasClick, sig);
    engine.canvas.addEventListener('mousemove', this.onCanvasMove, sig);
    const offDevice = onDeviceChange((d) => {
      // Back on the mouse mid-game: it has to be captured again with a click.
      if (d === 'mouse' && this.phase === 'playing' && !this.input.locked) this.ui.append(this.clickToPlay);
      else if (d !== 'mouse') this.clickToPlay.remove();
      if (this.phase === 'intro') this.skip.textContent = this.skipHint();
    });
    this.abort.signal.addEventListener('abort', offDevice);
    // Tapping the spectator line brings the results back (as Escape does).
    this.spectateLine.addEventListener('click', () => {
      if (this.phase !== 'dead' || !this.watching) return;
      this.watching = null;
      this.showResults();
    }, sig);
    if (opts.skipIntro || online) this.quickStart();
    else this.runIntro(startPose);
  }

  private applySettings(): void {
    const g = settings.value.graphics;
    this.effects.setQuality(g.particleQuality, g.gore, settings.value.accessibility.reducedFlashing);
    this.zombies.gore = g.gore !== 'off';
    // Phone and low presets: zombie flesh without the finest noise and veins.
    setZombieDetail(g.particleQuality === 'low' ? 'lite' : 'full');
    this.limbs.gore = g.gore !== 'off';
    this.weapon.gore = g.gore !== 'off';
    this.zombies.gibs.setGore(g.gore !== 'off');
    this.pyro.setQuality(g.particleQuality, settings.value.accessibility.reducedFlashing);
    this.remotes?.setGore(g.gore !== 'off');
    this.raid.setGore(g.gore !== 'off');
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
    // Fallen (watching or on the results), the chat still opens.
    if (this.phase === 'dead' && this.chatBox && !this.chatBox.isOpen && !typing(e) && settings.value.controls.bindings.chat.includes(e.code)) {
      e.preventDefault();
      this.chatBox.open();
      return;
    }
    if (this.phase === 'dead' && this.watching && e.code === 'Escape') {
      this.watching = null;
      this.showResults();
      return;
    }
    if (this.phase === 'intro') {
      this.finishIntro();
      return;
    }
    if (this.smith) {
      const b = settings.value.controls.bindings;
      if (e.code === 'Escape' || b.interact.includes(e.code) || b.gunsmith.includes(e.code)) this.closeGunsmith();
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
    // Escape while typing closes the chat (the browser lets go of the mouse too): back in with a click.
    if (this.phase === 'playing' && !this.input.engaged && this.chatBox?.isOpen) {
      this.chatBox.close();
      this.ui.append(this.clickToPlay);
    } else if (this.phase === 'playing' && !this.input.engaged) this.openPause();
    if (this.input.locked) this.clickToPlay.remove();
  };

  private onCanvasClick = (e: MouseEvent): void => {
    // A tap skips the opening shot on touch screens (there is no key to press).
    if (this.phase === 'intro') {
      this.finishIntro();
      return;
    }
    if (this.phase === 'playing' && this.input.device === 'mouse' && !this.input.locked) this.input.requestLock();
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
    this.skip.textContent = this.skipHint();
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

  /** What skips the opening shot here: any key, a tap anywhere (onCanvasClick), or B / Start (Escape from PadMenus). */
  private skipHint(): string {
    const d = this.input.device;
    return d === 'touch' ? 'TAP TO SKIP' : d === 'pad' ? 'PRESS B TO SKIP' : 'PRESS ANY KEY TO SKIP';
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
    if (this.input.device === 'mouse') this.input.requestLock();
    this.promptClick();
  }

  /** If the browser refused pointer lock (no gesture), wait for a click. */
  private promptClick(): void {
    setTimeout(() => {
      if (this.phase === 'playing' && !this.input.engaged) this.ui.append(this.clickToPlay);
    }, 250);
  }

  private openPause(): void {
    this.phase = 'paused';
    // Normally the mouse is already free (letting it go is what opens this); make sure the menu can be clicked.
    this.input.releaseLock();
    this.input.clear();
    this.player.clearInput();
    this.clearIntents();
    this.inventory.hide();
    this.pause.show(this.ui);
  }

  private resume(): void {
    this.pause.hide();
    this.phase = 'playing';
    if (this.input.device === 'mouse') this.input.requestLock();
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
    this.stopReviving();
  }

  // ------------------------------------------------------------------ downed and revives

  /** The downed teammate this survivor is holding interact on, and when that was asked for. */
  private reviveTarget: string | null = null;
  private reviveAskedAt = 0;
  /** This survivor is shown downed (follows the sim: an event or a snapshot can put them there). */
  private shownDown = false;
  private readonly downPanel = h('div', { class: 'downed-panel' });
  private readonly downText = h('div', { class: 'dp-text' });
  private readonly downFill = h('i');

  private startReviving(mate: SimPlayer): void {
    if (this.reviveTarget === mate.id) return;
    this.reviveTarget = mate.id;
    this.reviveAskedAt = this.netNow;
    this.player.clearInput();
    if (this.link) this.act({ a: 'revive', target: mate.id });
    else this.sim.revive(this.myId, mate.id);
  }

  private stopReviving(): void {
    if (!this.reviveTarget) return;
    this.reviveTarget = null;
    if (this.link) this.link.act({ a: 'revive', target: null });
    else this.sim.revive(this.myId, null);
  }

  /** Holding interact on a downed teammate: stay put and keep holding until they are up. */
  private keepReviving(): boolean {
    const id = this.reviveTarget;
    if (!id) return false;
    const mate = this.sim.players.get(id);
    const lost = !mate || !mate.downed || !this.me.up
      // The server never took it (someone else got there first).
      || (mate.reviver !== this.myId && this.netNow - this.reviveAskedAt > (this.link ? this.link.rtt + 1.5 : 0.1));
    if (lost || !this.input.held('interact')) {
      this.stopReviving();
      return false;
    }
    this.player.clearInput();
    this.fireHeld = false;
    this.fireBuffer = 0;
    const k = mate.reviver === this.myId ? Math.min(1, mate.revive / DOWNED.reviveTime) : 0;
    this.hud.setPrompt('interact', `REVIVING ${mate.name.toUpperCase()} · ${Math.round(k * 100)}%`);
    return true;
  }

  /** Puts this survivor on the ground or back on their feet when the sim says so. */
  private syncDowned(): void {
    const down = this.me.alive && this.me.downed;
    if (down === this.shownDown || this.phase === 'dead') return;
    this.shownDown = down;
    this.player.setDowned(down);
    if (down) {
      if (this.phase === 'table') this.closeTable();
      this.clearIntents();
      this.inventory.hide();
      this.weapon.setVisible(false);
      this.hud.setPrompt(null);
      this.hud.setScope(0);
      const last = this.me.downs >= DOWNED.maxDowns;
      this.hud.notify('YOU ARE DOWN', last ? 'ONE MORE AND YOU ARE DEAD · HOLD ON' : 'HOLD ON · A TEAMMATE CAN GET YOU UP', 3, 'danger');
      this.downPanel.replaceChildren(this.downText, h('div', { class: 'dp-bar' }, this.downFill));
      this.ui.append(this.downPanel);
      audio.playerHurt(1);
    } else {
      this.weapon.setVisible(true);
      this.downPanel.remove();
      this.hud.notify('BACK ON YOUR FEET', '', 1.6);
    }
  }

  private updateDownPanel(): void {
    if (!this.shownDown) return;
    const me = this.me;
    const helper = me.reviver ? this.sim.players.get(me.reviver) : null;
    const text = helper
      ? `${helper.name.toUpperCase()} IS GETTING YOU UP`
      : `BLEEDING OUT · ${Math.max(0, Math.ceil(me.bleed))}`;
    if (this.downText.textContent !== text) this.downText.textContent = text;
    const k = helper ? me.revive / DOWNED.reviveTime : me.bleed / DOWNED.bleedOut;
    this.downFill.style.width = `${(THREE.MathUtils.clamp(k, 0, 1) * 100).toFixed(1)}%`;
    this.downPanel.classList.toggle('helped', !!helper);
  }

  // ------------------------------------------------------------------ gunsmith

  /**
   * Customizing the carried guns: in the field (the night goes on, so it closes when hit) or
   * from the workbench. The gun is held up in front of the camera, side-on, with clickable
   * labels on its fittings; hovering an option shows it on the gun, clicking fits it for real
   * (the gun in hand is down for a moment while that's done).
   */
  private openGunsmith(bench: boolean): void {
    if (this.smith || (bench ? this.phase !== 'table' : this.phase !== 'playing') || !this.me.up) return;
    const a = this.me.arsenal;
    const guns = [a.primary.id, a.secondary.id].filter(buildable);
    if (!guns.length) return;
    if (bench) this.table?.el.remove();
    else {
      this.phase = 'gunsmith';
      this.input.clear();
      this.player.clearInput();
      this.clearIntents();
      this.inventory.hide();
      this.input.releaseLock();
      this.hud.setPrompt(null);
    }
    const stage = new GunsmithStage(true);
    stage.onMaterials = (m) => this.probe.attach(m);
    const buildOf = (id: WeaponId) => this.me.arsenal.builds[id] ?? defaultBuild(id);
    const panel = new GunsmithPanel(guns, buildOf, () => account.unlocks, () => account.xp, {
      onWeapon: (id) => stage.show(id, buildOf(id)),
      onPreview: (id, b) => stage.show(id, b ?? buildOf(id)),
      onApply: (id, b) => this.refit(id, b, panel),
      onSlot: (slot) => stage.face(slot),
    }, bench ? 'WORKBENCH' : 'GUNSMITH');
    if (a.active === 'secondary' && guns.includes(a.secondary.id)) panel.selectWeapon(a.secondary.id);
    stage.show(panel.current, buildOf(panel.current));
    stage.face(panel.currentSlot);
    this.engine.camera.add(stage.holder);
    const drag = h('div', {
      class: 'gs-drag',
      onpointerdown: (e: Event) => stage.pointerDown(e as PointerEvent),
    });
    const move = (e: PointerEvent) => stage.pointerMove(e);
    const up = () => stage.pointerUp();
    window.addEventListener('pointermove', move, { signal: this.abort.signal });
    window.addEventListener('pointerup', up, { signal: this.abort.signal });
    const el = h('div', { class: 'gs-layer' },
      bench ? null : h('div', { class: 'gs-field-veil' }),
      drag,
      panel.labels,
      h('div', { class: 'panel gunsmith-panel', role: 'dialog', 'aria-label': 'Gunsmith' },
        h('button', { class: 'panel-close', onclick: () => { audio.ui('back'); this.closeGunsmith(); } }, bench ? '◂ WEAPONS' : 'CLOSE ✕'),
        panel.el,
        h('p', { class: 'gs-hint' }, this.gunsmithHint(bench)),
      ),
    );
    this.smith = { stage, panel, el, bench };
    this.ui.append(el);
    gsap.fromTo(el.querySelector('.gunsmith-panel'), { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.35, ease: 'power3.out' });
    audio.ui('click');
  }

  /** How to turn the gun and leave, in the words of the device in hand (a phone or a pad has no [Esc]). */
  private gunsmithHint(bench: boolean): string {
    const d = this.input.device;
    const field = 'The night goes on: you stand still, and a hit closes this.';
    if (d === 'pad') return bench ? 'A on an option fits it. B back to the weapon table.' : `${field} B to put it away.`;
    if (d === 'touch') return bench ? 'Drag the gun to turn it. Tap a label on it or pick below. ◂ WEAPONS goes back to the weapon table.' : `${field} Drag the gun to turn it. CLOSE puts it away.`;
    const key = actionLabel('gunsmith');
    return bench
      ? 'Drag the gun to turn it. Click a label on it or pick below. [Esc] back to the weapon table.'
      : `${field} Drag the gun to turn it. ${key ? `[${key}] or ` : ''}[Esc] to put it away.`;
  }

  /** Puts the gun away (`keepTable`: the weapon table is closing too, don't bring its panel back). */
  private closeGunsmith(keepTable = false): void {
    const s = this.smith;
    if (!s) return;
    this.smith = null;
    s.stage.dispose();
    s.el.remove();
    if (s.bench) {
      if (!keepTable && this.table && this.phase === 'table') this.ui.append(this.table.el);
      return;
    }
    if (this.phase === 'gunsmith') {
      this.phase = 'playing';
      this.cam.snapNext();
      this.input.requestLock();
      this.promptClick();
    }
  }

  private updateGunsmith(dt: number): void {
    const s = this.smith;
    if (!s) return;
    s.stage.update(dt);
    // Held up in front of the camera, a little left of center (the panel takes the right), filling about half the width.
    const cam = this.engine.camera;
    const tanH = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.aspect;
    const d = Math.max(0.35, s.stage.radius / (0.5 * tanH));
    s.stage.holder.position.set(-0.32 * d * tanH, -0.02 * d, -d);
    const r = this.engine.canvas.getBoundingClientRect();
    s.panel.place(s.stage.hotspots(cam, r.width, r.height));
  }

  /** Fits a build to a carried gun: at once in solo, predicted and sent to the server online. */
  private refit(id: WeaponId, want: WeaponBuild, panel: GunsmithPanel | null = this.smith?.panel ?? null): void {
    const build = sanitizeBuild(id, want, account.unlocks);
    const code = encodeBuild(build);
    if (this.link) {
      if (!this.me.arsenal.refit(id, build)) {
        panel?.setNote('HANDS ARE BUSY · TRY AGAIN IN A MOMENT');
        return;
      }
      this.act({ a: 'refit', weapon: id, build: code });
      this.onEvent({ type: 'refit', player: this.myId, weapon: id, build: code });
      // Should the server refuse, the next snapshot after this puts the real build back.
      this.later.push({ t: 1.5, fn: () => this.mirror?.forgetBuilds(this.myId) });
    } else if (!this.sim.refit(this.myId, id, build)) {
      panel?.setNote('HANDS ARE BUSY · TRY AGAIN IN A MOMENT');
      return;
    }
    // Saved to the profile: the next night starts with it too.
    account.setLoadout({ ...account.loadout, [id]: build });
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
      onGunsmith: () => this.openGunsmith(true),
    });
    this.ui.append(this.table.el);
    gsap.fromTo(this.table.el, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.4, delay: 0.25, ease: 'power3.out' });
    audio.ui('click');
  }

  private choose(id: WeaponId): void {
    if (id === this.me.arsenal.primary.id) return;
    if (this.link) this.act({ a: 'primary', weapon: id });
    if (this.link || this.sim.selectPrimary(this.myId, id)) {
      settings.update((s) => { s.profile.primary = id; });
      this.table?.setCarried(id);
      this.rack?.highlight(this.hovered, id);
      audio.ui('click');
    }
  }

  private closeTable(): void {
    if (this.phase !== 'table') return;
    if (this.smith) this.closeGunsmith(true);
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
    if (this.input.device === 'mouse') this.input.requestLock();
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

    this.input.uiNav = this.phase !== 'playing';
    const touchMode = settings.value.controls.touch;
    this.touch.setVisible(this.phase === 'playing' && touchMode !== 'off' && (touchMode === 'on' || this.input.device === 'touch'));
    // "CLICK TO CONTINUE" asks for a click back into play: it goes once the survivor is dead (it sat over the
    // YOU DIED stats), paused or at a bench, and the way back into play puts it up again if it is still needed.
    if (this.phase !== 'playing' && this.clickToPlay.isConnected) this.clickToPlay.remove();
    if (this.phase === 'playing') this.gatherInput(dt);

    // Fixed-step simulation, rendered with interpolation.
    const step = this.physics.fixedDt;
    // Online the night goes on while the menu is open.
    const running = this.phase !== 'paused' || !!this.link;
    if (running) this.accumulator += dt;
    if (this.link) {
      // The scene has drawn a couple of frames (shaders compiled): ready for the server's stream.
      if (++this.framesDrawn === 3) this.link.markLoaded();
      this.receive();
    }
    let steps = 0;
    while (this.accumulator >= step && steps < 5) {
      p.fixedUpdate(step, this.cam.yaw);
      this.sim.setMotion(this.myId, this.myMotion());
      if (this.link) {
        if (this.phase === 'playing') this.sendOnline(step);
        this.stepOnline(step);
      } else {
        if (this.phase === 'playing') this.sendIntents(step);
        this.sim.step(step);
        this.doors.update(step, this.engine.camera, false);
      }
      this.physics.step();
      this.accumulator -= step;
      steps++;
    }
    if (steps === 5) this.accumulator = 0;
    if (running && !this.link) for (const e of this.sim.drain()) this.onEvent(e);
    this.syncDowned();
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
      // On a board the wheels take the landing (the board's own clack plays).
      this.cam.addTrauma(p.ride ? 0.06 : 0.12);
      if (!p.ride) audio.footstep(0.8, this.indoors);
    }
    this.updateRide(dt);

    // Camera.
    if (this.phase === 'table') {
      const c = this.tablePose;
      this.engine.camera.position.set(c.px, c.py, c.pz);
      this.engine.camera.lookAt(c.tx, c.ty, c.tz);
      this.fovTo(dt, 50);
    } else if (this.phase === 'dead') {
      this.deathCamera(dt);
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
      this.weapon.update(dt, a, { aim: a.aim, sprinting: p.sprinting, aimPoint: this.cam.aimPoint, ads, eye: this.cam.eye, view: this.cam.view, priming: this.throws.priming });
    }
    this.updateLamp(dt);
    this.probe.update(dt, this.ragdoll ? this.ragdoll.center(this.tmpA).setY(this.ragdoll.floorY) : p.renderPosition, this.engine.camera);

    // World (online: the mirror's clock, a snapshot behind the server).
    const m = this.mirror;
    const renderTime = m ? this.sim.time : this.sim.time - step + alpha * step;
    this.zombies.update(live, this.sim, renderTime, this.engine.camera);
    this.raid.update(live, this.sim, renderTime, this.engine.camera, !!m);
    this.limbs.update(live, this.sim, m ? m.limbAlpha : alpha, this.engine.camera, m ? m.limbStep : step);
    this.pickups.update(live, this.sim, this.engine.camera);
    this.skates.update(live, this.sim, this.engine.camera, (b) => this.boardPose(b, alpha));
    if (m) {
      this.remotes!.update(live, this.sim, m, this.engine.camera);
      this.updateVoices();
    }
    this.barricades.update(live, this.engine.camera);
    if (this.work) this.work.t += live;
    this.bleedHeldLimb(live);
    if (running) this.drops.update(live, renderTime);
    this.drops.helicopters(this.helis);
    audio.helicopters(this.phase === 'paused' && !this.link ? new Map() : this.helis);
    this.effects.update(live, this.engine.camera);
    this.updateFire(live, renderTime);
    this.rack?.update(dt, this.engine.camera);
    this.updateGunsmith(dt);

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

  /** Voices from where each survivor stands; who is talking lights up (name tags and the list). */
  private updateVoices(): void {
    const link = this.link;
    const r = this.remotes;
    if (!link || !r) return;
    const voice = link.voice;
    const talking: [string, boolean][] = [];
    for (const p of this.sim.players.values()) {
      const radio = voice.talkOf(p.id) === 'radio';
      const on = voice.speaking(p.id);
      if (on) talking.push([p.id === this.myId ? 'YOU' : p.name.toUpperCase(), radio]);
      if (p.id === this.myId) continue;
      voice.place(p.id, r.mouthOf(p.id, this.tmpVoice), p.alive);
      r.speaking(p.id, on, radio);
    }
    const key = talking.map(([n, radio]) => `${n}${radio ? '*' : ''}`).join('|');
    if (key !== this.voxKey && this.voxList) {
      this.voxKey = key;
      this.voxList.replaceChildren(...talking.map(([name, radio]) => h('div', { class: `vox${radio ? ' radio' : ''}` }, h('i'), radio ? `${name} · RADIO` : name)));
    }
  }

  private sightFor(id: WeaponId): Sight | null {
    const b = this.me.arsenal.builds[id];
    const key = b ? `${id}:${encodeBuild(b)}` : id;
    let s = this.sights.get(key);
    if (s === undefined) {
      s = sightOf(id, b);
      this.sights.set(key, s);
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

  /** Where this survivor is and aims, for the simulation and the server (with the light switch). */
  private myMotion(): PlayerMotion {
    const m = this.player.motion(this.cam.yaw, this.cam.pitch);
    m.light = flashlight()?.on ?? false;
    return m;
  }

  private toggleLight(): void {
    const f = flashlight();
    if (!f) return;
    const on = f.toggle();
    audio.flashlight(on);
    this.touch.setLight(on);
  }

  /**
   * The chest lamp's beam. In play it lights what the crosshair is on (from the chest, not the
   * camera); otherwise (the intro, the weapon table) it points ahead of the survivor, a little down.
   */
  private updateLamp(dt: number): void {
    const torch = flashlight();
    if (!torch) return;
    const alive = this.phase !== 'dead' && this.me.alive;
    const lens = this.lamp.origin(this.tmpTorchAt);
    const want = this.tmpTorchDir;
    if (this.phase === 'playing' || this.phase === 'paused') {
      want.subVectors(this.cam.aimPoint, lens);
      const len = want.length();
      // Something right up against the lamp (or behind it, past the camera's ray): straight down the view.
      if (len < 1 || want.dot(this.cam.aimDir) < len * 0.4) want.copy(this.cam.aimDir);
      else want.divideScalar(len);
    } else {
      const yaw = this.player.character.root.rotation.y;
      want.set(Math.sin(yaw), -0.25, Math.cos(yaw)).normalize();
    }
    const dir = this.lamp.follow(want, dt);
    torch.update(dt, alive, this.lamp.source(this.tmpTorchAt), dir);
    this.lamp.show(torch.level, this.engine.camera);
  }

  private gatherInput(dt: number): void {
    const input = this.input;
    const p = this.player;
    if (input.pausePressed()) {
      this.openPause();
      return;
    }
    // Sticks and thumbs get help onto zombies; the mouse never does.
    let friction = 1;
    if (input.device !== 'mouse') {
      if (input.pressed('aim')) this.assist.aimPressed();
      const moving = input.stickLook || Math.hypot(input.move.x, input.move.y) > 0.2;
      const a = this.assist.update(dt, this.sim, this.cam.aimOrigin, this.cam.aimDir, this.cam.yaw, this.cam.pitch,
        p.aiming, moving, settings.value.controls.aimAssist);
      if (a) {
        friction = a.friction;
        this.cam.nudge(a.yaw, a.pitch);
      }
    }
    this.cam.look(input, friction);
    p.sampleInput(input, this.cam.yaw);
    const a = this.me.arsenal;
    if (a.action === 'bandage') p.blockSprint(0.1);
    // The light works on the ground too: a downed survivor's beam helps the others find them.
    if (input.pressed('flashlight')) this.toggleLight();
    if (!this.me.up) {
      // On the ground: look about, drag yourself along, call for help.
      if (input.pressed('chat') && this.chatBox && !this.chatBox.isOpen) {
        this.chatBox.open();
        input.clear();
      }
      input.consumeWheel();
      this.hud.setPrompt(null);
      return;
    }

    this.fireHeld = input.held('fire');
    if (input.pressed('fire')) this.fireBuffer = 0.18;
    if (this.fireHeld || this.fireBuffer > 0) p.blockSprint(0.35);
    if (input.pressed('reload')) this.wantReload = true;
    if (input.pressed('weapon1')) this.wantSlot = 'primary';
    if (input.pressed('weapon2')) this.wantSlot = 'secondary';
    const wheel = input.consumeWheel();
    if (wheel !== 0) this.wantSlot = a.active === 'primary' ? 'secondary' : 'primary';
    if (input.pressed('melee')) this.wantMelee = true;
    this.throwInput();
    if (input.pressed('chat') && this.chatBox && !this.chatBox.isOpen) {
      this.chatBox.open();
      input.clear();
    }
    if (input.pressed('gunsmith')) {
      this.openGunsmith(false);
      return;
    }
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
    if (!this.me.up) return;
    if (this.wantSlot) {
      sim.switchWeapon(this.myId, this.wantSlot);
      this.wantSlot = null;
    }
    if (this.wantMelee) {
      this.wantMelee = false;
      // The blow goes where the crosshair is (which arm, the head).
      const o = this.cam.aimOrigin, d = this.cam.aimDir;
      sim.melee(this.myId, { origin: { x: o.x, y: o.y, z: o.z }, dir: { x: d.x, y: d.y, z: d.z } });
    }
    if (this.wantHeal) {
      this.wantHeal = false;
      sim.bandage(this.myId);
    }
    if (this.wantThrow) {
      const kind = this.wantThrow;
      this.wantThrow = null;
      const o = this.cam.aimOrigin, d = this.cam.aimDir;
      sim.throwItem(this.myId, kind, { origin: { x: o.x, y: o.y, z: o.z }, dir: { x: d.x, y: d.y, z: d.z } });
    }
    if (this.wantReload) {
      this.wantReload = false;
      sim.reload(this.myId);
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
    const r = sim.fire(this.myId, { x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, pressed, (Math.random() * 2 ** 31) | 1);
    if (r !== 'busy') this.fireBuffer = 0;
  }

  // ------------------------------------------------------------------ online

  private get netNow(): number {
    return performance.now() / 1000;
  }

  /** Snapshots, events and corrections from the server, in the order they came. */
  private receive(): void {
    const link = this.link!;
    const mirror = this.mirror!;
    for (const m of link.drain()) {
      if (m.k === 'snap') mirror.apply(m.snap, m.at);
      else if (m.k === 'pos') this.player.teleport(m.pos);
      else {
        for (const e of m.events) {
          mirror.event(e);
          if (!this.predicted(e)) this.onEvent(e);
        }
      }
    }
    mirror.tick(this.netNow);
  }

  /** This survivor's own actions the session already showed when they were made. */
  private predicted(e: SimEvent): boolean {
    if (!('player' in e) || e.player !== this.myId) return false;
    return e.type === 'dryFire' || e.type === 'refit' || e.type === 'throwStart' || (e.type === 'melee' && e.stage === 'swing') || (e.type === 'bandage' && e.stage === 'start');
  }

  /** What the server would do between snapshots: hands keep moving, doors keep swinging, zombies stay solid. */
  private stepOnline(step: number): void {
    const ticks: ArsenalTick[] = [];
    for (const pl of this.sim.players.values()) {
      if (!pl.up) continue;
      ticks.length = 0;
      pl.arsenal.step(step, pl.motion.aiming, ticks);
    }
    this.mirror!.updateBodies();
    this.doors.update(step, this.engine.camera, true);
    // Where this survivor is and aims, ~30 times a second.
    this.motionT -= step;
    if (this.motionT <= 0 && this.me.alive) {
      this.motionT += 1 / MOTION_RATE;
      if (this.motionT < 0) this.motionT = 0;
      const o = this.cam.aimOrigin, d = this.cam.aimDir;
      this.link!.motion(packMotion({
        motion: this.myMotion(), facing: this.player.facing,
        trigger: this.phase === 'playing' && this.fireHeld && !this.me.arsenal.limb,
        aimOrigin: { x: o.x, y: o.y, z: o.z }, aimDir: { x: d.x, y: d.y, z: d.z },
      }));
    }
  }

  /** Sends an action and keeps the predicted hands from being overwritten until the server has it. */
  private act(a: ActMsg): void {
    this.mirror!.holdSelf(this.netNow + this.link!.rtt + 0.15);
    this.link!.act(a);
  }

  /** Online intents: shown at once on this survivor's copy of the weapons, confirmed by the server. */
  private sendOnline(step: number): void {
    const a = this.me.arsenal;
    if (!this.me.up) return;
    const aim = () => {
      const o = this.cam.aimOrigin, d = this.cam.aimDir;
      return { o: { x: o.x, y: o.y, z: o.z }, d: { x: d.x, y: d.y, z: d.z } };
    };
    const swing = () => {
      if (!a.startMelee()) return;
      this.act({ a: 'melee', ...aim() });
      this.onEvent({ type: 'melee', player: this.myId, stage: 'swing', limb: a.meleeWith === 'limb' });
    };
    if (this.wantSlot) {
      const slot = this.wantSlot;
      this.wantSlot = null;
      // With an arm in hand the server throws it aside first.
      if (a.limb ? a.action !== 'melee' : a.switchTo(slot)) this.act({ a: 'switch', slot });
    }
    if (this.wantMelee) {
      this.wantMelee = false;
      swing();
    }
    if (this.wantHeal) {
      this.wantHeal = false;
      if (a.action !== 'melee' && a.action !== 'bandage' && a.startBandage()) {
        this.act({ a: 'bandage' });
        audio.bandage();
      }
    }
    if (this.wantThrow) {
      const kind = this.wantThrow;
      this.wantThrow = null;
      if (a.startThrow(kind)) {
        const { o, d } = aim();
        this.act({ a: 'throw', kind, o, d });
        this.onEvent({ type: 'throwStart', player: this.myId, kind });
      }
    }
    if (this.wantReload) {
      this.wantReload = false;
      if (a.startReload()) this.act({ a: 'reload' });
    }
    const pressed = this.fireBuffer > 0;
    this.fireBuffer = Math.max(0, this.fireBuffer - step);
    if (!this.fireHeld && !pressed) return;
    if (a.limb) {
      // The trigger finger swings the arm.
      if (pressed) {
        this.fireBuffer = 0;
        swing();
      }
      return;
    }
    if (a.weapon.mag <= 0 && !pressed) return;
    if (!a.def.auto && !pressed) return;
    const state = a.fireState();
    if (state === 'busy') return;
    this.fireBuffer = 0;
    if (state === 'empty') {
      a.dryFire();
      audio.dryFire(this.handPos(), a.weapon.id, true);
      this.act({ a: 'fire', ...aim() });
      a.startReload();
      return;
    }
    a.consume();
    // Held automatic fire carries on from the trigger flag in the motion messages.
    if (pressed) this.act({ a: 'fire', ...aim() });
    else this.mirror!.holdSelf(this.netNow + this.link!.rtt + 0.15);
    this.shotFeedback(a.weapon.id);
  }

  /** Muzzle flash, report, recoil and the spent case for this survivor's own shot. */
  private shotFeedback(weapon: WeaponId): void {
    const def = this.me.arsenal.defOf(weapon);
    const muzzle = this.weapon.muzzleWorld(this.tmpA);
    const dir = this.weapon.muzzleDir(this.tmpB);
    this.effects.muzzle(muzzle, dir, weapon);
    audio.gunshot(weapon, muzzle, true, undefined, this.me.arsenal.builds[weapon]?.muzzle === 'suppressor');
    this.weapon.fired(def);
    const kick = (0.006 + def.recoil * 0.014) * (this.player.aiming ? 0.75 : 1) * (this.player.crouching ? 0.8 : 1);
    this.cam.addRecoil(kick, (Math.random() - 0.5) * def.recoil * 0.008);
    this.cam.addTrauma(0.04 + def.recoil * 0.05);
    this.input.rumble(0.12 + def.recoil * 0.35, 60 + def.recoil * 60);
    this.player.faceCamera(0.7);
    if (weapon === 'shotgun') this.later.push({ t: 0.3, fn: () => this.ejectCasing(true) });
    else this.ejectCasing(false);
  }

  /** Another survivor fired: their muzzle, their report from where they stand, tracers to where it went. */
  /** A raider fired: their muzzle and report, tracers to where the rounds went. */
  private raiderShot(e: Extract<SimEvent, { type: 'shot' }>): void {
    const muzzle = this.raid.muzzle(e.player, this.tmpA) ?? v3(e.origin, this.tmpA);
    const dir = this.raid.muzzleDir(e.player, this.tmpB) ?? this.tmpB.set(0, 0, 1);
    this.effects.muzzle(muzzle, dir, e.weapon);
    for (let i = 0; i < e.pellets.length; i++) {
      if (e.pellets.length > 1 && i % 3 !== 0) continue;
      this.effects.tracer(muzzle, v3(e.pellets[i].end, this.tmpC));
    }
    audio.gunshot(e.weapon, muzzle, false, e.pellets.map((p) => p.end));
    this.raid.weaponOf(e.player)?.fired(WEAPONS[e.weapon]);
  }

  private remoteShot(e: Extract<SimEvent, { type: 'shot' }>): void {
    const r = this.remotes!;
    const muzzle = r.muzzle(e.player, this.tmpA) ?? v3(e.origin, this.tmpA);
    const dir = r.muzzleDir(e.player, this.tmpB) ?? this.tmpB.set(0, 0, 1);
    this.effects.muzzle(muzzle, dir, e.weapon);
    for (let i = 0; i < e.pellets.length; i++) {
      if (e.pellets.length > 1 && i % 3 !== 0) continue;
      this.effects.tracer(muzzle, v3(e.pellets[i].end, this.tmpC));
    }
    const shooter = this.sim.players.get(e.player)?.arsenal;
    audio.gunshot(e.weapon, muzzle, false, e.pellets.map((p) => p.end), shooter?.builds[e.weapon]?.muzzle === 'suppressor');
    const w = r.weaponOf(e.player);
    if (w) {
      w.fired(shooter ? shooter.defOf(e.weapon) : WEAPONS[e.weapon]);
      const pos = this.tmpC, d = this.tmpD;
      w.ejectWorld(pos, d);
      const floor = this.physics.raycast(pos.x, pos.y, pos.z, 0, -1, 0, 3);
      this.effects.eject(pos, d, floor !== null ? pos.y - floor : pos.y - 1.2, e.weapon === 'shotgun', this.tmpA.set(0, 0, 0));
    }
  }

  private handleInteraction(): void {
    if (this.keepReviving()) return;
    // On a skateboard [interact] steps off (nothing else is in reach from the deck).
    if (this.player.ride) {
      this.hud.setPrompt('interact', 'HOP OFF THE SKATEBOARD');
      if (this.input.pressed('interact')) this.leaveBoard(false);
      return;
    }
    const best = this.pickInteraction();
    const slot = this.workableSlot();
    // An opening in reach is boarded up from here unless something else is what the crosshair is on.
    const own = slot && (!best || (best.kind === 'door' && slot.kind === 'door' && best.door!.body.index === slot.ref)) ? slot : null;
    if (this.updateWork(own)) return;
    const key = (a: Action) => actionLabel(a) || (a === 'barricade' ? 'BOARD' : 'USE');
    if (own) {
      const what = own.kind === 'door' ? 'DOOR' : 'WINDOW';
      const count = `${own.boards}/${own.max}`;
      if (own.boards > 0) {
        this.hud.setPrompt('interact', `PRY A BOARD OFF THE ${what} · ${count}${own.boards < own.max ? ` · HOLD ${key('barricade')} TO ADD ONE` : ''}`);
        return;
      }
      if (!best) {
        this.hud.setPrompt('barricade', `HOLD TO BOARD UP THE ${what}${own.kind === 'window' && !own.glass ? ' · GLASS SMASHED' : ''}`);
        return;
      }
    }
    if (!best) {
      this.hud.setPrompt(null);
      return;
    }
    if (best.kind === 'revive') {
      this.hud.setPrompt('interact', `HOLD TO REVIVE ${best.mate!.name.toUpperCase()}`);
      if (this.input.pressed('interact') || this.input.held('interact')) this.startReviving(best.mate!);
      return;
    }
    if (best.kind === 'door') {
      const locked = this.sim.doorLocked(best.door!.body.index);
      const hint = own && !best.door!.open ? ` · HOLD ${key('barricade')} TO BOARD UP` : '';
      this.hud.setPrompt('interact', locked ? 'BOARDED UP FROM INSIDE' : `${best.door!.open ? 'CLOSE DOOR' : 'OPEN DOOR'}${hint}`);
    }
    else if (best.kind === 'ammo') this.hud.setPrompt('interact', `TAKE AMMUNITION · ${best.it!.supply} LEFT`);
    else if (best.kind === 'medical') this.hud.setPrompt('interact', `TAKE BANDAGES · ${best.it!.supply} LEFT`);
    else if (best.kind === 'supply') this.hud.setPrompt('interact', `TAKE UNIVERSAL AMMO · ${best.it!.supply} LEFT`);
    else if (best.kind === 'serum') this.hud.setPrompt('interact', `INJECT ${SERUM.name.toUpperCase()} · ARMOR AGAINST THE DEAD`);
    else if (best.kind === 'melee') {
      const mine = this.me.arsenal.meleeId;
      const what = WEAPONS[best.it!.weapon ?? 'machete'].model;
      this.hud.setPrompt('interact', mine === 'machete' ? `PICK UP ${what}` : `SWAP ${WEAPONS[mine].model} FOR ${what}`);
    }
    else if (best.kind === 'exclusive') this.hud.setPrompt('interact', `TAKE ${WEAPONS[best.it!.weapon ?? 'ar'].model} · REPLACES ${WEAPONS[this.me.arsenal.primary.id].model}`);
    else if (best.kind === 'board') this.hud.setPrompt('interact', 'RIDE THE SKATEBOARD');
    else if (best.kind === 'limb') {
      const l = best.limb!;
      const what = LIMB_NAME[l.cut];
      this.hud.setPrompt('interact', `${this.me.arsenal.limb ? 'SWAP FOR' : 'PICK UP'} ${what} · ${l.wear} HIT${l.wear === 1 ? '' : 'S'}`);
    } else this.hud.setPrompt('interact', 'SELECT WEAPON');
    if (!this.input.pressed('interact')) return;
    if (best.kind === 'door') {
      if (this.sim.doorLocked(best.door!.body.index)) {
        audio.doorPound(best.door!.center);
        return;
      }
      best.door!.toggle(this.player.position);
      audio.door(best.door!.open);
      if (this.link) {
        // Swung here at once; the server's word on it is ignored until it has heard.
        const i = best.door!.body.index;
        this.mirror!.holdDoor(i, this.netNow + this.link.rtt + 0.4);
        this.link.act({ a: 'door', door: i });
      }
    } else if (best.kind === 'weapons') {
      this.openTable();
    } else if (best.kind === 'board') {
      this.rideBoard(best.board!);
    } else if (best.kind === 'limb') {
      if (this.link) this.act({ a: 'grab', limb: best.limb!.id });
      else this.sim.grabLimb(this.myId, best.limb!.id);
    } else if (this.link) {
      this.link.act({ a: 'use', id: best.it!.id });
    } else {
      this.sim.use(this.myId, best.it!.id);
    }
  }

  // ------------------------------------------------------------------ skateboards

  /** Hops onto a board in reach: at once here; online the server may give it to someone quicker. */
  private rideBoard(b: Skateboard): void {
    const p = this.player;
    if (p.ride || !this.me.up) return;
    if (this.link) {
      p.mount(b.id, this.cam.yaw);
      this.rideAskedAt = this.netNow;
      b.rider = this.myId;
      b.flipped = false;
      this.mirror!.holdBoard(b.id, this.netNow + this.link.rtt + 0.5);
      this.link.act({ a: 'board', id: b.id });
    } else {
      if (!this.sim.rideBoard(this.myId, b.id)) return;
      p.mount(b.id, this.cam.yaw);
    }
    if (!this.skateHinted) {
      this.skateHinted = true;
      const d = this.input.device;
      const k = (a: Action, alt: string) => actionLabel(a) || alt;
      this.hud.notify('SKATEBOARD', d === 'touch'
        ? 'STICK UP PUSHES · DOWN BRAKES · SIDEWAYS CARVES · JUMP OLLIES · USE HOPS OFF'
        : d === 'pad'
          ? `LEFT STICK PUSH · BRAKE · CARVE · ${k('jump', 'A')} OLLIE · ${k('sprint', 'L3')} PUSH HARDER · ${k('interact', 'RB')} HOP OFF`
          : `${k('forward', 'W')} PUSH · ${k('back', 'S')} BRAKE · ${k('left', 'A')}/${k('right', 'D')} CARVE · ${k('jump', 'SPACE')} OLLIE · ${k('sprint', 'SHIFT')} PUSH HARDER · ${k('interact', 'E')} HOP OFF`,
        4.5);
    }
  }

  /** Steps off (or, `bail`, is thrown off by a wall): the board comes to rest on the floor where the session put it. */
  private leaveBoard(bail: boolean): void {
    const p = this.player;
    const r = p.ride;
    if (bail) p.bailed = true;
    const at = p.dismount();
    p.bailed = false;
    if (!r || !at) return;
    const pos = at.pos;
    const d = this.physics.raycast(pos.x, pos.y + 0.5, pos.z, 0, -1, 0, 2);
    if (d !== null) pos.y = pos.y + 0.5 - d;
    if (this.link) {
      const b = this.sim.skateboards.board(r.board);
      if (b && b.rider === this.myId) {
        b.rider = null;
        b.pos = { ...pos };
        b.yaw = at.yaw;
      }
      this.mirror!.holdBoard(r.board, this.netNow + this.link.rtt + 0.5);
      this.link.act({ a: 'board', id: -1, at: pos, yaw: at.yaw, bail });
      if (bail) {
        this.bailSentAt = this.netNow;
        this.bailFeedback(v3(pos, this.tmpE));
      }
    } else {
      // A bail comes back as an event (the feedback is shown there).
      this.sim.leaveBoard(this.myId, pos, at.yaw, bail);
    }
  }

  /** Thrown off the deck: the board clatters away, the view jolts. */
  private bailFeedback(pos: THREE.Vector3): void {
    audio.skateBail(pos);
    this.cam.addTrauma(0.35);
    this.input.rumble(0.5, 220);
    this.hud.feedLine('THROWN OFF THE SKATEBOARD');
  }

  /**
   * Every frame on a board: a wall taken head-on throws the survivor off; a board the server gave
   * to someone else (or took away) comes out from under the feet; at speed the view swings round
   * behind the deck unless the player is looking about or aiming.
   */
  private updateRide(dt: number): void {
    const p = this.player;
    const r = p.ride;
    if (!r) return;
    p.kicked = p.popped = false;
    if (p.bailed) {
      this.leaveBoard(true);
      return;
    }
    if (!this.me.up || this.phase === 'dead') {
      p.dismount();
      return;
    }
    const b = this.sim.skateboards.board(r.board);
    const grace = this.link ? this.link.rtt + 0.8 : 0;
    if (!b || (b.rider !== this.myId && this.netNow - this.rideAskedAt > grace)) {
      p.dismount();
      if (b?.rider) this.hud.feedLine('SOMEONE ELSE GOT TO THAT SKATEBOARD');
      return;
    }
    if (this.phase === 'playing' && !p.aiming) this.cam.follow(dt, r.heading, 1.8 * THREE.MathUtils.smoothstep(r.speed, 2, 6));
  }

  /** Where a ridden board is drawn: under this survivor's feet, or another's. */
  private boardPose(b: Skateboard, alpha: number): BoardPose | null {
    if (!b.rider) return null;
    if (b.rider !== this.myId) return this.remotes?.boardPose(b.rider, b) ?? null;
    const p = this.player;
    const r = p.ride;
    if (!r || r.board !== b.id || this.phase === 'dead') return null;
    const o = this.myBoard;
    o.pos.copy(p.renderPosition);
    o.yaw = p.rideHeading(alpha);
    o.lean = r.lean;
    o.pop = r.pop;
    o.air = !p.grounded;
    o.push = r.push;
    return o;
  }

  /** The opening this survivor could work on from where they stand (inside, within reach), if any. */
  private workableSlot(): BarricadeSlot | null {
    if (!this.me.alive) return null;
    const p = this.player.position;
    const slot = this.barricades.nearest(this.tmpA.set(p.x, p.y + this.player.eyeHeight, p.z), BARRICADE.reach);
    return slot && this.sim.canWork(this.me, slot) ? slot : null;
  }

  /**
   * [barricade] held nails boards up on the opening in reach, [interact] held on a boarded one pries
   * them off, a board after another while the key stays down. Returns true while working.
   */
  private updateWork(slot: BarricadeSlot | null): boolean {
    let want: 'board' | 'pry' | null = null;
    const input = this.input;
    if (slot) {
      if (input.held('barricade') && this.sim.workFor(this.me, slot, 'board')) want = 'board';
      else if (input.held('interact') && (input.pressed('interact') || this.work?.kind === 'pry') && this.sim.workFor(this.me, slot, 'pry')) want = 'pry';
    }
    const cur = this.work;
    if (!want || !slot) {
      if (cur) this.sendWork(null);
      return false;
    }
    if (!cur || cur.slot !== slot.index || cur.kind !== want) this.sendWork({ slot: slot.index, kind: want, t: 0 });
    const w = this.work!;
    const total = want === 'board' ? BARRICADE.boardTime : BARRICADE.pryTime;
    const t = this.link ? w.t : (this.me.work?.t ?? w.t);
    const pct = Math.min(99, Math.round((t / total) * 100));
    const what = slot.kind === 'door' ? 'DOOR' : 'WINDOW';
    this.hud.setPrompt(want === 'board' ? 'barricade' : 'interact',
      want === 'board' ? `NAILING BOARD ${slot.boards + 1}/${slot.max} ON THE ${what} · ${pct}%` : `PRYING A BOARD OFF · ${slot.boards}/${slot.max} · ${pct}%`);
    return true;
  }

  private sendWork(w: { slot: number; kind: 'board' | 'pry'; t: number } | null): void {
    this.work = w;
    if (this.link) this.link.act(w ? { a: 'barricade', slot: w.slot, k: w.kind } : { a: 'barricade', slot: -1, k: 'stop' });
    else if (w) this.sim.barricade(this.myId, w.slot, w.kind);
    else this.sim.barricade(this.myId, -1);
  }

  /** What [E] acts on: the reachable thing closest to where the camera looks. */
  private pickInteraction(): Candidate | null {
    if (!this.me.up) return null;
    const p = this.player.position;
    const eye = this.tmpA.set(p.x, p.y + 1.1, p.z);
    const cands: Candidate[] = [];
    // A teammate on the ground comes before anything else nearby.
    for (const mate of this.sim.downedInReach(this.myId)) {
      const m = mate.motion.pos;
      cands.push({ kind: 'revive', pos: new THREE.Vector3(m.x, m.y + 0.3, m.z), mate, near: Math.hypot(m.x - p.x, m.z - p.z) - 1 });
    }
    const door = this.doors.nearest(eye, 1.9);
    if (door) cands.push({ kind: 'door', pos: door.center, door });
    // Skateboards lying in reach count by how near they are underfoot, like things on the floor.
    for (const b of this.sim.skateboards.inReach(this.me)) {
      cands.push({ kind: 'board', pos: new THREE.Vector3(b.pos.x, b.pos.y + 0.1, b.pos.z), board: b, near: Math.hypot(b.pos.x - p.x, b.pos.z - p.z) });
    }
    for (const it of this.sim.reachable(this.myId)) {
      if (it.supply <= 0) continue;
      // Weapons lying on the floor count by how near they are underfoot, like severed arms.
      const near = it.kind === 'melee' ? Math.hypot(it.pos.x - p.x, it.pos.z - p.z) : undefined;
      cands.push({ kind: it.kind, pos: new THREE.Vector3(it.pos.x, it.pos.y, it.pos.z), it, near });
    }
    // Severed arms within reach (not mid-swing or mid-bandage, when the hands are busy).
    const busy = this.me.arsenal.action === 'melee' || this.me.arsenal.action === 'bandage';
    if (!busy) {
      for (const l of this.sim.limbsInReach(this.myId)) {
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

  // ------------------------------------------------------------------ throwing

  /**
   * Holding the grenade (or Molotov) key gets one ready and shows where it will go; letting go
   * throws it. Another key, a swing, a bandage or an arm in the hands puts it away again.
   */
  private throwInput(): void {
    const input = this.input;
    const a = this.me.arsenal;
    const t = this.throws;
    for (const kind of ['frag', 'molotov'] as const) {
      const action = kind === 'frag' ? 'grenade' : 'molotov';
      if (input.pressed(action) && !t.priming) {
        if (a.throwables[kind] <= 0) this.hud.feedLine(kind === 'frag' ? 'NO GRENADES' : 'NO MOLOTOVS');
        else if (a.limb) this.hud.feedLine('HANDS FULL');
        else if (a.action !== 'throw') {
          t.priming = kind;
          audio.throwReady(kind, this.handPos());
        }
      }
      if (t.priming === kind && !input.held(action)) {
        t.priming = null;
        this.wantThrow = kind;
      }
    }
    if (t.priming && (a.limb || a.action === 'melee' || a.action === 'bandage' || !this.me.alive || a.throwables[t.priming] <= 0)) t.priming = null;
    if (t.priming) this.player.blockSprint(0.1);
  }

  /** A survivor's throwing hand (this one's, or another's as drawn). */
  private handOf(id: string, out: THREE.Vector3): THREE.Vector3 {
    if (id === this.myId) return out.copy(this.handPos());
    const p = this.sim.players.get(id);
    return p ? out.set(p.motion.pos.x, p.motion.pos.y + 1.5, p.motion.pos.z) : out.set(0, 0, 0);
  }

  /** Flights, blasts and fires: burning zombies' flames, the aiming arc, the roar of fires. */
  private updateFire(dt: number, renderTime: number): void {
    const cam = this.engine.camera;
    const priming = this.phase === 'playing' ? this.throws.priming : null;
    if (priming) {
      const m = this.me.motion;
      const d = this.cam.aimDir;
      this.throws.aim(priming, this.me.eye, { x: d.x, y: d.y, z: d.z }, m.yaw, m.vel);
    } else {
      this.throws.aim(null, this.me.eye, this.me.eye, 0, this.me.eye);
    }
    this.throws.update(dt);
    // The lit rag in the hand.
    const wick = priming === 'molotov' ? this.weapon.wickWorld(this.tmpC) : null;
    if (wick && dt > 0) this.pyro.rag(wick, this.tmpD.set(0, 0, 0));
    this.pyro.setBurning(this.zombies.flamePoints(this.burnPoints, cam));
    this.pyro.update(dt, renderTime, cam);
    const fires = this.phase === 'paused' && !this.link ? [] : this.pyro.activeFires(renderTime);
    // Up to three of the nearest burning zombies crackle too.
    const cp = cam.position;
    const near = this.burnPoints.filter((b) => b.size >= 0.9)
      .sort((p, q) => Math.hypot(p.x - cp.x, p.z - cp.z) - Math.hypot(q.x - cp.x, q.z - cp.z)).slice(0, 3);
    for (let i = 0; i < near.length; i++) fires.push({ id: -1 - i, pos: new THREE.Vector3(near[i].x, near[i].y, near[i].z), strength: 0.5 * near[i].strength });
    audio.fires(fires, dt);
  }

  // ------------------------------------------------------------------ events

  private onEvent(e: SimEvent): void {
    const A = this.tmpA, B = this.tmpB, C = this.tmpC;
    switch (e.type) {
      case 'shot': {
        if (e.player.startsWith('raider:')) {
          this.raiderShot(e);
          break;
        }
        if (e.player !== this.myId) {
          if (this.remotes) this.remoteShot(e);
          break;
        }
        // Online the flash, report and kick came the moment the trigger was pulled.
        if (!this.link) this.shotFeedback(e.weapon);
        const muzzle = this.weapon.muzzleWorld(A);
        for (let i = 0; i < e.pellets.length; i++) {
          // A shotgun's pellets would be a solid sheet of light; a few streaks read better.
          if (e.pellets.length > 1 && i % 3 !== 0) continue;
          this.effects.tracer(muzzle, v3(e.pellets[i].end, C));
        }
        break;
      }
      case 'dryFire':
        if (e.player === this.myId) audio.dryFire(this.handPos(), e.weapon, true);
        else if (this.remotes?.handOf(e.player, A)) audio.dryFire(A, e.weapon);
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
        this.zombies.hit(e.zombie, e.zone, B, e.damage, e.melee, A, exit?.pos);
        if (e.limb !== undefined) {
          // Clubbed with a severed arm: a wet, heavy thud, blood flung off its torn end.
          audio.clubHit(A, Math.min(1, e.damage / 50));
          this.effects.clubSplash(A, B);
          const held = e.by === this.myId ? this.weapon.heldLimb : null;
          if (held) this.effects.clubSplash(held.cutEnd(C), B);
          if (e.by === this.myId) this.cam.addTrauma(0.1 + Math.min(0.1, e.damage / 400));
        } else if (e.weapon) {
          // A melee weapon: the blade's slice or the blunt weapon's crack and crunch.
          audio.meleeHit(e.weapon, A, { kill: e.killed, head: e.zone === 'head', damage: e.damage });
        } else {
          audio.flesh(A, { damage: e.damage, head: e.zone === 'head', own: e.by === this.myId, melee: e.melee });
        }
        if (e.by === this.myId) {
          const kind = e.killed ? (e.zone === 'head' ? 'head' : 'kill') : 'hit';
          // Seen, not heard: the round going in is the sound of a hit.
          this.hud.hitMarker(kind);
        }
        if (!e.killed && Math.random() < 0.4) audio.zombieHurt(this.zombies.headOf(e.zombie, C) ?? A, this.zombies.pitchOf(e.zombie));
        break;
      }
      case 'limbSevered':
        this.onSevered(e.zombie, e.arm, e.cut, v3(e.pos, A), v3(e.dir, B), e.melee, e.killed, e.by === this.myId);
        break;
      case 'limbGrabbed':
        if (e.player !== this.myId) {
          const w = this.remotes?.weaponOf(e.player);
          if (w && this.limbs.liftPose(e.limb, A, this.liftQ)) w.liftFrom(e.limb, A, this.liftQ);
          if (this.remotes?.handOf(e.player, A)) audio.limbGrab(A);
          break;
        }
        // Lifted from where it lay.
        if (this.limbs.liftPose(e.limb, A, this.liftQ)) this.weapon.liftFrom(e.limb, A, this.liftQ);
        audio.limbGrab(this.handPos());
        this.limbEndValid = false;
        if (!this.gripHinted) {
          this.gripHinted = true;
          const k = (a: 'fire' | 'melee' | 'weapon1' | 'weapon2') => actionLabel(a) || (a === 'fire' ? 'FIRE' : a === 'melee' ? 'MELEE' : 'SWAP');
          const drop = this.input.device === 'mouse' ? `${k('weapon1')} / ${k('weapon2')}` : k('weapon1');
          this.hud.notify('BEAT THEM WITH IT', `${k('fire')} OR ${k('melee')} SWING · ${drop} DROP IT FOR A GUN`, 3.2);
        }
        break;
      case 'limbDropped':
        break;
      case 'skate': {
        if (e.stage !== 'bail') break;
        v3(e.pos, A);
        if (e.player === this.myId) {
          // Thrown off by a hit (a wall the session saw itself, and showed then).
          if (this.player.ride) {
            this.player.bailed = true;
            this.player.dismount();
            this.player.bailed = false;
          }
          if (this.link && this.netNow - this.bailSentAt < this.link.rtt + 1) break;
          this.bailFeedback(A);
        } else audio.skateBail(A);
        break;
      }
      case 'meleeTaken': {
        v3(e.pos, A);
        audio.meleePickup(e.weapon, A);
        if (e.player !== this.myId) break;
        if (!this.meleeHinted) {
          this.meleeHinted = true;
          this.hud.notify(`${WEAPONS[e.weapon].model} IN HAND`, `${actionLabel('melee') || 'MELEE'} TO SWING · IT REPLACES YOUR MACHETE`, 3.2);
        }
        if (e.swapped) this.hud.feedLine(`LEFT THE ${WEAPONS[e.swapped].model} BEHIND`);
        break;
      }
      case 'limbBroke': {
        v3(e.pos, A);
        v3(e.dir, B);
        this.effects.gibs(A, B);
        audio.limbBreak(A);
        if (e.player === this.myId) {
          this.hud.feedLine(isLeg(this.me.arsenal.limb?.arm ?? 'armL') ? 'THE LEG CAME APART' : 'THE ARM CAME APART');
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
        this.zombies.died(e.zombie, e.zone, v3(e.dir, B), e.force, { cause: e.cause, gibs: e.gibs, shred: e.shred, blast: e.blast });
        break;
      }
      case 'raiderHit': {
        v3(e.pos, A);
        v3(e.dir, B);
        this.effects.blood(A, B, e.damage, { exit: null, killed: e.killed, head: e.zone === 'head', melee: e.melee });
        this.raid.hit(e.raider, e.zone, B, e.damage);
        audio.flesh(A, { damage: e.damage, head: e.zone === 'head', own: e.by === this.myId, melee: e.melee });
        if (e.by === this.myId) {
          const kind = e.killed ? (e.zone === 'head' ? 'head' : 'kill') : 'hit';
          // Seen, not heard: the round going in is the sound of a hit.
          this.hud.hitMarker(kind);
        }
        break;
      }
      case 'raiderDied':
        this.raid.died(e.raider, e.zone, v3(e.dir, B));
        if (e.by === this.myId) this.hud.feedLine('RAIDER KILLED');
        break;
      case 'raid':
        if (e.stage === 'arrived') audio.raidSting();
        break;
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
      case 'zombieScream': {
        audio.zombieScream(this.zombies.headOf(e.zombie, C) ?? v3(e.pos, A).setY(e.pos.y + 1.6));
        if (e.target === this.myId) {
          this.hud.feedLine(e.fresh > 0 ? 'A SCREAMER CALLED THE HORDE' : 'A SCREAMER GAVE YOU AWAY');
          if (!this.screamHinted) {
            this.screamHinted = true;
            this.hud.notify('SCREAMER', 'SHOOT THEM BEFORE THEY CALL · A HIT CUTS THE SCREAM SHORT', 3, 'danger');
          }
        }
        break;
      }
      case 'zombieBurst': {
        this.burstAt = performance.now();
        const at = this.zombies.burst(e.zombie, A) ?? v3(e.pos, A);
        this.effects.bloaterBurst(at);
        audio.bloaterBurst(at);
        const me = this.me.motion.pos;
        const d = Math.hypot(me.x - at.x, me.y - at.y, me.z - at.z);
        if (d < 14) this.cam.addTrauma(Math.min(0.45, 0.5 * (1 - d / 14)));
        if (e.by === this.myId) this.hud.feedLine('BLOATER BURST');
        break;
      }
      case 'doorPound': {
        audio.doorPound(v3(e.pos, A));
        const slot = this.sim.barricades.forDoor(e.door);
        if (slot && slot.boards > 0) this.barricades.hit(slot.index);
        break;
      }
      case 'barricadeHit':
        audio.doorPound(v3(e.pos, A));
        this.barricades.hit(e.slot);
        break;
      case 'hammer':
        audio.hammer(v3(e.pos, A));
        break;
      case 'barricade': {
        audio.board(v3(e.pos, A), e.change);
        if (e.player === this.myId && this.work) this.work.t = 0;
        if (e.change === 'broken') {
          const slot = this.sim.barricades.slots[e.slot];
          // Splinters fly into the room.
          if (slot) this.effects.splinters(A, B.set(-slot.normal.x, 0, -slot.normal.z));
          this.barricades.hit(e.slot);
        }
        break;
      }
      case 'glassBroken': {
        v3(e.pos, A);
        audio.glassBreak(A);
        const slot = this.sim.barricades.slots[e.slot];
        if (slot) {
          B.set(slot.normal.x, 0, slot.normal.z);
          if (B.dot(C.set(e.dir.x, e.dir.y, e.dir.z)) < 0) B.negate();
          for (let i = 0; i < 4; i++) {
            const p = this.tmpD.set(slot.center.x, slot.center.y, slot.center.z);
            p.x += (Math.random() - 0.5) * slot.width * (slot.axis === 'x' ? 0.8 : 0);
            p.z += (Math.random() - 0.5) * slot.width * (slot.axis === 'z' ? 0.8 : 0);
            p.y += (Math.random() - 0.5) * slot.height * 0.8;
            this.effects.impact(p, B, 'glass', C);
          }
        }
        break;
      }
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
        if (e.player === this.myId) this.onHurt(e.damage, e.from);
        else this.remotes?.hurt(e.player, v3(e.from, A), e.damage);
        break;
      case 'playerDied':
        if (e.player === this.myId) this.onDeath();
        else {
          const who = this.sim.players.get(e.player);
          if (who) this.hud.feedLine(`${who.name.toUpperCase()} IS DEAD`);
          if (this.watching === e.player) this.watching = null;
        }
        break;
      case 'playerDowned':
        if (e.player !== this.myId) {
          const who = this.sim.players.get(e.player);
          if (who && this.me.up) this.hud.notify(`${who.name.toUpperCase()} IS DOWN`, 'GET TO THEM AND HOLD INTERACT TO REVIVE', 2.4, 'danger');
        }
        break;
      case 'playerRevived': {
        const who = this.sim.players.get(e.player);
        const by = this.sim.players.get(e.by);
        if (e.by === this.myId && who) this.hud.feedLine(`REVIVED ${who.name.toUpperCase()}`);
        else if (e.player !== this.myId && who && by) this.hud.feedLine(`${by.name.toUpperCase()} REVIVED ${who.name.toUpperCase()}`);
        break;
      }
      case 'revive':
        if (e.player === this.myId && e.stage !== 'start') this.reviveTarget = null;
        if (e.player === this.myId && e.stage === 'start') audio.bandage();
        break;
      case 'playerHealed':
        if (e.player === this.myId) this.hud.feedLine(`HEALTH +${Math.round(e.amount)}`);
        break;
      case 'reload':
        // The sounds follow each survivor's reload animation (PlayerWeapon cues); a pump gun loaded
        // from empty is racked once the last shell is in.
        if (e.stage === 'end') {
          const w = e.player === this.myId ? this.weapon : (this.remotes?.weaponOf(e.player) ?? this.raid.weaponOf(e.player));
          w?.finishReload();
        }
        break;
      case 'melee':
        if (e.player !== this.myId) {
          if (e.stage === 'swing' && this.remotes?.handOf(e.player, A)) {
            if (e.limb) audio.heavySwing(A);
            else audio.meleeWhoosh(this.sim.players.get(e.player)?.arsenal.meleeId ?? 'machete', A);
          }
          break;
        }
        if (e.stage === 'swing') {
          if (e.limb) audio.heavySwing(this.handPos());
          else audio.meleeWhoosh(this.me.arsenal.meleeId, this.handPos());
          this.player.faceCamera(0.6);
          this.player.blockSprint(e.limb ? 0.85 : MELEE[this.me.arsenal.meleeId].recover);
        }
        break;
      case 'bandage':
        if (e.player !== this.myId) break;
        if (e.stage === 'start') audio.bandage();
        if (e.stage === 'cancel') this.hud.feedLine('BANDAGE INTERRUPTED');
        break;
      case 'refit':
        if (e.player !== this.myId) break;
        audio.foley('magIn', this.handPos(), e.weapon, 0, true);
        this.hud.feedLine(`${WEAPONS[e.weapon].model} REFITTED`);
        this.rack?.setBuilds(this.me.arsenal.builds);
        this.smith?.panel.render();
        break;
      case 'pickup':
        if (e.player !== this.myId) break;
        audio.pickup(e.item);
        if (e.item === 'ammo') this.hud.feedLine(`AMMUNITION +${e.amount}`);
        else if (e.item === 'supply') {
          this.hud.feedLine(`UNIVERSAL AMMO +${e.amount}`);
          this.hud.notify('ALL WEAPONS RESUPPLIED', 'Every gun you carry is full', 2.2);
        }
        else if (e.item === 'bandage') this.hud.feedLine(`BANDAGE +${e.amount}`);
        else if (e.item === 'serum') this.hud.notify(`${SERUM.name.toUpperCase()} INJECTED`, `The dead's hits do ${Math.round((1 - SERUM.absorb) * 100)}% damage until it is used up`, 3, 'rare');
        else if (e.weapon && WEAPONS[e.weapon].exclusive) this.hud.notify(`${WEAPONS[e.weapon].model} EQUIPPED`, WEAPONS[e.weapon].description, 3, 'rare');
        else if (e.weapon) this.hud.feedLine(`${WEAPONS[e.weapon].model} EQUIPPED`);
        break;
      case 'notice':
        if (e.player === this.myId || e.player === null) {
          if (e.text === 'SUPPLY DROP INBOUND') this.hud.notify(e.text, e.sub ?? '', 3.2);
          else if (e.text === 'RARE SUPPLY DROP INBOUND') this.hud.notify(e.text, e.sub ?? '', 4.2, 'rare');
          else if (e.text === 'VEHICLE APPROACHING' || e.text === 'HOSTILE SURVIVORS') this.hud.notify(e.text, e.sub ?? '', 4, 'danger');
          else if (e.text === 'RAIDERS ELIMINATED') this.hud.notify(e.text, e.sub ?? '', 3.6);
          else this.hud.feedLine(e.text);
        }
        break;
      case 'horde':
        this.onHorde(e.wave, e.stage, e.at);
        break;
      case 'heli':
        this.drops.flight(e.drop, e.flight, e.weapon ?? null, !!e.serum);
        break;
      case 'supplyDrop':
        if (e.stage === 'empty') this.drops.emptied(e.drop, this.sim.time);
        else if (e.stage === 'weaponTaken') this.drops.weaponTaken(e.drop);
        else if (e.stage === 'serumTaken') this.drops.serumTaken(e.drop);
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
        this.throws.onEvent(e, this.sim, (id, out) => this.handOf(id, out));
        break;
    }
  }

  /**
   * An arm torn off: the stump shows, blood bursts out of it both ways, the arm goes flying
   * (drawn from the simulation as it tumbles).
   */
  private onSevered(zombie: number, arm: LimbZone, cut: LimbCut, at: THREE.Vector3, dir: THREE.Vector3, melee: boolean, killed: boolean, mine: boolean): void {
    // The torn end as drawn, where there is one on screen.
    this.zombies.severed(zombie, arm, cut, at, this.tmpC);
    this.effects.sever(at, dir, melee);
    // A leg is more meat: a second burst down onto the ground.
    if (isLeg(arm)) this.effects.sever(this.tmpD.copy(at).setY(at.y - 0.15), this.tmpE.set(dir.x * 0.4, -0.6, dir.z * 0.4).normalize(), melee);
    audio.sever(at, melee);
    if (!mine || performance.now() - this.burstAt < 250) return;
    this.cam.addTrauma(melee ? 0.12 : 0.06);
    const leg = isLeg(arm);
    this.hud.feedLine(leg ? (killed ? (cut === 'hip' ? 'LEG BLOWN OFF' : 'SHIN BLOWN OFF') : 'LEG BLOWN OFF, STILL CRAWLING') : cut === 'shoulder' ? 'ARM TORN OFF' : 'FOREARM TORN OFF');
    if (leg && !killed && !this.crawlHinted) {
      this.crawlHinted = true;
      this.hud.notify('LEG BLOWN OFF', 'IT IS STILL COMING. FINISH IT', 2.8);
    } else if (!this.limbHinted) {
      this.limbHinted = true;
      this.hud.notify(leg ? 'LEG BLOWN OFF' : 'ARM TORN OFF', 'PICK IT UP AND BEAT THEM WITH IT', 2.8);
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
    this.input.rumble(0.45 + Math.min(0.5, damage / 50), 160);
    this.hurtFlash = Math.min(1, this.hurtFlash + 0.35 + damage / 50);
    audio.playerHurt(Math.min(1, damage / 30));
    if (this.smith && !this.smith.bench) this.closeGunsmith();
    if (this.phase === 'table') this.closeTable();
  }

  private onDeath(): void {
    if (this.phase === 'dead') return;
    if (this.smith && !this.smith.bench) this.closeGunsmith();
    if (this.phase === 'table') this.closeTable();
    // Online the night goes on behind the pause menu, so death can come while it is open.
    this.pause.hide();
    this.phase = 'dead';
    this.shownDown = false;
    this.downPanel.remove();
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
      const model = createWeaponModel(held.id, held.build);
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
    // Watching a teammate fight on, or over this survivor's body.
    const c = (this.watching ? this.remotes?.positionOf(this.watching, this.tmpA) : null)
      ?? (this.ragdoll ? this.ragdoll.center(this.tmpA) : this.tmpA.copy(this.player.position));
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
    if (this.results || this.teamResults) return;
    this.input.releaseLock();
    this.spectateLine.remove();
    const run = { survived: this.survivedAtDeath, total: this.me.diedAt, stats: { ...this.me.stats }, outbreak: this.outbreakAnnounced };
    if (!this.link) {
      this.results = new ResultsScreen(run, [['RETRY', () => this.onRetry()], ['MAIN MENU', () => this.onQuit()]]);
      this.results.show(this.ui);
      // On the boards (when the game server can be reached), marked as a solo run, and its XP on the profile.
      const before = account.xp;
      void account.reportSolo(run.survived, run.stats).then((r) => {
        this.results?.setRanks(r);
        this.results?.setXp(r.gained, before, account.xp, run, r.offline);
      });
      return;
    }
    const alive = [...this.sim.players.values()].filter((p) => p.alive && p.id !== this.myId);
    const actions: [string, () => void][] = [];
    if (alive.length) actions.push(['WATCH THE OTHERS', () => this.watch()]);
    actions.push(['LEAVE GAME', () => this.onQuit()]);
    const sub = alive.length === 1 ? `${alive[0].name.toUpperCase()} IS STILL FIGHTING.` : alive.length ? `${alive.length} SURVIVORS ARE STILL FIGHTING.` : 'THE NIGHT IS ENDING.';
    this.results = new ResultsScreen(run, actions, sub);
    this.results.show(this.ui);
  }

  private readonly spectateLine = h('div', { class: 'spectate' });
  private readonly reconnectLine = h('div', { class: 'spectate net-lost' }, 'CONNECTION LOST · RECONNECTING');
  private framesDrawn = 0;

  /** The connection dropped and is being restored (the night goes on without this survivor meanwhile). */
  setReconnecting(on: boolean): void {
    if (on) this.ui.append(this.reconnectLine);
    else this.reconnectLine.remove();
  }

  /** Online, dead: the camera follows a teammate still alive (ESC brings the results back). */
  private watch(): void {
    const next = [...this.sim.players.values()].find((p) => p.alive && p.id !== this.myId);
    if (!next) return;
    this.watching = next.id;
    this.results?.dispose();
    this.results = null;
    const back = this.input.device === 'pad' ? 'B' : this.input.device === 'touch' ? 'TAP HERE' : 'ESC';
    this.spectateLine.textContent = `WATCHING ${next.name.toUpperCase()} · ${back} FOR RESULTS`;
    this.ui.append(this.spectateLine);
  }

  /** Everyone is dead: how each survivor did, and the way back to the room. */
  showTeam(over: OverMsg): void {
    this.pause.hide();
    this.results?.dispose();
    this.results = null;
    this.spectateLine.remove();
    this.teamResults?.dispose();
    this.input.releaseLock();
    const actions: [string, () => void][] = [];
    if (this.opts.onLobby) actions.push(['BACK TO THE LOBBY', () => this.opts.onLobby?.()]);
    actions.push(['LEAVE GAME', () => this.onQuit()]);
    this.teamResults = new TeamResults(over, this.myId, actions);
    this.teamResults.show(this.ui);
    // The server put the night's XP on the profile: fetch the new level for the results.
    const mine = over.results.find((r) => r.id === this.myId);
    const before = account.xp;
    const team = this.teamResults;
    if (mine?.xp) void account.refresh().then(() => team.setXp(mine.xp ?? 0, before, account.xp, mine));
  }

  /** Seconds survived since the outbreak, frozen at death. */
  private survivedAtDeath = 0;

  /** Horde waves: the siren ahead of one, the roar when it hits, a breather when it is outlasted. */
  private onHorde(wave: number, stage: 'warning' | 'surge' | 'over', at: number): void {
    if (!this.me.alive) return;
    if (stage === 'warning') {
      this.hud.notify(`HORDE ${wave} INCOMING`, `${Math.round(at - this.sim.phaseTime)} SECONDS · FIND COVER, RELOAD`, 3.4, 'danger');
      audio.hordeWarning();
    } else if (stage === 'surge') {
      this.hud.notify(`HORDE ${wave}`, `HOLD OUT ${clock(at - this.sim.phaseTime)}`, 2.6, 'danger');
      audio.hordeSurge(wave);
      this.cam.addTrauma(0.18);
    } else {
      this.hud.notify(`HORDE ${wave} SURVIVED`, `SUPPLY DROP IN ${HORDES.dropAfter} SECONDS`, 3.2);
      audio.hordeOver();
    }
  }

  // ------------------------------------------------------------------ HUD

  private timerText(): string {
    const s = this.sim;
    if (s.phase === 'preparation') return `OUTBREAK IMMINENT — ${clock(Math.ceil(s.phaseTime))}`;
    const survived = `SURVIVED ${clock(s.phaseTime)}`;
    if (s.phase !== 'survival') return survived;
    const w = hordeAt(s.phaseTime);
    if (w.stage === 'surge') return `HORDE ${w.wave} — HOLD OUT ${clock(Math.ceil(w.end - s.phaseTime))}`;
    return `${survived} · HORDE ${w.wave} IN ${clock(Math.ceil(w.start - s.phaseTime))}`;
  }

  private updateHud(dt: number): void {
    const hud = this.hud;
    const me = this.me;
    const a = me.arsenal;
    const def = a.def;
    const p = this.player;

    hud.setHealth(me.health, PLAYER.maxHealth);
    hud.setArmor(me.alive ? me.armor : 0, SERUM.armor);
    const limb = a.limb && !a.limb.broken ? a.limb : null;
    hud.weapon({
      model: limb ? (LIMB_NAME[limb.cut]) : def.model,
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
      frags: a.throwables.frag,
      molotovs: a.throwables.molotov,
      light: flashlight()?.on ?? false,
    });
    const s = this.sim;
    const w = s.phase === 'survival' ? hordeAt(s.phaseTime).stage : 'calm';
    hud.setTimer(this.timerText(), (s.phase === 'preparation' && s.phaseTime <= 10) || w !== 'calm');

    this.updateWaypoint();

    // Ammunition warning: the active gun is down to its last magazine in total.
    const total = (w: { mag: number; reserve: number }) => w.mag + w.reserve;
    const allEmpty = total(a.primary) === 0 && total(a.secondary) === 0;
    const critical = total(a.weapon) <= def.magazine && def.mode !== 'MELEE';
    // (Not while the hands are full of something else to fight with.)
    hud.setWarning(limb ? '' : allEmpty ? `OUT OF AMMUNITION · USE YOUR ${WEAPONS[a.meleeId].model}` : critical && me.alive ? 'AMMUNITION CRITICAL' : '');

    // Dynamic crosshair: gap follows the real spread cone (rolling on a skateboard is smooth).
    const hv = Math.hypot(p.velocity.x, p.velocity.z) * (p.ride ? SKATEBOARD.spreadSpeed : 1);
    const spread = a.spread({ speed: hv, crouching: p.crouching, grounded: p.grounded, aiming: p.aiming });
    const cam = this.engine.camera;
    const px = (Math.tan((spread * Math.PI) / 180) / Math.tan((cam.fov * Math.PI) / 360)) * (window.innerHeight / 2);
    hud.setSpread(Math.min(70, px));
    // Down the sights, the sights are the crosshair. Not while the mouse is free either: "CLICK TO
    // CONTINUE" stands in the middle of the screen then, and the crosshair would strike through it.
    this.updateDownPanel();
    hud.setCrosshairVisible(this.phase === 'playing' && this.input.engaged && me.up && !p.sprinting && a.action !== 'bandage' && this.cam.ads < 0.4);
    hud.setStance(me.downed ? 'DOWN' : this.reviveTarget ? 'REVIVING' : a.action === 'bandage' ? 'BANDAGING' : this.throws.priming ? (this.throws.priming === 'frag' ? 'GRENADE READY' : 'MOLOTOV LIT') : p.crouching ? 'CROUCHED' : p.sprinting ? 'SPRINTING' : '');
    hud.setFps(this.engine.fps, this.link ? this.link.rtt : null);

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
    skipPreparation: () => (this.link ? this.link.debug({ cmd: 'skipPreparation' }) : this.sim.skipPreparation()),
    spawnZombie: (dist = 8, angle = 0, kind: ZombieKind = 'walker') => {
      // Online the server places it (when it runs with DEAD_HOURS_DEBUG=1).
      if (this.link) return this.link.debug({ cmd: 'spawn', dist, angle, kind }), -1;
      const p = this.player.position;
      const yaw = this.cam.yaw + angle;
      const at = { x: p.x - Math.sin(yaw) * dist, y: p.y + 0.02, z: p.z - Math.cos(yaw) * dist };
      return this.sim.spawnZombie(kind, at, 'approach').id;
    },
    phase: () => this.phase,
    /** Calls a supply helicopter now (during the outbreak). */
    supplyDrop: (weapon?: WeaponId, serum = false) => (this.link ? (this.link.debug({ cmd: 'supplyDrop', weapon, serum }), null) : this.sim.callSupplyDrop(weapon, serum)?.flight ?? null),
    hurt: (amount: number) => this.link?.debug({ cmd: 'hurt', amount }),
    /** Online: health stays full (the server's test mode only). */
    god: (on = true) => this.link?.debug({ cmd: 'god', on }),
    /** Sends in the raiders' van now (during the outbreak). */
    raid: () => (this.link ? (this.link.debug({ cmd: 'raid' }), true) : this.sim.callRaid()),
  };

  dispose(): void {
    this.abort.abort();
    audio.setAcoustics(null);
    this.link?.voice.setInGame(false);
    this.chatBox?.dispose();
    this.commsHud?.remove();
    this.unsubSettings();
    this.intro?.kill();
    this.tableTween?.kill();
    for (const el of [...this.letterbox, this.skip, this.clickToPlay]) el.remove();
    this.touch.dispose();
    this.lamp.dispose();
    this.input.uiNav = true;
    this.table?.el.remove();
    if (this.smith) {
      this.smith.stage.dispose();
      this.smith.el.remove();
      this.smith.panel.labels.remove();
      this.smith = null;
    }
    this.results?.dispose();
    this.teamResults?.dispose();
    this.spectateLine.remove();
    this.reconnectLine.remove();
    this.remotes?.dispose();
    this.skates.dispose();
    this.inventory.dispose();
    this.engine.canvas.style.cursor = '';
    this.input.enabled = false;
    this.input.releaseLock();
    this.input.clear();
    this.hud.dispose();
    this.pause.hide();
    this.sim.dispose();
    this.zombies.dispose();
    this.raid.dispose();
    this.limbs.dispose();
    this.barricades.dispose();
    this.pickups.dispose();
    this.drops.dispose();
    audio.helicopters(new Map());
    this.effects.dispose();
    this.throws.dispose();
    this.pyro.dispose();
    audio.fires([], 0);
    clearGibCache();
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
