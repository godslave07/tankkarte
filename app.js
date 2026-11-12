"use strict";
/* TankKarte — карта цен на топливо (Tankerkönig API v4 + OpenStreetMap). */

// ============================ Конфигурация ============================
const DEMO_KEY = "00000000-0000-0000-0000-000000000002";
const API_URL = "https://creativecommons.tankerkoenig.de/api/v4/stations/search";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const PHOTON_URL = "https://photon.komoot.io/api/";   // подсказки при вводе (Nominatim автодополнение запрещает)
const DE_BBOX = "5.86,47.27,15.05,55.06";
const OSRM_URL = "https://router.project-osrm.org/route/v1/driving/";   // маршруты по дорогам (OSM)
/**
 * «Лучший выбор» = самая низкая цена в радиусе; если таких заправок несколько — ближайшая из них.
 * BEST_TOLERANCE — допуск к минимуму в €/л (0 = строго самая дешёвая; 0.01 = «дешевле на 1 ц не важно»).
 */
const BEST_TOLERANCE = 0;
const AUTO_REFRESH_MS = 5 * 60 * 1000;   // ограничение Tankerkönig: не чаще раза в 5 минут
const MANUAL_MIN_MS = 20 * 1000;         // защита от многократных нажатий «Обновить»
const RADII = [5, 10, 15, 25];
const FUELS = [
  { id: "e5", name: "Super E5", short: "E5" },
  { id: "e10", name: "Super E10", short: "E10" },
  { id: "diesel", name: "Diesel", short: "Diesel" },
];
const FUEL_BY_API_NAME = { "super e5": "e5", "super e10": "e10", "diesel": "diesel" };
const GERMANY = { lat: 51.163, lng: 10.447, zoom: 6 };

// ============================ Хранилище ============================
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* квота / приватный режим */ }
  },
};

const settings = {
  apiKey: store.get("tk.key", ""),
  hideClosed: store.get("tk.hideClosed", false),
};
const prefs = Object.assign({ fuel: "e5", radius: 10, sort: "price" }, store.get("tk.prefs", {}));
const savePrefs = () => store.set("tk.prefs", { fuel: state.fuel, radius: state.radius, sort: state.sort });

const state = {
  fuel: prefs.fuel,
  radius: RADII.includes(prefs.radius) ? prefs.radius : 10,
  sort: prefs.sort,
  center: null,        // { lat, lng, label, kind: "location" | "city" | "point" }
  me: null,            // { lat, lng, acc }
  data: null,          // { center, radius, fetchedAt, stations }  — тоже кэшируется
  selectedId: null,
  bestId: null,
  loading: false,
  offline: false,
};

// ============================ Утилиты ============================
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** 1.789 → «1,78<sup>9</sup>» как на табло заправки. */
function fmtPrice(p, withEuro = false) {
  if (p == null) return "—";
  const [i, d] = p.toFixed(3).split(".");
  return `${i},${d.slice(0, 2)}<sup>${d[2]}</sup>${withEuro ? " €" : ""}`;
}
const fmtPlain = p => (p == null ? "—" : p.toFixed(2).replace(".", ","));
const fmtKm = km => `${km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)} км`;

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${time}`;
}
function fmtAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  return fmtTime(ts);
}
/** API отдаёт «2026-11-09T19:55:46+01» — дополняем смещение до ISO-формата. */
function parseTs(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(/([+-]\d\d)$/, "$1:00"));
  return Number.isNaN(t) ? null : t;
}
function haversineKm(a, b) {
  const R = 6371, rad = x => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const sameCenter = (a, b) => a && b && haversineKm(a, b) < 0.05;
const isWide = () => matchMedia("(min-width: 900px)").matches;

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

/** Одна строка-баннер под фильтрами: ошибки, офлайн, демо-ключ. */
function showBanner(html, kind = "info") {
  const b = $("banner");
  b.innerHTML = html; b.className = `banner ${kind === "error" ? "error" : ""}`; b.hidden = false;
  b.querySelector("[data-open-settings]")?.addEventListener("click", openSettings);
}
function hideBanner() { $("banner").hidden = true; }
function showDefaultBanner() { hideBanner(); }

// ============================ Данные: Tankerkönig ============================
class NetworkError extends Error {}

function normalizeStation(s) {
  const prices = {};
  for (const f of s.fuels || []) {
    const key = FUEL_BY_API_NAME[String(f.name).toLowerCase()];
    if (!key || typeof f.price !== "number" || f.price <= 0) continue;
    prices[key] = {
      price: f.price,
      ts: parseTs(f.lastChange?.timestamp),
      amount: typeof f.lastChange?.amount === "number" ? f.lastChange.amount : null,
    };
  }
  return {
    id: s.id,
    name: (s.name || "").trim(),
    brand: (s.brand || "").trim(),
    street: (s.street || "").trim(),
    postalCode: s.postalCode || "",
    place: (s.place || "").trim(),
    lat: s.coords?.lat,
    lng: s.coords?.lng,
    dist: Number(s.dist) || 0,
    isOpen: !!s.isOpen,
    prices,
  };
}

async function fetchStations(center, radius) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    apikey: settings.apiKey || DEMO_KEY,
    lat: center.lat.toFixed(6),
    lng: center.lng.toFixed(6),
    rad: radius,
  });
  let resp;
  try { resp = await fetch(url, { cache: "no-store" }); }
  catch { throw new NetworkError("Нет соединения с сервером"); }
  let body = null;
  try { body = await resp.json(); } catch { /* не JSON */ }
  if (!resp.ok) {
    const m = body?.message || "";
    if (/apikey/i.test(m) || resp.status === 401 || resp.status === 403) {
      throw new Error("Неверный API-ключ Tankerkönig — проверьте настройки.");
    }
    if (resp.status === 429) throw new Error("Слишком много запросов к Tankerkönig, попробуйте позже.");
    throw new Error(`Ошибка Tankerkönig (${resp.status}${m ? `: ${m}` : ""})`);
  }
  return (body?.stations || []).map(normalizeStation).filter(s => s.lat != null && s.lng != null);
}

// ============================ Данные: геокодинг и геолокация ============================
async function geocode(query) {
  const url = new URL(NOMINATIM_URL);
  url.search = new URLSearchParams({ q: query, format: "jsonv2", limit: 1, countrycodes: "de" });
  let resp;
  try { resp = await fetch(url, { headers: { "Accept-Language": "de,ru" } }); }
  catch { throw new NetworkError("Геокодер недоступен — нет сети"); }
  if (!resp.ok) throw new Error(`Геокодер: ошибка ${resp.status}`);
  const [place] = await resp.json();
  if (!place) throw new Error(`«${query}» не найден в Германии`);
  return { lat: +place.lat, lng: +place.lon, label: place.name || place.display_name.split(",")[0] || query, kind: "city" };
}

/** Подсказки населённых пунктов Германии по мере ввода (Photon / OSM). */
async function suggestPlaces(query, signal) {
  const url = new URL(PHOTON_URL);
  url.search = new URLSearchParams({ q: query, limit: 12, lang: "de", bbox: DE_BBOX, osm_tag: "place" });
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`Photon ${resp.status}`);
  const body = await resp.json();
  const seen = new Set();
  const out = [];
  for (const f of body.features || []) {
    const p = f.properties || {};
    if (p.countrycode && p.countrycode.toUpperCase() !== "DE") continue;
    const [lng, lat] = f.geometry?.coordinates || [];
    if (lat == null || !p.name) continue;
    const parts = [p.postcode, p.city && p.city !== p.name ? p.city : null, p.county, p.state]
      .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
    const sub = parts.join(", ");
    const key = `${p.name}|${p.county || p.state || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat, lng, label: p.name, sub, kind: "city" });
    if (out.length >= 7) break;
  }
  return out;
}

class GeoError extends Error {
  constructor(message, hint) { super(message); this.hint = hint; }
}
const WIN_LOCATION_HINT = "Проверьте, что в Windows включено «Расположение» и разрешён доступ для приложений: " +
  "Параметры → Конфиденциальность и защита → Расположение.";

const toPos = p => ({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy });

async function getPosition() {
  if (!("geolocation" in navigator)) throw new GeoError("Браузер не поддерживает геолокацию.");
  if (!window.isSecureContext) {
    throw new GeoError("Геолокация работает только по HTTPS или на localhost.");
  }
  // Статус разрешения используем только для текста ошибки: запрос делаем всегда,
  // потому что «denied» бывает устаревшим (разрешили, но не перезагрузили)
  // или идёт от Windows, а не от настроек сайта.
  const perm = await navigator.permissions?.query({ name: "geolocation" }).catch(() => null);
  watchPermission(perm);
  // Сначала быстрый «грубый» запрос (Wi-Fi/сеть) — для радиуса 5–25 км этого достаточно,
  // а на компьютере без GPS высокоточный режим часто упирается в таймаут.
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      p => resolve(toPos(p)),
      err => {
        console.warn("Geolocation error", err.code, err.message, "permission:", perm?.state);
        if (err.code === err.PERMISSION_DENIED) {
          reject(new GeoError("Нет доступа к местоположению.",
            "1) В браузере: значок слева от адреса → «Геоданные» → «Разрешить». " +
            "2) Если там уже «Разрешено», доступ закрыт в Windows: " +
            "Параметры → Конфиденциальность и защита → Расположение — включите «Службы определения расположения» " +
            "и «Разрешить классическим приложениям доступ к расположению». Затем нажмите «Повторить»."));
        } else if (err.code === err.TIMEOUT) {
          reject(new GeoError("Местоположение не определилось за 15 секунд.", "Попробуйте ещё раз. " + WIN_LOCATION_HINT));
        } else {
          reject(new GeoError("Устройство не смогло определить местоположение.", WIN_LOCATION_HINT));
        }
      },
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 },
    );
  });
}

/** Как только пользователь разрешит доступ в браузере — повторяем поиск сам, без перезагрузки. */
let permWatched = false;
function watchPermission(perm) {
  if (!perm || permWatched) return;
  permWatched = true;
  perm.addEventListener("change", () => {
    if (perm.state !== "denied" && (!state.center || state.center.kind === "location")) searchMyLocation();
  });
}

/** После первого успешного определения следим за положением: точка «я» и круг точности двигаются. */
let watchId = null;
function startWatching() {
  if (watchId != null || !("geolocation" in navigator)) return;
  watchId = navigator.geolocation.watchPosition(
    p => {
      state.me = toPos(p);
      drawMe();
      // Сдвинулись заметно — пересчитать «лучший выбор» и маршрут (не чаще раза в 20 с).
      if (lastRouteOrigin && haversineKm(state.me, lastRouteOrigin) > 0.3 && Date.now() - lastRouteAt > 20000) renderAll();
    },
    err => console.warn("watchPosition", err.code, err.message),
    { enableHighAccuracy: true, maximumAge: 30000 },
  );
}

// ============================ Карта ============================
const map = L.map("map", { zoomControl: false, attributionControl: true, worldCopyJump: true })
  .setView([GERMANY.lat, GERMANY.lng], GERMANY.zoom);
L.control.zoom({ position: "topright" }).addTo(map);
// Светлая карта OpenStreetMap (без ключа; лёгкое «смягчение» цветов — в style.css).
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · ' +
    'Маршруты: <a href="https://project-osrm.org/">OSRM</a> · ' +
    'Цены: <a href="https://creativecommons.tankerkoenig.de/">Tankerkönig</a> (CC BY 4.0)',
}).addTo(map);
map.attributionControl.setPrefix(false);

const stationsLayer = L.layerGroup().addTo(map);
const markers = new Map();
let radiusCircle = null, centerMarker = null, meMarker = null;

function drawCenter() {
  const c = state.center;
  if (!c) return;
  const ll = [c.lat, c.lng];
  const style = { color: "#1a9fff", weight: 2.5, fillColor: "#33ccff", fillOpacity: 0.06, dashArray: "8 8", interactive: false };
  if (!radiusCircle) radiusCircle = L.circle(ll, { ...style, radius: state.radius * 1000 }).addTo(map);
  else radiusCircle.setLatLng(ll).setRadius(state.radius * 1000);

  if (c.kind === "location") {
    centerMarker?.remove(); centerMarker = null;
  } else {
    const icon = L.divIcon({ className: "", html: '<div class="center-pin">📍</div>', iconSize: [26, 26], iconAnchor: [13, 25] });
    if (!centerMarker) centerMarker = L.marker(ll, { icon, interactive: false, zIndexOffset: -1000 }).addTo(map);
    else centerMarker.setLatLng(ll);
  }
}

function drawMe() {
  if (!state.me) return;
  const ll = [state.me.lat, state.me.lng];
  const icon = L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  if (!meMarker) meMarker = L.marker(ll, { icon, interactive: false, zIndexOffset: -500 }).addTo(map);
  else meMarker.setLatLng(ll);
  const acc = Math.min(state.me.acc || 0, 5000);
  if (!accCircle) {
    accCircle = L.circle(ll, { radius: acc, interactive: false, stroke: false, fillColor: "#3d9bff", fillOpacity: 0.15 }).addTo(map);
  } else accCircle.setLatLng(ll).setRadius(acc);
}
let accCircle = null;

function fitToRadius() {
  if (!radiusCircle) return;
  const top = document.querySelector(".topbar").getBoundingClientRect().bottom;
  const wide = isWide();
  map.fitBounds(radiusCircle.getBounds(), {
    paddingTopLeft: [wide ? 430 : 8, top + 8],
    paddingBottomRight: [wide ? 16 : 8, wide ? 16 : sheetPeekPx() + 8],
    maxZoom: 15,
  });
}

/** Показать точку в видимой части карты (не под карточкой / панелью). */
function panToVisible(lat, lng) {
  const z = Math.max(map.getZoom(), 14);
  const p = map.project([lat, lng], z);
  const card = $("card");
  const off = isWide() ? L.point(-210, 0) : L.point(0, card.hidden ? 0 : card.offsetHeight / 2 - 30);
  map.flyTo(map.unproject(p.add(off), z), z, { duration: 0.6 });
}

map.on("zoomend", () => {
  if (state.data && (map.getZoom() < COMPACT_ZOOM) !== compactMode) renderMarkers(visibleStations());
});

// ============================ Вычисления над списком ============================
function visibleStations() {
  const d = state.data;
  if (!d) return [];
  // Данные запрошены с радиусом ≥ текущего — уменьшение радиуса фильтруем локально.
  return d.stations.filter(s => s.dist <= state.radius + 1e-9 && (!settings.hideClosed || s.isOpen));
}
const priceOf = (s, fuel = state.fuel) => s.prices[fuel]?.price ?? null;

function sortStations(list) {
  const arr = [...list];
  if (state.sort === "dist") return arr.sort((a, b) => a.dist - b.dist);
  return arr.sort((a, b) => {
    const pa = priceOf(a), pb = priceOf(b);
    if (pa == null && pb == null) return a.dist - b.dist;
    if (pa == null) return 1;             // без цены — в конец
    if (pb == null) return -1;
    return pa - pb || a.dist - b.dist;
  });
}

/** Цвет по месту цены среди заправок в радиусе: зелёный → жёлтый → красный. */
function makeColorScale(list) {
  const prices = list.map(s => priceOf(s)).filter(p => p != null).sort((a, b) => a - b);
  const min = prices[0], max = prices[prices.length - 1];
  const color = p => {
    if (p == null) return null;
    if (max - min < 0.0005) return "hsl(130 55% 36%)";
    // ранг (а не линейная шкала), чтобы одна дорогая заправка не «сплющила» остальные
    let lo = 0;
    while (lo < prices.length && prices[lo] < p) lo++;
    const t = Math.min(1, lo / (prices.length - 1));
    return `hsl(${Math.round(130 * (1 - t))} 62% ${t > 0.35 && t < 0.65 ? 34 : 38}%)`;
  };
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  return { color, min, max, avg, count: prices.length };
}

// ============================ Лучший выбор и маршрут ============================
const byId = id => (id ? visibleStations().find(s => s.id === id) : null);

/** Откуда строим маршрут: от меня, если я рядом с зоной поиска, иначе от центра поиска. */
function routeOrigin() {
  const c = state.data?.center || state.center;
  if (state.me && (!c || c.kind === "location" || haversineKm(state.me, c) < 60)) {
    return { lat: state.me.lat, lng: state.me.lng, isMe: true };
  }
  return c ? { lat: c.lat, lng: c.lng, isMe: false } : null;
}

/** Самая дешёвая (± BEST_TOLERANCE), при равной цене — ближайшая. Открытые важнее закрытых. */
function findBest(list) {
  const priced = list.filter(s => priceOf(s) != null);
  const pool = priced.some(s => s.isOpen) ? priced.filter(s => s.isOpen) : priced;
  if (!pool.length) return null;
  const min = Math.min(...pool.map(s => priceOf(s)));
  const o = routeOrigin();
  const dist = s => (o ? haversineKm(o, s) : s.dist);
  const tier = pool
    .filter(s => priceOf(s) <= min + BEST_TOLERANCE + 1e-6)
    .sort((a, b) => dist(a) - dist(b) || priceOf(a) - priceOf(b));
  bestTierSize = tier.length;
  return tier[0];
}
let bestTierSize = 0;

const gmapsUrl = s => `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving`;

const routeLayer = L.layerGroup().addTo(map);
const routeCache = new Map();     // "origin>stationId" → { coords, km, min, straight }
let routeSeq = 0, lastRouteOrigin = null, lastRouteAt = 0;
const routeKey = (o, s) => `${o.lat.toFixed(3)},${o.lng.toFixed(3)}>${s.id}`;

async function fetchRoute(o, s) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const url = `${OSRM_URL}${o.lng.toFixed(5)},${o.lat.toFixed(5)};${s.lng.toFixed(5)},${s.lat.toFixed(5)}` +
      "?overview=full&geometries=geojson";
    const resp = await fetch(url, { signal: ctrl.signal });
    const body = await resp.json();
    const r = body?.routes?.[0];
    if (!resp.ok || body.code !== "Ok" || !r) throw new Error(body?.message || "no route");
    return { coords: r.geometry.coordinates.map(([x, y]) => [y, x]), km: r.distance / 1000, min: r.duration / 60, straight: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Маршрут к выбранной заправке, а если ничего не выбрано — к «лучшему выбору». */
async function updateRoute() {
  const target = byId(state.selectedId) || byId(state.bestId);
  const o = routeOrigin();
  if (!target || !o) { routeLayer.clearLayers(); renderRouteInfo(); return; }
  const key = routeKey(o, target);
  const seq = ++routeSeq;
  lastRouteOrigin = { lat: o.lat, lng: o.lng };
  lastRouteAt = Date.now();
  let r = routeCache.get(key);
  if (!r) {
    const straight = { coords: [[o.lat, o.lng], [target.lat, target.lng]], km: haversineKm(o, target), straight: true };
    drawRoute(straight, true);                      // пока ждём ответ — пунктир по прямой
    try { r = await fetchRoute(o, target); routeCache.set(key, r); }
    catch (e) { console.warn("OSRM:", e.message); r = straight; }
    if (seq !== routeSeq) return;
  }
  drawRoute(r, false);
  renderRouteInfo();
}

function drawRoute(r, pending) {
  routeLayer.clearLayers();
  const opts = { interactive: false, lineCap: "round", lineJoin: "round" };
  if (r.straight) {
    L.polyline(r.coords, { ...opts, color: "#1a9fff", weight: 4, opacity: pending ? 0.5 : 0.8, dashArray: "2 10" }).addTo(routeLayer);
  } else {
    L.polyline(r.coords, { ...opts, color: "#ffffff", weight: 11, opacity: 1 }).addTo(routeLayer);
    L.polyline(r.coords, { ...opts, color: "#1a9fff", weight: 6, opacity: 1 }).addTo(routeLayer);
  }
}

/** Текст «🚗 7,2 км · 11 мин» (по дороге) или «📏 6,1 км по прямой». */
function routeText(s) {
  const o = routeOrigin();
  if (!o || !s) return "";
  const r = routeCache.get(routeKey(o, s));
  const from = o.isMe ? "" : " от центра поиска";
  if (r && !r.straight) return `🚗 ${fmtKm(r.km)} · ${fmtDuration(r.min)}${from}`;
  return `📏 ${fmtKm(haversineKm(o, s))} по прямой${from}`;
}
function fmtDuration(min) {
  const m = Math.max(1, Math.round(min));
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function renderBest() {
  const el = $("best");
  const s = byId(state.bestId);
  if (!s) { el.hidden = true; return; }
  const p = priceOf(s);
  const fuel = FUELS.find(f => f.id === state.fuel).short;
  el.innerHTML = `
    <div class="bp" style="--c:${scale.color(p) || "var(--ok)"}">${fmtPrice(p)}</div>
    <div class="bi">
      <div class="bt">⭐ Дешевле всех · ${fuel}${bestTierSize > 1 ? ` · ближайшая из ${bestTierSize}` : ""}</div>
      <div class="bn">${esc(s.brand || s.name)}</div>
      <div class="bm" id="bestRoute">${routeText(s)} <span class="muted">· ${s.isOpen ? "открыто" : "закрыто"}</span></div>
    </div>
    <a class="btn go" href="${gmapsUrl(s)}" target="_blank" rel="noopener" title="Маршрут в Google Maps">🧭 Поехать</a>`;
  el.hidden = false;
}

function renderRouteInfo() {
  const best = byId(state.bestId);
  const br = $("bestRoute");
  if (best && br) br.innerHTML = `${routeText(best)} <span class="muted">· ${best.isOpen ? "открыто" : "закрыто"}</span>`;
  const sel = byId(state.selectedId);
  const cr = $("cardRoute");
  if (sel && cr) cr.textContent = routeText(sel);
}

// ============================ Отрисовка ============================
let scale = makeColorScale([]);

function renderAll() {
  const list = visibleStations();
  scale = makeColorScale(list);
  state.bestId = findBest(list)?.id ?? null;
  renderMarkers(list);
  renderList(list);
  renderBest();
  renderSheetHeader(list);
  renderControls();
  if (state.selectedId) {
    const s = list.find(x => x.id === state.selectedId);
    if (s) renderCard(s); else closeCard({ route: false });
  }
  updateRoute();
}

// При мелком масштабе подписи с ценой только у самых дешёвых, остальные — цветные точки.
const COMPACT_ZOOM = 13;
const LABELS_WHEN_COMPACT = 12;
let compactMode = null;

function renderMarkers(list) {
  stationsLayer.clearLayers();
  markers.clear();
  compactMode = map.getZoom() < COMPACT_ZOOM;
  const sorted = [...list].sort((a, b) => (priceOf(b) ?? 99) - (priceOf(a) ?? 99)); // дешёвые рисуем поверх
  sorted.forEach((s, i) => {
    const p = priceOf(s);
    const isBest = s.id === state.bestId;
    const rankFromCheapest = sorted.length - 1 - i;
    const dot = compactMode && !isBest && s.id !== state.selectedId &&
      (p == null || rankFromCheapest >= LABELS_WHEN_COMPACT);
    const cls = ["pin", p == null ? "none" : "", dot ? "dot" : "", isBest ? "best" : "",
      s.isOpen ? "" : "closed", s.id === state.selectedId ? "sel" : ""].join(" ");
    const icon = L.divIcon({
      className: "pin-wrap",
      html: `<div class="${cls}" style="--c:${scale.color(p) || "#9aa6b2"}">${isBest ? '<span class="tag">⭐ ДЕШЕВЛЕ ВСЕХ</span>' : ""}${fmtPrice(p)}</div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    const m = L.marker([s.lat, s.lng], {
      icon,
      zIndexOffset: s.id === state.selectedId ? 100000 : isBest ? 90000 : i * 10,
      title: `${s.brand || s.name}: ${p == null ? "нет цены" : fmtPlain(p) + " €"}`,
      keyboard: true,
    });
    m.on("click", () => selectStation(s.id, { pan: false }));
    m.addTo(stationsLayer);
    markers.set(s.id, m);
  });
}

function renderList(list) {
  const el = $("list");
  if (state.loading && !state.data) {
    el.innerHTML = `<li class="empty">Загрузка…</li>`;
    return;
  }
  if (!state.data) {
    el.innerHTML = `<li class="empty">Разрешите геолокацию или введите город.</li>`;
    return;
  }
  if (!list.length) {
    el.innerHTML = `<li class="empty">В радиусе ${state.radius} км заправок не найдено.</li>`;
    return;
  }
  el.innerHTML = sortStations(list).map(s => {
    const p = priceOf(s);
    return `<li data-id="${esc(s.id)}" class="${s.id === state.selectedId ? "sel" : ""}">
      <div class="price" style="--c:${scale.color(p) || "#4b5560"}">${fmtPrice(p)}</div>
      <div class="info">
        <div class="name">${s.id === state.bestId ? '<span class="star">⭐</span> ' : ""}${esc(s.brand || s.name)}</div>
        <div class="addr">${esc([s.street, s.place].filter(Boolean).join(", "))}</div>
      </div>
      <div class="meta">
        <div>${fmtKm(s.dist)}</div>
        <div class="${s.isOpen ? "open" : "closed-txt"}">${s.isOpen ? "открыто" : "закрыто"}</div>
      </div>
      <a class="go-mini" href="${gmapsUrl(s)}" target="_blank" rel="noopener" title="Маршрут в Google Maps" aria-label="Маршрут в Google Maps">🧭</a>
    </li>`;
  }).join("");
}

function renderSheetHeader(list) {
  const d = state.data;
  const fuelName = FUELS.find(f => f.id === state.fuel).short;
  $("sheetTitle").textContent = d
    ? `${d.center.label} · ${list.length} ${plural(list.length, "заправка", "заправки", "заправок")}`
    : (state.loading ? "Поиск заправок…" : "Где искать?");
  $("sheetSub").textContent = d
    ? `${state.radius} км · ${state.offline ? "нет сети, данные от " + fmtTime(d.fetchedAt) : "обновлено " + fmtAgo(d.fetchedAt)}`
    : "";
  $("stats").innerHTML = scale.count
    ? `${fuelName}: <span class="open">${fmtPlain(scale.min)}</span> – <span class="closed-txt">${fmtPlain(scale.max)}</span> €`
    : "";
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function renderControls() {
  const mark = (sel, attr, value) => document.querySelectorAll(`${sel} button`).forEach(b => {
    const on = b.dataset[attr] === String(value);
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  });
  mark("#fuelSeg", "fuel", state.fuel);
  mark("#radiusSeg", "rad", state.radius);
  mark("#sortSeg", "sort", state.sort);
  $("refreshBtn").classList.toggle("spin", state.loading);
  $("refreshBtn").disabled = state.loading;
  $("locateBtn").classList.toggle("active", state.center?.kind === "location");
}

// ---------- карточка заправки ----------
function renderCard(s) {
  const card = $("card");
  const d = state.data;
  const fromMe = state.me && d.center.kind !== "location" ? haversineKm(state.me, s) : null;
  const distTxt = d.center.kind === "location"
    ? `${fmtKm(s.dist)} от вас`
    : `${fmtKm(s.dist)} от точки поиска${fromMe != null ? ` · ${fmtKm(fromMe)} от вас` : ""}`;
  const lastTs = Math.max(0, ...Object.values(s.prices).map(p => p.ts || 0)) || null;
  const addr = [s.street, [s.postalCode, s.place].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const showBrand = s.brand && s.brand.toLowerCase() !== s.name.toLowerCase();

  card.innerHTML = `
    <div class="card-head">
      <div class="t">
        ${s.id === state.bestId ? '<div class="best-badge">⭐ САМАЯ НИЗКАЯ ЦЕНА</div>' : ""}
        ${showBrand ? `<div class="brand">${esc(s.brand)}</div>` : ""}
        <h2>${esc(s.name || s.brand)}</h2>
        <div class="addr">${esc(addr)}</div>
      </div>
      <button class="ico-btn" id="cardClose" aria-label="Закрыть">✕</button>
    </div>
    <div class="chips">
      <span class="chip route" id="cardRoute">${routeText(s)}</span>
      <span class="chip ${s.isOpen ? "open" : "closed-txt"}">${s.isOpen ? "● Открыто" : "● Закрыто"}</span>
      <span class="chip">📍 ${distTxt}</span>
      <span class="chip">🕒 цена изменена ${fmtTime(lastTs)}</span>
    </div>
    <div class="fuels">
      ${FUELS.map(f => {
        const p = s.prices[f.id];
        const amt = p?.amount;
        const change = amt ? `<span class="${amt > 0 ? "up" : "down"}">${amt > 0 ? "▲" : "▼"}${Math.abs(amt).toFixed(2).replace(".", ",")}</span> ` : "";
        return `<div class="fuel ${f.id === state.fuel ? "sel" : ""}">
          <div class="n">${f.name}</div>
          <div class="p">${fmtPrice(p?.price ?? null)}</div>
          <div class="u">${p ? `${change}${fmtTime(p.ts)}` : "нет в продаже"}</div>
        </div>`;
      }).join("")}
    </div>
    <div class="row-btns">
      <a class="btn primary" href="${gmapsUrl(s)}" target="_blank" rel="noopener">🧭 Поехать — Google Maps</a>
      <button class="btn tonal" id="cardList">Список</button>
    </div>`;
  card.hidden = false;
  if (!isWide()) $("sheet").classList.add("hidden-by-card");
  $("cardClose").onclick = closeCard;
  $("cardList").onclick = () => { closeCard(); setSheet("half"); };
}

function selectStation(id, { pan = true } = {}) {
  const s = visibleStations().find(x => x.id === id);
  if (!s) return;
  const prev = state.selectedId;
  state.selectedId = id;
  renderCard(s);
  // Обновляем только два маркера и подсветку строки — без полной перерисовки
  // (в компактном режиме выбранная точка должна стать подписью — тогда перерисовываем).
  if (compactMode) renderMarkers(visibleStations());
  else for (const mid of [prev, id]) {
    const m = markers.get(mid);
    const pin = m?.getElement()?.querySelector(".pin");
    if (pin) pin.classList.toggle("sel", mid === id);
    m?.setZIndexOffset(mid === id ? 100000 : 0);
  }
  document.querySelectorAll("#list li").forEach(li => li.classList.toggle("sel", li.dataset.id === id));
  if (pan) panToVisible(s.lat, s.lng);
  updateRoute();   // маршрут переключается на выбранную заправку
}

function closeCard({ route = true } = {}) {
  const id = state.selectedId;
  state.selectedId = null;
  $("card").hidden = true;
  $("sheet").classList.remove("hidden-by-card");
  markers.get(id)?.getElement()?.querySelector(".pin")?.classList.remove("sel");
  document.querySelectorAll("#list li.sel").forEach(li => li.classList.remove("sel"));
  if (route) updateRoute();   // маршрут возвращается к «лучшему выбору»
}

// ============================ Загрузка ============================
let reqSeq = 0;

/**
 * Поиск вокруг точки. Если уже есть свежие (< 5 мин) данные для этой точки с радиусом ≥ текущего,
 * повторный запрос не делается.
 */
async function load(center, { force = false, silent = false } = {}) {
  state.center = center;
  drawCenter();
  const d = state.data;
  const covers = d && sameCenter(d.center, center) && d.radius >= state.radius;
  const fresh = covers && Date.now() - d.fetchedAt < AUTO_REFRESH_MS;
  if (fresh && !force) {
    d.center = center;
    renderAll();
    if (!silent) fitToRadius();
    return;
  }

  const seq = ++reqSeq;
  state.loading = true;
  renderControls();
  if (!silent) fitToRadius();
  try {
    const stations = await fetchStations(center, state.radius);
    if (seq !== reqSeq) return;
    state.data = { center, radius: state.radius, fetchedAt: Date.now(), stations };
    state.offline = false;
    store.set("tk.last", state.data);
    showDefaultBanner();
  } catch (e) {
    if (seq !== reqSeq) return;
    if (e instanceof NetworkError || !navigator.onLine) {
      state.offline = true;
      showBanner(d
        ? `Нет сети — показаны сохранённые цены от ${fmtTime(d.fetchedAt)} (${esc(d.center.label)}).`
        : "Нет сети и нет сохранённых данных.", "error");
      if (d && !sameCenter(d.center, center)) { state.center = d.center; drawCenter(); }
    } else {
      showBanner(esc(e.message) + (/ключ/.test(e.message) ? ' <button data-open-settings>Настройки</button>' : ""), "error");
    }
  } finally {
    if (seq === reqSeq) state.loading = false;
  }
  renderAll();
}

async function searchMyLocation(opts = {}) {
  $("locateBtn").classList.add("spin");
  try {
    state.me = await getPosition();
    showDefaultBanner();   // убрать старую ошибку геолокации
    drawMe();
    startWatching();
    await load({ lat: state.me.lat, lng: state.me.lng, label: "Рядом со мной", kind: "location" }, opts);
  } catch (e) {
    if (opts.silent) return;   // фоновое обновление — без лишнего шума
    showBanner(
      `<b>${esc(e.message)}</b>${e.hint ? `<div class="hint-line">${esc(e.hint)}</div>` : ""}` +
      `<div class="hint-line">Или введите населённый пункт. ` +
      `<button data-retry-geo>Повторить</button></div>`, "error");
    $("banner").querySelector("[data-retry-geo]")?.addEventListener("click", () => searchMyLocation());
    if (!state.data) renderAll();
  } finally {
    $("locateBtn").classList.remove("spin");
  }
}

async function searchPlace(query) {
  const q = query.trim();
  if (!q) return;
  try {
    const place = await geocode(q);
    $("searchInput").value = place.label;
    await load(place);
  } catch (e) {
    showBanner(esc(e.message), "error");
  }
}

function refresh({ manual = false } = {}) {
  if (!state.center || state.loading) return;
  if (manual && state.data && Date.now() - state.data.fetchedAt < MANUAL_MIN_MS && !state.offline) {
    toast("Цены только что обновлены");
    return;
  }
  if (state.center.kind === "location") searchMyLocation({ force: true, silent: !manual });
  else load(state.center, { force: true, silent: true });
}

// Автообновление: проверяем каждые 30 с, запрашиваем не чаще раза в 5 минут и только когда вкладка видна.
function autoRefreshTick() {
  if (document.hidden || !state.center || state.loading) return;
  if (!state.data || Date.now() - state.data.fetchedAt >= AUTO_REFRESH_MS) refresh();
  else renderSheetHeader(visibleStations()); // обновить «N мин назад»
}
setInterval(autoRefreshTick, 30_000);
document.addEventListener("visibilitychange", autoRefreshTick);
window.addEventListener("online", () => { toast("Сеть снова доступна"); autoRefreshTick(); });
window.addEventListener("offline", () => {
  state.offline = true;
  if (state.data) showBanner(`Нет сети — показаны сохранённые цены от ${fmtTime(state.data.fetchedAt)}.`, "error");
  renderSheetHeader(visibleStations());
});

// ============================ Нижняя панель (drag) ============================
const sheet = $("sheet");
const sheetPeekPx = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek")) || 132;

function setSheet(s) { sheet.dataset.state = s; }

(function initSheetDrag() {
  const head = $("sheetHead");
  let drag = null;
  const translateY = () => new DOMMatrix(getComputedStyle(sheet).transform).m42;

  head.addEventListener("pointerdown", e => {
    if (isWide() || e.target.closest("button")) return;
    drag = { y: e.clientY, start: translateY(), moved: false, id: e.pointerId };
    head.setPointerCapture(e.pointerId);
    sheet.classList.add("dragging");
  });
  head.addEventListener("pointermove", e => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (Math.abs(dy) > 5) drag.moved = true;
    const max = sheet.offsetHeight - sheetPeekPx();
    sheet.style.transform = `translateY(${Math.min(max, Math.max(0, drag.start + dy))}px)`;
  });
  const end = e => {
    if (!drag) return;
    const h = sheet.offsetHeight;
    const y = translateY();
    sheet.classList.remove("dragging");
    sheet.style.transform = "";
    if (!drag.moved) {
      setSheet(sheet.dataset.state === "peek" ? "half" : "peek");
    } else {
      const snaps = { full: 0, half: h * 0.45, peek: h - sheetPeekPx() };
      const best = Object.entries(snaps).sort((a, b) => Math.abs(a[1] - y) - Math.abs(b[1] - y))[0][0];
      setSheet(best);
    }
    drag = null;
    try { head.releasePointerCapture(e.pointerId); } catch { /* уже отпущен */ }
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
})();

// ============================ Настройки ============================
function openSettings() {
  $("keyInput").value = settings.apiKey;
  $("hideClosed").checked = settings.hideClosed;
  renderMorning();
  $("settings").showModal();
}
$("settings").addEventListener("close", () => {
  if ($("settings").returnValue !== "save") return;
  const newKey = $("keyInput").value.trim();
  const keyChanged = newKey !== settings.apiKey;
  settings.apiKey = newKey;
  settings.hideClosed = $("hideClosed").checked;
  store.set("tk.key", settings.apiKey);
  store.set("tk.hideClosed", settings.hideClosed);
  showDefaultBanner();
  if (keyChanged && state.center) load(state.center, { force: true, silent: true });
  else renderAll();
});

// ============================ Утреннее уведомление ============================
/* Телефон подписывается на push (Web Push), а GitHub Actions каждое утро (~6:30 по Берлину)
 * запрашивает цены и присылает уведомление. Подписка + точка поиска передаются в GitHub
 * одним кодом (секрет TK_MORNING). Скрипт: .github/morning.py, расписание: .github/workflows/morning.yml */
const VAPID_PUBLIC = "BMXe11Zm--Gd0mpMJgePpfEgmvzUmKWGezB5rLUd2zl2pZbKddh4l6Gzprx7PZgogA5AmqHK5neCCfJJ3jUzlHA";

/** Та же логика, что в .github/morning.py: 2 самые дешёвые (сначала открытые, при равной цене — ближе). */
function morningMessage(stations, fuel, label) {
  const withPrice = stations.filter(s => priceOf(s, fuel) != null);
  const sorted = [...withPrice].sort((a, b) =>
    (b.isOpen - a.isOpen) || (priceOf(a, fuel) - priceOf(b, fuel)) || (a.dist - b.dist));
  const top = sorted.slice(0, 2);
  const short = FUELS.find(f => f.id === fuel)?.short || fuel;
  const line = (s, i) => `${i + 1}) ${s.brand || s.name} — ${priceOf(s, fuel).toFixed(3).replace(".", ",")} € · ` +
    `${fmtKm(s.dist)}${s.isOpen ? "" : " (закрыто)"}`;
  return {
    title: `⛽ ${short} — ${label}`,
    body: top.length ? top.map(line).join("\n") : "Нет цен в радиусе поиска",
    route: top[0] ? gmapsUrl(top[0]) : null,
  };
}

const b64urlToBytes = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const utf8ToB64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

function morningPoint() {
  const c = state.center;
  if (!c) return null;
  return { lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5),
    label: c.kind === "location" ? "Рядом с домом" : c.label, fuel: state.fuel, radius: state.radius };
}

function renderMorning() {
  const p = morningPoint();
  const short = p && (FUELS.find(f => f.id === p.fuel)?.short);
  $("mPoint").textContent = p
    ? `📍 ${p.label === "Рядом с домом" ? "Текущее местоположение" : p.label} · ${short} · ${p.radius} км`
    : "Сначала найдите заправки (геолокация или город).";
  $("mEnable").disabled = !p;
  const saved = store.get("tk.morning", null);
  $("mResult").hidden = !saved;
  if (saved) $("mCode").value = saved.code;
  $("mMsg").textContent = saved ? `Код создан ${fmtTime(saved.at)} для: ${saved.point}.` : "";
  if (!("PushManager" in window) || !("serviceWorker" in navigator)) {
    $("mEnable").disabled = true;
    $("mMsg").textContent = "Этот браузер не поддерживает уведомления. На Android откройте TankKarte в Chrome / с рабочего стола.";
  }
}

async function enableMorning() {
  const p = morningPoint();
  if (!p) return;
  $("mMsg").textContent = "Запрашиваю разрешение…";
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Уведомления запрещены — разрешите их для TankKarte в настройках телефона/браузера.");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const key = sub?.options?.applicationServerKey;
    if (sub && key && btoa(String.fromCharCode(...new Uint8Array(key))) !== btoa(String.fromCharCode(...b64urlToBytes(VAPID_PUBLIC)))) {
      await sub.unsubscribe(); sub = null;
    }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(VAPID_PUBLIC) });
    const cfg = { v: 1, sub: sub.toJSON(), ...p, weekends: $("mWeekends").checked };
    const short = FUELS.find(f => f.id === p.fuel)?.short;
    store.set("tk.morning", { code: utf8ToB64(JSON.stringify(cfg)), at: Date.now(), point: `${p.label}, ${short}, ${p.radius} км` });
    renderMorning();
    $("mCode").select();
  } catch (e) {
    $("mMsg").textContent = `Не получилось: ${e.message}`;
  }
}

$("mEnable").onclick = enableMorning;
$("mCopy").onclick = async () => {
  try { await navigator.clipboard.writeText($("mCode").value); toast("Код скопирован"); }
  catch { $("mCode").select(); document.execCommand("copy"); toast("Код скопирован"); }
};
$("mTest").onclick = async () => {
  if (Notification.permission !== "granted") { toast("Сначала включите уведомления"); return; }
  const p = morningPoint();
  const msg = morningMessage(visibleStations(), state.fuel, p?.label || "");
  const reg = await navigator.serviceWorker.ready;
  reg.active?.postMessage({ type: "test-push", payload: msg });
};

// ============================ События интерфейса ============================
// --- Подсказки при вводе города ---
const sugg = { items: [], active: -1, timer: 0, ctrl: null, lastQ: "" };
const suggestEl = $("suggest");

function hideSuggest() {
  clearTimeout(sugg.timer);
  sugg.ctrl?.abort();
  sugg.items = []; sugg.active = -1; sugg.lastQ = "";
  suggestEl.hidden = true;
  $("searchInput").setAttribute("aria-expanded", "false");
}
function renderSuggest() {
  if (!sugg.items.length) { suggestEl.hidden = true; $("searchInput").setAttribute("aria-expanded", "false"); return; }
  suggestEl.innerHTML = sugg.items.map((it, i) =>
    `<li role="option" data-i="${i}" class="${i === sugg.active ? "active" : ""}" aria-selected="${i === sugg.active}">` +
    `<span class="s-ico" aria-hidden="true">📍</span><span class="s-txt"><b>${esc(it.label)}</b>` +
    `${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</span></li>`).join("");
  suggestEl.hidden = false;
  $("searchInput").setAttribute("aria-expanded", "true");
}
function pickSuggestion(it) {
  hideSuggest();
  $("searchInput").value = it.label;
  $("searchInput").blur();
  load({ lat: it.lat, lng: it.lng, label: it.label, kind: "city" });
}

$("searchInput").addEventListener("input", () => {
  const q = $("searchInput").value.trim();
  clearTimeout(sugg.timer);
  if (q.length < 2) { hideSuggest(); return; }
  sugg.timer = setTimeout(async () => {
    if (q === sugg.lastQ) return;
    sugg.ctrl?.abort();
    sugg.ctrl = new AbortController();
    try {
      const items = await suggestPlaces(q, sugg.ctrl.signal);
      if ($("searchInput").value.trim() !== q || document.activeElement !== $("searchInput")) return;
      sugg.lastQ = q; sugg.items = items; sugg.active = -1;
      renderSuggest();
    } catch (e) {
      if (e.name !== "AbortError") console.warn("suggest:", e);
    }
  }, 250);
});
$("searchInput").addEventListener("keydown", e => {
  if (suggestEl.hidden || !sugg.items.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const n = sugg.items.length;
    // цикл по вариантам: -1 (ничего) → 0 … n-1 → -1
    const pos = (sugg.active + 1 + (e.key === "ArrowDown" ? 1 : -1) + n + 1) % (n + 1);
    sugg.active = pos - 1;
    renderSuggest();
  } else if (e.key === "Escape") {
    hideSuggest();
  }
});
$("searchInput").addEventListener("blur", () => setTimeout(hideSuggest, 150));
// pointerdown + preventDefault: поле не теряет фокус до выбора варианта
suggestEl.addEventListener("pointerdown", e => e.preventDefault());
suggestEl.addEventListener("click", e => {
  const li = e.target.closest("li[data-i]");
  if (li) pickSuggestion(sugg.items[+li.dataset.i]);
});

$("searchForm").addEventListener("submit", e => {
  e.preventDefault();
  const chosen = sugg.items[sugg.active];
  if (chosen) { pickSuggestion(chosen); return; }
  hideSuggest();
  $("searchInput").blur();
  searchPlace($("searchInput").value);
});
$("locateBtn").onclick = () => { hideSuggest(); $("searchInput").value = ""; searchMyLocation(); };
$("settingsBtn").onclick = openSettings;
$("refreshBtn").onclick = () => refresh({ manual: true });

$("fuelSeg").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  state.fuel = b.dataset.fuel; savePrefs(); renderAll();
};
$("radiusSeg").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  const r = +b.dataset.rad;
  if (r === state.radius) return;
  state.radius = r; savePrefs();
  if (state.center) load(state.center); else renderControls();
};
$("sortSeg").onclick = e => {
  const b = e.target.closest("button"); if (!b) return;
  state.sort = b.dataset.sort; savePrefs();
  renderList(visibleStations()); renderControls();
  $("list").scrollTop = 0;
};
$("list").onclick = e => {
  if (e.target.closest("a")) return;   // кнопка Google Maps — без выбора строки
  const li = e.target.closest("li[data-id]");
  if (li) selectStation(li.dataset.id);
};
$("best").onclick = e => {
  if (e.target.closest("a")) return;
  if (state.bestId) selectStation(state.bestId);
};
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("card").hidden) closeCard(); });

// ============================ Старт ============================
(function start() {
  // Высота верхней панели (с баннером) → CSS-переменная, чтобы панель списка не уходила под неё.
  const topbar = document.querySelector(".topbar");
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--top-h", `${Math.ceil(topbar.getBoundingClientRect().bottom)}px`);
  }).observe(topbar);
  // Высота шапки нижней панели = сколько панели видно в свёрнутом виде.
  const head = $("sheetHead");
  new ResizeObserver(() => {
    document.documentElement.style.setProperty("--peek", `${Math.ceil(head.offsetHeight)}px`);
  }).observe(head);
  renderControls();
  // Сначала показываем кэш (работает и без сети), потом обновляем по геолокации.
  const cached = store.get("tk.last", null);
  if (cached?.stations && cached.center) {
    state.data = cached;
    state.center = cached.center;
    drawCenter();
    renderAll();
    fitToRadius();
  } else {
    renderAll();
  }
  showDefaultBanner();
  searchMyLocation();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(err => console.warn("SW:", err));
  }
})();
