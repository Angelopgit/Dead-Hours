import * as THREE from 'three';
import gsap from 'gsap';
import { NEIGHBORHOOD } from '@dead-hours/shared';
import { Engine } from './Engine';
import { Input } from './Input';
import { Physics, initPhysics } from './Physics';
import { settings } from './Settings';
import { Neighborhood } from '../environment/Neighborhood';
import { DoorSystem } from '../gameplay/Doors';
import { MenuCinematic } from '../gameplay/MenuCinematic';
import { SoloSession } from '../gameplay/SoloSession';
import { MainMenu } from '../ui/MainMenu';
import { audio } from '../audio/AudioEngine';

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
  private session: SoloSession | null = null;
  private state: State = 'menu';
  private emittersAdded = false;
  private readonly ui = document.getElementById('ui-root')!;

  async boot(): Promise<void> {
    const canvas = document.getElementById('viewport') as HTMLCanvasElement;
    await initPhysics();
    this.engine = new Engine(canvas);
    this.input = new Input(canvas);
    this.physics = new Physics(NEIGHBORHOOD);
    this.world = new Neighborhood(NEIGHBORHOOD, this.engine.scene, this.engine.renderer.capabilities.getMaxAnisotropy());
    this.world.lighting.onThunder = (delay, power) => audio.thunder(delay, power);
    this.doors = new DoorSystem(NEIGHBORHOOD, this.physics, this.world.lib, this.world.root);
    this.menuCine = new MenuCinematic(this.engine.camera, this.engine.scene);
    this.applyRenderSettings();
    settings.subscribe(() => this.applyRenderSettings());

    window.addEventListener('pointerdown', this.unlockAudio);
    window.addEventListener('keydown', this.unlockAudio);

    this.menu = new MainMenu(this.input, { onSolo: () => void this.startSolo() });
    this.engine.add((dt, t) => this.update(dt, t));
    // Warm up shader compilation before the first visible frame.
    this.menuCine.update(0.016);
    this.engine.renderer.compile(this.engine.scene, this.engine.camera);
    this.engine.start();
    document.querySelector('.boot')?.remove();
    gsap.to(document.getElementById('fade'), { opacity: 0, duration: 2.2, ease: 'power2.out' });
    this.menu.show(this.ui);
    if (import.meta.env.DEV) Object.assign(window, { __deadHours: this, THREE });
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
    const key = `${g.particleQuality}`;
    if (this.engine.shadowMapSize !== this.lastShadowSize || key !== this.lastParticle || g.fogQuality !== this.lastFog || g.textureQuality !== this.lastTex) {
      this.lastShadowSize = this.engine.shadowMapSize;
      this.lastParticle = key;
      this.lastFog = g.fogQuality;
      this.lastTex = g.textureQuality;
      this.world.applySettings(this.engine.renderer, this.engine.shadowMapSize, focus);
    }
  }

  private async startSolo(): Promise<void> {
    if (this.state !== 'menu') return;
    this.state = 'session';
    const fade = document.getElementById('fade')!;
    await Promise.all([
      this.menu.hide(),
      new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.8, onComplete: () => r() })),
    ]);
    const pose = this.menuCine.pose();
    this.menuCine.setActive(false);
    this.session = new SoloSession(this.engine, this.input, this.physics, this.doors, this.ui, () => void this.quitToMenu(), pose);
  }

  private async quitToMenu(): Promise<void> {
    const fade = document.getElementById('fade')!;
    await new Promise<void>((r) => gsap.to(fade, { opacity: 1, duration: 0.6, onComplete: () => r() }));
    this.session?.dispose();
    this.session = null;
    this.state = 'menu';
    this.menu.show(this.ui);
    gsap.to(fade, { opacity: 0, duration: 1.4 });
  }

  private readonly tmpFocus = new THREE.Vector3();
  private update(dt: number, t: number): void {
    if (this.state === 'menu' || !this.session) {
      this.menuCine.update(dt);
      this.doors.update(dt);
      this.tmpFocus.copy(this.menuCine.focus);
    } else {
      this.session.update(dt);
      this.tmpFocus.copy(this.session.focus);
    }
    this.world.update(dt, t, this.engine.camera, this.tmpFocus);
    audio.update(dt, this.engine.camera);
    this.input.endFrame();
  }
}
