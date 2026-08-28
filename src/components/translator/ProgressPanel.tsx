import { CheckCircle2, AlertTriangle, Loader2, Clock, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PipelineProgress, ChunkProgress } from "@/lib/translator/pipeline";

interface ProgressPanelProps {
  progress: PipelineProgress | null;
  chunks: ChunkProgress[];
  isRunning: boolean;
  isComplete: boolean;
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
}: ProgressPanelProps) {
  const completedCount = chunks.filter((c) => c.status === "completed").length;
  const failedCount = chunks.filter((c) => c.status === "failed").length;
  const totalTokens = chunks.reduce((sum, c) => sum + c.tokensReceived, 0);
  const percent = progress?.overallPercent ?? 0;

  return (
    <div className="space-y-4">
      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-gray-700">
            {progress?.currentChunk ?? "Ready"}
          </span>
          <span className="font-semibold text-blue-600">{percent}%</span>
        </div>
        <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-gray-200/60 backdrop-blur-sm">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500 ease-out",
              isComplete && failedCount === 0
                ? "bg-gradient-to-r from-green-400 to-emerald-500"
                : isComplete && failedCount > 0
                  ? "bg-gradient-to-r from-amber-400 to-orange-500"
                  : "bg-gradient-to-r from-blue-400 to-indigo-500",
            )}
            style={{ width: `${percent}%` }}
          />
          {isRunning && (
            <div className="absolute inset-0 overflow-hidden rounded-full">
              <div className="h-full w-1/3 animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/40 to-transparent" />
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
          icon={<CheckCircle2 className="h-4 w-4 text-green-500" />}
          label="Completed"
          value={`${completedCount}/${chunks.length || progress?.totalChunks || 0}`}
        />
        <StatCard
          icon={<AlertTriangle className="h-4 w-4 text-amber-500" />}
          label="Failed"
          value={`${failedCount}`}
          highlight={failedCount > 0}
        />
        <StatCard
          icon={<Clock className="h-4 w-4 text-blue-500" />}
          label="Elapsed"
          value={formatTime(progress?.elapsedMs ?? 0)}
        />
        <StatCard
          icon={<Zap className="h-4 w-4 text-purple-500" />}
          label="Tokens"
          value={totalTokens.toLocaleString()}
        />
      </div>

      {/* Active status indicator */}
      {isRunning && (
        <div className="flex items-center gap-2 rounded-xl bg-blue-50/50 backdrop-blur-md border border-blue-200/50 px-3 py-2.5">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
          <span className="text-xs text-blue-700">
            Translating... {progress?.activeChunks ?? 0} active request
            {(progress?.activeChunks ?? 0) !== 1 ? "s" : ""}
          </span>
        </div>
      )}

      {isComplete && failedCount > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50/50 backdrop-blur-md border border-red-200/50 px-3 py-2.5">
          <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
          <div className="text-xs text-red-700 space-y-1">
            <p className="font-medium">{failedCount} chunk(s) failed</p>
            {chunks.some((c) => c.error?.includes("AQ_KEY_BUG")) ? (
              <p className="text-red-600">
                Your AQ. API keys are rejected by Google. This is a known bug.
                Try regenerating keys in AI Studio or using an older AIza-prefixed key.
              </p>
            ) : (
              <p className="text-red-600">
                {chunks.find((c) => c.error)?.error?.slice(0, 120) || "Unknown error"}
              </p>
            )}
          </div>
        </div>
      )}

      {isComplete && failedCount === 0 && chunks.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl bg-green-50/50 backdrop-blur-md border border-green-200/50 px-3 py-2.5">
          <CheckCircle2 className="h-4 w-4 text-green-500" />
          <span className="text-xs text-green-700 font-medium">
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
        "flex items-center gap-2 rounded-xl border px-3 py-2.5 backdrop-blur-md",
        highlight
          ? "border-amber-200/60 bg-amber-50/40"
          : "border-gray-200/60 bg-white/40",
      )}
    >
      {icon}
      <div>
        <p className="text-[10px] text-gray-500 uppercase tracking-wider">{label}</p>
        <p className="text-sm font-semibold text-gray-800">{value}</p>
      </div>
    </div>
  );
}
