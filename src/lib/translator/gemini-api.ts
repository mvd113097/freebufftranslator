/**
 * Gemini API client for novel translation.
 * Handles the modern native Gemini endpoint with x-goog-api-key header auth.
 * Supports both SSE streaming and non-streaming fallback.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

const SYSTEM_INSTRUCTION = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

IMPORTANT: Output ONLY the translated English text. Do not include any explanations, notes, commentary, or metadata. Do not wrap your output in quotes or markdown. Just return the raw translated English prose.`;

/**
 * Extract text from a Gemini response JSON object.
 */
function extractTextFromResponse(obj: unknown): string {
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
 * Parse Gemini streaming SSE response body.
 * SSE format: each line is "data: {json}\n\n"
 * Also handles raw JSON objects separated by newlines.
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
    const processStream = async () => {
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

          // Split on double newline (SSE frames) or single newline
          const frames = buffer.split(/\n\n|\n/);
          buffer = frames.pop() || "";

          for (let frame of frames) {
            frame = frame.trim();
            if (!frame || frame === "[DONE]") continue;

            // Strip SSE "data: " prefix
            if (frame.startsWith("data: ")) {
              frame = frame.slice(6).trim();
            }

            // Skip non-JSON lines
            if (!frame.startsWith("{")) continue;

            try {
              const obj = JSON.parse(frame);
              const text = extractTextFromResponse(obj);
              if (text) {
                fullText += text;
                onToken(text);
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          let remaining = buffer.trim();
          if (remaining.startsWith("data: ")) {
            remaining = remaining.slice(6).trim();
          }
          if (remaining.startsWith("{")) {
            try {
              const obj = JSON.parse(remaining);
              const text = extractTextFromResponse(obj);
              if (text) {
                fullText += text;
                onToken(text);
              }
            } catch {
              // Skip
            }
          }
        }

        resolve(fullText);
      } catch (err) {
        reject(err);
      }
    };

    processStream();
  });
}

/**
 * Non-streaming translation — used as fallback if streaming fails.
 */
async function translateNonStreaming(
  text: string,
  apiKey: string,
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const payload = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 8192,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `API error ${response.status}: ${errorBody.slice(0, 200)}`,
    );
  }

  const data = await response.json();
  const result = extractTextFromResponse(data);
  if (!result) {
    throw new Error("No translation content in response");
  }
  return result;
}

/**
 * Translate a single chunk of Chinese text to English.
 * Tries streaming first, falls back to non-streaming on certain errors.
 */
export async function translateChunk(
  text: string,
  apiKey: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const streamingUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

  const payload = {
    system_instruction: {
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text }],
      },
    ],
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 8192,
    },
  };

  const headers = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
  };

  try {
    const response = await fetch(streamingUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: abortSignal,
    });

    if (response.status === 429) {
      throw new Error("RATE_LIMITED");
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      const errMsg = `API error ${response.status}: ${errorBody.slice(0, 200)}`;
      console.warn("[Translator] Streaming failed:", errMsg);
      // Fall back to non-streaming for non-rate-limit errors
      if (response.status !== 429) {
        console.log("[Translator] Falling back to non-streaming mode...");
        const result = await translateNonStreaming(text, apiKey);
        // Simulate token-by-token output for non-streaming
        const words = result.split(/(\s+)/);
        for (const word of words) {
          if (abortSignal?.aborted) throw new Error("Translation aborted");
          onToken(word);
        }
        return result;
      }
      throw new Error(errMsg);
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    return await parseGeminiStream(reader, onToken, abortSignal);
  } catch (err) {
    // If streaming fails with a network error, try non-streaming
    const msg = err instanceof Error ? err.message : String(err);
    if (
      !msg.includes("RATE_LIMITED") &&
      !msg.includes("Translation aborted") &&
      !msg.includes("No translation")
    ) {
      console.warn(
        "[Translator] Streaming error, trying non-streaming:",
        msg,
      );
      try {
        const fallbackResult = await translateNonStreaming(text, apiKey);
        const words = fallbackResult.split(/(\s+)/);
        for (const word of words) {
          if (abortSignal?.aborted) throw new Error("Translation aborted");
          onToken(word);
        }
        return fallbackResult;
      } catch (fallbackErr) {
        // If both fail, throw the original error
        throw err;
      }
    }
    throw err;
  }
}

/**
 * Non-streaming translation for simpler use (testing, etc.)
 */
export async function translateChunkSimple(
  text: string,
  apiKey: string,
): Promise<string> {
  return translateNonStreaming(text, apiKey);
}
