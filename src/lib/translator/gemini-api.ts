/**
 * Gemini API client for novel translation.
 * Handles the modern native Gemini endpoint with x-goog-api-key header auth.
 * Parses the streaming response (newline-delimited JSON objects, not SSE).
 */

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent";

const SYSTEM_INSTRUCTION = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

IMPORTANT: Output ONLY the translated English text. Do not include any explanations, notes, commentary, or metadata. Do not wrap your output in quotes or markdown. Just return the raw translated English prose.`;

export interface TranslationChunk {
  index: number;
  text: string;
}

/**
 * Parse Gemini streaming response body.
 * The response is a stream of JSON objects separated by newlines,
 * NOT SSE data. Each line may be a JSON object like:
 * {"candidates":[{"content":{"parts":[{"text":"..."}]}}]}
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

          // Split on newlines - each line should be a JSON object
          const lines = buffer.split("\n");
          // Keep the last incomplete line in the buffer
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith("{")) continue;

            try {
              const obj = JSON.parse(trimmed);
              const candidates = obj.candidates;
              if (candidates && candidates.length > 0) {
                const content = candidates[0].content;
                if (content && content.parts && content.parts.length > 0) {
                  for (const part of content.parts) {
                    if (part.text) {
                      fullText += part.text;
                      onToken(part.text);
                    }
                  }
                }
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }

        // Process remaining buffer
        if (buffer.trim().startsWith("{")) {
          try {
            const obj = JSON.parse(buffer.trim());
            const candidates = obj.candidates;
            if (candidates && candidates.length > 0) {
              const content = candidates[0].content;
              if (content && content.parts && content.parts.length > 0) {
                for (const part of content.parts) {
                  if (part.text) {
                    fullText += part.text;
                    onToken(part.text);
                  }
                }
              }
            }
          } catch {
            // Skip
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
  const url = new URL(GEMINI_ENDPOINT);
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
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
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
  const candidates = data.candidates;
  if (candidates && candidates.length > 0) {
    const content = candidates[0].content;
    if (content && content.parts && content.parts.length > 0) {
      return content.parts.map((p: { text?: string }) => p.text || "").join("");
    }
  }

  throw new Error("No translation content in response");
}
