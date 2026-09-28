// Service worker for the browser phone (/device/). It makes the phone installable and lets it
// start without a network: the app shell comes from the cache, everything live (API, sockets)
// always goes to the network. A new build takes over on the next launch.
const CACHE = "olp-phone-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(["./", "manifest.webmanifest", "icon.svg"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (!url.pathname.startsWith("/device/")) return; // API, sockets, the companion app
  // Network first so a fresh build shows up; fall back to the cached shell when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          void caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        if (req.mode === "navigate") return (await caches.match("./")) ?? Response.error();
        return Response.error();
      }),
  );
});
