/**
 * Seasonal dressing, all behind one switch: Christmas snow over the main menu, the festive logo,
 * and Santa hats on a few of the dead. (The Santa hat in the character creator is a permanent
 * item and stays either way.)
 *
 * 'auto' turns it on from November 1 to January 6 every year, so it comes and goes by itself;
 * 'on' and 'off' force it. For one visit, `?holiday=on` or `?holiday=off` in the address wins
 * (screenshots, testing out of season).
 */
const HOLIDAY_MODE: 'auto' | 'on' | 'off' = 'auto';

/** In the Christmas window: November 1 through January 6. */
export function christmasSeason(d: Date): boolean {
  const m = d.getMonth();
  return m === 10 || m === 11 || (m === 0 && d.getDate() <= 6);
}

function decide(): boolean {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('holiday') : null;
  if (q === 'on' || q === 'off') return q === 'on';
  if (HOLIDAY_MODE !== 'auto') return HOLIDAY_MODE === 'on';
  return christmasSeason(new Date());
}

/** Decided once per page load, so zombie looks (and their cached bodies) don't change mid-session. */
export const HOLIDAY = decide();
