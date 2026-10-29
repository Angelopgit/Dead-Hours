/** Surface/material keys shared by the renderer (visuals) and the simulation (impact types later). */
export type MaterialKey =
  | 'asphalt'
  | 'sidewalk'
  | 'curb'
  | 'concrete'
  | 'grass'
  | 'dirt'
  | 'sidingBlue'
  | 'sidingGreen'
  | 'sidingGray'
  | 'sidingBeige'
  | 'brick'
  | 'interiorWall'
  | 'woodFloor'
  | 'tile'
  | 'trim'
  | 'fenceWood'
  | 'invisible';

/** An axis-aligned static box. Position is the box center; sizes are full extents (meters). */
export interface StaticBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  mat: MaterialKey;
  /** Defaults to true. */
  collide?: boolean;
  /** Defaults to true. */
  visible?: boolean;
}

export type Facing = 'north' | 'south';

export interface HouseSpec {
  id: string;
  /** Footprint center. */
  x: number;
  z: number;
  /** Width along X, depth along Z. */
  w: number;
  d: number;
  floors: 1 | 2;
  facing: Facing;
  siding: MaterialKey;
  roofColor: number;
  enterable: boolean;
  /** Fraction of windows lit from the inside (0..1). */
  litWindows: number;
  seed: number;
}

/** A window opening. Glass is a collider until it breaks (barricading arrives in Phase 6). */
export interface WindowSpec {
  id: string;
  houseId: string;
  x: number;
  y: number;
  z: number;
  /** Opening width along the wall, height. */
  w: number;
  h: number;
  /** Wall axis: 'x' means the wall runs along X (front/back walls). */
  axis: 'x' | 'z';
  /** Outward normal sign along the perpendicular axis. */
  outward: 1 | -1;
  lit: boolean;
}

export interface DoorSpec {
  id: string;
  houseId: string;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  axis: 'x' | 'z';
  outward: 1 | -1;
  /** Interior doorways have no door leaf. */
  exterior: boolean;
}

export type PropKind =
  | 'streetlight'
  | 'car'
  | 'policeCar'
  | 'wreckedCar'
  | 'trashBin'
  | 'mailbox'
  | 'tree'
  | 'pine'
  | 'bush'
  | 'hydrant'
  | 'utilityPole'
  | 'fence'
  | 'roadblock'
  | 'trashBag';

export interface PropSpec {
  kind: PropKind;
  x: number;
  z: number;
  rotY: number;
  /** Kind-specific variant (car color, fence length, flicker, ...). */
  variant?: number;
  /** Fence length / generic scale. */
  length?: number;
  /** Streetlights: whether this one flickers. Cars: hazards on. */
  flag?: boolean;
}

export interface MapDefinition {
  name: string;
  /** Half extent of the playable square (meters). */
  halfExtent: number;
  solids: StaticBox[];
  houses: HouseSpec[];
  windows: WindowSpec[];
  doors: DoorSpec[];
  props: PropSpec[];
  playerSpawns: { x: number; y: number; z: number; yaw: number }[];
}
