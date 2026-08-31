import { v } from "convex/values";
import { mutation, query, action, internalQuery, internalMutation } from "./_generated/server";
import { api } from "./_generated/api";

const SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

CRITICAL FORMATTING RULES:
- Preserve ALL paragraph breaks from the original text. Separate every paragraph with a blank line (double newline). The output must have clear visual spacing between paragraphs, matching the input's paragraph structure.
- If the input has a line break between paragraphs, your output MUST have a blank line between those same paragraphs.
- Preserve dialogue formatting and paragraph indentation style.
- Do NOT merge paragraphs together. Each paragraph in the input becomes its own paragraph in the output.

IMPORTANT: Output ONLY the translated English text. Do not include any explanations, notes, commentary, or metadata. Do not wrap your output in quotes or markdown. Just return the raw translated English prose with proper paragraph spacing.`;

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
  },
  handler: async (ctx, args) => {
    const patch: Record<string, any> = { status: args.status };
    if (args.translatedText !== undefined) patch.translatedText = args.translatedText;
    if (args.error !== undefined) patch.error = args.error;
    if (args.retries !== undefined) patch.retries = args.retries;
    await ctx.db.patch(args.chunkId, patch);
  },
});

export const internalPatchJob = internalMutation({
  args: {
    jobId: v.id("translationJobs"),
    status: v.optional(v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed"))),
    completedCount: v.optional(v.number()),
    failedCount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, any> = { updatedAt: Date.now() };
    if (args.status !== undefined) patch.status = args.status;
    if (args.completedCount !== undefined) patch.completedCount = args.completedCount;
    if (args.failedCount !== undefined) patch.failedCount = args.failedCount;
    await ctx.db.patch(args.jobId, patch);
  },
});

// ─── Public Mutations ────────────────────────────────────────────

/** Start a new translation job. Chunks text and stores everything. */
export const startTranslation = mutation({
  args: {
    fileName: v.string(),
    rawText: v.string(),
    model: v.string(),
    chunkSize: v.number(),
    concurrency: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const chunks = chunkText(args.rawText, args.chunkSize);

    const jobId = await ctx.db.insert("translationJobs", {
      fileName: args.fileName,
      rawText: args.rawText,
      rawTextLength: args.rawText.length,
      totalChunks: chunks.length,
      status: "processing",
      model: args.model,
      chunkSize: args.chunkSize,
      concurrency: args.concurrency,
      completedCount: 0,
      failedCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    for (const chunk of chunks) {
      await ctx.db.insert("translationChunks", {
        jobId,
        chunkIndex: chunk.id,
        originalText: chunk.text,
        translatedText: "",
        status: "pending",
        retries: 0,
      });
    }

    return { jobId, totalChunks: chunks.length };
  },
});

/** Mark a job as aborted. */
export const abortJob = mutation({
  args: { jobId: v.id("translationJobs") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.jobId, { status: "failed", updatedAt: Date.now() });
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

    return {
      ...job,
      completedCount: completed,
      failedCount: failed,
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

/** List all jobs. */
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

/** Process the next batch of pending chunks. Called repeatedly by the frontend. */
export const processNextBatch = action({
  args: {
    jobId: v.id("translationJobs"),
    apiKeys: v.array(v.string()),
    batchSize: v.number(),
  },
  handler: async (ctx, args) => {
    // Check job is still active
    const job = await ctx.runQuery(api.translation.internalGetJob, { jobId: args.jobId });
    if (!job || job.status !== "processing") {
      return { done: true, processed: 0, total: 0 };
    }

    // Get pending chunks
    const pending = await ctx.runQuery(api.translation.internalGetPendingChunks, {
      jobId: args.jobId,
      limit: args.batchSize,
    });

    if (pending.length === 0) {
      // Check if all done
      const counts: { total: number; completed: number; failed: number } = await ctx.runQuery(api.translation.internalCountChunks, { jobId: args.jobId });
      const isAllDone: boolean = counts.completed + counts.failed >= counts.total;

      if (isAllDone) {
        await ctx.runMutation(api.translation.internalPatchJob, {
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

    for (const chunk of pending) {
      const apiKey = args.apiKeys[keyIndex % args.apiKeys.length];
      keyIndex++;

      // Mark as processing
      await ctx.runMutation(api.translation.internalPatchChunk, {
        chunkId: chunk._id,
        status: "processing",
      });

      let success = false;
      let lastError = "";
      const maxRetries = 3;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
          // Rate limit stagger: 4.5s between requests
          if (attempt > 0 || processedCount > 0) {
            await new Promise((r) => setTimeout(r, 4500));
          }

          const translated = await callOpenRouter(
            chunk.originalText,
            apiKey,
            job.model
          );

          await ctx.runMutation(api.translation.internalPatchChunk, {
            chunkId: chunk._id,
            translatedText: translated,
            status: "completed",
            retries: attempt,
          });

          processedCount++;
          success = true;
          break;
        } catch (err: unknown) {
          lastError = err instanceof Error ? err.message : String(err);
          console.error(
            `[Translation] Chunk ${chunk.chunkIndex} attempt ${attempt + 1} failed:`,
            lastError
          );

          if (lastError.includes("RATE_LIMITED") || lastError.includes("429")) {
            await new Promise((r) => setTimeout(r, 30000 * (attempt + 1)));
          } else if (attempt < maxRetries - 1) {
            await new Promise((r) =>
              setTimeout(r, Math.min(3000 * Math.pow(2, attempt), 20000))
            );
          }
        }
      }

      if (!success) {
        await ctx.runMutation(api.translation.internalPatchChunk, {
          chunkId: chunk._id,
          status: "failed",
          error: lastError.slice(0, 500),
          retries: maxRetries,
        });
      }
    }

    // Update job progress
    const counts: { total: number; completed: number; failed: number } = await ctx.runQuery(api.translation.internalCountChunks, { jobId: args.jobId });
    const isAllDone: boolean = counts.completed + counts.failed >= counts.total;

    await ctx.runMutation(api.translation.internalPatchJob, {
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

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) {
    throw new Error("No translation content in response");
  }
  return content;
}
