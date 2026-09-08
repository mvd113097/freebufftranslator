import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate } from "react-router";
import { getAuthState, setGuest, logout, type AuthState } from "@/lib/auth";
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
  Cloud,
  Loader2,
  Pause,
  Play,
  Send,
  CheckCircle2,
  Wifi,
  WifiOff,
  Laptop,
  UserRound,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileUploader } from "@/components/translator/FileUploader";
import { KeyManager } from "@/components/translator/KeyManager";
import { ProgressPanel } from "@/components/translator/ProgressPanel";
import { SettingsPanel } from "@/components/translator/SettingsPanel";
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
import { CloudRunner } from "@/lib/translator/cloud-runner";
import {
  getWorkerUrl,
  setWorkerUrl,
  getWorkerSecret,
  setWorkerSecret,
} from "@/lib/translator/cloud-client";
import { CloudSettings } from "@/components/translator/CloudSettings";

// Quality-ranked: best models first. "Auto Free" cascades through these on failure.
const MODEL_OPTIONS = [
  { value: "openrouter/free", label: "Auto Free (best available)" },
  { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra 550B (free, 1M ctx)" },
  { value: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super 120B (free, 262K ctx)" },
  { value: "thinkingmachines/inkling:free", label: "Inkling (free, 1M ctx)" },
  { value: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (free, 1M ctx)" },
  { value: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (free, Google, 262K ctx)" },
  { value: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B (free, Google, 262K ctx)" },
  { value: "thinkingmachines/inkling-small:free", label: "Inkling Small (free, 1M ctx)" },
  { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash Fin (free, 262K ctx)" },
  { value: "inclusionai/ling-3.0-flash-sante:free", label: "Ling 3.0 Flash Sante (free, 262K ctx)" },
  { value: "poolside/laguna-s-2.1:free", label: "Laguna S 2.1 (free, 262K ctx)" },
  { value: "poolside/laguna-xs-2.1:free", label: "Laguna XS 2.1 (free, 262K ctx)" },
  { value: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", label: "Nemotron 3 Nano 30B (free, 256K ctx)" },
  { value: "dots-studio/dots-3-note-preview:free", label: "Dots 3 Note (free, 512K ctx)" },
  { value: "liquid/lfm-2.5-2.6b:free", label: "Liquid LFM 2.5 (free, 65K ctx)" },
];

// ─── Model availability persistence ──────────────────────────────
const MODEL_AVAIL_KEY = "novel-translator-model-availability";

function loadModelAvailability(): Record<string, "live" | "dead"> {
  try {
    const raw = localStorage.getItem(MODEL_AVAIL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Only accept "live" or "dead" values
    const result: Record<string, "live" | "dead"> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === "live" || v === "dead") result[k] = v;
    }
    return result;
  } catch {
    return {};
  }
}

function saveModelAvailability(data: Record<string, "live" | "dead">): void {
  try {
    localStorage.setItem(MODEL_AVAIL_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

/** Returns the live models in quality order (first = best). Falls back to the static list. */
function getLiveModelOrder(): string[] {
  const avail = loadModelAvailability();
  // Include both live and rate-limited models (rate-limited are alive but quota-exceeded)
  const live = MODEL_OPTIONS
    .filter((m) => m.value !== "openrouter/free" && (avail[m.value] === "live" || avail[m.value] === "dead"))
    .map((m) => m.value);
  // Prefer live-only if available, otherwise include all
  const liveOnly = MODEL_OPTIONS
    .filter((m) => m.value !== "openrouter/free" && avail[m.value] === "live")
    .map((m) => m.value);
  return liveOnly.length > 0 ? liveOnly : (live.length > 0 ? live : MODEL_OPTIONS.filter((m) => m.value !== "openrouter/free").map((m) => m.value));
}

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
  const [telegramNotifyOnPause, setTelegramNotifyOnPause] = useState(() => loadSettings().telegramNotifyOnPause);
  const [telegramStatusInterval, setTelegramStatusInterval] = useState(() => loadSettings().telegramStatusInterval);
  const [showScanResults, setShowScanResults] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [telegramOpen, setTelegramOpen] = useState(false);
  const [modelAvailability, setModelAvailability] = useState<Record<string, "live" | "dead" | "rate-limited" | "checking">>(() => {
    const saved = loadModelAvailability();
    // Convert saved {live|dead} to the UI state format
    const init: Record<string, "live" | "dead" | "rate-limited" | "checking"> = {};
    for (const [k, v] of Object.entries(saved)) init[k] = v;
    return init;
  });
  const [checkingModels, setCheckingModels] = useState(false);

  // Cloud mode (translation continues on a Cloudflare worker with the browser closed)
  const [translationMode, setTranslationMode] = useState<"client" | "cloud">(
    () => loadSettings().translationMode,
  );
  const [workerUrl, setWorkerUrlState] = useState(() => getWorkerUrl());
  const [workerSecret, setWorkerSecretState] = useState(() => getWorkerSecret());
  const [cloudJobId, setCloudJobId] = useState(() => loadSettings().cloudJobId);

  // Auth gate (fully client-side)
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const navigate = useNavigate();

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
  const [activeEnglishWords, setActiveEnglishWords] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );

  const pipelineRef = useRef<TranslationPipeline | null>(null);
  const cloudRunnerRef = useRef<CloudRunner | null>(null);
  const cloudChunkTextRef = useRef<Map<number, string>>(new Map());
  const progressRef = useRef<PipelineProgress | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const runningRef = useRef(false);

  // Settings snapshot for the Telegram callbacks (avoid stale closures)
  const telegramPrefsRef = useRef({ botToken: "", chatId: "", onStart: true, onProgress: true, onError: true, onComplete: true, onPause: true });
  telegramPrefsRef.current = {
    botToken: telegramBotToken,
    chatId: telegramChatId,
    onStart: telegramNotifyOnStart,
    onProgress: telegramNotifyOnProgress,
    onError: telegramNotifyOnError,
    onComplete: telegramNotifyOnComplete,
    onPause: telegramNotifyOnPause,
  };
  progressRef.current = progress;

  // ─── Derived flags ──────────────────────────────────────────────
  const completedCount = chunkProgress.filter((c) => c.status === "completed").length;
  const failedCount = chunkProgress.filter((c) => c.status === "failed").length;
  const totalChunks = chunkProgress.length;
  const hasSession = totalChunks > 0;
  const isComplete = hasSession && completedCount + failedCount === totalChunks;
  const isDoneClean = isComplete && failedCount === 0;
  const canStart =
    rawText.length > 0 &&
    keys.length > 0 &&
    !hasSession &&
    !isStarting &&
    (translationMode === "client" || workerUrl.trim().length > 0);
  const hasTranslatedChunks = completedCount > 0;

  // ─── Auth check: on mount and whenever the tab regains focus ────
  // (focus re-check picks up users who finish email login in another tab)
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const state = await getAuthState();
        if (!cancelled) setAuth(state);
      } catch {
        if (!cancelled) setAuth({ mode: "out", email: null });
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    };
    check();
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const handleGuestEntry = useCallback(() => {
    setGuest(true);
    setAuth({ mode: "guest", email: null });
  }, []);

  const handleSignOut = useCallback(async () => {
    await logout();
    setAuth({ mode: "out", email: null });
    navigate("/auth?returnTo=%2Fdashboard", { replace: true });
  }, [navigate]);

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
            // Only use saved translatedText if it's actually non-empty
            translatedText: c.translatedText && c.translatedText.length > 0 ? c.translatedText : "",
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

  // ─── Re-attach to a running cloud job after reload ──────────────
  useEffect(() => {
    const savedJobId = loadSettings().cloudJobId;
    if (!savedJobId) return;
    let cancelled = false;

    (async () => {
      try {
        const { getCloudStatus } = await import("@/lib/translator/cloud-client");
        const status = await getCloudStatus(savedJobId);
        if (cancelled) return;

        // Only re-attach if the job is still alive on the worker
        if (status.status === "active") {
          const runner = new CloudRunner(savedJobId, {
            onProgress: (p) => {
              setProgress(p);
              setActiveModel(p.activeModel);
              setElapsedMs(p.elapsedMs);
            },
            onChunkCompleted: async (chunkId, text) => {
              setChunkProgress((prev) =>
                prev.map((c) =>
                  c.id === chunkId
                    ? { ...c, status: "completed" as const, translatedText: text }
                    : c,
                ),
              );
              try {
                await updateChunk({
                  id: chunkId,
                  text: cloudChunkTextRef.current.get(chunkId) ?? "",
                  status: "completed",
                  translatedText: text,
                });
              } catch {
                /* ignore */
              }
            },
            onDone: (failedChunks) => {
              setIsRunning(false);
              setIsPaused(failedChunks > 0);
              cloudRunnerRef.current = null;
            },
            onError: (message) => console.error("[Cloud]", message),
          });
          cloudRunnerRef.current = runner;
          setIsRunning(true);
          runningRef.current = true;
        } else {
          // Job finished while we were away — refresh chunks from IndexedDB
          setCloudJobId("");
        }
      } catch {
        // Worker unreachable — keep local state, user can retry later
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
      telegramNotifyOnPause,
      telegramStatusInterval,
      translationMode,
      cloudJobId,
    });
  }, [keys, selectedModel, chunkSize, concurrency, telegramBotToken, telegramChatId, telegramNotifyOnStart, telegramNotifyOnProgress, telegramNotifyOnError, telegramNotifyOnComplete, telegramNotifyOnPause, telegramStatusInterval, translationMode, cloudJobId]);

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

  // ─── Auto-check model availability on mount ─────────────────────
  useEffect(() => {
    if (keys.length === 0) return;
    const saved = loadModelAvailability();
    const hasSavedResults = Object.keys(saved).length > 0;
    // If no saved results, check immediately; if saved, check in background
    if (!hasSavedResults) {
      checkModels();
    } else {
      // Background refresh — non-blocking
      const key = keys[0];
      const results: Record<string, "live" | "dead" | "rate-limited" | "checking"> = {};
      for (const [k, v] of Object.entries(saved)) results[k] = v;
      (async () => {
        for (const m of MODEL_OPTIONS) {
          if (m.value === "openrouter/free") continue;
          try {
            await translateChunkSimple("Hi", key, m.value);
            results[m.value] = "live";
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes("RATE_LIMITED") || msg.includes("429") || msg.includes("rate limit")) {
              results[m.value] = "rate-limited";
            } else {
              results[m.value] = "dead";
            }
          }
          setModelAvailability({ ...results });
        }
        const toSave: Record<string, "live" | "dead"> = {};
        for (const [k, v] of Object.entries(results)) {
          if (v === "live") toSave[k] = "live";
          if (v === "dead") toSave[k] = "dead";
          // Rate-limited models are NOT saved as dead
        }
        saveModelAvailability(toSave);
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.length > 0 ? "ready" : "none"]);

  // ─── Elapsed timer (client mode only — cloud polls report elapsed) ──
  useEffect(() => {
    if (isRunning && translationMode === "client") {
      const started = Date.now() - elapsedMs;
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - started);
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    }
  }, [isRunning, translationMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Telegram periodic status updates (every N minutes) ─────────
  useEffect(() => {
    if (!isRunning) return;
    const minutes = telegramStatusInterval;
    if (!minutes || minutes <= 0) return;
    const id = setInterval(() => {
      const prefs = telegramPrefsRef.current;
      const p = progressRef.current;
      if (!prefs.botToken || !prefs.chatId || !p || p.totalChunks === 0) return;
      const elapsedMin = Math.floor(p.elapsedMs / 60000);
      const etaMin = p.estimatedRemainingMs > 0 ? Math.ceil(p.estimatedRemainingMs / 60000) : 0;
      void sendTelegramDirect(
        prefs.botToken,
        prefs.chatId,
        `⏱️ <b>Status update</b>\n📖 ${p.completedChunks}/${p.totalChunks} chunks (${p.overallPercent}%)\n⚡ ${p.activeChunks} translating • ⏳ ${elapsedMin}m elapsed${etaMin ? ` • ~${etaMin}m left` : ""}`,
      );
    }, minutes * 60_000);
    return () => clearInterval(id);
  }, [isRunning, telegramStatusInterval]);

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

  // ─── Word counter (approximate, recalculates on any chunk change) ──
  useEffect(() => {
    const words = chunkProgress
      .filter((c) => c.status === "completed" && c.translatedText.length > 0)
      .reduce((sum, c) => sum + c.translatedText.split(/\s+/).filter(Boolean).length, 0);
    setActiveEnglishWords(words);
  }, [chunkProgress]);

  // ─── File upload handler ────────────────────────────────────────
  const handleFileContent = useCallback((content: string, name: string) => {
    setRawText(content);
    setFileName(name);
  }, []);

  // ─── Cloud worker settings persistence ──────────────────────────
  const handleWorkerUrlChange = useCallback((v: string) => {
    setWorkerUrlState(v);
    setWorkerUrl(v);
  }, []);
  const handleWorkerSecretChange = useCallback((v: string) => {
    setWorkerSecretState(v);
    setWorkerSecret(v);
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
          // 100% is covered by the dedicated completion message — skip it here
          if (pct >= lastMilestone + 25 && pct < 100 && p.completedChunks > 0) {
            lastMilestone = pct;
            sendTelegramDirect(
              prefs.botToken,
              prefs.chatId,
              `📖 <b>Translation ${pct}%</b>\n${p.completedChunks}/${p.totalChunks} chunks done\n⚡ ${p.activeChunks} in progress`,
            );
          }
        }
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
      setIsRestored(false);      // Telegram start notice (client mode only — the worker sends its own)
      const prefs = telegramPrefsRef.current;
      if (translationMode === "client" && prefs.onStart && prefs.botToken && prefs.chatId) {
        sendTelegramDirect(
          prefs.botToken,
          prefs.chatId,
          `🚀 <b>Translation started</b>\n📚 ${fileName || "novel"}\n📦 ${chunks.length} chunks • ${(rawText.length / 1000).toFixed(0)}k chars\n⚙️ Model: ${selectedModel === "openrouter/free" ? "Auto Free" : selectedModel}`,
        );
      }

      // ── Cloud mode: upload to the worker and poll — browser can close ──
      if (translationMode === "cloud") {
        setUploadPhase("chunking"); // reuse phase label while uploading
        try {
          const runner = await CloudRunner.start(
            {
              fileName: fileName || "novel.txt",
              model: selectedModel,
              keys,
              chunks: chunks.map((c) => ({ id: c.id, text: c.text })),
              liveModels: getLiveModelOrder(),
              telegramBotToken: telegramBotToken || undefined,
              telegramChatId: telegramChatId || undefined,
              telegramNotifyOnStart: telegramNotifyOnStart,
              telegramNotifyOnProgress: telegramNotifyOnProgress,
              telegramNotifyOnError: telegramNotifyOnError,
              telegramNotifyOnComplete: telegramNotifyOnComplete,
            },
            {
              onProgress: (p) => {
                setProgress(p);
                setActiveModel(p.activeModel);
                setElapsedMs(p.elapsedMs);
              },
              onChunkCompleted: async (chunkId, text) => {
                setChunkProgress((prev) =>
                  prev.map((c) =>
                    c.id === chunkId
                      ? { ...c, status: "completed" as const, translatedText: text }
                      : c,
                  ),
                );
                try {
                  await updateChunk({
                    id: chunkId,
                    text: cloudChunkTextRef.current.get(chunkId) ?? "",
                    status: "completed",
                    translatedText: text,
                  });
                } catch {
                  /* ignore */
                }
              },
              onDone: (failedChunks) => {
                setIsRunning(false);
                setIsPaused(false);
                if (failedChunks > 0) setIsPaused(true);
                setCloudJobId(runner.getJobId());
                cloudRunnerRef.current = null;
              },
              onError: (message) => {
                console.error("[Cloud]", message);
              },
            },
          );
          cloudRunnerRef.current = runner;
          setCloudJobId(runner.getJobId());
          // Keep the original text around for IndexedDB persistence
          cloudChunkTextRef.current = new Map(chunks.map((c) => [c.id, c.text]));
          setUploadPhase(null);
          setIsStarting(false);
          setIsRunning(true);
          setIsPaused(false);
          runningRef.current = true;
          return;
        } catch (err) {
          console.error("Cloud start failed:", err);
          alert(
            "Cloud start failed: " +
              (err instanceof Error ? err.message : String(err)) +
              "\n\nCheck the worker URL in Settings → Cloud Mode.",
          );
          setIsStarting(false);
          setUploadPhase(null);
          return;
        }
      }

      await acquireWakeLock();
      await runPipeline(initial);
    } catch (err) {
      console.error("Failed to start:", err);
      alert("Failed to start: " + (err instanceof Error ? err.message : String(err)));
      setIsStarting(false);
      setUploadPhase(null);
    }
  }, [canStart, rawText, fileName, chunkSize, keys, selectedModel, runPipeline, acquireWakeLock, translationMode, telegramBotToken, telegramChatId, telegramNotifyOnStart, telegramNotifyOnProgress, telegramNotifyOnError, telegramNotifyOnComplete]);

  // ─── Resume after pause/reload ──────────────────────────────────
  const resumeTranslation = useCallback(async () => {
    if (chunkProgress.length === 0) return;
    setIsResuming(true);
    try {
      // Cloud mode: re-upload the unfinished chunks as a fresh cloud job
      // (the old job was cancelled; completed chunks stay in IndexedDB).
      if (translationMode === "cloud") {
        const pending = chunkProgress.filter((c) => c.status !== "completed");
        if (pending.length === 0) {
          setIsResuming(false);
          return;
        }
        try {
          const runner = await CloudRunner.start(
            {
              fileName: fileName || "novel.txt",
              model: selectedModel,
              keys,
              chunks: pending.map((c) => ({ id: c.id, text: c.originalText })),
              liveModels: getLiveModelOrder(),
              telegramBotToken: telegramBotToken || undefined,
              telegramChatId: telegramChatId || undefined,
              telegramNotifyOnStart: telegramNotifyOnStart,
              telegramNotifyOnProgress: telegramNotifyOnProgress,
              telegramNotifyOnError: telegramNotifyOnError,
              telegramNotifyOnComplete: telegramNotifyOnComplete,
            },
            {
              onProgress: (p) => {
                setProgress(p);
                setActiveModel(p.activeModel);
                setElapsedMs(p.elapsedMs);
              },
              onChunkCompleted: async (chunkId, text) => {
                setChunkProgress((prev) =>
                  prev.map((c) =>
                    c.id === chunkId
                      ? { ...c, status: "completed" as const, translatedText: text }
                      : c,
                  ),
                );
                try {
                  await updateChunk({
                    id: chunkId,
                    text: cloudChunkTextRef.current.get(chunkId) ?? "",
                    status: "completed",
                    translatedText: text,
                  });
                } catch {
                  /* ignore */
                }
              },
              onDone: (failedChunks) => {
                setIsRunning(false);
                setIsPaused(failedChunks > 0);
                cloudRunnerRef.current = null;
              },
              onError: (message) => console.error("[Cloud]", message),
            },
          );
          cloudRunnerRef.current = runner;
          setCloudJobId(runner.getJobId());
          cloudChunkTextRef.current = new Map(
            pending.map((c) => [c.id, c.originalText]),
          );
          setIsRunning(true);
          setIsPaused(false);
          runningRef.current = true;
        } catch (err) {
          console.error("Cloud resume failed:", err);
          alert(
            "Cloud resume failed: " +
              (err instanceof Error ? err.message : String(err)),
          );
        } finally {
          setIsResuming(false);
        }
        return;
      }

      await acquireWakeLock();
      await runPipeline(chunkProgress);
    } finally {
      setTimeout(() => setIsResuming(false), 500);
    }
  }, [chunkProgress, runPipeline, acquireWakeLock, translationMode, fileName, selectedModel, keys, telegramBotToken, telegramChatId, telegramNotifyOnStart, telegramNotifyOnProgress, telegramNotifyOnError, telegramNotifyOnComplete]);

  // ─── Pause ──────────────────────────────────────────────────────
  const pauseTranslation = useCallback(() => {
    if (translationMode === "cloud") {
      void cloudRunnerRef.current?.cancel();
      cloudRunnerRef.current = null;
      setIsRunning(false);
      setIsPaused(true);
      runningRef.current = false;
      return;
    }
    pipelineRef.current?.abort();
    const prefs = telegramPrefsRef.current;
    if (prefs.onPause && prefs.botToken && prefs.chatId) {
      const p = progressRef.current;
      void sendTelegramDirect(
        prefs.botToken,
        prefs.chatId,
        `⏸️ <b>Translation paused</b>${p ? `\n📖 ${p.completedChunks}/${p.totalChunks} chunks (${p.overallPercent}%)` : ""}\nOpen the app and press Resume to continue.`,
      );
    }
  }, []);

  // ─── Stop (hard stop, same as pause for client-side) ────────────
  const stopTranslation = useCallback(() => {
    if (translationMode === "cloud") {
      void cloudRunnerRef.current?.cancel();
      cloudRunnerRef.current = null;
      setIsRunning(false);
      setIsPaused(true);
      runningRef.current = false;
      return;
    }
    pipelineRef.current?.abort();
    setIsRunning(false);
    setIsPaused(true);
    releaseWakeLock();
    const prefs = telegramPrefsRef.current;
    if (prefs.onPause && prefs.botToken && prefs.chatId) {
      const p = progressRef.current;
      void sendTelegramDirect(
        prefs.botToken,
        prefs.chatId,
        `⏹️ <b>Translation stopped</b>${p ? `\n📖 ${p.completedChunks}/${p.totalChunks} chunks (${p.overallPercent}%)` : ""}\nProgress is saved — Resume anytime.`,
      );
    }
  }, [releaseWakeLock, translationMode]);

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
      void cloudRunnerRef.current?.cancel();
      cloudRunnerRef.current = null;
    }
    try {
      await clearSession();
    } catch {
      /* ignore */
    }
    setChunkProgress([]);
    setProgress(null);
    setActiveEnglishWords(0);
    setElapsedMs(0);
    setIsRunning(false);
    setIsPaused(false);
    setIsRestored(false);
    setRestoredTotal(0);
    setRawText("");
    setFileName("");
    setShowScanResults(false);
    setCloudJobId("");
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

  // ─── Check which models are alive ───────────────────────────────
  const checkModels = useCallback(async () => {
    if (keys.length === 0) {
      alert("Add at least one API key first.");
      return;
    }
    setCheckingModels(true);
    const key = keys[0];
    const results: Record<string, "live" | "dead" | "rate-limited" | "checking"> = {};
    // Initialize all as checking
    for (const m of MODEL_OPTIONS) {
      if (m.value === "openrouter/free") continue;
      results[m.value] = "checking";
    }
    setModelAvailability({ ...results });

    // Test each model sequentially to avoid rate limits
    for (const m of MODEL_OPTIONS) {
      if (m.value === "openrouter/free") continue;
      try {
        await translateChunkSimple("Hi", key, m.value);
        results[m.value] = "live";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("RATE_LIMITED") || msg.includes("429") || msg.includes("rate limit")) {
          results[m.value] = "rate-limited";
        } else {
          results[m.value] = "dead";
        }
      }
      setModelAvailability({ ...results });
    }
    // Persist results to localStorage
    const toSave: Record<string, "live" | "dead"> = {};
    for (const [k, v] of Object.entries(results)) {
      if (v === "live") toSave[k] = "live";
      // Only mark as dead if truly dead (not rate-limited)
      if (v === "dead") toSave[k] = "dead";
      // Rate-limited models are NOT saved as dead — they're alive but quota-exceeded
    }
    saveModelAvailability(toSave);
    setCheckingModels(false);
  }, [keys]);

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

  // ─── Auth gate ──────────────────────────────────────────────────
  if (!authReady || auth === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-950">
        <div className="animate-pulse text-sm text-stone-500">Checking session…</div>
      </div>
    );
  }
  if (auth.mode === "out") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-950 px-4">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-sm rounded-3xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl p-7 text-center shadow-2xl shadow-black/40"
        >
          <p className="text-sm font-semibold text-stone-100">Sign in to continue</p>
          <p className="mt-1.5 text-xs text-stone-400 leading-relaxed">
            Your API keys and translation progress stay on this device.
          </p>
          <div className="mt-5 space-y-2.5">
            <button
              onClick={() => navigate("/auth?returnTo=%2Fdashboard")}
              className="w-full rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-5 py-2.5 text-sm font-semibold text-stone-950 shadow-lg shadow-amber-500/25 hover:shadow-amber-500/40 transition-all cursor-pointer"
            >
              Sign in with Email
            </button>
            <button
              onClick={handleGuestEntry}
              className="w-full rounded-xl border border-stone-700 bg-stone-800/60 px-5 py-2.5 text-sm font-medium text-stone-300 hover:bg-stone-800 hover:text-stone-100 transition-all cursor-pointer"
            >
              Continue as Guest
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

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
                    <Wifi className="h-3 w-3 text-green-400" />{" "}
                    {translationMode === "cloud"
                      ? "Cloud mode • Cloudflare Worker"
                      : "Client-side • Direct to OpenRouter"}
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
              {translationMode === "cloud" ? (
                <>
                  <Cloud className="h-3 w-3 text-sky-400" />
                  Runs on your Cloudflare worker
                </>
              ) : (
                <>
                  <Laptop className="h-3 w-3" />
                  Runs in your browser
                </>
              )}
            </div>
            {auth.mode === "user" && auth.email && (
              <div className="hidden sm:flex items-center gap-1.5 rounded-lg bg-stone-800 border border-stone-700 px-3 py-1.5 text-[10px] text-stone-300">
                <UserRound className="h-3 w-3 text-amber-400" />
                {auth.email}
              </div>
            )}
            {auth.mode === "guest" && (
              <div className="hidden sm:flex items-center gap-1.5 rounded-lg bg-stone-800 border border-stone-700 px-3 py-1.5 text-[10px] text-stone-400">
                <UserRound className="h-3 w-3" />
                Guest
              </div>
            )}
            <button
              onClick={handleSignOut}
              title="Sign out"
              className="flex items-center gap-1.5 rounded-lg border border-stone-700 bg-stone-800 px-2.5 py-1.5 text-[10px] font-medium text-stone-400 hover:text-stone-100 hover:bg-stone-700 transition-all cursor-pointer"
            >
              <LogOut className="h-3 w-3" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
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
        {/* Keep-tab-open banner while running (client mode) or cloud note (cloud mode) */}
        <AnimatePresence>
          {isRunning && translationMode === "client" && (
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
          {isRunning && translationMode === "cloud" && (
            <motion.div
              initial={{ opacity: 0, y: -12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <Cloud className="h-5 w-5 text-sky-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-sky-300">
                      Translating in the cloud — you can close this tab
                    </h3>
                    <p className="text-xs text-sky-200/70 mt-1">
                      Your Cloudflare worker is translating this book in the background. Reopen the
                      app anytime to check progress or download the finished .epub. Telegram updates
                      are sent by the worker too.
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
            {/* Translation Mode: Client vs Cloud */}
            <div className="rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl p-4 shadow-sm">
              <label className="text-xs font-semibold text-stone-200 block mb-2.5">
                Where translation runs
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setTranslationMode("client")}
                  disabled={isRunning || isStarting || hasSession}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
                    translationMode === "client"
                      ? "border-amber-500/50 bg-amber-500/10"
                      : "border-stone-700 bg-stone-800/60 hover:bg-stone-800",
                  )}
                >
                  <Laptop className={cn("h-4 w-4", translationMode === "client" ? "text-amber-400" : "text-stone-500")} />
                  <span className={cn("text-xs font-semibold", translationMode === "client" ? "text-amber-300" : "text-stone-300")}>
                    This Browser
                  </span>
                  <span className="text-[10px] text-stone-500 leading-tight">
                    Zero data use. Tab must stay open.
                  </span>
                </button>
                <button
                  onClick={() => setTranslationMode("cloud")}
                  disabled={isRunning || isStarting || hasSession}
                  className={cn(
                    "flex flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed",
                    translationMode === "cloud"
                      ? "border-sky-500/50 bg-sky-500/10"
                      : "border-stone-700 bg-stone-800/60 hover:bg-stone-800",
                  )}
                >
                  <Cloud className={cn("h-4 w-4", translationMode === "cloud" ? "text-sky-400" : "text-stone-500")} />
                  <span className={cn("text-xs font-semibold", translationMode === "cloud" ? "text-sky-300" : "text-stone-300")}>
                    Cloud (Cloudflare)
                  </span>
                  <span className="text-[10px] text-stone-500 leading-tight">
                    Browser can close. Uses ~2-4 MB data.
                  </span>
                </button>
              </div>
              {translationMode === "cloud" && workerUrl.trim() === "" && (
                <p className="mt-2.5 flex items-center gap-1.5 text-[10px] text-orange-300">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  Add your worker URL below to start cloud jobs.
                </p>
              )}
            </div>

            {/* Cloud worker settings (only in cloud mode) */}
            {translationMode === "cloud" && (
              <div className="rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-center gap-2 mb-3">
                  <Cloud className="h-4 w-4 text-sky-400" />
                  <span className="text-sm font-semibold text-stone-200">Cloud Worker</span>
                </div>
                <CloudSettings
                  workerUrl={workerUrl}
                  workerSecret={workerSecret}
                  onWorkerUrlChange={handleWorkerUrlChange}
                  onWorkerSecretChange={handleWorkerSecretChange}
                  disabled={isRunning || isStarting}
                />
              </div>
            )}

            {/* Model Selector */}
            <div className="rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl p-4 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-stone-200">Model</label>
                <button
                  onClick={checkModels}
                  disabled={checkingModels || keys.length === 0 || isRunning || isStarting}
                  className="flex items-center gap-1 rounded-lg border border-stone-700 bg-stone-800/60 px-2 py-1 text-[10px] font-medium text-stone-400 hover:text-stone-200 hover:bg-stone-700 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {checkingModels ? (
                    <><Loader2 className="h-3 w-3 animate-spin" /> Checking...</>
                  ) : (
                    "Check Live"
                  )}
                </button>
              </div>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isRunning || isStarting}
                className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs text-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-50 cursor-pointer"
              >
                {MODEL_OPTIONS.map((m) => {
                  const status = modelAvailability[m.value];
                  const indicator = status === "live"
                    ? " [LIVE]"
                    : status === "dead"
                      ? " [DEAD]"
                      : status === "rate-limited"
                        ? " [LIMITED]"
                        : status === "checking"
                          ? " ..."
                          : "";
                  return (
                    <option key={m.value} value={m.value}>
                      {m.label}{indicator}
                    </option>
                  );
                })}
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
                  Auto Free tries the best available model per chunk and automatically
                  skips dead or rate-limited models, falling back to the next one.
                </p>
              )}
              {/* Rate limit warning */}
              {Object.values(modelAvailability).includes("rate-limited") && (
                <div className="mt-2.5 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2">
                  <p className="text-[10px] text-yellow-300 leading-snug">
                    <strong>Daily limit hit!</strong> OpenRouter free tier allows ~50 requests/day. Add $10 credit to unlock 1000 free requests/day. Models marked [RATE LIMITED] are alive but quota-exceeded.
                  </p>
                </div>
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
                        <label className="text-xs font-medium text-stone-400">Status update every</label>
                        <select
                          value={telegramStatusInterval}
                          onChange={(e) => setTelegramStatusInterval(Number(e.target.value))}
                          disabled={isRunning}
                          className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs text-stone-200 focus:outline-none focus:ring-2 focus:ring-blue-400/30 disabled:opacity-50 cursor-pointer"
                        >
                          <option value={0}>Off — milestones only (25% steps)</option>
                          <option value={1}>Every 1 minute</option>
                          <option value={5}>Every 5 minutes</option>
                          <option value={10}>Every 10 minutes</option>
                          <option value={15}>Every 15 minutes</option>
                          <option value={30}>Every 30 minutes</option>
                        </select>
                        <p className="text-[10px] text-stone-600">
                          Periodic progress snapshots while translating. Pause or finish the run to change it.
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
                              { label: "Paused or stopped", checked: telegramNotifyOnPause, set: setTelegramNotifyOnPause },
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
                {translationMode === "cloud" ? (
                  <Cloud className="h-4 w-4" />
                ) : (
                  <Server className="h-4 w-4" />
                )}
                {translationMode === "cloud" ? "Start Cloud Translation" : "Start Translation"}
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
