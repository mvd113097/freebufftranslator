import { v } from "convex/values";
import {
  mutation,
  query,
  action,
  internalQuery,
  internalMutation,
  type ActionCtx,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc } from "./_generated/dataModel";

const SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

## FORMATTING RULES (VERY IMPORTANT - FOLLOW EXACTLY):

You MUST separate EVERY paragraph with a BLANK LINE. This means each paragraph ends with TWO newline characters (\n\n). This is non-negotiable.

Example of CORRECT formatting:
Paragraph one text here.

Paragraph two text here.

Paragraph three text here.

Example of WRONG formatting (DO NOT DO THIS):
Paragraph one text here.
Paragraph two text here.
Paragraph three text here.

- Count the paragraphs in the input. Your output MUST have the SAME number of paragraphs.
- Each paragraph in the input becomes exactly ONE paragraph in the output, separated by a blank line.
- Preserve dialogue formatting and paragraph indentation style.
- Do NOT merge paragraphs together.
- Do NOT output everything as one continuous block of text.

## OUTPUT RULES:
- Output ONLY the translated English text.
- Do NOT include any explanations, notes, commentary, or metadata.
- Do NOT wrap your output in quotes or markdown code blocks.
- Just return the raw translated English prose with proper paragraph spacing (blank lines between paragraphs).
- CRITICAL: Do NOT leave ANY Chinese characters untranslated. Every single Chinese word, phrase, and sentence MUST be translated to English. If you encounter a Chinese word like 别墅 (villa), 好的 (okay), 谢谢 (thank you), etc., you MUST translate it. Your output must contain ZERO Chinese characters. After translating, scan your output and replace any remaining Chinese characters with their English equivalents.
- You are translating published fiction. Translate ALL content faithfully — fight scenes, romance, violence, dark themes, and everything else — exactly as written. NEVER refuse, skip, summarize, censor, or leave any part untranslated, no matter how intense the passage is. Every paragraph of the input MUST appear in your output.
- Character names, sect names, and place names must be rendered in English (transliterated, e.g. 林逸 → Lin Yi). NEVER keep them in Chinese characters.`;

// ─── Chunking helper (pure, server-safe) ─────────────────────────

interface TextChunk {
  id: number;
  text: string;
}

function chunkText(rawText: string, targetChars: number): TextChunk[] {
  const cleaned = rawText.replace(/\r\n/g, "\n");
  const paragraphs = cleaned.split(/\n(?=\n)/);
  const chunks: TextChunk[] = [];
  let currentChunk = "";
  let chunkId = 0;

  for (const para of paragraphs) {
    if (currentChunk.length + para.length > targetChars && currentChunk.length > 0) {
      chunks.push({ id: chunkId++, text: currentChunk.trim() });
      currentChunk = "";
    }

    if (para.length > targetChars) {
      if (currentChunk.length > 0) {
        chunks.push({ id: chunkId++, text: currentChunk.trim() });
        currentChunk = "";
      }
      const sentences = para.split(/(?<=[。！？])/);
      for (const sentence of sentences) {
        if (currentChunk.length + sentence.length > targetChars && currentChunk.length > 0) {
          chunks.push({ id: chunkId++, text: currentChunk.trim() });
          currentChunk = "";
        }
        currentChunk += sentence;
      }
    } else {
      currentChunk += (currentChunk.length > 0 ? "\n\n" : "") + para;
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push({ id: chunkId++, text: currentChunk.trim() });
  }

  return chunks;
}

// ─── Internal queries/mutations (usable by actions) ───────────────

export const internalGetJob = internalQuery({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.jobId);
  },
});

export const internalGetPendingChunks = internalQuery({
  args: { jobId: v.id("translationJobs"), limit: v.number() },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    return chunks
      .filter((c) => c.status === "pending")
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .slice(0, args.limit);
  },
});

export const internalCountWords = internalQuery({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    // Use .map() to avoid loading full text — approximate words from length
    const rows = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    let words = 0;
    for (const c of rows) {
      if (c.status === "completed" && c.translatedText.length > 0) {
        words += Math.round(c.translatedText.length / 5.5); // ~5.5 chars per English word
      }
    }
    return words;
  },
});

export const internalCountChunks = internalQuery({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    return {
      total: chunks.length,
      completed: chunks.filter((c) => c.status === "completed").length,
      failed: chunks.filter((c) => c.status === "failed").length,
    };
  },
});

export const internalPatchChunk = internalMutation({
  args: {
    chunkId: v.id("translationChunks"),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    translatedText: v.optional(v.string()),
    error: v.optional(v.string()),
    retries: v.optional(v.number()),
    usedModel: v.optional(v.string()),
    processingSince: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { status: args.status };
    if (args.translatedText !== undefined) patch.translatedText = args.translatedText;
    if (args.error !== undefined) patch.error = args.error;
    if (args.retries !== undefined) patch.retries = args.retries;
    if (args.usedModel !== undefined) patch.usedModel = args.usedModel;
    if (args.processingSince !== undefined) patch.processingSince = args.processingSince;
    // Clear processingSince when leaving processing state
    if (args.status === "completed" || args.status === "failed" || args.status === "pending") {
      patch.processingSince = undefined;
    }
    await ctx.db.patch(args.chunkId, patch);
  },
});

export const internalPatchJob = internalMutation({
  args: {
    jobId: v.id("translationJobs"),
    status: v.optional(v.union(v.literal("pending"), v.literal("processing"), v.literal("paused"), v.literal("completed"), v.literal("failed"))),
    completedCount: v.optional(v.number()),
    failedCount: v.optional(v.number()),
    lastHeartbeat: v.optional(v.number()),
    lastStatusNotifyAt: v.optional(v.number()),
    activeModel: v.optional(v.string()),
    apiKeys: v.optional(v.array(v.string())),
    // Human-readable reason when the last Telegram notification failed to send.
    // Empty string clears a previous error (a later send succeeded).
    telegramLastError: v.optional(v.string()),
    telegramLastErrorAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.completedCount !== undefined) patch.completedCount = args.completedCount;
    if (args.failedCount !== undefined) patch.failedCount = args.failedCount;
    if (args.activeModel !== undefined) patch.activeModel = args.activeModel;
    if (args.lastHeartbeat !== undefined) patch.lastHeartbeat = args.lastHeartbeat;
    if (args.lastStatusNotifyAt !== undefined) patch.lastStatusNotifyAt = args.lastStatusNotifyAt;
    if (args.apiKeys !== undefined) patch.apiKeys = args.apiKeys;
    if (args.telegramLastError !== undefined) patch.telegramLastError = args.telegramLastError;
    if (args.telegramLastErrorAt !== undefined) patch.telegramLastErrorAt = args.telegramLastErrorAt;
    await ctx.db.patch(args.jobId, patch);
  },
});

/** Reset chunks stuck in 'processing' state back to 'pending'. */
export const internalResetStuckChunks = internalMutation({
  args: {
    jobId: v.id("translationJobs"),
    stuckTimeoutMs: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();

    let resetCount = 0;
    for (const chunk of chunks) {
      if (chunk.status === "processing") {
        const processingSince = (chunk as Record<string, unknown>).processingSince as number | undefined;
        if (processingSince && now - processingSince > args.stuckTimeoutMs) {
          await ctx.db.patch(chunk._id, {
            status: "pending",
            error: undefined,
            retries: 0,
            processingSince: undefined,
          });
          resetCount++;
        }
      }
    }

    return { resetCount };
  },
});

// ─── Public Mutations ────────────────────────────────────────────

/** Start a new translation job. Accepts pre-chunked text to avoid document size limits. */
export const startTranslation = mutation({
  args: {
    fileName: v.string(),
    // Chunks may be gzip-compressed (base64) to save mobile data on upload.
    // `len`/`gzip` are optional so plain-text uploads (older clients/fallback) still work.
    chunks: v.array(v.object({
      text: v.string(),
      len: v.optional(v.number()),
      gzip: v.optional(v.boolean()),
    })),
    model: v.string(),
    chunkSize: v.number(),
    concurrency: v.number(),
    apiKeys: v.array(v.string()),
    telegramBotToken: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    telegramNotifyOnStart: v.optional(v.boolean()),
    telegramNotifyOnProgress: v.optional(v.boolean()),
    telegramNotifyOnError: v.optional(v.boolean()),
    telegramNotifyOnComplete: v.optional(v.boolean()),
    telegramNotifyOnPause: v.optional(v.boolean()),
    telegramStatusInterval: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    const jobId = await ctx.db.insert("translationJobs", {
      userId: userId as string,
      fileName: args.fileName,
      rawTextLength: args.chunks.reduce((sum, c) => sum + (c.len ?? c.text.length), 0),
      totalChunks: args.chunks.length,
      status: "processing",
      model: args.model,
      chunkSize: args.chunkSize,
      concurrency: args.concurrency,
      apiKeys: args.apiKeys,
      completedCount: 0,
      failedCount: 0,
      lastHeartbeat: now,
      createdAt: now,
      updatedAt: now,
      telegramBotToken: args.telegramBotToken,
      telegramChatId: args.telegramChatId,
      telegramNotifyOnStart: args.telegramNotifyOnStart ?? true,
      telegramNotifyOnProgress: args.telegramNotifyOnProgress ?? true,
      telegramNotifyOnError: args.telegramNotifyOnError ?? true,
      telegramNotifyOnComplete: args.telegramNotifyOnComplete ?? true,
      telegramNotifyOnPause: args.telegramNotifyOnPause ?? true,
      telegramStatusInterval: args.telegramStatusInterval ?? 0,
    });

    for (let i = 0; i < args.chunks.length; i++) {
      await ctx.db.insert("translationChunks", {
        jobId,
        chunkIndex: i,
        originalText: args.chunks[i].text,
        originalGzip: args.chunks[i].gzip ?? false,
        translatedText: "",
        status: "pending",
        retries: 0,
      });
    }

    // Start the server-side pipeline from the SERVER (scheduler), not from the
    // browser. That way the translation begins on its own even if the user
    // closes the browser the moment the upload finishes — the scheduled action
    // lives on Convex and self-chains until the job is done.
    await ctx.scheduler.runAfter(500, api.translation.processJob, {
      jobId,
      batchSize: args.concurrency,
    });

    return { jobId, totalChunks: args.chunks.length };
  },
});

/** Pause a running job — the self-chaining loop will stop scheduling new batches. */
export const pauseJob = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || (userId && job.userId !== userId as string)) throw new Error("Unauthorized");
    await ctx.db.patch(args.jobId, { status: "paused", updatedAt: Date.now() });
  },
});

/** Mark a job as aborted/stopped. */
export const abortJob = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || (userId && job.userId !== userId as string)) throw new Error("Unauthorized");
    await ctx.db.patch(args.jobId, { status: "failed", updatedAt: Date.now() });
  },
});

/** Resume a paused/failed/completed job — reset failed chunks back to pending. */
export const resumeJob = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || (userId && job.userId !== userId as string)) throw new Error("Unauthorized");

    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();

    // Reset failed AND stuck processing chunks back to pending
    for (const chunk of chunks) {
      if (chunk.status === "failed" || chunk.status === "processing") {
        await ctx.db.patch(chunk._id, { status: "pending", error: undefined, retries: 0, processingSince: undefined });
      }
    }

    await ctx.db.patch(args.jobId, { status: "processing", failedCount: 0, lastHeartbeat: Date.now(), updatedAt: Date.now() });
  },
});

/** Retranslate only chunks that contain Chinese characters. Resets them to pending and restarts. */
export const retranslateChineseChunks = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || (userId && job.userId !== userId as string)) throw new Error("Unauthorized");

    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();

    const chineseRegex = /[\u4e00-\u9fff]+/;
    let resetCount = 0;
    let remainingCompleted = 0;

    for (const chunk of chunks) {
      if (chunk.status === "completed" && chunk.translatedText.length > 0) {
        if (chineseRegex.test(chunk.translatedText)) {
          await ctx.db.patch(chunk._id, {
            status: "pending",
            translatedText: "",
            error: undefined,
            retries: 0,
          });
          resetCount++;
        } else {
          remainingCompleted++;
        }
      } else if (chunk.status === "completed") {
        remainingCompleted++;
      } else if (chunk.status === "failed" && (chunk.error ?? "").includes("CHINESE_REMAINING")) {
        // Chunks the pipeline could not clean (failed the quality gate) — reset them too.
        await ctx.db.patch(chunk._id, {
          status: "pending",
          translatedText: "",
          error: undefined,
          retries: 0,
        });
        resetCount++;
      }
    }

    if (resetCount > 0) {
      await ctx.db.patch(args.jobId, {
        status: "processing",
        completedCount: remainingCompleted,
        failedCount: 0,
        lastHeartbeat: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return { resetCount };
  },
});

/** Update job settings mid-translation (concurrency, model, apiKeys). */
export const updateJobSettings = mutation({
  args: {
    jobId: v.id("translationJobs"),
    concurrency: v.optional(v.number()),
    model: v.optional(v.string()),
    apiKeys: v.optional(v.array(v.string())),
    telegramBotToken: v.optional(v.string()),
    telegramChatId: v.optional(v.string()),
    telegramNotifyOnStart: v.optional(v.boolean()),
    telegramNotifyOnProgress: v.optional(v.boolean()),
    telegramNotifyOnError: v.optional(v.boolean()),
    telegramNotifyOnComplete: v.optional(v.boolean()),
    telegramNotifyOnPause: v.optional(v.boolean()),
    telegramStatusInterval: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || (userId && job.userId !== userId as string)) throw new Error("Unauthorized");
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.concurrency !== undefined) patch.concurrency = args.concurrency;
    if (args.model !== undefined) patch.model = args.model;
    if (args.apiKeys !== undefined) patch.apiKeys = args.apiKeys;
    if (args.telegramBotToken !== undefined) patch.telegramBotToken = args.telegramBotToken;
    if (args.telegramChatId !== undefined) patch.telegramChatId = args.telegramChatId;
    if (args.telegramNotifyOnStart !== undefined) patch.telegramNotifyOnStart = args.telegramNotifyOnStart;
    if (args.telegramNotifyOnProgress !== undefined) patch.telegramNotifyOnProgress = args.telegramNotifyOnProgress;
    if (args.telegramNotifyOnError !== undefined) patch.telegramNotifyOnError = args.telegramNotifyOnError;
    if (args.telegramNotifyOnComplete !== undefined) patch.telegramNotifyOnComplete = args.telegramNotifyOnComplete;
    if (args.telegramNotifyOnPause !== undefined) patch.telegramNotifyOnPause = args.telegramNotifyOnPause;
    if (args.telegramStatusInterval !== undefined) {
      patch.telegramStatusInterval = args.telegramStatusInterval;
      // Reset the timer so the first notification fires after the new interval
      if (args.telegramStatusInterval > 0) {
        patch.lastStatusNotifyAt = 0;
      }
    }
    await ctx.db.patch(args.jobId, patch);
  },
});

/** Delete a job and all its chunks. */
export const deleteJob = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job || (userId && job.userId !== userId as string)) throw new Error("Unauthorized");
    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }
    await ctx.db.delete(args.jobId);
  },
});

// ─── Public Queries ──────────────────────────────────────────────

/** Get status of a translation job. */
export const getJobStatus = query({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;
    // Only return this job if it belongs to the current user
    if (userId && job.userId && job.userId !== userId as string) return null;

    // Collect then project — only return lightweight fields to client
    const allChunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const chunkRows = allChunks.map((c) => ({
      chunkIndex: c.chunkIndex,
      status: c.status,
      error: c.error,
      translatedLen: c.translatedText.length,
    }));

    let totalEnglishWords = 0;
    let completed = 0;
    let failed = 0;
    let processing = 0;
    for (const c of chunkRows) {
      if (c.status === "completed") completed++;
      else if (c.status === "failed") failed++;
      else if (c.status === "processing") processing++;
      // Approximate word count from text length (avoids loading full text)
      if (c.status === "completed" && c.translatedLen > 0) {
        totalEnglishWords += Math.round(c.translatedLen / 5.5); // ~5.5 chars per English word
      }
    }
    const total = chunkRows.length;

    return {
      fileName: job.fileName,
      totalChunks: job.totalChunks,
      status: job.status,
      completedCount: completed,
      failedCount: failed,
      processingCount: processing,
      activeModel: job.activeModel,
      telegramLastError: job.telegramLastError,
      telegramLastErrorAt: job.telegramLastErrorAt,
      totalEnglishWords,
      lastHeartbeat: job.lastHeartbeat,
      createdAt: job.createdAt,
      percent: total > 0 ? Math.round(((completed + failed) / total) * 100) : 0,
      chunks: chunkRows
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((c) => ({
          id: c.chunkIndex,
          status: c.status,
          error: c.error,
          translatedLength: c.translatedLen,
        })),
    };
  },
});

/** List all jobs for the current user — used for auto-recovery on page reload. */
export const listJobs = query({
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const jobs = await ctx.db
      .query("translationJobs")
      .withIndex("by_userId", (q) => q.eq("userId", userId as string))
      .order("desc")
      .collect();
    return jobs.map((j) => ({
      _id: j._id,
      fileName: j.fileName,
      status: j.status,
      totalChunks: j.totalChunks,
      completedCount: j.completedCount,
      failedCount: j.failedCount,
      percent:
        j.totalChunks > 0
          ? Math.round(((j.completedCount + j.failedCount) / j.totalChunks) * 100)
          : 0,
      createdAt: j.createdAt,
    }));
  },
});

/** Get all completed translated chunks for export. */
/** Lightweight progress query — returns only chunk status, NO text. Used by UI for live progress. */
export const getChunkProgress = query({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job) return { total: 0, completed: 0, failed: 0, chunks: [] };
    if (userId && job.userId && job.userId !== (userId as string)) return { total: 0, completed: 0, failed: 0, chunks: [] };

    // Collect then project — only return lightweight fields to client
    const allChunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    const chunkRows = allChunks.map((c) => ({
      index: c.chunkIndex,
      status: c.status,
      error: c.error,
      retries: c.retries,
    }));

    const sorted = chunkRows.sort((a, b) => a.index - b.index);
    const completed = sorted.filter((c) => c.status === "completed").length;
    const failed = sorted.filter((c) => c.status === "failed").length;

    return {
      total: sorted.length,
      completed,
      failed,
      chunks: sorted,
    };
  },
});

/** Fetch all translated chunks WITH text — used for download/export only. */
export const getTranslatedChunks = query({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    // Verify ownership
    const job = await ctx.db.get(args.jobId);
    if (!job) return [];
    if (userId && job.userId && job.userId !== userId as string) return [];

    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();

    return chunks
      .filter((c) => c.status === "completed" && c.translatedText.length > 0)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((c) => ({ index: c.chunkIndex, text: c.translatedText }));
  },
});

/** On-demand fetch for download/export — NOT a subscription. Returns translated text. */
export const fetchTranslatedChunks = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job) return [];
    if (userId && job.userId && job.userId !== (userId as string)) return [];

    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();

    return chunks
      .filter((c) => c.status === "completed" && c.translatedText.length > 0)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .map((c) => ({ index: c.chunkIndex, text: c.translatedText }));
  },
});

/** Scan translated chunks for remaining Chinese characters. Returns chunks that contain untranslated text. */
export const scanForChinese = query({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const job = await ctx.db.get(args.jobId);
    if (!job) return { totalScanned: 0, chunksWithChinese: [] };
    if (userId && job.userId && job.userId !== userId as string) return { totalScanned: 0, chunksWithChinese: [] };

    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();

    // Completed chunks may carry leftover Chinese (older runs, before the quality gate),
    // and failed chunks can be marked failed precisely because Chinese was left behind.
    const scannedChunks = chunks
      .filter((c) => {
        if (c.status === "completed") return c.translatedText.length > 0;
        if (c.status === "failed") return (c.error ?? "").includes("CHINESE_REMAINING");
        return false;
      })
      .sort((a, b) => a.chunkIndex - b.chunkIndex);

    const chineseRegex = /[\u4e00-\u9fff]+/g;
    const chunksWithChinese: { index: number; matches: string[] }[] = [];

    for (const chunk of scannedChunks) {
      const matches = (chunk.translatedText || "").match(chineseRegex);
      if (matches && matches.length > 0) {
        // Deduplicate
        chunksWithChinese.push({
          index: chunk.chunkIndex,
          matches: [...new Set(matches)],
        });
      }
    }

    return {
      totalScanned: scannedChunks.length,
      chunksWithChinese,
    };
  },
});

// ─── Public Actions (Node runtime, server-side) ──────────────────

/** Process the next batch of pending chunks. Called repeatedly by the frontend or self-chaining. */
export const processNextBatch = action({
  args: {
    jobId: v.id("translationJobs"),
    batchSize: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ done: boolean; processed: number; completed?: number; failed?: number; total?: number; error?: string; reason?: string }> => {
    // Check job is still active
    const job = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
    if (!job || job.status !== "processing") {
      return { done: true, processed: 0, total: 0, reason: job?.status ?? "missing" };
    }

    const apiKeys = job.apiKeys;
    if (!apiKeys || apiKeys.length === 0) {
      return { done: false, processed: 0, total: 0, error: "No API keys" };
    }

    // Use the job's current concurrency (may have been updated mid-translation)
    const effectiveBatchSize = job.concurrency || args.batchSize;

    // Get pending chunks
    const pending = await ctx.runQuery(internal.translation.internalGetPendingChunks, {
      jobId: args.jobId,
      limit: effectiveBatchSize,
    });

    if (pending.length === 0) {
      // Check if all done
      const counts: { total: number; completed: number; failed: number } = await ctx.runQuery(internal.translation.internalCountChunks, { jobId: args.jobId });
      const isAllDone: boolean = counts.completed + counts.failed >= counts.total;

      if (isAllDone) {
        await ctx.runMutation(internal.translation.internalPatchJob, {
          jobId: args.jobId,
          status: "completed",
          completedCount: counts.completed,
          failedCount: counts.failed,
        });
      } else {
        // STUCK CHUNK DETECTION: no pending chunks but not all done means some are stuck in "processing".
        // Reset chunks that have been processing for more than 5 minutes back to pending.
        const STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
        const resetResult = await ctx.runMutation(internal.translation.internalResetStuckChunks, {
          jobId: args.jobId,
          stuckTimeoutMs: STUCK_TIMEOUT_MS,
        });

        if (resetResult.resetCount > 0) {
          await notifyJob(
            ctx,
            job,
            `⚠️ <b>${resetResult.resetCount} stuck chunks recovered</b>\nChunks that were stuck in processing have been reset and will retry.\n📄 ${job.fileName}`,
            "error",
          );
        } else {
          // Chunks are still mid-request (possibly in another batch) — wait a bit before
          // re-checking so we don't spin the scheduler every 500ms while they age out.
          await new Promise((resolve) => setTimeout(resolve, 10_000));
        }
      }

      return {
        done: isAllDone,
        processed: 0,
        completed: counts.completed,
        failed: counts.failed,
        total: counts.total,
      };
    }

    // Send "started" notification on first batch
    const wasJustStarted = job.completedCount === 0 && job.failedCount === 0;
    if (wasJustStarted) {
      await notifyJob(
        ctx,
        job,
        `🚀 <b>Translation Started</b>\n` +
        `📄 ${job.fileName}\n` +
        `📊 ${job.totalChunks} chunks to process\n` +
        `🤖 Model: ${modelDisplay(job.model, undefined)}\n` +
        `⚡ Concurrency: ${job.concurrency}`,
        "start",
      );
    }

    // Assign each chunk to a key (round-robin)
    const chunkAssignments = pending.map((chunk, i) => ({
      chunk,
      apiKey: apiKeys[i % apiKeys.length],
    }));

    // Re-check job status before launching parallel batch
    const preCheck: { status: string } | null = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
    if (!preCheck || preCheck.status !== "processing") {
      if (preCheck?.status === "paused") {
        await notifyJob(ctx, job, `⏸️ <b>Translation Paused</b>\nOpen the browser to resume.`, "pause");
      } else if (preCheck?.status === "failed") {
        await notifyJob(ctx, job, `🛑 <b>Translation Stopped</b>\nOpen the browser to resume or reset.`, "pause");
      }
      return { done: false, processed: 0, reason: preCheck?.status ?? "missing" };
    }

    // Decompress chunks that were gzip-compressed on the phone before upload
    // (saves ~40-50% of upload data). Plain/legacy chunks are used as-is.
    const decodedSource = new Map<string, string>(); // chunk id -> plain text
    const compressedAssigns = chunkAssignments.filter((a) => a.chunk.originalGzip === true);
    if (compressedAssigns.length > 0) {
      let decoded: string[] = [];
      try {
        decoded = await ctx.runAction(internal.decompress.gunzipTexts, {
          items: compressedAssigns.map((a) => ({ data: a.chunk.originalText })),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Translation] Failed to decompress ${compressedAssigns.length} chunk(s):`, msg);
      }
      const failedDecode = new Set<string>();
      for (let i = 0; i < compressedAssigns.length; i++) {
        const a = compressedAssigns[i];
        const text = decoded[i];
        if (typeof text === "string" && text.length > 0) {
          decodedSource.set(a.chunk._id as string, text);
        } else {
          failedDecode.add(a.chunk._id as string);
        }
      }
      if (failedDecode.size > 0) {
        // Never send decompressed garbage to the model — fail these chunks cleanly.
        for (const a of compressedAssigns) {
          if (failedDecode.has(a.chunk._id as string)) {
            await ctx.runMutation(internal.translation.internalPatchChunk, {
              chunkId: a.chunk._id,
              status: "failed",
              error: "DECODE_ERROR: uploaded text could not be decompressed on the server",
              retries: 3,
            });
          }
        }
        await notifyJob(
          ctx,
          job,
          `❌ <b>${failedDecode.size} chunk(s) failed to decompress</b>\nUploaded text could not be restored on the server, so those chunks were marked failed.\n📄 ${job.fileName}`,
          "error",
        );
      }
    }
    const workableAssignments = chunkAssignments.filter(
      (a) => a.chunk.originalGzip !== true || decodedSource.has(a.chunk._id as string)
    );

    // Mark all chunks as processing upfront with a timestamp for stuck detection
    const now = Date.now();
    for (const { chunk } of workableAssignments) {
      await ctx.runMutation(internal.translation.internalPatchChunk, {
        chunkId: chunk._id,
        status: "processing",
        processingSince: now,
      });
    }

    // Periodic Telegram status — checked here at batch START too, because free models can
    // take many minutes per chunk and the periodic check used to only run after a batch
    // ended (so one long batch meant total Telegram silence, even with 5-min configured).
    const maybeSendPeriodicStatus = async (skipIfNothingDoneYet: boolean): Promise<void> => {
      const fresh = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
      const interval = fresh?.telegramStatusInterval ?? 0;
      const botToken = fresh?.telegramBotToken;
      const chatId = fresh?.telegramChatId;
      if (!fresh || !(interval > 0 && botToken && chatId)) return;
      // Skip the very first check — the "🚀 Translation Started" message already covers T0.
      if (skipIfNothingDoneYet && fresh.completedCount === 0 && fresh.failedCount === 0) return;

      const countsNow = await ctx.runQuery(internal.translation.internalCountChunks, { jobId: args.jobId });
      if (countsNow.completed + countsNow.failed >= countsNow.total) return; // completion notif covers it

      const lastNotify = fresh.lastStatusNotifyAt ?? 0;
      if ((Date.now() - lastNotify) / 60_000 < interval) return;

      const elapsedMsNow = Date.now() - fresh.createdAt;
      const elapsedMin = Math.floor(elapsedMsNow / 60_000);
      const elapsedSec = Math.floor((elapsedMsNow % 60_000) / 1000);
      const chunksDone = countsNow.completed;
      const chunksTotal = countsNow.total;
      const chunksPending = chunksTotal - chunksDone - countsNow.failed;
      const percent = chunksTotal > 0 ? Math.round((chunksDone / chunksTotal) * 100) : 0;
      const rate = elapsedMin > 0 ? (chunksDone / elapsedMin).toFixed(1) : "—";

      let etaTxt = "";
      if (chunksDone > 0 && chunksPending > 0) {
        const etaMs = (elapsedMsNow / chunksDone) * chunksPending;
        const etaMin = Math.floor(etaMs / 60_000);
        const etaSec = Math.floor((etaMs % 60_000) / 1000);
        etaTxt = etaMin > 0 ? `~${etaMin}m ${etaSec}s` : `~${etaSec}s`;
      }

      const totalWordsNow: number = await ctx.runQuery(internal.translation.internalCountWords, { jobId: args.jobId });

      await notifyJob(
        ctx,
        { ...fresh },
        `📋 <b>Status Update</b>\n` +
        `📄 ${fresh.fileName}\n` +
        `📊 ${chunksDone}/${chunksTotal} chunks (${percent}%)\n` +
        `📝 ${totalWordsNow.toLocaleString()} English words translated\n` +
        `🤖 Model: ${modelDisplay(fresh.model, fresh.activeModel)}\n` +
        `🔑 API Keys: ${fresh.apiKeys.length}\n` +
        `⚡ Concurrency: ${fresh.concurrency}\n` +
        `⏱️ Elapsed: ${elapsedMin}m ${elapsedSec}s\n` +
        `📈 Rate: ~${rate} chunks/min\n` +
        `${etaTxt ? `⏳ ETA: ${etaTxt}\n` : ""}` +
        `${chunksPending > 0 ? `⏳ ${chunksPending} chunks remaining` : `✅ All done!`}`,
        "status",
      );
      await ctx.runMutation(internal.translation.internalPatchJob, { jobId: args.jobId, lastStatusNotifyAt: Date.now() });
    };
    await maybeSendPeriodicStatus(true);

    // Process ALL chunks in parallel (one per key)
    let processedCount = 0;
    const modelChain = getFallbackChain(job.model);

    const results = await Promise.all(
      workableAssignments.map(async ({ chunk, apiKey }) => {
        let success = false;
        let lastError = "";
        let usedModel: string | undefined;
        let lastDirtyText = "";

        for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx++) {
          const tryModel = modelChain[modelIdx];
          const attemptsForModel = modelIdx === 0 ? 2 : 1; // Primary: 2 tries, fallbacks: 1 — free models are slow, fail fast and move on

          for (let attempt = 0; attempt < attemptsForModel; attempt++) {
            // Re-check job status
            const checkJob: { status: string } | null = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
            if (!checkJob || checkJob.status !== "processing") {
              return { success: false, chunkIndex: chunk.chunkIndex, error: "job_stopped" };
            }

            try {
              // Retry backoff (only on retries, not first attempt)
              if (attempt > 0) {
                await new Promise((r) => setTimeout(r, 1000));
              }

              const sourceText = decodedSource.get(chunk._id as string) ?? chunk.originalText;
              const translated = await callOpenRouter(sourceText, apiKey, tryModel);

              // Quality gate: output still containing Chinese is a FAILURE, not a success.
              // Free models often refuse "sensitive" passages by leaving the Chinese as-is,
              // so a dirty result gets one retry on this model, then moves down the fallback
              // chain — and if every model leaves Chinese, the fragment-repair pass below
              // re-translates only the leftover Chinese runs.
              const chineseRegex = /[\u4e00-\u9fff]+/;
              if (chineseRegex.test(translated)) {
                lastDirtyText = translated;
                lastError = "CHINESE_REMAINING: model left Chinese characters untranslated";
                console.warn(`[Quality] Chunk ${chunk.chunkIndex} model=${tryModel} left Chinese characters (attempt ${attempt + 1}/${attemptsForModel})`);
                if (attempt < attemptsForModel - 1) {
                  await new Promise((r) => setTimeout(r, 1500)); // brief pause before same-model retry
                  continue;
                }
                break; // this model exhausted — try the next one in the chain
              }

              await ctx.runMutation(internal.translation.internalPatchChunk, {
                chunkId: chunk._id,
                translatedText: translated,
                status: "completed",
                retries: attempt + (modelIdx * attemptsForModel),
                usedModel: tryModel,
              });

              success = true;
              usedModel = tryModel;
              break;
            } catch (err: unknown) {
              lastError = err instanceof Error ? err.message : String(err);
              console.error(`[Translation] Chunk ${chunk.chunkIndex} model=${tryModel} attempt ${attempt + 1} failed:`, lastError);

              if (lastError.includes("RATE_LIMITED") || lastError.includes("429")) {
                await new Promise((r) => setTimeout(r, 10000 * (attempt + 1))); // 10s backoff
              } else if (lastError.startsWith("KEY_REJECTED")) {
                // The API key itself is invalid/expired — no model will accept it, so
                // fail this chunk fast instead of wasting minutes on the fallback chain.
                break;
              } else if (lastError.includes("403")) {
                // Transient model/account auth error on free tier — short backoff then next model
                console.warn(`[Retry] Chunk ${chunk.chunkIndex} got 403 on ${tryModel}, retrying in 5s...`);
                await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
              } else if (lastError.includes("502") || lastError.includes("503") || lastError.includes("overloaded")) {
                await new Promise((r) => setTimeout(r, 3000)); // 3s for overloaded
                break;
              } else if (attempt < attemptsForModel - 1) {
                await new Promise((r) => setTimeout(r, 1000));
              }
            }
          }
          if (success) break;
          // Model exhausted — try next immediately (no delay)
        }

        if (!success && lastDirtyText) {
          // Fragment-repair pass: every model left Chinese behind (usually just a few
          // refused fragments or character names). Re-translate ONLY the Chinese runs
          // with a tiny targeted request — far more likely to succeed than re-sending
          // the whole chunk — then stitch the clean fragments back into the text.
          try {
            const repair = await repairChineseFragments(lastDirtyText, apiKey, modelChain);
            if (repair) {
              await ctx.runMutation(internal.translation.internalPatchChunk, {
                chunkId: chunk._id,
                translatedText: repair.text,
                status: "completed",
                retries: 5,
                usedModel: repair.model,
              });
              success = true;
              usedModel = repair.model;
              lastError = "";
              console.log(`[Repair] Chunk ${chunk.chunkIndex} repaired via ${repair.model} (${repair.fragments} fragments)`);
            }
          } catch (repairErr) {
            const msg = repairErr instanceof Error ? repairErr.message : String(repairErr);
            console.error(`[Repair] Chunk ${chunk.chunkIndex} repair pass failed:`, msg);
            lastError = `CHINESE_REMAINING (repair failed): ${msg.slice(0, 160)}`;
          }
        }

        if (!success) {
          await ctx.runMutation(internal.translation.internalPatchChunk, {
            chunkId: chunk._id,
            status: "failed",
            error: lastError.slice(0, 500),
            retries: 5,
          });
        }

        return { success, chunkIndex: chunk.chunkIndex, error: lastError, model: usedModel, apiKey };
      })
    );

    // Count results
    for (const r of results) {
      if (r.success) processedCount++;
    }

    // If any API key was rejected outright by OpenRouter, drop it from the job so
    // future batches stop wasting chunk slots on it. (Full keys are only compared
    // here — never logged; notifications only show the last 4 characters.)
    const rejectedKeys = new Set<string>();
    for (const r of results) {
      if (!r.success && r.apiKey && r.error && r.error.startsWith("KEY_REJECTED")) {
        rejectedKeys.add(r.apiKey);
      }
    }
    if (rejectedKeys.size > 0) {
      const remainingKeys = job.apiKeys.filter((k) => !rejectedKeys.has(k));
      if (remainingKeys.length < job.apiKeys.length) {
        await ctx.runMutation(internal.translation.internalPatchJob, {
          jobId: args.jobId,
          apiKeys: remainingKeys,
        });
        const tails = [...rejectedKeys].map((k) => `…${k.slice(-4)}`).join(", ");
        await notifyJob(
          ctx,
          job,
          `⚠️ <b>${rejectedKeys.size} invalid API key${rejectedKeys.size > 1 ? "s" : ""} removed</b>\nOpenRouter rejected key${rejectedKeys.size > 1 ? "s" : ""} ${tails}.\n${rejectedKeys.size > 1 ? "They were" : "It was"} removed from this translation — chunks that had been assigned to ${rejectedKeys.size > 1 ? "them" : "it"} failed.\nRemove ${rejectedKeys.size > 1 ? "them" : "it"} from your key list too (probably pasted wrong or expired).\n📄 ${job.fileName}`,
          "error",
        );
      }
    }

    // Update job progress
    const counts: { total: number; completed: number; failed: number } = await ctx.runQuery(internal.translation.internalCountChunks, { jobId: args.jobId });
    const isAllDone: boolean = counts.completed + counts.failed >= counts.total;

    // One consolidated Telegram alert per batch that produced NEW failures — instead of a
    // message per chunk, so a wave of failures can't spam Telegram or get lost.
    const failedResults = results.filter((r) => !r.success && r.error && r.error !== "job_stopped");
    const newFailuresThisBatch = counts.failed - job.failedCount;
    if (failedResults.length > 0 && newFailuresThisBatch > 0) {
      const chunkNums = failedResults.map((r) => r.chunkIndex + 1).join(", ");
      const sampleErr = failedResults[failedResults.length - 1]?.error?.slice(0, 160) ?? "unknown error";
      await notifyJob(
        ctx,
        job,
        `❌ <b>${failedResults.length} chunk${failedResults.length > 1 ? "s" : ""} failed</b>\n` +
        `Chunks: ${chunkNums}\n` +
        `📊 ${counts.failed}/${counts.total} failed total\n` +
        `🔍 Error: ${sampleErr}\n` +
        `📄 ${job.fileName}\n` +
        `💡 Pause then Resume retries failed chunks.`,
        "error",
      );
    }

    // Determine the most recently successful model from the batch
    let lastSuccessfulModel: string | undefined;
    for (const r of results) {
      if (r.success && r.model) {
        lastSuccessfulModel = r.model;
      }
    }

    await ctx.runMutation(internal.translation.internalPatchJob, {
      jobId: args.jobId,
      status: isAllDone ? "completed" : "processing",
      completedCount: counts.completed,
      failedCount: counts.failed,
      lastHeartbeat: Date.now(),
      ...(lastSuccessfulModel ? { activeModel: lastSuccessfulModel } : {}),
    });

    // Send progress notification every 10% or on completion
    const percentNow = Math.round(((counts.completed + counts.failed) / counts.total) * 100);
    const prevPercent = Math.round(((job.completedCount + job.failedCount) / job.totalChunks) * 100);
    const crossedTenPercent = Math.floor(percentNow / 10) > Math.floor(prevPercent / 10);

    // Helper to build detailed notification text
    const buildProgressText = async (pct: number, countsRef: { completed: number; failed: number; total: number }, jobRef: typeof job) => {
      const elapsed = Date.now() - jobRef.createdAt;
      const elapsedMin = Math.floor(elapsed / 60_000);
      const elapsedSec = Math.floor((elapsed % 60_000) / 1000);
      const elapsedStr = elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`;
      const chunksDone = countsRef.completed;
      const chunksTotal = countsRef.total;
      const chunksPending = chunksTotal - chunksDone - countsRef.failed;
      const rate = elapsedMin > 0 ? (chunksDone / elapsedMin).toFixed(1) : "—";
      const wordCount: number = await ctx.runQuery(internal.translation.internalCountWords, { jobId: jobRef._id });

      let etaStr = "";
      if (chunksDone > 0 && chunksPending > 0) {
        const avgPerChunk = elapsed / chunksDone;
        const etaMs = avgPerChunk * chunksPending;
        const etaMin = Math.floor(etaMs / 60_000);
        const etaSec = Math.floor((etaMs % 60_000) / 1000);
        etaStr = etaMin > 0 ? `~${etaMin}m ${etaSec}s` : `~${etaSec}s`;
      }

      return {
        elapsedStr, chunksDone, chunksTotal, chunksPending, rate, wordCount, etaStr,
        text: `📄 ${jobRef.fileName}\n` +
          `📊 ${chunksDone}/${chunksTotal} chunks (${pct}%)\n` +
          `📝 ${wordCount.toLocaleString()} English words\n` +
          `🤖 Model: ${modelDisplay(jobRef.model, jobRef.activeModel)}\n` +
          `⏱️ Elapsed: ${elapsedStr}\n` +
          `📈 Rate: ~${rate} chunks/min` +
          (countsRef.failed > 0 ? `\n❌ ${countsRef.failed} chunks failed` : "") +
          (etaStr ? `\n⏳ ETA: ${etaStr}` : ""),
      };
    };

    // Only send notifications if there were actual changes
    if (processedCount > 0 || isAllDone) {
      const pct = Math.round(((counts.completed + counts.failed) / counts.total) * 100);
      const detail = await buildProgressText(pct, counts, job);

      if (isAllDone) {
        await notifyJob(
          ctx,
          job,
          `✅ <b>Translation Complete!</b>\n${detail.text}\n📥 Ready to download!`,
          "complete",
        );
      } else if (crossedTenPercent) {
        // 10% milestone — uses "progress" type (respects checkbox)
        await notifyJob(
          ctx,
          job,
          `📊 <b>Progress: ${pct}%</b>\n${detail.text}`,
          "progress",
        );
      }
    }

    // Periodic status update (every N minutes if configured) — the interval is also enforced
    // at batch start (see maybeSendPeriodicStatus above), so a long-running batch still sends
    // updates at the configured cadence instead of staying silent until the batch finishes.
    await maybeSendPeriodicStatus(false);

    return {
      done: isAllDone,
      processed: processedCount,
      completed: counts.completed,
      failed: counts.failed,
      total: counts.total,
    };
  },
});

/**
 * Self-chaining action: processes a batch, then schedules the next batch
 * after a delay if there are still pending chunks. This allows the
 * translation pipeline to continue running on Convex servers even after
 * the browser is closed.
 */
export const processJob = action({
  args: {
    jobId: v.id("translationJobs"),
    batchSize: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ done: boolean; processed: number; completed?: number; failed?: number; total?: number; error?: string }> => {
    // Read current job settings (concurrency may have changed mid-translation)
    const currentJob = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
    const currentBatchSize = currentJob?.concurrency ?? args.batchSize;

    // Process the current batch
    let result;
    try {
      result = await ctx.runAction(api.translation.processNextBatch, {
        jobId: args.jobId,
        batchSize: currentBatchSize,
      });
    } catch (err) {
      // The batch action died (infra blip / function timeout) instead of returning normally.
      // Reset the chunks it was holding, notify the user, and restart the chain so a job can
      // never freeze silently in "processing" with no worker ever running again.
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Translation] processNextBatch crashed for job ${args.jobId}:`, errMsg);
      const crashedJob = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
      if (crashedJob && crashedJob.status === "processing") {
        await ctx.runMutation(internal.translation.internalResetStuckChunks, {
          jobId: args.jobId,
          stuckTimeoutMs: 30_000, // anything this crashed batch touched is orphaned
        });
        const lastNotify = crashedJob.lastStatusNotifyAt ?? 0;
        if (Date.now() - lastNotify > 60_000) {
        await notifyJob(
          ctx,
          { ...crashedJob },
          `⚠️ <b>Pipeline hiccup — auto-recovering</b>\nA worker batch crashed (${errMsg.slice(0, 120)}).\nThe chunks it was holding were reset and will retry automatically — no action needed.\n📄 ${crashedJob.fileName}`,
          "error",
        );
          await ctx.runMutation(internal.translation.internalPatchJob, {
            jobId: args.jobId,
            lastStatusNotifyAt: Date.now(),
          });
        }
        // Restart the self-chaining loop so translation continues on its own
        await ctx.scheduler.runAfter(3_000, api.translation.processJob, {
          jobId: args.jobId,
          batchSize: currentBatchSize,
        });
      }
      return { done: false, processed: 0, error: errMsg };
    }

    if (!result.done) {
      // If the batch was paused/stopped mid-processing, don't reschedule
      if (result.reason === "paused" || result.reason === "failed" || result.reason === "missing") {
        return result;
      }

      // Schedule next batch after 500ms (rate limiting is per-key, no need to wait long)
      await ctx.scheduler.runAfter(500, api.translation.processJob, {
        jobId: args.jobId,
        batchSize: currentBatchSize,
      });
    }

    return result;
  },
});

// ─── Telegram notifications ─────────────────────────────────────

async function sendTelegram(
  botToken: string,
  chatId: string,
  message: string,
): Promise<string | null> {
  // Support multiple chat IDs separated by commas
  const chatIds = chatId.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  let firstError: string | null = null;
  for (const id of chatIds) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text: message,
          parse_mode: "HTML",
        }),
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        let reason = bodyText.trim().slice(0, 160) || `HTTP ${response.status}`;
        if (response.status === 401) reason = "bot token is invalid (HTTP 401)";
        else if (response.status === 403) {
          reason = "bot is blocked by the user or can't message this chat (HTTP 403)";
        } else if (response.status === 400) {
          reason = `chat "${id}" not found — did you start the bot and use the right chat id? (HTTP 400)`;
        }
        console.error(`[Telegram] Failed to send to chat ${id}: ${reason}`);
        firstError = firstError ?? `Telegram send to chat ${id} failed — ${reason}`;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Telegram] Failed to send to ${id}:`, err);
      firstError = firstError ?? `Telegram send to chat ${id} failed — ${msg}`;
    }
  }
  return firstError;
}

type NotificationType = "start" | "progress" | "error" | "complete" | "pause" | "status";

async function notifyJob(
  ctx: ActionCtx,
  job: Doc<"translationJobs">,
  message: string,
  type: NotificationType,
): Promise<void> {
  if (!job.telegramBotToken || !job.telegramChatId) return;

  // Check if this notification type is enabled
  const prefMap: Record<NotificationType, boolean | undefined> = {
    start: job.telegramNotifyOnStart,
    progress: job.telegramNotifyOnProgress,
    error: job.telegramNotifyOnError,
    complete: job.telegramNotifyOnComplete,
    pause: job.telegramNotifyOnPause,
    status: true, // periodic status always passes the interval check separately
  };

  if (type !== "status" && prefMap[type] === false) return;

  const sendError = await sendTelegram(job.telegramBotToken, job.telegramChatId, message);

  // Record failures on the job so the dashboard can explain why no messages are
  // arriving (Telegram send errors used to be completely silent). Cleared once a
  // later send succeeds.
  try {
    if (sendError) {
      await ctx.runMutation(internal.translation.internalPatchJob, {
        jobId: job._id,
        telegramLastError: sendError.slice(0, 300),
        telegramLastErrorAt: Date.now(),
      });
    } else if (job.telegramLastError) {
      await ctx.runMutation(internal.translation.internalPatchJob, {
        jobId: job._id,
        telegramLastError: "",
      });
    }
  } catch (err) {
    console.error("[Telegram] Failed to record send status on job:", err);
  }
}

// ─── Model fallback chain ───────────────────────────────────────
// If the primary model fails, try these in order. These are all free models
// on OpenRouter with decent context windows suitable for novel translation.
const FALLBACK_MODELS = [
  "minimax/minimax-m3:free",
  "qwen/qwen3.6-plus:free",
  "z-ai/glm-5.2:free",
  "qwen/qwen3-235b-a22b-07-25:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "thinkingmachines/inkling:free",
];

// "Auto Free (best available)" is the UI selector stored on jobs — it is NOT a real
// OpenRouter model id, so it must never be sent to the API.
const AUTO_FREE_SELECTOR = "openrouter/free";

function isAutoFreeSelector(model: string): boolean {
  return model === AUTO_FREE_SELECTOR || model === "openrouter/auto" || model === "auto";
}

/** Short human-friendly label for a real model id, e.g. "minimax/m3" → "minimax-m3". */
function shortModelName(model: string): string {
  const short = model.split("/").pop() ?? model;
  return short.replace(/:free$/, "");
}

/**
 * Model label for messages/status: shows the real model currently doing work, and
 * makes it obvious when Auto Free picked it or when a fallback took over.
 */
function modelDisplay(selectedModel: string, activeModel: string | undefined): string {
  if (isAutoFreeSelector(selectedModel)) {
    return activeModel
      ? `${shortModelName(activeModel)} (Auto Free)`
      : "Auto Free (choosing best available)";
  }
  return activeModel ? shortModelName(activeModel) : shortModelName(selectedModel);
}

function getFallbackChain(primaryModel: string): string[] {
  // "Auto Free" is a UI-only selector — sending it to OpenRouter would make every
  // chunk fail before it even reached the free list. Skip straight to the ordered
  // free-model list (best available first) instead.
  if (isAutoFreeSelector(primaryModel)) {
    return [...FALLBACK_MODELS];
  }
  // Build a chain: primary first, then fallbacks (excluding the primary)
  const chain = [primaryModel];
  for (const m of FALLBACK_MODELS) {
    if (m !== primaryModel) chain.push(m);
  }
  return chain;
}

// ─── OpenRouter API call (server-side) ───────────────────────────

/** Extract the human-readable message out of an OpenRouter error body (JSON or text). */
function extractApiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const msg =
      (parsed?.error?.message as string | undefined) ??
      (parsed?.message as string | undefined);
    if (typeof msg === "string" && msg.trim().length > 0) return msg.trim().slice(0, 200);
  } catch {
    // not JSON — fall through to raw text
  }
  return body.trim().slice(0, 200);
}

async function callOpenRouter(text: string, apiKey: string, model: string): Promise<string> {
  const payload = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    temperature: 0.5,
    top_p: 0.9,
    max_tokens: 16384,
    stream: false,
  };

  // 10-minute timeout: long enough for a big chunk on a slow free model to finish
  // (generating ~10-16K tokens can legitimately take 5-10 minutes), but still prevents
  // the action from hanging forever on a truly stalled API call.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  try {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });

  if (response.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (response.status === 401 || response.status === 403) {
    // Read the provider's real error so we can tell a dead key from a model
    // restriction, instead of reporting a generic "invalid key" for everything.
    const bodyText = await response.text().catch(() => "");
    const realMsg = extractApiErrorMessage(bodyText);
    const low = bodyText.toLowerCase();
    const looksLikeKeyProblem =
      response.status === 401 ||
      /api[ _-]?key|invalid|expired|unauthorized|credential|permission|forbidden|denied|authentication|access denied|no access/.test(low);
    if (looksLikeKeyProblem) {
      // The API key itself is bad — no model will accept it. Fail fast and let the
      // batch logic remove this key from the job so it stops eating chunks.
      throw new Error(`KEY_REJECTED (key …${apiKey.slice(-4)}): ${realMsg || "Invalid or expired API key"}`);
    }
    // Model/account-specific 403 — may be transient, retry across models normally.
    throw new Error(`AUTH_ERROR_${response.status}: ${realMsg || "Request rejected"}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    // Detect overloaded server errors
    if (body.includes("overloaded") || body.includes("503") || body.includes("502")) {
      throw new Error(`SERVER_ERROR_${response.status}: Model overloaded`);
    }
    throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();

  // OpenRouter sometimes returns errors in the response body even with 200
  if (data.error) {
    const errMsg = typeof data.error === "string" ? data.error : data.error.message || JSON.stringify(data.error);
    throw new Error(`MODEL_ERROR: ${errMsg.slice(0, 200)}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) {
    throw new Error("No translation content in response");
  }
  return normalizeParagraphs(content);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("API_TIMEOUT: Request timed out after 10 minutes");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Repair pass: re-translate ONLY the Chinese fragments left in a dirty translation.
 *
 * Free models often refuse a few "sensitive" sentences (or keep character names in
 * Chinese), leaving Chinese runs inside an otherwise-fine translation. Re-sending the
 * whole chunk usually fails the same way, so instead we extract just the Chinese
 * fragments, translate them with a tiny targeted prompt, and stitch the results back in.
 * Returns the clean full text, or null if no model could clean it.
 */
async function repairChineseFragments(
  translated: string,
  apiKey: string,
  models: string[],
): Promise<{ text: string; model: string; fragments: number } | null> {
  const fragmentRegex = /[\u4e00-\u9fff]+/g;
  // Longest-first so a name like 林逸风 is replaced before the substring 林逸.
  const fragments = [...new Set(translated.match(fragmentRegex) ?? [])]
    .slice(0, 80)
    .sort((a, b) => b.length - a.length);
  if (fragments.length === 0) return null;

  const repairPrompt =
    `Translate each Chinese fragment below into fluent, natural English. ` +
    `Character names should be transliterated into English (e.g. 林逸 → Lin Yi). ` +
    `Output ONLY the translations — exactly one per line, in the same order as the input. ` +
    `Do not add numbering, quotes, explanations, or anything else.\n\n` +
    fragments.map((f, i) => `${i + 1}. ${f}`).join("\n");

  for (const model of models) {
    try {
      const raw = await callOpenRouter(repairPrompt, apiKey, model);
      // callOpenRouter normalizes paragraphs (blank line between paragraphs), so each
      // translation ends up on its own line; strip any "1."-style numbering too.
      const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((l) => l.replace(/^\d+[.)]\s*/, ""));
      if (lines.length !== fragments.length) continue; // merged/missing lines — try next model

      let repaired = translated;
      for (let i = 0; i < fragments.length; i++) {
        repaired = repaired.split(fragments[i]).join(lines[i]);
      }
      // Only accept if the stitched result is genuinely clean.
      if (!fragmentRegex.test(repaired)) {
        return { text: normalizeParagraphs(repaired), model, fragments: fragments.length };
      }
    } catch {
      // this model failed — try the next one
    }
  }
  return null;
}

/**
 * Post-process translated text to ensure proper paragraph spacing.
 * Some models collapse paragraph breaks into single newlines or no breaks.
 * This function normalizes the output to always have blank lines between paragraphs.
 */
function normalizeParagraphs(text: string): string {
  // Step 1: Normalize line endings
  let result = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Step 2: Convert ALL single newlines between text lines to double newlines.
  // This ensures every paragraph has a blank line after it, regardless of
  // whether the model already used some double newlines.
  // Pattern: a single \n that is NOT part of \n\n, and sits between
  // non-empty lines (text on both sides = paragraph break).
  result = result.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");

  // Step 3: Collapse 3+ consecutive newlines into exactly 2 (one blank line)
  result = result.replace(/\n{3,}/g, "\n\n");

  // Step 4: Trim leading/trailing whitespace on each line
  result = result
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  // Step 5: Trim leading/trailing whitespace of the whole text
  result = result.trim();

  // Step 6: Ensure the text ends with a single newline
  if (!result.endsWith("\n")) {
    result += "\n";
  }

  return result;
}
