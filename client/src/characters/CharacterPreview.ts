import * as THREE from 'three';
import gsap from 'gsap';
import type { Appearance } from '@dead-hours/shared';
import { Humanoid, survivorLook } from './Humanoid';
import { SmokeWisps } from '../effects/Smoke';

export type PreviewFocus = 'body' | 'head' | 'hat' | 'torso' | 'legs' | 'feet' | 'hands' | 'back' | 'smoke';

const FRAMING: Record<PreviewFocus, { y: number; dist: number; side?: number }> = {
  body: { y: 0.9, dist: 4.1 },
  head: { y: 1.7, dist: 1.15 },
  hat: { y: 1.8, dist: 1.6 },
  torso: { y: 1.3, dist: 2.45 },
  legs: { y: 0.55, dist: 2.3 },
  feet: { y: 0.22, dist: 1.5 },
  hands: { y: 0.95, dist: 2.2 },
  back: { y: 1.25, dist: 2.2, side: Math.PI + 0.45 },
  // The face turned to show the smoke in profile, with room above for it to rise.
  smoke: { y: 1.74, dist: 1.55, side: 0.7 },
};

const IDLE = { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 };

/**
 * The character creator's dressing room: its own small renderer with studio lights, a
 * turntable the player drags, and camera framings per category (face, feet, back...).
 */
export class CharacterPreview {
  readonly canvas = document.createElement('canvas');
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 30);
  private readonly turntable = new THREE.Group();
  private body: Humanoid | null = null;
  private readonly frame = { y: FRAMING.body.y, dist: FRAMING.body.dist };
  private yaw = 0.35;
  private yawTarget = 0.35;
  private dragX: number | null = null;
  private raf = 0;
  private last = 0;
  private readonly resizeObs: ResizeObserver;
  private readonly disposables: { dispose(): void }[] = [];
  /** Smoke from a cigarette, joint or blunt, lit to suit the studio lights. */
  private readonly smoke = new SmokeWisps(90, new THREE.Color(0.62, 0.65, 0.72));

  constructor() {
    this.canvas.className = 'creator-canvas';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // A work light from the front left, cool moonlight rim from behind.
    this.scene.add(new THREE.HemisphereLight(0xb9c4d4, 0x2a231c, 1.1));
    const key = new THREE.DirectionalLight(0xffe6c8, 2.6);
    key.position.set(2.5, 4, 4.5);
    const rim = new THREE.DirectionalLight(0x8fb0ff, 1.6);
    rim.position.set(-3, 3, -4);
    const fill = new THREE.DirectionalLight(0xc8d4ff, 0.5);
    fill.position.set(-4, 1, 3);
    // Warm bounce off the floor, so the underside of the jaw doesn't read as stubble.
    const bounce = new THREE.DirectionalLight(0xffd8bc, 0.7);
    bounce.position.set(0.5, -1.2, 3);
    this.scene.add(key, rim, fill, bounce);

    // Floor disc with a soft contact shadow under the feet.
    const tex = this.shadowTexture();
    const floorMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
    const floorGeo = new THREE.PlaneGeometry(1.6, 1.6);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.045;
    this.scene.add(floor, this.turntable, this.smoke.mesh);
    this.disposables.push(tex, floorMat, floorGeo, this.smoke);

    this.canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.canvas);
  }

  private shadowTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(0.35, 'rgba(0,0,0,0.3)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Dresses the preview survivor (rebuilds the body; geometry is shared and cached). */
  setAppearance(a: Appearance): void {
    const prev = this.body;
    this.body = new Humanoid(survivorLook(a));
    this.body.smokeSink = this.smoke;
    this.body.update(1 / 60, IDLE);
    this.turntable.add(this.body.root);
    prev?.dispose();
  }

  /** Glides the camera to frame part of the body (and turns the survivor for the back). */
  focus(f: PreviewFocus): void {
    const t = FRAMING[f];
    gsap.to(this.frame, { y: t.y, dist: t.dist, duration: 0.7, ease: 'power3.inOut', overwrite: true });
    if (t.side !== undefined) this.yawTarget = this.nearest(t.side);
    else if (Math.cos(this.yawTarget) < 0.2) this.yawTarget = this.nearest(0.35);
  }

  /** Rotates by a step (buttons, keyboard). */
  turn(step: number): void {
    this.yawTarget += step;
  }

  private nearest(angle: number): number {
    const k = Math.round((this.yawTarget - angle) / (Math.PI * 2));
    return angle + k * Math.PI * 2;
  }

  start(): void {
    if (this.raf) return;
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.render(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private render(dt: number): void {
    this.yaw += (this.yawTarget - this.yaw) * (1 - Math.exp(-dt * 8));
    this.turntable.rotation.y = this.yaw;
    this.body?.update(dt, IDLE);
    const { y, dist } = this.frame;
    this.camera.position.set(0, y + dist * 0.08, dist);
    this.camera.lookAt(0, y, 0);
    this.smoke.update(dt, this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  private resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole body in view on tall, narrow layouts.
    this.camera.fov = w / h < 0.75 ? 38 : 30;
    this.camera.updateProjectionMatrix();
  }

  private onDown = (e: PointerEvent): void => {
    this.dragX = e.clientX;
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => {
    if (this.dragX === null) return;
    this.yawTarget += (e.clientX - this.dragX) * 0.012;
    this.dragX = e.clientX;
  };

  private onUp = (): void => {
    this.dragX = null;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const d = THREE.MathUtils.clamp(this.frame.dist * (1 + Math.sign(e.deltaY) * 0.12), 0.8, 4.2);
    gsap.to(this.frame, { dist: d, duration: 0.25, ease: 'power2.out', overwrite: 'auto' });
  };

  dispose(): void {
    this.stop();
    gsap.killTweensOf(this.frame);
    this.resizeObs.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.body?.dispose();
    this.body = null;
    for (const d of this.disposables) d.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
