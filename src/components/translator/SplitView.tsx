import { useRef, useEffect } from "react";
import { Languages, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChunkProgress } from "@/lib/translator/pipeline";

interface SplitViewProps {
  chunks: ChunkProgress[];
  activeChunkId: number | null;
}

export function SplitView({ chunks, activeChunkId }: SplitViewProps) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  // Auto-scroll both panes to show active chunk
  useEffect(() => {
    if (activeChunkId === null) return;
    const left = leftRef.current;
    const right = rightRef.current;
    const leftChunk = left?.querySelector(`[data-chunk="${activeChunkId}"]`);
    const rightChunk = right?.querySelector(`[data-chunk="${activeChunkId}"]`);
    if (leftChunk) leftChunk.scrollIntoView({ behavior: "smooth", block: "start" });
    if (rightChunk) rightChunk.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeChunkId, chunks]);

  if (chunks.length === 0) {
    return (
      <div className="flex items-center justify-center h-full min-h-[300px] rounded-xl border border-gray-200/60 bg-white/30 backdrop-blur-md">
        <div className="text-center text-gray-400">
          <Languages className="h-10 w-10 mx-auto mb-3 opacity-40" />
          <p className="text-sm">Upload a file and start translation to see the split view</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 h-full min-h-[300px] max-h-[600px]">
      {/* Source panel */}
      <div className="flex flex-col rounded-xl border border-gray-200/60 bg-white/30 backdrop-blur-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200/40 bg-white/40">
          <FileText className="h-3.5 w-3.5 text-gray-500" />
          <span className="text-xs font-medium text-gray-600">Original Chinese</span>
        </div>
        <div ref={leftRef} className="flex-1 overflow-auto p-3 space-y-3">
          {chunks.map((chunk) => (
            <div
              key={chunk.id}
              data-chunk={chunk.id}
              className={cn(
                "rounded-lg p-3 text-sm leading-relaxed transition-colors duration-300 border",
                activeChunkId === chunk.id
                  ? "bg-amber-50/60 border-amber-200/60"
                  : "bg-white/20 border-transparent hover:bg-white/40",
              )}
            >
              <span className="inline-block rounded bg-gray-100/80 px-1.5 py-0.5 text-[10px] font-medium text-gray-500 mb-2">
                Chunk {chunk.id + 1}
              </span>
              <p className="text-gray-700 whitespace-pre-wrap font-[system-ui]">{chunk.originalText}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Translation panel */}
      <div className="flex flex-col rounded-xl border border-gray-200/60 bg-white/30 backdrop-blur-md overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200/40 bg-white/40">
          <Languages className="h-3.5 w-3.5 text-blue-500" />
          <span className="text-xs font-medium text-gray-600">English Translation</span>
        </div>
        <div ref={rightRef} className="flex-1 overflow-auto p-3 space-y-3">
          {chunks.map((chunk) => {
            const isActive = chunk.status === "translating";
            const hasContent = chunk.translatedText.length > 0;
            return (
              <div
                key={chunk.id}
                data-chunk={chunk.id}
                className={cn(
                  "rounded-lg p-3 text-sm leading-relaxed transition-colors duration-300 border",
                  isActive
                    ? "bg-blue-50/60 border-blue-200/60"
                    : chunk.status === "completed"
                      ? "bg-green-50/30 border-green-200/40"
                      : chunk.status === "failed"
                        ? "bg-red-50/30 border-red-200/40"
                        : "bg-white/20 border-transparent",
                )}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="inline-block rounded bg-gray-100/80 px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
                    Chunk {chunk.id + 1}
                  </span>
                  {isActive && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-blue-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                      streaming
                    </span>
                  )}
                  {chunk.status === "completed" && (
                    <span className="text-[10px] text-green-500">✓ done</span>
                  )}
                  {chunk.status === "failed" && (
                    <span className="text-[10px] text-red-500">
                      ✗ {chunk.error?.slice(0, 40) || "failed"}
                    </span>
                  )}
                </div>
                {hasContent ? (
                  <p className="text-gray-700 whitespace-pre-wrap">{chunk.translatedText}</p>
                ) : !isActive ? (
                  <p className="text-gray-400 italic text-xs">Waiting...</p>
                ) : null}
                {isActive && hasContent && (
                  <span className="inline-block h-4 w-0.5 bg-blue-500 animate-pulse ml-0.5" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
