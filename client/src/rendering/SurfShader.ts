import * as THREE from 'three';
import { chain } from '../lighting/BakeShader';

/**
 * One material for a whole hard-surface model: roughness and metalness ride in a `surf` vertex
 * attribute (x rough, y metal), so an anodized receiver, a steel barrel and a polymer stock share
 * a draw call. The material's own roughness and metalness stay 1 and scale it.
 */
export function patchSurf(mat: THREE.MeshStandardMaterial): void {
  if (mat.userData.surf) return;
  mat.userData.surf = true;
  mat.roughness = 1;
  mat.metalness = 1;
  chain(mat, 'surf', (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 surf;\nvarying vec2 vSurf;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = surf;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vSurf;')
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness * vSurf.x;
        #ifdef USE_ROUGHNESSMAP
          roughnessFactor *= texture2D( roughnessMap, vRoughnessMapUv ).g;
        #endif`)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = metalness * vSurf.y;');
  });
}

let detail: THREE.DataTexture | null = null;

/**
 * The shared detail map for hard surfaces, tiled over box-projected coordinates: fine grain and a
 * few handling scratches. Red is height (a faint bump), green scales roughness. One 256² texture
 * for every gun and car, made from arithmetic so it needs no download and no canvas.
 */
export function detailTexture(): THREE.DataTexture {
  if (detail) return detail;
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  let seed = 0x9e3779b9;
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967295;
  };
  const grain = new Float32Array(N * N);
  for (let i = 0; i < grain.length; i++) grain[i] = rand();
  const at = (x: number, y: number) => grain[((y + N) % N) * N + ((x + N) % N)];
  const rough = new Float32Array(N * N).fill(1);
  // Scratches: short bright (smoother) strokes, mostly along the length.
  for (let s = 0; s < 46; s++) {
    let x = rand() * N, y = rand() * N;
    const a = (rand() - 0.5) * 0.7 + (rand() < 0.2 ? Math.PI / 2 : 0);
    const len = 12 + rand() * 60, depth = 0.25 + rand() * 0.35;
    for (let t = 0; t < len; t++) {
      const k = (((Math.round(y) % N) + N) % N) * N + (((Math.round(x) % N) + N) % N);
      rough[k] = Math.min(rough[k], 1 - depth * Math.sin((t / len) * Math.PI));
      x += Math.cos(a); y += Math.sin(a);
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      // Grain blurred a little, so the bump doesn't sparkle.
      const g = (at(x, y) * 2 + at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1)) / 6;
      // Slow mottling: handling marks and oil.
      const m = 0.5 + 0.5 * Math.sin((x / N) * Math.PI * 4 + Math.sin((y / N) * Math.PI * 6) * 1.7) * Math.cos((y / N) * Math.PI * 2 + Math.sin((x / N) * Math.PI * 4));
      data[i * 4] = Math.round(255 * (0.5 + (g - 0.5) * 0.9 - (1 - rough[i]) * 0.25));
      data[i * 4 + 1] = Math.round(255 * THREE.MathUtils.clamp((0.86 + g * 0.14) * (0.88 + 0.12 * m) * rough[i], 0, 1));
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 255;
    }
  }
  detail = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
  detail.magFilter = THREE.LinearFilter;
  detail.minFilter = THREE.LinearMipmapLinearFilter;
  detail.generateMipmaps = true;
  detail.needsUpdate = true;
  return detail;
}
