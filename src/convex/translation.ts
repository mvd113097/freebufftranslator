import { v } from "convex/values";
import { mutation, query, action, internalQuery, internalMutation } from "./_generated/server";
import { api, internal } from "./_generated/api";

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
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.completedCount !== undefined) patch.completedCount = args.completedCount;
    if (args.failedCount !== undefined) patch.failedCount = args.failedCount;
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
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const jobId = await ctx.db.insert("translationJobs", {
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
      createdAt: now,
      updatedAt: now,
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
    await ctx.db.patch(args.jobId, { status: "paused", updatedAt: Date.now() });
  },
});

/** Mark a job as aborted/stopped. */
export const abortJob = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, { status: "failed", updatedAt: Date.now() });
  },
});

/** Resume a paused/failed/completed job — reset failed chunks back to pending. */
export const resumeJob = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
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

    await ctx.db.patch(args.jobId, { status: "processing", failedCount: 0, updatedAt: Date.now() });
  },
});

/** Update job settings mid-translation (concurrency, model). */
export const updateJobSettings = mutation({
  args: {
    jobId: v.id("translationJobs"),
    concurrency: v.optional(v.number()),
    model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.concurrency !== undefined) patch.concurrency = args.concurrency;
    if (args.model !== undefined) patch.model = args.model;
    await ctx.db.patch(args.jobId, patch);
  },
});

/** Delete a job and all its chunks. */
export const deleteJob = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
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
    const job = await ctx.db.get(args.jobId);
    if (!job) return null;

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
      totalEnglishWords,
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

/** List all jobs — used for auto-recovery on page reload. */
export const listJobs = query({
  handler: async (ctx) => {
    const jobs = await ctx.db.query("translationJobs").order("desc").collect();
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

    // Process each chunk
    let processedCount = 0;
    let keyIndex = 0;
    const modelChain = getFallbackChain(job.model);

    // Track last-use time per key for per-key rate limiting
    // Only wait between requests using the SAME key
    const keyLastUsed: Map<string, number> = new Map();

    for (const chunk of pending) {
      // Re-check job status before each chunk — if paused/stopped, bail immediately
      const currentJob: { status: string } | null = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
      if (!currentJob || currentJob.status !== "processing") {
        return {
          done: false,
          processed: processedCount,
          reason: currentJob?.status ?? "missing",
        };
      }

      const apiKey = apiKeys[keyIndex % apiKeys.length];
      keyIndex++;

      // Mark as processing
      await ctx.runMutation(internal.translation.internalPatchChunk, {
        chunkId: chunk._id,
        status: "processing",
      });

      let success = false;
      let lastError = "";

      // Try each model in the fallback chain
      for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx++) {
        const tryModel = modelChain[modelIdx];
        const attemptsForModel = modelIdx === 0 ? 3 : 2; // Primary gets 3 tries, fallbacks get 2

        for (let attempt = 0; attempt < attemptsForModel; attempt++) {
          // Re-check job status before each attempt
          const checkJob: { status: string } | null = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
          if (!checkJob || checkJob.status !== "processing") {
            return {
              done: false,
              processed: processedCount,
              reason: checkJob?.status ?? "missing",
            };
          }

          try {
            // Per-key rate limit: only wait if this key was used recently
            const lastUse = keyLastUsed.get(apiKey) ?? 0;
            const timeSinceLastUse = Date.now() - lastUse;
            const MIN_KEY_GAP = 4500; // 4.5s between uses of the same key
            if (timeSinceLastUse < MIN_KEY_GAP && attempt === 0 && modelIdx === 0) {
              await new Promise((r) => setTimeout(r, MIN_KEY_GAP - timeSinceLastUse));
            } else if (attempt > 0) {
              // Retrying same request — standard backoff
              await new Promise((r) => setTimeout(r, 3000));
            }

            keyLastUsed.set(apiKey, Date.now());
            console.log(`[Translation] Chunk ${chunk.chunkIndex}: trying model ${tryModel} (attempt ${attempt + 1})`);

            const translated = await callOpenRouter(
              chunk.originalText,
              apiKey,
              tryModel
            );

            await ctx.runMutation(internal.translation.internalPatchChunk, {
              chunkId: chunk._id,
              translatedText: translated,
              status: "completed",
              retries: attempt + (modelIdx * attemptsForModel),
              usedModel: tryModel,
            });

            processedCount++;
            success = true;
            break;
          } catch (err: unknown) {
            lastError = err instanceof Error ? err.message : String(err);
            console.error(
              `[Translation] Chunk ${chunk.chunkIndex} model=${tryModel} attempt ${attempt + 1} failed:`,
              lastError
            );

            // Rate limited — wait longer before retrying
            if (lastError.includes("RATE_LIMITED") || lastError.includes("429")) {
              await new Promise((r) => setTimeout(r, 30000 * (attempt + 1)));
            } else if (lastError.includes("401") || lastError.includes("403")) {
              // Auth error — don't retry this model, try next fallback
              break;
            } else if (lastError.includes("502") || lastError.includes("503") || lastError.includes("overloaded")) {
              // Server error — try next fallback model faster
              await new Promise((r) => setTimeout(r, 5000));
              break;
            } else if (attempt < attemptsForModel - 1) {
              await new Promise((r) =>
                setTimeout(r, Math.min(3000 * Math.pow(2, attempt), 20000))
              );
            }
          }
        }

        if (success) break;

        // Before switching to next model, wait a bit
        if (modelIdx < modelChain.length - 1) {
          console.log(`[Translation] Chunk ${chunk.chunkIndex}: model ${tryModel} exhausted, switching to next fallback`);
          await new Promise((r) => setTimeout(r, 3000));
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
    }

    // Update job progress
    const counts: { total: number; completed: number; failed: number } = await ctx.runQuery(internal.translation.internalCountChunks, { jobId: args.jobId });
    const isAllDone: boolean = counts.completed + counts.failed >= counts.total;

    await ctx.runMutation(internal.translation.internalPatchJob, {
      jobId: args.jobId,
      status: isAllDone ? "completed" : "processing",
      completedCount: counts.completed,
      failedCount: counts.failed,
    });

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

      // Schedule next batch after 2 seconds (enough for rate limiting)
      await ctx.scheduler.runAfter(2000, api.translation.processJob, {
        jobId: args.jobId,
        batchSize: currentBatchSize,
      });
    }

    return result;
  },
});

// ─── Model fallback chain ───────────────────────────────────────
// If the primary model fails, try these in order. These are all free models
// on OpenRouter with decent context windows suitable for novel translation.
const FALLBACK_MODELS = [
  "minimax/minimax-m3:free",
  "nvidia/nemotron-3.5-lightning:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "thinkingmachines/inkling:free",
  "inclusionai/ling-3.0-flash-fin:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "z-ai/glm-5.2:free",
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
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: 65536,
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

  // Step 2: If there are NO double newlines at all, the model collapsed paragraphs.
  // In this case, treat single newlines as paragraph breaks.
  const hasDoubleNewlines = /\n\n/.test(result);
  if (!hasDoubleNewlines && result.includes("\n")) {
    // Convert single newlines to double newlines (paragraph breaks)
    result = result.replace(/\n/g, "\n\n");
  }

  // Step 3: Collapse 3+ consecutive newlines into exactly 2 (one blank line)
  result = result.replace(/\n{3,}/g, "\n\n");

  // Step 4: Trim leading/trailing whitespace
  result = result.trim();

  // Step 5: Ensure the text ends with a single newline
  if (!result.endsWith("\n")) {
    result += "\n";
  }

  return result;
}
