/**
 * The steady little sounds fixed about the street (AudioEngine.addEmitter): street lamps buzzing and the wreck's
 * hazard relay clicking. Each is a tone through its own HRTF panner, and there are 19 on the map: all running,
 * they kept the audio thread busy (about 5% of a core here) even where none was near enough to hear. A chain
 * further than `off` from the listener is disconnected, which costs nothing, and joined again within `on`; the
 * gap keeps one at the edge from switching every frame. Out there it would be about 58 dB down, under the rain.
 */
export const EMITTER = {
  buzz: { refDistance: 1.5, gain: 0.05 },
  alarm: { refDistance: 2, gain: 0.04 },
  /** The panners' rolloff (inverse distance model). */
  rolloff: 1.2,
  /** Metres from the listener: connected within `on`, cut beyond `off`. */
  on: 46,
  off: 50,
};

export type EmitterKind = 'buzz' | 'alarm';

/** An emitter's level `dist` metres away, its level() at 1: the panner's inverse distance law times its gain. */
export function emitterGain(kind: EmitterKind, dist: number): number {
  const { refDistance: r, gain } = EMITTER[kind];
  return (gain * r) / (r + EMITTER.rolloff * (Math.max(dist, r) - r));
}

/** Whether an emitter `distSq` (squared metres) from the listener is connected, given whether it was. */
export function emitterOn(wasOn: boolean, distSq: number): boolean {
  const limit = wasOn ? EMITTER.off : EMITTER.on;
  return distSq < limit * limit;
}
