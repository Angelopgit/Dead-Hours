/**
 * Headless gun sound checks: renders every buffer the audio engine banks at startup and checks
 * it is finite, in range, the right shape and actually audible. Run with `npm run check:audio -w client`.
 *
 * Covers each gun's close-shot takes (reproducible, yet different from one another), the action
 * sounds, every handling sound for every gun, both echo impulse responses, and the per-gun
 * character the engine relies on (louder guns echo harder, rifles crack, the shotgun booms longest).
 */
import { MELEE_VOICES, renderMeleeHit, renderMeleePickup, renderMeleeSwing } from '../src/audio/MeleeSynth';
import { ENCLOSURES, GUN_SOUNDS, enclosedIR, renderFoley, renderMech, renderShot, streetIR, type Channels, type Enclosure, type FoleyKind } from '../src/audio/GunSynth';

const SR = 44100;
let failures = 0;
const fail = (msg: string) => { failures++; console.log('  FAIL ' + msg); };
const ok = (msg: string) => console.log('  ok   ' + msg);

function stats(chs: Channels, from = 0, to = Infinity): { peak: number; rms: number; finite: boolean } {
  let peak = 0, e = 0, n = 0, finite = true;
  for (const c of chs) {
    for (let i = Math.round(from * SR); i < Math.min(c.length, to * SR); i++) {
      if (!Number.isFinite(c[i])) finite = false;
      peak = Math.max(peak, Math.abs(c[i]));
      e += c[i] * c[i];
      n++;
    }
  }
  return { peak, rms: Math.sqrt(e / Math.max(1, n)), finite };
}

function sound(name: string, chs: Channels, channels: number, maxLen: number): void {
  const s = stats(chs);
  if (chs.length !== channels) fail(`${name}: ${chs.length} channels, expected ${channels}`);
  else if (!s.finite) fail(`${name}: NaN or infinite samples`);
  else if (s.peak > 1) fail(`${name}: clips (peak ${s.peak.toFixed(3)})`);
  else if (s.peak < 0.5) fail(`${name}: too quiet (peak ${s.peak.toFixed(3)})`);
  else if (chs[0].length > maxLen * SR || chs[0].length < 0.01 * SR) fail(`${name}: length ${(chs[0].length / SR).toFixed(3)} s`);
}

console.log('Close shots');
const loud: Record<string, number> = {};
for (const [id, g] of Object.entries(GUN_SOUNDS)) {
  const a = renderShot(g.shot, SR, 1), a2 = renderShot(g.shot, SR, 1), b = renderShot(g.shot, SR, 2);
  const before = failures;
  sound(`${id} shot`, a, 2, 0.6);
  if (a[0].some((v, i) => v !== a2[0][i])) fail(`${id} shot: same seed renders differently`);
  let diff = 0;
  for (let i = 0; i < a[0].length; i++) diff += Math.abs(a[0][i] - b[0][i]);
  if (diff / a[0].length < 1e-3) fail(`${id} shot: takes are identical`);
  const head = stats(a, 0, 0.004).peak, late = stats(a, 0.15, 0.6).peak;
  if (head < 0.9) fail(`${id} shot: report doesn't open on its peak (${head.toFixed(2)})`);
  if (late > 0.2) fail(`${id} shot: still loud after 150 ms (${late.toFixed(2)}), the echo should carry the length`);
  loud[id] = stats(a, 0, 0.1).rms;
  if (failures === before) ok(`${id}: reproducible, takes differ, peak first, dies within 150 ms`);
}
if (!(loud.shotgun > loud.ar && loud.marksman > loud.ar && loud.ar > loud.pistol)) fail(`body order wrong: ${JSON.stringify(loud)}`);
else ok('12 gauge and 7.62 carry the most body, the pistol the least');
if (!(GUN_SOUNDS.marksman.echo > GUN_SOUNDS.ar.echo && GUN_SOUNDS.ar.echo > GUN_SOUNDS.smg.echo)) fail('echo order wrong');
else ok('bigger guns drive the echo harder');
if (!(GUN_SOUNDS.ar.shot.crack > 0 && GUN_SOUNDS.marksman.shot.crack > GUN_SOUNDS.ar.shot.crack && GUN_SOUNDS.shotgun.shot.crack === 0)) fail('crack order wrong');
else ok('rifles crack, 7.62 hardest, buckshot none');

console.log('Actions');
for (const [id, g] of Object.entries(GUN_SOUNDS)) {
  if (!g.mech) { ok(`${id}: no action sound under the shot (pumped by hand)`); continue; }
  const before = failures;
  sound(`${id} action`, renderMech(g.mech, SR, 3), 1, 0.32);
  if (failures === before) ok(`${id} action`);
}

console.log('Handling');
const kinds: FoleyKind[] = ['magOut', 'magIn', 'bolt', 'pump', 'slide', 'shellIn', 'holster', 'draw', 'shellGrab', 'dryFire'];
let rendered = 0;
for (const id of [...Object.keys(GUN_SOUNDS), 'knife']) {
  for (const k of kinds) {
    const before = failures;
    sound(`${id} ${k}`, renderFoley(k, id, SR, 5), 1, 0.42);
    if (failures === before) rendered++;
  }
}
if (rendered === kinds.length * (Object.keys(GUN_SOUNDS).length + 1)) ok(`${rendered} handling sounds, every kind for every gun (and an unknown id)`);

console.log('Echo');
const spaces: [string, Channels, number][] = [['street', streetIR(SR, 7), 2.6]];
for (const k of Object.keys(ENCLOSURES) as Enclosure[]) spaces.push([k, enclosedIR(k, SR, 11), ENCLOSURES[k].length]);
for (const [name, ir, len] of spaces) {
  const s = stats(ir);
  const e = ir.reduce((sum, c) => sum + c.reduce((a, v) => a + v * v, 0), 0) / ir.length;
  const early = stats(ir, 0, 0.04).rms, late = stats(ir, len - 0.3, len).rms;
  if (!s.finite || ir.length !== 2) fail(`${name} IR malformed`);
  else if (Math.abs(e - 1) > 1e-3) fail(`${name} IR energy ${e.toFixed(4)}, expected 1`);
  else if (late > early * 0.05) fail(`${name} IR doesn't die out (late ${late.toExponential(2)} vs early ${early.toExponential(2)})`);
  else ok(`${name}: stereo, unit energy, decays to silence within ${len} s`);
}
const street = streetIR(SR, 7);
if (stats(street, 0, 0.04).peak > stats(street, 0.04, 0.5).peak * 0.1) fail('street IR answers before the nearest facade could');
else ok('street stays quiet until the first facade (45 ms)');
// Each space rings as long as its materials say: soft rooms die first, concrete and big rooms last.
const t30 = (ir: Channels): number => {
  const n = ir[0].length, e = new Float64Array(n);
  for (let i = n - 1, acc = 0; i >= 0; i--) e[i] = acc += ir[0][i] ** 2 + ir[1][i] ** 2;
  const at = (db: number) => e.findIndex((v) => 10 * Math.log10(v / e[0]) < db) / SR;
  return (at(-35) - at(-5)) * 2;
};
const decay = Object.fromEntries((Object.keys(ENCLOSURES) as Enclosure[]).map((k) => [k, t30(enclosedIR(k, SR, 11))]));
if (!(decay.room < decay.basement && decay.room < decay.hall)) fail(`ring times out of order: ${JSON.stringify(decay)}`);
else ok(`ring time (T60 from T30): room ${decay.room.toFixed(2)} s, basement ${decay.basement.toFixed(2)} s, hall ${decay.hall.toFixed(2)} s`);

console.log('Melee weapons');
{
  // Share of a sound's energy above `hz` (a one-pole split: crude but enough to compare voices).
  const bright = (x: Float32Array, hz: number) => {
    const a = Math.exp((-2 * Math.PI * hz) / SR);
    let lp = 0, hi = 0, all = 0;
    for (let i = 0; i < x.length; i++) {
      lp = a * lp + (1 - a) * x[i];
      hi += (x[i] - lp) ** 2;
      all += x[i] ** 2;
    }
    return hi / Math.max(1e-12, all);
  };
  const before = failures;
  const hits: Record<string, Float32Array> = {};
  for (const id of MELEE_VOICES) {
    const sw = renderMeleeSwing(id, SR, 1), sw2 = renderMeleeSwing(id, SR, 1);
    sound(`${id} swing`, [sw], 1, 0.6);
    if (sw.some((v, i) => v !== sw2[i])) fail(`${id} swing: same seed renders differently`);
    for (const heavy of [false, true]) {
      const h = renderMeleeHit(id, { kill: heavy, head: heavy }, SR, 3);
      sound(`${id} hit${heavy ? ' (kill)' : ''}`, [h], 1, 0.7);
      if (stats([h], 0, 0.01).peak < 0.5) fail(`${id} hit: doesn't land on its transient`);
      if (stats([h], 0.4, 0.62).peak > 0.1) fail(`${id} hit: still ringing after 400 ms`);
      if (!heavy) hits[id] = h;
    }
    sound(`${id} pickup`, [renderMeleePickup(id, SR, 5)], 1, 0.6);
  }
  const a = renderMeleeHit('machete', { kill: false, head: false }, SR, 3), b = renderMeleeHit('machete', { kill: false, head: false }, SR, 4);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  if (diff / a.length < 1e-3) fail('machete hit: takes are identical');
  // Blades slice (bright, hissing), clubs thud (dark): the katana brightest, the bat darkest.
  const br = Object.fromEntries(Object.entries(hits).map(([k, v]) => [k, bright(v, 2500)]));
  if (!(br.katana > br.bat && br.machete > br.bat && br.machete > br.wrench && br.katana > br.hockey)) fail(`brightness order wrong: ${JSON.stringify(br)}`);
  if (failures === before) ok(`${MELEE_VOICES.length} melee voices: swings, light and heavy hits, pickups render clean; blades brighter than clubs (${MELEE_VOICES.map((k) => `${k} ${(br[k] * 100).toFixed(0)}%`).join(', ')})`);
}

console.log(failures ? `\n${failures} FAILURES` : '\nALL AUDIO CHECKS PASSED');
process.exit(failures ? 1 : 0);
