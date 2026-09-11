/**
 * Pure core for the translation pipeline - no I/O, fully unit-testable.
 *
 * Implements (per approved plan v3):
 *  - Per-model output-token budget from a verified limits table (live-verified
 *    2026-09: Gemini text models 65,536 output; OpenRouter cascade per-model
 *    caps, e.g. lfm-2.5-2.6b:free = 8,192 which the old 16000 constant violated).
 *  - Response classifier: SUCCESS / TRUNCATED / BLOCKED / RATE_LIMITED /
 *    KEY_REJECTED / TRANSIENT (blocks are never retried).
 *  - Layered resume-boundary detection for CN->EN continuation:
 *      1. token overlap (works when the source contains Latin text / names),
 *      2. paragraph-count alignment (primary for CN->EN: the system prompt
 *         mandates 1:1 paragraphs, so the accumulated translation's paragraph
 *         count IS the exact translated source position, sanity-checked by
 *         plausible CN->EN expansion ratio),
 *      3. none -> the caller conservatively sends the FULL source with strict
 *         do-not-restart instructions and guards.
 *  - Seam-safe continuation joining (overlap strip, restart detect, echo guard).
 *  - Final validation gate that must pass before status='completed'.
 */

// ---------------------------------------------------------------------------
// Per-model output budget
// ---------------------------------------------------------------------------

/**
 * Verified output-token limits (live provider catalogs, 2026-09).
 * Keys are full model ids (OpenRouter) or bare names (Gemini).
 */
export const MODEL_OUTPUT_LIMITS: Record<string, number> = {
  // Gemini text models - all verified at 65,536 output tokens.
  "gemini-2.5-flash": 65536,
  "gemini-2.5-flash-lite": 65536,
  "gemini-2.5-pro": 65536,
  "gemini-3.1-pro-preview": 65536,
  "gemini-3.1-flash-lite": 65536,
  "gemini-3.5-flash": 65536,
  "gemini-3.5-flash-lite": 65536,
  "gemini-3.6-flash": 65536,
  "gemini-3.7-flash": 65536,
  "gemini-3.8-flash": 65536,
  // OpenRouter free cascade - per-model caps from the OpenRouter catalog.
  "inclusionai/ling-3.0-flash-fin:free": 32768,
  "inclusionai/ling-3.0-flash-sante:free": 32768,
  "google/gemma-4-31b-it:free": 32768,
  "google/gemma-4-26b-a4b-it:free": 32768,
  "poolside/laguna-s-2.1:free": 32768,
  "poolside/laguna-xs-2.1:free": 32768,
  "nex-agi/nex-n2.5-pro:free": 235929,
  "nex-agi/nex-n2.5-mini:free": 235929,
  "nvidia/nemotron-3-ultra-550b-a55b:free": 65536,
  "thinkingmachines/inkling:free": 262144,
  "nvidia/nemotron-3.5-lightning:free": 65536,
  "thinkingmachines/inkling-small:free": 262144,
  "dots-studio/dots-3-note-preview:free": 460800,
  "nvidia/nemotron-3-super-120b-a12b:free": 235929,
  "liquid/lfm-2.5-2.6b:free": 8192,
};

/** Request budget cap: enough for one unit, keeps responses inside timeouts. */
const REQUEST_CAP = 65536;
/** Conservative default when a model is unknown - continuation loop covers the rest. */
const DEFAULT_BUDGET = 8192;

/** Loose model-name normalization (strip provider prefix, lowercase). */
function normalizeModelName(model: string): string {
  const bare = model.includes("/") ? model.split("/").pop() ?? model : model;
  return bare.toLowerCase().trim();
}

/** Resolve the safe max-output-tokens request for a specific model. */
export function requestedMaxTokens(model: string): number {
  // Try the exact id first (OpenRouter ids carry provider prefixes), then bare.
  const exact = MODEL_OUTPUT_LIMITS[model.toLowerCase().trim()];
  if (exact !== undefined) return Math.min(exact, REQUEST_CAP);
  const bare = MODEL_OUTPUT_LIMITS[normalizeModelName(model)];
  if (bare === undefined) return DEFAULT_BUDGET;
  return Math.min(bare, REQUEST_CAP);
}

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

export type ProviderOutcome =
  | { kind: "SUCCESS"; content: string; model: string }
  | { kind: "TRUNCATED"; content: string; model: string }
  | { kind: "BLOCKED"; reason: string }
  | { kind: "RATE_LIMITED" }
  | { kind: "KEY_REJECTED"; reason: string }
  | { kind: "TRANSIENT"; reason: string };

export const PROVIDER_BLOCK_RE = /SAFETY|PROHIBITED_CONTENT|BLOCKLIST|RECITATION|SPII|content filter|content_filter|moderation/i;

/** Classify a Gemini :generateContent JSON response. */
export function classifyGeminiResponse(data: unknown, model: string): ProviderOutcome {
  const d = data as {
    promptFeedback?: { blockReason?: string };
    error?: { code?: number; message?: string };
    candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  };
  const pf = d?.promptFeedback;
  if (pf?.blockReason) {
    return { kind: "BLOCKED", reason: `prompt blocked: ${pf.blockReason}` };
  }
  const err = d?.error;
  if (err) {
    const msg = String(err.message ?? "");
    if (err.code === 429) return { kind: "RATE_LIMITED" };
    if (PROVIDER_BLOCK_RE.test(msg)) return { kind: "BLOCKED", reason: msg.slice(0, 300) };
    return { kind: "TRANSIENT", reason: `MODEL_ERROR: ${msg.slice(0, 300)}` };
  }
  const cand = d?.candidates?.[0];
  const text = extractGeminiText(d);
  const fr = cand?.finishReason;
  if (!text) {
    if (fr && fr !== "STOP" && fr !== "MAX_TOKENS") {
      return { kind: "BLOCKED", reason: `finishReason=${fr}` };
    }
    return { kind: "TRANSIENT", reason: fr === "MAX_TOKENS" ? "empty MAX_TOKENS response" : "empty response" };
  }
  if (fr === "MAX_TOKENS") return { kind: "TRUNCATED", content: text, model };
  return { kind: "SUCCESS", content: text, model };
}

/** Classify an OpenRouter /chat/completions JSON response. */
export function classifyOpenRouterResponse(data: unknown, model: string, httpStatus: number): ProviderOutcome {
  const d = data as {
    error?: { message?: string };
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  if (httpStatus === 429) return { kind: "RATE_LIMITED" };
  if (httpStatus === 402 || httpStatus === 404 || httpStatus === 408) {
    return { kind: "TRANSIENT", reason: `model unavailable (HTTP ${httpStatus})` };
  }
  const choice = d?.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    const e = String(d?.error?.message ?? "");
    if (PROVIDER_BLOCK_RE.test(e)) return { kind: "BLOCKED", reason: e.slice(0, 300) };
    return { kind: "TRANSIENT", reason: "empty response" };
  }
  if (choice?.finish_reason === "length") return { kind: "TRUNCATED", content, model };
  return { kind: "SUCCESS", content, model };
}

/** Pull all text parts out of a Gemini response shape. */
export function extractGeminiText(data: unknown): string | null {
  const d = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const parts = d?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const texts = parts
      .map((p) => p?.text)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
    if (texts.length > 0) return texts.join("");
  }
  return null;
}

// ---------------------------------------------------------------------------
// Paragraph alignment for source-positioned continuation
// ---------------------------------------------------------------------------

const CJK_RE = /[\u4e00-\u9fff]/;

/** Tokenize text into a bag of Latin words and CJK unigrams+bigrams. */
export function paraTokens(s: string): Set<string> {
  const out = new Set<string>();
  const clean = s.toLowerCase();
  const unigrams: string[] = clean.match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i < unigrams.length; i++) {
    out.add(unigrams[i]);
    if (
      CJK_RE.test(unigrams[i]) &&
      i + 1 < unigrams.length &&
      CJK_RE.test(unigrams[i + 1])
    ) {
      out.add(unigrams[i] + unigrams[i + 1]);
    }
  }
  return out;
}

/** Whitespace/punctuation-normalized text for tail comparisons. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Jaccard similarity between token bags of two strings. */
export function similarity(a: string, b: string): number {
  const A = paraTokens(a);
  const B = paraTokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Count non-empty paragraphs (blank-line or newline separated). */
export function countParagraphs(text: string): number {
  return text.split(/\n+/).filter((p) => p.trim().length > 0).length;
}

export type BoundaryStrategy = "token-overlap" | "paragraph-count" | "none";

export interface ResumeBoundary {
  /** Index of the first untranslated source paragraph. */
  paraIndex: number;
  /** Character offset of that paragraph in the "\n".join(sourceParagraphs). */
  charOffset: number;
  coveredParagraphs: number;
  /** Boundary is considered exact (caller may slice source at charOffset). */
  confident: boolean;
  which: BoundaryStrategy;
}

/** Fraction of a source paragraph's tokens that must appear in the translation. */
const COVERED_RATIO = 0.6;
/** Plausible CN->EN character expansion per paragraph (loose bounds).
 * Measured literary translations run ~2.5-4x; garbage/repetition exceeds it. */
const EXPANSION_MIN = 0.25;
const EXPANSION_MAX = 5.0;

/**
 * Determine which source paragraphs are already translated.
 *
 * Layer 1 - token overlap: paragraphs whose tokens (incl. Latin names/terms)
 * appear in the accumulated translation. Only trusted with a clean prefix
 * (no covered paragraph may exist beyond the boundary).
 *
 * Layer 2 - paragraph count: the system prompt mandates 1:1 paragraph mapping,
 * so if the accumulated translation has P < S paragraphs, the first P source
 * paragraphs are translated. Trusted when the average CN->EN expansion ratio
 * is plausible.
 */
export function computeResumeBoundary(
  sourceParagraphs: string[],
  accumulatedTranslation: string,
): ResumeBoundary {
  const srcCount = sourceParagraphs.length;
  const charOffsetOf = (idx: number): number => {
    let off = 0;
    for (let k = 0; k < idx && k < srcCount; k++) off += sourceParagraphs[k].length + 1;
    return off;
  };

  // Layer 1: token overlap (clean prefix scan).
  const accBag = paraTokens(accumulatedTranslation);
  let i = 0;
  let covered = 0;
  while (i < srcCount) {
    const bag = paraTokens(sourceParagraphs[i]);
    if (bag.size === 0) {
      i++;
      covered++;
      continue;
    }
    let hits = 0;
    for (const t of bag) if (accBag.has(t)) hits++;
    if (hits / bag.size >= COVERED_RATIO) {
      i++;
      covered++;
      continue;
    }
    break;
  }
  let contradiction = false;
  for (let j = i + 1; j < srcCount; j++) {
    const bag = paraTokens(sourceParagraphs[j]);
    if (bag.size === 0) continue;
    let hits = 0;
    for (const t of bag) if (accBag.has(t)) hits++;
    if (hits / bag.size >= COVERED_RATIO) {
      contradiction = true;
      break;
    }
  }
  if (!contradiction && covered > 0 && i < srcCount && accBag.size > 0) {
    return {
      paraIndex: i,
      charOffset: charOffsetOf(i),
      coveredParagraphs: covered,
      confident: true,
      which: "token-overlap",
    };
  }

  // Layer 2: paragraph-count alignment (primary for CN->EN).
  const accParas = countParagraphs(accumulatedTranslation);
  if (accParas > 0 && accParas < srcCount) {
    const accAvg = accumulatedTranslation.trim().length / accParas;
    const srcPrefix = sourceParagraphs.slice(0, accParas).join("\n");
    const srcAvg = Math.max(1, srcPrefix.length / accParas);
    const expansion = accAvg / srcAvg;
    const plausible = expansion >= EXPANSION_MIN && expansion <= EXPANSION_MAX;
    return {
      paraIndex: accParas,
      charOffset: charOffsetOf(accParas),
      coveredParagraphs: accParas,
      confident: plausible,
      which: "paragraph-count",
    };
  }

  // No reliable signal.
  return { paraIndex: 0, charOffset: 0, coveredParagraphs: 0, confident: false, which: "none" };
}

// ---------------------------------------------------------------------------
// Continuation joining
// ---------------------------------------------------------------------------

export interface JoinGuardResult {
  ok: boolean;
  joined: string;
  reason?: "restart" | "echo";
}

/**
 * Join a continuation to the accumulated translation with guards:
 *  - restart detection (model re-translated from the beginning)
 *  - echo detection (model repeated the untranslated source region instead of
 *    translating it - a genuine EN continuation has near-zero token overlap
 *    with CJK source, so HIGH similarity means it echoed)
 *  - overlap strip at the seam (dedup)
 *
 * `sentSourceRegion` is the exact source slice that accompanied the
 * continuation request (empty when the full source was sent as context).
 */
export function joinContinuation(
  accumulated: string,
  continuation: string,
  sentSourceRegion: string,
): JoinGuardResult {
  const contNorm = normalizeText(continuation);
  const accNorm = normalizeText(accumulated);

  // Restart: the continuation opens like the accumulated head.
  if (contNorm.length >= 40 && similarity(contNorm.slice(0, 200), accNorm.slice(0, 200)) > 0.8) {
    return { ok: false, joined: accumulated, reason: "restart" };
  }

  // Echo guard: continuation repeats source text instead of translating it.
  const contTokens = paraTokens(continuation);
  if (sentSourceRegion.trim().length > 0 && contTokens.size >= 10) {
    if (similarity(continuation, sentSourceRegion) > 0.5) {
      return { ok: false, joined: accumulated, reason: "echo" };
    }
  }

  // Overlap strip: longest suffix of accumulated that equals a prefix of continuation.
  let rawStrip = 0;
  const accRawTail = accumulated.slice(-400);
  for (let n = Math.min(accRawTail.length, continuation.length); n >= 8; n--) {
    if (accRawTail.endsWith(continuation.slice(0, n))) {
      rawStrip = n;
      break;
    }
  }
  let cont = continuation.slice(rawStrip);
  let stripped = rawStrip > 0;
  // Normalized-strip fallback when raw strip found nothing.
  if (!stripped && contNorm.length > 0 && accNorm.length > 0) {
    const accTailNorm = accNorm.slice(-300);
    let normStrip = 0;
    for (let n = Math.min(accTailNorm.length, contNorm.length); n >= 12; n--) {
      if (accTailNorm.endsWith(contNorm.slice(0, n))) {
        normStrip = n;
        break;
      }
    }
    if (normStrip > 0) {
      const firstKeep = contNorm.slice(normStrip).trimStart().split(" ")[0];
      if (firstKeep) {
        const idx = continuation.indexOf(firstKeep);
        if (idx > 0) {
          cont = continuation.slice(idx);
          stripped = true;
        }
      }
    }
  }

  // Seam joiner: overlap-strip implies mid-flow; otherwise paragraph-break vs
  // mid-sentence is decided by the accumulated ending and continuation opening.
  let joiner: string;
  if (stripped) {
    joiner = /\s$/.test(accumulated) || /^\s/.test(cont) ? "" : " ";
  } else {
    const accEndsClean = /[.!?…]["'」』”’]?\s*$/.test(accumulated);
    const contStartsLower = /^[a-z]/.test(cont.trimStart());
    joiner = accEndsClean && !contStartsLower ? "\n\n" : " ";
  }
  return { ok: true, joined: (accumulated + joiner + cont).trim() };
}

// ---------------------------------------------------------------------------
// Final validation gate
// ---------------------------------------------------------------------------

export interface ValidationResult {
  passed: boolean;
  reason?: "empty" | "identical-to-source" | "mostly-chinese" | "too-short" | "missing-paragraphs";
  cjkRatio: number;
  lengthRatio: number;
  paraRatio: number;
}

export const GATE = {
  maxCjkRatio: 0.1,
  maxSourceSim: 0.9,
  minLenRatio: 0.35,
  minParaRatio: 0.5,
} as const;

/** Conservative gate: every check must pass before a chunk may be completed. */
export function validateTranslation(translated: string, source: string): ValidationResult {
  const t = translated.trim();
  const srcLen = Math.max(1, source.length);
  const srcParas = countParagraphs(source);
  if (!t) return { passed: false, reason: "empty", cjkRatio: 1, lengthRatio: 0, paraRatio: 0 };
  if (similarity(t, source) >= GATE.maxSourceSim) {
    return { passed: false, reason: "identical-to-source", cjkRatio: 1, lengthRatio: t.length / srcLen, paraRatio: 0 };
  }
  const cjk = (t.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const cjkRatio = t.length > 0 ? cjk / t.length : 1;
  if (cjkRatio > GATE.maxCjkRatio) {
    return { passed: false, reason: "mostly-chinese", cjkRatio, lengthRatio: t.length / srcLen, paraRatio: 0 };
  }
  const lengthRatio = t.length / srcLen;
  if (lengthRatio < GATE.minLenRatio) {
    return { passed: false, reason: "too-short", cjkRatio, lengthRatio, paraRatio: 0 };
  }
  const outParas = countParagraphs(t);
  const paraRatio = srcParas > 0 ? outParas / srcParas : 1;
  if (paraRatio < GATE.minParaRatio) {
    return { passed: false, reason: "missing-paragraphs", cjkRatio, lengthRatio, paraRatio };
  }
  return { passed: true, cjkRatio, lengthRatio, paraRatio };
}
