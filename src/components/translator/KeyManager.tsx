import { useState, useEffect, useRef } from "react";
import { KeyRound, Plus, Trash2, Eye, EyeOff, AlertCircle, Cloud } from "lucide-react";
import { cn } from "@/lib/utils";

const OPENROUTER_STORAGE_KEY = "novel_translator_openrouter_keys";
const GEMINI_STORAGE_KEY = "novel_translator_gemini_keys";

interface KeyManagerProps {
  openrouterKeys: string[];
  geminiKeys: string[];
  onOpenrouterKeysChange: (keys: string[]) => void;
  onGeminiKeysChange: (keys: string[]) => void;
}

export function KeyManager({
  openrouterKeys,
  geminiKeys,
  onOpenrouterKeysChange,
  onGeminiKeysChange,
}: KeyManagerProps) {
  const [openrouterInput, setOpenrouterInput] = useState("");
  const [geminiInput, setGeminiInput] = useState("");
  const openrouterRef = useRef<HTMLTextAreaElement | null>(null);
  const geminiRef = useRef<HTMLTextAreaElement | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(OPENROUTER_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          onOpenrouterKeysChange(parsed);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(GEMINI_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          onGeminiKeysChange(parsed);
        }
      }
    } catch {
      // Ignore parse errors
    }
  }, []);

  // Save to localStorage on change
  useEffect(() => {
    if (openrouterKeys.length > 0) {
      localStorage.setItem(OPENROUTER_STORAGE_KEY, JSON.stringify(openrouterKeys));
    } else {
      localStorage.removeItem(OPENROUTER_STORAGE_KEY);
    }
  }, [openrouterKeys]);

  useEffect(() => {
    if (geminiKeys.length > 0) {
      localStorage.setItem(GEMINI_STORAGE_KEY, JSON.stringify(geminiKeys));
    } else {
      localStorage.removeItem(GEMINI_STORAGE_KEY);
    }
  }, [geminiKeys]);

  const addOpenrouterKeys = () => {
    const lines = openrouterInput
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("sk-or-v1-") && l.length > 20);

    if (lines.length === 0) return;

    const newKeys = [...new Set([...openrouterKeys, ...lines])];
    onOpenrouterKeysChange(newKeys);
    setOpenrouterInput("");
  };

  const addGeminiKeys = () => {
    const lines = geminiInput
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => (l.startsWith("AQ.") || l.length > 30) && l.length > 20);

    if (lines.length === 0) return;

    const newKeys = [...new Set([...geminiKeys, ...lines])];
    onGeminiKeysChange(newKeys);
    setGeminiInput("");
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    handler: () => void,
  ) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handler();
    }
  };

  const removeKey = (
    index: number,
    keys: string[],
    onKeysChange: (keys: string[]) => void,
  ) => {
    const newKeys = keys.filter((_, i) => i !== index);
    onKeysChange(newKeys);
  };

  const maskKey = (key: string) => {
    if (key.length <= 12) return key;
    return key.slice(0, 8) + "••••••" + key.slice(-4);
  };

  return (
    <div className="space-y-5">
      {/* OpenRouter Keys Section */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <KeyRound className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-stone-200">OpenRouter Keys</h3>
          {openrouterKeys.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
              {openrouterKeys.length} key{openrouterKeys.length !== 1 ? "s" : ""} loaded
            </span>
          )}
        </div>

        {openrouterKeys.length === 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2.5 text-xs text-amber-300">
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

        {/* OpenRouter Key list */}
        {openrouterKeys.length > 0 && (
          <div className="space-y-1.5">
            {openrouterKeys.map((key, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-lg border border-stone-700 bg-stone-800 px-3 py-2"
              >
                <span className="flex-1 font-mono text-xs text-stone-400 truncate">
                  {key}
                </span>
                <button
                  onClick={() =>
                    removeKey(i, openrouterKeys, onOpenrouterKeysChange)
                  }
                  className="p-1 rounded-md hover:bg-red-500/10 text-stone-500 hover:text-red-400 transition-colors cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* OpenRouter Add keys input */}
        <div className="space-y-2">
          <textarea
            ref={openrouterRef}
            value={openrouterInput}
            onChange={(e) => setOpenrouterInput(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e, addOpenrouterKeys)}
            placeholder={"Paste OpenRouter API key(s) here, one per line\nsk-or-v1-xxxxxxxxxxxxxxxx\nsk-or-v1-yyyyyyyyyyyyyyyy"}
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
            onClick={addOpenrouterKeys}
            disabled={!openrouterInput.trim()}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
              openrouterInput.trim()
                ? "bg-amber-500 text-stone-950 hover:bg-amber-400 shadow-sm"
                : "bg-stone-800 text-stone-500 cursor-not-allowed",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            {openrouterInput
              .split("\n")
              .filter((l) => l.trim().startsWith("sk-or-v1-") && l.trim().length > 20).length >
              1
              ? `Add ${openrouterInput.split("\n").filter((l) => l.trim().startsWith("sk-or-v1-") && l.trim().length > 20).length} Keys`
              : "Add Key"}
          </button>
        </div>
      </div>

      {/* Gemini Keys Section */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-2">
          <Cloud className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-stone-200">Gemini API Keys (AQ. format)</h3>
          {geminiKeys.length > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-400">
              {geminiKeys.length} key{geminiKeys.length !== 1 ? "s" : ""} loaded
            </span>
          )}
        </div>

        {geminiKeys.length === 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-stone-800/50 border border-stone-700/50 px-3 py-2.5 text-xs text-stone-400">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Add Gemini API keys for cloud mode translation. Get keys from Google AI Studio. Use the modern &quot;AQ.&quot; format keys.
            </span>
          </div>
        )}

        {/* Gemini Key list */}
        {geminiKeys.length > 0 && (
          <div className="space-y-1.5">
            {geminiKeys.map((key, i) => (
              <div
                key={i}
                className="flex items-center gap-2 rounded-lg border border-stone-700 bg-stone-800 px-3 py-2"
              >
                <span className="flex-1 font-mono text-xs text-stone-400 truncate">
                  {key.length > 40 ? key.slice(0, 20) + "..." + key.slice(-12) : key}
                </span>
                <button
                  onClick={() =>
                    removeKey(i, geminiKeys, onGeminiKeysChange)
                  }
                  className="p-1 rounded-md hover:bg-red-500/10 text-stone-500 hover:text-red-400 transition-colors cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Gemini Add keys input */}
        <div className="space-y-2">
          <textarea
            ref={geminiRef}
            value={geminiInput}
            onChange={(e) => setGeminiInput(e.target.value)}
            onKeyDown={(e) => handleKeyDown(e, addGeminiKeys)}
            placeholder={"Paste Gemini API key(s) here, one per line\nAQ.abc123...\nAQ.xyz789..."}
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
            onClick={addGeminiKeys}
            disabled={!geminiInput.trim()}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all cursor-pointer",
              geminiInput.trim()
                ? "bg-amber-500 text-stone-950 hover:bg-amber-400 shadow-sm"
                : "bg-stone-800 text-stone-500 cursor-not-allowed",
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            {geminiInput
              .split("\n")
              .filter((l) => l.trim().length > 20).length > 1
              ? `Add ${geminiInput.split("\n").filter((l) => l.trim().length > 20).length} Keys`
              : "Add Key"}
          </button>
        </div>
      </div>
    </div>
  );
}
