import * as THREE from 'three';
import type { MapDefinition, PropSpec } from '@dead-hours/shared';
import type { BakeTracer } from '../lighting/BakeTracer';
import { GLOSS_CAP_GLSL } from '../lighting/GlossCap';
import { weatherUniforms } from '../lighting/WetShader';
import type { PlanarMirror } from '../rendering/PlanarMirror';

/** Height of the water's surface (just over the asphalt), and of the mirror that reflects it. */
export const PUDDLE_Y = 0.026;
/** Static lamps all the puddles share (uniform slots), and how many each puddle reflects. */
export const PUDDLE_LAMP_SLOTS = 16;
const LAMPS_EACH = 4;
/**
 * Rings of the puddle mesh as fractions of its radius: 1 is roughly the water's edge (the shader
 * frays it with noise), past it a damp margin soaks into the road.
 */
const RINGS = [0.3, 0.55, 0.75, 0.88, 0.96, 1.04, 1.13, 1.24, 1.36, 1.5];
const SEGMENTS = 44;
/** The outer ring, as a fraction of the radius: the extent of a puddle and its damp margin. */
const REACH = RINGS[RINGS.length - 1];

/** A lamp a puddle can reflect (a baked map light, or a realtime one). */
interface Lamp {
  pos: THREE.Vector3;
  /** Linear colour × intensity. */
  color: THREE.Color;
  range: number;
  decay: number;
  dir: THREE.Vector3;
  /** cos(outer), cos(inner) of a spot's cone; -2 for point lights. */
  cone: [number, number];
  /** The realtime light, or null for a baked one. */
  light: THREE.PointLight | THREE.SpotLight | null;
}

interface Spot {
  x: number;
  z: number;
  /** Bounding radius, damp margin included. */
  reach: number;
}

/**
 * Standing water left on the streets. Each puddle is a thin film over the road: it takes away some
 * of the road's own light (darker toward the middle, more at grazing angles, where water is a
 * mirror) and adds what the water reflects: the street above it (PlanarMirror, or a sky gradient
 * where reflections are off), the lamps it can see as soft glints, and every live light (flashlight,
 * muzzle flashes, fires) through the material's own lighting. Its edge is frayed with noise and
 * fades into a band of damp, darker asphalt. Rain drops ring it, a drip lands now and then after
 * the rain stops, and the wind ruffles it.
 *
 * All puddles are one blended draw, not part of the static batch or the light bake.
 */
export class Puddles {
  readonly mesh: THREE.Mesh | null = null;
  readonly material: THREE.MeshStandardMaterial;
  private readonly spots: Spot[] = [];
  private readonly props: PropSpec[];
  private mirrorOn = false;
  private readonly live: { slot: number; light: THREE.PointLight | THREE.SpotLight }[] = [];
  readonly uniforms = {
    uPLampPos: { value: Array.from({ length: PUDDLE_LAMP_SLOTS }, () => new THREE.Vector4(0, -100, 0, 1)) },
    uPLampCol: { value: Array.from({ length: PUDDLE_LAMP_SLOTS }, () => new THREE.Vector4(0, 0, 0, 2)) },
    uPLampDir: { value: Array.from({ length: PUDDLE_LAMP_SLOTS }, () => new THREE.Vector4(0, -1, 0, -2)) },
    /** x cos(outer), y cos(inner) (x = -2 for point lights), z 1 for a realtime light (glow only). */
    uPLampCone: { value: Array.from({ length: PUDDLE_LAMP_SLOTS }, () => new THREE.Vector4(-2, -1, 0, 0)) },
    /** Puddles past this distance fall back to the sky gradient (the mirror is not drawn for them). */
    uMirrorFar: { value: 60 },
    /**
     * The look: x head-on reflectance of the mirror (clean water 0.02: a little more reads as dark
     * glass), y fog glow round lamps per unit of fog density, z/w how much of the road's light gets
     * through the water at its shallow edge and in the middle.
     */
    uPuddleLook: { value: new THREE.Vector4(0.05, 0.11, 0.7, 0.45) },
    /** Ruffling by the wind (slope at full wind). */
    uPuddleWind: { value: 0.03 },
  };
  private readonly frustum = new THREE.Frustum();
  private readonly projScreen = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly cam = new THREE.Vector3();

  constructor(map: MapDefinition, private readonly mirror: PlanarMirror) {
    this.props = map.props.filter((p) => p.kind === 'puddle');
    this.material = this.createMaterial();
    if (!this.props.length) return;
    this.mesh = new THREE.Mesh(this.buildGeometry(), this.material);
    this.mesh.name = 'puddles';
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // After the opaque world and before glass, smoke and glares.
    this.mesh.renderOrder = -1;
  }

  /** Reflections on or off (recompiles the water). */
  setMirror(on: boolean, far: number): void {
    this.uniforms.uMirrorFar.value = far;
    if (on === this.mirrorOn) return;
    this.mirrorOn = on;
    this.material.needsUpdate = true;
  }

  /**
   * The lamps each puddle reflects: the brightest few it can see (in range, unblocked, its cone
   * reaching the water). Baked lamps have no specular of their own, so they are added as glints in
   * the shader. Realtime map lights (the flickering streetlight, police strobes) already glint
   * through the material's lighting; for those the shader only adds their glow in the fog, kept
   * in step with them each frame (update).
   */
  setLamps(map: MapDefinition, tracer: BakeTracer, live: THREE.Light[]): void {
    if (!this.mesh) return;
    const cands: Lamp[] = [];
    for (const l of map.lights) {
      if (l.flicker || l.y < 0.5) continue;
      const lamp: Lamp = {
        pos: new THREE.Vector3(l.x, l.y, l.z), color: new THREE.Color(l.color).multiplyScalar(l.intensity),
        range: l.range, decay: l.decay ?? 2, dir: new THREE.Vector3(0, -1, 0), cone: [-2, -1], light: null,
      };
      if (l.kind === 'spot') {
        lamp.dir.set((l.tx ?? l.x) - l.x, (l.ty ?? 0) - l.y, (l.tz ?? l.z) - l.z).normalize();
        const angle = l.angle ?? Math.PI / 3;
        lamp.cone = [Math.cos(angle), Math.cos(angle * (1 - (l.penumbra ?? 0)))];
      }
      cands.push(lamp);
    }
    for (const light of live) {
      if (!(light instanceof THREE.PointLight) && !(light instanceof THREE.SpotLight)) continue;
      const pl = light;
      const pos = pl.getWorldPosition(new THREE.Vector3());
      if (pos.y < 0.5) continue;
      const lamp: Lamp = {
        pos, color: pl.color.clone().multiplyScalar(pl.intensity), range: pl.distance || 20, decay: pl.decay,
        dir: new THREE.Vector3(0, -1, 0), cone: [-2, -1], light: pl,
      };
      if (pl instanceof THREE.SpotLight) {
        const sp = pl;
        lamp.dir.copy(sp.target.getWorldPosition(new THREE.Vector3())).sub(pos).normalize();
        lamp.cone = [Math.cos(sp.angle), Math.cos(sp.angle * (1 - sp.penumbra))];
      }
      // Strobes rest at zero: rank them by a typical flash.
      if (pl.intensity <= 0) lamp.color.copy(pl.color).multiplyScalar(30);
      cands.push(lamp);
    }
    type Pick = { lamp: number; score: number };
    const per: Pick[][] = [];
    const best = new Map<number, number>();
    for (const p of this.props) {
      const reach = (p.length ?? 1.8) * REACH;
      const picks: Pick[] = [];
      cands.forEach((l, i) => {
        const dx = l.pos.x - p.x, dy = l.pos.y - PUDDLE_Y, dz = l.pos.z - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (d >= l.range + reach) return;
        const oy = l.pos.y - 0.1, od = Math.hypot(dx, oy, dz);
        if (tracer.occluded(p.x, 0.1, p.z, dx / od, oy / od, dz / od, od - 0.6)) return;
        // Generous: a spot counts if its cone reaches anywhere near the puddle.
        if (l.cone[0] > -1) {
          const c = -(dx * l.dir.x + dy * l.dir.y + dz * l.dir.z) / d;
          if (c <= Math.cos(Math.acos(l.cone[0]) + Math.atan2(reach, d))) return;
        }
        const lum = 0.2126 * l.color.r + 0.7152 * l.color.g + 0.0722 * l.color.b;
        picks.push({ lamp: i, score: lum / Math.pow(Math.max(d, 1), l.decay) });
      });
      picks.sort((a, b) => b.score - a.score);
      picks.length = Math.min(picks.length, LAMPS_EACH);
      per.push(picks);
      for (const k of picks) best.set(k.lamp, Math.max(best.get(k.lamp) ?? 0, k.score));
    }
    // The strongest lamps get the shared slots.
    const slots = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, PUDDLE_LAMP_SLOTS).map(([i]) => i);
    const u = this.uniforms;
    this.live.length = 0;
    slots.forEach((li, s) => {
      const l = cands[li];
      u.uPLampPos.value[s].set(l.pos.x, l.pos.y, l.pos.z, l.range);
      u.uPLampCol.value[s].set(l.color.r, l.color.g, l.color.b, l.decay);
      u.uPLampDir.value[s].set(l.dir.x, l.dir.y, l.dir.z, 0);
      u.uPLampCone.value[s].set(l.cone[0], l.cone[1], l.light ? 1 : 0, 0);
      if (l.light) this.live.push({ slot: s, light: l.light });
    });
    this.update();
    // Each vertex carries its puddle's slots (-1 = none).
    const attr = this.mesh.geometry.getAttribute('aLamps') as THREE.BufferAttribute;
    const perVertex = 1 + RINGS.length * SEGMENTS;
    per.forEach((picks, n) => {
      const ids = picks.map((k) => slots.indexOf(k.lamp)).filter((s) => s >= 0);
      for (let v = 0; v < perVertex; v++) {
        for (let k = 0; k < 4; k++) attr.setComponent(n * perVertex + v, k, ids[k] ?? -1);
      }
    });
    attr.needsUpdate = true;
  }

  /** Keeps the realtime lamps' glow in the water in step with the lights (flicker, strobes). */
  update(): void {
    const col = this.uniforms.uPLampCol.value;
    for (const { slot, light } of this.live) {
      col[slot].set(light.color.r * light.intensity, light.color.g * light.intensity, light.color.b * light.intensity, col[slot].w);
    }
  }

  /**
   * The screen rectangle (NDC x0, y0, x1, y1) covering every puddle in view within `far` metres, or
   * null when none is: all the mirror needs to draw. With a tracer, puddles hidden behind walls
   * (from indoors, round a corner) don't count.
   */
  screenRect(camera: THREE.PerspectiveCamera, far: number, out: THREE.Vector4, tracer: BakeTracer | null = null): THREE.Vector4 | null {
    if (!this.mesh || !this.mesh.visible) return null;
    camera.updateWorldMatrix(true, false);
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);
    this.cam.setFromMatrixPosition(camera.matrixWorld);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const e = this.projScreen.elements;
    for (const s of this.spots) {
      const dx = s.x - this.cam.x, dz = s.z - this.cam.z;
      const dist = Math.hypot(dx, PUDDLE_Y - this.cam.y, dz);
      if (dist - s.reach > far) continue;
      this.sphere.center.set(s.x, PUDDLE_Y, s.z);
      this.sphere.radius = s.reach;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      if (tracer && !this.inSight(tracer, s)) continue;
      // An octagon a little wider than the disc bounds its outline on screen.
      const r = s.reach * 1.09;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = s.x + Math.cos(a) * r, pz = s.z + Math.sin(a) * r;
        const w = e[3] * px + e[7] * PUDDLE_Y + e[11] * pz + e[15];
        if (w < 0.05) {
          // Wraps round the camera: take the whole screen.
          x0 = y0 = -1;
          x1 = y1 = 1;
          break;
        }
        const nx = (e[0] * px + e[4] * PUDDLE_Y + e[8] * pz + e[12]) / w;
        const ny = (e[1] * px + e[5] * PUDDLE_Y + e[9] * pz + e[13]) / w;
        x0 = Math.min(x0, nx); x1 = Math.max(x1, nx);
        y0 = Math.min(y0, ny); y1 = Math.max(y1, ny);
      }
    }
    // Room for the ripples' offsets, then the screen's edges.
    const pad = 0.03;
    x0 = Math.max(-1, x0 - pad); y0 = Math.max(-1, y0 - pad);
    x1 = Math.min(1, x1 + pad); y1 = Math.min(1, y1 + pad);
    if (!(x1 > x0 && y1 > y0)) return null;
    return out.set(x0, y0, x1, y1);
  }

  /** Whether any of five points across the puddle can be seen from the camera. */
  private inSight(tracer: BakeTracer, s: Spot): boolean {
    const c = this.cam;
    const r = s.reach * 0.6;
    for (let k = 0; k < 5; k++) {
      const px = s.x + (k === 1 ? r : k === 2 ? -r : 0), pz = s.z + (k === 3 ? r : k === 4 ? -r : 0);
      const dx = px - c.x, dy = PUDDLE_Y + 0.05 - c.y, dz = pz - c.z;
      const d = Math.hypot(dx, dy, dz);
      if (d < 0.5 || !tracer.occluded(c.x, c.y, c.z, dx / d, dy / d, dz / d, d - 0.1, 0.01, false)) return true;
    }
    return false;
  }

  private buildGeometry(): THREE.BufferGeometry {
    const perVertex = 1 + RINGS.length * SEGMENTS;
    const n = this.props.length * perVertex;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const pud = new Float32Array(n * 4);
    const lamps = new Float32Array(n * 4).fill(-1);
    const index: number[] = [];
    let v = 0;
    for (const p of this.props) {
      const r = p.length ?? 1.8;
      const variant = p.variant ?? 0;
      const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
      const base = v;
      const put = (lx: number, lz: number, ring: number) => {
        // Local frame of the old prop: x along the puddle, z squashed (turned by rotY).
        pos[v * 3] = p.x + lx * c + lz * s;
        pos[v * 3 + 1] = PUDDLE_Y;
        pos[v * 3 + 2] = p.z - lx * s + lz * c;
        nor[v * 3 + 1] = 1;
        pud[v * 4] = ring;
        pud[v * 4 + 1] = (variant * 0.618) % 1;
        pud[v * 4 + 2] = p.x;
        pud[v * 4 + 3] = p.z;
        v++;
      };
      put(0, 0, 0);
      let far = 0;
      for (const ring of RINGS) {
        for (let k = 0; k < SEGMENTS; k++) {
          const a = (k / SEGMENTS) * Math.PI * 2;
          // A soft, lopsided outline (low harmonics only, so no spikes).
          const f = (0.8 + 0.12 * Math.sin(a * 2 + variant) + 0.07 * Math.sin(a * 3 - variant * 1.7)) * r * ring;
          put(Math.cos(a) * f, -Math.sin(a) * f * 0.7, ring);
          far = Math.max(far, Math.abs(f));
        }
      }
      this.spots.push({ x: p.x, z: p.z, reach: far });
      for (let k = 0; k < SEGMENTS; k++) {
        const k1 = (k + 1) % SEGMENTS;
        // Wound to face up (the outline runs clockwise seen from above).
        index.push(base, base + 1 + k, base + 1 + k1);
        for (let ring = 0; ring < RINGS.length - 1; ring++) {
          const a = base + 1 + ring * SEGMENTS;
          const b = a + SEGMENTS;
          index.push(a + k, b + k, a + k1, a + k1, b + k, b + k1);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    // Ring fraction, a per-puddle seed, and the puddle's centre.
    g.setAttribute('aPuddle', new THREE.BufferAttribute(pud, 4));
    g.setAttribute('aLamps', new THREE.BufferAttribute(lamps, 4));
    g.setIndex(index);
    g.computeBoundingSphere();
    return g;
  }

  private createMaterial(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: 0x000000,
      roughness: 0.04,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    m.name = 'puddle';
    // Premultiplied: the water's own light is added, and alpha is how much of the road it hides.
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.OneFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendSrcAlpha = THREE.ZeroFactor;
    m.blendDstAlpha = THREE.OneFactor;
    m.customProgramCacheKey = () => `puddle|${this.mirrorOn ? 'mirror' : 'sky'}`;
    m.onBeforeCompile = (shader) => {
      const w = weatherUniforms;
      Object.assign(shader.uniforms, this.uniforms, {
        uWxTime: w.uWxTime, uWxWind: w.uWxWind, uWetness: w.uWetness, uRainAmt: w.uRainAmt, uSkyRefl: w.uSkyRefl,
      });
      if (this.mirrorOn) Object.assign(shader.uniforms, this.mirror.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aPuddle;
          attribute vec4 aLamps;
          varying vec3 vPuddleWorld;
          varying vec4 vPuddle;
          varying vec4 vLamps;`)
        .replace('#include <fog_vertex>', `#include <fog_vertex>
          vPuddleWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
          vPuddle = aPuddle;
          vLamps = aLamps;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          #define PUDDLE_MIRROR ${this.mirrorOn ? 1 : 0}
          ${PUDDLE_GLSL}`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
          // The shore: the mesh's ring fraction frayed by noise; past the water, a damp band.
          vec2 pq = vPuddleWorld.xz;
          float pn = puddleNoise(pq * 0.85 + vPuddle.y * 13.0) * 0.68 + puddleNoise(pq * 3.3 + 2.3) * 0.32;
          float pe = vPuddle.x + (pn - 0.5) * 0.32;
          // A crisp water line, deepening quickly inside it; outside, a thin patchy damp band.
          float pWater = 1.0 - smoothstep(0.925, 0.95, pe);
          float pDepth = smoothstep(0.95, 0.62, pe);
          float pDamp = (1.0 - smoothstep(0.95, 1.2, pe)) * smoothstep(0.25, 0.7, puddleNoise(pq * 2.4 + 9.1) + (1.12 - pe));
          float pCover = max(pWater, pDamp);
          if (pCover < 0.004) discard;
          roughnessFactor = mix(0.3, 0.03, pWater);`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          vec2 pSlope = vec2(0.0);
          if (pWater > 0.01) {
            pSlope = (puddleRings(pq, uWxTime, uRainAmt) + puddleWind(pq, uWxTime)) * pWater;
            // The meniscus: the surface curls up to meet the road along the water line, so a thin
            // rim mirrors a different part of the street and outlines the water.
            vec2 outward = pq - vPuddle.zw;
            float ol = length(outward);
            float rim = smoothstep(0.84, 0.925, pe) * (1.0 - smoothstep(0.925, 0.95, pe));
            if (ol > 1e-3) pSlope += outward / ol * rim * 0.3;
            normal = normalize(normal + (viewMatrix * vec4(-pSlope.x, 0.0, -pSlope.y, 0.0)).xyz);
          }`)
        .replace('#include <opaque_fragment>', PUDDLE_COMPOSE)
        .replace('#include <fog_fragment>', `
          #ifdef USE_FOG
            #ifdef FOG_EXP2
              float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
            #else
              float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
            #endif
            // Premultiplied: the fog takes the place of what the water hides as well as what it adds.
            gl_FragColor.rgb = gl_FragColor.rgb * (1.0 - fogFactor) + fogColor * fogFactor * gl_FragColor.a;
          #endif`);
    };
    return m;
  }

  dispose(): void {
    this.mesh?.geometry.dispose();
    this.material.dispose();
  }
}

const PUDDLE_GLSL = /* glsl */ `
  varying vec3 vPuddleWorld;
  varying vec4 vPuddle;
  varying vec4 vLamps;
  uniform float uWetness, uRainAmt, uWxTime;
  uniform vec2 uWxWind;
  uniform vec3 uSkyRefl;
  uniform vec4 uPLampPos[${PUDDLE_LAMP_SLOTS}];
  uniform vec4 uPLampCol[${PUDDLE_LAMP_SLOTS}];
  uniform vec4 uPLampDir[${PUDDLE_LAMP_SLOTS}];
  uniform vec4 uPLampCone[${PUDDLE_LAMP_SLOTS}];
  uniform float uMirrorFar, uPuddleWind;
  uniform vec4 uPuddleLook;
  #if PUDDLE_MIRROR
  uniform sampler2D uMirror;
  uniform mat4 uMirrorMatrix;
  uniform vec4 uMirrorClamp;
  uniform float uMirrorOn;
  #endif
  ${GLOSS_CAP_GLSL}
  float puddleHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float puddleNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(puddleHash(i), puddleHash(i + vec2(1.0, 0.0)), u.x), mix(puddleHash(i + vec2(0.0, 1.0)), puddleHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // One layer of drop rings: each cell of the grid catches a drop at a fresh random spot every
  // cycle, if its roll beats the chance. Returns the water's slope (a height gradient, world xz).
  vec2 puddleDrops(vec2 p, float t, float cell, float rate, float chance, float seed) {
    vec2 q = p / cell + seed;
    vec2 id = floor(q);
    float h = puddleHash(id + seed * 7.0);
    float tt = t * rate + h;
    float cyc = floor(tt);
    float ph = fract(tt);
    if (puddleHash(id + cyc * 0.731 + seed) > chance) return vec2(0.0);
    vec2 c = 0.3 + 0.4 * vec2(puddleHash(id + cyc * 1.37), puddleHash(id.yx + cyc * 2.11 + 4.0));
    vec2 d = fract(q) - c;
    float r = length(d);
    // A short train of rings running out from the drop, flattening as it spreads.
    float x = r - ph * 0.3;
    float env = (1.0 - ph) * (1.0 - ph) * exp(-x * x * 900.0);
    return (r > 1e-3 ? d / r : vec2(0.0)) * cos(x * 120.0) * env * 2.4;
  }
  // Rain rings (three grids, denser and livelier the harder it rains) or, once the rain stops,
  // a drip now and then.
  vec2 puddleRings(vec2 p, float t, float rain) {
    vec2 g = puddleDrops(p, t, 0.9, 0.32, 0.07, 0.0);
    if (rain > 0.02) {
      float k = smoothstep(0.02, 0.6, rain);
      g += puddleDrops(p, t, 0.34, 1.25, mix(0.25, 0.95, rain), 1.7) * k;
      g += puddleDrops(p, t, 0.47, 1.0, mix(0.2, 0.9, rain), 3.1) * k;
      g += puddleDrops(p, t, 0.61, 0.8, mix(0.15, 0.8, rain), 5.3) * k;
    }
    return g;
  }
  // Wind ruffles: a few short wavelets travelling with the wind, in gusty patches.
  vec2 puddleWind(vec2 p, float t) {
    float gust = puddleNoise(p * 0.7 - uWxWind * t * 0.4);
    float s = (clamp(length(uWxWind) * 0.35, 0.0, 1.0) * uPuddleWind + 0.006) * (0.25 + 1.5 * gust * gust);
    vec2 wd = length(uWxWind) > 1e-3 ? normalize(uWxWind) : vec2(1.0, 0.0);
    vec2 d1 = wd, d2 = vec2(wd.y, -wd.x) * 0.6 + wd * 0.8, d3 = vec2(-wd.y, wd.x) * 0.5 + wd * 0.87;
    return d1 * cos(dot(p, d1) * 9.0 - t * 2.3) * s
      + d2 * cos(dot(p, d2) * 15.0 - t * 3.1 + 1.3) * s * 0.6
      + d3 * cos(dot(p, d3) * 23.0 - t * 4.2 + 4.1) * s * 0.35;
  }
  #if PUDDLE_MIRROR
  vec3 puddleMirror(vec3 at) {
    vec4 c = uMirrorMatrix * vec4(at, 1.0);
    return texture2D(uMirror, clamp(c.xy / c.w, uMirrorClamp.xy, uMirrorClamp.zw)).rgb;
  }
  #endif
`;

/** Replaces opaque_fragment: what the water adds (rgb) and how much of the road it hides (alpha). */
const PUDDLE_COMPOSE = /* glsl */ `
  {
    vec3 wN = normalize((vec4(normal, 0.0) * viewMatrix).xyz);
    vec3 pv = cameraPosition - vPuddleWorld;
    float pDist = length(pv);
    pv /= pDist;
    float nv = max(dot(wN, pv), 1e-3);
    float fr = F_Schlick(vec3(0.02), 1.0, nv).x;
    // The mirror a little stronger than clean water's 2% head-on: dark night water reads as glass.
    float frRefl = F_Schlick(vec3(uPuddleLook.x), 1.0, nv).x;
    // What the water mirrors: the street above it, or a sky gradient where there is no mirror.
    vec3 rd = reflect(-pv, wN);
    vec3 refl = uSkyRefl * mix(1.0, 0.3, smoothstep(0.05, 0.7, rd.y));
    // The haze glowing round each lamp, as the reflected ray passes it: single scattering from a
    // point light, integrated in closed form along the first 25 m of the ray. The mirror draws no
    // volumetric fog, so without this the lamps' glow would be missing from the water.
    vec3 halo = vec3(0.0);
    #ifdef FOG_EXP2
    for (int k = 0; k < 4; k++) {
      float fi = vLamps[k];
      if (fi < -0.5) break;
      int i = int(fi + 0.5);
      vec3 o = uPLampPos[i].xyz - vPuddleWorld;
      float b = dot(o, rd);
      float hd = max(length(o - rd * b), 0.3);
      float along = (atan((25.0 - b) / hd) + atan(b / hd)) / hd;
      vec3 near = rd * clamp(b, 0.0, 25.0) - o;
      vec4 cn = uPLampCone[i];
      float cone = cn.x < -1.0 ? 1.0 : smoothstep(cn.x, cn.y, dot(normalize(near), uPLampDir[i].xyz));
      halo += uPLampCol[i].rgb * along * cone;
    }
    halo *= fogDensity * uPuddleLook.y;
    #endif
    #if PUDDLE_MIRROR
    float mOn = uMirrorOn * (1.0 - smoothstep(uMirrorFar * 0.8, uMirrorFar, pDist));
    if (mOn > 0.0) {
      // Ripples bend the image: shift where it is read by the surface's tilt.
      vec3 at = vPuddleWorld + vec3(wN.x, 0.0, wN.z) * 0.5;
      vec3 m = puddleMirror(at);
      // Damp asphalt mirrors only a blur.
      float blur = 1.0 - pWater;
      if (blur > 0.02) {
        vec3 b = puddleMirror(at + vec3(0.14, 0.0, 0.05)) + puddleMirror(at + vec3(-0.05, 0.0, 0.14))
          + puddleMirror(at + vec3(-0.14, 0.0, -0.05)) + puddleMirror(at + vec3(0.05, 0.0, -0.14));
        m = mix(m, (m + b) * 0.2, blur);
      }
      refl = mix(refl, m, mOn);
    }
    #endif
    refl += halo;
    vec3 spec = reflectedLight.directSpecular;
    // The street lamps this puddle sees: GGX glints widened by the bulb's size.
    for (int k = 0; k < 4; k++) {
      float fi = vLamps[k];
      if (fi < -0.5) break;
      int i = int(fi + 0.5);
      // Realtime lights glint through the material's own lighting.
      if (uPLampCone[i].z > 0.5) continue;
      vec3 lv = uPLampPos[i].xyz - vPuddleWorld;
      float d = max(length(lv), 1e-3);
      vec3 l = lv / d;
      float nl = max(dot(wN, l), 0.0);
      vec3 hv = l + pv;
      vec3 h = dot(hv, hv) > 1e-8 ? normalize(hv) : wN;
      float a = clamp(pow2(material.roughness) + 0.14 / d, 0.002, 1.0);
      float sp = D_GGX(a, max(dot(wN, h), 0.0)) * V_GGX_SmithCorrelated(a, nl, nv) * nl;
      vec3 f = F_Schlick(vec3(0.02), 1.0, max(dot(pv, h), 0.0));
      vec4 cn = uPLampCone[i];
      float cone = cn.x < -1.0 ? 1.0 : smoothstep(cn.x, cn.y, dot(-l, uPLampDir[i].xyz));
      float w = pow2(saturate(1.0 - pow4(d / uPLampPos[i].w)));
      spec += min(uPLampCol[i].rgb * f * (sp * cone * w / pow(max(d, 0.5), uPLampCol[i].w)), vec3(64.0));
    }
    vec3 add = (refl * frRefl * mix(0.35, 1.0, pWater) + spec) * pCover;
    // Mirror-bright, but under the soft ceiling every wet highlight keeps (GlossCap): lamps glint
    // without the bloom smearing them across the street.
    add = glossCap(add);
    // How much of the road's light gets through: the water's surface reflects some away (Fresnel)
    // and the water darkens what lies under it, more where deeper. Damp asphalt darkens a little,
    // less when the rain has already soaked the road.
    float tWater = (1.0 - frRefl) * mix(uPuddleLook.z, uPuddleLook.w, pDepth);
    float tDamp = 1.0 - 0.3 * (1.0 - 0.65 * uWetness);
    float through = mix(1.0, mix(tDamp, tWater, pWater), pCover);
    gl_FragColor = vec4(add, 1.0 - through);
  }
`;
