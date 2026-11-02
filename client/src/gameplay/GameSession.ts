import * as THREE from 'three';
import gsap from 'gsap';
import {
  BARRICADE, BICYCLE, C2S, DOWNED, DRIVE_FLAG, GAME, GORE, HORDES, LULLS, MELEE, isMelee, Mirror, isGoreGun, NEIGHBORHOOD, hordeAt, lullLeft, PLAYER, PRIMARY_WEAPONS, SECONDARY_WEAPONS, SERUM, SKATEBOARD, SKATE_TRICKS, Simulation, VEHICLE, WEAPONS, LIMB_NAME,
  encodeAppearance, isLeg, outsideBy, packDrive, packMotion, sanitizeAppearance,
  findVault, porches, type Porch, type VaultChoice, type VaultPlan,
  buildable, defaultBuild, encodeBuild, sanitizeBuild, type WeaponBuild,
  type ActMsg, type BarricadeSlot, type Bicycle, type BikeSeat, type ArsenalTick, type BeginMsg, type Interactable, type LimbCut, type LimbZone, type MapDefinition, type NavGrid,
  type OverMsg, type PlayerMotion, type SimEvent, type SimLimb, type SimPlayer, type Skateboard, type ThrowKind, type Vec3, type Vehicle, type WeaponId, type ZombieKind,
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
import { emberSample, sceneSmoke, setSceneSmoke } from '../characters/Smoking';
import { PlayerWeapon } from '../weapons/PlayerWeapon';
import { SeveredArm, clearSeveredCache } from '../characters/Severed';
import { setZombieDetail } from '../characters/Decay';
import { createWeaponModel, sightOf, type Sight, type WeaponModel } from '../weapons/WeaponModels';
import { Effects } from '../effects/Effects';
import { Pyro, type BurnPoint } from '../effects/Pyro';
import { Throwables } from './Throwables';
import { createThrowableModel } from '../weapons/ThrowableModels';
import { clearGibCache } from '../characters/Gibs';
import { ZombieView, type CorpseHit } from '../zombies/ZombieView';
import { RaidView } from './RaidView';
import { LimbView } from '../zombies/LimbView';
import { BarricadeView } from './BarricadeView';
import { MeleePickups } from './MeleePickups';
import { SkateboardView, type BoardPose } from './Skateboards';
import type { VehicleView } from './VehicleView';
import { Driving } from './Driving';
import { BicycleView, barAngle, type BikePose } from './Bicycles';
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
import { audio, type EngineSound } from '../audio/AudioEngine';
import { ChestLamp, flashlight, type Beam } from './Flashlight';
import { Acoustics } from '../audio/Acoustics';
import { h } from '../ui/dom';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';

/**
 * 'loading': built but not yet shown (Game gets it ready behind its loading screen; keys and
 * clicks do nothing yet). 'gunsmith': customizing the guns in the field (the night goes on
 * around the survivor).
 */
type Phase = 'loading' | 'intro' | 'playing' | 'paused' | 'table' | 'gunsmith' | 'dead';

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
  kind: 'door' | 'limb' | 'revive' | 'board' | 'vehicle' | 'bike' | Interactable['kind'];
  pos: THREE.Vector3;
  door?: Door;
  it?: Interactable;
  limb?: SimLimb;
  mate?: SimPlayer;
  board?: Skateboard;
  vehicle?: Vehicle;
  bike?: Bicycle;
  seat?: BikeSeat;
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
  /** The window this survivor would vault through on [jump], looked up a few times a second. */
  private vaultChoice: VaultChoice | null = null;
  private vaultLookT = 0;
  private readonly porches: Porch[] = porches(NEIGHBORHOOD);
  /** Online: panes this survivor smashed vaulting through (slot → when), so the server's echo isn't shown twice. */
  private readonly smashedHere = new Map<number, number>();
  private readonly myBoard: BoardPose = { pos: new THREE.Vector3(), yaw: 0, lean: 0, pop: -1, air: false, push: -1, trick: null, trickU: -1, toe: 1 };
  /** Shown once: hold a direction while popping for a flip trick. */
  private trickHinted = false;
  /** Tricks landed one after another (each within `streakT` seconds of the last). */
  private streak = 0;
  private streakT = 0;
  /** The car this survivor drives (null when not at a wheel), and when its next report goes to the server. */
  private driving: Driving | null = null;
  private driveT = 0;
  private carHinted = false;
  /** Online: where the server let this survivor out of a vehicle (until the session has put them there). */
  private exitAt: Vec3 | null = null;
  /** This frame's interpolation between fixed steps (where this survivor's own car is drawn). */
  private alpha = 0;
  private readonly seatPos = new THREE.Vector3();
  private readonly wheelL = new THREE.Vector3();
  private readonly wheelR = new THREE.Vector3();
  private readonly beamList: Beam[] = [];
  /** Engine sounds handed to the audio each frame (the nearest few running vehicles). */
  private readonly engineSounds: (EngineSound & { d: number })[] = [];
  private readonly engineList: EngineSound[] = [];
  /** Bicycles lying about and under riders (and passengers on the pegs). */
  private readonly bikes: BicycleView;
  private bikeHinted = false;
  private pegHinted = false;
  /** Online: when this survivor asked for the saddle or the pegs (the server may have given them to someone else). */
  private bikeAskedAt = 0;
  private bikeBailSentAt = -Infinity;
  private bellAt = -Infinity;
  private handsHintAt = -Infinity;
  private readonly myBike: BikePose = { pos: new THREE.Vector3(), yaw: 0, lean: 0, steer: 0, crank: 0, pedalling: false, brake: 0, air: false };
  /** The bike under this survivor's feet on someone's pegs, where it is drawn this frame. */
  private readonly underPegs: BikePose = { pos: new THREE.Vector3(), yaw: 0, lean: 0, steer: 0, crank: 0, pedalling: false, brake: 0, air: false };
  private readonly drops: SupplyDrops;
  private readonly helis = new Map<number, { pos: THREE.Vector3; hover: number }>();
  private readonly rack: WeaponRack | null = null;
  private table: WeaponTablePanel | null = null;
  private smith: Smith | null = null;
  private results: ResultsScreen | null = null;
  private phase: Phase = 'loading';
  /** Where the camera was when the night was set up (the opening shot starts from it). */
  private readonly startPose: { position: THREE.Vector3; target: THREE.Vector3 };
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
  private wantSlot: 'primary' | 'secondary' | 'melee' | null = null;
  private wantMelee = false;
  private wantHeal = false;

  private readonly later: { t: number; fn: () => void }[] = [];
  private hurtFlash = 0;
  private impactSoundAt = 0;
  private lastHurtDir = new THREE.Vector3(0, 0, 1);
  private ragdoll: Ragdoll | null = null;
  private readonly sights = new Map<string, Sight | null>();
  /** The guns that fell from the hands at death (both of an akimbo pair). */
  private dropped: Dropped[] = [];
  private deathT = 0;
  private deathYaw = 0;
  private readonly tablePose = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
  private tableTween: gsap.core.Tween | null = null;
  private hovered: WeaponId | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly mouse = new THREE.Vector2();
  private outbreakAnnounced = false;
  /** Online, dropped into a night under way: survival seconds already gone when the first snapshot came (NaN until then). */
  private joinedAt = 0;
  /** Horde waves already outlasted when this survivor joined (dropped in late). */
  private joinedHordes = 0;
  /** Session time the last horde was outlasted (a lull starting with it says so). */
  private hordeOverAt = -Infinity;
  private hordeOverWave = 0;
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
    private readonly vehicleView: VehicleView,
    private readonly field: LightField,
    nav: NavGrid,
    private readonly ui: HTMLElement,
    private readonly onQuit: () => void,
    private readonly onRetry: () => void,
    startPose: { position: THREE.Vector3; target: THREE.Vector3 },
    private readonly opts: SessionOptions = {},
  ) {
    const online = opts.online ?? null;
    const spawn = online ? online.begin.spawn : NEIGHBORHOOD.playerSpawns[0];
    if (online?.begin.late) this.joinedAt = NaN;
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
    const secondary = (SECONDARY_WEAPONS as string[]).includes(profile.secondary) ? (profile.secondary as WeaponId) : 'pistol';
    const look = sanitizeAppearance(profile.appearance);
    this.me = this.sim.addPlayer(this.myId, profile.name, primary, secondary, { x: spawn.x, y: spawn.y, z: spawn.z }, spawn.yaw, encodeAppearance(look), account.loadout);
    this.mirror = online ? new Mirror(this.sim, this.myId) : null;
    this.remotes = online ? new RemoteSurvivors(engine.scene, physics, field, ui, this.myId) : null;
    if (this.remotes) this.remotes.seats = vehicleView;
    // Every vehicle back where the map parks it (the simulation starts them there).
    vehicleView.reset();

    // Survivor, dressed as the profile's character.
    this.player = new PlayerController(physics, spawn, survivorLook(look));
    engine.scene.add(this.player.character.root);
    this.probe = new DynamicProbe(field);
    this.probe.attach(this.player.character.surfaces());
    this.player.character.onFootstep = (l) => audio.footstep(l, this.indoors);
    this.player.character.weathering = true;
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
    // Every survivor's cigarette, joint or blunt smokes into this night's effects.
    setSceneSmoke(this.effects.smoke);
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
    // The blood spreads out under a body for a few seconds once it lies still.
    this.zombies.onCorpseSettled = (pos) => this.effects.pool(pos, 1.15 + Math.random() * 0.7, 140, 8);
    this.zombies.onBodyFall = (pos, strength) => audio.bodyFall(pos, strength);
    this.zombies.onHeadPop = (pos) => {
      audio.headPop(pos);
      const me = this.me.motion.pos;
      const d = Math.hypot(me.x - pos.x, me.y - pos.y, me.z - pos.z);
      // Right in front of you, you feel it.
      if (d < 4) this.cam.addTrauma(0.08 * (1 - d / 4));
    };
    this.effects.onChunkLand = (pos, strength, kind) => audio.chunkLand(pos, strength, kind);
    this.zombies.onStep = (pos, gait, loudness) => audio.zombieStep(pos, gait, loudness);
    this.zombies.gibs.onLand = (pos, strength) => audio.limbLand(pos, strength);
    // Grenades and Molotovs: the blasts, the fires and the throws.
    this.pyro = new Pyro(engine.scene, physics, this.effects.decals);
    this.pyro.onBlastNear = (k) => this.cam.addTrauma(0.15 + k * 0.75);
    this.throws = new Throwables(engine.scene, physics, this.pyro);
    this.limbs = new LimbView(engine.scene, field, this.effects);
    this.pickups = new MeleePickups(engine.scene, field);
    this.skates = new SkateboardView(engine.scene, field, physics);
    this.bikes = new BicycleView(engine.scene, field, physics);
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
    this.startPose = startPose;
  }

  /**
   * Into the night, once it is ready (Game gets it ready behind its loading screen first): the
   * opening shot solo, straight into play on a retry or online.
   */
  start(): void {
    if (this.opts.skipIntro || this.opts.online) this.quickStart();
    else this.runIntro(this.startPose);
  }

  /**
   * Before the night is shown: one of everything it can put on screen later (a zombie of every
   * kind, gibs, severed limbs, every weapon in hand, in a supply case and on the gunsmith's
   * overlay, grenades and Molotovs, a supply drop, the raiders' van and a raider) stands in front
   * of the camera, so Game's loading screen compiles their shaders with the rest instead of the
   * first one of each compiling mid-fight. Returns what takes them away again.
   */
  prewarm(): () => void {
    const cam = this.engine.camera;
    const at = cam.getWorldDirection(new THREE.Vector3()).setY(0).normalize().multiplyScalar(6).add(cam.position);
    at.y = this.player.position.y;
    const stage = new THREE.Group();
    stage.name = 'prewarm';
    stage.position.copy(at);
    this.engine.scene.add(stage);
    const undo: (() => void)[] = [() => stage.removeFromParent()];
    const done = () => {
      for (const f of undo.reverse()) f();
      undo.length = 0;
    };
    try {
      undo.push(this.zombies.lineUp(at));
      const place = (root: THREE.Object3D, x: number, z: number) => {
        root.position.set(x, 0, z);
        stage.add(root);
      };
      const gib = this.zombies.gibs.sample();
      place(gib.root, -2, 1);
      undo.push(gib.dispose);
      // Pieces of meat and bone thrown off bodies (one instanced material of their own).
      undo.push(this.effects.chunks.sample(new THREE.Vector3(at.x - 2.5, at.y + 0.3, at.z + 1)));
      // A severed arm lying in the street and one in hand, each lit by its own probe as in play.
      for (const mode of ['world', 'held'] as const) {
        const arm = new SeveredArm({ kind: 'walker', look: 0, arm: mode === 'world' ? 'armL' : 'legR', cut: mode === 'world' ? 'elbow' : 'hip', scale: 1 }, mode);
        if (mode === 'world') new DynamicProbe(this.field).attach(arm.materials);
        else this.probe.attach(arm.materials);
        place(arm.root, mode === 'world' ? -1 : -1.5, 1);
        undo.push(() => arm.dispose());
      }
      // Every weapon in hand (lit by the survivor's probe) and in a supply case (unlit by one).
      let x = -3;
      for (const id of Object.keys(WEAPONS) as WeaponId[]) {
        for (const lit of [true, false]) {
          const m = createWeaponModel(id);
          if (lit) this.probe.attach(m.materials);
          place(m.root, (x += 0.25), lit ? 2 : 2.5);
          undo.push(() => m.dispose());
        }
      }
      for (const kind of ['frag', 'molotov'] as const) {
        for (const lit of [true, false]) {
          const m = createThrowableModel(kind);
          if (lit) this.probe.attach(m.materials);
          place(m.root, (x += 0.25), 3);
          undo.push(() => m.dispose());
        }
      }
      const drop = this.drops.sample();
      place(drop.root, 0, 8);
      undo.push(drop.dispose);
      const raid = this.raid.sample();
      place(raid.root, 6, 6);
      undo.push(raid.dispose);
      // A survivor's lit cigarette end (its smoke shares the explosions' smoke program).
      const ember = emberSample();
      place(ember.root, 6.5, 6);
      undo.push(ember.dispose);
      // A bicycle of every look (frame paint, chrome, rubber, the saddle).
      const bikes = this.bikes.sample();
      place(bikes.root, -4, 4);
      undo.push(bikes.dispose);
      // The field gunsmith's overlay draws the gun as see-through materials (their own programs).
      const smith = new GunsmithStage(true);
      smith.onMaterials = (m) => this.probe.attach(m);
      smith.show('ar', defaultBuild('ar'));
      place(smith.holder, 1, 2);
      undo.push(() => smith.dispose());
      stage.updateMatrixWorld(true);
    } catch (e) {
      done();
      throw e;
    }
    return done;
  }

  private applySettings(): void {
    const g = settings.value.graphics;
    this.effects.setQuality(g.particleQuality, g.gore, settings.value.accessibility.reducedFlashing);
    this.zombies.gore = g.gore !== 'off';
    // Bodies landing on bodies costs about a third more ragdoll time in a massacre: not on phones.
    this.zombies.piles = g.particleQuality !== 'low';
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
    if (this.opts.online?.begin.late) this.hud.notify('MAPLE HOLLOW', 'YOU JOINED A NIGHT UNDER WAY · FIND YOUR TEAM', 3.6);
    else this.hud.notify('MAPLE HOLLOW', 'THE SAFEHOUSE · 21:47 · GEAR UP BEFORE THEY ARRIVE', 3.2);
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
    gsap.fromTo(el.querySelector('.gunsmith-panel'), { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.35, ease: 'power3.out', clearProps: 'transform' });
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
    gsap.fromTo(this.table.el, { opacity: 0, x: 24 }, { opacity: 1, x: 0, duration: 0.4, delay: 0.25, ease: 'power3.out', clearProps: 'transform' });
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
    if (this.link) this.syncSeat();
    this.gluePegs();
    let steps = 0;
    while (this.accumulator >= step && steps < 5) {
      this.shoveFromCars();
      p.fixedUpdate(step, this.cam.yaw);
      if (this.driving) this.driveStep(step);
      this.sim.setMotion(this.myId, this.myMotion());
      if (this.link) {
        if (this.phase === 'playing') this.sendOnline(step);
        this.stepOnline(step);
      } else {
        if (this.phase === 'playing') this.sendIntents(step);
        this.sim.step(step);
        // In or out of a seat as the simulation says (got in, got out, thrown out going down).
        this.syncSeat();
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
    this.alpha = alpha;
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

    // Vehicles where they are drawn this frame; a survivor in a seat sits where theirs is.
    this.vehicleView.update(live, this.engine.camera, this.sim.vehicles.list, this.drawAt);
    this.placeSeated();
    p.render(dt, alpha);
    if (p.landed) {
      p.landed = false;
      // On a board or a bike the wheels take the landing (its own clack or thump plays). A drop out
      // of an upstairs window lands hard.
      this.cam.addTrauma(p.ride ? 0.06 : p.cycle ? 0.08 : Math.min(0.45, 0.12 + Math.max(0, p.landAir - 0.35) * 0.6));
      if (!p.ride && !p.cycle) audio.footstep(Math.min(1, 0.8 + p.landAir * 0.3), this.indoors);
    }
    if (p.vaultLanded) {
      p.vaultLanded = false;
      this.cam.addTrauma(0.08);
      audio.footstep(0.9, this.indoors);
    }
    this.updateRide(dt);
    this.updateDriving(dt);
    this.updateCycle(dt);

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
      const driver = p.seated?.driver ?? false;
      const wheel = driver && this.vehicleView.wheelPoints(p.seated!.vehicle, this.wheelL, this.wheelR) ? { left: this.wheelL, right: this.wheelR } : null;
      this.weapon.update(dt, a, { aim: driver ? 0 : a.aim, sprinting: p.sprinting, aimPoint: this.cam.aimPoint, ads, eye: this.cam.eye, view: this.cam.view, priming: this.throws.priming, wheel });
    }
    this.updateLamp(dt);
    this.probe.update(dt, this.ragdoll ? this.ragdoll.center(this.tmpA).setY(this.ragdoll.floorY) : p.renderPosition, this.engine.camera);

    // World (online: the mirror's clock, a snapshot behind the server).
    const m = this.mirror;
    const renderTime = m ? this.sim.time : this.sim.time - step + alpha * step;
    this.zombies.update(live, this.sim, renderTime, this.engine.camera);
    // Walking through the dead kicks their limbs aside.
    if (!this.ragdoll && live > 0) this.zombies.nudge(this.player.renderPosition, this.player.velocity);
    this.raid.update(live, this.sim, renderTime, this.engine.camera, !!m);
    this.limbs.update(live, this.sim, m ? m.limbAlpha : alpha, this.engine.camera, m ? m.limbStep : step);
    this.pickups.update(live, this.sim, this.engine.camera);
    if (m) {
      this.remotes!.update(live, this.sim, m, this.engine.camera, this.ownBikePose(alpha));
      this.updateVoices();
    }
    // After the other survivors: their boards go under their feet as drawn this frame (not the last).
    this.skates.update(live, this.sim, this.engine.camera, (b) => this.boardPose(b, alpha));
    // After the others: their bikes go where they are drawn this frame.
    this.bikes.update(live, this.sim, this.engine.camera, (b) => this.bikePose(b, alpha));
    // Lights for the other survivors' lamps and the headlights of cars (not this survivor's own:
    // the flashlight is theirs while they drive), nearest first.
    this.beamList.length = 0;
    if (this.remotes) for (const b of this.remotes.beams) this.beamList.push(b);
    this.vehicleView.beams(this.beamList, this.driving?.vehicle.id ?? -1);
    flashlight()?.placeRemotes(this.beamList, this.engine.camera.position, live);
    this.updateEngines(running);
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
    if (settings.value.controls.aimView !== 'sights' || this.phase !== 'playing' || this.player.seated?.driver) return null;
    const a = this.me.arsenal;
    if (a.action === 'reload' || a.action === 'draw' || a.limb || a.meleeOut) return null;
    return this.sightFor(a.weapon.id);
  }

  private get canAim(): boolean {
    const a = this.me.arsenal;
    // Nothing to aim down while both hands are on a severed arm (or on the wheel, or the handlebars).
    return a.action !== 'melee' && a.action !== 'bandage' && !a.limb && !a.meleeOut && !this.player.seated?.driver && !this.player.cycle;
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
    m.light = !this.driving && (flashlight()?.on ?? false);
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
    const d = this.driving;
    if (d && this.vehicleView.headlight(d.vehicle.id, this.tmpTorchAt, this.tmpTorchDir)) {
      // At the wheel the light is the car's headlights (the chest lamp waits, switched as it was).
      torch.update(dt, alive && d.lights && d.vehicle.engine, this.tmpTorchAt, this.tmpTorchDir, true);
      this.lamp.show(0, this.engine.camera);
      return;
    }
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
    // Sticks and thumbs get help onto zombies; the mouse never does (nor anyone at a wheel).
    let friction = 1;
    if (input.device !== 'mouse' && !this.driving) {
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
    if (this.driving) {
      // At the wheel: the pedals, the steering, the handbrake, the horn and the headlights.
      this.driving.read(input);
      input.consumeWheel();
      if (input.pressed('chat') && this.chatBox && !this.chatBox.isOpen) {
        this.chatBox.open();
        input.clear();
      }
      if (input.held('inventory')) this.inventory.show(this.ui, this.me, this.timerText());
      else this.inventory.hide();
      this.handleInteraction(dt);
      return;
    }
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

    if (p.cycle) {
      this.saddleInput(dt);
      return;
    }
    this.fireHeld = input.held('fire');
    if (input.pressed('fire')) this.fireBuffer = 0.18;
    if (this.fireHeld || this.fireBuffer > 0) p.blockSprint(0.35);
    if (input.pressed('reload')) this.wantReload = true;
    if (input.pressed('weapon1')) this.wantSlot = 'primary';
    if (input.pressed('weapon2')) this.wantSlot = 'secondary';
    if (input.pressed('weapon3')) this.wantSlot = 'melee';
    const wheel = input.consumeWheel();
    if (wheel !== 0) {
      // Primary → secondary → melee weapon in hand → primary (the other way scrolling up); in a
      // seat there is no room to swing, so only the guns.
      const order = ['primary', 'secondary', 'melee'] as const;
      const n = p.seated ? 2 : 3;
      const at = Math.min(n - 1, a.meleeOut ? 2 : a.active === 'primary' ? 0 : 1);
      this.wantSlot = order[(at + (wheel > 0 ? 1 : n - 1)) % n];
    }
    // In a seat: shoot, reload, bandage; no room to swing or throw.
    if (input.pressed('melee') && !p.seated) this.wantMelee = true;
    if (!p.seated) this.throwInput();
    if (input.pressed('chat') && this.chatBox && !this.chatBox.isOpen) {
      this.chatBox.open();
      input.clear();
    }
    if (input.pressed('gunsmith') && !p.seated) {
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

    this.handleInteraction(dt);
  }

  /**
   * In the saddle both hands are on the bars: the trigger rings the bell, and the keys that would
   * want a hand (reload, swap, swing, throw, bandage, the gunsmith) only say so.
   */
  private saddleInput(dt: number): void {
    const input = this.input;
    this.fireHeld = false;
    this.fireBuffer = 0;
    this.wantReload = this.wantMelee = this.wantHeal = false;
    this.wantSlot = null;
    this.wantThrow = null;
    this.throws.priming = null;
    if (input.pressed('fire')) this.ringBell();
    const wheel = input.consumeWheel();
    const hands: Action[] = ['reload', 'weapon1', 'weapon2', 'weapon3', 'melee', 'grenade', 'molotov', 'heal', 'gunsmith'];
    if ((wheel !== 0 || hands.some((k) => input.pressed(k))) && this.netNow - this.handsHintAt > 1.5) {
      this.handsHintAt = this.netNow;
      this.hud.feedLine(`HANDS ON THE BARS · ${actionLabel('interact') || 'USE'} TO GET OFF`);
    }
    if (input.pressed('chat') && this.chatBox && !this.chatBox.isOpen) {
      this.chatBox.open();
      input.clear();
    }
    if (input.held('inventory')) this.inventory.show(this.ui, this.me, this.timerText());
    else this.inventory.hide();
    this.handleInteraction(dt);
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
    if (a.meleeOut) {
      // The melee weapon in hand: the trigger swings it, again and again while held.
      const o = this.cam.aimOrigin, d = this.cam.aimDir;
      if (sim.fire(this.myId, { x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z }, pressed, 1) !== 'busy') this.fireBuffer = 0;
      return;
    }
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
      if (m.k === 'snap') {
        mirror.apply(m.snap, m.at);
        // Dropped in after the outbreak: it began without us (no siren), and our run counts from now.
        if (Number.isNaN(this.joinedAt)) {
          this.joinedAt = this.sim.phase === 'survival' ? this.sim.phaseTime : 0;
          this.joinedHordes = this.sim.phase === 'survival' ? hordeAt(this.sim.threatTime).survived : 0;
          if (this.sim.phase === 'survival') this.outbreakAnnounced = true;
        }
      }
      else if (m.k === 'pos') {
        if (!this.player.seated) this.player.teleport(m.pos);
      } else if (m.k === 'vpos') {
        // The server put this survivor's car back where it last accepted it.
        const d = this.driving;
        if (d && d.vehicle.id === m.v[0]) {
          d.reset({ x: m.v[1] / 100, y: m.v[2] / 100, z: m.v[3] / 100 }, m.v[4] / 1000);
          d.follow();
        }
      }
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
    return e.type === 'dryFire' || e.type === 'refit' || e.type === 'throwStart' || (e.type === 'melee' && e.stage === 'swing') || (e.type === 'bandage' && e.stage === 'start')
      || (e.type === 'bike' && e.stage === 'bell');
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
        trigger: this.phase === 'playing' && this.fireHeld && !this.me.arsenal.limb && !this.me.arsenal.meleeOut,
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
      // With an arm in hand the server throws it aside first (and the arm is the club then).
      if (slot === 'melee' ? a.drawMelee() : a.limb ? a.action !== 'melee' : a.switchTo(slot)) this.act({ a: 'switch', slot });
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
    if (a.meleeOut) {
      // The melee weapon in hand: the trigger swings it, again and again while held.
      if (a.action === 'idle') {
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
    // First, so the flash and the case come from the gun of a pair that fired (the rounds left say which).
    this.weapon.fired(def, this.me.arsenal.weapon.mag);
    const muzzle = this.weapon.muzzleWorld(this.tmpA);
    const dir = this.weapon.muzzleDir(this.tmpB);
    this.effects.muzzle(muzzle, dir, weapon);
    audio.gunshot(weapon, muzzle, true, undefined, this.me.arsenal.builds[weapon]?.muzzle === 'suppressor' || weapon === 'wraith');
    const kick = (0.006 + def.recoil * 0.014) * (this.player.aiming ? 0.75 : 1) * (this.player.crouching ? 0.8 : 1);
    this.cam.addRecoil(kick, (Math.random() - 0.5) * def.recoil * 0.008);
    this.cam.addTrauma(0.04 + def.recoil * 0.05);
    this.input.rumble(0.12 + def.recoil * 0.35, 60 + def.recoil * 60);
    this.player.faceCamera(0.7);
    if (weapon === 'shotgun') this.later.push({ t: 0.3, fn: () => this.ejectCasing(true) });
    else if (weapon === 'wraith') {
      // Bolt action: worked by hand after every round, the case flicked out as it comes back.
      this.later.push({ t: 0.32, fn: () => audio.foley('bolt', this.handPos(), 'wraith', 0, true) });
      this.later.push({ t: 0.4, fn: () => this.ejectCasing(false) });
    } else if (weapon !== 'rpg') this.ejectCasing(false);
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
    audio.gunshot(e.weapon, muzzle, false, e.pellets.map((p) => p.end), false, e.player);
    this.raid.weaponOf(e.player)?.fired(WEAPONS[e.weapon]);
  }

  private remoteShot(e: Extract<SimEvent, { type: 'shot' }>): void {
    const r = this.remotes!;
    const shooter = this.sim.players.get(e.player)?.arsenal;
    const w = r.weaponOf(e.player);
    // First, so an akimbo pair's flash, tracers and case come from the gun that fired.
    w?.fired(shooter ? shooter.defOf(e.weapon) : WEAPONS[e.weapon]);
    const muzzle = r.muzzle(e.player, this.tmpA) ?? v3(e.origin, this.tmpA);
    const dir = r.muzzleDir(e.player, this.tmpB) ?? this.tmpB.set(0, 0, 1);
    this.effects.muzzle(muzzle, dir, e.weapon);
    for (let i = 0; i < e.pellets.length; i++) {
      if (e.pellets.length > 1 && i % 3 !== 0) continue;
      this.effects.tracer(muzzle, v3(e.pellets[i].end, this.tmpC));
    }
    audio.gunshot(e.weapon, muzzle, false, e.pellets.map((p) => p.end), shooter?.builds[e.weapon]?.muzzle === 'suppressor' || e.weapon === 'wraith', e.player);
    if (w) {
      if (e.weapon === 'rpg') return;
      const pos = this.tmpC, d = this.tmpD;
      w.ejectWorld(pos, d);
      const floor = this.physics.raycast(pos.x, pos.y, pos.z, 0, -1, 0, 3);
      this.effects.eject(pos, d, floor !== null ? pos.y - floor : pos.y - 1.2, e.weapon === 'shotgun', this.tmpA.set(0, 0, 0));
    }
  }

  private handleInteraction(dt: number): void {
    if (this.player.seated) {
      this.seatControls();
      return;
    }
    if (this.keepReviving()) return;
    // On a skateboard [interact] steps off (nothing else is in reach from the deck); on a bike, gets off it.
    if (this.player.ride) {
      this.hud.setPrompt('interact', 'HOP OFF THE SKATEBOARD');
      if (this.input.pressed('interact')) this.leaveBoard(false);
      return;
    }
    if (this.player.cycle || this.player.pillion) {
      if (this.work) this.sendWork(null);
      this.hud.setPrompt('interact', this.player.cycle ? 'GET OFF THE BIKE' : 'HOP OFF THE PEGS');
      if (this.input.pressed('interact')) {
        if (this.player.cycle) this.leaveBike(false);
        else this.leavePegs();
      }
      return;
    }
    // [jump] at a window in front goes through it.
    const vault = this.lookForVault(dt);
    if (this.input.pressed('jump') && vault) {
      if (vault.plan) {
        this.vaultThrough(vault.plan);
        return;
      }
      this.hud.feedLine(vault.block === 'boarded' ? 'THE WINDOW IS BOARDED UP' : 'NO ROOM TO CLIMB THROUGH');
    }
    const best = this.pickInteraction();
    const slot = this.workableSlot();
    // An opening in reach is boarded up from here unless something else is what the crosshair is on.
    const own = slot && (!best || (best.kind === 'door' && slot.kind === 'door' && best.door!.body.index === slot.ref)) ? slot : null;
    if (this.updateWork(own)) return;
    const key = (a: Action) => actionLabel(a) || (a === 'barricade' ? 'BOARD' : a === 'jump' ? 'JUMP' : 'USE');
    const plan = vault?.plan ?? null;
    const vaultText = plan ? (plan.smash ? 'SMASH THROUGH THE WINDOW' : plan.land ? 'VAULT THROUGH THE WINDOW' : 'JUMP OUT OF THE WINDOW') : '';
    if (own) {
      const what = own.kind === 'door' ? 'DOOR' : 'WINDOW';
      const count = `${own.boards}/${own.max}`;
      if (own.boards > 0) {
        this.hud.setPrompt('interact', `PRY A BOARD OFF THE ${what} · ${count}${own.boards < own.max ? ` · HOLD ${key('barricade')} TO ADD ONE` : ''}`);
        return;
      }
      if (!best) {
        const out = plan && vault?.slot === own ? ` · ${key('jump').toUpperCase()} ${plan.smash ? 'SMASH THROUGH' : 'VAULT OUT'}` : '';
        this.hud.setPrompt('barricade', `HOLD TO BOARD UP THE ${what}${own.kind === 'window' && !own.glass ? ' · GLASS SMASHED' : ''}${out}`);
        return;
      }
    }
    if (!best) {
      this.hud.setPrompt(plan ? 'jump' : null, vaultText);
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
    else if (best.kind === 'supply') {
      const it = best.it!;
      const what = ['UNIVERSAL AMMO', it.frags ? 'GRENADES' : '', it.molotovs ? 'MOLOTOVS' : ''].filter(Boolean).join(' + ');
      this.hud.setPrompt('interact', `TAKE ${what} · ${it.supply} LEFT`);
    }
    else if (best.kind === 'serum') this.hud.setPrompt('interact', `INJECT ${SERUM.name.toUpperCase()} · ARMOR AGAINST THE DEAD`);
    else if (best.kind === 'melee') {
      const mine = this.me.arsenal.meleeId;
      const what = WEAPONS[best.it!.weapon ?? 'machete'].model;
      const pair = best.it!.weapon === 'katana' && mine === 'katana';
      this.hud.setPrompt('interact', pair ? 'PICK UP SECOND KATANA · DUAL WIELD'
        : best.it!.weapon === 'katana' && mine === 'katanas' ? 'BOTH HANDS HOLD A KATANA'
        : mine === 'machete' ? `PICK UP ${what}` : `SWAP ${WEAPONS[mine].model} FOR ${what}`);
    }
    else if (best.kind === 'exclusive') this.hud.setPrompt('interact', `TAKE ${WEAPONS[best.it!.weapon ?? 'ar'].model} · REPLACES ${WEAPONS[this.me.arsenal.primary.id].model}`);
    else if (best.kind === 'board') this.hud.setPrompt('interact', 'RIDE THE SKATEBOARD');
    else if (best.kind === 'vehicle') {
      const v = best.vehicle!;
      const gas = v.gas <= 0 ? 'NO GAS' : `GAS ${Math.max(1, Math.round(v.gas * 100))}%`;
      this.hud.setPrompt('interact', `${v.seats[0] === null ? 'DRIVE' : 'GET IN'} THE ${v.def.name} · ${gas}`);
    }
    else if (best.kind === 'bike') {
      const rider = best.seat === 'peg' && best.bike!.rider ? this.sim.players.get(best.bike!.rider) : undefined;
      this.hud.setPrompt('interact', best.seat === 'peg' ? `HOP ON THE PEGS${rider ? ` · ${rider.name.toUpperCase()} RIDES` : ''}` : 'GET ON THE BIKE');
    }
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
    } else if (best.kind === 'vehicle') {
      this.getIn(best.vehicle!);
    } else if (best.kind === 'bike') {
      this.rideBike(best.bike!, best.seat!);
    } else if (best.kind === 'limb') {
      if (this.link) this.act({ a: 'grab', limb: best.limb!.id });
      else this.sim.grabLimb(this.myId, best.limb!.id);
    } else if (this.link) {
      this.link.act({ a: 'use', id: best.it!.id });
    } else {
      this.sim.use(this.myId, best.it!.id);
    }
  }

  // ------------------------------------------------------------------ vaulting through windows

  /**
   * The window in front of this survivor that [jump] would take them through (or why not), looked
   * up a few times a second and at once when [jump] is pressed. "In front" is the way they move,
   * or where the camera looks when standing still.
   */
  private lookForVault(dt: number): VaultChoice | null {
    const p = this.player;
    const jump = this.input.pressed('jump');
    this.vaultLookT -= dt;
    if (!jump && this.vaultLookT > 0) return this.vaultChoice;
    this.vaultLookT = 0.1;
    this.vaultChoice = null;
    if (!this.me.up || p.ride || p.vault || p.seated || p.downed || this.work || (!p.grounded && !jump)) return null;
    const mv = this.input.move;
    const yaw = this.cam.yaw;
    let fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    if (Math.hypot(mv.x, mv.y) > 0.3) {
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const wx = fx * mv.y + rx * mv.x, wz = fz * mv.y + rz * mv.x;
      const l = Math.hypot(wx, wz);
      fx = wx / l;
      fz = wz / l;
    }
    const pos = p.position;
    this.vaultChoice = findVault(this.physics, this.sim.barricades, { x: pos.x, y: pos.y, z: pos.z }, { x: fx, z: fz }, p.crouching ? PLAYER.crouchHeight : PLAYER.height, this.porches);
    return this.vaultChoice;
  }

  /** Over the sill (smashing the glass if it's still in): at once here; the server is told online. */
  private vaultThrough(plan: VaultPlan): void {
    const p = this.player;
    if (this.work) this.sendWork(null);
    const slot = this.sim.barricades.slots[plan.slot];
    if (!slot) return;
    if (this.link) {
      this.link.act({ a: 'vault', slot: plan.slot });
      if (plan.smash && this.sim.barricades.breakGlass(slot)) {
        // Shown now; the server's word on it comes back a moment later and isn't shown twice.
        this.smashedHere.set(plan.slot, this.netNow);
        const at = { x: slot.center.x, y: slot.bottom + slot.height * 0.45, z: slot.center.z };
        this.onEvent({ type: 'glassBroken', slot: plan.slot, pos: at, dir: { x: plan.dir.x, y: 0, z: plan.dir.z } });
      }
    } else if (!this.sim.vault(this.myId, plan.slot)) {
      return;
    }
    p.startVault(plan);
    this.vaultChoice = null;
    this.hud.setPrompt(null);
    audio.vault(this.tmpE.set(slot.center.x, slot.bottom + 0.3, slot.center.z));
    this.input.rumble(plan.smash ? 0.45 : 0.2, plan.smash ? 160 : 90);
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

  /** After the first plain ollie: which way to hold the stick (or keys) while popping for each flip trick. */
  private trickHint(): void {
    if (this.trickHinted) return;
    this.trickHinted = true;
    const d = this.input.device;
    const k = (a: Action, alt: string) => actionLabel(a) || alt;
    const jump = k('jump', d === 'pad' ? 'A' : d === 'touch' ? 'JUMP' : 'SPACE');
    // Keys by their bindings; a stick by the way it is pushed (short enough for a phone's width).
    const stick = d === 'pad' || d === 'touch';
    const [l, r, b] = stick ? ['←', '→', '↓'] : [k('left', 'A'), k('right', 'D'), k('back', 'S')];
    const [bl, br] = stick ? ['↙', '↘'] : [`${b}+${l}`, `${b}+${r}`];
    this.hud.notify('FLIP TRICKS', `${jump} + ${stick ? 'STICK ' : ''}${l} KICKFLIP · ${r} HEELFLIP · ${b} SHOVE-IT · ${bl} 360 FLIP · ${br} VARIAL HEELFLIP`, 5);
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
    this.cam.rush = r ? THREE.MathUtils.smoothstep(r.speed, 5, SKATEBOARD.sprintTop) : 0;
    const popped = p.popped, tricked = p.tricked, landed = p.landedTrick;
    p.kicked = p.popped = false;
    p.tricked = p.landedTrick = null;
    this.streakT = Math.max(0, this.streakT - dt);
    if (!r) return;
    // A flip trick: the others see it (online it goes by the server; solo the simulation hears of it
    // all the same), and once it is landed it is called out.
    if (tricked) {
      if (this.link) this.link.act({ a: 'trick', kind: tricked });
      else this.sim.skateTrick(this.myId, tricked);
    } else if (popped && !this.trickHinted && r.since > 1) this.later.push({ t: 0.7, fn: () => this.trickHint() });
    if (tricked) this.trickHinted = true;
    if (landed) {
      this.streak = this.streakT > 0 ? this.streak + 1 : 1;
      this.streakT = 3;
      this.hud.trickCall(SKATE_TRICKS[landed].name, this.streak);
      this.input.rumble(0.25, 90);
    }
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
    o.trick = r.trick;
    o.trickU = p.trickU(alpha);
    o.toe = p.character.skateToe;
    return o;
  }

  // ------------------------------------------------------------------ vehicles

  /** Where a vehicle is drawn: this survivor's own car between fixed steps, others gliding between snapshots. */
  private readonly drawAt = (v: Vehicle, out: Vec3): number | null => {
    const d = this.driving;
    if (d && d.vehicle === v) return d.drawn(this.alpha, out);
    return this.mirror ? this.mirror.vehiclePose(v.id, out) : null;
  };

  /** Into the seat the simulation (or the server) gave this survivor, or out of the one they left. */
  private syncSeat(): void {
    const at = this.me.alive ? this.sim.vehicles.seatOf(this.myId) : null;
    const p = this.player;
    const cur = p.seated;
    if (at) {
      const [v, seat] = at;
      if (cur && cur.vehicle === v.id && cur.seat === seat) return;
      p.sitIn(v.id, seat, seat === 0);
      this.cam.seat = seat === 0 ? 'driver' : 'passenger';
      this.cam.seeThrough = this.assist.seeThrough = v.body;
      this.touch.setSeat(seat === 0 ? 'driver' : 'passenger');
      this.throws.priming = null;
      this.driving = seat === 0 ? new Driving(this.physics, this.sim, v) : null;
      this.driveT = 0;
      if (this.driving) this.mirror?.dropVehicleTrack(v.id);
      if (!cur) this.carHint(seat === 0);
      return;
    }
    if (!cur) return;
    const out = this.exitAt ?? this.me.motion.pos;
    this.exitAt = null;
    p.leaveSeat(out);
    this.cam.seat = null;
    this.cam.seeThrough = this.assist.seeThrough = null;
    this.touch.setSeat(null);
    this.driving = null;
  }

  /** The first time in a vehicle: how it's driven (or what a passenger can do). */
  private carHint(driver: boolean): void {
    if (this.carHinted) return;
    this.carHinted = true;
    const d = this.input.device;
    const k = (a: Action, alt: string) => actionLabel(a) || alt;
    if (!driver) {
      this.hud.notify('PASSENGER', d === 'touch' ? 'SHOOT FROM THE WINDOWS · SEAT MOVES OVER · USE GETS OUT' : `SHOOT FROM THE WINDOWS · ${k('barricade', 'G')} CHANGE SEAT · ${k('interact', 'E')} GET OUT`, 4);
      return;
    }
    this.hud.notify('DRIVING · WATCH THE GAS', d === 'touch'
      ? 'STICK UP GAS · DOWN BRAKE AND REVERSE · SIDEWAYS STEERS · BRAKE BUTTON HANDBRAKE · HORN · USE GETS OUT'
      : d === 'pad'
        ? `RT GAS · LT BRAKE · LEFT STICK STEERS · ${k('jump', 'A')} HANDBRAKE · ${k('melee', 'R3')} HORN · ${k('flashlight', '↑')} LIGHTS · ${k('interact', 'RB')} GET OUT`
        : `${k('forward', 'W')} GAS · ${k('back', 'S')} BRAKE AND REVERSE · ${k('left', 'A')}/${k('right', 'D')} STEER · ${k('jump', 'SPACE')} HANDBRAKE · ${k('melee', 'F')} HORN · ${k('flashlight', 'L')} LIGHTS · ${k('interact', 'E')} GET OUT`,
      5);
  }

  /** Puts this survivor on their seat as the vehicle is drawn this frame. */
  private placeSeated(): void {
    const s = this.player.seated;
    if (!s) return;
    const yaw = this.vehicleView.seatPoint(s.vehicle, s.seat, this.seatPos);
    const v = this.sim.vehicles.vehicle(s.vehicle);
    if (yaw === null || !v) return;
    this.player.seatAt(this.seatPos, yaw, this.driving ? this.driving.body.vel : v.vel);
  }

  /** One fixed step at the wheel: the car moves here, and where it went is told (the simulation, or the server ~30 times a second). */
  private driveStep(step: number): void {
    const d = this.driving!;
    if (this.phase !== 'playing' || !this.me.up) d.release();
    d.step(step);
    if (this.link) {
      d.follow();
      this.driveT -= step;
      if (this.driveT <= 0) {
        this.driveT += 1 / MOTION_RATE;
        if (this.driveT < 0) this.driveT = 0;
        this.link.send(C2S.drive, packDrive(d.report()));
      }
    } else {
      this.sim.drive(this.myId, d.report());
    }
  }

  /** Online: the server's word on this survivor's car before anything that depends on where it is (getting out). */
  private flushDrive(): void {
    if (this.link && this.driving) {
      this.link.send(C2S.drive, packDrive(this.driving.report()));
      this.driveT = 1 / MOTION_RATE;
    }
  }

  /**
   * A car someone drives into this survivor (on foot) pushes them aside: out of its bodywork the
   * shortest way, as it is drawn. Parked ones are solid to walk into already.
   */
  private shoveFromCars(): void {
    const p = this.player;
    if (p.seated || !this.me.alive) return;
    const pos = p.position;
    const at = this.tmpE;
    for (const v of this.sim.vehicles.list) {
      if (!v.touched || Math.abs(v.pos.x - pos.x) > 9 || Math.abs(v.pos.z - pos.z) > 9) continue;
      const yaw = this.drawAt(v, at) ?? (at.set(v.pos.x, v.pos.y, v.pos.z), v.yaw);
      if (pos.y > at.y + v.def.low || pos.y + PLAYER.height < at.y + v.def.clear) continue;
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      const dx = pos.x - at.x, dz = pos.z - at.z;
      const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
      const r = PLAYER.radius + 0.04;
      const px = v.def.hx + r - Math.abs(lx), pz = v.def.hz + r - Math.abs(lz);
      if (px <= 0 || pz <= 0) continue;
      if (px < pz) {
        const k = lx >= 0 ? px : -px;
        p.shove(c * k, -sn * k);
      } else {
        const k = lz >= 0 ? pz : -pz;
        p.shove(sn * k, c * k);
      }
    }
  }

  /** Gets into a vehicle in reach (the driver's seat if it's free). */
  private getIn(v: Vehicle): void {
    if (this.player.vault) return;
    if (this.player.ride) this.leaveBoard(false);
    if (this.link) this.link.act({ a: 'seat', v: v.id });
    else if (this.sim.enterVehicle(this.myId, v.id)) this.syncSeat();
  }

  /** In a seat: [interact] gets out (not at speed), [barricade] moves over to the next free seat. */
  private seatControls(): void {
    const at = this.sim.vehicles.seatOf(this.myId);
    if (!at) {
      this.hud.setPrompt(null);
      return;
    }
    const [v] = at;
    const speed = Math.abs(this.driving ? this.driving.body.speed : v.speed);
    const free = v.seats.includes(null);
    const key = (a: Action, alt: string) => actionLabel(a) || alt;
    const seatHint = free ? ` · ${key('barricade', 'SEAT')} CHANGE SEAT` : '';
    if (speed > VEHICLE.exitSpeed) this.hud.setPrompt('interact', `SLOW DOWN TO GET OUT${seatHint}`);
    else this.hud.setPrompt('interact', `GET OUT${seatHint}`);
    if (this.input.pressed('barricade') && free) {
      this.flushDrive();
      if (this.link) this.link.act({ a: 'seat', v: v.id, s: -1 });
      else if (this.sim.switchSeat(this.myId)) this.syncSeat();
    }
    if (this.input.pressed('interact') && speed <= VEHICLE.exitSpeed) {
      this.flushDrive();
      if (this.link) this.link.act({ a: 'seat', v: -1 });
      else if (this.sim.exitVehicle(this.myId)) this.syncSeat();
      else this.hud.feedLine('NO ROOM TO GET OUT HERE');
    }
  }

  /**
   * Every frame in a vehicle: hard hits jolt the view (and the controller), the view swings round
   * behind a moving car unless the driver is looking about, and the HUD shows speed and gas.
   */
  private updateDriving(dt: number): void {
    const p = this.player;
    const at = this.phase !== 'dead' && this.me.alive ? this.sim.vehicles.seatOf(this.myId) : null;
    if (!at || !p.seated) {
      this.hud.setVehicle(null);
      if (!p.ride) this.cam.rush = 0;
      return;
    }
    const [v, seat] = at;
    const d = this.driving;
    const speed = d ? d.body.speed : v.speed;
    if (d) {
      if (d.jolt >= VEHICLE.crashSound) {
        const k = Math.min(1, d.jolt / 20);
        this.cam.addTrauma(0.2 + k * 0.6);
        this.input.rumble(0.4 + k * 0.6, 160 + k * 200);
      }
      if (d.thud > 0) {
        this.cam.addTrauma(Math.min(0.25, 0.06 + d.thud * 0.008));
        this.input.rumble(0.3, 90);
      }
      d.jolt = d.thud = 0;
      if (this.phase === 'playing') this.cam.follow(dt, v.yaw + Math.PI / 2, 2.4 * THREE.MathUtils.smoothstep(Math.abs(speed), 1.5, 6));
    }
    this.cam.rush = THREE.MathUtils.smoothstep(Math.abs(speed), 8, 26) * 0.8;
    const state = v.crank > 0 ? 'STARTING' : v.engine ? (d && !d.lights ? 'LIGHTS OFF' : '') : v.gas <= 0 ? 'OUT OF GAS' : seat === 0 ? 'ENGINE OFF' : '';
    this.hud.setVehicle({ name: v.def.name, seat: seat === 0 ? 'DRIVING' : 'PASSENGER', mph: Math.abs(speed) * 2.237, gas: v.gas, state });
  }

  /** Engines running and horns sounding near the listener: the nearest three are heard. */
  private updateEngines(running: boolean): void {
    const list = this.engineList;
    list.length = 0;
    if (running && this.phase !== 'loading') {
      const cam = this.engine.camera.position;
      const vs = this.sim.vehicles.list;
      while (this.engineSounds.length < vs.length) {
        this.engineSounds.push({ id: 0, pos: new THREE.Vector3(), kind: 'car', running: false, speed: 0, top: 1, throttle: false, horn: false, d: 0 });
      }
      const near: (EngineSound & { d: number })[] = [];
      for (const v of vs) {
        const mine = this.driving?.vehicle === v ? this.driving : null;
        const horn = mine ? mine.horn : (v.input & DRIVE_FLAG.horn) !== 0;
        if (!v.engine && !horn) continue;
        const e = this.engineSounds[v.id];
        if (this.vehicleView.drawnPose(v.id, e.pos) === null) e.pos.set(v.pos.x, v.pos.y, v.pos.z);
        e.d = e.pos.distanceToSquared(cam);
        if (e.d > 160 * 160) continue;
        e.id = v.id;
        e.kind = v.kind;
        e.running = v.engine;
        e.speed = mine ? mine.body.speed : v.speed;
        e.top = v.def.top;
        e.throttle = mine ? mine.input.throttle > 0.1 : (v.input & DRIVE_FLAG.throttle) !== 0;
        e.horn = horn && this.phase !== 'dead';
        near.push(e);
      }
      near.sort((a, b) => a.d - b.d);
      for (let i = 0; i < near.length && i < 3; i++) list.push(near[i]);
    }
    audio.engines(list);
  }

  /** Something happened to a vehicle: doors, the starter, the engine catching or dying, a crash. */
  private onVehicle(e: Extract<SimEvent, { type: 'vehicle' }>): void {
    const v = this.sim.vehicles.vehicle(e.vehicle);
    const at = this.vehicleView.drawnPose(e.vehicle, this.tmpA) !== null ? this.tmpA : e.pos ? v3(e.pos, this.tmpA) : null;
    if (!v || !at) return;
    const mine = e.player === this.myId;
    const inside = this.player.seated?.vehicle === e.vehicle;
    switch (e.stage) {
      case 'in':
        audio.carDoor(at);
        break;
      case 'out':
      case 'thrown':
        if (mine && e.pos) this.exitAt = { ...e.pos };
        audio.carDoor(e.pos ? v3(e.pos, this.tmpB) : at);
        break;
      case 'crank':
        audio.starter(at, v.def.crank);
        break;
      case 'start':
        audio.engineCatch(at, v.kind === 'truck');
        break;
      case 'dry':
        audio.sputter(at);
        if (mine) this.hud.notify('THE TANK IS DRY', 'THIS ONE WON\'T START · FIND ANOTHER CAR', 2.6, 'danger');
        break;
      case 'empty':
        audio.sputter(at);
        if (inside) this.hud.notify('OUT OF GAS', 'THE ENGINE DIED · FIND ANOTHER CAR', 2.6, 'danger');
        break;
      case 'crash': {
        const k = e.strength ?? VEHICLE.crashSound;
        audio.carCrash(at, k);
        // The driver felt it already; the others in the car feel it now.
        if (inside && !this.driving) this.cam.addTrauma(Math.min(0.8, 0.15 + k * 0.03));
        break;
      }
    }
  }

  // ------------------------------------------------------------------ bicycles

  /**
   * Gets on a bike in reach: picks up one lying about, or hops on the pegs of one a teammate
   * rides. At once here; online the server may give the seat to someone quicker.
   */
  private rideBike(b: Bicycle, seat: BikeSeat): void {
    const p = this.player;
    if (p.ride || p.cycle || p.pillion || !this.me.up) return;
    const under = seat === 'peg' ? this.drawnBike(b, this.underPegs) : null;
    if (seat === 'peg' && !under) return;
    if (this.link) {
      if (seat === 'rider') {
        b.rider = this.myId;
        b.pos = { x: p.position.x, y: p.position.y, z: p.position.z };
      } else b.passenger = this.myId;
      this.mirror!.holdBike(b.id, this.netNow + this.link.rtt + 0.5);
      this.link.act({ a: 'bike', id: b.id, seat });
    } else if (!this.sim.rideBike(this.myId, b.id, seat)) return;
    this.bikeAskedAt = this.netNow;
    if (this.work) this.sendWork(null);
    if (seat === 'rider') {
      // Both hands go to the bars: whatever they were doing stops (the server does the same).
      const a = this.me.arsenal;
      if (this.link) {
        a.cancelReload();
        a.cancelBandage();
        if (a.meleeOut) a.switchTo(a.active);
      }
      this.throws.priming = null;
      p.mountBike(b.id, this.cam.yaw, !!b.passenger && b.passenger !== this.myId);
    } else {
      p.boardPegs(b.id, this.pegsOf(under!, this.tmpE), under!.yaw);
    }
    const d = this.input.device;
    const k = (a: Action, alt: string) => actionLabel(a) || alt;
    if (seat === 'rider' && !this.bikeHinted) {
      this.bikeHinted = true;
      this.hud.notify('BICYCLE', d === 'touch'
        ? 'STICK UP PEDALS · DOWN BRAKES · SIDEWAYS STEERS · JUMP HOPS · FIRE RINGS THE BELL · USE GETS OFF'
        : d === 'pad'
          ? `LEFT STICK PEDAL · BRAKE · STEER · ${k('jump', 'A')} HOP · ${k('sprint', 'L3')} STAND ON THE PEDALS · ${k('fire', 'RT')} BELL · ${k('interact', 'RB')} GET OFF`
          : `${k('forward', 'W')} PEDAL · ${k('back', 'S')} BRAKE · ${k('left', 'A')}/${k('right', 'D')} STEER · ${k('jump', 'SPACE')} HOP · ${k('sprint', 'SHIFT')} STAND ON THE PEDALS · ${k('fire', 'FIRE')} BELL · ${k('interact', 'E')} GET OFF`,
        5);
    } else if (seat === 'peg' && !this.pegHinted) {
      this.pegHinted = true;
      this.hud.notify('ON THE PEGS', `AIM AND SHOOT WHILE THEY PEDAL · ${d === 'touch' ? 'USE' : k('interact', d === 'pad' ? 'RB' : 'E')} HOPS OFF`, 4);
    }
  }

  /** Gets off the saddle (or, `bail`, is thrown off by a wall): the bike falls over where the session put it. */
  private leaveBike(bail: boolean): void {
    const p = this.player;
    const c = p.cycle;
    if (bail) p.bailed = true;
    const at = p.dismountBike();
    p.bailed = false;
    if (!c || !at) return;
    const pos = at.pos;
    const d = this.physics.raycast(pos.x, pos.y + 0.5, pos.z, 0, -1, 0, 2);
    if (d !== null) pos.y = pos.y + 0.5 - d;
    if (this.link) {
      const b = this.sim.bicycles.bike(c.bike);
      if (b && b.rider === this.myId) {
        b.rider = null;
        b.passenger = null;
        b.pos = { ...pos };
        b.yaw = at.yaw;
      }
      this.mirror!.holdBike(c.bike, this.netNow + this.link.rtt + 0.5);
      this.link.act({ a: 'bike', id: -1, at: pos, yaw: at.yaw, bail });
      if (bail) {
        this.bikeBailSentAt = this.netNow;
        this.bikeBailFeedback(v3(pos, this.tmpE), 'THROWN OFF THE BIKE');
      }
    } else {
      // A bail comes back as an event (the feedback is shown there).
      this.sim.leaveBike(this.myId, pos, at.yaw, bail);
    }
  }

  /** Steps down off the pegs, beside the back wheel (the side with room), with some of the bike's speed. */
  private leavePegs(): void {
    const p = this.player;
    const pl = p.pillion;
    if (!pl) return;
    const spot = this.stepDown(pl.pos, pl.yaw);
    p.leavePegs(spot, Math.hypot(pl.vel.x, pl.vel.z));
    if (this.link) {
      const b = this.sim.bicycles.bike(pl.bike);
      if (b && b.passenger === this.myId) b.passenger = null;
      this.mirror!.holdBike(pl.bike, this.netNow + this.link.rtt + 0.5);
      this.link.act({ a: 'bike', id: -1, at: spot, yaw: pl.yaw });
    } else this.sim.leaveBike(this.myId, spot, pl.yaw);
  }

  /** Where a passenger steps down: to the bike's left of the pegs (its right if a wall is there), on the floor. */
  private stepDown(pegs: THREE.Vector3, yaw: number): Vec3 {
    const lx = Math.cos(yaw), lz = -Math.sin(yaw);
    const y = pegs.y + 0.3;
    let side = 1;
    for (const s of [1, -1]) {
      const room = this.physics.raycast(pegs.x, y, pegs.z, lx * s, 0, lz * s, 0.9);
      if (room === null) {
        side = s;
        break;
      }
    }
    const x = pegs.x + lx * side * 0.7, z = pegs.z + lz * side * 0.7;
    const d = this.physics.raycast(x, y + 0.2, z, 0, -1, 0, 3);
    return { x, y: d !== null ? y + 0.2 - d : pegs.y - BICYCLE.pegHeight, z };
  }

  /** Thrown off (or knocked off) a bike: it clatters down, the view jolts. */
  private bikeBailFeedback(pos: THREE.Vector3, line: string): void {
    audio.bikeCrash(pos);
    this.cam.addTrauma(0.38);
    this.input.rumble(0.55, 240);
    this.hud.feedLine(line);
  }

  /** The bell on the bars (the trigger finger's only job in the saddle): heard down the street, by the dead too. */
  private ringBell(): void {
    if (this.netNow - this.bellAt < BICYCLE.bellEvery) return;
    this.bellAt = this.netNow;
    if (this.link) {
      this.link.act({ a: 'bell' });
      audio.bikeBell(this.bellPos(this.tmpE), true);
    } else this.sim.ringBell(this.myId);
  }

  /** The bell, on the left of the bars of this survivor's bike. */
  private bellPos(out: THREE.Vector3): THREE.Vector3 {
    const p = this.player;
    const yaw = p.cycle ? p.cycle.heading : p.facing;
    return out.set(p.renderPosition.x + Math.sin(yaw) * BICYCLE.grips.z, p.renderPosition.y + BICYCLE.grips.y, p.renderPosition.z + Math.cos(yaw) * BICYCLE.grips.z);
  }

  /**
   * Every frame on a bike. In the saddle: a wall taken head-on throws the rider off, a bike the
   * server gave to someone else comes out from under them, someone on the pegs makes it heavier,
   * and at speed the view swings round behind it unless the player is looking about. On the pegs:
   * a seat the server gave to someone else (or a bike that is gone) puts the feet back on the street.
   */
  private updateCycle(dt: number): void {
    const p = this.player;
    const c = p.cycle;
    const grace = this.link ? this.link.rtt + 0.8 : 0;
    if (c) {
      this.cam.rush = THREE.MathUtils.smoothstep(c.speed, 6, BICYCLE.sprintTop);
      if (p.bailed) {
        this.leaveBike(true);
        return;
      }
      if (!this.me.up || this.phase === 'dead') {
        p.dismountBike();
        return;
      }
      const b = this.sim.bicycles.bike(c.bike);
      if (!b || (b.rider !== this.myId && this.netNow - this.bikeAskedAt > grace)) {
        p.dismountBike();
        if (b?.rider) this.hud.feedLine('SOMEONE ELSE GOT TO THAT BIKE');
        return;
      }
      c.loaded = !!b.passenger && b.passenger !== this.myId;
      if (this.phase === 'playing') this.cam.follow(dt, c.heading, 1.6 * THREE.MathUtils.smoothstep(c.speed, 2, 7));
      return;
    }
    const pl = p.pillion;
    if (!pl) return;
    if (!this.me.up || this.phase === 'dead') {
      p.leavePegs(null);
      return;
    }
    const b = this.sim.bicycles.bike(pl.bike);
    if (!b || ((b.passenger !== this.myId || !b.rider) && this.netNow - this.bikeAskedAt > grace)) {
      p.leavePegs(this.stepDown(pl.pos, pl.yaw));
      if (b?.passenger) this.hud.feedLine('SOMEONE ELSE GOT ON THOSE PEGS');
    }
  }

  /** Before the fixed steps: a passenger's feet go where the pegs of the bike under them are drawn this frame. */
  private gluePegs(): void {
    const pl = this.player.pillion;
    if (!pl) return;
    const b = this.sim.bicycles.bike(pl.bike);
    const under = b ? this.drawnBike(b, this.underPegs) : null;
    if (!b || !under) return;
    this.pegsOf(under, pl.pos);
    const rider = b.rider ? this.sim.players.get(b.rider) : undefined;
    if (rider) pl.vel.set(rider.motion.vel.x, 0, rider.motion.vel.z);
    else pl.vel.set(0, 0, 0);
    pl.yaw = under.yaw;
    pl.lean = under.lean;
  }

  /** Where the pegs are (the soles on top of them) on a bike drawn so. */
  private pegsOf(bike: BikePose, out: THREE.Vector3): THREE.Vector3 {
    return out.set(bike.pos.x - Math.sin(bike.yaw) * BICYCLE.pegBack, bike.pos.y + BICYCLE.pegHeight, bike.pos.z - Math.cos(bike.yaw) * BICYCLE.pegBack);
  }

  /**
   * Where another survivor's bike is drawn now (online: where the mirror has its rider at this
   * frame's time, the way and lean as last drawn), or where it lies.
   */
  private drawnBike(b: Bicycle, out: BikePose): BikePose | null {
    if (b.rider && b.rider !== this.myId && this.remotes && this.mirror) {
      const now = this.remotes.bikeNow(b.rider, this.mirror, out);
      if (now) return now;
    }
    if (b.rider === this.myId) return this.ownBikePose(1);
    out.pos.set(b.pos.x, b.pos.y, b.pos.z);
    out.yaw = b.yaw;
    out.lean = 0;
    out.steer = 0;
    out.pedalling = false;
    out.brake = 0;
    out.air = false;
    return out;
  }

  /** This survivor's own bike as drawn (under them in the saddle), or null when they aren't pedalling one. */
  private ownBikePose(alpha: number): BikePose | null {
    const p = this.player;
    const c = p.cycle;
    if (!c || this.phase === 'dead') return null;
    const o = this.myBike;
    o.pos.copy(p.renderPosition);
    o.yaw = p.cycleHeading(alpha);
    o.lean = c.lean;
    o.steer = barAngle(c.steer, c.speed);
    o.crank = c.crank;
    o.pedalling = c.pedalling;
    o.brake = c.brake;
    o.air = !p.grounded;
    return o;
  }

  /** Where a ridden bike is drawn: under this survivor, or another. */
  private bikePose(b: Bicycle, alpha: number): BikePose | null {
    if (!b.rider) return null;
    if (b.rider !== this.myId) return this.remotes?.bikePose(b.rider) ?? null;
    const c = this.player.cycle;
    return c && c.bike === b.id ? this.ownBikePose(alpha) : null;
  }

  /** The opening this survivor could work on from where they stand (inside, within reach), if any. */
  private workableSlot(): BarricadeSlot | null {
    if (!this.me.alive) return null;
    const p = this.player.position;
    return this.barricades.nearest(this.tmpA.set(p.x, p.y + this.player.eyeHeight, p.z), BARRICADE.reach, (s) => this.sim.canWork(this.me, s));
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
    // Vehicles with a seat free: by how near their bodywork is.
    for (const v of this.sim.vehicles.inReach(this.me)) {
      const at = this.vehicleView.drawnPose(v.id, this.tmpC) !== null ? this.tmpC : this.tmpC.set(v.pos.x, v.pos.y, v.pos.z);
      cands.push({ kind: 'vehicle', pos: new THREE.Vector3(at.x, at.y + v.def.low, at.z), vehicle: v, near: outsideBy(v, p.x, p.z) + 0.2 });
    }
    // Bicycles the same (one lying about to pick up, or the pegs of one a teammate rides, by where it is drawn).
    for (const { bike, seat } of this.sim.bicycles.inReach(this.me)) {
      const at = seat === 'peg' ? this.drawnBike(bike, this.underPegs)?.pos ?? v3(bike.pos, new THREE.Vector3()) : v3(bike.pos, new THREE.Vector3());
      cands.push({ kind: 'bike', pos: new THREE.Vector3(at.x, at.y + (seat === 'peg' ? 0.6 : 0.35), at.z), bike, seat, near: Math.hypot(at.x - p.x, at.z - p.z) - 0.2 });
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
    if (e.type === 'shot' && !e.player.startsWith('raider:')) this.shootCorpses(e);
    else if (e.type === 'explosion') this.zombies.blastCorpses(v3(e.pos, A), 7, 1);
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
        // How heavy the round was: big guns blow more blood and meat out of the back.
        const power = e.gun && isGoreGun(e.gun) ? GORE.power[e.gun] : undefined;
        this.effects.blood(A, B, e.damage, { exit, killed: e.killed, head: e.zone === 'head', melee: e.melee, power });
        this.zombies.hit(e.zombie, e.zone, B, e.damage, e.melee, A, exit?.pos, power ?? 0);
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
        } else if (e.vehicle !== undefined) {
          // Run down: the thump into the bodywork, and what it does to them.
          audio.carHit(A, Math.min(1, e.damage / 120));
          audio.flesh(A, { damage: e.damage, head: false, own: e.by === this.myId, melee: true });
        } else {
          audio.flesh(A, { damage: e.damage, head: e.zone === 'head', own: e.by === this.myId, melee: e.melee, power });
        }
        if (e.by === this.myId) {
          const kind = e.killed ? (e.zone === 'head' ? 'head' : 'kill') : 'hit';
          // Seen, not heard: the round going in is the sound of a hit.
          this.hud.hitMarker(kind);
        }
        if (!e.killed && Math.random() < 0.4) audio.zombieHurt(this.zombies.headOf(e.zombie, C) ?? A, this.zombies.pitchOf(e.zombie));
        this.bloody(e.by, A, e.melee ? (e.killed ? 0.05 : 0.03) : e.killed ? 0.015 : 0);
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
      case 'vehicle':
        this.onVehicle(e);
        break;
      case 'skate': {
        // Another rider's flip trick: drawn as they leave the ground (this survivor's own already shows).
        if (e.stage === 'trick') {
          if (e.player !== this.myId && e.trick) this.remotes?.trick(e.player, e.trick);
          break;
        }
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
      case 'draw': {
        // The melee weapon taken out to hold: the same grip-settling sound as picking it up.
        if (e.slot !== 'melee' || !isMelee(e.weapon)) break;
        const who = this.sim.players.get(e.player);
        if (!who) break;
        audio.meleePickup(e.weapon, A.set(who.motion.pos.x, who.motion.pos.y + 1.2, who.motion.pos.z));
        break;
      }
      case 'bike': {
        v3(e.pos, A);
        const p = this.player;
        if (e.stage === 'bell') {
          // (Online this survivor's own ring played when it was pressed.)
          if (e.player === this.myId) audio.bikeBell(this.bellPos(A), true);
          else audio.bikeBell(this.remotes?.positionOf(e.player, A)?.setY(A.y - 0.1) ?? A.setY(A.y + BICYCLE.grips.y));
          break;
        }
        if (e.player === this.myId) {
          if (e.seat === 'rider' && e.stage === 'bail') {
            // Knocked off by a hit (a wall the session saw itself, and showed then).
            if (p.cycle) {
              p.bailed = true;
              p.dismountBike();
              p.bailed = false;
            }
            if (this.link && this.netNow - this.bikeBailSentAt < this.link.rtt + 1) break;
            this.bikeBailFeedback(A, 'KNOCKED OFF THE BIKE');
          } else if (e.seat === 'peg' && e.stage !== 'on' && p.pillion) {
            // Put down beside the bike: its rider got off or was thrown, or a hit knocked this survivor off.
            const pl = p.pillion;
            p.leavePegs(e.pos, e.stage === 'bail' ? 0 : Math.hypot(pl.vel.x, pl.vel.z));
            if (e.stage === 'bail') {
              this.cam.addTrauma(0.3);
              this.input.rumble(0.45, 200);
              this.hud.feedLine('KNOCKED OFF THE PEGS');
            }
          }
          break;
        }
        if (e.stage === 'bail' && e.seat === 'rider') audio.bikeCrash(A);
        // Someone hopped on this survivor's pegs (or off them).
        const mine = this.player.cycle;
        if (mine && mine.bike === e.bike && e.seat === 'peg') {
          const who = this.sim.players.get(e.player)?.name.toUpperCase() ?? 'SOMEONE';
          this.hud.feedLine(e.stage === 'on' ? `${who} HOPPED ON THE PEGS` : `${who} HOPPED OFF`);
        }
        break;
      }
      case 'meleeTaken': {
        v3(e.pos, A);
        audio.meleePickup(e.weapon, A);
        if (e.player !== this.myId) break;
        if (e.weapon === 'katanas') {
          this.hud.notify('DUAL KATANAS', `${actionLabel('melee') || 'MELEE'} TO SWING · ${actionLabel('weapon3') || 'SWAP'} TO HOLD THEM OUT`, 3.2);
        } else if (!this.meleeHinted) {
          this.meleeHinted = true;
          this.hud.notify(`${WEAPONS[e.weapon].model} IN HAND`, `${actionLabel('melee') || 'MELEE'} TO SWING · ${actionLabel('weapon3') || 'SWAP'} TO HOLD IT OUT`, 3.2);
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
        this.zombies.died(e.zombie, e.zone, v3(e.dir, B), e.force, { cause: e.cause, gibs: e.gibs, shred: e.shred, blast: e.blast, gun: e.gun, pop: e.pop });
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
        this.zombies.blastCorpses(at, 5, 0.8);
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
      case 'vault': {
        // A zombie climbing over a sill.
        const slot = this.sim.barricades.slots[e.slot];
        const z = this.sim.zombie(e.zombie);
        if (slot) audio.vault(A.set(slot.center.x, slot.bottom + 0.3, slot.center.z), z?.kind === 'brute');
        break;
      }
      case 'playerVault': {
        if (e.player === this.myId) break;
        const slot = this.sim.barricades.slots[e.slot];
        if (slot) audio.vault(A.set(slot.center.x, slot.bottom + 0.3, slot.center.z));
        break;
      }
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
        // This survivor's own vault through it was shown when it started.
        const mine = this.smashedHere.get(e.slot);
        if (mine !== undefined && this.link && this.netNow - mine < 3 && this.netNow - mine > 0.001) {
          this.smashedHere.delete(e.slot);
          break;
        }
        v3(e.pos, A);
        audio.glassBreak(A);
        const slot = this.sim.barricades.slots[e.slot];
        if (slot) {
          // The sash bars break out with it.
          B.set(slot.normal.x, 0, slot.normal.z);
          if (B.dot(C.set(e.dir.x, e.dir.y, e.dir.z)) < 0) B.negate();
          this.effects.splinters(this.tmpD.set(slot.center.x, slot.center.y, slot.center.z), B, { floor: slot.bottom - 1, amount: 0.5, spread: slot.height * 0.45 });
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
      case 'lull':
        this.onLull(e.n, e.stage, e.at, e.back ?? []);
        break;
      case 'playerRespawned':
        if (e.player === this.myId) this.onRespawn(e.pos, e.yaw);
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

  private readonly corpseEnds: THREE.Vector3[] = [];
  private readonly corpseHits: CorpseHit[] = [];

  /**
   * Any survivor's rounds going through bodies already on the ground (every screen gets every
   * shot, so all of them see the dead jerk under it): the body is shoved along the shot, bleeds,
   * and makes the sound of it.
   */
  private shootCorpses(e: Extract<SimEvent, { type: 'shot' }>): void {
    if (!this.zombies.corpseCount || !isGoreGun(e.weapon)) return;
    const ends = this.corpseEnds;
    while (ends.length < e.pellets.length) ends.push(new THREE.Vector3());
    ends.length = e.pellets.length;
    e.pellets.forEach((p, i) => ends[i].set(p.end.x, p.end.y, p.end.z));
    const power = GORE.power[e.weapon];
    // A shotgun's pellets share the push between them.
    const push = GORE.throw[e.weapon] * (e.pellets.length > 1 ? 1.6 / e.pellets.length : 0.55);
    const hits = this.zombies.shootCorpses(v3(e.origin, this.tmpE), ends, power, push, this.corpseHits);
    for (const h of hits) audio.flesh(h.pos, { damage: 18 + power * 20, head: false, own: e.player === this.myId, melee: false, power: power * 0.6 });
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

  /** Blood on whoever made a hit close enough to wear it (melee, or a kill within 3 m). */
  private bloody(by: string, at: THREE.Vector3, amount: number): void {
    if (amount <= 0) return;
    const body = by === this.myId ? this.player.character : this.remotes?.bodyOf(by);
    if (body && body.root.position.distanceToSquared(at) < 12) body.splatter(amount);
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
    this.player.character.splatter(Math.min(0.12, damage * 0.004));
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
    this.diedPhaseTime = this.sim.phaseTime;
    this.survivedAtDeath = this.outbreakAnnounced ? Math.max(0, this.sim.phaseTime - (this.joinedAt || 0) - this.deadFor) : 0;
    this.hordesAtDeath = this.outbreakAnnounced ? Math.max(0, hordeAt(this.sim.threatTime).survived - this.joinedHordes) : 0;
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

    // The held weapon falls (both guns of a pair); the survivor goes limp.
    for (const held of [this.weapon.heldModel, this.weapon.offhandModel]) {
      if (!held) continue;
      const model = createWeaponModel(held.id, held.build);
      model.root.position.copy(held.root.position);
      model.root.quaternion.copy(held.root.quaternion);
      model.root.scale.copy(held.root.scale);
      this.engine.scene.add(model.root);
      this.probe.attach(model.materials);
      const at = model.root.position;
      const hit = this.physics.raycast(at.x, at.y, at.z, 0, -1, 0, 3);
      const lie = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)),
      );
      const rest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2).multiply(lie);
      this.dropped.push({
        model,
        vel: this.player.velocity.clone().multiplyScalar(0.5).add(new THREE.Vector3((Math.random() - 0.5) * 1.5, 1, (Math.random() - 0.5) * 1.5)),
        spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 8),
        floor: hit !== null ? at.y - hit + 0.035 : this.player.position.y + 0.035,
        rest,
        landed: false,
      });
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
    for (const d of this.dropped) this.dropOne(d, dt);
  }

  private dropOne(d: Dropped, dt: number): void {
    if (d.landed) return;
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
    // (Not if a lull brought them back before the screen was due.)
    if (this.results || this.teamResults || this.phase !== 'dead') return;
    this.input.releaseLock();
    this.spectateLine.remove();
    const run = { survived: this.survivedAtDeath, total: this.me.diedAt, stats: { ...this.me.stats }, outbreak: this.outbreakAnnounced, hordes: this.hordesAtDeath };
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
    const back = alive.length ? ' THE NEXT DOWNTIME BRINGS YOU BACK.' : '';
    const sub = (alive.length === 1 ? `${alive[0].name.toUpperCase()} IS STILL FIGHTING.` : alive.length ? `${alive.length} SURVIVORS ARE STILL FIGHTING.` : 'THE NIGHT IS ENDING.') + back;
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
  /** Seconds spent dead before a lull brought this survivor back (not survived), and when they last fell. */
  private deadFor = 0;
  private diedPhaseTime = 0;
  /** Horde waves outlasted by then. */
  private hordesAtDeath = 0;

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
      this.hordeOverAt = this.sim.time;
      this.hordeOverWave = wave;
    }
  }

  /**
   * Downtime: the dead fall back for a minute or two. Announced when it starts (how long, and what
   * it is for), warned before it ends, and called when they are coming again.
   */
  private onLull(n: number, stage: 'start' | 'ending' | 'over', at: number, back: readonly string[]): void {
    const mine = back.includes(this.myId);
    if (!this.me.alive && !mine) return;
    const left = Math.max(0, at - this.sim.phaseTime);
    if (stage === 'start') {
      // Straight after a wave the two go together (the wave's chord has just played).
      const afterWave = this.sim.time - this.hordeOverAt < 1.5;
      const why = mine ? 'YOU ARE BACK · ' : afterWave ? `HORDE ${this.hordeOverWave} HELD OFF · ` : 'THE DEAD FALL BACK · ';
      const fallen = back.filter((id) => id !== this.myId).map((id) => this.sim.players.get(id)?.name.toUpperCase()).filter(Boolean);
      const rise = fallen.length === 1 ? ` · ${fallen[0]} IS BACK` : fallen.length ? ` · THE FALLEN ARE BACK` : '';
      this.hud.notify(`DOWNTIME · ${clock(Math.round(left))}`, `${why}REGROUP, GATHER AMMO, HEAL UP${rise}`, 5.5, 'calm');
      this.hud.feedLine(`Downtime: no zombies coming for ${clock(Math.round(left))}`);
      for (const name of fallen) this.hud.feedLine(`${name} IS BACK IN THE FIGHT`);
      if (!back.length && n === 1 && this.sim.players.size > 1) this.hud.feedLine('Every downtime brings back the fallen');
      audio.lullStart(afterWave);
    } else if (stage === 'ending') {
      this.hud.notify('DOWNTIME ENDING', `THE DEAD RETURN IN ${Math.round(left)} SECONDS · GET READY`, 3.4, 'danger');
      audio.lullEnding();
    } else {
      this.hud.notify('THEY ARE COMING BACK', 'DOWNTIME OVER', 2.2, 'danger');
    }
  }

  /**
   * A lull brought this survivor back: off the ground beside a teammate, full health and rearmed
   * (the server's numbers follow in the next snapshot), the results and spectating put away.
   */
  private onRespawn(pos: Vec3, yaw: number): void {
    if (this.phase !== 'dead') return;
    this.deadFor += Math.max(0, this.sim.phaseTime - this.diedPhaseTime);
    this.results?.dispose();
    this.results = null;
    this.spectateLine.remove();
    this.watching = null;
    this.ragdoll = null;
    for (const d of this.dropped) {
      d.model.dispose();
      d.model.root.removeFromParent();
    }
    this.dropped = [];
    // Online the snapshot says so too; until it comes, take the event's word for it.
    const me = this.me;
    if (!me.alive) {
      me.alive = true;
      me.health = PLAYER.maxHealth;
      me.downed = false;
    }
    this.player.respawn(pos, yaw);
    this.cam.yaw = yaw;
    this.cam.snapNext();
    this.weapon.setVisible(true);
    this.hud.setVisible(true);
    this.hurtFlash = 0;
    this.phase = 'playing';
    this.input.enabled = true;
    if (this.input.device === 'mouse') this.input.requestLock();
    this.promptClick();
    this.cam.addTrauma(0.1);
  }

  // ------------------------------------------------------------------ HUD

  private timerText(): string {
    const s = this.sim;
    if (s.phase === 'preparation') return `OUTBREAK IMMINENT — ${clock(Math.ceil(s.phaseTime))}`;
    const survived = `SURVIVED ${clock(s.phaseTime)}`;
    if (s.phase !== 'survival') return survived;
    const lull = lullLeft(s.lull, s.phaseTime);
    if (lull > 0) return `DOWNTIME — ${clock(Math.ceil(lull))} LEFT · ${survived}`;
    // The horde schedule runs on the threat clock (it stood still through the lulls).
    const t = s.threatTime;
    const w = hordeAt(t);
    if (w.stage === 'surge') return `HORDE ${w.wave} — HOLD OUT ${clock(Math.ceil(w.end - t))}`;
    return `${survived} · HORDE ${w.wave} IN ${clock(Math.ceil(w.start - t))}`;
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
      model: limb ? (LIMB_NAME[limb.cut]) : a.meleeOut ? WEAPONS[a.meleeId].model : def.model,
      mag: a.weapon.mag,
      magazine: def.magazine,
      reserve: a.weapon.reserve,
      mode: a.meleeOut && !limb ? 'MELEE' : def.mode,
      reload: a.action === 'reload' ? a.progress : null,
      slot: a.meleeOut ? 'melee' : a.active,
      meleeModel: WEAPONS[a.meleeId].model,
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
    const w = s.phase === 'survival' ? hordeAt(s.threatTime).stage : 'calm';
    const lull = s.phase === 'survival' ? lullLeft(s.lull, s.phaseTime) : 0;
    hud.setTimer(this.timerText(), (s.phase === 'preparation' && s.phaseTime <= 10) || (lull > 0 ? lull <= LULLS.warning : w !== 'calm'), lull > LULLS.warning);

    this.updateWaypoint();

    // Ammunition warning: the active gun is down to its last magazine in total.
    const total = (w: { mag: number; reserve: number }) => w.mag + w.reserve;
    const allEmpty = total(a.primary) === 0 && total(a.secondary) === 0;
    const critical = total(a.weapon) <= def.magazine && def.mode !== 'MELEE';
    // (Not while the hands are full of something else to fight with.)
    hud.setWarning(limb || a.meleeOut ? '' : allEmpty ? `OUT OF AMMUNITION · USE YOUR ${WEAPONS[a.meleeId].model}` : critical && me.alive ? 'AMMUNITION CRITICAL' : '');

    // Dynamic crosshair: gap follows the real spread cone (rolling on a skateboard is smooth).
    const hv = Math.hypot(p.velocity.x, p.velocity.z) * (p.ride ? SKATEBOARD.spreadSpeed : p.seated ? VEHICLE.spreadSpeed : p.pillion ? BICYCLE.spreadSpeed : 1);
    const spread = a.spread({ speed: hv, crouching: p.crouching, grounded: p.grounded, aiming: p.aiming });
    const cam = this.engine.camera;
    const px = (Math.tan((spread * Math.PI) / 180) / Math.tan((cam.fov * Math.PI) / 360)) * (window.innerHeight / 2);
    hud.setSpread(Math.min(70, px));
    // Down the sights, the sights are the crosshair. Not while the mouse is free either: "CLICK TO
    // CONTINUE" stands in the middle of the screen then, and the crosshair would strike through it.
    this.updateDownPanel();
    hud.setCrosshairVisible(this.phase === 'playing' && this.input.engaged && me.up && !p.sprinting && !p.cycle && a.action !== 'bandage' && this.cam.ads < 0.4 && !p.seated?.driver);
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
    /** Starts a downtime lull now (during the outbreak). */
    lull: () => (this.link ? (this.link.debug({ cmd: 'lull' }), true) : this.sim.startLull()),
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
    flashlight()?.placeRemotes([], this.engine.camera.position);
    audio.engines([]);
    this.vehicleView.reset();
    this.skates.dispose();
    this.bikes.dispose();
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
    if (sceneSmoke() === this.effects.smoke) setSceneSmoke(null);
    this.effects.dispose();
    this.throws.dispose();
    this.pyro.dispose();
    audio.fires([], 0);
    clearGibCache();
    this.rack?.dispose();
    this.weapon.dispose();
    clearSeveredCache();
    for (const d of this.dropped) {
      d.model.dispose();
      d.model.root.removeFromParent();
    }
    this.dropped = [];
    this.player.dispose();
    this.fill.removeFromParent();
    this.fill.dispose();
    this.engine.post.uniforms.uDamage.value = 0;
    audio.setVitals(0);
  }
}
