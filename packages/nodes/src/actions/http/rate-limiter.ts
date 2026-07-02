// Spec §13: default one request per second per service, never removable.
export class RateLimiter {
  private readonly nextAllowed = new Map<string, number>();

  constructor(private readonly minIntervalMs = 1_000) {}

  async acquire(key: string): Promise<void> {
    const now = Date.now();
    const earliest = this.nextAllowed.get(key) ?? 0;
    const startAt = Math.max(now, earliest);
    this.nextAllowed.set(key, startAt + this.minIntervalMs);
    const wait = startAt - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
