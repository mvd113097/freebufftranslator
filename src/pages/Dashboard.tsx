import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Square,
  Download,
  Sparkles,
  BookOpen,
  RotateCcw,
  Zap,
  AlertCircle,
  ChevronDown,
  Settings2,
  Server,
  Loader2,
  Pause,
  Play,
  Send,
  CheckCircle2,
  Wifi,
  WifiOff,
  Laptop,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileUploader } from "@/components/translator/FileUploader";
import { KeyManager } from "@/components/translator/KeyManager";
import { ProgressPanel } from "@/components/translator/ProgressPanel";
import { SettingsPanel } from "@/components/translator/SettingsPanel";
import { SplitView } from "@/components/translator/SplitView";
import {
  chunkText,
  type TextChunk,
} from "@/lib/translator/chunker";
import {
  loadSettings,
  saveSettings,
  saveSession,
  loadSession,
  updateChunk,
  clearSession,
  type StoredChunk,
} from "@/lib/translator/persistence";
import {
  TranslationPipeline,
  type ChunkProgress,
  type PipelineProgress,
} from "@/lib/translator/pipeline";
import { translateChunkSimple } from "@/lib/translator/gemini-api";

const MODEL_OPTIONS = [
  { value: "openrouter/free", label: "Auto Free (best available)" },
  { value: "minimax/minimax-m3:free", label: "MiniMax M3 (free, 1M ctx)" },
  { value: "qwen/qwen3.6-plus:free", label: "Qwen 3.6 Plus (free, 1M ctx)" },
  { value: "z-ai/glm-5.2:free", label: "GLM 5.2 (free, 256K ctx)" },
  { value: "qwen/qwen3-235b-a22b-07-25:free", label: "Qwen 3 235B (free, 1M ctx)" },
  { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free, 1M ctx)" },
  { value: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (free, 1M ctx)" },
  { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash (free, 262K ctx)" },
  { value: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super (free, 262K ctx)" },
  { value: "thinkingmachines/inkling:free", label: "Thinking Machines Inkling (free, 1M ctx)" },
];

// ─── Telegram direct-from-browser ──────────────────────────────────

async function sendTelegramDirect(
  botToken: string,
  chatId: string,
  message: string,
): Promise<void> {
  if (!botToken || !chatId) return;
  const targets = chatId.split(",").map((s) => s.trim()).filter(Boolean);
  await Promise.all(
    targets.map((id) =>
      fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }).catch(() => undefined),
    ),
  );
}

export default function Dashboard() {
  // ─── State ──────────────────────────────────────────────────────
  const [keys, setKeys] = useState<string[]>(() => loadSettings().keys);
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [chunkSize, setChunkSize] = useState(() => loadSettings().chunkSize);
  const [concurrency, setConcurrency] = useState(() => loadSettings().concurrency);
  const [selectedModel, setSelectedModel] = useState(() => loadSettings().model);
  const [telegramBotToken, setTelegramBotToken] = useState(() => loadSettings().telegramBotToken);
  const [telegramChatId, setTelegramChatId] = useState(() => loadSettings().telegramChatId);
  const [telegramNotifyOnStart, setTelegramNotifyOnStart] = useState(() => loadSettings().telegramNotifyOnStart);
  const [telegramNotifyOnProgress, setTelegramNotifyOnProgress] = useState(() => loadSettings().telegramNotifyOnProgress);
  const [telegramNotifyOnError, setTelegramNotifyOnError] = useState(() => loadSettings().telegramNotifyOnError);
  const [telegramNotifyOnComplete, setTelegramNotifyOnComplete] = useState(() => loadSettings().telegramNotifyOnComplete);
  const [showScanResults, setShowScanResults] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);

  // Session restored from IndexedDB
  const [isRestored, setIsRestored] = useState(false);
  const [restoredTotal, setRestoredTotal] = useState(0);

  // Live pipeline state
  const [isRunning, setIsRunning] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<"chunking" | null>(null);
  const [chunkProgress, setChunkProgress] = useState<ChunkProgress[]>([]);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [activeModel, setActiveModel] = useState<string | undefined>(undefined);
  const [activeChunkId, setActiveChunkId] = useState<number | null>(null);
  const [activeEnglishWords, setActiveEnglishWords] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  const pipelineRef = useRef<TranslationPipeline | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const runningRef = useRef(false);

  // Settings snapshot for the Telegram callbacks (avoid stale closures)
  const telegramPrefsRef = useRef({ botToken: "", chatId: "", onStart: true, onProgress: true, onError: true, onComplete: true });
  telegramPrefsRef.current = {
    botToken: telegramBotToken,
    chatId: telegramChatId,
    onStart: telegramNotifyOnStart,
    onProgress: telegramNotifyOnProgress,
    onError: telegramNotifyOnError,
    onComplete: telegramNotifyOnComplete,
  };

  // ─── Derived flags ──────────────────────────────────────────────
  const completedCount = chunkProgress.filter((c) => c.status === "completed").length;
  const failedCount = chunkProgress.filter((c) => c.status === "failed").length;
  const totalChunks = chunkProgress.length;
  const hasSession = totalChunks > 0;
  const isComplete = hasSession && completedCount + failedCount === totalChunks;
  const isDoneClean = isComplete && failedCount === 0;
  const canStart = rawText.length > 0 && keys.length > 0 && !hasSession && !isStarting;
  const hasTranslatedChunks = completedCount > 0;

  // ─── Restore session from IndexedDB on mount ────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await loadSession();
        if (cancelled || !saved) return;
        setFileName(saved.session.fileName);
        setRestoredTotal(saved.session.totalChunks);
        setChunkProgress(
          saved.chunks.map((c) => ({
            id: c.id,
            status: c.status === "completed" ? ("completed" as const) : ("pending" as const),
            originalText: c.text,
            translatedText: c.translatedText,
            tokensReceived: 0,
            retries: 0,
          })),
        );
        setIsRestored(true);
      } catch {
        /* no session */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─── Persist settings to localStorage on change ─────────────────
  useEffect(() => {
    saveSettings({
      keys,
      model: selectedModel,
      chunkSize,
      concurrency,
      telegramBotToken,
      telegramChatId,
      telegramNotifyOnStart,
      telegramNotifyOnProgress,
      telegramNotifyOnError,
      telegramNotifyOnComplete,
      telegramNotifyOnPause: true,
      telegramStatusInterval: 0,
    });
  }, [keys, selectedModel, chunkSize, concurrency, telegramBotToken, telegramChatId, telegramNotifyOnStart, telegramNotifyOnProgress, telegramNotifyOnError, telegramNotifyOnComplete]);

  // ─── Online/offline awareness ───────────────────────────────────
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // ─── Elapsed timer ──────────────────────────────────────────────
  useEffect(() => {
    if (isRunning) {
      const started = Date.now() - elapsedMs;
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - started);
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [isRunning]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Wake Lock: keep the screen on while translating ────────────
  const acquireWakeLock = useCallback(async () => {
    try {
      if ("wakeLock" in navigator) {
        wakeLockRef.current = await navigator.wakeLock.request("screen");
        wakeLockRef.current.addEventListener("release", () => {
          wakeLockRef.current = null;
        });
      }
    } catch {
      /* denied or unsupported — non-fatal */
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    try {
      wakeLockRef.current?.release();
    } catch {
      /* ignore */
    }
    wakeLockRef.current = null;
  }, []);

  // Re-acquire wake lock when tab becomes visible again (browser drops it)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && runningRef.current) {
        acquireWakeLock();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [acquireWakeLock]);

  useEffect(() => releaseWakeLock, [releaseWakeLock]);

  // ─── Word counter (approximate, throttled by chunk completions) ──
  useEffect(() => {
    const words = chunkProgress
      .filter((c) => c.status === "completed")
      .reduce((sum, c) => sum + c.translatedText.split(/\s+/).filter(Boolean).length, 0);
    setActiveEnglishWords(words);
  }, [completedCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── File upload handler ────────────────────────────────────────
  const handleFileContent = useCallback((content: string, name: string) => {
    setRawText(content);
    setFileName(name);
  }, []);

  // ─── Persist one chunk to IndexedDB ─────────────────────────────
  const persistChunk = useCallback(async (chunk: ChunkProgress) => {
    try {
      await updateChunk({
        id: chunk.id,
        text: chunk.originalText,
        status: chunk.status === "completed" ? "completed" : "pending",
        translatedText: chunk.translatedText,
      });
    } catch (err) {
      console.error("Failed to persist chunk:", err);
    }
  }, []);

  // ─── Core runner: shared by Start and Resume ────────────────────
  const runPipeline = useCallback(
    async (existingChunks: ChunkProgress[]) => {
      const keysSnapshot = keys;
      if (keysSnapshot.length === 0) {
        alert("Add at least one API key first.");
        return;
      }

      const pipeline = new TranslationPipeline();
      pipelineRef.current = pipeline;
      runningRef.current = true;
      setIsRunning(true);
      setIsPaused(false);

      let lastMilestone = 0;
      let telegramStartSent = false;

      pipeline.setProgressCallback((p) => {
        setProgress(p);

        // Telegram progress milestones (every 25%)
        const prefs = telegramPrefsRef.current;
        if (
          prefs.onProgress &&
          prefs.botToken &&
          prefs.chatId &&
          p.totalChunks > 0
        ) {
          const pct = Math.floor(p.overallPercent / 25) * 25;
          if (pct >= lastMilestone + 25 && p.completedChunks > 0) {
            lastMilestone = pct;
            sendTelegramDirect(
              prefs.botToken,
              prefs.chatId,
              `📖 <b>Translation ${pct}%</b>\n${p.completedChunks}/${p.totalChunks} chunks done\n⚡ ${p.activeChunks} in progress`,
            );
          }
        }
      });

      pipeline.setTokenCallback((chunkId, _token) => {
        setActiveChunkId(chunkId);
      });

      try {
        // Run the pipeline over the chunk list. Already-completed chunks are
        // skipped by passing them as pre-completed in the progress map.
        await pipeline.resume(existingChunks, keysSnapshot, {
          concurrency,
          model: selectedModel,
          chunkSize,
          maxRetries: 3,
          onChunkComplete: async (chunk) => {
            await persistChunk(chunk);
          },
          onModelUsed: (model) => setActiveModel(model),
          onChunkFailed: (chunk) => {
            const prefs = telegramPrefsRef.current;
            if (prefs.onError && prefs.botToken && prefs.chatId) {
              sendTelegramDirect(
                prefs.botToken,
                prefs.chatId,
                `❌ <b>Chunk ${chunk.id + 1} failed</b>\n<code>${(chunk.error ?? "unknown").slice(0, 150)}</code>`,
              );
            }
          },
        });

        const finished = pipeline.getChunkProgress();
        setChunkProgress([...finished]);

        const allDone = finished.every(
          (c) => c.status === "completed" || c.status === "failed",
        );
        if (allDone) {
          setIsRunning(false);
          setIsPaused(false);
          releaseWakeLock();

          const prefs = telegramPrefsRef.current;
          if (prefs.onComplete && prefs.botToken && prefs.chatId) {
            const done = finished.filter((c) => c.status === "completed").length;
            const words = finished
              .filter((c) => c.status === "completed")
              .reduce((s, c) => s + c.translatedText.split(/\s+/).filter(Boolean).length, 0);
            sendTelegramDirect(
              prefs.botToken,
              prefs.chatId,
              `🎉 <b>Translation complete!</b>\n${done} chunks • ~${words.toLocaleString()} words\nOpen the app to download your .epub`,
            );
          }
        } else {
          // Some chunks still pending — treat as paused
          setIsRunning(false);
          setIsPaused(true);
          releaseWakeLock();
        }
      } catch (err) {
        console.error("Pipeline error:", err);
        setIsRunning(false);
        setIsPaused(true);
        releaseWakeLock();
      } finally {
        pipelineRef.current = null;
        runningRef.current = false;
      }
    },
    [keys, concurrency, selectedModel, chunkSize, persistChunk, releaseWakeLock],
  );

  // ─── Start translation ──────────────────────────────────────────
  const startTranslation = useCallback(async () => {
    if (!canStart) return;
    setIsStarting(true);
    setUploadPhase("chunking");

    try {
      // Chunk the text (paragraph-aware)
      const chunks: TextChunk[] = chunkText(rawText, chunkSize);
      if (chunks.length === 0) {
        alert("No text to translate.");
        setIsStarting(false);
        setUploadPhase(null);
        return;
      }

      const initial: ChunkProgress[] = chunks.map((c) => ({
        id: c.id,
        status: "pending" as const,
        originalText: c.text,
        translatedText: "",
        tokensReceived: 0,
        retries: 0,
      }));
      setChunkProgress(initial);

      // Persist to IndexedDB immediately so a reload resumes cleanly
      try {
        await saveSession(
          {
            id: "current",
            fileName: fileName || "unknown.txt",
            rawText: "",
            rawTextLength: rawText.length,
            totalChunks: chunks.length,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          chunks.map((c) => ({
            id: c.id,
            text: c.text,
            status: "pending" as const,
            translatedText: "",
          })),
        );
      } catch (err) {
        console.error("Failed to save session:", err);
      }

      setUploadPhase(null);
      setIsStarting(false);
      setIsRestored(false);

      // Telegram start notice
      const prefs = telegramPrefsRef.current;
      if (prefs.onStart && prefs.botToken && prefs.chatId) {
        sendTelegramDirect(
          prefs.botToken,
          prefs.chatId,
          `🚀 <b>Translation started</b>\n📚 ${fileName || "novel"}\n📦 ${chunks.length} chunks • ${(rawText.length / 1000).toFixed(0)}k chars\n⚙️ Model: ${selectedModel === "openrouter/free" ? "Auto Free" : selectedModel}`,
        );
      }

      await acquireWakeLock();
      await runPipeline(initial);
    } catch (err) {
      console.error("Failed to start:", err);
      alert("Failed to start: " + (err instanceof Error ? err.message : String(err)));
      setIsStarting(false);
      setUploadPhase(null);
    }
  }, [canStart, rawText, fileName, chunkSize, keys.length, selectedModel, runPipeline, acquireWakeLock]);

  // ─── Resume after pause/reload ──────────────────────────────────
  const resumeTranslation = useCallback(async () => {
    if (chunkProgress.length === 0) return;
    setIsResuming(true);
    try {
      await acquireWakeLock();
      await runPipeline(chunkProgress);
    } finally {
      setTimeout(() => setIsResuming(false), 500);
    }
  }, [chunkProgress, runPipeline, acquireWakeLock]);

  // ─── Pause ──────────────────────────────────────────────────────
  const pauseTranslation = useCallback(() => {
    pipelineRef.current?.abort();
  }, []);

  // ─── Stop (hard stop, same as pause for client-side) ────────────
  const stopTranslation = useCallback(() => {
    pipelineRef.current?.abort();
    setIsRunning(false);
    setIsPaused(true);
    releaseWakeLock();
  }, [releaseWakeLock]);

  // ─── Download helper ────────────────────────────────────────────
  const downloadTranslation = useCallback(
    async (chunks: { index: number; text: string }[], label: string) => {
      if (chunks.length === 0) {
        alert("No translated content to download yet.");
        return;
      }
      const { generateEpub, triggerDownload } = await import("@/lib/translator/epub");
      const title = (fileName.replace(/\.txt$/i, "") || "Translated Novel").replace(/_/g, " ");
      const epubBlob = await generateEpub(chunks, title, fileName);
      triggerDownload(epubBlob, label);
    },
    [fileName],
  );

  // ─── Export complete ────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    const done = chunkProgress
      .filter((c) => c.status === "completed")
      .map((c) => ({ index: c.id, text: c.translatedText }));
    const baseName = (fileName.replace(/\.txt$/i, "") || "translated_novel") + ".epub";
    await downloadTranslation(done, baseName);
  }, [chunkProgress, fileName, downloadTranslation]);

  // ─── Download progress (partial) ────────────────────────────────
  const handleDownloadProgress = useCallback(async () => {
    const done = chunkProgress
      .filter((c) => c.status === "completed")
      .map((c) => ({ index: c.id, text: c.translatedText }));
    await downloadTranslation(done, "incomplete_english.epub");
  }, [chunkProgress, downloadTranslation]);

  // ─── Reset ──────────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    if (isRunning) {
      pipelineRef.current?.abort();
    }
    try {
      await clearSession();
    } catch {
      /* ignore */
    }
    setChunkProgress([]);
    setProgress(null);
    setActiveChunkId(null);
    setActiveEnglishWords(0);
    setElapsedMs(0);
    setIsRunning(false);
    setIsPaused(false);
    setIsRestored(false);
    setRestoredTotal(0);
    setRawText("");
    setFileName("");
    setShowScanResults(false);
  }, [isRunning]);

  // ─── Test all keys ──────────────────────────────────────────────
  const testAllKeys = useCallback(async () => {
    try {
      const lines: string[] = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        try {
          await translateChunkSimple("你好世界 Hello World", key, selectedModel);
          lines.push(`Key ${i + 1} (…${key.slice(-4)}): ✅ works`);
        } catch (err2) {
          const msg = err2 instanceof Error ? err2.message : String(err2);
          lines.push(`Key ${i + 1} (…${key.slice(-4)}): ❌ ${msg.slice(0, 140)}`);
        }
      }
      const okCount = lines.filter((l) => l.includes("✅")).length;
      alert(
        `Key check — ${okCount}/${keys.length} valid:\n\n${lines.join("\n\n")}\n\nRemove the ❌ keys (they will fail every chunk).`,
      );
    } catch (err) {
      alert(`❌ Key test failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [keys, selectedModel]);

  // ─── Scan for Chinese characters in translated text ─────────────
  const scanResults = useMemo(() => {
    const withChinese: { index: number; matches: string[] }[] = [];
    const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
    for (const c of chunkProgress) {
      if (c.status !== "completed") continue;
      const matches = [...new Set(c.translatedText.match(CJK) ?? [])];
      if (matches.length > 0) withChinese.push({ index: c.id, matches: matches.slice(0, 12) });
    }
    return {
      totalScanned: completedCount,
      chunksWithChinese: withChinese,
    };
  }, [chunkProgress, completedCount]);

  const retranslateChinese = useCallback(() => {
    const dirty = new Set(scanResults.chunksWithChinese.map((c) => c.index));
    if (dirty.size === 0) return;
    const reset = chunkProgress.map((c) =>
      dirty.has(c.id)
        ? { ...c, status: "pending" as const, translatedText: "", error: undefined, tokensReceived: 0 }
        : c,
    );
    setChunkProgress(reset);
    setShowScanResults(false);
    void runPipeline(reset);
  }, [scanResults, chunkProgress, runPipeline]);

  // ─── Render ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-stone-950">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-stone-800 bg-stone-900/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-amber-600 shadow-md shadow-amber-500/20">
              <BookOpen className="h-4 w-4 text-stone-950" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-stone-100 tracking-tight">
                Novel Translator
              </h1>
              <p className="text-[10px] text-stone-400 flex items-center gap-1">
                {isOnline ? (
                  <>
                    <Wifi className="h-3 w-3 text-green-400" /> Client-side • Direct to OpenRouter
                  </>
                ) : (
                  <>
                    <WifiOff className="h-3 w-3 text-red-400" /> Offline — translation paused
                  </>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-1.5 rounded-lg bg-stone-800 border border-stone-700 px-3 py-1.5 text-[10px] text-stone-400">
              <Laptop className="h-3 w-3" />
              Runs in your browser
            </div>
            {isRunning && (
              <div className="flex items-center gap-1.5 rounded-lg bg-green-500/10 border border-green-500/20 px-3 py-1.5 text-[10px] text-green-400">
                <Loader2 className="h-3 w-3 animate-spin" />
                Translating
              </div>
            )}
            {isPaused && !isRunning && hasSession && (
              <div className="flex items-center gap-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 text-[10px] text-yellow-400">
                <Pause className="h-3 w-3" />
                Paused
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
        {/* Keep-tab-open banner while running */}
        <AnimatePresence>
          {isRunning && (
            <motion.div
              initial={{ opacity: 0, y: -12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <Laptop className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-amber-300">
                      Keep this tab open — translation runs in your browser
                    </h3>
                    <p className="text-xs text-amber-200/70 mt-1">
                      Every finished chunk is saved automatically. If the browser closes, just reopen
                      the app and press Resume — it continues exactly where it left off.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Restored session banner */}
        <AnimatePresence>
          {isRestored && hasSession && !isRunning && (
            <motion.div
              initial={{ opacity: 0, y: -12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-blue-500/30 bg-blue-500/10 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="h-5 w-5 text-blue-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-blue-300">
                      Session restored — {fileName || "saved novel"}
                    </h3>
                    <p className="text-xs text-blue-200/70 mt-1">
                      {completedCount} of {totalChunks} chunks already translated
                      {failedCount > 0 ? ` • ${failedCount} failed` : ""}. Resume to continue, or
                      download what's done.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Paused banner */}
        <AnimatePresence>
          {isPaused && hasSession && !isRunning && !isComplete && (
            <motion.div
              initial={{ opacity: 0, y: -12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <Pause className="h-5 w-5 text-yellow-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-yellow-300">
                      Translation paused
                    </h3>
                    <p className="text-xs text-yellow-200/70 mt-1">
                      <strong>{fileName}</strong> — {completedCount} of {totalChunks} chunks done.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Failed chunks banner */}
        <AnimatePresence>
          {isComplete && failedCount > 0 && !isRunning && (
            <motion.div
              initial={{ opacity: 0, y: -12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-orange-500/30 bg-orange-500/10 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-orange-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-orange-300">
                      {failedCount} chunk{failedCount > 1 ? "s" : ""} failed to translate
                    </h3>
                    <p className="text-xs text-orange-200/70 mt-1">
                      {completedCount} of {totalChunks} succeeded. Press Resume to retry just the
                      failed chunks, or download what's done.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Top Row: Upload + Keys */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="lg:col-span-2 space-y-3"
          >
            <FileUploader
              onFileContent={handleFileContent}
              disabled={isRunning || isStarting || hasSession}
            />
            {rawText.length > 0 && !hasSession && (
              <div className="flex items-center gap-4 text-[11px] text-stone-400 px-1">
                <span>📄 {rawText.length.toLocaleString()} characters</span>
                <span>📦 ~{Math.ceil(rawText.length / chunkSize)} chunks</span>
              </div>
            )}
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl p-4 shadow-sm"
          >
            <KeyManager keys={keys} onKeysChange={setKeys} />
          </motion.div>
        </div>

        {/* Model + Settings + Progress */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="space-y-4"
          >
            {/* Model Selector */}
            <div className="rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl p-4 shadow-sm">
              <label className="text-xs font-semibold text-stone-200 block mb-2">Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isRunning || isStarting}
                className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs text-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-50 cursor-pointer"
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              {activeModel && (
                <p className="mt-2 text-[10px] text-stone-400 flex items-center gap-1">
                  <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                  Now translating with{" "}
                  <span className="font-mono font-semibold text-amber-400">
                    {activeModel.split("/").pop()?.replace(/:free$/, "")}
                  </span>
                  {selectedModel === "openrouter/free" ? " (Auto Free picked it)" : ""}
                </p>
              )}
              {selectedModel === "openrouter/free" && !activeModel && (
                <p className="mt-2 text-[10px] text-stone-500 leading-snug">
                  Auto Free tries the best available model per chunk and skips any that are
                  rate-limited.
                </p>
              )}
            </div>

            {/* Collapsible Pipeline Settings */}
            <div className="rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl shadow-sm overflow-hidden">
              <button
                onClick={() => setSettingsOpen(!settingsOpen)}
                className="w-full flex items-center justify-between p-4 text-left cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Settings2 className="h-4 w-4 text-amber-400" />
                  <span className="text-sm font-semibold text-stone-200">Pipeline Settings</span>
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-stone-400 transition-transform duration-200",
                    settingsOpen && "rotate-180",
                  )}
                />
              </button>
              <AnimatePresence initial={false}>
                {settingsOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeInOut" }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4 pt-0">
                      <SettingsPanel
                        chunkSize={chunkSize}
                        onChunkSizeChange={setChunkSize}
                        concurrency={concurrency}
                        onConcurrencyChange={setConcurrency}
                        chunkSizeDisabled={isRunning || isStarting || hasSession}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Telegram Notifications */}
            <div className="rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl shadow-sm overflow-hidden">
              <button
                onClick={() => setTelegramOpen((v) => !v)}
                className="w-full flex items-center justify-between p-4 text-left cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <Send className="h-4 w-4 text-blue-400" />
                  <span className="text-sm font-semibold text-stone-200">Telegram Notifications</span>
                  {telegramBotToken && telegramChatId && (
                    <span className="inline-flex items-center rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-400">
                      Active
                    </span>
                  )}
                </div>
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-stone-400 transition-transform duration-200",
                    telegramOpen && "rotate-180",
                  )}
                />
              </button>
              <AnimatePresence initial={false}>
                {telegramOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: "easeInOut" }}
                    className="overflow-hidden"
                  >
                    <div className="px-4 pb-4 pt-0 space-y-3">
                      <p className="text-[11px] text-stone-500">
                        Sent directly from your browser while the tab is open. Optional.
                      </p>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-stone-400">Bot Token</label>
                        <input
                          type="password"
                          value={telegramBotToken}
                          onChange={(e) => setTelegramBotToken(e.target.value)}
                          placeholder="1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
                          className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs font-mono text-stone-200 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-stone-400">Chat ID</label>
                        <input
                          type="text"
                          value={telegramChatId}
                          onChange={(e) => setTelegramChatId(e.target.value)}
                          placeholder="123456789"
                          className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs font-mono text-stone-200 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                        />
                        <p className="text-[10px] text-stone-600">
                          Message @userinfobot to find your Chat ID. Separate multiple IDs with commas.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium text-stone-400">Notify me when...</label>
                        <div className="space-y-1.5">
                          {(
                            [
                              { label: "Translation starts", checked: telegramNotifyOnStart, set: setTelegramNotifyOnStart },
                              { label: "Progress milestones (every 25%)", checked: telegramNotifyOnProgress, set: setTelegramNotifyOnProgress },
                              { label: "A chunk fails (error)", checked: telegramNotifyOnError, set: setTelegramNotifyOnError },
                              { label: "Translation completes", checked: telegramNotifyOnComplete, set: setTelegramNotifyOnComplete },
                            ] as const
                          ).map(({ label, checked, set }) => (
                            <label key={label} className="flex items-center gap-2 cursor-pointer group">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => set(e.target.checked)}
                                className="h-3.5 w-3.5 rounded border-stone-600 bg-stone-700 text-blue-400 focus:ring-blue-400/30 cursor-pointer"
                              />
                              <span className="text-[11px] text-stone-300 group-hover:text-stone-200 transition-colors">{label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="lg:col-span-2 rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl p-4 shadow-sm"
          >
            <ProgressPanel
              progress={progress}
              chunks={chunkProgress}
              isRunning={isRunning}
              isComplete={isDoneClean}
              totalEnglishWords={activeEnglishWords}
              activeModel={activeModel}
            />
          </motion.div>
        </div>

        {/* Split View — original vs streaming translation */}
        {hasSession && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25 }}
          >
            <SplitView chunks={chunkProgress} activeChunkId={activeChunkId} />
          </motion.div>
        )}

        {/* Action Buttons */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="flex items-center gap-3 flex-wrap"
        >
          {!isRunning && !isStarting && !hasSession && (
            <>
              <button
                onClick={startTranslation}
                disabled={!canStart}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-semibold transition-all shadow-lg cursor-pointer",
                  canStart
                    ? "bg-gradient-to-r from-amber-500 to-amber-600 text-stone-950 shadow-amber-500/25 hover:shadow-amber-500/40 hover:scale-[1.02] active:scale-[0.98]"
                    : "bg-stone-800 text-stone-500 cursor-not-allowed shadow-none",
                )}
              >
                <Server className="h-4 w-4" />
                Start Translation
              </button>
              {keys.length > 0 && (
                <button
                  onClick={testAllKeys}
                  className="flex items-center gap-2 rounded-xl border border-stone-700 bg-stone-800 px-4 py-2.5 text-xs font-medium text-stone-300 hover:bg-stone-700 transition-all cursor-pointer"
                >
                  <Zap className="h-3.5 w-3.5" />
                  Test All Keys
                </button>
              )}
            </>
          )}

          {isStarting && (
            <button
              disabled
              className="flex items-center gap-2 rounded-xl bg-amber-500/50 px-6 py-2.5 text-sm font-semibold text-stone-950 cursor-not-allowed"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              {uploadPhase === "chunking" ? "Chunking file…" : "Starting..."}
            </button>
          )}

          {isRunning && (
            <>
              <button
                onClick={pauseTranslation}
                className="flex items-center gap-2 rounded-xl bg-yellow-500/90 backdrop-blur-sm px-5 py-2.5 text-sm font-semibold text-stone-950 shadow-lg shadow-yellow-500/25 hover:bg-yellow-400 transition-all cursor-pointer"
              >
                <Pause className="h-4 w-4" />
                Pause
              </button>
              <button
                onClick={stopTranslation}
                className="flex items-center gap-2 rounded-xl bg-red-500/90 backdrop-blur-sm px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-red-500/25 hover:bg-red-600 transition-all cursor-pointer"
              >
                <Square className="h-4 w-4" />
                Stop
              </button>
            </>
          )}

          {(isPaused || (isComplete && failedCount > 0)) && !isRunning && hasSession && (
            <button
              onClick={resumeTranslation}
              disabled={isResuming}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-2.5 text-sm font-semibold text-stone-950 shadow-lg shadow-amber-500/25 hover:shadow-amber-500/40 hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100"
            >
              {isResuming ? (
                <><Loader2 className="h-4 w-4 animate-spin" /> Resuming...</>
              ) : (
                <><Play className="h-4 w-4" /> Resume Translation</>
              )}
            </button>
          )}

          {/* Download Progress — partial export */}
          {hasSession && hasTranslatedChunks && !isRunning && (
            <button
              onClick={handleDownloadProgress}
              className="flex items-center gap-2 rounded-xl border border-green-500/30 bg-green-500/10 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-green-300 hover:bg-green-500/20 active:bg-green-500/30 transition-all cursor-pointer"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Download className="h-4 w-4" />
              Download Progress ({completedCount} chunks)
            </button>
          )}

          {/* Export Complete */}
          {isDoneClean && hasTranslatedChunks && (
            <button
              onClick={handleExport}
              className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 backdrop-blur-md px-5 py-2.5 text-sm font-medium text-amber-300 hover:bg-amber-500/20 active:bg-amber-500/30 transition-all cursor-pointer"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Download className="h-4 w-4" />
              Download Complete ({completedCount} chunks)
            </button>
          )}

          {/* Scan for Chinese */}
          {hasSession && hasTranslatedChunks && (
            <button
              onClick={() => setShowScanResults(!showScanResults)}
              className="flex items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-purple-300 hover:bg-purple-500/20 active:bg-purple-500/30 transition-all cursor-pointer"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              {showScanResults ? "Hide" : "Scan for Chinese"}
            </button>
          )}

          {/* Reset */}
          {hasSession && !isRunning && (
            <button
              onClick={handleReset}
              className="flex items-center gap-2 rounded-xl border border-stone-700 bg-stone-800 px-4 py-2.5 text-sm font-medium text-stone-300 hover:bg-stone-700 transition-all cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
          )}

          {!canStart && !isRunning && !isStarting && !hasSession && (
            <span className="text-xs text-stone-500 flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              {rawText.length === 0
                ? "Upload a .txt file to begin"
                : "Add at least one API key"}
            </span>
          )}
        </motion.div>

        {/* Scan Results */}
        <AnimatePresence>
          {showScanResults && (
            <motion.div
              initial={{ opacity: 0, y: 12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: 12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-purple-500/30 bg-purple-500/10 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-purple-300">
                    Chinese Character Scan Results
                  </h3>
                  <div className="flex items-center gap-3">
                    {scanResults.chunksWithChinese.length > 0 && !isRunning && (
                      <button
                        onClick={retranslateChinese}
                        className="rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 px-3 py-1.5 text-[11px] font-semibold text-white shadow-md hover:shadow-lg transition-all cursor-pointer"
                      >
                        Re-translate {scanResults.chunksWithChinese.length} chunks
                      </button>
                    )}
                    <button
                      onClick={() => setShowScanResults(false)}
                      className="text-xs text-purple-400 hover:text-purple-300 cursor-pointer"
                    >
                      Close
                    </button>
                  </div>
                </div>
                {scanResults.totalScanned === 0 ? (
                  <p className="text-xs text-stone-400">No completed chunks found.</p>
                ) : scanResults.chunksWithChinese.length === 0 ? (
                  <div className="flex items-center gap-2 text-green-400">
                    <span className="text-lg">✅</span>
                    <p className="text-sm font-medium">
                      All {scanResults.totalScanned} chunks are clean — zero Chinese characters found!
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-purple-200/70">
                      Found Chinese characters in {scanResults.chunksWithChinese.length} of{" "}
                      {scanResults.totalScanned} chunks:
                    </p>
                    {scanResults.chunksWithChinese.map((item) => (
                      <div
                        key={item.index}
                        className="rounded-xl border border-red-500/30 bg-red-500/10 p-3"
                      >
                        <p className="text-[11px] font-semibold text-red-300 mb-1">
                          Chunk {item.index + 1}
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {item.matches.map((word, i) => (
                            <span
                              key={i}
                              className="inline-block rounded bg-red-500/20 px-2 py-0.5 text-xs font-mono text-red-200 border border-red-500/30"
                            >
                              {word}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
