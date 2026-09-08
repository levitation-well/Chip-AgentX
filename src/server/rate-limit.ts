export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetAt: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now()
  ) {}

  consume(key: string, limitName: string, limit: number): RateLimitResult {
    const now = this.now();
    const entryKey = `${limitName}:${key}`;
    const existing = this.entries.get(entryKey);
    const entry =
      existing && existing.resetAt > now
        ? existing
        : {
            count: 0,
            resetAt: now + this.windowMs
          };

    entry.count += 1;
    this.entries.set(entryKey, entry);
    return {
      allowed: entry.count <= limit,
      count: entry.count,
      limit,
      resetAt: entry.resetAt
    };
  }

  cleanup(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) {
        this.entries.delete(key);
      }
    }
  }
}
