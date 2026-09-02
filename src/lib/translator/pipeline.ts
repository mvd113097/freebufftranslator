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
  activeModel?: string;
}

export type ProgressCallback = (progress: PipelineProgress) => void;
export type TokenCallback = (chunkId: number, token: string) => void;

export interface PipelineOptions {
  chunkSize: number;
  concurrency: number;
  maxRetries: number;
  model: string;
  /** Chunk IDs to skip (already completed in a prior session). */
  skipChunkIds?: number[];
}

const DEFAULT_OPTIONS: PipelineOptions = {
  chunkSize: 4000,
  concurrency: 5,
  maxRetries: 3,
  model: "openrouter/free",
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
    // OpenRouter free tier: ~20 RPM per key. Be conservative with 5 RPM.
    this.rateLimiter = new RateLimiter(5, 3000);
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

    const results: string[] = new Array(chunks.length).fill("");
    const skipSet = new Set(this.options.skipChunkIds ?? []);

    const processChunk = async (chunk: TextChunk) => {
      const progress = this.chunkProgress[chunk.id];
      if (skipSet.has(chunk.id)) {
        progress.status = "completed";
        progress.translatedText = "[skipped]";
        return;
      }
      progress.status = "translating";
      this.reportProgress();

      let attempt = 0;

      while (attempt <= this.options.maxRetries) {
        try {
          if (this.abortController?.signal.aborted) {
            progress.status = "failed";
            progress.error = "Aborted";
            return;
          }

          // Wait for an available key (handles per-key rate limiting)
          const currentKey = await this.rateLimiter.waitForAvailableKey(this.keys);

          // Brief delay to avoid burst
          const timeSinceLastRequest = Date.now() - this.lastRequestTime;
          if (timeSinceLastRequest < 500) {
            const waitMs = 500 - timeSinceLastRequest;
            await new Promise((r) => setTimeout(r, waitMs));
          }
          this.lastRequestTime = Date.now();

          console.log(`[Pipeline] Chunk ${chunk.id + 1} sending request (attempt ${attempt + 1})...`);

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
            this.options.model,
          );

          results[chunk.id] = translated;
          progress.translatedText = translated;
          progress.status = "completed";
          console.log(`[Pipeline] Chunk ${chunk.id + 1} completed (${translated.length} chars)`);
          this.reportProgress();
          return;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[Pipeline] Chunk ${chunk.id + 1} attempt ${attempt + 1} failed:`, message);

          if (message === "Translation aborted") {
            progress.status = "failed";
            progress.error = "Aborted";
            return;
          }

          if (attempt < this.options.maxRetries) {
            attempt++;
            progress.retries = attempt;
            progress.error = message;
            // Rate limit: wait 30s. Other errors: exponential backoff.
            const isRateLimit = message.includes("RATE_LIMITED") || message.includes("429");
            const backoffMs = isRateLimit
              ? 10000
              : Math.min(3000 * Math.pow(2, attempt - 1), 15000);
            console.log(`[Pipeline] Retrying in ${backoffMs / 1000}s...`);
            this.reportProgress();
            await new Promise((r) => setTimeout(r, backoffMs));
          } else {
            progress.status = "failed";
            progress.error = message;
            this.reportProgress();
            return;
          }
        }
      }
    };

    // Process chunks (skip already-completed ones)
    const chunksToProcess = chunks.filter((c) => !skipSet.has(c.id));
    if (this.options.concurrency <= 1) {
      for (const chunk of chunksToProcess) {
        if (this.abortController?.signal.aborted) break;
        await processChunk(chunk);
      }
    } else {
      const pendingChunks = [...chunksToProcess];
      const activePromises: Promise<void>[] = [];

      const runNext = async (): Promise<void> => {
        if (pendingChunks.length === 0) return;
        if (this.abortController?.signal.aborted) return;
        const chunk = pendingChunks.shift()!;
        await processChunk(chunk);
        return runNext();
      };

      const workerCount = Math.min(this.options.concurrency, chunksToProcess.length);
      for (let i = 0; i < workerCount; i++) {
        const delay = i * 500; // 500ms stagger between workers (faster startup)
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
    }

    // If there were skipped chunks, return only the newly-translated results
    if (skipSet.size > 0) {
      return chunksToProcess.map((c) => results[c.id]);
    }
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
