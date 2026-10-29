import * as THREE from 'three';

export interface HumanoidLook {
  skin: number;
  top: number;
  pants: number;
  shoes: number;
  hair?: number;
  /** Zombies: hunched posture, reaching arms, limp. */
  zombie?: boolean;
  /** Optional accessory color (backpack / vest). */
  vest?: number;
}

export interface LocomotionState {
  /** Horizontal speed in m/s. */
  speed: number;
  /** 0 standing .. 1 fully crouched. */
  crouch: number;
  /** 0..1 aim pose blend. */
  aim: number;
  grounded: boolean;
  /** Body-relative lateral velocity sign for strafing lean (-1..1). */
  strafe: number;
}

type Limb = { upper: THREE.Group; lower: THREE.Group };

function part(g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Low-poly segmented character with a procedural animation system
 * (idle, walk, run, crouch, aim, airborne) blended from a single locomotion state.
 */
export class Humanoid {
  readonly root = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly armL: Limb;
  private readonly armR: Limb;
  private readonly legL: Limb;
  private readonly legR: Limb;
  private phase = Math.random() * 10;
  private smoothed: LocomotionState = { speed: 0, crouch: 0, aim: 0, grounded: true, strafe: 0 };
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  /** Fired at each foot plant with a 0..1 loudness. */
  onFootstep: ((loudness: number) => void) | null = null;
  private lastStepSign = 0;
  private readonly zombie: boolean;
  private readonly seed = Math.random() * 100;

  constructor(look: HumanoidLook) {
    this.zombie = !!look.zombie;
    const mat = (c: number, r = 0.85) => {
      const m = new THREE.MeshStandardMaterial({ color: c, roughness: r, flatShading: true });
      this.materials.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T) => {
      this.geometries.push(g);
      return g;
    };
    const skin = mat(look.skin, 0.7);
    const top = mat(look.top);
    const pants = mat(look.pants);
    const shoes = mat(look.shoes, 0.6);

    this.root.add(this.hips);
    this.hips.position.y = 0.95;

    const pelvis = part(geo(new THREE.CylinderGeometry(0.17, 0.15, 0.2, 6)), pants);
    pelvis.scale.z = 0.7;
    this.hips.add(pelvis);

    this.hips.add(this.spine);
    this.spine.position.y = 0.08;
    const torso = part(geo(new THREE.CylinderGeometry(0.21, 0.16, 0.56, 6)), top);
    torso.position.y = 0.3;
    torso.scale.z = 0.62;
    this.spine.add(torso);
    if (look.vest !== undefined) {
      const vest = part(geo(new THREE.BoxGeometry(0.34, 0.4, 0.12)), mat(look.vest, 0.9));
      vest.position.set(0, 0.32, -0.15);
      this.spine.add(vest);
    }

    this.spine.add(this.head);
    this.head.position.y = 0.64;
    const neck = part(geo(new THREE.CylinderGeometry(0.055, 0.065, 0.12, 5)), skin);
    neck.position.y = -0.04;
    this.head.add(neck);
    const skull = part(geo(new THREE.IcosahedronGeometry(0.13, 1)), skin);
    skull.scale.set(0.9, 1.08, 1);
    skull.position.y = 0.12;
    this.head.add(skull);
    if (look.hair !== undefined) {
      const hair = part(geo(new THREE.IcosahedronGeometry(0.135, 1)), mat(look.hair, 0.95));
      hair.scale.set(0.95, 0.75, 1.02);
      hair.position.set(0, 0.18, -0.015);
      this.head.add(hair);
    }
    if (this.zombie) {
      const eye = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xc8d27a, emissiveIntensity: 1.2 });
      this.materials.push(eye);
      for (const ex of [-0.045, 0.045]) {
        const e = new THREE.Mesh(geo(new THREE.SphereGeometry(0.014, 4, 3)), eye);
        e.position.set(ex, 0.13, 0.12);
        this.head.add(e);
      }
    }

    const makeLimb = (parent: THREE.Object3D, x: number, y: number, upperLen: number, lowerLen: number, r0: number, r1: number, mUpper: THREE.Material, mLower: THREE.Material, end: THREE.Mesh | null): Limb => {
      const upper = new THREE.Group();
      upper.position.set(x, y, 0);
      parent.add(upper);
      const u = part(geo(new THREE.CylinderGeometry(r0, r1, upperLen, 6)), mUpper);
      u.position.y = -upperLen / 2;
      upper.add(u);
      const lower = new THREE.Group();
      lower.position.y = -upperLen;
      upper.add(lower);
      const l = part(geo(new THREE.CylinderGeometry(r1, r1 * 0.85, lowerLen, 6)), mLower);
      l.position.y = -lowerLen / 2;
      lower.add(l);
      if (end) {
        end.position.y = -lowerLen;
        lower.add(end);
      }
      return { upper, lower };
    };
    const hand = () => {
      const h = part(geo(new THREE.BoxGeometry(0.07, 0.09, 0.05)), skin);
      h.position.y -= 0.04;
      return h;
    };
    const foot = () => {
      const f = part(geo(new THREE.BoxGeometry(0.1, 0.08, 0.24)), shoes);
      f.geometry.translate(0, -0.04, 0.05);
      return f;
    };
    const sleeve = this.zombie ? skin : top;
    this.armL = makeLimb(this.spine, -0.25, 0.54, 0.29, 0.27, 0.055, 0.045, top, sleeve, hand());
    this.armR = makeLimb(this.spine, 0.25, 0.54, 0.29, 0.27, 0.055, 0.045, top, sleeve, hand());
    this.legL = makeLimb(this.hips, -0.1, -0.04, 0.44, 0.44, 0.08, 0.06, pants, pants, foot());
    this.legR = makeLimb(this.hips, 0.1, -0.04, 0.44, 0.44, 0.08, 0.06, pants, pants, foot());
  }

  update(dt: number, target: LocomotionState): void {
    const s = this.smoothed;
    const k = 1 - Math.exp(-dt * 10);
    s.speed += (target.speed - s.speed) * k;
    s.crouch += (target.crouch - s.crouch) * k;
    s.aim += (target.aim - s.aim) * (1 - Math.exp(-dt * 14));
    s.strafe += (target.strafe - s.strafe) * k;
    s.grounded = target.grounded;

    const speed = s.speed;
    const run = THREE.MathUtils.smoothstep(speed, 3.6, 6);
    const moving = THREE.MathUtils.smoothstep(speed, 0.1, 1.0);
    const strideFreq = this.zombie ? 0.9 + speed * 0.55 : 1.35 + speed * 0.32;
    this.phase += dt * strideFreq * Math.PI * 2 * (moving > 0.01 ? 1 : 0.25);
    const p = this.phase;
    const sin = Math.sin(p);
    const cos = Math.cos(p);

    const legAmp = (0.42 + run * 0.35) * moving;
    const kneeAmp = (0.55 + run * 0.6) * moving;
    const armAmp = (0.35 + run * 0.6) * moving;
    const crouch = s.crouch;

    // Hips bob and crouch.
    const bob = Math.abs(cos) * 0.045 * moving * (1 + run);
    this.hips.position.y = 0.95 - crouch * 0.33 + bob - (this.zombie ? 0.04 : 0);
    const lean = run * 0.22 + moving * 0.05 + crouch * 0.35;
    this.spine.rotation.x = lean + (this.zombie ? 0.28 : 0) - s.aim * 0.05;
    this.spine.rotation.z = -s.strafe * 0.06 * moving;
    this.spine.rotation.y = (this.zombie ? Math.sin(p * 0.5) * 0.1 : sin * 0.08 * moving) + s.aim * 0.12;
    this.hips.rotation.y = -sin * 0.1 * moving;

    // Legs.
    const limp = this.zombie ? 0.55 : 1;
    this.legL.upper.rotation.x = -sin * legAmp - crouch * 0.9;
    this.legR.upper.rotation.x = sin * legAmp * limp - crouch * 0.9;
    this.legL.lower.rotation.x = Math.max(0, cos) * kneeAmp + crouch * 1.5 + (s.grounded ? 0 : 0.6);
    this.legR.lower.rotation.x = Math.max(0, -cos) * kneeAmp * limp + crouch * 1.5 + (s.grounded ? 0 : 0.3);
    if (!s.grounded) {
      this.legL.upper.rotation.x -= 0.5;
      this.legR.upper.rotation.x += 0.1;
    }

    // Arms.
    if (this.zombie) {
      const reach = 1.25 + Math.sin(p * 0.7 + this.seed) * 0.12;
      this.armL.upper.rotation.set(-reach + sin * 0.1, 0, 0.12);
      this.armR.upper.rotation.set(-reach * 0.9 - sin * 0.1, 0, -0.1);
      this.armL.lower.rotation.x = -0.25;
      this.armR.lower.rotation.x = -0.4;
      this.head.rotation.set(0.15 + Math.sin(p * 0.3) * 0.1, Math.sin(p * 0.21 + this.seed) * 0.3, 0.25 * Math.sin(this.seed));
    } else {
      const aim = s.aim;
      const swingL = sin * armAmp;
      const swingR = -sin * armAmp;
      // Ready/aim pose: both hands forward at chest height.
      this.armL.upper.rotation.x = THREE.MathUtils.lerp(swingL - crouch * 0.2, -1.25, aim);
      this.armR.upper.rotation.x = THREE.MathUtils.lerp(swingR - crouch * 0.2, -1.35, aim);
      this.armL.upper.rotation.z = THREE.MathUtils.lerp(0.08, -0.45, aim);
      this.armR.upper.rotation.z = THREE.MathUtils.lerp(-0.08, 0.15, aim);
      this.armL.lower.rotation.x = THREE.MathUtils.lerp(-0.25 - run * 0.9, -0.6, aim);
      this.armR.lower.rotation.x = THREE.MathUtils.lerp(-0.25 - run * 0.9, -0.3, aim);
      const breathe = Math.sin(performance.now() * 0.0018 + this.seed) * 0.02 * (1 - moving);
      this.head.rotation.set(-lean * 0.6 + breathe, -this.spine.rotation.y * 0.7, 0);
    }

    // Footstep events at each plant.
    const sign = Math.sign(sin);
    if (sign !== this.lastStepSign && moving > 0.3 && s.grounded) {
      this.onFootstep?.(Math.min(1, speed / 6) * (1 - crouch * 0.6));
    }
    this.lastStepSign = sign;
  }

  setVisible(v: boolean): void {
    this.root.visible = v;
  }

  /** Surface materials, for lighting patches (light probes). */
  surfaces(): THREE.Material[] {
    return this.materials;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}

export const SURVIVOR_LOOKS: HumanoidLook[] = [
  { skin: 0xb08a6e, top: 0x3a4a3a, pants: 0x2b2f38, shoes: 0x1c1a18, hair: 0x2a1f17, vest: 0x4a3c2a },
  { skin: 0x8a6248, top: 0x5a3a2a, pants: 0x32363c, shoes: 0x222020, hair: 0x111111, vest: 0x2f3a2b },
  { skin: 0xc9a385, top: 0x2f3e52, pants: 0x3a3a33, shoes: 0x1c1a18, hair: 0x6b4a2a },
  { skin: 0x6e4a36, top: 0x4b4b4b, pants: 0x2a2a2e, shoes: 0x161616, hair: 0x0d0d0d, vest: 0x3a3226 },
];

export function zombieLook(i: number): HumanoidLook {
  const skins = [0x7d8a72, 0x8b8a76, 0x6f7a6a, 0x948f7e];
  const tops = [0x4a3f3a, 0x3c4450, 0x5a4a3a, 0x3a3a35, 0x6a5a50];
  const pants = [0x2e3138, 0x3b3530, 0x2a2c2a];
  return { skin: skins[i % skins.length], top: tops[(i * 3) % tops.length], pants: pants[i % pants.length], shoes: 0x1a1816, hair: i % 2 ? 0x2a241f : undefined, zombie: true };
}
