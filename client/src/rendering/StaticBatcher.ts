import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { withWhiteColors } from './GeometryUtils';

/**
 * Collects static geometry by material and merges it into one mesh per material.
 * This keeps the whole neighborhood at a few dozen draw calls regardless of prop count.
 * Geometry stays indexed so per-vertex baked lighting is computed once per shared vertex.
 */
export class StaticBatcher {
  private readonly buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly flags = new Map<THREE.Material, { cast: boolean; receive: boolean }>();

  add(geometry: THREE.BufferGeometry, material: THREE.Material, cast = true, receive = true): void {
    let list = this.buckets.get(material);
    if (!list) {
      list = [];
      this.buckets.set(material, list);
      this.flags.set(material, { cast, receive });
    }
    const g = geometry;
    if (!g.index) {
      const n = g.getAttribute('position').count;
      const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    // Normalize attributes so everything in a bucket merges.
    for (const name of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv', 'color'].includes(name)) g.deleteAttribute(name);
    }
    if (!g.getAttribute('uv')) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
    }
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    withWhiteColors(g);
    list.push(g);
  }

  /** Bakes every mesh under `object` (with its world transform) into the batch. */
  addObject(object: THREE.Object3D): void {
    object.updateWorldMatrix(true, true);
    object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      this.add(g, mesh.material as THREE.Material, mesh.castShadow, mesh.receiveShadow);
    });
  }

  build(parent: THREE.Object3D, name = 'static'): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [mat, list] of this.buckets) {
      if (!list.length) continue;
      const merged = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      if (!merged) continue;
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      const f = this.flags.get(mat)!;
      mesh.castShadow = f.cast;
      mesh.receiveShadow = f.receive;
      mesh.name = `${name}:${mat.name}`;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.buckets.clear();
    return meshes;
  }
}
