/**
 * Mirror-like wet ground (puddles, soaked asphalt) reflects lamps, fires, flashlights and muzzle
 * flashes almost as bright as the lights themselves: tens of times the bloom threshold (0.9), so
 * the bloom smeared every reflection across the street. Highlights rise as they are up to
 * GLOSS_KNEE, then ease toward GLOSS_CEIL (luminance, linear): the reflection still reads as a
 * bright streak, and only its hottest core just touches the bloom.
 */
export const GLOSS_KNEE = 0.45;
export const GLOSS_CEIL = 1.0;
/**
 * Bodies get the same ceiling on the light falling on them (Humanoid): a burning zombie carries
 * its fire's light a hand's width from its own chest, and anyone walking through a Molotov passes
 * right by the fire's light, so they lit up white. The knee sits higher so ordinary key lights
 * (the character previews) pass untouched.
 */
export const BODY_KNEE = 0.7;

/**
 * `softCeil(c, knee, ceil)`: c as it is up to the knee (luminance), then easing toward the
 * ceiling, keeping its colour. `glossCap(c)`: the wet-ground highlight under its ceiling.
 */
export const GLOSS_CAP_GLSL = /* glsl */ `
  #ifndef GLOSS_CAP
  #define GLOSS_CAP
  vec3 softCeil(vec3 c, float knee, float ceil) {
    float m = dot(c, vec3(0.2126, 0.7152, 0.0722));
    if (m <= knee) return c;
    float span = ceil - knee;
    return c * ((knee + span * (1.0 - exp(-(m - knee) / span))) / m);
  }
  vec3 glossCap(vec3 c) { return softCeil(c, ${GLOSS_KNEE.toFixed(3)}, ${GLOSS_CEIL.toFixed(3)}); }
  #endif
`;

/** The same curve on the CPU (checks). */
export function softCeil(lum: number, knee = GLOSS_KNEE, ceil = GLOSS_CEIL): number {
  if (lum <= knee) return lum;
  const span = ceil - knee;
  return knee + span * (1 - Math.exp(-(lum - knee) / span));
}

export function glossCap(lum: number): number {
  return softCeil(lum);
}
