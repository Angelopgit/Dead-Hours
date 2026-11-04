/**
 * The game's theme, written out note by note ("Count the Hours", D minor, about 56 bpm), played by
 * the engine's piano voice over the drone. The opening figure is three repeated notes, a clock
 * striking, falling away; the second phrase climbs a step higher before it falls back to D.
 *
 * The menu plays the whole theme and then lets the street be quiet for a while. During a night
 * only fragments come back, lower and further apart, and none at all while the fighting is loud.
 */

/** One note: start and length in beats, MIDI pitch, loudness 0..1. */
export type Note = readonly [beat: number, midi: number, beats: number, vel: number];

export const BPM = 56;

// Pitches used below (MIDI): D3 50, F3 53, G3 55, A3 57, Bb3 58, C4 60, D4 62, E4 64, F4 65, G4 67,
// A4 69, Bb4 70, C5 72, D5 74; bass G2 43, Bb2 46, C3 48.
const MELODY: Note[] = [
  // The clock: three strikes on A, then down to F.
  [0, 69, 1, 0.8], [1, 69, 1, 0.65], [2, 69, 0.5, 0.6], [2.5, 67, 0.5, 0.5], [3, 65, 2, 0.7],
  // Answer: down the scale to D, settling on E (left open).
  [5, 65, 1, 0.55], [6, 64, 1, 0.5], [7, 62, 1, 0.55], [8, 64, 3, 0.6],
  // The clock again, but it climbs.
  [12, 69, 1, 0.8], [13, 69, 1, 0.65], [14, 69, 0.5, 0.6], [14.5, 70, 0.5, 0.6], [15, 72, 2, 0.75],
  [17, 70, 1, 0.6], [18, 69, 1, 0.55], [19, 67, 1, 0.5], [20, 69, 3, 0.65],
  // Up to the high D and home.
  [24, 74, 2, 0.8], [26, 72, 1, 0.6], [27, 69, 1, 0.55], [28, 65, 1, 0.5], [29, 64, 1, 0.5], [30, 62, 5, 0.7],
];

const BASS: Note[] = [
  [0, 50, 5, 0.5], [0, 57, 5, 0.3],
  [5, 46, 6, 0.45], [5, 53, 6, 0.25],
  [12, 53, 5, 0.45], [12, 60, 5, 0.25],
  [17, 43, 6, 0.45], [17, 55, 6, 0.25],
  [24, 46, 4, 0.45], [24, 53, 4, 0.25],
  [28, 48, 2, 0.4], [30, 50, 6, 0.5], [30, 57, 6, 0.3],
];

/** The full theme, melody and bass together. */
export const THEME: Note[] = [...MELODY, ...BASS].sort((a, b) => a[0] - b[0]);
export const THEME_BEATS = 36;

/**
 * Night fragments: the clock figure alone, an octave down, with its bass note; or the closing
 * turn home. Picked one at a time.
 */
export const FRAGMENTS: Note[][] = [
  [[0, 57, 1, 0.6], [1, 57, 1, 0.5], [2, 57, 0.5, 0.45], [2.5, 55, 0.5, 0.4], [3, 53, 3, 0.55], [0, 38, 6, 0.4]],
  [[0, 57, 1, 0.6], [1, 57, 1, 0.5], [2, 57, 0.5, 0.45], [2.5, 58, 0.5, 0.45], [3, 60, 3, 0.55], [0, 41, 6, 0.4]],
  [[0, 62, 2, 0.55], [2, 60, 1, 0.45], [3, 57, 1, 0.4], [4, 53, 1, 0.4], [5, 52, 1, 0.4], [6, 50, 4, 0.55], [6, 38, 5, 0.4]],
];

export const midiHz = (m: number): number => 440 * 2 ** ((m - 69) / 12);
export const beatSeconds = (): number => 60 / BPM;
