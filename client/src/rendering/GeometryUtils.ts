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
  cell = 0,
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
    // Optional tessellation so per-vertex baked lighting has enough resolution on big faces.
    const [a, b, , d] = verts;
    const lenU = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const lenV = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    const groundTop = top && n[1] > 0 && a[1] < 0.17 && a[1] > -0.3;
    const nu = cell > 0 && !groundTop ? Math.max(1, Math.ceil(lenU / cell)) : 1;
    const nv = cell > 0 && !groundTop ? Math.max(1, Math.ceil(lenV / cell)) : 1;
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        const fu = i / nu, fv = j / nv;
        const v: [number, number, number] = [
          a[0] + (b[0] - a[0]) * fu + (d[0] - a[0]) * fv,
          a[1] + (b[1] - a[1]) * fu + (d[1] - a[1]) * fv,
          a[2] + (b[2] - a[2]) * fu + (d[2] - a[2]) * fv,
        ];
        pos.push(...v);
        nor.push(...n);
        const [u, w2] = uvOf(v);
        uv.push(u / texScale, w2 / texScale);
        const sh = top ? 1 : shade(v[1]);
        col.push(sh, sh, sh);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const p0 = base + j * (nu + 1) + i;
        const p1 = p0 + 1;
        const p3 = p0 + (nu + 1);
        const p2 = p3 + 1;
        idx.push(p0, p1, p2, p0, p2, p3);
      }
    }
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
