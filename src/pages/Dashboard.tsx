import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useMutation, useAction, useQuery } from "convex/react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileUploader } from "@/components/translator/FileUploader";
import { KeyManager } from "@/components/translator/KeyManager";
import { ProgressPanel } from "@/components/translator/ProgressPanel";
import { SettingsPanel } from "@/components/translator/SettingsPanel";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { chunkTexts } from "@/lib/translator/chunker";
import { prepareChunkForUpload } from "@/lib/translator/compress";
import {
  loadSettings,
  saveSettings,
} from "@/lib/translator/persistence";

// Only models that are actually live and free right now. MiniMax, Qwen, GLM and
// Inkling were delisted from OpenRouter's free tier in 2026 and no longer appear.
const MODEL_OPTIONS = [
  { value: "auto_free", label: "Auto Free (Gemini first, then best free)" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (direct Google — free)" },
  { value: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite (direct Google — free)" },
  { value: "google/gemma-4-31b-it:free", label: "Gemma 4 31B — Google (free via OpenRouter)" },
  { value: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B MoE — Google (free via OpenRouter)" },
  { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free, 1M ctx)" },
  { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash (free, 262K ctx)" },
  { value: "nvidia/nemotron-3-super-120b-a12b:free", label: "Nemotron 3 Super (free, 262K ctx)" },
];

/** OpenRouter free models that were delisted — saved selections migrate to Auto Free. */
const DEAD_MODEL_VALUES = new Set([
  "minimax/minimax-m3:free",
  "qwen/qwen3.6-plus:free",
  "z-ai/glm-5.2:free",
  "qwen/qwen3-235b-a22b-07-25:free",
  "nvidia/nemotron-3.5-lightning:free",
  "thinkingmachines/inkling:free",
]);

/** A live, free OpenRouter model used when a concrete pick isn't testable. */
const OPENROUTER_TEST_MODEL = "google/gemma-4-31b-it:free";

/** Google AI Studio keys (free Gemini) start with "AIza" or "AQ." */
function isGeminiKeyClient(key: string): boolean {
  return key.startsWith("AIza") || key.startsWith("AQ.");
}

function isAutoFree(model: string): boolean {
  return model === "auto_free" || model === "openrouter/free" || model === "openrouter/auto" || model === "auto";
}

/** Map legacy/dead saved model values onto current selector ids. */
function normalizeModelValue(model: string): string {
  return isAutoFree(model) || DEAD_MODEL_VALUES.has(model) ? "auto_free" : model;
}

// ─── localStorage helpers for active job persistence ──────────────

const ACTIVE_JOB_KEY = "novelTranslator_activeJobId";

function saveActiveJobId(jobId: string | null) {
  try {
    if (jobId) {
      localStorage.setItem(ACTIVE_JOB_KEY, jobId);
    } else {
      localStorage.removeItem(ACTIVE_JOB_KEY);
    }
  } catch { /* ignore */ }
}

function loadActiveJobId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_JOB_KEY);
  } catch {
    return null;
  }
}

export default function Dashboard() {
  // ─── State ──────────────────────────────────────────────────────
  const [keys, setKeys] = useState<string[]>(() => loadSettings().keys);
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [chunkSize, setChunkSize] = useState(() => loadSettings().chunkSize);
  const [concurrency, setConcurrency] = useState(() => loadSettings().concurrency);
  const [selectedModel, setSelectedModel] = useState(() => normalizeModelValue(loadSettings().model));
  const [telegramBotToken, setTelegramBotToken] = useState(() => loadSettings().telegramBotToken);
  const [telegramChatId, setTelegramChatId] = useState(() => loadSettings().telegramChatId);
  const [telegramNotifyOnStart, setTelegramNotifyOnStart] = useState(() => loadSettings().telegramNotifyOnStart);
  const [telegramNotifyOnProgress, setTelegramNotifyOnProgress] = useState(() => loadSettings().telegramNotifyOnProgress);
  const [telegramNotifyOnError, setTelegramNotifyOnError] = useState(() => loadSettings().telegramNotifyOnError);
  const [telegramNotifyOnComplete, setTelegramNotifyOnComplete] = useState(() => loadSettings().telegramNotifyOnComplete);
  const [telegramNotifyOnPause, setTelegramNotifyOnPause] = useState(() => loadSettings().telegramNotifyOnPause);
  const [telegramStatusInterval, setTelegramStatusInterval] = useState(() => loadSettings().telegramStatusInterval);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showScanResults, setShowScanResults] = useState(false);
  const [recentlyDeletedIds, setRecentlyDeletedIds] = useState<Set<string>>(new Set());

  // Active job tracking — persisted to localStorage
  const [activeJobId, setActiveJobId] = useState<Id<"translationJobs"> | null>(() => {
    const saved = loadActiveJobId();
    return saved ? (saved as Id<"translationJobs">) : null;
  });
  const [isStarting, setIsStarting] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<"compressing" | "uploading" | null>(null);
  const [hasRecovered, setHasRecovered] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ─── Convex mutations/queries ────────────────────────────────────
  const startTranslationMutation = useMutation(api.translation.startTranslation);
  const processJobAction = useAction(api.translation.processJob);
  const abortJobMutation = useMutation(api.translation.abortJob);
  const deleteJobMutation = useMutation(api.translation.deleteJob);
  const resumeJobMutation = useMutation(api.translation.resumeJob);
  const pauseJobMutation = useMutation(api.translation.pauseJob);
  const updateJobSettingsMutation = useMutation(api.translation.updateJobSettings);
  const retranslateChineseMutation = useMutation(api.translation.retranslateChineseChunks);

  // List all jobs for auto-recovery detection
  const allJobs = useQuery(api.translation.listJobs);

  // Reactive query for active job status (updates in real-time via Convex subscriptions)
  const jobStatus = useQuery(
    api.translation.getJobStatus,
    activeJobId ? { jobId: activeJobId } : "skip"
  );

  // On-demand fetch for download/export (NOT a subscription — fetches once)
  const fetchTranslatedChunksMutation = useMutation(api.translation.fetchTranslatedChunks);

  // Scan results for Chinese characters in translated text
  const scanResults = useQuery(
    api.translation.scanForChinese,
    showScanResults && activeJobId ? { jobId: activeJobId } : "skip"
  );

  // ─── Persist settings to localStorage on change ─────────────────
  useEffect(() => {
    saveSettings({ keys, model: selectedModel, chunkSize, concurrency, telegramBotToken, telegramChatId, telegramNotifyOnStart, telegramNotifyOnProgress, telegramNotifyOnError, telegramNotifyOnComplete, telegramNotifyOnPause, telegramStatusInterval });
  }, [keys, selectedModel, chunkSize, concurrency, telegramBotToken, telegramChatId, telegramNotifyOnStart, telegramNotifyOnProgress, telegramNotifyOnError, telegramNotifyOnComplete, telegramNotifyOnPause, telegramStatusInterval]);



  // ─── Persist activeJobId to localStorage on change ──────────────
  useEffect(() => {
    saveActiveJobId(activeJobId);
  }, [activeJobId]);

  // ─── Auto-recover running/paused jobs on page reload ────────────
  useEffect(() => {
    if (hasRecovered || !allJobs) return;
    setHasRecovered(true);

    // If we already have an activeJobId, check if it still exists
    if (activeJobId) {
      const job = allJobs.find((j) => j._id === activeJobId && !recentlyDeletedIds.has(j._id));
      if (!job) {
        setActiveJobId(null);
        saveActiveJobId(null);
      }
      return;
    }

    // Look for the most recent non-deleted job (any status) to recover
    // Priority: processing > paused > completed/failed > any
    const recoverable =
      allJobs.find((j) => j.status === "processing" && !recentlyDeletedIds.has(j._id)) ??
      allJobs.find((j) => j.status === "paused" && !recentlyDeletedIds.has(j._id)) ??
      allJobs.find((j) => (j.status === "completed" || j.status === "failed") && !recentlyDeletedIds.has(j._id));
    if (recoverable) {
      setActiveJobId(recoverable._id);
      // Restore fileName from the recovered job
      setFileName(recoverable.fileName || "");
    }
  }, [allJobs, activeJobId, hasRecovered, recentlyDeletedIds]);

  // ─── Clear activeJobId if query returns no data (job was deleted) ─
  useEffect(() => {
    if (hasRecovered && activeJobId && jobStatus === undefined) {
      // Query returned undefined (not null) — means skip or loading
      // Only clear if we've already loaded once
    }
    if (hasRecovered && activeJobId && jobStatus === null) {
      // Job no longer exists on server
      setActiveJobId(null);
      saveActiveJobId(null);
    }
  }, [jobStatus, activeJobId, hasRecovered]);

  // ─── Derived state ──────────────────────────────────────────────
  const canStart = useMemo(
    () => rawText.length > 0 && keys.length > 0 && !activeJobId,
    [rawText, keys, activeJobId]
  );

  const isRunning = jobStatus?.status === "processing";
  const isPaused = jobStatus?.status === "paused";
  const isComplete = jobStatus?.status === "completed";
  const isFailed = jobStatus?.status === "failed";

  const completedCount = jobStatus?.completedCount ?? 0;
  const failedCount = jobStatus?.failedCount ?? 0;
  const totalChunks = jobStatus?.totalChunks ?? 0;
  const totalEnglishWords = jobStatus?.totalEnglishWords ?? 0;
  const processingCount = jobStatus?.processingCount ?? 0;

  // Detect stale jobs: status is "processing" but no heartbeat in 60 seconds
  // Only show stale if there are NO chunks currently being processed
  // (chunks in "processing" status means the pipeline is actively working)
  const isStale = isRunning && jobStatus?.lastHeartbeat
    ? (Date.now() - jobStatus.lastHeartbeat) > 60_000 && processingCount === 0
    : false;

  // Live elapsed timer — counts up from job creation
  useEffect(() => {
    if (isRunning && jobStatus?.createdAt) {
      // Set initial elapsed
      setElapsedMs(Date.now() - jobStatus.createdAt);
      // Tick every second
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - (jobStatus.createdAt ?? Date.now()));
      }, 1000);
      return () => {
        if (timerRef.current) clearInterval(timerRef.current);
      };
    } else {
      // Not running — freeze elapsed at current value
      if (timerRef.current) clearInterval(timerRef.current);
      if (isComplete || isFailed || isPaused) {
        // Keep showing the elapsed time from when it stopped
      } else {
        setElapsedMs(0);
      }
    }
  }, [isRunning, isComplete, isFailed, isPaused, jobStatus?.createdAt]);

  // Convert job chunks to ChunkProgress format for ProgressPanel
  const progressChunks = useMemo(() => {
    if (!jobStatus?.chunks) return [];
    return jobStatus.chunks.map((c) => ({
      id: c.id,
      status: c.status as "pending" | "translating" | "completed" | "failed",
      originalText: "",
      translatedText: "",
      tokensReceived: 0,
      error: c.error,
      retries: 0,
    }));
  }, [jobStatus?.chunks]);

  const progress = useMemo(() => {
    if (!jobStatus) return null;
    const pendingRemaining = totalChunks - completedCount - failedCount - processingCount;
    return {
      totalChunks: jobStatus.totalChunks,
      completedChunks: jobStatus.completedCount,
      failedChunks: jobStatus.failedCount,
      activeChunks: processingCount,
      overallPercent: jobStatus.percent,
      currentChunk: isRunning
        ? processingCount > 0
          ? completedCount === 0 && elapsedMs > 90_000
            ? `First chunks still generating (${completedCount}/${totalChunks}) — free models take several min per big chunk...`
            : `Processing ${processingCount} chunk${processingCount > 1 ? "s" : ""} (${completedCount}/${totalChunks} done)...`
          : `Starting next batch... (${completedCount}/${totalChunks} done)`
        : isPaused
          ? `Paused — ${completedCount} of ${totalChunks} done`
          : isComplete
            ? "All done!"
            : isFailed
              ? "Stopped"
              : `Ready — ${totalChunks} chunks`,
      elapsedMs,
      estimatedRemainingMs: 0,
      pendingRemaining,
    };
  }, [jobStatus, isRunning, isComplete, isFailed, isPaused, processingCount, completedCount, failedCount, totalChunks, elapsedMs]);

  // ─── Sync all settings (including Telegram prefs) to Convex job mid-translation ─
  useEffect(() => {
    if (!activeJobId || !isRunning) return;
    // Debounce: only update after user stops making changes
    const timer = setTimeout(() => {
      updateJobSettingsMutation({
        jobId: activeJobId,
        concurrency,
        model: selectedModel,
        apiKeys: keys,
        telegramBotToken: telegramBotToken || undefined,
        telegramChatId: telegramChatId || undefined,
        telegramNotifyOnStart,
        telegramNotifyOnProgress,
        telegramNotifyOnError,
        telegramNotifyOnComplete,
        telegramNotifyOnPause,
        telegramStatusInterval,
      }).catch((err) => console.error("Failed to update job settings:", err));
    }, 500);
    return () => clearTimeout(timer);
  }, [concurrency, selectedModel, keys, activeJobId, isRunning, updateJobSettingsMutation, telegramBotToken, telegramChatId, telegramNotifyOnStart, telegramNotifyOnProgress, telegramNotifyOnError, telegramNotifyOnComplete, telegramNotifyOnPause, telegramStatusInterval]);

  // ─── File upload handler ────────────────────────────────────────
  const handleFileContent = useCallback((content: string, name: string) => {
    setRawText(content);
    setFileName(name);
  }, []);

  // ─── Start translation (server-side) ────────────────────────────
  const startTranslation = useCallback(async () => {
    if (!canStart) return;

    setIsStarting(true);
    setUploadPhase("compressing");
    try {
      // Chunk text client-side to avoid Convex document size limits
      const textChunks = chunkTexts(rawText, chunkSize);

      // Compress every chunk (gzip) on the phone before upload so ~40-50% less
      // mobile data is sent. Falls back to plain text on older browsers.
      const compressedChunks = await Promise.all(
        textChunks.map(async (t) => prepareChunkForUpload(t))
      );

      setUploadPhase("uploading");
      const { jobId } = await startTranslationMutation({
        fileName: fileName || "unknown.txt",
        chunks: compressedChunks,
        model: selectedModel,
        chunkSize,
        concurrency,
        apiKeys: keys,
        telegramBotToken: telegramBotToken || undefined,
        telegramChatId: telegramChatId || undefined,
        telegramNotifyOnStart,
        telegramNotifyOnProgress,
        telegramNotifyOnError,
        telegramNotifyOnComplete,
        telegramNotifyOnPause,
        telegramStatusInterval,
      });

      setActiveJobId(jobId);
      saveActiveJobId(jobId);
      setIsStarting(false);
      setUploadPhase(null);

      // The server already scheduled the pipeline to start itself (inside
      // startTranslation), so translation begins even if the browser closes.
    } catch (err) {
      console.error("Failed to start translation:", err);
      alert("Failed to start: " + (err instanceof Error ? err.message : String(err)));
      setIsStarting(false);
      setUploadPhase(null);
    }
  }, [canStart, rawText, keys, chunkSize, concurrency, selectedModel, fileName, startTranslationMutation]);

  // ─── Pause translation (stops self-chaining, keeps state) ───────
  const pauseTranslation = useCallback(async () => {
    if (activeJobId) {
      try {
        await pauseJobMutation({ jobId: activeJobId });
      } catch (err) {
        console.error("Failed to pause:", err);
      }
    }
  }, [activeJobId, pauseJobMutation]);

  // ─── Stop translation (hard stop — marks as failed) ─────────────
  const stopTranslation = useCallback(async () => {
    if (activeJobId) {
      try {
        await abortJobMutation({ jobId: activeJobId });
      } catch (err) {
        console.error("Failed to abort:", err);
      }
    }
  }, [activeJobId, abortJobMutation]);

  // ─── Resume translation (after pause/stop/failure) ──────────────
  const resumeTranslation = useCallback(async () => {
    if (!activeJobId) return;
    setIsResuming(true);
    try {
      await resumeJobMutation({ jobId: activeJobId });
      // Fire-and-forget
      processJobAction({
        jobId: activeJobId,
        batchSize: concurrency,
      }).catch((err) => {
        console.error("Pipeline resume failed:", err);
      });
      // Clear loading state after a brief delay (heartbeat will clear stale)
      setTimeout(() => setIsResuming(false), 2000);
    } catch (err) {
      console.error("Failed to resume:", err);
      setIsResuming(false);
    }
  }, [activeJobId, concurrency, resumeJobMutation, processJobAction]);

  // ─── Download helper — generates EPUB from translated chunks ──
  const downloadTranslation = useCallback(
    async (chunks: { index: number; text: string }[], label: string) => {
      if (chunks.length === 0) {
        alert("No translated content to download yet.");
        return;
      }
      // Loaded on demand — keeps the EPUB/JSZip library out of the initial page download
      const { generateEpub, triggerDownload } = await import("@/lib/translator/epub");
      const title = (fileName.replace(/\.txt$/i, "") || "Translated Novel").replace(/_/g, " ");
      const epubBlob = await generateEpub(chunks, title, fileName);
      const epubName = label.replace(/\.txt$/i, ".epub");
      triggerDownload(epubBlob, epubName);
    },
    [fileName]
  );

  // ─── Export (final) ─────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (!activeJobId) return;
    try {
      const chunks = await fetchTranslatedChunksMutation({ jobId: activeJobId });
      if (!chunks || chunks.length === 0) {
        alert("No translated content to export yet.");
        return;
      }
      const baseName = (fileName.replace(/\.txt$/i, "") || "translated_novel") + ".epub";
      downloadTranslation(chunks, baseName);
    } catch (err) {
      console.error("Failed to fetch chunks for export:", err);
    }
  }, [activeJobId, fileName, downloadTranslation, fetchTranslatedChunksMutation]);

  // ─── Download Progress (partial, while running) ─────────────────
  const handleDownloadProgress = useCallback(async () => {
    if (!activeJobId) return;
    try {
      const chunks = await fetchTranslatedChunksMutation({ jobId: activeJobId });
      if (!chunks || chunks.length === 0) {
        alert("No translated chunks available yet.");
        return;
      }
      downloadTranslation(chunks, "incomplete_english.epub");
    } catch (err) {
      console.error("Failed to fetch chunks for download:", err);
    }
  }, [activeJobId, downloadTranslation, fetchTranslatedChunksMutation]);

  // ─── Reset ──────────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    if (activeJobId) {
      const jobIdToDelete = activeJobId;
      try {
        await deleteJobMutation({ jobId: activeJobId });
      } catch (err) {
        console.error("Failed to delete job:", err);
      }
      setRecentlyDeletedIds((prev) => new Set(prev).add(jobIdToDelete as string));
    }
    setActiveJobId(null);
    saveActiveJobId(null);
    setRawText("");
    setFileName("");
  }, [activeJobId, deleteJobMutation]);

  const hasTranslatedChunks = completedCount > 0;

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
              <p className="text-[10px] text-stone-400">Chinese → English • Backend Pipeline</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isRunning && (
              <div className="flex items-center gap-1.5 rounded-lg bg-green-500/10 border border-green-500/20 px-3 py-1.5 text-[10px] text-green-400">
                <Server className="h-3 w-3" />
                Server active
              </div>
            )}
            {isPaused && (
              <div className="flex items-center gap-1.5 rounded-lg bg-yellow-500/10 border border-yellow-500/20 px-3 py-1.5 text-[10px] text-yellow-400">
                <Pause className="h-3 w-3" />
                Paused
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
        {/* Server-side info banner */}
        <AnimatePresence>
          {isRunning && (
            <motion.div
              initial={{ opacity: 0, y: -12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-green-500/30 bg-green-500/10 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <Server className="h-5 w-5 text-green-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-green-300">
                      Translation running on Convex servers
                    </h3>
                    <p className="text-xs text-green-200/70 mt-1">
                      This translation continues even if you close the browser tab.
                      Come back anytime to check progress.
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Stale job banner — pipeline stopped, needs resume */}
        <AnimatePresence>
          {isStale && (
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
                      Translation pipeline stopped
                    </h3>
                    <p className="text-xs text-orange-200/70 mt-1">
                      The server-side pipeline appears to have stopped. {completedCount} of {totalChunks} chunks completed.
                      Click Resume to continue from where it left off.
                    </p>
                    <div className="flex items-center gap-3 mt-3">
                      <button
                        onClick={resumeTranslation}
                        disabled={isResuming}
                        className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-semibold text-stone-950 shadow-md hover:shadow-lg transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isResuming ? (
                          <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Resuming...</>
                        ) : (
                          <><Play className="h-3.5 w-3.5" /> Resume Translation</>
                        )}
                      </button>
                      <button
                        onClick={handleReset}
                        className="flex items-center gap-1.5 rounded-xl border border-stone-700 bg-stone-800 px-4 py-2 text-xs font-medium text-stone-300 hover:bg-stone-700 transition-all cursor-pointer"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Start Over
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Paused banner */}
        <AnimatePresence>
          {isPaused && (
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
                      <strong>{jobStatus?.fileName}</strong> — {completedCount} of{" "}
                      {totalChunks} chunks completed. The server pipeline has stopped.
                    </p>
                    <div className="flex items-center gap-3 mt-3">
                      <button
                        onClick={resumeTranslation}
                        disabled={isResuming}
                        className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-semibold text-stone-950 shadow-md hover:shadow-lg transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isResuming ? (
                          <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Resuming...</>
                        ) : (
                          <><Play className="h-3.5 w-3.5" /> Resume Translation</>
                        )}
                      </button>
                      <button
                        onClick={handleReset}
                        className="flex items-center gap-1.5 rounded-xl border border-stone-700 bg-stone-800 px-4 py-2 text-xs font-medium text-stone-300 hover:bg-stone-700 transition-all cursor-pointer"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Start Over
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Interrupted/Failed run info */}
        <AnimatePresence>
          {isFailed && !isRunning && (
            <motion.div
              initial={{ opacity: 0, y: -12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-amber-300">
                      Interrupted run detected
                    </h3>
                    <p className="text-xs text-amber-200/70 mt-1">
                      <strong>{jobStatus?.fileName}</strong> — {completedCount} of{" "}
                      {totalChunks} chunks completed.
                      {failedCount > 0 ? ` ${failedCount} failed.` : ""}
                    </p>
                    <div className="flex items-center gap-3 mt-3">
                      <button
                        onClick={resumeTranslation}
                        disabled={isResuming}
                        className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-semibold text-stone-950 shadow-md hover:shadow-lg transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isResuming ? (
                          <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Resuming...</>
                        ) : (
                          <><Zap className="h-3.5 w-3.5" /> Resume Translation</>
                        )}
                      </button>
                      <button
                        onClick={handleReset}
                        className="flex items-center gap-1.5 rounded-xl border border-stone-700 bg-stone-800 px-4 py-2 text-xs font-medium text-stone-300 hover:bg-stone-700 transition-all cursor-pointer"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        Start Over
                      </button>
                    </div>
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
            <FileUploader onFileContent={handleFileContent} disabled={isRunning || isStarting || isPaused} />
            {rawText.length > 0 && (
              <div className="flex items-center gap-4 text-[11px] text-stone-400 px-1">
                <span>📄 {rawText.length.toLocaleString()} characters</span>
                <span>📦 ~{Math.ceil(rawText.length / chunkSize)} chunks</span>
                {isComplete && (
                  <span className="text-green-400 font-medium">✅ Translation complete</span>
                )}
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
                disabled={isStarting}
                className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs text-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-50 cursor-pointer"
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>

              {/* Live model info — shows exactly which model is doing the work right now */}
              <div className="mt-2 space-y-1.5">
                {jobStatus?.activeModel ? (
                  <>
                    <p className="text-[10px] text-stone-400 flex items-center gap-1">
                      <Zap className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                      Now translating with{" "}
                      <span className="font-mono font-semibold text-amber-400">
                    {jobStatus.activeModel.split("/").pop()?.replace(/:free$/, "")}
                  </span>
                  {isAutoFree(selectedModel) ? " (Auto Free picked it)" : ""}
                    </p>
                    {selectedModel !== "auto_free" &&
                      jobStatus.activeModel !== selectedModel && (
                        <p className="text-[10px] text-stone-500 leading-snug">
                          Your pick is rate-limited or overloaded right now, so it fell back to the
                          next working free model. It switches back automatically when available.
                        </p>
                      )}
                  </>
                ) : (isRunning || isPaused) && isAutoFree(selectedModel) ? (
                  <p className="text-[10px] text-stone-500 leading-snug">
                    Auto Free tries free Gemini first (needs a Google AI Studio key), then MiniMax
                    → Qwen → GLM → more with your OpenRouter keys, skipping anything rate-limited.
                    The line above shows which model is actually translating.
                  </p>
                ) : null}
              </div>
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
                    settingsOpen && "rotate-180"
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
                        chunkSizeDisabled={isRunning || isStarting || isPaused}
                      />
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Telegram Notifications */}
            <div className="rounded-2xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl shadow-sm overflow-hidden mt-4">
              <button
                onClick={() => {
                  const el = document.getElementById("telegram-settings");
                  if (el) el.style.display = el.style.display === "none" ? "block" : "none";
                }}
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
                  {jobStatus?.telegramLastError && (
                    <span className="inline-flex items-center rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-medium text-red-400">
                      ⚠ Sending failed
                    </span>
                  )}
                </div>
                <ChevronDown className="h-4 w-4 text-stone-400" />
              </button>
              <div id="telegram-settings" style={{ display: "none" }} className="px-4 pb-4 pt-0 space-y-3">
                <p className="text-[11px] text-stone-500">
                  Get notified about translation events. Optional — leave blank to disable.
                </p>
                {jobStatus?.telegramLastError && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
                    <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    <div className="text-[11px] text-red-300 space-y-1">
                      <p className="font-semibold">
                        The last Telegram message failed to send
                      </p>
                      <p className="break-words">{jobStatus.telegramLastError}</p>
                      <p className="text-red-300/70">
                        Fix the bot token / chat ID above, then the next notification retries
                        automatically. Tip: you must open the chat with your bot in Telegram
                        (press Start) before it can message you.
                      </p>
                    </div>
                  </div>
                )}
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
                    Message @userinfobot on Telegram to find your Chat ID. Separate multiple IDs with commas.
                  </p>
                </div>

                {/* Notification preferences */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-stone-400">Notify me when...</label>
                  <div className="space-y-1.5">
                    {[
                      { label: "Translation starts", checked: telegramNotifyOnStart, set: setTelegramNotifyOnStart },
                      { label: "Progress milestones (every 10%)", checked: telegramNotifyOnProgress, set: setTelegramNotifyOnProgress },
                      { label: "A chunk fails (error)", checked: telegramNotifyOnError, set: setTelegramNotifyOnError },
                      { label: "Translation completes", checked: telegramNotifyOnComplete, set: setTelegramNotifyOnComplete },
                      { label: "Pipeline pauses/stops", checked: telegramNotifyOnPause, set: setTelegramNotifyOnPause },
                    ].map(({ label, checked, set }) => (
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

                {/* Periodic status updates */}
                <div className="space-y-2">
                  <label className="text-xs font-medium text-stone-400">Periodic Status Updates</label>
                  <select
                    value={telegramStatusInterval}
                    onChange={(e) => setTelegramStatusInterval(Number(e.target.value))}
                    className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs text-stone-200 focus:outline-none focus:ring-2 focus:ring-blue-400/30 cursor-pointer"
                  >
                    <option value={0}>Off</option>
                    <option value={5}>Every 5 minutes</option>
                    <option value={10}>Every 10 minutes</option>
                    <option value={15}>Every 15 minutes</option>
                    <option value={30}>Every 30 minutes</option>
                  </select>
                  <p className="text-[10px] text-stone-600">
                    Sends a detailed status summary with words translated, model used, and ETA.
                  </p>
                </div>
              </div>
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
              chunks={progressChunks}
              isRunning={!!isRunning}
              isComplete={!!isComplete}
              totalEnglishWords={totalEnglishWords}
              activeModel={jobStatus?.activeModel}
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
          {!isRunning && !isStarting && !activeJobId && (
            <>
              <button
                onClick={startTranslation}
                disabled={!canStart}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-semibold transition-all shadow-lg cursor-pointer",
                  canStart
                    ? "bg-gradient-to-r from-amber-500 to-amber-600 text-stone-950 shadow-amber-500/25 hover:shadow-amber-500/40 hover:scale-[1.02] active:scale-[0.98]"
                    : "bg-stone-800 text-stone-500 cursor-not-allowed shadow-none"
                )}
              >
                <Server className="h-4 w-4" />
                Start Server Translation
              </button>
              {keys.length > 0 && (
                <button
                  onClick={async () => {
                    try {
                      // Loaded on demand — only downloaded when the button is tapped.
                      // Each key is tested against the provider its format belongs to.
                      const { testApiKey } = await import("@/lib/translator/gemini-api");
                      const lines: string[] = [];
                      for (let i = 0; i < keys.length; i++) {
                        const key = keys[i];
                        try {
                          const provider = await testApiKey(key);
                          lines.push(`Key ${i + 1} (…${key.slice(-4)}): ✅ works — ${provider}`);
                        } catch (err2) {
                          const msg = err2 instanceof Error ? err2.message : String(err2);
                          lines.push(`Key ${i + 1} (…${key.slice(-4)}): ❌ ${msg.slice(0, 140)}`);
                        }
                      }
                      const okCount = lines.filter((l) => l.includes("✅")).length;
                      alert(`Key check — ${okCount}/${keys.length} valid:\n\n${lines.join("\n\n")}\n\nRemove the ❌ keys from the list (they will fail every chunk).`);
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      alert(`❌ Key test failed: ${msg.slice(0, 200)}`);
                    }
                  }}
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
              {uploadPhase === "compressing"
                ? "Compressing file… (saves data)"
                : uploadPhase === "uploading"
                  ? "Uploading…"
                  : "Starting..."}
            </button>
          )}

          {/* Running: Pause + Stop */}
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

          {/* Paused: Resume */}
          {isPaused && !isRunning && (
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

          {/* Download Progress — available while running, paused, or failed */}
          {(isRunning || isPaused || isFailed) && (
            <button
              onClick={handleDownloadProgress}
              disabled={!hasTranslatedChunks}
              className="relative z-10 flex items-center gap-2 rounded-xl border border-green-500/30 bg-green-500/10 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-green-300 hover:bg-green-500/20 active:bg-green-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Download className="h-4 w-4" />
              {hasTranslatedChunks ? `Download Progress (${completedCount} chunks)` : "Download Progress (waiting for chunks...)"}
            </button>
          )}

          {/* Export Complete — only when fully done */}
          {isComplete && hasTranslatedChunks && (
            <>
              <button
                onClick={handleExport}
                className="relative z-10 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 backdrop-blur-md px-5 py-2.5 text-sm font-medium text-amber-300 hover:bg-amber-500/20 active:bg-amber-500/30 transition-all cursor-pointer"
                style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
              >
                <Download className="h-4 w-4" />
                Download Complete ({completedCount} chunks)
              </button>
              <button
                onClick={() => setShowScanResults(!showScanResults)}
                className="relative z-10 flex items-center gap-2 rounded-xl border border-purple-500/30 bg-purple-500/10 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-purple-300 hover:bg-purple-500/20 active:bg-purple-500/30 transition-all cursor-pointer"
                style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
              >
                {showScanResults ? "Hide" : "Scan for Chinese"}
              </button>
            </>
          )}

          {(isRunning || isComplete || isFailed || isPaused || isStarting) && (
            <button
              onClick={handleReset}
              className="flex items-center gap-2 rounded-xl border border-stone-700 bg-stone-800 px-4 py-2.5 text-sm font-medium text-stone-300 hover:bg-stone-700 transition-all cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
          )}

          {!canStart && !isRunning && !isStarting && !activeJobId && (
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
          {showScanResults && scanResults && (
            <motion.div
              initial={{ opacity: 0, y: 12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: 12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-purple-500/30 bg-purple-500/10 backdrop-blur-xl p-4 shadow-sm">                  <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-purple-300">
                    Chinese Character Scan Results
                  </h3>
                  <div className="flex items-center gap-3">
                    {scanResults.chunksWithChinese.length > 0 && activeJobId && (
                      <button
                        onClick={async () => {
                          try {
                            const result = await retranslateChineseMutation({ jobId: activeJobId });
                            setShowScanResults(false);
                            processJobAction({ jobId: activeJobId, batchSize: concurrency }).catch(console.error);
                            alert(`Reset ${result.resetCount} chunks for re-translation. Pipeline restarted.`);
                          } catch (err) {
                            alert("Failed: " + (err instanceof Error ? err.message : String(err)));
                          }
                        }}
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
                    <p className="text-sm font-medium">All {scanResults.totalScanned} chunks are clean — zero Chinese characters found!</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-xs text-purple-200/70">
                      Found Chinese characters in {scanResults.chunksWithChinese.length} of {scanResults.totalScanned} chunks:
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

        {/* Past Translations list */}
        {(() => {
          const visibleJobs = allJobs?.filter((j) => !recentlyDeletedIds.has(j._id)) ?? [];
          return visibleJobs.length > 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="space-y-3"
          >
            <h3 className="text-xs font-semibold text-stone-400 uppercase tracking-wider px-1">
              Past Translations ({visibleJobs.length})
            </h3>
            <div className="space-y-2">
              {visibleJobs.map((job) => (
                <div
                  key={job._id}
                  onClick={() => {
                    if (activeJobId !== job._id) {
                      setActiveJobId(job._id);
                      saveActiveJobId(job._id);
                    }
                  }}
                  className={cn(
                    "flex items-center justify-between rounded-xl border px-4 py-3 transition-all cursor-pointer",
                    activeJobId === job._id
                      ? "border-amber-500/30 bg-amber-500/10"
                      : "border-stone-700/50 bg-stone-900/80 hover:bg-stone-800/80 hover:border-stone-600/50",
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={cn(
                      "h-2 w-2 rounded-full shrink-0",
                      job.status === "processing"
                        ? "bg-green-400 animate-pulse"
                        : job.status === "paused"
                          ? "bg-yellow-400"
                          : job.status === "completed"
                            ? "bg-blue-400"
                            : job.status === "failed"
                              ? "bg-red-400"
                              : "bg-stone-500",
                    )} />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-stone-200 truncate">{job.fileName}</p>
                      <p className="text-[10px] text-stone-500">
                        {job.completedCount}/{job.totalChunks} chunks • {job.percent}%
                        {job.status === "completed" ? " • ✅ Done" : job.status === "processing" ? " • ⏳ Running..." : job.status === "paused" ? " • ⏸️ Paused" : job.status === "failed" ? " • ❌ Failed" : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveJobId(job._id);
                        saveActiveJobId(job._id);
                        setFileName(job.fileName || "");
                      }}
                      className="rounded-lg border border-stone-700 bg-stone-800 px-2.5 py-1 text-[10px] font-medium text-stone-400 hover:bg-stone-700 hover:text-stone-200 transition-all cursor-pointer"
                    >
                      View
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!confirm(`Delete ${job.fileName}?`)) return;
                        try {
                          await deleteJobMutation({ jobId: job._id });
                          setRecentlyDeletedIds((prev) => new Set(prev).add(job._id as string));
                          if (activeJobId === job._id) {
                            setActiveJobId(null);
                            saveActiveJobId(null);
                            setFileName("");
                          }
                        } catch (err) {
                          console.error("Failed to delete:", err);
                        }
                      }}
                      className="rounded-lg border border-stone-700 bg-stone-800 px-2.5 py-1 text-[10px] font-medium text-stone-500 hover:bg-red-500/10 hover:text-red-400 hover:border-red-500/30 transition-all cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
          ) : null;
        })()}
      </main>
    </div>
  );
}
