/**
 * Gemini API client for novel translation.
 *
 * Key type detection:
 *   - AQ. prefix → tries Vertex AI first, falls back to AI Studio
 *   - AIza prefix → AI Studio endpoint directly
 *
 * NOTE: Google's new AQ. auth keys have a known issue where many return
 * "ACCESS_TOKEN_TYPE_UNSUPPORTED" on both endpoints. This is a Google-side
 * bug tracked at discuss.ai.google.dev. If both endpoints fail, the user
 * should regenerate their key in Google AI Studio.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

const SYSTEM_INSTRUCTION = `You are an expert human literary translator specializing in Chinese web novels (Xianxia, Wuxia, and Sci-Fi). Translate the following Chinese prose into highly fluent, immersive English fiction. Do not use stiff or literal machine-like phrasing. Translate cultivation tiers, localized idioms, and online slang into contextually accurate Western fantasy equivalents while maintaining rigid character name consistency.

IMPORTANT: Output ONLY the translated English text. Do not include any explanations, notes, commentary, or metadata. Do not wrap your output in quotes or markdown. Just return the raw translated English prose.`;

/** Build endpoint URLs based on key type */
function getEndpoints(apiKey: string) {
  const isAQ = apiKey.startsWith("AQ.");

  // Vertex AI Express Mode endpoint
  const vertexStream = `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:streamGenerateContent?key=${apiKey}`;
  const vertexNonStream = `https://aiplatform.googleapis.com/v1/publishers/google/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // AI Studio endpoint
  const studioStream = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent`;
  const studioNonStream = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  return {
    isAQ,
    // For AQ keys: try Vertex first, then Studio
    // For AIza keys: use Studio directly
    streamUrls: isAQ ? [vertexStream, studioStream] : [studioStream],
    nonStreamUrls: isAQ ? [vertexNonStream, studioNonStream] : [studioNonStream],
    streamHeaders: isAQ ? [] : [{ "x-goog-api-key": apiKey }],
  };
}

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
    generationConfig: { temperature: 0.7, topP: 0.95, maxOutputTokens: 8192 },
  };
}

/**
 * Try non-streaming on each endpoint until one works.
 */
async function tryNonStreaming(
  text: string,
  apiKey: string,
): Promise<string> {
  const ep = getEndpoints(apiKey);

  for (let i = 0; i < ep.nonStreamUrls.length; i++) {
    const url = ep.nonStreamUrls[i];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    // AI Studio endpoint needs x-goog-api-key header
    if (i > 0 || !ep.isAQ) {
      headers["x-goog-api-key"] = apiKey;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(buildPayload(text)),
      });

      if (response.status === 429) throw new Error("RATE_LIMITED");

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const code = body.includes("ACCESS_TOKEN_TYPE_UNSUPPORTED")
          ? "AQ_KEY_BUG"
          : `${response.status}`;
        console.warn(
          `[Translator] Endpoint ${i + 1} (${ep.isAQ && i === 0 ? "Vertex" : "Studio"}) failed: ${code}`,
        );
        continue; // Try next endpoint
      }

      const data = await response.json();
      const result = extractText(data);
      if (!result) throw new Error("No translation content in response");
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "RATE_LIMITED") throw err;
      console.warn(`[Translator] Endpoint ${i + 1} error:`, msg);
      continue;
    }
  }

  // All endpoints failed
  if (ep.isAQ) {
    throw new Error(
      "AQ_KEY_BUG: Your AQ. API key was rejected by both Google endpoints. " +
        "This is a known Google bug — try regenerating your key in AI Studio, " +
        "or use an older AIza-prefixed key if available.",
    );
  }
  throw new Error("All API endpoints failed. Check your API key and try again.");
}

/**
 * Translate a single chunk. Tries streaming on each endpoint, falls back to non-streaming.
 */
export async function translateChunk(
  text: string,
  apiKey: string,
  onToken: (token: string) => void,
  abortSignal?: AbortSignal,
): Promise<string> {
  const ep = getEndpoints(apiKey);

  // Try each streaming endpoint
  for (let i = 0; i < ep.streamUrls.length; i++) {
    const url = ep.streamUrls[i];
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (i > 0 || !ep.isAQ) {
      headers["x-goog-api-key"] = apiKey;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(buildPayload(text)),
        signal: abortSignal,
      });

      if (response.status === 429) throw new Error("RATE_LIMITED");

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const label = ep.isAQ && i === 0 ? "Vertex" : "Studio";
        console.warn(`[Translator] Stream ${label} failed: ${response.status}`);
        continue;
      }

      if (!response.body) throw new Error("Response body is null");

      const reader = response.body.getReader();
      return await parseStream(reader, onToken, abortSignal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "RATE_LIMITED" || msg === "Translation aborted") throw err;
      console.warn(`[Translator] Stream error (endpoint ${i + 1}):`, msg);
      continue;
    }
  }

  // All streaming endpoints failed — try non-streaming
  console.log("[Translator] All streaming endpoints failed, trying non-streaming...");
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
