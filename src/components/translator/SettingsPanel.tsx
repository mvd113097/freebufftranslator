import { cn } from "@/lib/utils";

interface SettingsPanelProps {
  chunkSize: number;
  onChunkSizeChange: (v: number) => void;
  concurrency: number;
  onConcurrencyChange: (v: number) => void;
  disabled?: boolean;
}

export function SettingsPanel({
  chunkSize,
  onChunkSizeChange,
  concurrency,
  onConcurrencyChange,
  disabled,
}: SettingsPanelProps) {
  return (
    <div className={cn("space-y-4", disabled && "opacity-50 pointer-events-none")}>
      {/* Chunk Size Slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-stone-400">Characters per Chunk</label>
          <span className="text-xs font-mono font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md">
            {(chunkSize / 1000).toFixed(0)}k
          </span>
        </div>
        <input
          type="range"
          min={1000}
          max={50000}
          step={1000}
          value={chunkSize}
          onChange={(e) => onChunkSizeChange(Number(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none bg-stone-700 cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-500 [&::-webkit-slider-thumb]:shadow-md
            [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-stone-900
            [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-125"
        />
        <div className="flex justify-between text-[10px] text-stone-500">
          <span>1k (finer)</span>
          <span>50k (coarser)</span>
        </div>
      </div>

      {/* Concurrency Slider */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-stone-400">Parallel Requests</label>
          <span className="text-xs font-mono font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-md">
            {concurrency}×
          </span>
        </div>
        <input
          type="range"
          min={1}
          max={10}
          step={1}
          value={concurrency}
          onChange={(e) => onConcurrencyChange(Number(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none bg-stone-700 cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-amber-500 [&::-webkit-slider-thumb]:shadow-md
            [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-stone-900
            [&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:hover:scale-125"
        />
        <div className="flex justify-between text-[10px] text-stone-500">
          <span>1 (safe)</span>
          <span>10 (fast)</span>
        </div>
      </div>
    </div>
  );
}
