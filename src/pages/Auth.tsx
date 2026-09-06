import { useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router";

/**
 * Auth is no longer required — the app is fully client-side with no backend.
 * This page simply forwards to the dashboard, preserving ?returnTo if present.
 */
export default function AuthPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    const returnTo = searchParams.get("returnTo");
    const target =
      returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
        ? returnTo
        : "/dashboard";
    navigate(target, { replace: true });
  }, [navigate, searchParams]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-950">
      <p className="text-sm text-stone-400">Opening translator…</p>
    </div>
  );
}
