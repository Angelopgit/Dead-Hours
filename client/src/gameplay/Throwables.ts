import * as THREE from 'three';
import {
  FIRE, SHELL, THROWABLES, THROWING, VOLATILE_STAGE, flightStep, throwLaunch,
  type SimEvent, type Simulation, type ThrowKind, type Vec3,
} from '@dead-hours/shared';
import type { Physics } from '../core/Physics';
import type { Pyro } from '../effects/Pyro';
import { createThrowableModel, type ThrowableModel } from '../weapons/ThrowableModels';
import { audio } from '../audio/AudioEngine';

/** The simulation smashes any window pane a throw meets fast enough: the copy here flies on through it too. */
const throughGlass = (): boolean => true;

interface Flying {
  id: number;
  kind: ThrowKind;
  model: ThrowableModel;
  f: { pos: Vec3; vel: Vec3; rest: boolean };
  spin: THREE.Vector3;
  born: number;
  /** Bounce sounds come from the server's events; locally the flight only draws. */
  lastClank: number;
  /** A launcher's 40 mm round: flies flat and fast, gone where it bursts. */
  shell: boolean;
}

const ARC_POINTS = 90;
const ARC_DT = 1 / 30;
const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _w = new THREE.Vector3(), _m = new THREE.Matrix4();

/**
 * Grenades and Molotovs on the client: the aiming arc while the key is held (the same launch and
 * flight the simulation uses, so it lands where it shows), each throw flying from the events
 * (corrected at every bounce the server reports), and the explosions and fires they end in.
 */
export class Throwables {
  private readonly flying = new Map<number, Flying>();
  /** Glowing beads along the path (an instanced mesh: lines and points are 1 px or unsupported on some GPUs). */
  private readonly arc: THREE.InstancedMesh;
  private readonly arcMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.6, 1.2, 0.6), transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false, fog: false });
  private readonly arcPos = new Float32Array(ARC_POINTS * 3);
  private readonly marker: THREE.Mesh;
  private readonly markerMat: THREE.ShaderMaterial;
  private time = 0;
  /** What the held key is getting ready to throw. */
  priming: ThrowKind | null = null;

  constructor(private readonly scene: THREE.Scene, private readonly physics: Physics, private readonly pyro: Pyro) {
    this.arc = new THREE.InstancedMesh(new THREE.SphereGeometry(0.045, 8, 6), this.arcMat, ARC_POINTS);
    this.arc.count = 0;
    this.arc.frustumCulled = false;
    this.arc.renderOrder = 20;
    this.arc.visible = false;
    this.markerMat = new THREE.ShaderMaterial({
      uniforms: { uT: { value: 0 }, uColor: { value: new THREE.Color(1.6, 1.2, 0.6) } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uT; uniform vec3 uColor; varying vec2 vUv;
        void main() {
          float r = length(vUv - 0.5) * 2.0;
          float ring = smoothstep(0.82, 0.9, r) * (1.0 - smoothstep(0.94, 1.0, r));
          float pulse = smoothstep(0.0, 0.08, abs(r - fract(uT * 0.8))) ;
          float inner = (1.0 - smoothstep(0.0, 0.25, abs(r - fract(uT * 0.8)))) * 0.35 * (1.0 - r);
          float a = ring * 0.9 + inner * (1.0 - pulse * 0.0);
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.marker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.markerMat);
    this.marker.renderOrder = 19;
    this.marker.visible = false;
    scene.add(this.arc, this.marker);
  }

  /**
   * The aiming arc for a throw from `eye` along `dir` (null hides it): flies the throw ahead
   * of time and rings where it will land (the frag's blast radius, the Molotov's spill).
   */
  aim(kind: ThrowKind | null, eye: Vec3, dir: Vec3, yaw: number, carry: Vec3): void {
    if (!kind) {
      this.arc.visible = false;
      this.marker.visible = false;
      return;
    }
    const def = THROWABLES[kind];
    const launch = throwLaunch(this.physics, eye, dir, yaw, kind, carry);
    const f = { pos: launch.pos, vel: launch.vel, rest: false };
    const out = this.arcPos;
    let n = 0;
    const put = () => {
      out[n * 3] = f.pos.x; out[n * 3 + 1] = f.pos.y; out[n * 3 + 2] = f.pos.z;
      n++;
    };
    put();
    let landed: { x: number; y: number; z: number } | null = null;
    let t = 0;
    while (n < ARC_POINTS) {
      // Thrown hard enough it goes through a window (the simulation smashes the pane).
      const hit = flightStep(this.physics, f, def, ARC_DT, throughGlass);
      t += ARC_DT;
      put();
      // A Molotov breaks on the first hard knock; a frag's arc shows its first landing.
      if (hit) {
        landed = { ...f.pos };
        break;
      }
      if (t > THROWING.maxFlight) break;
    }
    for (let i = n; i < ARC_POINTS; i++) {
      out[i * 3] = f.pos.x; out[i * 3 + 1] = f.pos.y; out[i * 3 + 2] = f.pos.z;
    }
    // Beads, every other step, swelling and dimming in a wave that runs out along the arc.
    const m = _m;
    let count = 0;
    for (let i = 2; i < n; i += 2) {
      const pulse = 0.75 + 0.25 * Math.sin(i * 0.45 - this.time * 9);
      m.makeScale(pulse, pulse, pulse).setPosition(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]);
      this.arc.setMatrixAt(count++, m);
    }
    this.arc.count = count;
    this.arc.instanceMatrix.needsUpdate = true;
    this.arc.visible = true;
    const color = kind === 'frag' ? [1.3, 1.25, 0.9] : [2.2, 0.9, 0.25];
    this.arcMat.color.setRGB(color[0], color[1], color[2]);
    this.markerMat.uniforms.uColor.value.setRGB(color[0], color[1], color[2]);
    if (landed) {
      this.marker.visible = true;
      this.marker.position.set(landed.x, landed.y + 0.04, landed.z);
      this.marker.scale.setScalar(kind === 'frag' ? 2 * 2.4 : 2 * FIRE.spread * 0.6);
    } else {
      this.marker.visible = false;
    }
  }

  /** The events about throws, explosions and fire (true when handled). */
  onEvent(e: SimEvent, sim: Simulation, handOf: (player: string, out: THREE.Vector3) => THREE.Vector3): boolean {
    switch (e.type) {
      case 'throwStart':
        audio.throwReady(e.kind, handOf(e.player, _v));
        return true;
      case 'thrown': {
        this.flying.get(e.id)?.model.dispose();
        const model = createThrowableModel(e.kind);
        this.scene.add(model.root);
        model.root.position.set(e.pos.x, e.pos.y, e.pos.z);
        const shell = !!e.shell;
        // A launched round spins about the way it flies (rifling), a thrown one tumbles.
        const spin = shell ? new THREE.Vector3(e.vel.x, e.vel.y, e.vel.z).normalize().multiplyScalar(30)
          : new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(e.kind === 'frag' ? 14 : 9);
        if (shell) model.root.scale.setScalar(0.85);
        this.flying.set(e.id, { id: e.id, kind: e.kind, model, f: { pos: { ...e.pos }, vel: { ...e.vel }, rest: false }, spin, born: this.time, lastClank: 0, shell });
        if (!shell) audio.throwWhoosh(_v.set(e.pos.x, e.pos.y, e.pos.z));
        return true;
      }
      case 'bounce': {
        const fl = this.flying.get(e.id);
        if (fl) {
          fl.f.pos = { ...e.pos };
          fl.f.vel = { ...e.vel };
          fl.f.rest = e.speed === 0 && Math.hypot(e.vel.x, e.vel.y, e.vel.z) < 0.05;
          fl.spin.multiplyScalar(0.55);
          if (e.speed > 0) audio.thrownBounce(fl.kind, e.surface, _v.set(e.pos.x, e.pos.y, e.pos.z), e.speed);
        }
        return true;
      }
      case 'explosion': {
        this.drop(e.id);
        const p = new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z);
        this.pyro.explosion(p, e.power ?? 1, e.kind === 'fuel');
        audio.explosion(p);
        return true;
      }
      case 'fire': {
        this.drop(e.id);
        const p = new THREE.Vector3(e.pos.x, e.pos.y, e.pos.z);
        // A bottle breaking, or fuel from something that blew up (no glass, and the blast was heard already).
        if (!e.spill) this.pyro.shatter(p, new THREE.Vector3(e.ground.x, e.ground.y, e.ground.z));
        this.pyro.fire(e.id, e.patches.map(([x, y, z, r]) => ({ x, y, z, r })), e.start, e.end);
        if (!e.spill) audio.molotov(p);
        return true;
      }
      case 'volatile': {
        // A car, a pump or a drum: the whoosh as it catches, torn metal as it goes up (Wrecks draws the rest).
        const p = _v.set(e.pos.x, e.pos.y, e.pos.z);
        if (e.stage === VOLATILE_STAGE.burning) audio.ignite(p);
        else if (e.stage === VOLATILE_STAGE.blown) audio.impact('metal', p);
        return true;
      }
      case 'ignite': {
        const z = sim.zombie(e.zombie);
        if (z) audio.ignite(_v.set(z.pos.x, z.pos.y + 1, z.pos.z));
        return true;
      }
    }
    return false;
  }

  private drop(id: number): void {
    const fl = this.flying.get(id);
    if (!fl) return;
    fl.model.dispose();
    this.flying.delete(id);
  }

  update(dt: number): void {
    this.time += dt;
    this.markerMat.uniforms.uT.value = this.time;
    if (dt <= 0) return;
    for (const fl of this.flying.values()) {
      // Lost its ending (a missed event): gone after any throw would have ended.
      if (this.time - fl.born > THROWING.fuse + THROWING.maxFlight) {
        this.drop(fl.id);
        continue;
      }
      const def = fl.shell ? SHELL : THROWABLES[fl.kind];
      // Small steps so it bounces where the simulation's does.
      const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
      for (let i = 0; i < steps; i++) {
        const hit = flightStep(this.physics, fl.f, def, dt / steps, throughGlass);
        if (hit && (fl.kind === 'molotov' || fl.shell)) fl.f.rest = true;
      }
      // It burst where it struck: the blast (the next event) takes it away.
      if (fl.shell && fl.f.rest) fl.model.root.visible = false;
      const r = fl.model.root;
      r.position.set(fl.f.pos.x, fl.f.pos.y, fl.f.pos.z);
      const speed = Math.hypot(fl.f.vel.x, fl.f.vel.y, fl.f.vel.z);
      if (!fl.f.rest && speed > 0.2) {
        const w = fl.spin.length() * Math.min(1, speed / 3);
        _q.setFromAxisAngle(_w.copy(fl.spin).normalize(), w * dt);
        r.quaternion.premultiply(_q);
      }
      r.updateMatrixWorld(true);
      if (fl.kind === 'molotov') {
        r.localToWorld(_v.copy(fl.model.wick));
        this.pyro.rag(_v, _w.set(fl.f.vel.x, fl.f.vel.y, fl.f.vel.z));
      }
    }
  }

  get count(): number {
    return this.flying.size;
  }

  clear(): void {
    for (const fl of this.flying.values()) fl.model.dispose();
    this.flying.clear();
    this.arc.visible = false;
    this.marker.visible = false;
  }

  dispose(): void {
    this.clear();
    this.arc.removeFromParent();
    this.arc.geometry.dispose();
    this.arcMat.dispose();
    this.marker.removeFromParent();
    this.marker.geometry.dispose();
    this.markerMat.dispose();
  }
}
