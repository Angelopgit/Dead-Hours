import { h } from './dom';

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

/** The holiday logo: the first word in Christmas red with a Santa hat on its first letter. */
export function holidayTitle(title: string): HTMLElement {
  const [first, ...rest] = title.split(' ');
  const cap = h('span', { class: 't-cap', html: first[0] + SANTA_HAT });
  return h('h1', { class: 'title', 'aria-label': title },
    h('span', { class: 't-red' }, cap, first.slice(1)),
    rest.length ? ' ' + rest.join(' ') : '',
  );
}
