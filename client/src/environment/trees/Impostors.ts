import * as THREE from 'three';
import type { TreeModel } from './TreeGen';
import type { ImpostorUniforms } from './TreeMaterials';
import { releaseAfterUpload } from './TreeTextures';

/** Views per model around the trunk. */
export const IMPOSTOR_VIEWS = 8;

const BAKE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vC;
void main() {
  vUv = uv;
  vC = color;
  vN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const BAKE_FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 uColor;
uniform float uLeaf;
uniform float uTexSize;
uniform float uRefLum;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vC;
void main() {
  vec4 t = texture2D(map, vUv);
  if (uLeaf > 0.5) {
    vec2 mt = vUv * uTexSize;
    vec2 ddx = dFdx(mt), ddy = dFdy(mt);
    float mip = 0.5 * log2(max(max(dot(ddx, ddx), dot(ddy, ddy)), 1e-8));
    if (t.a * (1.0 + max(mip, 0.0) * 0.28) < 0.5) discard;
  }
  vec3 alb = t.rgb * vC * uColor;
  float lum = dot(alb, vec3(0.2126, 0.7152, 0.0722)) / uRefLum;
  vec3 n = normalize(vN);
  if (uLeaf < 0.5 && !gl_FrontFacing) n = -n;
  gl_FragColor = vec4(sqrt(clamp(lum, 0.0, 1.0)), n.x * 0.5 + 0.5, n.y * 0.5 + 0.5, 1.0);
}`;

export interface BakeSource {
  model: TreeModel;
  bark: { map: THREE.Texture; color: THREE.Color } | null;
  leaves: { map: THREE.Texture; texSize: number };
  /** Luminance of the leaf tint the impostor multiplies by (bark is stored relative to it). */
  refLum: number;
}

export interface ImpostorAtlas {
  texture: THREE.DataTexture;
  size: number;
  cells: ImpostorUniforms[];
}

/**
 * Renders each model from IMPOSTOR_VIEWS directions (orthographic, level with the trunk) into one
 * atlas row per model, reads it back, fills the empty texels around the silhouettes with their
 * neighbours' values (so mipmaps don't darken the edges) and uploads it as a mipmapped texture.
 */
export function bakeImpostors(renderer: THREE.WebGLRenderer, sources: BakeSource[], cellH: number): ImpostorAtlas {
  // Empty texels round every view, so far (low-mip) cards never pick up their neighbours.
  const pad = Math.max(4, Math.round(cellH / 24));
  const inner = cellH - pad * 2;
  const widths = sources.map((s) => Math.max(16, Math.round((inner * (2 * s.model.radius)) / (s.model.height + 0.2) / 4) * 4) + pad * 2);
  const w = Math.max(...widths) * IMPOSTOR_VIEWS;
  const h = cellH * sources.length;
  // One draw of every view at once (the MSAA target is resolved once): the camera looks down -z in
  // pixel units and each view is a copy of the model turned to face it, scaled to its cell.
  const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4, depthBuffer: true, type: THREE.UnsignedByteType });
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(0, w, h, 0, 1, 4000);
  cam.position.set(0, 0, 2000);
  cam.updateMatrixWorld();
  const mats: THREE.ShaderMaterial[] = [];
  const material = (map: THREE.Texture, color: THREE.Color, leaf: boolean, texSize: number, refLum: number) => {
    const m = new THREE.ShaderMaterial({
      vertexShader: BAKE_VERT,
      fragmentShader: BAKE_FRAG,
      vertexColors: true,
      side: leaf ? THREE.DoubleSide : THREE.FrontSide,
      uniforms: { map: { value: map }, uColor: { value: color }, uLeaf: { value: leaf ? 1 : 0 }, uTexSize: { value: texSize }, uRefLum: { value: refLum } },
    });
    mats.push(m);
    return m;
  };
  const cells: ImpostorUniforms[] = [];
  sources.forEach((s, row) => {
    const m = s.model;
    const H = m.height + 0.2;
    const cw = widths[row];
    const scale = inner / H;
    const parts = m.lods[0];
    const barkMat = parts.bark && s.bark ? material(s.bark.map, s.bark.color, false, 512, s.refLum) : null;
    const leafMat = material(s.leaves.map, new THREE.Color(1, 1, 1), true, s.leaves.texSize, 1);
    for (let k = 0; k < IMPOSTOR_VIEWS; k++) {
      const holder = new THREE.Group();
      // Seen from azimuth a (direction (sin a, 0, cos a) in the model's frame).
      holder.rotation.y = -(k / IMPOSTOR_VIEWS) * Math.PI * 2;
      holder.scale.setScalar(scale);
      holder.position.set(k * cw + cw / 2, row * cellH + pad, 0);
      if (barkMat) holder.add(new THREE.Mesh(parts.bark!, barkMat));
      holder.add(new THREE.Mesh(parts.leaves, leafMat));
      scene.add(holder);
    }
    cells.push({
      uImpCell: { value: new THREE.Vector4(cw / w, inner / h, (row * cellH + pad) / h, IMPOSTOR_VIEWS) },
      uImpPad: { value: (pad / cw) },
      uImpSize: { value: new THREE.Vector2((cw - pad * 2) / scale, H) },
    });
  });
  const prev = {
    target: renderer.getRenderTarget(),
    clear: renderer.getClearColor(new THREE.Color()),
    alpha: renderer.getClearAlpha(),
  };
  try {
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, false);
    renderer.render(scene, cam);
    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    dilate(px, w, h);
    const tex = new THREE.DataTexture(px, w, h, THREE.RGBAFormat);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return { texture: releaseAfterUpload(tex), size: Math.max(w, h), cells };
  } finally {
    renderer.setRenderTarget(prev.target);
    renderer.setClearColor(prev.clear, prev.alpha);
    rt.dispose();
    for (const m of mats) m.dispose();
  }
}

/**
 * Undoes the MSAA blend with the (zero) background along the silhouettes, then spreads the colour
 * and normal of covered texels outward over empty ones, a few texels at a time.
 */
function dilate(px: Uint8Array, w: number, h: number): void {
  for (let i = 0; i < w * h; i++) {
    const a = px[i * 4 + 3];
    if (a > 0 && a < 255) {
      const k = 255 / a;
      px[i * 4] = Math.min(255, px[i * 4] * k);
      px[i * 4 + 1] = Math.min(255, px[i * 4 + 1] * k);
      px[i * 4 + 2] = Math.min(255, px[i * 4 + 2] * k);
    }
  }
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = px[i * 4 + 3] > 0 ? 1 : 0;
  const next = new Uint8Array(w * h);
  for (let pass = 0; pass < 6; pass++) {
    next.set(filled);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (filled[i]) continue;
        let r = 0, g = 0, b = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (!filled[j]) continue;
          r += px[j * 4]; g += px[j * 4 + 1]; b += px[j * 4 + 2]; n++;
        }
        if (!n) continue;
        px[i * 4] = r / n;
        px[i * 4 + 1] = g / n;
        px[i * 4 + 2] = b / n;
        next[i] = 1;
      }
    }
    filled.set(next);
  }
  // Untouched far texels: a neutral normal facing the camera, mid albedo.
  for (let i = 0; i < w * h; i++) {
    if (filled[i]) continue;
    px[i * 4] = 80;
    px[i * 4 + 1] = 128;
    px[i * 4 + 2] = 128;
  }
}
