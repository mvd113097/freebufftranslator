import { CheckCircle2, AlertTriangle, Loader2, Clock, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PipelineProgress, ChunkProgress } from "@/lib/translator/pipeline";

interface ProgressPanelProps {
  progress: PipelineProgress | null;
  chunks: ChunkProgress[];
  isRunning: boolean;
  isComplete: boolean;
  totalEnglishWords?: number;
}

function formatTime(ms: number): string {
  if (ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function ProgressPanel({
  progress,
  chunks,
  isRunning,
  isComplete,
  totalEnglishWords = 0,
}: ProgressPanelProps) {
  const completedCount = chunks.filter((c) => c.status === "completed").length;
  const failedCount = chunks.filter((c) => c.status === "failed").length;
  const percent = progress?.overallPercent ?? 0;

  return (
    <div className="space-y-4">
      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-stone-300">
            {progress?.currentChunk ?? "Ready"}
          </span>
          <span className="font-semibold text-amber-400">{percent}%</span>
        </div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-stone-700">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500 ease-out",
              isComplete && failedCount === 0
                ? "bg-gradient-to-r from-amber-400 to-amber-500"
                : isComplete && failedCount > 0
                  ? "bg-gradient-to-r from-amber-400 to-orange-500"
                  : "bg-gradient-to-r from-amber-500 to-amber-600",
            )}
            style={{ width: `${percent}%` }}
          />
          {isRunning && (
            <div className="absolute inset-0 overflow-hidden rounded-full">
              <div className="h-full w-1/3 animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/20 to-transparent" />
            </div>
          )}
        </div>
        <style>{`
          @keyframes shimmer {
            0% { transform: translateX(-100%); }
            100% { transform: translateX(300%); }
          }
        `}</style>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard
          icon={<CheckCircle2 className="h-4 w-4 text-amber-400" />}
          label="Completed"
          value={`${completedCount}/${chunks.length || progress?.totalChunks || 0}`}
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4 text-red-400" />}
          label="Failed"
          value={`${failedCount}`}
          highlight={failedCount > 0}
        />
        <StatCard
          icon={<Clock className="h-4 w-4 text-stone-400" />}
          label="Elapsed"
          value={formatTime(progress?.elapsedMs ?? 0)}
        />
        <StatCard
          icon={<BookOpen className="h-4 w-4 text-green-400" />}
          label="English Words"
          value={totalEnglishWords.toLocaleString()}
        />
      </div>

      {/* Active status indicator */}
      {isRunning && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2.5">
          <Loader2 className="h-4 w-4 animate-spin text-amber-400" />
          <span className="text-xs text-amber-300">
            Translating... {progress?.activeChunks ?? 0} chunk{(progress?.activeChunks ?? 0) !== 1 ? "s" : ""} in progress
          </span>
        </div>
      )}

      {failedCount > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-red-500/10 border border-red-500/20 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
          <div className="text-xs text-red-300 space-y-1.5 flex-1">
            <p className="font-medium">{failedCount} chunk(s) failed</p>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {chunks
                .filter((c) => c.status === "failed" && c.error)
                .slice(0, 5)
                .map((c) => (
                  <div key={c.id} className="rounded-md bg-red-500/10 px-2 py-1.5">
                    <span className="font-medium">Chunk {c.id + 1}:</span>{" "}
                    <span className="text-red-400 break-all">{(c.error ?? "Unknown").slice(0, 150)}</span>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {isComplete && failedCount === 0 && chunks.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-green-500/10 border border-green-500/20 px-3 py-2.5">
          <CheckCircle2 className="h-4 w-4 text-green-400" />
          <span className="text-xs text-green-300 font-medium">
            All chunks translated successfully! Ready to export.
          </span>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-xl border px-3 py-2.5",
        highlight
          ? "border-red-500/30 bg-red-500/10"
          : "border-stone-700 bg-stone-800",
      )}
    >
      {icon}
      <div>
        <p className="text-[10px] text-stone-500 uppercase tracking-wider">{label}</p>
        <p className="text-sm font-semibold text-stone-200">{value}</p>
      </div>
    </div>
  );
}
