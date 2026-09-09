/**
 * Single source of truth for the OpenRouter free-tier model list.
 *
 * Every place that needs "which models exist / is this slug valid" must import
 * from here, so a saved setting that references a removed or dead model
 * (e.g. minimax/minimax-m3:free) can be detected and fixed up automatically.
 */

export interface ModelOption {
  value: string;
  label: string;
}

// Quality-ranked with proven-reliability first. "Auto Free" cascades through
// these on failure. Non-reasoning models (Ling, Gemma) are listed before
// reasoning models (Nemotron Ultra, Inkling): reasoning models stream a long
// silent thinking phase that can time out short-lived fetches (e.g. the
// Cloudflare worker aborts mid-reasoning with "The operation was aborted").
// IMPORTANT: all slugs are real OpenRouter :free variants — paid slugs (no
// :free) are rejected with HTTP 402 on free-tier OpenRouter accounts.
export const MODEL_OPTIONS: ModelOption[] = [
  { value: "openrouter/free", label: "Auto (best available)" },
  { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash Fin (262K ctx, free) ★" },
  { value: "inclusionai/ling-3.0-flash-sante:free", label: "Ling 3.0 Flash Sante (262K ctx, free)" },
  { value: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (Google, 262K ctx, free)" },
  { value: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (Google, 262K ctx, free)" },
  { value: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (262K ctx, free)" },
  { value: "poolside/laguna-xs-2.1:free", label: "Laguna XS 2.1 (262K ctx, free)" },
  { value: "nex-agi/nex-n2.5-pro:free", label: "Nex N2.5 Pro (262K ctx, free)" },
  { value: "nex-agi/nex-n2.5-mini:free", label: "Nex N2.5 Mini (262K ctx, free)" },
  { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B (1M ctx, free, slow)" },
  { value: "thinkingmachines/inkling:free", label: "Inkling (1M ctx, free, slow)" },
  { value: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (1M ctx, free, slow)" },
  { value: "thinkingmachines/inkling-small:free", label: "Inkling Small (1M ctx, free)" },
  { value: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note (512K ctx, free)" },
  { value: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B (262K ctx, free)" },
  { value: "liquid/lfm-2.5-2.6b:free", label: "Liquid LFM 2.5 (65K ctx, free)" },
];

/** All verified-live specific model slugs (no "Auto" entry). */
export const LIVE_MODEL_SLUGS: string[] = MODEL_OPTIONS.filter(
  (m) => m.value !== "openrouter/free",
).map((m) => m.value);

/** Auto values (the app's internal "Auto Free" sentinel). */
export const AUTO_VALUES = new Set(["openrouter/free", "openrouter/auto", "auto"]);

export function isAutoModel(model: string | undefined | null): boolean {
  return !!model && AUTO_VALUES.has(model);
}

/** True when the slug is a known-good live model (or the Auto sentinel). */
export function isKnownModel(model: string | undefined | null): boolean {
  if (isAutoModel(model)) return true;
  return !!model && LIVE_MODEL_SLUGS.includes(model);
}

/**
 * Resolve "Auto" to the first verified-working model slug.
 *
 * The deployed Cloudflare Worker may run an older build whose own auto-cascade
 * still starts with dead models (e.g. minimax/minimax-m3:free → HTTP 404).
 * Sending a specific known-good slug bypasses the Worker's cascade entirely.
 * For client mode, FALLBACK_MODELS in gemini-api.ts handles the cascade.
 */
export function resolveAutoModel(model: string): string {
  if (isAutoModel(model)) return LIVE_MODEL_SLUGS[0] ?? model;
  return model;
}

/**
 * Sanitize a user-saved model slug: map Auto values to the sentinel, and
 * migrate anything that is not a known live slug (removed/dead models like
 * minimax-minimax-m3:free saved by an older build) back to Auto, which always
 * resolves to a verified-live model at start/resume time.
 */
export function sanitizeModel(model: string | undefined | null): string {
  if (!model) return "openrouter/free";
  if (isKnownModel(model)) return model;
  return "openrouter/free";
}
