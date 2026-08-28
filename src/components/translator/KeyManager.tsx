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
        <KeyRound className="h-4 w-4 text-amber-500" />
        <h3 className="text-sm font-semibold text-gray-800">API Keys</h3>
        {keys.length > 0 && (
          <span className="inline-flex items-center rounded-full bg-green-100/80 backdrop-blur-sm px-2 py-0.5 text-xs font-medium text-green-700">
            {keys.length} key{keys.length !== 1 ? "s" : ""} loaded
          </span>
        )}
      </div>

      {keys.length === 0 && (
        <div className="flex items-start gap-2 rounded-lg bg-blue-50/60 backdrop-blur-sm border border-blue-200/50 px-3 py-2.5 text-xs text-blue-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            Add your OpenRouter API key(s). Get one free at{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="underline font-medium"
            >
              openrouter.ai/keys
            </a>
          </span>
        </div>
      )}

      {/* Key list */}
      {keys.length > 0 && (
        <div className="space-y-1.5">
          {keys.map((key, i) => (
            <div
              key={i}
              className="flex items-center gap-2 rounded-lg border border-gray-200/60 bg-white/40 backdrop-blur-sm px-3 py-2"
            >
              <span className="flex-1 font-mono text-xs text-gray-600 truncate">
                {showKeys ? key : maskKey(key)}
              </span>
              <button
                onClick={() => setShowKeys(!showKeys)}
                className="p-1 rounded-md hover:bg-gray-100/80 text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
              >
                {showKeys ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
              <button
                onClick={() => removeKey(i)}
                className="p-1 rounded-md hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
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
          placeholder={"Paste OpenRouter API key(s) here, one per line\nsk-or-v1-xxxxxxxxxxxxxxxx\nsk-or-v1-yyyyyyyyyyyyyyyy"}
          className={cn(
            "w-full rounded-xl border border-gray-200/60 bg-white/40 backdrop-blur-md px-3 py-2.5",
            "text-xs font-mono text-gray-700 placeholder:text-gray-400",
            "focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-blue-300",
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
              ? "bg-blue-500/90 backdrop-blur-sm text-white hover:bg-blue-600 shadow-sm"
              : "bg-gray-100/80 text-gray-400 cursor-not-allowed",
          )}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Key{inputValue.split("\n").filter((l) => l.trim()).length > 1 ? "s" : ""}
        </button>
      </div>
    </div>
  );
}
