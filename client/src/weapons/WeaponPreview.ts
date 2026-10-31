import * as THREE from 'three';
import type { WeaponBuild, WeaponId } from '@dead-hours/shared';
import { GunsmithStage, type Hotspot } from './GunsmithStage';

/**
 * The armory's turntable: its own small renderer with bench lights and a gun on show, framed to
 * fill the view, turned by dragging. Disposed with its WebGL context (like the creator's).
 */
export class WeaponPreview {
  readonly canvas = document.createElement('canvas');
  readonly stage = new GunsmithStage();
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.02, 20);
  private raf = 0;
  private last = 0;
  private dist = 2;
  private readonly resizeObs: ResizeObserver;
  /** Called every frame with the fittings' screen spots. */
  onFrame: ((spots: Hotspot[]) => void) | null = null;
  /** A click on the gun (not a drag): the nearest fitting, if one is close. */
  onPick: ((slot: Hotspot['slot']) => void) | null = null;

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // A shop lamp over the bench, a cool rim from behind, a soft fill.
    this.scene.add(new THREE.HemisphereLight(0xc4ccd8, 0x2a231c, 1.2));
    const key = new THREE.DirectionalLight(0xffe2c0, 3);
    key.position.set(1.5, 4, 3);
    const rim = new THREE.DirectionalLight(0x8fb0ff, 2);
    rim.position.set(-2, 2, -3);
    const fill = new THREE.DirectionalLight(0xd0d8ff, 0.6);
    fill.position.set(-3, -1, 2);
    this.scene.add(key, rim, fill, this.stage.holder);
    this.canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(this.canvas);
  }

  show(id: WeaponId, build: WeaponBuild): void {
    this.stage.show(id, build);
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

  private render(dt: number): void {
    this.stage.update(dt);
    // Frame the gun's length across the view (a pistol comes closer than a rifle).
    const fit = this.stage.radius / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / Math.min(1.6, this.camera.aspect) * 1.25;
    this.dist += (Math.max(0.5, fit) - this.dist) * (1 - Math.exp(-dt * 6));
    this.camera.position.set(0, this.dist * 0.12, this.dist);
    this.camera.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.camera);
    this.onFrame?.(this.stage.hotspots(this.camera, this.canvas.clientWidth, this.canvas.clientHeight));
  }

  private resize(): void {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private onDown = (e: PointerEvent): void => {
    this.stage.pointerDown(e);
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent): void => this.stage.pointerMove(e);

  private onUp = (e: PointerEvent): void => {
    if (this.stage.pointerUp() || e.target !== this.canvas) return;
    // A click near a fitting selects it.
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best: Hotspot | null = null;
    let bestD = 70;
    for (const s of this.stage.hotspots(this.camera, r.width, r.height)) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (s.visible && d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) this.onPick?.(best.slot);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObs.disconnect();
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.stage.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}
