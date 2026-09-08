/**
 * Cloudflare Worker — Novel Translator Cloud Backend
 *
 * Endpoints:
 *   GET  /api/ping
 *   POST /api/jobs              — create a job + upload chunks
 *   GET  /api/jobs/:id          — job status
 *   GET  /api/jobs/:id/chunks   — download translated chunks
 *   POST /api/jobs/:id/cancel   — cancel a running job
 *   DELETE /api/jobs/:id        — delete a job
 *
 * Cron (every 1 min) — picks up pending chunks and translates them via OpenRouter.
 */

const SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

## FORMATTING RULES (VERY IMPORTANT - FOLLOW EXACTLY):

You MUST separate EVERY paragraph with a BLANK LINE. This means each paragraph ends with TWO newline characters (\\n\\n). This is non-negotiable.

Example of CORRECT formatting:
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
- CRITICAL: Do NOT leave ANY Chinese characters untranslated. Every single Chinese word, phrase, and sentence MUST be translated to English.`;

// ─── Auto-free model cascade (tried in order when a specific model isn't set) ──
// Quality-ranked: best models first. Dead models are skipped automatically.
const AUTO_FREE_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",       // 550B params, 1M ctx — best
  "nvidia/nemotron-3-super-120b-a12b:free",       // 120B params, 262K ctx
  "thinkingmachines/inkling:free",                 // 1M ctx, strong reasoning
  "nvidia/nemotron-3.5-lightning:free",            // 1M ctx, fast
  "google/gemma-4-31b-it:free",                   // Google, 262K ctx
  "google/gemma-4-26b-a4b-it:free",               // Google, 262K ctx
  "thinkingmachines/inkling-small:free",           // 1M ctx, lighter
  "inclusionai/ling-3.0-flash-fin:free",           // 262K ctx
  "inclusionai/ling-3.0-flash-sante:free",         // 262K ctx
  "poolside/laguna-s-2.1:free",                   // 262K ctx
  "poolside/laguna-xs-2.1:free",                  // 262K ctx, lighter
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", // 30B, 256K ctx
  "dots-studio/dots-3-note-preview:free",         // 512K ctx
  "liquid/lfm-2.5-2.6b:free",                    // 65K ctx, smallest fallback
];

const BATCH_SIZE = 2; // chunks to translate per cron tick
const MAX_RETRIES = 3;
const STAGGER_MS = 4500;

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface Env {
  DB: D1Database;
  JOB_SECRET: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-job-secret",
    },
  });
}

function cors(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,x-job-secret",
    },
  });
}

function verifySecret(request: Request, env: Env): boolean {
  if (!env.JOB_SECRET) return true; // no secret configured → open access
  const provided = request.headers.get("x-job-secret") ?? "";
  return provided === env.JOB_SECRET;
}

function decodeChunkText(text: string, isGzip: boolean | undefined): string {
  if (!isGzip) return text;
  try {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const ds = new DecompressionStream("gzip");
    const writer = ds.writable.getWriter();
    writer.write(bytes).then(() => writer.close());
    // Note: Worker cron context doesn't have full DecompressionStream in all
    // runtimes.  Fall back to returning the base64 text (client will get raw).
    // For now we just decode with pako-like approach using node:zlib if needed.
    // Actually, Cloudflare Workers DO support DecompressionStream natively.
    // But it's async and we need a sync-ish path. Let's do it properly:
    const decoder = new TextDecoder();
    const reader = ds.readable.getReader();
    // Collect all chunks
    const chunks: Uint8Array[] = [];
    // This is a simplified sync adapter — in reality, CF Workers support
    // async DecompressionStream. We'll handle it in the async caller.
    return text; // placeholder — the async version below handles this
  } catch {
    return text;
  }
}

async function decompressGzip(base64: string): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(result);
}

/** Send a Telegram message (fire-and-forget). */
async function sendTelegram(
  botToken: string,
  chatId: string,
  message: string,
): Promise<void> {
  if (!botToken || !chatId) return;
  const targets = chatId.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.all(
    targets.map((id) =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }).catch(() => undefined)
    ),
  );
}

/** Resolve the OpenRouter model string. If "openrouter/free", tries models in order. */
function resolveModel(requested: string): string {
  if (requested !== "openrouter/free") return requested;
  // Return a random one from the auto-free list for variety
  return AUTO_FREE_MODELS[Math.floor(Math.random() * AUTO_FREE_MODELS.length)];
}

// ─── Translation via OpenRouter ───────────────────────────────────────────────

async function callOpenRouter(
  text: string,
  key: string,
  model: string,
): Promise<{ content: string; model: string }> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://novel-translator.app",
      "X-Title": "Novel Translator",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      max_tokens: 32000,
      temperature: 0.3,
    }),
  });

  if (res.status === 429) throw new Error("RATE_LIMITED");

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty response from model");
  return { content: content.trim(), model };
}

async function translateChunk(
  text: string,
  keys: string[],
  requestedModel: string,
  liveModels?: string[] | null,
): Promise<{ translated: string; model: string }> {
  if (!keys.length) throw new Error("No API keys provided");

  // Build the model list: try the requested model first, then cascade through auto-free
  // If liveModels is provided (from the frontend's Check Live), use that quality-ranked order
  const models = requestedModel === "openrouter/free"
    ? (liveModels && liveModels.length > 0
        ? liveModels
        : [resolveModel(requestedModel), ...AUTO_FREE_MODELS.filter((m) => m !== resolveModel(requestedModel))])
    : [requestedModel];

  let lastError: Error | null = null;

  for (const model of models) {
    for (let ki = 0; ki < keys.length; ki++) {
      const key = keys[ki];
      try {
        const result = await callOpenRouter(text, key, model);
        return { translated: result.content, model: result.model };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (lastError.message === "RATE_LIMITED") {
          await new Promise((r) => setTimeout(r, STAGGER_MS));
          continue; // try next key
        }
        // 404/400 — model unavailable, try next model
        if (lastError.message.includes("404") || lastError.message.includes("400")) {
          break; // move to next model
        }
        // Other error — try next key with stagger
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }
    }
  }

  throw lastError ?? new Error("All translation attempts failed");
}

// ─── Route Handler ────────────────────────────────────────────────────────────

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS preflight
  if (method === "OPTIONS") return cors();

  // ── Ping ──────────────────────────────────────────────────────
  if (path === "/api/ping" && method === "GET") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    return json({ ok: true, time: Date.now() });
  }

  // ── Create Job ────────────────────────────────────────────────
  if (path === "/api/jobs" && method === "POST") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);

    const body = (await request.json()) as {
      fileName: string;
      model: string;
      keys: string[];
      chunks: { text: string; gzip?: boolean }[];
      liveModels?: string[];
      telegramBotToken?: string;
      telegramChatId?: string;
      telegramNotifyOnStart?: boolean;
      telegramNotifyOnProgress?: boolean;
      telegramNotifyOnError?: boolean;
      telegramNotifyOnComplete?: boolean;
    };

    if (!body.chunks?.length) return json({ error: "No chunks provided" }, 400);
    if (!body.keys?.length) return json({ error: "No API keys provided" }, 400);

    const jobId = crypto.randomUUID();
    const now = Date.now();

    // Insert job
    const liveModelsJson = body.liveModels && body.liveModels.length > 0
      ? JSON.stringify(body.liveModels) : null;

    await env.DB.prepare(
      `INSERT INTO jobs (id, file_name, model, keys_json, status, created_at, updated_at, live_models_json, telegram_bot_token, telegram_chat_id, telegram_on_start, telegram_on_progress, telegram_on_error, telegram_on_complete, last_milestone)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
      .bind(
        jobId,
        body.fileName,
        body.model,
        JSON.stringify(body.keys),
        now,
        now,
        liveModelsJson,
        body.telegramBotToken ?? null,
        body.telegramChatId ?? null,
        body.telegramNotifyOnStart ? 1 : 0,
        body.telegramNotifyOnProgress ? 1 : 0,
        body.telegramNotifyOnError ? 1 : 0,
        body.telegramNotifyOnComplete ? 1 : 0,
      )
      .run();

    // Insert chunks in batches (D1 limit: 50 params per batch)
    const BATCH = 25;
    for (let i = 0; i < body.chunks.length; i += BATCH) {
      const batch = body.chunks.slice(i, i + BATCH);
      const stmts = await Promise.all(
        batch.map(async (c, idx) => {
          const text = c.gzip ? await decompressGzip(c.text) : c.text;
          return env.DB.prepare(
            `INSERT INTO chunks (job_id, seq, text, status, attempts, updated_at)
             VALUES (?, ?, ?, 'pending', 0, ?)`
          ).bind(jobId, i + idx, text, now);
        }),
      );
      await env.DB.batch(stmts);
    }

    // Send Telegram start notification
    if (body.telegramBotToken && body.telegramChatId && body.telegramNotifyOnStart) {
      await sendTelegram(
        body.telegramBotToken,
        body.telegramChatId,
        `🚀 <b>Cloud translation started</b>\n📚 ${body.fileName}\n📦 ${body.chunks.length} chunks`,
      ).catch(() => undefined);
    }

    return json({ jobId, totalChunks: body.chunks.length });
  }

  // ── Job status / delete ───────────────────────────────────────
  const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)$/);
  if (jobMatch) {
    const jobId = jobMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);

    if (method === "GET") {
      const job = await env.DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first();
      if (!job) return json({ error: "Job not found" }, 404);

      const counts = await env.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM chunks WHERE job_id = ?`
      ).bind(jobId).first();

      return json({
        jobId: job.id,
        fileName: job.file_name,
        status: job.status === "active" ? "active" : job.status === "cancelled" ? "cancelled" : "done",
        totalChunks: counts?.total ?? 0,
        completedChunks: counts?.completed ?? 0,
        failedChunks: counts?.failed ?? 0,
        activeModel: job.active_model ?? null,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
      });
    }

    if (method === "DELETE") {
      await env.DB.prepare(`DELETE FROM chunks WHERE job_id = ?`).bind(jobId).run();
      await env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId).run();
      return json({ ok: true });
    }
  }

  // ── Get completed chunks ──────────────────────────────────────
  const chunksMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/chunks$/);
  if (chunksMatch && method === "GET") {
    const jobId = chunksMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);

    const after = Number(url.searchParams.get("after") ?? "-1");
    const rows = await env.DB.prepare(
      `SELECT seq, translated_text FROM chunks
       WHERE job_id = ? AND seq > ? AND status = 'completed' AND translated_text IS NOT NULL
       ORDER BY seq ASC`
    )
      .bind(jobId, after)
      .all();

    return json({
      chunks: rows.results.map((r) => ({ id: r.seq as number, text: r.translated_text as string })),
    });
  }

  // ── Manual cron trigger (for testing) ─────────────────────────
  if (path === "/api/run-cron" && method === "POST") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    try {
      await handleCron(env);
      return json({ ok: true, message: "Cron executed manually" });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  }

  // ── Cancel job ────────────────────────────────────────────────
  const cancelMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    const jobId = cancelMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);

    await env.DB.prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'`)
      .bind(Date.now(), jobId)
      .run();

    // Reset translating chunks back to pending so they don't hang
    await env.DB.prepare(`UPDATE chunks SET status = 'pending' WHERE job_id = ? AND status = 'translating'`)
      .bind(jobId)
      .run();

    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ─── Cron Handler ─────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
  // Get all active jobs
  const jobs = await env.DB.prepare(`SELECT * FROM jobs WHERE status = 'active'`).all();

  for (const job of jobs.results) {
    const jobId = job.id as string;
    const keys: string[] = JSON.parse((job.keys_json as string) ?? "[]");
    const model = job.model as string;
    const liveModels: string[] | null = job.live_models_json
      ? JSON.parse(job.live_models_json as string) : null;
    const telegramToken = job.telegram_bot_token as string | null;
    const telegramChatId = job.telegram_chat_id as string | null;
    const notifyOnError = (job.telegram_on_error as number) === 1;
    const notifyOnComplete = (job.telegram_on_complete as number) === 1;
    const notifyOnProgress = (job.telegram_on_progress as number) === 1;
    const lastMilestone = (job.last_milestone as number) ?? 0;

    if (!keys.length) continue;

    // Claim a batch of pending chunks
    const pending = await env.DB.prepare(
      `SELECT id, seq, text FROM chunks
       WHERE job_id = ? AND status = 'pending'
       ORDER BY seq ASC
       LIMIT ?`
    )
      .bind(jobId, BATCH_SIZE)
      .all();

    if (pending.results.length === 0) {
      // Check if all chunks are done → mark job as done
      const counts = await env.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
         FROM chunks WHERE job_id = ?`
      ).bind(jobId).first();

      const total = (counts?.total as number) ?? 0;
      const completed = (counts?.completed as number) ?? 0;
      const failed = (counts?.failed as number) ?? 0;

      if (completed + failed === total && total > 0) {
        const newStatus = failed > 0 ? "done" : "done";
        await env.DB.prepare(`UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?`)
          .bind(newStatus, Date.now(), jobId)
          .run();

        // Send Telegram completion
        if (telegramToken && telegramChatId && notifyOnComplete) {
          await sendTelegram(
            telegramToken,
            telegramChatId,
            `🎉 <b>Cloud translation complete!</b>\n✅ ${completed} chunks translated\n❌ ${failed} failed`,
          ).catch(() => undefined);
        }
      }
      continue;
    }

    // Mark as translating
    const now = Date.now();
    const markStmts = pending.results.map((r) =>
      env.DB.prepare(`UPDATE chunks SET status = 'translating', updated_at = ? WHERE id = ?`)
        .bind(now, r.id)
    );
    await env.DB.batch(markStmts);

    // Translate each chunk (with stagger between requests)
    let completedDelta = 0;
    let failedDelta = 0;

    for (let i = 0; i < pending.results.length; i++) {
      const chunk = pending.results[i];
      const chunkId = chunk.id as number;
      const seq = chunk.seq as number;
      const text = chunk.text as string;

      // Stagger between requests
      if (i > 0) {
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }

      try {
        const { translated, model: usedModel } = await translateChunk(text, keys, model, liveModels);

        await env.DB.prepare(
          `UPDATE chunks SET status = 'completed', translated_text = ?, model_used = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`
        )
          .bind(translated, usedModel, Date.now(), chunkId)
          .run();

        completedDelta++;

        // Update active_model on the job
        await env.DB.prepare(`UPDATE jobs SET active_model = ?, updated_at = ? WHERE id = ?`)
          .bind(usedModel, Date.now(), jobId)
          .run();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Get current attempts from the chunk
        const chunkRow = await env.DB.prepare(`SELECT attempts FROM chunks WHERE id = ?`).bind(chunkId).first();
        const currentAttempts = (chunkRow?.attempts as number) ?? 0;
        const newAttempts = currentAttempts + 1;

        if (newAttempts >= MAX_RETRIES) {
          await env.DB.prepare(
            `UPDATE chunks SET status = 'failed', error = ?, attempts = ?, updated_at = ? WHERE id = ?`
          )
            .bind(errMsg.slice(0, 1000), newAttempts, Date.now(), chunkId)
            .run();
          failedDelta++;

          // Telegram error notification
          if (telegramToken && telegramChatId && notifyOnError) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `❌ <b>Chunk ${seq + 1} failed</b>\n<code>${errMsg.slice(0, 150)}</code>`,
            ).catch(() => undefined);
          }
        } else {
          // Retry — set back to pending
          await env.DB.prepare(
            `UPDATE chunks SET status = 'pending', attempts = ?, error = ?, updated_at = ? WHERE id = ?`
          )
            .bind(newAttempts, errMsg.slice(0, 500), Date.now(), chunkId)
            .run();
        }
      }
    }

    // Update job counts
    const counts = await env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
       FROM chunks WHERE job_id = ?`
    ).bind(jobId).first();

    await env.DB.prepare(
      `UPDATE jobs SET completed_count = ?, failed_count = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?`
    )
      .bind(
        counts?.completed ?? 0,
        counts?.failed ?? 0,
        Date.now(),
        Date.now(),
        jobId,
      )
      .run();

    // Telegram progress milestone
    if (telegramToken && telegramChatId && notifyOnProgress && counts) {
      const total = (counts.total as number) ?? 0;
      const completed = (counts.completed as number) ?? 0;
      const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
      const milestone = Math.floor(pct / 25) * 25;
      if (milestone >= lastMilestone + 25 && milestone < 100 && completed > 0) {
        await env.DB.prepare(`UPDATE jobs SET last_milestone = ? WHERE id = ?`)
          .bind(milestone, jobId)
          .run();
        await sendTelegram(
          telegramToken,
          telegramChatId,
          `📖 <b>Translation ${milestone}%</b>\n${completed}/${total} chunks done`,
        ).catch(() => undefined);
      }
    }
  }
}

// ─── Entry Points ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      await handleCron(env);
    } catch (err) {
      console.error("Cron error:", err);
    }
  },
};
