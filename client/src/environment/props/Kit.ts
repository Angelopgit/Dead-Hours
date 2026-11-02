import * as THREE from 'three';
import type { PropSpec } from '@dead-hours/shared';
import type { MaterialLibrary } from '../../rendering/Materials';

export interface Updatable {
  update(dt: number, t: number): void;
}

/** Positional sound sources the audio engine can attach to. */
export interface SoundAnchor {
  kind: 'buzz' | 'alarm';
  position: THREE.Vector3;
  /** 0..1 loudness driven by the visual state (e.g. flicker). */
  level: () => number;
}

/**
 * A drivable vehicle's parts, built in its own frame (origin on the road under its middle, nose
 * along +X) and left out of the static batch: the vehicle view merges and moves them.
 */
export interface VehicleParts {
  /** Index of the prop in the map. */
  prop: number;
  /** Static parts (headlight lenses tagged userData.lamp = 'head', tail lights 'tail'). */
  root: THREE.Group;
  /** Animated parts (police strobes, hazard flashers and their lights). */
  dyn: THREE.Group;
  /** Sound sources on it (a hazard alarm), at their offsets from its origin. */
  anchors: { anchor: SoundAnchor; offset: THREE.Vector3 }[];
}

export interface PropBuildResult {
  dynamic: Updatable[];
  anchors: SoundAnchor[];
  /** Ground-level positions of emissive roadside lights (used by the menu camera framing). */
  landmarks: { policeCar?: THREE.Vector3; wreck?: THREE.Vector3; flicker?: THREE.Vector3 };
  /** Every drivable vehicle, by vehicle id (the order of the drivable props in the map). */
  vehicles: VehicleParts[];
}

export interface Paint {
  paint: true;
  material: THREE.MeshStandardMaterial;
  color: THREE.Color;
}

export type Surface = THREE.Material | Paint;

export interface PartOptions {
  rx?: number;
  ry?: number;
  rz?: number;
  cast?: boolean;
  /** Attach to the dynamic group (not merged into the static batch). */
  dynamic?: boolean;
}

function textCanvas(lines: string[], w: number, h: number, bg: string, fg: string, border: string | null): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const x = c.getContext('2d')!;
  x.fillStyle = bg;
  x.fillRect(0, 0, w, h);
  if (border) {
    x.strokeStyle = border;
    x.lineWidth = Math.max(4, h * 0.03);
    x.strokeRect(x.lineWidth, x.lineWidth, w - x.lineWidth * 2, h - x.lineWidth * 2);
  }
  x.fillStyle = fg;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const size = Math.min((h * 0.72) / lines.length, (w * 1.5) / Math.max(...lines.map((l) => l.length)));
  x.font = `700 ${size}px Oswald, Impact, sans-serif`;
  lines.forEach((l, i) => x.fillText(l, w / 2, (h * (i + 0.5)) / lines.length + size * 0.04));
  // Weathering.
  for (let i = 0; i < 260; i++) {
    x.fillStyle = `rgba(0,0,0,${Math.random() * 0.12})`;
    x.fillRect(Math.random() * w, Math.random() * h, 2 + Math.random() * 6, 2 + Math.random() * 6);
  }
  return c;
}

/**
 * Small construction kit for procedural props: positioned primitives on a prop's local
 * root (static) or dynamic group, with cached materials from the shared library.
 * Local axes: +X along the prop's length, +Z its front, origin on the floor.
 */
export class Kit {
  root!: THREE.Group;
  dyn!: THREE.Group;
  p!: PropSpec;
  private readonly textCache = new Map<string, THREE.MeshStandardMaterial>();

  constructor(readonly lib: MaterialLibrary, readonly out: PropBuildResult) {}

  begin(p: PropSpec, root: THREE.Group, dyn: THREE.Group): void {
    this.p = p;
    this.root = root;
    this.dyn = dyn;
  }

  /**
   * A paint: one shared vertex-colored material per roughness/metalness bucket, with the color
   * written into the part's vertices. Keeps hundreds of prop colors at a handful of draw calls.
   */
  mat(color: number, roughness = 0.8, metalness = 0, flat = true): Paint {
    const r = Math.round(roughness * 10) / 10;
    const m = Math.round(metalness * 5) / 5;
    const material = this.lib.custom(`paint-${r}-${m}-${flat}`, () =>
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: r, metalness: m, flatShading: flat, vertexColors: true }));
    return { paint: true, material, color: new THREE.Color(color) };
  }

  glow(color: number, intensity: number): THREE.MeshStandardMaterial {
    const m = this.lib.emissive(color, intensity);
    m.userData.noBake = true;
    return m;
  }

  /** Canvas-lettered material for signs. */
  text(lines: string[], opts: { w?: number; h?: number; bg?: string; fg?: string; border?: string | null; emissive?: number } = {}): THREE.MeshStandardMaterial {
    const key = JSON.stringify([lines, opts]);
    let m = this.textCache.get(key);
    if (!m) {
      const c = textCanvas(lines, opts.w ?? 512, opts.h ?? 256, opts.bg ?? '#e8e4d8', opts.fg ?? '#1b1b1b', opts.border === undefined ? '#1b1b1b' : opts.border);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.75 });
      if (opts.emissive) {
        m.emissive.setHex(0xffffff);
        m.emissiveMap = t;
        m.emissiveIntensity = opts.emissive;
        m.userData.noBake = true;
      }
      m.name = `sign-${this.textCache.size}`;
      this.textCache.set(key, m);
    }
    return m;
  }

  add(g: THREE.BufferGeometry, s: Surface, x: number, y: number, z: number, o: PartOptions = {}): THREE.Mesh {
    let m: THREE.Material;
    if ('paint' in s) {
      m = s.material;
      const n = g.getAttribute('position').count;
      const c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { c[i * 3] = s.color.r; c[i * 3 + 1] = s.color.g; c[i * 3 + 2] = s.color.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    } else {
      m = s;
    }
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.rotation.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    mesh.castShadow = o.cast ?? true;
    mesh.receiveShadow = true;
    (o.dynamic ? this.dyn : this.root).add(mesh);
    return mesh;
  }

  box(w: number, h: number, d: number, m: Surface, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.add(new THREE.BoxGeometry(w, h, d), m, x, y, z, o);
  }

  /** Box whose bottom sits at y. */
  block(w: number, h: number, d: number, m: Surface, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.box(w, h, d, m, x, y + h / 2, z, o);
  }

  cyl(rTop: number, rBottom: number, h: number, seg: number, m: Surface, x = 0, y = 0, z = 0, o: PartOptions = {}): THREE.Mesh {
    return this.add(new THREE.CylinderGeometry(rTop, rBottom, h, seg), m, x, y, z, o);
  }

  /** Thin rod between two local points. */
  rod(a: THREE.Vector3, b: THREE.Vector3, r: number, m: Surface, seg = 5): THREE.Mesh {
    const len = a.distanceTo(b);
    const mesh = this.cyl(r, r, len, seg, m, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    return mesh;
  }

  /** Deterministic pseudo-random in [0, 1) per prop and salt. */
  rand(salt: number): number {
    const s = Math.sin((this.p.x * 12.9898 + this.p.z * 78.233 + salt * 37.719) * 0.5) * 43758.5453;
    return s - Math.floor(s);
  }
}

/** Gable roof: two sloped quads and two triangle ends, ridge along local X. */
export function gableRoof(w: number, d: number, rise: number, overhang = 0.15): THREE.BufferGeometry {
  const x0 = -w / 2 - overhang, x1 = w / 2 + overhang;
  const z0 = -d / 2 - overhang, z1 = d / 2 + overhang;
  const k = rise / (d / 2);
  const ye = -overhang * k;
  const v = [
    // south slope
    x0, ye, z1, x1, ye, z1, x1, rise, 0, x0, ye, z1, x1, rise, 0, x0, rise, 0,
    // north slope
    x1, ye, z0, x0, ye, z0, x0, rise, 0, x1, ye, z0, x0, rise, 0, x1, rise, 0,
    // gable ends
    -w / 2, 0, d / 2, -w / 2, rise, 0, -w / 2, 0, -d / 2,
    w / 2, 0, -d / 2, w / 2, rise, 0, w / 2, 0, d / 2,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

/** Jitters vertices (weld-safe: identical positions move together). */
export function jitter(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280) - 0.5;
  const cache = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let o = cache.get(key);
    if (!o) {
      o = [rnd() * amount, rnd() * amount, rnd() * amount];
      cache.set(key, o);
    }
    p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
  }
  g.computeVertexNormals();
  return g;
}
