import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GAME } from '@dead-hours/shared';
import { isPhone, type ShadowQuality } from '../core/Settings';
import { weatherUniforms } from '../lighting/WetShader';
import { BONE } from '../characters/rig';
import type { Humanoid } from '../characters/Humanoid';

const INTENSITY = 95;
const RANGE = 30;
const ANGLE = 0.36;
/** Other survivors' lights: a little shorter, and no shadows. */
const REMOTE_INTENSITY = 85;
const REMOTE_RANGE = 26;
/**
 * Shadow casters nearer the lamp than this stay out of its shadow map: the survivor's own gun,
 * arms and melee weapon pass in front of a chest light and would print themselves into the beam.
 */
const SHADOW_NEAR = 0.85;
/** How fast the beam follows the aim (1/s): quick, with a little weight. */
const FOLLOW = 18;
/**
 * Lights for the other survivors' lamps (the nearest get one). Every light in the scene costs every
 * lit pixel, even dark, so phones keep one.
 */
const REMOTE_SLOTS = isPhone() ? 1 : GAME.maxPlayers - 1;

/** Where the lamp clips on, in spine space: left of the sternum, under the collarbone. */
const MOUNT_X = 0.085;
const MOUNT_Y = 0.42;
/** The lens's centre in the device's own space (it faces +Z). */
const LENS = new THREE.Vector3(0, 0.008, 0.05);
/**
 * The beam swings at most this far (radians) from straight out of the chest: further round, it
 * would shine through the survivor's own arm and shoulder.
 */
const SWING = 1.0;
/**
 * The light itself sits this far behind the lens, inside the chest, along the beam. Nothing lights
 * from closer than this (a gun or a hand right in front of the lamp would burn white at a few
 * centimetres), and the chest and the lamp, lit from behind their faces, stay unlit.
 */
const SETBACK = 0.14;

/**
 * The survivor's light: a lamp clipped to the chest (ChestLamp) whose beam follows the aim. The
 * light lives in the scene from boot at zero intensity (adding a light later would recompile every
 * material), lights the world as a real spot, casts shadows when the shadow setting allows, and
 * also drives the rain glints and the volumetric beam. A small pool of shadowless spots does the
 * same for the other survivors online.
 */
export class Flashlight {
  readonly light = new THREE.SpotLight(0xffe9cf, 0, RANGE, ANGLE, 0.6, 1.45);
  /** The player's switch. */
  on = true;
  private lvl = 0;
  private readonly remotes: THREE.SpotLight[] = [];

  constructor(scene: THREE.Scene) {
    this.light.name = 'flashlight';
    this.light.shadow.camera.near = SHADOW_NEAR;
    this.light.shadow.camera.far = RANGE;
    this.light.shadow.bias = -0.0006;
    this.light.shadow.normalBias = 0.03;
    this.light.userData.fogScale = 0.55;
    scene.add(this.light, this.light.target);
    for (let i = 0; i < REMOTE_SLOTS; i++) {
      const l = new THREE.SpotLight(0xffe9cf, 0, REMOTE_RANGE, ANGLE, 0.6, 1.45);
      l.name = `flashlight:remote${i}`;
      l.castShadow = false;
      l.userData.fogScale = 0.5;
      scene.add(l, l.target);
      this.remotes.push(l);
    }
  }

  /** Shadows cost a depth render of the scene: only on medium and high. */
  setShadows(q: ShadowQuality): void {
    const cast = q === 'medium' || q === 'high';
    this.light.castShadow = cast;
    // Draw the map once even while the light is off: materials compiled for a shadowed spot
    // sample it, and an unrendered (missing) map binds the wrong texture type.
    this.light.shadow.needsUpdate = true;
    if (cast) {
      const size = q === 'high' ? 1024 : 512;
      if (this.light.shadow.mapSize.x !== size) {
        this.light.shadow.mapSize.set(size, size);
        this.light.shadow.map?.dispose();
        this.light.shadow.map = null;
      }
    }
  }

  /** Flips the switch; returns whether it is on now. */
  toggle(): boolean {
    this.on = !this.on;
    return this.on;
  }

  get lit(): boolean {
    return this.lvl > 0.01;
  }

  /** 0..1 how bright it is now (the switch, with its short fade off). */
  get level(): number {
    return this.lvl;
  }

  /** active: in play and alive. origin/dir: where the light sits and points. */
  update(dt: number, active: boolean, origin: THREE.Vector3, dir: THREE.Vector3): void {
    this.lvl = fade(this.lvl, active && this.on, dt);
    this.light.intensity = INTENSITY * this.lvl;
    // Hiding a light would change the light count and recompile every material: dim it instead,
    // and stop redrawing its shadow map while it is off.
    this.light.shadow.autoUpdate = this.lvl > 0.001;
    aim(this.light, origin, dir);
    const u = weatherUniforms;
    u.uTorchPos.value.set(origin.x, origin.y, origin.z, this.lvl > 0.01 ? 1 : 0);
    u.uTorchDir.value.set(dir.x, dir.y, dir.z, Math.cos(ANGLE));
    const c = this.light.color;
    u.uTorchCol.value.set(c.r, c.g, c.b).multiplyScalar(this.light.intensity * 0.25);
  }

  /** Gives the pool's lights to the lit lamps of other survivors nearest the camera. */
  placeRemotes(beams: readonly Beam[], camera: THREE.Vector3): void {
    const lit = beams.filter((b) => b.level > 0.01).sort((a, b) => a.origin.distanceToSquared(camera) - b.origin.distanceToSquared(camera));
    for (let i = 0; i < this.remotes.length; i++) {
      const l = this.remotes[i];
      const b = lit[i];
      if (!b || b.origin.distanceTo(camera) > 70) {
        l.intensity = 0;
        continue;
      }
      l.intensity = REMOTE_INTENSITY * b.level;
      aim(l, b.origin, b.dir);
    }
  }
}

/** A lamp somebody carries, as the pool sees it. */
export interface Beam {
  origin: THREE.Vector3;
  dir: THREE.Vector3;
  level: number;
}

/** A click on, a short fade off. */
function fade(level: number, on: boolean, dt: number): number {
  return on ? 1 : Math.max(0, level - dt * 6);
}

function aim(l: THREE.SpotLight, origin: THREE.Vector3, dir: THREE.Vector3): void {
  l.position.copy(origin);
  l.target.position.copy(origin).addScaledVector(dir, 10);
  l.updateMatrixWorld();
  l.target.updateMatrixWorld();
}

let current: Flashlight | null = null;

/** The one flashlight (made at boot by Game, driven by the play session). */
export function setFlashlight(f: Flashlight | null): void {
  current = f;
}

export function flashlight(): Flashlight | null {
  return current;
}

// ------------------------------------------------------------------ the lamp on the chest

const mounts = new WeakMap<THREE.BufferGeometry, THREE.Vector3>();

/**
 * Where the lamp sits on this body (spine space): the outermost surface of whatever the survivor
 * wears at the mount point (skin, shirt, jacket, vest, a strap), found by casting along -Z through
 * the bind-pose triangles the spine carries.
 */
function chestMount(body: Humanoid): THREE.Vector3 {
  const g = body.mesh.geometry;
  const known = mounts.get(g);
  if (known) return known;
  const inv = body.mesh.skeleton.boneInverses[BONE.spine];
  const toModel = inv.clone().invert();
  const p = new THREE.Vector3(MOUNT_X, MOUNT_Y, 0).applyMatrix4(toModel);
  const pos = g.getAttribute('position');
  const si = g.getAttribute('skinIndex');
  const idx = g.index;
  const n = idx ? idx.count : pos.count;
  const at = (k: number) => (idx ? idx.getX(k) : k);
  let best = -Infinity;
  for (let k = 0; k + 2 < n; k += 3) {
    const a = at(k), b = at(k + 1), c = at(k + 2);
    if (si.getX(a) !== BONE.spine) continue;
    const ax = pos.getX(a), ay = pos.getY(a), bx = pos.getX(b), by = pos.getY(b), cx = pos.getX(c), cy = pos.getY(c);
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(d) < 1e-10) continue;
    const u = ((by - cy) * (p.x - cx) + (cx - bx) * (p.y - cy)) / d;
    const v = ((cy - ay) * (p.x - cx) + (ax - cx) * (p.y - cy)) / d;
    const w = 1 - u - v;
    if (u < 0 || v < 0 || w < 0) continue;
    best = Math.max(best, u * pos.getZ(a) + v * pos.getZ(b) + w * pos.getZ(c));
  }
  p.z = Number.isFinite(best) ? best : 0.13;
  const m = p.applyMatrix4(inv);
  mounts.set(g, m);
  return m;
}

/** Box with a flat vertex color (the housing is one merged, vertex-colored mesh). */
function part(g: THREE.BufferGeometry, hex: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  if (geo !== g) g.dispose();
  geo.deleteAttribute('uv');
  geo.translate(x, y, z);
  const c = new THREE.Color(hex);
  const col = new Float32Array(geo.getAttribute('position').count * 3);
  for (let i = 0; i < col.length; i += 3) c.toArray(col, i);
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

let housingGeo: THREE.BufferGeometry | null = null;
let lensGeo: THREE.BufferGeometry | null = null;
let glareTex: THREE.Texture | null = null;

function shared(): { housing: THREE.BufferGeometry; lens: THREE.BufferGeometry; glare: THREE.Texture } {
  if (!housingGeo) {
    const head = new THREE.CylinderGeometry(0.019, 0.017, 0.016, 12).rotateX(Math.PI / 2);
    housingGeo = mergeGeometries([
      // Clip behind, on the strap or the shirt.
      part(new THREE.BoxGeometry(0.03, 0.05, 0.007), 0x222326, 0, 0, 0.0035),
      // Body, its switch on top, and the head with the lens.
      part(new THREE.BoxGeometry(0.034, 0.05, 0.028), 0x18191b, 0, 0, 0.021),
      part(new THREE.BoxGeometry(0.01, 0.006, 0.01), 0x3a3b3e, 0.008, 0.028, 0.02),
      part(head, 0x2a2b2e, LENS.x, LENS.y, LENS.z - 0.01),
    ])!;
    lensGeo = new THREE.CircleGeometry(0.0145, 14).translate(LENS.x, LENS.y, LENS.z - 0.0015);
    const size = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d')!;
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,248,232,1)');
    grad.addColorStop(0.12, 'rgba(255,236,206,0.75)');
    grad.addColorStop(0.4, 'rgba(255,214,170,0.18)');
    grad.addColorStop(1, 'rgba(255,200,150,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    glareTex = new THREE.CanvasTexture(cv);
    glareTex.colorSpace = THREE.SRGBColorSpace;
  }
  return { housing: housingGeo, lens: lensGeo!, glare: glareTex! };
}

const LENS_OFF = new THREE.Color(0x2c3036);
const LENS_ON = new THREE.Color(1, 0.95, 0.86).multiplyScalar(3);
const _o = new THREE.Vector3();
const _to = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _wq = new THREE.Quaternion();

/**
 * The lamp itself: a small angle-head light clipped to the left of the chest, riding the spine
 * bone (it bobs, leans and falls with the body). Its lens glows while lit, and looking into the
 * beam shows a glare. The beam is aimed separately (it follows the aim, as a lamp tilted on its
 * clip would), so the light comes from the survivor but lights what they look at.
 */
export class ChestLamp {
  readonly root = new THREE.Group();
  private readonly housing: THREE.MeshStandardMaterial;
  private readonly lensMat: THREE.MeshBasicMaterial;
  private readonly glare: THREE.Sprite;
  private readonly glareMat: THREE.SpriteMaterial;
  /** Where the beam points (world), smoothed. */
  readonly dir = new THREE.Vector3(0, 0, 1);
  private aimed = false;
  level = 0;

  constructor(body: Humanoid) {
    const s = shared();
    this.housing = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.35, flatShading: true });
    this.lensMat = new THREE.MeshBasicMaterial({ color: LENS_OFF, toneMapped: false });
    const housing = new THREE.Mesh(s.housing, this.housing);
    const lens = new THREE.Mesh(s.lens, this.lensMat);
    housing.castShadow = lens.castShadow = false;
    this.glareMat = new THREE.SpriteMaterial({ map: s.glare, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false, opacity: 0, toneMapped: false });
    this.glare = new THREE.Sprite(this.glareMat);
    this.glare.scale.setScalar(0.15);
    this.glare.position.copy(LENS).setZ(LENS.z + 0.02);
    this.glare.visible = false;
    this.glare.renderOrder = 6;
    this.root.add(housing, lens, this.glare);
    this.root.name = 'chest-lamp';
    this.root.position.copy(chestMount(body));
    body.spine.add(this.root);
  }

  /** Surface materials (light probes). */
  materials(): THREE.Material[] {
    return [this.housing];
  }

  /** The lens (world). */
  origin(out: THREE.Vector3): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false);
    return this.root.localToWorld(out.copy(LENS));
  }

  /** Where the light is put (world): behind the lens along the beam (see SETBACK). */
  source(out: THREE.Vector3): THREE.Vector3 {
    return this.origin(out).addScaledVector(this.dir, -SETBACK);
  }

  /**
   * Turns the beam toward `want` (world, normalized) with a little weight, as far as the lamp can
   * swing on its clip from straight out of the chest; snaps the first time.
   */
  follow(want: THREE.Vector3, dt: number): THREE.Vector3 {
    this.root.updateWorldMatrix(true, false);
    const fwd = _fwd.set(0, 0, 1).applyQuaternion(this.root.getWorldQuaternion(_wq));
    const goal = _to.copy(want);
    const angle = Math.acos(THREE.MathUtils.clamp(goal.dot(fwd), -1, 1));
    if (angle > SWING) {
      _axis.crossVectors(fwd, goal);
      // Straight behind: no way round is better than another, so stay ahead.
      if (_axis.lengthSq() < 1e-8) goal.copy(fwd);
      else goal.copy(fwd).applyQuaternion(_q.setFromAxisAngle(_axis.normalize(), SWING));
    }
    if (!this.aimed) {
      this.dir.copy(goal);
      this.aimed = true;
    } else this.dir.lerp(goal, 1 - Math.exp(-dt * FOLLOW)).normalize();
    return this.dir;
  }

  /** Lens glow, and the glare seen when the beam points at the camera. */
  show(level: number, camera: THREE.Camera): void {
    this.level = level;
    this.lensMat.color.copy(LENS_OFF).lerp(LENS_ON, level);
    let glare = 0;
    if (level > 0.01) {
      const o = this.origin(_o);
      const to = camera.getWorldPosition(_to).sub(o);
      const d = to.length();
      if (d > 1.2) {
        const facing = to.divideScalar(d).dot(this.dir);
        const k = THREE.MathUtils.smoothstep(facing, Math.cos(ANGLE * 1.5), 1);
        // Up close the lens itself is enough; the glare grows with distance so it still reads far off.
        glare = level * k * k * THREE.MathUtils.smoothstep(d, 1.2, 4) * 0.85;
        this.glare.scale.setScalar(0.1 + Math.min(0.7, d * 0.018));
      }
    }
    this.glareMat.opacity = glare;
    this.glare.visible = glare > 0.01;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.housing.dispose();
    this.lensMat.dispose();
    this.glareMat.dispose();
  }
}
