type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

/** Minimal element builder. Keys starting with "on" become listeners. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/**
 * Does `panel` overlap any visible menu text in `menu` (its title, subtitle, name box and items)? A menu dimmed beside a
 * panel reads fine; one the panel slices through (phones, narrow windows) does not, so callers hide it then.
 * `skip` leaves out items that are collapsed away.
 */
export function panelCoversMenu(panel: HTMLElement, menu: HTMLElement, skip?: (e: Element) => boolean): boolean {
  const p = panel.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const range = document.createRange();
  for (const e of menu.querySelectorAll('.title, .subtitle, .menu-name, .menu-item')) {
    if (skip?.(e)) continue;
    range.selectNodeContents(e);
    for (const r of range.getClientRects()) {
      if (!r.width || r.bottom < m.top || r.top > m.bottom) continue;
      if (r.right > p.left && r.left < p.right && r.bottom > p.top && r.top < p.bottom) return true;
    }
  }
  return false;
}

/** Does `panel`'s box cross a line of `el`'s text (a line it hides some of, or all)? */
export function panelCrossesText(panel: HTMLElement, el: Element): boolean {
  const p = panel.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(el);
  for (const r of range.getClientRects()) {
    if (r.width && r.right > p.left && r.left < p.right && r.bottom > p.top && r.top < p.bottom) return true;
  }
  return false;
}

/**
 * A row that scrolls sideways (the creator's category strip on a narrow window) moves with an ordinary mouse wheel
 * too: the browser scrolls such a row only for a sideways wheel or Shift, so with a mouse its last tabs were out of
 * reach. A sideways swipe, a pinch (ctrl) and a row that fits pass through untouched, and so does the wheel once
 * the row is at its end.
 */
export function wheelScrollsSideways(row: HTMLElement): void {
  row.addEventListener('wheel', (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    const max = row.scrollWidth - row.clientWidth;
    if (max <= 0) return;
    const step = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? row.clientWidth : 1);
    const to = Math.min(max, Math.max(0, row.scrollLeft + step));
    if (to === row.scrollLeft) return;
    row.scrollLeft = to;
    e.preventDefault();
  }, { passive: false });
}
