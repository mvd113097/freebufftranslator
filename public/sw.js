/* Novel Translator — data-saving service worker (PUBLISHED SITES ONLY).
 *
 * Goal: after the first visit, opening the published site costs almost zero
 * mobile data because the heavy JS/CSS chunks are served from this cache.
 *
 * IMPORTANT: this worker must never control a dev environment. Dev servers
 * change file hashes on every edit, so cached assets there go stale and break
 * the site. The register code in main.tsx also refuses to register on dev
 * hosts; this check is a second line of defense for any worker already
 * installed on a dev URL.
 *
 * Rules:
 *  - Page navigations: network-first (a fresh publish is always picked up),
 *    with the last cached page as an offline fallback.
 *  - Same-origin static assets (hashed JS/CSS/images): cache-first.
 *  - Everything else (API calls, Telegram, cross-origin): untouched.
 *
 * Bump CACHE_NAME whenever you want every visitor to re-download once.
 */
const CACHE_NAME = "translatebuff-static-v2";

// Any host that serves a live dev server must never be cached.
const DEV_HOST_SUFFIXES = [".vly.sh", ".freebuff.dev", "localhost"];

self.addEventListener("install", (event) => {
  const url = self.location.href;
  const isDev = DEV_HOST_SUFFIXES.some(
    (s) => url.includes(s) || new URL(url).hostname === s,
  );
  if (isDev) {
    // Dev environment: do nothing and remove ourselves immediately.
    self.registration.unregister().catch(() => {});
    event.waitUntil(Promise.resolve());
    return;
  }
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        await cache.add("/");
      } catch {
        /* index.html may not be cacheable via add(); harmless. */
      }
    })(),
  );
});

self.addEventListener("activate", (event) => {
  const url = self.location.href;
  const isDev = DEV_HOST_SUFFIXES.some((s) => url.includes(s));
  event.waitUntil(
    (async () => {
      // Clean up every cache we own (also wipes stale caches from old versions).
      const keys = await caches.keys();
      if (isDev) {
        await Promise.all(keys.map((key) => caches.delete(key)));
        await self.registration.unregister().catch(() => {});
      } else {
        await Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        );
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  // Dev environment: never intercept anything.
  const url = new URL(request.url);
  if (DEV_HOST_SUFFIXES.some((s) => url.hostname.endsWith(s))) return;

  // Only cache our own origin. API calls and cross-origin requests untouched.
  if (url.origin !== self.location.origin) return;

  // Page navigations: network-first so a new publish shows up immediately;
  // fall back to the cached page only when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put("/", fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match("/");
          return cached || Response.error();
        }
      })(),
    );
    return;
  }

  // Static assets (content-hashed — they never change between publishes,
  // so cache-first is safe and saves all repeat traffic).
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(request);
      if (cached) return cached;
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          cache.put(request, response.clone());
        }
        return response;
      } catch {
        return Response.error();
      }
    })(),
  );
});
