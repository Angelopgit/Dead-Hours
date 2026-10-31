import * as THREE from 'three';
import { SKATEBOARD, type Skateboard, type Simulation } from '@dead-hours/shared';
import type { LightField } from '../lighting/LightField';
import { DynamicProbe } from '../lighting/Probes';
import type { Physics } from '../core/Physics';
import { audio } from '../audio/AudioEngine';

/** Where a ridden board is drawn: under its rider's feet. */
export interface BoardPose {
  pos: THREE.Vector3;
  /** Which way the nose points (radians). */
  yaw: number;
  /** Lean into the carve, -1..1 (positive: turning left). */
  lean: number;
  /** Seconds since an ollie popped, or -1. */
  pop: number;
  air: boolean;
  /** Kick cycle 0..1 while the rider pushes along, or -1. */
  push: number;
}

/** Deck graphic (underside) and wheel colour for each look. */
const LOOKS: { base: number; accent: number; stripe: number; wheel: number }[] = [
  { base: 0xb3261e, accent: 0xf2efe6, stripe: 0x1a1a1a, wheel: 0xf1ead8 },
  { base: 0x18181b, accent: 0xf26b1d, stripe: 0xf7c948, wheel: 0xe8e2d0 },
  { base: 0x14837b, accent: 0xf5d547, stripe: 0x0f2f3a, wheel: 0xf5d547 },
  { base: 0x5b2a86, accent: 0xf28ab2, stripe: 0xf2efe6, wheel: 0xf28ab2 },
  { base: 0xd8b98a, accent: 0x222222, stripe: 0xb3261e, wheel: 0xf1ead8 },
  { base: 0x4b5a2a, accent: 0xe9dfc4, stripe: 0x2a2a20, wheel: 0xe9dfc4 },
  { base: 0x1d4f9c, accent: 0xf2efe6, stripe: 0xe03a3a, wheel: 0x7ad0e6 },
  { base: 0xf2c230, accent: 0x151515, stripe: 0x151515, wheel: 0xf1ead8 },
];

const L = SKATEBOARD.length, W = SKATEBOARD.width, R = SKATEBOARD.wheel;
/** Deck thickness, the underside's height off the ground, and where the trucks sit along the deck. */
const T = 0.012;
const UNDER = SKATEBOARD.deck - T;
const TRUCK_Z = 0.19;
/** Kicktail rise past this distance from the middle. */
const KICK_FROM = 0.245;
/** How high the nose and tail tips rise above the middle of the deck. */
const KICK_RISE = 0.32 * (L / 2 - KICK_FROM) ** 2 / (L / 2 - KICK_FROM + 0.03);

/** Rise of the deck along its length (kicktails), and a little concave across. */
const rise = (z: number, v: number) => {
  const t = Math.abs(z) - KICK_FROM;
  return (t > 0 ? (0.32 * t * t) / (t + 0.03) : 0) + 0.004 * v * v;
};

/**
 * A deck shaped like the real thing: popsicle outline with round ends, kicked-up nose and tail,
 * a little concave, black grip on top, maple edges and the look's graphic underneath. Along +Z
 * (nose), origin on the ground between the trucks.
 */
function deckGeometry(look: number): THREE.BufferGeometry {
  const c = LOOKS[look % LOOKS.length];
  const base = new THREE.Color(c.base), accent = new THREE.Color(c.accent), stripe = new THREE.Color(c.stripe);
  const grip = new THREE.Color(0x1c1c1f), maple = new THREE.Color(0xd9bc8c);
  const N = 34, M = 7;
  const half = L / 2 - 0.003;
  // Stations along the deck, closer together at the round ends.
  const zs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = (i / N) * 2 - 1;
    zs.push(Math.sign(u) * Math.pow(Math.abs(u), 0.8) * half);
  }
  const rEnd = W / 2;
  const hw = (z: number) => {
    const d = Math.abs(z) - (L / 2 - rEnd);
    return d <= 0 ? W / 2 : Math.sqrt(Math.max(0, rEnd * rEnd - d * d)) + 0.002;
  };
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const push = (x: number, y: number, z: number, cc: THREE.Color, shade = 1) => {
    pos.push(x, y, z);
    col.push(cc.r * shade, cc.g * shade, cc.b * shade);
    return pos.length / 3 - 1;
  };
  const graphic = (z: number, v: number): THREE.Color => {
    const az = Math.abs(z);
    if (az > 0.3) return accent;
    if (az > 0.255 && az < 0.285) return stripe;
    if (Math.abs(v) < 0.22 && az < 0.16) return accent;
    if (Math.abs(az - 0.2) < 0.012) return stripe;
    return base;
  };
  const top: number[][] = [], bottom: number[][] = [];
  for (const z of zs) {
    const w = hw(z);
    const rowT: number[] = [], rowB: number[] = [];
    for (let j = 0; j < M; j++) {
      const v = (j / (M - 1)) * 2 - 1;
      const y = UNDER + rise(z, v);
      // Grip with a little speckle.
      const speck = 0.85 + (((Math.sin(z * 913 + v * 37) * 43758.5) % 1 + 1) % 1) * 0.3;
      rowT.push(push(v * w, y + T, z, grip, speck));
      rowB.push(push(v * w, y, z, graphic(z, v)));
    }
    top.push(rowT);
    bottom.push(rowB);
  }
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M - 1; j++) {
      const a = top[i][j], b = top[i][j + 1], cc = top[i + 1][j + 1], d = top[i + 1][j];
      idx.push(a, d, cc, a, cc, b);
      const e = bottom[i][j], f = bottom[i][j + 1], g = bottom[i + 1][j + 1], h = bottom[i + 1][j];
      idx.push(e, f, g, e, g, h);
    }
  }
  // Edges: maple ply all the way round (own vertices, so they shade on their own).
  const ring: [number, number][] = [];
  for (let i = 0; i <= N; i++) ring.push([i, M - 1]);
  for (let i = N; i >= 0; i--) ring.push([i, 0]);
  ring.push(ring[0]);
  for (let k = 0; k < ring.length - 1; k++) {
    const [i0, j0] = ring[k], [i1, j1] = ring[k + 1];
    const p = (row: number[][], i: number, j: number) => row[i][j] * 3;
    const tA = p(top, i0, j0), tB = p(top, i1, j1), bA = p(bottom, i0, j0), bB = p(bottom, i1, j1);
    const a = push(pos[tA], pos[tA + 1], pos[tA + 2], maple, 1);
    const b = push(pos[tB], pos[tB + 1], pos[tB + 2], maple, 1);
    const cc = push(pos[bB], pos[bB + 1], pos[bB + 2], maple, 0.8);
    const d = push(pos[bA], pos[bA + 1], pos[bA + 2], maple, 0.8);
    idx.push(a, b, cc, a, cc, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** A built board: the deck, the trucks, and the two axles whose wheels spin. */
interface BoardModel {
  root: THREE.Group;
  axles: THREE.Group[];
  materials: THREE.MeshStandardMaterial[];
  dispose(): void;
}

function createBoard(look: number): BoardModel {
  const c = LOOKS[look % LOOKS.length];
  const deckMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xa9adb3, roughness: 0.38, metalness: 0.85 });
  const wheelMat = new THREE.MeshStandardMaterial({ color: c.wheel, roughness: 0.55, metalness: 0 });
  const geos: THREE.BufferGeometry[] = [];
  const keep = <G extends THREE.BufferGeometry>(g: G) => (geos.push(g), g);
  const root = new THREE.Group();
  root.name = 'skateboard';
  const deck = new THREE.Mesh(keep(deckGeometry(look)), deckMat);
  deck.castShadow = deck.receiveShadow = true;
  root.add(deck);
  const plate = keep(new THREE.BoxGeometry(0.056, 0.008, 0.07));
  const hanger = keep(new THREE.BoxGeometry(0.13, 0.022, 0.03));
  const yoke = keep(new THREE.CylinderGeometry(0.012, 0.016, 0.05, 8));
  const axle = keep(new THREE.CylinderGeometry(0.004, 0.004, 0.2, 6).rotateZ(Math.PI / 2));
  const wheel = keep(new THREE.CylinderGeometry(R, R, 0.032, 16).rotateZ(Math.PI / 2));
  const hub = keep(new THREE.CylinderGeometry(R * 0.45, R * 0.45, 0.034, 10).rotateZ(Math.PI / 2));
  const hubMat = new THREE.MeshStandardMaterial({ color: 0x3a3b3f, roughness: 0.5, metalness: 0.4 });
  const axles: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const z = side * TRUCK_Z;
    const p = new THREE.Mesh(plate, metal);
    p.position.set(0, UNDER - 0.004, z);
    const y = new THREE.Mesh(yoke, metal);
    y.position.set(0, UNDER - 0.03, z - side * 0.006);
    const h = new THREE.Mesh(hanger, metal);
    h.position.set(0, R + 0.012, z);
    const a = new THREE.Mesh(axle, metal);
    a.position.set(0, R, z);
    for (const m of [p, y, h, a]) {
      m.castShadow = true;
      root.add(m);
    }
    const spin = new THREE.Group();
    spin.position.set(0, R, z);
    for (const x of [0.085, -0.085]) {
      const w = new THREE.Mesh(wheel, wheelMat);
      w.position.x = x;
      w.castShadow = true;
      // A darker core so the spin reads.
      const hb = new THREE.Mesh(hub, hubMat);
      hb.position.x = x;
      hb.scale.set(1, 1, 0.6);
      spin.add(w, hb);
    }
    root.add(spin);
    axles.push(spin);
  }
  const materials = [deckMat, metal, wheelMat, hubMat];
  return {
    root, axles, materials,
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of materials) m.dispose();
    },
  };
}

interface View {
  id: number;
  look: number;
  model: BoardModel;
  probe: DynamicProbe;
  /** Drawn pose (eases to a new spot after a hop on or off). */
  pos: THREE.Vector3;
  yaw: number;
  flip: number;
  /** 0..1 easing from the old pose after the board changed hands. */
  ease: number;
  rider: string | null;
  last: THREE.Vector3;
  /** Rolling speed as drawn (m/s, smoothed). */
  speed: number;
  air: boolean;
  airT: number;
  push: number;
  /** Distance to the next sidewalk seam (concrete slabs click under the wheels). */
  seam: number;
  surfaceT: number;
  rough: number;
}

const _q = new THREE.Vector3();

/**
 * The night's skateboards as the simulation has them: lying about (some flipped over), or under
 * a rider's feet (this survivor's own, or another's online), with spinning wheels, the deck
 * popping up for an ollie and leaning into carves, and the sounds of all that: wheels rolling
 * (seams clicking on sidewalks), kicks, pops, landings, hopping on and off, bails.
 */
export class SkateboardView {
  private readonly root = new THREE.Group();
  private readonly views = new Map<number, View>();
  private readonly rolls: { id: number; pos: THREE.Vector3; speed: number; rough: number }[] = [];

  constructor(scene: THREE.Scene, private readonly field: LightField, private readonly physics: Physics) {
    this.root.name = 'skateboards';
    scene.add(this.root);
  }

  update(dt: number, sim: Simulation, camera: THREE.Camera, poseOf: (b: Skateboard) => BoardPose | null): void {
    const seen = new Set<number>();
    this.rolls.length = 0;
    for (const b of sim.skateboards.boards) {
      if (!b) continue;
      seen.add(b.id);
      let v = this.views.get(b.id);
      if (!v || v.look !== b.look) {
        if (v) this.remove(b.id);
        v = this.create(b);
      }
      this.place(v, b, dt, poseOf(b));
      v.probe.update(dt, v.pos, camera, 0.3);
    }
    for (const id of [...this.views.keys()]) if (!seen.has(id)) this.remove(id);
    audio.skateRoll(this.rolls);
  }

  private create(b: Skateboard): View {
    const model = createBoard(b.look);
    const probe = new DynamicProbe(this.field);
    probe.attach(model.materials);
    this.root.add(model.root);
    const v: View = {
      id: b.id, look: b.look, model, probe, pos: new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z), yaw: b.yaw, flip: b.flipped ? 1 : 0,
      ease: 1, rider: b.rider, last: new THREE.Vector3(b.pos.x, b.pos.y, b.pos.z), speed: 0, air: false, airT: 0, push: -1,
      seam: 1.5, surfaceT: 0, rough: 1,
    };
    this.views.set(b.id, v);
    return v;
  }

  private place(v: View, b: Skateboard, dt: number, pose: BoardPose | null): void {
    // Changing hands (hopped on, stepped off): glide from where it was drawn.
    if (b.rider !== v.rider) {
      const was = v.rider;
      v.rider = b.rider;
      v.ease = 0;
      const at = pose?.pos ?? _q.set(b.pos.x, b.pos.y, b.pos.z);
      if (b.rider) audio.skateMount(at);
      else if (was) audio.skateOff(at);
      v.air = false;
      v.push = -1;
    }
    v.ease = Math.min(1, v.ease + dt / 0.18);
    const k = v.ease < 1 ? 1 - Math.exp(-dt * 26) : 1;
    const tx = pose ? pose.pos.x : b.pos.x, ty = pose ? pose.pos.y : b.pos.y, tz = pose ? pose.pos.z : b.pos.z;
    const tyaw = pose ? pose.yaw : b.yaw;
    v.pos.x += (tx - v.pos.x) * k;
    v.pos.y += (ty - v.pos.y) * k;
    v.pos.z += (tz - v.pos.z) * k;
    v.yaw += Math.atan2(Math.sin(tyaw - v.yaw), Math.cos(tyaw - v.yaw)) * (pose && v.ease >= 1 ? 1 : k);
    v.flip += ((b.flipped && !pose ? 1 : 0) - v.flip) * (1 - Math.exp(-dt * 14));
    // Ollie: tail snaps down, nose up, levels out in the air.
    let pitch = 0;
    if (pose && pose.pop >= 0) {
      const t = pose.pop;
      pitch = t < 0.08 ? -0.42 * (t / 0.08) : t < 0.3 ? -0.42 * (1 - (t - 0.08) / 0.22) : 0;
    }
    const roll = pose ? -pose.lean * 0.13 : 0;
    const r = v.model.root;
    // Flipped boards lie on their grip, resting on the nose and tail.
    const flipLift = (SKATEBOARD.deck + KICK_RISE) * v.flip;
    r.position.set(v.pos.x, v.pos.y - (pose ? 0.015 : 0) + flipLift + Math.max(0, -pitch) * (L / 2 - 0.05) * 0.9, v.pos.z);
    r.rotation.order = 'YXZ';
    r.rotation.set(pitch, v.yaw, roll + Math.PI * v.flip);

    // Wheels spin with the distance rolled along the deck.
    const dx = v.pos.x - v.last.x, dz = v.pos.z - v.last.z;
    const along = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
    v.last.copy(v.pos);
    if (Math.abs(along) < 2) for (const a of v.model.axles) a.rotation.x += along / R;
    const inst = dt > 0 && Math.abs(along) < 2 ? Math.abs(along) / dt : 0;
    v.speed += (inst - v.speed) * (1 - Math.exp(-dt * 8));

    if (!pose) {
      v.speed = 0;
      return;
    }
    // Sounds: the kick, the pop and the landing, and the wheels.
    const air = pose.air;
    if (air) v.airT += dt;
    if (!v.air && air && pose.pop >= 0 && pose.pop < 0.15) audio.skatePop(v.pos);
    if (v.air && !air && v.airT > 0.2) audio.skateLand(v.pos, Math.min(1, v.airT / 0.6));
    if (!air) v.airT = 0;
    v.air = air;
    if (v.push >= 0 && pose.push >= SKATEBOARD.pushFrom && v.push < SKATEBOARD.pushFrom) audio.skateKick(v.pos);
    v.push = pose.push;
    v.surfaceT -= dt;
    if (v.surfaceT <= 0) {
      v.surfaceT = 0.25;
      v.rough = this.roughness(v.pos);
    }
    if (!air && v.speed > 0.3) {
      // Sidewalk slabs: a click at every seam.
      if (v.rough < 0.7) {
        v.seam -= Math.abs(along);
        if (v.seam <= 0) {
          v.seam = 1.5;
          audio.skateSeam(v.pos, Math.min(1, v.speed / 7));
        }
      }
      this.rolls.push({ id: v.id, pos: v.pos.clone(), speed: v.speed, rough: v.rough });
    }
  }

  /** How rough the ground under the wheels is: asphalt 1, smooth concrete 0.45, floors 0.25. */
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
    audio.skateRoll([]);
  }
}
