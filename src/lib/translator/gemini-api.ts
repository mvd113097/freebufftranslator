/**
 * OpenRouter API client for novel translation.
 *
 * Uses the standard OpenAI-compatible chat completions endpoint.
 * Works with any model available on OpenRouter (free or paid).
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

/**
 * Translate a single chunk via streaming, with non-streaming fallback.
 */
export async function translateChunk(
  text: string,
  apiKey: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
  model?: string,
): Promise<string> {
  const usedModel = model || DEFAULT_MODEL;
  const payload = buildPayload(text, usedModel);

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

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`API error ${response.status}: ${body.slice(0, 200)}`);
    }

    if (!response.body) throw new Error("Response body is null");

    const reader = response.body.getReader();
    return await parseStream(reader, onToken, abortSignal);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "RATE_LIMITED" || msg === "Translation aborted") throw err;

    // Streaming failed — try non-streaming fallback
    console.log("[Translator] Streaming failed:", msg, "— falling back to non-streaming");
    const result = await translateNonStreaming(text, apiKey, usedModel);
    // Simulate token-by-token delivery for progress tracking
    const words = result.split(/(\s+)/);
    for (const word of words) {
      if (abortSignal?.aborted) throw new Error("Translation aborted");
      onToken(word);
    }
    return result;
  }
}

/** Simple non-streaming translation for testing */
export async function translateChunkSimple(
  text: string,
  apiKey: string,
  model?: string,
): Promise<string> {
  return translateNonStreaming(text, apiKey, model || DEFAULT_MODEL);
}

/**
 * Test a single API key against the provider it actually belongs to.
 * Google keys (AIza…/AQ.…) go to the free Gemini endpoint with header auth;
 * everything else goes to OpenRouter with a live free model (never "auto_free",
 * which is a UI-only selector, not a real model id).
 */
export async function testApiKey(key: string): Promise<string> {
  const trimmed = key.trim();
  if (trimmed.startsWith("AIza") || trimmed.startsWith("AQ.")) {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Google keys must NEVER go in the query string — header auth only.
          "x-goog-api-key": trimmed,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: "Reply with the single word: OK" }] }],
          generationConfig: { maxOutputTokens: 512 },
        }),
      },
    );
    if (response.status === 429) throw new Error("RATE_LIMITED (key works, just out of quota right now)");
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${body.slice(0, 140)}`);
    }
    return "gemini (direct Google)";
  }

  // OpenRouter key — must use a real, currently-free model id.
  await translateNonStreaming("你好世界 Hello World", trimmed, OPENROUTER_TEST_MODEL);
  return `openrouter (${OPENROUTER_TEST_MODEL})`;
}

/** Live free OpenRouter model used for key tests. */
const OPENROUTER_TEST_MODEL = "google/gemma-4-31b-it:free";
