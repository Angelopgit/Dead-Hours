import * as THREE from 'three';
import type { MapDefinition } from '@dead-hours/shared';
import type { BakeTracer } from './BakeTracer';
import type { FogLight } from '../rendering/SceneFX';
import type { WetLamp } from './WetShader';

/** Static lamps scatter this much in the fog relative to their candela (tuned by eye). */
const STATIC_SCALE = 1;
/** Box around a lamp: rays to the nearest wall on each axis, padded. */
const AXES: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

interface Live {
  light: THREE.PointLight | THREE.SpotLight;
  fog: FogLight;
}

/**
 * Feeds the volumetric fog its lights each frame: the map's baked lamps (each confined to the box of
 * walls around it, so a lamp in a room never glows through to the street) and every live point or
 * spot light in the scene with some intensity: the flickering streetlight, muzzle flashes, the
 * helicopter searchlight, flares, police lights, fires and the flashlight. Live lights are found by
 * a scene scan twice a second, so systems that add their own lights need no registration.
 */
export class FogLights {
  private readonly statics: FogLight[] = [];
  /** Outdoor static lamps, for wet reflections and rain glints. */
  readonly outdoor: WetLamp[] = [];
  private live: Live[] = [];
  private scanIn = 0;
  private readonly ranked: { l: FogLight; score: number }[] = [];
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
      // Outdoors when nothing is overhead: those lamps reflect in wet streets.
      if (!tracer.occluded(l.x, l.y + 0.3, l.z, 0, 1, 0, 60)) {
        this.outdoor.push({ pos, color: new THREE.Color(l.color).multiplyScalar(l.intensity), range: l.range, decay: l.decay ?? 2, dir, cosOuter });
      }
    }
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

  /** Ranks every light by its brightness at the camera and writes the strongest into `out`. */
  update(dt: number, scene: THREE.Scene, cam: THREE.Vector3, out: FogLight[], max: number): void {
    this.scanIn -= dt;
    if (this.scanIn <= 0) {
      this.scanIn = 0.5;
      this.scan(scene);
    }
    this.ranked.length = 0;
    const consider = (f: FogLight, power: number) => {
      const d = Math.max(f.pos.distanceTo(cam) - f.range * 0.5, 0.5);
      if (d > 48 + f.range) return;
      this.ranked.push({ l: f, score: power / (d * d) });
    };
    for (const f of this.statics) consider(f, f.color.r + f.color.g + f.color.b);
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
      // Live lights are few and usually what the player is looking at: weight them up.
      consider(f, (f.color.r + f.color.g + f.color.b) * 2);
    }
    this.ranked.sort((a, b) => b.score - a.score);
    out.length = 0;
    for (let i = 0; i < Math.min(max, this.ranked.length); i++) out.push(this.ranked[i].l);
  }
}
