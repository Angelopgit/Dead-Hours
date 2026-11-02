import { settings } from '../core/Settings';

/**
 * The night's weather, shared by rain, wet surfaces, fog and audio.
 *
 * Rain follows the wall clock (a slow sum of sines), so every survivor in an online room sees and
 * hears the same downpour without any network traffic. Surfaces lag behind: they soak up within
 * about twenty seconds of rain and take a couple of minutes to dry.
 */
export const weather = {
  /** 0..1: how hard it is raining now. */
  rain: 0,
  /** 0..1: how wet exposed surfaces are. */
  wetness: 0,
  /** Seconds, for rain and ripple animation. */
  time: 0,
  /** Snow is falling instead (the holiday main menu): the rain holds off meanwhile. */
  snowing: false,
};

/** Rain at a wall-clock time (ms): mostly steady rain with heavier bursts and short lulls. */
export function rainAt(ms: number): number {
  const t = ms / 1000;
  const slow = Math.sin(t / 211) * 0.42 + Math.sin(t / 97 + 1.3) * 0.26 + Math.sin(t / 41 + 4.1) * 0.12;
  const r = 0.62 + slow;
  return Math.min(1, Math.max(0, (r - 0.18) / 0.82));
}

let started = false;

/** Snow starts or stops; `instant` (behind a fade) also brings the rain straight back or away. */
export function setSnowing(on: boolean, instant = false): void {
  weather.snowing = on;
  if (instant && started) weather.rain = settings.value.graphics.rain && !on ? rainAt(Date.now()) : 0;
}

export function updateWeather(dt: number): void {
  weather.time += dt;
  const on = settings.value.graphics.rain;
  const target = on && !weather.snowing ? rainAt(Date.now()) : 0;
  if (!started) {
    started = true;
    weather.rain = target;
    weather.wetness = on ? Math.min(1, 0.35 + target) : 0;
    return;
  }
  weather.rain += (target - weather.rain) * Math.min(1, dt * 0.5);
  if (!on) {
    weather.wetness = 0;
    return;
  }
  // Soak quickly while it rains, dry slowly in a lull.
  const wetTarget = Math.min(1, weather.rain * 2.5);
  const rate = wetTarget > weather.wetness ? 0.05 : 0.008;
  weather.wetness += (wetTarget - weather.wetness) * Math.min(1, dt * rate);
}
