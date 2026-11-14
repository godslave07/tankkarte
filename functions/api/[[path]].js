/* API сайта TankKarte (Cloudflare Pages Functions): /api/stations, /api/subscribe, /api/unsubscribe, /api/test. */
import { json, getStations, trimStations, validSubscription, deliver, rateLimited, RADII, FUELS, MAX_SUBS } from "../../server/lib.js";

// API только для самого приложения: свой сайт (и его предпросмотры *.tankkarte.pages.dev),
// старый адрес на GitHub Pages и локальная разработка.
const ALLOWED_ORIGINS = ["https://tankkarte.pages.dev", "https://godslave07.github.io", "http://localhost:8766", "http://127.0.0.1:8766"];
const allowedOrigin = o => !!o && (ALLOWED_ORIGINS.includes(o) || /^https:\/\/[a-z0-9-]+\.tankkarte\.pages\.dev$/.test(o));

/** Запрос пришёл из нашего приложения в браузере? (Простую выкачку данных скриптами это отсекает.) */
function fromOurApp(request) {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  if (allowedOrigin(request.headers.get("origin"))) return true;
  try { return allowedOrigin(new URL(request.headers.get("referer")).origin); } catch { return false; }
}
// Лимиты на один адрес в минуту.
const LIMITS = { stations: 30, subscribe: 10, test: 4 };

function cors(request) {
  const origin = request.headers.get("origin");
  if (!allowedOrigin(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST",
    "access-control-allow-headers": "content-type", "access-control-max-age": "86400", vary: "origin" };
}

const inGermany = (lat, lng) => lat > 47 && lat < 55.2 && lng > 5.5 && lng < 15.3;
const TIMES = new Set(Array.from({ length: 21 }, (_, i) => {   // 05:00 … 10:00 с шагом 15 минут
  const m = 5 * 60 + i * 15;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}));

async function stations(url, env) {
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const rad = Number(url.searchParams.get("rad"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inGermany(lat, lng) || !RADII.includes(rad)) {
    return json({ ok: false, message: "bad parameters" }, 400);
  }
  try {
    const body = JSON.stringify(trimStations(await getStations(env, lat, lng, rad)));
    return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  } catch (e) {
    return json({ ok: false, message: e.message }, e.status === 429 ? 429 : 502);
  }
}

async function subscribe(request, env) {
  const b = await request.json().catch(() => null);
  if (!b || !validSubscription(b.sub)) return json({ ok: false, message: "bad subscription" }, 400);
  const lat = Number(b.lat), lng = Number(b.lng), radius = Number(b.radius);
  if (!inGermany(lat, lng) || !RADII.includes(radius) || !FUELS[b.fuel] || !["ru", "de"].includes(b.lang) || !TIMES.has(b.time)) {
    return json({ ok: false, message: "bad settings" }, 400);
  }
  const exists = await env.DB.prepare("SELECT 1 FROM subs WHERE endpoint = ?").bind(b.sub.endpoint).first();
  if (!exists) {
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM subs").first();
    if (n >= MAX_SUBS) return json({ ok: false, message: "too many subscribers" }, 503);
  }
  const label = String(b.label || "").slice(0, 80);
  await env.DB.prepare(
    `INSERT INTO subs (endpoint, sub, lat, lng, label, home, fuel, radius, lang, weekends, time, created)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(endpoint) DO UPDATE SET sub = ?2, lat = ?3, lng = ?4, label = ?5, home = ?6, fuel = ?7,
       radius = ?8, lang = ?9, weekends = ?10, time = ?11`,
  ).bind(b.sub.endpoint, JSON.stringify(b.sub), lat, lng, label, b.home ? 1 : 0, b.fuel, radius, b.lang,
    b.weekends === false ? 0 : 1, b.time, Date.now()).run();
  return json({ ok: true });
}

async function unsubscribe(request, env) {
  const b = await request.json().catch(() => null);
  if (!b?.endpoint) return json({ ok: false }, 400);
  await env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(String(b.endpoint)).run();
  return json({ ok: true });
}

/** Пробное уведомление прямо сейчас (не чаще раза в 30 секунд на подписку). */
async function test(request, env) {
  const b = await request.json().catch(() => null);
  const row = b?.endpoint && await env.DB.prepare("SELECT * FROM subs WHERE endpoint = ?").bind(String(b.endpoint)).first();
  if (!row) return json({ ok: false, message: "not subscribed" }, 404);
  if (row.last_test && Date.now() - row.last_test < 30_000) return json({ ok: false, message: "too often" }, 429);
  await env.DB.prepare("UPDATE subs SET last_test = ? WHERE endpoint = ?").bind(Date.now(), row.endpoint).run();
  const status = await deliver(env, row);
  return json({ ok: status >= 200 && status < 300, status });
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const headers = cors(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  let resp;
  try {
    const route = `${request.method} ${url.pathname.replace(/\/$/, "")}`;
    const bucket = { "GET /api/stations": "stations", "POST /api/subscribe": "subscribe",
      "POST /api/unsubscribe": "subscribe", "POST /api/test": "test" }[route];
    if (!bucket) resp = json({ ok: false, message: "not found" }, 404);
    else if (!fromOurApp(request)) resp = json({ ok: false, message: "forbidden" }, 403);
    else if (await rateLimited(env, request, bucket, LIMITS[bucket])) {
      resp = json({ ok: false, message: "too many requests" }, 429, { "retry-after": "60" });
    }
    else if (bucket === "stations") resp = await stations(url, env);
    else if (route === "POST /api/subscribe") resp = await subscribe(request, env);
    else if (route === "POST /api/unsubscribe") resp = await unsubscribe(request, env);
    else resp = await test(request, env);
  } catch (e) {
    console.error(e);
    resp = json({ ok: false, message: "server error" }, 500);
  }
  for (const [k, v] of Object.entries(headers)) resp.headers.set(k, v);
  return resp;
}
