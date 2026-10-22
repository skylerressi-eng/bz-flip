// Service worker: makes BZ Flip installable and fast to open.
// - The app shell is served stale-while-revalidate (instant load, updates next visit);
//   the page itself is network-first so a new deploy shows up immediately when online.
// - Live data (Hypixel, Coflnet history) always goes to the network; only item icons are cached.
const VERSION = "v2"; // bump on every asset change so installed PWAs pick up new code
const SHELL = `bzflip-shell-${VERSION}`;
const ICONS = "bzflip-icons";
const SHELL_FILES = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/css/styles.css",
  "assets/js/app.js",
  "assets/js/analysis.js",
  "assets/js/history.js",
  "assets/js/format.js",
  "assets/js/chart.js",
  "assets/js/tracker.js",
  "assets/icons/icon-192.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("bzflip-shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (await cache.match("index.html")) || Response.error();
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => {
    if (res.ok || res.type === "opaque") cache.put(req, res.clone());
    return res;
  }).catch(() => hit);
  return hit || fresh;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    // pages and refreshed data files: prefer the network
    if (req.mode === "navigate" || url.pathname.includes("/data/")) return e.respondWith(networkFirst(req));
    return e.respondWith(staleWhileRevalidate(req, SHELL));
  }
  if (url.hostname === "sky.coflnet.com" && url.pathname.startsWith("/static/icon/")) {
    return e.respondWith(staleWhileRevalidate(req, ICONS));
  }
  // everything else (live prices, history) goes straight to the network
});

// Clicking an alert focuses the open tab (or opens one) on that item.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.id ? `./#${encodeURIComponent(e.notification.data.id)}` : "./", self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (win) return win.focus().then(() => win.navigate(target));
      return self.clients.openWindow(target);
    }),
  );
});
