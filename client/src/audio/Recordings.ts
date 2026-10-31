import type { FoleyKind } from './GunSynth';

/**
 * Real recordings (CC0, from Freesound and the Free Firearm Sound Library: see the README's
 * credits), cut, levelled and encoded by dev/make_recorded_sounds.py into ./recorded: four takes of
 * each gun, the layers of a round going into flesh, and the parts of every reload. Files are named
 * <set>-<take>.mp3; recordedFiles.ts lists their URLs.
 */

/** Recording sets by name ('pistol', 'flesh', ...), each its takes in order. */
export function groupRecordings(files: Record<string, string>): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  for (const [path, url] of Object.entries(files)) {
    const m = /([a-z]+)-(\d+)\.mp3$/.exec(path);
    if (m) (sets[m[1]] ??= [])[Number(m[2])] = url;
  }
  return sets;
}

/** The sets a round going into a body is layered from. */
export const FLESH_SETS = ['flesh', 'wet', 'head', 'punch'] as const;

export interface RecordedShot {
  /** The recording set it plays. */
  set: string;
  /** Playback rate (below 1 is lower and longer). */
  rate: number;
  level: number;
  /** Sub-bass weight added under your own shot, on top of what the recording carries. */
  punch: number;
}

/**
 * Guns that play recorded shots. A gun missing here, or every gun until the files are decoded,
 * plays its synthesized shot from GunSynth.
 */
export const RECORDED_SHOTS: Record<string, RecordedShot> = {
  pistol: { set: 'pistol', rate: 1, level: 0.8, punch: 0.45 },
  smg: { set: 'smg', rate: 1, level: 0.72, punch: 0.35 },
  ar: { set: 'ar', rate: 1, level: 0.88, punch: 0.5 },
  marksman: { set: 'marksman', rate: 1, level: 1, punch: 0.7 },
  shotgun: { set: 'shotgun', rate: 1, level: 1.3, punch: 0.85 },
  // The M249 fires the same 5.56 round as the M4: its recording, a touch lower from the longer barrel.
  lmg: { set: 'ar', rate: 0.97, level: 0.92, punch: 0.6 },
  battle: { set: 'battle', rate: 1, level: 0.95, punch: 0.7 },
  sniper: { set: 'sniper', rate: 1, level: 0.8, punch: 0.9 },
};

/**
 * Reload and handling recordings, by mechanism. Every take is cut with what leads up to its main hit
 * (a magazine sliding up the well before it seats) and that hit is its loudest moment: the engine
 * finds it and lines it up with the hand's contact in the reload animation.
 */
export const HANDLING_SETS = [
  'armagout', 'armagin', 'arbolt', 'archarge', 'pmagout', 'pmagin', 'pslide', 'shellin', 'pumpback', 'pumpfwd',
  'smgcock', 'smgmagout', 'smgmagin', 'smgslap', 'rifmagout', 'rifmagin', 'oprod', 'coveropen', 'coverclose',
] as const;
export type HandlingSet = (typeof HANDLING_SETS)[number];

export interface HandlingVoice {
  set: HandlingSet;
  /** Playback rate: below 1 for bigger, heavier parts (lower and slower). */
  rate: number;
  level: number;
}

const v = (set: HandlingSet, rate: number, level: number): HandlingVoice => ({ set, rate, level });
/** The AR-15's magazine well, catch and bolt, pitched for the size of the gun. */
const arLike = (rate: number, level: number): Partial<Record<FoleyKind, HandlingVoice>> => ({
  magOut: v('armagout', rate, 0.42 * level), magIn: v('armagin', rate, 0.55 * level), bolt: v('arbolt', rate, 0.6 * level),
});

/**
 * Which recording each gun's handling sounds play. A sound missing here (the pouch, a dropped
 * magazine, the belt) or not yet decoded plays its synthesized version from GunSynth.
 */
export const RECORDED_HANDLING: Record<string, Partial<Record<FoleyKind, HandlingVoice>>> = {
  // M4A1: an AR-15.
  ar: arLike(1, 1),
  // SCAR-H: the same controls, bigger 7.62 magazines and a heavier bolt.
  battle: { ...arLike(0.93, 1.05), bolt: v('arbolt', 0.9, 0.65) },
  // M249: the feed cover, a 100-round box in and out, and the charging handle when the bolt went home.
  lmg: {
    ...arLike(0.86, 1.05), coverOpen: v('coveropen', 0.95, 0.45), coverClose: v('coverclose', 0.92, 0.6), charge: v('archarge', 0.9, 0.6),
  },
  // MP5: bolt locked back first, magazines out and in, and the slap that sends the bolt home.
  smg: {
    cock: v('smgcock', 1.04, 0.45), magOut: v('smgmagout', 1, 0.42), magIn: v('smgmagin', 1, 0.52), slap: v('smgslap', 1.08, 0.6),
  },
  // MK14: rocked-in magazines and the op rod going home.
  marksman: { magOut: v('rifmagout', 0.95, 0.42), magIn: v('rifmagin', 0.95, 0.55), opRod: v('oprod', 0.94, 0.62) },
  // M107: a heavy .50 box magazine and a long charging handle.
  sniper: { magOut: v('rifmagout', 0.82, 0.48), magIn: v('rifmagin', 0.82, 0.6), charge: v('archarge', 0.8, 0.68) },
  // M17: magazine dropped free, a fresh one in, the slide sent home off the stop.
  pistol: { magOut: v('pmagout', 1, 0.4), magIn: v('pmagin', 1, 0.5), slide: v('pslide', 1, 0.55) },
  // M870: shells thumbed into the tube and the pump.
  shotgun: { shellIn: v('shellin', 1, 0.42), pumpBack: v('pumpback', 1, 0.5), pumpFwd: v('pumpfwd', 1, 0.55) },
};

/** The bytes behind a sound's URL, without a network request when it is inlined. */
export async function recordingBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('data:')) {
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * The decoded take from its first sound on: MP3 decoders put a few tens of milliseconds of
 * silence in front, which would make every shot late.
 */
export function trimLead(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const data = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  let start = 0;
  while (start < data.length && Math.abs(data[start]) < peak * 0.01) start++;
  start = Math.max(0, start - Math.round(buf.sampleRate * 0.0005));
  if (start === 0) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length - start, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).subarray(start), c);
  return out;
}
