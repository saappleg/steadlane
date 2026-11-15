const CACHE_NAME = "steadlane-shell-v3";
const APP_SHELL = [
  "/",
  "/index.html",
  "/src/styles.css",
  "/src/app.js",
  "/src/auth.js",
  "/src/booking-api.js",
  "/src/map.js",
  "/src/pricing.js",
  "/manifest.webmanifest",
  "/assets/steadlane-icon.svg",
];
const SHELL_PATHS = new Set(APP_SHELL);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("steadlane-shell-") && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin || !SHELL_PATHS.has(url.pathname)) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch {
        return (await caches.match(request))
          || (await caches.match("/index.html"))
          || caches.match("/");
      }
    })());
    return;
  }

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;

      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        await caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    }),
  );
});
