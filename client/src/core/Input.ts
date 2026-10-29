import { settings, type Action } from './Settings';

/**
 * Keyboard/mouse input mapped to rebindable actions. Mouse buttons are encoded as "Mouse<n>".
 * Look deltas accumulate between frames and are consumed by the camera.
 */
export class Input {
  private down = new Set<string>();
  private pressedThisFrame = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private wheel = 0;
  enabled = false;
  private readonly target: HTMLElement;
  private readonly abort = new AbortController();
  /** When set, the next key/button press is delivered here instead of to gameplay (rebinding). */
  captureNext: ((code: string) => void) | null = null;

  constructor(target: HTMLElement) {
    this.target = target;
    const opts = { signal: this.abort.signal };
    window.addEventListener('keydown', (e) => this.onKey(e, true), opts);
    window.addEventListener('keyup', (e) => this.onKey(e, false), opts);
    window.addEventListener('mousedown', (e) => this.onButton(e, true), opts);
    window.addEventListener('mouseup', (e) => this.onButton(e, false), opts);
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.lookX += e.movementX;
      this.lookY += e.movementY;
    }, opts);
    window.addEventListener('wheel', (e) => { this.wheel += Math.sign(e.deltaY); }, { ...opts, passive: true });
    window.addEventListener('contextmenu', (e) => { if (this.enabled) e.preventDefault(); }, opts);
    window.addEventListener('blur', () => this.down.clear(), opts);
  }

  get locked(): boolean {
    return document.pointerLockElement === this.target;
  }

  requestLock(): void {
    if (this.locked) return;
    const p = this.target.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => { /* user gesture required; the next click retries */ });
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  private onKey(e: KeyboardEvent, isDown: boolean): void {
    if (isDown && this.captureNext) {
      e.preventDefault();
      const cb = this.captureNext;
      this.captureNext = null;
      cb(e.code);
      return;
    }
    if (!this.enabled) return;
    if (e.code === 'Tab' || e.code === 'Space' || (e.ctrlKey && e.code !== 'KeyW')) e.preventDefault();
    this.setState(e.code, isDown);
  }

  private onButton(e: MouseEvent, isDown: boolean): void {
    const code = `Mouse${e.button}`;
    if (isDown && this.captureNext) {
      const cb = this.captureNext;
      this.captureNext = null;
      cb(code);
      return;
    }
    if (!this.enabled || !this.locked) return;
    this.setState(code, isDown);
  }

  private setState(code: string, isDown: boolean): void {
    if (isDown) {
      if (!this.down.has(code)) this.pressedThisFrame.add(code);
      this.down.add(code);
    } else {
      this.down.delete(code);
    }
  }

  private codes(action: Action): string[] {
    return settings.value.controls.bindings[action] ?? [];
  }

  held(action: Action): boolean {
    if (!this.enabled) return false;
    return this.codes(action).some((c) => this.down.has(c));
  }

  pressed(action: Action): boolean {
    if (!this.enabled) return false;
    return this.codes(action).some((c) => this.pressedThisFrame.has(c));
  }

  consumeLook(): { x: number; y: number } {
    const r = { x: this.lookX, y: this.lookY };
    this.lookX = 0;
    this.lookY = 0;
    return r;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.pressedThisFrame.clear();
  }

  clear(): void {
    this.down.clear();
    this.pressedThisFrame.clear();
    this.lookX = this.lookY = 0;
  }

  dispose(): void {
    this.abort.abort();
  }
}

export function codeLabel(code: string): string {
  if (code.startsWith('Mouse')) return ['LMB', 'MMB', 'RMB', 'M4', 'M5'][Number(code.slice(5))] ?? code;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map: Record<string, string> = {
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt', Space: 'Space', Tab: 'Tab', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    CapsLock: 'Caps', Backquote: '`',
  };
  return map[code] ?? code;
}
