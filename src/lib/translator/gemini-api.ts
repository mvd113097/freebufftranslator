/**
 * OpenRouter API client for novel translation.
 *
 * Uses the standard OpenAI-compatible chat completions endpoint.
 * Works with any model available on OpenRouter (free or paid).
 * All requests are made directly from the browser — no backend involved.
 */

const OPENROUTER_BASE = "https://openrouter.ai/api/v1/chat/completions";

const SYSTEM_PROMPT = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

CRITICAL FORMATTING RULES:
- Preserve ALL paragraph breaks from the original text. Separate every paragraph with a blank line (double newline). The output must have clear visual spacing between paragraphs, matching the input's paragraph structure.
- If the input has a line break between paragraphs, your output MUST have a blank line between those same paragraphs.
- Preserve dialogue formatting and paragraph indentation style.
- Do NOT merge paragraphs together. Each paragraph in the input becomes its own paragraph in the output.

IMPORTANT: Output ONLY the translated English text. Do not include any explanations, notes, commentary, or metadata. Do not wrap your output in quotes or markdown. Just return the raw translated English prose with proper paragraph spacing.`;

/** Default model — free or very cheap on OpenRouter */
export const DEFAULT_MODEL = "openrouter/free";

/**
 * Fallback chain for "Auto Free": ordered by quality/context for novel
 * translation. When a model is rate-limited/overloaded, the next one is tried.
 */
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

/** "openrouter/free" is a UI-only selector — never a real API model id. */
export function isAutoFreeSelector(model: string): boolean {
  return (
    model === "openrouter/free" ||
    model === "openrouter/auto" ||
    model === "auto"
  );
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
    max_tokens: 65536,
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

  if (!isAutoFreeSelector(selected)) {
    onModelUsed?.(selected);
    return translateWithModel(text, apiKey, selected, onToken, abortSignal);
  }

  // Auto Free: walk the fallback chain. RATE_LIMITED and SERVER_ERROR move to
  // the next model; KEY_REJECTED and aborts bubble up immediately.
  let lastError: Error | null = null;
  for (const candidate of FALLBACK_MODELS) {
    if (abortSignal?.aborted) throw new Error("Translation aborted");
    try {
      onModelUsed?.(candidate);
      return await translateWithModel(
        text,
        apiKey,
        candidate,
        onToken,
        abortSignal,
      );
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

/** Simple non-streaming translation for testing keys */
export async function translateChunkSimple(
  text: string,
  apiKey: string,
  model?: string,
): Promise<string> {
  const selected = model || DEFAULT_MODEL;
  if (isAutoFreeSelector(selected)) {
    // Try the first two models in the chain for a quick key validity check
    for (const candidate of FALLBACK_MODELS.slice(0, 2)) {
      try {
        return await translateNonStreaming(text, apiKey, candidate);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "RATE_LIMITED" || msg.startsWith("KEY_REJECTED")) throw err;
      }
    }
    throw new Error("All models rate-limited right now");
  }
  return translateNonStreaming(text, apiKey, selected);
}
