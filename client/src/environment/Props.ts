import * as THREE from 'three';
import type { MapDefinition } from '@dead-hours/shared';
import type { MaterialLibrary } from '../rendering/Materials';
import type { StaticBatcher } from '../rendering/StaticBatcher';
import { createLightConeMaterial } from './LightCone';
import { settings } from '../core/Settings';
import { Kit, jitter, type PropBuildResult } from './props/Kit';
import { INTERIOR } from './props/interior';
import { OUTDOOR } from './props/outdoor';

export type { PropBuildResult, SoundAnchor, Updatable } from './props/Kit';

const CAR_COLORS = [0x3e4a56, 0x5b2f2b, 0x6f6f68, 0x2f3d33, 0x8a8374, 0x1f2328];

/** Car cabin: box with the top face inset to give slanted windshields. */
function cabinGeometry(len: number, h: number, wid: number, insetF: number, insetB: number, insetSide: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(len, h, wid);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) > 0 ? p.getX(i) - insetF : p.getX(i) + insetB);
      p.setZ(i, p.getZ(i) * (1 - insetSide));
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Builds every map prop. Static parts merge into the world batch; animated parts stay separate. */
export class PropFactory {
  readonly foliageUniforms = { uTime: { value: 0 }, uWind: { value: 1 } };
  readonly foliage: THREE.MeshStandardMaterial;
  readonly pine: THREE.MeshStandardMaterial;
  readonly trunk: THREE.MeshStandardMaterial;

  constructor(private readonly lib: MaterialLibrary) {
    this.foliage = lib.custom('foliage', () => new THREE.MeshStandardMaterial({ color: 0x27331f, roughness: 0.95, flatShading: true }));
    this.pine = lib.custom('pine', () => new THREE.MeshStandardMaterial({ color: 0x1d2a1f, roughness: 0.95, flatShading: true }));
    this.trunk = lib.standard(0x2f261f, 0.95);
    for (const m of [this.foliage, this.pine]) {
      m.userData.foliage = true;
      this.sway(m, false);
    }
  }

  /** Wind sway for foliage; instanced copies take their phase from the instance position. */
  sway(m: THREE.MeshStandardMaterial, instanced: boolean): void {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.foliageUniforms.uTime;
      shader.uniforms.uWind = this.foliageUniforms.uWind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float hgt = max(position.y - 1.2, 0.0);
           ${instanced ? 'vec3 base = instanceMatrix[3].xyz;' : 'vec3 base = position;'}
           float ph = base.x * 0.35 + base.z * 0.27;
           transformed.x += sin(uTime * 1.3 + ph) * 0.035 * hgt * uWind;
           transformed.z += cos(uTime * 1.1 + ph * 1.3) * 0.025 * hgt * uWind;`,
        );
      // Dither foliage out right in front of the camera so the shoulder view never ends up
      // inside a crown in the woods (shadows use their own depth material and are unaffected).
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         float camDist = length(vViewPosition);
         if (camDist < 4.6) {
           float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
           if (n > smoothstep(1.2, 4.6, camDist)) discard;
         }`,
      );
    };
    m.customProgramCacheKey = () => (instanced ? 'sway-instanced' : 'sway');
  }

  build(map: MapDefinition, scene: THREE.Object3D, batch: StaticBatcher): PropBuildResult {
    const result: PropBuildResult = { dynamic: [], anchors: [], landmarks: {} };
    const kit = new Kit(this.lib, result);
    const poles = new Map<number, THREE.Vector3[]>();
    for (const p of map.props) {
      if (p.forest) continue;
      const root = new THREE.Group();
      root.position.set(p.x, p.y ?? 0, p.z);
      root.rotation.y = p.rotY;
      const dynamicRoot = new THREE.Group();
      dynamicRoot.position.copy(root.position);
      dynamicRoot.rotation.copy(root.rotation);
      kit.begin(p, root, dynamicRoot);
      const builder = INTERIOR[p.kind] ?? OUTDOOR[p.kind];
      if (builder) builder(kit);
      else this.buildStreetProp(kit, result);
      if (p.kind === 'utilityPole') {
        const line = poles.get(p.variant ?? 0) ?? [];
        line.push(new THREE.Vector3(p.x, 8.4, p.z));
        poles.set(p.variant ?? 0, line);
      }
      batch.addObject(root);
      root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
      if (dynamicRoot.children.length) scene.add(dynamicRoot);
    }
    for (const line of poles.values()) this.buildWires(line, batch);
    return result;
  }

  private buildWires(poles: THREE.Vector3[], batch: StaticBatcher): void {
    poles.sort((a, b) => a.x - b.x);
    const mat = this.lib.standard(0x101214, 0.6, 0.3);
    for (let i = 0; i < poles.length - 1; i++) {
      for (const off of [-0.7, 0, 0.7]) {
        const a = poles[i].clone().add(new THREE.Vector3(0, 0, off));
        const b = poles[i + 1].clone().add(new THREE.Vector3(0, 0, off));
        const mid = a.clone().lerp(b, 0.5);
        mid.y -= 0.9;
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
        batch.add(new THREE.TubeGeometry(curve, 16, 0.018, 3, false), mat, false, false);
      }
    }
  }

  private buildStreetProp(k: Kit, out: PropBuildResult): void {
    const p = k.p;
    switch (p.kind) {
      case 'streetlight': {
        const metal = k.mat(0x2a2d30, 0.6, 0.5);
        k.cyl(0.08, 0.13, 6.2, 7, metal, 0, 3.1, 0);
        k.box(0.08, 0.08, 1.7, metal, 0, 6.05, 0.8);
        k.cyl(0.22, 0.34, 0.2, 8, metal, 0, 5.95, 1.65);
        const dead = (p.variant ?? 0) === 1;
        if (dead) {
          k.cyl(0.24, 0.24, 0.04, 8, k.mat(0x1a1a18, 0.4), 0, 5.84, 1.65, { cast: false });
          break;
        }
        const flicker = !!p.flag;
        const bulbMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc27a, emissiveIntensity: 6 });
        bulbMat.userData.noBake = true;
        k.cyl(0.24, 0.24, 0.04, 8, bulbMat, 0, 5.84, 1.65, { cast: false, dynamic: flicker });
        const coneH = 5.7;
        const coneG = new THREE.ConeGeometry(2.9, coneH, 20, 1, true);
        coneG.translate(0, -coneH / 2, 0);
        const coneMat = createLightConeMaterial(0xffbf80);
        const cone = new THREE.Mesh(coneG, coneMat);
        cone.position.set(0, 5.82, 1.65);
        cone.renderOrder = 2;
        k.dyn.add(cone);
        const worldPos = new THREE.Vector3(p.x, 5.8, p.z);
        if (!flicker) {
          out.anchors.push({ kind: 'buzz', position: worldPos, level: () => 0.35 });
          break;
        }
        // The one realtime streetlight: it flickers, so it can't be baked.
        const spot = new THREE.SpotLight(0xffb36b, 260, 24, 0.95, 0.65, 1.6);
        spot.position.set(0, 5.8, 1.65);
        spot.target.position.set(0, 0, 2.4);
        k.dyn.add(spot, spot.target);
        let level = 1;
        let nextGlitch = 2 + Math.random() * 5;
        let glitchUntil = 0;
        out.dynamic.push({
          update: (_dt, t) => {
            if (t > nextGlitch) {
              glitchUntil = t + 0.25 + Math.random() * 1.2;
              nextGlitch = glitchUntil + 1.5 + Math.random() * 6;
            }
            if (t < glitchUntil) {
              const n = Math.sin(t * 61.0) * Math.sin(t * 23.7 + 1.3);
              level = n > 0.1 ? 1 : n > -0.4 ? 0.25 : 0.02;
            } else {
              level = 0.92 + Math.sin(t * 17) * 0.03;
            }
            if (settings.value.accessibility.reducedFlashing) level = 0.5 + level * 0.5;
            spot.intensity = 260 * level;
            bulbMat.emissiveIntensity = 6 * level;
            coneMat.uniforms.uIntensity.value = level;
          },
        });
        out.anchors.push({ kind: 'buzz', position: worldPos, level: () => level });
        out.landmarks.flicker = worldPos.clone();
        break;
      }
      case 'car':
      case 'policeCar':
      case 'wreckedCar': {
        const police = p.kind === 'policeCar';
        const wreck = p.kind === 'wreckedCar';
        const overturned = (p.variant ?? 0) >= 10;
        if (overturned) {
          // Roof down: flip the whole body about its long axis.
          k.root.rotation.order = k.dyn.rotation.order = 'YXZ';
          k.root.rotation.x = Math.PI;
          k.root.position.y += 1.55;
          k.dyn.rotation.x = Math.PI;
          k.dyn.position.y += 1.55;
        }
        const color = police ? 0x15181c : CAR_COLORS[(p.variant ?? 0) % CAR_COLORS.length];
        const paint = this.lib.standard(color, wreck ? 0.75 : 0.45, 0.35, true);
        paint.userData.envMap = !wreck;
        const glass = this.lib.custom('car-glass', () => new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.08, metalness: 0.8 }));
        glass.userData.envMap = true;
        const rubber = k.mat(0x111111, 0.9);
        const chrome = k.mat(0x77797b, 0.35, 0.8);
        k.box(4.4, 0.62, 1.86, paint, 0, 0.62, 0);
        if (police) k.box(1.9, 0.63, 1.875, k.mat(0xb9bcbf, 0.5, 0.2), -0.1, 0.62, 0);
        k.add(cabinGeometry(2.3, 0.6, 1.7, 0.55, 0.4, 0.12), glass, -0.2, 1.23, 0);
        k.box(1.3, 0.06, 1.5, police ? k.mat(0xb9bcbf, 0.5, 0.2) : paint, -0.15, 1.55, 0);
        k.box(0.12, 0.25, 1.9, chrome, 2.22, 0.45, 0);
        k.box(0.12, 0.25, 1.9, chrome, -2.22, 0.45, 0);
        for (const wx of [-1.35, 1.35]) for (const wz of [-0.86, 0.86]) k.cyl(0.36, 0.36, 0.26, 10, rubber, wx, 0.36, wz, { rx: Math.PI / 2 });
        const tail = k.glow(0x5a0805, 0.6);
        k.box(0.05, 0.12, 0.35, tail, -2.24, 0.75, 0.65, { cast: false });
        k.box(0.05, 0.12, 0.35, tail, -2.24, 0.75, -0.65, { cast: false });
        k.box(0.05, 0.14, 0.38, k.mat(0x9aa0a6, 0.2, 0.5), 2.24, 0.72, 0.62);
        k.box(0.05, 0.14, 0.38, k.mat(0x9aa0a6, 0.2, 0.5), 2.24, 0.72, -0.62);
        if (wreck) {
          k.root.rotation.z = 0.03;
          k.box(1.2, 0.08, 1.7, paint, 1.55, 0.98, 0, { rz: -0.25 });
          k.add(jitter(new THREE.BoxGeometry(0.9, 0.3, 1.6, 2, 1, 2), 0.08, Math.round(p.x)), k.mat(0x141210, 0.9), 1.9, 0.9, 0);
        }
        if (police) {
          k.box(0.35, 0.1, 1.3, k.mat(0x1a1a1a, 0.6), -0.15, 1.63, 0);
          k.box(1.4, 0.22, 0.01, k.text(['POLICE'], { w: 512, h: 96, bg: '#b9bcbf', fg: '#111418', border: null }), -0.1, 0.7, 0.944, { cast: false });
          k.box(1.4, 0.22, 0.01, k.text(['POLICE'], { w: 512, h: 96, bg: '#b9bcbf', fg: '#111418', border: null }), -0.1, 0.7, -0.944, { cast: false, ry: Math.PI });
          const red = new THREE.MeshStandardMaterial({ color: 0x110000, emissive: 0xff2a1a, emissiveIntensity: 2 });
          const blue = new THREE.MeshStandardMaterial({ color: 0x000011, emissive: 0x2050ff, emissiveIntensity: 2 });
          red.userData.noBake = blue.userData.noBake = true;
          if (!p.flag) {
            red.emissiveIntensity = blue.emissiveIntensity = 0.4;
            k.box(0.3, 0.12, 0.55, red, -0.15, 1.73, 0.33, { cast: false });
            k.box(0.3, 0.12, 0.55, blue, -0.15, 1.73, -0.33, { cast: false });
            break;
          }
          k.box(0.3, 0.12, 0.55, red, -0.15, 1.73, 0.33, { cast: false, dynamic: true });
          k.box(0.3, 0.12, 0.55, blue, -0.15, 1.73, -0.33, { cast: false, dynamic: true });
          const rl = new THREE.PointLight(0xff2a1a, 0, 14, 1.8);
          rl.position.set(-0.15, 1.95, 0.8);
          const bl = new THREE.PointLight(0x2050ff, 0, 14, 1.8);
          bl.position.set(-0.15, 1.95, -0.8);
          k.dyn.add(rl, bl);
          const phase = p.x * 0.37;
          out.dynamic.push({
            update: (_dt, t) => {
              const reduced = settings.value.accessibility.reducedFlashing;
              const cycle = (t * (reduced ? 0.6 : 1.6) + phase) % 1;
              const strobe = (c: number) => (reduced ? 0.5 + 0.5 * Math.sin(c * Math.PI * 2) : (c % 0.25 < 0.09 ? 1 : 0));
              const redOn = cycle < 0.5 ? strobe(cycle * 2) : 0;
              const blueOn = cycle >= 0.5 ? strobe((cycle - 0.5) * 2) : 0;
              const kk = reduced ? 0.4 : 1;
              red.emissiveIntensity = 2 + redOn * 14 * kk;
              blue.emissiveIntensity = 2 + blueOn * 14 * kk;
              rl.intensity = redOn * 30 * kk;
              bl.intensity = blueOn * 34 * kk;
            },
          });
          out.landmarks.policeCar ??= new THREE.Vector3(p.x, 1, p.z);
        }
        if (wreck && p.flag) {
          const amber = new THREE.MeshStandardMaterial({ color: 0x110800, emissive: 0xff8a1c, emissiveIntensity: 0 });
          amber.userData.noBake = true;
          for (const [hx, hz] of [[2.24, 0.82], [2.24, -0.82], [-2.24, 0.82], [-2.24, -0.82]]) k.box(0.06, 0.1, 0.18, amber, hx, 0.74, hz, { cast: false, dynamic: true });
          const hl = new THREE.PointLight(0xff8a1c, 0, 9, 1.8);
          hl.position.set(0, 1.0, 0);
          k.dyn.add(hl);
          out.dynamic.push({
            update: (_dt, t) => {
              const on = (t % 1.1) < 0.55 ? 1 : 0;
              const kk = settings.value.accessibility.reducedFlashing ? 0.35 : 1;
              amber.emissiveIntensity = on * 9 * kk;
              hl.intensity = on * 9 * kk;
            },
          });
          out.landmarks.wreck = new THREE.Vector3(p.x, 1, p.z);
          out.anchors.push({ kind: 'alarm', position: new THREE.Vector3(p.x, 1, p.z), level: () => 1 });
        }
        break;
      }
      case 'trashBin': {
        const m = k.mat([0x2c3a2e, 0x2a2f38, 0x3a3a36][(p.variant ?? 0) % 3], 0.7);
        const bin = k.cyl(0.33, 0.29, 1.0, 8, m, 0, 0.5, 0);
        bin.scale.z = 0.9;
        k.box(0.72, 0.08, 0.68, m, 0.02, 1.04, 0, { rz: (p.variant ?? 0) === 1 ? 0.5 : 0.03 });
        break;
      }
      case 'mailbox': {
        k.box(0.09, 1.0, 0.09, k.mat(0x3a2e24, 0.9), 0, 0.5, 0);
        const g = new THREE.CylinderGeometry(0.15, 0.15, 0.48, 8, 1, false, 0, Math.PI);
        k.add(g, k.mat(0x2c2f33, 0.5, 0.5), 0, 1.0, 0, { rz: Math.PI / 2, ry: Math.PI / 2 });
        k.box(0.3, 0.12, 0.48, k.mat(0x2c2f33, 0.5, 0.5), 0, 0.97, 0);
        k.box(0.03, 0.14, 0.05, k.mat(0x6b2620, 0.6), 0.16, 1.15, 0.12);
        break;
      }
      case 'hydrant': {
        const m = k.mat(0x6d2a22, 0.6, 0.2);
        k.cyl(0.14, 0.17, 0.7, 8, m, 0, 0.35, 0);
        k.add(new THREE.SphereGeometry(0.15, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), m, 0, 0.7, 0);
        k.box(0.42, 0.1, 0.1, m, 0, 0.45, 0);
        break;
      }
      case 'utilityPole': {
        const wood = k.mat(0x3d3128, 0.95);
        k.cyl(0.12, 0.17, 9, 7, wood, 0, 4.5, 0);
        k.box(0.12, 0.12, 2.0, wood, 0, 8.45, 0);
        k.cyl(0.22, 0.22, 0.6, 8, k.mat(0x50565a, 0.5, 0.6), 0.3, 7.5, 0);
        if (p.flag) {
          // Alley lamp on a short arm.
          const metal = k.mat(0x2a2d30, 0.6, 0.5);
          k.box(0.06, 0.06, 1.0, metal, 0, 6.25, 0.5);
          k.cyl(0.16, 0.26, 0.16, 8, metal, 0, 6.15, 0.95);
          k.cyl(0.17, 0.17, 0.03, 8, k.glow(0xffc27a, 5), 0, 6.06, 0.95, { cast: false });
        }
        break;
      }
      case 'tree': {
        const v = p.variant ?? 0;
        const hgt = 3.2 + (v % 3) * 0.6;
        k.add(new THREE.CylinderGeometry(0.14, 0.24, hgt, 6), this.trunk, 0, hgt / 2, 0);
        const clumps = 4 + (v % 3);
        for (let i = 0; i < clumps; i++) {
          const a = (i / clumps) * Math.PI * 2 + v;
          const r = i === 0 ? 0 : 0.9 + (i % 2) * 0.4;
          const size = i === 0 ? 1.9 : 1.2 + ((v + i) % 3) * 0.2;
          const g = jitter(new THREE.IcosahedronGeometry(size, 1), size * 0.25, v * 10 + i);
          k.add(g, this.foliage, Math.cos(a) * r, hgt + (i === 0 ? 0.9 : 0.2 + (i % 3) * 0.5), Math.sin(a) * r);
        }
        break;
      }
      case 'pine': {
        k.add(new THREE.CylinderGeometry(0.12, 0.2, 2, 6), this.trunk, 0, 1, 0);
        for (const [g, y] of pineCrown(p.variant ?? 0)) k.add(g, this.pine, 0, y, 0);
        break;
      }
      case 'bush': {
        const v = p.variant ?? 0;
        for (let i = 0; i < 3; i++) {
          const g = jitter(new THREE.IcosahedronGeometry(0.55 + (i % 2) * 0.2, 0), 0.15, v * 5 + i);
          g.scale(1, 0.8, 1);
          k.add(g, this.foliage, (i - 1) * 0.55, 0.45 + (i % 2) * 0.1, ((v + i) % 2) * 0.3 - 0.15);
        }
        break;
      }
      case 'fence': {
        const len = p.length ?? 6;
        const broken = (p.variant ?? 0) === 1;
        const boards = this.lib.get('fenceWood');
        const post = k.mat(0x3e3024, 0.95);
        const posts = Math.max(2, Math.round(len / 2.4) + 1);
        for (let i = 0; i < posts; i++) k.box(0.12, 1.7, 0.12, post, -len / 2 + (i * len) / (posts - 1), 0.85, 0);
        k.box(len, 0.09, 0.05, post, 0, 0.45, 0.06);
        k.box(len, 0.09, 0.05, post, 0, 1.3, 0.06);
        // Board panels textured with slats; broken fences lose a few boards.
        const gaps = broken ? [0.23, 0.61, 0.84].map((f) => -len / 2 + f * len) : [];
        let x = -len / 2;
        for (const gx of [...gaps, len / 2]) {
          const end = gx === len / 2 ? gx : gx - 0.16;
          if (end - x > 0.05) {
            const g = new THREE.BoxGeometry(end - x, 1.58, 0.025);
            const uv = g.getAttribute('uv') as THREE.BufferAttribute;
            const pos = g.getAttribute('position') as THREE.BufferAttribute;
            for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + (x + end) / 2) / boards.texScale, (pos.getY(i) + 0.8) / boards.texScale);
            k.add(g, boards.material, (x + end) / 2, 0.8, 0.1);
          }
          if (gx !== len / 2) k.box(0.12, 1.2, 0.025, boards.material, gx, 0.7, 0.16, { rz: 0.35 });
          x = gx + 0.16;
        }
        break;
      }
      case 'roadblock': {
        const white = k.mat(0xa9a59a, 0.7);
        const red = k.mat(0x7a2a22, 0.7);
        for (let i = 0; i < 6; i++) {
          k.box(0.53, 0.25, 0.08, i % 2 ? red : white, -1.33 + i * 0.53, 0.9, 0);
          k.box(0.53, 0.18, 0.08, i % 2 ? white : red, -1.33 + i * 0.53, 0.45, 0);
        }
        for (const lx of [-1.4, 1.4]) k.box(0.08, 1.05, 0.6, k.mat(0x3a3a3a, 0.6, 0.4), lx, 0.52, 0);
        const lampMat = new THREE.MeshStandardMaterial({ color: 0x110800, emissive: 0xffa020, emissiveIntensity: 0 });
        lampMat.userData.noBake = true;
        k.box(0.14, 0.14, 0.14, lampMat, 1.4, 1.13, 0, { cast: false, dynamic: true });
        const ph = p.z;
        out.dynamic.push({ update: (_dt, t) => { lampMat.emissiveIntensity = ((t + ph) % 1.4) < 0.3 ? 8 : 0.3; } });
        break;
      }
      case 'trashBag': {
        const g = jitter(new THREE.IcosahedronGeometry(0.32, 1), 0.12, p.variant ?? 1);
        g.scale(1, 0.7, 1);
        k.add(g, k.mat(0x121315, 0.35, 0.1), 0, 0.2, 0);
        break;
      }
      default:
        break;
    }
  }
}

/** Pine crown cones (shared by batched yard pines and the instanced forest). */
export function pineCrown(v: number): [THREE.BufferGeometry, number][] {
  const scale = 1 + (v % 3) * 0.15;
  const out: [THREE.BufferGeometry, number][] = [];
  for (let i = 0; i < 4; i++) {
    const r = (2.2 - i * 0.45) * scale;
    const h = 2.4 * scale;
    out.push([jitter(new THREE.ConeGeometry(r, h, 7, 1), 0.18, v * 7 + i), 1.6 + i * 1.25 * scale + h / 2 - 0.6]);
  }
  return out;
}
