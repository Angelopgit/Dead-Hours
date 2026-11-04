/** Two digits. */
export const pad = (n: number) => String(n).padStart(2, '0');

/** A run's time: mm:ss. */
export const clock = (s: number) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;

/** A total that runs to hours (lifetime time survived): h:mm:ss from an hour up, mm:ss below. */
export const longClock = (s: number) =>
  s < 3600 ? clock(s) : `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s % 60))}`;
