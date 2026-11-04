// Keeps the companion's own files on the phone, so it opens even when the
// laptop is out of reach (the recovery arrow works from the saved position).
const CACHE = "owl-companion-1";
const FILES = ["./", "index.html", "companion.css", "companion.js", "icon-180.png"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || u.pathname.startsWith("/c/")) return;     // live data always from the network
  // network first (newest app when the laptop is there), the saved copy when it isn't
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
