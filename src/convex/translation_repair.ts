import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { callOpenRouter, getFallbackChain, notifyJob } from "./translation";

/**
 * Fast post-completion cleanup for leftover Chinese text.
 *
 * Free models often refuse a few "sensitive" passages (or keep character names in
 * Chinese), leaving Chinese runs inside an otherwise-complete translation. Re-sending
 * the whole chunk usually fails the same way — so instead of re-translating entire
 * chunks, this module extracts ONLY the Chinese fragments from a dirty chunk, translates
 * them with a tiny targeted prompt, and stitches the English back into place. Each dirty
 * chunk costs one or two small requests instead of a full 35k-character re-run.
 *
 * Fragments are sent in batches of 25 per request: models frequently merge or drop lines
 * when asked for 50+ answers at once, which used to fail the whole repair.
 */

/** Matches Chinese characters, including rarer CJK Extension A ideographs. */
const CHINESE_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+/;
const CHINESE_RE_GLOBAL = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

/** Max fragments per repair request — keeps the "one line per fragment" contract reliable. */
const MAX_REPAIR_FRAGMENTS_PER_REQUEST = 25;

/** Normalize paragraph spacing (mirrors the helper in translation.ts so this module is self-contained). */
function normalizeParagraphs(text: string): string {
  let result = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  result = result.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  result = result.trim();
  if (!result.endsWith("\n")) result += "\n";
  return result;
}

/** Translate one batch of fragments; returns one line per fragment, or null if no model cooperated. */
async function repairFragmentBatch(
  fragments: string[],
  apiKey: string,
  models: string[],
): Promise<{ lines: string[]; model: string } | null> {
  const repairPrompt =
    `Translate each Chinese fragment below into fluent, natural English. ` +
    `Character names should be transliterated into English (e.g. 林逸 → Lin Yi). ` +
    `Output ONLY the translations — exactly one per line, in the same order as the input. ` +
    `You MUST output exactly ${fragments.length} lines, one translation per line. ` +
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
      return { lines, model };
    } catch {
      // this model failed — try the next one
    }
  }
  return null;
}

/**
 * Repair pass: re-translate ONLY the Chinese fragments left in a dirty translation,
 * then stitch the results back in. Returns the clean full text, or null if no model
 * could clean it.
 */
async function repairChineseFragmentsBatched(
  translated: string,
  apiKey: string,
  models: string[],
): Promise<{ text: string; model: string; fragments: number } | null> {
  // Longest-first so a name like 林逸风 is replaced before the substring 林逸.
  const fragments = [...new Set(translated.match(CHINESE_RE_GLOBAL) ?? [])]
    .slice(0, 100)
    .sort((a, b) => b.length - a.length);
  if (fragments.length === 0) return null;

  const replacements = new Map<string, string>();
  let usedModel: string | undefined;

  for (let start = 0; start < fragments.length; start += MAX_REPAIR_FRAGMENTS_PER_REQUEST) {
    const batch = fragments.slice(start, start + MAX_REPAIR_FRAGMENTS_PER_REQUEST);
    const batchResult = await repairFragmentBatch(batch, apiKey, models);
    if (!batchResult) return null; // one failed batch aborts the whole repair
    for (let i = 0; i < batch.length; i++) {
      replacements.set(batch[i], batchResult.lines[i]);
    }
    usedModel = batchResult.model;
  }

  let repaired = translated;
  for (const [fragment, replacement] of replacements) {
    repaired = repaired.split(fragment).join(replacement);
  }

  // Only accept if the stitched result is genuinely clean.
  if (CHINESE_RE.test(repaired)) return null;
  return {
    text: normalizeParagraphs(repaired),
    model: usedModel ?? models[0],
    fragments: fragments.length,
  };
}

/**
 * Translate ONLY the leftover Chinese fragments inside already-completed chunks and save
 * the repaired text back. Much cheaper and faster than re-running whole chunks, and it
 * works even when the full-chunk retranslate keeps failing on the same refused passages.
 */
export const fixChineseFragments = action({
  args: { jobId: v.id("translationJobs") },
  handler: async (
    ctx,
    args,
  ): Promise<{ repairedChunks: number; repairedFragments: number; failedChunks: number[] }> => {
    const job = await ctx.runQuery(internal.translation.internalGetJob, { jobId: args.jobId });
    if (!job) return { repairedChunks: 0, repairedFragments: 0, failedChunks: [] };

    const apiKeys = job.apiKeys ?? [];
    if (apiKeys.length === 0) return { repairedChunks: 0, repairedFragments: 0, failedChunks: [] };

    const chunks = await ctx.runQuery(internal.translation.internalGetChunksForJob, { jobId: args.jobId });
    const dirtyChunks = chunks
      .filter(
        (c) =>
          c.status === "completed" &&
          c.translatedText.length > 0 &&
          CHINESE_RE.test(c.translatedText)
      )
      .sort((a, b) => a.chunkIndex - b.chunkIndex);

    const modelChain = getFallbackChain(job.model);
    let repairedChunks = 0;
    let repairedFragments = 0;
    const failedChunks: number[] = [];

    for (let i = 0; i < dirtyChunks.length; i++) {
      const chunk = dirtyChunks[i];
      const apiKey = apiKeys[i % apiKeys.length];
      try {
        const repair = await repairChineseFragmentsBatched(chunk.translatedText, apiKey, modelChain);
        if (repair) {
          await ctx.runMutation(internal.translation.internalPatchChunk, {
            chunkId: chunk._id,
            status: "completed",
            translatedText: repair.text,
            retries: 6,
            usedModel: repair.model,
          });
          repairedChunks++;
          repairedFragments += repair.fragments;
          console.log(`[FixChinese] Chunk ${chunk.chunkIndex} repaired via ${repair.model} (${repair.fragments} fragments)`);
        } else {
          failedChunks.push(chunk.chunkIndex + 1);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[FixChinese] Chunk ${chunk.chunkIndex} repair failed:`, msg);
        failedChunks.push(chunk.chunkIndex + 1);
      }
    }

    if (repairedChunks > 0 || failedChunks.length > 0) {
      const message =
        `🧹 <b>Leftover Chinese repaired</b>\n` +
        (repairedChunks > 0
          ? `Fixed ${repairedChunks} chunk${repairedChunks > 1 ? "s" : ""} — ${repairedFragments} leftover Chinese fragment${repairedFragments > 1 ? "s" : ""} translated.\n`
          : "") +
        (failedChunks.length > 0
          ? `❌ ${failedChunks.length} chunk${failedChunks.length > 1 ? "s" : ""} couldn't be auto-fixed (${failedChunks.join(", ")}) — use Re-translate for those.\n`
          : "") +
        `📄 ${job.fileName}`;
      await notifyJob(
        ctx,
        job,
        message,
        failedChunks.length > 0 && repairedChunks === 0 ? "error" : "complete"
      );
    }

    return { repairedChunks, repairedFragments, failedChunks };
  },
});