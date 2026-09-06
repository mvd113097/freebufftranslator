import { Toaster } from "@/components/ui/sonner";
import React, { StrictMode, Suspense, lazy, useEffect } from "react";
// App entry: routes are lazy-loaded for fast cold starts.
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";

// Route code-splitting: every route lazy-loads so the initial bundle stays
// small (this is what makes cold loads on mobile networks fast).
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Dev-only VlyToolbar (element picker + screenshot capture). Lazy-loaded so the
// heavy @zumer/snapdom code is never downloaded by published visitors.
const VlyToolbar = lazy(
  () =>
    import("../vly-toolbar-readonly.tsx").then((m) => ({
      default: m.VlyToolbar,
    }))
);

// Shared loading fallback shown while any lazy route chunk downloads.
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-950">
      <div className="animate-pulse text-sm text-stone-500">Loading…</div>
    </div>
  );
}

// Dev-only auth page keeps its own state — no backend session needed since the
// pipeline is fully client-side. The /auth route just passes through.
function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Register the data-saving service worker ONLY on the published site
 * (top-level page, https, not a dev/preview host). Preview iframes and
 * development deployments never register it, so the Freebuff editor is
 * unaffected — only real visitors on the published URL get cached assets.
 */
function registerServiceWorker() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (window.self !== window.top) return; // inside the Freebuff preview iframe
  const { hostname, protocol } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return;
  if (protocol !== "https:" && protocol !== "http:") return;
  if (hostname.endsWith(".vly.sh")) return; // dev deployment, not published
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {
        // Non-fatal — the site works normally without a service worker.
      });
  });
}

registerServiceWorker();

const rootEl = document.getElementById("root");
if (!rootEl) {
  // Preview iframe may not have the root element — render into body as fallback.
  const fallback = document.createElement("div");
  fallback.id = "root";
  document.body.appendChild(fallback);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <Suspense fallback={<RouteLoading />}>
        <VlyToolbar />
      </Suspense>
      <Suspense fallback={<RouteLoading />}>
        <BrowserRouter>
          <RouteSyncer />
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/auth" element={<AuthPage />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </Suspense>
      <Toaster />
    </RootErrorBoundary>
  </StrictMode>,
);
