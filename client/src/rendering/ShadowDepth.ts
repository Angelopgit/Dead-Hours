import * as THREE from 'three';

/**
 * Shadow maps are depth only. three draws them into a target that also has a color buffer (only
 * the variance shadow type reads it; this game's PCF shadows sample the depth texture), so every
 * caster also wrote a packed depth color into a 4096² buffer nothing reads. Turning color writes
 * off for the depth materials leaves the shadow maps exactly as they were and lets the GPU take its
 * depth-only fast path. Set as each caster is drawn (three hands over its depth material just before),
 * so the per-object material variants three makes on the fly are covered too; `colorWrite` is not
 * part of a program, so nothing recompiles.
 */
const proto = THREE.Object3D.prototype;
const previous = proto.onBeforeShadow;
proto.onBeforeShadow = function (this: THREE.Object3D, ...args: Parameters<THREE.Object3D['onBeforeShadow']>) {
  args[5].colorWrite = false;
  previous.apply(this, args);
};
