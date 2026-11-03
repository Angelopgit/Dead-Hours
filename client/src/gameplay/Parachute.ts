import * as THREE from 'three';
import { GROUP, groups, type Physics } from '../core/Physics';

/**
 * A round cargo parachute for the supply drops. In the air it is a gored canopy: sixteen panels
 * of orange and white nylon bulging out between their seams, a scalloped hem that breathes and
 * flutters, a vent at the crown, and a suspension line from every seam down to a confluence link
 * with two risers to the crate. When the crate lands the lines go slack, the canopy sinks, closes,
 * tips over downwind and settles onto the street as a long crumpled sheet: two layers of fabric
 * pleated along the seams, a pocket of trapped air, the lines lying in loops back to the crate.
 *
 * One small mesh (1200 vertices) moved on the CPU, so shadows and every light just work. It is
 * reshaped every frame while it flies and collapses, then only a breath of wind in the trapped air
 * while someone is close enough to see it.
 */

const GORES = 16;
/** Segments across each gore and from the vent to the skirt. */
const ACROSS = 4;
const RINGS = 14;
const ROW = ACROSS + 1;
const PER_GORE = ROW * (RINGS + 1);
const COUNT = GORES * PER_GORE;
/** Inflated dome: an ellipsoid from the vent (TH0) to past its equator at the skirt (TH1). */
const RH = 3.0;
const RV = 2.0;
const TH0 = 0.07 * Math.PI;
const TH1 = 0.6 * Math.PI;
/** Height of the skirt plane under the dome's centre (negative: the skirt curls in below it). */
const SKIRT_DROP = RV * Math.cos(TH1);
/** Heights above the crate's base: skirt plane fully deployed, confluence link while hanging. */
const SKIRT = 7.4;
const CONF = 1.9;
/** Segments per suspension line (they bend on the ground). */
const LINE_SEG = 5;
/** Lying flat: skirt this far from the crate, crown this much further, half width at the widest. */
const LIE_FROM = 1.45;
const LIE_LEN = 3.6;
const LIE_HALF = 1.25;
const LIE_FULL = LIE_FROM + LIE_LEN + 0.4;
/** Seconds each part of the canopy takes to come down, and when the last part has landed. */
const DROP_TIME = 1.3;
export const CHUTE_SETTLED = 1.05 + DROP_TIME;
/** Height grid sampled under the lying canopy: along its axis and across it. */
const GRID_A0 = -0.5;
const GRID_A = 13;
const GRID_B0 = -2;
const GRID_B = 9;
const GRID_STEP = 0.5;

const ORANGE = new THREE.Color(0xd8642a);
const WHITE = new THREE.Color(0xd8d4c6);

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number, a: number, b: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a landed canopy lies: the direction it fell (world yaw), how much room it had, its ground. */
interface Layout {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** 0.45..1: canopy length that fitted before a wall or car (the rest bunches up). */
  len: number;
  heights: Float32Array;
}

export class Parachute {
  readonly root = new THREE.Group();
  private readonly canopy: THREE.Mesh;
  private readonly lines: THREE.LineSegments;
  private readonly geo = new THREE.BufferGeometry();
  private readonly lineGeo = new THREE.BufferGeometry();
  private readonly pos = new Float32Array(COUNT * 3);
  private readonly linePos = new Float32Array((GORES * LINE_SEG + 2) * 6);
  private readonly materials: THREE.Material[] = [];
  /** Per vertex: angle round the canopy, place across its gore (0..1), vent 0 .. skirt 1. */
  private readonly phi = new Float32Array(COUNT);
  private readonly gu = new Float32Array(COUNT);
  private readonly gv = new Float32Array(COUNT);
  private readonly gore = new Uint8Array(COUNT);
  /** Per vertex, when it starts coming down after the landing. */
  private readonly delay = new Float32Array(COUNT);
  /**
   * Per vertex terms that never change, worked out once: cos and sin of its angle, of its place
   * on the dome's profile, the gore's bulge across, the hem's scallop, the creases and dents it
   * takes as it deflates, and its radius in the unopened sleeve.
   */
  private readonly cphi = new Float32Array(COUNT);
  private readonly sphi = new Float32Array(COUNT);
  private readonly sth = new Float32Array(COUNT);
  private readonly cth = new Float32Array(COUNT);
  private readonly bulge = new Float32Array(COUNT);
  private readonly hem = new Float32Array(COUNT);
  private readonly crease = new Float32Array(COUNT);
  private readonly caveR = new Float32Array(COUNT);
  private readonly caveY = new Float32Array(COUNT);
  private readonly sleeve = new Float32Array(COUNT);
  /** Per frame: each gore's flutter, each ring's inflation and overshoot. */
  private readonly flutter = new Float32Array(GORES);
  private readonly ringW = new Float32Array(RINGS + 1);
  private readonly ringOver = new Float32Array(RINGS + 1);
  private breath = 0;
  private live = 1;
  private deflate = 0;
  private inflate = 1;
  private cs = 1;
  private ss = 0;
  private normalsAt = -1;
  /** Lying shape (filled at the landing) and how much of each vertex's height is trapped air. */
  private ground: Float32Array | null = null;
  private puff: Float32Array | null = null;
  /** Each line point's place on the ground (confluence first), and the whole settled line set. */
  private lineTargets: Float32Array | null = null;
  private settledLines: Float32Array | null = null;
  private layout: Layout | null = null;
  private readonly jitter = new Float32Array(GORES);
  private readonly ph = new Float32Array(8);
  private spin: number;
  private readonly lean: number;
  /** Length of the unopened sleeve above the skirt. */
  private bag = 3;
  /** The canopy's turn when the crate touches down. */
  private landSpin = 0;
  /** Down on the ground (or most of it), pressing the grass flat. */
  private lying = false;
  private settledAt = -1;
  private rippleT = 0;
  private readonly v3 = new THREE.Vector3();

  constructor(readonly seed: number) {
    const rand = rng(seed * 2654435761);
    for (let i = 0; i < GORES; i++) this.jitter[i] = rand();
    for (let i = 0; i < this.ph.length; i++) this.ph[i] = rand() * Math.PI * 2;
    this.spin = this.ph[7];
    this.lean = (rand() - 0.5) * 0.3;
    const col = new Float32Array(COUNT * 3);
    const index: number[] = [];
    const c = new THREE.Color();
    for (let g = 0; g < GORES; g++) {
      // Panels alternate orange and white, each a touch differently faded, the hem a little soiled.
      const base = g % 2 ? ORANGE : WHITE;
      const fade = 0.9 + this.jitter[g] * 0.1;
      for (let j = 0; j <= RINGS; j++) {
        for (let i = 0; i <= ACROSS; i++) {
          const k = g * PER_GORE + j * ROW + i;
          const u = i / ACROSS, v = j / RINGS;
          this.phi[k] = ((g + u) / GORES) * Math.PI * 2;
          this.gu[k] = u;
          this.gv[k] = v;
          this.gore[k] = g;
          // Lower parts land first, the crown last; a little unevenly round the canopy.
          const phi = this.phi[k];
          this.delay[k] = 0.15 + 0.7 * (1 - v) + 0.15 * (0.5 + 0.5 * Math.sin(2 * phi + this.ph[6]));
          const th = TH0 + v * (TH1 - TH0);
          this.cphi[k] = Math.cos(phi);
          this.sphi[k] = Math.sin(phi);
          this.sth[k] = Math.sin(th);
          this.cth[k] = Math.cos(th);
          this.bulge[k] = Math.sin(Math.PI * u);
          this.hem[k] = smooth(v, 0.72, 1);
          // Spilling its air: creases, and big dents where panels cave in.
          this.crease[k] = (Math.sin(3 * phi + this.ph[2] + 6 * v) * 0.6 + Math.sin(7 * phi + this.ph[3] - 4 * v) * 0.4) * (0.3 + v);
          const cave = 0.5 + 0.5 * Math.sin(4 * phi + this.ph[5] + 3 * v) * Math.sin(phi + this.ph[4]);
          this.caveR[k] = 0.18 * v * v + 0.4 * cave * Math.sin(Math.PI * Math.min(1, v * 1.4));
          this.caveY[k] = 1.2 * (1 - v) * (1 - v) + 0.4 * cave * (1 - v);
          this.sleeve[k] = 0.16 + 0.05 * Math.sin(3 * phi + v * 7 + this.ph[4]);
          c.copy(base).multiplyScalar(fade * (1 - 0.12 * v * v * v));
          col.set([c.r, c.g, c.b], k * 3);
          if (i < ACROSS && j < RINGS) {
            const a = k, b = k + 1, d = k + ROW, e = k + ROW + 1;
            index.push(a, d, b, b, d, e);
          }
        }
      }
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.geo.setIndex(index);
    // Big enough for the dome overhead and the canopy lying beside the crate.
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 4.5, 0), 9.5);
    const cloth = this.mat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: THREE.DoubleSide }));
    this.canopy = new THREE.Mesh(this.geo, cloth);
    this.canopy.castShadow = true;
    // Thin nylon lets light through; self-shadowing a sheet this thin only speckles it.
    this.canopy.receiveShadow = false;
    this.root.add(this.canopy);
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.lineGeo.boundingSphere = this.geo.boundingSphere.clone();
    this.lines = new THREE.LineSegments(this.lineGeo, this.mat(new THREE.LineBasicMaterial({ color: 0x67645b, transparent: true, opacity: 0.8 })));
    this.root.add(this.lines);
    this.root.visible = false;
  }

  private mat<M extends THREE.Material>(m: M): M {
    this.materials.push(m);
    return m;
  }

  hide(): void {
    this.root.visible = false;
    this.lying = false;
  }

  /**
   * In the air, `fall` seconds after release: the lines pay out as a streamer, the canopy
   * blossoms crown first, then breathes. `anchor` is where it hangs from (world), `crate` the
   * crate's base and yaw (the risers end on its lugs).
   */
  fly(anchor: THREE.Vector3, crate: THREE.Vector3, crateYaw: number, fall: number, time: number, room = Infinity): void {
    // Fills only as fast as the crate falls clear of the helicopter: `room` is the height free
    // above the crate's base.
    let f = fall;
    while (f > 0.12 && Parachute.height(f) > room) f -= 0.05;
    this.root.visible = f > 0.12;
    if (!this.root.visible) return;
    this.root.position.copy(anchor);
    const payout = smooth(f, 0.12, 2.3);
    const inflate = clamp01((f - 0.9) / 1.7);
    this.spin = this.spinAt(fall);
    const span = lerp(1.4, SKIRT, payout);
    const conf = lerp(1.0, CONF, payout);
    this.bag = lerp(0.9, 3.0, payout);
    this.prepare(time, inflate, 0);
    const o = this.v3;
    for (let k = 0; k < COUNT; k++) {
      this.air(k, span, o);
      this.pos[k * 3] = o.x;
      this.pos[k * 3 + 1] = o.y;
      this.pos[k * 3 + 2] = o.z;
    }
    const cx = crate.x - anchor.x, cy = crate.y - anchor.y, cz = crate.z - anchor.z;
    // The confluence sits on the line from the crate up to the middle of the skirt.
    const lift = conf / span;
    const fx = cx * (1 - lift), fy = cy + conf, fz = cz * (1 - lift);
    this.writeLines(fx, fy, fz, cx, cy, cz, crateYaw, 0, 0);
    // Once open it only breathes and turns slowly: its shading can lag a frame or three.
    const open = payout >= 1 && inflate >= 1;
    const shade = !open || time < this.normalsAt || time - this.normalsAt > 1 / 15;
    if (shade) this.normalsAt = time;
    this.commit(shade);
  }

  /** Points along the canopy lying on the ground (world x, z) and their radii, to press the grass flat. */
  pressed(out: (x: number, z: number, r: number) => void): void {
    const lay = this.layout;
    if (!lay || !this.lying) return;
    const p = this.root.position, L = LIE_LEN * lay.len;
    for (const t of [0.15, 0.5, 0.85]) {
      const a = LIE_FROM + L * t;
      out(p.x + a * lay.ax, p.z + a * lay.az, 1.3);
    }
  }

  /** Whether `lay` has worked out where the canopy will lie. */
  get laid(): boolean {
    return this.layout !== null;
  }

  /**
   * On the ground, `s` seconds after the crate landed at `at`: deflates, sinks, tips over the way
   * it has room to fall and settles (`lay` must have run). `view` is the camera: the trapped air
   * only stirs while someone is near enough to see it.
   */
  settle(at: THREE.Vector3, crateYaw: number, s: number, time: number, dt: number, view: THREE.Vector3 | null): void {
    this.root.visible = true;
    this.root.position.copy(at);
    this.spin = this.landSpin;
    this.lying = s > 1.2;
    const ground = this.ground!, lay = this.layout!;
    if (s >= CHUTE_SETTLED) {
      // Lying still: only the trapped air rises and falls a little in the wind, while seen.
      const near = !view || view.distanceToSquared(at) < 40 * 40;
      this.rippleT += dt;
      if (this.settledAt >= 0 && (!near || this.rippleT < 1 / 15)) return;
      this.rippleT = 0;
      const first = this.settledAt < 0;
      this.settledAt = time;
      const puff = this.puff!;
      const breath = 0.86 + 0.14 * Math.sin(time * 1.15 + this.ph[0]) + 0.05 * Math.sin(time * 2.9 + this.ph[1]);
      for (let k = 0; k < COUNT; k++) {
        this.pos[k * 3] = ground[k * 3];
        this.pos[k * 3 + 1] = ground[k * 3 + 1] + puff[k] * (breath - 1);
        this.pos[k * 3 + 2] = ground[k * 3 + 2];
      }
      if (first) this.linePos.set(this.settledLines!);
      this.commit(first);
      return;
    }
    this.settledAt = -1;
    const deflate = smooth(s, 0, 1.3);
    // The canopy keeps falling a moment after the crate stops, slowing as it spills its air.
    const sink = s < 1.6 ? 4.4 * s - 1.375 * s * s : 3.52;
    const tip = 1.15 * smooth(s, 0.1, 1.9);
    const ct = Math.cos(tip), st = Math.sin(tip);
    this.prepare(time, 1, deflate);
    const o = this.v3;
    for (let k = 0; k < COUNT; k++) {
      this.air(k, SKIRT, o);
      // Tip over toward the lying direction, about the confluence.
      const pa = o.x * lay.ax + o.z * lay.az, pb = o.x * lay.bx + o.z * lay.bz;
      const py = o.y - sink - CONF;
      const ra = pa * ct + py * st, ry = py * ct - pa * st + CONF;
      const ax = ra * lay.ax + pb * lay.bx, az = ra * lay.az + pb * lay.bz;
      const e = clamp01((s - this.delay[k]) / DROP_TIME);
      const w = e * e * (3 - 2 * e);
      // Air under the fabric slows it near the ground, so it floats down in a gentle arc.
      const arch = 0.45 * Math.sin(Math.PI * w) * (1 - this.gv[k]);
      this.pos[k * 3] = lerp(ax, ground[k * 3], w);
      this.pos[k * 3 + 1] = Math.max(lerp(ry, ground[k * 3 + 1], w) + arch, 0.03);
      this.pos[k * 3 + 2] = lerp(az, ground[k * 3 + 2], w);
    }
    // Lines: slack at once, the confluence drops beside the crate, each line lies down with its seam.
    const slack = smooth(s, 0, 0.7);
    const gl = this.lineTargets!;
    const fx = gl[0] * slack, fy = lerp(CONF, gl[1], slack), fz = gl[2] * slack;
    this.writeLines(fx, fy, fz, 0, 0, 0, crateYaw, slack, s);
    this.commit(true);
  }

  /** Roughly how high above the crate's base the chute reaches `fall` seconds after release. */
  private static height(fall: number): number {
    const payout = smooth(fall, 0.12, 2.3);
    const w = clamp01((fall - 0.9) / 1.7);
    return lerp(1.4, SKIRT, payout) + lerp(lerp(0.9, 3.0, payout), 2.6 * 1.12, w);
  }

  /** Spin of the canopy `fall` seconds after release (it turns slowly as it comes down). */
  private spinAt(fall: number): number {
    return this.ph[7] + fall * 0.12;
  }

  /** Per frame terms of the air shape, shared by every vertex (deflate 0..1 after landing). */
  private prepare(t: number, inflate: number, deflate: number): void {
    this.live = 1 - deflate;
    this.deflate = deflate;
    this.inflate = inflate;
    // Breathing: the skirt pulses in and out, the crown the other way; each gore flutters at its hem.
    this.breath = Math.sin(t * 2.4 + this.ph[0]) * this.live;
    for (let g = 0; g < GORES; g++) this.flutter[g] = Math.sin(t * 7.3 + g * 1.9 + this.ph[1]) * this.live;
    // Before it fills it is a long sleeve streaming above the lines; it opens crown first and
    // blossoms a little past full before it settles.
    for (let j = 0; j <= RINGS; j++) {
      const w = smooth(inflate * 1.5 - (j / RINGS) * 0.5, 0, 1);
      this.ringW[j] = w;
      this.ringOver[j] = 1 + 0.12 * Math.sin(Math.PI * w) * w;
    }
    this.cs = Math.cos(this.spin);
    this.ss = Math.sin(this.spin);
  }

  /** One vertex of the canopy in the air, relative to its anchor (after `prepare`). */
  private air(k: number, span: number, out: THREE.Vector3): void {
    const v = this.gv[k], v2 = v * v;
    const live = this.live, breath = this.breath, bulge = this.bulge[k];
    const sth = this.sth[k];
    const fl = this.flutter[this.gore[k]] * bulge;
    let r = RH * sth * (1 + 0.035 * breath * v2) + 0.24 * sth * bulge * live + 0.06 * fl * v2 * v2;
    let y = RV * this.cth[k] * (1 - 0.03 * breath) + (0.2 * bulge * live + 0.05 * fl) * this.hem[k];
    const deflate = this.deflate;
    if (deflate > 0) {
      // Spilling its air: the panels cave in, the crown falls in, the whole canopy slumps.
      r *= 1 - deflate * this.caveR[k];
      r += 0.32 * deflate * this.crease[k];
      y = y * (1 - 0.4 * deflate) - deflate * this.caveY[k];
    }
    if (this.inflate < 1) {
      const j = Math.round(v * RINGS);
      const w = this.ringW[j];
      r = lerp(this.sleeve[k], r * this.ringOver[j], w);
      y = lerp(SKIRT_DROP + (1 - v) * this.bag, y, w);
    }
    const c = this.cphi[k], s = this.sphi[k];
    out.set((c * this.cs - s * this.ss) * r, span - SKIRT_DROP + y, (s * this.cs + c * this.ss) * r);
  }

  /**
   * Suspension lines from the confluence (fx, fy, fz) to each seam at the skirt, and two risers
   * from it to the lugs on the crate's ends (crate base at cx, cy, cz). `down` 0..1 blends each
   * line toward its loops on the ground.
   */
  private writeLines(fx: number, fy: number, fz: number, cx: number, cy: number, cz: number, yaw: number, down: number, s: number): void {
    const lp = this.linePos, p = this.pos, gl = this.lineTargets;
    let n = 0;
    const put = (x: number, y: number, z: number) => {
      lp[n++] = x;
      lp[n++] = y;
      lp[n++] = z;
    };
    for (let i = 0; i < GORES; i++) {
      const k = i * PER_GORE + RINGS * ROW;
      const sx = p[k * 3], sy = p[k * 3 + 1], sz = p[k * 3 + 2];
      // Lying down along with the seam it holds.
      const lie = gl ? Math.min(down, smooth(s - this.delay[k], 0, DROP_TIME)) : 0;
      let px = fx, py = fy, pz = fz;
      for (let j = 1; j <= LINE_SEG; j++) {
        const t = j / LINE_SEG;
        let x = lerp(fx, sx, t), y = lerp(fy, sy, t), z = lerp(fz, sz, t);
        if (gl && down > 0) {
          y -= 0.7 * Math.sin(Math.PI * t) * down * (1 - lie);
          const q = (i * LINE_SEG + j) * 3;
          x = lerp(x, gl[q], lie);
          y = lerp(y, gl[q + 1], lie);
          z = lerp(z, gl[q + 2], lie);
        }
        if (j === LINE_SEG) {
          x = sx;
          y = sy;
          z = sz;
        }
        put(px, py, pz);
        put(x, y, z);
        px = x;
        py = y;
        pz = z;
      }
    }
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    for (const side of [-1, 1]) {
      put(fx, fy, fz);
      put(cx + side * 0.56 * cs, cy + 0.42, cz - side * 0.56 * sn);
    }
  }

  private commit(normals: boolean): void {
    const a = this.geo.getAttribute('position') as THREE.BufferAttribute;
    a.needsUpdate = true;
    if (normals) this.geo.computeVertexNormals();
    (this.lineGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }

  /**
   * Works out once, while the crate is still coming down, where the canopy will lie: along the
   * helicopter's way in `inYaw` (the weapon case and serum lie across it), whichever way has room
   * before a wall or car, draped over the ground under it (curbs, low walls). `at` is where the
   * crate lands, `crateYaw` its heading there, `fall` its seconds in the air. The same on every
   * machine.
   */
  lay(at: { x: number; y: number; z: number }, inYaw: number, crateYaw: number, fall: number, physics: Physics | null): void {
    if (this.layout) return;
    this.landSpin = this.spinAt(fall);
    const rand = rng(this.seed * 40503 + 17);
    const base = inYaw + (rand() - 0.5) * 0.3;
    const tries = [0, Math.PI, 0.45, -0.45, Math.PI - 0.45, Math.PI + 0.45, 0.9, -0.9, Math.PI - 0.9, Math.PI + 0.9, Math.PI / 2, -Math.PI / 2];
    let yaw = base, room = -1;
    for (const off of tries) {
      const y = base + off;
      const free = physics ? this.room(physics, at, y) : LIE_FULL;
      if (free > room + 0.3) {
        room = free;
        yaw = y;
      }
      if (free >= LIE_FULL - 0.01) break;
    }
    const ax = Math.sin(yaw), az = Math.cos(yaw);
    const lay: Layout = { ax, az, bx: az, bz: -ax, len: THREE.MathUtils.clamp((room - LIE_FROM - 0.35) / LIE_LEN, 0.45, 1), heights: new Float32Array(GRID_A * GRID_B) };
    if (physics) {
      const filter = groups(0xffff, GROUP.static);
      for (let i = 0; i < GRID_A; i++) {
        for (let j = 0; j < GRID_B; j++) {
          const a = GRID_A0 + i * GRID_STEP, b = GRID_B0 + j * GRID_STEP;
          const x = at.x + a * ax + b * lay.bx, z = at.z + a * az + b * lay.bz;
          const d = physics.raycast(x, at.y + 1.6, z, 0, -1, 0, 2.4, filter);
          lay.heights[i * GRID_B + j] = d === null ? 0 : THREE.MathUtils.clamp(1.6 - d, -0.5, 1.2);
        }
      }
    }
    this.layout = lay;
    this.buildGround(lay, crateYaw);
  }

  /** Clear run from the crate along a direction, at knee and chest height, across the canopy's width. */
  private room(physics: Physics, at: { x: number; y: number; z: number }, yaw: number): number {
    const ax = Math.sin(yaw), az = Math.cos(yaw);
    let free = LIE_FULL;
    // From just clear of the crate (its own collider is in the world once it is down).
    const start = 0.8;
    for (const off of [-1, 0, 1]) {
      for (const h of [0.45, 1.25]) {
        const d = physics.raycast(at.x + ax * start + az * off, at.y + h, at.z + az * start - ax * off, ax, 0, az, LIE_FULL - start);
        if (d !== null && d + start < free) free = d + start;
      }
    }
    return free;
  }

  /** Ground height under a point of the lying frame (a along the canopy, b across it). */
  private heightAt(lay: Layout, a: number, b: number): number {
    const fa = THREE.MathUtils.clamp((a - GRID_A0) / GRID_STEP, 0, GRID_A - 1.001);
    const fb = THREE.MathUtils.clamp((b - GRID_B0) / GRID_STEP, 0, GRID_B - 1.001);
    const i = Math.floor(fa), j = Math.floor(fb);
    const ta = fa - i, tb = fb - j;
    const h = lay.heights;
    const h0 = lerp(h[i * GRID_B + j], h[i * GRID_B + j + 1], tb);
    const h1 = lerp(h[(i + 1) * GRID_B + j], h[(i + 1) * GRID_B + j + 1], tb);
    return lerp(h0, h1, ta);
  }

  /**
   * The canopy lying flat: tipped over with its crown away from the crate, flattened into two
   * layers (the side that faced upwind on top), gathered narrow at the crown and at the skirt where
   * the lines pull it together, pleated along every gore, with a pocket of air under the top layer.
   */
  private buildGround(lay: Layout, crateYaw: number): void {
    const ground = new Float32Array(COUNT * 3);
    const puff = new Float32Array(COUNT);
    const ph = this.ph;
    const bunch = 1 - lay.len;
    const spin = this.landSpin;
    const alpha = Math.atan2(lay.ax, lay.az);
    const crumple = 1 + 1.2 * bunch;
    const L = LIE_LEN * lay.len;
    // A little air still trapped under the top layer, in a couple of lumps toward the crown.
    const lumps = [
      [LIE_FROM + L * 0.62, 0.15 + (ph[2] - Math.PI) * 0.05, 0.75, 0.55, 0.14],
      [LIE_FROM + L * 0.34, -0.3 + (ph[3] - Math.PI) * 0.05, 0.5, 0.42, 0.08],
    ];
    for (let k = 0; k < COUNT; k++) {
      const v = this.gv[k], u = this.gu[k];
      // Where this point faced before it tipped over: the upwind half ends on top (sb > 0).
      let psi = -(this.phi[k] + spin + alpha);
      psi = Math.atan2(Math.sin(psi), Math.cos(psi));
      const sb = Math.sin(psi);
      // Flattened into two layers folded at the edges: +1 .. -1 across the top, back underneath.
      const across = 1 - (2 * Math.abs(psi)) / Math.PI;
      const top = smooth(sb, -0.2, 0.2);
      // Narrow at the crown, widest past the middle, gathered at the skirt where the lines pull it
      // together; a ragged outline. Noise only from (across, v), so both layers stay stacked.
      const prof = v < 0.55 ? 0.5 + 0.5 * Math.sin((Math.PI / 2) * (v / 0.55)) : 1 - 0.55 * smooth(v, 0.55, 1);
      const ragged = 1 + 0.2 * Math.sin(v * 7.3 + ph[0]) + 0.1 * Math.sin(v * 16.1 + ph[1]);
      const half = LIE_HALF * prof * ragged * (1 + 0.35 * bunch);
      const x = across * 2.6;
      const n1 = Math.sin(x + ph[2] + v * 5.3) * 0.6 + Math.sin(x * 2.3 + ph[3] - v * 9.1) * 0.4;
      const n2 = Math.sin(x * 1.7 + ph[4] + v * 7.7) * 0.6 + Math.sin(x * 3.1 + ph[5] + v * 12.3) * 0.4;
      const crown = (1 - v) * (1 - v) * (1 - v);
      const a = LIE_FROM + (1 - v) * L + 0.16 * n2 * (0.3 + 0.7 * (1 - v)) + this.lean * across * (1 - v) + 0.3 * crown * (1 - across * across);
      const b = half * across + 0.28 * Math.sin(v * 4.1 + ph[6]) * (1 - v) + 0.1 * n1;
      // Thin fabric: the bottom layer flat on the ground, the top one resting on it, pleated along
      // the middle of every gore and creased across like a crumpled sheet.
      const pleat = 0.08 * Math.pow(Math.sin(Math.PI * u), 2) * (0.4 + 0.6 * this.jitter[this.gore[k]]);
      const r1 = 1 - Math.abs(Math.sin(b * 3.4 + a * 0.7 + ph[0] + 0.8 * n1));
      const r2 = 1 - Math.abs(Math.sin(b * 2.1 - a * 1.0 + ph[1] + 0.8 * n2));
      const r3 = 0.5 + 0.5 * Math.sin(a * 2.2 + b * 0.8 + ph[2]);
      const r4 = 1 - Math.abs(Math.sin(b * 6.5 + a * 1.6 + ph[3] + 1.3 * n2));
      const crease = 0.11 * r1 * r1 * r1 + 0.08 * r2 * r2 * r2 + 0.06 * r3 + 0.04 * r4 * r4 * r4;
      let air = 0;
      for (const [la, lb, ra, rb, lh] of lumps) {
        const da = (a - la) / ra, db = (b - lb) / rb;
        air += lh * Math.exp(-da * da - db * db);
      }
      air *= (1 + bunch) * top;
      const edge = 0.35 + 0.65 * smooth(1 - Math.abs(across), 0, 0.3);
      const h = 0.012 + 0.04 * top + top * edge * ((pleat + crease) * crumple) + air + (1 - top) * 0.006 * n1;
      ground[k * 3] = a * lay.ax + b * lay.bx;
      ground[k * 3 + 1] = this.heightAt(lay, a, b) + h;
      ground[k * 3 + 2] = a * lay.az + b * lay.bz;
      puff[k] = air;
    }
    // Lines: from a confluence on the ground beside the crate, snaking out to the skirt.
    const lines = new Float32Array((GORES * LINE_SEG + 1) * 3);
    const ca = 0.8;
    lines[0] = ca * lay.ax;
    lines[1] = this.heightAt(lay, ca, 0) + 0.04;
    lines[2] = ca * lay.az;
    for (let i = 0; i < GORES; i++) {
      const k = i * PER_GORE + RINGS * ROW;
      const sx = ground[k * 3], sy = ground[k * 3 + 1], sz = ground[k * 3 + 2];
      for (let j = 1; j <= LINE_SEG; j++) {
        const t = j / LINE_SEG;
        const bow = Math.sin(Math.PI * t);
        const wb = 0.24 * Math.sin(j * 1.9 + i * 2.3 + ph[5]) * bow;
        const wa = 0.12 * Math.cos(j * 1.3 + i * 0.7) * bow;
        const x = lerp(lines[0], sx, t) + wb * lay.bx + wa * lay.ax;
        const z = lerp(lines[2], sz, t) + wb * lay.bz + wa * lay.az;
        const a = x * lay.ax + z * lay.az, b = x * lay.bx + z * lay.bz;
        const q = (i * LINE_SEG + j) * 3;
        lines[q] = x;
        lines[q + 1] = j === LINE_SEG ? sy : this.heightAt(lay, a, b) + 0.03;
        lines[q + 2] = z;
      }
    }
    this.ground = ground;
    this.puff = puff;
    this.lineTargets = lines;
    // The settled line set, written once and reused while it lies still.
    const save = this.pos.slice();
    this.pos.set(ground);
    this.writeLines(lines[0], lines[1], lines[2], 0, 0, 0, crateYaw, 1, Infinity);
    this.settledLines = this.linePos.slice();
    this.pos.set(save);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.geo.dispose();
    this.lineGeo.dispose();
    for (const m of this.materials) m.dispose();
  }
}
