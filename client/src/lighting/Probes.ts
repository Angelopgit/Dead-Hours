import * as THREE from 'three';
import type { LightField } from './LightField';
import { createProbeUniforms, patchProbe, type ProbeUniforms } from './BakeShader';

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

interface Sample {
  ao: number;
  ambient: THREE.Vector3;
  d0: THREE.Vector3;
  c0: THREE.Vector3;
  d1: THREE.Vector3;
  c1: THREE.Vector3;
  /** Luminance of all direct light reaching the point. */
  direct: number;
}

function emptySample(): Sample {
  return { ao: 1, ambient: new THREE.Vector3(), d0: new THREE.Vector3(0, 1, 0), c0: new THREE.Vector3(), d1: new THREE.Vector3(0, 1, 0), c1: new THREE.Vector3(), direct: 0 };
}

const scratch = { ao: 1, ambient: new Float32Array(3), dirs: [] as { x: number; y: number; z: number; r: number; g: number; b: number }[] };

/** Evaluates the baked light field at a free point. */
export function sampleField(field: LightField, p: THREE.Vector3, out: Sample): Sample {
  field.probe(p.x, p.y, p.z, scratch);
  out.ao = scratch.ao;
  out.ambient.set(scratch.ambient[0], scratch.ambient[1], scratch.ambient[2]);
  const dirs = scratch.dirs.sort((a, b) => lum(b.r, b.g, b.b) - lum(a.r, a.g, a.b));
  out.c0.set(0, 0, 0);
  out.c1.set(0, 0, 0);
  out.direct = 0;
  dirs.forEach((d, i) => {
    out.direct += lum(d.r, d.g, d.b);
    if (i === 0) { out.d0.set(d.x, d.y, d.z); out.c0.set(d.r, d.g, d.b); }
    else if (i === 1) { out.d1.set(d.x, d.y, d.z); out.c1.set(d.r, d.g, d.b); }
    else out.ambient.add(new THREE.Vector3(d.r, d.g, d.b).multiplyScalar(0.25));
  });
  return out;
}

/**
 * Light probe that follows a dynamic object: re-sampled a few times per second and eased so
 * crossing a shadow edge never pops. Directions are converted to view space every frame.
 */
export class DynamicProbe {
  readonly uniforms: ProbeUniforms = createProbeUniforms();
  private readonly target = emptySample();
  private readonly current = emptySample();
  private timer = 0;
  private primed = false;
  private readonly at = new THREE.Vector3();

  constructor(private readonly field: LightField, private readonly interval = 0.12) {}

  attach(materials: THREE.Material[]): void {
    for (const m of materials) patchProbe(m, this.uniforms);
  }

  update(dt: number, position: THREE.Vector3, camera: THREE.Camera, height = 1.2): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = this.interval;
      this.at.copy(position);
      this.at.y += height;
      sampleField(this.field, this.at, this.target);
      if (!this.primed) {
        this.primed = true;
        this.copy(this.target, this.current);
      }
    }
    const k = 1 - Math.exp(-dt * 6);
    const c = this.current, t = this.target;
    c.ao += (t.ao - c.ao) * k;
    c.ambient.lerp(t.ambient, k);
    c.c0.lerp(t.c0, k);
    c.c1.lerp(t.c1, k);
    c.d0.lerp(t.d0, k).normalize();
    c.d1.lerp(t.d1, k).normalize();
    c.direct += (t.direct - c.direct) * k;
    const u = this.uniforms;
    u.uProbeAO.value = c.ao;
    u.uProbeAmbient.value.copy(c.ambient);
    u.uProbeCol0.value.copy(c.c0);
    u.uProbeCol1.value.copy(c.c1);
    u.uProbeDir0.value.copy(c.d0).transformDirection(camera.matrixWorldInverse);
    u.uProbeDir1.value.copy(c.d1).transformDirection(camera.matrixWorldInverse);
  }

  get sample(): Readonly<Sample> {
    return this.current;
  }

  private copy(a: Sample, b: Sample): void {
    b.ao = a.ao;
    b.ambient.copy(a.ambient);
    b.d0.copy(a.d0); b.c0.copy(a.c0);
    b.d1.copy(a.d1); b.c1.copy(a.c1);
    b.direct = a.direct;
  }
}

/**
 * A probe that never moves (doors): sampled once on each side of a plane, and shows whichever
 * side the camera is on, so a door seen from a dark garage isn't lit like the street outside.
 */
export class StaticProbe {
  readonly uniforms: ProbeUniforms = createProbeUniforms();
  private readonly front = emptySample();
  private readonly back = emptySample();
  private shown: Sample | null = null;

  constructor(field: LightField, private readonly center: THREE.Vector3, private readonly normal = new THREE.Vector3(), offset = 0.45) {
    sampleField(field, center.clone().addScaledVector(normal, offset), this.front);
    if (offset > 0 && normal.lengthSq() > 0) sampleField(field, center.clone().addScaledVector(normal, -offset), this.back);
    else this.copyInto(this.front, this.back);
  }

  private copyInto(a: Sample, b: Sample): void {
    b.ao = a.ao; b.ambient.copy(a.ambient); b.d0.copy(a.d0); b.c0.copy(a.c0); b.d1.copy(a.d1); b.c1.copy(a.c1); b.direct = a.direct;
  }

  update(camera: THREE.Camera): void {
    const dx = camera.position.x - this.center.x, dy = camera.position.y - this.center.y, dz = camera.position.z - this.center.z;
    const s = dx * this.normal.x + dy * this.normal.y + dz * this.normal.z >= 0 ? this.front : this.back;
    const u = this.uniforms;
    if (s !== this.shown) {
      this.shown = s;
      u.uProbeAO.value = s.ao;
      u.uProbeAmbient.value.copy(s.ambient);
      u.uProbeCol0.value.copy(s.c0);
      u.uProbeCol1.value.copy(s.c1);
    }
    u.uProbeDir0.value.copy(s.d0).transformDirection(camera.matrixWorldInverse);
    u.uProbeDir1.value.copy(s.d1).transformDirection(camera.matrixWorldInverse);
  }
}

/**
 * Eye adaptation: opens up in dark enclosed spaces (basement, unlit rooms) and closes down a
 * little under strong lights. Driven by a probe at the camera.
 */
export class AutoExposure {
  private readonly probe: DynamicProbe;
  private value = 1;

  constructor(field: LightField) {
    this.probe = new DynamicProbe(field, 0.25);
  }

  update(dt: number, camera: THREE.Camera): number {
    this.probe.update(dt, camera.position, camera, 0);
    const s = this.probe.sample;
    const enclosed = 1 - s.ao;
    const lit = s.direct + lum(s.ambient.x, s.ambient.y, s.ambient.z) * 4;
    const target = THREE.MathUtils.clamp((1 + enclosed * 0.75) / Math.sqrt(1 + lit * 0.06), 0.85, 1.75);
    // Adapting to darkness is slower than adapting to light.
    const rate = target > this.value ? 0.9 : 2.2;
    this.value += (target - this.value) * (1 - Math.exp(-dt * rate));
    return this.value;
  }
}
