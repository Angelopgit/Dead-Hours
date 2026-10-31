/**
 * Headless gun sound checks: renders every buffer the audio engine banks at startup and checks
 * it is finite, in range, the right shape and actually audible. Run with `npm run check:audio -w client`.
 *
 * Covers each gun's close-shot takes (reproducible, yet different from one another), the action
 * sounds, every handling sound for every gun, both echo impulse responses, and the per-gun
 * character the engine relies on (louder guns echo harder, rifles crack, the shotgun booms longest).
 * Then the real recordings the engine plays in their place: four takes for every gun, the flesh-hit
 * layers, each a sane MP3 (decoded and measured when ffmpeg is installed), and every source credited.
 * Reloads: every gun's script sits on its hand animation, sends the bolt home only from empty, and
 * its cues, played out frame by frame the way PlayerWeapon does, land every hit once and on time;
 * every handling recording set exists, each take with its main hit early in it.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { WEAPONS } from '@dead-hours/shared';
import { ENCLOSURES, FOLEY_KINDS, GUN_SOUNDS, enclosedIR, renderFoley, renderMech, renderShot, streetIR, type Channels, type Enclosure, type FoleyKind } from '../src/audio/GunSynth';
import { MELEE_VOICES, renderMeleeHit, renderMeleePickup, renderMeleeSwing } from '../src/audio/MeleeSynth';
import { FLESH_SETS, HANDLING_SETS, RECORDED_HANDLING, RECORDED_SHOTS, groupRecordings } from '../src/audio/Recordings';
import { RELOAD_STEPS, dueCues, reloadTimeline } from '../src/weapons/reloadScript';

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
const kinds: FoleyKind[] = FOLEY_KINDS;
let rendered = 0;
for (const id of [...Object.keys(GUN_SOUNDS), 'knife']) {
  for (const k of kinds) {
    const before = failures;
    sound(`${id} ${k}`, renderFoley(k, id, SR, 5), 1, 0.42);
    if (failures === before) rendered++;
  }
}
if (rendered === kinds.length * (Object.keys(GUN_SOUNDS).length + 1)) ok(`${rendered} handling sounds, every kind for every gun (and an unknown id)`);

console.log('Reloads');
{
  const before = failures;
  // The hand animation's keyframes (PlayerWeapon.leftHand): where the new magazine seats.
  const SEAT = { rifle: 0.74, pistol: 0.66 };
  const HOME: FoleyKind[] = ['bolt', 'charge', 'slap', 'opRod', 'slide'];
  for (const id of Object.keys(GUN_SOUNDS)) {
    const def = WEAPONS[id as keyof typeof WEAPONS];
    const steps = RELOAD_STEPS[id];
    if (!steps?.length) { fail(`${id}: no reload script`); continue; }
    if (steps.some((st) => st.at < 0 || st.at > 1)) fail(`${id}: a reload step outside the reload`);
    if (def.perShell) {
      if (!steps.some((st) => st.cue === 'shellIn')) fail(`${id}: no shell going in`);
      continue;
    }
    const seat = steps.find((st) => st.cue === 'magIn');
    const want = def.hold === 'pistol' ? SEAT.pistol : SEAT.rifle;
    if (!seat || Math.abs(seat.at - want) > 0.02) fail(`${id}: the magazine seats at ${seat?.at}, the hand pushes it home at ${want}`);
    const empty = reloadTimeline(id, true, def.reloadTime + 0.35).map((c) => c.cue);
    const tactical = reloadTimeline(id, false, def.reloadTime).map((c) => c.cue);
    if (!empty.some((c) => HOME.includes(c))) fail(`${id}: an empty reload never sends the bolt home`);
    if (tactical.some((c) => HOME.includes(c))) fail(`${id}: a reload with a round chambered works the bolt`);
    if (empty.indexOf('magOut') > empty.indexOf('magIn')) fail(`${id}: the magazine goes in before the old one is out`);
  }
  // Played out at 60 fps the way PlayerWeapon does: every hit once, within a frame of the script.
  const play = (id: string, empty: boolean, segments: number[]): { cue: FoleyKind; t: number }[] => {
    const heard: { cue: FoleyKind; t: number }[] = [];
    let t0 = 0;
    for (const len of segments) {
      let last = -Infinity;
      for (let t = 0; t <= len + 1e-9; t += 1 / 60) {
        const p = Math.min(1, t / len);
        for (const c of dueCues(id, empty, last, p, len)) heard.push({ cue: c.cue, t: t0 + t + c.inS });
        last = p;
      }
      t0 += len;
    }
    return heard.sort((a, b) => a.t - b.t);
  };
  let played = 0;
  for (const id of Object.keys(GUN_SOUNDS)) {
    const def = WEAPONS[id as keyof typeof WEAPONS];
    for (const empty of [true, false]) {
      const per = def.reloadTime / def.magazine;
      const want = def.perShell ? reloadTimeline(id, empty, 0, 4, per).filter((c) => c.cue !== 'pumpBack' && c.cue !== 'pumpFwd') : reloadTimeline(id, empty, def.reloadTime + (empty ? 0.35 : 0));
      const got = play(id, empty, def.perShell ? [0.4, per, per, per] : [def.reloadTime + (empty ? 0.35 : 0)]);
      const off = want.length !== got.length ? Infinity : Math.max(...want.map((w, k) => (w.cue === got[k].cue ? Math.abs(w.t - got[k].t) : Infinity)));
      if (off > 1 / 60 + 1e-6) fail(`${id} ${empty ? 'empty' : 'tactical'} reload: cues ${got.map((c) => `${c.cue}@${c.t.toFixed(2)}`).join(' ')}, script ${want.map((c) => `${c.cue}@${c.t.toFixed(2)}`).join(' ')}`);
      else played++;
    }
  }
  if (failures === before) ok(`${Object.keys(GUN_SOUNDS).length} reload scripts on their animations, bolts home only from empty; ${played} reloads cue every hit once and on time`);
}

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
console.log('Recordings');
const recDir = new URL('../src/audio/recorded/', import.meta.url);
const recFiles = readdirSync(recDir).filter((f) => f.endsWith('.mp3'));
const sets = groupRecordings(Object.fromEntries(recFiles.map((f) => [f, f])));
let recorded = 0;
for (const id of Object.keys(GUN_SOUNDS)) {
  const rec = RECORDED_SHOTS[id];
  const takes = rec ? (sets[rec.set] ?? []).filter(Boolean).length : 0;
  if (!rec) fail(`${id}: no recorded shot, it would play the synthesized one`);
  else if (takes < 4) fail(`${id}: ${takes} recorded takes of '${rec.set}', expected 4`);
  else recorded++;
}
if (recorded === Object.keys(GUN_SOUNDS).length) ok(`all ${recorded} guns play one of 4 recorded takes`);
const missing = FLESH_SETS.filter((set) => !sets[set]?.length);
if (missing.length) fail(`flesh layers missing: ${missing.join(', ')}`);
else ok(`flesh hit layers: ${FLESH_SETS.map((set) => `${set} ×${sets[set].length}`).join(', ')}`);
{
  const before = failures;
  const short = HANDLING_SETS.filter((set) => (sets[set] ?? []).filter(Boolean).length < 2);
  if (short.length) fail(`handling sets with fewer than 2 takes: ${short.join(', ')}`);
  for (const [id, voices] of Object.entries(RECORDED_HANDLING)) {
    for (const [kind, v] of Object.entries(voices)) {
      if (!(HANDLING_SETS as readonly string[]).includes(v.set)) fail(`${id} ${kind}: plays '${v.set}', not a handling set`);
      if (!(v.rate > 0.7 && v.rate < 1.3) || !(v.level > 0 && v.level < 1)) fail(`${id} ${kind}: rate ${v.rate}, level ${v.level}`);
    }
    const scripted = new Set([...(RELOAD_STEPS[id] ?? []).map((st) => st.cue)]);
    const unvoiced = (['magOut', 'magIn', 'shellIn'] as FoleyKind[]).filter((k) => scripted.has(k) && !voices[k]);
    if (unvoiced.length) fail(`${id}: ${unvoiced.join(', ')} not recorded`);
  }
  if (failures === before) ok(`reloads: ${HANDLING_SETS.length} recorded sets (${HANDLING_SETS.reduce((n, set) => n + sets[set].filter(Boolean).length, 0)} takes), every gun's magazine or shells recorded`);
}
const clicks = (sets.torch ?? []).filter(Boolean).length;
if (clicks < 2) fail(`flashlight switch: ${clicks} recorded takes of 'torch', expected at least 2`);
else ok(`flashlight switch: ${clicks} recorded clicks`);
const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
let sane = 0;
for (const f of recFiles) {
  const bytes = readFileSync(new URL(f, recDir));
  const mp3 = (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (!mp3) { fail(`${f}: not an MP3`); continue; }
  if (bytes.length < 2000 || bytes.length > 100_000) { fail(`${f}: ${bytes.length} bytes`); continue; }
  if (ffmpeg) {
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', '-', '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { input: bytes, maxBuffer: 1 << 26 }).stdout;
    const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length >> 2);
    const s = stats([x]);
    let onset = 0;
    while (onset < x.length && Math.abs(x[onset]) < s.peak * 0.05) onset++;
    if (!s.finite) { fail(`${f}: NaN samples`); continue; }
    if (s.peak > 1 || s.peak < 0.7) { fail(`${f}: peak ${s.peak.toFixed(3)}, expected about -1 dBFS`); continue; }
    const handling = (HANDLING_SETS as readonly string[]).includes(f.replace(/-\d+\.mp3$/, ''));
    if (handling) {
      // Handling takes lead up to their main hit (the loudest moment), which the game lines up with the hand.
      let at = 0;
      for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > Math.abs(x[at])) at = i;
      if (at > 0.4 * SR) { fail(`${f}: main hit ${(at / SR * 1000).toFixed(0)} ms in`); continue; }
      if (x.length > 0.75 * SR) { fail(`${f}: ${(x.length / SR).toFixed(2)} s long`); continue; }
    } else if (onset > 0.005 * SR) { fail(`${f}: starts ${(onset / SR * 1000).toFixed(1)} ms late`); continue; }
    if (x.length > 2.1 * SR) { fail(`${f}: ${(x.length / SR).toFixed(2)} s long`); continue; }
  }
  sane++;
}
if (sane === recFiles.length) ok(`${sane} recordings are MP3s of sane size${ffmpeg ? ', peak near -1 dBFS, start on the sound, under 2.1 s' : ' (ffmpeg not installed: not decoded)'}`);
// Every recording used is credited in the README with its Freesound page.
const maker = readFileSync(new URL('../dev/make_recorded_sounds.py', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const ids = [...maker.matchAll(/freesound\.org\/previews\/\d+\/(\d+)_/g)].map((m) => m[1]);
const uncredited = ids.filter((id) => !readme.includes(`freesound.org/s/${id}`));
if (!ids.length) fail('no sources found in make_recorded_sounds.py');
else if (uncredited.length) fail(`README doesn't credit Freesound ${uncredited.join(', ')}`);
else ok(`all ${ids.length} source recordings credited in the README`);
const library = /LIBRARY_URL = '[^']*FreeFirearmsSFXLibrary\/([0-9a-f]{40})\//.exec(maker);
if (!library) fail('make_recorded_sounds.py: no pinned Free Firearm Sound Library source');
else if (!readme.includes('Free Firearm Sound Library') || !readme.includes(library[1].slice(0, 7))) fail(`README doesn't credit the Free Firearm Sound Library at ${library[1].slice(0, 7)}`);
else ok('the Free Firearm Sound Library (reloads) credited in the README');

console.log(failures ? `\n${failures} FAILURES` : '\nALL AUDIO CHECKS PASSED');
process.exit(failures ? 1 : 0);
