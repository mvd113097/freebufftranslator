/**
 * Unit tests for the pure worker core (bun test).
 * Covers: per-model budgets, response classification (both providers),
 * layered resume-boundary detection, seam-safe continuation joining,
 * and the validation gate.
 */
import { describe, expect, test } from "bun:test";
import {
  classifyGeminiResponse,
  classifyOpenRouterResponse,
  computeResumeBoundary,
  joinContinuation,
  paraTokens,
  requestedMaxTokens,
  validateTranslation,
} from "./translation-core";

// ---------------------------------------------------------------------------
// Per-model output budgets
// ---------------------------------------------------------------------------

describe("requestedMaxTokens", () => {
  test("gemini models get 65536", () => {
    expect(requestedMaxTokens("gemini-3.6-flash")).toBe(65536);
    expect(requestedMaxTokens("gemini-3.5-flash-lite")).toBe(65536);
    expect(requestedMaxTokens("gemini-2.5-pro")).toBe(65536);
  });
  test("openrouter free models get their verified per-model caps", () => {
    expect(requestedMaxTokens("liquid/lfm-2.5-2.6b:free")).toBe(8192);
    expect(requestedMaxTokens("inclusionai/ling-3.0-flash-fin:free")).toBe(32768);
    expect(requestedMaxTokens("nvidia/nemotron-3-ultra-550b-a55b:free")).toBe(65536);
    expect(requestedMaxTokens("thinkingmachines/inkling:free")).toBe(65536); // capped at REQUEST_CAP
  });
  test("unknown models fall back to conservative 8192", () => {
    expect(requestedMaxTokens("some/brand-new-model:free")).toBe(8192);
    expect(requestedMaxTokens("gemini-9.9-future")).toBe(8192);
  });
});

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

describe("classifyGeminiResponse", () => {
  test("SUCCESS with normal finishReason", () => {
    const r = classifyGeminiResponse(
      { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Hello." }] } }] },
      "gemini-3.6-flash",
    );
    expect(r.kind).toBe("SUCCESS");
  });
  test("MAX_TOKENS with partial text => TRUNCATED (the silent-loss case)", () => {
    const r = classifyGeminiResponse(
      {
        candidates: [
          { finishReason: "MAX_TOKENS", content: { parts: [{ text: "one, two, three," }] } },
        ],
      },
      "gemini-3.6-flash",
    );
    expect(r.kind).toBe("TRUNCATED");
    if (r.kind === "TRUNCATED") expect(r.content).toBe("one, two, three,");
  });
  test("promptFeedback.blockReason => BLOCKED", () => {
    const r = classifyGeminiResponse(
      { promptFeedback: { blockReason: "SAFETY" } },
      "gemini-3.6-flash",
    );
    expect(r.kind).toBe("BLOCKED");
  });
  test("finishReason SAFETY with no text => BLOCKED", () => {
    const r = classifyGeminiResponse(
      { candidates: [{ finishReason: "SAFETY" }] },
      "gemini-3.6-flash",
    );
    expect(r.kind).toBe("BLOCKED");
  });
  test("error code 429 => RATE_LIMITED", () => {
    const r = classifyGeminiResponse({ error: { code: 429, message: "quota" } }, "m");
    expect(r.kind).toBe("RATE_LIMITED");
  });
  test("other error => TRANSIENT", () => {
    const r = classifyGeminiResponse({ error: { code: 500, message: "boom" } }, "m");
    expect(r.kind).toBe("TRANSIENT");
  });
});

describe("classifyOpenRouterResponse", () => {
  test("SUCCESS", () => {
    const r = classifyOpenRouterResponse(
      { choices: [{ message: { content: "Hi." }, finish_reason: "stop" }] },
      "m",
      200,
    );
    expect(r.kind).toBe("SUCCESS");
  });
  test("finish_reason length => TRUNCATED", () => {
    const r = classifyOpenRouterResponse(
      { choices: [{ message: { content: "partial..." }, finish_reason: "length" }] },
      "m",
      200,
    );
    expect(r.kind).toBe("TRUNCATED");
  });
  test("HTTP 429 => RATE_LIMITED", () => {
    expect(classifyOpenRouterResponse({}, "m", 429).kind).toBe("RATE_LIMITED");
  });
  test("HTTP 404 => TRANSIENT (cascade moves on)", () => {
    expect(classifyOpenRouterResponse({}, "m", 404).kind).toBe("TRANSIENT");
  });
  test("content-filter error => BLOCKED", () => {
    const r = classifyOpenRouterResponse(
      { error: { message: "content filtering policy violation" } },
      "m",
      200,
    );
    expect(r.kind).toBe("BLOCKED");
  });
});

// ---------------------------------------------------------------------------
// Layered resume-boundary detection
// ---------------------------------------------------------------------------

describe("computeResumeBoundary", () => {
  // Realistic CN paragraphs (~28-32 chars each).
  const src = [
    "林逸盘膝坐在青石板上，闭目凝神，缓缓运转周天，气息绵长而稳定。",
    "老人抚摸着长须，目光深邃，看着少年的背影，缓缓开口说道。",
    "朱棣被朱标一把拽住，怒道：皇爷爷面前，岂容你放肆！",
    "马皇后叹了口气，眼中满是疼惜与无奈。",
  ];

  test("empty translation => no reliable boundary", () => {
    const b = computeResumeBoundary(src, "");
    expect(b.which).toBe("none");
    expect(b.confident).toBe(false);
    expect(b.paraIndex).toBe(0);
  });

  test("two translated paragraphs => boundary at 2 via paragraph-count", () => {
    const acc =
      "Lin Yi sat cross-legged on the bluestone slab, eyes closed, breathing slowly as his power circulated through him.\n\n" +
      "The old man stroked his long beard and watched the youth's back with deep, ancient eyes before speaking at last.";
    const b = computeResumeBoundary(src, acc);
    expect(b.which).toBe("paragraph-count");
    expect(b.paraIndex).toBe(2);
    expect(b.coveredParagraphs).toBe(2);
    expect(b.confident).toBe(true); // expansion ratio plausible
    expect(b.charOffset).toBe(src[0].length + 1 + src[1].length + 1);
  });

  test("implausible expansion => boundary returned but not confident", () => {
    // Translation paragraphs absurdly long vs source -> alignment untrusted.
    const acc = Array.from({ length: 2 }, () => "x".repeat(500)).join("\n\n");
    const b = computeResumeBoundary(src, acc);
    expect(b.which).toBe("paragraph-count");
    expect(b.paraIndex).toBe(2);
    expect(b.confident).toBe(false);
  });

  test("more translation paragraphs than source => no reliable boundary", () => {
    const acc = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} of text.`).join("\n\n");
    const b = computeResumeBoundary(src, acc);
    expect(b.which).toBe("none");
    expect(b.confident).toBe(false);
  });

  test("token-overlap layer works when tokens are shared", () => {
    // Source contains Latin terms that survive into the translation.
    const src2 = [
      "修士们称这种丹药为九转还魂丹（Jiuzan Huandu Dan），极为罕见。",
      "他翻开了那本名为《大道归一》的古卷。",
      "第三段内容与前面完全不同，讲的是别的事情。",
    ];
    const acc =
      "Cultivators called this pill the Jiuzan Huandu Dan, exceedingly rare.\n\nHe opened the ancient scroll.";
    const b = computeResumeBoundary(src2, acc);
    // Either layer may claim it; what matters: boundary lands at 2 with confidence.
    expect(b.paraIndex).toBe(2);
    expect(b.confident).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Continuation joining
// ---------------------------------------------------------------------------

describe("joinContinuation", () => {
  const region = "老人抚摸着长须，缓缓说道。朱棣被朱标一把拽住";

  test("clean continuation joins with blank-line seam", () => {
    const acc = "Lin Yi sat cross-legged on the bluestone slab.";
    const cont = "The old man stroked his beard and spoke slowly.";
    const r = joinContinuation(acc, cont, "");
    expect(r.ok).toBe(true);
    expect(r.joined).toContain("bluestone slab");
    expect(r.joined).toContain("stroked his beard");
  });

  test("exact duplicate tail is stripped from the seam (no duplication)", () => {
    const acc = "He walked toward the gate. The wind was cold.";
    const cont = "The wind was cold. He opened the door.";
    const r = joinContinuation(acc, cont, "");
    expect(r.ok).toBe(true);
    expect(r.joined).toBe("He walked toward the gate. The wind was cold. He opened the door.");
    expect(r.joined.match(/The wind was cold/g)?.length).toBe(1);
  });

  test("restart (model re-translates from the beginning) is rejected", () => {
    const acc = "Lin Yi sat cross-legged on the bluestone slab and began to cultivate.";
    const cont = "Lin Yi sat cross-legged on the bluestone slab and began to cultivate. The moon rose.";
    const r = joinContinuation(acc, cont, "");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("restart");
  });

  test("continuation that echoes the Chinese source is rejected (echo guard)", () => {
    const r = joinContinuation(
      "Lin Yi sat cross-legged on the bluestone slab.",
      "老人抚摸着长须，缓缓说道。朱棣被朱标一把拽住",
      region,
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("echo");
  });

  test("genuine English continuation of Chinese source is NOT rejected", () => {
    const r = joinContinuation(
      "Lin Yi sat cross-legged on the bluestone slab.",
      "The old man stroked his beard and spoke slowly. Zhu Di was seized by the collar.",
      region,
    );
    expect(r.ok).toBe(true);
  });

  test("mid-sentence continuation joins with a single space", () => {
    const acc = "He grabbed the sword and";
    const cont = "swung it at the darkness.";
    const r = joinContinuation(acc, cont, "");
    expect(r.ok).toBe(true);
    expect(r.joined).toBe("He grabbed the sword and swung it at the darkness.");
  });
});

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

describe("validateTranslation", () => {
  test("good translation passes", () => {
    const src = "林逸盘膝坐在青石板上修炼。他闭目凝神，气息绵长而平稳。";
    const t = "Lin Yi sat cross-legged on the bluestone slab, cultivating. He closed his eyes, steadied his spirit, and his breathing slowed into a long, even rhythm as the night deepened around him.";
    const r = validateTranslation(t, src);
    expect(r.passed).toBe(true);
  });
  test("empty fails", () => {
    expect(validateTranslation("", "内容").reason).toBe("empty");
  });
  test("untranslated Chinese fails (the 29-paragraph block case)", () => {
    const src = "朱棣被朱标一把拽住，怒道：皇爷爷面前，岂容你放肆！";
    const r = validateTranslation("朱棣被朱标一把拽住，怒道：皇爷爷面前，岂容你放肆！", src);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("identical-to-source");
  });
  test("mostly Chinese output fails", () => {
    const src = "这是一段很长的文字，需要被翻译成英文输出。".repeat(5);
    const t = "Some English. " + "这是中文内容" + " more English words here now.";
    const r = validateTranslation(t, src);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("mostly-chinese");
  });
  test("truncated output (below 35% of source length) fails", () => {
    const src = "长".repeat(1000);
    const t = "Short text. ";
    const r = validateTranslation(t, src);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("too-short");
  });
  test("missing paragraphs fail", () => {
    const src = [
      "第一段的内容在这里，写得比较长一些。",
      "第二段的内容在这里，写得比较长一些。",
      "第三段的内容在这里，写得比较长一些。",
      "第四段的内容在这里，写得比较长一些。",
    ].join("\n\n");
    const t = "Only one paragraph of translation exists here with enough words to pass the length check easily.";
    const r = validateTranslation(t, src);
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("missing-paragraphs");
  });
});

// ---------------------------------------------------------------------------
// Tokenizer sanity
// ---------------------------------------------------------------------------

describe("paraTokens", () => {
  test("CJK bigrams and latin words both tokenize", () => {
    const bag = paraTokens("修炼 Lin Yi");
    expect(bag.has("修炼")).toBe(true);
    expect(bag.has("lin")).toBe(true);
    expect(bag.has("yi")).toBe(true);
  });
});
