import * as THREE from 'three';

/**
 * Axis-aligned box with world-space UVs (meters / texScale) and a baked vertical
 * occlusion gradient in vertex colors, so merged boxes of any size tile textures evenly
 * and walls darken toward the ground like contact AO.
 */
export function worldBox(
  cx: number, cy: number, cz: number,
  w: number, h: number, d: number,
  texScale: number,
  ao: { groundY: number; strength: number } | null = { groundY: 0, strength: 0.45 },
): THREE.BufferGeometry {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - h / 2, y1 = cy + h / 2;
  const z0 = cz - d / 2, z1 = cz + d / 2;
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const shade = (y: number) => {
    if (!ao) return 1;
    const t = THREE.MathUtils.clamp((y - ao.groundY) / 1.6, 0, 1);
    return 1 - ao.strength * (1 - t) * (1 - t);
  };
  const face = (
    verts: [number, number, number][],
    n: [number, number, number],
    uvOf: (v: [number, number, number]) => [number, number],
    top = false,
  ) => {
    const base = pos.length / 3;
    for (const v of verts) {
      pos.push(...v);
      nor.push(...n);
      const [u, w2] = uvOf(v);
      uv.push(u / texScale, w2 / texScale);
      const s = top ? 1 : shade(v[1]);
      col.push(s, s, s);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  // +X
  face([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], (v) => [-v[2], v[1]]);
  // -X
  face([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], (v) => [v[2], v[1]]);
  // +Y
  face([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], (v) => [v[0], -v[2]], true);
  // -Y
  face([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], (v) => [v[0], v[2]], true);
  // +Z
  face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], (v) => [v[0], v[1]]);
  // -Z
  face([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], (v) => [-v[0], v[1]]);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

/** Ensures a geometry has a white color attribute so it can merge with vertex-colored geometry. */
export function withWhiteColors(g: THREE.BufferGeometry, value = 1): THREE.BufferGeometry {
  if (!g.getAttribute('color')) {
    const n = g.getAttribute('position').count;
    const c = new Float32Array(n * 3).fill(value);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  return g;
}
