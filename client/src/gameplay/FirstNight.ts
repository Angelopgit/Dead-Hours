/**
 * The first nights a player plays: while the preparation clock runs, the goal card lists three
 * things to try before the dead come (board up a window, take supplies, check your gear), ticked
 * off as they are done. Shown on the first two nights, or until all three have been done once.
 */
export type FirstStep = 'board' | 'stock' | 'gear';

const KEY = 'deadhours.firstnight.v1';
const NIGHTS = 2;

function read(): number {
  try {
    return Number(localStorage.getItem(KEY) ?? 0) || 0;
  } catch {
    return NIGHTS;
  }
}

function write(n: number): void {
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    // Private windows: it just shows again next time.
  }
}

export class FirstNight {
  readonly active: boolean;
  private readonly done = new Set<FirstStep>();
  private counted = false;

  constructor(enabled: boolean) {
    this.active = enabled && read() < NIGHTS;
  }

  mark(step: FirstStep): void {
    if (!this.active || this.done.has(step)) return;
    this.done.add(step);
    if (this.done.size === 3) write(NIGHTS);
  }

  /** The outbreak began: this night counts as one of the first ones. */
  over(): void {
    if (!this.active || this.counted) return;
    this.counted = true;
    if (this.done.size < 3) write(read() + 1);
  }

  rows(key: (a: 'barricade' | 'inventory') => string): { text: string; done: boolean }[] {
    return [
      { text: `Board up a window: hold ${key('barricade')} at it`, done: this.done.has('board') },
      { text: 'Take ammo or bandages: there are crates and first aid boxes in the house', done: this.done.has('stock') },
      { text: `Hold ${key('inventory')} to check your gear`, done: this.done.has('gear') },
    ];
  }
}
