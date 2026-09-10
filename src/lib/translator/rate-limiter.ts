/**
 * Token-bucket rate limiter tracking per-key rolling windows.
 * Conservative: 1 request per key per minute, 6s stagger.
 */

interface KeyBucket {
  timestamps: number[];
  lastUsed: number;
}

export class RateLimiter {
  private buckets: Map<string, KeyBucket> = new Map();
  /** key -> timestamp until which the key is skipped (set after a 429). */
  private cooldowns: Map<string, number> = new Map();
  private maxRPM: number;
  private staggerMs: number;

  constructor(maxRPM = 5, staggerMs = 3000) {
    this.maxRPM = maxRPM;
    this.staggerMs = staggerMs;
  }

  private cleanOldTimestamps(bucket: KeyBucket): void {
    const now = Date.now();
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < 60_000);
  }

  /** Temporarily disable a key after a rate-limit / rejection failure. */
  markCooldown(key: string, ms: number): void {
    this.cooldowns.set(key, Date.now() + ms);
  }

  canUseKey(key: string): boolean {
    const cd = this.cooldowns.get(key);
    if (cd !== undefined && Date.now() < cd) return false;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { timestamps: [], lastUsed: 0 };
      this.buckets.set(key, bucket);
    }
    this.cleanOldTimestamps(bucket);
    return bucket.timestamps.length < this.maxRPM;
  }

  /** Wait until the key is available, then mark it used. */
  async waitForAvailableKey(keys: string[]): Promise<string> {
    const validKeys = keys.filter((k) => k.trim().length > 0);
    if (validKeys.length === 0) {
      throw new Error("No valid API keys provided");
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Try to find a key that's available
      for (const key of validKeys) {
        if (this.canUseKey(key)) {
          const bucket = this.buckets.get(key)!;
          const now = Date.now();
          const timeSinceLastUse = now - bucket.lastUsed;

          // Apply stagger delay if this key was used recently
          if (bucket.lastUsed > 0 && timeSinceLastUse < this.staggerMs) {
            const waitTime = this.staggerMs - timeSinceLastUse;
            if (waitTime > 0) {
              await new Promise((resolve) => setTimeout(resolve, waitTime));
            }
          }

          // Record usage
          bucket.timestamps.push(Date.now());
          bucket.lastUsed = Date.now();
          return key;
        }
      }

      // All keys are rate-limited or in cooldown. Wait until the earliest
      // cooldown expires (or a fixed window for pure RPM limits), capped so
      // an abort / pipeline change stays responsive.
      const now = Date.now();
      let earliest = Infinity;
      for (const key of validKeys) {
        const cd = this.cooldowns.get(key);
        if (cd !== undefined) earliest = Math.min(earliest, cd);
      }
      const waitMs =
        earliest !== Infinity
          ? Math.min(Math.max(earliest - now, 0), 30_000)
          : 15_000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  reset(): void {
    this.buckets.clear();
    this.cooldowns.clear();
  }
}
