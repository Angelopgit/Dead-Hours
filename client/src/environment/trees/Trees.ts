import * as THREE from 'three';
import type { MapDefinition } from '@dead-hours/shared';
import type { LightField } from '../../lighting/LightField';
import { MOON_DIR } from '../../lighting/Lighting';
import type { Quality } from '../../core/Settings';
import { broadleaf, bush, pine, PINE_OUTLINE, type TreeModel } from './TreeGen';
import { createBarkAtlas, createLeafAtlas } from './TreeTextures';
import { TREE_DATA_ROWS, createImpostorMaterial, createTreeMaterial, treeUniforms } from './TreeMaterials';
import { bakeImpostors, type ImpostorAtlas } from './Impostors';

/**
 * Every tree and shrub on the map (yard trees, park trees, hedges and the woods): procedural
 * models (TreeGen) drawn instanced, three levels of detail cross-faded by distance (full models
 * near, lighter ones in the middle distance, pre-rendered impostor cards far away), culled on the
 * CPU against the view (widened by the moon shadow's reach so off-screen trees still throw their
 * shadows in). One small upload per frame (the visible instances' matrices); no per-tree objects.
 */

export type TreeTier = Quality;

interface Tier {
  /** Full models out to `near` (0: never), middle models to `mid`, cross-fades `band` wide. */
  near: number;
  mid: number;
  /**
   * The same for the woods: hundreds of pines a few metres apart, where the view is a wall of
   * crowns many cards deep and the next row hides most of what is behind.
   */
  woodsNear: number;
  woodsMid: number;
  band: number;
  bushNear: number;
  bushFar: number;
  /** Impostor atlas cell height (px). */
  cell: number;
  leafTex: number;
}

const TIERS: Record<TreeTier, Tier> = {
  high: { near: 22, mid: 48, woodsNear: 15, woodsMid: 34, band: 4, bushNear: 16, bushFar: 55, cell: 192, leafTex: 1024 },
  medium: { near: 15, mid: 38, woodsNear: 11, woodsMid: 28, band: 4, bushNear: 11, bushFar: 44, cell: 160, leafTex: 1024 },
  low: { near: 0, mid: 30, woodsNear: 0, woodsMid: 22, band: 3, bushNear: 0, bushFar: 34, cell: 112, leafTex: 512 },
};

/** Past this nothing is drawn (the woods' far edge from the middle of the map). */
const FAR = 175;

/** Model indices: 0-2 broadleaf, 3-5 pine, 6-7 bush. */
const MODEL_COUNT = 8;
const IMPOSTOR_MODELS = 6;

interface Bucket {
  meshes: THREE.InstancedMesh[];
  matrix: THREE.InstancedBufferAttribute;
  tree: THREE.InstancedBufferAttribute;
  count: number;
}

/** Linear colours. */
const lin = (hex: number, k = 1) => new THREE.Color(hex).convertSRGBToLinear().multiplyScalar(k);

export class Trees {
  readonly root = new THREE.Group();
  readonly count: number;
  private readonly models: TreeModel[] = [];
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly py: Float32Array;
  private readonly sy: Float32Array;
  private readonly modelOf: Uint8Array;
  /** First LOD band per tree: 0 yard and street trees, 3 shrubs, 5 the woods. */
  private readonly bandOf: Uint8Array;
  private readonly matrices: Float32Array;
  private readonly data: Float32Array;
  private readonly dataTex: THREE.DataTexture;
  /** buckets[model][band]: band 0 near, 1 middle, 2 impostor. */
  private readonly buckets: (Bucket | null)[][] = [];
  private readonly leafAtlas: THREE.DataTexture;
  private readonly bark: { map: THREE.DataTexture; normalMap: THREE.DataTexture };
  private readonly barkMats: THREE.MeshStandardMaterial[] = [];
  private readonly leafMats: THREE.MeshStandardMaterial[] = [];
  private readonly depthMats: THREE.MeshDepthMaterial[] = [];
  private impostorMats: THREE.MeshStandardMaterial[] = [];
  private atlas: ImpostorAtlas | null = null;
  private tier: TreeTier | null = null;
  private shadows = true;
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly lastPos = new THREE.Vector3(1e9, 0, 0);
  private readonly lastQuat = new THREE.Quaternion();
  private sinceUpdate = 0;
  private forced: THREE.Vector3 | null = null;
  /** Visible trees this rebuild, as (distance in cm) * 65536 + index, sorted near to far. */
  private order: Float64Array = new Float64Array(0);
  /** Where the moon throws shadows (ground plane), per metre of tree height. */
  private readonly shadowX = -MOON_DIR.x / MOON_DIR.y;
  private readonly shadowZ = -MOON_DIR.z / MOON_DIR.y;
  /** Species palettes (linear): [usual, second, rare]. */
  private readonly tints = {
    broadleaf: [lin(0x50663a), lin(0x8a5a22), lin(0x9a8a3a)] as [THREE.Color, THREE.Color, THREE.Color],
    pine: [lin(0x4a7350), lin(0x587449), lin(0x4f7560)] as [THREE.Color, THREE.Color, THREE.Color],
    bush: [lin(0x45603a), lin(0x566b3a), lin(0x3e5a40)] as [THREE.Color, THREE.Color, THREE.Color],
  };

  constructor(map: MapDefinition, quality: TreeTier) {
    this.root.name = 'trees';
    for (let v = 0; v < 3; v++) this.models.push(broadleaf(v));
    for (let v = 0; v < 3; v++) this.models.push(pine(v));
    for (let v = 0; v < 2; v++) this.models.push(bush(v));

    const specs = map.props.filter((p) => p.kind === 'tree' || p.kind === 'pine' || p.kind === 'bush');
    const n = (this.count = specs.length);
    // The per-frame sort packs an index into 16 bits.
    if (n >= 65536) throw new Error(`Trees: ${n} trees, at most 65535`);
    this.px = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.py = new Float32Array(n);
    this.sy = new Float32Array(n);
    this.modelOf = new Uint8Array(n);
    this.bandOf = new Uint8Array(n);
    this.matrices = new Float32Array(n * 16);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    specs.forEach((t, i) => {
      const v = t.variant ?? 0;
      let model: number, k = 1, ky = 1;
      if (t.kind === 'tree') {
        model = v % 3;
        k = 0.96 + ((v * 7) % 5) * 0.02;
        ky = k;
      } else if (t.kind === 'pine') {
        model = 3 + (v % 3);
        if (t.forest) {
          // The woods: the old forest's sizes (0.85..1.3, a little taller or squatter).
          k = 0.85 + (v % 6) * 0.09;
          ky = k * (0.9 + ((i * 7) % 5) * 0.06);
          k *= 0.92;
        }
      } else {
        model = 6 + (v % 2);
        k = 0.9 + ((v * 3) % 4) * 0.07;
        ky = k * 0.95;
      }
      this.modelOf[i] = model;
      this.bandOf[i] = model >= 6 ? 3 : t.forest ? 5 : 0;
      this.px[i] = t.x;
      this.pz[i] = t.z;
      this.py[i] = t.y ?? 0;
      this.sy[i] = ky;
      q.setFromAxisAngle(up, t.rotY);
      m.compose(p.set(t.x, t.y ?? 0, t.z), q, s.set(k, ky, k));
      m.toArray(this.matrices, i * 16);
    });

    this.data = new Float32Array(n * 4 * TREE_DATA_ROWS);
    this.dataTex = new THREE.DataTexture(this.data, Math.max(1, n), TREE_DATA_ROWS, THREE.RGBAFormat, THREE.FloatType);
    this.dataTex.minFilter = this.dataTex.magFilter = THREE.NearestFilter;
    this.dataTex.generateMipmaps = false;
    this.unlit();
    treeUniforms.uTreeData.value = this.dataTex;

    this.leafAtlas = createLeafAtlas(TIERS[quality].leafTex);
    this.bark = createBarkAtlas(512, 512);
    const barkColor = { broadleaf: 0x6b5e52, pine: 0x6a4f3e } as const;
    const white: [THREE.Color, THREE.Color, THREE.Color] = [new THREE.Color(1, 1, 1), new THREE.Color(0.92, 0.9, 0.88), new THREE.Color(1.05, 1.02, 1)];
    for (const species of ['broadleaf', 'pine', 'bush'] as const) {
      if (species !== 'bush') {
        const b = createTreeMaterial({ leaf: false, map: this.bark.map, normalMap: this.bark.normalMap, color: barkColor[species], roughness: 0.9, tints: white, texSize: 512 });
        b.material.name = `tree-bark-${species}`;
        this.barkMats.push(b.material);
        this.depthMats.push(b.depth);
      }
      const l = createTreeMaterial({ leaf: true, map: this.leafAtlas, color: 0xffffff, roughness: species === 'pine' ? 0.78 : 0.7, tints: this.tints[species], texSize: this.leafAtlas.image.width });
      l.material.name = `tree-leaves-${species}`;
      this.leafMats.push(l.material);
      this.depthMats.push(l.depth);
    }
    for (let mi = 0; mi < MODEL_COUNT; mi++) this.buckets.push([null, null, null]);
    this.buildBuckets();
    this.setTier(quality, true);
  }

  private speciesIndex(model: number): 0 | 1 | 2 {
    return model < 3 ? 0 : model < 6 ? 1 : 2;
  }

  /** The instanced meshes for every model and band (impostors once the atlas exists). */
  private buildBuckets(): void {
    const per = new Array(MODEL_COUNT).fill(0);
    for (let i = 0; i < this.count; i++) per[this.modelOf[i]]++;
    for (let mi = 0; mi < MODEL_COUNT; mi++) {
      const cap = per[mi];
      if (!cap) continue;
      const model = this.models[mi];
      const sp = this.speciesIndex(mi);
      for (let band = 0; band < 2; band++) {
        const parts = model.lods[band];
        const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
        matrix.setUsage(THREE.DynamicDrawUsage);
        const tree = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
        tree.setUsage(THREE.DynamicDrawUsage);
        const meshes: THREE.InstancedMesh[] = [];
        const add = (g: THREE.BufferGeometry, mat: THREE.MeshStandardMaterial, depth: THREE.MeshDepthMaterial) => {
          g.setAttribute('aTree', tree);
          const im = new THREE.InstancedMesh(g, mat, cap);
          im.instanceMatrix = matrix;
          im.count = 0;
          im.frustumCulled = false;
          im.castShadow = true;
          im.receiveShadow = true;
          im.customDepthMaterial = depth;
          im.visible = false;
          // After the rest of the opaque scene (houses hide crowns behind them), near before middle.
          im.renderOrder = 1 + band;
          im.name = `trees:${mi}:${band}:${mat.name}`;
          this.root.add(im);
          meshes.push(im);
        };
        if (parts.bark && sp < 2) add(parts.bark, this.barkMats[sp], this.depthMats[sp * 2]);
        add(parts.leaves, this.leafMats[sp], this.depthMats[sp < 2 ? sp * 2 + 1 : 4]);
        this.buckets[mi][band] = { meshes, matrix, tree, count: 0 };
      }
    }
  }

  private buildImpostors(renderer: THREE.WebGLRenderer, tier: Tier): void {
    for (const b of this.buckets) {
      const imp = b[2];
      if (!imp) continue;
      for (const m of imp.meshes) {
        this.root.remove(m);
        m.dispose();
      }
      b[2] = null;
    }
    for (const m of this.impostorMats) m.dispose();
    this.impostorMats = [];
    this.atlas?.texture.dispose();
    const refLum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const sources = this.models.slice(0, IMPOSTOR_MODELS).map((model, mi) => {
      const sp = this.speciesIndex(mi) as 0 | 1;
      const tint = this.tints[sp === 0 ? 'broadleaf' : 'pine'][0];
      return {
        model,
        bark: { map: this.bark.map, color: this.barkMats[sp].color },
        leaves: { map: this.leafAtlas, texSize: this.leafAtlas.image.width },
        refLum: refLum(tint),
      };
    });
    this.atlas = bakeImpostors(renderer, sources, tier.cell);
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    const spire = pineOutline();
    const per = new Array(MODEL_COUNT).fill(0);
    for (let i = 0; i < this.count; i++) per[this.modelOf[i]]++;
    for (let mi = 0; mi < IMPOSTOR_MODELS; mi++) {
      const cap = per[mi];
      if (!cap) continue;
      const sp = this.speciesIndex(mi);
      const mat = createImpostorMaterial(this.atlas.texture, this.atlas.cells[mi], this.tints[sp === 0 ? 'broadleaf' : 'pine'], this.atlas.size);
      mat.name = `tree-impostor-${mi}`;
      this.impostorMats.push(mat);
      const g = (this.speciesIndex(mi) === 1 ? spire : quad).clone();
      const matrix = new THREE.InstancedBufferAttribute(new Float32Array(cap * 16), 16);
      matrix.setUsage(THREE.DynamicDrawUsage);
      const tree = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
      tree.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aTree', tree);
      const im = new THREE.InstancedMesh(g, mat, cap);
      im.instanceMatrix = matrix;
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = false;
      im.receiveShadow = false;
      im.renderOrder = 3;
      im.visible = false;
      im.name = `trees:${mi}:2:impostor`;
      this.root.add(im);
      this.buckets[mi][2] = { meshes: [im], matrix, tree, count: 0 };
    }
    quad.dispose();
    spire.dispose();
    this.lastPos.set(1e9, 0, 0);
  }

  /**
   * Level-of-detail distances and impostor resolution for a graphics tier; the impostors are
   * (re)rendered when a renderer is given and the atlas size changed.
   */
  setTier(tier: TreeTier, init = false, renderer?: THREE.WebGLRenderer): void {
    const t = TIERS[tier];
    const changedCell = !this.tier || TIERS[this.tier].cell !== t.cell;
    this.tier = tier;
    const bands = treeUniforms.uLodBand.value;
    const fadeEnd = FAR, fadeStart = FAR - 10;
    // Trees: near [0, near], middle [near, mid], impostors [mid, FAR]; the woods at 5..7.
    for (const [b0, near, mid] of [[0, t.near, t.mid], [5, t.woodsNear, t.woodsMid]] as const) {
      if (near > 0) bands[b0].set(-2, -1, near, near + t.band);
      else bands[b0].set(-2, -1, -1, -0.5);
      bands[b0 + 1].set(near > 0 ? near : -2, near > 0 ? near + t.band : -1, mid, mid + t.band);
      bands[b0 + 2].set(mid, mid + t.band, fadeStart, fadeEnd);
    }
    // Shrubs: near and middle only, then gone (bands 3, 4).
    if (t.bushNear > 0) bands[3].set(-2, -1, t.bushNear, t.bushNear + t.band);
    else bands[3].set(-2, -1, -1, -0.5);
    bands[4].set(t.bushNear > 0 ? t.bushNear : -2, t.bushNear > 0 ? t.bushNear + t.band : -1, t.bushFar - 6, t.bushFar);
    if (renderer && (changedCell || !this.atlas) && !init) this.buildImpostors(renderer, t);
    this.lastPos.set(1e9, 0, 0);
  }

  /** Renders the impostors (needs the renderer; call once after construction). */
  prepare(renderer: THREE.WebGLRenderer): void {
    if (!this.atlas && this.tier) this.buildImpostors(renderer, TIERS[this.tier]);
  }

  /** Shadow casting for the full and middle models (off with shadows off: nothing to draw into). */
  setShadows(on: boolean): void {
    this.shadows = on;
    for (const b of this.buckets) {
      for (const band of [b[0], b[1]]) for (const m of band?.meshes ?? []) m.castShadow = on;
    }
  }

  /** No baked light yet: open sky, no lamps (until light() runs). */
  private unlit(): void {
    const d = this.data, w = this.count;
    d.fill(0);
    for (let i = 0; i < w; i++) {
      const model = this.models[this.modelOf[i]];
      for (const [row0, h] of [[0, model.probeLow], [5, model.probeHigh]] as const) {
        d[((row0) * w + i) * 4 + 3] = 1;
        d[((row0 + 1) * w + i) * 4 + 3] = h;
        d[((row0 + 1) * w + i) * 4 + 1] = 1;
        d[((row0 + 3) * w + i) * 4 + 1] = 1;
      }
    }
    this.dataTex.needsUpdate = true;
  }

  /**
   * Static light at each tree from the baked light field: two probes (low and high in its crown)
   * with sky visibility, bounce light and the two strongest lamps; crowded woods get darker.
   */
  async light(field: LightField, slice: () => Promise<void>): Promise<void> {
    const d = this.data, w = this.count;
    const out = { ao: 1, ambient: new Float32Array(3), dirs: [] as { x: number; y: number; z: number; r: number; g: number; b: number }[] };
    const lum = (l: { r: number; g: number; b: number }) => 0.2126 * l.r + 0.7152 * l.g + 0.0722 * l.b;
    // Neighbours within 5 m (a 5 m grid).
    const cell = 5, grid = new Map<number, number[]>();
    const key = (x: number, z: number) => (Math.floor(x / cell) + 1000) * 4096 + Math.floor(z / cell) + 1000;
    for (let i = 0; i < w; i++) {
      const k = key(this.px[i], this.pz[i]);
      let l = grid.get(k);
      if (!l) grid.set(k, (l = []));
      l.push(i);
    }
    // Probes sit just outside the trunk (on the moonlit side): from the trunk axis every ray
    // starts inside the trunk's 0.3 m collider, which read as no sky and no lamps.
    const mh = Math.hypot(MOON_DIR.x, MOON_DIR.z);
    const offX = (MOON_DIR.x / mh) * 0.55, offZ = (MOON_DIR.z / mh) * 0.55;
    let last = performance.now();
    for (let i = 0; i < w; i++) {
      let crowd = 0;
      const cx = Math.floor(this.px[i] / cell), cz = Math.floor(this.pz[i] / cell);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) {
          for (const j of grid.get((cx + a + 1000) * 4096 + cz + b + 1000) ?? []) {
            if (j !== i && (this.px[j] - this.px[i]) ** 2 + (this.pz[j] - this.pz[i]) ** 2 < 25) crowd++;
          }
        }
      }
      const model = this.models[this.modelOf[i]];
      for (const [row0, h] of [[0, model.probeLow], [5, model.probeHigh]] as const) {
        field.probe(this.px[i] + offX, this.py[i] + h * this.sy[i], this.pz[i] + offZ, out, false);
        const dirs = out.dirs.sort((a, b) => lum(b) - lum(a));
        const o = (row: number) => ((row0 + row) * w + i) * 4;
        const amb = [out.ambient[0], out.ambient[1], out.ambient[2]];
        for (const extra of dirs.slice(2)) {
          amb[0] += extra.r * 0.25; amb[1] += extra.g * 0.25; amb[2] += extra.b * 0.25;
        }
        d.set([amb[0], amb[1], amb[2], out.ao * Math.max(0.72, 1 - crowd * 0.045)], o(0));
        const l0 = dirs[0], l1 = dirs[1];
        d.set(l0 ? [l0.x, l0.y, l0.z, h] : [0, 1, 0, h], o(1));
        d.set(l0 ? [l0.r, l0.g, l0.b, 0] : [0, 0, 0, 0], o(2));
        d.set(l1 ? [l1.x, l1.y, l1.z, 0] : [0, 1, 0, 0], o(3));
        d.set(l1 ? [l1.r, l1.g, l1.b, 0] : [0, 0, 0, 0], o(4));
      }
      if (performance.now() - last > 12) {
        await slice();
        last = performance.now();
      }
    }
    this.dataTex.needsUpdate = true;
  }

  /** Visible trees per frame: distance bands and view culling into each bucket. */
  update(camera: THREE.Camera): void {
    treeUniforms.uTreeEye.value.copy(camera.position);
    this.sinceUpdate++;
    const moved = camera.position.distanceToSquared(this.lastPos) > 0.04;
    const turned = 1 - Math.abs(camera.quaternion.dot(this.lastQuat)) > 2e-5;
    if (!moved && !turned && this.sinceUpdate < 20 && !this.forced) return;
    this.sinceUpdate = 0;
    this.lastPos.copy(camera.position);
    this.lastQuat.copy(camera.quaternion);
    camera.updateMatrixWorld();
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const bands = treeUniforms.uLodBand.value;
    for (const b of this.buckets) for (const k of b) if (k) k.count = 0;
    const cx = camera.position.x, cz = camera.position.z;
    const far = FAR;
    const shadowReach = this.shadows ? 45 : 0;
    if (this.order.length < this.count) this.order = new Float64Array(this.count);
    let visible = 0;
    for (let i = 0; i < this.count; i++) {
      const dx = this.px[i] - cx, dz = this.pz[i] - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 > far * far) continue;
      const model = this.models[this.modelOf[i]];
      const d = Math.sqrt(d2);
      const h = model.height * this.sy[i];
      const r = model.radius * this.sy[i];
      // In view, or near enough that its shadow might fall into view.
      const sph = this.sphere;
      if (d < shadowReach) {
        const reach = h * 0.5;
        sph.center.set(this.px[i] + this.shadowX * reach, this.py[i] + h * 0.5, this.pz[i] + this.shadowZ * reach);
        sph.radius = r + Math.hypot(this.shadowX, this.shadowZ) * reach + h * 0.5;
      } else {
        sph.center.set(this.px[i], this.py[i] + h * 0.5, this.pz[i]);
        sph.radius = Math.max(r, h * 0.5) + 0.5;
      }
      if (!this.frustum.intersectsSphere(sph)) continue;
      this.order[visible++] = Math.floor(d * 100) * 65536 + i;
    }
    // Near to far: alpha-tested leaves can't write depth before shading, so the nearest crowns
    // drawn first let the depth test throw away what they hide.
    const order = this.order.subarray(0, visible).sort();
    for (let k = 0; k < visible; k++) {
      const i = order[k] % 65536;
      const d = Math.floor(order[k] / 65536) / 100;
      const mi = this.modelOf[i];
      const b0 = this.bandOf[i];
      for (let band = 0; band < 3; band++) {
        const bk = this.buckets[mi][band];
        if (!bk) continue;
        // Shrubs have no impostors.
        if (band === 2 && b0 === 3) continue;
        const range = bands[b0 + band];
        if (d < range.x || d > range.w) continue;
        const at = bk.count++;
        (bk.matrix.array as Float32Array).set(this.matrices.subarray(i * 16, i * 16 + 16), at * 16);
        const ta = bk.tree.array as Float32Array;
        ta[at * 2] = i;
        ta[at * 2 + 1] = b0 + band;
      }
    }
    if (this.forced) this.placeForced(this.forced);
    for (const b of this.buckets) {
      for (const k of b) {
        if (!k) continue;
        for (const m of k.meshes) {
          m.count = k.count;
          m.visible = k.count > 0;
        }
        if (k.count) {
          k.matrix.clearUpdateRanges();
          k.matrix.addUpdateRange(0, k.count * 16);
          k.matrix.needsUpdate = true;
          k.tree.clearUpdateRanges();
          k.tree.addUpdateRange(0, k.count * 2);
          k.tree.needsUpdate = true;
        }
      }
    }
  }

  /** Puts one instance into every empty bucket at `at` (prewarm: every program, shadows too). */
  private placeForced(at: THREE.Vector3): void {
    const m = new THREE.Matrix4();
    for (let mi = 0; mi < MODEL_COUNT; mi++) {
      for (let band = 0; band < 3; band++) {
        const bk = this.buckets[mi][band];
        if (!bk || bk.count) continue;
        const i = this.modelOf.indexOf(mi);
        if (i < 0) continue;
        m.makeTranslation(at.x + (mi - 4) * 0.7, at.y, at.z + band * 0.7);
        m.toArray(bk.matrix.array as Float32Array, 0);
        const ta = bk.tree.array as Float32Array;
        ta[0] = i;
        // A band that always shows (near trees / near shrubs).
        ta[1] = mi >= 6 ? 3 : 0;
        bk.count = 1;
      }
    }
  }

  /**
   * Shows one of everything (every model at every level, impostors too) at `at` until the undo
   * runs, so the loading screen compiles every tree program, shadow passes included.
   */
  prewarm(at: THREE.Vector3, camera: THREE.Camera): () => void {
    this.forced = at.clone();
    const bands = treeUniforms.uLodBand.value.map((v) => v.clone());
    // Every band visible for the warm-up frames.
    for (const v of treeUniforms.uLodBand.value) v.set(-2, -1, 1e5, 1e5 + 1);
    this.update(camera);
    return () => {
      this.forced = null;
      treeUniforms.uLodBand.value.forEach((v, k) => v.copy(bands[k]));
      this.lastPos.set(1e9, 0, 0);
      this.update(camera);
    };
  }

  /** Draw counts by level (for the debug overlay and measurements). */
  stats(): { near: number; mid: number; impostor: number; drawn: number } {
    const s = { near: 0, mid: 0, impostor: 0, drawn: 0 };
    for (const b of this.buckets) {
      s.near += b[0]?.count ?? 0;
      s.mid += b[1]?.count ?? 0;
      s.impostor += b[2]?.count ?? 0;
      for (const k of b) if (k?.count) s.drawn += k.meshes.length;
    }
    return s;
  }

  dispose(): void {
    for (const b of this.buckets) {
      for (const k of b) {
        for (const m of k?.meshes ?? []) {
          m.geometry.dispose();
          m.dispose();
        }
      }
    }
    for (const m of [...this.barkMats, ...this.leafMats, ...this.depthMats, ...this.impostorMats]) m.dispose();
    this.leafAtlas.dispose();
    this.bark.map.dispose();
    this.bark.normalMap.dispose();
    this.atlas?.texture.dispose();
    this.dataTex.dispose();
    this.root.removeFromParent();
  }
}

/**
 * Pine impostors: a tapered outline instead of the whole rectangle (x -0.5..0.5 across the
 * billboard, y 0..1 up it, as the impostor shader expects), so a third fewer far-away pixels are
 * shaded only to be discarded. check:trees keeps every pine model inside it.
 */
function pineOutline(): THREE.BufferGeometry {
  const pts = PINE_OUTLINE;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(([x, y]) => [x, y, 0]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pts.flatMap(() => [0, 0, 1]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(pts.flatMap(([x, y]) => [x + 0.5, y]), 2));
  g.setIndex([0, 1, 2, 0, 2, 5, 5, 2, 3, 5, 3, 4]);
  return g;
}
