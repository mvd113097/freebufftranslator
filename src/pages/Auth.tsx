import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { motion } from "framer-motion";
import { BookOpen, Loader2, Mail, LogIn, UserRound } from "lucide-react";
import {
  loginWithEmail,
  setGuest,
  magicAvailable,
  isGuest,
} from "@/lib/auth";

/**
 * Passwordless email login (Magic) + "continue as guest".
 * Fully client-side — no Convex, no backend.
 */
export default function AuthPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  const returnTo =
    searchParams.get("returnTo") &&
    searchParams.get("returnTo")!.startsWith("/") &&
    !searchParams.get("returnTo")!.startsWith("//")
      ? searchParams.get("returnTo")!
      : "/dashboard";

  const finish = () => navigate(returnTo, { replace: true });

  const handleGuest = () => {
    setGuest(true);
    finish();
  };

  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !email.includes("@")) {
      setStatus("error");
      setMessage("Please enter a valid email address.");
      return;
    }
    setStatus("sending");
    setMessage("");
    try {
      await loginWithEmail(email.trim());
      setStatus("sent");
      setMessage("Check your email — tap the link or enter the code there to sign in.");
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : "Login failed. Try again.");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-950 px-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="w-full max-w-sm"
      >
        <div className="rounded-3xl border border-stone-700/50 bg-stone-900/80 backdrop-blur-xl p-7 shadow-2xl shadow-black/40">
          <div className="flex items-center justify-center gap-2.5 mb-6">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 to-amber-600 shadow-lg shadow-amber-500/25">
              <BookOpen className="h-5 w-5 text-stone-950" />
            </div>
            <h1 className="text-lg font-bold text-stone-100 tracking-tight">
              Novel Translator
            </h1>
          </div>

          {isGuest() ? (
            <div className="text-center space-y-4">
              <p className="text-sm text-stone-400">You're signed in as a guest.</p>
              <button
                onClick={finish}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-5 py-2.5 text-sm font-semibold text-stone-950 shadow-lg shadow-amber-500/25 hover:shadow-amber-500/40 transition-all cursor-pointer"
              >
                <LogIn className="h-4 w-4" />
                Open the Translator
              </button>
              <button
                onClick={() => setGuest(false)}
                className="w-full text-xs text-stone-500 hover:text-stone-300 transition-colors cursor-pointer"
              >
                Switch to email login instead
              </button>
            </div>
          ) : magicAvailable() ? (
            <>
              <p className="text-xs text-stone-400 text-center mb-5 leading-relaxed">
                Sign in with your email — we'll send a one-time link/code. No password,
                no server, stays on this device.
              </p>
              <form onSubmit={handleEmailLogin} className="space-y-3">
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-500" />
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    disabled={status === "sending" || status === "sent"}
                    className="w-full rounded-xl border border-stone-700 bg-stone-800 pl-10 pr-3 py-2.5 text-sm text-stone-200 placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-amber-400/30 disabled:opacity-50"
                  />
                </div>
                <button
                  type="submit"
                  disabled={status === "sending" || status === "sent"}
                  className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-5 py-2.5 text-sm font-semibold text-stone-950 shadow-lg shadow-amber-500/25 hover:shadow-amber-500/40 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {status === "sending" ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Sending login email…
                    </>
                  ) : status === "sent" ? (
                    <>
                      <Mail className="h-4 w-4" />
                      Email sent — check your inbox
                    </>
                  ) : (
                    <>
                      <Mail className="h-4 w-4" />
                      Continue with Email
                    </>
                  )}
                </button>
              </form>

              <div className="flex items-center gap-3 my-5">
                <div className="h-px flex-1 bg-stone-800" />
                <span className="text-[10px] uppercase tracking-wider text-stone-600">or</span>
                <div className="h-px flex-1 bg-stone-800" />
              </div>

              <button
                onClick={handleGuest}
                className="w-full flex items-center justify-center gap-2 rounded-xl border border-stone-700 bg-stone-800/60 px-5 py-2.5 text-sm font-medium text-stone-300 hover:bg-stone-800 hover:text-stone-100 transition-all cursor-pointer"
              >
                <UserRound className="h-4 w-4" />
                Continue as Guest
              </button>
            </>
          ) : (
            <div className="space-y-4 text-center">
              <p className="text-sm text-stone-400 leading-relaxed">
                Email login isn't configured yet. You can still use the translator as a
                guest — everything is saved on this device.
              </p>
              <button
                onClick={handleGuest}
                className="w-full flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-amber-600 px-5 py-2.5 text-sm font-semibold text-stone-950 shadow-lg shadow-amber-500/25 hover:shadow-amber-500/40 transition-all cursor-pointer"
              >
                <UserRound className="h-4 w-4" />
                Continue as Guest
              </button>
            </div>
          )}

          {message && (
            <p
              className={`mt-4 text-[11px] text-center leading-relaxed ${
                status === "error" ? "text-red-400" : "text-amber-300"
              }`}
            >
              {message}
            </p>
          )}
        </div>

        <button
          onClick={finish}
          className="mt-4 w-full text-center text-xs text-stone-600 hover:text-stone-400 transition-colors cursor-pointer"
        >
          Skip for now →
        </button>
      </motion.div>
    </div>
  );
}
