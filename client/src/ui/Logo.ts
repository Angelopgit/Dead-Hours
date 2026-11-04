import { h } from './dom';

/**
 * The game's logo: the name set tight in heavy condensed capitals, with the O of HOURS drawn as a clock face
 * stopped at three in the morning, and the whole thing worn like a sign that has been out in the weather.
 * In the holiday season the first word turns red and its first letter wears a Santa hat.
 */

/** The clock that stands in for the O: an oval face as narrow as the letters around it, hands at 3:00. */
const CLOCK = `<svg class="logo-clock" viewBox="0 0 64 100" aria-hidden="true">
  <ellipse cx="32" cy="50" rx="26.5" ry="44.5" fill="none" stroke="currentColor" stroke-width="11"/>
  <g stroke="currentColor" stroke-width="3.5" stroke-linecap="square" opacity="0.7">
    <path d="M32 15v6M32 79v6M12 50h6M46 50h6"/>
  </g>
  <path d="M32 50V22" stroke="#c4372b" stroke-width="5" stroke-linecap="square"/>
  <path d="M32 50h15" stroke="#c4372b" stroke-width="6" stroke-linecap="square"/>
  <circle cx="32" cy="50" r="4.5" fill="#c4372b"/>
</svg>`;

/** A Santa hat in the logo's own flat style: a red cone flopping over to the right, fur band, pom-pom. */
const SANTA_HAT = `<svg class="santa-hat" viewBox="0 0 132 120" aria-hidden="true">
  <defs>
    <linearGradient id="santa-red" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ec4a52"/><stop offset="0.55" stop-color="#c11f2b"/><stop offset="1" stop-color="#7c0e18"/>
    </linearGradient>
    <linearGradient id="santa-fur" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cdd5df"/>
    </linearGradient>
  </defs>
  <path d="M18 98 C20 58 34 20 62 9 C90 0 114 22 120 62 L104 68 C100 56 94 50 86 47 C90 64 94 80 96 98 Z" fill="url(#santa-red)"/>
  <path d="M86 47 C90 64 94 80 96 98 L86 98 C84 80 82 62 86 47 Z" fill="#000" opacity="0.25"/>
  <rect x="7" y="89" width="98" height="25" rx="12.5" fill="url(#santa-fur)"/>
  <circle cx="113" cy="68" r="13.5" fill="url(#santa-fur)"/>
</svg>`;

let wear: string | null = null;

/**
 * A mask of worn paint: mostly solid, with flecks, a few chips and fine scratches knocked out of it.
 * Drawn once with a fixed seed, so the logo is worn the same way every time.
 */
function wearMask(): string {
  if (wear !== null) return wear;
  wear = '';
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  if (!x) return wear;
  let s = 0x2b5e17;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  x.fillStyle = '#fff';
  x.fillRect(0, 0, 256, 256);
  x.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 900; i++) {
    x.globalAlpha = 0.25 + r() * 0.75;
    x.fillRect(r() * 256, r() * 256, 0.6 + r() * 1.4, 0.6 + r() * 1.4);
  }
  for (let i = 0; i < 26; i++) {
    x.globalAlpha = 0.85;
    x.beginPath();
    const cx = r() * 256, cy = r() * 256, rad = 1.5 + r() * 4;
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2, d = rad * (0.6 + r() * 0.7);
      if (k === 0) x.moveTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
      else x.lineTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    }
    x.fill();
  }
  x.lineWidth = 0.8;
  for (let i = 0; i < 14; i++) {
    x.globalAlpha = 0.5 + r() * 0.4;
    const sx = r() * 256, sy = r() * 256, len = 20 + r() * 60, a = -0.35 + r() * 0.3;
    x.beginPath();
    x.moveTo(sx, sy);
    x.lineTo(sx + Math.cos(a) * len, sy + Math.sin(a) * len);
    x.stroke();
  }
  wear = c.toDataURL('image/png');
  return wear;
}

/** "HOURS" with its O swapped for the clock (any word with an O gets it at its first O). */
function clockWord(word: string): (string | HTMLElement)[] {
  const i = word.indexOf('O');
  if (i < 0) return [word];
  return [word.slice(0, i), h('span', { class: 'logo-o', html: CLOCK }), word.slice(i + 1)];
}

export function logo(title: string, holiday: boolean): HTMLElement {
  const [first, ...rest] = title.split(' ');
  const second = rest.join(' ');
  const lead = holiday
    ? h('span', { class: 'logo-word t-red' }, h('span', { class: 't-cap', html: first[0] + SANTA_HAT }), first.slice(1))
    : h('span', { class: 'logo-word' }, first);
  const el = h('h1', { class: 'title logo', 'aria-label': title },
    lead,
    second ? h('span', { class: 'logo-word' }, ...clockWord(second)) : '',
  );
  const mask = wearMask();
  if (mask) el.style.setProperty('--wear', `url(${mask})`);
  return el;
}
