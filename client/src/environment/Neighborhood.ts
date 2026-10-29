import * as THREE from 'three';
import { subtractRects, type MapDefinition } from '@dead-hours/shared';
import { MaterialLibrary } from '../rendering/Materials';
import { StaticBatcher } from '../rendering/StaticBatcher';
import { worldBox } from '../rendering/GeometryUtils';
import { BAKE_CELL, dressHouses } from './Houses';
import { PropFactory, pineCrown, type PropBuildResult, type Updatable } from './Props';
import { Sky } from './Sky';
import { Atmosphere } from './Atmosphere';
import { Lighting } from '../lighting/Lighting';
import { LightField } from '../lighting/LightField';
import { LightBaker, type BakeProgress } from '../lighting/LightBaker';
import { bakeUniforms, patchBaked } from '../lighting/BakeShader';
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
  field: LightField | null = null;
  private readonly propFactory: PropFactory;
  private readonly dynamic: Updatable[] = [];
  private readonly fog: THREE.FogExp2;
  private readonly staticMeshes: THREE.Mesh[];
  private envMap: THREE.Texture | null = null;

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
      batch.add(worldBox(s.x, s.y, s.z, s.w, s.h, s.d, e.texScale, ao, BAKE_CELL), e.material, s.h > 0.2, true);
    }
    this.buildRoadMarkings(batch);
    dressHouses(map, this.lib, batch);
    this.propFactory = new PropFactory(this.lib);
    this.props = this.propFactory.build(map, this.root, batch);
    this.dynamic.push(...this.props.dynamic);
    this.buildFixtures(batch);
    this.staticMeshes = batch.build(this.root, 'map');
    this.buildForest();
    this.root.add(this.atmosphere.group);
  }

  /** Bakes (or loads cached) static lighting and switches static materials over to it. */
  async bakeLighting(onProgress: BakeProgress): Promise<LightField> {
    const field = new LightField(this.map);
    const baker = new LightBaker(field, this.map);
    const ground = await baker.bake(this.staticMeshes, onProgress);
    bakeUniforms.uGroundBake.value = ground;
    for (const m of this.staticMeshes) patchBaked(m.material as THREE.Material);
    this.field = field;
    return field;
  }

  /** A small night-sky environment for reflective materials (glass, car paint, puddles). */
  buildEnvironment(renderer: THREE.WebGLRenderer): void {
    const env = new THREE.Scene();
    const skyGeo = new THREE.SphereGeometry(50, 32, 16);
    const colors: number[] = [];
    const pos = skyGeo.getAttribute('position') as THREE.BufferAttribute;
    const top = new THREE.Color(0x121823), horizon = new THREE.Color(0x262d3b), below = new THREE.Color(0x0a0b0d);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 50;
      if (y >= 0) c.copy(horizon).lerp(top, Math.pow(y, 0.6));
      else c.copy(horizon).lerp(below, Math.min(1, -y * 4));
      colors.push(c.r, c.g, c.b);
    }
    skyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    env.add(new THREE.Mesh(skyGeo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    // Warm streetlight glints and a pale moon.
    const glint = (x: number, y: number, z: number, r: number, color: number, k: number) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) }));
      m.position.set(x, y, z);
      env.add(m);
    };
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      glint(Math.cos(a) * 40, 6 + (i % 3), Math.sin(a) * 40, 1.6, 0xffb36b, 6);
    }
    glint(-28, 22, 20, 3, 0xc8d8f0, 4);
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.envMap = pmrem.fromScene(env, 0.02).texture;
    pmrem.dispose();
    env.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });
    const apply = (o: THREE.Object3D) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (m.userData.envMap && m instanceof THREE.MeshStandardMaterial && m.envMap !== this.envMap) {
          m.envMap = this.envMap;
          m.needsUpdate = true;
        }
      }
    };
    this.scene.traverse(apply);
  }

  private buildGround(batch: StaticBatcher): void {
    // Lawn planes with vertex-color variation (patchy dead grass; forest floor in the woods), open over basements.
    const half = this.map.halfExtent + 60;
    const grass = this.lib.get('grass');
    for (const r of subtractRects({ x0: -half, x1: half, z0: -half, z1: half }, this.map.excavations)) {
      const w = r.x1 - r.x0, d = r.z1 - r.z0;
      const g = new THREE.PlaneGeometry(w, d, Math.max(1, Math.round(w / 3.5)), Math.max(1, Math.round(d / 3.5)));
      g.rotateX(-Math.PI / 2);
      g.translate((r.x0 + r.x1) / 2, 0, (r.z0 + r.z1) / 2);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const z = pos.getZ(i);
        uv.setXY(i, x / grass.texScale, z / grass.texScale);
        const n = Math.sin(x * 0.11) * Math.cos(z * 0.13) + Math.sin(x * 0.031 + z * 0.047) * 0.8;
        const dry = THREE.MathUtils.smoothstep(n, 0.2, 1.2);
        const v = 0.85 + n * 0.12;
        const woods = Math.max(
          THREE.MathUtils.smoothstep(Math.abs(z), 50, 60),
          THREE.MathUtils.smoothstep(Math.abs(x), 113, 121),
        );
        const r0 = v * (1 + dry * 0.35), g0 = v * (1 + dry * 0.12), b0 = v * (1 - dry * 0.1);
        colors[i * 3] = THREE.MathUtils.lerp(r0, 0.95 + n * 0.1, woods);
        colors[i * 3 + 1] = THREE.MathUtils.lerp(g0, 0.62, woods);
        colors[i * 3 + 2] = THREE.MathUtils.lerp(b0, 0.5, woods);
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      batch.add(g, grass.material, false, true);
    }
  }

  private buildRoadMarkings(batch: StaticBatcher): void {
    const paint = this.lib.custom('road-paint', () => new THREE.MeshStandardMaterial({
      color: 0x8c8360, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, vertexColors: true,
    }));
    const white = this.lib.custom('road-paint-white', () => new THREE.MeshStandardMaterial({
      color: 0x8a8a86, roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -2, vertexColors: true,
    }));
    const birch = -68;
    const inIntersection = (x: number) => x > birch - 8 && x < birch + 8;
    for (let x = -150; x < 150; x += 6) {
      if ((x * 13) % 7 === 0 || inIntersection(x + 1.5)) continue; // worn-off segments
      batch.add(worldBox(x + 1.5, 0.022, 0, 3, 0.004, 0.14, 1, null), paint, false);
    }
    for (let z = -150; z < 150; z += 6) {
      if ((z * 11) % 7 === 0 || Math.abs(z + 1.5) < 8) continue;
      batch.add(worldBox(birch, 0.022, z + 1.5, 0.14, 0.004, 3, 1, null), paint, false);
    }
    // Stop lines and crosswalks at the Birch Lane intersection.
    batch.add(worldBox(birch + 2.25, 0.022, -5.6, 4.3, 0.004, 0.35, 1, null), white, false);
    batch.add(worldBox(birch - 2.25, 0.022, 5.6, 4.3, 0.004, 0.35, 1, null), white, false);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        batch.add(worldBox(birch + side * 6.2, 0.022, -4 + i, 1.6, 0.004, 0.5, 1, null), white, false);
        batch.add(worldBox(birch - 4 + i, 0.022, side * 6.2, 0.5, 0.004, 1.6, 1, null), white, false);
      }
    }
  }

  /** Visible emitters for baked lights (bulbs and panels; streetlights draw their own heads). */
  private buildFixtures(batch: StaticBatcher): void {
    const bulb = this.lib.emissive(0xffc27a, 6);
    const shade = this.lib.standard(0x2a2622, 0.7, 0.2);
    const panel = this.lib.emissive(0xe6eeff, 5);
    bulb.userData.noBake = panel.userData.noBake = true;
    for (const l of this.map.lights) {
      if (l.fixture === 'bulb') {
        const g = new THREE.SphereGeometry(0.07, 8, 6);
        g.translate(l.x, l.y + 0.06, l.z);
        batch.add(g, bulb, false, false);
        const s = new THREE.CylinderGeometry(0.12, 0.26, 0.16, 10, 1, true);
        s.translate(l.x, l.y + 0.17, l.z);
        batch.add(s, shade, false, false);
        const cord = new THREE.CylinderGeometry(0.01, 0.01, 0.12, 4);
        cord.translate(l.x, l.y + 0.3, l.z);
        batch.add(cord, shade, false, false);
      } else if (l.fixture === 'panel') {
        batch.add(worldBox(l.x, l.y + 0.03, l.z, 1.1, 0.04, 0.34, 1, null), panel, false, false);
      }
    }
  }

  /** The woods: one instanced draw for trunks and one for crowns, with per-instance sway phase. */
  private buildForest(): void {
    const trees = this.map.props.filter((p) => p.forest);
    if (!trees.length) return;
    const crowns = pineCrown(1).map(([g, y]) => g.translate(0, y, 0));
    const crown = mergeAll(crowns);
    const trunk = new THREE.CylinderGeometry(0.12, 0.22, 2.4, 6).translate(0, 1.2, 0);
    const pineMat = this.lib.custom('pine-forest', () => new THREE.MeshStandardMaterial({ color: 0x1b271d, roughness: 0.95, flatShading: true }));
    this.propFactory.sway(pineMat, true);
    const trunkMat = this.lib.custom('trunk-forest', () => new THREE.MeshStandardMaterial({ color: 0x2b231c, roughness: 0.95, flatShading: true }));
    const a = new THREE.InstancedMesh(crown, pineMat, trees.length);
    const b = new THREE.InstancedMesh(trunk, trunkMat, trees.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    trees.forEach((p, i) => {
      const k = 0.85 + ((p.variant ?? 0) % 6) * 0.09;
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rotY);
      s.set(k, k * (0.9 + ((i * 7) % 5) * 0.06), k);
      m.compose(new THREE.Vector3(p.x, 0, p.z), q, s);
      a.setMatrixAt(i, m);
      b.setMatrixAt(i, m);
    });
    for (const im of [a, b]) {
      im.castShadow = true;
      im.receiveShadow = true;
      im.computeBoundingSphere();
      this.root.add(im);
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
    this.envMap?.dispose();
  }
}

function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const g of parts) count += g.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.getAttribute('position').array as Float32Array, o * 3);
    nor.set(g.getAttribute('normal').array as Float32Array, o * 3);
    o += g.getAttribute('position').count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}
