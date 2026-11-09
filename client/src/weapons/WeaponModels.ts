import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { patchSurf } from '../rendering/SurfShader';
import { bakeOcclusion, boxProject, chamferBox, loft, patchNoise, plate, type LoftOptions, type P2, type Ring } from '../rendering/Solid';
import { SKINS, defaultBuild, encodeBuild, isHandgun, type BuildSlot, type WeaponBuild, type WeaponId } from '@dead-hours/shared';

/**
 * A held weapon: merged low-poly parts with vertex colors (a draw call or two each), plus
 * the attachment points animation needs. Model space: +Z is the barrel, +Y the top, and the
 * origin is where the right wrist goes when holding the grip.
 */
export interface WeaponModel {
  readonly id: WeaponId;
  readonly root: THREE.Group;
  /** Detachable magazine (reloads), at rest in its well. */
  readonly mag: THREE.Object3D | null;
  readonly magRest: THREE.Vector3;
  /** Shotgun fore-end / pistol slide: slides along Z when cycling. */
  readonly action: THREE.Object3D | null;
  readonly actionRest: THREE.Vector3;
  readonly muzzle: THREE.Vector3;
  /** Left wrist target on the handguard (or the support grip for pistols). */
  readonly fore: THREE.Vector3;
  readonly eject: THREE.Vector3;
  /** Butt of the stock, seated in the shoulder when aiming (origin for pistols and blades). */
  readonly stock: THREE.Vector3;
  /** Charging handle / slide catch the left hand slaps at the end of a reload. */
  readonly bolt: THREE.Vector3;
  /** Aiming down the sights: where the eye sits behind them (model space). */
  readonly sight: Sight | null;
  /** The fitted build and its wire code (models are rebuilt when it changes). */
  readonly build: WeaponBuild;
  readonly code: string;
  /** Where each fitting sits (model space): the gunsmith's hotspots. */
  readonly points: Record<BuildSlot, THREE.Vector3>;
  readonly materials: THREE.MeshStandardMaterial[];
  dispose(): void;
}

export type Optic = 'iron' | 'dot' | 'scope';

export interface Sight {
  /** Eye position for a correct sight picture; the sight line runs along +Z from here. */
  eye: THREE.Vector3;
  /** Vertical field of view while aiming down the sights. */
  fov: number;
  optic: Optic;
}

type V3 = [number, number, number];
/** Supply-drop exclusives: sights built in, no fittings. */
const FIXED_SIGHTS: Partial<Record<WeaponId, { eye: V3; fov: number; optic: Optic }>> = {
  lmg: { eye: [0, 0.125, -0.2], fov: 48, optic: 'iron' },
  battle: { eye: [0, 0.14, -0.17], fov: 42, optic: 'dot' },
  sniper: { eye: [0, 0.16, -0.22], fov: 7, optic: 'scope' },
  rpg: { eye: [0, 0.125, -0.16], fov: 46, optic: 'iron' },
  wraith: { eye: [0, 0.14, -0.2], fov: 9, optic: 'scope' },
};

/** Iron sights each gun comes with: eye position and zoom. */
const IRONS: Partial<Record<WeaponId, { eye: V3; fov: number }>> = {
  ar: { eye: [0, 0.106, -0.2], fov: 50 },
  smg: { eye: [0, 0.1, -0.125], fov: 48 },
  shotgun: { eye: [0, 0.088, -0.26], fov: 50 },
  marksman: { eye: [0, 0.098, -0.15], fov: 50 },
  pistol: { eye: [0, 0.0885, -0.45], fov: 50 },
  // The pair: the right gun's sights line up with the eye (the left one is held out beside it).
  akimbo: { eye: [0, 0.0885, -0.45], fov: 50 },
};

/**
 * Where an optic sits: the top of the rail (y), the optic's middle along the barrel (z), and
 * whether it rides on the slide (the pistol). `onAction` coordinates are slide-local.
 */
const RAILS: Partial<Record<WeaponId, { y: number; z: number; riser: number; onAction?: boolean }>> = {
  ar: { y: 0.08, z: 0.1, riser: 0 },
  smg: { y: 0.09, z: 0.07, riser: 0.02 },
  shotgun: { y: 0.0775, z: 0.06, riser: 0.008 },
  marksman: { y: 0.08, z: 0.075, riser: 0 },
  pistol: { y: 0.017, z: -0.035, riser: 0, onAction: true },
  akimbo: { y: 0.017, z: -0.035, riser: 0, onAction: true },
};

/** Optic heights above the rail (sight line), zoom and kind. */
const OPTIC_VIEW: Record<string, { h: number; fov: number; optic: Optic }> = {
  dot: { h: 0.038, fov: 44, optic: 'dot' },
  holo: { h: 0.032, fov: 44, optic: 'dot' },
  acog: { h: 0.042, fov: 26, optic: 'dot' },
  scope: { h: 0.055, fov: 14, optic: 'scope' },
  /** Handgun optics on the slide: mini dot, enclosed compact holographic, compact prism. */
  mini: { h: 0.024, fov: 48, optic: 'dot' },
  miniHolo: { h: 0.021, fov: 46, optic: 'dot' },
  miniPrism: { h: 0.026, fov: 30, optic: 'dot' },
};

/** Handguns take slide-sized versions of the rail optics. */
const HANDGUN_OPTIC: Record<string, string> = { dot: 'mini', holo: 'miniHolo', acog: 'miniPrism' };
const opticKey = (id: WeaponId, optic: string) => (isHandgun(id) ? HANDGUN_OPTIC[optic] ?? optic : optic);

/** Sights of a weapon with a build fitted (null for blades), without building its model. */
/**
 * A pair down the sights frames both guns either side of the crosshair rather than looking down
 * one of them, so the view only closes in a little (a 3x prism can't magnify two guns at once).
 */
const TWIN_FOV: Record<string, number> = { iron: 58, dot: 56, holo: 55, acog: 50 };

export function sightOf(id: WeaponId, build: WeaponBuild = defaultBuild(id)): Sight | null {
  if (id === 'akimbo') {
    const one = sightOf('pistol', { ...defaultBuild('pistol'), optic: build.optic });
    return one && { ...one, fov: TWIN_FOV[build.optic] ?? TWIN_FOV.iron };
  }
  const fixed = FIXED_SIGHTS[id];
  if (fixed) return { eye: new THREE.Vector3(...fixed.eye), fov: fixed.fov, optic: fixed.optic };
  const irons = IRONS[id];
  if (!irons) return null;
  const rail = RAILS[id];
  const view = OPTIC_VIEW[opticKey(id, build.optic)];
  if (!rail || !view || build.optic === 'iron') return { eye: new THREE.Vector3(...irons.eye), fov: irons.fov, optic: 'iron' };
  const base = rail.onAction ? 0.064 : 0;
  return { eye: new THREE.Vector3(0, base + rail.y + rail.riser + view.h, irons.eye[2]), fov: view.fov, optic: view.optic };
}

/** What a part is made of: how rough, how metallic, and how readily its edges wear through. */
export interface Surface {
  rough: number;
  metal: number;
  /** 0..1: how much of the chamfered edges has worn through. */
  wear?: number;
  /** What shows where it has worn (bare aluminium, bright steel, scuffed plastic). */
  worn?: number;
}

/** Real finishes (docs/art-style.md): the receiver, the barrel and the furniture of one gun differ. */
export const SURF = {
  /** Hard-anodized aluminium: receivers, rails, scope tubes. */
  anodized: { rough: 0.5, metal: 0.55, wear: 0.42, worn: 0x74777b },
  /** Parkerized or phosphated steel: barrels, sights, pins. */
  steel: { rough: 0.6, metal: 0.7, wear: 0.4, worn: 0x70737a },
  /** Blued or polished steel: bolts, slides, blades. */
  blued: { rough: 0.34, metal: 0.85, wear: 0.5, worn: 0x9a9da2 },
  /** Glass-filled polymer: handguards, stocks, grips, magazines. */
  polymer: { rough: 0.8, metal: 0, wear: 0.3, worn: 0x4a4b4e },
  rubber: { rough: 0.94, metal: 0 },
  wood: { rough: 0.62, metal: 0, wear: 0.35, worn: 0x8a6a48 },
  brass: { rough: 0.3, metal: 0.9 },
} satisfies Record<string, Surface>;

type Part = { g: THREE.BufferGeometry; color: number; keep: boolean; surface: Surface | null };

/** Parts no finish paints over: bare steel, sight posts, glass. */
const BARE = new Set([0x141516, 0x0e0e0e, 0x8e9296, 0xb6babe]);

/** How far a surface shades its neighbours in the baked occlusion (metres). */
const AO_REACH = 0.02;
/** Detail map tiles per metre. */
const DETAIL_TILES = 9;

class Builder {
  readonly parts: Part[] = [];
  /** While set, parts added are fittings (optics, suppressors): a finish leaves them alone. */
  fitting = false;
  /** Self-lit parts (red dot, tritium and fiber-optic sights), drawn unlit so they read at night. */
  readonly glowParts: Part[] = [];
  private surface: Surface | null = null;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();

  private push(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, glow = false): void {
    const geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    geo.deleteAttribute('uv');
    this.q.setFromEuler(this.e.set(rx, ry, rz));
    geo.applyMatrix4(this.m.compose(new THREE.Vector3(x, y, z), this.q, new THREE.Vector3(1, 1, 1)));
    (glow ? this.glowParts : this.parts).push({ g: geo, color, keep: this.fitting || BARE.has(color), surface: this.surface });
  }

  /** What the parts added from here on are made of (null: the gun's plain finish). */
  as(surface: Surface | null): this {
    this.surface = surface;
    return this;
  }

  glow(w: number, h: number, d: number, color: number, x: number, y: number, z: number): this {
    this.push(new THREE.BoxGeometry(w, h, d), color, x, y, z, 0, 0, 0, true);
    return this;
  }

  /** Open ring around the Z axis (sight apertures, hoods, optic bodies) you can look through. */
  ring(r: number, t: number, z0: number, z1: number, color: number, x: number, y: number, segs = 10): this {
    const o = r + t;
    this.push(loft([{ z: z0, rx: o }, { z: z1, rx: o }, { z: z1, rx: r }, { z: z0, rx: r }, { z: z0, rx: o }], { segments: Math.max(segs, 12), caps: false }), color, x, y, 0);
    return this;
  }

  box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    this.push(new THREE.BoxGeometry(w, h, d), color, x, y, z, rx, ry, rz);
    return this;
  }

  /** A box with chamfered edges, which catch the light and wear. */
  slab(w: number, h: number, d: number, bevel: number, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    this.push(chamferBox(w, h, d, bevel), color, x, y, z, rx, ry, rz);
    return this;
  }

  /** A side-view outline ([z, y] points) extruded across the gun, chamfered. */
  plate(outline: P2[], width: number, color: number, bevel = 0, x = 0): this {
    this.push(plate(outline, width, { bevel, x }), color, 0, 0, 0);
    return this;
  }

  /** A tube along the barrel through stations (stepped barrels, handguards, scope bodies). */
  loft(rings: Ring[], color: number, opts: LoftOptions = {}, x = 0, y = 0): this {
    this.push(loft(rings, opts), color, x, y, 0);
    return this;
  }

  /** Cylinder along Z from z0 to z1. */
  tube(r: number, z0: number, z1: number, color: number, x: number, y: number, segs = 8, r1 = r): this {
    this.push(new THREE.CylinderGeometry(r1, r, Math.abs(z1 - z0), segs), color, x, y, (z0 + z1) / 2, Math.PI / 2);
    return this;
  }

  /** A short cylinder across the gun (pins, buttons, drums), centred at x. */
  pin(r: number, len: number, color: number, x: number, y: number, z: number, segs = 8): this {
    this.push(new THREE.CylinderGeometry(r, r, len, segs), color, x, y, z, 0, 0, Math.PI / 2);
    return this;
  }

  /**
   * Merged geometry with vertex colors; `paint` is a finish's colors (patchwork camo when several).
   * Colors carry the baked occlusion and the wear on chamfered edges; `surf` carries each part's
   * roughness and metalness (`plain` for parts that named no surface of their own).
   */
  build(glow = false, paint: number[] = [], plain: Surface = { rough: 0.55, metal: 0.35 }, painted: Surface | null = null): THREE.BufferGeometry | null {
    const parts = glow ? this.glowParts : this.parts;
    if (parts.length === 0) return null;
    const c = new THREE.Color(), w = new THREE.Color();
    parts.forEach((p, i) => {
      const pos = p.g.getAttribute('position');
      const n = pos.count;
      const col = new Float32Array(n * 3);
      const surf = new Float32Array(n * 2);
      const isPainted = paint.length > 0 && !p.keep;
      const s = (isPainted && painted) || p.surface || plain;
      c.setHex(isPainted ? finish(p.color, paint, i) : p.color);
      // Under a finish, wear shows the gun's own color; bare parts show their metal.
      w.setHex(isPainted ? p.color : s.worn ?? p.color);
      const edge = p.g.getAttribute('edge');
      const wear = glow ? 0 : s.wear ?? 0;
      for (let k = 0; k < n; k++) {
        let t = 0;
        if (edge && wear > 0 && edge.getX(k) > 0.5) {
          t = THREE.MathUtils.smoothstep(patchNoise(pos.getX(k), pos.getY(k), pos.getZ(k), 0.022), 1 - wear, 1 - wear * 0.35) * 0.85;
        }
        col[k * 3] = c.r + (w.r - c.r) * t;
        col[k * 3 + 1] = c.g + (w.g - c.g) * t;
        col[k * 3 + 2] = c.b + (w.b - c.b) * t;
        // Worn-through metal is brighter and smoother than its coating.
        surf[k * 2] = s.rough * (1 - 0.35 * t);
        surf[k * 2 + 1] = isPainted && !painted ? s.metal * 0.5 + (s.metal * 0.5) * t : s.metal;
      }
      if (edge) p.g.deleteAttribute('edge');
      p.g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      p.g.setAttribute('surf', new THREE.BufferAttribute(surf, 2));
    });
    // Rear parts first: the eye is behind the gun (over the shoulder, down the sights), so the stock
    // and receiver are drawn before what they hide and the hidden pixels are never shaded.
    const rear = (p: Part) => {
      if (!p.g.boundingBox) p.g.computeBoundingBox();
      return p.g.boundingBox!.min.z;
    };
    const ordered = [...parts].sort((a, b) => rear(a) - rear(b));
    const merged = mergeGeometries(ordered.map((p) => p.g), false)!;
    for (const p of parts) p.g.dispose();
    const pos = merged.getAttribute('position').array, nor = merged.getAttribute('normal').array;
    if (!glow) {
      const ao = bakeOcclusion(pos, nor, AO_REACH);
      const col = merged.getAttribute('color').array as Float32Array;
      for (let k = 0; k < ao.length; k++) {
        const shade = 0.3 + 0.7 * ao[k];
        col[k * 3] *= shade;
        col[k * 3 + 1] *= shade;
        col[k * 3 + 2] *= shade;
      }
    }
    merged.setAttribute('uv', new THREE.BufferAttribute(boxProject(pos, nor, DETAIL_TILES), 2));
    merged.computeBoundingSphere();
    return merged;
  }
}

/** A part's color under a finish: the finish color picked per part, as light or dark as the part was. */
function finish(color: number, paint: number[], i: number): number {
  const pick = paint[paint.length === 1 ? 0 : ((i * 2654435761) >>> 0) % paint.length];
  const l = (((color >> 16) & 255) + ((color >> 8) & 255) + (color & 255)) / 765;
  const k = THREE.MathUtils.clamp(0.82 + (l - 0.12) * 1.4, 0.7, 1.25);
  const ch = (v: number) => Math.min(255, Math.round(v * k));
  return (ch((pick >> 16) & 255) << 16) | (ch((pick >> 8) & 255) << 8) | ch(pick & 255);
}

const BLACK = 0x1d1e20;
const DARK = 0x26272a;
const STEEL = 0x141516;
const WOOD = 0x5a3b24;
const TAN = 0x6b5f48;
const COYOTE = 0x8b7556;
/** Flat dark earth (SCAR). */
const FDE = 0x8f7a5a;
const OLIVE = 0x3b4231;
const BRASS = 0xb8913a;

interface Spec {
  body: Builder;
  mag?: { b: Builder; at: [number, number, number] };
  action?: { b: Builder; at: [number, number, number] };
  muzzle: [number, number, number];
  fore: [number, number, number];
  eject: [number, number, number];
  stock: [number, number, number];
  bolt: [number, number, number];
  /** Underside of the handguard: grips and lasers mount here. */
  under?: [number, number, number];
  /** Iron sights that fold away under an optic (the rear aperture of rifles that come with optics). */
  irons?: (b: Builder) => void;
  metal?: boolean;
  /** Non-metal parts of a metal weapon (a katana's wrapped grip, tape), or the whole of a wooden one. */
  trim?: Builder;
  trimRough?: number;
}

/**
 * A drawing's frame: points are given in millimetres, forward of the receiver's front face and
 * up from the bore line, as dimension drawings give them, and land in model space.
 */
function drawn(z0: number, y0: number) {
  return {
    p: (pts: P2[]): P2[] => pts.map(([z, y]) => [z0 + z / 1000, y0 + y / 1000]),
    z: (mm: number) => z0 + mm / 1000,
    y: (mm: number) => y0 + mm / 1000,
  };
}

/** Anodized receiver grey, furniture black, parkerized barrel. */
const RECV = 0x2c2d30;
const POLY = 0x1b1b1d;
const PARK = 0x242528;
const PORT = 0x08080a;

/**
 * Colt M4 carbine with a flat-top receiver (TM 9-1005-319-10): 838 mm with the stock out, a
 * 368 mm barrel that stands 387 mm proud of the receiver with its flash hider, a 200 mm receiver,
 * double-shield handguards and the front sight base 200 mm ahead of it. The hand on the grip is
 * the origin, so everything else is placed from where a real one sits around that hand.
 */
function m4(): Spec {
  const d = drawn(0.216, 0.05);
  const b = new Builder();
  // Upper receiver and its rail.
  b.as(SURF.anodized)
    .plate(d.p([[-200, -20], [-200, 19], [-193, 24], [-4, 24], [0, 19], [0, -20]]), 0.031, RECV, 0.003)
    .slab(0.0155, 0.004, 0.19, 0.001, RECV, 0, d.y(25.5), d.z(-98));
  for (let k = 0; k < 19; k++) b.box(0.0212, 0.0032, 0.0047, RECV, 0, d.y(28.9), d.z(-188 + k * 10));
  // Lower receiver: magazine well, trigger housing, the ring the buffer tube screws into.
  b.plate(d.p([[-2, -20], [-2, -32], [-13, -36], [-17, -79], [-80, -71], [-83, -50], [-150, -50], [-156, -60], [-184, -60], [-192, -44], [-203, -34], [-213, -28], [-213, 17], [-201, 17], [-201, -20]]), 0.03, RECV, 0.002)
    .slab(0.012, 0.003, 0.07, 0.001, RECV, 0, d.y(-72), d.z(-117));
  // Right side (-X): ejection port with the bolt showing, its door hanging open, the brass deflector, the forward assist.
  b.box(0.002, 0.015, 0.047, PORT, -0.0152, d.y(3), d.z(-85))
    .as(SURF.blued).box(0.002, 0.007, 0.04, 0x4c4f54, -0.0156, d.y(4), d.z(-86))
    .as(SURF.anodized).box(0.0025, 0.015, 0.046, RECV, -0.0185, d.y(-11), d.z(-85), 0, 0, -0.55)
    .plate(d.p([[-112, -3], [-112, 12], [-123, 9], [-126, -1]]), 0.008, RECV, 0.002, -0.016)
    .tube(0.0058, d.z(-178), d.z(-150), RECV, -0.0185, d.y(5), 8)
    .tube(0.0074, d.z(-184), d.z(-178), RECV, -0.0185, d.y(5), 8)
    .pin(0.0045, 0.004, RECV, -0.0155, d.y(-38), d.z(-95));
  // Left side: bolt catch and the selector. Charging handle across the back.
  b.slab(0.004, 0.02, 0.011, 0.001, RECV, 0.0162, d.y(-25), d.z(-93))
    .pin(0.0055, 0.004, RECV, 0.0155, d.y(-42), d.z(-168))
    .box(0.003, 0.004, 0.017, RECV, 0.0175, d.y(-42), d.z(-161))
    .slab(0.046, 0.008, 0.011, 0.002, RECV, 0, d.y(19), d.z(-204))
    .slab(0.012, 0.007, 0.03, 0.001, RECV, 0, d.y(20.5), d.z(-190));
  // Pins, trigger.
  b.as(SURF.steel)
    .pin(0.0038, 0.0312, 0x3a3c40, 0, d.y(-28), d.z(-11))
    .pin(0.0038, 0.0312, 0x3a3c40, 0, d.y(-31), d.z(-190))
    .plate(d.p([[-124, -50], [-131, -50], [-133, -60], [-130, -68], [-126, -68], [-127, -59]]), 0.006, STEEL, 0.001);
  // Pistol grip.
  b.as(SURF.polymer)
    .plate(d.p([[-150, -50], [-152, -72], [-158, -76], [-160, -84], [-164, -96], [-184, -146], [-224, -138], [-200, -62], [-205, -48], [-196, -44], [-186, -50]]), 0.028, POLY, 0.007);
  // Buffer tube with its castle nut, and the stock pulled out.
  b.as(SURF.anodized)
    .loft([{ z: d.z(-213), rx: 0.019 }, { z: d.z(-225), rx: 0.019 }, { z: d.z(-225), rx: 0.0145 }, { z: d.z(-292), rx: 0.0145 }], RECV, { segments: 10 }, 0, d.y(0));
  b.as(SURF.polymer)
    .plate(d.p([[-266, 20], [-438, 23], [-446, 16], [-446, -90], [-440, -98], [-423, -98], [-334, -40], [-316, -44], [-312, -34], [-284, -30], [-266, -20]]), 0.04, POLY, 0.005)
    .plate(d.p([[-300, -22], [-300, -27], [-430, -86], [-436, -80]]), 0.0415, POLY, 0.0005)
    .plate(d.p([[-276, 6], [-276, 2], [-436, 4], [-436, 8]]), 0.0415, POLY, 0.0005)
    .box(0.042, 0.02, 0.008, PORT, 0, d.y(-52), d.z(-428))
    .slab(0.014, 0.008, 0.03, 0.002, POLY, 0, d.y(-41), d.z(-300))
    .as(SURF.rubber).slab(0.041, 0.118, 0.006, 0.002, 0x101011, 0, d.y(-37), d.z(-448));
  // Barrel nut and delta ring, then the handguards with their ribs and vents.
  b.as(SURF.steel)
    .loft([{ z: d.z(0), rx: 0.019 }, { z: d.z(8), rx: 0.019 }, { z: d.z(8), rx: 0.0275 }, { z: d.z(12), rx: 0.0275 }, { z: d.z(28), rx: 0.0235 }], PARK, { segments: 12 }, 0, d.y(0));
  const guard: Ring[] = [];
  const taper = (mm: number) => 1 - 0.15 * ((mm - 28) / 168);
  for (let k = 0; k < 7; k++) {
    const z0 = 28 + k * 24;
    for (const [z, deep] of [[z0, 1], [z0 + 3, 0], [z0 + 19, 0], [z0 + 22, 1]] as const) {
      const r = taper(z) - deep * 0.06;
      guard.push({ z: d.z(z), rx: 0.027 * r, ry: 0.0305 * r });
    }
  }
  b.as(SURF.polymer).loft(guard, POLY, { segments: 12, power: 2.4 }, 0, d.y(0));
  for (let k = 1; k < 7; k++) b.box(0.007, 0.003, 0.004, PORT, 0, d.y(30.5 * taper(28 + k * 24) - 1.2), d.z(27 + k * 24));
  // Front sight base: clamp and bayonet lug, the A-frame, the ears around the post.
  b.as(SURF.steel)
    .loft([{ z: d.z(196), rx: 0.0245 }, { z: d.z(200), rx: 0.0245 }], PARK, { segments: 12 }, 0, d.y(0))
    .plate(d.p([[200, -13], [200, 14], [238, 14], [240, -13], [238, -25], [226, -25], [226, -13]]), 0.021, PARK, 0.003)
    .plate(d.p([[203, 12], [204, 50], [222, 50], [224, 44], [238, 12]]), 0.0105, PARK, 0.0015)
    .plate(d.p([[210, 19], [212, 41], [226, 19]]), 0.011, PORT, 0)
    .plate(d.p([[203, 50], [203, 63], [206, 66], [217, 66], [221, 62], [222, 50]]), 0.003, PARK, 0.0006, 0.0095)
    .plate(d.p([[203, 50], [203, 63], [206, 66], [217, 66], [221, 62], [222, 50]]), 0.003, PARK, 0.0006, -0.0095)
    .box(0.016, 0.004, 0.018, PARK, 0, d.y(51), d.z(212))
    .box(0.0036, 0.01, 0.0036, BLACK, 0, d.y(52), d.z(212));
  // Barrel: the step cut for a grenade launcher, then the flash hider with its slots.
  b.loft([
    { z: d.z(238), rx: 0.0095 }, { z: d.z(262), rx: 0.0095 }, { z: d.z(262), rx: 0.008 }, { z: d.z(300), rx: 0.008 },
    { z: d.z(300), rx: 0.0095 }, { z: d.z(343), rx: 0.0095 }, { z: d.z(343), rx: 0.0078 }, { z: d.z(346), rx: 0.0078 },
    { z: d.z(346), rx: 0.011 }, { z: d.z(383), rx: 0.011 }, { z: d.z(387), rx: 0.009 },
  ], PARK, { segments: 12 }, 0, d.y(0));
  for (const a of [0, 0.96, -0.96, 1.92, -1.92]) b.box(0.0034, 0.003, 0.02, PORT, Math.sin(a) * 0.0102, d.y(0) + Math.cos(a) * 0.0102, d.z(366), 0, 0, -a);
  b.tube(0.0046, d.z(386.6), d.z(387.3), PORT, 0, d.y(0), 8);
  b.as(null);
  // The magazine: a 30-round aluminium one, straight in the well and curving forward below it.
  const at: V3 = [0, -0.01, 0.167];
  const md = drawn(0.216 - at[2], 0.05 - at[1]);
  const mag = new Builder().as({ rough: 0.52, metal: 0.5, wear: 0.55, worn: 0x7e8185 })
    .plate(md.p([[-20, -40], [-80, -40], [-81, -105], [-76, -150], [-61, -196], [-56, -200], [2, -186], [4, -181], [-10, -150], [-18, -105]]), 0.0225, 0x303134, 0.002)
    .box(0.0236, 0.07, 0.004, 0x2a2b2e, 0, md.y(-128), md.z(-33), 0.16)
    .box(0.0236, 0.07, 0.004, 0x2a2b2e, 0, md.y(-128), md.z(-60), 0.16)
    .as(SURF.polymer).slab(0.0245, 0.006, 0.066, 0.0015, 0x1d1d1f, 0, md.y(-192), md.z(-28), -0.235);
  return {
    body: b, mag: { b: mag, at },
    muzzle: [0, 0.05, d.z(387)], fore: [0.035, -0.012, 0.31], eject: [-0.02, 0.055, d.z(-85)], stock: [0, 0.03, d.z(-451)], bolt: [0.02, 0.072, d.z(-204)],
    under: [0, 0.019, 0.33],
    // Flip-up rear aperture on the last rail slots, lined up with the front post.
    irons: (r) => r.box(0.02, 0.012, 0.016, BLACK, 0, 0.092, 0.035).ring(0.0035, 0.002, 0.031, 0.039, BLACK, 0, 0.106, 10),
  };
}

function mp5(): Spec {
  const b = new Builder()
    .tube(0.026, -0.08, 0.22, DARK, 0, 0.05, 8)
    .box(0.02, 0.016, 0.22, BLACK, 0, 0.082, 0.07)
    // Rear diopter (a peep ring on its drum) and the hooded front post with a tritium dot.
    .box(0.03, 0.022, 0.03, BLACK, 0, 0.082, -0.05)
    .ring(0.006, 0.004, -0.056, -0.044, BLACK, 0, 0.1, 10)
    .box(0.02, 0.022, 0.022, BLACK, 0, 0.077, 0.24)
    .ring(0.011, 0.003, 0.232, 0.248, BLACK, 0, 0.1, 12)
    .box(0.003, 0.012, 0.004, BLACK, 0, 0.094, 0.24)
    .glow(0.0024, 0.0024, 0.0008, 0x9dff6a, 0, 0.0985, 0.2376)
    .box(0.056, 0.062, 0.14, 0x1b1c1e, 0, 0.04, 0.28)
    .tube(0.012, 0.35, 0.42, STEEL, 0, 0.05, 6)
    .box(0.04, 0.04, 0.13, BLACK, 0, 0.005, 0.03)
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.03, -0.25)
    .box(0.008, 0.008, 0.18, STEEL, 0.02, 0.045, -0.16)
    .box(0.008, 0.008, 0.18, STEEL, -0.02, 0.045, -0.16)
    .box(0.05, 0.1, 0.02, BLACK, 0, 0.035, -0.25);
  const mag = new Builder().box(0.022, 0.16, 0.034, 0x202124, 0, -0.075, 0.025, 0.35);
  return {
    body: b, mag: { b: mag, at: [0, -0.0, 0.15] },
    muzzle: [0, 0.05, 0.43], fore: [0.035, -0.01, 0.25], eject: [-0.03, 0.06, 0.08], stock: [0, 0.035, -0.26], bolt: [0.0, 0.08, 0.2],
    under: [0, 0.009, 0.28],
  };
}

function m870(): Spec {
  const b = new Builder()
    .box(0.05, 0.075, 0.2, 0x1f2022, 0, 0.04, 0.06)
    .tube(0.013, 0.16, 0.63, STEEL, 0, 0.066)
    .tube(0.013, 0.16, 0.54, 0x18191a, 0, 0.026)
    .box(0.008, 0.006, 0.01, STEEL, 0, 0.08, 0.62)
    .glow(0.005, 0.005, 0.005, 0xff8a2a, 0, 0.0845, 0.62)
    .box(0.042, 0.1, 0.27, WOOD, 0, -0.005, -0.2, 0.12)
    .box(0.046, 0.13, 0.025, 0x101010, 0, -0.03, -0.345, 0.12)
    .box(0.036, 0.06, 0.09, WOOD, 0, -0.012, -0.035, 0.45)
    .box(0.012, 0.012, 0.06, BLACK, 0, -0.01, 0.06);
  const pump = new Builder()
    .box(0.052, 0.05, 0.17, WOOD, 0, 0, 0)
    .box(0.056, 0.006, 0.17, 0x4a3020, 0, -0.01, 0);
  return {
    body: b, action: { b: pump, at: [0, 0.026, 0.27] },
    muzzle: [0, 0.066, 0.64], fore: [0.035, -0.002, 0.27], eject: [-0.03, 0.05, 0.07], stock: [0, -0.01, -0.35], bolt: [0.035, -0.002, 0.27],
    // The pump slides: the laser rides on the receiver's side.
    under: [0.032, 0.03, 0.12],
  };
}

function mk14(): Spec {
  const b = new Builder()
    .box(0.06, 0.08, 0.42, TAN, 0, 0.04, 0.12)
    .box(0.066, 0.02, 0.3, 0x5d5340, 0, 0.04, 0.2)
    .tube(0.012, 0.33, 0.63, STEEL, 0, 0.06)
    .tube(0.019, 0.63, 0.69, STEEL, 0, 0.06, 6)
    // Front post on the gas block (the rear aperture folds under an optic).
    .box(0.016, 0.014, 0.02, BLACK, 0, 0.077, 0.6)
    .box(0.004, 0.022, 0.005, BLACK, 0, 0.09, 0.6)
    .box(0.04, 0.05, 0.18, TAN, 0, 0.045, -0.18)
    // Cheek comb, kept under the iron sight line (IRONS.marksman eye y 0.098): taller, the eye sat inside it.
    .box(0.03, 0.016, 0.1, TAN, 0, 0.078, -0.17)
    .box(0.05, 0.12, 0.03, BLACK, 0, 0.025, -0.28)
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.035, -0.3);
  const mag = new Builder().box(0.03, 0.11, 0.07, 0x1c1c1c, 0, -0.055, 0, 0.05);
  return {
    body: b, mag: { b: mag, at: [0, -0.005, 0.12] },
    muzzle: [0, 0.06, 0.7], fore: [0.04, -0.01, 0.26], eject: [-0.035, 0.06, 0.1], stock: [0, 0.03, -0.3], bolt: [0.035, 0.07, 0.05],
    under: [0, 0.0, 0.26],
    irons: (r) => r.box(0.02, 0.012, 0.018, BLACK, 0, 0.086, -0.05).ring(0.0035, 0.002, -0.054, -0.046, BLACK, 0, 0.098, 10),
  };
}

function m249(): Spec {
  const b = new Builder()
    // Receiver with the feed tray cover on top, handguard and a long barrel under a carry handle.
    .box(0.07, 0.085, 0.36, DARK, 0, 0.045, 0.06)
    .box(0.072, 0.024, 0.2, BLACK, 0, 0.1, 0.03)
    .box(0.074, 0.006, 0.04, STEEL, 0, 0.113, 0.11)
    .box(0.076, 0.06, 0.2, BLACK, 0, 0.03, 0.34)
    .tube(0.014, 0.44, 0.8, STEEL, 0, 0.05)
    .tube(0.019, 0.8, 0.86, STEEL, 0, 0.05, 6)
    .tube(0.009, 0.44, 0.68, STEEL, 0, 0.018)
    .box(0.012, 0.04, 0.012, BLACK, -0.05, 0.08, 0.46)
    .box(0.012, 0.04, 0.012, BLACK, -0.05, 0.08, 0.58)
    .box(0.018, 0.014, 0.15, BLACK, -0.05, 0.105, 0.52)
    // Folded bipod under the barrel.
    .box(0.01, 0.01, 0.28, STEEL, 0.012, 0.0, 0.62)
    .box(0.01, 0.01, 0.28, STEEL, -0.012, 0.0, 0.62)
    .box(0.03, 0.016, 0.03, BLACK, 0, 0.012, 0.76)
    // Hooded front post on the barrel, rear aperture on the cover.
    .box(0.022, 0.035, 0.02, BLACK, 0, 0.073, 0.76)
    .box(0.004, 0.035, 0.005, BLACK, 0, 0.1075, 0.76)
    .box(0.004, 0.03, 0.016, BLACK, 0.012, 0.11, 0.76)
    .box(0.004, 0.03, 0.016, BLACK, -0.012, 0.11, 0.76)
    .box(0.03, 0.006, 0.03, BLACK, 0, 0.115, -0.06)
    .ring(0.006, 0.004, -0.066, -0.054, BLACK, 0, 0.125, 10)
    // Grip, trigger guard, skeleton stock and butt.
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.035, -0.3)
    .box(0.008, 0.01, 0.06, BLACK, 0, -0.025, 0.08)
    .box(0.03, 0.025, 0.2, BLACK, 0, 0.065, -0.22)
    .box(0.03, 0.02, 0.2, BLACK, 0, 0.0, -0.22, 0.12)
    .box(0.05, 0.12, 0.022, 0x121212, 0, 0.025, -0.33);
  // The belt box hangs under the left of the receiver, a strip of rounds running up into the feed.
  const mag = new Builder()
    .box(0.075, 0.12, 0.11, OLIVE, -0.005, -0.06, 0)
    .box(0.077, 0.01, 0.112, 0x2c3125, -0.005, -0.004, 0)
    .box(0.028, 0.016, 0.05, BRASS, 0.02, 0.006, 0);
  return {
    body: b, mag: { b: mag, at: [-0.012, 0.0, 0.14] },
    muzzle: [0, 0.05, 0.87], fore: [0.04, -0.005, 0.34], eject: [-0.035, 0.01, 0.1], stock: [0, 0.03, -0.34], bolt: [0.04, 0.05, 0.12],
  };
}

function scarH(): Spec {
  const b = new Builder()
    // Angular FDE upper with a full-length rail, black lower.
    .box(0.058, 0.065, 0.42, FDE, 0, 0.06, 0.13)
    .box(0.026, 0.012, 0.42, BLACK, 0, 0.098, 0.13)
    .box(0.062, 0.03, 0.16, FDE, 0, 0.04, 0.27)
    .box(0.05, 0.05, 0.2, BLACK, 0, 0.005, 0.05)
    .tube(0.013, 0.34, 0.56, STEEL, 0, 0.055)
    .tube(0.019, 0.56, 0.62, STEEL, 0, 0.055, 6)
    // Holographic sight: a rectangular window on the rail, the reticle at its front pane.
    .box(0.036, 0.02, 0.07, BLACK, 0, 0.114, 0.08)
    .box(0.046, 0.006, 0.04, BLACK, 0, 0.158, 0.09)
    .box(0.006, 0.036, 0.04, BLACK, 0.02, 0.14, 0.09)
    .box(0.006, 0.036, 0.04, BLACK, -0.02, 0.14, 0.09)
    .box(0.046, 0.004, 0.04, BLACK, 0, 0.124, 0.09)
    .glow(0.0024, 0.0024, 0.0008, 0xff2414, 0, 0.14, 0.108)
    .glow(0.012, 0.0008, 0.0008, 0xff2414, 0, 0.1465, 0.108)
    .glow(0.012, 0.0008, 0.0008, 0xff2414, 0, 0.1335, 0.108)
    .glow(0.0008, 0.012, 0.0008, 0xff2414, 0.0065, 0.14, 0.108)
    .glow(0.0008, 0.012, 0.0008, 0xff2414, -0.0065, 0.14, 0.108)
    // Charging handle on the left, grip, folding stock with a cheek riser.
    .box(0.03, 0.012, 0.02, BLACK, -0.04, 0.07, 0.2)
    .box(0.03, 0.09, 0.035, BLACK, 0, -0.045, 0.035, -0.3)
    .box(0.008, 0.01, 0.06, BLACK, 0, -0.025, 0.08)
    .box(0.04, 0.06, 0.24, BLACK, 0, 0.045, -0.185)
    .box(0.034, 0.022, 0.12, FDE, 0, 0.085, -0.2)
    .box(0.05, 0.12, 0.025, 0x121212, 0, 0.03, -0.3);
  const mag = new Builder().box(0.03, 0.14, 0.072, 0x1c1c1c, 0, -0.07, 0, 0.1);
  return {
    body: b, mag: { b: mag, at: [0, -0.01, 0.12] },
    muzzle: [0, 0.055, 0.63], fore: [0.035, -0.005, 0.27], eject: [-0.03, 0.06, 0.1], stock: [0, 0.03, -0.31], bolt: [-0.04, 0.07, 0.2],
  };
}

function m107(): Spec {
  const b = new Builder()
    // Long boxy receiver and rail, a heavy barrel ending in a two-port brake.
    .box(0.075, 0.09, 0.55, DARK, 0, 0.05, 0.1)
    .box(0.03, 0.014, 0.5, BLACK, 0, 0.102, 0.1)
    .box(0.08, 0.06, 0.12, BLACK, 0, 0.04, 0.42)
    .tube(0.019, 0.48, 0.98, STEEL, 0, 0.06, 10)
    .box(0.07, 0.05, 0.09, STEEL, 0, 0.06, 1.02)
    .box(0.076, 0.014, 0.014, BLACK, 0, 0.06, 1.0)
    .box(0.076, 0.014, 0.014, BLACK, 0, 0.06, 1.035)
    // A big scope on two rings.
    .tube(0.021, -0.05, 0.2, 0x111214, 0, 0.16, 10)
    .tube(0.031, -0.13, -0.05, 0x111214, 0, 0.16, 10, 0.023)
    .tube(0.023, 0.2, 0.31, 0x111214, 0, 0.16, 10, 0.038)
    .tube(0.026, 0.06, 0.09, 0x111214, 0, 0.16, 8)
    .box(0.03, 0.045, 0.025, BLACK, 0, 0.13, 0.0)
    .box(0.03, 0.045, 0.025, BLACK, 0, 0.13, 0.16)
    // Bipod folded along the barrel.
    .box(0.012, 0.012, 0.34, STEEL, 0.02, 0.02, 0.68)
    .box(0.012, 0.012, 0.34, STEEL, -0.02, 0.02, 0.68)
    .box(0.05, 0.025, 0.04, BLACK, 0, 0.03, 0.5)
    // Grip, trigger guard, stock with butt pad and monopod.
    .box(0.035, 0.1, 0.04, BLACK, 0, -0.05, 0.035, -0.3)
    .box(0.01, 0.012, 0.07, BLACK, 0, -0.02, 0.08)
    .box(0.05, 0.1, 0.24, DARK, 0, 0.03, -0.29)
    .box(0.04, 0.03, 0.14, BLACK, 0, 0.09, -0.3)
    .box(0.056, 0.15, 0.03, 0x101010, 0, 0.02, -0.42)
    .box(0.015, 0.08, 0.015, STEEL, 0, -0.04, -0.36);
  const mag = new Builder()
    .box(0.05, 0.1, 0.12, 0x1a1a1a, 0, -0.05, 0)
    .box(0.03, 0.012, 0.09, BRASS, 0, 0.004, 0);
  return {
    body: b, mag: { b: mag, at: [0, 0.0, 0.16] },
    muzzle: [0, 0.06, 1.07], fore: [0.04, 0.0, 0.32], eject: [-0.04, 0.07, 0.12], stock: [0, 0.03, -0.43], bolt: [0.045, 0.07, 0.15],
  };
}

function rpg7(): Spec {
  const b = new Builder()
    // The launch tube, wooden heat guards round its middle, the flared venturi at the back.
    .tube(0.022, -0.46, 0.52, DARK, 0, 0.07, 10)
    .tube(0.031, -0.06, 0.22, WOOD, 0, 0.07, 10)
    .tube(0.025, -0.62, -0.46, STEEL, 0, 0.07, 10, 0.022)
    .tube(0.046, -0.7, -0.62, STEEL, 0, 0.07, 10, 0.025)
    .tube(0.026, 0.48, 0.52, STEEL, 0, 0.07, 8)
    // Rear leaf on its block, front post at the muzzle end.
    .box(0.03, 0.03, 0.03, BLACK, 0, 0.098, 0.0)
    .ring(0.006, 0.004, -0.006, 0.006, BLACK, 0, 0.125, 10)
    .box(0.024, 0.028, 0.022, BLACK, 0, 0.1, 0.42)
    .box(0.004, 0.022, 0.005, BLACK, 0, 0.123, 0.42)
    // Trigger grip under the tube, a second grip ahead of it.
    .box(0.03, 0.1, 0.035, BLACK, 0, -0.01, 0.035, -0.25)
    .box(0.012, 0.03, 0.05, BLACK, 0, 0.035, 0.07)
    .box(0.03, 0.09, 0.035, WOOD, 0, 0.0, 0.2, -0.15);
  // The rocket sits in the muzzle: neck, fat olive warhead, pointed nose.
  const mag = new Builder()
    .tube(0.018, 0, 0.08, STEEL, 0, 0, 8)
    .tube(0.044, 0.08, 0.24, OLIVE, 0, 0, 12)
    .tube(0.044, 0.24, 0.4, OLIVE, 0, 0, 12, 0.006)
    .box(0.09, 0.006, 0.04, STEEL, 0, 0, 0.03)
    .box(0.006, 0.09, 0.04, STEEL, 0, 0, 0.03);
  return {
    body: b, mag: { b: mag, at: [0, 0.07, 0.5] },
    muzzle: [0, 0.07, 0.9], fore: [0.035, -0.03, 0.2], eject: [0, 0.07, -0.7], stock: [0, 0.06, -0.3], bolt: [0.03, 0.07, 0.1],
  };
}

function wraith(): Spec {
  const RANGER = 0x2f3a2c;
  const b = new Builder()
    // Custom chassis in ranger green: a slim action, a long can on the barrel.
    .box(0.06, 0.07, 0.36, RANGER, 0, 0.05, 0.06)
    .box(0.026, 0.012, 0.36, BLACK, 0, 0.091, 0.06)
    .box(0.066, 0.05, 0.22, RANGER, 0, 0.035, 0.33)
    .tube(0.014, 0.24, 0.62, STEEL, 0, 0.055)
    .tube(0.025, 0.62, 0.96, BLACK, 0, 0.055, 12)
    .tube(0.027, 0.62, 0.64, STEEL, 0, 0.055, 12)
    // Scope on two rings.
    .tube(0.019, -0.06, 0.2, 0x111214, 0, 0.14, 10)
    .tube(0.029, -0.13, -0.06, 0x111214, 0, 0.14, 10, 0.021)
    .tube(0.021, 0.2, 0.3, 0x111214, 0, 0.14, 10, 0.034)
    .tube(0.024, 0.05, 0.08, 0x111214, 0, 0.14, 8)
    .box(0.028, 0.04, 0.022, BLACK, 0, 0.11, -0.01)
    .box(0.028, 0.04, 0.022, BLACK, 0, 0.11, 0.15)
    // Bolt handle with a fat knob on the right.
    .box(0.05, 0.01, 0.012, STEEL, 0.045, 0.06, -0.06)
    .tube(0.011, -0.07, -0.04, BLACK, 0.072, 0.06, 8)
    // Grip, guard, skeleton stock with an adjustable cheek and butt.
    .box(0.03, 0.095, 0.035, BLACK, 0, -0.045, 0.035, -0.3)
    .box(0.008, 0.01, 0.06, BLACK, 0, -0.025, 0.08)
    .box(0.035, 0.025, 0.25, RANGER, 0, 0.065, -0.24)
    .box(0.035, 0.022, 0.25, RANGER, 0, 0.0, -0.24, 0.1)
    .box(0.03, 0.02, 0.12, BLACK, 0, 0.09, -0.24)
    .box(0.05, 0.13, 0.025, 0x121212, 0, 0.03, -0.37);
  const mag = new Builder().box(0.028, 0.07, 0.08, 0x1a1a1a, 0, -0.035, 0).box(0.02, 0.008, 0.06, BRASS, 0, 0.003, 0);
  return {
    body: b, mag: { b: mag, at: [0, 0.0, 0.12] },
    muzzle: [0, 0.055, 0.97], fore: [0.04, -0.005, 0.32], eject: [0.035, 0.06, 0.06], stock: [0, 0.03, -0.38], bolt: [0.072, 0.06, -0.055],
  };
}

function m17(): Spec {
  const b = new Builder()
    .box(0.028, 0.025, 0.16, COYOTE, 0, 0.035, 0.1)
    .box(0.03, 0.11, 0.046, COYOTE, 0, -0.015, 0.045, -0.3)
    .box(0.01, 0.01, 0.045, COYOTE, 0, 0.004, 0.1);
  const slide = new Builder()
    .box(0.027, 0.034, 0.19, 0x1b1b1c, 0, 0, 0)
    // Three-dot night sights: front post, rear notch.
    .box(0.004, 0.009, 0.005, 0x0e0e0e, 0, 0.0205, 0.085)
    .glow(0.0022, 0.0022, 0.0008, 0x9dff6a, 0, 0.0215, 0.0822)
    .box(0.0075, 0.01, 0.01, 0x0e0e0e, 0.006, 0.021, -0.088)
    .box(0.0075, 0.01, 0.01, 0x0e0e0e, -0.006, 0.021, -0.088)
    .glow(0.002, 0.002, 0.0008, 0x9dff6a, 0.006, 0.0215, -0.0935)
    .glow(0.002, 0.002, 0.0008, 0x9dff6a, -0.006, 0.0215, -0.0935);
  const mag = new Builder().box(0.024, 0.1, 0.036, 0x161616, 0, -0.045, 0, -0.3).box(0.03, 0.012, 0.045, 0x161616, 0, -0.098, -0.015, -0.3);
  return {
    body: b, action: { b: slide, at: [0, 0.064, 0.1] }, mag: { b: mag, at: [0, 0.02, 0.05] },
    muzzle: [0, 0.064, 0.2], fore: [0.03, -0.035, 0.035], eject: [-0.02, 0.07, 0.1], stock: [0, 0, 0], bolt: [0.0, 0.07, 0.03],
    under: [0, -0.002, 0.13],
  };
}

function machete(): Spec {
  const b = new Builder()
    .tube(0.017, -0.03, 0.11, 0x151515, 0, 0, 8)
    .box(0.014, 0.045, 0.014, 0x2a2a2a, 0, 0.004, 0.115)
    .box(0.004, 0.05, 0.36, 0x8e9296, 0, 0.014, 0.3)
    .box(0.004, 0.034, 0.09, 0x8e9296, 0, 0.022, 0.51, -0.25)
    .box(0.0045, 0.008, 0.36, 0xb6babe, 0, -0.008, 0.3);
  // The fist round the middle of the handle, the butt just showing under the little finger.
  return regrip({
    body: b, metal: true,
    muzzle: [0, 0.01, 0.56], fore: [0, 0, 0], eject: [0, 0, 0], stock: [0, 0, 0], bolt: [0, 0, 0],
  }, 0.045);
}

/** Melee models: origin at the right hand's grip, +Z toward the striking end, +Y the edge's back. */
const MELEE_POINTS = { eject: [0, 0, 0] as V3, stock: [0, 0, 0] as V3, bolt: [0, 0, 0] as V3 };

/**
 * Moves a melee model along its handle so the origin is where the lead fist closes (the middle of
 * the hand, PlayerWeapon/MeleeGrip): `z` is that point as the model was drawn.
 */
function regrip(spec: Spec, z: number): Spec {
  for (const b of [spec.body, spec.trim]) for (const part of b?.parts ?? []) part.g.translate(0, 0, -z);
  spec.muzzle = [spec.muzzle[0], spec.muzzle[1], spec.muzzle[2] - z];
  spec.fore = [spec.fore[0], spec.fore[1], spec.fore[2] - z];
  return spec;
}

function katana(): Spec {
  const blade = new Builder();
  // A gently curved blade (sori): short segments rising toward the tip, the back (mune) up.
  const segs = 9, z0 = 0.075, len = 0.7;
  for (let i = 0; i < segs; i++) {
    const u0 = i / segs, u1 = (i + 1) / segs;
    const zc = z0 + len * (u0 + u1) / 2;
    const rise = (u: number) => 0.022 * u * u;
    const yc = (rise(u0) + rise(u1)) / 2;
    const tilt = -Math.atan2(rise(u1) - rise(u0), len / segs);
    const h = 0.03 - 0.006 * u1;
    blade.box(0.0055, h, len / segs + 0.002, 0x9ea4aa, 0, yc + 0.004, zc, tilt);
    // The hardened edge (hamon side): bright steel.
    blade.box(0.0035, 0.008, len / segs + 0.002, 0xd8dde2, 0, yc - h / 2 + 0.006, zc, tilt);
  }
  // Kissaki: the angled point.
  blade.box(0.005, 0.02, 0.05, 0xb9bec4, 0, 0.026, z0 + len + 0.016, -0.55);
  // Habaki (brass collar) and tsuba (guard).
  blade.box(0.012, 0.036, 0.026, 0xb08a3c, 0, 0.003, 0.068);
  blade.tube(0.042, 0.05, 0.057, 0x2a2622, 0, 0.002, 10);
  blade.tube(0.017, -0.245, -0.235, 0x6b5a3a, 0, 0.002, 8);
  const grip = new Builder()
    .tube(0.0155, -0.235, 0.05, 0x1a1817, 0, 0.002, 8, 0.0165);
  // Ito wrap: diamonds along the grip.
  for (let i = 0; i < 9; i++) {
    const z = -0.22 + i * 0.03;
    grip.box(0.034, 0.008, 0.012, 0x2c2622, 0, 0.002, z, 0, 0, 0.7);
    grip.box(0.034, 0.008, 0.012, 0x2c2622, 0, 0.002, z + 0.015, 0, 0, -0.7);
  }
  return {
    body: blade, trim: grip, trimRough: 0.85, metal: true,
    muzzle: [0, 0.03, 0.78], fore: [0, 0, -0.17], ...MELEE_POINTS,
  };
}

function bat(): Spec {
  const ASH = 0xb8915e;
  const b = new Builder()
    // Knob, taped handle, the flare and the barrel.
    .tube(0.026, -0.14, -0.125, 0x9c7a4c, 0, 0, 10, 0.02)
    .tube(0.0145, -0.125, 0.16, ASH, 0, 0, 10, 0.016)
    .tube(0.016, 0.16, 0.42, ASH, 0, 0, 10, 0.03)
    .tube(0.03, 0.42, 0.74, 0xbf9963, 0, 0, 12, 0.034)
    .tube(0.034, 0.74, 0.755, 0xa88352, 0, 0, 12, 0.03);
  // Grip tape spiral and the burnt-in brand.
  for (let i = 0; i < 8; i++) b.box(0.033, 0.006, 0.014, 0x161616, 0, 0, -0.11 + i * 0.026, 0, 0, i % 2 ? 0.5 : -0.5);
  b.box(0.004, 0.02, 0.07, 0x3a2410, 0.031, 0.006, 0.56);
  // Dark, dried stains on the barrel: it has been used.
  b.box(0.006, 0.024, 0.05, 0x3b0d0a, 0.03, -0.01, 0.65, 0, 0, 0.4);
  return {
    body: new Builder(), trim: b, trimRough: 0.62,
    muzzle: [0, 0, 0.75], fore: [0, 0, -0.085], ...MELEE_POINTS,
  };
}

function crowbar(): Spec {
  const RED = 0x8f1d17;
  const b = new Builder()
    // Hex bar, painted, worn to bare iron at the ends.
    .tube(0.0115, -0.13, 0.44, RED, 0, 0, 6)
    .tube(0.0115, -0.2, -0.13, 0x3a3836, 0, 0, 6, 0.0115)
    // Flat chisel end, slightly bent.
    .box(0.026, 0.006, 0.05, 0x4a4744, 0, 0.004, -0.225, 0.15)
    // The goose neck curling back over the top, and its split claw.
    .tube(0.0115, 0.44, 0.48, 0x4a4744, 0, 0, 6);
  const arc = [[0.5, 0.012, 0.5], [0.52, 0.036, 1.05], [0.522, 0.066, 1.6], [0.51, 0.094, 2.2], [0.488, 0.11, 2.75]];
  for (const [z, y, a] of arc) b.box(0.022, 0.022, 0.04, 0x4a4744, 0, y, z, -a);
  b.box(0.03, 0.007, 0.045, 0x3a3836, 0, 0.116, 0.462, -3.0);
  b.box(0.004, 0.012, 0.03, 0x1a1a1a, 0, 0.12, 0.45, -3.0);
  // Held near the chisel end, the goose neck out where it hits.
  return regrip({
    body: b, metal: true,
    muzzle: [0, 0.1, 0.5], fore: [0, 0, -0.08], ...MELEE_POINTS,
  }, -0.1);
}

function wrench(): Spec {
  const IRON = 0x7a2a22, BARE = 0x55585a;
  const b = new Builder()
    // I-beam handle with a hanging hole at the end.
    .box(0.014, 0.03, 0.3, IRON, 0, 0, 0.06)
    .box(0.026, 0.008, 0.3, IRON, 0, 0.015, 0.06)
    .box(0.026, 0.008, 0.3, IRON, 0, -0.015, 0.06)
    .box(0.03, 0.038, 0.03, BARE, 0, 0, -0.105)
    // The head: fixed hook jaw, knurled adjusting nut, sliding hook jaw.
    .box(0.03, 0.05, 0.06, IRON, 0, 0.012, 0.235)
    .box(0.03, 0.02, 0.05, BARE, 0, 0.05, 0.27)
    .tube(0.017, 0.255, 0.285, BARE, 0, 0.065, 10)
    .box(0.032, 0.11, 0.024, IRON, 0, 0.08, 0.3)
    .box(0.03, 0.022, 0.052, IRON, 0, 0.128, 0.322);
  // Jaw teeth.
  for (let i = 0; i < 4; i++) b.box(0.032, 0.004, 0.006, 0x2a2b2c, 0, 0.115, 0.306 + i * 0.008);
  // Held down the handle toward its end.
  return regrip({
    body: b, metal: true,
    muzzle: [0, 0.1, 0.33], fore: [0, 0, -0.07], ...MELEE_POINTS,
  }, -0.035);
}

function hockey(): Spec {
  const SHAFT = 0x22262c, BLADE = 0x2c3038;
  const b = new Builder()
    // Composite shaft: the left hand at the taped butt, the right partway down.
    .box(0.03, 0.022, 1.18, SHAFT, 0, 0, 0.29)
    .box(0.031, 0.023, 0.12, 0x101010, 0, 0, -0.25)
    .box(0.036, 0.028, 0.025, 0x101010, 0, 0, -0.31)
    .box(0.0305, 0.0225, 0.25, 0xc8ccd0, 0, 0, 0.55)
    // The heel, then the curved blade off to the side, its tape wrapped white.
    .box(0.03, 0.024, 0.07, BLADE, 0.004, -0.004, 0.9, 0, 0.4);
  const curve = [[0.04, 0.95, 0.75], [0.1, 0.985, 1.05], [0.17, 1.005, 1.28], [0.24, 1.01, 1.5]];
  for (const [x, z, a] of curve) {
    b.box(0.075, 0.07, 0.012, BLADE, x, 0.018, z, 0, a - Math.PI / 2 + 0.1);
    b.box(0.072, 0.03, 0.013, 0xe7e7e2, x, 0.015, z, 0, a - Math.PI / 2 + 0.1);
  }
  // The left hand on the taped butt, the right 20 cm down the shaft.
  return regrip({
    body: new Builder(), trim: b, trimRough: 0.45,
    muzzle: [0.14, 0.02, 1.0], fore: [0, 0, -0.26], ...MELEE_POINTS,
  }, -0.06);
}

const SPECS: Record<WeaponId, () => Spec> = { ar: m4, smg: mp5, shotgun: m870, marksman: mk14, pistol: m17, akimbo: m17, machete, lmg: m249, battle: scarH, sniper: m107, rpg: rpg7, wraith,
  katana, katanas: katana, bat, crowbar, wrench, hockey,
};

const v = (a: V3) => new THREE.Vector3(...a);

// ------------------------------------------------------------------ fittings

/** An optic on the rail: `y` is the rail top, `z` the optic's middle; a riser lifts it over integral sights. */
function optic(b: Builder, kind: string, y: number, z: number, riser: number): void {
  if (riser > 0) b.box(0.03, riser, 0.05, BLACK, 0, y + riser / 2, z);
  y += riser;
  switch (kind) {
    case 'dot':
      // An open tube on a mount, the dot floating at its front.
      b.box(0.03, 0.022, 0.05, BLACK, 0, y + 0.007, z)
        .ring(0.021, 0.005, z - 0.03, z + 0.04, STEEL, 0, y + 0.038, 12)
        .ring(0.026, 0.003, z + 0.036, z + 0.044, BLACK, 0, y + 0.038, 12)
        .glow(0.0022, 0.0022, 0.0008, 0xff2414, 0, y + 0.038, z + 0.036);
      break;
    case 'holo': {
      // A square window in a hood over the battery housing; the ring reticle seems to float in it.
      b.box(0.036, 0.012, 0.075, BLACK, 0, y + 0.006, z)
        .box(0.03, 0.009, 0.03, BLACK, 0, y + 0.016, z - 0.024)
        .box(0.004, 0.046, 0.06, DARK, 0.021, y + 0.035, z)
        .box(0.004, 0.046, 0.06, DARK, -0.021, y + 0.035, z)
        .box(0.046, 0.005, 0.06, DARK, 0, y + 0.06, z);
      const r = 0.0062, h = y + 0.032, gz = z + 0.026;
      b.glow(0.0016, 0.0016, 0.0008, 0xff3020, 0, h, gz);
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        b.glow(0.0013, 0.0013, 0.0008, 0xff3020, Math.cos(a) * r, h + Math.sin(a) * r, gz);
      }
      break;
    }
    case 'acog':
      // A short prism tube (open, to see through) with a lit chevron.
      b.box(0.026, 0.016, 0.06, BLACK, 0, y + 0.008, z)
        .ring(0.016, 0.004, z - 0.05, z + 0.03, DARK, 0, y + 0.042, 12)
        .ring(0.021, 0.003, z + 0.03, z + 0.07, DARK, 0, y + 0.042, 12)
        .box(0.012, 0.008, 0.04, 0x2e3a24, 0, y + 0.066, z)
        .glow(0.0016, 0.0032, 0.0008, 0xff4a1a, 0, y + 0.0405, z + 0.01)
        .glow(0.0032, 0.0014, 0.0008, 0xff4a1a, 0, y + 0.042, z + 0.01);
      break;
    case 'scope':
      // Long tube with bells on two rings (looking through it is the scope view, not this model).
      b.tube(0.025, z - 0.095, z + 0.085, 0x111214, 0, y + 0.055, 10)
        .tube(0.031, z - 0.135, z - 0.095, 0x111214, 0, y + 0.055, 10, 0.026)
        .tube(0.026, z + 0.085, z + 0.135, 0x111214, 0, y + 0.055, 10, 0.033)
        .box(0.025, 0.04, 0.02, BLACK, 0, y + 0.02, z - 0.075)
        .box(0.025, 0.04, 0.02, BLACK, 0, y + 0.02, z + 0.055);
      break;
    case 'miniHolo': {
      // Enclosed compact holographic: a squared-off hood over a short base, the ring reticle in the window.
      b.box(0.026, 0.008, 0.042, BLACK, 0, y + 0.004, z)
        .box(0.004, 0.028, 0.042, DARK, 0.013, y + 0.021, z)
        .box(0.004, 0.028, 0.042, DARK, -0.013, y + 0.021, z)
        .box(0.03, 0.005, 0.042, DARK, 0, y + 0.0355, z)
        .box(0.008, 0.012, 0.012, BLACK, 0.017, y + 0.024, z - 0.008);
      const r = 0.0045, h = y + 0.021, gz = z + 0.012;
      b.glow(0.0013, 0.0013, 0.0008, 0xff3020, 0, h, gz);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        b.glow(0.0011, 0.0011, 0.0008, 0xff3020, Math.cos(a) * r, h + Math.sin(a) * r, gz);
      }
      break;
    }
    case 'miniPrism':
      // Compact prism: a short open tube on a low mount, a lit chevron inside.
      b.box(0.022, 0.01, 0.04, BLACK, 0, y + 0.005, z)
        .box(0.012, 0.006, 0.03, BLACK, 0, y + 0.012, z)
        .ring(0.0105, 0.003, z - 0.03, z + 0.022, DARK, 0, y + 0.026, 12)
        .ring(0.0135, 0.0025, z + 0.022, z + 0.044, DARK, 0, y + 0.026, 12)
        .box(0.008, 0.005, 0.026, 0x2e3a24, 0, y + 0.041, z)
        .glow(0.0012, 0.0024, 0.0008, 0xff4a1a, 0, y + 0.0245, z + 0.004)
        .glow(0.0024, 0.0011, 0.0008, 0xff4a1a, 0, y + 0.026, z + 0.004);
      break;
    case 'mini':
      // Pistol dot: a small open window on the slide.
      b.box(0.024, 0.01, 0.034, BLACK, 0, y + 0.005, z)
        .box(0.004, 0.024, 0.012, BLACK, 0.011, y + 0.02, z + 0.008)
        .box(0.004, 0.024, 0.012, BLACK, -0.011, y + 0.02, z + 0.008)
        .box(0.026, 0.004, 0.012, BLACK, 0, y + 0.034, z + 0.008)
        .glow(0.0018, 0.0018, 0.0008, 0xff2414, 0, y + 0.024, z + 0.008);
      break;
    default:
      break;
  }
}

/** A muzzle device; returns how far it moves the muzzle forward. */
function muzzleDevice(b: Builder, kind: string, m: V3, small: boolean): number {
  const [x, y, z] = m;
  if (kind === 'suppressor') {
    const len = small ? 0.13 : 0.17;
    b.tube(small ? 0.016 : 0.021, z - 0.01, z + len, 0x1a1b1d, x, y, 10).tube(small ? 0.012 : 0.016, z + len, z + len + 0.004, 0x0b0b0c, x, y, 10);
    return len;
  }
  if (kind === 'compensator') {
    b.tube(0.015, z - 0.005, z + 0.045, DARK, x, y, 8)
      .box(0.006, 0.005, 0.01, 0x070707, x, y + 0.013, z + 0.014)
      .box(0.006, 0.005, 0.01, 0x070707, x, y + 0.013, z + 0.03);
    return 0.045;
  }
  if (kind === 'choke') {
    b.tube(0.017, z - 0.005, z + 0.03, 0x2a2b2e, x, y, 10);
    return 0.03;
  }
  return 0;
}

/** Grip or laser under the handguard; returns where the support hand goes instead (or null). */
function underbarrel(b: Builder, kind: string, u: V3, fore: V3): V3 | null {
  const [x, y, z] = u;
  if (kind === 'vertical') {
    b.box(0.022, 0.012, 0.04, BLACK, x, y - 0.006, z).box(0.024, 0.075, 0.028, 0x1a1b1d, x, y - 0.048, z, -0.12);
    return [fore[0], y - 0.05, z];
  }
  if (kind === 'angled') {
    b.box(0.024, 0.026, 0.075, 0x1a1b1d, x, y - 0.013, z - 0.01, 0.35);
    return [fore[0], y - 0.02, z - 0.02];
  }
  if (kind === 'laser') {
    b.box(0.02, 0.018, 0.045, DARK, x, y - 0.01, z).glow(0.004, 0.004, 0.0008, 0xff3020, x, y - 0.01, z + 0.0228);
  }
  return null;
}

export function createWeaponModel(id: WeaponId, build: WeaponBuild = defaultBuild(id)): WeaponModel {
  const spec = (SPECS[id] ?? m4)();
  const skin = SKINS.find((k) => k.id === build.skin) ?? SKINS[0];
  const paint = skin.colors;
  const rail = RAILS[id];
  const fore = [...spec.fore] as V3;
  const muzzle = [...spec.muzzle] as V3;
  const points = {} as Record<BuildSlot, THREE.Vector3>;
  // Fittings: built into the body (or the slide) as unpainted parts.
  const body = spec.body;
  body.fitting = true;
  if (rail) {
    const kind = opticKey(id, build.optic);
    const on = rail.onAction && spec.action ? spec.action.b : body;
    on.fitting = true;
    if (build.optic === 'iron') spec.irons?.(body);
    else optic(on, kind, rail.y, rail.z, rail.riser);
    on.fitting = on === body;
    const base: V3 = rail.onAction && spec.action ? spec.action.at : [0, 0, 0];
    points.optic = new THREE.Vector3(base[0], base[1] + rail.y + rail.riser + 0.03, base[2] + rail.z);
  }
  points.muzzle = v(spec.muzzle);
  muzzle[2] += muzzleDevice(body, build.muzzle, spec.muzzle, isHandgun(id));
  if (spec.under) {
    const hand = underbarrel(body, build.grip, spec.under, spec.fore);
    if (hand) fore.splice(0, 3, ...hand);
    points.grip = v(spec.under).add(new THREE.Vector3(0, -0.02, 0));
  }
  if (build.mag === 'extended' && spec.action && !spec.mag) {
    // Tube magazine: an extension past the end of the tube.
    body.tube(0.013, 0.54, 0.6, 0x18191a, 0, 0.026).tube(0.015, 0.6, 0.61, BLACK, 0, 0.026);
  }
  body.fitting = false;
  if (spec.mag && build.mag === 'fast') {
    // Pull tab under the magazine's floor plate.
    const box = new THREE.Box3();
    for (const p of spec.mag.b.parts) {
      p.g.computeBoundingBox();
      box.union(p.g.boundingBox!);
    }
    spec.mag.b.fitting = true;
    spec.mag.b.box(0.012, 0.022, 0.012, 0xb8401c, 0, box.min.y - 0.009, (box.min.z + box.max.z) / 2);
  }
  points.mag = spec.mag ? v(spec.mag.at).add(new THREE.Vector3(0, -0.07, 0)) : spec.under ? v(spec.under).add(new THREE.Vector3(0, -0.02, 0.12)) : v(spec.fore);
  points.skin = isHandgun(id) ? new THREE.Vector3(0, -0.02, 0.045) : v(spec.stock).add(new THREE.Vector3(0, 0, 0.08));

  const root = new THREE.Group();
  root.name = `weapon:${id}`;
  const materials: THREE.MeshStandardMaterial[] = [];
  const glowMaterials: THREE.Material[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const metallic = spec.metal || skin.metal;
  /** Parts that name no surface of their own: the gun's plain finish, or bright metal. */
  const plain: Surface = metallic ? { rough: 0.32, metal: 0.75 } : { rough: 0.55, metal: 0.35 };
  const mesh = (b: Builder, parent: THREE.Object3D, trim = false) => {
    // Trim (wood, tape, rubber) keeps its own colors under a finish.
    const g = trim
      ? b.build(false, [], { rough: spec.trimRough ?? 0.7, metal: 0.02 })
      : b.build(false, paint, plain, skin.metal ? { rough: 0.3, metal: 0.85, wear: 0.3 } : null);
    if (!g) return null;
    geometries.push(g);
    // Double-sided: looking down the sights puts the eye inside apertures and optic tubes.
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    patchSurf(mat);
    if (skin.glow && !trim) mat.emissive.setRGB(0.04, 0.22, 0.2);
    mat.userData.baseEmissive = mat.emissive.getHex();
    materials.push(mat);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    parent.add(m);
    const glow = b.build(true);
    if (glow) {
      geometries.push(glow);
      const gm = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
      glowMaterials.push(gm);
      parent.add(new THREE.Mesh(glow, gm));
    }
    return m;
  };
  mesh(spec.body, root);
  if (spec.trim) mesh(spec.trim, root, true);
  const sub = (s: { b: Builder; at: [number, number, number] } | undefined) => {
    if (!s) return null;
    const o = new THREE.Group();
    o.position.set(...s.at);
    root.add(o);
    mesh(s.b, o);
    return o;
  };
  const mag = sub(spec.mag);
  const action = sub(spec.action);
  // Extended box magazines: longer, growing down out of the well.
  if (mag && build.mag === 'extended') mag.scale.set(1, 1.4, 1.06);
  return {
    id, root, mag, action,
    magRest: mag ? mag.position.clone() : new THREE.Vector3(),
    actionRest: action ? action.position.clone() : new THREE.Vector3(),
    muzzle: v(muzzle), fore: v(fore), eject: v(spec.eject), stock: v(spec.stock), bolt: v(spec.bolt),
    sight: sightOf(id, build),
    build: { ...build },
    code: encodeBuild(build),
    points,
    materials,
    dispose() {
      root.removeFromParent();
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const m of glowMaterials) m.dispose();
    },
  };
}
