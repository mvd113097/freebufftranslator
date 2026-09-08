import { useState } from "react";
import { Cloud, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getWorkerUrl,
  setWorkerUrl,
  getWorkerSecret,
  setWorkerSecret,
  pingWorker,
} from "@/lib/translator/cloud-client";

interface CloudSettingsProps {
  workerUrl: string;
  workerSecret: string;
  onWorkerUrlChange: (v: string) => void;
  onWorkerSecretChange: (v: string) => void;
  disabled?: boolean;
}

export function CloudSettings({
  workerUrl,
  workerSecret,
  onWorkerUrlChange,
  onWorkerSecretChange,
  disabled,
}: CloudSettingsProps) {
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"ok" | "fail" | null>(null);
  const [testMsg, setTestMsg] = useState("");

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    setTestMsg("");
    setWorkerUrl(workerUrl);
    setWorkerSecret(workerSecret);
    try {
      const res = await pingWorker();
      setTestResult("ok");
      setTestMsg(`Connected — worker alive at ${new Date(res.time).toLocaleTimeString()}`);
    } catch (err) {
      setTestResult("fail");
      setTestMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={cn("space-y-3", disabled && "opacity-50 pointer-events-none")}>
      <div className="flex items-center gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 p-2.5">
        <Cloud className="h-4 w-4 text-sky-400 shrink-0" />
        <p className="text-[10px] text-sky-200/70 leading-snug">
          Cloud mode runs the translation on your own free Cloudflare worker —
          you can close the browser and the book keeps translating. Upload once,
          poll for progress, download when done.
        </p>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-stone-400">Worker URL</label>
        <input
          type="url"
          value={workerUrl}
          onChange={(e) => {
            onWorkerUrlChange(e.target.value);
            setTestResult(null);
          }}
          placeholder="https://novel-translator-worker.your-name.workers.dev"
          className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs font-mono text-stone-200 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-sky-400/30"
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-stone-400">Job Secret (optional)</label>
        <input
          type="password"
          value={workerSecret}
          onChange={(e) => {
            onWorkerSecretChange(e.target.value);
            setTestResult(null);
          }}
          placeholder="Matches JOB_SECRET in wrangler.toml — leave empty if none"
          className="w-full rounded-xl border border-stone-700 bg-stone-800 px-3 py-2 text-xs font-mono text-stone-200 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-sky-400/30"
        />
        <p className="text-[10px] text-stone-600">
          A shared password that stops strangers from creating jobs on your worker.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleTest}
          disabled={testing || !workerUrl.trim()}
          className="flex items-center gap-1.5 rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-1.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/20 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Cloud className="h-3.5 w-3.5" />
          )}
          Test Connection
        </button>
        {testResult === "ok" && (
          <span className="flex items-center gap-1 text-[11px] text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> Connected
          </span>
        )}
        {testResult === "fail" && (
          <span className="flex items-center gap-1 text-[11px] text-red-400">
            <XCircle className="h-3.5 w-3.5" /> {testMsg.slice(0, 60)}
          </span>
        )}
      </div>

      <details className="group">
        <summary className="cursor-pointer text-[11px] font-medium text-stone-400 hover:text-stone-300 transition-colors">
          How do I deploy my own worker? ▾
        </summary>
        <div className="mt-2 space-y-2 rounded-xl border border-stone-700/50 bg-stone-950/60 p-3">
          <p className="text-[10px] text-stone-400 leading-relaxed">
            1. Create a free Cloudflare account (no card needed).
            <br />
            2. In a terminal: <code className="text-amber-400">cd cloudflare-worker && bun install</code>
            <br />
            3. <code className="text-amber-400">npx wrangler d1 create novel-translator</code> — paste the
            returned <code>database_id</code> into <code>wrangler.toml</code>.
            <br />
            4. <code className="text-amber-400">bun run db:init</code> (creates the tables)
            <br />
            5. <code className="text-amber-400">bun run deploy</code> — prints your worker URL.
            <br />
            6. Paste the URL above. Your OpenRouter keys and Telegram token are
            sent to <em>your</em> worker only when you start a cloud job.
          </p>
        </div>
      </details>
    </div>
  );
}
