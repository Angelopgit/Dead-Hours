import { C2S, CHAT, cleanChat, type ChatLine } from '@dead-hours/shared';
import { comms } from './Comms';

/** Lines kept for the lobby box and the in-game overlay. */
const KEEP = 80;

/**
 * The room's text chat: lines from the server (already cleaned and filtered there), minus players
 * this one has muted or blocked; sending holds back the same way the server does, so a burst is
 * refused here with a reason instead of vanishing.
 */
export class Chat {
  readonly lines: (ChatLine & { at: number })[] = [];
  private readonly listeners = new Set<(line: ChatLine & { at: number }) => void>();
  private tokens: number = CHAT.burst;
  private refillAt = performance.now();

  constructor(private readonly send: (type: string, msg: unknown) => void) {}

  receive(line: ChatLine): void {
    if (!line || typeof line.text !== 'string') return;
    if (!line.sys && (comms.blocked(line.pid) || comms.textMuted(line.pid))) return;
    this.push(line);
  }

  /** A line only this player sees (the box's own hints). */
  local(text: string): void {
    this.push({ id: '', pid: '', name: '', text, sys: true });
  }

  private push(line: ChatLine): void {
    const l = { ...line, at: performance.now() };
    this.lines.push(l);
    if (this.lines.length > KEEP) this.lines.shift();
    for (const fn of this.listeners) fn(l);
  }

  subscribe(fn: (line: ChatLine & { at: number }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Sends a line; false (with a hint in the box) when it was empty or too soon. */
  say(raw: string): boolean {
    const text = cleanChat(raw);
    if (!text) return false;
    const now = performance.now();
    this.tokens = Math.min(CHAT.burst, this.tokens + (now - this.refillAt) / (CHAT.refillSeconds * 1000));
    this.refillAt = now;
    if (this.tokens < 1) {
      this.local('Slow down: too many messages.');
      return false;
    }
    this.tokens -= 1;
    this.send(C2S.chat, text);
    return true;
  }
}
