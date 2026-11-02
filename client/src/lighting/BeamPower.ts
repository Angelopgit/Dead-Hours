import * as THREE from 'three';
import { GROUP, groups, type Physics, type RayHit, type Surface } from '../core/Physics';

/**
 * The brightest a carried lamp or a fire may make what it lands on: radiance of the palest thing
 * in the hot spot (linear, before exposure). The bloom starts at 0.9 (PostFX), so across a room
 * nothing lit reaches it, and right up against a wall only the white window and door trim just
 * does: a faint glow, never a white-out. At full power the flashlight made a plaster wall half a
 * metre off about 25 times the bloom threshold, and a Molotov lit a car beside it white.
 */
export const HOTSPOT_FAR = 0.75;
export const HOTSPOT_NEAR = 1.0;
/** Light-to-surface distances (m) over which the cap eases from NEAR to FAR. */
const NEAR_FROM = 0.8;
const NEAR_TO = 2.5;
/** Rays per beam: one down the middle and a ring of this many through the bright core. */
const RING = 6;
/** The ring's angle from the axis, as a share of the cone's half angle. */
const RING_SHARE = 0.55;
/** Nothing counts as nearer than this (m): a lamp sits inside the survivor's capsule. */
const MIN_DIST = 0.2;
/** What a beam can land on: the world, doors, props and zombies (never survivors, a lamp sits inside one). */
const BEAM_FILTER = groups(0xffff, GROUP.static | GROUP.dynamic | GROUP.zombie);
/**
 * The palest thing the beam may be lighting where a ray lands, as linear luminance (Materials.ts).
 * Walls of every kind carry white window and door trim (0.45) that the collision boxes don't
 * have, so a wall counts as trim; brick houses have less of it. The ground is as dark as it looks:
 * asphalt, grass, dirt, the boards of a wooden floor. Tile (0.27) is the palest floor.
 */
export const TRIM_ALBEDO = 0.45;
const ALBEDO: Record<Surface, number> = {
  plaster: TRIM_ALBEDO, wood: TRIM_ALBEDO, concrete: TRIM_ALBEDO, metal: TRIM_ALBEDO, glass: TRIM_ALBEDO,
  brick: 0.2, fabric: 0.2, flesh: 0.25, dirt: 0.09, grass: 0.05, asphalt: 0.04,
};
/** Upward faces (floors, the ground) of the kinds above that aren't already ground. */
const FLOOR_ALBEDO: Partial<Record<Surface, number>> = { wood: 0.12, concrete: 0.27, plaster: 0.27, metal: 0.27, glass: 0.27 };

/** What lands where the light may go too bright. */
const LAMP_FILTER = groups(0xffff, GROUP.static | GROUP.dynamic);
/**
 * Round a point light: four ways level, four ways down at 45° (the ground round it) and straight
 * up (a ceiling). Straight down is left out: what burns covers the ground right under a fire.
 */
const LAMP_RAYS = [
  ...[0, 1, 2, 3].map((i) => new THREE.Vector3(Math.cos((i * Math.PI) / 2), 0, Math.sin((i * Math.PI) / 2))),
  ...[0, 1, 2, 3].map((i) => new THREE.Vector3(Math.cos(((i + 0.5) * Math.PI) / 2), -1, Math.sin(((i + 0.5) * Math.PI) / 2)).normalize()),
  new THREE.Vector3(0, 1, 0),
];

const _ray = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
/** What the rays of one light found: its brightest spot (radiance × π per candela), the nearest hit. */
const found = { peak: 0, near: Infinity };

/**
 * How much of its full power (0..1] a carried spot may use so the brightest thing it lands on
 * stays at the hotspot cap. Casts down the middle of the beam and round a ring through its core,
 * and takes the spot that would come out brightest: how close, how square on, how pale, how near
 * the axis. Down a street nothing comes close to the cap and the beam keeps full power; against a
 * wall it drops to a few percent.
 *
 * `light` gives the cone and the falloff, `candela` the full power, `from` and `dir` where the
 * light sits and points (world).
 */
export function beamPower(physics: Physics, light: THREE.SpotLight, candela: number, from: THREE.Vector3, dir: THREE.Vector3): number {
  _side.set(-dir.z, 0, dir.x);
  if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0);
  _side.normalize();
  _up.crossVectors(_side, dir).normalize();
  const ring = light.angle * RING_SHARE;
  const c = Math.cos(ring);
  const s = Math.sin(ring);
  // three.js's cone: full inside angle × (1 - penumbra), smoothstep out to the edge.
  const ringSpot = THREE.MathUtils.smoothstep(c, Math.cos(light.angle), Math.cos(light.angle * (1 - light.penumbra)));
  found.peak = 0;
  found.near = Infinity;
  for (let i = 0; i <= RING; i++) {
    let spot = 1;
    if (i === 0) _ray.copy(dir);
    else {
      const a = ((i - 1) / RING) * Math.PI * 2;
      _ray.copy(dir).multiplyScalar(c).addScaledVector(_side, s * Math.cos(a)).addScaledVector(_up, s * Math.sin(a));
      spot = ringSpot;
    }
    cast(physics, from, _ray, spot, light, BEAM_FILTER);
  }
  return settle(candela, light.color);
}

/**
 * The same for a point light that sits low among things (a Molotov's fire, a burning body): how
 * much of its power it may use so the wall, car, ceiling or ground round it doesn't burn white.
 * Out in the open nothing is near and it keeps full power.
 */
export function lampPower(physics: Physics, light: THREE.PointLight, candela: number, from: THREE.Vector3): number {
  found.peak = 0;
  found.near = Infinity;
  for (const r of LAMP_RAYS) cast(physics, from, r, 1, light, LAMP_FILTER);
  return settle(candela, light.color);
}

function cast(physics: Physics, from: THREE.Vector3, dir: THREE.Vector3, spot: number, light: THREE.PointLight | THREE.SpotLight, filter: number): void {
  const hit = physics.raycastHit(from.x, from.y, from.z, dir.x, dir.y, dir.z, light.distance > 0 ? light.distance : 30, filter);
  if (!hit) return;
  const d = Math.max(hit.distance, MIN_DIST);
  found.near = Math.min(found.near, d);
  const square = Math.max(-(hit.nx * dir.x + hit.ny * dir.y + hit.nz * dir.z), 0.3);
  found.peak = Math.max(found.peak, albedo(hit) * spot * square * falloff(d, light.distance, light.decay));
}

function settle(candela: number, color: THREE.Color): number {
  if (found.peak <= 0) return 1;
  const hot = THREE.MathUtils.lerp(HOTSPOT_NEAR, HOTSPOT_FAR, THREE.MathUtils.smoothstep(found.near, NEAR_FROM, NEAR_TO));
  // Lambertian: radiance = candela × falloff × cos × albedo / π, in the light's own colour (the
  // bloom goes by luminance, and a fire's orange is little more than half as bright as white).
  const lum = Math.max(0.05, 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b);
  return Math.min(1, (hot * Math.PI) / (candela * lum * found.peak));
}

function albedo(hit: RayHit): number {
  if ((hit.collider.collisionGroups() >>> 16) & GROUP.zombie) return ALBEDO.flesh;
  return (hit.ny > 0.7 ? FLOOR_ALBEDO[hit.surface] : undefined) ?? ALBEDO[hit.surface];
}

/** three.js's falloff for a light with a range (getDistanceAttenuation). */
export function falloff(d: number, range: number, decay: number): number {
  const w = range > 0 ? Math.max(0, 1 - (d / range) ** 4) : 1;
  return (w * w) / Math.max(d ** decay, 0.01);
}
