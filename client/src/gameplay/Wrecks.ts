import * as THREE from 'three';
import { NEIGHBORHOOD, VOLATILE_STAGE, type Simulation, type Volatile } from '@dead-hours/shared';
import { showPiece, type BatchPiece } from '../rendering/StaticBatcher';
import { worldPieces } from '../environment/WorldPieces';
import type { SmoulderPoint } from '../effects/Pyro';
import { soot, type VehicleView } from './VehicleView';

/** Where on each kind the damage smokes and the fire starts (its own frame: x toward the nose), and how big it burns. */
const HOT: Record<string, { x: number; y: number; size: number }> = {
  car: { x: 1.45, y: 0.95, size: 1 },
  policeCar: { x: 1.45, y: 0.95, size: 1 },
  wreckedCar: { x: 1.45, y: 0.95, size: 1 },
  armoredTruck: { x: 2.3, y: 1.5, size: 1.3 },
  pump: { x: 0, y: 1.5, size: 0.7 },
  oilDrum: { x: 0, y: 0.85, size: 0.5 },
};
const CARS = new Set(['car', 'policeCar', 'wreckedCar']);
/** A burnt-out shell smokes this long, and still shows flames this long (seconds). */
const SMOKE = 45, FLAMES = 16;
/** A car's roof and whatever sat on it are higher than this over the road; they come down this far onto the body. */
const ROOF = 1.3, ROOF_DROP = 0.59;

const _v = new THREE.Vector3();

/**
 * The night's cars, pumps and drums as they are shot up: smoke from the damage, flames when they
 * catch, and once they blow a blackened shell where they stood. Parked ones are pieces of the
 * static world (their vertices repainted with soot, their glass taken out, the roof dropped onto
 * the body); driven ones are blackened by the vehicle view. Drawn from the simulation's state
 * each frame, so a survivor who joins late sees the same wrecks. Everything is put back when the
 * night ends.
 */
export class Wrecks {
  private readonly shown: number[];
  /** Seconds since each blew (as seen here). */
  private readonly since: number[];
  private readonly undo: (() => void)[] = [];
  private readonly points: SmoulderPoint[] = [];

  constructor(private readonly sim: Simulation, private readonly vehicles: VehicleView) {
    this.shown = sim.volatiles.list.map(() => VOLATILE_STAGE.fine);
    this.since = sim.volatiles.list.map(() => 0);
  }

  /** Where one's damage shows (its hood, the top of a pump), or its middle once it has burnt out. */
  private hot(v: Volatile, out: THREE.Vector3): number {
    const h = HOT[v.kind] ?? HOT.car;
    let yaw = v.yaw;
    if (v.vehicle) {
      const drawn = this.vehicles.drawnPose(v.vehicle.id, out);
      if (drawn === null) out.set(v.vehicle.pos.x, v.vehicle.pos.y, v.vehicle.pos.z);
      yaw = drawn ?? v.vehicle.yaw;
    } else out.set(v.home.x, v.home.y, v.home.z);
    const blown = v.stage === VOLATILE_STAGE.blown;
    const lx = blown ? 0 : h.x, ly = blown ? Math.min(h.y, v.def.centre + 0.1) : h.y;
    out.x += lx * Math.cos(yaw);
    out.z -= lx * Math.sin(yaw);
    out.y += ly;
    return h.size * (blown ? 1.25 : 1);
  }

  /** Brings what is drawn up to date and returns what smokes and burns this frame (for Pyro). */
  update(dt: number): SmoulderPoint[] {
    const list = this.sim.volatiles.list;
    this.points.length = 0;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      if (v.stage !== this.shown[i]) {
        if (v.stage === VOLATILE_STAGE.blown) this.char(v);
        this.shown[i] = v.stage;
        this.since[i] = 0;
      }
      if (v.stage === VOLATILE_STAGE.fine) continue;
      let strength = 1;
      if (v.stage === VOLATILE_STAGE.blown) {
        this.since[i] += dt;
        // A drum is gone in the blast; a shell smokes on.
        const span = v.def.shell ? SMOKE : 5;
        if (this.since[i] > span) continue;
        strength = 1 - this.since[i] / span;
      } else if (v.stage === VOLATILE_STAGE.smoking) {
        strength = 1 - v.health / (v.def.health * 0.55);
        strength = 0.35 + 0.65 * Math.min(1, Math.max(0, strength));
      }
      const size = this.hot(v, _v);
      // A wreck's last flames die well before its smoke does.
      const stage = v.stage === VOLATILE_STAGE.blown && this.since[i] > FLAMES ? 4 : v.stage;
      this.points.push({ x: _v.x, y: _v.y, z: _v.z, stage, size, seed: (i * 0.618) % 1, strength });
    }
    return this.points;
  }

  /** The ones on fire (for the roar of it): id, where, how hard. */
  burning(out: { id: number; pos: THREE.Vector3; strength: number }[]): void {
    const list = this.sim.volatiles.list;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const blown = v.stage === VOLATILE_STAGE.blown;
      if (v.stage !== VOLATILE_STAGE.burning && !(blown && v.def.shell && this.since[i] < FLAMES)) continue;
      this.hot(v, _v);
      out.push({ id: -100 - i, pos: _v.clone(), strength: blown ? 0.7 * (1 - this.since[i] / FLAMES) : 0.8 });
    }
  }

  /** Blackens what blew up. */
  private char(v: Volatile): void {
    const prop = NEIGHBORHOOD.props[v.prop];
    worldPieces.burnt.add(prop);
    this.undo.push(() => worldPieces.burnt.delete(prop));
    if (v.vehicle) {
      const id = v.vehicle.id;
      this.vehicles.char(id, true);
      this.undo.push(() => this.vehicles.char(id, false));
      return;
    }
    const group = worldPieces.groups.get(`prop:${v.prop}`);
    if (!group) return;
    const base = prop.y ?? 0;
    const upright = CARS.has(prop.kind) && !(prop.kind === 'wreckedCar' && (prop.variant ?? 0) >= 10);
    for (const piece of group) {
      const mesh = piece.mesh;
      if (!mesh || piece.saved) continue;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      // Gone: a drum altogether; lamps, lettering and anything else that can't take soot; an upright car's glass.
      if (!v.def.shell || !mat.vertexColors || (upright && mat.name === 'car-glass')) {
        showPiece(piece, false);
        this.undo.push(() => showPiece(piece, true));
        continue;
      }
      this.blacken(piece, upright ? base + ROOF : Infinity);
    }
  }

  /** Soot over a piece's vertices; one that sits above `roof` (a car's roof, a light bar) comes down onto the body. */
  private blacken(piece: BatchPiece, roof: number): void {
    const g = piece.mesh!.geometry;
    const color = g.getAttribute('color') as THREE.BufferAttribute;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const a = piece.start * 3, n = piece.count * 3;
    const c = color.array as Float32Array, p = pos.array as Float32Array;
    const was = c.slice(a, a + n);
    for (let i = 0; i < n; i += 3) {
      const [r, gg, b] = soot(c[a + i], c[a + i + 1], c[a + i + 2], piece.start + i / 3);
      c[a + i] = r; c[a + i + 1] = gg; c[a + i + 2] = b;
    }
    color.addUpdateRange(a, n);
    color.needsUpdate = true;
    let low = Infinity;
    for (let i = 1; i < n; i += 3) low = Math.min(low, p[a + i]);
    const drop = low > roof;
    if (drop) {
      for (let i = 1; i < n; i += 3) p[a + i] -= ROOF_DROP;
      pos.addUpdateRange(a, n);
      pos.needsUpdate = true;
    }
    this.undo.push(() => {
      c.set(was, a);
      color.addUpdateRange(a, n);
      color.needsUpdate = true;
      if (!drop) return;
      for (let i = 1; i < n; i += 3) p[a + i] += ROOF_DROP;
      pos.addUpdateRange(a, n);
      pos.needsUpdate = true;
    });
  }

  /** Everything as the map has it again. */
  dispose(): void {
    for (let i = this.undo.length - 1; i >= 0; i--) this.undo[i]();
    this.undo.length = 0;
  }
}
