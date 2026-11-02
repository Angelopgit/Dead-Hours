import * as THREE from 'three';

/**
 * Survivors' clothes as lived in, all in the body shader (no textures, no extra draw calls):
 * creases where cloth bunches (inside the elbows, behind the knees, under the arms, above the
 * belt, in the lap, stacked at cuffs and hems), pale wear where it rubs (knees, elbows, seat,
 * shoulders), and a night's dirt and blood that build up on them (Humanoid.grime). Plus a faint
 * rim and fill for every body (Humanoid's patchWounds), so they read against the dark.
 *
 * Like the zombie decay, it is all placed in bind-pose space (the body as built, standing at the
 * origin facing +Z): hips 0.95, belt 1.03, elbows 1.20, wrists 0.91, knees 0.47, ankles 0.03.
 */

/** Per-body shading uniforms. */
export interface BodyShading {
  /** x: dirt 0..1, y: blood 0..1, z: per-body noise seed (survivors only). */
  uGrime: { value: THREE.Vector4 };
  /** rgb: rim light (linear, at the silhouette's edge), w: flat fill (times the albedo). */
  uRim: { value: THREE.Vector4 };
}

/** Rim and fill, shared by every body of a kind (tune here). Zombies get far less: they should loom. */
export const RIM = {
  survivor: new THREE.Vector4(0.075, 0.085, 0.11, 0.012),
  zombie: new THREE.Vector4(0.028, 0.032, 0.042, 0.004),
};

/** Fragment declarations for survivors (zombies declare the same noise in DECAY_COMMON). */
export const SURVIVOR_COMMON = /* glsl */ `
  precision highp sampler3D;
  uniform sampler3D uZNoise;
  uniform vec4 uGrime;
  vec4 zN(vec3 x) { return texture(uZNoise, x * 0.125); }
  // 1 along a crease once per unit of t, falling off over w of the period either side.
  float sCrease(float t, float w) { return 1.0 - smoothstep(0.0, w, abs(fract(t) - 0.5) * 2.0); }
`;

/** Fragment body (after the fabric patterns, before the wounds): folds, wear, dirt and blood. */
export const SURVIVOR_WEAR = /* glsl */ `
  {
    vec3 q = vWoundP;
    vec3 n = normalize(vPatN);
    float bn = vBone + 0.5;
    float arm = step(3.0, bn) * step(bn, 7.0);
    float leg = step(7.0, bn);
    float torso = step(bn, 2.0);
    float head = step(2.0, bn) * step(bn, 3.0);
    // Forearms and shins (odd bones are upper arms and thighs).
    float lower = (1.0 - torso - head) * (1.0 - mod(floor(bn), 2.0));
    float skin = step(0.5, vZSurf) * (1.0 - step(1.5, vZSurf));
    float front = smoothstep(-0.2, 0.6, n.z);
    float rear = smoothstep(-0.2, 0.6, -n.z);
    float e = q.y - 1.2;
    float kn = q.y - 0.47;
    vec4 nz = zN(q * vec3(7.0, 3.0, 7.0) + uGrime.z);
    if (vZSurf < 0.5) {
      float wob = (nz.x - 0.5) * 0.9;
      float crease = 0.0;
      // Inside the elbows, a few slanting creases.
      crease += arm * front * (1.0 - smoothstep(0.02, 0.075, abs(e))) * sCrease(e * 38.0 + q.z * 6.0 + wob, 0.32);
      // Sleeves bunched above the cuff.
      crease += arm * lower * step(0.93, q.y) * (1.0 - smoothstep(0.0, 0.09, q.y - 0.95)) * sCrease(q.y * 52.0 + wob * 1.4, 0.26) * 0.8;
      // Under the arms, fanning down toward the chest.
      crease += torso * (1.0 - smoothstep(0.0, 0.09, abs(q.y - 1.37))) * smoothstep(0.08, 0.15, abs(q.x)) * sCrease((q.y - abs(q.x) * 0.9) * 34.0 + wob, 0.3) * 0.8;
      // A soft diagonal pull across the chest and back.
      crease += torso * step(1.1, q.y) * (1.0 - smoothstep(1.3, 1.44, q.y)) * smoothstep(0.6, 0.95, sin((q.y + abs(q.x) * 0.7) * 26.0 + nz.y * 3.0)) * 0.3;
      // Bunched above the belt.
      crease += torso * (1.0 - smoothstep(0.0, 0.045, abs(q.y - 1.085))) * sCrease(q.y * 70.0 + sin(q.x * 25.0) * 0.6 + wob, 0.3) * 0.5;
      // Behind the knees, in the lap, and trousers stacked on the shoes.
      crease += leg * rear * (1.0 - smoothstep(0.02, 0.08, abs(kn))) * sCrease(kn * 40.0 + q.x * 5.0 + wob, 0.32);
      crease += leg * front * (1.0 - smoothstep(0.0, 0.07, abs(q.y - 0.84))) * sCrease((q.y + abs(q.x) * 1.1) * 30.0 + wob, 0.3) * 0.6;
      crease += leg * lower * step(0.1, q.y) * (1.0 - smoothstep(0.17, 0.26, q.y)) * sCrease(q.y * 45.0 + nz.z * 2.0, 0.3) * 0.7;

      // Rubbed pale: knees, elbows, seat, shoulders, cuffs.
      float wear = leg * front * (1.0 - smoothstep(0.03, 0.1, abs(kn)));
      wear += arm * rear * (1.0 - smoothstep(0.03, 0.09, abs(e)));
      wear += (torso + leg * (1.0 - lower)) * rear * smoothstep(0.76, 0.84, q.y) * (1.0 - smoothstep(0.95, 1.0, q.y));
      wear += torso * smoothstep(0.3, 0.8, n.y) * smoothstep(1.42, 1.5, q.y);
      wear += arm * lower * step(0.92, q.y) * (1.0 - smoothstep(0.93, 0.98, q.y));
      wear = clamp(wear, 0.0, 1.0) * smoothstep(0.3, 0.75, nz.y);

      vec3 c = diffuseColor.rgb;
      float luma = dot(c, vec3(0.3, 0.59, 0.11));
      c = mix(c, mix(c, vec3(luma), 0.35) * 1.3 + 0.012, wear * 0.55);
      diffuseColor.rgb = c * (1.0 - clamp(crease, 0.0, 1.0) * 0.32);
    }

    // Dirt: up from the feet (higher as the night goes on), knees, hands, then smudges anywhere.
    float g = clamp(0.12 + uGrime.x, 0.0, 1.2);
    vec4 dn = zN(q * vec3(4.0, 2.5, 4.0) + 3.7 + uGrime.z);
    float dirt = 1.0 - smoothstep(0.02, 0.12 + 0.4 * g, q.y + (dn.x - 0.5) * 0.12);
    dirt = max(dirt, leg * front * (1.0 - smoothstep(0.03, 0.11, abs(kn))) * g);
    dirt = max(dirt, arm * lower * skin * (1.0 - smoothstep(0.86, 1.0, q.y)) * g * 0.9);
    dirt = max(dirt, smoothstep(0.8 - 0.2 * g, 0.9 - 0.2 * g, dn.w) * g * 0.8);
    // Patchy, splashed: never an even wash. Faces only smudged (heavier reads as a beard).
    float spl = zN(q * 23.0 + 5.0).x;
    dirt *= smoothstep(0.32, 0.58, dn.y * 0.6 + spl * 0.4 + 0.08 * g) * (1.0 - step(1.5, vZSurf) * 0.5) * (1.0 - head * 0.65);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.1, 0.072, 0.045) * (0.7 + 0.6 * dn.z), clamp(dirt, 0.0, 1.0) * 0.62);

    // Blood: flecks, then smears, over the chest, forearms and hands, shins and face.
    float b = uGrime.y;
    if (b > 0.002) {
      vec4 bq = zN(q * 34.0 + 11.0 + uGrime.z);
      float cluster = zN(q * 6.0 + uGrime.z * 1.7).x;
      float region = torso * smoothstep(0.0, 0.5, n.z) * step(0.95, q.y) + arm * lower + leg * lower * front + head * front * 0.7;
      float fleck = smoothstep(1.0 - b * 0.45, 1.02 - b * 0.45, bq.x * 0.6 + cluster * 0.55);
      float smear = smoothstep(0.78 - 0.3 * b, 0.82 - 0.3 * b, cluster) * smoothstep(0.3, 0.6, b) * (1.0 - head);
      float m = clamp(region, 0.0, 1.0) * max(fleck, smear);
      vec3 bc = skin > 0.5 ? vec3(0.2, 0.012, 0.01) : vec3(0.075, 0.006, 0.005);
      diffuseColor.rgb = mix(diffuseColor.rgb, bc * (0.7 + 0.6 * bq.y), m * 0.92);
      zWet = max(zWet, m * 0.3);
    }
  }
`;
