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
