/**
 * Lawn grass placement on the shared map. Run with `npm run check:grass`.
 *
 * Builds the lawn mask the grass shader reads and checks that grass grows on the yards, verges
 * and park of both streets, and never on roads, sidewalks, driveways, slabs, inside a house, over
 * a basement, in a puddle, under a prop or out on the forest floor. Also times the build (it runs
 * at boot) and checks the shader's dry tint follows the ground's own noise.
 */
import { NEIGHBORHOOD as map, OAK, propColliders } from '@dead-hours/shared';
import { buildLawnMask, groundNoise, lawnDensity, woodsAt } from '../src/environment/Lawn';

let failures = 0;
const fail = (msg: string) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg: string) => console.log('  ok   ' + msg);

const t0 = performance.now();
const mask = buildLawnMask(map);
const ms = performance.now() - t0;
console.log(`lawn mask ${mask.w}x${mask.h} (${mask.texel} m) built in ${ms.toFixed(0)} ms`);
if (ms > 1500) fail(`mask build took ${ms.toFixed(0)} ms (boot budget 1500 ms)`);
else ok('mask builds within the boot budget');

// Coverage: share of the playable area that is lawn.
let lawn = 0;
for (let k = 0; k < mask.w * mask.h; k++) if (mask.data[k * 2] > 64) lawn++;
const lawnM2 = lawn * mask.texel * mask.texel;
console.log(`lawn area ${lawnM2.toFixed(0)} m² (density > 0.25)`);
if (lawnM2 < 8000) fail(`only ${lawnM2.toFixed(0)} m² of lawn`);
else ok('both streets have lawns');

/** Points sampled over a rectangle (center, half extents), inset by `inset`. */
function* samples(cx: number, cz: number, hx: number, hz: number, step = 0.2, inset = 0): Generator<[number, number]> {
  for (let z = cz - hz + inset; z <= cz + hz - inset; z += step) for (let x = cx - hx + inset; x <= cx + hx - inset; x += step) yield [x, z];
}

// Nothing grows on or under anything lying on the ground. The lookup filters the mask the way the
// GPU does (linearly), so every edge softens over half a texel: blades may lap a footprint's rim by
// up to EDGE, and a density under NONE is one blade in fifty spots.
const EDGE = 0.15, NONE = 0.02;
let bad = 0, checked = 0;
const report = (what: string) => {
  if (bad) fail(`${bad} of ${checked} points with grass on ${what}`);
  else ok(`no grass on ${what} (${checked} points)`);
  bad = 0;
  checked = 0;
};
for (const s of map.solids) {
  const bottom = s.y - s.h / 2, top = s.y + s.h / 2;
  if (top < -0.05 || bottom > 0.7 || s.w < 0.3 || s.d < 0.3) continue;
  for (const [x, z] of samples(s.x, s.z, s.w / 2, s.d / 2, 0.3, EDGE)) {
    checked++;
    if (lawnDensity(mask, x, z) > NONE) bad++;
  }
}
report('roads, sidewalks, driveways, slabs, walls and fences');
for (const h of map.houses) for (const [x, z] of samples(h.x, h.z, h.w / 2, h.d / 2, 0.4)) { checked++; if (lawnDensity(mask, x, z) > NONE) bad++; }
report('house footprints');
for (const e of map.excavations) {
  for (const [x, z] of samples((e.x0 + e.x1) / 2, (e.z0 + e.z1) / 2, (e.x1 - e.x0) / 2, (e.z1 - e.z0) / 2, 0.3)) { checked++; if (lawnDensity(mask, x, z) > NONE) bad++; }
}
report('basement openings');
for (const p of map.props) {
  if (p.forest || (p.y ?? 0) > 0.25) continue;
  if (p.kind === 'puddle') {
    const r = (p.length ?? 1.8) * 0.75;
    for (let a = 0; a < Math.PI * 2; a += 0.4) for (const k of [0, 0.5, 0.9]) {
      checked++;
      // Inside the puddle's squashed outline, in its own frame.
      const lx = Math.cos(a) * r * k, lz = Math.sin(a) * r * k * 0.7;
      const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
      if (lawnDensity(mask, p.x + lx * c + lz * s, p.z - lx * s + lz * c) > NONE) bad++;
    }
    continue;
  }
  // Thin walls (iron fence pickets, tent canvas, open-shed sides, sign boards) have grass growing up to them on
  // both sides; their floors and the rest are checked whole.
  if (p.kind === 'shed' && p.variant === 1) {
    const c = Math.cos(p.rotY), s = Math.sin(p.rotY);
    for (let u = -1.4; u <= 1.4; u += 0.2) for (let v = -1.1; v <= 1.1; v += 0.2) {
      checked++;
      if (lawnDensity(mask, p.x + u * c + v * s, p.z - u * s + v * c) > NONE) bad++;
    }
  }
  for (const o of propColliders(p)) {
    if (o.y - o.hy > 0.6 || o.y + o.hy < 0 || Math.min(o.hx, o.hz) < 0.15) continue;
    const c = Math.cos(o.rotY), s = Math.sin(o.rotY);
    const ix = Math.max(0, o.hx - EDGE), iz = Math.max(0, o.hz - EDGE);
    for (let u = -ix; u <= ix + 1e-6; u += 0.15) for (let v = -iz; v <= iz + 1e-6; v += 0.15) {
      checked++;
      if (lawnDensity(mask, o.x + u * c + v * s, o.z - u * s + v * c) > NONE) bad++;
    }
  }
}
report('puddles and props');

// Lawns: the yards in front of the homes on both streets, and the park.
const yardPoints = (cz: number, x0: number, x1: number) => {
  let grass = 0, n = 0;
  for (let x = x0; x < x1; x += 0.5) {
    for (let dz = -2; dz <= 2; dz += 0.5) {
      const z = cz + dz;
      if (map.solids.some((s) => Math.abs(x - s.x) < s.w / 2 + 0.3 && Math.abs(z - s.z) < s.d / 2 + 0.3 && s.y - s.h / 2 < 0.7 && s.y + s.h / 2 > -0.05)) continue;
      if (map.houses.some((h) => Math.abs(x - h.x) < h.w / 2 + 0.5 && Math.abs(z - h.z) < h.d / 2 + 0.5)) continue;
      n++;
      if (lawnDensity(mask, x, z) > 0.2) grass++;
    }
  }
  return { grass, n };
};
for (const [name, cz, x0, x1] of [
  ['Hale Street north yards', -11, -60, 60],
  ['Hale Street south yards', 11, -60, 60],
  ['Kinney Street north yards', OAK.z - 11, OAK.birch + 12, OAK.lotsEnd],
  ['Kinney Street south yards', OAK.z + 11, OAK.birch + 12, OAK.lotsEnd],
  ['Vesper Park', 30, 70, 108],
] as const) {
  const { grass, n } = yardPoints(cz, x0, x1);
  const share = n ? grass / n : 0;
  if (n < 20 || share < 0.6) fail(`${name}: grass on ${(share * 100).toFixed(0)}% of ${n} open points`);
  else ok(`${name}: grass on ${(share * 100).toFixed(0)}% of ${n} open points`);
}

// The forest floor stays bare.
const woods = woodsAt(map);
let deep = 0, inWoods = 0;
for (let z = map.bounds.z0; z < map.bounds.z1; z += 1.5) {
  for (let x = map.bounds.x0; x < map.bounds.x1; x += 1.5) {
    if (woods(x, z) < 0.9) continue;
    inWoods++;
    if (lawnDensity(mask, x, z) > 0) deep++;
  }
}
if (inWoods < 100) fail(`only ${inWoods} forest points found`);
else if (deep) fail(`${deep} of ${inWoods} forest-floor points have grass`);
else ok(`no grass on the forest floor (${inWoods} points)`);

// The shader's dry tint repeats the ground's noise (GLSL copy in Grass.ts).
const glsl = `sin(gRoot.x * 0.11) * cos(gRoot.y * 0.13) + sin(gRoot.x * 0.031 + gRoot.y * 0.047) * 0.8`;
const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/environment/Grass.ts', import.meta.url), 'utf8'));
if (!src.includes(glsl) || Math.abs(groundNoise(3, 4) - (Math.sin(0.33) * Math.cos(0.52) + Math.sin(0.093 + 0.188) * 0.8)) > 1e-9) fail('grass dry tint no longer matches the ground noise');
else ok('grass dry tint matches the ground noise');

console.log(failures ? `\n${failures} grass check(s) failed` : '\nall grass checks passed');
process.exit(failures ? 1 : 0);
