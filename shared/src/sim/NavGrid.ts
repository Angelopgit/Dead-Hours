import { RAPIER, GROUP, groups, type Physics } from '../physics/Physics';
import type { MapDefinition } from '../types/world';
import { propColliders } from '../map/colliders';
import { isDrivable } from '../config/vehicles';
import type { Vec3 } from './math';

/**
 * Layered navigation grid for zombies, built from the real collision world so it matches what
 * characters can walk on: 0.5 m columns, each holding every floor at that spot (street, upper
 * storey, basement). A cell is walkable when a 0.48 m square column of air from knee to head
 * height is free, so neighbouring cells tile the plane and nothing thin can sit between two
 * connected cells. Door leaves are ignored here; zombies deal with closed doors themselves.
 */
export const NAV = {
  cell: 0.5,
  half: 0.24,
  /** Air column checked above each floor, relative to the floor. */
  clearFrom: 0.3,
  clearTo: 1.6,
  /** Largest height change between neighbouring cells (character autostep is 0.4). */
  maxStep: 0.42,
  castTop: 14,
  minFloor: -3.4,
  maxLayers: 6,
} as const;

/** Node flags. */
export const NAV_REACHABLE = 1;
export const NAV_NEAR_WALL = 2;
export const NAV_INDOOR = 4;

const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DZ = [0, 1, 0, -1, 1, 1, -1, -1];
const DIAG = Math.SQRT2;

export interface NavBuffers {
  cols: number;
  rows: number;
  x0: number;
  z0: number;
  colStart: Int32Array;
  nodeY: Float32Array;
  flags: Uint8Array;
  door: Int16Array;
  links: Int32Array;
}

export interface PathOptions {
  /** Node expansion budget; when exhausted the path to the closest node found is returned. */
  maxExpand?: number;
  /** Per-agent seed: adds a stable cost jitter so agents spread over different routes. */
  seed?: number;
  /** Extra cost for crossing a door cell (closed doors cost more). */
  doorCost?: (door: number) => number;
  /**
   * Extra cost for taking a climb-through link (see setLink), Infinity when it can't be taken.
   * Without it links are ignored.
   */
  linkCost?: (id: number) => number;
}

/** A climb-through link a path takes, from one side to the other. */
export interface PathLink {
  id: number;
  from: Vec3;
  to: Vec3;
}

export interface PathResult {
  points: Vec3[];
  /** False when the budget ran out and the path ends at the closest node found. */
  complete: boolean;
  /** Door indices crossed, in order. */
  doors: number[];
  /** Climb-through links taken, in order (their ends are waypoints). */
  links: PathLink[];
}

function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

export class NavGrid implements NavBuffers {
  readonly cols: number;
  readonly rows: number;
  readonly x0: number;
  readonly z0: number;
  readonly colStart: Int32Array;
  readonly nodeY: Float32Array;
  readonly flags: Uint8Array;
  readonly door: Int16Array;
  /** 8 neighbour node indices per node (-1 when not connected). */
  readonly links: Int32Array;
  private readonly nodeColumn: Int32Array;
  // A* scratch, reused between searches.
  private readonly g: Float32Array;
  private readonly parent: Int32Array;
  private readonly stamp: Uint32Array;
  private readonly closed: Uint32Array;
  private generation = 0;
  private heapNodes: Int32Array;
  private heapF: Float32Array;
  /**
   * Links that aren't walking: windows a zombie climbs through. Not part of the cached buffers; the
   * simulation sets them from the map, keyed by id so setting them again changes nothing.
   */
  private readonly linkEnds = new Map<number, [number, number]>();
  private readonly extra = new Map<number, { to: number; id: number }[]>();

  constructor(b: NavBuffers) {
    this.cols = b.cols;
    this.rows = b.rows;
    this.x0 = b.x0;
    this.z0 = b.z0;
    this.colStart = b.colStart;
    this.nodeY = b.nodeY;
    this.flags = b.flags;
    this.door = b.door;
    this.links = b.links;
    const n = this.nodeY.length;
    this.nodeColumn = new Int32Array(n);
    for (let c = 0; c < this.cols * this.rows; c++) {
      for (let i = this.colStart[c]; i < this.colStart[c + 1]; i++) this.nodeColumn[i] = c;
    }
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heapNodes = new Int32Array(4096);
    this.heapF = new Float32Array(4096);
  }

  get nodeCount(): number {
    return this.nodeY.length;
  }

  buffers(): NavBuffers {
    return { cols: this.cols, rows: this.rows, x0: this.x0, z0: this.z0, colStart: this.colStart, nodeY: this.nodeY, flags: this.flags, door: this.door, links: this.links };
  }

  nodeX(n: number): number {
    return this.x0 + ((this.nodeColumn[n] % this.cols) + 0.5) * NAV.cell;
  }

  nodeZ(n: number): number {
    return this.z0 + (Math.floor(this.nodeColumn[n] / this.cols) + 0.5) * NAV.cell;
  }

  nodePos(n: number): Vec3 {
    return { x: this.nodeX(n), y: this.nodeY[n], z: this.nodeZ(n) };
  }

  reachable(n: number): boolean {
    return n >= 0 && (this.flags[n] & NAV_REACHABLE) !== 0;
  }

  private column(x: number, z: number): number {
    const ix = Math.floor((x - this.x0) / NAV.cell);
    const iz = Math.floor((z - this.z0) / NAV.cell);
    if (ix < 0 || iz < 0 || ix >= this.cols || iz >= this.rows) return -1;
    return iz * this.cols + ix;
  }

  /** Reachable node in a column whose floor is nearest to `y` (within a storey), or -1. */
  private inColumn(c: number, y: number, tolerance: number): number {
    if (c < 0) return -1;
    let best = -1;
    let bestD = tolerance;
    for (let i = this.colStart[c]; i < this.colStart[c + 1]; i++) {
      if (!(this.flags[i] & NAV_REACHABLE)) continue;
      // Feet sit on (or slightly above) the floor; prefer the floor just below the point.
      const d = Math.abs(y - this.nodeY[i] - 0.05);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Node under a position. Falls back to the nearest reachable cell within `radius` meters. */
  nodeAt(x: number, y: number, z: number, radius = 1.5): number {
    const direct = this.inColumn(this.column(x, z), y, 1.2);
    if (direct >= 0) return direct;
    const r = Math.ceil(radius / NAV.cell);
    const ix = Math.floor((x - this.x0) / NAV.cell);
    const iz = Math.floor((z - this.z0) / NAV.cell);
    let best = -1;
    let bestD = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const cx = ix + dx, cz = iz + dz;
        if (cx < 0 || cz < 0 || cx >= this.cols || cz >= this.rows) continue;
        const n = this.inColumn(cz * this.cols + cx, y, 1.2);
        if (n < 0) continue;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
    }
    return best;
  }

  /** Joins two nodes both ways with climb-through link `id` (replacing whatever `id` joined before). */
  setLink(id: number, a: number, b: number): void {
    const old = this.linkEnds.get(id);
    if (old && old[0] === a && old[1] === b) return;
    if (old) for (const n of old) this.extra.set(n, (this.extra.get(n) ?? []).filter((e) => e.id !== id));
    this.linkEnds.set(id, [a, b]);
    for (const [from, to] of [[a, b], [b, a]]) {
      const list = this.extra.get(from) ?? [];
      list.push({ to, id });
      this.extra.set(from, list);
    }
  }

  /** The nodes link `id` joins. */
  linkNodes(id: number): [number, number] | undefined {
    return this.linkEnds.get(id);
  }

  private linkBetween(a: number, b: number): number {
    const list = this.extra.get(a);
    if (list) for (const e of list) if (e.to === b) return e.id;
    return -1;
  }

  /** Neighbour of `n` in direction index 0..7, or -1. */
  link(n: number, dir: number): number {
    return this.links[n * 8 + dir];
  }

  /**
   * Whether an agent can walk straight from node a to node b: every column crossed has a
   * connected floor. Used for path smoothing and direct pursuit.
   */
  walkableLine(a: number, b: number): boolean {
    if (a < 0 || b < 0) return false;
    if (a === b) return true;
    const ca = this.nodeColumn[a], cb = this.nodeColumn[b];
    const dx = (cb % this.cols) - (ca % this.cols);
    const dz = Math.floor(cb / this.cols) - Math.floor(ca / this.cols);
    const adx = Math.abs(dx), adz = Math.abs(dz);
    const dirX = dx > 0 ? 0 : 2, dirZ = dz > 0 ? 1 : 3;
    // Grid traversal between cell centers, one orthogonal step at a time, so the line can't
    // slip diagonally between two blocked cells.
    const tdx = adx ? 1 / adx : Infinity, tdz = adz ? 1 / adz : Infinity;
    let tx = adx ? 0.5 / adx : Infinity, tz = adz ? 0.5 / adz : Infinity;
    let cur = a;
    for (let steps = adx + adz; steps > 0; steps--) {
      let dir: number;
      if (tx <= tz) {
        dir = dirX;
        tx += tdx;
      } else {
        dir = dirZ;
        tz += tdz;
      }
      const next = this.links[cur * 8 + dir];
      if (next < 0 || !(this.flags[next] & NAV_REACHABLE)) return false;
      cur = next;
    }
    return this.nodeColumn[cur] === cb;
  }

  private heapPush(size: number, node: number, f: number): number {
    if (size >= this.heapNodes.length) {
      const nn = new Int32Array(this.heapNodes.length * 2);
      nn.set(this.heapNodes);
      const nf = new Float32Array(this.heapF.length * 2);
      nf.set(this.heapF);
      this.heapNodes = nn;
      this.heapF = nf;
    }
    let i = size;
    const hn = this.heapNodes, hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      hn[i] = hn[p];
      hf[i] = hf[p];
      i = p;
    }
    hn[i] = node;
    hf[i] = f;
    return size + 1;
  }

  private heapPop(size: number): number {
    const hn = this.heapNodes, hf = this.heapF;
    const n = size - 1;
    const lastN = hn[n], lastF = hf[n];
    let i = 0;
    while (true) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && hf[c + 1] < hf[c]) c++;
      if (hf[c] >= lastF) break;
      hn[i] = hn[c];
      hf[i] = hf[c];
      i = c;
    }
    hn[i] = lastN;
    hf[i] = lastF;
    return n;
  }

  /** A* over the grid with octile heuristic. Returns waypoints from start to goal (smoothed). */
  findPath(from: Vec3, to: Vec3, opts: PathOptions = {}): PathResult | null {
    const start = this.nodeAt(from.x, from.y, from.z);
    const goal = this.nodeAt(to.x, to.y, to.z, 3);
    if (start < 0 || goal < 0) return null;
    const maxExpand = opts.maxExpand ?? 12000;
    const seed = opts.seed ?? 0;
    const gen = ++this.generation;
    const gx = this.nodeX(goal), gz = this.nodeZ(goal), gy = this.nodeY[goal];
    const cell = NAV.cell;
    const h = (n: number) => {
      const dx = Math.abs(this.nodeX(n) - gx), dz = Math.abs(this.nodeZ(n) - gz);
      return (Math.max(dx, dz) + (DIAG - 1) * Math.min(dx, dz)) + Math.abs(this.nodeY[n] - gy);
    };
    this.g[start] = 0;
    this.parent[start] = -1;
    this.stamp[start] = gen;
    let size = this.heapPush(0, start, h(start));
    let best = start;
    let bestH = h(start);
    let expanded = 0;
    let found = false;
    while (size > 0) {
      const cur = this.heapNodes[0];
      size = this.heapPop(size);
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      if (cur === goal) {
        found = true;
        break;
      }
      const hc = h(cur);
      if (hc < bestH) {
        bestH = hc;
        best = cur;
      }
      if (++expanded > maxExpand) break;
      const gc = this.g[cur];
      for (let d = 0; d < 8; d++) {
        const nb = this.links[cur * 8 + d];
        if (nb < 0 || this.closed[nb] === gen || !(this.flags[nb] & NAV_REACHABLE)) continue;
        let cost = (d < 4 ? 1 : DIAG) * cell;
        if (this.flags[nb] & NAV_NEAR_WALL) cost *= 1.5;
        if (seed) cost *= 1 + hash(nb >> 2, seed) * 0.5;
        const dr = this.door[nb];
        if (dr >= 0 && opts.doorCost) cost += opts.doorCost(dr);
        const ng = gc + cost;
        if (this.stamp[nb] === gen && ng >= this.g[nb]) continue;
        this.stamp[nb] = gen;
        this.g[nb] = ng;
        this.parent[nb] = cur;
        size = this.heapPush(size, nb, ng + h(nb));
      }
      const ex = opts.linkCost ? this.extra.get(cur) : undefined;
      if (ex) {
        for (const e of ex) {
          const nb = e.to;
          if (this.closed[nb] === gen || !(this.flags[nb] & NAV_REACHABLE)) continue;
          const extra = opts.linkCost!(e.id);
          if (!(extra < Infinity)) continue;
          const ng = gc + Math.hypot(this.nodeX(nb) - this.nodeX(cur), this.nodeZ(nb) - this.nodeZ(cur)) + extra;
          if (this.stamp[nb] === gen && ng >= this.g[nb]) continue;
          this.stamp[nb] = gen;
          this.g[nb] = ng;
          this.parent[nb] = cur;
          size = this.heapPush(size, nb, ng + h(nb));
        }
      }
    }
    const end = found ? goal : best;
    const chain: number[] = [];
    for (let n = end; n >= 0; n = this.parent[n]) {
      chain.push(n);
      if (n === start) break;
    }
    chain.reverse();
    const doors: number[] = [];
    for (const n of chain) {
      const dr = this.door[n];
      if (dr >= 0 && doors[doors.length - 1] !== dr) doors.push(dr);
    }
    const links: PathLink[] = [];
    const keep = new Set<number>();
    if (this.extra.size) {
      for (let i = 1; i < chain.length; i++) {
        const id = this.linkBetween(chain[i - 1], chain[i]);
        if (id < 0) continue;
        let grid = false;
        for (let d = 0; d < 8; d++) if (this.links[chain[i - 1] * 8 + d] === chain[i]) grid = true;
        if (grid) continue;
        links.push({ id, from: this.nodePos(chain[i - 1]), to: this.nodePos(chain[i]) });
        keep.add(i - 1);
        keep.add(i);
      }
    }
    return { points: this.smooth(chain, keep), complete: found, doors, links };
  }

  /** String pulling: keeps a waypoint only where the straight walk to the next one is blocked. */
  private smooth(chain: number[], keep?: Set<number>): Vec3[] {
    if (chain.length <= 2) return chain.map((n) => this.nodePos(n));
    const out: Vec3[] = [this.nodePos(chain[0])];
    let anchor = 0;
    while (anchor < chain.length - 1) {
      let far = anchor + 1;
      const limit = Math.min(chain.length - 1, anchor + 24);
      for (let j = limit; j > anchor + 1; j--) {
        // On stairs keep waypoints close together so agents stay on the flight.
        if (Math.abs(this.nodeY[chain[j]] - this.nodeY[chain[anchor]]) > 0.6) continue;
        if (this.walkableLine(chain[anchor], chain[j])) {
          far = j;
          break;
        }
      }
      for (let j = anchor + 1; j < far; j++) {
        // Keep door cells as waypoints so agents line up with the opening, and both ends of a climb.
        if (this.door[chain[j]] >= 0 || keep?.has(j)) {
          far = j;
          break;
        }
      }
      out.push(this.nodePos(chain[far]));
      anchor = far;
    }
    return out;
  }

  /** Random reachable node within a radius of a point (wander targets). */
  randomNear(x: number, y: number, z: number, radius: number, rand: () => number, outdoorOnly = false): number {
    for (let tries = 0; tries < 24; tries++) {
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(rand()) * radius;
      const n = this.nodeAt(x + Math.cos(a) * r, y, z + Math.sin(a) * r, 0.6);
      if (n >= 0 && (!outdoorOnly || !(this.flags[n] & NAV_INDOOR))) return n;
    }
    return -1;
  }
}

/**
 * Builds the grid by ray casting down every column and testing the air above each floor.
 * A generator so the browser can spread the work over frames; yields progress 0..1.
 */
export function* buildNavGrid(physics: Physics, map: MapDefinition): Generator<number, NavGrid> {
  const R = RAPIER;
  const world = physics.world;
  const b = map.bounds;
  const cols = Math.round((b.x1 - b.x0) / NAV.cell);
  const rows = Math.round((b.z1 - b.z0) / NAV.cell);
  const x0 = b.x0, z0 = b.z0;
  const staticOnly = groups(0xffff, GROUP.static);
  const box = new R.Cuboid(NAV.half, (NAV.clearTo - NAV.clearFrom) / 2, NAV.half);
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  const down = { x: 0, y: -1, z: 0 };
  const ray = new R.Ray({ x: 0, y: 0, z: 0 }, down);
  // The cars where they are parked when the night starts count as solid here: zombies path round
  // them (a car driven away leaves a gap they skirt; one parked somewhere new they slide along).
  // The grid is then the same as when cars were scenery, so cached grids stay good.
  const parked = world.createRigidBody(R.RigidBodyDesc.fixed());
  for (const p of map.props) {
    if (!isDrivable(p)) continue;
    for (const c of propColliders(p)) {
      const q = { x: 0, y: Math.sin(c.rotY / 2), z: 0, w: Math.cos(c.rotY / 2) };
      world.createCollider(R.ColliderDesc.cuboid(c.hx, c.hy, c.hz).setTranslation(c.x, c.y, c.z).setRotation(q).setCollisionGroups(groups(GROUP.static, 0xffff)), parked);
    }
  }
  world.step();
  try {

    const colStart = new Int32Array(cols * rows + 1);
    const ys: number[] = [];
    const indoor: boolean[] = [];
    const floorsAt: number[] = [];
    for (let iz = 0; iz < rows; iz++) {
      const cz = z0 + (iz + 0.5) * NAV.cell;
      for (let ix = 0; ix < cols; ix++) {
        const cx = x0 + (ix + 0.5) * NAV.cell;
        colStart[iz * cols + ix] = ys.length;
        floorsAt.length = 0;
        let top: number = NAV.castTop;
        let roofAbove = false;
        for (let guard = 0; guard < 16 && top > NAV.minFloor; guard++) {
          ray.origin = { x: cx, y: top, z: cz };
          const hit = world.castRayAndGetNormal(ray, top - NAV.minFloor, true, undefined, staticOnly);
          if (!hit) break;
          const y = top - hit.timeOfImpact;
          if (hit.timeOfImpact > 0 && hit.normal.y > 0.7) floorsAt.push(y, roofAbove ? 1 : 0);
          roofAbove = true;
          if (physics.isGround(hit.collider)) break;
          // Step through the solid to its underside and keep looking for floors below.
          ray.origin = { x: cx, y: y - 0.002, z: cz };
          const exit = world.castRay(ray, y - NAV.minFloor, false, undefined, staticOnly);
          if (!exit) break;
          top = y - 0.002 - exit.timeOfImpact - 0.002;
        }
        for (let i = 0; i < floorsAt.length && ys.length - colStart[iz * cols + ix] < NAV.maxLayers; i += 2) {
          const fy = floorsAt[i];
          const center = { x: cx, y: fy + (NAV.clearFrom + NAV.clearTo) / 2, z: cz };
          // (The plural query walks the BVH; the singular one is linear in Rapier 0.14.)
          let blocked = false;
          world.intersectionsWithShape(center, rot, box, () => { blocked = true; return false; }, undefined, staticOnly);
          if (blocked) continue;
          ys.push(fy);
          indoor.push(floorsAt[i + 1] === 1);
        }
      }
      // Every row, so a page can build the grid in short idle moments between frames.
      yield (iz / rows) * 0.9;
    }
    colStart[cols * rows] = ys.length;
    const n = ys.length;
    const nodeY = Float32Array.from(ys);
    const flags = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (indoor[i]) flags[i] |= NAV_INDOOR;
    const links = new Int32Array(n * 8).fill(-1);

    const nearestIn = (c: number, y: number): number => {
      let best = -1;
      let bestD: number = NAV.maxStep;
      for (let i = colStart[c]; i < colStart[c + 1]; i++) {
        const d = Math.abs(nodeY[i] - y);
        if (d <= bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    };
    for (let iz = 0; iz < rows; iz++) {
      for (let ix = 0; ix < cols; ix++) {
        const c = iz * cols + ix;
        for (let i = colStart[c]; i < colStart[c + 1]; i++) {
          for (let d = 0; d < 4; d++) {
            const nx = ix + DX[d], nz = iz + DZ[d];
            if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
            links[i * 8 + d] = nearestIn(nz * cols + nx, nodeY[i]);
          }
        }
      }
      if (iz % 8 === 0) yield 0.9 + (iz / rows) * 0.05;
    }
    // Diagonals only where both orthogonal steps connect (no corner cutting).
    for (let i = 0; i < n; i++) {
      for (let d = 4; d < 8; d++) {
        const ox = DX[d], oz = DZ[d];
        const a = links[i * 8 + (ox > 0 ? 0 : 2)];
        const b = links[i * 8 + (oz > 0 ? 1 : 3)];
        if (a < 0 || b < 0) continue;
        const viaA = links[a * 8 + (oz > 0 ? 1 : 3)];
        const viaB = links[b * 8 + (ox > 0 ? 0 : 2)];
        if (viaA >= 0 && viaA === viaB) links[i * 8 + d] = viaA;
      }
    }
    yield 0.95;

    // Reachability: flood from the player spawns; roofs, car tops and sealed rooms drop out.
    const nav = new NavGrid({ cols, rows, x0, z0, colStart, nodeY, flags, door: new Int16Array(n).fill(-1), links });
    const queue = new Int32Array(n);
    let qh = 0, qt = 0;
    for (const s of map.playerSpawns) {
      const ix = Math.floor((s.x - x0) / NAV.cell), iz = Math.floor((s.z - z0) / NAV.cell);
      const c = iz * cols + ix;
      for (let i = colStart[c]; i < colStart[c + 1]; i++) {
        if (Math.abs(nodeY[i] - s.y) < 0.6 && !(flags[i] & NAV_REACHABLE)) {
          flags[i] |= NAV_REACHABLE;
          queue[qt++] = i;
        }
      }
    }
    while (qh < qt) {
      const cur = queue[qh++];
      for (let d = 0; d < 8; d++) {
        const nb = links[cur * 8 + d];
        if (nb < 0 || flags[nb] & NAV_REACHABLE) continue;
        flags[nb] |= NAV_REACHABLE;
        queue[qt++] = nb;
      }
    }
    for (let i = 0; i < n; i++) {
      let open = 0;
      for (let d = 0; d < 8; d++) if (links[i * 8 + d] >= 0) open++;
      if (open < 8) flags[i] |= NAV_NEAR_WALL;
    }

    // Door cells: the opening plus a little on each side.
    map.doors.forEach((dspec, index) => {
      const alongX = dspec.axis === 'x';
      const hw = dspec.w / 2 + 0.05;
      const depth = 0.55;
      const xa = alongX ? dspec.x - hw : dspec.x - depth, xb = alongX ? dspec.x + hw : dspec.x + depth;
      const za = alongX ? dspec.z - depth : dspec.z - hw, zb = alongX ? dspec.z + depth : dspec.z + hw;
      const floor = dspec.floorY ?? 0.3;
      for (let z = za; z <= zb; z += NAV.cell * 0.5) {
        for (let x = xa; x <= xb; x += NAV.cell * 0.5) {
          const ix = Math.floor((x - x0) / NAV.cell), iz = Math.floor((z - z0) / NAV.cell);
          if (ix < 0 || iz < 0 || ix >= cols || iz >= rows) continue;
          const c = iz * cols + ix;
          for (let i = colStart[c]; i < colStart[c + 1]; i++) if (Math.abs(nodeY[i] - floor) < 0.5) nav.door[i] = index;
        }
      }
    });
    yield 1;
    return nav;
  } finally {
    world.removeRigidBody(parked);
  }
}

export function buildNavGridSync(physics: Physics, map: MapDefinition): NavGrid {
  const it = buildNavGrid(physics, map);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
