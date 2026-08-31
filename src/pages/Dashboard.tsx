import { useState, useCallback, useMemo, useEffect } from "react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileUploader } from "@/components/translator/FileUploader";
import { KeyManager } from "@/components/translator/KeyManager";
import { ProgressPanel } from "@/components/translator/ProgressPanel";
import { SettingsPanel } from "@/components/translator/SettingsPanel";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { translateChunkSimple } from "@/lib/translator/gemini-api";
import { chunkTexts } from "@/lib/translator/chunker";
import {
  loadSettings,
  saveSettings,
} from "@/lib/translator/persistence";

const MODEL_OPTIONS = [
  { value: "openrouter/free", label: "Auto Free (best available)" },
  { value: "minimax/minimax-m3:free", label: "MiniMax M3 (free, 1M ctx)" },
  { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free, 1M ctx)" },
  { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash (free, 262K ctx)" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (paid)" },
];

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
  const [selectedModel, setSelectedModel] = useState(() => loadSettings().model);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Active job tracking — persisted to localStorage
  const [activeJobId, setActiveJobId] = useState<Id<"translationJobs"> | null>(() => {
    const saved = loadActiveJobId();
    return saved ? (saved as Id<"translationJobs">) : null;
  });
  const [isStarting, setIsStarting] = useState(false);
  const [hasRecovered, setHasRecovered] = useState(false);

  // ─── Convex mutations/queries ────────────────────────────────────
  const startTranslationMutation = useMutation(api.translation.startTranslation);
  const processJobAction = useAction(api.translation.processJob);
  const abortJobMutation = useMutation(api.translation.abortJob);
  const deleteJobMutation = useMutation(api.translation.deleteJob);
  const resumeJobMutation = useMutation(api.translation.resumeJob);
  const pauseJobMutation = useMutation(api.translation.pauseJob);

  // List all jobs for auto-recovery detection
  const allJobs = useQuery(api.translation.listJobs);

  // Reactive query for active job status (updates in real-time via Convex subscriptions)
  const jobStatus = useQuery(
    api.translation.getJobStatus,
    activeJobId ? { jobId: activeJobId } : "skip"
  );

  // Always query translated chunks (for partial download AND final export)
  const translatedChunks = useQuery(
    api.translation.getTranslatedChunks,
    activeJobId ? { jobId: activeJobId } : "skip"
  );

  // ─── Persist settings to localStorage on change ─────────────────
  useEffect(() => {
    saveSettings({ keys, model: selectedModel, chunkSize, concurrency });
  }, [keys, selectedModel, chunkSize, concurrency]);

  // ─── Persist activeJobId to localStorage on change ──────────────
  useEffect(() => {
    saveActiveJobId(activeJobId);
  }, [activeJobId]);

  // ─── Auto-recover running/paused jobs on page reload ────────────
  useEffect(() => {
    if (hasRecovered || !allJobs) return;
    setHasRecovered(true);

    // If we already have an activeJobId, check if it's still valid
    if (activeJobId) {
      const job = allJobs.find((j) => j._id === activeJobId);
      if (!job) {
        // Job was deleted — clear
        setActiveJobId(null);
      }
      return;
    }

    // Look for the most recent processing or paused job
    const recoverable = allJobs.find(
      (j) => j.status === "processing" || j.status === "paused"
    );
    if (recoverable) {
      setActiveJobId(recoverable._id);
    }
  }, [allJobs, activeJobId, hasRecovered]);

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

  // Convert job chunks to ChunkProgress format for ProgressPanel
  const chunkProgress = useMemo(() => {
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
    return {
      totalChunks: jobStatus.totalChunks,
      completedChunks: jobStatus.completedCount,
      failedChunks: jobStatus.failedCount,
      activeChunks: processingCount,
      overallPercent: jobStatus.percent,
      currentChunk: isRunning
        ? `Processing chunk ${completedCount + 1} of ${totalChunks}...`
        : isPaused
          ? `Paused — ${completedCount} of ${totalChunks} done`
          : isComplete
            ? "All done!"
            : isFailed
              ? "Stopped"
              : "Ready",
      elapsedMs: 0,
      estimatedRemainingMs: 0,
    };
  }, [jobStatus, isRunning, isComplete, isFailed, isPaused, processingCount, completedCount, totalChunks]);

  // ─── File upload handler ────────────────────────────────────────
  const handleFileContent = useCallback((content: string, name: string) => {
    setRawText(content);
    setFileName(name);
  }, []);

  // ─── Start translation (server-side) ────────────────────────────
  const startTranslation = useCallback(async () => {
    if (!canStart) return;

    setIsStarting(true);
    try {
      // Chunk text client-side to avoid Convex document size limits
      const textChunks = chunkTexts(rawText, chunkSize);

      const { jobId } = await startTranslationMutation({
        fileName: fileName || "unknown.txt",
        chunks: textChunks.map((t) => ({ text: t })),
        model: selectedModel,
        chunkSize,
        concurrency,
        apiKeys: keys,
      });

      setActiveJobId(jobId);
      saveActiveJobId(jobId);
      setIsStarting(false);

      // Fire-and-forget: start the server-side pipeline.
      processJobAction({
        jobId,
        batchSize: concurrency,
      }).catch((err) => {
        console.error("Pipeline action failed:", err);
      });
    } catch (err) {
      console.error("Failed to start translation:", err);
      alert("Failed to start: " + (err instanceof Error ? err.message : String(err)));
      setIsStarting(false);
    }
  }, [canStart, rawText, keys, chunkSize, concurrency, selectedModel, fileName, startTranslationMutation, processJobAction]);

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
    try {
      await resumeJobMutation({ jobId: activeJobId });
      // Fire-and-forget
      processJobAction({
        jobId: activeJobId,
        batchSize: concurrency,
      }).catch((err) => {
        console.error("Pipeline resume failed:", err);
      });
    } catch (err) {
      console.error("Failed to resume:", err);
    }
  }, [activeJobId, concurrency, resumeJobMutation, processJobAction]);

  // ─── Download helper (works for both partial and final) ─────────
  const downloadTranslation = useCallback(
    (chunks: { index: number; text: string }[], label: string) => {
      if (chunks.length === 0) {
        alert("No translated content to download yet.");
        return;
      }
      const stitched = chunks
        .sort((a, b) => a.index - b.index)
        .map((c) => c.text)
        .join("\n\n");
      const blob = new Blob([stitched], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = label;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
    []
  );

  // ─── Export (final) ─────────────────────────────────────────────
  const handleExport = useCallback(() => {
    if (!translatedChunks || translatedChunks.length === 0) {
      alert("No translated content to export yet.");
      return;
    }
    const baseName = (fileName.replace(/\.txt$/i, "") || "translated_novel") + ".txt";
    downloadTranslation(translatedChunks, baseName);
  }, [translatedChunks, fileName, downloadTranslation]);

  // ─── Download Progress (partial, while running) ─────────────────
  const handleDownloadProgress = useCallback(() => {
    if (!translatedChunks || translatedChunks.length === 0) {
      alert("No translated chunks available yet.");
      return;
    }
    downloadTranslation(translatedChunks, "incomplete_english.txt");
  }, [translatedChunks, downloadTranslation]);

  // ─── Reset ──────────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    if (activeJobId) {
      try {
        await deleteJobMutation({ jobId: activeJobId });
      } catch (err) {
        console.error("Failed to delete job:", err);
      }
    }
    setActiveJobId(null);
    saveActiveJobId(null);
    setRawText("");
    setFileName("");
  }, [activeJobId, deleteJobMutation]);

  const hasTranslatedChunks = translatedChunks && translatedChunks.length > 0;

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
                        className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-semibold text-stone-950 shadow-md hover:shadow-lg transition-all cursor-pointer"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Resume Translation
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
                        className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-semibold text-stone-950 shadow-md hover:shadow-lg transition-all cursor-pointer"
                      >
                        <Zap className="h-3.5 w-3.5" />
                        Resume Translation
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
                disabled={isRunning || isStarting || isPaused}
                className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs text-stone-200 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-50 cursor-pointer"
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
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
                        disabled={isRunning || isStarting || isPaused}
                      />
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
              isRunning={!!isRunning}
              isComplete={!!isComplete}
              totalEnglishWords={totalEnglishWords}
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
                      const result = await translateChunkSimple(
                        "你好世界 Hello World",
                        keys[0],
                        selectedModel
                      );
                      alert(`✅ Key works! Response: ${result.slice(0, 100)}`);
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      alert(`❌ Key test failed: ${msg.slice(0, 200)}`);
                    }
                  }}
                  className="flex items-center gap-2 rounded-xl border border-stone-700 bg-stone-800 px-4 py-2.5 text-xs font-medium text-stone-300 hover:bg-stone-700 transition-all cursor-pointer"
                >
                  <Zap className="h-3.5 w-3.5" />
                  Test Key
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
              Starting...
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
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-6 py-2.5 text-sm font-semibold text-stone-950 shadow-lg shadow-amber-500/25 hover:shadow-amber-500/40 hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer"
            >
              <Play className="h-4 w-4" />
              Resume Translation
            </button>
          )}

          {/* Download Progress — available while running, paused, or failed with chunks */}
          {(isRunning || isPaused || isFailed) && hasTranslatedChunks && (
            <button
              onClick={handleDownloadProgress}
              className="relative z-10 flex items-center gap-2 rounded-xl border border-green-500/30 bg-green-500/10 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-green-300 hover:bg-green-500/20 active:bg-green-500/30 transition-all cursor-pointer"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Download className="h-4 w-4" />
              Download Progress ({translatedChunks!.length} chunks)
            </button>
          )}

          {/* Export Complete — only when fully done */}
          {isComplete && hasTranslatedChunks && (
            <button
              onClick={handleExport}
              className="relative z-10 flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 backdrop-blur-md px-5 py-2.5 text-sm font-medium text-amber-300 hover:bg-amber-500/20 active:bg-amber-500/30 transition-all cursor-pointer"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Download className="h-4 w-4" />
              Download Complete ({translatedChunks!.length} chunks)
            </button>
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
      </main>
    </div>
  );
}
