/**
 * Dual-provider API client for novel translation.
 *
 * Supports two backends:
 *  1. OpenRouter  — OpenAI-compatible chat completions (Bearer sk-or-v1-...).
 *  2. Google Gemini — native Gemini stream endpoint with x-goog-api-key header
 *     (AQ. keys forbid query-param auth; DO NOT append ?key= to the URL).
 *
 * All requests are made directly from the browser — no backend involved.
 */

// ─── OpenRouter ───────────────────────────────────────────────────────

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";

// ─── Gemini (native Google endpoint) ──────────────────────────────────

const GEMINI_BASE = "https://googleapis.com/v1beta/models";

import { LIVE_MODEL_SLUGS, GEMINI_MODEL_SLUGS } from "./models";

const SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

CRITICAL FORMATTING RULES:
- Preserve ALL paragraph breaks from the original text. Separate every paragraph with a blank line (double newline). The output must have clear visual spacing between paragraphs, matching the input's paragraph structure.
- If the input has a line break between paragraphs, your output MUST have a blank line between those same paragraphs.
- Preserve dialogue formatting and paragraph indentation style.
- Do NOT merge paragraphs together. Each paragraph in the input becomes its own paragraph in the output.

IMPORTANT: Output ONLY the translated English text. Do not include any explanations, notes, commentary, or metadata. Do not wrap your output in quotes or markdown. Just return the raw translated English prose with proper paragraph spacing.`;

/** Default model — free or very cheap on OpenRouter */
export const DEFAULT_MODEL = "openrouter/free";

/** When provided a Gemini key, default to the first Gemini model. */
export function defaultModelForProvider(provider: "openrouter" | "gemini"): string {
  return provider === "gemini" ? "gemini/free" : "openrouter/free";
}
/**
 * Fallback chain for OpenRouter "Auto": ordered for reliability first (fast,
 * non-reasoning models before slow reasoning ones), then quality. When a model
 * is rate-limited/overloaded, the next one is tried.
 *
 * IMPORTANT: all slugs are the real OpenRouter :free variants (verified live
 * against /api/v1/models on 2026-09). Paid slugs (no :free suffix) are rejected
 * with HTTP 402 on free-tier accounts.
 */
const OPENROUTER_FALLBACK_MODELS = LIVE_MODEL_SLUGS;

/**
 * Fallback chain for Gemini "Auto": ordered for speed + free-tier reliability.
 * When a model returns 429 / overloaded, the next one is tried.
 */
const GEMINI_FALLBACK_MODELS = GEMINI_MODEL_SLUGS;

/**
 * Cap on requested max_tokens. Free-tier OpenRouter accounts can only
 * "afford" a small reservation on paid models (HTTP 402 otherwise); free
 * models accept this fine.
 */
const MAX_TOKENS_LIMIT = 16000;

/** Sentinel values that mean "Auto for the current provider". */
export function isAutoSelector(model: string): boolean {
  return (
    model === "openrouter/free" ||
    model === "openrouter/auto" ||
    model === "auto" ||
    model === "gemini/free"
  );
}

/** True when `model` is an OpenRouter Auto sentinel. */
export function isOpenRouterAuto(model: string): boolean {
  return model === "openrouter/free" || model === "openrouter/auto" || model === "auto";
}

/** True when `model` is a Gemini Auto sentinel. */
export function isGeminiAuto(model: string): boolean {
  return model === "gemini/free";
}

/** Post-process translated text to guarantee blank-line paragraph spacing. */
function normalizeParagraphs(text: string): string {
  let result = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Convert single newlines between text lines into paragraph breaks
  result = result.replace(/([^\n])\n([^\n])/g, "$1\n\n$2");
  // Collapse 3+ newlines into exactly one blank line
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result.trim();
  return result;
}

/**
 * Build OpenAI-compatible chat completions payload.
 */
function buildPayload(text: string, model: string) {
  return {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    temperature: 0.7,
    top_p: 0.95,
    max_tokens: MAX_TOKENS_LIMIT,
    stream: true,
  };
}

/** Extract a short human-readable error from an OpenRouter error body. */
function extractApiErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body);
    const msg =
      (parsed?.error?.message as string | undefined) ??
      (parsed?.message as string | undefined);
    if (typeof msg === "string" && msg.trim().length > 0)
      return msg.trim().slice(0, 200);
  } catch {
    /* not JSON */
  }
  return body.trim().slice(0, 200);
}

/**
 * Parse SSE streaming response from OpenRouter (OpenAI-compatible format).
 * Lines are: "data: {json}" or "data: [DONE]"
 */
function parseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  return new Promise<string>((resolve, reject) => {
    const run = async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (abortSignal?.aborted) {
            reject(new Error("Translation aborted"));
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (let line of lines) {
            line = line.trim();
            if (!line || line === "data: [DONE]") continue;
            if (line.startsWith("data: ")) line = line.slice(6).trim();
            if (!line.startsWith("{")) continue;

            try {
              const parsed = JSON.parse(line);
              // OpenRouter can report errors mid-stream
              if (parsed.error) {
                const errMsg =
                  typeof parsed.error === "string"
                    ? parsed.error
                    : parsed.error.message || JSON.stringify(parsed.error);
                reject(new Error(`MODEL_ERROR: ${errMsg.slice(0, 200)}`));
                return;
              }
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                fullText += delta.content;
                onToken(delta.content);
              }
            } catch {
              /* skip malformed lines */
            }
          }
        }

        // Handle remaining buffer
        if (buffer.trim()) {
          let r = buffer.trim();
          if (r.startsWith("data: ")) r = r.slice(6).trim();
          if (r.startsWith("{")) {
            try {
              const parsed = JSON.parse(r);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) {
                fullText += delta.content;
                onToken(delta.content);
              }
            } catch {
              /* skip */
            }
          }
        }

        resolve(fullText);
      } catch (err) {
        reject(err);
      }
    };
    run();
  });
}

/**
 * Translate one chunk with ONE specific model (streaming, then non-streaming
 * fallback). Throws on failure — the caller decides whether to try the next
 * model in the chain.
 */
async function translateWithModel(
  text: string,
  apiKey: string,
  model: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const payload = buildPayload(text, model);

  // Try streaming first
  try {
    const response = await fetch(OPENROUTER_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (response.status === 429) throw new Error("RATE_LIMITED");

    // 402 = insufficient credits (paid model on a free-tier account).
    // Treat like a model-level failure so Auto Free moves to the next model.
    if (response.status === 402) throw new Error("INSUFFICIENT_CREDITS");

    if (response.status === 401 || response.status === 403) {
      const body = await response.text().catch(() => "");
      const realMsg = extractApiErrorMessage(body);
      const low = body.toLowerCase();
      const looksLikeKeyProblem =
        response.status === 401 ||
        /api[ _-]?key|invalid|expired|unauthorized|credential|permission|forbidden|denied|authentication|access denied|no access/.test(
          low,
        );
      if (looksLikeKeyProblem) {
        throw new Error(
          `KEY_REJECTED (key …${apiKey.slice(-4)}): ${realMsg || "Invalid or expired API key"}`,
        );
      }
      throw new Error(`AUTH_ERROR_${response.status}: ${realMsg || "Request rejected"}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      if (body.includes("overloaded") || body.includes("503") || body.includes("502")) {
        throw new Error(`SERVER_ERROR_${response.status}: Model overloaded`);
      }
      throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
    }

    if (!response.body) throw new Error("Response body is null");

    const reader = response.body.getReader();
    const result = await parseStream(reader, onToken, abortSignal);
    if (!result.trim()) {
      throw new Error("Model returned empty translation");
    }
    return normalizeParagraphs(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "RATE_LIMITED" || msg === "Translation aborted" || msg.startsWith("KEY_REJECTED")) throw err;

    // Streaming failed — try non-streaming fallback with the same model
    console.log(
      "[Translator] Streaming failed:",
      msg,
      "— falling back to non-streaming",
    );
    const result = await translateNonStreaming(text, apiKey, model);
    // Simulate token-by-token delivery for progress tracking
    const words = result.split(/(\s+)/);
    for (const word of words) {
      if (abortSignal?.aborted) throw new Error("Translation aborted");
      onToken(word);
    }
    return result;
  }
}

/**
 * Non-streaming fallback — uses the same endpoint with stream: false.
 */
async function translateNonStreaming(
  text: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const payload = buildPayload(text, model);
  payload.stream = false;

  const response = await fetch(OPENROUTER_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 429) throw new Error("RATE_LIMITED");
  if (response.status === 402) throw new Error("INSUFFICIENT_CREDITS");

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    const realMsg = extractApiErrorMessage(body);
    throw new Error(
      `KEY_REJECTED (key …${apiKey.slice(-4)}): ${realMsg || "Invalid or expired API key"}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  if (data.error) {
    const errMsg =
      typeof data.error === "string"
        ? data.error
        : data.error.message || JSON.stringify(data.error);
    throw new Error(`MODEL_ERROR: ${errMsg.slice(0, 200)}`);
  }
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content) {
    throw new Error("No translation content in response");
  }
  return normalizeParagraphs(content);
}

/**
 * Translate a single chunk. When the model is the "Auto Free" selector (or a
 * model fails and auto-free is active), walks the free-model fallback chain
 * until one succeeds. Reports the actual model used via onModelUsed.
 */
export async function translateChunk(
  text: string,
  apiKey: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
  model?: string,
  onModelUsed?: (model: string) => void,
): Promise<string> {
  const selected = model || DEFAULT_MODEL;

  // Determine the provider so Auto stays within its own backend.
  const provider =
    selected.startsWith("gemini") || selected === "gemini/free"
      ? "gemini"
      : "openrouter";

  if (!isAutoSelector(selected)) {
    onModelUsed?.(selected);
    return provider === "gemini"
      ? translateGeminiChunk(text, apiKey, selected, onToken, abortSignal)
      : translateOpenRouterChunk(text, apiKey, selected, onToken, abortSignal);
  }

  // Auto: walk the per-provider fallback chain. RATE_LIMITED / 429 move to the
  // next model; KEY_REJECTED and aborts bubble up immediately.
  const chain = provider === "gemini" ? GEMINI_FALLBACK_MODELS : OPENROUTER_FALLBACK_MODELS;
  let lastError: Error | null = null;
  for (const candidate of chain) {
    if (abortSignal?.aborted) throw new Error("Translation aborted");      try {
      onModelUsed?.(candidate);
      return provider === "gemini"
        ? await translateGeminiChunk(text, apiKey, candidate, onToken, abortSignal)
        : await translateOpenRouterChunk(text, apiKey, candidate, onToken, abortSignal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg === "Translation aborted" ||
        msg.startsWith("KEY_REJECTED")
      ) {
        throw err;
      }
      console.log(
        `[Translator] Auto Free: ${candidate} failed (${msg.slice(0, 80)}) — trying next model`,
      );
      lastError = err instanceof Error ? err : new Error(msg);
    }
  }
  throw lastError ?? new Error("All free models failed");
}

/**
 * Gemini translation — routes through the Cloudflare Worker when one is
 * configured (avoids browser CORS on googleapis.com), otherwise hits the
 * native Google endpoint directly.
 *
 * Response format from the worker: JSON { translated, model } (non-streaming).
 * Response format from direct googleapis.com: JSON-per-line stream (NOT SSE).
 */
async function translateGeminiChunk(
  text: string,
  apiKey: string,
  model: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const workerUrl = getGeminiWorkerUrl();

  if (workerUrl) {
    // Route through the worker — browser never touches googleapis.com directly,
    // so there's no CORS issue. The worker calls Gemini server-side.
    return translateGeminiViaWorker(text, apiKey, model, onToken, abortSignal);
  }

  // No worker configured — hit the native endpoint directly (may fail with CORS
  // in some browsers, which is why the worker path is preferred).
  return translateGeminiDirect(text, apiKey, model, onToken, abortSignal);
}

/**
 * Parse Gemini's JSON-per-line stream (NOT SSE).
 *
 * Each line is a standalone JSON object. We extract
 *   candidates[0].content.parts[*].text
 * and concatenate.
 */
function parseGeminiStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  return new Promise<string>((resolve, reject) => {
    const run = async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (abortSignal?.aborted) {
            reject(new Error("Translation aborted"));
            return;
          }
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (let line of lines) {
            line = line.trim();
            if (!line) continue;
            // Gemini streams raw JSON objects line-by-line (not "data: ...")
            if (!line.startsWith("{")) continue;

            try {
              const parsed = JSON.parse(line);

              // Top-level error
              if (parsed.error) {
                const errMsg =
                  typeof parsed.error === "string"
                    ? parsed.error
                    : parsed.error.message || JSON.stringify(parsed.error);
                reject(new Error(`MODEL_ERROR: ${errMsg.slice(0, 200)}`));
                return;
              }

              const content =
                parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (typeof content === "string" && content) {
                fullText += content;
                onToken(content);
              }
            } catch {
              /* skip malformed lines */
            }
          }
        }

        // Handle any remaining line in the buffer
        if (buffer.trim()) {
          const line = buffer.trim();
          if (line.startsWith("{")) {
            try {
              const parsed = JSON.parse(line);
              const content =
                parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (typeof content === "string" && content) {
                fullText += content;
                onToken(content);
              }
            } catch {
              /* skip */
            }
          }
        }

        resolve(fullText);
      } catch (err) {
        reject(err);
      }
    };
    run();
  });
}

/**
 * Gemini non-streaming fallback. Routes through the worker when configured,
 * otherwise hits the native endpoint directly.
 */
async function translateGeminiNonStreaming(
  text: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const workerUrl = getGeminiWorkerUrl();
  if (workerUrl) {
    return translateGeminiViaWorker(text, apiKey, model, undefined as any, undefined).then((t) => t);
  }
  return translateGeminiDirectNonStreaming(text, apiKey, model);
}

// ─── Worker-mediated Gemini path ──────────────────────────────────────────────

const WORKER_GEMINI_URL_KEY = "novel-translator-gemini-worker-url";

function getGeminiWorkerUrl(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    return localStorage.getItem(WORKER_GEMINI_URL_KEY) ?? "";
  } catch {
    return "";
  }
}

function setGeminiWorkerUrl(url: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(WORKER_GEMINI_URL_KEY, url.trim().replace(/\/+$/, ""));
  } catch {
    /* ignore */
  }
}

/**
 * Call the worker's /api/translate endpoint. The worker calls Gemini server-side
 * and returns { translated, model }. We simulate token-by-token delivery by
 * splitting the result on whitespace so the progress UI still updates word-by-word.
 */
async function translateGeminiViaWorker(
  text: string,
  apiKey: string,
  model: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const workerUrl = getGeminiWorkerUrl();
  if (!workerUrl) throw new Error("Gemini worker URL not configured");

  const secret = getGeminiWorkerSecret();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (secret) headers["x-job-secret"] = secret;

  const payload = {
    text,
    model,
    keys: [apiKey],
  };

  const response = await fetch(`${workerUrl}/api/translate`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: abortSignal,
  });

  if (response.status === 429) throw new Error("RATE_LIMITED");

  if (response.status === 401 || response.status === 403) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `KEY_REJECTED (key …${apiKey.slice(-4)}): ${body.slice(0, 200) || "Invalid or expired API key"}`,
    );
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let msg = body;
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error) msg = parsed.error;
    } catch {
      /* ignore */
    }
    if (msg.includes("overloaded") || msg.includes("503") || msg.includes("502")) {
      throw new Error(`SERVER_ERROR: Model overloaded`);
    }
    throw new Error(`API error ${response.status}: ${msg.slice(0, 200)}`);
  }

  const data = await response.json() as { translated?: string; model?: string; error?: string };
  if (data.error) {
    throw new Error(`MODEL_ERROR: ${data.error.slice(0, 200)}`);
  }
  const translated = data.translated;
  if (typeof translated !== "string" || !translated) {
    throw new Error("Model returned empty translation");
  }

  // Simulate token-by-token delivery for progress tracking
  if (onToken) {
    const words = translated.split(/\s+/);
    for (const word of words) {
      if (abortSignal?.aborted) throw new Error("Translation aborted");
      onToken(word + " ");
    }
  }

  return normalizeParagraphs(translated);
}

/** Set the Gemini worker URL (called from the dashboard when cloud mode is on). */
export function setGeminiWorkerUrl(url: string): void {
  setGeminiWorkerUrl(url);
}

/** Set the Gemini worker secret. */
export function setGeminiWorkerSecret(secret: string): void {
  try {
    localStorage.setItem("novel-translator-gemini-worker-secret", secret.trim());
  } catch {
    /* ignore */
  }
}

function getGeminiWorkerSecret(): string {
  try {
    return localStorage.getItem("novel-translator-gemini-worker-secret") ?? "";
  } catch {
    return "";
  }
}

export function clearGeminiWorkerConfig(): void {
  try {
    localStorage.removeItem(WORKER_GEMINI_URL_KEY);
    localStorage.removeItem("novel-translator-gemini-worker-secret");
  } catch {
    /* ignore */
  }
}

/**
 * OpenRouter wrapper — keeps the original translateWithModel name so existing
 * call sites that think in terms of "one model at a time" still read clearly.
 */
async function translateOpenRouterChunk(
  text: string,
  apiKey: string,
  model: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  return translateWithModel(text, apiKey, model, onToken, abortSignal);
}

/** Transient upstream failures that should NOT fail a key-validity check. */
function isTransientModelError(msg: string): boolean {
  return (
    msg.includes("MODEL_ERROR") ||
    msg.includes("SERVER_ERROR") ||
    /overload|temporar|503|502|timeout/i.test(msg)
  );
}

/** Simple non-streaming translation for testing keys (both providers). */
export async function translateChunkSimple(
  text: string,
  apiKey: string,
  model?: string,
): Promise<string> {
  const selected = model || DEFAULT_MODEL;

  // Auto: pick the first model of whichever provider the sentinel belongs to.
  if (isAutoSelector(selected)) {
    const provider =
      selected.startsWith("gemini") || selected === "gemini/free"
        ? "gemini"
        : "openrouter";
    const chain =
      provider === "gemini" ? GEMINI_FALLBACK_MODELS.slice(0, 2) : OPENROUTER_FALLBACK_MODELS.slice(0, 2);
    for (const candidate of chain) {
      try {
        return await translateNonStreaming(text, apiKey, candidate);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "RATE_LIMITED" || msg.startsWith("KEY_REJECTED")) throw err;
      }
    }
    throw new Error("All models rate-limited right now");
  }

  // Specific model — route to the right backend.
  const provider =
    selected.startsWith("gemini") || selected === "gemini/free"
      ? "gemini"
      : "openrouter";

  if (provider === "gemini") {
    // Gemini: non-streaming is the simplest key check.
    let lastErr: Error = new Error("Unknown error");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await translateGeminiNonStreaming(text, apiKey, selected);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lastErr = err instanceof Error ? err : new Error(msg);
        if (msg.startsWith("KEY_REJECTED") || msg === "RATE_LIMITED") throw err;
        if (!isTransientModelError(msg)) throw err;
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  // OpenRouter
  let lastErr: Error = new Error("Unknown error");
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await translateNonStreaming(text, apiKey, selected);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastErr = err instanceof Error ? err : new Error(msg);
      if (msg.startsWith("KEY_REJECTED") || msg === "RATE_LIMITED") throw err;
      if (!isTransientModelError(msg)) throw err;
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
  }
  throw lastErr;
}
