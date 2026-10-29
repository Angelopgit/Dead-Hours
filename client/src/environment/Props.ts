import * as THREE from 'three';
import type { MapDefinition, PropSpec } from '@dead-hours/shared';
import type { MaterialLibrary } from '../rendering/Materials';
import type { StaticBatcher } from '../rendering/StaticBatcher';
import { createLightConeMaterial } from './LightCone';
import { settings } from '../core/Settings';

export interface Updatable {
  update(dt: number, t: number): void;
}

/** Positional sound sources the audio engine can attach to. */
export interface SoundAnchor {
  kind: 'buzz' | 'alarm';
  position: THREE.Vector3;
  /** 0..1 loudness driven by the visual state (e.g. flicker). */
  level: () => number;
}

export interface PropBuildResult {
  dynamic: Updatable[];
  anchors: SoundAnchor[];
  /** Ground-level positions of emissive roadside lights (used by the menu camera framing). */
  landmarks: { policeCar?: THREE.Vector3; wreck?: THREE.Vector3; flicker?: THREE.Vector3 };
}

const CAR_COLORS = [0x3e4a56, 0x5b2f2b, 0x6f6f68, 0x2f3d33, 0x8a8374, 0x1f2328];

function mesh(g: THREE.BufferGeometry, m: THREE.Material, cast = true, receive = true): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.castShadow = cast;
  o.receiveShadow = receive;
  return o;
}

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0, cast = true): THREE.Mesh {
  const o = mesh(new THREE.BoxGeometry(w, h, d), m, cast);
  o.position.set(x, y, z);
  return o;
}

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

function jitter(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280) - 0.5;
  // Weld-safe jitter: same input position → same offset.
  const cache = new Map<string, [number, number, number]>();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let o = cache.get(key);
    if (!o) {
      o = [rnd() * amount, rnd() * amount, rnd() * amount];
      cache.set(key, o);
    }
    p.setXYZ(i, p.getX(i) + o[0], p.getY(i) + o[1], p.getZ(i) + o[2]);
  }
  g.computeVertexNormals();
  return g;
}

export class PropFactory {
  readonly foliageUniforms = { uTime: { value: 0 }, uWind: { value: 1 } };
  private readonly foliage: THREE.MeshStandardMaterial;
  private readonly pine: THREE.MeshStandardMaterial;

  constructor(private readonly lib: MaterialLibrary) {
    const sway = (m: THREE.MeshStandardMaterial) => {
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uTime = this.foliageUniforms.uTime;
        shader.uniforms.uWind = this.foliageUniforms.uWind;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
          .replace(
            '#include <begin_vertex>',
            `#include <begin_vertex>
             float hgt = max(position.y - 1.2, 0.0);
             float ph = position.x * 0.35 + position.z * 0.27;
             transformed.x += sin(uTime * 1.3 + ph) * 0.035 * hgt * uWind;
             transformed.z += cos(uTime * 1.1 + ph * 1.3) * 0.025 * hgt * uWind;`,
          );
      };
    };
    this.foliage = lib.custom('foliage', () => new THREE.MeshStandardMaterial({ color: 0x27331f, roughness: 0.95, flatShading: true }));
    this.pine = lib.custom('pine', () => new THREE.MeshStandardMaterial({ color: 0x1d2a1f, roughness: 0.95, flatShading: true }));
    sway(this.foliage);
    sway(this.pine);
  }

  build(map: MapDefinition, scene: THREE.Object3D, batch: StaticBatcher): PropBuildResult {
    const result: PropBuildResult = { dynamic: [], anchors: [], landmarks: {} };
    const poles: THREE.Vector3[] = [];
    for (const p of map.props) {
      const root = new THREE.Group();
      root.position.set(p.x, 0, p.z);
      root.rotation.y = p.rotY;
      const dynamicRoot = new THREE.Group();
      dynamicRoot.position.copy(root.position);
      dynamicRoot.rotation.copy(root.rotation);
      this.buildProp(p, root, dynamicRoot, result);
      if (p.kind === 'utilityPole') poles.push(new THREE.Vector3(p.x, 8.4, p.z));
      batch.addObject(root);
      root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
      if (dynamicRoot.children.length) scene.add(dynamicRoot);
    }
    this.buildWires(poles, batch);
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

  private buildProp(p: PropSpec, root: THREE.Group, dyn: THREE.Group, out: PropBuildResult): void {
    const L = this.lib;
    switch (p.kind) {
      case 'streetlight': {
        const metal = L.standard(0x2a2d30, 0.6, 0.5);
        const pole = mesh(new THREE.CylinderGeometry(0.08, 0.13, 6.2, 7), metal);
        pole.position.y = 3.1;
        root.add(pole);
        const arm = box(0.08, 0.08, 1.7, metal, 0, 6.05, 0.8);
        root.add(arm);
        const head = mesh(new THREE.CylinderGeometry(0.22, 0.34, 0.2, 8), metal);
        head.position.set(0, 5.95, 1.65);
        root.add(head);
        // Dynamic: bulb, spotlight, volumetric cone.
        const bulbMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffc27a, emissiveIntensity: 6 });
        const bulb = mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.04, 8), bulbMat, false, false);
        bulb.position.set(0, 5.84, 1.65);
        dyn.add(bulb);
        const spot = new THREE.SpotLight(0xffb36b, 260, 24, 0.95, 0.65, 1.6);
        spot.position.set(0, 5.8, 1.65);
        spot.target.position.set(0, 0, 2.4);
        dyn.add(spot, spot.target);
        const coneH = 5.7;
        const coneG = new THREE.ConeGeometry(2.9, coneH, 20, 1, true);
        coneG.translate(0, -coneH / 2, 0);
        const coneMat = createLightConeMaterial(0xffbf80);
        const cone = new THREE.Mesh(coneG, coneMat);
        cone.position.set(0, 5.82, 1.65);
        cone.renderOrder = 2;
        dyn.add(cone);
        const flicker = !!p.flag;
        const worldPos = new THREE.Vector3(p.x, 5.8, p.z);
        let level = 1;
        let nextGlitch = 2 + Math.random() * 5;
        let glitchUntil = 0;
        out.dynamic.push({
          update: (_dt, t) => {
            if (flicker) {
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
            }
            spot.intensity = 260 * level;
            bulbMat.emissiveIntensity = 6 * level;
            coneMat.uniforms.uIntensity.value = level;
          },
        });
        out.anchors.push({ kind: 'buzz', position: worldPos, level: () => (flicker ? level : 0.35) });
        if (flicker) out.landmarks.flicker = worldPos.clone();
        break;
      }
      case 'car':
      case 'policeCar':
      case 'wreckedCar': {
        const police = p.kind === 'policeCar';
        const wreck = p.kind === 'wreckedCar';
        const color = police ? 0x15181c : CAR_COLORS[(p.variant ?? 0) % CAR_COLORS.length];
        const paint = L.standard(color, wreck ? 0.75 : 0.45, 0.35, true);
        const glass = L.custom('car-glass', () => new THREE.MeshStandardMaterial({ color: 0x0b0f14, roughness: 0.08, metalness: 0.8 }));
        const rubber = L.standard(0x111111, 0.9);
        const chrome = L.standard(0x77797b, 0.35, 0.8);
        const body = box(4.4, 0.62, 1.86, paint, 0, 0.62, 0);
        root.add(body);
        if (police) {
          root.add(box(1.9, 0.63, 1.875, L.standard(0xb9bcbf, 0.5, 0.2), -0.1, 0.62, 0));
        }
        const cabin = mesh(cabinGeometry(2.3, 0.6, 1.7, 0.55, 0.4, 0.12), glass);
        cabin.position.set(-0.2, 1.23, 0);
        root.add(cabin);
        const roof = box(1.3, 0.06, 1.5, police ? L.standard(0xb9bcbf, 0.5, 0.2) : paint, -0.15, 1.55, 0);
        root.add(roof);
        root.add(box(0.12, 0.25, 1.9, chrome, 2.22, 0.45, 0));
        root.add(box(0.12, 0.25, 1.9, chrome, -2.22, 0.45, 0));
        for (const wx of [-1.35, 1.35]) for (const wz of [-0.86, 0.86]) {
          const wheel = mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.26, 10), rubber);
          wheel.rotation.x = Math.PI / 2;
          wheel.position.set(wx, 0.36, wz);
          root.add(wheel);
        }
        // Headlights dark (abandoned), taillights faint.
        const tail = L.emissive(0x5a0805, 0.6);
        root.add(box(0.05, 0.12, 0.35, tail, -2.24, 0.75, 0.65, false));
        root.add(box(0.05, 0.12, 0.35, tail, -2.24, 0.75, -0.65, false));
        root.add(box(0.05, 0.14, 0.38, L.standard(0x9aa0a6, 0.2, 0.5), 2.24, 0.72, 0.62));
        root.add(box(0.05, 0.14, 0.38, L.standard(0x9aa0a6, 0.2, 0.5), 2.24, 0.72, -0.62));
        if (wreck) {
          root.rotation.z = 0.03;
          // Crumpled hood and a popped trunk.
          const hood = box(1.2, 0.08, 1.7, paint, 1.55, 0.98, 0);
          hood.rotation.z = -0.25;
          root.add(hood);
        }
        if (police) {
          const red = new THREE.MeshStandardMaterial({ color: 0x110000, emissive: 0xff2a1a, emissiveIntensity: 0 });
          const blue = new THREE.MeshStandardMaterial({ color: 0x000011, emissive: 0x2050ff, emissiveIntensity: 0 });
          const barBase = box(0.35, 0.1, 1.3, L.standard(0x1a1a1a, 0.6), -0.15, 1.63, 0);
          root.add(barBase);
          const r = box(0.3, 0.12, 0.55, red, -0.15, 1.73, 0.33, false);
          const b = box(0.3, 0.12, 0.55, blue, -0.15, 1.73, -0.33, false);
          dyn.add(r, b);
          const rl = new THREE.PointLight(0xff2a1a, 0, 14, 1.8);
          rl.position.set(-0.15, 1.95, 0.8);
          const bl = new THREE.PointLight(0x2050ff, 0, 14, 1.8);
          bl.position.set(-0.15, 1.95, -0.8);
          dyn.add(rl, bl);
          const phase = p.x * 0.37;
          out.dynamic.push({
            update: (_dt, t) => {
              const reduced = settings.value.accessibility.reducedFlashing;
              const cycle = (t * (reduced ? 0.6 : 1.6) + phase) % 1;
              // Double-strobe pattern alternating red/blue.
              const strobe = (c: number) => (reduced ? 0.5 + 0.5 * Math.sin(c * Math.PI * 2) : (c % 0.25 < 0.09 ? 1 : 0));
              const redOn = cycle < 0.5 ? strobe(cycle * 2) : 0;
              const blueOn = cycle >= 0.5 ? strobe((cycle - 0.5) * 2) : 0;
              const k = reduced ? 0.4 : 1;
              red.emissiveIntensity = 2 + redOn * 14 * k;
              blue.emissiveIntensity = 2 + blueOn * 14 * k;
              rl.intensity = redOn * 30 * k;
              bl.intensity = blueOn * 34 * k;
            },
          });
          out.landmarks.policeCar ??= new THREE.Vector3(p.x, 1, p.z);
        }
        if (wreck && p.flag) {
          const amber = new THREE.MeshStandardMaterial({ color: 0x110800, emissive: 0xff8a1c, emissiveIntensity: 0 });
          for (const [hx, hz] of [[2.24, 0.82], [2.24, -0.82], [-2.24, 0.82], [-2.24, -0.82]]) {
            dyn.add(box(0.06, 0.1, 0.18, amber, hx, 0.74, hz, false));
          }
          const hl = new THREE.PointLight(0xff8a1c, 0, 9, 1.8);
          hl.position.set(0, 1.0, 0);
          dyn.add(hl);
          out.dynamic.push({
            update: (_dt, t) => {
              const on = (t % 1.1) < 0.55 ? 1 : 0;
              const k = settings.value.accessibility.reducedFlashing ? 0.35 : 1;
              amber.emissiveIntensity = on * 9 * k;
              hl.intensity = on * 9 * k;
            },
          });
          out.landmarks.wreck = new THREE.Vector3(p.x, 1, p.z);
          out.anchors.push({ kind: 'alarm', position: new THREE.Vector3(p.x, 1, p.z), level: () => 1 });
        }
        break;
      }
      case 'trashBin': {
        const c = [0x2c3a2e, 0x2a2f38, 0x3a3a36][(p.variant ?? 0) % 3];
        const m = L.standard(c, 0.7);
        const bin = mesh(new THREE.CylinderGeometry(0.33, 0.29, 1.0, 8), m);
        bin.position.y = 0.5;
        bin.scale.z = 0.9;
        root.add(bin);
        const lid = box(0.72, 0.08, 0.68, m, 0.02, 1.04, 0);
        lid.rotation.z = (p.variant ?? 0) === 1 ? 0.5 : 0.03;
        root.add(lid);
        break;
      }
      case 'mailbox': {
        root.add(box(0.09, 1.0, 0.09, L.standard(0x3a2e24, 0.9), 0, 0.5, 0));
        const mb = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.48, 8, 1, false, 0, Math.PI), L.standard(0x2c2f33, 0.5, 0.5));
        mb.rotation.z = Math.PI / 2;
        mb.rotation.y = Math.PI / 2;
        mb.position.set(0, 1.0, 0);
        root.add(mb);
        root.add(box(0.3, 0.12, 0.48, L.standard(0x2c2f33, 0.5, 0.5), 0, 0.97, 0));
        root.add(box(0.03, 0.14, 0.05, L.standard(0x6b2620, 0.6), 0.16, 1.15, 0.12));
        break;
      }
      case 'hydrant': {
        const m = L.standard(0x6d2a22, 0.6, 0.2);
        const h = mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.7, 8), m);
        h.position.y = 0.35;
        root.add(h);
        const cap = mesh(new THREE.SphereGeometry(0.15, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), m);
        cap.position.y = 0.7;
        root.add(cap);
        root.add(box(0.42, 0.1, 0.1, m, 0, 0.45, 0));
        break;
      }
      case 'utilityPole': {
        const wood = L.standard(0x3d3128, 0.95);
        const pole = mesh(new THREE.CylinderGeometry(0.12, 0.17, 9, 7), wood);
        pole.position.y = 4.5;
        root.add(pole);
        root.add(box(0.12, 0.12, 2.0, wood, 0, 8.45, 0));
        const tr = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.6, 8), L.standard(0x50565a, 0.5, 0.6));
        tr.position.set(0.3, 7.5, 0);
        root.add(tr);
        break;
      }
      case 'tree': {
        const v = p.variant ?? 0;
        const trunkM = L.standard(0x2f261f, 0.95);
        const hgt = 3.2 + (v % 3) * 0.6;
        const trunk = mesh(new THREE.CylinderGeometry(0.14, 0.24, hgt, 6), trunkM);
        trunk.position.y = hgt / 2;
        root.add(trunk);
        const clumps = 4 + (v % 3);
        for (let i = 0; i < clumps; i++) {
          const a = (i / clumps) * Math.PI * 2 + v;
          const r = i === 0 ? 0 : 0.9 + (i % 2) * 0.4;
          const size = i === 0 ? 1.9 : 1.2 + ((v + i) % 3) * 0.2;
          const g = jitter(new THREE.IcosahedronGeometry(size, 1), size * 0.25, v * 10 + i);
          const c = mesh(g, this.foliage);
          c.position.set(Math.cos(a) * r, hgt + (i === 0 ? 0.9 : 0.2 + (i % 3) * 0.5), Math.sin(a) * r);
          root.add(c);
        }
        break;
      }
      case 'pine': {
        const v = p.variant ?? 0;
        const trunk = mesh(new THREE.CylinderGeometry(0.12, 0.2, 2, 6), L.standard(0x2f261f, 0.95));
        trunk.position.y = 1;
        root.add(trunk);
        const scale = 1 + (v % 3) * 0.15;
        for (let i = 0; i < 4; i++) {
          const r = (2.2 - i * 0.45) * scale;
          const h = 2.4 * scale;
          const g = jitter(new THREE.ConeGeometry(r, h, 7, 1), 0.18, v * 7 + i);
          const c = mesh(g, this.pine);
          c.position.y = 1.6 + i * 1.25 * scale + h / 2 - 0.6;
          root.add(c);
        }
        break;
      }
      case 'bush': {
        const v = p.variant ?? 0;
        for (let i = 0; i < 3; i++) {
          const g = jitter(new THREE.IcosahedronGeometry(0.55 + (i % 2) * 0.2, 0), 0.15, v * 5 + i);
          const c = mesh(g, this.foliage);
          c.position.set((i - 1) * 0.55, 0.45 + (i % 2) * 0.1, ((v + i) % 2) * 0.3 - 0.15);
          c.scale.y = 0.8;
          root.add(c);
        }
        break;
      }
      case 'fence': {
        const len = p.length ?? 6;
        const broken = (p.variant ?? 0) === 1;
        const m = L.get('fenceWood').material;
        const post = L.standard(0x3e3024, 0.95);
        const posts = Math.max(2, Math.round(len / 2.4) + 1);
        for (let i = 0; i < posts; i++) {
          root.add(box(0.12, 1.7, 0.12, post, -len / 2 + (i * len) / (posts - 1), 0.85, 0));
        }
        root.add(box(len, 0.09, 0.05, post, 0, 0.45, 0.06));
        root.add(box(len, 0.09, 0.05, post, 0, 1.3, 0.06));
        const slats = Math.floor(len / 0.16);
        for (let i = 0; i < slats; i++) {
          if (broken && (i % 7 === 3 || i % 11 === 5)) continue;
          const s = box(0.12, 1.55 + ((i * 37) % 5) * 0.015, 0.025, m, -len / 2 + 0.08 + i * 0.16, 0.8, 0.1);
          if (broken && i % 9 === 0) s.rotation.z = 0.15;
          root.add(s);
        }
        break;
      }
      case 'roadblock': {
        const white = L.standard(0xa9a59a, 0.7);
        const red = L.standard(0x7a2a22, 0.7);
        for (let i = 0; i < 6; i++) {
          root.add(box(0.53, 0.25, 0.08, i % 2 ? red : white, -1.33 + i * 0.53, 0.9, 0));
          root.add(box(0.53, 0.18, 0.08, i % 2 ? white : red, -1.33 + i * 0.53, 0.45, 0));
        }
        for (const lx of [-1.4, 1.4]) {
          const leg = box(0.08, 1.05, 0.6, L.standard(0x3a3a3a, 0.6, 0.4), lx, 0.52, 0);
          root.add(leg);
        }
        const lampMat = new THREE.MeshStandardMaterial({ color: 0x110800, emissive: 0xffa020, emissiveIntensity: 0 });
        const lamp = box(0.14, 0.14, 0.14, lampMat, 1.4, 1.13, 0, false);
        dyn.add(lamp);
        const ph = p.z;
        out.dynamic.push({ update: (_dt, t) => { lampMat.emissiveIntensity = ((t + ph) % 1.4) < 0.3 ? 8 : 0.3; } });
        break;
      }
      case 'trashBag': {
        const g = jitter(new THREE.IcosahedronGeometry(0.32, 1), 0.12, p.variant ?? 1);
        const bag = mesh(g, L.standard(0x121315, 0.35, 0.1));
        bag.scale.y = 0.7;
        bag.position.y = 0.2;
        root.add(bag);
        break;
      }
    }
  }
}
