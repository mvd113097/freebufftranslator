/**
 * Gemini API client for novel translation.
 * Handles the modern native Gemini endpoint with x-goog-api-key header auth.
 * Parses the streaming response (SSE format with data: prefix OR newline-delimited JSON).
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
  const candidates = record.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates || candidates.length === 0) return "";

  const content = candidates[0].content as Record<string, unknown> | undefined;
  if (!content) return "";

  const parts = content.parts as Array<Record<string, unknown>> | undefined;
  if (!parts || parts.length === 0) return "";

  return parts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

/**
 * Parse Gemini streaming response body.
 * Supports two formats:
 *   1. SSE: each line is "data: {json}\n\n"
 *   2. Raw streaming: each line is a JSON object or JSON array element
 *   3. Full JSON array: entire body is [{...}, {...}, ...]
 */
function parseGeminiStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let isSSE = false;
  let isJsonArray = false;
  let arrayBuffer = "";
  let firstChunk = true;

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

          const chunk = decoder.decode(value, { stream: true });

          // Detect format on first chunk
          if (firstChunk) {
            firstChunk = false;
            const trimmed = chunk.trimStart();
            if (trimmed.startsWith("[")) {
              isJsonArray = true;
              arrayBuffer = trimmed;
              // Try to parse the full array
              try {
                const arr = JSON.parse(arrayBuffer);
                if (Array.isArray(arr)) {
                  for (const obj of arr) {
                    const text = extractTextFromResponse(obj);
                    if (text) {
                      fullText += text;
                      onToken(text);
                    }
                  }
                  resolve(fullText);
                  return;
                }
              } catch {
                // Not complete yet, will accumulate
              }
            } else if (trimmed.startsWith("data: ")) {
              isSSE = true;
            } else if (trimmed.startsWith("{")) {
              isSSE = false;
            }
          }

          if (isJsonArray) {
            // Accumulate and try to parse the JSON array
            arrayBuffer += chunk;
            try {
              const arr = JSON.parse(arrayBuffer);
              if (Array.isArray(arr)) {
                for (const obj of arr) {
                  const text = extractTextFromResponse(obj);
                  if (text) {
                    fullText += text;
                    onToken(text);
                  }
                }
                resolve(fullText);
                return;
              }
            } catch {
              // Not complete yet, keep accumulating
            }
            continue;
          }

          buffer += chunk;

          // Split on double newline (SSE) or single newline
          const separator = isSSE ? "\n\n" : "\n";
          const parts = buffer.split(separator);
          // Keep the last incomplete part in the buffer
          buffer = parts.pop() || "";

          for (const part of parts) {
            let jsonStr = part.trim();

            // Strip SSE "data: " prefix if present
            if (jsonStr.startsWith("data: ")) {
              jsonStr = jsonStr.slice(6);
            }

            // Skip empty lines or [DONE] markers
            if (!jsonStr || jsonStr === "[DONE]" || !jsonStr.startsWith("{")) {
              continue;
            }

            try {
              const obj = JSON.parse(jsonStr);
              const text = extractTextFromResponse(obj);
              if (text) {
                fullText += text;
                onToken(text);
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim()) {
          let jsonStr = buffer.trim();
          if (jsonStr.startsWith("data: ")) {
            jsonStr = jsonStr.slice(6);
          }
          if (jsonStr.startsWith("{")) {
            try {
              const obj = JSON.parse(jsonStr);
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
 * Translate a single chunk of Chinese text to English.
 * Uses streaming for real-time token output.
 */
export async function translateChunk(
  text: string,
  apiKey: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent`,
  );
  url.searchParams.set("alt", "sse");

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

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(payload),
    signal: abortSignal,
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

  if (!response.body) {
    throw new Error("Response body is null");
  }

  const reader = response.body.getReader();
  return parseGeminiStream(reader, onToken, abortSignal);
}

/**
 * Non-streaming translation for simpler use (testing, etc.)
 */
export async function translateChunkSimple(
  text: string,
  apiKey: string,
): Promise<string> {
  const url = new URL(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
  );

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

  const response = await fetch(url.toString(), {
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
  return extractTextFromResponse(data);
}
