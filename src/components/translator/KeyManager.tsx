import { useState, useEffect } from "react";
import { KeyRound, Plus, Trash2, Eye, EyeOff, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "novel_translator_api_keys";

interface KeyManagerProps {
  keys: string[];
  onKeysChange: (keys: string[]) => void;
}

export function KeyManager({ keys, onKeysChange }: KeyManagerProps) {
  const [showKeys, setShowKeys] = useState(false);
  const [inputValue, setInputValue] = useState("");

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          onKeysChange(parsed);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  // Save to localStorage on change
  useEffect(() => {
    if (keys.length > 0) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, [keys]);

  const addKeys = () => {
    const lines = inputValue
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 10);

    if (lines.length === 0) return;

    const newKeys = [...new Set([...keys, ...lines])];
    onKeysChange(newKeys);
    setInputValue("");
  };

  const removeKey = (index: number) => {
    const newKeys = keys.filter((_, i) => i !== index);
    onKeysChange(newKeys);
  };

  const maskKey = (key: string) => {
    if (key.length <= 12) return key;
    return key.slice(0, 8) + "••••••" + key.slice(-4);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-2">
        <KeyRound className="h-4 w-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-stone-200">API Keys</h3>
        {(() => {
          const gemini = keys.filter((k) => k.startsWith("AIza") || k.startsWith("AQ.")).length;
          const openrouter = keys.length - gemini;
          return (
            <>
              {gemini > 0 && (
                <span className="inline-flex items-center rounded-full bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-400">
                  {gemini} Gemini
                </span>
              )}
              {openrouter > 0 && (
                <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
                  {openrouter} OpenRouter
                </span>
              )}
            </>
          );
        })()}
        {keys.length > 0 && (
          <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
            {keys.length} key{keys.length !== 1 ? "s" : ""} loaded
          </span>
        )}
      </div>

      {keys.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-300">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Paste key(s) — one per line. OpenRouter keys (sk-or-v1-…) from{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-medium"
            >
              openrouter.ai/keys
            </a>{" "}
            and/or free Google Gemini keys (AIza… or AQ.…) from{" "}
            <a
              href="https://aistudio.google.com/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-medium"
            >
              aistudio.google.com/apikey
            </a>
            . With a Gemini key, Auto Free always tries Gemini first.
          </span>
        </div>
      )}

      {/* Key list */}
      {keys.length > 0 && (
        <div className="space-y-1.5">
          {keys.map((key, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-lg border border-stone-700 bg-stone-800 px-3 py-2"
            >
              <span className="flex-1 font-mono text-xs text-stone-400 truncate">
                {showKeys ? key : maskKey(key)}
              </span>
              <button
                onClick={() => setShowKeys(!showKeys)}
                className="p-1 rounded-md hover:bg-stone-700 text-stone-500 hover:text-stone-300 transition-colors cursor-pointer"
              >
                {showKeys ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => removeKey(i)}
                className="p-1 rounded-md hover:bg-red-500/10 text-stone-500 hover:text-red-400 transition-colors cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add keys input */}
      <div className="space-y-2">
        <textarea
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={"Paste API key(s) here, one per line\nsk-or-v1-… (OpenRouter) or AIza…/AQ.… (free Google Gemini)"}
          className={cn(
            "w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2.5",
            "text-xs font-mono text-stone-200 placeholder:text-stone-500",
            "focus:outline-none focus:ring-2 focus:ring-amber-400/30 focus:border-amber-500/50",
            "resize-none transition-all",
            "min-h-[60px]",
          )}
          rows={3}
        />
        <button
          onClick={addKeys}
          disabled={!inputValue.trim()}
          className={cn(
            "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
            inputValue.trim()
              ? "bg-amber-500 text-stone-950 hover:bg-amber-400 shadow-sm"
              : "bg-stone-800 text-stone-500 cursor-not-allowed",
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Key{inputValue.split("\n").filter((l) => l.trim()).length > 1 ? "s" : ""}
        </button>
      </div>
    </div>
  );
}
