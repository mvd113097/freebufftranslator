/**
 * Single source of truth for all model lists in the app.
 *
 * Every place that needs "which models exist / is this slug valid" must import
 * from here, so a saved setting that references a removed or dead model
 * (e.g. minimax/minimax-m3:free) can be detected and fixed up automatically.
 *
 * Supported providers:
 *  - OpenRouter free tier:  https://openrouter.ai  (Bearer sk-or-v1-...)
 *  - Google Gemini free tier: https://googleapis.com  (header x-goog-api-key
 *    with AQ. keys; query-param ?key= is forbidden for AQ. keys)
 */

export type Provider = "openrouter" | "gemini";

export interface ModelOption {
  value: string;
  label: string;
  provider: Provider;
}

// ─── OpenRouter free-tier models ──────────────────────────────────────

const OPENROUTER_MODELS: ModelOption[] = [
  { value: "openrouter/free", label: "Auto (best available)", provider: "openrouter" },
  { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash Fin (262K ctx, free) ★", provider: "openrouter" },
  { value: "inclusionai/ling-3.0-flash-sante:free", label: "Ling 3.0 Flash Sante (262K ctx, free)", provider: "openrouter" },
  { value: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (Google, 262K ctx, free)", provider: "openrouter" },
  { value: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (Google, 262K ctx, free)", provider: "openrouter" },
  { value: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (262K ctx, free)", provider: "openrouter" },
  { value: "poolside/laguna-xs-2.1:free", label: "Laguna XS 2.1 (262K ctx, free)", provider: "openrouter" },
  { value: "nex-agi/nex-n2.5-pro:free", label: "Nex N2.5 Pro (262K ctx, free)", provider: "openrouter" },
  { value: "nex-agi/nex-n2.5-mini:free", label: "Nex N2.5 Mini (262K ctx, free)", provider: "openrouter" },
  { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B (1M ctx, free, slow)", provider: "openrouter" },
  { value: "thinkingmachines/inkling:free", label: "Inkling (1M ctx, free, slow)", provider: "openrouter" },
  { value: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (1M ctx, free, slow)", provider: "openrouter" },
  { value: "thinkingmachines/inkling-small:free", label: "Inkling Small (1M ctx, free)", provider: "openrouter" },
  { value: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note (512K ctx, free)", provider: "openrouter" },
  { value: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B (262K ctx, free)", provider: "openrouter" },
  { value: "liquid/lfm-2.5-2.6b:free", label: "Liquid LFM 2.5 (65K ctx, free)", provider: "openrouter" },
];

// ─── Gemini free-tier models (native Google endpoint, AQ. keys) ───────
// These are the model IDs from Google's official Gemini API docs (2026-09)
// Endpoint: https://googleapis.com/v1beta/models/{model}:streamGenerateContent

const GEMINI_MODELS: ModelOption[] = [
  { value: "gemini-3.8-flash", label: "Gemini 3.8 Flash (free tier) ★", provider: "gemini" },
  { value: "gemini-3.7-flash", label: "Gemini 3.7 Flash (free tier)", provider: "gemini" },
  { value: "gemini-3.6-flash", label: "Gemini 3.6 Flash (free tier)", provider: "gemini" },
  { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash (free tier)", provider: "gemini" },
  { value: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite (free tier)", provider: "gemini" },
  { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite (free tier)", provider: "gemini" },
];

// Master list: OpenRouter first, then Gemini.
export const MODEL_OPTIONS: ModelOption[] = [
  ...OPENROUTER_MODELS,
  ...GEMINI_MODELS,
];

/** OpenRouter model slugs only (excludes the Auto sentinel and Gemini). */
export const LIVE_MODEL_SLUGS: string[] = OPENROUTER_MODELS.filter(
  (m) => m.value !== "openrouter/free",
).map((m) => m.value);

/** Gemini model slugs only. */
export const GEMINI_MODEL_SLUGS: string[] = GEMINI_MODELS.map((m) => m.value);

/** OpenRouter Auto sentinels. */
export const OPENROUTER_AUTO_VALUES = new Set(["openrouter/free", "openrouter/auto", "auto"]);

/** Gemini Auto sentinel (uses the first Gemini model). */
export const GEMINI_AUTO_VALUE = "gemini/free";

export function isAutoModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return (
    OPENROUTER_AUTO_VALUES.has(model) ||
    model === GEMINI_AUTO_VALUE
  );
}

/** True when the slug is a known-good live model (or an Auto sentinel). */
export function isKnownModel(model: string | undefined | null): boolean {
  if (isAutoModel(model)) return true;
  if (!model) return false;
  return (
    LIVE_MODEL_SLUGS.includes(model) ||
    GEMINI_MODEL_SLUGS.includes(model)
  );
}

/** Provider lookup for a known model value (undefined for unknown). */
export function modelProvider(model: string): Provider | undefined {
  if (OPENROUTER_AUTO_VALUES.has(model)) return "openrouter";
  if (model === GEMINI_AUTO_VALUE) return "gemini";
  if (LIVE_MODEL_SLUGS.includes(model)) return "openrouter";
  if (GEMINI_MODEL_SLUGS.includes(model)) return "gemini";
  return undefined;
}

/**
 * Resolve an "Auto" sentinel to the first verified-working model slug for that
 * provider. Auto always stays within its own provider.
 */
export function resolveAutoModel(model: string): string {
  if (OPENROUTER_AUTO_VALUES.has(model)) {
    return LIVE_MODEL_SLUGS[0] ?? model;
  }
  if (model === GEMINI_AUTO_VALUE) {
    return GEMINI_MODEL_SLUGS[0] ?? model;
  }
  return model;
}

/**
 * Sanitize a user-saved model slug: anything not a known live slug (removed/
 * dead models like minimax-minimax-m3:free) is reset to the OpenRouter Auto
 * sentinel, which always resolves to a verified-live model at start/resume.
 */
export function sanitizeModel(model: string | undefined | null): string {
  if (!model) return "openrouter/free";
  if (isKnownModel(model)) return model;
  return "openrouter/free";
}
