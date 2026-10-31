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
import { GameSession } from '../gameplay/GameSession';
import type { NetLink } from '../network/NetLink';
import { MainMenu } from '../ui/MainMenu';
import { audio } from '../audio/AudioEngine';
import { AutoExposure } from '../lighting/Probes';
import type { LightField } from '../lighting/LightField';
import { Flashlight, setFlashlight } from '../gameplay/Flashlight';
import { weather } from '../environment/Weather';
import { weatherUniforms } from '../lighting/WetShader';

type State = 'menu' | 'session';

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
  private emittersAdded = false;
  private field!: LightField;
  private exposure!: AutoExposure;
  private nav!: NavGrid;
  private flashlight!: Flashlight;
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
    this.flashlight = new Flashlight(this.engine.scene);
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
    // Warm up shader compilation before the first visible frame.
    this.menuCine.update(0.016);
    this.engine.renderer.compile(this.engine.scene, this.engine.camera);
    this.engine.start();
    document.querySelector('.boot')?.remove();
    gsap.to(document.getElementById('fade'), { opacity: 0, duration: 2.2, ease: 'power2.out' });
    this.menu.show(this.ui);
    if (import.meta.env.DEV) Object.assign(window, { __deadHours: this, THREE, __weather: weather, __wet: weatherUniforms });
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
    this.session = this.createSession(pose, false);
  }

  private createSession(pose: { position: THREE.Vector3; target: THREE.Vector3 }, skipIntro: boolean, online?: { link: NetLink; begin: BeginMsg }): GameSession {
    return new GameSession(
      this.engine, this.input, this.physics, this.doors, this.field, this.nav, this.ui,
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
    if (this.link !== link || !link.open) {
      await this.quitToMenu();
      return;
    }
    this.session = this.createSession(this.menuCine.pose(), true, { link, begin });
  }

  private async restartOnline(link: NetLink, begin: BeginMsg): Promise<void> {
    if (this.link !== link || !this.session) return;
    const fade = document.getElementById('fade')!;
    await new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.4, onComplete: () => r() }));
    this.session?.dispose();
    this.session = this.createSession(this.menuCine.pose(), true, { link, begin });
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
    this.session = this.createSession(pose, true);
  }

  private async quitToMenu(): Promise<void> {
    // Leaving a game in progress leaves its room.
    this.link?.leave();
    this.link = null;
    const fade = document.getElementById('fade')!;
    await new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.6, onComplete: () => r() }));
    this.session?.dispose();
    this.session = null;
    this.doors.reset();
    this.state = 'menu';
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
      this.world.fogLights.update(dt, this.engine.scene, this.engine.camera.position, fx.lights, 12);
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
