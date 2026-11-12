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
/** Height of the M17's bore over the hand on its grip (the slide rides here). */
const M17_BORE = 0.071;
/** Supply-drop exclusives: sights built in, no fittings. */
const FIXED_SIGHTS: Partial<Record<WeaponId, { eye: V3; fov: number; optic: Optic }>> = {
  lmg: { eye: [0, 0.125, -0.06], fov: 48, optic: 'iron' },
  battle: { eye: [0, 0.143, -0.095], fov: 42, optic: 'dot' },
  sniper: { eye: [0, 0.16, -0.12], fov: 7, optic: 'scope' },
  rpg: { eye: [0, 0.125, -0.16], fov: 46, optic: 'iron' },
  wraith: { eye: [0, 0.14, -0.2], fov: 9, optic: 'scope' },
  at4: { eye: [0, 0.154, -0.19], fov: 46, optic: 'iron' },
  mgl: { eye: [0, 0.16, -0.1], fov: 50, optic: 'dot' },
};

/** Iron sights each gun comes with: eye position and zoom. */
const IRONS: Partial<Record<WeaponId, { eye: V3; fov: number }>> = {
  ar: { eye: [0, 0.106, -0.2], fov: 50 },
  smg: { eye: [0, 0.1, -0.09], fov: 48 },
  shotgun: { eye: [0, 0.082, -0.24], fov: 50 },
  marksman: { eye: [0, 0.098, -0.067], fov: 50 },
  pistol: { eye: [0, M17_BORE + 0.0175, -0.45], fov: 50 },
  // The pair: the right gun's sights line up with the eye (the left one is held out beside it).
  akimbo: { eye: [0, M17_BORE + 0.0175, -0.45], fov: 50 },
};

/**
 * Where an optic sits: the top of the rail (y), the optic's middle along the barrel (z), and
 * whether it rides on the slide (the pistol). `onAction` coordinates are slide-local.
 */
const RAILS: Partial<Record<WeaponId, { y: number; z: number; riser: number; onAction?: boolean }>> = {
  ar: { y: 0.08, z: 0.1, riser: 0 },
  smg: { y: 0.09, z: 0.07, riser: 0.02 },
  shotgun: { y: 0.074, z: 0.1, riser: 0.01 },
  marksman: { y: 0.0925, z: 0.16, riser: 0 },
  pistol: { y: 0.0115, z: -0.035, riser: 0, onAction: true },
  akimbo: { y: 0.0115, z: -0.035, riser: 0, onAction: true },
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
  const base = rail.onAction ? M17_BORE : 0;
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
  /** Front cap of a tube magazine: an extension screws on here. */
  tube?: [number, number, number];
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

/** HK's black paint over phosphated steel. */
const HK = 0x222326;

/**
 * Heckler & Koch MP5A2 (operator's manual): 680 mm with the fixed stock, a 225 mm barrel, sights
 * 340 mm apart. Drawn from the back of the receiver and the bore line: the stamped receiver with
 * the bolt tube along its top, which runs on forward over the barrel as the cocking tube.
 */
function mp5(): Spec {
  const d = drawn(-0.1, 0.05);
  const b = new Builder();
  b.as(SURF.steel)
    .plate(d.p([[0, -22], [0, 22], [287, 22], [287, -22], [281, -22], [281, -47], [236, -50], [232, -22]]), 0.038, HK, 0.003)
    .loft([
      { z: d.z(0), rx: 0.0135 }, { z: d.z(287), rx: 0.0135 }, { z: d.z(287), rx: 0.0115 }, { z: d.z(430), rx: 0.0115 },
      { z: d.z(430), rx: 0.0128 }, { z: d.z(437), rx: 0.0128 },
    ], HK, { segments: 12 }, 0, d.y(27))
    // Pressed ribs along the sides, the end cap.
    .slab(0.0392, 0.004, 0.17, 0.001, HK, 0, d.y(8), d.z(110))
    .slab(0.0392, 0.004, 0.2, 0.001, HK, 0, d.y(-12), d.z(125))
    .slab(0.04, 0.062, 0.008, 0.002, 0x1a1b1d, 0, d.y(9), d.z(-2))
    // Ejection port on the right, the bolt showing in it.
    .box(0.002, 0.016, 0.046, PORT, -0.0185, d.y(13), d.z(228))
    .as(SURF.blued).box(0.002, 0.008, 0.04, 0x4c4f54, -0.019, d.y(14), d.z(228))
    .as(SURF.steel)
    // Cocking handle in its slot on the left of the tube.
    .box(0.002, 0.005, 0.11, PORT, 0.0112, d.y(29), d.z(355))
    .pin(0.004, 0.02, HK, 0.02, d.y(29), d.z(398))
    .pin(0.0062, 0.009, 0x1a1b1d, 0.031, d.y(29), d.z(398), 10)
    // Rear sight: the diopter drum on its base.
    .slab(0.03, 0.007, 0.034, 0.0015, HK, 0, d.y(41), d.z(85))
    .box(0.006, 0.012, 0.012, HK, 0.012, d.y(48), d.z(85))
    .box(0.006, 0.012, 0.012, HK, -0.012, d.y(48), d.z(85))
    .ring(0.006, 0.004, d.z(79), d.z(91), BLACK, 0, d.y(50), 10)
    // Front sight holder with its hood, the post and a tritium dot.
    .plate(d.p([[419, -11], [419, 39], [423, 41], [431, 41], [435, 39], [435, -11]]), 0.024, HK, 0.003)
    .ring(0.011, 0.003, d.z(421), d.z(433), BLACK, 0, d.y(50), 12)
    .box(0.003, 0.012, 0.004, BLACK, 0, d.y(44), d.z(427))
    .glow(0.0024, 0.0024, 0.0008, 0x9dff6a, 0, d.y(48.5), d.z(424.6))
    // Barrel with the three lugs.
    .loft([
      { z: d.z(287), rx: 0.0075 }, { z: d.z(455), rx: 0.0075 }, { z: d.z(455), rx: 0.0088 }, { z: d.z(459), rx: 0.0088 },
      { z: d.z(459), rx: 0.0075 }, { z: d.z(469), rx: 0.0075 }, { z: d.z(469), rx: 0.0086 }, { z: d.z(480), rx: 0.0086 },
    ], PARK, { segments: 10 }, 0, d.y(0))
    .tube(0.0046, d.z(479.6), d.z(480.3), PORT, 0, d.y(0), 8)
    // Pins that hold the stock and the grip housing.
    .pin(0.0035, 0.0395, 0x3a3c40, 0, d.y(-12), d.z(8))
    .pin(0.0035, 0.0395, 0x3a3c40, 0, d.y(-34), d.z(240));
  // Handguard, grip housing with its guard, trigger and selector.
  b.as(SURF.polymer)
    .plate(d.p([[288, -32], [288, 15], [293, 21], [414, 21], [419, 15], [419, -22], [413, -27]]), 0.046, POLY, 0.008)
    .plate(d.p([[100, -22], [232, -22], [232, -46], [168, -46], [163, -52], [143, -127], [138, -132], [104, -126], [100, -119], [110, -64], [100, -42]]), 0.032, POLY, 0.005)
    .plate(d.p([[232, -44], [232, -58], [224, -70], [172, -70], [163, -56], [167, -50], [175, -66], [221, -66], [228, -57], [228, -44]]), 0.014, POLY, 0.002)
    .pin(0.0055, 0.035, POLY, 0, d.y(-33), d.z(150), 10)
    .slab(0.003, 0.005, 0.024, 0.001, POLY, 0.0172, d.y(-31), d.z(162), -0.25)
    .slab(0.003, 0.012, 0.02, 0.001, POLY, 0, d.y(-54), d.z(236), 0.3)
    .as(SURF.rubber)
    .box(0.0006, 0.003, 0.003, 0xd8d8d8, 0.0162, d.y(-26), d.z(168))
    .box(0.0006, 0.003, 0.003, 0xc22a1c, 0.0162, d.y(-26), d.z(176))
    .box(0.0006, 0.003, 0.003, 0xc22a1c, 0.0162, d.y(-26), d.z(183))
    .as(SURF.steel)
    .plate(d.p([[196, -46], [201, -46], [199.5, -56], [195, -64], [192, -63], [195.5, -55]]), 0.006, STEEL, 0.001);
  // Fixed stock: the collar on the receiver, the hollow-looking body, a ribbed butt.
  b.as(SURF.polymer)
    .plate(d.p([[-6, 40], [-30, 38], [-186, 24], [-197, 18], [-197, -90], [-190, -96], [-178, -94], [-70, -30], [-30, -24], [-6, -24]]), 0.04, POLY, 0.006)
    .plate(d.p([[-40, 20], [-170, 10], [-170, -70], [-80, -18], [-40, -12]]), 0.0412, 0x151517, 0.0006)
    .as(SURF.rubber).slab(0.04, 0.112, 0.005, 0.0015, 0x101011, 0, d.y(-36), d.z(-197.5))
    .as(null);
  // 30-round magazine, curved forward.
  const at: V3 = [0, d.y(-22), d.z(257)];
  const md = drawn(-0.1 - at[2], 0.05 - at[1]);
  const mag = new Builder().as({ rough: 0.5, metal: 0.6, wear: 0.5, worn: 0x7e8185 })
    .plate(md.p([[239, -24], [277, -24], [279, -80], [286, -130], [297, -175], [303, -192], [268, -203], [262, -186], [252, -138], [243, -84]]), 0.021, 0x242528, 0.002)
    .box(0.0216, 0.12, 0.003, 0x1c1d1f, 0, md.y(-110), md.z(264), -0.16)
    .as(SURF.polymer).plate(md.p([[306, -190], [304.5, -195], [266, -207.5], [265, -202.5]]), 0.024, 0x1d1d1f, 0.0015);
  return {
    body: b, mag: { b: mag, at },
    muzzle: [0, 0.05, d.z(480)], fore: [0.035, 0.0, 0.25], eject: [-0.03, d.y(14), d.z(228)], stock: [0, 0.035, d.z(-200)], bolt: [0.03, d.y(29), d.z(398)],
    under: [0, d.y(-30), d.z(350)],
  };
}

/**
 * Remington 870 Police with the 18 inch barrel and walnut furniture: 978 mm long, a 356 mm length
 * of pull, the four-round tube ending short of the muzzle. Drawn from the back of the receiver and
 * the bore line; the fore-end stands a full stroke ahead of the receiver, as it has to.
 */
function m870(): Spec {
  const d = drawn(0.045, 0.058);
  const b = new Builder();
  b.as(SURF.steel)
    .plate(d.p([[0, -42], [0, 10], [6, 16], [215, 16], [215, -42]]), 0.04, 0x222326, 0.005)
    // Ejection port with the bright bolt in it, the loading port underneath.
    .box(0.002, 0.018, 0.092, PORT, -0.0202, d.y(3), d.z(145))
    .as({ rough: 0.25, metal: 0.95 }).box(0.002, 0.012, 0.074, 0x8e9296, -0.0206, d.y(3.5), d.z(138))
    .as(SURF.steel)
    .box(0.024, 0.002, 0.1, PORT, 0, d.y(-42.4), d.z(135))
    .pin(0.003, 0.0405, 0x3a3c40, 0, d.y(-24), d.z(40))
    .pin(0.003, 0.0405, 0x3a3c40, 0, d.y(-30), d.z(108))
    // Barrel, the bead on its pedestal, the ring that ties it to the magazine tube.
    .loft([{ z: d.z(215), rx: 0.0135 }, { z: d.z(657), rx: 0.0108 }], PARK, { segments: 12 }, 0, d.y(0))
    .tube(0.0092, d.z(656.6), d.z(657.3), PORT, 0, d.y(0), 10)
    .box(0.006, 0.008, 0.008, STEEL, 0, d.y(14), d.z(642))
    .glow(0.005, 0.005, 0.005, 0xff8a2a, 0, d.y(20.5), d.z(642))
    .slab(0.013, 0.022, 0.014, 0.002, PARK, 0, d.y(-15), d.z(551))
    .loft([{ z: d.z(215), rx: 0.0125 }, { z: d.z(560), rx: 0.0125 }, { z: d.z(560), rx: 0.014 }, { z: d.z(572), rx: 0.014 }, { z: d.z(575), rx: 0.011 }], 0x1a1b1d, { segments: 10 }, 0, d.y(-29));
  // Trigger plate: guard, trigger, the cross-bolt safety behind it.
  b.as(SURF.anodized)
    .plate(d.p([[5, -42], [8, -70], [20, -78], [55, -78], [66, -64], [70, -42], [66, -42], [62, -62], [53, -74], [22, -74], [12, -68], [9, -42]]), 0.012, 0x1c1d1f, 0.002)
    .as(SURF.steel)
    .plate(d.p([[36, -42], [41, -42], [39.5, -54], [35, -62], [32, -61], [35.5, -52]]), 0.006, STEEL, 0.001)
    .pin(0.003, 0.016, 0x3a3c40, 0, d.y(-50), d.z(14));
  // Walnut stock with its semi-pistol grip, a rubber recoil pad.
  b.as(SURF.wood)
    .plate(d.p([[2, 12], [-20, 8], [-55, -12], [-100, -16], [-110, -13], [-309, -40], [-305, -172], [-88, -94], [-66, -94], [-58, -86], [-30, -52], [2, -42]]), 0.042, WOOD, 0.009)
    .as(SURF.polymer).slab(0.0425, 0.004, 0.02, 0.001, 0x141415, 0, d.y(-95), d.z(-77))
    .as(SURF.rubber).slab(0.042, 0.136, 0.014, 0.003, 0x101011, 0, d.y(-106), d.z(-313), -0.03)
    .as(null);
  // Fore-end: ribbed walnut round the magazine tube, on two steel action bars.
  const at: V3 = [0, d.y(-29), d.z(392)];
  const ribs: Ring[] = [{ z: -0.086, rx: 0.019, ry: 0.018, y: 0.003 }];
  for (let k = 0; k < 10; k++) {
    const z0 = -0.081 + k * 0.0162;
    for (const [z, deep] of [[z0, 1], [z0 + 0.002, 0], [z0 + 0.0142, 0], [z0 + 0.0162, 1]] as const) ribs.push({ z, rx: 0.024 - deep * 0.0016, ry: 0.0215 - deep * 0.0016, y: 0.004 });
  }
  ribs.push({ z: 0.086, rx: 0.019, ry: 0.018, y: 0.003 });
  const pump = new Builder().as(SURF.wood)
    .loft(ribs, WOOD, { segments: 12 })
    .as(SURF.steel)
    .box(0.003, 0.008, 0.13, 0x18191a, 0.0142, 0.006, -0.15)
    .box(0.003, 0.008, 0.13, 0x18191a, -0.0142, 0.006, -0.15)
    .tube(0.0138, 0.086, 0.091, 0x18191a, 0, 0, 10)
    .as(null);
  return {
    body: b, action: { b: pump, at },
    muzzle: [0, d.y(0), d.z(657)], fore: [0.026, at[1] - 0.06, at[2]], eject: [-0.03, d.y(3), d.z(145)], stock: [0, -0.03, d.z(-321)], bolt: [0.026, at[1] - 0.06, at[2]],
    // The pump slides: the laser rides on the receiver's side.
    under: [0.031, d.y(-2), d.z(150)],
    tube: [0, d.y(-29), d.z(572)],
  };
}

/**
 * Mk 14 Mod 0 Enhanced Battle Rifle: an M14 action with a 457 mm barrel in the Sage aluminium
 * chassis. 889 mm with the stock run in; drawn with it pulled out 90 mm, to the M14's own 337 mm
 * length of pull plus the pad. Measured from the bolt face and the bore line.
 */
function mk14(): Spec {
  const d = drawn(0.23, 0.06);
  const b = new Builder();
  const GROOVE = 0x3b3529;
  // Chassis: the bed under the action with the magazine well, then the railed fore-end.
  b.as({ rough: 0.55, metal: 0.4, wear: 0.45, worn: 0x8d8f92 })
    .plate(d.p([[-228, -58], [-228, -8], [-200, 0], [30, 0], [30, -40], [0, -46], [-88, -46], [-96, -58]]), 0.05, TAN, 0.004)
    .plate(d.p([[30, -34], [30, 24], [325, 24], [330, 18], [330, -28], [322, -34]]), 0.05, TAN, 0.004)
    .slab(0.004, 0.021, 0.27, 0.001, TAN, 0.0265, d.y(0), d.z(180))
    .slab(0.004, 0.021, 0.27, 0.001, TAN, -0.0265, d.y(0), d.z(180))
    .slab(0.021, 0.004, 0.27, 0.001, TAN, 0, d.y(-35.5), d.z(180))
    // Top rail from the clip guide to the front of the fore-end.
    .slab(0.021, 0.007, 0.47, 0.001, TAN, 0, d.y(27.5), d.z(70))
    .slab(0.02, 0.014, 0.03, 0.002, TAN, 0, d.y(18), d.z(-150));
  for (let k = 0; k < 13; k++) {
    const z = d.z(60 + k * 20);
    b.box(0.0046, 0.0215, 0.005, GROOVE, 0.0265, d.y(0), z).box(0.0046, 0.0215, 0.005, GROOVE, -0.0265, d.y(0), z).box(0.0215, 0.0046, 0.005, GROOVE, 0, d.y(-35.5), z);
  }
  for (let k = 0; k < 47; k++) b.box(0.0212, 0.003, 0.0052, TAN, 0, d.y(31), d.z(-160 + k * 10));
  // The M14 receiver: heel with the sight ears, the open bolt raceway, the ring round the breech.
  b.as(SURF.steel)
    .plate(d.p([[-215, 0], [-215, 20], [-182, 20], [-174, 12], [-10, 12], [-4, 18], [25, 18], [25, 0]]), 0.036, PARK, 0.003)
    .pin(0.0065, 0.052, PARK, 0, d.y(15), d.z(-197), 10)
    .as(SURF.blued).slab(0.02, 0.008, 0.095, 0.002, 0x3c3e42, -0.004, d.y(12.5), d.z(-66))
    // Operating rod along the right side, its handle behind the breech.
    .as(SURF.steel)
    .slab(0.006, 0.01, 0.23, 0.0015, PARK, -0.0205, d.y(6), d.z(40))
    .slab(0.012, 0.011, 0.018, 0.002, PARK, -0.027, d.y(7), d.z(-78))
    .box(0.002, 0.012, 0.06, PORT, -0.0185, d.y(6), d.z(-40))
    // Barrel past the fore-end, the flash hider, the front sight on its base.
    .loft([
      { z: d.z(25), rx: 0.0105 }, { z: d.z(330), rx: 0.0088 }, { z: d.z(440), rx: 0.008 }, { z: d.z(440), rx: 0.0112 },
      { z: d.z(486), rx: 0.0105 }, { z: d.z(492), rx: 0.0088 },
    ], PARK, { segments: 12 }, 0, d.y(0))
    .tube(0.0046, d.z(491.6), d.z(492.3), PORT, 0, d.y(0), 8)
    .plate(d.p([[443, 8], [446, 29], [462, 29], [466, 8]]), 0.012, PARK, 0.002)
    .plate(d.p([[446, 29], [446, 39], [450, 41], [458, 41], [462, 39], [462, 29]]), 0.002, PARK, 0.0004, 0.0075)
    .plate(d.p([[446, 29], [446, 39], [450, 41], [458, 41], [462, 39], [462, 29]]), 0.002, PARK, 0.0004, -0.0075)
    .box(0.002, 0.01, 0.003, BLACK, 0, d.y(33), d.z(454));
  for (const a of [0, 1.26, -1.26, 2.51, -2.51]) b.box(0.003, 0.003, 0.026, PORT, Math.sin(a) * 0.0105, d.y(0) + Math.cos(a) * 0.0105, d.z(466), 0, 0, -a);
  // Trigger guard and trigger.
  b.plate(d.p([[-160, -58], [-158, -80], [-150, -86], [-115, -86], [-104, -74], [-100, -58], [-104, -58], [-108, -72], [-117, -82], [-148, -82], [-155, -77], [-156, -58]]), 0.012, PARK, 0.002)
    .plate(d.p([[-138, -58], [-133, -58], [-134.5, -68], [-139, -76], [-142, -75], [-139, -67]]), 0.006, STEEL, 0.001);
  // Pistol grip.
  b.as(SURF.polymer)
    .plate(d.p([[-164, -56], [-166, -82], [-172, -86], [-174, -94], [-178, -106], [-198, -156], [-238, -148], [-214, -72], [-219, -58], [-210, -54], [-200, -56]]), 0.028, POLY, 0.007);
  // Stock: the tube it slides on, the cheek rest, the butt on its strut.
  b.as(SURF.anodized)
    .loft([{ z: d.z(-228), rx: 0.013 }, { z: d.z(-430), rx: 0.013 }], 0x2a2b2e, { segments: 10 }, 0, d.y(-14))
    .plate(d.p([[-228, -30], [-228, -44], [-452, -74], [-448, -58]]), 0.014, 0x2a2b2e, 0.002)
    .as({ rough: 0.55, metal: 0.4, wear: 0.45, worn: 0x8d8f92 })
    .plate(d.p([[-252, 4], [-252, 20], [-258, 24], [-398, 24], [-408, 16], [-408, 4]]), 0.034, TAN, 0.006)
    .slab(0.018, 0.009, 0.11, 0.002, TAN, 0, d.y(1), d.z(-330))
    .as(SURF.polymer)
    .plate(d.p([[-428, 18], [-434, 24], [-482, 24], [-482, -96], [-466, -100], [-448, -60], [-428, -36]]), 0.04, POLY, 0.004)
    .as(SURF.rubber).slab(0.04, 0.124, 0.008, 0.002, 0x101011, 0, d.y(-37), d.z(-485))
    .as(null);
  // 20-round steel magazine.
  const at: V3 = [0, d.y(-40), d.z(-45)];
  const md = drawn(0.23 - at[2], 0.06 - at[1]);
  const mag = new Builder().as({ rough: 0.5, metal: 0.6, wear: 0.5, worn: 0x7e8185 })
    .plate(md.p([[-84, -30], [-6, -30], [-2, -150], [-80, -140]]), 0.0245, 0x222325, 0.002)
    .box(0.0252, 0.1, 0.004, 0x1c1d1f, 0, md.y(-90), md.z(-30))
    .box(0.0252, 0.1, 0.004, 0x1c1d1f, 0, md.y(-90), md.z(-58))
    .plate(md.p([[-1, -148], [0, -153], [-82, -143.5], [-81, -138.5]]), 0.026, 0x1a1b1d, 0.0012);
  return {
    body: b, mag: { b: mag, at },
    muzzle: [0, 0.06, d.z(492)], fore: [0.04, -0.008, 0.33], eject: [-0.035, 0.075, d.z(-60)], stock: [0, 0.03, d.z(-489)], bolt: [0.02, d.y(16), d.z(-90)],
    under: [0, d.y(-37.5), d.z(110)],
    irons: (r) => r.box(0.02, 0.012, 0.018, BLACK, 0, 0.086, d.z(-197)).ring(0.0035, 0.002, d.z(-201), d.z(-193), BLACK, 0, 0.098, 10),
  };
}

/** The M4's A2 pistol grip, drawn `ds` mm ahead of where the M4 carries it (the hand closes on the same place). */
function a2Grip(d: ReturnType<typeof drawn>, ds: number, dh = 0): P2[] {
  return d.p(([[-150, -50], [-152, -72], [-158, -76], [-160, -84], [-164, -96], [-184, -146], [-224, -138], [-200, -62], [-205, -48], [-196, -44], [-186, -50]] as P2[]).map(([z, y]) => [z + ds, y + dh] as P2));
}
/** A trigger guard as a strip, and the trigger in it (`s` is the trigger, `h` the housing it hangs from). */
function guard(b: Builder, d: ReturnType<typeof drawn>, s: number, h: number, color: number): void {
  b.plate(d.p([[s - 24, h + 2], [s - 22, h - 20], [s - 16, h - 25], [s + 34, h - 25], [s + 42, h - 16], [s + 44, h + 2], [s + 40, h + 2], [s + 38, h - 14], [s + 32, h - 21], [s - 15, h - 21], [s - 18, h - 17], [s - 20, h + 2]]), 0.012, color, 0.002)
    .plate(d.p([[s - 2, h], [s + 3, h], [s + 1.5, h - 10], [s - 3, h - 18], [s - 6, h - 17], [s - 3, h - 9]]), 0.006, STEEL, 0.001);
}

/**
 * M249 Squad Automatic Weapon (TM 9-1005-201-10): 1,041 mm long with a 465 mm barrel, fed from a
 * 200-round box under the receiver. Measured from the trigger and the bore line.
 */
function m249(): Spec {
  const d = drawn(0.08, 0.05);
  const b = new Builder();
  b.as(SURF.steel)
    // Stamped receiver, the feed cover hinged over it with a short rail on top.
    .plate(d.p([[-75, -40], [-75, 28], [235, 28], [235, -40]]), 0.052, DARK, 0.004)
    .plate(d.p([[-52, 28], [-52, 44], [-42, 50], [178, 50], [204, 36], [204, 28]]), 0.05, 0x202124, 0.005)
    .slab(0.021, 0.005, 0.13, 0.001, 0x202124, 0, d.y(52), d.z(85));
  for (let k = 0; k < 13; k++) b.box(0.0212, 0.003, 0.0052, 0x202124, 0, d.y(55.5), d.z(25 + k * 10));
  b.slab(0.054, 0.008, 0.2, 0.002, DARK, 0, d.y(-8), d.z(70))
    // Cocking handle in its slot on the right, the ejection port low behind the box.
    .box(0.002, 0.006, 0.17, PORT, -0.0262, d.y(10), d.z(90))
    .slab(0.014, 0.012, 0.02, 0.003, 0x1a1b1d, -0.033, d.y(10), d.z(150))
    .box(0.002, 0.02, 0.05, PORT, -0.0262, d.y(-26), d.z(110))
    // Rear sight on the back of the receiver.
    .slab(0.03, 0.01, 0.03, 0.002, BLACK, 0, d.y(54), d.z(-40))
    .box(0.005, 0.016, 0.012, BLACK, 0.0125, d.y(66), d.z(-40))
    .box(0.005, 0.016, 0.012, BLACK, -0.0125, d.y(66), d.z(-40))
    .ring(0.006, 0.004, d.z(-46), d.z(-34), BLACK, 0, d.y(75), 10)
    // Barrel with the gas cylinder under it, the gas block and the hooded front post, the flash hider.
    .loft([
      { z: d.z(191), rx: 0.0135 }, { z: d.z(440), rx: 0.012 }, { z: d.z(440), rx: 0.016 }, { z: d.z(462), rx: 0.016 },
      { z: d.z(462), rx: 0.0105 }, { z: d.z(662), rx: 0.0095 }, { z: d.z(662), rx: 0.012 }, { z: d.z(705), rx: 0.0115 }, { z: d.z(711), rx: 0.009 },
    ], PARK, { segments: 12 }, 0, d.y(0))
    .tube(0.0046, d.z(710.6), d.z(711.3), PORT, 0, d.y(0), 8)
    .loft([{ z: d.z(235), rx: 0.009 }, { z: d.z(462), rx: 0.009 }, { z: d.z(462), rx: 0.011 }, { z: d.z(476), rx: 0.011 }], PARK, { segments: 8 }, 0, d.y(-26))
    .plate(d.p([[442, 12], [446, 60], [458, 60], [462, 12]]), 0.013, PARK, 0.002)
    .plate(d.p([[446, 60], [446, 74], [449, 77], [455, 77], [458, 74], [458, 60]]), 0.002, PARK, 0.0004, 0.008)
    .plate(d.p([[446, 60], [446, 74], [449, 77], [455, 77], [458, 74], [458, 60]]), 0.002, PARK, 0.0004, -0.008)
    .box(0.0026, 0.015, 0.0036, BLACK, 0, d.y(67.5), d.z(452));
  for (const a of [0, 1.26, -1.26, 2.51, -2.51]) b.box(0.003, 0.003, 0.024, PORT, Math.sin(a) * 0.0112, d.y(0) + Math.cos(a) * 0.0112, d.z(684), 0, 0, -a);
  // Folded bipod: the yoke on the gas cylinder, the legs back under the handguard.
  b.slab(0.04, 0.014, 0.02, 0.003, PARK, 0, d.y(-36), d.z(468))
    .box(0.007, 0.007, 0.21, PARK, 0.017, d.y(-53), d.z(365))
    .box(0.007, 0.007, 0.21, PARK, -0.017, d.y(-53), d.z(365))
    .box(0.012, 0.01, 0.016, PARK, 0.017, d.y(-53), d.z(258))
    .box(0.012, 0.01, 0.016, PARK, -0.017, d.y(-53), d.z(258));
  guard(b, d, 8, -52, PARK);
  // Heat shield over the barrel, the handguard under it, the carry handle folded to the right.
  b.as(SURF.polymer)
    .plate(d.p([[238, 12], [238, 20], [244, 24], [432, 22], [438, 16], [438, 12]]), 0.034, POLY, 0.005)
    .plate(d.p([[236, -48], [236, -10], [432, -10], [432, -38], [422, -46]]), 0.058, POLY, 0.009)
    .plate(d.p([[-70, -40], [52, -40], [50, -52], [-66, -52]]), 0.034, POLY, 0.003)
    .plate(a2Grip(d, 136), 0.028, POLY, 0.007);
  for (let k = 0; k < 6; k++) b.box(0.0345, 0.003, 0.018, PORT, 0, d.y(22.6 - k * 0.25), d.z(262 + k * 30));
  b.as(SURF.steel)
    .box(0.01, 0.006, 0.012, PARK, -0.02, d.y(14), d.z(262))
    .box(0.01, 0.006, 0.012, PARK, -0.02, d.y(14), d.z(332))
    .as(SURF.polymer).loft([{ z: d.z(256), rx: 0.0085 }, { z: d.z(338), rx: 0.0085 }], POLY, { segments: 8 }, -0.033, d.y(16));
  // Solid stock with its shoulder rest.
  b.plate(d.p([[-75, 30], [-108, 36], [-320, 36], [-327, 30], [-327, -74], [-318, -80], [-300, -80], [-120, -42], [-75, -40]]), 0.046, POLY, 0.006)
    .plate(d.p([[-125, 22], [-300, 22], [-300, -60], [-140, -28]]), 0.0472, 0x151517, 0.0006)
    .as(SURF.rubber).slab(0.046, 0.112, 0.006, 0.002, 0x101011, 0, d.y(-22), d.z(-329))
    .as(null);
  // The 200-round box under the receiver, the belt climbing its left side into the feed tray.
  const at: V3 = [0.004, d.y(-40), d.z(165)];
  const mag = new Builder().as(SURF.polymer)
    .slab(0.078, 0.128, 0.13, 0.006, OLIVE, 0, -0.066, 0)
    .slab(0.08, 0.012, 0.132, 0.003, 0x2c3125, 0, -0.008, 0)
    .box(0.0792, 0.004, 0.1, 0x2c3125, 0, -0.07, 0)
    .box(0.03, 0.02, 0.004, 0x2c3125, 0, -0.04, 0.066)
    .as(SURF.brass)
    .box(0.01, 0.07, 0.032, BRASS, 0.034, 0.03, -0.02)
    .box(0.026, 0.008, 0.032, BRASS, 0.024, 0.066, -0.02);
  for (let k = 0; k < 6; k++) mag.box(0.0104, 0.003, 0.033, 0x4a4b4e, 0.034, 0.002 + k * 0.011, -0.02);
  return {
    body: b, mag: { b: mag, at },
    muzzle: [0, 0.05, d.z(711)], fore: [0.04, -0.024, d.z(320)], eject: [-0.035, 0.02, d.z(110)], stock: [0, 0.03, d.z(-330)], bolt: [0.03, d.y(10), d.z(100)],
  };
}

/** A rail's cross slots along the top of a part: `n` teeth from `s0`, 10 mm apart. */
function teeth(b: Builder, d: ReturnType<typeof drawn>, s0: number, n: number, h: number, color: number): void {
  for (let k = 0; k < n; k++) b.box(0.0212, 0.003, 0.0052, color, 0, d.y(h), d.z(s0 + k * 10));
}

/**
 * FN SCAR-H (Mk 17 Mod 0) with the 406 mm barrel: 965 mm with the stock out. One long aluminium
 * upper with the rail down its whole top, a polymer lower, the folding stock with its cheek piece.
 * Measured from the trigger and the bore line.
 */
function scarH(): Spec {
  const d = drawn(0.08, 0.055);
  const b = new Builder();
  const LOWER = 0x97835f, SLOT = 0x4d412e;
  b.as({ rough: 0.5, metal: 0.5, wear: 0.45, worn: 0xb9b4a6 })
    .plate(d.p([[-85, -24], [-85, 42], [-80, 47], [396, 47], [400, 42], [400, -30], [190, -30], [185, -24]]), 0.05, FDE, 0.004)
    .slab(0.021, 0.004, 0.47, 0.001, FDE, 0, d.y(47.5), d.z(157))
    // Side and bottom rails of the fore-end.
    .slab(0.004, 0.021, 0.15, 0.001, FDE, 0.0265, d.y(10), d.z(315))
    .slab(0.004, 0.021, 0.15, 0.001, FDE, -0.0265, d.y(10), d.z(315))
    .slab(0.021, 0.004, 0.18, 0.001, FDE, 0, d.y(-31.5), d.z(300));
  teeth(b, d, -78, 48, 50.5, FDE);
  for (let k = 0; k < 7; k++) {
    const z = d.z(255 + k * 20);
    b.box(0.0046, 0.0215, 0.005, SLOT, 0.0265, d.y(10), z).box(0.0046, 0.0215, 0.005, SLOT, -0.0265, d.y(10), z);
  }
  for (let k = 0; k < 8; k++) b.box(0.0215, 0.0046, 0.005, SLOT, 0, d.y(-31.5), d.z(225 + k * 20));
  // Lightening slots along the upper, the ejection port with the carrier in it, the charging handle.
  for (let k = 0; k < 4; k++) b.box(0.0506, 0.008, 0.03, SLOT, 0, d.y(30), d.z(215 + k * 45));
  b.box(0.002, 0.02, 0.066, PORT, -0.0252, d.y(10), d.z(138))
    .as(SURF.blued).box(0.002, 0.011, 0.058, 0x4c4f54, -0.0256, d.y(11), d.z(136))
    .as(SURF.steel)
    .box(0.002, 0.006, 0.15, PORT, -0.0254, d.y(-8), d.z(265))
    .slab(0.018, 0.01, 0.014, 0.003, BLACK, -0.034, d.y(-8), d.z(200))
    // Gas block with the folded front sight, barrel, the muzzle brake.
    .slab(0.03, 0.03, 0.03, 0.004, PARK, 0, d.y(8), d.z(414))
    .slab(0.016, 0.01, 0.03, 0.002, BLACK, 0, d.y(28), d.z(414))
    .loft([
      { z: d.z(400), rx: 0.0102 }, { z: d.z(583), rx: 0.009 }, { z: d.z(583), rx: 0.0118 }, { z: d.z(620), rx: 0.0118 }, { z: d.z(625), rx: 0.0095 },
    ], PARK, { segments: 12 }, 0, d.y(0))
    .tube(0.0052, d.z(624.6), d.z(625.3), PORT, 0, d.y(0), 8);
  for (const a of [0.6, -0.6, 1.57, -1.57, 2.54, -2.54]) b.box(0.003, 0.003, 0.022, PORT, Math.sin(a) * 0.0115, d.y(0) + Math.cos(a) * 0.0115, d.z(602), 0, 0, -a);
  guard(b, d, 8, -50, 0x1c1d1f);
  // Holographic sight: a rectangular window on the rail, the reticle at its front pane.
  const hy = d.y(52), hz = d.z(85);
  b.as(SURF.anodized)
    .slab(0.036, 0.02, 0.07, 0.003, BLACK, 0, hy + 0.01, hz - 0.01)
    .box(0.046, 0.006, 0.04, BLACK, 0, hy + 0.054, hz)
    .box(0.006, 0.036, 0.04, BLACK, 0.02, hy + 0.036, hz)
    .box(0.006, 0.036, 0.04, BLACK, -0.02, hy + 0.036, hz)
    .box(0.046, 0.004, 0.04, BLACK, 0, hy + 0.02, hz)
    .glow(0.0024, 0.0024, 0.0008, 0xff2414, 0, hy + 0.036, hz + 0.018)
    .glow(0.012, 0.0008, 0.0008, 0xff2414, 0, hy + 0.0425, hz + 0.018)
    .glow(0.012, 0.0008, 0.0008, 0xff2414, 0, hy + 0.0295, hz + 0.018)
    .glow(0.0008, 0.012, 0.0008, 0xff2414, 0.0065, hy + 0.036, hz + 0.018)
    .glow(0.0008, 0.012, 0.0008, 0xff2414, -0.0065, hy + 0.036, hz + 0.018);
  // Polymer lower with the magazine well, the grip, the stock on its hinge.
  b.as({ rough: 0.82, metal: 0, wear: 0.25, worn: 0xb09a74 })
    .plate(d.p([[-85, -24], [183, -24], [181, -64], [97, -66], [92, -50], [-62, -50], [-85, -40]]), 0.04, LOWER, 0.004)
    .plate(d.p([[-87, 42], [-87, -22], [-120, -26], [-238, -34], [-262, -92], [-298, -100], [-332, -96], [-332, 40], [-300, 46], [-112, 46]]), 0.044, LOWER, 0.006)
    .plate(d.p([[-130, 46], [-134, 57], [-250, 57], [-262, 46]]), 0.036, LOWER, 0.006)
    .plate(d.p([[-135, 30], [-290, 30], [-290, -76], [-250, -26], [-135, -18]]), 0.0452, 0x7f6d4e, 0.0006)
    .as(SURF.polymer)
    .plate(a2Grip(d, 136), 0.028, POLY, 0.007)
    .pin(0.005, 0.042, POLY, 0, d.y(-34), d.z(-30), 10)
    .slab(0.003, 0.005, 0.022, 0.001, POLY, 0.0212, d.y(-33), d.z(-20), -0.2)
    .as(SURF.rubber).slab(0.044, 0.13, 0.006, 0.002, 0x101011, 0, d.y(-27), d.z(-334))
    .as(null);
  // 20-round steel magazine.
  const at: V3 = [0, d.y(-24), d.z(138)];
  const md = drawn(0.08 - at[2], 0.055 - at[1]);
  const mag = new Builder().as({ rough: 0.5, metal: 0.6, wear: 0.5, worn: 0x7e8185 })
    .plate(md.p([[100, -30], [176, -30], [181, -158], [105, -168]]), 0.026, 0x232427, 0.002)
    .box(0.0266, 0.1, 0.004, 0x1c1d1f, 0, md.y(-105), md.z(127))
    .box(0.0266, 0.1, 0.004, 0x1c1d1f, 0, md.y(-105), md.z(155))
    .as(SURF.polymer).plate(md.p([[183, -156], [183.5, -161], [104, -171.5], [103.5, -166.5]]), 0.028, 0x1a1b1d, 0.0012);
  return {
    body: b, mag: { b: mag, at },
    muzzle: [0, 0.055, d.z(625)], fore: [0.035, -0.012, d.z(290)], eject: [-0.03, d.y(10), d.z(138)], stock: [0, 0.03, d.z(-337)], bolt: [-0.036, d.y(-8), d.z(200)],
  };
}

/**
 * A telescopic sight along the barrel, from the eyepiece at `z0` to the objective at `z1`: the
 * tube with its turrets, a bell at each end, two rings standing on the rail at height `rail`.
 */
function scope(b: Builder, y: number, z0: number, z1: number, rail: number, big = 1): void {
  const len = z1 - z0, t = 0.0165 * big, eye = 0.022 * big, obj = 0.028 * big, body = 0x121315;
  b.as(SURF.anodized)
    .loft([
      { z: z0, rx: eye * 0.94 }, { z: z0 + 0.01, rx: eye }, { z: z0 + len * 0.15, rx: eye }, { z: z0 + len * 0.2, rx: t },
      { z: z0 + len * 0.64, rx: t }, { z: z0 + len * 0.78, rx: obj }, { z: z1 - 0.004, rx: obj }, { z: z1, rx: obj * 0.95 },
    ], body, { segments: 12 }, 0, y)
    .slab(t * 2.3, t * 2.3, 0.03, 0.004, body, 0, y, z0 + len * 0.44)
    .slab(0.017 * big, 0.016, 0.017 * big, 0.003, body, 0, y + t + 0.008, z0 + len * 0.44)
    .pin(0.009 * big, t * 2 + 0.03, body, 0, y, z0 + len * 0.44, 10);
  for (const k of [0.29, 0.57]) {
    const z = z0 + len * k;
    b.slab(0.024, y - rail, 0.014, 0.002, BLACK, 0, (y + rail) / 2, z)
      .loft([{ z: z - 0.007, rx: t + 0.0045 }, { z: z + 0.007, rx: t + 0.0045 }], BLACK, { segments: 12 }, 0, y);
  }
  b.as({ rough: 0.08, metal: 0.6 })
    .tube(obj * 0.86, z1 - 0.0004, z1 + 0.0006, 0x1d3040, 0, y, 12)
    .tube(eye * 0.8, z0 - 0.0006, z0 + 0.0004, 0x1d3040, 0, y, 12)
    .as(null);
}

/**
 * Barrett M107 (TM 9-1005-239-10): 1,448 mm long with the 737 mm barrel, which runs back inside
 * the long stamped upper. Measured from the trigger and the bore line.
 */
function m107(): Spec {
  const d = drawn(0.08, 0.06);
  const b = new Builder();
  b.as(SURF.steel)
    .plate(d.p([[-340, -18], [-340, 40], [-330, 48], [425, 48], [432, 40], [432, -18]]), 0.058, DARK, 0.005)
    .slab(0.021, 0.004, 0.46, 0.001, 0x202124, 0, d.y(49), d.z(75));
  teeth(b, d, -150, 46, 52, 0x202124);
  // Cooling slots round the barrel, the ejection port, the charging handle on the right.
  for (let k = 0; k < 3; k++) b.box(0.0586, 0.008, 0.04, PORT, 0, d.y(22), d.z(275 + k * 55)).box(0.0586, 0.008, 0.04, PORT, 0, d.y(2), d.z(275 + k * 55));
  b.box(0.002, 0.024, 0.11, PORT, -0.0292, d.y(12), d.z(145))
    .as(SURF.blued).box(0.002, 0.014, 0.098, 0x4c4f54, -0.0296, d.y(13), d.z(142))
    .as(SURF.steel)
    .slab(0.02, 0.012, 0.016, 0.003, BLACK, -0.038, d.y(12), d.z(70))
    // Lower receiver: the magazine well, the trigger housing, the butt dropping behind the grip.
    .plate(d.p([[-338, -18], [215, -18], [215, -58], [52, -60], [48, -50], [-64, -50], [-120, -40], [-250, -40], [-272, -92], [-300, -100], [-338, -96]]), 0.048, 0x202124, 0.004)
    .pin(0.004, 0.06, 0x3a3c40, 0, d.y(-8), d.z(-300))
    .pin(0.004, 0.06, 0x3a3c40, 0, d.y(-8), d.z(225))
    // The heavy fluted barrel and its arrowhead brake.
    .loft([
      { z: d.z(432), rx: 0.026 }, { z: d.z(452), rx: 0.026 }, { z: d.z(452), rx: 0.0195 }, { z: d.z(1010), rx: 0.0165 },
    ], PARK, { segments: 12 }, 0, d.y(0));
  for (let k = 0; k < 6; k++) {
    const a = (k + 0.5) * Math.PI / 3;
    b.box(0.004, 0.002, 0.44, 0x0c0c0d, Math.sin(a) * 0.0176, d.y(0) + Math.cos(a) * 0.0176, d.z(730), 0, 0, -a);
  }
  b.slab(0.026, 0.026, 0.09, 0.003, PARK, 0, d.y(0), d.z(1053))
    .slab(0.076, 0.046, 0.022, 0.004, PARK, 0, d.y(0), d.z(1030), 0, 0, 0)
    .slab(0.062, 0.046, 0.02, 0.004, PARK, 0, d.y(0), d.z(1064))
    .slab(0.044, 0.042, 0.014, 0.004, PARK, 0, d.y(0), d.z(1091))
    .tube(0.0075, d.z(1097.8), d.z(1098.4), PORT, 0, d.y(0), 10)
    // Bipod: the yoke under the front of the receiver, the legs folded forward beside the barrel.
    .slab(0.074, 0.016, 0.03, 0.004, PARK, 0, d.y(-24), d.z(405))
    .box(0.011, 0.011, 0.3, PARK, 0.031, d.y(-26), d.z(560))
    .box(0.011, 0.011, 0.3, PARK, -0.031, d.y(-26), d.z(560))
    .slab(0.016, 0.014, 0.026, 0.003, BLACK, 0.031, d.y(-26), d.z(716))
    .slab(0.016, 0.014, 0.026, 0.003, BLACK, -0.031, d.y(-26), d.z(716))
    // Carry handle ahead of the scope.
    .plate(d.p([[322, 48], [334, 72], [410, 72], [422, 48], [414, 48], [404, 65], [340, 65], [331, 48]]), 0.01, PARK, 0.002, 0.016);
  guard(b, d, 8, -50, PARK);
  b.as(SURF.polymer).plate(a2Grip(d, 136), 0.03, POLY, 0.007)
    .as(SURF.rubber).slab(0.05, 0.14, 0.012, 0.003, 0x101011, 0, d.y(-27), d.z(-344));
  scope(b, d.y(100), d.z(-110), d.z(270), d.y(53.5), 1.15);
  // Ten-round magazine.
  const at: V3 = [0, d.y(-58), d.z(133)];
  const md = drawn(0.08 - at[2], 0.06 - at[1]);
  const mag = new Builder().as({ rough: 0.5, metal: 0.6, wear: 0.5, worn: 0x7e8185 })
    .plate(md.p([[60, -30], [206, -30], [206, -148], [62, -140]]), 0.044, 0x1f2023, 0.003)
    .box(0.0446, 0.09, 0.005, 0x18191b, 0, md.y(-95), md.z(100))
    .box(0.0446, 0.09, 0.005, 0x18191b, 0, md.y(-95), md.z(165))
    .plate(md.p([[208, -146], [208, -151], [60, -143], [60, -138]]), 0.046, 0x18191b, 0.0015);
  return {
    body: b, mag: { b: mag, at },
    muzzle: [0, 0.06, d.z(1098)], fore: [0.04, 0.006, d.z(300)], eject: [-0.04, 0.07, d.z(145)], stock: [0, 0.03, d.z(-350)], bolt: [0.035, d.y(12), d.z(70)],
  };
}

/**
 * RPG-7: a 950 mm launcher, 40 mm in the bore. The trigger grip is the front one; the plain grip
 * behind it is for the other hand, and the wooden shield over the chamber lies on the shoulder.
 * Measured from the trigger grip and the tube's axis.
 */
function rpg7(): Spec {
  const d = drawn(0.035, 0.07);
  const BAKELITE = 0x3b2416;
  const b = new Builder();
  b.as(SURF.steel)
    // The tube, open at the muzzle; the chamber swell is under the wood.
    .loft([
      { z: d.z(-470), rx: 0.0245 }, { z: d.z(255), rx: 0.0245 }, { z: d.z(255), rx: 0.0275 }, { z: d.z(265), rx: 0.0275 },
      { z: d.z(265), rx: 0.021 }, { z: d.z(160), rx: 0.021 },
    ], DARK, { segments: 14, caps: false }, 0, d.y(0))
    .tube(0.021, d.z(159), d.z(160), PORT, 0, d.y(0), 14)
    // Throat and the flared blast cone, hollow from behind.
    .loft([
      { z: d.z(-450), rx: 0.031 }, { z: d.z(-545), rx: 0.03 }, { z: d.z(-562), rx: 0.022 }, { z: d.z(-675), rx: 0.046 }, { z: d.z(-685), rx: 0.048 },
      { z: d.z(-685), rx: 0.0445 }, { z: d.z(-675), rx: 0.0425 }, { z: d.z(-566), rx: 0.016 },
    ], STEEL, { segments: 14, caps: false }, 0, d.y(0))
    .tube(0.016, d.z(-567), d.z(-566), PORT, 0, d.y(0), 14)
    // Sights: the folding rear leaf, the front post.
    .slab(0.026, 0.022, 0.03, 0.003, BLACK, 0, d.y(34), d.z(-35))
    .box(0.004, 0.014, 0.008, BLACK, 0.01, d.y(50), d.z(-35))
    .box(0.004, 0.014, 0.008, BLACK, -0.01, d.y(50), d.z(-35))
    .ring(0.006, 0.004, d.z(-41), d.z(-29), BLACK, 0, d.y(55), 10)
    .plate(d.p([[212, 22], [216, 46], [234, 46], [238, 22]]), 0.012, BLACK, 0.002)
    .box(0.003, 0.014, 0.004, BLACK, 0, d.y(48), d.z(225))
    // Bracket for the optical sight on the left, the trigger housing with its hammer.
    .slab(0.006, 0.034, 0.09, 0.002, BLACK, 0.027, d.y(6), d.z(-30))
    .plate(d.p([[-20, -22], [78, -22], [80, -40], [70, -50], [-12, -50], [-22, -40]]), 0.024, 0x1c1d1f, 0.003)
    .box(0.008, 0.012, 0.01, STEEL, 0, d.y(-30), d.z(-26), 0.5);
  guard(b, d, 50, -50, 0x1c1d1f);
  // Bands that hold the heat shield.
  for (const z of [-172, -428]) b.loft([{ z: d.z(z - 8), rx: 0.0432 }, { z: d.z(z + 8), rx: 0.0432 }], STEEL, { segments: 14 }, 0, d.y(0));
  b.as(SURF.wood)
    .loft([{ z: d.z(-452), rx: 0.036 }, { z: d.z(-444), rx: 0.041 }, { z: d.z(-156), rx: 0.041 }, { z: d.z(-148), rx: 0.036 }], WOOD, { segments: 14 }, 0, d.y(0))
    .plate(d.p([[-122, -22], [-152, -22], [-170, -118], [-140, -124], [-128, -60]]), 0.03, WOOD, 0.008)
    .as({ rough: 0.5, metal: 0, wear: 0.3, worn: 0x6b4a32 })
    .plate(a2Grip(d, 181), 0.03, BAKELITE, 0.007)
    .as(null);
  // The rocket sits in the muzzle: its motor, the swell of the warhead, the long nose and its fuze.
  const mag = new Builder().as({ rough: 0.6, metal: 0.3, wear: 0.3, worn: 0x7b8068 })
    .loft([
      { z: -0.03, rx: 0.0195 }, { z: 0.07, rx: 0.0195 }, { z: 0.14, rx: 0.0425 }, { z: 0.185, rx: 0.0425 }, { z: 0.365, rx: 0.012 },
    ], OLIVE, { segments: 14 })
    .as(SURF.steel)
    .loft([{ z: 0.365, rx: 0.012 }, { z: 0.385, rx: 0.011 }, { z: 0.385, rx: 0.007 }, { z: 0.405, rx: 0.006 }, { z: 0.41, rx: 0.003 }], 0x8e9296, { segments: 10 })
    .loft([{ z: 0.068, rx: 0.0205 }, { z: 0.074, rx: 0.0205 }], 0x8e9296, { segments: 14 });
  return {
    body: b, mag: { b: mag, at: [0, 0.07, d.z(265)] },
    muzzle: [0, 0.07, d.z(265) + 0.41], fore: [0.035, d.y(-74), d.z(-146)], eject: [0, 0.07, d.z(-685)], stock: [0, 0.06, -0.3], bolt: [0.03, 0.07, 0.1],
  };
}

/** The LR-338 "Wraith": our own long rifle, so there is no real one to measure. A slim chassis, a long suppressor. */
function wraith(): Spec {
  const RANGER = 0x2f3a2c;
  const d = drawn(0.08, 0.055);
  const b = new Builder();
  b.as({ rough: 0.55, metal: 0.45, wear: 0.4, worn: 0x80837f })
    .plate(d.p([[-200, -38], [-200, 24], [-192, 30], [150, 30], [162, 20], [360, 8], [364, 2], [364, -30], [356, -38]]), 0.05, RANGER, 0.005)
    .slab(0.021, 0.005, 0.34, 0.001, 0x1c1d1f, 0, d.y(32.5), d.z(-22))
    // Skeleton stock: the beam, the strut under it, the butt.
    .plate(d.p([[-198, 22], [-198, -4], [-440, -4], [-440, 22]]), 0.032, RANGER, 0.004)
    .plate(d.p([[-198, -38], [-198, -24], [-440, -70], [-440, -84]]), 0.02, RANGER, 0.003)
    .plate(d.p([[-438, 36], [-450, 40], [-450, -92], [-438, -96]]), 0.044, RANGER, 0.003);
  teeth(b, d, -186, 34, 36, 0x1c1d1f);
  for (let k = 0; k < 4; k++) b.box(0.0506, 0.008, 0.032, PORT, 0, d.y(-12), d.z(190 + k * 44));
  b.as(SURF.steel)
    // Bolt shroud at the back, the handle with a fat knob on the right.
    .loft([{ z: d.z(-216), rx: 0.011 }, { z: d.z(-200), rx: 0.013 }], PARK, { segments: 10 }, 0, d.y(8))
    .box(0.05, 0.01, 0.012, STEEL, 0.045, 0.06, -0.06)
    .loft([{ z: -0.074, rx: 0.008 }, { z: -0.066, rx: 0.012 }, { z: -0.05, rx: 0.012 }, { z: -0.042, rx: 0.008 }], BLACK, { segments: 10 }, 0.072, 0.06)
    .box(0.002, 0.014, 0.09, PORT, 0.0252, d.y(8), d.z(40))
    // Barrel, then the suppressor on its mount.
    .loft([{ z: d.z(160), rx: 0.0125 }, { z: d.z(540), rx: 0.0105 }], PARK, { segments: 10 }, 0, d.y(0))
    .loft([{ z: d.z(536), rx: 0.021 }, { z: d.z(540), rx: 0.027 }, { z: d.z(560), rx: 0.027 }, { z: d.z(560), rx: 0.025 }, { z: d.z(874), rx: 0.025 }, { z: d.z(880), rx: 0.021 }], 0x18191b, { segments: 12 }, 0, d.y(0))
    .tube(0.006, d.z(879.7), d.z(880.4), PORT, 0, d.y(0), 8);
  for (const z of [640, 720, 800]) b.loft([{ z: d.z(z - 2), rx: 0.0256 }, { z: d.z(z + 2), rx: 0.0256 }], 0x0e0e0f, { segments: 12 }, 0, d.y(0));
  guard(b, d, 8, -50, 0x1c1d1f);
  b.as(SURF.polymer)
    .plate(a2Grip(d, 136), 0.028, POLY, 0.007)
    .plate(d.p([[-262, 22], [-266, 40], [-380, 40], [-386, 22]]), 0.03, POLY, 0.006)
    .as(SURF.rubber).slab(0.044, 0.13, 0.008, 0.002, 0x101011, 0, d.y(-28), d.z(-454));
  scope(b, 0.14, -0.13, 0.3, d.y(37.5));
  const at: V3 = [0, d.y(-38), d.z(45)];
  const md = drawn(0.08 - at[2], 0.055 - at[1]);
  const mag = new Builder().as({ rough: 0.5, metal: 0.6, wear: 0.5, worn: 0x7e8185 })
    .plate(md.p([[8, -30], [84, -30], [86, -100], [10, -106]]), 0.026, 0x1c1d1f, 0.002)
    .as(SURF.polymer).plate(md.p([[88, -98], [88, -103], [8, -109], [8, -104]]), 0.028, 0x161617, 0.0012);
  return {
    body: b, mag: { b: mag, at },
    muzzle: [0, 0.055, d.z(880)], fore: [0.04, -0.005, 0.32], eject: [0.035, 0.06, 0.06], stock: [0, 0.03, d.z(-458)], bolt: [0.072, 0.06, -0.055],
  };
}

/** Coyote polymer of the M17's grip module, and the PVD coat on its steel slide. */
const COYOTE_POLY: Surface = { rough: 0.82, metal: 0, wear: 0.25, worn: 0xa48f6c };
const COYOTE_PVD: Surface = { rough: 0.46, metal: 0.5, wear: 0.5, worn: 0xb3ad9f };
const PVD = 0x86704f;
const CONTROL = 0x19191a;

/**
 * SIG Sauer M17 (TM 9-1005-470-10): 203 mm long, 140 mm tall, a 119 mm barrel, sights 173 mm
 * apart. Drawn from the rear face of the slide and the bore line. The grip rakes back the way a
 * real one does, around the point the hand always closed on.
 */
function m17(): Spec {
  const d = drawn(0.006, M17_BORE);
  const b = new Builder();
  // Grip module: dust cover with its rail, the beavertail, then the grip itself, wider and rounder.
  b.as(COYOTE_POLY)
    .plate(d.p([[-9, -19], [-9, -16], [-2, -13], [186, -13], [188, -17], [188, -29], [186, -31], [128, -31], [124, -33], [76, -33], [73, -40], [9, -36], [11, -30], [8, -24], [-4, -20]]), 0.0285, COYOTE, 0.002)
    .plate(d.p([[75, -35], [66, -58], [45.5, -117.5], [-9, -101], [-8, -90], [3, -55], [10, -33]]), 0.031, COYOTE, 0.006)
    .plate(d.p([[127, -31], [124, -36], [124, -56], [117, -64], [71, -64], [64, -60], [66, -56], [73, -59], [114.5, -59], [119, -53.5], [119, -33]]), 0.013, COYOTE, 0.002);
  // Stippled panels on the sides of the grip.
  b.as({ rough: 0.97, metal: 0 })
    .plate(d.p([[63, -50], [59, -62], [43, -106], [-3, -92], [5, -62], [13, -47]]), 0.0322, 0x77643f, 0);
  for (const s of [140, 152, 164]) b.box(0.029, 0.003, 0.0052, PORT, 0, d.y(-30.2), d.z(s));
  // Controls: takedown lever, slide catch and thumb safety on both sides, magazine release, trigger.
  b.as(SURF.polymer)
    .pin(0.0042, 0.0302, CONTROL, 0, d.y(-19), d.z(103), 10)
    .slab(0.003, 0.005, 0.017, 0.001, CONTROL, 0.0152, d.y(-18), d.z(111))
    .pin(0.0042, 0.0318, CONTROL, 0, d.y(-46), d.z(62), 10);
  for (const x of [0.0152, -0.0152]) {
    b.slab(0.003, 0.0045, 0.022, 0.001, CONTROL, x, d.y(-15.5), d.z(52))
      .slab(0.0045, 0.006, 0.021, 0.0012, CONTROL, x, d.y(-17.5), d.z(22), 0.12);
  }
  b.plate(d.p([[84, -33], [89, -33], [87.5, -46], [83, -56], [80, -55], [83.5, -45]]), 0.007, CONTROL, 0.001);
  // Barrel and its chamber block: the slide hides them until it comes back.
  b.as(SURF.blued)
    .loft([{ z: d.z(112), rx: 0.0068 }, { z: d.z(193), rx: 0.0068 }, { z: d.z(194), rx: 0.0058 }], 0x2b2b2e, { segments: 10 }, 0, d.y(0))
    .slab(0.017, 0.02, 0.038, 0.0015, 0x1c1c1e, 0, d.y(0.5), d.z(94))
    .tube(0.0045, d.z(193.7), d.z(194.2), PORT, 0, d.y(0), 8)
    .as(null);

  const sd = drawn(-0.094, 0);
  const slide = new Builder().as(COYOTE_PVD)
    .plate(sd.p([[0, -13], [0, 8.5], [3, 11.5], [187, 11.5], [191, 8], [191, -11.5], [189.5, -13]]), 0.026, PVD, 0.003)
    // The plate an optic replaces, under the rear sight.
    .slab(0.019, 0.0012, 0.042, 0.0004, 0x756044, 0, sd.y(11.8), sd.z(32));
  // Cocking serrations, rear and front.
  for (let k = 0; k < 7; k++) slide.box(0.0266, 0.019, 0.0016, 0x4a3d2b, 0, sd.y(-1.5), sd.z(11 + k * 3.6));
  for (let k = 0; k < 5; k++) slide.box(0.0266, 0.019, 0.0016, 0x4a3d2b, 0, sd.y(-1.5), sd.z(158 + k * 3.6));
  slide.as(SURF.blued)
    // Ejection port over the right of the top, filled by the chamber; the extractor behind it.
    .plate(sd.p([[77, -0.5], [77, 11.9], [115, 11.9], [115, -0.5]]), 0.0194, 0x252528, 0.003, -0.0038)
    .box(0.001, 0.003, 0.016, CONTROL, -0.0133, sd.y(1.5), sd.z(68))
    // Striker cover at the back, the holes for the barrel and the guide rod at the front.
    .box(0.009, 0.013, 0.0008, 0x3d3325, 0, sd.y(-3), sd.z(-0.2))
    .tube(0.0076, sd.z(190.8), sd.z(191.25), PORT, 0, sd.y(0), 10)
    .tube(0.0036, sd.z(190.8), sd.z(191.25), 0x2c2c2f, 0, sd.y(-8), 8)
    // Three-dot night sights: front post, rear notch.
    .slab(0.006, 0.002, 0.013, 0.0005, 0x0e0e0e, 0, 0.0124, 0.085)
    .box(0.004, 0.0065, 0.005, 0x0e0e0e, 0, 0.01475, 0.085)
    .glow(0.0022, 0.0022, 0.0008, 0x9dff6a, 0, 0.0148, 0.0822)
    .slab(0.02, 0.004, 0.011, 0.0008, 0x0e0e0e, 0, 0.0135, -0.088)
    .box(0.0075, 0.0075, 0.01, 0x0e0e0e, 0.006, 0.01525, -0.088)
    .box(0.0075, 0.0075, 0.01, 0x0e0e0e, -0.006, 0.01525, -0.088)
    .glow(0.002, 0.002, 0.0008, 0x9dff6a, 0.006, 0.0152, -0.0935)
    .glow(0.002, 0.002, 0.0008, 0x9dff6a, -0.006, 0.0152, -0.0935)
    .as(null);

  // 17-round magazine: a steel tube raked with the grip, a polymer floor plate along its foot.
  const at: V3 = [0, 0.02, 0.05];
  const md = drawn(0.006 - at[2], M17_BORE - at[1]);
  const mag = new Builder().as({ rough: 0.4, metal: 0.8, wear: 0.3, worn: 0x8e9196 })
    .plate(md.p([[43.5, -22], [74.5, -22], [41.6, -117], [14, -108]]), 0.021, 0x1c1c1e, 0.002)
    .as(SURF.polymer)
    .plate(md.p([[47.5, -118], [5, -104.8], [3.6, -109.5], [46, -122.7]]), 0.03, 0x18181a, 0.002);
  return {
    body: b, action: { b: slide, at: [0, M17_BORE, 0.1] }, mag: { b: mag, at },
    muzzle: [0, M17_BORE, 0.2], fore: [0.03, -0.035, 0.035], eject: [-0.02, d.y(6), d.z(96)], stock: [0, 0, 0], bolt: [0.0, d.y(6), 0.03],
    // The rail under the dust cover.
    under: [0, d.y(-31), 0.16],
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

/** Olive drab fibreglass and the black rubber of the AT4's bumpers. */
const OD_TUBE = 0x454a33;
const BUMPER = 0x151617;

/**
 * M136 AT4 (TM 9-1315-886-12): a sealed 84 mm fibreglass tube 1,016 mm long that is thrown away
 * once fired. Rubber bumpers on both ends, pop-up sights under sliding covers, the firing rod in
 * its housing along the top with the cocking lever and the red trigger button, the folding
 * shoulder stop and the sling. Carried by the forward grip of the shoulder stop bracket here.
 */
function at4(): Spec {
  const d = drawn(0.035, 0.07);
  const R = 0.047;
  const b = new Builder();
  b.as({ rough: 0.72, metal: 0.05, wear: 0.3, worn: 0x6f7355 })
    // The tube, open at both ends (the muzzle cover is off, the venturi behind).
    .loft([
      { z: d.z(-470), rx: R }, { z: d.z(455), rx: R }, { z: d.z(455), rx: R - 0.005 }, { z: d.z(300), rx: R - 0.005 },
    ], OD_TUBE, { segments: 16, caps: false }, 0, d.y(0))
    .tube(R - 0.005, d.z(299), d.z(300), PORT, 0, d.y(0), 16)
    .loft([{ z: d.z(-470), rx: R - 0.006 }, { z: d.z(-380), rx: R - 0.016 }], 0x202124, { segments: 16, caps: false }, 0, d.y(0))
    .tube(R - 0.016, d.z(-381), d.z(-380), PORT, 0, d.y(0), 16)
    // Stencilled bands: the yellow high-explosive band and the black instruction label.
    .loft([{ z: d.z(338), rx: R + 0.0006 }, { z: d.z(352), rx: R + 0.0006 }], 0xb39a2a, { segments: 16, caps: false }, 0, d.y(0))
    .loft([{ z: d.z(-330), rx: R + 0.0006 }, { z: d.z(-250), rx: R + 0.0006 }], 0x23261c, { segments: 16, caps: false }, 0, d.y(0))
    .as(SURF.rubber)
    // Muzzle bumper and the flared venturi bumper.
    .loft([{ z: d.z(430), rx: R + 0.004 }, { z: d.z(440), rx: R + 0.014 }, { z: d.z(500), rx: R + 0.014 }, { z: d.z(508), rx: R + 0.008 }, { z: d.z(508), rx: R - 0.003 }, { z: d.z(456), rx: R - 0.003 }], BUMPER, { segments: 16, caps: false }, 0, d.y(0))
    .loft([{ z: d.z(-420), rx: R + 0.004 }, { z: d.z(-432), rx: R + 0.012 }, { z: d.z(-500), rx: R + 0.02 }, { z: d.z(-508), rx: R + 0.016 }, { z: d.z(-508), rx: R + 0.004 }, { z: d.z(-470), rx: R - 0.004 }], BUMPER, { segments: 16, caps: false }, 0, d.y(0))
    .as(SURF.polymer)
    // Sight housings with their covers slid back, the leaves standing.
    .slab(0.034, 0.02, 0.085, 0.004, 0x1f2119, 0, d.y(R * 1000 + 8), d.z(250))
    .slab(0.034, 0.02, 0.085, 0.004, 0x1f2119, 0, d.y(R * 1000 + 8), d.z(-70))
    .as(SURF.steel)
    .plate(d.p([[244, R * 1000 + 16], [247, R * 1000 + 40], [253, R * 1000 + 40], [256, R * 1000 + 16]]), 0.004, BLACK, 0.0006)
    .box(0.014, 0.004, 0.004, BLACK, 0, d.y(R * 1000 + 30), d.z(250))
    .plate(d.p([[-76, R * 1000 + 16], [-74, R * 1000 + 32], [-66, R * 1000 + 32], [-64, R * 1000 + 16]]), 0.022, BLACK, 0.0008)
    .ring(0.004, 0.003, d.z(-73), d.z(-67), BLACK, 0, d.y(R * 1000 + 37), 10)
    // Firing rod housing along the top right, the cocking lever and the forward safety.
    .tube(0.0075, d.z(-390), d.z(-110), 0x1f2119, -0.028, d.y(R * 1000 - 6), 8)
    .slab(0.02, 0.016, 0.07, 0.003, 0x1f2119, -0.03, d.y(R * 1000 - 4), d.z(-140))
    .slab(0.01, 0.01, 0.05, 0.002, BLACK, -0.042, d.y(R * 1000 - 2), d.z(-150), 0, 0.25)
    .slab(0.012, 0.008, 0.03, 0.002, BLACK, -0.036, d.y(R * 1000 - 12), d.z(-100))
    .as({ rough: 0.5, metal: 0.1 })
    .slab(0.014, 0.008, 0.022, 0.002, 0x8a1c16, -0.026, d.y(R * 1000 + 2), d.z(-176))
    .as(SURF.steel)
    // Bracket and grip under the tube, the folding shoulder stop behind it.
    .plate(d.p([[-30, -R * 1000 + 2], [90, -R * 1000 + 2], [84, -R * 1000 - 5], [-24, -R * 1000 - 5]]), 0.03, 0x1f2119, 0.003)
    .plate(d.p([[-262, -R * 1000 + 2], [-232, -R * 1000 + 2], [-236, -R * 1000 - 96], [-258, -R * 1000 - 100], [-268, -R * 1000 - 92]]), 0.05, 0x1f2119, 0.006)
    // Sling swivels.
    .ring(0.008, 0.003, d.z(380), d.z(384), STEEL, 0.03, d.y(-R * 1000 - 4), 8)
    .ring(0.008, 0.003, d.z(-360), d.z(-356), STEEL, 0.03, d.y(-R * 1000 - 4), 8)
    .as(SURF.polymer)
    .plate(a2Grip(d, 181), 0.03, 0x1f2119, 0.007)
    .as({ rough: 0.9, metal: 0 })
    // The sling, slack along the left side.
    .plate(d.p([[380, -R * 1000 - 6], [200, -R * 1000 - 22], [0, -R * 1000 - 30], [-200, -R * 1000 - 22], [-358, -R * 1000 - 6], [-358, -R * 1000 - 10], [-200, -R * 1000 - 26], [0, -R * 1000 - 34], [200, -R * 1000 - 26], [380, -R * 1000 - 10]]), 0.022, 0x2f3324, 0.0005, 0.032)
    .as(null);
  return {
    body: b,
    muzzle: [0, 0.07, d.z(508)], fore: [0.04, d.y(-R * 1000 - 8), d.z(210)], eject: [0, 0.07, d.z(-508)], stock: [0, 0.06, -0.3], bolt: [-0.04, d.y(R * 1000 - 2), d.z(-150)],
  };
}

/**
 * M32A1 multi-shot grenade launcher (Milkor MGL): six 40 mm chambers in a spring-wound cylinder,
 * the short 226 mm barrel in line with the top chamber, a rail over it with the reflex sight, a
 * vertical foregrip under the barrel and an M4 stock. 711 mm long with the stock in.
 */
function m32(): Spec {
  const BORE = 0.076, AXIS = 0.03;
  const c0 = 0.07, c1 = 0.215;
  const b = new Builder();
  b.as(SURF.anodized)
    // Frame: the rear plate with the firing mechanism, the top strap, the front plate that carries the barrel.
    .plate([[-0.02, -0.03], [-0.02, 0.1], [0.012, 0.118], [c0 - 0.004, 0.118], [c0 - 0.004, -0.03]], 0.058, RECV, 0.005)
    .plate([[c0 - 0.004, 0.106], [c0 - 0.004, 0.118], [c1 + 0.05, 0.118], [c1 + 0.05, 0.106]], 0.04, RECV, 0.003)
    .plate([[c1 + 0.004, -0.02], [c1 + 0.004, 0.112], [c1 + 0.05, 0.112], [c1 + 0.05, 0.03], [c1 + 0.03, -0.02]], 0.06, RECV, 0.005)
    // Rail on the strap.
    .slab(0.021, 0.006, 0.24, 0.001, 0x202124, 0, 0.121, 0.13);
  for (let k = 0; k < 22; k++) b.box(0.0212, 0.003, 0.0052, 0x202124, 0, 0.1245, 0.02 + k * 0.01);
  b.as(SURF.steel)
    // The cylinder: six chambers, the flutes between them, the axis pin and the winding knob in front.
    .loft([{ z: c0, rx: 0.07 }, { z: c0 + 0.006, rx: 0.076 }, { z: c1 - 0.006, rx: 0.076 }, { z: c1, rx: 0.07 }], DARK, { segments: 18 }, 0, AXIS)
    .tube(0.012, c0 - 0.004, c1 + 0.03, STEEL, 0, AXIS, 8);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const cx = Math.sin(a) * 0.046, cy = AXIS + Math.cos(a) * 0.046;
    // Chamber mouths (the top one is behind the barrel), each with the nose of its grenade.
    if (k !== 0) {
      b.tube(0.0205, c1, c1 + 0.0008, PORT, cx, cy, 10)
        .as(SURF.brass).tube(0.017, c1 + 0.0008, c1 + 0.004, 0xb39a2a, cx, cy, 10, 0.012).as(SURF.steel);
    }
    const f = a + Math.PI / 6;
    b.box(0.016, 0.004, c1 - c0 - 0.03, 0x17181a, Math.sin(f) * 0.0755, AXIS + Math.cos(f) * 0.0755, (c0 + c1) / 2, 0, 0, -f);
  }
  b.as(SURF.steel)
    // Barrel with its muzzle ring; the bore.
    .loft([{ z: c1 + 0.004, rx: 0.026 }, { z: c1 + 0.2, rx: 0.026 }, { z: c1 + 0.2, rx: 0.0285 }, { z: c1 + 0.226, rx: 0.0285 }, { z: c1 + 0.226, rx: 0.0205 }, { z: c1 + 0.15, rx: 0.0205 }], PARK, { segments: 14, caps: false }, 0, BORE)
    .tube(0.0205, c1 + 0.149, c1 + 0.15, PORT, 0, BORE, 14)
    // Hand guard rail under the barrel and the vertical foregrip.
    .slab(0.024, 0.012, 0.15, 0.002, RECV, 0, BORE - 0.036, c1 + 0.11)
    .box(0.008, 0.012, 0.012, STEEL, 0, 0.0, -0.012, 0.5);
  guard(b, drawn(0.0, 0.05), 30, -50, 0x1c1d1f);
  // Reflex sight on the rail: the housing, its window, the dot.
  const sy = 0.127, sz = 0.06;
  b.as(SURF.anodized)
    .slab(0.036, 0.016, 0.06, 0.003, BLACK, 0, sy + 0.008, sz)
    .box(0.044, 0.005, 0.03, BLACK, 0, sy + 0.05, sz + 0.012)
    .box(0.005, 0.034, 0.03, BLACK, 0.0195, sy + 0.032, sz + 0.012)
    .box(0.005, 0.034, 0.03, BLACK, -0.0195, sy + 0.032, sz + 0.012)
    .glow(0.003, 0.003, 0.0008, 0xff2414, 0, sy + 0.033, sz + 0.02)
    .as(SURF.polymer)
    .plate(a2Grip(drawn(0.0, 0.05), 150), 0.03, POLY, 0.007)
    .slab(0.032, 0.1, 0.036, 0.008, POLY, 0, BORE - 0.092, c1 + 0.11)
    // Buffer tube and the M4 stock on it.
    .as(SURF.anodized)
    .tube(0.0145, -0.25, -0.02, RECV, 0, 0.074, 10)
    .as(SURF.polymer)
    .plate([[-0.12, 0.094], [-0.262, 0.094], [-0.27, 0.086], [-0.27, -0.03], [-0.25, -0.036], [-0.225, 0.03], [-0.12, 0.052]], 0.04, POLY, 0.006)
    .as(SURF.rubber).slab(0.04, 0.12, 0.006, 0.002, 0x101011, 0, 0.03, -0.272)
    .as(null);
  return {
    body: b,
    muzzle: [0, BORE, c1 + 0.226], fore: [0.03, BORE - 0.1, c1 + 0.11], eject: [-0.07, AXIS, (c0 + c1) / 2], stock: [0, 0.04, -0.275], bolt: [0.06, AXIS + 0.03, c1 - 0.02],
  };
}

/** NATO green of the Guard's trucks and gun shields. */
const NATO_GREEN = 0x3f4634;

/**
 * Browning M2HB on a Humvee's ring (TM 9-1005-213-10): 1,654 mm long with its 1,143 mm barrel,
 * the receiver 115 mm high and 80 mm across, spade grips and the butterfly trigger on the back
 * plate, a 100-round can in the tray on its left. The origin is the trunnion pin it tips on. The
 * pintle, its yoke and the gun shield are the `action`: they turn with the gun but stay upright.
 */
function m2hb(): Spec {
  const BORE = 0.05;
  const b = new Builder();
  b.as(SURF.steel)
    // Receiver, the top cover with its latch, the back plate.
    .plate([[-0.36, -0.008], [-0.36, 0.1], [0.2, 0.1], [0.2, -0.008]], 0.08, PARK, 0.004)
    .plate([[-0.2, 0.1], [-0.2, 0.118], [-0.185, 0.124], [0.13, 0.124], [0.16, 0.11], [0.16, 0.1]], 0.076, 0x202124, 0.004)
    .slab(0.03, 0.01, 0.03, 0.002, STEEL, 0, 0.128, -0.17)
    .slab(0.084, 0.118, 0.012, 0.003, 0x202124, 0, 0.046, -0.366)
    // Rear sight leaf and the front blade on the trunnion block.
    .plate([[-0.3, 0.1], [-0.297, 0.15], [-0.283, 0.15], [-0.28, 0.1]], 0.03, BLACK, 0.001)
    .box(0.003, 0.03, 0.006, BLACK, 0, 0.115, 0.185)
    // Bolt latch release between the grips, the retracting slide handle on the right.
    .slab(0.03, 0.03, 0.02, 0.004, STEEL, 0, 0.046, -0.385)
    .slab(0.012, 0.012, 0.16, 0.002, 0x202124, -0.046, 0.03, -0.1)
    .pin(0.008, 0.05, STEEL, -0.07, 0.03, -0.04, 8)
    // Spade grips: two D frames off the back plate.
    .box(0.014, 0.012, 0.07, 0x202124, 0.085, 0.1, -0.4)
    .box(0.014, 0.012, 0.07, 0x202124, 0.085, -0.01, -0.4)
    .box(0.014, 0.012, 0.07, 0x202124, -0.085, 0.1, -0.4)
    .box(0.014, 0.012, 0.07, 0x202124, -0.085, -0.01, -0.4)
    .box(0.184, 0.012, 0.014, 0x202124, 0, 0.1, -0.372)
    .box(0.184, 0.012, 0.014, 0x202124, 0, -0.01, -0.372)
    // Butterfly trigger.
    .slab(0.07, 0.016, 0.01, 0.002, STEEL, 0, 0.07, -0.392, 0.3)
    // Barrel support, perforated, and the heavy barrel with its carrying handle.
    .loft([{ z: 0.2, rx: 0.032 }, { z: 0.46, rx: 0.032 }, { z: 0.47, rx: 0.026 }], PARK, { segments: 12 }, 0, BORE)
    .loft([{ z: 0.47, rx: 0.0235 }, { z: 0.78, rx: 0.0225 }, { z: 1.194, rx: 0.019 }, { z: 1.194, rx: 0.021 }, { z: 1.218, rx: 0.021 }], 0x1c1d1f, { segments: 12 }, 0, BORE)
    .tube(0.0065, 1.2176, 1.2186, PORT, 0, BORE, 8)
    .slab(0.012, 0.04, 0.03, 0.003, STEEL, 0.03, BORE + 0.03, 0.56, 0, 0, -0.6)
    .tube(0.011, 0.5, 0.62, WOOD, 0.052, BORE + 0.05, 8);
  for (let k = 0; k < 4; k++) {
    for (const a of [0.6, 1.57, 2.54, -0.6, -1.57, -2.54]) {
      b.box(0.012, 0.003, 0.03, PORT, Math.sin(a) * 0.0315, BORE + Math.cos(a) * 0.0315, 0.245 + k * 0.058, 0, 0, -a);
    }
  }
  // Cradle under the receiver: the trunnion pin and the bracket for the can.
  b.slab(0.05, 0.03, 0.34, 0.004, 0x202124, 0, -0.022, -0.08)
    .pin(0.014, 0.13, STEEL, 0, 0, 0, 10)
    .slab(0.2, 0.008, 0.2, 0.002, 0x202124, 0.14, -0.05, 0.05)
    .box(0.008, 0.06, 0.012, 0x202124, 0.05, -0.02, 0.05)
    // The can, its lid open on the far side, the belt up over the feed tray into the gun.
    .as({ rough: 0.6, metal: 0.4, wear: 0.4, worn: 0x7b8068 })
    .slab(0.155, 0.19, 0.305, 0.006, OLIVE, 0.145, 0.05, 0.03)
    .box(0.157, 0.006, 0.307, 0x2c3125, 0.145, 0.07, 0.03)
    .box(0.02, 0.03, 0.12, 0x2c3125, 0.225, 0.11, 0.03)
    .as(SURF.brass)
    .box(0.1, 0.012, 0.1, BRASS, 0.1, 0.15, 0.06)
    .box(0.03, 0.03, 0.1, BRASS, 0.05, 0.135, 0.06);
  for (let k = 0; k < 7; k++) b.box(0.006, 0.0125, 0.102, 0x4a4b4e, 0.062 + k * 0.013, 0.15, 0.06);
  b.as(null);
  // What stays upright: the pintle in its socket, the yoke, the shield with its wings and the sight slot.
  const m = new Builder();
  m.as(SURF.steel)
    .slab(0.07, 0.3, 0.07, 0.008, 0x202124, 0, -0.2, 0)
    .slab(0.012, 0.11, 0.07, 0.003, 0x202124, 0.072, -0.03, 0)
    .slab(0.012, 0.11, 0.07, 0.003, 0x202124, -0.072, -0.03, 0)
    .slab(0.156, 0.02, 0.07, 0.004, 0x202124, 0, -0.085, 0)
    .slab(0.16, 0.05, 0.16, 0.01, 0x202124, 0, -0.355, 0)
    // Shield arms.
    .box(0.03, 0.03, 0.3, 0x202124, 0.26, -0.2, 0.17)
    .box(0.03, 0.03, 0.3, 0x202124, -0.26, -0.2, 0.17)
    .box(0.55, 0.03, 0.03, 0x202124, 0, -0.2, 0.03)
    .as({ rough: 0.78, metal: 0.25, wear: 0.45, worn: 0x8a8c80 })
    .slab(0.43, 0.62, 0.012, 0.003, NATO_GREEN, -0.285, -0.03, 0.33)
    .slab(0.43, 0.62, 0.012, 0.003, NATO_GREEN, 0.285, -0.03, 0.33)
    .slab(0.14, 0.24, 0.012, 0.003, NATO_GREEN, 0, -0.22, 0.33)
    .slab(0.2, 0.62, 0.012, 0.003, NATO_GREEN, -0.585, -0.03, 0.278, 0, -0.55)
    .slab(0.2, 0.62, 0.012, 0.003, NATO_GREEN, 0.585, -0.03, 0.278, 0, 0.55)
    // Vision slot frames and the bolts along the edges.
    .as(SURF.steel)
    .slab(0.16, 0.05, 0.016, 0.003, 0x202124, -0.3, 0.2, 0.332)
    .slab(0.16, 0.05, 0.016, 0.003, 0x202124, 0.3, 0.2, 0.332)
    .as(null);
  return {
    body: b, action: { b: m, at: [0, 0, 0] },
    muzzle: [0, BORE, 1.2186], fore: [0.085, 0.045, -0.42], eject: [-0.01, -0.03, 0.02], stock: [0, 0.045, -0.44], bolt: [-0.07, 0.03, -0.04],
  };
}

const SPECS: Record<WeaponId, () => Spec> = { ar: m4, smg: mp5, shotgun: m870, marksman: mk14, pistol: m17, akimbo: m17, machete, lmg: m249, battle: scarH, sniper: m107, rpg: rpg7, wraith, at4, mgl: m32, m2: m2hb,
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
      scope(b, y + 0.055, z - 0.135, z + 0.135, y, 1.2);
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
  if (build.mag === 'extended' && spec.tube) {
    // Tube magazine: an extension past the end of the tube.
    const [x, y, z] = spec.tube;
    body.tube(0.0125, z - 0.004, z + 0.085, 0x18191a, x, y, 10).tube(0.0145, z + 0.085, z + 0.094, BLACK, x, y, 10);
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
