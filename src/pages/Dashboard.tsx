import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Play,
  Square,
  Download,
  Sparkles,
  BookOpen,
  RotateCcw,
  Zap,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { FileUploader } from "@/components/translator/FileUploader";
import { KeyManager } from "@/components/translator/KeyManager";
import { ProgressPanel } from "@/components/translator/ProgressPanel";
import { SettingsPanel } from "@/components/translator/SettingsPanel";
import {
  TranslationPipeline,
  type PipelineProgress,
  type ChunkProgress,
} from "@/lib/translator/pipeline";
import { DEFAULT_MODEL, translateChunkSimple } from "@/lib/translator/gemini-api";
import {
  loadSettings,
  saveSettings,
  saveSession,
  loadSession,
  updateChunk,
  clearSession,
  type StoredChunk,
  type StoredSession,
} from "@/lib/translator/persistence";

const MODEL_OPTIONS = [
  { value: "openrouter/free", label: "Auto Free (best available)" },
  { value: "minimax/minimax-m3:free", label: "MiniMax M3 (free, 1M ctx)" },
  { value: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (free, 1M ctx)" },
  { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash (free, 262K ctx)" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (paid)" },
];

export default function Dashboard() {
  // ─── State ──────────────────────────────────────────────────────
  const [keys, setKeys] = useState<string[]>(() => loadSettings().keys);
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [chunkProgress, setChunkProgress] = useState<ChunkProgress[]>([]);
  const [chunkSize, setChunkSize] = useState(() => loadSettings().chunkSize);
  const [concurrency, setConcurrency] = useState(() => loadSettings().concurrency);
  const [finalResults, setFinalResults] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState(() => loadSettings().model);

  // Resume state
  const [interruptedRun, setInterruptedRun] = useState<StoredSession | null>(null);
  const [pendingChunks, setPendingChunks] = useState<StoredChunk[]>([]);

  const pipelineRef = useRef<TranslationPipeline | null>(null);

  // ─── Persist settings to localStorage on change ─────────────────
  useEffect(() => {
    saveSettings({ keys, model: selectedModel, chunkSize, concurrency });
  }, [keys, selectedModel, chunkSize, concurrency]);

  // ─── Check for interrupted run on mount ─────────────────────────
  useEffect(() => {
    loadSession().then((result) => {
      if (result) {
        const { session, chunks } = result;
        const pending = chunks.filter((c) => c.status === "pending");
        if (pending.length > 0) {
          // There are unfinished chunks — offer resume
          setInterruptedRun(session);
          setPendingChunks(chunks);
          setFileName(session.fileName);
          setRawText(chunks.map((c) => c.text).join("\n\n"));
          setChunkProgress(
            chunks.map((c) => ({
              id: c.id,
              status: c.status,
              originalText: c.text,
              translatedText: c.translatedText,
              tokensReceived: 0,
              error: undefined,
              retries: 0,
            }))
          );
          setProgress({
            totalChunks: session.totalChunks,
            completedChunks: chunks.filter((c) => c.status === "completed").length,
            failedChunks: 0,
            activeChunks: 0,
            overallPercent: Math.round(
              (chunks.filter((c) => c.status === "completed").length / session.totalChunks) * 100
            ),
            currentChunk: "Paused",
            elapsedMs: 0,
            estimatedRemainingMs: 0,
          });
        } else {
          // All chunks were completed — clear stale session
          clearSession();
        }
      }
    });
  }, []);

  // ─── Derived ────────────────────────────────────────────────────
  const canStart = useMemo(
    () => rawText.length > 0 && keys.length > 0 && !isRunning,
    [rawText, keys, isRunning]
  );

  const completedCount = useMemo(
    () => chunkProgress.filter((c) => c.status === "completed").length,
    [chunkProgress]
  );

  // ─── Chunk persistence helper ───────────────────────────────────
  const persistChunks = useCallback(async (chunks: string[], session: StoredSession) => {
    const storedChunks: StoredChunk[] = chunks.map((text, i) => ({
      id: i,
      text,
      status: "pending" as const,
      translatedText: "",
    }));
    await saveSession(session, storedChunks);
  }, []);

  const markChunkCompleted = useCallback(async (id: number, translatedText: string) => {
    await updateChunk({ id, text: "", status: "completed", translatedText });
  }, []);

  // ─── File upload handler ────────────────────────────────────────
  const handleFileContent = useCallback(
    async (content: string, name: string) => {
      setRawText(content);
      setFileName(name);
      setIsComplete(false);
      setFinalResults([]);
      setChunkProgress([]);
      setProgress(null);
      setInterruptedRun(null);

      // Pre-chunk and persist to IndexedDB
      const { chunkTexts } = await import("@/lib/translator/chunker");
      const chunks = chunkTexts(content, chunkSize);
      const session: StoredSession = {
        id: "current",
        fileName: name,
        rawTextLength: content.length,
        totalChunks: chunks.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await persistChunks(chunks, session);
    },
    [chunkSize, persistChunks]
  );

  // ─── Resume handler ─────────────────────────────────────────────
  const handleResume = useCallback(() => {
    setInterruptedRun(null);
    // rawText, chunkProgress, and progress are already restored from mount effect
    setIsComplete(false);
  }, []);

  // ─── Start translation ──────────────────────────────────────────
  const startTranslation = useCallback(async () => {
    if (!canStart) return;

    setIsRunning(true);
    setIsComplete(false);
    setFinalResults([]);

    const pipeline = new TranslationPipeline();
    pipelineRef.current = pipeline;

    // Track which chunks we've already persisted to avoid redundant writes
    const persistedChunks = new Set<number>();

    pipeline.setProgressCallback((p) => {
      setProgress(p);
      const chunks = [...pipeline.getChunkProgress()];
      setChunkProgress(chunks);
      // Persist newly completed chunks to IndexedDB immediately
      chunks.forEach((c) => {
        if (c.status === "completed" && !persistedChunks.has(c.id)) {
          persistedChunks.add(c.id);
          markChunkCompleted(c.id, c.translatedText);
        }
      });
    });

    pipeline.setTokenCallback(() => {
      setChunkProgress([...pipeline.getChunkProgress()]);
    });

    try {
      const results = await pipeline.start(rawText, keys, {
        chunkSize,
        concurrency,
        maxRetries: 3,
        model: selectedModel,
      });

      setFinalResults(results);
      setChunkProgress([...pipeline.getChunkProgress()]);
      setIsComplete(true);

      // Persist completed chunks
      const chunks = pipeline.getChunkProgress();
      const session: StoredSession = {
        id: "current",
        fileName: fileName || "unknown.txt",
        rawTextLength: rawText.length,
        totalChunks: chunks.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const storedChunks: StoredChunk[] = chunks.map((c) => ({
        id: c.id,
        text: c.originalText,
        status: "completed",
        translatedText: c.translatedText,
      }));
      await saveSession(session, storedChunks);
    } catch (err) {
      console.error("Pipeline error:", err);
    } finally {
      setIsRunning(false);
    }
  }, [canStart, rawText, keys, chunkSize, concurrency, selectedModel, fileName]);

  // ─── Resume translation (skip completed chunks) ─────────────────
  const startResumeTranslation = useCallback(async () => {
    if (!rawText || keys.length === 0) return;

    setIsRunning(true);
    setIsComplete(false);
    setFinalResults([]);

    // Find completed and pending chunk IDs
    const completedIds = chunkProgress
      .filter((c) => c.status === "completed")
      .map((c) => c.id);
    const pendingIds = chunkProgress
      .filter((c) => c.status === "pending")
      .map((c) => c.id);

    if (pendingIds.length === 0) {
      setIsRunning(false);
      setIsComplete(true);
      setFinalResults(chunkProgress.map((c) => c.translatedText));
      return;
    }

    // Save pre-completed results
    const preCompleted = new Map<number, string>();
    chunkProgress.forEach((c) => {
      if (c.status === "completed") preCompleted.set(c.id, c.translatedText);
    });

    const pipeline = new TranslationPipeline();
    pipelineRef.current = pipeline;

    // Track which new chunks we've persisted
    const persistedChunks = new Set<number>(completedIds);

    pipeline.setProgressCallback((p) => {
      setProgress(p);
      // Merge pipeline progress with stored completed chunks
      const liveChunks = [...pipeline.getChunkProgress()];
      const merged: ChunkProgress[] = liveChunks.map((lc) => {
        if (lc.status === "pending" && preCompleted.has(lc.id)) {
          return {
            ...lc,
            status: "completed" as const,
            translatedText: preCompleted.get(lc.id) || "",
          };
        }
        return lc;
      });
      setChunkProgress(merged);
      // Persist newly completed chunks to IndexedDB
      liveChunks.forEach((lc) => {
        if (lc.status === "completed" && !persistedChunks.has(lc.id)) {
          persistedChunks.add(lc.id);
          markChunkCompleted(lc.id, lc.translatedText);
        }
      });
    });

    pipeline.setTokenCallback(() => {
      const liveChunks = [...pipeline.getChunkProgress()];
      const merged: ChunkProgress[] = liveChunks.map((lc) => {
        if (lc.status === "pending" && preCompleted.has(lc.id)) {
          return {
            ...lc,
            status: "completed" as const,
            translatedText: preCompleted.get(lc.id) || "",
          };
        }
        return lc;
      });
      setChunkProgress(merged);
    });

    try {
      const results = await pipeline.start(rawText, keys, {
        chunkSize,
        concurrency,
        maxRetries: 3,
        model: selectedModel,
        skipChunkIds: completedIds, // Skip already-translated chunks
      });

      // The pipeline returns results only for non-skipped chunks.
      // Map them back to their correct positions.
      const allResults = new Array<string>(chunkProgress.length).fill("");
      preCompleted.forEach((text, id) => {
        allResults[id] = text;
      });
      pendingIds.forEach((id, i) => {
        if (results[i]) allResults[id] = results[i];
      });

      setFinalResults(allResults);
      setIsComplete(true);

      // Persist all completed
      const session: StoredSession = {
        id: "current",
        fileName: fileName || "unknown.txt",
        rawTextLength: rawText.length,
        totalChunks: chunkProgress.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const storedChunks: StoredChunk[] = allResults.map((text, i) => ({
        id: i,
        text: chunkProgress[i]?.originalText || "",
        status: "completed",
        translatedText: text,
      }));
      await saveSession(session, storedChunks);
    } catch (err) {
      console.error("Resume pipeline error:", err);
    } finally {
      setIsRunning(false);
    }
  }, [rawText, keys, chunkSize, concurrency, selectedModel, fileName, chunkProgress]);

  // ─── Stop ───────────────────────────────────────────────────────
  const stopTranslation = useCallback(() => {
    pipelineRef.current?.abort();
    setIsRunning(false);
  }, []);

  // ─── Export (final) ─────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    try {
      const translated = finalResults.filter((c) => c.length > 0);
      if (translated.length === 0) {
        alert("No translated content to export.");
        return;
      }
      const stitched = translated.join("\n\n");
      const blob = new Blob([stitched], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (fileName.replace(/\.txt$/i, "") || "translated_novel") + ".txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);

      // Clean up IndexedDB after successful download
      await clearSession();
    } catch (err) {
      console.error("Export error:", err);
      alert("Download failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }, [finalResults, fileName]);

  // ─── Download progress (mid-translation) ────────────────────────
  const handleDownloadProgress = useCallback(() => {
    try {
      const completedChunks = chunkProgress
        .filter((c) => c.status === "completed" && c.translatedText.length > 0)
        .sort((a, b) => a.id - b.id)
        .map((c) => c.translatedText);

      if (completedChunks.length === 0) {
        alert("No completed chunks to download yet.");
        return;
      }

      const stitched = completedChunks.join("\n\n");
      const blob = new Blob([stitched], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "incomplete_english.txt";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error("Progress export error:", err);
      alert("Download failed: " + (err instanceof Error ? err.message : String(err)));
    }
  }, [chunkProgress]);

  // ─── Reset ──────────────────────────────────────────────────────
  const handleReset = useCallback(async () => {
    pipelineRef.current?.abort();
    setIsRunning(false);
    setIsComplete(false);
    setFinalResults([]);
    setChunkProgress([]);
    setProgress(null);
    setRawText("");
    setFileName("");
    setInterruptedRun(null);
    await clearSession();
  }, []);

  // ─── Render ─────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50/80 via-indigo-50/60 to-violet-50/40">
      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-white/40 bg-white/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 sm:px-6 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-md">
              <BookOpen className="h-4 w-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-bold text-gray-900 tracking-tight">
                Novel Translator
              </h1>
              <p className="text-[10px] text-gray-500">Chinese → English via OpenRouter</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isComplete && finalResults.length > 0 && (
              <motion.button
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                onClick={handleExport}
                className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transition-all cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                Download .txt
              </motion.button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
        {/* ─── Interrupted Run Banner ─────────────────────────────── */}
        <AnimatePresence>
          {interruptedRun && !isRunning && (
            <motion.div
              initial={{ opacity: 0, y: -12, height: 0 }}
              animate={{ opacity: 1, y: 0, height: "auto" }}
              exit={{ opacity: 0, y: -12, height: 0 }}
              className="overflow-hidden"
            >
              <div className="rounded-2xl border border-amber-200/60 bg-amber-50/50 backdrop-blur-xl p-4 shadow-sm">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
                  <div className="flex-1">
                    <h3 className="text-sm font-semibold text-amber-800">
                      Interrupted run detected
                    </h3>
                    <p className="text-xs text-amber-700 mt-1">
                      <strong>{interruptedRun.fileName}</strong> — {completedCount} of{" "}
                      {interruptedRun.totalChunks} chunks completed.{" "}
                      {pendingChunks.filter((c) => c.status === "pending").length} chunks remaining.
                    </p>
                    <div className="flex items-center gap-3 mt-3">
                      <button
                        onClick={handleResume}
                        className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2 text-xs font-semibold text-white shadow-md hover:shadow-lg transition-all cursor-pointer"
                      >
                        <Play className="h-3.5 w-3.5" />
                        Resume Translation
                      </button>
                      <button
                        onClick={handleReset}
                        className="flex items-center gap-1.5 rounded-xl border border-gray-200/60 bg-white/50 px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50/50 transition-all cursor-pointer"
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
            <FileUploader onFileContent={handleFileContent} disabled={isRunning} />
            {rawText.length > 0 && (
              <div className="flex items-center gap-4 text-[11px] text-gray-500 px-1">
                <span>📄 {rawText.length.toLocaleString()} characters</span>
                <span>📦 ~{Math.ceil(rawText.length / chunkSize)} chunks</span>
                {isComplete && (
                  <span className="text-green-600 font-medium">✅ Translation complete</span>
                )}
              </div>
            )}
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="rounded-2xl border border-white/50 bg-white/40 backdrop-blur-xl p-4 shadow-sm"
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
            <div className="rounded-2xl border border-white/50 bg-white/40 backdrop-blur-xl p-4 shadow-sm">
              <label className="text-xs font-semibold text-gray-800 block mb-2">Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isRunning}
                className="w-full rounded-xl border border-gray-200/60 bg-white/40 backdrop-blur-md px-3 py-2 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400/30 disabled:opacity-50 cursor-pointer"
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>

            <SettingsPanel
              chunkSize={chunkSize}
              onChunkSizeChange={setChunkSize}
              concurrency={concurrency}
              onConcurrencyChange={setConcurrency}
              disabled={isRunning}
            />
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="lg:col-span-2 rounded-2xl border border-white/50 bg-white/40 backdrop-blur-xl p-4 shadow-sm"
          >
            <ProgressPanel
              progress={progress}
              chunks={chunkProgress}
              isRunning={isRunning}
              isComplete={isComplete}
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
          {!isRunning ? (
            <>
              <button
                onClick={startTranslation}
                disabled={!canStart}
                className={cn(
                  "flex items-center gap-2 rounded-xl px-6 py-2.5 text-sm font-semibold transition-all shadow-lg cursor-pointer",
                  canStart
                    ? "bg-gradient-to-r from-blue-500 to-indigo-600 text-white shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98]"
                    : "bg-gray-200/80 text-gray-400 cursor-not-allowed shadow-none"
                )}
              >
                <Play className="h-4 w-4" />
                Start Translation
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
                  className="flex items-center gap-2 rounded-xl border border-gray-200/60 bg-white/50 backdrop-blur-md px-4 py-2.5 text-xs font-medium text-gray-600 hover:bg-gray-50/50 transition-all cursor-pointer"
                >
                  <Zap className="h-3.5 w-3.5" />
                  Test Key
                </button>
              )}
            </>
          ) : (
            <button
              onClick={stopTranslation}
              className="flex items-center gap-2 rounded-xl bg-red-500/90 backdrop-blur-sm px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-red-500/25 hover:bg-red-600 transition-all cursor-pointer"
            >
              <Square className="h-4 w-4" />
              Stop
            </button>
          )}

          {isComplete && (
            <button
              type="button"
              onClick={handleExport}
              className="relative z-10 flex items-center gap-2 rounded-xl border border-blue-200/60 bg-white/50 backdrop-blur-md px-5 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50/50 active:bg-blue-100/60 transition-all"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Download className="h-4 w-4" />
              Export .txt
            </button>
          )}

          {isRunning && (
            <button
              type="button"
              onClick={handleDownloadProgress}
              className="relative z-10 flex items-center gap-2 rounded-xl border border-amber-200/60 bg-amber-50/50 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-100/50 active:bg-amber-200/60 transition-all"
              style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
            >
              <Download className="h-4 w-4" />
              Download Progress
            </button>
          )}

          {(isRunning || isComplete || interruptedRun) && (
            <button
              onClick={handleReset}
              className="flex items-center gap-2 rounded-xl border border-gray-200/60 bg-white/50 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50/50 transition-all cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
          )}

          {!canStart && !isRunning && !interruptedRun && (
            <span className="text-xs text-gray-400 flex items-center gap-1">
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
