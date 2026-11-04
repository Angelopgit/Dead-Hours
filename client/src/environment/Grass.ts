import * as THREE from 'three';
import { rng, type MapDefinition } from '@dead-hours/shared';
import { bakeUniforms } from '../lighting/BakeShader';
import { weatherUniforms } from '../lighting/WetShader';
import type { GrassQuality } from '../core/Settings';
import { buildLawnMask, type LawnMask } from './Lawn';
import { bindWind, WIND_GLSL } from './Wind';

/**
 * Lawn grass that sways in the wind. Every blade is built on the GPU: tiles of instanced blades
 * follow the camera, the vertex shader looks up the lawn mask at each blade's root (no grass on
 * roads, sidewalks, floors, basements or the forest floor), shapes, bends and colours it, and
 * thins the field out with distance. Nothing per blade happens on the CPU; per frame it only
 * moves a handful of tiles when the camera crosses into a new one.
 *
 *  - Two layers: a dense near field of finer blades and a sparse far field of wider ones, each
 *    fading out by distance (blades shrink into the ground in a random order, so nothing pops).
 *  - Tiles are separate meshes so three culls them against the view; tiles with no lawn are
 *    never drawn. One shared material, so the whole field is one shader program.
 *  - Wind: gusts roll across the lawns as waves in the wind's direction, plus per-blade flutter.
 *    Survivors and zombies push the grass aside where they walk (setTramplers).
 *  - Lit like the ground under it: the baked lamp light and sky visibility of the ground
 *    lightmap at the root, moonlight with shadows, flashlights and fires, fog. Wet grass darkens.
 *  - Draws no shadows of its own and stays well under the bloom threshold.
 */

interface LayerSpec {
  /** Tile edge (m). */
  tile: number;
  /** Blades per square meter where the layer is full. */
  density: number;
  /** Bends along the blade (vertices = segments * 2 + 1). */
  segments: number;
  /** Distance (m) where blades start dropping out, and where the last one is gone. */
  fadeStart: number;
  fadeEnd: number;
  /** Blade width and height multipliers. */
  width: number;
  height: number;
}

const QUALITY: Record<Exclude<GrassQuality, 'off'>, LayerSpec[]> = {
  high: [
    { tile: 6, density: 64, segments: 4, fadeStart: 7, fadeEnd: 19, width: 1, height: 1 },
    { tile: 16, density: 9, segments: 2, fadeStart: 16, fadeEnd: 46, width: 1.5, height: 0.95 },
  ],
  medium: [
    { tile: 6, density: 42, segments: 3, fadeStart: 5, fadeEnd: 15, width: 1.15, height: 1 },
    { tile: 16, density: 7, segments: 2, fadeStart: 12, fadeEnd: 36, width: 1.7, height: 0.95 },
  ],
  low: [
    { tile: 6, density: 22, segments: 3, fadeStart: 3.5, fadeEnd: 11, width: 1.45, height: 0.95 },
    { tile: 16, density: 4.5, segments: 2, fadeStart: 8, fadeEnd: 24, width: 2.1, height: 0.9 },
  ],
};

/** People and zombies pushing the grass aside, nearest the camera first. */
export const GRASS_TRAMPLERS = 12;

/** Something pressing the grass down: where (x, z), how wide (m) and how hard (0..1). */
export interface GrassFoot { x: number; z: number; r: number; k: number }

let current: Grass | null = null;

/** The night's survivors, zombies and bodies in the grass this frame (nearest the camera first). */
export function trampleGrass(feet: readonly GrassFoot[], count = feet.length): void {
  current?.setTramplers(feet, count);
}

const VERTEX_PARS = /* glsl */ `
attribute vec3 blade;
attribute vec4 lod;
uniform sampler2D uLawn;
uniform vec4 uLawnRect;
uniform sampler2D uGroundBake;
uniform vec4 uGroundRect;
uniform float uGrassGust;
uniform float uGrassLodScale;
uniform float uWetness;
uniform vec3 uGrassRoot;
uniform vec3 uGrassTip;
uniform vec3 uGrassDry;
uniform vec4 uTramplers[${GRASS_TRAMPLERS}];
varying vec3 vGrassColor;
varying vec4 vGrassBake;
varying float vGrassH;
`;

/** Builds the blade (replaces beginnormal_vertex): gPos in the tile's frame, objectNormal. */
const VERTEX_BLADE = /* glsl */ `
  vec2 gTile = modelMatrix[3].xz;
  // Blades come rank-sorted (far tiles draw only the first ones). Each tile reshuffles the seeds,
  // so sizes, lean and colour never repeat from tile to tile.
  float gRank = blade.y;
  float gSeed = fract(blade.z + fract(sin(dot(gTile, vec2(39.3468, 11.1351))) * 24634.6345));
  vec2 gRoot = gTile + position.xz;
  float gDist = length(gRoot - cameraPosition.xz) * uGrassLodScale;
  vec2 gMask = texture2D(uLawn, (gRoot - uLawnRect.xy) * uLawnRect.zw).rg;
  // Far blades drop out in rank order, shrinking first; the lawn mask thins them the same way.
  float gKeep = 1.0 - smoothstep(lod.x, lod.y, gDist);
  float gShow = clamp((gKeep - gRank) * 7.0, 0.0, 1.0) * clamp((gMask.r - gSeed) * 6.0, 0.0, 1.0);
  bool gHidden = gShow < 0.03;
  vec3 gPos = vec3(0.0);
  vec3 objectNormal = vec3(0.0, 1.0, 0.0);
  vGrassColor = vec3(0.0);
  vGrassBake = vec4(0.0);
  vGrassH = 0.0;
  if (!gHidden) {
    float gR3 = fract(gSeed * 7.137 + gRank * 3.711);
    float gR4 = fract(gSeed * 13.73 + gRank * 1.931);
    float gR5 = fract(gSeed * 3.171 + gRank * 11.31);
    float gR6 = fract(gSeed * 17.93 + gRank * 5.273);
    float gH = (0.15 + 0.27 * gR3 * gR3) * min(gMask.g * 2.0, 1.5) * lod.w * (0.35 + 0.65 * gShow);
    float gW = (0.026 + 0.022 * gR4) * lod.z * (1.0 + smoothstep(5.0, lod.y, gDist) * 1.6) * (0.5 + 0.5 * gShow);
    float gA = gR5 * 6.2831853;
    vec2 gFace = vec2(cos(gA), sin(gA));
    vec2 gSide = vec2(-gFace.y, gFace.x);

    // Wind: gust bands rolling downwind over the lawns, and each blade's own flutter.
    // The same gust waves that sway the trees (Wind.ts), a little stronger in the rain.
    vec2 gWd = uWindDir;
    float gWs = uWindStrength * uGrassGust;
    float gGust = windGust(gRoot);
    float gFl = sin(uWindTime * (4.0 + gR4 * 3.2) + gR3 * 6.2831853);
    vec2 gL = gFace * (0.12 + 0.3 * gR6)
      + gWd * ((0.08 + 0.5 * gGust) * gWs + gFl * 0.035 * gWs)
      + gSide * (gFl * 0.06 * gWs);
    // Pushed aside and pressed down around feet.
    float gFlat = 0.0;
    for (int i = 0; i < ${GRASS_TRAMPLERS}; i++) {
      vec4 tp = uTramplers[i];
      vec2 d = gRoot - tp.xy;
      float l = length(d);
      float k = tp.w * (1.0 - smoothstep(tp.z * 0.3, tp.z, l));
      gL += d / max(l, 0.05) * (k * 1.4);
      gFlat = max(gFlat, k);
    }
    gH *= 1.0 - gFlat * 0.45;
    // A camera down in the grass (crouched, prone, a low shoulder view) sees over the blades
    // right in front of it instead of into a wall of them.
    float gLow = clamp((1.2 - cameraPosition.y) / 0.9, 0.0, 1.0);
    gH *= 1.0 - gLow * 0.65 * (1.0 - smoothstep(0.6, 3.5, length(gRoot - cameraPosition.xz)));
    float gLen = length(gL);
    if (gLen > 1.35) gL *= 1.35 / gLen;

    float gh = position.y;
    float gs = blade.x;
    float gBent = dot(gL, gL);
    float gDrop = 1.0 - 0.3 * gBent * gh;
    vec3 gSide3 = vec3(gSide.x, 0.0, gSide.y);
    gPos = vec3(position.x, -0.02, position.z)
      + vec3(gL.x * gh * gh, gh * gDrop, gL.y * gh * gh) * gH
      + gSide3 * (gs * gW * 0.5 * (1.0 - gh * 0.82));
    // Blade normal from the bend, rounded across the blade so it shades like a curved leaf.
    vec3 gTan = normalize(vec3(2.0 * gL.x * gh, 1.0 - 0.6 * gBent * gh, 2.0 * gL.y * gh));
    objectNormal = normalize(cross(gTan, gSide3) + gSide3 * (gs * 0.45));

    // Colour: dark roots, lighter tips, dry straw where the ground itself is dry; wind sheen.
    float gN = sin(gRoot.x * 0.11) * cos(gRoot.y * 0.13) + sin(gRoot.x * 0.031 + gRoot.y * 0.047) * 0.8;
    float gDry = clamp(smoothstep(0.2, 1.2, gN) * 0.8 + (gR6 - 0.4) * 0.6, 0.0, 1.0);
    vec3 gTipC = mix(uGrassTip, uGrassDry, gDry) * (0.75 + 0.5 * gR3);
    vGrassColor = mix(uGrassRoot, gTipC, pow(gh, 0.75)) * (1.0 + gGust * gh * 0.18) * (1.0 - uWetness * 0.28);
    // Far away a field shows more of its shaded lower half: settle toward the ground's own tone.
    vGrassColor = mix(vGrassColor, uGrassRoot * 1.6, smoothstep(lod.y * 0.35, lod.y, gDist) * 0.55);
    vGrassH = gh;
    vGrassBake = texture2D(uGroundBake, (gRoot - uGroundRect.xy) * uGroundRect.zw);
  }
`;

const FRAGMENT_PARS = /* glsl */ `
uniform float uBakeGain;
uniform float uWetness;
uniform vec3 uSkyRefl;
/** Wetness where this blade is (open sky only), set at the top of main. */
float gWet;
varying vec3 vGrassColor;
varying vec4 vGrassBake;
varying float vGrassH;
/** The blade's own normal (facing the viewer), before it is blended toward the ground's. */
vec3 gBladeN;
`;

/**
 * Direct light on a blade: lit faces as Lambert, light through a thin blade from behind
 * (translucency, strongest toward the tip), mixed with the ground's response so a lawn shades as
 * one surface; plus a faint sheen that grows when wet. Lights keep their shadows.
 */
const DIRECT_LIGHT = /* glsl */ `
	float gNL = dot( gBladeN, directLight.direction );
	float dotNL = mix( saturate( gNL ) + saturate( - gNL ) * ( 0.25 + 0.4 * vGrassH ), saturate( dot( geometryNormal, directLight.direction ) ), 0.35 );
	vec3 gHalf = normalize( directLight.direction + geometryViewDir );
	reflectedLight.directDiffuse += directLight.color * ( pow( saturate( dot( geometryNormal, gHalf ) ), 14.0 ) * ( 0.25 + 0.75 * vGrassH ) * ( 0.012 + gWet * 0.07 ) );`;

/** three's Lambert light functions with the grass's direct light term. */
function lambertWithGrassLight(): string {
  const chunk = THREE.ShaderChunk.lights_lambert_pars_fragment;
  const line = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';
  if (!chunk.includes(line)) throw new Error('grass: three.js Lambert chunk changed');
  return chunk.replace(line, DIRECT_LIGHT);
}

/**
 * A tile's blades merged into one mesh (instancing 5-9 vertex blades leaves most of a GPU's
 * vertex lanes idle). Per vertex: position = (blade x, height fraction 0..1, blade z) in the
 * tile, blade = (across -1..1, rank, seed), lod = the layer's fade distances and size. Blades are
 * in rank order, so drawing the first n of them draws the n that survive the farthest.
 */
function tileGeometry(spec: LayerSpec, blades: readonly (readonly [number, number, number, number])[]): THREE.BufferGeometry {
  const { segments } = spec;
  const per = segments * 2 + 1;
  const tris = (segments - 1) * 2 + 1;
  const n = blades.length;
  const pos = new Float32Array(n * per * 3);
  const info = new Float32Array(n * per * 3);
  const lod = new Float32Array(n * per * 4);
  const index = n * per > 65535 ? new Uint32Array(n * tris * 3) : new Uint16Array(n * tris * 3);
  let v = 0, t = 0;
  for (const [x, z, rank, seed] of blades) {
    const base = v;
    for (let k = 0; k <= segments; k++) {
      const h = k / segments;
      for (const side of k === segments ? [0] : [-1, 1]) {
        pos.set([x, h, z], v * 3);
        info.set([side, rank, seed], v * 3);
        lod.set([spec.fadeStart, spec.fadeEnd, spec.width, spec.height], v * 4);
        v++;
      }
    }
    for (let k = 0; k < segments - 1; k++) {
      const a = base + k * 2;
      index.set([a, a + 1, a + 3, a, a + 3, a + 2], t);
      t += 6;
    }
    const last = base + (segments - 1) * 2;
    index.set([last, last + 1, base + segments * 2], t);
    t += 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('blade', new THREE.BufferAttribute(info, 3));
  g.setAttribute('lod', new THREE.BufferAttribute(lod, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.userData.indicesPerBlade = tris * 3;
  return g;
}

/** One layer: a shared blade geometry instanced over tiles that follow the camera. */
class Layer {
  readonly geometry: THREE.BufferGeometry;
  private readonly pool: THREE.Mesh[] = [];
  private readonly indicesPerBlade: number;
  /** Blades per tile. */
  private readonly count: number;
  /** The tiles in reach now: tile origin x, z for each pooled mesh in use. */
  private readonly tiles: number[] = [];
  /** Strongest grass density per tile (0..1). */
  private readonly tileMax: Float32Array;
  private readonly tilesX: number;
  private readonly tilesZ: number;
  private lastKey = '';
  /** Tiles drawn now (for stats). */
  active = 0;

  constructor(readonly spec: LayerSpec, private readonly mask: LawnMask, private readonly material: THREE.Material, private readonly parent: THREE.Object3D, seed: number) {
    const { tile, density } = spec;
    // Blades jittered on a grid over the tile (even cover, no clumps), random rank and seed.
    const side = Math.max(1, Math.round(tile * Math.sqrt(density)));
    const n = side * side;
    const cell = tile / side;
    const r = rng(seed);
    const list: [number, number, number, number][] = [];
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) list.push([(i + 0.1 + r() * 0.8) * cell, (j + 0.1 + r() * 0.8) * cell, r(), r()]);
    }
    // Sorted by rank: a tile that can only show the first fraction of its blades (far away)
    // draws only those.
    list.sort((a, b) => a[2] - b[2]);
    this.geometry = tileGeometry(spec, list);
    this.indicesPerBlade = this.geometry.userData.indicesPerBlade as number;
    this.count = n;
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(tile / 2, 0.4, tile / 2), tile * Math.SQRT1_2 + 1);
    this.geometry.boundingBox = new THREE.Box3(new THREE.Vector3(-1, -0.1, -1), new THREE.Vector3(tile + 1, 1.6, tile + 1));

    // Which tiles have any lawn at all.
    this.tilesX = Math.ceil((mask.w * mask.texel) / tile);
    this.tilesZ = Math.ceil((mask.h * mask.texel) / tile);
    this.tileMax = new Float32Array(this.tilesX * this.tilesZ);
    const per = tile / mask.texel;
    for (let j = 0; j < mask.h; j++) {
      const tz = Math.floor(j / per);
      for (let i = 0; i < mask.w; i++) {
        const v = mask.data[(j * mask.w + i) * 2] / 255;
        const k = tz * this.tilesX + Math.floor(i / per);
        if (v > this.tileMax[k]) this.tileMax[k] = v;
      }
    }
  }

  /**
   * Tiles within reach of the camera (in lawn-scaled distance), each drawn by one pooled mesh,
   * and how many of its blades each needs: only the ranks its nearest corner can still show.
   */
  update(cx: number, cz: number, lodScale: number): void {
    const { tile, fadeStart, fadeEnd } = this.spec;
    const reach = fadeEnd / lodScale + 1.5;
    const m = this.mask;
    const tx = Math.floor((cx - m.x0) / tile), tz = Math.floor((cz - m.z0) / tile);
    const key = `${tx},${tz},${reach.toFixed(1)}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.tiles.length = 0;
      const span = Math.ceil(reach / tile);
      for (let j = Math.max(0, tz - span); j <= Math.min(this.tilesZ - 1, tz + span); j++) {
        for (let i = Math.max(0, tx - span); i <= Math.min(this.tilesX - 1, tx + span); i++) {
          if (this.tileMax[j * this.tilesX + i] >= 0.02) this.tiles.push(m.x0 + i * tile, m.z0 + j * tile);
        }
      }
    }
    let used = 0;
    for (let k = 0; k < this.tiles.length; k += 2) {
      const x = this.tiles[k], z = this.tiles[k + 1];
      // Nearest point of the tile to the camera.
      const dx = Math.max(x - cx, 0, cx - (x + tile)), dz = Math.max(z - cz, 0, cz - (z + tile));
      const d = Math.sqrt(dx * dx + dz * dz) * lodScale;
      if (d >= fadeEnd) continue;
      const t = Math.min(1, Math.max(0, (d - fadeStart) / (fadeEnd - fadeStart)));
      const keep = 1 - t * t * (3 - 2 * t);
      const n = Math.min(this.count, Math.ceil(this.count * (keep + 0.01)));
      if (n <= 0) continue;
      const mesh = this.mesh(used++);
      if (mesh.position.x !== x || mesh.position.z !== z) {
        mesh.position.set(x, 0, z);
        mesh.updateMatrix();
        mesh.updateMatrixWorld();
      }
      mesh.geometry.setDrawRange(0, n * this.indicesPerBlade);
      mesh.visible = true;
    }
    for (let k = used; k < this.pool.length; k++) this.pool[k].visible = false;
    this.active = used;
  }

  /** Blades submitted this frame (before the frustum culls whole tiles). */
  get blades(): number {
    let n = 0;
    for (const m of this.pool) if (m.visible) n += m.geometry.drawRange.count / this.indicesPerBlade;
    return n;
  }

  private mesh(k: number): THREE.Mesh {
    while (this.pool.length <= k) {
      // Its own geometry (for its own blade count) over the layer's shared buffers.
      const g = new THREE.BufferGeometry();
      g.setIndex(this.geometry.index);
      for (const [name, attr] of Object.entries(this.geometry.attributes)) g.setAttribute(name, attr);
      g.boundingSphere = this.geometry.boundingSphere;
      g.boundingBox = this.geometry.boundingBox;
      const mesh = new THREE.Mesh(g, this.material);
      mesh.name = 'grass-tile';
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.raycast = () => {};
      mesh.position.set(NaN, 0, NaN);
      this.parent.add(mesh);
      this.pool.push(mesh);
    }
    return this.pool[k];
  }

  hide(): void {
    for (const m of this.pool) m.visible = false;
    this.lastKey = '';
    this.active = 0;
  }

  dispose(): void {
    for (const m of this.pool) {
      m.removeFromParent();
      m.geometry.dispose();
    }
    this.geometry.dispose();
  }
}

/** Builds and animates the grass on every lawn of the map. */
export class Grass {
  readonly root = new THREE.Group();
  readonly material: THREE.MeshLambertMaterial;
  readonly mask: LawnMask;
  private readonly texture: THREE.DataTexture;
  private readonly warmGeometry: THREE.BufferGeometry;
  private layers: Layer[] = [];
  private quality: GrassQuality = 'off';
  private readonly tramplers: THREE.Vector4[] = [];
  readonly uniforms = {
    uLawn: { value: null as unknown as THREE.Texture },
    uLawnRect: { value: new THREE.Vector4() },
    /** Extra wind on the lawns on top of the shared wind (rain gusts harder). */
    uGrassGust: { value: 1 },
    /** Shortens the fade distances while zoomed in (sights, scopes) so far grass stays. */
    uGrassLodScale: { value: 1 },
    uGrassRoot: { value: new THREE.Color(0x1a2412) },
    uGrassTip: { value: new THREE.Color(0x6b8a3e) },
    uGrassDry: { value: new THREE.Color(0x8a7a48) },
    uTramplers: { value: [] as THREE.Vector4[] },
  };

  constructor(map: MapDefinition) {
    this.root.name = 'grass';
    this.mask = buildLawnMask(map);
    const m = this.mask;
    this.texture = new THREE.DataTexture(m.data, m.w, m.h, THREE.RGFormat, THREE.UnsignedByteType);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.uniforms.uLawn.value = this.texture;
    this.uniforms.uLawnRect.value.set(m.x0, m.z0, 1 / (m.w * m.texel), 1 / (m.h * m.texel));
    for (let i = 0; i < GRASS_TRAMPLERS; i++) this.tramplers.push(new THREE.Vector4(0, 0, 1, 0));
    this.uniforms.uTramplers.value = this.tramplers;

    this.material = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.material.name = 'grass-blades';
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms, {
        uGroundBake: bakeUniforms.uGroundBake,
        uGroundRect: bakeUniforms.uGroundRect,
        uBakeGain: bakeUniforms.uBakeGain,
        uWetness: weatherUniforms.uWetness,
        uSkyRefl: weatherUniforms.uSkyRefl,
      });
      bindWind(shader);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${WIND_GLSL}\n${VERTEX_PARS}`)
        .replace('#include <beginnormal_vertex>', VERTEX_BLADE)
        .replace('#include <begin_vertex>', 'vec3 transformed = gPos;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          // Blades off the lawn or faded out collapse outside the view.
          if (gHidden) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_PARS}`)
        .replace('#include <color_fragment>', 'diffuseColor.rgb = vGrassColor;')
        .replace('#include <lights_lambert_pars_fragment>', lambertWithGrassLight())
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          // Half the ground's normal: the lawn reads as one surface, the blades as its texture.
          gBladeN = normal;
          normal = normalize(mix(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), 0.55));`)
        .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
          // The ground lightmap at the root: sky visibility scales the fill, baked lamps add.
          irradiance = irradiance * vGrassBake.a + vGrassBake.rgb * uBakeGain;`)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          // Wet blades mirror the glowing fog at grazing angles, like the wet ground under them.
          if (gWet > 0.01) {
            float gNv = saturate(dot(normal, normalize(vViewPosition)));
            reflectedLight.indirectDiffuse += uSkyRefl * (F_Schlick(vec3(0.02), 1.0, gNv) * 0.18 * gWet * (0.3 + 0.7 * vGrassH));
          }`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          gWet = uWetness * smoothstep(0.42, 0.8, vGrassBake.a);`);
    };
    this.material.customProgramCacheKey = () => 'grass-blades';

    // Always drawn with no blades, so the grass shader is compiled with the rest at load even when
    // no lawn is in reach (or grass is off and turned on later).
    const warm = tileGeometry(QUALITY.low[1], [[0, 0, 1, 1]]);
    warm.setDrawRange(0, 0);
    this.warmGeometry = warm;
    const sentinel = new THREE.Mesh(warm, this.material);
    sentinel.name = 'grass-warm';
    sentinel.frustumCulled = false;
    sentinel.castShadow = false;
    sentinel.receiveShadow = true;
    sentinel.raycast = () => {};
    this.root.add(sentinel);
    current = this;
  }

  setQuality(q: GrassQuality): void {
    if (q === this.quality) return;
    this.quality = q;
    for (const l of this.layers) l.dispose();
    this.layers = [];
    if (q === 'off') return;
    QUALITY[q].forEach((spec, i) => this.layers.push(new Layer(spec, this.mask, this.material, this.root, 7 + i * 31)));
  }

  /** Feet in the grass, nearest first (the first GRASS_TRAMPLERS count; the rest is ignored). */
  setTramplers(list: readonly GrassFoot[], count = list.length): void {
    for (let i = 0; i < GRASS_TRAMPLERS; i++) {
      const t = i < count ? list[i] : undefined;
      if (t) this.tramplers[i].set(t.x, t.z, t.r, t.k);
      else this.tramplers[i].w = 0;
    }
  }

  /** Per frame, after updateWind: `gust` scales the shared wind on the lawns. */
  update(camera: THREE.PerspectiveCamera, gust = 1): void {
    const u = this.uniforms;
    u.uGrassGust.value = gust;
    // Zoomed in (aiming, scopes), grass reaches as far on screen as it does unzoomed.
    const lodScale = THREE.MathUtils.clamp(camera.fov / 60, 0.4, 1);
    u.uGrassLodScale.value = lodScale;
    for (const l of this.layers) l.update(camera.position.x, camera.position.z, lodScale);
  }

  /** Tiles in reach and blades submitted now, per layer (before frustum culling). */
  get stats(): { tiles: number; blades: number }[] {
    return this.layers.map((l) => ({ tiles: l.active, blades: l.blades }));
  }

  dispose(): void {
    if (current === this) current = null;
    for (const l of this.layers) l.dispose();
    this.layers = [];
    this.root.removeFromParent();
    this.texture.dispose();
    this.warmGeometry.dispose();
    this.material.dispose();
  }
}
