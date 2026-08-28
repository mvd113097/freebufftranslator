import { chunkText, type TextChunk } from "./chunker";
import { RateLimiter } from "./rate-limiter";
import { translateChunk } from "./gemini-api";

export type ChunkStatus = "pending" | "translating" | "completed" | "failed";

export interface ChunkProgress {
  id: number;
  status: ChunkStatus;
  originalText: string;
  translatedText: string;
  tokensReceived: number;
  error?: string;
  retries: number;
}

export interface PipelineProgress {
  totalChunks: number;
  completedChunks: number;
  failedChunks: number;
  activeChunks: number;
  overallPercent: number;
  currentChunk: string;
  elapsedMs: number;
  estimatedRemainingMs: number;
}

export type ProgressCallback = (progress: PipelineProgress) => void;
export type TokenCallback = (chunkId: number, token: string) => void;

export interface PipelineOptions {
  chunkSize: number;
  concurrency: number;
  maxRetries: number;
}

const DEFAULT_OPTIONS: PipelineOptions = {
  chunkSize: 25000,
  concurrency: 3,
  maxRetries: 3,
};

export class TranslationPipeline {
  private abortController: AbortController | null = null;
  private chunkProgress: ChunkProgress[] = [];
  private keys: string[] = [];
  private options: PipelineOptions;
  private rateLimiter: RateLimiter;
  private startTime = 0;
  private lastRequestTime = 0;
  private onProgress: ProgressCallback | null = null;
  private onToken: TokenCallback | null = null;

  constructor() {
    this.options = { ...DEFAULT_OPTIONS };
    this.rateLimiter = new RateLimiter(1, 4500);
  }

  setProgressCallback(cb: ProgressCallback) {
    this.onProgress = cb;
  }

  setTokenCallback(cb: TokenCallback) {
    this.onToken = cb;
  }

  getChunkProgress(): ChunkProgress[] {
    return this.chunkProgress;
  }

  async start(
    rawText: string,
    keys: string[],
    options?: Partial<PipelineOptions>,
  ): Promise<string[]> {
    if (options) {
      this.options = { ...DEFAULT_OPTIONS, ...options };
    }

    this.keys = keys.filter((k) => k.trim().length > 0);
    if (this.keys.length === 0) {
      throw new Error("No valid API keys provided");
    }

    this.rateLimiter.reset();
    this.abortController = new AbortController();
    this.startTime = Date.now();
    this.lastRequestTime = 0;

    // Chunk the text
    const chunks = chunkText(rawText, this.options.chunkSize);
    this.chunkProgress = chunks.map((c) => ({
      id: c.id,
      status: "pending" as ChunkStatus,
      originalText: c.text,
      translatedText: "",
      tokensReceived: 0,
      retries: 0,
    }));

    this.reportProgress();

    // Process chunks with concurrency control
    const results: string[] = new Array(chunks.length).fill("");
    const pendingChunks = [...chunks];
    const activePromises: Promise<void>[] = [];

    const processChunk = async (chunk: TextChunk) => {
      const progress = this.chunkProgress[chunk.id];
      progress.status = "translating";
      this.reportProgress();

      let attempt = 0;
      console.log(`[Pipeline] Chunk ${chunk.id + 1} waiting for key...`);
      let currentKey = await this.rateLimiter.waitForAvailableKey(this.keys);
      console.log(`[Pipeline] Chunk ${chunk.id + 1} got key, sending request...`);

      // Global delay: ensure at least 2s between any two API requests (IP-level rate limit)
      const timeSinceLastRequest = Date.now() - this.lastRequestTime;
      if (timeSinceLastRequest < 2000) {
        await new Promise((r) => setTimeout(r, 2000 - timeSinceLastRequest));
      }
      this.lastRequestTime = Date.now();

      while (attempt <= this.options.maxRetries) {
        try {
          if (this.abortController?.signal.aborted) {
            progress.status = "failed";
            progress.error = "Aborted";
            return;
          }

          const translated = await translateChunk(
            chunk.text,
            currentKey,
            (token) => {
              progress.tokensReceived++;
              progress.translatedText += token;
              this.onToken?.(chunk.id, token);
              this.reportProgress();
            },
            this.abortController?.signal,
          );

          results[chunk.id] = translated;
          progress.translatedText = translated;
          progress.status = "completed";
          console.log(`[Pipeline] Chunk ${chunk.id + 1} completed (${translated.length} chars)`);
          this.reportProgress();
          return;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[Pipeline] Chunk ${chunk.id} attempt ${attempt} failed:`, message);

          if (message === "Translation aborted") {
            progress.status = "failed";
            progress.error = "Aborted";
            return;
          }

          if (attempt < this.options.maxRetries) {
            attempt++;
            progress.retries = attempt;
            progress.error = message;
            // For rate limit errors, wait longer (30-60s) for the window to reset
            const isRateLimit = message.includes("RATE_LIMITED") || message.includes("429");
            const backoffMs = isRateLimit
              ? Math.min(30000 * Math.pow(2, attempt - 1), 60000)
              : Math.min(2000 * Math.pow(2, attempt - 1), 30000);
            this.reportProgress();
            await new Promise((r) => setTimeout(r, backoffMs));

            // Get a different key for the retry
            currentKey = await this.rateLimiter.waitForAvailableKey(this.keys);
          } else {
            progress.status = "failed";
            progress.error = message;
            this.reportProgress();
            return;
          }
        }
      }
    };

    // Process with concurrency limit
    const runNext = async (): Promise<void> => {
      if (pendingChunks.length === 0) return;
      if (this.abortController?.signal.aborted) return;

      const chunk = pendingChunks.shift()!;
      await processChunk(chunk);
      return runNext();
    };

    // Start N concurrent workers, staggered to avoid burst traffic
    const workerCount = Math.min(this.options.concurrency, chunks.length);
    for (let i = 0; i < workerCount; i++) {
      // Stagger worker starts by 1.5s each to prevent burst
      const delay = i * 1500;
      activePromises.push(
        new Promise<void>((resolve) => {
          setTimeout(async () => {
            await runNext();
            resolve();
          }, delay);
        }),
      );
    }

    await Promise.allSettled(activePromises);

    // Filter out empty results
    return results;
  }

  abort(): void {
    this.abortController?.abort();
  }

  private reportProgress(): void {
    if (!this.onProgress) return;

    const completed = this.chunkProgress.filter(
      (c) => c.status === "completed",
    ).length;
    const failed = this.chunkProgress.filter(
      (c) => c.status === "failed",
    ).length;
    const active = this.chunkProgress.filter(
      (c) => c.status === "translating",
    ).length;
    const total = this.chunkProgress.length;
    const percent = total > 0 ? Math.round(((completed + failed) / total) * 100) : 0;

    const elapsedMs = Date.now() - this.startTime;
    const completedTotal = completed + failed;
    const avgMsPerChunk = completedTotal > 0 ? elapsedMs / completedTotal : 0;
    const remaining = total - completedTotal;
    const estimatedRemainingMs = remaining * avgMsPerChunk;

    const activeChunk = this.chunkProgress.find((c) => c.status === "translating");
    const currentChunkLabel = activeChunk
      ? `Chunk ${activeChunk.id + 1} of ${total}`
      : completed === total
        ? "Done!"
        : "Preparing...";

    this.onProgress({
      totalChunks: total,
      completedChunks: completed,
      failedChunks: failed,
      activeChunks: active,
      overallPercent: percent,
      currentChunk: currentChunkLabel,
      elapsedMs,
      estimatedRemainingMs,
    });
  }
}
