/**
 * Cloudflare Worker — Novel Translator Cloud Backend
 *
 * Endpoints:
 *   GET  /api/ping
 *   POST /api/jobs                        — create a job + upload chunks
 *   GET  /api/jobs/:id                    — job status (+ mapping health)
 *   GET  /api/jobs/:id/chunks             — completed units (+ mapping fields)
 *   GET  /api/jobs/:id/export-summary     — per-original-section rollup for exports
 *   POST /api/jobs/:id/legacy-plan        — import a pre-mapping localStorage plan (validated)
 *   POST /api/jobs/:id/retry-blocked      — user-initiated: blocked chunks -> pending
 *   POST /api/jobs/:id/cancel             — cancel a running job
 *   DELETE /api/jobs/:id                  — delete a job
 *   POST /api/translate                   — on-demand single-chunk translation
 *   POST /api/run-cron                    — manual cron trigger (testing)
 *
 * Cron (every 1 min) — picks up pending/partial chunks and translates them.
 *
 * Engine (per approved plan v3):
 *   - finishReason/finish_reason detection: MAX_TOKENS/"length" triggers
 *     source-positioned continuation (never a blind re-translation).
 *   - Per-model output budgets from live-verified limits (core.ts).
 *   - Validation gate before status='completed' (no silent truncation, no
 *     untranslated Chinese marked as success).
 *   - BLOCKED (safety/policy) chunks are never retried across keys/models.
 *   - Server-authoritative chunk->original mapping; legacy (pre-mapping) jobs
 *     keep old behavior with an explicit uncertainty flag.
 *   - Free-only: quota exhaustion pauses with a wait message (never suggests paying).
 */

import {
  classifyGeminiResponse,
  classifyOpenRouterResponse,
  computeResumeBoundary,
  joinContinuation,
  requestedMaxTokens,
  validateTranslation,
  countParagraphs,
  type ProviderOutcome,
} from "../../src/lib/translator/translation-core";

const SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

## FORMATTING RULES (VERY IMPORTANT - FOLLOW EXACTLY):

You MUST separate EVERY paragraph with a BLANK LINE. This means each paragraph ends with TWO newline characters. This is non-negotiable.

- Count the paragraphs in the input. Your output MUST have the SAME number of paragraphs.
- Each paragraph in the input becomes exactly ONE paragraph in the output, separated by a blank line.
- Preserve dialogue formatting and paragraph indentation style.
- Do NOT merge paragraphs together.
- Do NOT output everything as one continuous block of text.

## OUTPUT RULES:
- Output ONLY the translated English text.
- Do NOT include any explanations, notes, commentary, or metadata.
- Do NOT wrap your output in quotes or markdown code blocks.
- Just return the raw translated English prose with proper paragraph spacing.
- CRITICAL: Do NOT leave ANY Chinese characters untranslated. Every single Chinese word, phrase, and sentence MUST be translated to English.`;

const CONTINUATION_PROMPT = `You are continuing a Chinese-to-English literary translation that was cut off by an output limit. You will receive the tail of the translation produced so far (CONTEXT ONLY) and the remaining untranslated source text.

## CONTINUATION RULES (CRITICAL):
- Translate the REMAINING SOURCE ONLY, continuing EXACTLY where the translated context ends.
- Do NOT repeat any previously translated text.
- Do NOT restart the translation from the beginning.
- Do NOT skip any source text. Start mid-sentence if that is where the context ends.
- Separate every paragraph with a blank line, matching the source paragraph structure.
- Output ONLY the continuing English prose. No commentary.`;

// ─── Auto-free model cascade (tried in order when auto mode is requested) ─────
const AUTO_FREE_MODELS = [
  "inclusionai/ling-3.0-flash-fin:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "poolside/laguna-s-2.1:free",
  "poolside/laguna-xs-2.1:free",
  "nex-agi/nex-n2.5-pro:free",
  "nex-agi/nex-n2.5-mini:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "thinkingmachines/inkling:free",
  "nvidia/nemotron-3.5-lightning:free",
  "thinkingmachines/inkling-small:free",
  "dots-studio/dots-3-note-preview:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "liquid/lfm-2.5-2.6b:free",
];

const BATCH_SIZE = 1; // chunks per cron tick — stay under 30s Worker CPU limit
const MAX_RETRIES = 3;
const STAGGER_MS = 4500;
/** Continuation rounds per chunk per cron pass (the partial text is preserved
 * between passes, so quota is never wasted re-translating the prefix). */
const MAX_CONTINUATION_ROUNDS = 3;
/** Total claim attempts (translation + continuations) before a partial is
 * parked as failed — text stays in D1, never silently dropped. */
const MAX_TOTAL_ATTEMPTS = 8;
/** Upstream fetch timeout per request. */
const UPSTREAM_TIMEOUT_MS = 110000;
/** A chunk in 'translating' whose updated_at is older than this was claimed
 * by a cron invocation that was killed by Cloudflare's wall-clock limit
 * (always shorter than this) — it is reclaimed with its accumulated
 * translated_text preserved, so no live worker can ever be double-claimed. */
const STALE_TRANSLATING_MS = 20 * 60_000;
/** buffy-smoke-* jobs reclaim much faster so recovery is observable in tests. */
const SMOKE_STALE_TRANSLATING_MS = 90_000;

// ─── Official Gemini endpoint (verified: googleapis.com serves HTML 404s) ─────
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

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

/** Resolve the OpenRouter model string. If auto, use the best ranked model. */
function resolveModel(_requested: string): string {
  return AUTO_FREE_MODELS[0];
}

/** True when `model` is a Gemini model (hits the Google endpoint). */
function isGeminiModel(model: string): boolean {
  return model.startsWith("gemini-");
}

// ─── Runtime schema migration (idempotent, non-destructive) ────────────────────
//
// The mapping columns are ADDITIVE. Existing rows keep NULL mapping fields:
// legacy jobs preserve their old (client-plan) behavior and are flagged
// "legacy-unmapped" instead of being assumed identity-mapped. Only the upload
// endpoint (or a validated legacy-plan import) ever fills these in.

let schemaReady = false;

async function ensureSchema(env: Env): Promise<void> {
  if (schemaReady) return;
  const alters = [
    `ALTER TABLE chunks ADD COLUMN original_chunk_id INTEGER`,
    `ALTER TABLE chunks ADD COLUMN part_index INTEGER`,
    `ALTER TABLE chunks ADD COLUMN part_count INTEGER`,
    `ALTER TABLE jobs ADD COLUMN original_count INTEGER`,
    `ALTER TABLE jobs ADD COLUMN smoke_max_tokens INTEGER`,
  ];
  for (const sql of alters) {
    try {
      await env.DB.prepare(sql).run();
    } catch {
      /* duplicate column — already migrated */
    }
  }
  // Evidence table for importing a legacy localStorage plan (validated).
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS legacy_upload_plan (
       job_id TEXT NOT NULL,
       original_id INTEGER NOT NULL,
       parts INTEGER NOT NULL,
       imported_at INTEGER NOT NULL,
       PRIMARY KEY (job_id, original_id)
     )`,
  ).run();
  schemaReady = true;
}

// ─── Provider calls (classified outcomes + per-model output budget) ────────────

async function callGemini(
  text: string,
  key: string,
  model: string,
  systemPrompt: string,
  maxOutputTokens: number,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<ProviderOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // AQ. keys MUST go in the header — query-param auth is forbidden.
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens,
        },
        systemInstruction: { parts: [{ text: systemPrompt }] },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 429) return { kind: "RATE_LIMITED" };
      const low = errBody.toLowerCase();
      if (
        res.status === 401 ||
        res.status === 403 ||
        /api[ _-]?key|invalid|expired|unauthorized|credential|permission|forbidden|denied|authentication|access denied|no access/i.test(low)
      ) {
        return {
          kind: "KEY_REJECTED",
          reason: `key …${key.slice(-4)}: ${errBody.slice(0, 200) || "Invalid or expired API key"}`,
        };
      }
      if (res.status === 400 && /SAFETY|PROHIBITED_CONTENT|BLOCKLIST|RECITATION|SPII/i.test(errBody)) {
        return { kind: "BLOCKED", reason: errBody.slice(0, 300) };
      }
      return { kind: "TRANSIENT", reason: `HTTP ${res.status}: ${errBody.slice(0, 300)}` };
    }

    const data = (await res.json().catch(() => null)) as unknown;
    if (!data) return { kind: "TRANSIENT", reason: "invalid JSON response" };
    return classifyGeminiResponse(data, model);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) return { kind: "TRANSIENT", reason: "upstream timeout" };
    return { kind: "TRANSIENT", reason: msg.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenRouter(
  text: string,
  key: string,
  model: string,
  systemPrompt: string,
  maxTokens: number,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<ProviderOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        max_tokens: maxTokens,
        temperature: 0.3,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      if (res.status === 429) return { kind: "RATE_LIMITED" };
      if (res.status === 402 || res.status === 404 || res.status === 408) {
        return { kind: "TRANSIENT", reason: `model unavailable (HTTP ${res.status})` };
      }
      const low = errBody.toLowerCase();
      if (
        res.status === 401 ||
        (res.status === 403 &&
          /api[ _-]?key|invalid|expired|unauthorized|credential|authentication/i.test(low))
      ) {
        return { kind: "KEY_REJECTED", reason: `key …${key.slice(-4)}: ${errBody.slice(0, 200)}` };
      }
      if (/content filter|content_filter|moderation policy|flagged/i.test(low)) {
        return { kind: "BLOCKED", reason: errBody.slice(0, 300) };
      }
      return { kind: "TRANSIENT", reason: `HTTP ${res.status}: ${errBody.slice(0, 300)}` };
    }

    const data = (await res.json().catch(() => null)) as unknown;
    if (!data) return { kind: "TRANSIENT", reason: "invalid JSON response" };
    return classifyOpenRouterResponse(data, model, res.status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) return { kind: "TRANSIENT", reason: "upstream timeout" };
    return { kind: "TRANSIENT", reason: msg.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Continuation engine ───────────────────────────────────────────────────────
/** Route a key to the provider that owns it by prefix (the app's convention):
 * sk-or-v1-… → OpenRouter (Bearer), AQ.… → Gemini (x-goog-api-key header).
 * Never feed a Gemini key to OpenRouter or vice versa — the provider just
 * rejects it as "Missing Authentication" and the attempt is wasted. */
function openrouterKeysOf(keys: string[]): string[] {
  return keys.filter((k) => k.startsWith("sk-or-v1-"));
}
function geminiKeysOf(keys: string[]): string[] {
  return keys.filter((k) => k.startsWith("AQ."));
}

interface TranslationResult {
  translated: string;
  model: string;
  /** Output hit the model's limit and rounds were exhausted — stored as partial. */
  truncated: boolean;
  blockedReason?: string;
  gateReason?: string;
  rateLimited?: boolean;
  keyRejected?: string;
  transient?: string;
}

/** Build the continuation user message: translated tail as context + remaining source. */
function buildContinuationMessage(
  accumulated: string,
  remainingSource: string,
): string {
  const accParas = accumulated.split(/\n+/).filter((p) => p.trim().length > 0);
  const tail = accParas.slice(-2).join("\n\n");
  return (
    `[TRANSLATED SO FAR — CONTEXT ONLY. Do NOT repeat or restart this.]\n` +
    `${tail}\n\n` +
    `[REMAINING SOURCE — translate ALL of it now, starting exactly where the context above ends]\n` +
    `${remainingSource}`
  );
}

/**
 * Translate one unit with continuation: on truncation, resume from the exact
 * untranslated source position (paragraph-aligned) and append — never a blind
 * re-translation. The expensive prefix is never recomputed.
 */
async function translateWithContinuation(
  source: string,
  keys: string[],
  model: string,
  liveModels: string[] | null | undefined,
  /** Previously accumulated text when resuming a `partial` unit. */
  priorAccumulated: string = "",
  /** SMOKE ONLY: forced budget for buffy-smoke-* jobs; always clamped below. */
  budgetOverride?: number | null,
): Promise<TranslationResult> {
  const backend = isGeminiModel(model) ? callGemini : callOpenRouter;
  const budget =
    budgetOverride && budgetOverride > 0
      ? Math.min(budgetOverride, requestedMaxTokens(model))
      : requestedMaxTokens(model);

  let accumulated = priorAccumulated;
  let firstRound = priorAccumulated.length === 0;

  for (let round = 0; round <= MAX_CONTINUATION_ROUNDS; round++) {
    let promptText: string;
    let sentSourceRegion = "";

    if (firstRound) {
      promptText = source;
    } else {
      // Locate the exact untranslated position from the accumulated text.
      const srcParas = source.split(/\n+/).filter((p) => p.trim().length > 0);
      const boundary = computeResumeBoundary(srcParas, accumulated);
      if (boundary.confident) {
        // Slice at the paragraph boundary — the model translates exactly the
        // untranslated source, in position.
        const joined = srcParas.join("\n");
        sentSourceRegion = joined.slice(boundary.charOffset);
        if (sentSourceRegion.trim().length === 0) {
          // Everything is covered but the finish reason said truncated — the
          // boundary overshot; treat as full-source continuation (guards protect).
          sentSourceRegion = joined;
        }
        promptText = buildContinuationMessage(accumulated, sentSourceRegion);
      } else {
        // Unreliable alignment: do NOT guess a position. Send the full source
        // as context; restart/echo guards reject any bad continuation.
        sentSourceRegion = source;
        promptText =
          `[TRANSLATED SO FAR — CONTEXT ONLY. It is INCOMPLETE. Do NOT repeat or restart.]\n` +
          `${accumulated.slice(-1200)}\n\n` +
          `[FULL SOURCE — the translation above is MISSING its ending and possibly more. Output ONLY the missing continuation, starting exactly where the context stops mid-flow.]`;
      }
      if (round > MAX_CONTINUATION_ROUNDS - 1) break;
    }      // Try all PROVIDER-APPROPRIATE keys for this model/round.
      const roundKeys = isGeminiModel(model) ? geminiKeysOf(keys) : openrouterKeysOf(keys);
      if (roundKeys.length === 0) {
        // No key for this provider — skip the model entirely (cascade onward)
        // instead of reporting a bogus quota exhaustion.
        if (firstRound) {
          return { translated: "", model, truncated: false, keyRejected: `no ${isGeminiModel(model) ? "Gemini" : "OpenRouter"} key provided` };
        }
        return { translated: accumulated, model, truncated: true, keyRejected: `no ${isGeminiModel(model) ? "Gemini" : "OpenRouter"} key provided` };
      }
      let outcome: ProviderOutcome | null = null;
      for (const key of roundKeys) {
      outcome = isGeminiModel(model)
        ? await (backend as typeof callGemini)(promptText, key, model, firstRound ? SYSTEM_PROMPT : CONTINUATION_PROMPT, budget)
        : await (backend as typeof callOpenRouter)(promptText, key, model, firstRound ? SYSTEM_PROMPT : CONTINUATION_PROMPT, budget);
      if (outcome.kind === "RATE_LIMITED") continue; // next key
      if (outcome.kind === "KEY_REJECTED") continue; // next key; surfaced after loop
      break;
    }
    if (!outcome) {
      return { translated: accumulated, model, truncated: accumulated.length > 0, rateLimited: true };
    }

    if (outcome.kind === "RATE_LIMITED") {
      return { translated: accumulated, model, truncated: accumulated.length > 0, rateLimited: true };
    }
    if (outcome.kind === "KEY_REJECTED") {
      return { translated: accumulated, model, truncated: accumulated.length > 0, keyRejected: outcome.reason };
    }
    if (outcome.kind === "BLOCKED") {
      // Never retried, on any key or model — quota is not burned on blocks.
      return { translated: accumulated, model, truncated: false, blockedReason: outcome.reason };
    }
    if (outcome.kind === "TRANSIENT") {
      if (firstRound) return { translated: "", model, truncated: false, transient: outcome.reason };
      // A transient failure mid-continuation keeps the accumulated prefix as partial.
      return { translated: accumulated, model, truncated: true, transient: outcome.reason };
    }

    const piece = outcome.content;
    if (firstRound) {
      accumulated = piece;
      firstRound = false;
      const v = validateTranslation(accumulated, source);
      if (v.passed) {
        return { translated: accumulated, model, truncated: false };
      }
      // If the gate fails AND we have more to give (truncation), continue;
      // otherwise this model's answer is unusable as-is.
      if (outcome.kind === "TRUNCATED" || v.reason === "too-short" || v.reason === "missing-paragraphs") {
        continue; // continuation round
      }
      return { translated: accumulated, model, truncated: false, gateReason: v.reason };
    }

    // Continuation round: join with guards (restart / echo / overlap strip).
    const join = joinContinuation(accumulated, piece, sentSourceRegion);
    if (!join.ok) {
      // One bad continuation is enough — do not burn quota looping a confused model.
      const v = validateTranslation(accumulated, source);
      return {
        translated: accumulated,
        model,
        truncated: true,
        gateReason: v.passed ? undefined : v.reason,
      };
    }
    accumulated = join.joined;

    if (outcome.kind === "SUCCESS") {
      const v = validateTranslation(accumulated, source);
      if (v.passed) return { translated: accumulated, model, truncated: false };
      // Still short of the source — one more round if we have one.
      if (round < MAX_CONTINUATION_ROUNDS) continue;
      return { translated: accumulated, model, truncated: true, gateReason: v.reason };
    }
    // TRUNCATED again — loop for another continuation round.
  }

  const v = validateTranslation(accumulated, source);
  return {
    translated: accumulated,
    model,
    truncated: true,
    gateReason: v.passed ? undefined : v.reason,
  };
}

// ─── Cascade orchestration ─────────────────────────────────────────────────────

/**
 * Translate a unit: requested model first (all keys), then the free cascade
 * for OpenRouter models. BLOCKED aborts everything (never retried).
 * Gemini models get all keys on the requested model before failing.
 */
async function translateChunk(
  text: string,
  keys: string[],
  requestedModel: string,
  liveModels?: string[] | null,
  priorAccumulated: string = "",
  budgetOverride?: number | null,
): Promise<TranslationResult> {
  if (!keys.length) {
    return { translated: "", model: requestedModel, truncated: false, transient: "No API keys provided" };
  }

  let models: string[];
  if (isGeminiModel(requestedModel)) {
    models = [requestedModel];
  } else if (requestedModel === "openrouter/free") {
    models =
      liveModels && liveModels.length > 0
        ? liveModels
        : [resolveModel(requestedModel), ...AUTO_FREE_MODELS.filter((m) => m !== resolveModel(requestedModel))];
  } else {
    models = [requestedModel, ...AUTO_FREE_MODELS.filter((m) => m !== requestedModel)];
  }

  let last: TranslationResult | null = null;
  let allRateLimited = true;

  for (const model of models) {
    const result = await translateWithContinuation(text, keys, model, liveModels, priorAccumulated, budgetOverride);

    if (result.blockedReason) return result; // BLOCKED: stop the entire cascade
    if (!result.rateLimited && !result.keyRejected && !result.transient) {
      const usable = result.truncated
        ? result.translated.length > 0 // partial progress is worth keeping
        : true;
      if (usable) return result;
    }
    last = result;
    if (result.rateLimited) {
      continue; // try next model with fresh keys
    }
    allRateLimited = false;
    if (result.keyRejected && keys.length > 1) {
      continue; // a rejected key shouldn't kill the cascade; result still recorded
    }
    if (!result.truncated || result.translated.length === 0) {
      // Hard failure on THIS model with no progress — including empty-content
      // TRANSIENT (reasoning models can burn the entire output budget on
      // hidden reasoning and return nothing). Cascade to the next FREE model
      // instead of burning every attempt on a dead model; same treatment as
      // RATE_LIMITED. On the last model this exits the loop and `last` is
      // returned, so behavior for a fully-failed cascade is unchanged.
      continue;
    }
    // Partial progress on this model — prefer it over gambling on the cascade.
    return result;
  }

  if (last) return last;
  return {
    translated: priorAccumulated,
    model: requestedModel,
    truncated: priorAccumulated.length > 0,
    transient: "All translation attempts failed",
    rateLimited: allRateLimited || undefined,
  };
}

// ─── Route Handler ────────────────────────────────────────────────────────────

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") return cors();
  await ensureSchema(env);

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
      chunks: { text: string; gzip?: boolean; originalId?: number; partIndex?: number; partCount?: number }[];
      liveModels?: string[];
      originalChunkCount?: number;
      telegramBotToken?: string;
      telegramChatId?: string;
      telegramNotifyOnStart?: boolean;
      telegramNotifyOnProgress?: boolean;
      telegramNotifyOnError?: boolean;
      telegramNotifyOnComplete?: boolean;
      /** SMOKE TESTS ONLY: forces a low output budget to make truncation
       * deterministic. Honored exclusively for fileName starting with
       * "buffy-smoke-" and can only LOWER the budget (clamped), so real jobs
       * are never affected and no model limit can be exceeded. */
      smoke?: { forceMaxOutputTokens?: number };
    };

    if (!body.chunks?.length) return json({ error: "No chunks provided" }, 400);
    if (!body.keys?.length) return json({ error: "No API keys provided" }, 400);

    const jobId = crypto.randomUUID();
    const now = Date.now();

    const smokeBudget =
      body.fileName?.startsWith("buffy-smoke-") &&
      Number.isInteger(body.smoke?.forceMaxOutputTokens) &&
      (body.smoke?.forceMaxOutputTokens as number) >= 32
        ? Math.min(body.smoke!.forceMaxOutputTokens!, 8192)
        : null;

    const liveModelsJson = body.liveModels && body.liveModels.length > 0
      ? JSON.stringify(body.liveModels) : null;

    await env.DB.prepare(
      `INSERT INTO jobs (id, file_name, model, keys_json, status, created_at, updated_at, live_models_json, telegram_bot_token, telegram_chat_id, telegram_on_start, telegram_on_progress, telegram_on_error, telegram_on_complete, last_milestone, original_count, smoke_max_tokens)
       VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
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
        body.originalChunkCount ?? body.chunks.length,
        smokeBudget,
      )
      .run();

    // Server-authoritative mapping: if the client sent mapping fields, every
    // unit MUST carry them (all-or-nothing — no half-mapped jobs).
    const hasMapping = body.chunks.some((c) => c.originalId !== undefined);
    const mappingComplete = body.chunks.every(
      (c) => c.originalId !== undefined && c.partIndex !== undefined && c.partCount !== undefined,
    );
    if (hasMapping && !mappingComplete) {
      await env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId).run();
      return json({ error: "Incomplete mapping fields on chunks" }, 400);
    }

    const BATCH = 25;
    for (let i = 0; i < body.chunks.length; i += BATCH) {
      const batch = body.chunks.slice(i, i + BATCH);
      const stmts = await Promise.all(
        batch.map(async (c, idx) => {
          const text = c.gzip ? await decompressGzip(c.text) : c.text;
          return env.DB.prepare(
            `INSERT INTO chunks (job_id, seq, text, status, attempts, updated_at, original_chunk_id, part_index, part_count)
             VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
          ).bind(
            jobId,
            i + idx,
            text,
            now,
            mappingComplete ? c.originalId! : null,
            mappingComplete ? c.partIndex! : null,
            mappingComplete ? c.partCount! : null,
          );
        }),
      );
      await env.DB.batch(stmts);
    }

    // Telegram start notification (original sections, not upload units)
    if (body.telegramBotToken && body.telegramChatId && body.telegramNotifyOnStart) {
      const sectionCount = body.originalChunkCount ?? body.chunks.length;
      const modelLabel = isGeminiModel(body.model)
        ? body.model
        : body.model.split("/").pop()?.replace(/:free$/, "") ?? body.model;
      await sendTelegram(
        body.telegramBotToken,
        body.telegramChatId,
        `🚀 <b>Cloud translation started</b>\n📚 ${body.fileName}\n📦 ${sectionCount} chunks • ⚙️ ${modelLabel}`,
      ).catch(() => undefined);
    }

    return json({ jobId, totalChunks: body.chunks.length, mapping: mappingComplete ? "server" : "legacy" });
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
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) as partial,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
         FROM chunks WHERE job_id = ?`
      ).bind(jobId).first();

      const lastChunk = await env.DB.prepare(
        `SELECT MAX(updated_at) as last_at FROM chunks WHERE job_id = ? AND status = 'completed'`
      ).bind(jobId).first();

      // Mapping health: legacy jobs with NULL mapping columns and no imported
      // plan are explicitly flagged — the UI must surface this, never guess.
      const mappedCount = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM chunks WHERE job_id = ? AND original_chunk_id IS NOT NULL`
      ).bind(jobId).first();
      const legacyPlan = await env.DB.prepare(
        `SELECT COUNT(*) as n FROM legacy_upload_plan WHERE job_id = ?`
      ).bind(jobId).first();

      const totalRows = (counts?.total as number) ?? 0;
      const mappedRows = (mappedCount?.n as number) ?? 0;
      let mapping: "server" | "legacy-imported" | "legacy-unmapped";
      if (mappedRows === totalRows && totalRows > 0) mapping = "server";
      else if ((legacyPlan?.n as number) > 0) mapping = "legacy-imported";
      else mapping = "legacy-unmapped";

      let pauseReason: string | null = null;
      if (job.status === "paused") {
        const failedSample = await env.DB.prepare(
          `SELECT error FROM chunks WHERE job_id = ? AND status = 'failed' AND (error LIKE '%quota%' OR error = 'Daily free-tier quota exhausted') LIMIT 1`
        ).bind(jobId).first();
        if (failedSample) pauseReason = "quota_exhausted";
        else {
          const blockedSample = await env.DB.prepare(
            `SELECT COUNT(*) as n FROM chunks WHERE job_id = ? AND status = 'blocked'`
          ).bind(jobId).first();
          if ((blockedSample?.n as number) > 0) pauseReason = "content_blocked";
        }
      }

      return json({
        jobId: job.id,
        fileName: job.file_name,
        status: job.status,
        totalChunks: counts?.total ?? 0,
        completedChunks: counts?.completed ?? 0,
        failedChunks: counts?.failed ?? 0,
        partialChunks: counts?.partial ?? 0,
        blockedChunks: counts?.blocked ?? 0,
        originalCount: job.original_count ?? counts?.total ?? 0,
        mapping,
        activeModel: job.active_model ?? null,
        createdAt: job.created_at,
        lastHeartbeat: job.last_heartbeat,
        lastChunkAt: lastChunk?.last_at ?? null,
        updatedAt: job.updated_at,
        pauseReason,
      });
    }

    if (method === "DELETE") {
      await env.DB.prepare(`DELETE FROM chunks WHERE job_id = ?`).bind(jobId).run();
      await env.DB.prepare(`DELETE FROM legacy_upload_plan WHERE job_id = ?`).bind(jobId).run();
      await env.DB.prepare(`DELETE FROM jobs WHERE id = ?`).bind(jobId).run();
      return json({ ok: true });
    }
  }

  // ── Debug: get chunk errors for a job ─────────────────────────
  const debugMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/debug$/);
  if (debugMatch && method === "GET") {
    const jobId = debugMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    const rows = await env.DB.prepare(
      `SELECT seq, status, error, model_used, attempts, original_chunk_id, part_index, part_count
       FROM chunks WHERE job_id = ? ORDER BY seq ASC`
    ).bind(jobId).all();
    return json({ chunks: rows.results });
  }

  // ── Get completed units (+ mapping fields; additive, client-compatible) ──
  const chunksMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/chunks$/);
  if (chunksMatch && method === "GET") {
    const jobId = chunksMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);

    const after = Number(url.searchParams.get("after") ?? "-1");
    const rows = await env.DB.prepare(
      `SELECT id, seq, translated_text, status, original_chunk_id, part_index, part_count
       FROM chunks
       WHERE job_id = ? AND seq > ? AND status = 'completed' AND translated_text IS NOT NULL
       ORDER BY seq ASC`
    )
      .bind(jobId, after)
      .all();

    return json({
      chunks: rows.results.map((r) => ({
        id: r.id as number,
        seq: r.seq as number,
        text: r.translated_text as string,
        originalId: r.original_chunk_id as number | null,
        partIndex: r.part_index as number | null,
        partCount: r.part_count as number | null,
      })),
    });
  }

  // ── Export summary: per-original-section rollup ───────────────
  const summaryMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/export-summary$/);
  if (summaryMatch && method === "GET") {
    const jobId = summaryMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);

    const job = await env.DB.prepare(`SELECT original_count FROM jobs WHERE id = ?`).bind(jobId).first();
    const rows = await env.DB.prepare(
      `SELECT original_chunk_id, part_index, part_count, status
       FROM chunks WHERE job_id = ? ORDER BY seq ASC`
    ).bind(jobId).all();

    type Acc = { parts: Set<number>; expected: number; statuses: string[] };
    const byOriginal = new Map<number, Acc>();
    let unmappedRows = 0;
    for (const r of rows.results) {
      const oid = r.original_chunk_id as number | null;
      if (oid === null || oid === undefined) {
        unmappedRows++;
        continue;
      }
      const acc = byOriginal.get(oid) ?? { parts: new Set<number>(), expected: (r.part_count as number) ?? 1, statuses: [] };
      if (r.status === "completed") acc.parts.add((r.part_index as number) ?? 0);
      acc.statuses.push(r.status as string);
      byOriginal.set(oid, acc);
    }

    const sections = [...byOriginal.entries()].map(([id, acc]) => ({
      id,
      partsCompleted: acc.parts.size,
      partsExpected: acc.expected,
      complete: acc.parts.size >= acc.expected,
      blocked: acc.statuses.includes("blocked"),
      failed: acc.statuses.includes("failed"),
      partial: acc.statuses.includes("partial"),
    }));

    const maxId = sections.length > 0 ? Math.max(...sections.map((s) => s.id)) : -1;
    const declared = (job?.original_count as number) ?? 0;
    return json({
      mapping: unmappedRows === 0 && sections.length > 0 ? "server" : unmappedRows > 0 && sections.length > 0 ? "mixed" : "legacy-unmapped",
      declaredOriginalCount: declared,
      detectedOriginalCount: sections.length,
      // A declared count larger than detected => some originals have no units
      // visible => legacy/unmapped territory; UI must warn.
      suspiciousGap: declared > 0 && sections.length > 0 && Math.max(0, declared - sections.length) > 0,
      maxSeenId: maxId,
      sections,
    });
  }

  // ── Legacy plan import (validated — refuses uncertain evidence) ──────────────
  const legacyMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/legacy-plan$/);
  if (legacyMatch && method === "POST") {
    const jobId = legacyMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);

    const body = (await request.json()) as { entries?: { originalId: number; parts: number }[] };
    const entries = (body.entries ?? []).filter((e) => Number.isInteger(e.originalId) && Number.isInteger(e.parts) && e.parts >= 1);
    if (entries.length === 0) return json({ error: "No valid plan entries" }, 400);

    // Only pre-mapping jobs are eligible: every mapping column must be NULL.
    const row = await env.DB.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN original_chunk_id IS NOT NULL THEN 1 ELSE 0 END) as mapped
       FROM chunks WHERE job_id = ?`
    ).bind(jobId).first();
    if (!row || (row.total as number) === 0) return json({ error: "Job not found or has no chunks" }, 404);
    if ((row.mapped as number) > 0) {
      return json({ error: "Job already has server-authoritative mapping" }, 409);
    }

    // The plan must account for EXACTLY every uploaded unit — otherwise the
    // evidence is unreliable and the import is refused (no silent guessing).
    const totalUnits = row.total as number;
    const planUnits = entries.reduce((s, e) => s + e.parts, 0);
    if (planUnits !== totalUnits) {
      return json({ error: `Plan covers ${planUnits} units but job has ${totalUnits} — refusing uncertain mapping` }, 422);
    }
    // Original ids must be contiguous from 0 (book order is positional).
    const ids = entries.map((e) => e.originalId).sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] !== i) return json({ error: "Plan original ids must be contiguous from 0" }, 422);
    }

    const now = Date.now();
    const stmts: D1PreparedStatement[] = [];
    let seqCursor = 0;
    // Chunks are stored in upload order; the plan lists originals in order, so
    // assign mapping fields by walking both in parallel.
    const unitRows = await env.DB.prepare(
      `SELECT id FROM chunks WHERE job_id = ? ORDER BY seq ASC`
    ).bind(jobId).all();
    const unitIds = unitRows.results.map((r) => r.id as number);
    if (unitIds.length !== totalUnits) return json({ error: "Chunk rows changed during import — retry" }, 409);

    for (const e of entries) {
      for (let p = 0; p < e.parts; p++) {
        const unitId = unitIds[seqCursor++];
        stmts.push(
          env.DB.prepare(
            `UPDATE chunks SET original_chunk_id = ?, part_index = ?, part_count = ? WHERE id = ?`
          ).bind(e.originalId, p, e.parts, unitId),
        );
      }
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO legacy_upload_plan (job_id, original_id, parts, imported_at) VALUES (?, ?, ?, ?)`
        ).bind(jobId, e.originalId, e.parts, now),
      );
    }
    await env.DB.batch(stmts);
    return json({ ok: true, mappedUnits: totalUnits, originals: entries.length });
  }

  // ── Retry blocked chunks (explicit user action only) ──────────
  const retryBlockedMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/retry-blocked$/);
  if (retryBlockedMatch && method === "POST") {
    const jobId = retryBlockedMatch[1];
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    const res = await env.DB.prepare(
      `UPDATE chunks SET status = 'pending', error = NULL, updated_at = ? WHERE job_id = ? AND status = 'blocked'`
    ).bind(Date.now(), jobId).run();
    await env.DB.prepare(
      `UPDATE jobs SET status = 'active', updated_at = ? WHERE id = ? AND status = 'paused'`
    ).bind(Date.now(), jobId).run();
    return json({ ok: true, reset: res.meta?.changes ?? 0 });
  }

  // ── On-demand single-chunk translation (client-side via worker) ──────────────
  if (path === "/api/translate" && method === "POST") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    try {
      const body = (await request.json()) as {
        text: string;
        model: string;
        keys: string[];
        liveModels?: string[];
      };
      if (!body.text) return json({ error: "Missing text" }, 400);
      if (!body.keys?.length) return json({ error: "No API keys" }, 400);
      const result = await translateChunk(body.text, body.keys, body.model, body.liveModels ?? null);
      if (result.blockedReason) {
        return json({ error: `BLOCKED: ${result.blockedReason}` }, 422);
      }
      return json({ translated: result.translated, model: result.model, truncated: result.truncated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 500);
    }
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

    await env.DB.prepare(`UPDATE chunks SET status = 'pending' WHERE job_id = ? AND status = 'translating'`)
      .bind(jobId)
      .run();

    return json({ ok: true });
  }

  // ── SMOKE TESTS ONLY: simulate a stalled 'translating' chunk ──────────
  // Rewinds updated_at on an in-flight chunk of a buffy-smoke-* job so the
  // stale-reclaim path can be observed deterministically. Refuses real jobs.
  const smokeStaleMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)\/smoke-stale$/);
  if (smokeStaleMatch && method === "POST") {
    if (!verifySecret(request, env)) return json({ error: "Invalid secret" }, 403);
    const jobId = smokeStaleMatch[1];
    const job = await env.DB.prepare(`SELECT file_name FROM jobs WHERE id = ?`).bind(jobId).first();
    if (!job) return json({ error: "Job not found" }, 404);
    if (!(job.file_name as string).startsWith("buffy-smoke-")) {
      return json({ error: "smoke-stale is only allowed on buffy-smoke-* jobs" }, 403);
    }
    const res = await env.DB.prepare(
      `UPDATE chunks SET updated_at = ? WHERE job_id = ? AND status = 'translating'`
    )
      .bind(Date.now() - SMOKE_STALE_TRANSLATING_MS - 10_000, jobId)
      .run();
    return json({ ok: true, rewound: res.meta?.changes ?? 0 });
  }

  return json({ error: "Not found" }, 404);
}

// ─── Cron Handler ─────────────────────────────────────────────────────────────

async function handleCron(env: Env): Promise<void> {
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

    await env.DB.prepare(`UPDATE jobs SET last_heartbeat = ?, updated_at = ? WHERE id = ?`)
      .bind(Date.now(), Date.now(), jobId)
      .run();

    // ── Stale 'translating' reclaim (Defect #2 fix) ─────────────
    // A cron invocation can be killed by Cloudflare's wall-clock limit
    // mid-flight, stranding chunks in 'translating' forever — the claim below
    // only picks pending/partial. Reclaim anything stale ATOMICALLY (the
    // status + updated_at CAS means a second worker can never re-claim a row
    // that was just recovered). Any accumulated translated_text is preserved
    // and the chunk resumes from its exact stored position.
    const staleMs = (job.file_name as string | undefined)?.startsWith("buffy-smoke-")
      ? SMOKE_STALE_TRANSLATING_MS
      : STALE_TRANSLATING_MS;
    await env.DB.prepare(
      `UPDATE chunks
         SET status = CASE WHEN COALESCE(translated_text, '') = '' THEN 'pending' ELSE 'partial' END,
             error = CASE WHEN COALESCE(translated_text, '') = '' THEN error
                          ELSE 'reclaimed from stalled translating — continuation pending' END,
             updated_at = ?
       WHERE job_id = ? AND status = 'translating' AND updated_at < ?`
    )
      .bind(Date.now(), jobId, Date.now() - staleMs)
      .run();

    // Claim pending AND partial units — partials resume from their stored
    // accumulated text (the prefix is never re-translated).
    const pending = await env.DB.prepare(
      `SELECT id, seq, text, translated_text, attempts FROM chunks
       WHERE job_id = ? AND status IN ('pending', 'partial')
       ORDER BY seq ASC
       LIMIT ?`
    )
      .bind(jobId, BATCH_SIZE)
      .all();

    if (pending.results.length === 0) {
      const currentJob = await env.DB.prepare(`SELECT status FROM jobs WHERE id = ?`).bind(jobId).first();
      if (currentJob?.status === "paused") continue;

      const counts = await env.DB.prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
           SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as blocked
         FROM chunks WHERE job_id = ?`
      ).bind(jobId).first();

      const total = (counts?.total as number) ?? 0;
      const completed = (counts?.completed as number) ?? 0;
      const failed = (counts?.failed as number) ?? 0;
      const blocked = (counts?.blocked as number) ?? 0;

      if (completed + failed + blocked === total && total > 0) {
        await env.DB.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`)
          .bind(Date.now(), jobId)
          .run();

        if (telegramToken && telegramChatId && notifyOnComplete) {
          // Report ORIGINAL sections, not upload units.
          const sectionsDone = await countOriginalSections(env, jobId, "completed");
          const sectionsBlocked = await countOriginalSections(env, jobId, "blocked");
          await sendTelegram(
            telegramToken,
            telegramChatId,
            `🎉 <b>Cloud translation complete!</b>\n✅ ${sectionsDone} sections translated\n❌ ${failed} failed\n🚫 ${sectionsBlocked} blocked`,
          ).catch(() => undefined);
        }
      }
      continue;
    }

    const now = Date.now();
    // Atomic claim (Defect #2 companion): the status guard makes concurrent
    // cron invocations safe — only the FIRST worker's UPDATE matches, so the
    // same chunk can never be double-claimed (which would burn free quota).
    const claimed: typeof pending.results = [];
    for (const r of pending.results) {
      const claim = await env.DB.prepare(
        `UPDATE chunks SET status = 'translating', updated_at = ?
         WHERE id = ? AND status IN ('pending', 'partial')`
      )
        .bind(now, r.id)
        .run();
      if ((claim.meta?.changes ?? 0) > 0) claimed.push(r);
    }

    let completedDelta = 0;
    let failedDelta = 0;
    let blockedDelta = 0;
    let quotaExhausted = false;

    for (let i = 0; i < claimed.length; i++) {
      const chunk = claimed[i];
      const chunkId = chunk.id as number;
      const seq = chunk.seq as number;
      const text = chunk.text as string;
      const priorAccumulated = (chunk.translated_text as string | null) ?? "";
      const currentAttempts = (chunk.attempts as number) ?? 0;

      if (i > 0) {
        await new Promise((r) => setTimeout(r, STAGGER_MS));
      }

      try {
        const smokeBudget =
          (job.file_name as string | undefined)?.startsWith("buffy-smoke-")
            ? (job.smoke_max_tokens as number | null)
            : null;
        const result = await translateChunk(text, keys, model, liveModels, priorAccumulated, smokeBudget);
        const attempts = currentAttempts + 1;

        // BLOCKED: never retried, no key/model cycling — quota is protected.
        if (result.blockedReason) {
          // CAS on the claim state: if the chunk was stale-reclaimed while a
          // zombie worker was still computing, only the live claimant writes.
          await env.DB.prepare(
            `UPDATE chunks SET status = 'blocked', translated_text = NULL, model_used = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ? AND status = 'translating'`
          )
            .bind(result.model, `BLOCKED: ${result.blockedReason}`.slice(0, 1000), attempts, Date.now(), chunkId)
            .run();
          blockedDelta++;

          if (telegramToken && telegramChatId) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `🚫 <b>Chunk ${seq + 1} blocked by content policy</b>\n<code>${result.blockedReason.slice(0, 200)}</code>\nNot retried (saves free quota). Use "Retry blocked" in the app if needed.`,
            ).catch(() => undefined);
          }
          // Blocks on one chunk usually mean more blocks — pause to protect quota.
          await env.DB.prepare(`UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`)
            .bind(Date.now(), jobId)
            .run();
          if (telegramToken && telegramChatId) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `⏸️ <b>Translation paused — content blocked</b>\nThe provider refused to translate this passage. Other chunks are safe.\nOpen the app to review, or tap "Retry blocked" to continue anyway.`,
            ).catch(() => undefined);
          }
          break;
        }

        // QUOTA: all keys rate-limited → pause, wait state (free-only message).
        if (result.rateLimited && result.translated.length === 0) {
          quotaExhausted = true;
          await env.DB.prepare(
            `UPDATE chunks SET status = 'pending', error = 'Daily free-tier quota exhausted', attempts = ?, updated_at = ? WHERE id = ?`
          )
            .bind(attempts, Date.now(), chunkId)
            .run();

          await env.DB.prepare(`UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'active'`)
            .bind(Date.now(), jobId)
            .run();

          if (telegramToken && telegramChatId) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `⏸️ <b>Translation paused — daily free quota exhausted</b>\nAll keys have hit their free daily limit.\n\n⏱️ Resets at midnight UTC — no action needed, just Resume later.\nNothing was lost; completed chunks are saved.`,
            ).catch(() => undefined);
          }
          break;
        }

        // Validated completion only — the gate ran inside the engine. Empty
        // text is never "completed": a transient failure with no output must
        // retry instead.
        if (!result.truncated && result.translated.trim().length > 0) {
          // CAS on the claim state — same zombie-worker protection as above.
          await env.DB.prepare(
            `UPDATE chunks SET status = 'completed', translated_text = ?, model_used = ?, error = NULL, attempts = ?, updated_at = ? WHERE id = ? AND status = 'translating'`
          )
            .bind(result.translated, result.model, attempts, Date.now(), chunkId)
            .run();
          completedDelta++;

          await env.DB.prepare(`UPDATE jobs SET active_model = ?, updated_at = ? WHERE id = ?`)
            .bind(result.model, Date.now(), jobId)
            .run();
          continue;
        }

        // PARTIAL: keep the accumulated text; the next tick continues from the
        // exact untranslated position (no re-translation of the prefix).
        if (attempts >= MAX_TOTAL_ATTEMPTS) {
          await env.DB.prepare(
            `UPDATE chunks SET status = 'failed', translated_text = ?, model_used = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ?`
          )
            .bind(
              result.translated,
              result.model,
              `Failed after ${attempts} attempts: ${result.gateReason ?? result.keyRejected ?? result.transient ?? "truncation not resolved"}`.slice(0, 1000),
              attempts,
              Date.now(),
              chunkId,
            )
            .run();
          failedDelta++;
          if (telegramToken && telegramChatId && notifyOnError) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `❌ <b>Chunk ${seq + 1} failed after ${attempts} attempts</b>\n<code>${(result.gateReason ?? result.transient ?? "unknown").slice(0, 150)}</code>\nPartial text is preserved in storage — nothing was lost.`,
            ).catch(() => undefined);
          }
          continue; // do NOT pause the whole book for one stubborn chunk
        }

        await env.DB.prepare(
          `UPDATE chunks SET status = 'partial', translated_text = ?, model_used = ?, error = ?, attempts = ?, updated_at = ? WHERE id = ?`
        )
          .bind(
            result.translated,
            result.model,
            `partial: ${result.gateReason ?? "truncated — continuation pending"}`.slice(0, 500),
            attempts,
            Date.now(),
            chunkId,
          )
          .run();
        // Not a failure — next tick resumes. No pause, no Telegram error.
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const attempts = currentAttempts + 1;

        if (attempts >= MAX_RETRIES) {
          await env.DB.prepare(
            `UPDATE chunks SET status = 'failed', error = ?, attempts = ?, updated_at = ? WHERE id = ?`
          )
            .bind(errMsg.slice(0, 1000), attempts, Date.now(), chunkId)
            .run();
          failedDelta++;

          if (telegramToken && telegramChatId && notifyOnError) {
            await sendTelegram(
              telegramToken,
              telegramChatId,
              `❌ <b>Chunk ${seq + 1} failed</b>\n<code>${errMsg.slice(0, 150)}</code>`,
            ).catch(() => undefined);
          }
          // One failed chunk no longer pauses the whole book; the failure is
          // visible and retryable instead.
        } else {
          await env.DB.prepare(
            `UPDATE chunks SET status = 'pending', attempts = ?, error = ?, updated_at = ? WHERE id = ?`
          )
            .bind(attempts, errMsg.slice(0, 500), Date.now(), chunkId)
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

    // Pause on quota exhaustion was handled inline (quotaExhausted). A lone
    // transient failure no longer pauses the job — it stays visible/retryable.

    // Telegram progress milestone — ORIGINAL sections, not upload units.
    if (telegramToken && telegramChatId && notifyOnProgress && counts && !quotaExhausted) {
      const sectionsDone = await countOriginalSections(env, jobId, "completed");
      const sectionsTotal = (job.original_count as number) ?? (counts.total as number) ?? 0;
      const pct = sectionsTotal > 0 ? Math.round((sectionsDone / sectionsTotal) * 100) : 0;
      const milestone = Math.floor(pct / 25) * 25;
      if (milestone >= lastMilestone + 25 && milestone < 100 && sectionsDone > 0) {
        await env.DB.prepare(`UPDATE jobs SET last_milestone = ? WHERE id = ?`)
          .bind(milestone, jobId)
          .run();
        await sendTelegram(
          telegramToken,
          telegramChatId,
          `📖 <b>Translation ${milestone}%</b>\n${sectionsDone}/${sectionsTotal} sections done`,
        ).catch(() => undefined);
      }
    }
  }
}

/** Count DISTINCT original sections in a given unit status (legacy-safe). */
async function countOriginalSections(
  env: Env,
  jobId: string,
  unitStatus: string,
): Promise<number> {
  const mapped = await env.DB.prepare(
    `SELECT COUNT(DISTINCT original_chunk_id) as n FROM chunks
     WHERE job_id = ? AND status = ? AND original_chunk_id IS NOT NULL`
  ).bind(jobId, unitStatus).first();
  const unmapped = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM chunks
     WHERE job_id = ? AND status = ? AND original_chunk_id IS NULL`
  ).bind(jobId, unitStatus).first();
  return ((mapped?.n as number) ?? 0) + ((unmapped?.n as number) ?? 0);
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
