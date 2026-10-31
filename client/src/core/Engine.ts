import * as THREE from 'three';
import { PostFX } from '../rendering/PostFX';
import { settings, isPhone, type ShadowQuality } from './Settings';

export type FrameCallback = (dt: number, time: number) => void;

const SHADOW_SIZE: Record<ShadowQuality, number> = { off: 0, low: 1024, medium: 2048, high: 4096 };
/** Phones have 3x screens and small GPUs: cap the pixel ratio and let adaptive resolution go lower. */
const PHONE = isPhone();
const MAX_PIXEL_RATIO = PHONE ? 1.5 : 2;
const MIN_DYNAMIC_SCALE = PHONE ? 0.45 : 0.55;

/** Owns the WebGL renderer, the main camera, post-processing and the frame loop. */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly post: PostFX;
  private readonly callbacks = new Set<FrameCallback>();
  private readonly timer = new THREE.Timer();
  private running = false;
  private lastFrame = 0;
  private time = 0;
  private dynamicScale = 1;
  private fpsAccum = 0;
  private fpsFrames = 0;
  fps = 60;
  private lowFpsTime = 0;
  private highFpsTime = 0;
  private readonly unsub: () => void;
  onFps: ((fps: number) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.08, settings.value.graphics.renderDistance + 200);
    this.post = new PostFX(this.renderer, this.scene, this.camera, settings.value.graphics.antialias);

    window.addEventListener('resize', this.onResize);
    this.onResize();
    let prevAA = settings.value.graphics.antialias;
    this.unsub = settings.subscribe((s) => {
      this.onResize();
      this.post.bloom.enabled = s.graphics.bloom;
      this.post.uniforms.uGrain.value = s.graphics.filmGrain ? 0.045 : 0;
      this.camera.far = s.graphics.renderDistance + 200;
      this.camera.updateProjectionMatrix();
      if (s.graphics.antialias !== prevAA) {
        prevAA = s.graphics.antialias;
        this.post.setMsaa(prevAA);
        this.onResize();
      }
      document.documentElement.style.setProperty('--ui-scale', String(s.accessibility.uiScale));
    });
    this.post.bloom.enabled = settings.value.graphics.bloom;
    this.post.uniforms.uGrain.value = settings.value.graphics.filmGrain ? 0.045 : 0;
    document.documentElement.style.setProperty('--ui-scale', String(settings.value.accessibility.uiScale));
  }

  get shadowMapSize(): number {
    return SHADOW_SIZE[settings.value.graphics.shadows];
  }

  private onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const scale = settings.value.graphics.resolutionScale * this.dynamicScale;
    const pr = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO) * scale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.post.setSize(w, h, pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  add(cb: FrameCallback): () => void {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop(this.frame);
  }

  /** While true the loop keeps time but neither updates nor draws (a full-screen menu covers the view). */
  paused = false;
  /** Runs every frame while paused (the controller still drives the menu in front). */
  whilePaused: (() => void) | null = null;

  private frame = (now: number): void => {
    if (this.paused) {
      this.timer.update(now);
      this.lastFrame = now;
      this.whilePaused?.();
      return;
    }
    const limit = settings.value.graphics.fpsLimit;
    if (limit > 0 && now - this.lastFrame < 1000 / limit - 0.5) return;
    this.lastFrame = now;
    this.timer.update(now);
    const dt = Math.min(this.timer.getDelta(), 0.1);
    this.time += dt;
    for (const cb of this.callbacks) cb(dt, this.time);
    this.post.render(dt);
    this.trackPerformance(dt);
  };

  /** Adaptive resolution: drop render scale when sustained FPS is low, restore when there is headroom. */
  private trackPerformance(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum < 0.5) return;
    this.fps = this.fpsFrames / this.fpsAccum;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    this.onFps?.(this.fps);
    if (!settings.value.graphics.adaptiveResolution) {
      if (this.dynamicScale !== 1) {
        this.dynamicScale = 1;
        this.onResize();
      }
      return;
    }
    const limit = settings.value.graphics.fpsLimit || 60;
    const target = Math.min(limit, 60);
    if (this.fps < target * 0.75) {
      this.lowFpsTime += 0.5;
      this.highFpsTime = 0;
    } else if (this.fps > target * 0.95) {
      this.highFpsTime += 0.5;
      this.lowFpsTime = 0;
    }
    if (this.lowFpsTime >= 2 && this.dynamicScale > MIN_DYNAMIC_SCALE) {
      this.dynamicScale = Math.max(MIN_DYNAMIC_SCALE, this.dynamicScale - 0.1);
      this.lowFpsTime = 0;
      this.onResize();
    } else if (this.highFpsTime >= 6 && this.dynamicScale < 1) {
      this.dynamicScale = Math.min(1, this.dynamicScale + 0.05);
      this.highFpsTime = 0;
      this.onResize();
    }
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    this.unsub();
    this.post.dispose();
    this.renderer.dispose();
  }
}
