/**
 * Token-bucket rate limiter tracking per-key rolling windows.
 * Gemini free tier: ~2 RPM per key with stagger between requests.
 */

interface KeyBucket {
  timestamps: number[];
  lastUsed: number;
}

export class RateLimiter {
  private buckets: Map<string, KeyBucket> = new Map();
  private maxRPM: number;
  private staggerMs: number;

  constructor(maxRPM = 2, staggerMs = 4500) {
    this.maxRPM = maxRPM;
    this.staggerMs = staggerMs;
  }

  private cleanOldTimestamps(bucket: KeyBucket): void {
    const now = Date.now();
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < 60_000);
  }

  canUseKey(key: string): boolean {
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
          console.log(`[RateLimiter] Key assigned: ${key.slice(0, 12)}... | Uses in last 60s: ${bucket.timestamps.length}/${this.maxRPM}`);
          return key;
        }
      }

      // All keys are rate-limited, wait and retry
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}
