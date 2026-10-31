/**
 * Real recordings (CC0, from Freesound: see the README's credits), cut, levelled and encoded by
 * dev/make_recorded_sounds.py into ./recorded: four takes of each gun, and the layers of a round
 * going into flesh. Files are named <set>-<take>.mp3; recordedFiles.ts lists their URLs.
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
