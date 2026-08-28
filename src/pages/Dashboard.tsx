import { useState, useRef, useCallback, useMemo } from "react";
import { motion } from "framer-motion";
import {
  Play,
  Square,
  Download,
  Sparkles,
  BookOpen,
  RotateCcw,
  Zap,
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
import { stitchAndExportEpub } from "@/components/translator/epub-export";
import { DEFAULT_MODEL, translateChunkSimple } from "@/lib/translator/gemini-api";

const MODEL_OPTIONS = [
  { value: "openrouter/free", label: "Auto Free (best available)" },
  { value: "inclusionai/ling-3.0-flash-fin:free", label: "Ling 3.0 Flash (free, 262K ctx)" },
  { value: "qwen/qwen-2.5-72b-instruct:free", label: "Qwen 2.5 72B (free, great Chinese)" },
  { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash (paid, cheapest)" },
  { value: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash (paid, best)" },
];

export default function Dashboard() {
  const [keys, setKeys] = useState<string[]>([]);
  const [rawText, setRawText] = useState("");
  const [fileName, setFileName] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [chunkProgress, setChunkProgress] = useState<ChunkProgress[]>([]);
  const [chunkSize, setChunkSize] = useState(4000);
  const [concurrency, setConcurrency] = useState(5);
  const [finalResults, setFinalResults] = useState<string[]>([]);
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);

  const pipelineRef = useRef<TranslationPipeline | null>(null);

  const canStart = useMemo(
    () => rawText.length > 0 && keys.length > 0 && !isRunning,
    [rawText, keys, isRunning],
  );

  const handleFileContent = useCallback((content: string, name: string) => {
    setRawText(content);
    setFileName(name);
    setIsComplete(false);
    setFinalResults([]);
    setChunkProgress([]);
    setProgress(null);
  }, []);

  const startTranslation = useCallback(async () => {
    if (!canStart) return;

    setIsRunning(true);
    setIsComplete(false);
    setFinalResults([]);
    setChunkProgress([]);

    const pipeline = new TranslationPipeline();
    pipelineRef.current = pipeline;

    pipeline.setProgressCallback((p) => {
      setProgress(p);
      setChunkProgress([...pipeline.getChunkProgress()]);
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
    } catch (err) {
      console.error("Pipeline error:", err);
    } finally {
      setIsRunning(false);
    }
  }, [canStart, rawText, keys, chunkSize, concurrency, selectedModel]);

  const stopTranslation = useCallback(() => {
    pipelineRef.current?.abort();
    setIsRunning(false);
  }, []);

  const handleExport = useCallback(() => {
    try {
      stitchAndExportEpub(
        finalResults,
        rawText,
        fileName.replace(/\.txt$/i, "") || "Translated Novel",
      );
    } catch (err) {
      console.error("Export error:", err);
    }
  }, [finalResults, rawText, fileName]);

  const handleReset = useCallback(() => {
    pipelineRef.current?.abort();
    setIsRunning(false);
    setIsComplete(false);
    setFinalResults([]);
    setChunkProgress([]);
    setProgress(null);
    setRawText("");
    setFileName("");
  }, []);

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
                Download .epub
              </motion.button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 py-6 space-y-6">
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
              disabled={isRunning}
            />
            {rawText.length > 0 && (
              <div className="flex items-center gap-4 text-[11px] text-gray-500 px-1">
                <span>
                  📄 {rawText.length.toLocaleString()} characters
                </span>
                <span>
                  📦 ~{Math.ceil(rawText.length / chunkSize)} chunks
                </span>
                {isComplete && (
                  <span className="text-green-600 font-medium">
                    ✅ Translation complete
                  </span>
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
          className="flex items-center gap-3"
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
                    : "bg-gray-200/80 text-gray-400 cursor-not-allowed shadow-none",
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
                        selectedModel,
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
              onClick={handleExport}
              className="flex items-center gap-2 rounded-xl border border-blue-200/60 bg-white/50 backdrop-blur-md px-5 py-2.5 text-sm font-medium text-blue-700 hover:bg-blue-50/50 transition-all cursor-pointer"
            >
              <Download className="h-4 w-4" />
              Export .epub
            </button>
          )}

          {(isRunning || isComplete) && (
            <button
              onClick={handleReset}
              className="flex items-center gap-2 rounded-xl border border-gray-200/60 bg-white/50 backdrop-blur-md px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50/50 transition-all cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </button>
          )}

          {!canStart && !isRunning && (
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
