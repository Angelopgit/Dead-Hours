import type { RAPIER, Physics } from '../physics/Physics';
import type { DoorBody } from '../physics/DoorBody';
import { BARRICADE, isBarricadeWindow, isVaultWindow } from '../config/barricades';
import { storeyFloors } from '../map/builder';
import type { MapDefinition } from '../types/world';
import type { NavGrid } from './NavGrid';
import type { Vec3 } from './math';

/** Climb-through link ids on the nav grid start here (one per window slot), clear of anything else. */
export const WINDOW_LINK_BASE = 1 << 16;

/**
 * An opening of an enterable building: an exterior door or a window. Doors and ground-storey
 * windows take boards (`max` > 0), nailed on from inside and pounded off by zombies one at a
 * time. Every window's glass can be smashed (shots, blows, blasts, a survivor vaulting through);
 * with glass and boards gone a zombie climbs in, and a survivor can vault through either way.
 */
export interface BarricadeSlot {
  index: number;
  kind: 'door' | 'window';
  houseId: string;
  /** Index into map.doors or map.windows. */
  ref: number;
  /** Centre of the opening, in the middle of the wall. */
  center: Vec3;
  /** Outward normal of the wall. */
  normal: { x: number; z: number };
  axis: 'x' | 'z';
  width: number;
  height: number;
  /** Height of the opening's bottom edge (the sill for windows, the floor for doors). */
  bottom: number;
  /** Floor of the storey the opening is in: survivors work on it standing there. */
  floor: number;
  /** Most boards it takes (0: an upstairs window or a slit nobody boards up). */
  max: number;
  /** Windows a survivor fits through (vaulting). */
  climb: boolean;
  boards: number;
  /** Pounding the outermost board has soaked (it splits off at BARRICADE.boardStrength). */
  damage: number;
  /** Windows: the pane is still in. */
  glass: boolean;
  pane: RAPIER.Collider | null;
  /** Windows a zombie can climb through: the nav nodes on the outside and the inside, else -1. */
  outNode: number;
  inNode: number;
  /** A zombie is climbing through until then. */
  busyUntil: number;
}

export class Barricades {
  readonly slots: BarricadeSlot[] = [];
  /** The window slots. */
  readonly windows: BarricadeSlot[] = [];
  private readonly byDoor = new Map<number, BarricadeSlot>();
  private readonly byPane = new Map<number, BarricadeSlot>();

  constructor(map: MapDefinition, nav: NavGrid, doors: (DoorBody | null)[], private readonly physics: Physics) {
    for (const d of doors) {
      if (!d) continue;
      const s = d.spec;
      const slot = this.add({
        kind: 'door', houseId: s.houseId, ref: d.index,
        center: { x: s.x, y: (s.floorY ?? 0.3) + s.h / 2, z: s.z }, normal: { ...d.normal }, axis: s.axis,
        width: s.w, height: s.h, bottom: s.floorY ?? 0.3, floor: s.floorY ?? 0.3, max: BARRICADE.doorBoards, climb: false, glass: false, pane: null, outNode: -1, inNode: -1,
      });
      this.byDoor.set(d.index, slot);
    }
    const houses = new Map(map.houses.map((h) => [h.id, h]));
    // Windows that take boards first (their slot numbers are the ones they always had), then the
    // rest of every enterable building's windows: upstairs ones and bathroom slits.
    const boardable = (i: number) => isBarricadeWindow(houses.get(map.windows[i].houseId), map.windows[i]);
    const order = map.windows.map((_, i) => i).filter((i) => houses.get(map.windows[i].houseId)?.enterable);
    for (const i of [...order.filter(boardable), ...order.filter((i) => !boardable(i))]) {
      const w = map.windows[i];
      const house = houses.get(w.houseId)!;
      const normal = w.axis === 'x' ? { x: 0, z: w.outward } : { x: w.outward, z: 0 };
      const bottom = w.y - w.h / 2;
      const pane = physics.paneAt(w.x, w.y, w.z);
      if (pane) physics.switchOn(pane);
      // Where a zombie stands to climb in, and where it lands: the nearest floor on each side.
      const side = (sign: number): number => {
        const x = w.x + normal.x * sign * 0.75, z = w.z + normal.z * sign * 0.75;
        const n = nav.nodeAt(x, bottom - 1.0, z, 0.6);
        if (!nav.reachable(n)) return -1;
        const drop = bottom - nav.nodeY[n];
        const off = (nav.nodeX(n) - w.x) * normal.x * sign + (nav.nodeZ(n) - w.z) * normal.z * sign;
        const lateral = Math.abs((nav.nodeX(n) - w.x) * normal.z) + Math.abs((nav.nodeZ(n) - w.z) * normal.x);
        return drop > 0.3 && drop < 1.6 && off > 0.3 && off < 1.3 && lateral < w.w / 2 ? n : -1;
      };
      const boards = boardable(i);
      // Zombies climb through the windows that take boards (not upstairs, where nothing reaches).
      const out = boards ? side(1) : -1, inn = boards ? side(-1) : -1;
      const ok = out >= 0 && inn >= 0;
      const slot = this.add({
        kind: 'window', houseId: w.houseId, ref: i, center: { x: w.x, y: w.y, z: w.z }, normal, axis: w.axis,
        width: w.w, height: w.h, bottom, floor: storeyFloors(house).filter((f) => f <= bottom).pop() ?? storeyFloors(house)[0],
        max: boards ? BARRICADE.windowBoards : 0, climb: isVaultWindow(house, w),
        glass: true, pane, outNode: ok ? out : -1, inNode: ok ? inn : -1,
      });
      if (ok) nav.setLink(WINDOW_LINK_BASE + slot.index, out, inn);
      if (pane) this.byPane.set(pane.handle, slot);
      this.windows.push(slot);
    }
    // Panes a previous night smashed are back in.
    physics.sync();
  }

  private add(s: Omit<BarricadeSlot, 'index' | 'boards' | 'damage' | 'busyUntil'>): BarricadeSlot {
    const slot: BarricadeSlot = { ...s, index: this.slots.length, boards: 0, damage: 0, busyUntil: 0 };
    this.slots.push(slot);
    return slot;
  }

  forDoor(door: number): BarricadeSlot | undefined {
    return this.byDoor.get(door);
  }

  /** The window whose glass a collider is. */
  forPane(handle: number): BarricadeSlot | undefined {
    return this.byPane.get(handle);
  }

  /** The window slot a nav link belongs to. */
  forLink(id: number): BarricadeSlot | undefined {
    const s = this.slots[id - WINDOW_LINK_BASE];
    return s && s.kind === 'window' ? s : undefined;
  }

  /** Which side of the opening a point is on (+1 outside, -1 inside). */
  side(s: BarricadeSlot, x: number, z: number): number {
    return Math.sign((x - s.center.x) * s.normal.x + (z - s.center.z) * s.normal.z) || 1;
  }

  /** Windows that take boards and doors (upstairs windows and slits don't). */
  boardable(s: BarricadeSlot): boolean {
    return s.max > 0;
  }

  /**
   * Whether a move from `a` to `b` (feet) goes through a boarded-up window: boards aren't solid
   * to the physics, so the server checks moves against them.
   */
  crossesBoards(a: Vec3, b: Vec3): boolean {
    for (const s of this.windows) {
      if (s.boards <= 0) continue;
      const da = (a.x - s.center.x) * s.normal.x + (a.z - s.center.z) * s.normal.z;
      const db = (b.x - s.center.x) * s.normal.x + (b.z - s.center.z) * s.normal.z;
      if ((da > 0) === (db > 0) || da === db) continue;
      const t = da / (da - db);
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      const lateral = Math.abs((x - s.center.x) * s.normal.z) + Math.abs((z - s.center.z) * s.normal.x);
      // Feet anywhere from a body's height under the sill to the top of the opening.
      if (lateral < s.width / 2 + 0.3 && y > s.bottom - 1.9 && y < s.bottom + s.height) return true;
    }
    return false;
  }

  /** Nothing in the way: no glass, no boards. */
  clear(s: BarricadeSlot): boolean {
    return s.boards === 0 && !s.glass;
  }

  /** Smashes the pane (and lets bullets and sight through). Returns false when it was already out. */
  breakGlass(s: BarricadeSlot): boolean {
    if (!s.glass) return false;
    s.glass = false;
    // Rays cast this same step must already go through.
    if (s.pane) this.physics.switchOff(s.pane);
    return true;
  }

  /**
   * Pounding on the boards. Returns how many came off (0 or 1); the damage left over carries to
   * the next board only up to a split, so one blow never takes two.
   */
  pound(s: BarricadeSlot, amount: number): number {
    if (s.boards <= 0) return 0;
    s.damage += amount;
    if (s.damage < BARRICADE.boardStrength) return 0;
    s.damage = 0;
    s.boards--;
    return 1;
  }

  /** Takes the state the server decided (network clients). */
  remote(s: BarricadeSlot, boards: number, damage: number, glass: boolean): void {
    s.boards = Math.max(0, Math.min(s.max, boards));
    s.damage = damage;
    if (!glass) this.breakGlass(s);
  }
}
