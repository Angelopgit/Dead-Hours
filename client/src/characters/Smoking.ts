import * as THREE from 'three';
import type { SmokeKind, SmokeRig } from './Outfit';

/** Where survivors' smoke is drawn: the night's effects, or the character creator's preview. */
export interface SmokeSink {
  /** A wisp curling up off the lit end (world position). */
  wisp(at: THREE.Vector3, kind: SmokeKind): void;
  /**
   * One billow of a breath blown out: from the mouth `at` along `dir` (world, normalized); `k`
   * is 1 as the breath starts and falls toward 0 as it runs out.
   */
  exhale(at: THREE.Vector3, dir: THREE.Vector3, kind: SmokeKind, k: number): void;
}

let sceneSink: SmokeSink | null = null;

/** The sink for bodies that have none of their own (GameSession's effects, while a night runs). */
export function setSceneSmoke(sink: SmokeSink | null): void {
  sceneSink = sink;
}

export function sceneSmoke(): SmokeSink | null {
  return sceneSink;
}

/** Per kind: wisps a second off the lit end, billows in a breath, seconds between drags. */
const HABIT: Record<SmokeKind, { wisps: number; breath: number; every: readonly [number, number] }> = {
  cigarette: { wisps: 4, breath: 9, every: [7, 13] },
  joint: { wisps: 5, breath: 12, every: [6, 11] },
  blunt: { wisps: 6, breath: 14, every: [6, 11] },
};

/** A drag: drawing on it (the tip flares), holding it in, blowing it out (seconds). */
const DRAW = 1.1, HOLD = 0.7, BLOW = 1.1;

/**
 * Ember colour (linear): a dull red smoulder, a hot orange on a drag. Kept small and dim enough
 * that only a drag reaches the bloom knee (see PostFX BLOOM_KNEE): a pinpoint, not a flare.
 */
const COLD = new THREE.Color(0.62, 0.11, 0.03), HOT = new THREE.Color(1.0, 0.38, 0.08);
const SMOULDER = 0.18;

const _v = new THREE.Vector3(), _d = new THREE.Vector3();

/**
 * A lit cigarette, joint or blunt in a survivor's mouth (Outfit draws it; this is its life): the
 * end smoulders and sends up wisps, and every several seconds they take a drag, the tip flares
 * and a moment later they blow the smoke out. Each body keeps its own rhythm; nothing of it is
 * sent online, everyone just sees everyone's smoke.
 */
export class Smoking {
  readonly ember: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  /** Seconds to the next drag, or how far into one (`drag` >= 0). */
  private next = 2 + Math.random() * 3;
  private drag = -1;
  private heat = SMOULDER;
  private wispAcc = Math.random();
  private blowAcc = 0;
  private flicker = Math.random() * 100;

  constructor(private readonly rig: SmokeRig, private readonly head: THREE.Object3D) {
    this.material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.ember = new THREE.Mesh(rig.ember, this.material);
    this.ember.castShadow = false;
    this.ember.name = 'ember';
    head.add(this.ember);
    this.paint();
  }

  get kind(): SmokeKind {
    return this.rig.kind;
  }

  /**
   * `visible`: the head is drawn (not hidden, not collapsed while aiming down sights), so smoke
   * is let out; `alive`: still taking drags (the dead's just smoulders).
   */
  update(dt: number, sink: SmokeSink | null, visible: boolean, alive: boolean): void {
    if (dt <= 0) return;
    const habit = HABIT[this.rig.kind];
    if (this.drag < 0) {
      this.next -= dt;
      if (this.next <= 0 && alive) this.drag = 0;
    } else {
      this.drag += dt;
      if (this.drag > DRAW + HOLD + BLOW) {
        this.drag = -1;
        this.next = habit.every[0] + Math.random() * (habit.every[1] - habit.every[0]);
      }
    }
    const drawing = this.drag >= 0 && this.drag < DRAW;
    this.flicker += dt;
    const f = this.flicker;
    const idle = SMOULDER + 0.05 * Math.sin(f * 7.3) * Math.sin(f * 2.9 + 1.3);
    // Flares fast while drawn on, cools slowly after.
    this.heat += ((drawing ? 1 : idle) - this.heat) * (1 - Math.exp(-dt * (drawing ? 3.2 : 1.1)));
    this.paint();
    if (!sink || !visible) {
      this.wispAcc = 0;
      return;
    }
    // While it is drawn on, the smoke goes into the lungs, not up.
    this.wispAcc += dt * habit.wisps * (drawing ? 0.2 : 1);
    const blowing = this.drag >= DRAW + HOLD;
    if (blowing) this.blowAcc += dt * (habit.breath / BLOW);
    if (this.wispAcc < 1 && this.blowAcc < 1) return;
    this.head.updateWorldMatrix(true, false);
    const m = this.head.matrixWorld;
    while (this.wispAcc >= 1) {
      this.wispAcc -= 1;
      sink.wisp(_v.copy(this.rig.tip).applyMatrix4(m), this.rig.kind);
    }
    if (blowing) {
      const k = 1 - (this.drag - DRAW - HOLD) / BLOW;
      // Blown out ahead of the face, a little down at first.
      _d.set(0, -0.12, 1).transformDirection(m);
      while (this.blowAcc >= 1) {
        this.blowAcc -= 1;
        sink.exhale(_v.copy(this.rig.mouth).applyMatrix4(m), _d, this.rig.kind, k);
      }
    } else {
      this.blowAcc = 0;
    }
  }

  private paint(): void {
    const h = THREE.MathUtils.clamp(this.heat, 0, 1);
    this.material.color.copy(COLD).lerp(HOT, h).multiplyScalar(1.2 + 2.0 * h);
  }

  dispose(): void {
    this.ember.removeFromParent();
    this.rig.ember.dispose();
    this.material.dispose();
  }
}

/** One ember for the night's preload (GameSession.prewarm), so the first smoker compiles nothing. */
export function emberSample(): { root: THREE.Object3D; dispose(): void } {
  const g = new THREE.CylinderGeometry(0.004, 0.004, 0.005, 8);
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const root = new THREE.Mesh(g, m);
  root.position.y = 1.6;
  return { root, dispose: () => { root.removeFromParent(); g.dispose(); m.dispose(); } };
}
