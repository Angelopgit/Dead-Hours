import { GLYPH, PAD, buttonNamed, glyphStyle } from '../core/PadLayout';

/** Spoken names for the glyphs that are pictures. */
const SPOKEN: Record<string, string> = {
  '✕': 'cross', '○': 'circle', '□': 'square', '△': 'triangle', '▼': 'bottom button', '▶': 'right button', '◀': 'left button', '▲': 'top button',
  '↑': 'D-pad up', '↓': 'D-pad down', '←': 'D-pad left', '→': 'D-pad right', '−': 'minus', '+': 'plus',
};

const SVG = (body: string) => `<svg viewBox="0 0 20 20" aria-hidden="true">${body}</svg>`;

/** The D-pad as a cross with the pressed arm filled. */
function dpad(button: number): string {
  const arms: [number, string][] = [
    [PAD.UP, 'M7.5 1.5h5v6h-5z'], [PAD.DOWN, 'M7.5 12.5h5v6h-5z'], [PAD.LEFT, 'M1.5 7.5h6v5h-6z'], [PAD.RIGHT, 'M12.5 7.5h6v5h-6z'],
  ];
  return SVG(`<path d="M7.5 7.5h5v5h-5z" class="pb-off"/>${arms.map(([b, d]) => `<path d="${d}" class="${b === button ? 'pb-on' : 'pb-off'}"/>`).join('')}`);
}

/** A generic pad's face buttons: four dots in a diamond, the one meant lit. */
function diamond(button: number): string {
  const at: [number, number, number][] = [[PAD.A, 10, 15.5], [PAD.B, 15.5, 10], [PAD.X, 4.5, 10], [PAD.Y, 10, 4.5]];
  return SVG(at.map(([b, x, y]) => `<circle cx="${x}" cy="${y}" r="${b === button ? 3.6 : 2.3}" class="${b === button ? 'pb-on' : 'pb-off'}"/>`).join(''));
}

/** One button drawn as a button. */
export function glyphEl(name: string): HTMLElement {
  const style = glyphStyle();
  const b = buttonNamed(name, style);
  const kind = b < 0 ? 'meta' : b <= PAD.Y ? 'face' : b <= PAD.RB ? 'bumper' : b <= PAD.RT ? 'trigger'
    : b === PAD.LS || b === PAD.RS ? 'stick' : b >= PAD.UP && b <= PAD.RIGHT ? 'dpad' : 'meta';
  const el = document.createElement('span');
  el.className = `pb pb-${kind} pb-${style} pb-b${b}`;
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', SPOKEN[name] ?? name);
  if (kind === 'dpad') el.innerHTML = dpad(b);
  else if (kind === 'face' && style === 'generic') el.innerHTML = diamond(b);
  else el.textContent = name;
  return el;
}

/** A string with glyphs in it, as nodes: the glyphs drawn as buttons, the rest as text. */
export function richNodes(text: string): (Node | string)[] {
  if (!text.includes(GLYPH)) return text ? [text] : [];
  return text.split(GLYPH).flatMap<Node | string>((part, i) => (i % 2 ? [glyphEl(part)] : part ? [part] : []));
}

/** Writes a string into an element, drawing any glyphs in it (only when the string changed). */
export function richText(el: HTMLElement, text: string): void {
  if (el.dataset.rich === text) return;
  el.dataset.rich = text;
  if (!text.includes(GLYPH)) el.textContent = text;
  else el.replaceChildren(...richNodes(text));
}
