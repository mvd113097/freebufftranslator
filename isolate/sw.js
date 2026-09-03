/* Novel Translator — data-saving service worker.
 *
 * Goal: after the first visit, opening/reloading the published site costs almost
 * zero mobile data because the heavy JS/CSS chunks are served from this cache.
 *
 * Rules:
 *  - Page navigations: network-first (a freshly published site is always picked
 *    up), with the last cached page as an offline fallback.
 *  - Same-origin static assets (hashed JS/CSS/images): cache-first.
 *  - Everything else (Convex API, OpenRouter, Telegram, cross-origin): untouched.
 *
 * Bump CACHE_NAME whenever you want every visitor to re-download once.
 */
const CACHE_NAME = "translatebuff-static-v1";

self.addEventListener("install", (event) => {
  // Take over immediately so this worker is used right away.
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE_NAME);
        // App shell — lets the site open instantly/offline once visited.
        await cache.add("/");
      } catch {
        /* index.html may not be cacheable via add(); harmless. */
      }
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Only cache our own origin. Convex, auth, OpenRouter, Telegram stay untouched.
  if (url.origin !== self.location.origin) return;

  // Page navigations: try the network first so a new publish shows up
  // immediately, fall back to the cached page only when offline.
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
      })()
    );
    return;
  }

  // Static assets (JS/CSS/images have content hashes — they never change
  // between publishes, so cache-first is safe and saves all repeat traffic).
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
    })()
  );
});
