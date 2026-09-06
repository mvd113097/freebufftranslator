import { api } from "@/convex/_generated/api";
import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";

export function useAuth() {
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.currentUser);
  const { signIn, signOut } = useAuthActions();

  // If Convex auth is stuck loading for too long, give up and treat as unauthenticated.
  // This prevents the preview from hanging forever on a loading spinner when the
  // Convex deployment is unreachable or the VITE_CONVEX_URL is wrong.
  const timedOut = useRef(false);
  const [authTimedOut, setAuthTimedOut] = useState(false);

  useEffect(() => {
    if (!isAuthLoading || authTimedOut) return;
    const timer = setTimeout(() => {
      timedOut.current = true;
      setAuthTimedOut(true);
    }, 15_000);
    return () => clearTimeout(timer);
  }, [isAuthLoading, authTimedOut]);

  // Derive isLoading directly from the dependencies instead of managing separate state
  const isLoading = isAuthLoading || user === undefined;

  return {
    isLoading: authTimedOut ? false : isLoading,
    isAuthenticated: authTimedOut ? false : isAuthenticated,
    user: authTimedOut ? null : user,
    signIn,
    signOut,
  };
}
