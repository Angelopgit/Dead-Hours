import * as THREE from 'three';
import { GROUP, groups, type Physics, type RayHit, type Surface } from '../core/Physics';

/**
 * The brightest a carried lamp may make what it lands on: radiance of the palest thing in the hot
 * spot (linear, before exposure). The bloom takes anything over 0.9, so across a room nothing in
 * the beam reaches it, and right in front of a wall only the white window and door trim just does:
 * a faint glow, never a white-out. At full power the flashlight made a plaster wall half a metre
 * off about 25 times the bloom threshold.
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
/** Nothing counts as nearer than this (m): the lamp sits inside the survivor's capsule. */
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

const _ray = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();

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
  let peak = 0;
  let near = Infinity;
  for (let i = 0; i <= RING; i++) {
    let spot = 1;
    if (i === 0) _ray.copy(dir);
    else {
      const a = ((i - 1) / RING) * Math.PI * 2;
      _ray.copy(dir).multiplyScalar(c).addScaledVector(_side, s * Math.cos(a)).addScaledVector(_up, s * Math.sin(a));
      spot = ringSpot;
    }
    const hit = physics.raycastHit(from.x, from.y, from.z, _ray.x, _ray.y, _ray.z, light.distance, BEAM_FILTER);
    if (!hit) continue;
    const d = Math.max(hit.distance, MIN_DIST);
    near = Math.min(near, d);
    const square = Math.max(-(hit.nx * _ray.x + hit.ny * _ray.y + hit.nz * _ray.z), 0.3);
    peak = Math.max(peak, albedo(hit) * spot * square * falloff(d, light.distance, light.decay));
  }
  if (peak <= 0) return 1;
  const hot = THREE.MathUtils.lerp(HOTSPOT_NEAR, HOTSPOT_FAR, THREE.MathUtils.smoothstep(near, NEAR_FROM, NEAR_TO));
  // Lambertian: radiance = candela × falloff × cos × albedo / π.
  return Math.min(1, (hot * Math.PI) / (candela * peak));
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
