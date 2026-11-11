// Podium service worker: keeps the app shell available offline. API calls (/v1) and downloads always go to the network.
const SHELL = "architect-podium-v11";
const FILES = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/firm-suite.js", "/firm-suite.css"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/v1/") || url.pathname.startsWith("/download")) return;
  // Network first, so a new Podium shows up at once; the cache answers when the server is unreachable.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(url.pathname === "/" ? "/" : e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.pathname === "/" ? "/" : e.request).then((r) => r || Response.error())),
  );
});
