import * as THREE from 'three';
import { lightOwner, type MapDefinition } from '@dead-hours/shared';
import { worldPieces } from '../environment/WorldPieces';
import type { BakeTracer } from './BakeTracer';
import { LIVE_FOG_LIGHTS, type FogLight } from '../rendering/SceneFX';
import type { WetLamp } from './WetShader';

/** Static lamps scatter this much in the fog relative to their candela (tuned by eye). */
const STATIC_SCALE = 1;
/** Box around a lamp: rays to the nearest wall on each axis, padded. */
const AXES: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

interface Live {
  light: THREE.PointLight | THREE.SpotLight;
  fog: FogLight;
}

/** Seconds a lamp takes to fade into or out of the fog when it gains or loses its slot. */
const FADE = 0.6;
/** A lamp already in the fog keeps its slot until a rival is this much brighter at the camera. */
const HOLD = 1.4;
/** A camera jump longer than this (respawn, cut) settles the lamps at once instead of fading. */
const CUT = 8;

/**
 * Feeds the volumetric fog its lights each frame: the map's baked lamps (each confined to the box of
 * walls around it, so a lamp in a room never glows through to the street) and every live point or
 * spot light in the scene with some intensity: the flickering streetlight, muzzle flashes, the
 * helicopter searchlight, flares, police lights, fires and the flashlight. Live lights are found by
 * a scene scan twice a second, so systems that add their own lights need no registration.
 *
 * The fog only takes the brightest few lamps, and which few changes as the camera moves. A lamp
 * that simply dropped off that list would lose its glow from one frame to the next (and two lamps
 * near a tie would trade places back and forth), so lamps own their slots: a lamp keeps its slot
 * until a rival is clearly brighter, fades out over FADE seconds when it loses it, and only then
 * hands the slot to the next lamp, which fades in. Live lights get slots of their own (LIVE_FOG_LIGHTS),
 * so a muzzle flash never pushes a lamp out of the fog.
 */
export class FogLights {
  private readonly statics: FogLight[] = [];
  private readonly power: number[] = [];
  /** Per static lamp: the structure it goes out with (see worldPieces.fallen). */
  private readonly owner: (string | null)[] = [];
  /** Per static lamp: how far it has faded into the fog (0..1), and whether it owns a slot. */
  private readonly weight: Float32Array;
  private readonly holds: Uint8Array;
  private readonly wanted: Uint8Array;
  /** Static lamps that own a slot. */
  private readonly held: number[] = [];
  /** Outdoor static lamps, for wet reflections and rain glints. */
  readonly outdoor: WetLamp[] = [];
  private live: Live[] = [];
  private scanIn = 0;
  private readonly ranked: { i: number; score: number }[] = [];
  private readonly liveRanked: { l: FogLight; score: number }[] = [];
  /** What the fog is handed for each slot lamp: the lamp with its color scaled by its fade. */
  private readonly shown: FogLight[] = [];
  private readonly lastCam = new THREE.Vector3();
  private placed = false;
  private readonly tmp = new THREE.Vector3();

  constructor(map: MapDefinition, tracer: BakeTracer) {
    for (const l of map.lights) {
      const pos = new THREE.Vector3(l.x, l.y, l.z);
      const box = new THREE.Box3(pos.clone(), pos.clone());
      for (const [dx, dy, dz] of AXES) {
        const reach = tracer.intersect(l.x, l.y, l.z, dx, dy, dz, l.range, 0.02) ? tracer.hit.t + 0.15 : l.range;
        box.expandByPoint(this.tmp.set(l.x + dx * reach, l.y + dy * reach, l.z + dz * reach));
      }
      const dir = new THREE.Vector3(0, -1, 0);
      let cosOuter = -2, cosInner = -2;
      if (l.kind === 'spot') {
        dir.set((l.tx ?? l.x) - l.x, (l.ty ?? 0) - l.y, (l.tz ?? l.z) - l.z).normalize();
        const angle = l.angle ?? Math.PI / 3;
        cosOuter = Math.cos(angle);
        cosInner = Math.cos(angle * (1 - (l.penumbra ?? 0)));
      }
      const color = new THREE.Color(l.color).multiplyScalar(l.intensity * STATIC_SCALE);
      this.statics.push({ pos, range: l.range, color, decay: l.decay ?? 2, dir, cosOuter, cosInner, box });
      this.power.push(color.r + color.g + color.b);
      this.owner.push(lightOwner(map, l));
      // Outdoors when nothing is overhead: those lamps reflect in wet streets.
      if (!tracer.occluded(l.x, l.y + 0.3, l.z, 0, 1, 0, 60)) {
        this.outdoor.push({ pos, color: new THREE.Color(l.color).multiplyScalar(l.intensity), range: l.range, decay: l.decay ?? 2, dir, cosOuter });
      }
    }
    const n = this.statics.length;
    this.weight = new Float32Array(n);
    this.holds = new Uint8Array(n);
    this.wanted = new Uint8Array(n);
  }

  private scan(scene: THREE.Scene): void {
    const found = new Map<THREE.Object3D, Live>();
    for (const e of this.live) found.set(e.light, e);
    const next: Live[] = [];
    scene.traverse((o) => {
      const l = o as THREE.PointLight | THREE.SpotLight;
      if (!(l as THREE.PointLight).isPointLight && !(l as THREE.SpotLight).isSpotLight) return;
      if (l.userData.noFog) return;
      next.push(found.get(l) ?? {
        light: l,
        fog: { pos: new THREE.Vector3(), range: 10, color: new THREE.Color(), decay: 2, dir: new THREE.Vector3(0, -1, 0), cosOuter: -2, cosInner: -2, box: null },
      });
    });
    this.live = next;
  }

  /** Brightness of a light at the camera, for ranking; 0 when it is too far to reach the fog. */
  private score(f: FogLight, power: number, cam: THREE.Vector3): number {
    const d = Math.max(f.pos.distanceTo(cam) - f.range * 0.5, 0.5);
    return d > 48 + f.range ? 0 : power / (d * d);
  }

  /**
   * Writes the fog's lights into `out`: up to `lamps` static lamps (fading in and out of their
   * slots) followed by up to `live` live lights.
   */
  update(dt: number, scene: THREE.Scene, cam: THREE.Vector3, out: FogLight[], lamps: number, live = LIVE_FOG_LIGHTS): void {
    this.scanIn -= dt;
    if (this.scanIn <= 0) {
      this.scanIn = 0.5;
      this.scan(scene);
    }
    const cut = !this.placed || this.lastCam.distanceTo(cam) > CUT;
    this.placed = true;
    this.lastCam.copy(cam);
    const step = cut ? 1 : dt / FADE;

    // Static lamps: the brightest `lamps` (holders get the HOLD edge) are wanted.
    this.ranked.length = 0;
    const fallen = worldPieces.fallen;
    for (let i = 0; i < this.statics.length; i++) {
      // A lamp whose building has come down is out: it loses its slot and fades.
      if (fallen.size && this.owner[i] !== null && fallen.has(this.owner[i]!)) continue;
      let s = this.score(this.statics[i], this.power[i], cam);
      if (s <= 0) continue;
      if (this.holds[i]) s *= HOLD;
      this.ranked.push({ i, score: s });
    }
    this.ranked.sort((a, b) => b.score - a.score);
    this.wanted.fill(0);
    for (let k = 0; k < Math.min(lamps, this.ranked.length); k++) this.wanted[this.ranked[k].i] = 1;
    // Holders fade toward wanted or not; one that fades out gives its slot up.
    for (let k = this.held.length - 1; k >= 0; k--) {
      const i = this.held[k];
      if (this.wanted[i]) {
        this.weight[i] = Math.min(1, this.weight[i] + step);
      } else {
        this.weight[i] -= step;
        if (this.weight[i] <= 0) {
          this.weight[i] = 0;
          this.holds[i] = 0;
          this.held.splice(k, 1);
        }
      }
    }
    // Free slots go to the brightest wanted lamps without one.
    for (const r of this.ranked) {
      if (this.held.length >= lamps) break;
      if (!this.wanted[r.i] || this.holds[r.i]) continue;
      this.holds[r.i] = 1;
      this.weight[r.i] = Math.min(1, step);
      this.held.push(r.i);
    }

    out.length = 0;
    for (let k = 0; k < this.held.length; k++) {
      const f = this.statics[this.held[k]];
      const w = this.weight[this.held[k]];
      const o = this.shown[k] ?? (this.shown[k] = { ...f, color: new THREE.Color() });
      o.pos = f.pos;
      o.range = f.range;
      o.decay = f.decay;
      o.dir = f.dir;
      o.cosOuter = f.cosOuter;
      o.cosInner = f.cosInner;
      o.box = f.box;
      o.color.copy(f.color).multiplyScalar(w * w * (3 - 2 * w));
      out.push(o);
    }

    // Live lights: their own slots, at their own (animated) intensity.
    this.liveRanked.length = 0;
    for (const e of this.live) {
      const l = e.light;
      if (l.intensity <= 0.01 || !l.visible || !l.parent) continue;
      const f = e.fog;
      l.getWorldPosition(f.pos);
      f.range = l.distance > 0 ? l.distance : 20;
      f.decay = l.decay;
      const k = (l.userData.fogScale as number | undefined) ?? 1;
      f.color.copy(l.color).multiplyScalar(l.intensity * k);
      if ((l as THREE.SpotLight).isSpotLight) {
        const s = l as THREE.SpotLight;
        s.target.getWorldPosition(this.tmp);
        f.dir.subVectors(this.tmp, f.pos).normalize();
        f.cosOuter = Math.cos(s.angle);
        f.cosInner = Math.cos(s.angle * (1 - s.penumbra));
      } else {
        f.cosOuter = f.cosInner = -2;
      }
      const s = this.score(f, f.color.r + f.color.g + f.color.b, cam);
      if (s > 0) this.liveRanked.push({ l: f, score: s });
    }
    this.liveRanked.sort((a, b) => b.score - a.score);
    for (let k = 0; k < Math.min(live, this.liveRanked.length); k++) out.push(this.liveRanked[k].l);
  }
}
