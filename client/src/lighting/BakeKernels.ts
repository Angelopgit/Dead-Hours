import * as THREE from 'three';
import type { MapDefinition } from '@dead-hours/shared';
import type { LightField } from './LightField';

/**
 * The light bake's inner loops, free of the DOM, so the same code runs on the page (the fallback)
 * and in the bake workers (BakeWorker.ts). Every result depends only on its inputs, so splitting
 * the work between workers gives exactly the same lighting as baking it in one go.
 */

/** Ground lightmap: covers the play area and a few meters past its edges at 0.5 m per texel. */
export const GROUND_BAKE = { texel: 0.5, margin: 3 } as const;

/** The ground lightmap's rectangle and size for a map (an even number of texels each way). */
export function groundBakeRect(map: MapDefinition): { x0: number; z0: number; w: number; d: number; resX: number; resZ: number } {
  const { texel, margin } = GROUND_BAKE;
  const b = map.bounds;
  const resX = Math.ceil((b.x1 - b.x0 + margin * 2) / (texel * 2)) * 2;
  const resZ = Math.ceil((b.z1 - b.z0 + margin * 2) / (texel * 2)) * 2;
  const w = resX * texel, d = resZ * texel;
  return { x0: (b.x0 + b.x1 - w) / 2, z0: (b.z0 + b.z1 - d) / 2, w, d, resX, resZ };
}

/** Up-facing surfaces in this height band read the ground lightmap instead of their vertices. */
export const GROUND_BAND = { min: -0.3, max: 0.17 } as const;

/** Surface height under a ground texel (a ray down from above curbs and islands); null inside a solid. */
function surface(field: LightField, x: number, z: number): number | null {
  const tr = field.tracer;
  if (!tr.intersect(x, 0.6, z, 0, -1, 0, 1.0, 0)) return -1;
  return tr.hit.t <= 1e-4 ? null : 0.6 - tr.hit.t;
}

/** Sky visibility of the ground on a 1 m grid (half the lightmap's resolution), rows j0 to j1. */
export function groundAoRows(field: LightField, map: MapDefinition, j0: number, j1: number): Float32Array {
  const { x0, z0, resX } = groundBakeRect(map);
  const step = GROUND_BAKE.texel * 2;
  const aoX = resX / 2;
  const out = new Float32Array((j1 - j0) * aoX);
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < aoX; i++) {
      const x = x0 + (i + 0.5) * step;
      const z = z0 + (j + 0.5) * step;
      const y = surface(field, x, z);
      out[(j - j0) * aoX + i] = y === null ? 0 : field.ao(x, y, z, 0, 1, 0, 7, true);
    }
  }
  return out;
}

/**
 * Ground lightmap texels for rows j0 to j1 (half-float rgba: irradiance and sky visibility), with
 * the sky visibility upsampled from the whole 1 m grid that groundAoRows made.
 */
export function groundLightRows(field: LightField, map: MapDefinition, ao: Float32Array, j0: number, j1: number): Uint16Array {
  const { x0, z0, resX, resZ } = groundBakeRect(map);
  const texel = GROUND_BAKE.texel;
  const aoX = resX / 2, aoZ = resZ / 2;
  const sampleAo = (u: number, v: number) => {
    const fx = Math.min(Math.max(u * aoX - 0.5, 0), aoX - 1);
    const fy = Math.min(Math.max(v * aoZ - 0.5, 0), aoZ - 1);
    const ix = Math.floor(fx), iy = Math.floor(fy);
    const ix1 = Math.min(ix + 1, aoX - 1), iy1 = Math.min(iy + 1, aoZ - 1);
    const tx = fx - ix, ty = fy - iy;
    const a = ao[iy * aoX + ix] * (1 - tx) + ao[iy * aoX + ix1] * tx;
    const b = ao[iy1 * aoX + ix] * (1 - tx) + ao[iy1 * aoX + ix1] * tx;
    return a * (1 - ty) + b * ty;
  };
  const data = new Uint16Array((j1 - j0) * resX * 4);
  const rgb = new Float32Array(3);
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < resX; i++) {
      const x = x0 + (i + 0.5) * texel;
      const z = z0 + (j + 0.5) * texel;
      const o = ((j - j0) * resX + i) * 4;
      let a = sampleAo((i + 0.5) / resX, (j + 0.5) / resZ);
      rgb[0] = rgb[1] = rgb[2] = 0;
      const y = surface(field, x, z);
      if (y === null) {
        a = 0;
      } else {
        field.direct(x, y, z, 0, 1, 0, rgb);
        field.indirect(x, y, z, 0, 1, 0, rgb);
      }
      data[o] = toHalf(rgb[0]);
      data[o + 1] = toHalf(rgb[1]);
      data[o + 2] = toHalf(rgb[2]);
      data[o + 3] = toHalf(a);
    }
  }
  return data;
}

/**
 * Bakes surface points: `pts` holds world position and unit normal (x, y, z, nx, ny, nz) per
 * point, `foliage` flags leaves (fixed openness, lamps traced past tree crowns). Writes irradiance
 * rgb and sky visibility (4 floats) per point into `out`, for points from to to.
 */
export function bakePoints(field: LightField, pts: Float64Array, foliage: Uint8Array, out: Float32Array, from = 0, to = foliage.length): void {
  const rgb = new Float32Array(3);
  for (let p = from; p < to; p++) {
    const k = p * 6, o = p * 4;
    const x = pts[k], y = pts[k + 1], z = pts[k + 2], nx = pts[k + 3], ny = pts[k + 4], nz = pts[k + 5];
    const leaf = foliage[p] === 1;
    out[o + 3] = leaf ? 0.8 : field.ao(x, y, z, nx, ny, nz, 6);
    field.direct(x, y, z, nx, ny, nz, rgb, !leaf);
    field.indirect(x, y, z, nx, ny, nz, rgb);
    out[o] = rgb[0]; out[o + 1] = rgb[1]; out[o + 2] = rgb[2];
  }
}
