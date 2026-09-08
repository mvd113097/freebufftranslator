/**
 * Cloudflare Worker: server-side translation queue.
 *
 * Runs the same OpenRouter translation pipeline that used to live in the
 * browser, but driven by a 5-minute cron. The browser can be closed — the
 * worker keeps pulling untranslated chunks from D1, translating them via
 * OpenRouter with the user's rotated keys, and saving results back to D1.
 * The frontend polls the job API for progress and downloads the finished
 * chunks when done.
 *
 * Endpoints (all JSON):
 *   POST /api/jobs           → create job { fileName, model, keys[], chunks[{text}] }
 *   GET  /api/jobs/:id       → status { status, totalChunks, completedChunks, failedChunks, activeModel }
 *   GET  /api/jobs/:id/chunks→ translated chunks [{ id, text }] (completed only)
 *   POST /api/jobs/:id/cancel→ mark job cancelled (worker stops translating it)
 *   DELETE /api/jobs/:id     → delete job + chunks (frees D1 storage)
 *   GET  /api/ping           → health check
 *
 * Auth: every /api/jobs* call must send header "x-job-secret" matching the
 * JOB_SECRET var when one is configured. Keys are stored per-job in D1 and
 * never returned by the API.
 *
 * Cron (every 5 min): pick up to MAX_CHUNKS_PER_RUN pending chunks across
 * active jobs, translate each (model fallback chain + retry w/ backoff,
 * per-key rate limiting), commit results to D1 as they finish. A single
 * invocation is bounded; the next tick continues the job.
 */

export interface Env {
  DB: D1Database;
  MAX_CHUNKS_PER_RUN?: string;
  JOB_SECRET?: string;
}

// ─── Shared translation logic (mirrors src/lib/translator/gemini-api.ts) ───

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

CRITICAL FORMATTING RULES:
- Preserve ALL paragraph breaks from the original text. Separate every paragraph with a blank line (double newline). The output must have clear visual spacing between paragraphs, matching the input's paragraph structure.
- If the input has a line break between paragraphs, your output MUST have a blank line between those same paragraphs.
- Preserve dialogue formatting and paragraph indentation style.
- Do NOT merge paragraphs together. Each paragraph in the input becomes its own paragraph in the output.

IMPORTANT: Output ONLY the translated English text. Do not include any explanations, notes, commentary, or metadata. Do not wrap your output in quotes or markdown. Just return the raw translated English prose with proper paragraph spacing.`;

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

function isAutoFreeSelector(model: string): boolean {
  return model === "openrouter/free" || model === "openrouter/auto" || model === "auto";
}

function normalizeParagraphs(text: string): string {
  let result = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  result = result.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

function extractApiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const msg =
      (parsed?.error?.message as string | undefined) ??
      (parsed?.message as string | undefined);
    if (typeof msg === "string" && msg.trim().length > 0) return msg.trim().slice(0, 200);
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 200);
}

/** Non-streaming translation with one model. Throws typed errors. */
async function translateNonStreaming(
  text: string,
  apiKey: string,
  model: string,
): Promise<string> {
  // 8-minute cap: free models can legitimately take minutes on a big chunk,
  // but a truly stalled connection must never hang the cron tick forever.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8 * 60 * 1000);
  try {
    const response = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        temperature: 0.7,
        top_p: 0.95,
        max_tokens: 65536,
        stream: false,
      }),
      signal: controller.signal,
    });

  if (response.status === 429) throw new Error("RATE_LIMITED");

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    const realMsg = extractApiErrorMessage(body);
    throw new Error(
      `KEY_REJECTED (key …${apiKey.slice(-4)}): ${realMsg || "Invalid or expired API key"}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (body.includes("overloaded") || response.status === 503 || response.status === 502) {
      throw new Error(`SERVER_ERROR_${response.status}: Model overloaded`);
    }
    throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
  }

    const data = await response.json() as {
      error?: unknown;
      choices?: { message?: { content?: string } }[];
    };
    if (data.error) {
      const errMsg =
        typeof data.error === "string" ? data.error : (data.error as { message?: string }).message || JSON.stringify(data.error);
      throw new Error(`MODEL_ERROR: ${errMsg.slice(0, 200)}`);
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Model returned empty translation");
    }
    return normalizeParagraphs(content);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("API_TIMEOUT: Request timed out after 8 minutes");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Translate one chunk. Walks the fallback chain for Auto Free; retries
 * rate-limited models down the chain. KEY_REJECTED and aborts bubble up.
 */
async function translateChunk(
  text: string,
  apiKey: string,
  model: string,
): Promise<{ text: string; modelUsed: string }> {
  if (!isAutoFreeSelector(model)) {
    return { text: await translateNonStreaming(text, apiKey, model), modelUsed: model };
  }
  let lastError: Error | null = null;
  for (const candidate of FALLBACK_MODELS) {
    try {
      return { text: await translateNonStreaming(text, apiKey, candidate), modelUsed: candidate };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("KEY_REJECTED")) throw err;
      lastError = err instanceof Error ? err : new Error(msg);
    }
  }
  throw lastError ?? new Error("All free models failed");
}

/**
 * Per-key rate limiter: rotate keys, respecting ~5 RPM per key
 * (mirrors the browser pipeline's conservative limiter).
 */
class KeyRotator {
  private lastUse = new Map<string, number>();
  private readonly minIntervalMs: number;

  private readonly keys: string[];

  constructor(keys: string[], requestsPerMinutePerKey = 5) {
    this.keys = keys;
    this.minIntervalMs = Math.ceil(60000 / requestsPerMinutePerKey);
  }

  /** Returns the next available key, waiting if all are cooling down. */
  async next(): Promise<string> {
    if (this.keys.length === 0) throw new Error("No API keys configured for this job");
    let bestKey = this.keys[0];
    for (let attempt = 0; attempt < 2; attempt++) {
      const now = Date.now();
      let oldestWait = Infinity;
      bestKey = this.keys[0];
      for (const key of this.keys) {
        const last = this.lastUse.get(key) ?? 0;
        const wait = this.minIntervalMs - (now - last);
        if (wait <= 0) return key;
        if (wait < oldestWait) {
          oldestWait = wait;
          bestKey = key;
        }
      }
      if (attempt === 0 && oldestWait < 15000) {
        await new Promise((r) => setTimeout(r, Math.max(oldestWait, 250)));
      }
    }
    // All keys cooling — use the one that frees soonest (caller retries on 429)
    this.lastUse.set(bestKey, Date.now());
    return bestKey;
  }

  markUsed(key: string) {
    this.lastUse.set(key, Date.now());
  }
}

// ─── D1 helpers ─────────────────────────────────────────────────────────────

interface JobRow {
  id: string;
  file_name: string;
  model: string;
  keys_json: string;
  status: string; // active | done | cancelled
  created_at: number;
  updated_at: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  telegram_on_start: number;
  telegram_on_progress: number;
  telegram_on_error: number;
  telegram_on_complete: number;
  last_milestone: number;
}

interface ChunkRow {
  id: number;
  job_id: string;
  seq: number;
  text: string;
  status: string; // pending | translating | completed | failed
  translated_text: string | null;
  model_used: string | null;
  error: string | null;
  attempts: number;
  updated_at: number;
}

async function getJob(db: D1Database, jobId: string): Promise<JobRow | null> {
  const row = await db
    .prepare("SELECT * FROM jobs WHERE id = ?")
    .bind(jobId)
    .first<JobRow>();
  return row ?? null;
}

async function jobStats(db: D1Database, jobId: string) {
  const res = await db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM chunks WHERE job_id = ?`,
    )
    .bind(jobId)
    .first<{ total: number; completed: number | null; failed: number | null }>();
  return {
    total: res?.total ?? 0,
    completed: res?.completed ?? 0,
    failed: res?.failed ?? 0,
  };
}

async function sendTelegram(
  botToken: string | null,
  chatId: string | null,
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
      }).catch(() => undefined),
    ),
  );
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function corsPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, x-job-secret",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function checkSecret(env: Env, request: Request): boolean {
  const secret = (env.JOB_SECRET ?? "").trim();
  if (!secret) return true; // no secret configured
  return request.headers.get("x-job-secret") === secret;
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/** Decode base64 → gunzip → text (browser uploads are gzipped to save data). */
async function gunzipBase64(b64: string): Promise<string> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/**
 * Translate one claimed chunk (up to 3 attempts) and commit the result to D1.
 * Called in parallel for the whole claimed batch by the cron handler.
 */
async function translateOneChunk(
  env: Env,
  chunk: ChunkRow & {
    model: string;
    keys_json: string;
    telegram_bot_token: string | null;
    telegram_chat_id: string | null;
    telegram_on_error: number;
    telegram_on_progress: number;
  },
  rotator: KeyRotator,
): Promise<void> {
  let translated: string | null = null;
  let modelUsed: string | null = null;
  let lastError = "";
  let keyRejected = false;

  for (let attempt = 1; attempt <= 3 && !translated; attempt++) {
    try {
      const key = await rotator.next();
      rotator.markUsed(key);
      const result = await translateChunk(chunk.text, key, chunk.model);
      translated = result.text;
      modelUsed = result.modelUsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      if (msg.startsWith("KEY_REJECTED")) {
        keyRejected = true;
        break; // don't burn attempts on a dead key this tick
      }
      if (msg.includes("RATE_LIMITED")) {
        await new Promise((r) => setTimeout(r, 8000));
      } else {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  if (translated) {
    await env.DB
      .prepare(
        `UPDATE chunks SET status = 'completed', translated_text = ?, model_used = ?,
         error = NULL, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
      )
      .bind(translated, modelUsed, Date.now(), chunk.id)
      .run();
  } else {
    // Back to pending so the next cron tick retries (unless key dead —
    // mark failed so the user can act on it).
    await env.DB
      .prepare(
        `UPDATE chunks SET status = ?, error = ?, attempts = attempts + 1, updated_at = ?
         WHERE id = ?`,
      )
      .bind(keyRejected ? "failed" : "pending", lastError.slice(0, 300), Date.now(), chunk.id)
      .run();

    if (keyRejected && chunk.telegram_bot_token && chunk.telegram_chat_id && chunk.telegram_on_error) {
      void sendTelegram(
        chunk.telegram_bot_token,
        chunk.telegram_chat_id,
        `❌ <b>Chunk ${chunk.seq + 1} failed</b>\n<code>${lastError.slice(0, 150)}</code>`,
      );
    }
  }
}

// ─── HTTP API ───────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return corsPreflight();

    if (url.pathname === "/api/ping") {
      // Verify the secret too (when configured) so "Test Connection" in the
      // app actually validates credentials, not just reachability.
      if (!checkSecret(env, request)) {
        return json({ error: "Unauthorized — secret mismatch" }, 401);
      }
      return json({ ok: true, time: Date.now() });
    }

    if (!url.pathname.startsWith("/api/jobs")) {
      return json({ error: "Not found" }, 404);
    }

    if (!checkSecret(env, request)) {
      return json({ error: "Unauthorized" }, 401);
    }

    const parts = url.pathname.split("/").filter(Boolean); // ["api","jobs",id?,action?]
    const jobId = parts[2] ?? null;
    const action = parts[3] ?? null;

    // POST /api/jobs — create job
    if (request.method === "POST" && !jobId) {
      let body: {
        fileName?: string;
        model?: string;
        keys?: string[];
        chunks?: { text: string }[];
        telegramBotToken?: string;
        telegramChatId?: string;
        telegramNotifyOnStart?: boolean;
        telegramNotifyOnProgress?: boolean;
        telegramNotifyOnError?: boolean;
        telegramNotifyOnComplete?: boolean;
      };
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }

      const keys = (body.keys ?? []).map((k) => String(k).trim()).filter(Boolean);
      const rawChunks = (body.chunks ?? []).filter(
        (c) => c && typeof c.text === "string" && c.text.length > 0,
      );
      // Decompress gzipped uploads (browser gzips chunks to save mobile data)
      const chunks: { text: string }[] = [];
      for (const c of rawChunks) {
        const rec = c as { text: string; gzip?: boolean };
        if (rec.gzip) {
          try {
            chunks.push({ text: await gunzipBase64(rec.text) });
          } catch {
            return json({ error: "Failed to decompress a chunk" }, 400);
          }
        } else {
          chunks.push({ text: rec.text });
        }
      }
      if (keys.length === 0) return json({ error: "At least one API key required" }, 400);
      if (chunks.length === 0) return json({ error: "No chunks provided" }, 400);
      if (chunks.length > 5000) return json({ error: "Too many chunks (max 5000)" }, 400);

      const jobIdNew = newId();
      const now = Date.now();
      const model = body.model || "openrouter/free";

      const stmts = [
        env.DB.prepare(
          `INSERT INTO jobs (id, file_name, model, keys_json, status, created_at, updated_at,
             telegram_bot_token, telegram_chat_id, telegram_on_start, telegram_on_progress,
             telegram_on_error, telegram_on_complete, last_milestone)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ).bind(
          jobIdNew,
          (body.fileName || "novel.txt").slice(0, 200),
          model,
          JSON.stringify(keys),
          now,
          now,
          body.telegramBotToken || null,
          body.telegramChatId || null,
          body.telegramNotifyOnStart === false ? 0 : 1,
          body.telegramNotifyOnProgress === false ? 0 : 1,
          body.telegramNotifyOnError === false ? 0 : 1,
          body.telegramNotifyOnComplete === false ? 0 : 1,
        ),
      ];
      for (let i = 0; i < chunks.length; i++) {
        stmts.push(
          env.DB.prepare(
            `INSERT INTO chunks (job_id, seq, text, status, attempts, updated_at)
             VALUES (?, ?, ?, 'pending', 0, ?)`,
          ).bind(jobIdNew, i, chunks[i].text, now),
        );
      }
      // D1 batches up to ~100 statements; chunk into groups
      for (let i = 0; i < stmts.length; i += 80) {
        await env.DB.batch(stmts.slice(i, i + 80));
      }

      const t = {
        bot: body.telegramBotToken || null,
        chat: body.telegramChatId || null,
        onStart: body.telegramNotifyOnStart !== false,
      };
      if (t.bot && t.chat && t.onStart) {
        void sendTelegram(
          t.bot,
          t.chat,
          `🚀 <b>Cloud translation started</b>\n📚 ${(body.fileName || "novel").slice(0, 60)}\n📦 ${chunks.length} chunks\n🌐 Running on Cloudflare — browser can close now`,
        );
      }

      return json({ jobId: jobIdNew, totalChunks: chunks.length }, 201);
    }

    if (jobId) {
      const job = await getJob(env.DB, jobId);
      if (!job) return json({ error: "Job not found" }, 404);

      // GET /api/jobs/:id — status
      if (request.method === "GET" && !action) {
        const stats = await jobStats(env.DB, jobId);
        const activeModelRow = await env.DB
          .prepare(
            `SELECT model_used FROM chunks WHERE job_id = ? AND model_used IS NOT NULL
             ORDER BY updated_at DESC LIMIT 1`,
          )
          .bind(jobId)
          .first<{ model_used: string }>();
        return json({
          jobId,
          fileName: job.file_name,
          status: job.status,
          createdAt: job.created_at,
          totalChunks: stats.total,
          completedChunks: stats.completed,
          failedChunks: stats.failed,
          activeModel: activeModelRow?.model_used ?? null,
          updatedAt: job.updated_at,
        });
      }

      // GET /api/jobs/:id/chunks?after=N — translated chunks completed since seq N
      // (data-saving: the client only pulls newly-finished chunks, not the whole book)
      if (request.method === "GET" && action === "chunks") {
        const after = Number(url.searchParams.get("after") ?? "-1");
        const { results } = await env.DB
          .prepare(
            `SELECT seq, translated_text FROM chunks
             WHERE job_id = ? AND status = 'completed' AND seq > ? ORDER BY seq`,
          )
          .bind(jobId, Number.isFinite(after) ? after : -1)
          .all<{ seq: number; translated_text: string }>();
        return json({
          chunks: (results ?? []).map((r) => ({ id: r.seq, text: r.translated_text })),
        });
      }

      // POST /api/jobs/:id/cancel
      if (request.method === "POST" && action === "cancel") {
        await env.DB
          .prepare(`UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?`)
          .bind(Date.now(), jobId)
          .run();
        return json({ ok: true });
      }

      // DELETE /api/jobs/:id
      if (request.method === "DELETE" && !action) {
        await env.DB.batch([
          env.DB.prepare(`DELETE FROM chunks WHERE job_id = ?`).bind(jobId),
          env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId),
        ]);
        return json({ ok: true });
      }
    }

    return json({ error: "Method not allowed" }, 405);
  },

  // ─── Cron: translate a bounded batch of pending chunks ──────────────────

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const maxChunks = Math.max(1, Math.min(40, Number(env.MAX_CHUNKS_PER_RUN ?? "15")));

    // ── Stuck-chunk recovery ─────────────────────────────────────────────
    // A previous cron invocation can be killed mid-translation (worker EV
    // eviction, runtime limit). Chunks left in 'translating' would otherwise
    // stay there forever — only 'pending' chunks ever get claimed again.
    // Requeue anything stuck for longer than 10 minutes.
    await env.DB
      .prepare(
        `UPDATE chunks SET status = 'pending', updated_at = ?
         WHERE status = 'translating' AND updated_at < ?`,
      )
      .bind(Date.now(), Date.now() - 10 * 60 * 1000)
      .run();

    // ── Claim a batch of pending chunks ─────────────────────────────────
    // Mark them 'translating' immediately so overlapping crons don't double-work.
    const claimResult = await env.DB.batch([
      env.DB.prepare(
        `UPDATE chunks SET status = 'translating', updated_at = ?
         WHERE id IN (
           SELECT c.id FROM chunks c
           JOIN jobs j ON j.id = c.job_id
           WHERE c.status = 'pending' AND j.status = 'active'
           ORDER BY j.created_at, c.seq
           LIMIT ??
         )`,
      ).bind(Date.now(), maxChunks),
    ]);
    const claimed = claimResult[0]?.meta?.changes ?? 0;
    if (claimed === 0) return;

    const { results: claimedRows } = await env.DB
      .prepare(
        `SELECT c.*, j.model, j.keys_json, j.telegram_bot_token, j.telegram_chat_id,
                j.telegram_on_error, j.telegram_on_progress, j.last_milestone
         FROM chunks c JOIN jobs j ON j.id = c.job_id
         WHERE c.status = 'translating' AND j.status = 'active'
         ORDER BY j.created_at, c.seq
         LIMIT ??`,
      )
      .bind(maxChunks)
      .all<ChunkRow & { model: string; keys_json: string; telegram_bot_token: string | null; telegram_chat_id: string | null; telegram_on_error: number; telegram_on_progress: number }>();

    if (!claimedRows || claimedRows.length === 0) return;

    // Group by job to reuse key rotators
    const rotators = new Map<string, KeyRotator>();
    for (const row of claimedRows) {
      if (!rotators.has(row.job_id)) {
        let keys: string[] = [];
        try {
          keys = JSON.parse(row.keys_json) as string[];
        } catch {
          keys = [];
        }
        rotators.set(row.job_id, new KeyRotator(keys));
      }
    }

    // ── Translate claimed chunks IN PARALLEL ─────────────────────────
    // A real chunk can take minutes; sequential loops exceed a single cron
    // invocation's budget and deadlock the job. All claims finish together or
    // get requeued together, so the batch stays small and predictable.
    await Promise.all(
      claimedRows.map((chunk) =>
        translateOneChunk(env, chunk, rotators.get(chunk.job_id)!),
      ),
    );

    // Milestone + completion Telegram notices per affected job
    const jobIds = [...new Set(claimedRows.map((r) => r.job_id))];
    for (const jobId of jobIds) {
      const job = await getJob(env.DB, jobId);
      if (!job || job.status !== "active") continue;
      const stats = await jobStats(env.DB, jobId);
      if (stats.total === 0) continue;

      const pct = Math.floor(((stats.completed + stats.failed) / stats.total) * 100);
      const milestone = Math.floor(pct / 25) * 25;

      if (
        job.telegram_bot_token &&
        job.telegram_chat_id &&
        job.telegram_on_progress &&
        milestone >= job.last_milestone + 25 &&
        milestone > 0 &&
        milestone < 100
      ) {
        await env.DB
          .prepare(`UPDATE jobs SET last_milestone = ? WHERE id = ?`)
          .bind(milestone, jobId)
          .run();
        void sendTelegram(
          job.telegram_bot_token,
          job.telegram_chat_id,
          `📖 <b>Translation ${milestone}%</b>\n${stats.completed}/${stats.total} chunks done`,
        );
      }

      // Completion check
      if (stats.completed + stats.failed >= stats.total) {
        await env.DB
          .prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`)
          .bind(Date.now(), jobId)
          .run();
        if (job.telegram_bot_token && job.telegram_chat_id && job.telegram_on_complete) {
          const words = await env.DB
            .prepare(
              `SELECT SUM(length(translated_text) - length(replace(translated_text, ' ', '')) + 1) AS words
               FROM chunks WHERE job_id = ? AND status = 'completed'`,
            )
            .bind(jobId)
            .first<{ words: number | null }>();
          void sendTelegram(
            job.telegram_bot_token,
            job.telegram_chat_id,
            `🎉 <b>Cloud translation complete!</b>\n${stats.completed} chunks • ~${(words?.words ?? 0).toLocaleString()} words\nOpen the app to download your .epub`,
          );
        }
      }
    }
  },
};
