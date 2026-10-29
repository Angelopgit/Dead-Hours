import * as THREE from 'three';
import type { MapDefinition } from '@dead-hours/shared';
import { MaterialLibrary } from '../rendering/Materials';
import { StaticBatcher } from '../rendering/StaticBatcher';
import { worldBox } from '../rendering/GeometryUtils';
import { dressHouses } from './Houses';
import { PropFactory, type PropBuildResult, type Updatable } from './Props';
import { Sky } from './Sky';
import { Atmosphere } from './Atmosphere';
import { Lighting } from '../lighting/Lighting';
import { settings, type Quality } from '../core/Settings';

const FOG_DENSITY: Record<Quality, number> = { low: 0.017, medium: 0.02, high: 0.022 };
export const FOG_COLOR = 0x252e3c;

/** Builds and owns everything visual about the map: static batches, props, sky, fog, lights. */
export class Neighborhood {
  readonly root = new THREE.Group();
  readonly lib: MaterialLibrary;
  readonly sky = new Sky();
  readonly atmosphere = new Atmosphere();
  readonly lighting: Lighting;
  readonly props: PropBuildResult;
  private readonly propFactory: PropFactory;
  private readonly dynamic: Updatable[] = [];
  private readonly fog: THREE.FogExp2;

  constructor(readonly map: MapDefinition, private readonly scene: THREE.Scene, anisotropy: number) {
    const texSize = { low: 256, medium: 512, high: 1024 }[settings.value.graphics.textureQuality];
    this.lib = new MaterialLibrary(texSize, anisotropy);
    this.root.name = 'neighborhood';
    scene.add(this.root);

    this.fog = new THREE.FogExp2(FOG_COLOR, FOG_DENSITY[settings.value.graphics.fogQuality]);
    scene.fog = this.fog;
    scene.background = new THREE.Color(FOG_COLOR);
    scene.add(this.sky.mesh);
    this.lighting = new Lighting(scene);
    this.lighting.onThunder = null;

    const batch = new StaticBatcher();
    this.buildGround(batch);
    for (const s of map.solids) {
      if (s.visible === false || s.mat === 'invisible') continue;
      const e = this.lib.get(s.mat);
      const ao = s.h > 0.5 ? { groundY: s.y - s.h / 2, strength: 0.4 } : null;
      batch.add(worldBox(s.x, s.y, s.z, s.w, s.h, s.d, e.texScale, ao), e.material, s.h > 0.2, true);
    }
    this.buildRoadMarkings(batch);
    dressHouses(map, this.lib, batch);
    this.propFactory = new PropFactory(this.lib);
    this.props = this.propFactory.build(map, this.root, batch);
    this.dynamic.push(...this.props.dynamic);
    batch.build(this.root, 'map');
    this.addInteriorLights();
    this.root.add(this.atmosphere.group);
  }

  private buildGround(batch: StaticBatcher): void {
    // Subdivided lawn plane with vertex-color variation (patchy dead grass, darker under trees).
    const size = this.map.halfExtent * 2 + 120;
    const seg = 96;
    const g = new THREE.PlaneGeometry(size, size, seg, seg);
    g.rotateX(-Math.PI / 2);
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const grassScale = this.lib.get('grass').texScale;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      uv.setXY(i, x / grassScale, z / grassScale);
      const n = Math.sin(x * 0.11) * Math.cos(z * 0.13) + Math.sin(x * 0.031 + z * 0.047) * 0.8;
      const dry = THREE.MathUtils.smoothstep(n, 0.2, 1.2);
      const v = 0.85 + n * 0.12;
      colors[i * 3] = v * (1 + dry * 0.35);
      colors[i * 3 + 1] = v * (1 + dry * 0.12);
      colors[i * 3 + 2] = v * (1 - dry * 0.1);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    batch.add(g, this.lib.get('grass').material, false, true);
  }

  private buildRoadMarkings(batch: StaticBatcher): void {
    const paint = this.lib.custom('road-paint', () => new THREE.MeshStandardMaterial({
      color: 0x8c8360, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, vertexColors: true,
    }));
    const half = 120;
    for (let x = -half; x < half; x += 6) {
      if ((x * 13) % 7 === 0) continue; // worn-off segments
      batch.add(worldBox(x + 1.5, 0.022, 0, 3, 0.004, 0.14, 1, null), paint, false);
    }
  }

  private addInteriorLights(): void {
    // Warm practical lights inside enterable houses contrast with the cold exterior.
    const lamps: [number, number, number, number][] = [
      [3.2, 3.0, -20, 4.2], [-4.4, 3.0, -20.5, 3.4], [27, 3.0, -18.5, 3],
    ];
    const shade = this.lib.emissive(0xffb36b, 3.5);
    // Porch light over the safehouse front door.
    const porch = new THREE.PointLight(0xffb070, 3.2, 9, 1.8);
    porch.position.set(2.4, 2.75, -14.3);
    this.root.add(porch);
    const porchLamp = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.24, 0.12), this.lib.emissive(0xffc27a, 5));
    porchLamp.position.set(3.35, 2.45, -14.95);
    this.root.add(porchLamp);
    for (const [x, y, z, power] of lamps) {
      const l = new THREE.PointLight(0xffa35a, power, 11, 1.7);
      l.position.set(x, y, z);
      this.root.add(l);
      const bulb = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.12, 10), shade);
      bulb.position.set(x, 3.25, z);
      this.root.add(bulb);
    }
  }

  applySettings(renderer: THREE.WebGLRenderer, shadowSize: number, focus: THREE.Vector3): void {
    const g = settings.value.graphics;
    this.fog.density = FOG_DENSITY[g.fogQuality];
    this.lighting.setShadowSize(shadowSize, renderer);
    this.atmosphere.setQuality(g.particleQuality, focus);
    this.lib.setAnisotropy(g.textureQuality === 'low' ? 1 : g.textureQuality === 'medium' ? 4 : 8);
  }

  update(dt: number, t: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    this.sky.update(dt, camera.position);
    this.sky.uniforms.uFlash.value = this.lighting.flash * (settings.value.accessibility.reducedFlashing ? 0.2 : 1);
    this.lighting.update(dt);
    this.lighting.follow(focus);
    this.atmosphere.update(dt, t, focus);
    this.propFactory.foliageUniforms.uTime.value = t;
    this.propFactory.foliageUniforms.uWind.value = this.atmosphere.windStrength;
    for (const d of this.dynamic) d.update(dt, t);
  }

  dispose(): void {
    this.scene.remove(this.root, this.sky.mesh);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.sky.dispose();
    this.atmosphere.dispose();
    this.lib.dispose();
  }
}
