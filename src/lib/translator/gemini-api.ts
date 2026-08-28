/**
 * Gemini API client for novel translation.
 *
 * AQ keys work from the browser using generativelanguage.googleapis.com.
 * Tries x-goog-api-key header first, then falls back to ?key= query param.
 */

const GEMINI_MODEL = "gemini-3.6-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

const SYSTEM_INSTRUCTION = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

IMPORTANT: Output ONLY the translated English text. Do not include any explanations, notes, commentary, or metadata. Do not wrap your output in quotes or markdown. Just return the raw translated English prose.`;

/**
 * Extract text from a Gemini response JSON object.
 */
function extractText(obj: unknown): string {
  if (!obj || typeof obj !== "object") return "";
  const record = obj as Record<string, unknown>;
  const candidates = record.candidates as
    | Array<Record<string, unknown>>
    | undefined;
  if (!candidates || candidates.length === 0) return "";

  const content = candidates[0].content as
    | Record<string, unknown>
    | undefined;
  if (!content) return "";

  const parts = content.parts as Array<Record<string, unknown>> | undefined;
  if (!parts || parts.length === 0) return "";

  return parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/**
 * Parse streaming SSE response — handles both "data: {json}" and raw JSON.
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
          const frames = buffer.split(/\n\n|\n/);
          buffer = frames.pop() || "";

          for (let frame of frames) {
            frame = frame.trim();
            if (!frame || frame === "[DONE]") continue;
            if (frame.startsWith("data: ")) frame = frame.slice(6).trim();
            if (!frame.startsWith("{")) continue;
            try {
              const text = extractText(JSON.parse(frame));
              if (text) {
                fullText += text;
                onToken(text);
              }
            } catch {
              /* skip */
            }
          }
        }
        // Remaining buffer
        if (buffer.trim()) {
          let r = buffer.trim();
          if (r.startsWith("data: ")) r = r.slice(6).trim();
          if (r.startsWith("{")) {
            try {
              const text = extractText(JSON.parse(r));
              if (text) {
                fullText += text;
                onToken(text);
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

function buildPayload(text: string) {
  return {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text }] }],
    generationConfig: { temperature: 0.7, topP: 0.95, maxOutputTokens: 65536 },
  };
}

/**
 * Build request configs — tries header auth first, then query param auth.
 */
function getAuthConfigs(apiKey: string, action: "stream" | "nonstream") {
  const method = action === "stream" ? "streamGenerateContent" : "generateContent";
  const headerAuth: Record<string, string> = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };
  const paramAuth: Record<string, string> = {
    "Content-Type": "application/json",
  };
  return [
    {
      // Method 1: x-goog-api-key header
      url: `${API_BASE}/models/${GEMINI_MODEL}:${method}`,
      headers: headerAuth,
    },
    {
      // Method 2: ?key= query param (fallback for some AQ key setups)
      url: `${API_BASE}/models/${GEMINI_MODEL}:${method}?key=${apiKey}`,
      headers: paramAuth,
    },
  ];
}

/**
 * Try non-streaming translation with both auth methods.
 */
async function tryNonStreaming(
  text: string,
  apiKey: string,
): Promise<string> {
  const configs = getAuthConfigs(apiKey, "nonstream");
  const payload = JSON.stringify(buildPayload(text));

  for (let i = 0; i < configs.length; i++) {
    const { url, headers } = configs[i];
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
      });

      if (response.status === 429) throw new Error("RATE_LIMITED");

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(`[Translator] Non-stream auth method ${i + 1} failed: ${response.status}`);
        continue;
      }

      const data = await response.json();
      const result = extractText(data);
      if (!result) throw new Error("No translation content in response");
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "RATE_LIMITED") throw err;
      console.warn(`[Translator] Non-stream auth method ${i + 1} error:`, msg);
      continue;
    }
  }

  throw new Error("All API endpoints failed. Check your API key and try again.");
}

/**
 * Translate a single chunk via streaming, with non-streaming fallback.
 */
export async function translateChunk(
  text: string,
  apiKey: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const configs = getAuthConfigs(apiKey, "stream");
  const payload = JSON.stringify(buildPayload(text));

  // Try streaming with both auth methods
  for (let i = 0; i < configs.length; i++) {
    const { url, headers } = configs[i];
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: payload,
        signal: abortSignal,
      });

      if (response.status === 429) throw new Error("RATE_LIMITED");

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        console.warn(`[Translator] Stream auth method ${i + 1} failed: ${response.status}`);
        continue;
      }

      if (!response.body) throw new Error("Response body is null");

      const reader = response.body.getReader();
      return await parseStream(reader, onToken, abortSignal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "RATE_LIMITED" || msg === "Translation aborted") throw err;
      console.warn(`[Translator] Stream auth method ${i + 1} error:`, msg);
      continue;
    }
  }

  // All streaming attempts failed — try non-streaming
  console.log("[Translator] All streaming attempts failed, trying non-streaming...");
  const result = await tryNonStreaming(text, apiKey);
  const words = result.split(/(\s+)/);
  for (const word of words) {
    if (abortSignal?.aborted) throw new Error("Translation aborted");
    onToken(word);
  }
  return result;
}

/** Simple non-streaming translation for testing */
export async function translateChunkSimple(
  text: string,
  apiKey: string,
): Promise<string> {
  return tryNonStreaming(text, apiKey);
}
