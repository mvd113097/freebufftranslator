import { v } from "convex/values";
import { mutation, query, action, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";

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
- CRITICAL: Do NOT leave ANY Chinese characters untranslated. Every single Chinese word, phrase, and sentence MUST be translated to English. If you encounter a Chinese word like 别墅 (villa), 好的 (okay), 谢谢 (thank you), etc., you MUST translate it. Your output must contain ZERO Chinese characters. After translating, scan your output and replace any remaining Chinese characters with their English equivalents.`;

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
    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();
    let words = 0;
    for (const c of chunks) {
      if (c.status === "completed" && c.translatedText.length > 0) {
        words += c.translatedText.split(/\s+/).filter((w) => w.length > 0).length;
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
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { status: args.status };
    if (args.translatedText !== undefined) patch.translatedText = args.translatedText;
    if (args.error !== undefined) patch.error = args.error;
    if (args.retries !== undefined) patch.retries = args.retries;
    if (args.usedModel !== undefined) patch.usedModel = args.usedModel;
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
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.completedCount !== undefined) patch.completedCount = args.completedCount;
    if (args.failedCount !== undefined) patch.failedCount = args.failedCount;
    if (args.activeModel !== undefined) patch.activeModel = args.activeModel;
    if (args.lastHeartbeat !== undefined) patch.lastHeartbeat = args.lastHeartbeat;
    if (args.lastStatusNotifyAt !== undefined) patch.lastStatusNotifyAt = args.lastStatusNotifyAt;
    await ctx.db.patch(args.jobId, patch);
  },
});

// ─── Public Mutations ────────────────────────────────────────────

/** Start a new translation job. Accepts pre-chunked text to avoid document size limits. */
export const startTranslation = mutation({
  args: {
    fileName: v.string(),
    chunks: v.array(v.object({ text: v.string() })),
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
      rawTextLength: args.chunks.reduce((sum, c) => sum + c.text.length, 0),
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
        translatedText: "",
        status: "pending",
        retries: 0,
      });
    }

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

    // Reset only failed chunks; keep completed ones
    for (const chunk of chunks) {
      if (chunk.status === "failed") {
        await ctx.db.patch(chunk._id, { status: "pending", error: undefined, retries: 0 });
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

    const chunks = await ctx.db
      .query("translationChunks")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .collect();

    const completed = chunks.filter((c) => c.status === "completed").length;
    const failed = chunks.filter((c) => c.status === "failed").length;
    const total = chunks.length;

    // Count English words in completed translations
    let totalEnglishWords = 0;
    for (const c of chunks) {
      if (c.status === "completed" && c.translatedText.length > 0) {
        totalEnglishWords += c.translatedText.split(/\s+/).filter((w) => w.length > 0).length;
      }
    }

    // Count processing chunks (active in-flight)
    const processing = chunks.filter((c) => c.status === "processing").length;

    return {
      fileName: job.fileName,
      totalChunks: job.totalChunks,
      status: job.status,
      completedCount: completed,
      failedCount: failed,
      processingCount: processing,
      activeModel: job.activeModel,
      totalEnglishWords,
      lastHeartbeat: job.lastHeartbeat,
      createdAt: job.createdAt,
      percent: total > 0 ? Math.round(((completed + failed) / total) * 100) : 0,
      chunks: chunks
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((c) => ({
          id: c.chunkIndex,
          status: c.status,
          error: c.error,
          translatedLength: c.translatedText.length,
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

    const completedChunks = chunks
      .filter((c) => c.status === "completed" && c.translatedText.length > 0)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);

    const chineseRegex = /[\u4e00-\u9fff]+/g;
    const chunksWithChinese: { index: number; matches: string[] }[] = [];

    for (const chunk of completedChunks) {
      const matches = chunk.translatedText.match(chineseRegex);
      if (matches && matches.length > 0) {
        // Deduplicate
        chunksWithChinese.push({
          index: chunk.chunkIndex,
          matches: [...new Set(matches)],
        });
      }
    }

    return {
      totalScanned: completedChunks.length,
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
        job,
        `🚀 <b>Translation Started</b>\n` +
        `📄 ${job.fileName}\n` +
        `📊 ${job.totalChunks} chunks to process\n` +
        `🤖 Model: ${job.model}\n` +
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
        await notifyJob(job, `⏸️ <b>Translation Paused</b>\nOpen the browser to resume.`, "pause");
      } else if (preCheck?.status === "failed") {
        await notifyJob(job, `🛑 <b>Translation Stopped</b>\nOpen the browser to resume or reset.`, "pause");
      }
      return { done: false, processed: 0, reason: preCheck?.status ?? "missing" };
    }

    // Mark all chunks as processing upfront
    for (const { chunk } of chunkAssignments) {
      await ctx.runMutation(internal.translation.internalPatchChunk, {
        chunkId: chunk._id,
        status: "processing",
      });
    }

    // Process ALL chunks in parallel (one per key)
    let processedCount = 0;
    const modelChain = getFallbackChain(job.model);

    const results = await Promise.all(
      chunkAssignments.map(async ({ chunk, apiKey }) => {
        let success = false;
        let lastError = "";
        let usedModel: string | undefined;

        for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx++) {
          const tryModel = modelChain[modelIdx];
          const attemptsForModel = modelIdx === 0 ? 3 : 2; // Primary: 3 tries, fallbacks: 2

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

              const translated = await callOpenRouter(chunk.originalText, apiKey, tryModel);

              // Quality gate: reject if output still contains Chinese characters
              const chineseRegex = /[\u4e00-\u9fff]+/;
              if (chineseRegex.test(translated) && attempt < attemptsForModel - 1) {
                console.warn(`[Quality] Chunk ${chunk.chunkIndex} contains Chinese characters, retrying...`);
                continue; // retry same model immediately
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
              } else if (lastError.includes("403")) {
                // Transient auth error on free models — retry with backoff
                console.warn(`[Retry] Chunk ${chunk.chunkIndex} got 403 on ${tryModel}, retrying in 5s...`);
                await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
              } else if (lastError.includes("401")) {
                break; // Real invalid key — skip to next model
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

        if (!success) {
          await ctx.runMutation(internal.translation.internalPatchChunk, {
            chunkId: chunk._id,
            status: "failed",
            error: lastError.slice(0, 500),
            retries: 5,
          });
          await notifyJob(
            job,
            `❌ <b>Chunk ${chunk.chunkIndex + 1} failed</b>\nError: ${lastError.slice(0, 200)}`,
            "error",
          );
        }

        return { success, chunkIndex: chunk.chunkIndex, error: lastError, model: usedModel };
      })
    );

    // Count results
    for (const r of results) {
      if (r.success) processedCount++;
    }

    // Update job progress
    const counts: { total: number; completed: number; failed: number } = await ctx.runQuery(internal.translation.internalCountChunks, { jobId: args.jobId });
    const isAllDone: boolean = counts.completed + counts.failed >= counts.total;

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
          `🤖 Model: ${jobRef.activeModel ?? jobRef.model}\n` +
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
          job,
          `✅ <b>Translation Complete!</b>\n${detail.text}\n📥 Ready to download!`,
          "complete",
        );
      } else if (crossedTenPercent) {
        // 10% milestone — uses "progress" type (respects checkbox)
        await notifyJob(
          job,
          `📊 <b>Progress: ${pct}%</b>\n${detail.text}`,
          "progress",
        );
      }
    }

    // Periodic status update (every N minutes if configured)
    const statusIntervalMin = job.telegramStatusInterval ?? 0;
    if (statusIntervalMin > 0 && job.telegramBotToken && job.telegramChatId) {
      const lastNotify = job.lastStatusNotifyAt ?? 0;
      const minutesSince = (Date.now() - lastNotify) / 60_000;
      if (minutesSince >= statusIntervalMin && !isAllDone) {
        const elapsed = Date.now() - job.createdAt;
        const elapsedMin = Math.floor(elapsed / 60_000);
        const elapsedSec = Math.floor((elapsed % 60_000) / 1000);
        const chunksDone = counts.completed;
        const chunksTotal = counts.total;
        const chunksPending = chunksTotal - chunksDone - counts.failed;
        const percent = chunksTotal > 0 ? Math.round((chunksDone / chunksTotal) * 100) : 0;
        const rate = elapsedMin > 0 ? (chunksDone / elapsedMin).toFixed(1) : "—";

        let etaStr2 = "";
        if (chunksDone > 0 && chunksPending > 0) {
          const avgPerChunk = elapsed / chunksDone;
          const etaMs = avgPerChunk * chunksPending;
          const etaMin = Math.floor(etaMs / 60_000);
          const etaSec = Math.floor((etaMs % 60_000) / 1000);
          etaStr2 = etaMin > 0 ? `~${etaMin}m ${etaSec}s` : `~${etaSec}s`;
        }

        // Count English words via internal query
        const totalWords: number = await ctx.runQuery(internal.translation.internalCountWords, { jobId: args.jobId });

        await notifyJob(
          job,
          `📋 <b>Status Update</b>\n` +
          `📄 ${job.fileName}\n` +
          `📊 ${chunksDone}/${chunksTotal} chunks (${percent}%)\n` +
          `📝 ${totalWords.toLocaleString()} English words translated\n` +
          `🤖 Model: ${job.activeModel ?? job.model}\n` +
          `🔑 API Keys: ${job.apiKeys.length}\n` +
          `⚡ Concurrency: ${job.concurrency}\n` +
          `⏱️ Elapsed: ${elapsedMin}m ${elapsedSec}s\n` +
          `📈 Rate: ~${rate} chunks/min\n` +
          `${etaStr2 ? `⏳ ETA: ${etaStr2}\n` : ""}` +
          `${chunksPending > 0 ? `⏳ ${chunksPending} chunks remaining` : `✅ All done!`}`,
          "status",
        );
        await ctx.runMutation(internal.translation.internalPatchJob, {
          jobId: args.jobId,
          lastStatusNotifyAt: Date.now(),
        });
      }
    }

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
    const result = await ctx.runAction(api.translation.processNextBatch, {
      jobId: args.jobId,
      batchSize: currentBatchSize,
    });

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

async function sendTelegram(botToken: string, chatId: string, message: string): Promise<void> {
  // Support multiple chat IDs separated by commas
  const chatIds = chatId.split(",").map((id) => id.trim()).filter((id) => id.length > 0);
  for (const id of chatIds) {
    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text: message,
          parse_mode: "HTML",
        }),
      });
    } catch (err) {
      console.error(`[Telegram] Failed to send to ${id}:`, err);
    }
  }
}

type NotificationType = "start" | "progress" | "error" | "complete" | "pause" | "status";

async function notifyJob(
  job: {
    telegramBotToken?: string;
    telegramChatId?: string;
    telegramNotifyOnStart?: boolean;
    telegramNotifyOnProgress?: boolean;
    telegramNotifyOnError?: boolean;
    telegramNotifyOnComplete?: boolean;
    telegramNotifyOnPause?: boolean;
    telegramStatusInterval?: number;
    lastStatusNotifyAt?: number;
    fileName: string;
    totalChunks: number;
    completedCount: number;
    failedCount: number;
    model: string;
    totalEnglishWords?: number;
  },
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

  await sendTelegram(job.telegramBotToken, job.telegramChatId, message);
}

// ─── Model fallback chain ───────────────────────────────────────
// If the primary model fails, try these in order. These are all free models
// on OpenRouter with decent context windows suitable for novel translation.
const FALLBACK_MODELS = [
  "minimax/minimax-m3:free",
  "z-ai/glm-5.2:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3.5-lightning:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "thinkingmachines/inkling:free",
];

function getFallbackChain(primaryModel: string): string[] {
  // Build a chain: primary first, then fallbacks (excluding the primary)
  const chain = [primaryModel];
  for (const m of FALLBACK_MODELS) {
    if (m !== primaryModel) chain.push(m);
  }
  return chain;
}

// ─── OpenRouter API call (server-side) ───────────────────────────

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

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(`AUTH_ERROR_${response.status}: Invalid or expired API key`);
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
