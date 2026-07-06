const CACHE_NAME = "mlb-edge-tracker-final-v1";
const APP_SHELL = [
  "/",
  "/index.html?v=final-1",
  "/styles.css?v=final-1",
  "/app.js?v=final-1",
  "/icon.svg",
  "/manifest.webmanifest?v=final-1"
];

self.addEventListener("install", event => {
  self.skipWaiting();

  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(APP_SHELL).catch(() => null);
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(() => {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "Offline. API data is not available right now."
          }),
          {
            headers: {
              "Content-Type": "application/json"
            },
            status: 503
          }
        );
      })
    );

    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        const copy = response.clone();

        caches.open(CACHE_NAME).then(cache => {
          cache.put(request, copy).catch(() => null);
        });

        return response;
      }).catch(() => {
        return caches.match("/") || caches.match("/index.html?v=final-1");
      });
    })
  );
});
