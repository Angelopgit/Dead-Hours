import * as THREE from 'three';
import gsap from 'gsap';
import { NEIGHBORHOOD, type BeginMsg, type NavGrid } from '@dead-hours/shared';
import { Engine } from './Engine';
import { Input } from './Input';
import { Physics, initPhysics } from './Physics';
import { loadNavGrid } from './NavLoader';
import { settings } from './Settings';
import { Neighborhood } from '../environment/Neighborhood';
import { DoorSystem } from '../gameplay/Doors';
import { MenuCinematic } from '../gameplay/MenuCinematic';
import { VehicleView } from '../gameplay/VehicleView';
import { GameSession } from '../gameplay/GameSession';
import type { NetLink } from '../network/NetLink';
import { MainMenu } from '../ui/MainMenu';
import { audio } from '../audio/AudioEngine';
import { AutoExposure } from '../lighting/Probes';
import type { LightField } from '../lighting/LightField';
import { Flashlight, setFlashlight } from '../gameplay/Flashlight';
import { setSnowing, weather } from '../environment/Weather';
import { HOLIDAY } from './Holiday';
import { weatherUniforms } from '../lighting/WetShader';
import { LoadingScreen } from '../ui/LoadingScreen';
import { compileForPost, compileScene, nextFrame, pinPrograms, uploadTextures } from './Preload';

type State = 'menu' | 'session';

/** The loading screen's line for an online night: the room's name. */
function lobbyCaption(link: NetLink): string {
  const name = link.lobby?.name;
  return name ? `ONLINE · ${name.toUpperCase()}` : 'ONLINE';
}

/** Top-level orchestrator: boots the world once and switches between menu and play sessions. */
export class Game {
  private engine!: Engine;
  private input!: Input;
  private physics!: Physics;
  private world!: Neighborhood;
  private doors!: DoorSystem;
  private menuCine!: MenuCinematic;
  private menu!: MainMenu;
  private session: GameSession | null = null;
  /** The online room the current session is played in. */
  private link: NetLink | null = null;
  private state: State = 'menu';
  /** The night being got ready behind the loading screen (cleared to abandon it). */
  private launching: object | null = null;
  private emittersAdded = false;
  private field!: LightField;
  private exposure!: AutoExposure;
  private nav!: NavGrid;
  private flashlight!: Flashlight;
  /** Every drivable vehicle as drawn (parked in the menu, wherever the night takes them). */
  private vehicles!: VehicleView;
  private readonly ui = document.getElementById('ui-root')!;

  async boot(): Promise<void> {
    const canvas = document.getElementById('viewport') as HTMLCanvasElement;
    await initPhysics();
    this.engine = new Engine(canvas);
    this.input = new Input(canvas);
    this.physics = new Physics(NEIGHBORHOOD);
    this.world = new Neighborhood(NEIGHBORHOOD, this.engine.scene, this.engine.renderer.capabilities.getMaxAnisotropy());
    this.world.lighting.onThunder = (delay, power) => audio.thunder(delay, power);
    // Compressed PBR texture sets stream in while the lighting bakes.
    const pbr = this.world.lib.loadPbr(this.engine.renderer, settings.value.graphics.textureQuality);
    const label = document.querySelector('.boot');
    let lastLabel = '';
    this.field = await this.world.bakeLighting((f, text) => {
      const next = `${text} ${Math.round(f * 100)}%`;
      if (label && next !== lastLabel) label.textContent = lastLabel = next;
    });
    // The vehicles' own meshes and probes (before the environment map is handed out: their paint reflects it).
    this.vehicles = new VehicleView(this.engine.scene, this.world.props.vehicles, this.field);
    this.world.buildEnvironment(this.engine.renderer);
    this.exposure = new AutoExposure(this.field);
    this.doors = new DoorSystem(NEIGHBORHOOD, this.physics, this.world.root);
    this.doors.applyProbes(this.field);
    // Zombie navigation is built from the same collision (cached between visits).
    this.nav = await loadNavGrid(this.physics, NEIGHBORHOOD, (f) => {
      const next = `MAPPING STREETS ${Math.round(f * 100)}%`;
      if (label && next !== lastLabel) label.textContent = lastLabel = next;
    });
    // In the scene from the start (at zero), so turning it on never recompiles materials.
    this.flashlight = new Flashlight(this.engine.scene, this.physics);
    setFlashlight(this.flashlight);
    this.menuCine = new MenuCinematic(this.engine.camera, this.engine.scene);
    this.menuCine.applyProbe(this.field);
    this.applyRenderSettings();
    settings.subscribe(() => this.applyRenderSettings());

    window.addEventListener('pointerdown', this.unlockAudio);
    window.addEventListener('keydown', this.unlockAudio);

    this.menu = new MainMenu(this.input, {
      onSolo: () => void this.startSolo(),
      onBegin: (link, begin) => void this.startOnline(link, begin),
      onCreator: (open) => { this.engine.paused = open; },
    });
    this.engine.add((dt, t) => this.update(dt, t));
    this.engine.whilePaused = () => {
      this.input.poll(1 / 60);
      this.input.endFrame();
    };
    await pbr;
    this.menuSnow(true, true);
    // Warm up shader compilation before the first visible frame.
    this.menuCine.update(0.016);
    compileForPost(this.engine.renderer, this.engine.scene, this.engine.camera);
    // The menu's shaders stay compiled for coming back to it after a night.
    pinPrograms(this.engine.renderer);
    this.engine.start();
    document.querySelector('.boot')?.remove();
    gsap.to(document.getElementById('fade'), { opacity: 0, duration: 2.2, ease: 'power2.out' });
    this.menu.show(this.ui);
    if (import.meta.env.DEV) Object.assign(window, { __deadHours: this, THREE, __weather: weather, __wet: weatherUniforms });
  }

  /** Holiday season: snow over the menu's street instead of rain (and no lightning); the nights stay as they are. */
  private menuSnow(on: boolean, instant: boolean): void {
    const snow = this.world.snow;
    if (!HOLIDAY || !snow) return;
    snow.set(on, instant);
    this.world.lighting.calm = on;
    setSnowing(on, instant);
  }

  private unlockAudio = (): void => {
    audio.unlock();
    if (!this.emittersAdded && audio.ctx) {
      this.emittersAdded = true;
      for (const a of this.world.props.anchors) audio.addEmitter(a.kind, a.position, a.level);
    }
  };

  private lastShadowSize = -1;
  private lastParticle = '';
  private lastFog = '';
  private lastTex = '';
  private applyRenderSettings(): void {
    const g = settings.value.graphics;
    const focus = this.session?.focus ?? this.menuCine.focus;
    const key = `${g.particleQuality}|${g.rain}`;
    if (this.engine.shadowMapSize !== this.lastShadowSize || key !== this.lastParticle || g.fogQuality !== this.lastFog || g.textureQuality !== this.lastTex) {
      this.lastShadowSize = this.engine.shadowMapSize;
      this.lastParticle = key;
      this.lastFog = g.fogQuality;
      this.lastTex = g.textureQuality;
      this.flashlight.setShadows(g.shadows);
      this.world.applySettings(this.engine.renderer, this.engine.shadowMapSize, focus);
    }
  }

  async startSolo(): Promise<void> {
    if (this.state !== 'menu') return;
    this.state = 'session';
    const fade = document.getElementById('fade')!;
    await Promise.all([
      this.menu.hide(),
      new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.8, onComplete: () => r() })),
    ]);
    const pose = this.menuCine.pose();
    this.menuCine.setActive(false);
    this.menuSnow(false, true);
    await this.launched(await this.launch(() => this.createSession(pose, false), 'SOLO'));
  }

  /**
   * Gets a night ready behind a loading screen before showing it, so nothing loads mid-fight:
   * every sound rendered and decoded, the night's scene built, a zombie body of every look made,
   * every shader the night can need compiled (one of everything it can show stands in front of
   * the camera meanwhile), every texture on the GPU, and the result kept for later nights. The
   * page keeps breathing throughout (online, the room's pings are answered), and online the
   * server only streams the night once it has drawn its first frames after this.
   * 'stopped': abandoned on the way (left, disconnected); 'failed': the night could not be built.
   */
  private async launch(make: () => GameSession, caption: string): Promise<'ready' | 'stopped' | 'failed'> {
    const token = {};
    this.launching = token;
    const stop = () => this.launching !== token;
    const screen = new LoadingScreen(caption);
    screen.show();
    // Nothing draws while shaders compile behind the screen (a draw would wait on them).
    this.engine.paused = true;
    // Whatever the menu has compiled since boot stays for coming back to it.
    pinPrograms(this.engine.renderer);
    let session: GameSession | null = null;
    try {
      // Normally running since the first click; if not, it starts (suspended) so it can decode.
      this.unlockAudio();
      await audio.prepare((f) => screen.step('sounds', f));
      if (stop()) return 'stopped';
      screen.step('night', 0);
      await nextFrame();
      if (stop()) return 'stopped';
      session = make();
      screen.step('night', 1);
      try {
        await this.warm(session, screen, stop);
      } catch (e) {
        // Not fatal: the night still plays, compiling what is missing as it first shows up.
        console.warn('could not finish getting the night ready', e);
      }
      if (stop()) return 'stopped';
      screen.step('ready', 1);
      this.session = session;
      session = null;
      this.session.start();
      return 'ready';
    } catch (e) {
      console.error('could not build the night', e);
      return 'failed';
    } finally {
      session?.dispose();
      if (this.launching === token) this.launching = null;
      this.engine.paused = false;
      screen.hide();
    }
  }

  /** The shaders, bodies and textures part of `launch`. */
  private async warm(session: GameSession, screen: LoadingScreen, stop: () => boolean): Promise<void> {
    const putAway = session.prewarm();
    try {
      if (stop()) return;
      const r = this.engine.renderer;
      await compileScene(r, this.engine.scene, this.engine.camera, this.engine.scene, (f) => screen.step('shaders', f), stop);
      if (stop()) return;
      await uploadTextures(r, this.engine.scene, (f) => screen.step('textures', f), stop);
      if (stop()) return;
      // Two real frames with everything in view: shadow passes, post-processing, the last uploads.
      for (let i = 0; i < 2; i++) {
        this.engine.post.render(1 / 60);
        await nextFrame();
      }
      pinPrograms(r);
    } finally {
      putAway();
    }
  }

  /** After `launch`: back to the menu unless the night is on (saying so if it failed to load). */
  private async launched(result: 'ready' | 'stopped' | 'failed', link: NetLink | null = null): Promise<void> {
    if (result === 'ready' || this.link !== link) return;
    await this.quitToMenu();
    if (result === 'failed') this.menu.notice('THE NIGHT FAILED TO LOAD');
  }

  private createSession(pose: { position: THREE.Vector3; target: THREE.Vector3 }, skipIntro: boolean, online?: { link: NetLink; begin: BeginMsg }): GameSession {
    return new GameSession(
      this.engine, this.input, this.physics, this.doors, this.vehicles, this.field, this.nav, this.ui,
      () => void this.quitToMenu(), () => void this.retry(), pose,
      { skipIntro, online, onLobby: online ? () => void this.backToLobby() : undefined },
    );
  }

  /** The host started the night: into the game with everyone in the room. */
  async startOnline(link: NetLink, begin: BeginMsg): Promise<void> {
    if (this.state !== 'menu') return;
    this.state = 'session';
    this.link = link;
    link.handlers = {
      over: (o) => this.session?.showTeam(o),
      // The host started another night while this survivor was still on the results.
      begin: (b) => void this.restartOnline(link, b),
      reconnecting: (on) => this.session?.setReconnecting(on),
      closed: () => void this.connectionLost(link),
    };
    const fade = document.getElementById('fade')!;
    await Promise.all([
      this.menu.hide(),
      new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.6, onComplete: () => r() })),
    ]);
    this.menuCine.setActive(false);
    this.menuSnow(false, true);
    if (this.link !== link || !link.open) {
      await this.quitToMenu();
      return;
    }
    await this.launched(await this.launch(() => this.createSession(this.menuCine.pose(), true, { link, begin }), lobbyCaption(link)), link);
  }

  private async restartOnline(link: NetLink, begin: BeginMsg): Promise<void> {
    if (this.link !== link || !this.session) return;
    const fade = document.getElementById('fade')!;
    await new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.4, onComplete: () => r() }));
    if (this.link !== link || this.launching) return;
    this.session?.dispose();
    this.session = null;
    await this.launched(await this.launch(() => this.createSession(this.menuCine.pose(), true, { link, begin }), lobbyCaption(link)), link);
  }

  /** After the night: back to the room's lobby (still connected) for the next one. */
  private async backToLobby(): Promise<void> {
    const link = this.link;
    if (!link) return;
    link.stopPlaying();
    this.link = null;
    await this.quitToMenu();
    if (link.open) this.menu.openLobby(link);
  }

  private async connectionLost(link: NetLink): Promise<void> {
    if (this.link !== link) return;
    this.link = null;
    await this.quitToMenu();
    this.menu.notice('CONNECTION TO THE GAME WAS LOST');
  }

  /** Results → RETRY: a fresh run from the safehouse, straight into play. */
  private async retry(): Promise<void> {
    if (this.state !== 'session' || !this.session) return;
    const fade = document.getElementById('fade')!;
    await new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.6, onComplete: () => r() }));
    const pose = this.menuCine.pose();
    this.session.dispose();
    this.session = null;
    await this.launched(await this.launch(() => this.createSession(pose, true), 'SOLO'));
  }

  private async quitToMenu(): Promise<void> {
    // Leaving a game in progress leaves its room (and stops getting it ready).
    this.launching = null;
    this.link?.leave();
    this.link = null;
    const fade = document.getElementById('fade')!;
    await new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.6, onComplete: () => r() }));
    this.session?.dispose();
    this.session = null;
    this.doors.reset();
    this.state = 'menu';
    this.menuSnow(true, true);
    this.menu.show(this.ui);
    gsap.to(fade, { opacity: 0, duration: 1.4 });
  }

  private readonly tmpFocus = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private update(dt: number, t: number): void {
    this.input.poll(dt);
    if (this.state === 'menu' || !this.session) {
      this.input.uiNav = true;
      this.menuCine.update(dt);
      this.doors.update(dt, this.engine.camera);
      this.vehicles.update(dt, this.engine.camera, null, null);
      this.flashlight.update(dt, false, this.engine.camera.position, this.tmpDir.set(0, 0, -1));
      this.tmpFocus.copy(this.menuCine.focus);
    } else {
      this.session.update(dt);
      this.tmpFocus.copy(this.session.focus);
    }
    this.world.update(dt, t, this.engine.camera, this.tmpFocus);
    // Volumetric fog: the brightest lights near the camera, at the flat fog's density (a little
    // thicker in rain), drifting with the wind.
    const fx = this.engine.post.scene;
    if (fx.fogOn && this.world.fogLights) {
      this.world.fogLights.update(dt, this.engine.scene, this.engine.camera.position, fx.lights, fx.fogLamps);
      fx.fogDensity = this.world.fogDensity * (1 + weather.rain * 0.35);
      fx.time = t;
      fx.cover = weatherUniforms.uCover.value;
      fx.coverRect.copy(weatherUniforms.uCoverRect.value);
      fx.wind.copy(this.world.atmosphere.wind).multiplyScalar(this.world.atmosphere.windStrength);
    }
    this.engine.renderer.toneMappingExposure = 1.45 * this.exposure.update(dt, this.engine.camera);
    audio.update(dt, this.engine.camera);
    this.input.endFrame();
  }
}
