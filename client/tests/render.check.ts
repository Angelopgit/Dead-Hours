/**
 * Render budget checks (no GPU needed): the FPS limiter's frame rates on common displays, and the
 * shader patch that keeps lights from shading pixels they don't reach still applying to the three
 * in node_modules. Run with `npm run check:render`.
 */
import * as THREE from 'three';
import { FrameGate } from '../src/core/FrameGate';
import { LIGHT_LOOP_PATCHED } from '../src/rendering/LightLoop';

let failures = 0;
const fail = (msg: string) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg: string) => console.log('  ok   ' + msg);

/** Frames a second drawn over 20 s of a display at `hz` (with a little timestamp jitter) under `limit`. */
function rate(hz: number, limit: number, jitter = 0.15): { fps: number; maxGap: number } {
  const gate = new FrameGate();
  const period = 1000 / hz;
  let drawn = 0, last = 0, maxGap = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const frames = Math.round(20 * hz);
  for (let i = 1; i <= frames; i++) {
    const now = i * period + rnd() * jitter;
    if (gate.tick(now, limit)) {
      // Skip the first second while the refresh estimate settles.
      if (now > 1000) {
        drawn++;
        if (last) maxGap = Math.max(maxGap, now - last);
      }
      last = now;
    }
  }
  return { fps: drawn / 19, maxGap };
}

console.log('FPS limit');
const cases: [number, number, number][] = [
  // display Hz, limit, expected fps
  [60, 0, 60], [144, 0, 144], [60, 60, 60], [59.94, 60, 59.94], [60.5, 60, 60.5], [75, 60, 60],
  [120, 60, 60], [144, 60, 60], [165, 60, 60], [240, 60, 60], [144, 120, 120], [144, 144, 144],
  [165, 144, 144], [60, 30, 30], [144, 30, 30], [240, 144, 144],
];
for (const [hz, limit, want] of cases) {
  const r = rate(hz, limit);
  const msg = `${hz} Hz display, limit ${limit || 'off'}: ${r.fps.toFixed(1)} fps (want ${want}), longest gap ${r.maxGap.toFixed(1)} ms`;
  if (Math.abs(r.fps - want) > want * 0.02) fail(msg);
  else ok(msg);
}
// At about the limit, every refresh draws (no dropped frame every few seconds from clock drift).
for (const hz of [59.94, 60, 60.2, 60.5]) {
  const r = rate(hz, 60);
  if (r.maxGap > 1000 / hz * 1.5) fail(`${hz} Hz at limit 60 skipped a refresh (gap ${r.maxGap.toFixed(1)} ms)`);
}

console.log('Lights reach only the pixels they light');
if (!LIGHT_LOOP_PATCHED) fail('lights_fragment_begin was not patched (three changed the chunk?)');
else {
  const c = THREE.ShaderChunk.lights_fragment_begin;
  const guarded = c.split('if ( directLight.visible ) RE_Direct(').length - 1;
  if (guarded !== 2) fail(`expected the point and spot loops guarded, found ${guarded}`);
  else ok('point and spot light loops skip lights that add nothing');
  const dir = c.slice(c.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )'));
  if (dir.includes('if ( directLight.visible )')) fail('the moon (directional) loop must stay unguarded');
}

if (failures) {
  console.log(`\n${failures} render check(s) FAILED`);
  process.exit(1);
}
console.log('\nrender checks passed');
