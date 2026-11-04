import * as THREE from 'three';
import { WIND_GLSL, windUniforms } from '../Wind';
import { weatherUniforms } from '../../lighting/WetShader';
import { BODY_KNEE, GLOSS_CAP_GLSL } from '../../lighting/GlossCap';

/**
 * Shader patches for instanced trees (MeshStandardMaterial, so fog, moon shadows, the flashlight
 * and every scene light work as on any surface; the point and spot lights are summed per vertex):
 *  - wind: the whole tree leans and rocks with the gusts, branches bob, leaves flutter (GPU only);
 *  - static light: two light probes per tree (low and high in the crown) read from a data texture,
 *    applied per vertex (sky visibility, bounce, the two strongest baked lamps; leaves also let lamp
 *    light through toward the eye);
 *  - LOD cross-fades: a screen-space dither between neighbouring levels instead of a pop;
 *  - leaves: alpha-tested cards whose coverage holds up in the distance, normals from the crown
 *    (never flipped on back faces), dithered out right in front of the camera;
 *  - rain darkens bark and leaves and makes them glossier.
 * Programs are shared by every species (per-species values are uniforms), and the shadow pass
 * sways and fades with the same code (customDepthMaterial).
 */

export const LOD_BANDS = 8;

/** Rows per tree in the data texture: 5 per probe (ambient+ao, dir0+height, col0, dir1, col1). */
export const TREE_DATA_ROWS = 10;

/** Shared by every tree material (the data texture and LOD bands are swapped in place). */
export const treeUniforms = {
  uTreeData: { value: new THREE.DataTexture(new Float32Array(4 * TREE_DATA_ROWS), 1, TREE_DATA_ROWS, THREE.RGBAFormat, THREE.FloatType) as THREE.Texture },
  /**
   * Per LOD band (trees: 0 near, 1 middle, 2 impostor; shrubs: 3 near, 4 middle; the woods: 5 near,
   * 6 middle, 7 impostor): fade in from x to y, fade out from z to w (horizontal metres from the camera).
   */
  uLodBand: { value: Array.from({ length: LOD_BANDS }, () => new THREE.Vector4(-2, -1, 1e5, 1e5 + 1)) },
  /** The main camera (the shadow passes have their own cameraPosition). */
  uTreeEye: { value: new THREE.Vector3() },
  uWetness: weatherUniforms.uWetness,
};

const COMMON_VERT = /* glsl */ `
attribute vec2 aTree;
#ifndef TREE_IMPOSTOR
attribute vec4 aWind;
#endif
uniform sampler2D uTreeData;
uniform vec4 uLodBand[${LOD_BANDS}];
uniform vec3 uTreeEye;
uniform vec3 uTint0;
uniform vec3 uTint1;
uniform vec3 uTint2;
${WIND_GLSL}
varying vec2 vTreeFade;
#ifndef TREE_DEPTH
varying vec4 vTreeAmb;
varying vec3 vTreeDirect;
#endif
float treeHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 treeTint(vec3 p) {
  float h = treeHash(p.xz);
  vec3 c = h < 0.64 ? uTint0 : (h < 0.85 ? uTint1 : uTint2);
  return c * (0.82 + 0.36 * treeHash(p.zx + 7.13));
}
vec2 treeFade(vec3 p) {
  float d = length(uTreeEye.xz - p.xz);
  vec4 b = uLodBand[int(aTree.y + 0.5)];
  return vec2(smoothstep(b.x, b.y, d), 1.0 - smoothstep(b.z, b.w, d));
}
#ifndef TREE_DEPTH
vec3 treeLit(vec3 n, vec3 toEye, vec3 l, vec3 c) {
#ifdef TREE_LEAF
  // Wrapped (light reaches round into the crown) plus what shines through toward the eye.
  return c * (max((dot(n, l) + 0.5) / 1.5, 0.0) + pow(max(dot(-toEye, l), 0.0), 4.0) * 0.5);
#else
  return c * max(dot(n, l), 0.0);
#endif
}
vec3 treeProbe(int id, int row, vec3 n, vec3 toEye) {
  vec4 d0 = texelFetch(uTreeData, ivec2(id, row + 1), 0);
  vec4 c0 = texelFetch(uTreeData, ivec2(id, row + 2), 0);
  vec4 d1 = texelFetch(uTreeData, ivec2(id, row + 3), 0);
  vec4 c1 = texelFetch(uTreeData, ivec2(id, row + 4), 0);
  return treeLit(n, toEye, d0.xyz, c0.rgb) + treeLit(n, toEye, d1.xyz, c1.rgb);
}
#endif
#ifdef TREE_VERTEX_LIGHTS
#include <lights_pars_begin>
varying vec3 vTreePunctual;
/** Point and spot lights (flashlights, muzzle flashes, sirens, fires) on a tree vertex, view space. */
vec3 treePunctual(vec3 pos, vec3 n) {
  vec3 acc = vec3(0.0);
  vec3 toEye = normalize(-pos);
  IncidentLight tl;
#if NUM_POINT_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_POINT_LIGHTS; i ++ ) {
    getPointLightInfo( pointLights[ i ], pos, tl );
    acc += treeLit( n, toEye, tl.direction, tl.color );
  }
  #pragma unroll_loop_end
#endif
#if NUM_SPOT_LIGHTS > 0
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_SPOT_LIGHTS; i ++ ) {
    getSpotLightInfo( spotLights[ i ], pos, tl );
    acc += treeLit( n, toEye, tl.direction, tl.color );
  }
  #pragma unroll_loop_end
#endif
  return acc;
}
#endif
`;

const WIND_VERT = /* glsl */ `
#include <begin_vertex>
vec3 tP = instanceMatrix[3].xyz;
mat3 tM = mat3(instanceMatrix);
vec3 tS2 = vec3(dot(tM[0], tM[0]), dot(tM[1], tM[1]), dot(tM[2], tM[2]));
float tSeed = treeHash(tP.xz);
float tStr = uWindStrength * (0.4 + 0.6 * windGust(tP.xz));
vec3 tWd = vec3(uWindDir.x, 0.0, uWindDir.y);
float tT = uWindTime;
{
  // The whole tree leans downwind in gusts and rocks slowly (metres at the top).
  float rock = sin(tT * 0.8 + tSeed * 6.2832) * 0.6 + sin(tT * 1.37 + tSeed * 3.1) * 0.4;
  vec3 dW = tWd * aWind.w * tStr * (0.045 + rock * 0.025);
  // Branches bob and swing around that, each on its own phase.
  float bph = (aWind.z + tSeed) * 6.2832;
  float bs = sin(tT * 1.9 + bph) * 0.65 + sin(tT * 3.1 + bph * 1.7) * 0.35;
  dW += (tWd * (0.45 + 0.55 * bs) * 0.09 + vec3(0.0, bs * 0.045, 0.0)) * aWind.x * tStr;
  transformed += (transpose(tM) * dW) / tS2;
  // Leaves flutter across their face.
  float fl = sin(tT * 8.3 + bph * 3.0 + dot(position, vec3(2.1, 1.7, 2.9)));
  transformed += normal * (fl * 0.028 * aWind.y * (0.35 + 0.45 * tStr));
}
vTreeFade = treeFade(tP);
#ifndef TREE_DEPTH
{
  int id = int(aTree.x + 0.5);
  vec3 wN = normalize(tM * objectNormal);
  vec3 wPos = tP + tM * transformed;
  vec3 toEye = normalize(cameraPosition - wPos);
  vec4 aL = texelFetch(uTreeData, ivec2(id, 0), 0);
  vec4 aH = texelFetch(uTreeData, ivec2(id, 5), 0);
  float hL = texelFetch(uTreeData, ivec2(id, 1), 0).w;
  float hH = texelFetch(uTreeData, ivec2(id, 6), 0).w;
  float f = clamp((position.y - hL) / max(hH - hL, 0.1), 0.0, 1.0);
  vTreeAmb = mix(aL, aH, f);
  vTreeDirect = mix(treeProbe(id, 0, wN, toEye), treeProbe(id, 5, wN, toEye), f);
}
#endif
`;

const COMMON_FRAG = /* glsl */ `
varying vec2 vTreeFade;
#ifdef TREE_VERTEX_LIGHTS
varying vec3 vTreePunctual;
#endif
#ifndef TREE_DEPTH
varying vec4 vTreeAmb;
varying vec3 vTreeDirect;
uniform float uWetness;
uniform float uLeafTexSize;
${GLOSS_CAP_GLSL}
#endif
float treeDither() { return fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))); }
`;

/**
 * Leaves right in front of the camera thin out (never stuck inside a crown in the woods): all there
 * from `full` metres, dithered away closer in. Under a 15% share the dither keeps only lone pixels,
 * so standing under a pine scattered dark specks over the sky; from 25% the kept pixels touch. So
 * below `floor` the leaves are gone entirely (closer than about 2.3 m).
 */
export const NEAR_LEAF = { gone: 1.2, full: 4.6, floor: 0.25 };

const FADE_FRAG = /* glsl */ `
#include <clipping_planes_fragment>
{
  float dn = treeDither();
  if (dn > vTreeFade.y || dn < 1.0 - vTreeFade.x) discard;
#if defined(TREE_LEAF) && !defined(TREE_DEPTH)
  float camDist = length(vViewPosition);
  if (camDist < ${NEAR_LEAF.full.toFixed(2)}) {
    float keep = smoothstep(${NEAR_LEAF.gone.toFixed(2)}, ${NEAR_LEAF.full.toFixed(2)}, camDist);
    if (keep < ${NEAR_LEAF.floor.toFixed(2)} || dn > keep) discard;
  }
#endif
}
`;

/**
 * Leaves are most of the woods' pixels, many cards deep, and a dozen point and spot lights per
 * pixel made the forest several times slower than the rest of the map: on trees those lights are
 * summed per vertex instead (treePunctual), and the per-pixel loop keeps the moon (with its
 * shadows) and the sky. Impostors, far past every point and spot light's reach, skip them.
 */
function withoutPointSpot(chunk: string): string | null {
  const a = chunk.indexOf('#if ( NUM_POINT_LIGHTS > 0 ) && defined( RE_Direct )');
  const b = chunk.indexOf('#if ( NUM_SUN_LIGHTS > 0 ) && defined( RE_Direct )');
  const c = chunk.indexOf('#if ( NUM_SPOT_LIGHTS > 0 ) && defined( RE_Direct )');
  return a >= 0 && c > a && b > c ? chunk.slice(0, a) + chunk.slice(b) : null;
}
const MOON_ONLY = withoutPointSpot(THREE.ShaderChunk.lights_fragment_begin);
/** False if three's light chunk changed shape (trees then light per pixel as before). */
export const TREE_VERTEX_LIGHTS = MOON_ONLY !== null;

/** Keeps coverage as the leaf texture shrinks (alpha-tested mips otherwise thin to nothing). */
const LEAF_ALPHA = /* glsl */ `
#include <map_fragment>
{
  vec2 mt = vMapUv * uLeafTexSize;
  vec2 ddx = dFdx(mt), ddy = dFdy(mt);
  float mip = 0.5 * log2(max(max(dot(ddx, ddx), dot(ddy, ddy)), 1e-8));
  diffuseColor.a *= 1.0 + max(mip, 0.0) * 0.28;
}
`;

const LIGHT_FRAG = /* glsl */ `
#include <lights_fragment_maps>
#ifdef TREE_LEAF
irradiance = irradiance * vTreeAmb.a * 1.25 + vTreeAmb.rgb;
#else
irradiance = irradiance * vTreeAmb.a + vTreeAmb.rgb;
#endif
reflectedLight.directDiffuse += vTreeDirect * BRDF_Lambert(material.diffuseColor);
#ifdef TREE_VERTEX_LIGHTS
reflectedLight.directDiffuse += vTreePunctual * BRDF_Lambert(material.diffuseColor);
#endif
`;

/**
 * A crown right beside a floodlight or a fire would light up past the bloom threshold: the light
 * on bark and leaves eases under the same ceiling as bodies (GlossCap, the bloom budget).
 */
const CEIL_FRAG = /* glsl */ `
#include <lights_fragment_end>
reflectedLight.directDiffuse = softCeil(reflectedLight.directDiffuse, ${BODY_KNEE.toFixed(2)}, 1.0);
reflectedLight.directSpecular = softCeil(reflectedLight.directSpecular, 0.45, 1.0);
`;

const WET_FRAG = /* glsl */ `
#include <color_fragment>
diffuseColor.rgb *= 1.0 - 0.3 * uWetness;
`;
const WET_ROUGH = /* glsl */ `
#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.55, uWetness);
`;

/** normal_fragment_begin without the back-face flip (crown normals point out on both faces). */
const LEAF_NORMAL = THREE.ShaderChunk.normal_fragment_begin.replace(/normal \*= faceDirection;/g, '');

/**
 * The moon on leaves: wrapped diffuse (light reaches round into the crown) plus a little shining
 * through toward the eye when backlit, and no GGX highlight: with crown normals the far side of a
 * crown faces away from the camera, where GGX blows up and lit whole pines frosty white.
 */
const LEAF_BRDF = /* glsl */ `
#include <lights_physical_pars_fragment>
void RE_Direct_TreeLeaf(const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight) {
  float wrap = max((dot(geometryNormal, directLight.direction) + 0.6) / 1.6, 0.0);
  float through = pow(max(dot(-geometryViewDir, directLight.direction), 0.0), 4.0) * 0.5;
  // x1.3: light scattered on through the leaf layers (a crown is brighter than one leaf).
  reflectedLight.directDiffuse += (wrap + through) * 1.3 * directLight.color * BRDF_Lambert(material.diffuseColor);
}
#undef RE_Direct
#define RE_Direct RE_Direct_TreeLeaf
`;

export interface TreeTints {
  /** Most trees, then the less common two (autumn, dry) by a per-tree hash. */
  tints: [THREE.Color, THREE.Color, THREE.Color];
}

function patchTree(shader: THREE.WebGLProgramParametersWithUniforms, own: Record<string, THREE.IUniform>, leaf: boolean, depth: boolean): void {
  Object.assign(shader.uniforms, treeUniforms, windUniforms, own);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${COMMON_VERT}`)
    .replace('#include <begin_vertex>', WIND_VERT)
    .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb *= treeTint(instanceMatrix[3].xyz);')
    .replace('#include <project_vertex>', '#include <project_vertex>\n#ifdef TREE_VERTEX_LIGHTS\nvTreePunctual = treePunctual(mvPosition.xyz, normalize(transformedNormal));\n#endif');
  let frag = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${COMMON_FRAG}`)
    .replace('#include <clipping_planes_fragment>', FADE_FRAG);
  if (!depth) {
    frag = frag
      .replace('#include <lights_fragment_maps>', LIGHT_FRAG)
      .replace('#include <lights_fragment_end>', CEIL_FRAG)
      .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectSpecular *= vTreeAmb.a;')
      .replace('#include <color_fragment>', WET_FRAG)
      .replace('#include <roughnessmap_fragment>', WET_ROUGH);
    if (leaf) {
      frag = frag
        .replace('#include <map_fragment>', LEAF_ALPHA)
        .replace('#include <normal_fragment_begin>', LEAF_NORMAL)
        .replace('#include <lights_physical_pars_fragment>', LEAF_BRDF);
    }
    if (MOON_ONLY) frag = frag.replace('#include <lights_fragment_begin>', MOON_ONLY);
  }
  shader.fragmentShader = frag;
}

/** Bark or leaves for one species, with the matching shadow-pass material. */
export function createTreeMaterial(opts: {
  leaf: boolean;
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  color: THREE.ColorRepresentation;
  roughness: number;
  tints: [THREE.Color, THREE.Color, THREE.Color];
  texSize: number;
}): { material: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial } {
  const own = {
    uTint0: { value: opts.tints[0] },
    uTint1: { value: opts.tints[1] },
    uTint2: { value: opts.tints[2] },
    uLeafTexSize: { value: opts.texSize },
  };
  const m = new THREE.MeshStandardMaterial({
    color: opts.color,
    roughness: opts.roughness,
    metalness: 0,
    map: opts.map,
    normalMap: opts.normalMap ?? null,
    vertexColors: true,
    side: opts.leaf ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: opts.leaf ? 0.5 : 0,
  });
  if (opts.normalMap) m.normalScale.set(0.9, 0.9);
  m.defines = { ...(opts.leaf ? { TREE_LEAF: '' } : {}), ...(TREE_VERTEX_LIGHTS ? { TREE_VERTEX_LIGHTS: '' } : {}) };
  m.userData.noBake = true;
  m.onBeforeCompile = (s) => patchTree(s, own, opts.leaf, false);
  m.customProgramCacheKey = () => (opts.leaf ? 'tree-leaf' : 'tree-bark');
  const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  d.defines = opts.leaf ? { TREE_LEAF: '', TREE_DEPTH: '' } : { TREE_DEPTH: '' };
  d.onBeforeCompile = (s) => patchTree(s, own, opts.leaf, true);
  d.customProgramCacheKey = () => (opts.leaf ? 'tree-leaf-depth' : 'tree-bark-depth');
  return { material: m, depth: d };
}

/** Everything the impostor shader needs to find a model's views in the atlas. */
export interface ImpostorUniforms {
  /** x cell width (uv), y cell height (uv), z the row's bottom v, w number of views. */
  uImpCell: { value: THREE.Vector4 };
  /** Horizontal padding inside each view's cell, as a fraction of the cell. */
  uImpPad: { value: number };
  /** The model's billboard width and height (m). */
  uImpSize: { value: THREE.Vector2 };
}

/**
 * Far trees: one camera-facing card per tree showing the model pre-rendered from 8 directions
 * (the two nearest views blended), lit with the normals rendered alongside, so they shade like
 * the real ones under the moon, lamps and flashlight. Atlas texels: r = sqrt(albedo luminance),
 * g, b = view-space normal xy, a = coverage.
 */
export function createImpostorMaterial(atlas: THREE.Texture, imp: ImpostorUniforms, tints: [THREE.Color, THREE.Color, THREE.Color], atlasSize: number): THREE.MeshStandardMaterial {
  const own = {
    uTint0: { value: tints[0] },
    uTint1: { value: tints[1] },
    uTint2: { value: tints[2] },
    uLeafTexSize: { value: atlasSize },
    ...imp,
  };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, map: atlas, alphaTest: 0.5 });
  m.defines = { TREE_IMPOSTOR: '' };
  m.userData.noBake = true;
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, treeUniforms, windUniforms, own);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${COMMON_VERT}
        uniform vec4 uImpCell;
        uniform float uImpPad;
        uniform vec2 uImpSize;
        varying vec2 vImpUv0;
        varying vec2 vImpUv1;
        varying float vImpBlend;
        varying vec3 vImpR;
        varying vec3 vImpU;
        varying vec3 vImpTint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 tP = instanceMatrix[3].xyz;
        mat3 tM = mat3(instanceMatrix);
        vec3 tS2 = vec3(dot(tM[0], tM[0]), dot(tM[1], tM[1]), dot(tM[2], tM[2]));
        vec3 toCam = uTreeEye - tP;
        vec2 dc = normalize(toCam.xz + vec2(1e-4, 0.0));
        vec3 right = vec3(dc.y, 0.0, -dc.x);
        vec3 offW = right * (position.x * uImpSize.x * sqrt(tS2.x)) + vec3(0.0, position.y * uImpSize.y * sqrt(tS2.y), 0.0);
        offW += vec3(uWindDir.x, 0.0, uWindDir.y) * (position.y * position.y) * uWindStrength * (0.4 + 0.6 * windGust(tP.xz)) * 0.06;
        transformed = (transpose(tM) * offW) / tS2;
        // Which two of the views to show: the camera's direction in the tree's own frame.
        vec3 lc = transpose(tM) * vec3(toCam.x, 0.0, toCam.z);
        float fr = fract(atan(lc.x, lc.z) / 6.2831853 + 1.0) * uImpCell.w;
        float f0 = floor(fr);
        vImpBlend = fr - f0;
        float f1 = mod(f0 + 1.0, uImpCell.w);
        vec2 cuv = vec2(uImpPad + (position.x + 0.5) * (1.0 - 2.0 * uImpPad), position.y);
        vImpUv0 = vec2((f0 + cuv.x) * uImpCell.x, uImpCell.z + cuv.y * uImpCell.y);
        vImpUv1 = vec2((f1 + cuv.x) * uImpCell.x, uImpCell.z + cuv.y * uImpCell.y);
        vImpR = normalize((viewMatrix * vec4(right, 0.0)).xyz);
        vImpU = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        vImpTint = treeTint(tP);
        vTreeFade = treeFade(tP);
        {
          int id = int(aTree.x + 0.5);
          vTreeAmb = texelFetch(uTreeData, ivec2(id, 5), 0);
          vec3 c = texelFetch(uTreeData, ivec2(id, 7), 0).rgb + texelFetch(uTreeData, ivec2(id, 9), 0).rgb;
          vTreeDirect = c * 0.5;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${COMMON_FRAG}
        varying vec2 vImpUv0;
        varying vec2 vImpUv1;
        varying float vImpBlend;
        varying vec3 vImpR;
        varying vec3 vImpU;
        varying vec3 vImpTint;`)
      .replace('#include <clipping_planes_fragment>', FADE_FRAG)
      .replace('#include <map_fragment>', `
        vec4 im = mix(texture2D(map, vImpUv0), texture2D(map, vImpUv1), vImpBlend);
        diffuseColor.rgb *= vImpTint * (im.r * im.r);
        diffuseColor.a *= im.a;
        {
          vec2 mt = vImpUv0 * uLeafTexSize;
          vec2 ddx = dFdx(mt), ddy = dFdy(mt);
          float mip = 0.5 * log2(max(max(dot(ddx, ddx), dot(ddy, ddy)), 1e-8));
          diffuseColor.a *= 1.0 + max(mip, 0.0) * 0.28;
        }`)
      .replace('#include <color_fragment>', WET_FRAG)
      .replace('#include <normal_fragment_begin>', `
        float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;
        vec3 nC = vec3(im.g * 2.0 - 1.0, im.b * 2.0 - 1.0, 0.0);
        nC.z = sqrt(max(1.0 - dot(nC.xy, nC.xy), 0.0));
        vec3 normal = normalize(nC.x * vImpR + nC.y * vImpU + nC.z * cross(vImpR, vImpU));
        vec3 nonPerturbedNormal = normal;`)
      // The light already falls on the normals: the baked lamps arrive as soft fill.
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        irradiance = irradiance * vTreeAmb.a + vTreeAmb.rgb + vTreeDirect;`)
      .replace('#include <lights_fragment_end>', CEIL_FRAG)
      .replace('#include <lights_physical_pars_fragment>', LEAF_BRDF)
      .replace('#include <lights_fragment_begin>', MOON_ONLY ?? '#include <lights_fragment_begin>');
  };
  m.customProgramCacheKey = () => 'tree-impostor';
  return m;
}
