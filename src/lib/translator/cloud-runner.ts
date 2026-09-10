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
 *
 * ── Oversized-chunk splitting ─────────────────────────────────────
 * Very large chunks (30k+ chars) make the worker's single upstream request
 * stream for minutes until it dies with "The operation was aborted". To keep
 * cloud jobs alive we split any chunk above MAX_UPLOAD_CHARS into ~10k-char
 * parts at paragraph boundaries, upload each part as its own worker chunk,
 * and merge the parts back together (in order) before reporting the chunk as
 * completed. The original chunk ids are preserved end-to-end via an upload
 * plan, which is persisted to localStorage so a page reload can re-attach
 * with the correct mapping.
 */

import {
  createCloudJob,
  getCloudStatus,
  getCloudChunks,
  getCloudDebug,
  cancelCloudJob,
} from "./cloud-client";
import { prepareChunkForUpload } from "./compress";
import { sanitizeModel, resolveAutoModel } from "./models";
import type { PipelineProgress } from "./pipeline";

/** Chunks larger than this are split before upload. The deployed worker
 * (workers/worker.js) accepts up to 100k chars per request with a 110s
 * upstream timeout, so a default 35k pipeline chunk uploads as ONE request;
 * only oversized 100k-slider chunks are split, into ~30k parts. */
const MAX_UPLOAD_CHARS = 40000;
/** Preferred part size when splitting. */
const TARGET_SPLIT_CHARS = 30000;

/** localStorage key holding the upload plan for the active cloud job. */
const CLOUD_PLAN_KEY = "novel-translator-cloud-plan";

/** One original chunk's entry in the upload plan. */
export interface CloudPlanEntry {
  id: number;
  parts: number;
}

function storePlan(jobId: string, plan: CloudPlanEntry[]): void {
  try {
    localStorage.setItem(CLOUD_PLAN_KEY, JSON.stringify({ jobId, plan }));
  } catch {
    /* quota — non-fatal */
  }
}

/** Load the stored upload plan for a job (null when missing/from another job). */
export function loadStoredPlan(jobId: string): CloudPlanEntry[] | null {
  try {
    const raw = localStorage.getItem(CLOUD_PLAN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { jobId: string; plan: CloudPlanEntry[] };
    if (parsed?.jobId !== jobId || !Array.isArray(parsed.plan)) return null;
    return parsed.plan;
  } catch {
    return null;
  }
}

/**
 * Map raw worker upload-units back to ORIGINAL chunks using the upload plan
 * (identity mapping when no plan exists — single-part chunks). Returns only
 * fully-received originals with parts merged in order, sorted by id.
 * Used when re-attaching after a reload so chunks finished while the tab was
 * closed are restored into local state + IndexedDB.
 */
export function mapUnitsToOriginals(
  units: { id: number; text: string }[],
  plan: CloudPlanEntry[] | null,
): { id: number; text: string }[] {
  if (units.length === 0) return [];
  if (!plan || plan.length === 0) {
    return [...units].sort((a, b) => a.id - b.id);
  }
  const unitToOriginal: number[] = [];
  const unitToPartIndex: number[] = [];
  for (const entry of plan) {
    for (let p = 0; p < Math.max(entry.parts, 1); p++) {
      unitToOriginal.push(entry.id);
      unitToPartIndex.push(p);
    }
  }
  const partsBuffer = new Map<number, (string | undefined)[]>();
  for (const unit of units) {
    const originalId = unitToOriginal[unit.id] ?? unit.id;
    const partIndex = unitToPartIndex[unit.id] ?? 0;
    const parts = partsBuffer.get(originalId) ?? [];
    parts[partIndex] = unit.text;
    partsBuffer.set(originalId, parts);
  }
  const merged: { id: number; text: string }[] = [];
  for (const [originalId, parts] of partsBuffer) {
    const expected = plan.find((e) => e.id === originalId)?.parts ?? 1;
    const received = parts.filter((p) => p !== undefined).length;
    if (received < expected) continue; // still translating — skip
    const text = Array.from({ length: expected }, (_, i) => parts[i] ?? "")
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    merged.push({ id: originalId, text });
  }
  return merged.sort((a, b) => a.id - b.id);
}

/**
 * Split text into parts of at most MAX_UPLOAD_CHARS, preferring paragraph
 * boundaries. Returns a single-element array for text that needs no split.
 */
function splitForUpload(text: string): string[] {
  if (text.length <= MAX_UPLOAD_CHARS) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + TARGET_SPLIT_CHARS, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const lastBreak = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
      // Only use the break if it keeps the part at least half-full
      if (lastBreak > TARGET_SPLIT_CHARS * 0.5) {
        end = start + lastBreak + 1;
      }
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

export interface CloudRunnerCallbacks {
  onProgress: (progress: PipelineProgress) => void;
  onChunkCompleted?: (chunkId: number, text: string) => void | Promise<void>;
  onDone: (failedChunks: number, pauseReason?: string | null) => void;
  onError: (message: string) => void;
}

export class CloudRunner {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private totalChunks = 0;
  /** Worker upload-unit ids already fetched from the worker. */
  private completedUnitIds = new Set<number>();
  /** Original chunk ids whose parts have all arrived and been emitted. */
  private completedOriginalIds = new Set<number>();
  /** originalId -> sparse array of received parts. */
  private partsBuffer = new Map<number, (string | undefined)[]>();
  /** Original chunk id -> error string for failed worker units (cleared on retry). */
  private failedUnits = new Map<number, string>();
  /** Upload plan: one entry per ORIGINAL chunk. */
  private plan: CloudPlanEntry[] = [];
  /** Worker upload-unit position -> original chunk id. */
  private unitToOriginal: number[] = [];
  /** Worker upload-unit position -> part index within its original chunk. */
  private unitToPartIndex: number[] = [];
  private startTime = 0;
  private totalCharsTranslated = 0;
  private lastChunkCompletedAt = 0;
  private activeModel: string | undefined;
  private onChunkCompleted?: (chunkId: number, text: string) => void | Promise<void>;
  private readonly jobId: string;
  private readonly callbacks: CloudRunnerCallbacks;

  constructor(jobId: string, callbacks: CloudRunnerCallbacks) {
    this.jobId = jobId;
    this.callbacks = callbacks;
    this.onChunkCompleted = callbacks.onChunkCompleted;
    // Re-attach after reload: restore the upload plan stored at job start.
    const stored = loadStoredPlan(jobId);
    if (stored) {
      this.setPlan(stored);
      // Original chunk count comes from the plan (worker counts upload units)
      this.totalChunks = stored.length;
    }
  }

  /** Build the worker-position → (originalId, partIndex) maps from a plan. */
  private setPlan(plan: CloudPlanEntry[]): void {
    this.plan = plan;
    this.unitToOriginal = [];
    this.unitToPartIndex = [];
    for (const entry of plan) {
      for (let p = 0; p < Math.max(entry.parts, 1); p++) {
        this.unitToOriginal.push(entry.id);
        this.unitToPartIndex.push(p);
      }
    }
  }

  static async start(
    input: {
      fileName: string;
      model: string;
      keys: string[];
      chunks: { id: number; text: string }[];
      liveModels?: string[];
      /** Original (user-visible) section count — the worker stores upload-units
       * which can be larger after oversized-chunk splitting. Used for the
       * Telegram start notification so it matches what the app shows. */
      originalChunkCount?: number;
      telegramBotToken?: string;
      telegramChatId?: string;
      telegramNotifyOnStart?: boolean;
      telegramNotifyOnProgress?: boolean;
      telegramNotifyOnError?: boolean;
      telegramNotifyOnComplete?: boolean;
    },
    callbacks: CloudRunnerCallbacks,
  ): Promise<CloudRunner> {
    // Build the upload plan: split oversized chunks into safe parts.
    const plan: CloudPlanEntry[] = [];
    const payload: { text: string; gzip: boolean }[] = [];
    for (const chunk of input.chunks) {
      const parts = splitForUpload(chunk.text);
      plan.push({ id: chunk.id, parts: parts.length });
      for (const part of parts) {
        const prepared = await prepareChunkForUpload(part);
        payload.push({ text: prepared.text, gzip: prepared.gzip });
      }
    }

    const { jobId } = await createCloudJob({
      fileName: input.fileName,
      // Defense in depth: never send a removed/dead model slug (e.g. one saved
      // by an older build) or the Auto sentinel to the worker — resolve to a
      // specific verified-live slug here so the deployed worker, whatever
      // version it runs, always starts from a working model.
      model: resolveAutoModel(sanitizeModel(input.model)),
      keys: input.keys,
      chunks: payload,
      liveModels: input.liveModels,
      telegramBotToken: input.telegramBotToken,
      telegramChatId: input.telegramChatId,
      telegramNotifyOnStart: input.telegramNotifyOnStart,
      telegramNotifyOnProgress: input.telegramNotifyOnProgress,
      telegramNotifyOnError: input.telegramNotifyOnError,
      telegramNotifyOnComplete: input.telegramNotifyOnComplete,
      originalChunkCount: input.originalChunkCount,
    });

    storePlan(jobId, plan);

    const runner = new CloudRunner(jobId, callbacks);
    runner.setPlan(plan);
    runner.totalChunks = input.chunks.length;
    runner.startTime = Date.now();
    await runner.refreshFailureMap();
    runner.startPolling();
    return runner;
  }

  getJobId(): string {
    return this.jobId;
  }

  /** Map worker-unit failures back to original chunk ids via the upload plan. */
  private async refreshFailureMap(): Promise<void> {
    this.failedUnits.clear();
    if (this.unitToOriginal.length === 0) return;
    try {
      const rows = await getCloudDebug(this.jobId);
      for (const row of rows) {
        if (row.status !== "failed") continue;
        const originalId = this.unitToOriginal[row.seq] ?? row.seq;
        const existing = this.failedUnits.get(originalId);
        const msg = row.error ?? "Unknown error";
        if (!existing || msg.length < existing.length) {
          this.failedUnits.set(originalId, msg);
        }
      }
    } catch {
      /* debug endpoint unavailable on older workers — non-fatal */
    }
  }

  /** Latest original-chunk-id -> error map (empty when nothing has failed). */
  getFailures(): { id: number; error: string }[] {
    return [...this.failedUnits.entries()].map(([id, error]) => ({ id, error }));
  }

  /**
   * Re-attach to an existing job after page reload.
   * Fetches current status immediately, then starts polling.
   */
  async attach(): Promise<void> {
    this.startTime = 0;
    this.stopped = false;
    await this.refreshFailureMap();
    this.startPolling();
  }

  /**
   * Handle one completed worker upload-unit: buffer it, and when every part
   * of its original chunk has arrived, merge and emit the ORIGINAL chunk.
   */
  private async handleCompletedUnit(unitId: number, text: string): Promise<void> {
    if (this.completedUnitIds.has(unitId)) return;
    this.completedUnitIds.add(unitId);

    const originalId = this.unitToOriginal[unitId] ?? unitId;
    const partIndex = this.unitToPartIndex[unitId] ?? 0;
    const expected =
      this.plan.find((e) => e.id === originalId)?.parts ?? 1;

    const parts = this.partsBuffer.get(originalId) ?? [];
    parts[partIndex] = text;
    this.partsBuffer.set(originalId, parts);

    const received = parts.filter((p) => p !== undefined).length;
    if (received < expected) return; // wait for the remaining parts

    // Merge parts in order. Parts were split at paragraph boundaries, so a
    // single newline join preserves the original paragraph structure.
    const merged = Array.from({ length: expected }, (_, i) => parts[i] ?? "")
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    this.partsBuffer.delete(originalId);
    if (this.completedOriginalIds.has(originalId)) return;
    this.completedOriginalIds.add(originalId);
    this.totalCharsTranslated += merged.length;
    this.lastChunkCompletedAt = Date.now();
    await this.onChunkCompleted?.(originalId, merged);
  }

  private startPolling() {
    const poll = async () => {
      if (this.stopped) return;
      try {
        const status = await getCloudStatus(this.jobId);
        this.activeModel = status.activeModel ?? undefined;

        // Pick up chunks that failed since the last tick so the UI shows
        // WHICH section failed and WHY while the job is still running.
        if (status.failedChunks > 0) {
          await this.refreshFailureMap();
        }

        // Use createdAt from the server for accurate elapsed time across reloads
        if (this.startTime === 0 && status.createdAt) {
          this.startTime = status.createdAt;
        }

        // Fetch any newly completed worker units and merge/emit them
        if (status.completedChunks > this.completedUnitIds.size) {
          const units = await getCloudChunks(this.jobId);
          for (const unit of units) {
            await this.handleCompletedUnit(unit.id, unit.text);
          }
        }

        // Progress counts ORIGINAL chunks (parts are invisible to the user)
        const completedOriginal = this.completedOriginalIds.size;
        const failedOriginal = status.failedChunks;
        const done = Math.min(completedOriginal + failedOriginal, this.totalChunks || completedOriginal + failedOriginal);
        const total = this.totalChunks || status.totalChunks;
        const percent = total > 0 ? Math.round((done / total) * 100) : 0;
        const elapsedMs = Date.now() - this.startTime;
        const avgPerChunk = done > 0 ? elapsedMs / done : 0;
        const remaining = Math.max(total - done, 0);
        const charsPerMinute = elapsedMs > 0 && this.totalCharsTranslated > 0
          ? Math.round((this.totalCharsTranslated / elapsedMs) * 60000)
          : 0;
        const timeSinceLastChunkMs = this.lastChunkCompletedAt > 0
          ? Date.now() - this.lastChunkCompletedAt
          : 0;

        const workerHeartbeatMs = status.lastHeartbeat
          ? Date.now() - status.lastHeartbeat
          : 0;

        this.callbacks.onProgress({
          totalChunks: total,
          completedChunks: completedOriginal,
          failedChunks: failedOriginal,
          // Surface per-chunk failure detail so the UI shows WHICH section
          // failed and WHY (worker failures were previously invisible here).
          failures: this.getFailures(),
          activeChunks: 0,
          overallPercent: percent,
          currentChunk:
            status.status === "done"
              ? "Done!"
              : `Chunk ${Math.min(done + 1, total)} of ${total} (cloud)`,
          elapsedMs,
          estimatedRemainingMs: remaining * avgPerChunk,
          activeModel: this.activeModel,
          charsTranslated: this.totalCharsTranslated,
          charsPerMinute,
          timeSinceLastChunkMs,
          workerHeartbeatMs,
        });

        if (status.status === "done" || status.status === "cancelled" || status.status === "paused") {
          this.stopPolling();
          this.callbacks.onDone(status.failedChunks, status.pauseReason);
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
