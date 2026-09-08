/**
 * Cloud-mode runner.
 *
 * Mirrors the client pipeline's public surface (progress callbacks, abort)
 * but instead of translating in the browser it:
 *   1. uploads the chunk texts to the Cloudflare worker (gzipped),
 *   2. polls job status every few seconds and maps it to PipelineProgress,
 *   3. exposes getCompletedChunks() for .epub export,
 *   4. supports cancel (marks the job cancelled server-side).
 *
 * The browser can be closed any time — the worker keeps translating.
 */

import {
  createCloudJob,
  getCloudStatus,
  getCloudChunks,
  cancelCloudJob,
} from "./cloud-client";
import { prepareChunkForUpload } from "./compress";
import type { PipelineProgress } from "./pipeline";

export interface CloudRunnerCallbacks {
  onProgress: (progress: PipelineProgress) => void;
  onChunkCompleted?: (chunkId: number, text: string) => void | Promise<void>;
  onDone: (failedChunks: number) => void;
  onError: (message: string) => void;
}

export class CloudRunner {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private totalChunks = 0;
  private completedIds = new Set<number>();
  private startTime = Date.now();
  private activeModel: string | undefined;
  private onChunkCompleted?: (chunkId: number, text: string) => void | Promise<void>;

  constructor(
    private jobId: string,
    private callbacks: CloudRunnerCallbacks,
  ) {
    this.onChunkCompleted = callbacks.onChunkCompleted;
  }

  static async start(
    input: {
      fileName: string;
      model: string;
      keys: string[];
      chunks: { id: number; text: string }[];
      telegramBotToken?: string;
      telegramChatId?: string;
      telegramNotifyOnStart?: boolean;
      telegramNotifyOnProgress?: boolean;
      telegramNotifyOnError?: boolean;
      telegramNotifyOnComplete?: boolean;
    },
    callbacks: CloudRunnerCallbacks,
  ): Promise<CloudRunner> {
    // Compress chunks for upload (falls back to plain text automatically)
    const payload = [];
    for (const chunk of input.chunks) {
      const prepared = await prepareChunkForUpload(chunk.text);
      payload.push({ text: prepared.text, gzip: prepared.gzip });
    }

    const { jobId } = await createCloudJob({
      fileName: input.fileName,
      model: input.model,
      keys: input.keys,
      chunks: payload,
      telegramBotToken: input.telegramBotToken,
      telegramChatId: input.telegramChatId,
      telegramNotifyOnStart: input.telegramNotifyOnStart,
      telegramNotifyOnProgress: input.telegramNotifyOnProgress,
      telegramNotifyOnError: input.telegramNotifyOnError,
      telegramNotifyOnComplete: input.telegramNotifyOnComplete,
    });

    const runner = new CloudRunner(jobId, callbacks);
    runner.totalChunks = input.chunks.length;
    runner.startTime = Date.now();
    runner.startPolling();
    return runner;
  }

  getJobId(): string {
    return this.jobId;
  }

  private startPolling() {
    const poll = async () => {
      if (this.stopped) return;
      try {
        const status = await getCloudStatus(this.jobId);
        this.activeModel = status.activeModel ?? undefined;

        // Detect newly completed chunks for live persistence
        if (status.completedChunks > this.completedIds.size) {
          const chunks = await getCloudChunks(this.jobId);
          for (const chunk of chunks) {
            if (!this.completedIds.has(chunk.id)) {
              this.completedIds.add(chunk.id);
              await this.onChunkCompleted?.(chunk.id, chunk.text);
            }
          }
        }

        const done = status.completedChunks + status.failedChunks;
        const percent =
          status.totalChunks > 0
            ? Math.round((done / status.totalChunks) * 100)
            : 0;
        const elapsedMs = Date.now() - this.startTime;
        const avgPerChunk = done > 0 ? elapsedMs / done : 0;
        const remaining = status.totalChunks - done;

        this.callbacks.onProgress({
          totalChunks: status.totalChunks || this.totalChunks,
          completedChunks: status.completedChunks,
          failedChunks: status.failedChunks,
          activeChunks: 0,
          overallPercent: percent,
          currentChunk:
            status.status === "done"
              ? "Done!"
              : `Chunk ${Math.min(done + 1, status.totalChunks)} of ${status.totalChunks} (cloud)`,
          elapsedMs,
          estimatedRemainingMs: remaining * avgPerChunk,
          activeModel: this.activeModel,
        });

        if (status.status === "done" || status.status === "cancelled") {
          this.stopPolling();
          this.callbacks.onDone(status.failedChunks);
          return;
        }
      } catch (err) {
        // Network blips are expected on mobile — keep polling
        console.warn("[Cloud] poll failed:", err);
      }
    };

    void poll();
    this.pollTimer = setInterval(poll, 5000);
  }

  stopPolling() {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Stop polling locally AND tell the worker to stop translating this job. */
  async cancel(): Promise<void> {
    this.stopPolling();
    try {
      await cancelCloudJob(this.jobId);
    } catch (err) {
      console.warn("[Cloud] cancel failed:", err);
    }
  }

  /** Fetch all completed translated chunks (for .epub export). */
  async getCompletedChunks(): Promise<{ id: number; text: string }[]> {
    return getCloudChunks(this.jobId);
  }
}
