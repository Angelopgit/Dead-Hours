/** A token bucket: `burst` at once, then one more every `every` seconds. */
export class Bucket {
  private tokens: number;
  private at = 0;

  constructor(private readonly burst: number, private readonly every: number) {
    this.tokens = burst;
  }

  /** Spends one token if there is one (now in seconds). */
  take(now = Date.now() / 1000): boolean {
    if (this.at) this.tokens = Math.min(this.burst, this.tokens + (now - this.at) / this.every);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
