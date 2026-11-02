import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BICYCLE, type Bicycle, type Simulation } from '@dead-hours/shared';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';
import type { Physics } from '../core/Physics';
import { audio } from '../audio/AudioEngine';

/** Where a ridden bike is drawn and what its moving parts do. */
export interface BikePose {
  /** The ground under the saddle. */
  pos: THREE.Vector3;
  /** Which way the front wheel points (radians). */
  yaw: number;
  /** Leaning into the turn (radians, positive: to the left). */
  lean: number;
  /** How far the bars are turned (radians, positive: left; see barAngle). */
  steer: number;
  /** Crank angle (radians; 0: the right pedal at the top, going forward). */
  crank: number;
  /** Feet pushing the pedals round (else coasting: the freewheel ticks). */
  pedalling: boolean;
  /** Hand brakes, 0..1 (hard at speed: the back tyre skids). */
  brake: number;
  air: boolean;
}

/** How far the bars turn for a steering input (-1..1) at a speed: a lot walking it round, a little at speed. */
export function barAngle(steer: number, speed: number): number {
  return steer * 0.36 * (1 - 0.75 * THREE.MathUtils.smoothstep(speed, 2, 10));
}

/** Frame colour and rim finish for each look. */
const LOOKS: { frame: number; rim: 'silver' | 'black' }[] = [
  { frame: 0xa3241e, rim: 'silver' },
  { frame: 0x177e7a, rim: 'black' },
  { frame: 0x1d1e21, rim: 'silver' },
  { frame: 0xd2a02a, rim: 'black' },
  { frame: 0x2753a3, rim: 'silver' },
  { frame: 0x56612f, rim: 'black' },
];

const B = BICYCLE;
const R = B.wheel;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const BB = V(0, B.bottomBracket.y, B.bottomBracket.z);
const HT = V(0, B.head.y, B.head.z);
const HB = V(0, B.head.y - 0.15, B.head.z + 0.055);
const RA = V(0, R, B.rearAxle);
const FA = V(0, R, B.frontAxle);
/** Lying on its right side: rolled this far, lifted this much (resting on the bar end and the pedal). */
const LIE = 1.36;
const LIE_LIFT = 0.1;

const _up = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/** A round tube from `a` to `b` (bike space). */
function tube(a: THREE.Vector3, b: THREE.Vector3, r: number, seg = 8): THREE.BufferGeometry {
  const d = _v.subVectors(b, a);
  const len = d.length();
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1);
  _q.setFromUnitVectors(_up, d.normalize());
  _m.compose(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5), _q, new THREE.Vector3(1, 1, 1));
  return g.applyMatrix4(_m);
}

function merged(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = mergeGeometries(list, false)!;
  for (const g of list) g.dispose();
  return out;
}

/** A wheel in its own space (axle along X at the origin): tyre, rim, spokes, hub. */
function wheelParts(): { tyre: THREE.BufferGeometry; rim: THREE.BufferGeometry; spokes: THREE.BufferGeometry } {
  const tyre = new THREE.TorusGeometry(R - 0.026, 0.026, 8, 40).rotateY(Math.PI / 2);
  const rimParts: THREE.BufferGeometry[] = [new THREE.TorusGeometry(R - 0.058, 0.011, 6, 40).rotateY(Math.PI / 2)];
  const spokes: THREE.BufferGeometry[] = [];
  const N = 18;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const side = i % 2 ? 1 : -1;
    // Laced from alternate hub flanges, a little off radial (tangent) so the wheel reads as built.
    const hub = V(side * 0.03, Math.cos(a + 0.35) * 0.022, Math.sin(a + 0.35) * 0.022);
    const rim = V(side * 0.004, Math.cos(a) * (R - 0.062), Math.sin(a) * (R - 0.062));
    spokes.push(tube(hub, rim, 0.0022, 4));
  }
  spokes.push(new THREE.CylinderGeometry(0.02, 0.02, 0.09, 10).rotateZ(Math.PI / 2));
  return { tyre, rim: merged(rimParts), spokes: merged(spokes) };
}

/** A tapered saddle: wide at the back, a narrow nose. */
function saddleGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(0.16, 0.05, 0.27, 2, 1, 6);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    const k = THREE.MathUtils.clamp((z + 0.03) / 0.165, 0, 1);
    p.setX(i, p.getX(i) * (1 - 0.68 * k));
    if (p.getY(i) > 0) p.setY(i, p.getY(i) - 0.012 * Math.abs(z / 0.135));
  }
  g.computeVertexNormals();
  return g.translate(0, B.saddle.y - 0.02, B.saddle.z);
}

/** A built bike: the frame and the parts that move (bars and front wheel, back wheel, cranks and pedals). */
interface BikeModel {
  root: THREE.Group;
  steer: THREE.Group;
  front: THREE.Group;
  rear: THREE.Group;
  cranks: THREE.Group;
  pedals: THREE.Mesh[];
  materials: THREE.MeshStandardMaterial[];
  dispose(): void;
}

function createBike(look: number): BikeModel {
  const c = LOOKS[look % LOOKS.length];
  const frameMat = new THREE.MeshStandardMaterial({ color: c.frame, roughness: 0.4, metalness: 0.35 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xb9bdc3, roughness: 0.28, metalness: 0.9 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2c2d31, roughness: 0.5, metalness: 0.6 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.93, metalness: 0 });
  const rimMat = c.rim === 'silver' ? chrome : dark;
  const geos: THREE.BufferGeometry[] = [];
  const keep = <G extends THREE.BufferGeometry>(g: G) => (geos.push(g), g);
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, shadow = true) => {
    const o = new THREE.Mesh(keep(g), m);
    o.castShadow = shadow;
    o.receiveShadow = true;
    return o;
  };
  const root = new THREE.Group();
  root.name = 'bicycle';
  root.rotation.order = 'YXZ';

  // The frame: seat tube, top tube, down tube, head tube, both stays each side.
  const ST = V(0, 0.84, -0.02);
  const frame: THREE.BufferGeometry[] = [
    tube(BB, ST, 0.017),
    tube(V(0, B.head.y - 0.03, B.head.z + 0.01), V(0, 0.8, -0.012), 0.016),
    tube(HB, BB, 0.02),
    tube(HB, HT, 0.022),
  ];
  for (const s of [1, -1]) {
    const axle = V(s * 0.065, R, B.rearAxle);
    frame.push(tube(V(s * 0.02, BB.y, BB.z - 0.02), axle, 0.011));
    frame.push(tube(V(s * 0.022, 0.79, -0.012), axle, 0.01));
  }
  root.add(mesh(merged(frame), frameMat));
  // Seat post, pegs, the rear axle; the saddle; the chain line and the rear cog's guard.
  const metal: THREE.BufferGeometry[] = [tube(ST, V(0, 0.905, -0.045), 0.013)];
  for (const s of [1, -1]) metal.push(tube(V(s * 0.06, R, B.rearAxle), V(s * 0.2, R, B.rearAxle), 0.019, 10));
  root.add(mesh(merged(metal), chrome));
  root.add(mesh(saddleGeometry(), rubber));
  const chain: THREE.BufferGeometry[] = [];
  const cx = -0.062;
  for (const [ry, rr] of [[0.097, 0.04], [-0.097, -0.04]] as const) chain.push(tube(V(cx, BB.y + ry, BB.z), V(cx, R + rr, B.rearAxle), 0.0045, 4));
  root.add(mesh(merged(chain), dark, false));

  // Steering: fork, front wheel, stem and bars turn about the head tube's axis.
  const pivot = new THREE.Group();
  pivot.position.copy(HT);
  pivot.quaternion.setFromUnitVectors(_up, new THREE.Vector3().subVectors(HT, HB).normalize());
  const steer = new THREE.Group();
  pivot.add(steer);
  const content = new THREE.Group();
  // Back into bike space inside the turning group.
  pivot.updateMatrix();
  content.matrix.copy(pivot.matrix).invert();
  content.matrix.decompose(content.position, content.quaternion, content.scale);
  steer.add(content);
  root.add(pivot);
  const fork: THREE.BufferGeometry[] = [tube(V(0, HB.y + 0.02, HB.z), V(0, HB.y - 0.02, HB.z + 0.01), 0.03)];
  for (const s of [1, -1]) fork.push(tube(V(s * 0.045, HB.y - 0.02, HB.z + 0.01), V(s * 0.05, R, B.frontAxle), 0.012));
  const G = B.grips;
  const bars: THREE.BufferGeometry[] = [
    tube(V(0, HT.y - 0.02, HT.z), V(0, 1.03, HT.z - 0.045), 0.015),
    tube(V(0, 1.03, HT.z - 0.045), V(0, 1.055, G.z + 0.04), 0.017),
    tube(V(-0.13, 1.055, G.z + 0.04), V(0.13, 1.055, G.z + 0.04), 0.012),
  ];
  for (const s of [1, -1]) {
    bars.push(tube(V(s * 0.13, 1.055, G.z + 0.04), V(s * 0.21, G.y, G.z), 0.012));
    bars.push(tube(V(s * 0.21, G.y, G.z), V(s * (G.x + 0.03), G.y, G.z), 0.012));
    // Brake lever under each grip.
    bars.push(tube(V(s * 0.2, G.y - 0.005, G.z + 0.02), V(s * 0.29, G.y - 0.03, G.z + 0.09), 0.006, 4));
  }
  content.add(mesh(merged(fork), frameMat));
  content.add(mesh(merged(bars), chrome));
  const grips: THREE.BufferGeometry[] = [];
  for (const s of [1, -1]) grips.push(tube(V(s * 0.2, G.y, G.z), V(s * (G.x + 0.035), G.y, G.z), 0.019));
  content.add(mesh(merged(grips), rubber, false));
  // The bell, on the left of the bars.
  const bell = new THREE.SphereGeometry(0.026, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0.15, G.y + 0.005, G.z + 0.02);
  content.add(mesh(bell, chrome, false));

  const wheel = (at: THREE.Vector3, parent: THREE.Object3D): THREE.Group => {
    const g = new THREE.Group();
    g.position.copy(at);
    const w = wheelParts();
    g.add(mesh(w.tyre, rubber), mesh(w.rim, rimMat), mesh(w.spokes, chrome, false));
    parent.add(g);
    return g;
  };
  const front = wheel(FA, content);
  const rear = wheel(RA, root);
  // The rear cog, turning with the wheel.
  rear.add(mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.012, 14).rotateZ(Math.PI / 2).translate(cx, 0, 0), dark, false));

  // Cranks: arms, chainring, pedals (the pedals stay level as the cranks turn).
  const cranks = new THREE.Group();
  cranks.position.copy(BB);
  const arms: THREE.BufferGeometry[] = [
    tube(V(-0.075, 0, 0), V(-0.075, B.crank, 0), 0.011, 6),
    tube(V(0.075, 0, 0), V(0.075, -B.crank, 0), 0.011, 6),
    tube(V(-0.08, 0, 0), V(0.08, 0, 0), 0.014, 8),
  ];
  cranks.add(mesh(merged(arms), chrome));
  const ring: THREE.BufferGeometry[] = [
    new THREE.TorusGeometry(0.097, 0.007, 4, 32).rotateY(Math.PI / 2).translate(cx, 0, 0),
    new THREE.CylinderGeometry(0.088, 0.088, 0.004, 24).rotateZ(Math.PI / 2).translate(cx, 0, 0),
  ];
  cranks.add(mesh(merged(ring), dark, false));
  const pedalGeo = keep(new THREE.BoxGeometry(0.09, 0.022, 0.07));
  const pedals: THREE.Mesh[] = [];
  for (const [x, y] of [[-B.pedalOut, B.crank], [B.pedalOut, -B.crank]] as const) {
    const pd = new THREE.Mesh(pedalGeo, rubber);
    pd.position.set(x, y, 0);
    pd.castShadow = true;
    cranks.add(pd);
    pedals.push(pd);
  }
  root.add(cranks);

  const materials = [frameMat, chrome, dark, rubber];
  return {
    root, steer, front, rear, cranks, pedals, materials,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

interface View {
  id: number;
  look: number;
  model: BikeModel;
  probe: DynamicProbe;
  pos: THREE.Vector3;
  yaw: number;
  /** Roll as drawn (radians, positive: over to the right; LIE lying down). */
  roll: number;
  /** 0..1 easing from the old spot after it changed hands. */
  ease: number;
  rider: string | null;
  passenger: string | null;
  /** Falling over after the rider left it (0..1), or -1. */
  fall: number;
  fallFrom: number;
  last: THREE.Vector3;
  speed: number;
  air: boolean;
  airT: number;
  seam: number;
  surfaceT: number;
  rough: number;
  crank: number;
}

/**
 * The night's bicycles as the simulation has them: lying on their sides, or under a rider (this
 * survivor's own, or another's online) with someone maybe standing on the pegs; wheels and cranks
 * turning, the bars steering, leaning into turns and falling over when left; and the sounds of
 * all that: tyres on the street, the freewheel ticking while coasting, skids, sidewalk seams,
 * getting on and off, landing a hop.
 */
export class BicycleView {
  private readonly root = new THREE.Group();
  private readonly views = new Map<number, View>();
  private readonly rolls: { id: number; pos: THREE.Vector3; speed: number; rough: number; coast: boolean; skid: number }[] = [];

  constructor(scene: THREE.Scene, private readonly field: LightField, private readonly physics: Physics) {
    this.root.name = 'bicycles';
    scene.add(this.root);
  }

  update(dt: number, sim: Simulation, camera: THREE.Camera, poseOf: (b: Bicycle) => BikePose | null): void {
    const seen = new Set<number>();
    this.rolls.length = 0;
    for (const b of sim.bicycles.bikes) {
      if (!b) continue;
      seen.add(b.id);
      let v = this.views.get(b.id);
      if (!v || v.look !== b.look) {
        if (v) this.remove(b.id);
        v = this.create(b);
      }
      this.place(v, b, dt, poseOf(b));
      v.probe.update(dt, v.pos, camera, 0.6);
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.remove(id);
    audio.bikeRoll(this.rolls);
  }

  /** One bike of every look standing for the loading screen's shader pass (see GameSession.prewarm). */
  sample(): { root: THREE.Object3D; dispose(): void } {
    const root = new THREE.Group();
    const models: BikeModel[] = [];
    for (let i = 0; i < LOOKS.length; i++) {
      const m = createBike(i);
      new DynamicProbe(this.field).attach(m.materials);
      m.root.position.x = i * 0.5;
      root.add(m.root);
      models.push(m);
    }
    return { root, dispose: () => { for (const m of models) m.dispose(); root.removeFromParent(); } };
  }

  private create(b: Bicycle): View {
    const model = createBike(b.look);
    const probe = new DynamicProbe(this.field);
    probe.attach(model.materials);
    this.root.add(model.root);
    const v: View = {
      id: b.id, look: b.look, model, probe, pos: new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z), yaw: b.yaw, roll: b.rider ? 0 : LIE,
      ease: 1, rider: b.rider, passenger: b.passenger, fall: -1, fallFrom: 0, last: new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z),
      speed: 0, air: false, airT: 0, seam: 1.5, surfaceT: 0, rough: 1, crank: Math.PI / 2,
    };
    this.views.set(b.id, v);
    return v;
  }

  private place(v: View, b: Bicycle, dt: number, pose: BikePose | null): void {
    // Changing hands: picked up (it rights itself under the rider) or left (it falls over).
    if (b.rider !== v.rider) {
      const was = v.rider;
      v.rider = b.rider;
      v.ease = 0;
      if (b.rider) {
        v.fall = -1;
        audio.bikeMount(pose?.pos ?? _v.set(b.pos.x, b.pos.y, b.pos.z));
      } else if (was) {
        v.fall = 0;
        v.fallFrom = v.roll;
      }
      v.air = false;
    }
    if (b.passenger !== v.passenger) {
      if (b.passenger) audio.bikePeg(v.pos);
      v.passenger = b.passenger;
    }
    v.ease = Math.min(1, v.ease + dt / 0.3);
    const k = v.ease < 1 ? 1 - Math.exp(-dt * 18) : 1;
    const tx = pose ? pose.pos.x : b.pos.x, ty = pose ? pose.pos.y : b.pos.y, tz = pose ? pose.pos.z : b.pos.z;
    v.pos.x += (tx - v.pos.x) * k;
    v.pos.y += (ty - v.pos.y) * k;
    v.pos.z += (tz - v.pos.z) * k;
    const tyaw = pose ? pose.yaw : b.yaw;
    v.yaw += Math.atan2(Math.sin(tyaw - v.yaw), Math.cos(tyaw - v.yaw)) * (pose && v.ease >= 1 ? 1 : k);
    // Roll: leaning into turns under a rider; tipping over (gravity's way: slow, then fast) when left.
    if (pose) v.roll += (-pose.lean - v.roll) * (v.ease < 1 ? 1 - Math.exp(-dt * 10) : 1);
    else if (v.fall >= 0) {
      v.fall = Math.min(1, v.fall + dt / 0.55);
      v.roll = v.fallFrom + (LIE - v.fallFrom) * v.fall * v.fall;
      if (v.fall >= 1) {
        v.fall = -1;
        audio.bikeDrop(v.pos);
      }
    } else v.roll += (LIE - v.roll) * (1 - Math.exp(-dt * 8));
    const lying = THREE.MathUtils.clamp(v.roll / LIE, 0, 1);
    const m = v.model;
    m.root.position.set(v.pos.x, v.pos.y + LIE_LIFT * lying * lying, v.pos.z);
    m.root.rotation.set(0, v.yaw, v.roll);

    // Wheels turn with the distance travelled along the frame; the bars steer; the cranks go round.
    const dx = v.pos.x - v.last.x, dz = v.pos.z - v.last.z;
    const along = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
    v.last.copy(v.pos);
    const ok = Math.abs(along) < 2;
    if (ok) {
      m.front.rotation.x += along / R;
      m.rear.rotation.x += along / R;
    }
    const inst = dt > 0 && ok ? Math.abs(along) / dt : 0;
    v.speed += (inst - v.speed) * (1 - Math.exp(-dt * 8));
    if (pose && v.ease >= 1) m.steer.rotation.y = pose.steer;
    else m.steer.rotation.y += ((pose ? pose.steer : 0.45 * lying) - m.steer.rotation.y) * (1 - Math.exp(-dt * 14));
    if (pose) v.crank = pose.crank;
    else v.crank += (Math.PI / 2 - v.crank) * (1 - Math.exp(-dt * 3));
    m.cranks.rotation.x = v.crank;
    for (const p of m.pedals) p.rotation.x = -v.crank;

    if (!pose) {
      v.speed = 0;
      return;
    }
    // Sounds: landing a hop, the tyres, the freewheel when coasting, a skid when braking hard.
    if (pose.air) v.airT += dt;
    if (v.air && !pose.air && v.airT > 0.2) audio.bikeLand(v.pos, Math.min(1, v.airT / 0.6));
    if (!pose.air) v.airT = 0;
    v.air = pose.air;
    v.surfaceT -= dt;
    if (v.surfaceT <= 0) {
      v.surfaceT = 0.25;
      v.rough = this.roughness(v.pos);
    }
    if (!pose.air && v.speed > 0.3) {
      if (v.rough < 0.7) {
        v.seam -= Math.abs(along);
        if (v.seam <= 0) {
          v.seam = 1.5;
          audio.bikeSeam(v.pos, Math.min(1, v.speed / 8), (B.frontAxle - B.rearAxle) / Math.max(1, v.speed));
        }
      }
      const skid = pose.brake > B.skidBrake && v.speed > B.skidSpeed ? (pose.brake - B.skidBrake) / (1 - B.skidBrake) : 0;
      this.rolls.push({ id: v.id, pos: v.pos.clone(), speed: v.speed, rough: v.rough, coast: !pose.pedalling, skid });
    }
  }

  /** How rough the ground under the tyres is: asphalt 1, smooth concrete 0.45, floors 0.25, grass and dirt 1.4. */
  private roughness(p: THREE.Vector3): number {
    const hit = this.physics.raycastHit(p.x, p.y + 0.3, p.z, 0, -1, 0, 0.8);
    const s = hit?.surface ?? 'asphalt';
    return s === 'asphalt' ? 1 : s === 'concrete' ? 0.45 : s === 'wood' || s === 'fabric' ? 0.25 : s === 'dirt' || s === 'grass' ? 1.4 : 0.6;
  }

  private remove(id: number): void {
    const v = this.views.get(id);
    if (!v) return;
    v.model.root.removeFromParent();
    v.model.dispose();
    this.views.delete(id);
  }

  dispose(): void {
    for (const id of [...this.views.keys()]) this.remove(id);
    this.root.removeFromParent();
    audio.bikeRoll([]);
  }
}
