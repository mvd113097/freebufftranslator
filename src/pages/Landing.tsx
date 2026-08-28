import { motion } from "framer-motion";
import {
  BookOpen,
  Zap,
  Shield,
  Globe,
  ArrowRight,
  Languages,
  FileText,
  Sparkles,
  Upload,
} from "lucide-react";
import { useNavigate } from "react-router";

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50/80 via-indigo-50/60 to-violet-50/40">
      {/* Nav */}
      <nav className="sticky top-0 z-30 border-b border-white/40 bg-white/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-md">
              <BookOpen className="h-4 w-4 text-white" />
            </div>
            <span className="text-sm font-bold text-gray-900 tracking-tight">
              Novel Translator
            </span>
          </div>
          <button
            onClick={() => navigate("/dashboard")}
            className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 transition-all cursor-pointer"
          >
            Launch App
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden">
        {/* Decorative blobs */}
        <div className="pointer-events-none absolute -top-40 left-1/2 h-[500px] w-[800px] -translate-x-1/2 rounded-full bg-gradient-to-br from-blue-200/40 via-indigo-200/30 to-violet-200/20 blur-3xl" />

        <div className="relative mx-auto max-w-4xl px-6 pt-20 pb-16 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200/60 bg-white/50 backdrop-blur-md px-4 py-1.5 text-xs font-medium text-blue-700 mb-6 shadow-sm">
              <Sparkles className="h-3.5 w-3.5" />
              Powered by OpenRouter
            </div>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="text-4xl sm:text-5xl md:text-6xl font-extrabold tracking-tight text-gray-900 leading-[1.1]"
          >
            Translate 500k+ word{" "}
            <span className="bg-gradient-to-r from-blue-600 to-indigo-600 bg-clip-text text-transparent">
              Chinese novels
            </span>{" "}
            in minutes
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.2 }}
            className="mt-5 text-base sm:text-lg text-gray-600 max-w-2xl mx-auto leading-relaxed"
          >
            Drop a massive .txt file and let our intelligent pipeline handle the
            rest — paragraph-aware chunking, multi-key rate limiting, parallel
            translation, and real-time streaming output.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.3 }}
            className="mt-8 flex items-center justify-center gap-3"
          >
            <button
              onClick={() => navigate("/dashboard")}
              className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 px-7 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer"
            >
              Start Translating
              <ArrowRight className="h-4 w-4" />
            </button>
            <a
              href="#features"
              className="flex items-center gap-2 rounded-xl border border-gray-200/60 bg-white/50 backdrop-blur-md px-6 py-3 text-sm font-medium text-gray-700 hover:bg-white/70 transition-all"
            >
              Learn More
            </a>
          </motion.div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="mt-14 grid grid-cols-3 gap-4 max-w-lg mx-auto"
          >
            {[
              { label: "500k+", sub: "words per session" },
              { label: "<5 min", sub: "translation time" },
              { label: "∞", sub: "keys supported" },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-xl border border-white/50 bg-white/40 backdrop-blur-md p-3 shadow-sm"
              >
                <p className="text-xl font-bold text-gray-900">{stat.label}</p>
                <p className="text-[10px] text-gray-500 mt-0.5">{stat.sub}</p>
              </div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20">
        <div className="mx-auto max-w-5xl px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="text-center mb-14"
          >
            <h2 className="text-2xl sm:text-3xl font-bold text-gray-900">
              Built for massive novels
            </h2>
            <p className="mt-3 text-sm text-gray-500 max-w-md mx-auto">
              Every feature is designed to handle hundreds of thousands of words
              efficiently while respecting free-tier API limits.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {features.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.08 }}
                className="rounded-2xl border border-white/50 bg-white/40 backdrop-blur-xl p-5 shadow-sm hover:shadow-md transition-shadow"
              >
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 border border-blue-100/60 mb-3">
                  <f.icon className="h-4.5 w-4.5 text-blue-600" />
                </div>
                <h3 className="text-sm font-semibold text-gray-900">{f.title}</h3>
                <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
                  {f.desc}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="pb-20">
        <div className="mx-auto max-w-3xl px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            className="rounded-3xl border border-white/50 bg-white/50 backdrop-blur-xl p-10 text-center shadow-lg"
          >
            <h2 className="text-xl sm:text-2xl font-bold text-gray-900">
              Ready to translate your novel?
            </h2>
            <p className="mt-2 text-sm text-gray-500">
              Get a free OpenRouter API key, upload your file, and hit start.
            </p>
            <button
              onClick={() => navigate("/dashboard")}
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-600 px-7 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-500/25 hover:shadow-blue-500/40 hover:scale-[1.02] active:scale-[0.98] transition-all cursor-pointer"
            >
              Open Translator
              <ArrowRight className="h-4 w-4" />
            </button>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/40 bg-white/30 backdrop-blur-xl">
        <div className="mx-auto max-w-6xl px-6 py-5 flex items-center justify-between text-[11px] text-gray-400">
          <span>Novel Translator — Free & Open</span>
          <span>Client-side only • No data leaves your browser</span>
        </div>
      </footer>
    </div>
  );
}

const features = [
  {
    icon: Upload,
    title: "Smart File Chunking",
    desc: "Paragraph-aware splitting preserves context. Adjustable chunk sizes from 5k to 80k characters.",
  },
  {
    icon: Shield,
    title: "Multi-Key Rate Limiting",
    desc: "Per-key token-bucket rate limiter prevents hitting API limits. Staggered requests across multiple keys.",
  },
  {
    icon: Zap,
    title: "Parallel Pipeline",
    desc: "Concurrent request processing (configurable 1–10×) with exponential backoff retries on 429 errors.",
  },
  {
    icon: Languages,
    title: "Literary Translation",
    desc: "Custom system prompt for Xianxia, Wuxia, and Sci-Fi novels. Cultivation tiers and idioms translated naturally.",
  },
  {
    icon: Globe,
    title: "Real-time Streaming",
    desc: "Watch each translated token appear live in the split-screen view as Gemini generates it.",
  },
  {
    icon: FileText,
    title: "One-Click .epub Export",
    desc: "Stitched chunks are packaged into a proper EPUB file with table of contents, ready for any e-reader.",
  },
];
