import * as THREE from 'three';
import gsap from 'gsap';
import { NEIGHBORHOOD, PLAYER, STORY, type MapDefinition } from '@dead-hours/shared';
import type { Engine } from '../core/Engine';
import type { Input } from '../core/Input';
import type { Physics } from '../core/Physics';
import { settings } from '../core/Settings';
import { PlayerController } from './PlayerController';
import { ThirdPersonCamera } from './ThirdPersonCamera';
import type { DoorSystem } from './Doors';
import { SURVIVOR_LOOKS } from '../characters/Humanoid';
import { HUD } from '../ui/HUD';
import { PauseMenu } from '../ui/PauseMenu';
import { audio } from '../audio/AudioEngine';
import { h } from '../ui/dom';

type Phase = 'intro' | 'playing' | 'paused';

function insideHouse(map: MapDefinition, p: THREE.Vector3): string | null {
  for (const hs of map.houses) {
    if (!hs.enterable) continue;
    if (Math.abs(p.x - hs.x) < hs.w / 2 - 0.1 && Math.abs(p.z - hs.z) < hs.d / 2 - 0.1 && p.y < STORY.slab + STORY.ground) return hs.id;
  }
  return null;
}

/**
 * A local play session: one player in the neighborhood. The multiplayer room in Phase 4
 * reuses PlayerController as the predicted local player and adds remote players.
 */
export class SoloSession {
  readonly player: PlayerController;
  readonly cam: ThirdPersonCamera;
  private readonly hud: HUD;
  private readonly pause: PauseMenu;
  private phase: Phase = 'intro';
  private accumulator = 0;
  private intro: gsap.core.Timeline | null = null;
  private readonly introCam = { px: 0, py: 0, pz: 0, tx: 0, ty: 0, tz: 0 };
  private readonly letterbox: HTMLElement[];
  private readonly skip: HTMLElement;
  private readonly clickToPlay: HTMLElement;
  private wasInside: string | null = null;
  readonly focus = new THREE.Vector3();
  private readonly abort = new AbortController();
  private readonly fill = new THREE.PointLight(0xa8b8d0, 1.6, 9, 1.5);

  constructor(
    private readonly engine: Engine,
    private readonly input: Input,
    private readonly physics: Physics,
    private readonly doors: DoorSystem,
    private readonly ui: HTMLElement,
    private readonly onQuit: () => void,
    startPose: { position: THREE.Vector3; target: THREE.Vector3 },
  ) {
    const spawn = NEIGHBORHOOD.playerSpawns[0];
    this.player = new PlayerController(physics, spawn, SURVIVOR_LOOKS[0]);
    engine.scene.add(this.player.character.root);
    this.player.character.onFootstep = (l) => audio.footstep(l, insideHouse(NEIGHBORHOOD, this.player.position) !== null);
    this.cam = new ThirdPersonCamera(engine.camera, physics);
    this.cam.yaw = spawn.yaw;
    this.focus.copy(this.player.position);
    this.wasInside = insideHouse(NEIGHBORHOOD, this.player.position);
    // Soft fill that travels with the camera so the survivor stays readable at night.
    this.fill.position.set(0, 0.4, 0.6);
    engine.camera.add(this.fill);
    if (!engine.camera.parent) engine.scene.add(engine.camera);

    this.hud = new HUD(settings.value.profile.name);
    this.hud.el.style.opacity = '0';
    ui.append(this.hud.el);
    this.pause = new PauseMenu(input, () => this.resume(), () => this.quit());

    this.letterbox = [h('div', { class: 'letterbox top' }), h('div', { class: 'letterbox bottom' })];
    this.skip = h('div', { class: 'skip' }, 'PRESS ANY KEY TO SKIP');
    this.clickToPlay = h('div', { class: 'click-to-play' }, 'CLICK TO CONTINUE');
    const sig = { signal: this.abort.signal };
    document.addEventListener('pointerlockchange', this.onLockChange, sig);
    window.addEventListener('keydown', this.onKeyDown, sig);
    engine.canvas.addEventListener('click', () => {
      if (this.phase === 'playing' && !input.locked) input.requestLock();
    }, sig);
    this.runIntro(startPose);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.phase === 'intro') {
      this.finishIntro();
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

  private finishIntro(): void {
    if (this.phase !== 'intro') return;
    this.intro?.kill();
    this.intro = null;
    gsap.to(document.getElementById('fade'), { opacity: 0, duration: 0.5 });
    for (const el of [...this.letterbox, this.skip]) el.remove();
    this.phase = 'playing';
    this.cam.snapNext();
    this.hud.setVisible(true);
    this.hud.notify('MAPLE HOLLOW', 'THE SAFEHOUSE · 21:47', 3.2);
    this.input.enabled = true;
    this.input.requestLock();
    // If the browser refused pointer lock (no gesture), wait for a click.
    setTimeout(() => {
      if (this.phase === 'playing' && !this.input.locked) this.ui.append(this.clickToPlay);
    }, 250);
  }

  private openPause(): void {
    this.phase = 'paused';
    this.input.clear();
    this.player.clearInput();
    this.pause.show(this.ui);
  }

  private resume(): void {
    this.pause.hide();
    this.phase = 'playing';
    this.input.requestLock();
    setTimeout(() => {
      if (this.phase === 'playing' && !this.input.locked) this.ui.append(this.clickToPlay);
    }, 250);
  }

  private quit(): void {
    this.pause.hide();
    this.onQuit();
  }

  update(dt: number): void {
    const p = this.player;
    if (this.phase === 'intro') {
      const c = this.introCam;
      this.engine.camera.position.set(c.px, c.py, c.pz);
      this.engine.camera.lookAt(c.tx, c.ty, c.tz);
      p.render(dt, 1);
      this.focus.set(c.tx, 0, c.tz);
      return;
    }

    if (this.phase === 'playing') {
      this.cam.look(this.input);
      p.sampleInput(this.input, this.cam.yaw);
      this.handleInteraction();
    }

    // Fixed-step simulation, rendered with interpolation.
    const step = this.physics.fixedDt;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= step && steps < 5) {
      if (this.phase !== 'paused') p.fixedUpdate(step, this.cam.yaw);
      this.doors.update(step);
      this.physics.step();
      this.accumulator -= step;
      steps++;
    }
    if (steps === 5) this.accumulator = 0;
    const alpha = this.accumulator / step;
    p.render(dt, alpha);
    if (p.landed) {
      p.landed = false;
      this.cam.addTrauma(0.12);
      audio.footstep(0.8, insideHouse(NEIGHBORHOOD, p.position) !== null);
    }

    this.cam.update(dt, p.renderPosition, p.eyeHeight, p.aiming, p.sprinting);
    this.focus.copy(p.renderPosition);

    const hv = Math.hypot(p.velocity.x, p.velocity.z);
    this.hud.setSpread(p.aiming ? 0 : Math.min(14, hv * 2 + (p.grounded ? 0 : 8)));
    this.hud.setStance(p.crouching ? 'CROUCHED' : p.sprinting ? 'SPRINTING' : '');
    this.hud.setHealth(p.health, PLAYER.maxHealth);
    this.hud.setFps(this.engine.fps);

    const inside = insideHouse(NEIGHBORHOOD, p.position);
    if (inside !== this.wasInside) {
      if (inside === 'safehouse' && this.wasInside === null && this.phase === 'playing') this.hud.notify('SAFEHOUSE', '', 1.2);
      this.wasInside = inside;
    }
  }

  private handleInteraction(): void {
    const p = this.player;
    const probe = p.position.clone().setY(p.position.y + 1.1);
    const door = this.doors.nearest(probe, 1.9);
    if (door) {
      this.hud.setPrompt('interact', door.open ? 'CLOSE DOOR' : 'OPEN DOOR');
      if (this.input.pressed('interact')) {
        door.toggle(p.position);
        audio.door(door.open);
      }
    } else {
      this.hud.setPrompt(null);
    }
  }

  dispose(): void {
    this.abort.abort();
    this.intro?.kill();
    for (const el of [...this.letterbox, this.skip, this.clickToPlay]) el.remove();
    this.input.enabled = false;
    this.input.releaseLock();
    this.input.clear();
    this.hud.dispose();
    this.pause.hide();
    this.player.dispose();
    this.fill.removeFromParent();
    this.fill.dispose();
  }
}
