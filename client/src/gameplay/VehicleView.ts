import * as THREE from 'three';
import { bakeOcclusion } from '../rendering/Solid';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { DRIVE_FLAG, NEIGHBORHOOD, VEHICLES, seatDrop, seatStands, vehicleKindOf, type Vec3, type VehicleDef, type VehicleKind, type Vehicle } from '@dead-hours/shared';
import type { VehicleParts } from '../environment/Props';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';
import { chain } from '../lighting/BakeShader';
import type { Beam } from './Flashlight';
import type { SmokeWisps } from '../effects/Smoke';
import { createWeaponModel, type WeaponModel } from '../weapons/WeaponModels';

/** Lamp colours (linear) times how bright they burn when lit. */
const HEAD = new THREE.Color(1, 0.93, 0.8);
const HEAD_GLOW = 2.6;
const TAIL_ON = 0.9;
const TAIL_BRAKE = 2.4;

/** The end of each kind's tailpipe in its own frame (x toward the nose), as the models draw it. */
const SEDAN_PIPE = { x: -2.33, y: 0.27, z: 0.52 };
const PIPE: Record<VehicleKind, { x: number; y: number; z: number }> = {
  car: SEDAN_PIPE, police: SEDAN_PIPE, wreck: SEDAN_PIPE,
  truck: { x: -3.22, y: 0.4, z: 0.62 },
  humvee: { x: -2.46, y: 0.52, z: 0.78 },
};
/** Puffs a second out of the pipe at idle, and what full throttle adds. */
const PUFFS = 5, PUFFS_POWER = 9;

/**
 * Crash damage. A hit pushes the end that took it in by up to CRUSH a time, CRUSH_MAX all told
 * (metres, for a sedan; a heavier body gives less), across the part of the body ahead of the
 * wheels. One lamp on that end goes dark past LAMP_OUT; the other never does, so the beams and the
 * brake lights the others steer by still have a lamp to come from.
 */
const CRUSH = 0.1, CRUSH_MAX = 0.3, LAMP_OUT = 0.1;
/** Bare steel where the paint is scraped off. */
const SCRAPE: [number, number, number] = [0.2, 0.2, 0.21];

/** How a vehicle is drawn this frame, as the session says. */
export interface VehicleDraw {
  pos: Vec3;
  yaw: number;
}

/**
 * A roof gun: it turns on the ring (`yaw`, about the hatch) and tips at its trunnion (`pitch`),
 * following whoever stands at it. The gun, its cradle and its shield are one weapon model.
 */
interface Turret {
  yaw: THREE.Group;
  pitch: THREE.Group;
  gun: WeaponModel;
  /** Where it points in the vehicle's frame, and where it is being swung to. */
  angle: number;
  tip: number;
  toAngle: number;
  toTip: number;
  /** Recoil: how far the gun has jumped back in its cradle (m). */
  kick: number;
}

interface Drawn {
  id: number;
  def: VehicleDef;
  group: THREE.Group;
  body: THREE.Mesh;
  mats: THREE.MeshStandardMaterial[];
  head: { value: number };
  tail: { value: number };
  probe: DynamicProbe;
  anchors: VehicleParts['anchors'];
  /** Where it is parked when the night starts. */
  home: { x: number; y: number; z: number; yaw: number };
  /** Drawn pose, and the speed it was drawn moving at (for the body's pitch and roll). */
  pos: THREE.Vector3;
  yaw: number;
  speed: number;
  pitch: number;
  roll: number;
  beam: Beam;
  /** Seconds since it last moved (still ones skip their light probe). */
  still: number;
  /** Burnt out: its paint, finish and lamps as they were, to give back for the next night. */
  paint: { color: Float32Array; pbr: Float32Array; glow: Float32Array } | null;
  /** The engine runs, and how hard it is being pushed (0 idle .. 1), eased. */
  running: boolean;
  power: number;
  /** Puffs owed to the tailpipe (a fraction carries over each frame). */
  puff: number;
  /** Which way it last rolled (1 ahead, -1 back): the end a crash lands on. */
  dir: number;
  /** How far each end is pushed in (metres): nose, tail. */
  crush: [number, number];
  /** The body as it left the factory, kept from the first dent on. */
  factory: { position: Float32Array; color: Float32Array; pbr: Float32Array; glow: Float32Array } | null;
  turret: Turret | null;
}

/** Soot over what a vertex was painted: nearly black, a trace of the old colour, mottled. */
export function soot(r: number, g: number, b: number, i: number): [number, number, number] {
  const n = 0.65 + 0.7 * (((i * 2654435761) >>> 0) / 4294967296);
  return [(0.022 + r * 0.05) * n, (0.019 + g * 0.045) * n, (0.017 + b * 0.04) * n];
}

/** A number in [0, 1) from a point and a salt: the same for every vertex at that point. */
function hash3(x: number, y: number, z: number, salt: number): number {
  const n = Math.sin(Math.round(x * 500) * 12.9898 + Math.round(y * 500) * 78.233 + Math.round(z * 500) * 37.719 + salt * 4.1) * 43758.5453;
  return n - Math.floor(n);
}

/** hash3 smoothed over patches a third of a metre across (a, b in metres). */
function patch(a: number, b: number, salt: number): number {
  const u = a * 3, v = b * 3;
  const iu = Math.floor(u), iv = Math.floor(v);
  const fu = u - iu, fv = v - iv;
  const su = fu * fu * (3 - 2 * fu), sv = fv * fv * (3 - 2 * fv);
  const at = (i: number, j: number) => hash3(i * 0.002, j * 0.002, 0, salt);
  return (at(iu, iv) * (1 - su) + at(iu + 1, iv) * su) * (1 - sv) + (at(iu, iv + 1) * (1 - su) + at(iu + 1, iv + 1) * su) * sv;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _at: Vec3 = { x: 0, y: 0, z: 0 };
const UP = new THREE.Vector3(0, 1, 0);

/**
 * One material for a whole vehicle: colour, roughness and metalness come per vertex, so the body,
 * glass, tyres, chrome and lamps are one draw. Head and tail lamps light up from uniforms (the
 * driver's switch and the brake pedal).
 */
function bodyMaterial(head: { value: number }, tail: { value: number }): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, flatShading: true });
  m.userData.envMap = true;
  m.userData.noBake = true;
  m.name = 'vehicle';
  chain(m, 'vehicle', (shader) => {
    shader.uniforms.uHead = head;
    shader.uniforms.uTail = tail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 pbr;\nattribute vec3 glow;\nvarying vec3 vPbr;\nvarying vec3 vGlow;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;\nvGlow = glow;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uHead;\nuniform float uTail;\nvarying vec3 vPbr;\nvarying vec3 vGlow;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vPbr.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vPbr.y;')
      .replace('#include <emissivemap_fragment>', `totalEmissiveRadiance = vGlow
        + step(0.5, vPbr.z) * step(vPbr.z, 1.5) * vec3(${HEAD.r.toFixed(3)}, ${HEAD.g.toFixed(3)}, ${HEAD.b.toFixed(3)}) * uHead
        + step(1.5, vPbr.z) * vec3(1.0, 0.05, 0.02) * uTail;`);
  });
  return m;
}

/**
 * Merges a vehicle's static parts into one geometry: positions in its frame, colour, and per
 * vertex roughness, metalness, lamp (0 none, 1 head, 2 tail) and glow. Parts with a texture
 * (police lettering) are handed back to stay meshes of their own, and the clear glass (Kit.pane)
 * comes back as one geometry of its own with its material.
 */
function mergeParts(root: THREE.Group): { geometry: THREE.BufferGeometry; textured: THREE.Mesh[]; glass: { geometry: THREE.BufferGeometry; material: THREE.Material } | null } {
  root.updateMatrixWorld(true);
  const pos: number[] = [], col: number[] = [], pbr: number[] = [], glow: number[] = [];
  const textured: THREE.Mesh[] = [];
  const panes: THREE.BufferGeometry[] = [];
  let paneMat: THREE.Material | null = null;
  const c = new THREE.Color();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (mesh.userData.glass) {
      const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      panes.push(g);
      paneMat = mat;
      return;
    }
    if (mat.map) {
      textured.push(mesh);
      return;
    }
    const g = (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrixWorld);
    const p = g.getAttribute('position');
    const vc = mat.vertexColors ? g.getAttribute('color') : null;
    const lamp = mesh.userData.lamp === 'head' ? 1 : mesh.userData.lamp === 'tail' ? 2 : 0;
    const er = mat.emissive.r * mat.emissiveIntensity, eg = mat.emissive.g * mat.emissiveIntensity, eb = mat.emissive.b * mat.emissiveIntensity;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      c.copy(mat.color);
      if (vc) c.multiply(new THREE.Color(vc.getX(i), vc.getY(i), vc.getZ(i)));
      col.push(c.r, c.g, c.b);
      pbr.push(mat.roughness, mat.metalness, lamp);
      glow.push(er, eg, eb);
    }
    g.dispose();
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geometry.setAttribute('pbr', new THREE.Float32BufferAttribute(pbr, 3));
  geometry.setAttribute('glow', new THREE.Float32BufferAttribute(glow, 3));
  // Flat shading: normals come from the faces in the shader.
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
  geometry.computeVertexNormals();
  // Parts shade each other (docs/art-style.md): wheels in their arches, bumpers under the body, handles on doors. Lamps stay clear.
  const shade = bakeOcclusion(pos, geometry.getAttribute('normal').array, 0.15);
  const tint = geometry.getAttribute('color').array as Float32Array;
  for (let i = 0; i < shade.length; i++) {
    if (pbr[i * 3 + 2] > 0 || glow[i * 3] + glow[i * 3 + 1] + glow[i * 3 + 2] > 0) continue;
    const k = 0.4 + 0.6 * shade[i];
    tint[i * 3] *= k;
    tint[i * 3 + 1] *= k;
    tint[i * 3 + 2] *= k;
  }
  geometry.computeBoundingSphere();
  let glass: { geometry: THREE.BufferGeometry; material: THREE.Material } | null = null;
  if (panes.length && paneMat) {
    const g = panes.length === 1 ? panes[0] : mergeGeometries(panes)!;
    for (const p of panes) if (p !== g) p.dispose();
    g.computeBoundingSphere();
    glass = { geometry: g, material: paneMat };
  }
  return { geometry, textured, glass };
}

/** A soft dark patch under each vehicle (contact shadow: they cast no baked shadow, being free to move). */
function blobTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.75)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  return t;
}

/**
 * Every drivable vehicle as it is drawn: in the menu where it is parked, in a night where the
 * simulation (or the server's copy, gliding between snapshots) has it. Each is one merged mesh
 * lit by its own light probe, with its police lettering, strobes and hazard flashers riding along,
 * lamps that light with the driver's switch and the brake pedal, and headlight beams handed to
 * the flashlight pool. All of it is in the scene from boot, so nothing compiles mid-game.
 */
export class VehicleView {
  private readonly drawn: Drawn[] = [];
  private readonly shadows: THREE.InstancedMesh;
  private readonly root = new THREE.Group();

  constructor(scene: THREE.Scene, parts: VehicleParts[], private readonly field: LightField) {
    this.root.name = 'vehicles';
    scene.add(this.root);
    const map = NEIGHBORHOOD;
    for (const part of parts) {
      const p = map.props[part.prop];
      const kind = vehicleKindOf(p);
      if (!kind) continue;
      const def = VEHICLES[kind];
      const head = { value: 0 }, tail = { value: 0 };
      const mat = bodyMaterial(head, tail);
      const { geometry, textured, glass } = mergeParts(part.root);
      const body = new THREE.Mesh(geometry, mat);
      body.castShadow = true;
      body.receiveShadow = true;
      body.name = `vehicle:${this.drawn.length}`;
      const group = new THREE.Group();
      group.rotation.order = 'YXZ';
      group.add(body);
      const mats: THREE.MeshStandardMaterial[] = [mat];
      if (glass) {
        // Clear windows: whoever sits inside shows through them (drawn after everything solid).
        const gm = (glass.material as THREE.MeshStandardMaterial).clone();
        const pane = new THREE.Mesh(glass.geometry, gm);
        pane.name = `vehicle-glass:${this.drawn.length}`;
        pane.castShadow = false;
        pane.receiveShadow = false;
        group.add(pane);
        mats.push(gm);
      }
      for (const t of textured) {
        const m = (t.material as THREE.MeshStandardMaterial).clone();
        const g = t.geometry.clone().applyMatrix4(t.matrixWorld);
        const mesh = new THREE.Mesh(g, m);
        mesh.receiveShadow = true;
        group.add(mesh);
        mats.push(m);
      }
      // Strobes and flashers: their own materials and lights, animated by the prop's updaters.
      group.add(part.dyn);
      part.dyn.traverse((o) => {
        const mm = (o as THREE.Mesh).material as THREE.Material | undefined;
        if ((o as THREE.Mesh).isMesh && mm instanceof THREE.MeshStandardMaterial) mats.push(mm);
      });
      for (const o of part.root.children) (o as THREE.Mesh).geometry?.dispose();
      let turret: Turret | null = null;
      const ts = def.turret;
      if (ts) {
        const ring = def.seats[ts.seat];
        const yaw = new THREE.Group(), pitch = new THREE.Group();
        yaw.position.set(ring.x, ts.ring, ring.z);
        pitch.position.set(ts.pivot, ts.y - ts.ring, 0);
        const gun = createWeaponModel(ts.weapon);
        // Weapon models point down +Z; the vehicle's nose is +X.
        gun.root.rotation.y = Math.PI / 2;
        gun.root.traverse((o) => {
          o.castShadow = true;
        });
        pitch.add(gun.root);
        yaw.add(pitch);
        group.add(yaw);
        mats.push(...gun.materials);
        turret = { yaw, pitch, gun, angle: 0, tip: 0, toAngle: 0, toTip: 0, kick: 0 };
      }
      const probe = new DynamicProbe(this.field, 0.15);
      probe.attach(mats);
      const y = p.y ?? 0;
      group.position.set(p.x, y, p.z);
      group.rotation.y = p.rotY;
      group.updateMatrix();
      this.root.add(group);
      this.drawn.push({
        id: this.drawn.length, def, group, body, mats, head, tail, probe, anchors: part.anchors,
        home: { x: p.x, y, z: p.z, yaw: p.rotY }, pos: new THREE.Vector3(p.x, y, p.z), yaw: p.rotY, speed: 0, pitch: 0, roll: 0,
        beam: { origin: new THREE.Vector3(), dir: new THREE.Vector3(), level: 0, dim: 1, head: true }, still: 0, paint: null,
        running: false, power: 0, puff: 0, dir: 1, crush: [0, 0], factory: null, turret,
      });
    }
    const blob = new THREE.MeshBasicMaterial({ color: 0x000000, alphaMap: blobTexture(), transparent: true, opacity: 0.62, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.shadows = new THREE.InstancedMesh(quad, blob, Math.max(1, this.drawn.length));
    this.shadows.name = 'vehicle-shadows';
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 1;
    this.root.add(this.shadows);
    for (const d of this.drawn) this.placeShadow(d);
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  get count(): number {
    return this.drawn.length;
  }

  private placeShadow(d: Drawn): void {
    _q.setFromAxisAngle(UP, d.yaw);
    _s.set(d.def.hx * 2 + 0.7, 1, d.def.hz * 2 + 0.5);
    _p.set(d.pos.x, d.pos.y + 0.025, d.pos.z);
    this.shadows.setMatrixAt(d.id, _m.compose(_p, _q, _s));
  }

  /**
   * A vehicle that blew up: its body black with soot, its glass and lettering gone, its lamps dead.
   * `on` false gives it back its paint (a new night).
   */
  char(id: number, on: boolean): void {
    const d = this.drawn[id];
    if (!d || (d.paint !== null) === on) return;
    const g = d.body.geometry;
    const color = g.getAttribute('color') as THREE.BufferAttribute;
    const pbr = g.getAttribute('pbr') as THREE.BufferAttribute;
    const glow = g.getAttribute('glow') as THREE.BufferAttribute;
    const c = color.array as Float32Array, p = pbr.array as Float32Array, e = glow.array as Float32Array;
    if (on) {
      d.paint = { color: c.slice(), pbr: p.slice(), glow: e.slice() };
      for (let i = 0; i < color.count; i++) {
        // Tyres, seats and steel alike: the whole triangle one shade.
        const [r, gg, b] = soot(c[i * 3], c[i * 3 + 1], c[i * 3 + 2], Math.floor(i / 3));
        c[i * 3] = r; c[i * 3 + 1] = gg; c[i * 3 + 2] = b;
        p[i * 3] = 0.95; p[i * 3 + 1] = 0.25; p[i * 3 + 2] = 0;
      }
      e.fill(0);
    } else if (d.paint) {
      c.set(d.paint.color);
      p.set(d.paint.pbr);
      e.set(d.paint.glow);
      d.paint = null;
    }
    color.needsUpdate = pbr.needsUpdate = glow.needsUpdate = true;
    // The glass and the lettering go with the fire (meshes only: lights are never hidden, see Pyro).
    for (const o of d.group.children) if (o !== d.body && (o as THREE.Mesh).isMesh) o.visible = !on;
  }

  /** Puts every vehicle back where the map parks it, lamps off (the menu, a new night). */
  reset(): void {
    for (const d of this.drawn) {
      this.char(d.id, false);
      this.repair(d);
      d.running = false;
      d.power = d.puff = 0;
      d.pos.set(d.home.x, d.home.y, d.home.z);
      d.yaw = d.home.yaw;
      d.speed = d.pitch = d.roll = 0;
      d.head.value = d.tail.value = 0;
      d.beam.level = 0;
      d.still = 0;
      if (d.turret) d.turret.angle = d.turret.tip = d.turret.toAngle = d.turret.toTip = d.turret.kick = 0;
      this.pose(d);
      this.placeShadow(d);
    }
    this.shadows.instanceMatrix.needsUpdate = true;
  }

  private pose(d: Drawn): void {
    d.group.position.copy(d.pos);
    _e.set(d.pitch, d.yaw, d.roll);
    d.group.rotation.copy(_e);
    // Seats and the steering wheel are read off it before the frame is drawn.
    d.group.updateMatrix();
    for (const a of d.anchors) {
      const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
      a.anchor.position.set(d.pos.x + a.offset.x * c + a.offset.z * s, d.pos.y + a.offset.y, d.pos.z - a.offset.x * s + a.offset.z * c);
    }
    this.poseTurret(d);
  }

  /** Sets the roof gun as it points now, so its muzzle and grips can be read before the frame is drawn. */
  private poseTurret(d: Drawn): void {
    const t = d.turret;
    if (!t) return;
    t.yaw.rotation.y = t.angle;
    t.pitch.rotation.z = t.tip;
    t.gun.root.position.x = -t.kick;
    // The pintle and the shield stand upright while the gun tips in its cradle.
    if (t.gun.action) t.gun.action.rotation.x = t.tip;
    d.group.updateMatrixWorld(true);
  }

  /**
   * Swings a vehicle's roof gun toward where its gunner aims (`aim`: a world direction), as fast
   * as a gunner can throw it round; with no one at it (null) it stays where it was left.
   */
  aimTurret(id: number, aim: { x: number; y: number; z: number } | null, dt: number): void {
    const d = this.drawn[id];
    const t = d?.turret;
    const ts = d?.def.turret;
    if (!d || !t || !ts) return;
    if (aim) {
      const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
      const lx = aim.x * c - aim.z * s, lz = aim.x * s + aim.z * c;
      const flat = Math.hypot(lx, lz);
      if (flat > 1e-4) t.toAngle = Math.atan2(-lz, lx);
      t.toTip = THREE.MathUtils.clamp(Math.atan2(aim.y, flat), ts.pitch[0], ts.pitch[1]);
    }
    const k = 1 - Math.exp(-dt * 16);
    const turn = Math.atan2(Math.sin(t.toAngle - t.angle), Math.cos(t.toAngle - t.angle));
    const before = t.angle + t.tip + t.kick;
    t.angle += turn * k;
    t.tip += (t.toTip - t.tip) * k;
    t.kick *= Math.exp(-dt * 26);
    if (t.kick < 1e-4) t.kick = 0;
    if (Math.abs(t.angle + t.tip + t.kick - before) > 1e-5) this.poseTurret(d);
  }

  /** A round left the roof gun: it jumps back in its cradle. */
  turretFired(id: number): void {
    const t = this.drawn[id]?.turret;
    if (t) t.kick = Math.min(0.035, t.kick + 0.016);
  }

  /** The trunnion of a vehicle's roof gun as drawn: where its aim is measured from. */
  turretPivot(id: number, out: THREE.Vector3): boolean {
    const t = this.drawn[id]?.turret;
    if (!t) return false;
    t.pitch.getWorldPosition(out);
    return true;
  }

  /** The roof gun's muzzle and the way its barrel points (world). */
  turretMuzzle(id: number, out: THREE.Vector3, dir: THREE.Vector3): boolean {
    const t = this.drawn[id]?.turret;
    if (!t) return false;
    t.gun.root.localToWorld(out.copy(t.gun.muzzle));
    t.pitch.getWorldPosition(dir);
    dir.subVectors(out, dir).normalize();
    return true;
  }

  /** Where the roof gun throws its cases out, and which way. */
  turretEject(id: number, out: THREE.Vector3, dir: THREE.Vector3): boolean {
    const t = this.drawn[id]?.turret;
    if (!t) return false;
    t.gun.root.localToWorld(out.copy(t.gun.eject));
    dir.set(0, -0.4, 1).applyQuaternion(t.yaw.getWorldQuaternion(_q)).normalize();
    return true;
  }

  /** The roof gun's spade grips (world): where its gunner's hands go. */
  turretGrips(id: number, left: THREE.Vector3, right: THREE.Vector3): boolean {
    const d = this.drawn[id];
    const t = d?.turret;
    const ts = d?.def.turret;
    if (!t || !ts) return false;
    t.pitch.localToWorld(left.set(-ts.grips, 0, -0.085));
    t.pitch.localToWorld(right.set(-ts.grips, 0, 0.085));
    return true;
  }

  /** Whether a seat is stood in (the hatch under a roof gun). */
  stands(id: number, seat: number): boolean {
    const d = this.drawn[id];
    return !!d && seatStands(d.def, seat);
  }

  /**
   * Draws the night's vehicles. `drawAt` gives where each is drawn (null: where the copy has it);
   * without a simulation (the menu) they stay parked.
   */
  update(dt: number, camera: THREE.Camera, vehicles: readonly Vehicle[] | null, drawAt: ((v: Vehicle, out: Vec3) => number | null) | null): void {
    let moved = false;
    for (const d of this.drawn) {
      const v = vehicles?.[d.id];
      if (v) {
        const yaw = drawAt?.(v, _at) ?? null;
        const x = yaw === null ? v.pos.x : _at.x, y = yaw === null ? v.pos.y : _at.y, z = yaw === null ? v.pos.z : _at.z;
        const ny = yaw === null ? v.yaw : yaw;
        const shift = Math.abs(x - d.pos.x) + Math.abs(z - d.pos.z) + Math.abs(y - d.pos.y) + Math.abs(Math.atan2(Math.sin(ny - d.yaw), Math.cos(ny - d.yaw)));
        // The body leans back under power and dips under braking, rolls out of a turn.
        const accel = dt > 0 ? (v.speed - d.speed) / dt : 0;
        d.speed = v.speed;
        const k = 1 - Math.exp(-dt * 6);
        const steer = v.steer * Math.min(1, Math.abs(v.speed) / 6) * Math.sign(v.speed);
        d.pitch += (THREE.MathUtils.clamp(accel * 0.004, -0.05, 0.035) - d.pitch) * k;
        d.roll += (THREE.MathUtils.clamp(-steer * Math.abs(v.speed) * 0.0045, -0.05, 0.05) - d.roll) * k;
        if (shift > 1e-4 || Math.abs(d.pitch) > 1e-4 || Math.abs(d.roll) > 1e-4) {
          d.pos.set(x, y, z);
          d.yaw = ny;
          this.pose(d);
          this.placeShadow(d);
          moved = true;
          d.still = 0;
        } else d.still += dt;
        if (Math.abs(v.speed) > 1) d.dir = Math.sign(v.speed);
        d.running = v.engine && !v.wrecked;
        d.power += (((v.input & DRIVE_FLAG.throttle) !== 0 ? 1 : 0) - d.power) * (1 - Math.exp(-dt * 4));
        const lights = v.engine && (v.input & DRIVE_FLAG.lights) !== 0;
        const brake = (v.input & DRIVE_FLAG.brake) !== 0 && v.speed > 0.3;
        d.head.value = lights ? HEAD_GLOW : 0;
        d.tail.value = brake ? TAIL_BRAKE : lights ? TAIL_ON : 0;
        d.beam.level = lights ? 1 : 0;
      } else {
        d.head.value = d.tail.value = 0;
        d.beam.level = 0;
        d.running = false;
        d.still += dt;
      }
      // Light probes: sampled while it moves; a parked one keeps the light it was given.
      d.probe.update(d.still < 0.5 ? dt : 0, d.pos, camera, 1);
    }
    if (moved) this.shadows.instanceMatrix.needsUpdate = true;
  }

  /** Where a vehicle's tailpipe ends as it is drawn, and (into `dir`) the way it points. */
  private pipe(d: Drawn, out: THREE.Vector3, dir: THREE.Vector3): void {
    const p = PIPE[d.def.kind];
    out.set(p.x, p.y, p.z).applyMatrix4(d.group.matrix);
    dir.set(-Math.cos(d.yaw), 0, Math.sin(d.yaw));
  }

  /**
   * Exhaust from every running engine: a slow pale thread at idle, more and greyer under power,
   * left behind as the car pulls away, and red in the brake lights.
   */
  exhaust(dt: number, smoke: SmokeWisps): void {
    for (const d of this.drawn) {
      if (!d.running) {
        d.puff = 0;
        continue;
      }
      d.puff += dt * (PUFFS + PUFFS_POWER * d.power);
      if (d.puff < 1) continue;
      this.pipe(d, _p, _s);
      const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
      const red = d.tail.value >= TAIL_BRAKE ? 0.5 : d.tail.value > 0 ? 0.1 : 0;
      for (; d.puff >= 1; d.puff -= 1) smoke.exhaust(_p, _s, c * d.speed, -s * d.speed, d.power, 0, red);
    }
  }

  /** The engine catches: a few dark puffs of what the starter left in the pipe. */
  cough(id: number, smoke: SmokeWisps): void {
    const d = this.drawn[id];
    if (!d) return;
    this.pipe(d, _p, _s);
    for (let i = 0; i < 5; i++) smoke.exhaust(_p, _s, 0, 0, 0.5 + i * 0.1, 1);
  }

  /**
   * A crash of `strength` (the speed it lost, m/s): the end it was rolling toward is pushed in a
   * little more, its paint scraped to the steel, and past a point one of its lamps is put out. Looks
   * only: the body's collision and its beams stay as they were. Undone by reset(). `end` names the
   * end (0 nose, 1 tail) for the dev page; the game leaves it to the way the car was rolling.
   */
  dent(id: number, strength: number, end?: 0 | 1): void {
    const d = this.drawn[id];
    if (!d || d.paint) return;
    end ??= d.dir >= 0 ? 0 : 1;
    const most = CRUSH_MAX / d.def.ram;
    const now = Math.min(most, d.crush[end] + THREE.MathUtils.clamp((strength - 3) * 0.012, 0.015, CRUSH) / d.def.ram);
    if (now <= d.crush[end]) return;
    d.crush[end] = now;
    this.reshape(d);
  }

  /** Rebuilds a dented body from the factory one and how far each end is pushed in. */
  private reshape(d: Drawn): void {
    const g = d.body.geometry;
    const position = g.getAttribute('position') as THREE.BufferAttribute;
    const color = g.getAttribute('color') as THREE.BufferAttribute;
    const pbr = g.getAttribute('pbr') as THREE.BufferAttribute;
    const glow = g.getAttribute('glow') as THREE.BufferAttribute;
    const p = position.array as Float32Array, c = color.array as Float32Array, m = pbr.array as Float32Array, e = glow.array as Float32Array;
    d.factory ??= { position: p.slice(), color: c.slice(), pbr: m.slice(), glow: e.slice() };
    const f = d.factory;
    p.set(f.position);
    c.set(f.color);
    m.set(f.pbr);
    e.set(f.glow);
    const def = d.def;
    const most = CRUSH_MAX / def.ram;
    for (let end = 0; end < 2; end++) {
      // The crumple zone: from just past the tyres to the bumper, below the glass.
      const zone = def.hx - (Math.abs(def.axles[end]) + def.wheelRadius + 0.04);
      const crush = d.crush[end];
      if (crush <= 0) continue;
      const s = end === 0 ? 1 : -1;
      const k = crush / most;
      // Which lamp goes is the car's own.
      const first = (d.id + end) % 2 === 0 ? 1 : -1;
      for (let i = 0; i < position.count; i++) {
        const x = f.position[i * 3], y = f.position[i * 3 + 1], z = f.position[i * 3 + 2];
        const depth = (s * x - (def.hx - zone)) / zone;
        if (depth <= 0 || y > def.low + 0.02) continue;
        const t = Math.min(1.15, depth);
        // A push that changes slowly across the end, so a lamp or a grille bar goes in with the panel it sits on.
        const salt = d.id * 2 + end;
        p[i * 3] = x - s * crush * t * (0.6 + 0.8 * patch(y, z, salt));
        p[i * 3 + 1] = y + crush * t * (patch(z, y, salt + 31) - 0.5) * 0.5;
        p[i * 3 + 2] = z * (1 + crush * t * (patch(y, z, salt + 57) - 0.35) * 0.3);
        if (m[i * 3 + 2] > 0) {
          // A lamp: dark and dull once its lens is smashed.
          if (Math.sign(z) === first && crush >= LAMP_OUT / def.ram) {
            m[i * 3 + 2] = 0;
            m[i * 3] = 0.7;
            c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = 0.03;
            e[i * 3] = e[i * 3 + 1] = e[i * 3 + 2] = 0;
          }
          continue;
        }
        // Paint: scuffed and dulled, and scraped to the steel at the corners that took the most.
        const bare = THREE.MathUtils.clamp((k * t * 0.4 - hash3(x, y, z, salt)) * 4, 0, 1);
        const dull = 1 - 0.3 * k * t;
        for (let j = 0; j < 3; j++) c[i * 3 + j] = c[i * 3 + j] * dull * (1 - bare) + SCRAPE[j] * bare;
        m[i * 3] = Math.min(1, m[i * 3] + 0.25 * k * t) * (1 - bare) + 0.5 * bare;
        m[i * 3 + 1] = m[i * 3 + 1] * (1 - bare) + 0.85 * bare;
      }
    }
    position.needsUpdate = color.needsUpdate = pbr.needsUpdate = glow.needsUpdate = true;
  }

  /** The body as it left the factory again. */
  private repair(d: Drawn): void {
    d.crush[0] = d.crush[1] = 0;
    d.dir = 1;
    if (!d.factory) return;
    const g = d.body.geometry;
    for (const name of ['position', 'color', 'pbr', 'glow'] as const) {
      const a = g.getAttribute(name) as THREE.BufferAttribute;
      (a.array as Float32Array).set(d.factory[name]);
      a.needsUpdate = true;
    }
    d.factory = null;
  }

  /** Headlight beams of the vehicles with their lamps on (not `except`, which the survivor's own light draws). */
  beams(out: Beam[], except = -1): Beam[] {
    for (const d of this.drawn) {
      if (d.beam.level <= 0 || d.id === except) continue;
      this.headlight(d.id, d.beam.origin, d.beam.dir);
      out.push(d.beam);
    }
    return out;
  }

  /** Where a vehicle's headlights shine from and which way (just ahead of its nose, a little down). */
  headlight(id: number, origin: THREE.Vector3, dir: THREE.Vector3): boolean {
    const d = this.drawn[id];
    if (!d) return false;
    const c = Math.cos(d.yaw), s = Math.sin(d.yaw);
    const ahead = d.def.hx + 0.25;
    origin.set(d.pos.x + c * ahead, d.pos.y + d.def.low * 0.8, d.pos.z - s * ahead);
    dir.set(c, -0.1, -s).normalize();
    return true;
  }

  /** Where a vehicle is drawn (its road point) and its heading. */
  drawnPose(id: number, out: THREE.Vector3): number | null {
    const d = this.drawn[id];
    if (!d) return null;
    out.copy(d.pos);
    return d.yaw;
  }

  /**
   * Where a seat's cushion is as the vehicle is drawn (leaning with it), and the vehicle's heading;
   * null for no such vehicle.
   */
  seatPoint(id: number, seat: number, out: THREE.Vector3): number | null {
    const d = this.drawn[id];
    if (!d) return null;
    const s = d.def.seats[seat] ?? d.def.seats[0];
    out.set(s.x, s.y, s.z).applyMatrix4(d.group.matrix);
    return d.yaw;
  }

  /** How high a seat's cushion is over the vehicle's floor (where the feet of whoever sits there go). */
  seatDrop(id: number, seat: number): number {
    const d = this.drawn[id];
    return d ? seatDrop(d.def, seat) : 0.5;
  }

  /** Where the driver's hands go on the steering wheel (left and right of its rim), as drawn. */
  wheelPoints(id: number, left: THREE.Vector3, right: THREE.Vector3): boolean {
    const d = this.drawn[id];
    if (!d) return false;
    const s = d.def.seats[0], w = d.def.wheel;
    left.set(w.x, w.y, s.z - 0.17).applyMatrix4(d.group.matrix);
    right.set(w.x, w.y, s.z + 0.17).applyMatrix4(d.group.matrix);
    return true;
  }

  /** A vehicle's body mesh and its drawn group (for the camera's look-through and the seat poses). */
  group(id: number): THREE.Group | null {
    return this.drawn[id]?.group ?? null;
  }

  dispose(): void {
    for (const d of this.drawn) {
      for (const o of d.group.children) if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
      for (const m of d.mats) m.dispose();
      d.turret?.gun.dispose();
    }
    this.shadows.geometry.dispose();
    (this.shadows.material as THREE.Material).dispose();
    this.root.removeFromParent();
  }
}
