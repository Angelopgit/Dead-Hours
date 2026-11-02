import * as THREE from 'three';
import { glareUniforms } from '../environment/LampGlare';

type ShadowLight = THREE.Light & { shadow: THREE.LightShadow };

/**
 * A mirror for water lying on the ground (puddles): the scene drawn once more, from the camera
 * reflected in the horizontal plane y = `height`, into a texture the water samples at the point it
 * shades. Everything on that plane shares the one image.
 *
 * It only costs what the puddles on screen need. Nothing is drawn while none is near and in view.
 * Otherwise the reflected view is cropped to the part of the screen they cover (a few percent of it
 * on a street, more when one is at the survivor's feet), so the frustum culls everything they
 * can't show and the texture is only that rectangle, at a fraction of the screen's resolution and
 * capped in pixels. An oblique near plane on the mirror (Lengyel) drops what lies under the water,
 * without clipping planes, so every material keeps the program it has in the main view: the mirror
 * draws into a half-float target like the main view, compiles nothing new and needs no preloading.
 */
export class PlanarMirror {
  readonly camera = new THREE.PerspectiveCamera();
  /** Shared by every material that reflects the mirror. */
  readonly uniforms = {
    uMirror: { value: null as THREE.Texture | null },
    /** World → mirror texture coordinates (homogeneous), cropped rectangle included. */
    uMirrorMatrix: { value: new THREE.Matrix4() },
    /** Texel bounds of this frame's rectangle: min uv (xy), max uv (zw), for clamping ripple offsets. */
    uMirrorClamp: { value: new THREE.Vector4(0, 0, 1, 1) },
    /** 1 when this frame's image is valid. */
    uMirrorOn: { value: 0 },
  };
  /** Objects left out of the reflection (the water itself, rain streaks, particles...). */
  readonly hidden: THREE.Object3D[] = [];
  /** Fraction of the screen's resolution the mirror draws at (0 = off). */
  scale = 0;
  /** Most pixels one mirror image may hold. */
  maxPixels = 640 * 360;
  /** Reflections end here (metres along the reflected ray): fog has swallowed the rest. */
  far = 70;
  private target: THREE.WebGLRenderTarget | null = null;
  private readonly plane = new THREE.Plane();
  private readonly clip = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly v = new THREE.Vector3();
  private readonly look = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly crop = new THREE.Matrix4();
  private readonly bias = new THREE.Matrix4();
  private readonly saved: boolean[] = [];
  private readonly shadowLights: ShadowLight[] = [];
  private lightScan = 0;
  /** Draws this frame (for measuring). */
  drawn = false;

  constructor(readonly height: number) {
    this.camera.matrixAutoUpdate = true;
  }

  /**
   * Draws the reflection for `camera`, cropped to `rect` (NDC x0, y0, x1, y1 of the screen area to
   * cover), or turns the mirror off for this frame when `rect` is null.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, rect: THREE.Vector4 | null, screen: THREE.Vector2): void {
    const u = this.uniforms;
    this.drawn = false;
    camera.updateWorldMatrix(true, false);
    const camPos = this.v.setFromMatrixPosition(camera.matrixWorld);
    if (!rect || this.scale <= 0 || camPos.y <= this.height + 0.02) {
      u.uMirrorOn.value = 0;
      return;
    }
    // Pixels for the rectangle: the quality's share of the screen, capped.
    const rw = (rect.z - rect.x) / 2, rh = (rect.w - rect.y) / 2;
    let w = screen.x * rw * this.scale, h = screen.y * rh * this.scale;
    const fit = Math.min(1, Math.sqrt(this.maxPixels / Math.max(1, w * h)));
    w = Math.max(8, Math.round(w * fit));
    h = Math.max(8, Math.round(h * fit));
    const t = this.ensureTarget(w, h);

    // The camera reflected in the plane (a proper rotation: the reflected up vector keeps it right-handed).
    const cam = this.camera;
    const hgt = this.height;
    cam.position.set(camPos.x, 2 * hgt - camPos.y, camPos.z);
    this.look.set(0, 0, -1).transformDirection(camera.matrixWorld).add(camPos);
    this.look.y = 2 * hgt - this.look.y;
    this.up.set(0, 1, 0).transformDirection(camera.matrixWorld);
    this.up.y = -this.up.y;
    cam.up.copy(this.up);
    cam.lookAt(this.look);
    cam.updateMatrixWorld();
    cam.fov = camera.fov;
    cam.aspect = camera.aspect;
    cam.zoom = camera.zoom;
    cam.near = camera.near;
    cam.far = Math.min(camera.far, this.far);
    cam.updateProjectionMatrix();
    // Crop to the rectangle: points on the plane land at the same screen spot in both views.
    const cx = (rect.x + rect.z) / 2, cy = (rect.y + rect.w) / 2;
    this.crop.set(
      1 / rw, 0, 0, -cx / rw,
      0, 1 / rh, 0, -cy / rh,
      0, 0, 1, 0,
      0, 0, 0, 1,
    );
    const proj = cam.projectionMatrix;
    proj.premultiply(this.crop);
    // World → texture lookup (the oblique near plane below changes depth only, not x, y or w).
    const sx = w / t.width, sy = h / t.height;
    this.bias.set(
      0.5 * sx, 0, 0, 0.5 * sx,
      0, 0.5 * sy, 0, 0.5 * sy,
      0, 0, 0.5, 0.5,
      0, 0, 0, 1,
    );
    u.uMirrorMatrix.value.multiplyMatrices(this.bias, proj).multiply(cam.matrixWorldInverse);
    u.uMirrorClamp.value.set(0.5 / t.width, 0.5 / t.height, (w - 0.5) / t.width, (h - 0.5) / t.height);
    // Oblique near plane on the water's surface (terathon.com/lengyel/Lengyel-Oblique.pdf).
    this.plane.set(this.v.set(0, 1, 0), -hgt).applyMatrix4(cam.matrixWorldInverse);
    const e = proj.elements;
    this.clip.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    this.q.set((Math.sign(this.clip.x) + e[8]) / e[0], (Math.sign(this.clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
    this.clip.multiplyScalar(2 / this.clip.dot(this.q));
    e[2] = this.clip.x;
    e[6] = this.clip.y;
    e[10] = this.clip.z + 1;
    e[14] = this.clip.w;
    cam.projectionMatrixInverse.copy(proj).invert();

    const prevTarget = renderer.getRenderTarget();
    const prevShadows = renderer.shadowMap.autoUpdate;
    // The mirror reuses the shadow maps the scene drew last frame. A shadow-casting light whose map
    // was never drawn (the first frame, a lamp's shadows just turned on) would bind the wrong kind
    // of texture and fail every draw, so then the shadows are drawn here (the scene draws them again).
    if (this.lightScan-- <= 0) {
      this.lightScan = 60;
      this.shadowLights.length = 0;
      scene.traverse((o) => { if ((o as ShadowLight).isLight && (o as ShadowLight).shadow) this.shadowLights.push(o as ShadowLight); });
    }
    if (this.shadowLights.some((l) => l.castShadow && l.shadow.map === null)) renderer.shadowMap.needsUpdate = true;
    const prevPx = glareUniforms.uPxAngle.value;
    this.saved.length = 0;
    for (const o of this.hidden) {
      this.saved.push(o.visible);
      o.visible = false;
    }
    // Lamp lenses size themselves by the angle a pixel covers (their glares take over below a few
    // pixels); in here that is the mirror's pixel. Restored after, for the scene's own lenses.
    glareUniforms.uPxAngle.value = 2 / (e[5] * h);
    renderer.shadowMap.autoUpdate = false;
    t.viewport.set(0, 0, w, h);
    t.scissor.set(0, 0, w, h);
    t.scissorTest = true;
    // Nothing may read the image while it is being drawn (a feedback loop fails the draw).
    u.uMirror.value = null;
    renderer.setRenderTarget(t);
    renderer.state.buffers.depth.setMask(true);
    if (!renderer.autoClear) renderer.clear();
    renderer.render(scene, cam);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadows;
    glareUniforms.uPxAngle.value = prevPx;
    for (let i = 0; i < this.hidden.length; i++) this.hidden[i].visible = this.saved[i];
    u.uMirror.value = t.texture;
    u.uMirrorOn.value = 1;
    this.drawn = true;
  }

  private ensureTarget(w: number, h: number): THREE.WebGLRenderTarget {
    // Grows only (in steps), so a moving rectangle never reallocates frame to frame.
    const t = this.target;
    if (t && t.width >= w && t.height >= h) return t;
    const nw = Math.max(w, t?.width ?? 0, 64), nh = Math.max(h, t?.height ?? 0, 64);
    const step = (n: number) => Math.ceil(n / 64) * 64;
    t?.dispose();
    this.target = new THREE.WebGLRenderTarget(step(nw), step(nh), {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
    });
    return this.target;
  }

  /** Frees the image (reflections off). */
  release(): void {
    this.target?.dispose();
    this.target = null;
    this.uniforms.uMirror.value = null;
    this.uniforms.uMirrorOn.value = 0;
  }

  dispose(): void {
    this.release();
  }
}
