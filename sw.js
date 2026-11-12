/* Service worker: оболочка приложения и Leaflet — офлайн, тайлы карты — кэш просмотренных.
 * Цены (Tankerkönig), маршруты (OSRM) и геокодинг здесь не кэшируются: последние цены хранит app.js в localStorage. */
const VERSION = "v8";
const SHELL = `tk-shell-${VERSION}`;
const TILES = `tk-tiles-${VERSION}`;
const MAX_TILES = 600;

const SHELL_FILES = ["./", "index.html", "style.css", "app.js", "manifest.webmanifest", "icon.svg",
  "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
const CDN_FILES = [
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll(SHELL_FILES);
    await cache.addAll(CDN_FILES.map(u => new Request(u, { mode: "cors" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, TILES]);
    for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Тайлы карты (CARTO / OSM): сначала кэш, затем сеть (с ограничением размера кэша).
  if (url.hostname.endsWith("tile.openstreetmap.org") || url.hostname.endsWith("basemaps.cartocdn.com")) {
    event.respondWith(cacheFirst(req, TILES, true));
    return;
  }
  // Leaflet с CDN: неизменяемые версионированные файлы.
  if (url.hostname === "unpkg.com") {
    event.respondWith(cacheFirst(req, SHELL, false));
    return;
  }
  // Файлы приложения: сначала сеть (чтобы получать обновления), при офлайне — кэш.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
  }
  // Остальное (API цен, Nominatim) — напрямую в сеть.
});

async function cacheFirst(req, cacheName, trim) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const resp = await fetch(req);
    if (resp.ok || resp.type === "opaque") {
      await cache.put(req, resp.clone());
      if (trim) trimCache(cache);
    }
    return resp;
  } catch {
    return new Response("", { status: 504, statusText: "offline" });
  }
}

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    // no-cache: всегда сверяться с сервером, чтобы обновления приложения приходили сразу
    const resp = await fetch(req, { cache: "no-cache" });
    if (resp.ok) cache.put(req, resp.clone());
    return resp;
  } catch {
    return (await cache.match(req, { ignoreSearch: true }))
      || (req.mode === "navigate" ? cache.match("index.html") : undefined)
      || new Response("offline", { status: 503 });
  }
}

// ---------- Утреннее уведомление (push из GitHub Actions) ----------
function showPush(data) {
  const actions = data.route ? [{ action: "route", title: "🧭 Маршрут к №1" }] : [];
  return self.registration.showNotification(data.title || "TankKarte", {
    body: data.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: "tk-morning",
    renotify: true,
    actions,
    data: { route: data.route || null },
  });
}

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() || "" }; }
  event.waitUntil(showPush(data));
});

self.addEventListener("message", event => {
  if (event.data?.type === "test-push") event.waitUntil(showPush(event.data.payload || {}));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const route = event.notification.data?.route;
  event.waitUntil((async () => {
    if (event.action === "route" && route) return self.clients.openWindow(route);
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const app = wins.find(w => new URL(w.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (app) { await app.focus(); return; }
    return self.clients.openWindow(self.registration.scope);
  })());
});

let trimming = false;
async function trimCache(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
  } finally {
    trimming = false;
  }
}
