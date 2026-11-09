import * as THREE from 'three';
import { COURT, OAK, ownerAt, subtractRects, type LightSpec, type MapDefinition } from '@dead-hours/shared';
import { MaterialLibrary } from '../rendering/Materials';
import { StaticBatcher } from '../rendering/StaticBatcher';
import { worldBox } from '../rendering/GeometryUtils';
import { BAKE_CELL, dressHouses } from './Houses';
import { buildWaterTower } from './WaterTower';
import { PropFactory, type PropBuildResult, type Updatable } from './Props';
import { worldPieces } from './WorldPieces';
import { Trees, type TreeTier } from './trees/Trees';
import { Sky } from './Sky';
import { Atmosphere } from './Atmosphere';
import { Clutter } from './Clutter';
import { Lighting } from '../lighting/Lighting';
import { LightField } from '../lighting/LightField';
import { LightBaker, type BakeProgress } from '../lighting/LightBaker';
import { bakeUniforms, patchBaked } from '../lighting/BakeShader';
import { settings, type Quality } from '../core/Settings';
import { patchWet, setWetLamps, setWetLampBudget, setWetTier, updateWetLamps, weatherUniforms } from '../lighting/WetShader';
import { FogLights } from '../lighting/FogLights';
import { setLightConesVisible } from './LightCone';
import { Rain, buildCoverMap } from './Rain';
import { Snow } from './Snow';
import { HOLIDAY } from '../core/Holiday';
import { updateWeather, weather } from './Weather';
import { updateWind } from './Wind';
import { Grass } from './Grass';
import { groundNoise, woodsAt } from './Lawn';
import { Puddles, PUDDLE_Y } from './Puddles';
import { PlanarMirror } from '../rendering/PlanarMirror';
import { FOG_DENSITY } from './FogRange';

/**
 * Puddle reflections per quality: the share of the screen's resolution the mirror draws at, the
 * most pixels it may use, and how far away a puddle still gets one (past it, the sky gradient).
 */
const MIRROR: Record<'low' | 'high', { scale: number; maxPixels: number; far: number }> = {
  low: { scale: 0.33, maxPixels: 400 * 225, far: 40 },
  high: { scale: 0.5, maxPixels: 800 * 450, far: 60 },
};
export const FOG_COLOR = 0x252e3c;
/** Indoor surfaces the puddles' mirror leaves out (see the constructor). */
const NOT_MIRRORED = new Set(['interiorWall', 'interiorWallBlue', 'carpet', 'woodFloor', 'tile']);

/** Builds and owns everything visual about the map: static batches, props, sky, fog, lights. */
export class Neighborhood {
  readonly root = new THREE.Group();
  readonly lib: MaterialLibrary;
  readonly sky = new Sky();
  readonly atmosphere = new Atmosphere();
  readonly rain = new Rain();
  /** Christmas snow over the menu and the nights (only built in the holiday season). */
  readonly snow = HOLIDAY ? new Snow() : null;
  /** Wind-swayed lawn grass (merged blade tiles around the camera, swayed on the GPU). */
  readonly grass: Grass;
  /** Every tree and shrub (instanced, levels of detail, wind). */
  readonly trees: Trees;
  /** The ground-level mirror puddles reflect (drawn only while one is near and in view). */
  readonly mirror = new PlanarMirror(PUDDLE_Y);
  readonly puddles: Puddles;
  private readonly mirrorRect = new THREE.Vector4();
  /** Lights for the volumetric fog (set up with the bake). */
  fogLights: FogLights | null = null;
  readonly lighting: Lighting;
  readonly props: PropBuildResult;
  field: LightField | null = null;
  private readonly propFactory: PropFactory;
  private readonly dynamic: Updatable[] = [];
  private readonly fog: THREE.FogExp2;
  private readonly staticMeshes: THREE.Mesh[];
  private envMap: THREE.Texture | null = null;
  /** Litter, leaves, papers and glass pieces scattered at build time. */
  clutterCount = 0;

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
      // What a structure is built of is grouped by its owner, so it can be taken out when it falls.
      batch.begin(s.owner);
      batch.add(worldBox(s.x, s.y, s.z, s.w, s.h, s.d, e.texScale, ao, BAKE_CELL), e.material, s.h > 0.2, true);
    }
    batch.end();
    this.buildRoadMarkings(batch);
    dressHouses(map, this.lib, batch);
    batch.begin('water-tower');
    const tower = buildWaterTower(this.lib, batch, this.root);
    batch.end();
    this.dynamic.push(tower);
    this.propFactory = new PropFactory(this.lib);
    this.props = this.propFactory.build(map, this.root, batch);
    this.dynamic.push(...this.props.dynamic);
    this.buildFixtures(batch);
    // Fixed density: clutter is static geometry, and changing it would re-run the lighting bake.
    this.clutterCount = Clutter.build(map, this.lib, batch);
    this.staticMeshes = batch.build(this.root, 'map');
    worldPieces.groups = batch.groups;
    // After the static batches: grass draws after the houses, so the ones in front hide it cheaply.
    this.grass = new Grass(map);
    this.root.add(this.grass.root);
    this.trees = new Trees(map, treeTier(settings.value.graphics));
    this.root.add(this.trees.root);
    this.root.add(this.atmosphere.group);
    this.root.add(this.rain.mesh);
    if (this.snow) this.root.add(this.snow.mesh);
    this.puddles = new Puddles(map, this.mirror);
    if (this.puddles.mesh) this.root.add(this.puddles.mesh);
    // Left out of the reflection: the water itself, streaks and motes around the camera, flat
    // ground-level batches (roads, lawns, paint), which lie under the water anyway, and the grass
    // (the lawns stop short of every puddle, and its many blades would cost more than they show).
    const hidden = this.mirror.hidden;
    hidden.push(this.rain.mesh, this.atmosphere.group, this.grass.root);
    if (this.snow) hidden.push(this.snow.mesh);
    if (this.puddles.mesh) hidden.push(this.puddles.mesh);
    // Rooms (glimpsed through windows at best) and litter are left out too: each batch spans the
    // whole map, so whatever the mirror draws, it draws all of.
    for (const m of this.staticMeshes) {
      m.geometry.computeBoundingBox();
      const name = (m.material as THREE.Material).name;
      if (m.geometry.boundingBox!.max.y < PUDDLE_Y + 0.02 || NOT_MIRRORED.has(name) || name.startsWith('clutter-')) hidden.push(m);
    }
    weatherUniforms.uCover.value = buildCoverMap(map);
  }

  /** Bakes (or loads cached) static lighting and switches static materials over to it. */
  async bakeLighting(onProgress: BakeProgress): Promise<LightField> {
    const field = new LightField(this.map);
    const baker = new LightBaker(field, this.map);
    const ground = await baker.bake(this.staticMeshes, onProgress);
    bakeUniforms.uGroundBake.value = ground;
    bakeUniforms.uGroundRect.value.copy(baker.groundRect());
    for (const m of this.staticMeshes) patchBaked(m.material as THREE.Material);
    for (const m of this.staticMeshes) patchWet(m.material as THREE.Material);
    await this.trees.light(field, () => new Promise((r) => setTimeout(r, 0)));
    this.fogLights = new FogLights(this.map, field.tracer);
    setWetLamps(this.fogLights.outdoor);
    // Realtime map lights (flickering lamps, police strobes) glow in the puddles too.
    const live: THREE.Light[] = [];
    this.root.updateMatrixWorld(true);
    this.root.traverse((o) => { if ((o as THREE.Light).isLight) live.push(o as THREE.Light); });
    this.puddles.setLamps(this.map, field.tracer, live);
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
    // Only the moon: lamps reflect where they really are (see Puddles), so the sky holds no
    // stand-in lamp glints that would light up every puddle and windshield from nowhere.
    const glint = (x: number, y: number, z: number, r: number, color: number, k: number) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) }));
      m.position.set(x, y, z);
      env.add(m);
    };
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
    const b = this.map.bounds;
    const grass = this.lib.get('grass');
    const woodsOf = woodsAt(this.map);
    for (const r of subtractRects({ x0: b.x0 - 60, x1: b.x1 + 60, z0: b.z0 - 60, z1: b.z1 + 60 }, this.map.excavations)) {
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
        const n = groundNoise(x, z);
        const dry = THREE.MathUtils.smoothstep(n, 0.2, 1.2);
        const v = 0.85 + n * 0.12;
        // The forest floor: see woodsAt (the grass thins out the same way).
        const woods = woodsOf(x, z);
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
    const birch = OAK.birch;
    const inIntersection = (x: number) => x > birch - 8 && x < birch + 8;
    for (let x = -150; x < 150; x += 6) {
      if ((x * 13) % 7 === 0 || inIntersection(x + 1.5)) continue; // worn-off segments
      batch.add(worldBox(x + 1.5, 0.022, 0, 3, 0.004, 0.14, 1, null), paint, false);
    }
    // Pell Lane runs on past Kinney Street to the edge of the map.
    for (let z = -150; z < this.map.bounds.z1 + 25; z += 6) {
      if ((z * 11) % 7 === 0 || Math.abs(z + 1.5) < 8 || Math.abs(z + 1.5 - OAK.z) < 8 || Math.abs(z + 1.5 - COURT.z) < 8) continue;
      batch.add(worldBox(birch, 0.022, z + 1.5, 0.14, 0.004, 3, 1, null), paint, false);
    }
    // Kinney Street's centre line, from the junction to the dead end.
    for (let x = birch + 8; x < OAK.end - 4; x += 6) {
      if ((Math.round(x) * 17) % 7 === 0) continue;
      batch.add(worldBox(x + 1.5, 0.022, OAK.z, 3, 0.004, 0.14, 1, null), paint, false);
    }
    // Court Street's centre line, from the junction to the water tower's lot, and the parking lot's stalls.
    for (let x = birch + 8; x < COURT.end - 3; x += 6) {
      if ((Math.round(x) * 19) % 7 === 0) continue;
      batch.add(worldBox(x + 1.5, 0.022, COURT.z, 3, 0.004, 0.14, 1, null), paint, false);
    }
    const lot = COURT.parking;
    for (let x = lot.x0 + 4.5; x < lot.x1 - 1; x += 3) {
      if (Math.abs(x - COURT.pathX) < 2 || (Math.round(x) * 5) % 11 === 0) continue;
      batch.add(worldBox(x, 0.026, lot.z1 - 2.6, 0.12, 0.004, 5, 1, null), white, false);
    }
    batch.add(worldBox(birch + 7.4, 0.022, COURT.z + 2.25, 0.35, 0.004, 4.3, 1, null), white, false);
    for (let i = 0; i < 9; i++) {
      batch.add(worldBox(birch + 6.2, 0.022, COURT.z - 4 + i, 1.6, 0.004, 0.5, 1, null), white, false);
      for (const side of [-1, 1]) batch.add(worldBox(birch - 4 + i, 0.022, COURT.z + side * 6.2, 0.5, 0.004, 1.6, 1, null), white, false);
    }
    // Stop lines and crosswalks at the Pell Lane intersection.
    batch.add(worldBox(birch + 2.25, 0.022, -5.6, 4.3, 0.004, 0.35, 1, null), white, false);
    batch.add(worldBox(birch - 2.25, 0.022, 5.6, 4.3, 0.004, 0.35, 1, null), white, false);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        batch.add(worldBox(birch + side * 6.2, 0.022, -4 + i, 1.6, 0.004, 0.5, 1, null), white, false);
        batch.add(worldBox(birch - 4 + i, 0.022, side * 6.2, 0.5, 0.004, 1.6, 1, null), white, false);
      }
    }
    // Kinney Street's T-junction: a stop line behind a crosswalk on Kinney, crosswalks over Pell either side.
    batch.add(worldBox(birch + 7.4, 0.022, OAK.z - 2.25, 0.35, 0.004, 4.3, 1, null), white, false);
    for (let i = 0; i < 9; i++) {
      batch.add(worldBox(birch + 6.2, 0.022, OAK.z - 4 + i, 1.6, 0.004, 0.5, 1, null), white, false);
      for (const side of [-1, 1]) batch.add(worldBox(birch - 4 + i, 0.022, OAK.z + side * 6.2, 0.5, 0.004, 1.6, 1, null), white, false);
    }
  }

  /** Visible emitters for baked lights (bulbs and panels; streetlights draw their own heads). */
  private buildFixtures(batch: StaticBatcher): void {
    const bulb = this.lib.emissive(0xffc27a, 6);
    const shade = this.lib.standard(0x2a2622, 0.7, 0.2);
    const panel = this.lib.emissive(0xe6eeff, 5);
    bulb.userData.noBake = panel.userData.noBake = true;
    for (const l of this.map.lights) {
      if (l.flicker) {
        this.buildFlicker(l);
        continue;
      }
      batch.begin(ownerAt(this.map, l.x, l.z));
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
    batch.end();
  }

  /**
   * A failing fixture: its emitter and a realtime light (no shadows, short range) stutter together,
   * with long steady stretches between bursts. The light is always in the scene (intensity changes
   * only), so no shader recompiles while it flickers.
   */
  private buildFlicker(l: LightSpec): void {
    const color = new THREE.Color(l.color);
    const emitter = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: 5, roughness: 1 });
    emitter.userData.noBake = true;
    const g = l.fixture === 'bulb'
      ? new THREE.SphereGeometry(0.07, 8, 6).translate(l.x, l.y + 0.06, l.z)
      : new THREE.BoxGeometry(1.1, 0.04, 0.34).translate(l.x, l.y + 0.03, l.z);
    const mesh = new THREE.Mesh(g, emitter);
    mesh.castShadow = false;
    this.root.add(mesh);
    const light = new THREE.PointLight(color, l.intensity, Math.min(l.range, 9), l.decay ?? 2);
    light.position.set(l.x, l.y - 0.1, l.z);
    light.castShadow = false;
    this.root.add(light);
    const base = l.intensity;
    let next = 1.5 + ((l.x * 7.3) % 3), until = 0, level = 1;
    this.dynamic.push({
      update: (_dt, t) => {
        if (t > next) {
          until = t + 0.3 + ((t * 13.7) % 1) * 1.4;
          next = until + 2 + ((t * 7.1) % 1) * 7;
        }
        if (t < until) {
          const n = Math.sin(t * 57.0) * Math.sin(t * 19.3 + 0.7);
          level = n > 0.15 ? 1 : n > -0.35 ? 0.3 : 0.03;
        } else {
          level = 0.95 + Math.sin(t * 100) * 0.02;
        }
        if (settings.value.accessibility.reducedFlashing) level = 0.55 + level * 0.45;
        light.intensity = base * level;
        emitter.emissiveIntensity = 5 * level;
      },
    });
  }

  /** Current flat fog density (the volumetric fog matches it). */
  get fogDensity(): number {
    return this.fog.density;
  }

  applySettings(renderer: THREE.WebGLRenderer, shadowSize: number, focus: THREE.Vector3): void {
    const g = settings.value.graphics;
    this.fog.density = FOG_DENSITY[g.fogQuality];
    this.lighting.setShadowSize(shadowSize, renderer);
    this.atmosphere.setQuality(g.particleQuality, focus);
    this.rain.setQuality(g.particleQuality);
    this.snow?.setQuality(g.particleQuality);
    // Low fog (Phone, Low): wet streets keep the cheap baked sheen, no per-lamp reflections.
    setWetLampBudget(g.fogQuality === 'high' ? 8 : g.fogQuality === 'medium' ? 5 : 0);
    setWetTier(!g.rain ? 'off' : g.fogQuality === 'low' ? 'cheap' : 'full');
    setLightConesVisible(g.fogQuality === 'low');
    this.grass.setQuality(g.grass);
    const r = g.reflections === 'off' ? null : MIRROR[g.reflections];
    this.mirror.scale = r?.scale ?? 0;
    this.mirror.maxPixels = r?.maxPixels ?? 0;
    this.puddles.setMirror(r !== null, r?.far ?? 0);
    if (!r) this.mirror.release();
    this.lib.setAnisotropy(g.textureQuality === 'low' ? 1 : g.textureQuality === 'medium' ? 4 : 8);
    this.trees.setTier(treeTier(g), false, renderer);
    this.trees.prepare(renderer);
    this.trees.setShadows(shadowSize > 0);
    void this.lib.loadPbr(renderer, g.textureQuality);
  }

  /**
   * Draws the puddles' reflection for this frame's camera (just before the scene), cropped to the
   * part of the screen the puddles in view cover; nothing when none is.
   */
  renderMirror(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, screen: THREE.Vector2): void {
    const rect = this.mirror.scale > 0
      ? this.puddles.screenRect(camera, this.puddles.uniforms.uMirrorFar.value, this.mirrorRect, this.field?.tracer ?? null)
      : null;
    this.mirror.render(renderer, this.scene, camera, rect, screen);
  }

  update(dt: number, t: number, camera: THREE.Camera, focus: THREE.Vector3): void {
    this.sky.update(dt, camera.position);
    this.sky.uniforms.uFlash.value = this.lighting.flash * (settings.value.accessibility.reducedFlashing ? 0.2 : 1);
    this.lighting.update(dt);
    this.lighting.follow(focus);
    this.atmosphere.update(dt, t, focus);
    updateWeather(dt);
    const u = weatherUniforms;
    u.uWxTime.value = weather.time;
    u.uWetness.value = weather.wetness;
    u.uRainAmt.value = weather.rain;
    u.uWxWind.value.set(this.atmosphere.wind.x, this.atmosphere.wind.z).multiplyScalar(this.atmosphere.windStrength);
    updateWetLamps(camera.position, dt);
    this.rain.update(camera, this.fog.density, this.lighting.flash * (settings.value.accessibility.reducedFlashing ? 0.2 : 1));
    updateWind(t, this.atmosphere.wind, this.atmosphere.windStrength);
    this.snow?.update(dt, camera, this.fog.density);
    // Rain comes with stronger wind in the grass.
    this.grass.update(camera as THREE.PerspectiveCamera, 1 + weather.rain * 0.35);
    this.trees.update(camera);
    for (const d of this.dynamic) d.update(dt, t);
    this.puddles.update();
  }

  dispose(): void {
    this.scene.remove(this.root, this.sky.mesh);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    this.sky.dispose();
    this.trees.dispose();
    this.rain.dispose();
    this.snow?.dispose();
    this.grass.dispose();
    this.puddles.dispose();
    this.mirror.dispose();
    this.atmosphere.dispose();
    this.lib.dispose();
    this.envMap?.dispose();
  }
}

/** Tree detail follows the particle quality (Phone and Low presets: low). */
export function treeTier(g: { particleQuality: Quality }): TreeTier {
  return g.particleQuality;
}
