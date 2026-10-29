/** Surface/material keys shared by the renderer (visuals) and the simulation (impact types later). */
export type MaterialKey =
  | 'asphalt'
  | 'sidewalk'
  | 'curb'
  | 'concrete'
  | 'grass'
  | 'dirt'
  | 'gravel'
  | 'sidingBlue'
  | 'sidingGreen'
  | 'sidingGray'
  | 'sidingBeige'
  | 'brick'
  | 'stucco'
  | 'interiorWall'
  | 'interiorWallBlue'
  | 'woodFloor'
  | 'carpet'
  | 'tile'
  | 'trim'
  | 'fenceWood'
  | 'darkWood'
  | 'metal'
  | 'roofFlat'
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
  /** Window glass: blocks movement but lets baked light through. Breakable in Phase 6. */
  glass?: boolean;
  /** Tilt for ramps (stairs collision), radians about the X or Z axis. */
  rotX?: number;
  rotZ?: number;
}

export type Facing = 'north' | 'south';
export type WallSide = 'front' | 'back' | 'west' | 'east';

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
  /** Floor slab height (default 0.3). Garages sit at ground level. */
  slab?: number;
  /** Ground-storey wall height (default 3.0). */
  groundHeight?: number;
  roof?: 'gable-x' | 'gable-z' | 'flat';
  /** Walls shared with a neighbouring structure. */
  skipWalls?: WallSide[];
  /** Interior wall finish for enterable houses. */
  interior?: MaterialKey;
  /** Floor finish for enterable houses. */
  floorMat?: MaterialKey;
  /** Display name for location notices. */
  label?: string;
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
  /** Storefront glass has no mullions. */
  plain?: boolean;
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
  style?: 'wood' | 'glass' | 'rollup';
  /** Floor height under the door. */
  floorY?: number;
}

export type PropKind =
  // street
  | 'streetlight' | 'car' | 'policeCar' | 'wreckedCar' | 'trashBin' | 'mailbox' | 'tree' | 'pine' | 'bush'
  | 'hydrant' | 'utilityPole' | 'fence' | 'roadblock' | 'trashBag' | 'streetSign' | 'stopSign' | 'puddle' | 'leafPile'
  // checkpoint
  | 'jerseyBarrier' | 'sandbags' | 'floodlight' | 'tent' | 'cone' | 'armoredTruck' | 'boardSign'
  // gas station
  | 'pump' | 'signPylon' | 'dumpster' | 'tireStack' | 'oilDrum' | 'iceChest'
  // park
  | 'swingSet' | 'slide' | 'merryGoRound' | 'sandbox' | 'bench' | 'picnicTable' | 'parkLamp' | 'gazebo' | 'ironFence'
  // backyards
  | 'shed' | 'bbq' | 'patioTable' | 'trampoline' | 'clothesline' | 'woodpile' | 'doghouse' | 'kiddiePool'
  // interiors
  | 'sofa' | 'armchair' | 'coffeeTable' | 'tvStand' | 'bed' | 'wardrobe' | 'bookshelf' | 'counter' | 'fridge'
  | 'stove' | 'diningTable' | 'chair' | 'workbench' | 'metalShelf' | 'crate' | 'ammoCrate' | 'washer'
  | 'waterHeater' | 'desk' | 'dresser' | 'rug' | 'floorLamp' | 'storeShelf' | 'storeCounter' | 'cooler'
  | 'ceilingLamp' | 'stairs' | 'railing' | 'pallet' | 'mattress' | 'firstAid';

export interface PropSpec {
  kind: PropKind;
  x: number;
  z: number;
  rotY: number;
  /** Base height (upper floors, basements). Defaults to 0. */
  y?: number;
  /** Kind-specific variant (car color, fence length, flicker, ...). */
  variant?: number;
  /** Fence length / generic length along local X. */
  length?: number;
  /** Streetlights: whether this one flickers. Cars: hazards on. Police: strobes on. */
  flag?: boolean;
  /** Signs: text painted on the face. */
  text?: string;
  /** Can be picked up and placed as a barricade (Phase 6). */
  movable?: boolean;
  /** Stairs: rise over the run (along local +X). */
  rise?: number;
  /** Instanced woodland tree (no per-tree draw call). */
  forest?: boolean;
  /** Interaction the prop offers besides its kind's default (the workbench that is the weapon table). */
  use?: 'weapons';
}

/** Static light: baked into static geometry and sampled by dynamic objects through probes. */
export interface LightSpec {
  x: number;
  y: number;
  z: number;
  color: number;
  /** Luminous intensity in candela (Three.js physical units). */
  intensity: number;
  range: number;
  decay?: number;
  kind: 'point' | 'spot';
  /** Spot target. */
  tx?: number;
  ty?: number;
  tz?: number;
  angle?: number;
  penumbra?: number;
  /** Visible emitter shape the renderer draws at the light. */
  fixture?: 'bulb' | 'panel' | 'none';
}

export interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

export interface AreaSpec extends Rect {
  name: string;
  /** Vertical band, for basements and upper floors. */
  y0?: number;
  y1?: number;
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
  lights: LightSpec[];
  /** Ground removed from the terrain collider (basements). */
  excavations: Rect[];
  areas: AreaSpec[];
  playerSpawns: { x: number; y: number; z: number; yaw: number }[];
}
