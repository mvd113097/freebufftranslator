/**
 * Client-side passwordless email auth via Magic (magic.link).
 *
 * No backend involved: the Magic SDK talks to Magic's API directly from the
 * browser and stores the session in the user's localStorage/IndexedDB. The
 * SDK is dynamically imported so its bundle is never downloaded unless the
 * user actually opens the auth flow.
 */

import type { Magic as MagicInstance, MagicUserMetadata } from "magic-sdk";

export type AuthMode = "user" | "guest" | "out";
export type AuthState = { mode: AuthMode; email: string | null };

const GUEST_KEY = "translatebuff.guest";

let magicInstance: MagicInstance | null = null;
let magicPromise: Promise<MagicInstance> | null = null;

/** Email login is only offered when a Magic publishable key is configured. */
export function magicAvailable(): boolean {
  return Boolean(import.meta.env.VITE_MAGIC_PUBLISHABLE_KEY);
}

/** Lazily creates (and caches) the Magic client. */
export function getMagic(): Promise<MagicInstance> {
  if (!magicPromise) {
    magicPromise = (async () => {
      // Some magic-sdk builds expect a Node-like `process` object.
      const w = window as unknown as { process?: { env?: Record<string, string> } };
      w.process ??= { env: {} };
      const { Magic } = await import("magic-sdk");
      magicInstance = new Magic(
        import.meta.env.VITE_MAGIC_PUBLISHABLE_KEY as string,
      );
      return magicInstance;
    })();
  }
  return magicPromise;
}

// ─── Guest mode (localStorage flag) ──────────────────────────────

export function isGuest(): boolean {
  try {
    return localStorage.getItem(GUEST_KEY) === "1";
  } catch {
    return false;
  }
}

export function setGuest(value: boolean): void {
  try {
    if (value) localStorage.setItem(GUEST_KEY, "1");
    else localStorage.removeItem(GUEST_KEY);
  } catch {
    /* storage unavailable */
  }
}

// ─── Session checks / login / logout ─────────────────────────────

/** Current signed-in Magic user, or null when not logged in. */
export async function getCurrentUser(): Promise<{ email: string | null } | null> {
  if (!magicAvailable()) return null;
  try {
    const magic = await getMagic();
    if (!(await magic.user.isLoggedIn())) return null;
    const meta: MagicUserMetadata = await magic.user.getInfo();
    return { email: meta.email ?? null };
  } catch {
    return null;
  }
}

/** Combined view used by the dashboard gate: user, guest, or signed out. */
export async function getAuthState(): Promise<AuthState> {
  if (isGuest()) return { mode: "guest", email: null };
  const user = await getCurrentUser();
  if (user) return { mode: "user", email: user.email };
  return { mode: "out", email: null };
}

/** Sends the login email; resolves once the user completes the code entry. */
export async function loginWithEmail(email: string): Promise<void> {
  const magic = await getMagic();
  await magic.auth.loginWithMagicLink({ email });
}

export async function logout(): Promise<void> {
  setGuest(false);
  try {
    const magic = await getMagic();
    await magic.user.logout();
  } catch {
    /* already logged out */
  }
}
