import * as THREE from 'three';
import { VEHICLES, VOLATILES, isDrivable, propOwner, wreckDoor, type MapDefinition, type PropSpec } from '@dead-hours/shared';
import type { MaterialLibrary } from '../rendering/Materials';
import type { StaticBatcher } from '../rendering/StaticBatcher';
import { createLightConeMaterial } from './LightCone';
import { LampGlare, patchLens } from './LampGlare';
import { WIRE_RADIUS, wireCurves, wireMaterial } from './Wires';
import { settings } from '../core/Settings';
import { Kit, jitter, type Paint, type PropBuildResult, type Surface } from './props/Kit';
import { chamferBox, loft, plate, type P2 } from '../rendering/Solid';
import { worldPieces } from './WorldPieces';
import { INTERIOR } from './props/interior';
import { OUTDOOR } from './props/outdoor';

export type { PropBuildResult, SoundAnchor, Updatable, VehicleParts } from './props/Kit';

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

/** A car's greenhouse as panes only (windshield, rear window, the sides): open top and bottom, for a cabin to show through. */
function openCabinGeometry(len: number, h: number, wid: number, insetF: number, insetB: number, insetSide: number): THREE.BufferGeometry {
  const box = cabinGeometry(len, h, wid, insetF, insetB, insetSide);
  const index = box.getIndex()!;
  const keep: number[] = [];
  // BoxGeometry's faces: +x, -x, +y, -y, +z, -z; the top (under the roof) and the bottom go.
  for (const g of box.groups) {
    if (g.materialIndex === 2 || g.materialIndex === 3) continue;
    for (let i = g.start; i < g.start + g.count; i++) keep.push(index.getX(i));
  }
  box.setIndex(keep);
  box.clearGroups();
  return box;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A kit geometry ready for the prop batches: no modeling attributes, texture coordinates present. */
function dressed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  g.deleteAttribute('edge');
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2));
  return g;
}

/** A car's side-view outline ([x, y] points, nose toward +X) extruded across the car and chamfered. */
function sidePlate(outline: P2[], width: number, bevel: number): THREE.BufferGeometry {
  const g = plate(outline, width, { bevel });
  g.rotateY(Math.PI / 2);
  return dressed(g);
}

/** Points along a wheel arch, from angle a0 to a1 (radians, 0 toward the nose). */
function arch(cx: number, cy: number, r: number, a0: number, a1: number, n: number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

/**
 * The sedan's hard points, which the seats, the colliders and the driving all assume
 * (shared/src/config/vehicles.ts): 4.4 m of body on a 2.7 m wheelbase, 1.86 m wide, the belt
 * line at 0.93 m and 0.72 m wheels. The outline between them is a mid-90s American sedan's.
 */
const CAR = { nose: 2.2, tail: -2.2, sill: 0.31, belt: 0.93, axle: 1.35, wheelY: 0.36, wheelR: 0.36, archR: 0.435, half: 0.93, cowl: 0.95, deck: -1.35 };

/**
 * Knocked-over furniture: a chair falls onto its side (toward local -X, matching its tipped collider),
 * a floor lamp lies along local +X.
 */
function tip(kind: PropSpec['kind'], root: THREE.Group): void {
  root.rotation.order = 'YXZ';
  if (kind === 'chair') {
    root.rotation.z = Math.PI / 2;
    root.position.y += 0.21;
  } else if (kind === 'floorLamp') {
    root.rotation.z = -Math.PI / 2 + 0.06;
    root.position.y += 0.2;
  }
}

/** Lamp lenses (discs facing down): radius and thickness in metres. */
const LENS = { street: { r: 0.24, t: 0.04 }, alley: { r: 0.17, t: 0.03 } } as const;

/** Builds every map prop. Static parts merge into the world batch; animated parts stay separate. */
export class PropFactory {
  /** Soft glares that take over from lamp lenses too thin to draw steadily (see LampGlare). */
  readonly glare = new LampGlare();
  constructor(private readonly lib: MaterialLibrary) {}

  build(map: MapDefinition, scene: THREE.Object3D, batch: StaticBatcher): PropBuildResult {
    const result: PropBuildResult = { dynamic: [], anchors: [], landmarks: {}, vehicles: [] };
    const kit = new Kit(this.lib, result);
    const poles = new Map<number, THREE.Vector3[]>();
    map.props.forEach((p, index) => {
      if (isDrivable(p)) this.buildVehicle(kit, p, index, result);
    });
    map.props.forEach((p, index) => {
      // Trees, pines and shrubs are drawn by Trees (instanced, levels of detail, wind).
      if (p.forest || isDrivable(p) || p.kind === 'tree' || p.kind === 'pine' || p.kind === 'bush') return;
      const root = new THREE.Group();
      root.position.set(p.x, p.y ?? 0, p.z);
      root.rotation.y = p.rotY;
      const dynamicRoot = new THREE.Group();
      dynamicRoot.position.copy(root.position);
      dynamicRoot.rotation.copy(root.rotation);
      if (p.tipped) tip(p.kind, root);
      kit.begin(p, root, dynamicRoot);
      const builder = INTERIOR[p.kind] ?? OUTDOOR[p.kind];
      if (builder) builder(kit);
      else this.buildStreetProp(kit, result);
      if (p.kind === 'utilityPole') {
        const line = poles.get(p.variant ?? 0) ?? [];
        line.push(new THREE.Vector3(p.x, 0, p.z));
        poles.set(p.variant ?? 0, line);
      }
      // Furniture goes down with the building it stands in; a car, a pump or a drum burns on its own.
      batch.begin(VOLATILES[p.kind] ? `prop:${index}` : propOwner(map, p));
      batch.addObject(root);
      batch.end();
      root.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
      if (dynamicRoot.children.length) scene.add(dynamicRoot);
    });
    for (const line of poles.values()) this.buildWires(line, batch);
    const glare = this.glare.build();
    if (glare) scene.add(glare);
    return result;
  }

  /**
   * A vehicle that can be driven, built about its own origin (the vehicle view moves it). Sound
   * anchors and landmarks it registers are at the spot it is parked in when the night starts.
   */
  private buildVehicle(kit: Kit, p: PropSpec, index: number, out: PropBuildResult): void {
    const root = new THREE.Group();
    const dyn = new THREE.Group();
    // Parts go on the groups' own frames; the prop keeps its spot for its random looks and its landmarks.
    kit.begin(p, root, dyn);
    const anchors = out.anchors.length;
    const builder = OUTDOOR[p.kind];
    if (builder) builder(kit);
    else this.buildStreetProp(kit, out);
    // Sounds placed where it is parked ride along with it: kept as offsets in its own frame.
    const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
    const parts = out.anchors.slice(anchors).map((anchor) => {
      const dx = anchor.position.x - p.x, dz = anchor.position.z - p.z;
      return { anchor, offset: new THREE.Vector3(dx * c - dz * s, anchor.position.y - (p.y ?? 0), dx * s + dz * c) };
    });
    out.vehicles.push({ prop: index, root, dyn, anchors: parts });
  }

  /**
   * A drivable car's middle, between the solid hood and trunk: the doors and the floor pan the
   * feet rest on (VEHICLES.car.floor), the seats, the dashboard and the steering wheel where the
   * driver's hands go, under clear glass with slim pillars holding up the roof.
   */
  private carCabin(k: Kit, paint: Surface, police: boolean): void {
    const def = VEHICLES.car;
    const white = k.mat(0xb9bcbf, 0.5, 0.2);
    const cloth = k.mat(0x2b2724, 0.95);
    const dash = k.mat(0x1b1b1d, 0.8);
    k.block(2.3, def.floor - 0.31, 1.72, k.mat(0x161617, 0.9), -0.2, 0.31, 0);
    // Two bucket seats in front, a bench behind.
    const [driver, front, back] = def.seats;
    for (const s of [driver, front]) {
      k.block(0.48, s.y - def.floor, 0.48, cloth, s.x - 0.02, def.floor, s.z);
      k.box(0.12, 0.6, 0.48, cloth, s.x - 0.27, s.y + 0.3, s.z, { rz: 0.16 });
      k.box(0.09, 0.16, 0.26, cloth, s.x - 0.33, s.y + 0.68, s.z, { rz: 0.16 });
    }
    k.block(0.5, back.y - def.floor, 1.62, cloth, back.x - 0.02, def.floor, 0);
    k.box(0.13, 0.52, 1.62, cloth, back.x - 0.29, back.y + 0.27, 0, { rz: 0.2 });
    // The dashboard under the windshield, and the wheel in front of the driver (its rim where VehicleView puts the hands).
    k.block(0.28, 0.27, 1.72, dash, 0.81, 0.68, 0);
    const w = def.wheel, tilt = 0.45;
    const rim = new THREE.TorusGeometry(0.17, 0.02, 6, 20);
    rim.rotateY(Math.PI / 2);
    rim.rotateZ(tilt);
    k.add(rim, dash, w.x, w.y, driver.z, { cast: false });
    k.cyl(0.045, 0.045, 0.05, 8, dash, w.x + 0.01, w.y, driver.z, { rz: tilt - Math.PI / 2, cast: false });
    k.rod(V(w.x + 0.03, w.y - 0.01, driver.z), V(0.75, 0.82, driver.z), 0.028, dash);
    // Glass all round, the roof, and the pillars at the corners and between the doors.
    k.pane(openCabinGeometry(2.3, 0.6, 1.7, 0.55, 0.4, 0.12), -0.2, 1.23, 0);
    k.add(dressed(chamferBox(1.39, 0.06, 1.54, 0.02)), police ? white : paint, -0.275, 1.555, 0);
    for (const sz of [-1, 1]) {
      k.rod(V(0.95, 0.93, sz * 0.85), V(0.4, 1.53, sz * 0.748), 0.035, paint);
      k.rod(V(-0.28, 0.93, sz * 0.85), V(-0.3, 1.53, sz * 0.748), 0.03, paint);
      k.rod(V(-1.35, 0.93, sz * 0.85), V(-0.95, 1.53, sz * 0.748), 0.045, paint);
    }
  }

  /**
   * A sedan's shell below the glass: the front clip (hood, fenders, fascia) and the rear one
   * (trunk and quarters) as side outlines across the whole car, the doors as panels with the
   * rear arch cut into them, bumpers, wheels with steel rims, lamps, grille and the small things
   * a silhouette is read by. The middle is left open for a cabin (or closed by dark glass).
   */
  private carBody(k: Kit, paint: Surface, police: boolean, wreck: boolean): void {
    const c = CAR;
    const dark = k.mat(0x0c0c0d, 0.9);
    const trim = k.mat(0x18191b, 0.7);
    const chrome = k.mat(0x77797b, 0.35, 0.8);
    const white = k.mat(0xb9bcbf, 0.5, 0.2);
    const up = Math.PI / 2;
    // Front clip: cowl, hood falling to the nose, the fascia, and the arch over the wheel.
    const cowlArch = Math.acos((c.cowl - c.axle) / c.archR);
    const low = -Math.asin((c.wheelY - c.sill) / c.archR);
    k.add(sidePlate([
      [c.cowl, c.belt], [1.55, 0.915], [2.02, 0.86], [2.16, 0.8], [c.nose, 0.72], [c.nose, 0.44], [2.13, c.sill],
      ...arch(c.axle, c.wheelY, c.archR, low, cowlArch, 7),
    ], c.half * 2, 0.06), paint, 0, 0, 0);
    // Rear clip: the deck, the tail, and the back of the rear arch.
    k.add(sidePlate([
      [c.deck, c.belt], [c.deck, c.wheelY + c.archR], ...arch(-c.axle, c.wheelY, c.archR, up + 0.3, Math.PI - low, 5),
      [-2.14, c.sill], [c.tail, 0.46], [c.tail, 0.8], [-2.12, 0.885], [-1.9, 0.915],
    ], c.half * 2, 0.06), paint, 0, 0, 0);
    // Doors and sills: a panel each side, the front of the rear arch cut out of it.
    const door: P2[] = [[c.cowl, c.belt], [c.deck, c.belt], [c.deck, c.wheelY + c.archR], ...arch(-c.axle, c.wheelY, c.archR, up - 0.3, low, 5), [c.cowl, c.sill]];
    for (const sz of [-1, 1]) {
      k.add(sidePlate(door, 0.07, 0.012), paint, 0, 0, sz * 0.895);
      // Black and white: the white doors.
      if (police) k.add(dressed(chamferBox(1.82, 0.585, 0.078, 0.01)), white, -0.06, 0.63, sz * 0.895);
      // The shut line between the doors, their handles, the rub strip, the mirror.
      k.box(0.014, 0.56, 0.006, dark, -0.28, 0.63, sz * 0.932, { cast: false });
      k.box(0.014, 0.56, 0.006, dark, 0.86, 0.63, sz * 0.932, { cast: false });
      for (const hx of [0.42, -0.72]) k.add(dressed(chamferBox(0.13, 0.03, 0.02, 0.006)), police ? trim : chrome, hx, 0.84, sz * 0.938, { cast: false });
      if (!police) k.box(2.2, 0.035, 0.014, trim, -0.2, 0.56, sz * 0.936, { cast: false });
      k.add(dressed(chamferBox(0.09, 0.11, 0.17, 0.02)), police ? trim : paint, 0.82, 1.0, sz * 1.01, { cast: false });
      // Wheel wells, so the arches are dark and not a view through the car.
      k.box(0.86, 0.5, 0.36, dark, c.axle, 0.56, sz * 0.72, { cast: false });
      k.box(0.86, 0.5, 0.36, dark, -c.axle, 0.56, sz * 0.72, { cast: false });
    }
    // Bumpers, grille between the headlamps, plates.
    for (const end of [1, -1]) {
      k.add(dressed(chamferBox(0.17, 0.2, 1.92, 0.04)), wreck ? chrome : trim, end * 2.2, 0.43, 0);
      k.box(0.012, 0.11, 0.32, k.mat(0xc9c6ba, 0.6), end * 2.292, 0.43, 0, { cast: false });
    }
    k.add(dressed(chamferBox(0.05, 0.13, 0.74, 0.012)), dark, 2.19, 0.635, 0, { cast: false });
    for (let i = -3; i <= 3; i++) k.box(0.012, 0.11, 0.012, chrome, 2.218, 0.635, i * 0.1, { cast: false });
    // Wheels: a tire with shoulders on a steel rim, a cap on the hub.
    const tire = dressed(loft([{ z: -0.13, rx: 0.2 }, { z: -0.13, rx: 0.325 }, { z: -0.1, rx: c.wheelR }, { z: 0.1, rx: c.wheelR }, { z: 0.13, rx: 0.325 }, { z: 0.13, rx: 0.2 }], { segments: 16, caps: false }));
    const rim = dressed(loft([{ z: -0.118, rx: 0.205 }, { z: -0.1, rx: 0.215 }, { z: 0.1, rx: 0.215 }, { z: 0.118, rx: 0.205 }], { segments: 12 }));
    const cap = dressed(loft([{ z: -0.135, rx: 0.06 }, { z: -0.128, rx: 0.085 }, { z: 0.128, rx: 0.085 }, { z: 0.135, rx: 0.06 }], { segments: 8 }));
    const rubber = k.mat(0x101010, 0.92);
    const steel = police ? k.mat(0x1b1c1e, 0.5, 0.6) : k.mat(0x8d9093, 0.4, 0.8);
    for (const wx of [-c.axle, c.axle]) for (const wz of [-0.86, 0.86]) {
      k.add(tire.clone(), rubber, wx, c.wheelY, wz);
      k.add(rim.clone(), steel, wx, c.wheelY, wz, { cast: false });
      k.add(cap.clone(), chrome, wx, c.wheelY, wz, { cast: false });
    }
    tire.dispose(); rim.dispose(); cap.dispose();
  }

  /** A lamp lens that hands its light to the glare as it shrinks on screen. */
  private lensMaterial(color: number, intensity: number, lens: { r: number; t: number }): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: intensity, roughness: 1 });
    m.userData.noBake = true;
    patchLens(m, lens.r, lens.t);
    return m;
  }

  private lens(key: string, color: number, intensity: number, lens: { r: number; t: number }): THREE.MeshStandardMaterial {
    return this.lib.custom(`lens-${key}-${color}-${intensity}`, () => this.lensMaterial(color, intensity, lens));
  }

  /** Registers the glare for a lens at local (0, y, z) on the current prop. */
  private addGlare(k: Kit, y: number, z: number, color: number, intensity: number, lens: { r: number; t: number }): number {
    const pos = new THREE.Vector3(0, y, z).applyAxisAngle(new THREE.Vector3(0, 1, 0), k.p.rotY).add(new THREE.Vector3(k.p.x, k.p.y ?? 0, k.p.z));
    return this.glare.add(pos, new THREE.Color(color).multiplyScalar(intensity), lens.r, lens.t);
  }

  private buildWires(poles: THREE.Vector3[], batch: StaticBatcher): void {
    const mat = wireMaterial(this.lib);
    for (const curve of wireCurves(poles)) batch.add(new THREE.TubeGeometry(curve, 16, WIRE_RADIUS, 3, false), mat, false, false);
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
        // Steady lamps share one lens (one draw); the failing one dims its own.
        const bulbMat = flicker ? this.lensMaterial(0xffc27a, 6, LENS.street) : this.lens('street', 0xffc27a, 6, LENS.street);
        k.cyl(LENS.street.r, LENS.street.r, LENS.street.t, 8, bulbMat, 0, 5.84, 1.65, { cast: false, dynamic: flicker });
        const glare = this.addGlare(k, 5.84, 1.65, 0xffc27a, 6, LENS.street);
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
            this.glare.setGain(glare, level);
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
        // Paint and glass carry their colour in the vertices, so a car that burns out can be blackened where it stands.
        const paint: Paint = {
          paint: true, color: new THREE.Color(color),
          material: this.lib.custom(wreck ? 'car-paint-dull' : 'car-paint', () =>
            new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: wreck ? 0.75 : 0.45, metalness: 0.35, flatShading: true, vertexColors: true })),
        };
        paint.material.userData.envMap = !wreck;
        const glass: Paint = {
          paint: true, color: new THREE.Color(0x0b0f14),
          material: this.lib.custom('car-glass', () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.08, metalness: 0.8, vertexColors: true })),
        };
        glass.material.userData.envMap = true;
        // One that drives shows who is inside: clear glass over an open cabin.
        const open = isDrivable(p);
        this.carBody(k, paint, police, wreck);
        if (open) this.carCabin(k, paint, police);
        else {
          k.block(2.3, 0.05, 1.72, k.mat(0x161617, 0.9), -0.2, 0.31, 0);
          k.add(cabinGeometry(2.3, 0.6, 1.7, 0.55, 0.4, 0.12), glass, -0.2, 1.23, 0);
          k.add(dressed(chamferBox(1.34, 0.06, 1.52, 0.02)), police ? k.mat(0xb9bcbf, 0.5, 0.2) : paint, -0.15, 1.55, 0);
        }
        const tail = k.glow(0x5a0805, 0.6);
        for (const tz of [0.63, -0.63]) k.box(0.05, 0.13, 0.44, tail, -2.185, 0.7, tz, { cast: false }).userData.lamp = 'tail';
        for (const hz of [0.63, -0.63]) k.box(0.05, 0.13, 0.42, k.mat(0x9aa0a6, 0.2, 0.5), 2.185, 0.635, hz).userData.lamp = 'head';
        const door = wreckDoor(p);
        if (door) {
          // Abandoned with a door hanging open: a hole in the body and the door swung out on its hinge.
          const dz = door.side * 0.935;
          k.box(door.length - 0.08, 0.5, 0.02, k.mat(0x0d0d0e, 0.9), 0.55 - door.length / 2, 0.68, dz, { cast: false });
          k.box(door.length, 0.62, 0.07, paint, door.cx, 0.62, door.cz, { ry: door.ry });
          const win = new THREE.BoxGeometry(door.length * 0.62, 0.42, 0.02);
          const wx = door.cx + Math.cos(door.ry) * 0.12, wz = door.cz - Math.sin(door.ry) * 0.12;
          if (open) k.pane(win, wx, 1.12, wz, { ry: door.ry });
          else k.add(win, glass, wx, 1.12, wz, { ry: door.ry, cast: false });
          // Interior: seat backs show through the opening (an open cabin has its seats already).
          if (!open) k.box(0.5, 0.55, 1.5, k.mat(0x2a2422, 0.95), 0.05, 0.95, 0, { cast: false });
        }
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
              // Burnt out: the strobes are dead.
              if (worldPieces.burnt.has(p)) {
                red.emissiveIntensity = blue.emissiveIntensity = 0;
                rl.intensity = bl.intensity = 0;
                return;
              }
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
              const on = (t % 1.1) < 0.55 && !worldPieces.burnt.has(p) ? 1 : 0;
              const kk = settings.value.accessibility.reducedFlashing ? 0.35 : 1;
              amber.emissiveIntensity = on * 9 * kk;
              hl.intensity = on * 9 * kk;
            },
          });
          out.landmarks.wreck = new THREE.Vector3(p.x, 1, p.z);
          out.anchors.push({ kind: 'alarm', position: new THREE.Vector3(p.x, 1, p.z), level: () => (worldPieces.burnt.has(p) ? 0 : 1) });
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
          k.cyl(LENS.alley.r, LENS.alley.r, LENS.alley.t, 8, this.lens('alley', 0xffc27a, 5, LENS.alley), 0, 6.06, 0.95, { cast: false });
          this.addGlare(k, 6.06, 0.95, 0xffc27a, 5, LENS.alley);
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
