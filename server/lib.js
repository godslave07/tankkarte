/* Общий код сервера TankKarte (Cloudflare): цены Tankerkönig с кэшем, подписки, Web Push.
 * Используется функциями сайта (functions/api/*) и воркером расписания (server/cron.js).
 * Переменные окружения: DB (D1), TK_API_KEY, VAPID_PUBLIC, VAPID_PRIVATE — секреты Cloudflare. */

export const APP_URL = "https://tankkarte.pages.dev/";
const TK_URL = "https://creativecommons.tankerkoenig.de/api/v4/stations/search";
const PRICE_TTL_MS = 5 * 60 * 1000;          // Tankerkönig: не чаще раза в 5 минут на одну точку
export const RADII = [5, 10, 15, 25];
export const FUELS = { e5: ["super e5", "E5"], e10: ["super e10", "E10"], diesel: ["diesel", "Diesel"] };
export const MAX_SUBS = 5000;
const PUSH_HOSTS = [/\.googleapis\.com$/, /\.mozilla\.com$/, /\.push\.apple\.com$/, /\.notify\.windows\.com$/, /\.mozaws\.net$/];

// ---------------------------------------------------------------- utils
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

const enc = new TextEncoder();
export function b64url(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64url(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/** Время в Берлине по правилу ЕС (летнее время с последнего воскресенья марта по последнее воскресенье октября, 01:00 UTC). */
export function berlinNow(now = new Date()) {
  const lastSunday = month => {
    const d = new Date(Date.UTC(now.getUTCFullYear(), month, 31, 1));   // month: 2 = март, 9 = октябрь
    d.setUTCDate(31 - d.getUTCDay());
    return d;
  };
  const offset = now >= lastSunday(2) && now < lastSunday(9) ? 2 : 1;
  const b = new Date(now.getTime() + offset * 3600_000);
  const pad = n => String(n).padStart(2, "0");
  return {
    date: `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`,
    hh: b.getUTCHours(), mm: b.getUTCMinutes(),
    weekday: (b.getUTCDay() + 6) % 7,   // 0 = понедельник … 6 = воскресенье
  };
}

// ---------------------------------------------------------------- цены
const memCache = new Map();   // в пределах одного экземпляра воркера

/**
 * Только то, что нужно самому приложению: условия Tankerkönig запрещают передавать наборы данных дальше,
 * поэтому полный ответ API наружу не отдаём.
 */
export function trimStations(body) {
  const data = typeof body === "string" ? JSON.parse(body) : body;
  const round = (x, d) => (typeof x === "number" ? Math.round(x * 10 ** d) / 10 ** d : null);
  return {
    stations: (data.stations || []).map(s => ({
      id: s.id,
      name: s.name,
      brand: s.brand,
      street: s.street,
      postalCode: s.postalCode,
      place: s.place,
      coords: { lat: round(s.coords?.lat, 5), lng: round(s.coords?.lng, 5) },
      dist: s.dist,
      isOpen: !!s.isOpen,
      fuels: (s.fuels || []).filter(f => FUEL_API_NAMES.has(String(f.name).toLowerCase())).map(f => ({
        name: f.name,
        price: f.price,
        lastChange: f.lastChange ? { amount: f.lastChange.amount, timestamp: f.lastChange.timestamp } : undefined,
      })),
    })),
  };
}
const FUEL_API_NAMES = new Set(["super e5", "super e10", "diesel"]);

/** Заправки вокруг точки. Координаты округляются до ~100 м, ответ кэшируется на 5 минут (память + D1). */
export async function getStations(env, lat, lng, rad) {
  lat = Math.round(lat * 1000) / 1000;
  lng = Math.round(lng * 1000) / 1000;
  const key = `${lat},${lng},${rad}`;
  const now = Date.now();
  const mem = memCache.get(key);
  if (mem && now - mem.at < PRICE_TTL_MS) return mem.body;
  const row = await env.DB.prepare("SELECT at, body FROM price_cache WHERE key = ?").bind(key).first();
  if (row && now - row.at < PRICE_TTL_MS) {
    memCache.set(key, { at: row.at, body: row.body });
    return row.body;
  }
  const url = `${TK_URL}?${new URLSearchParams({ apikey: env.TK_API_KEY, lat, lng, rad })}`;
  const resp = await fetch(url, { headers: { "user-agent": "TankKarte" } });
  const raw = await resp.text();
  if (!resp.ok) {
    if (row) return row.body;   // Tankerkönig недоступен — отдаём последние сохранённые цены
    throw Object.assign(new Error(`Tankerkönig ${resp.status}`), { status: resp.status });
  }
  const body = JSON.stringify(trimStations(raw));
  memCache.set(key, { at: now, body });
  if (memCache.size > 500) memCache.delete(memCache.keys().next().value);
  await env.DB.prepare("INSERT OR REPLACE INTO price_cache (key, at, body) VALUES (?, ?, ?)").bind(key, now, body).run();
  return body;
}

// ---------------------------------------------------------------- ограничение частоты запросов
/**
 * Не больше `limit` запросов в минуту с одного адреса. IP не хранится: только его хэш с солью,
 * которая меняется каждый день (по нему нельзя восстановить адрес). Возвращает true, если лимит превышен.
 */
export async function rateLimited(env, request, bucket, limit) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const minute = Math.floor(Date.now() / 60000);
  const day = Math.floor(minute / 1440);
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(`${day}|${env.VAPID_PRIVATE}|${ip}`));
  const key = `${bucket}|${b64url(digest).slice(0, 16)}|${minute}`;
  const row = await env.DB.prepare(
    "INSERT INTO rate (k, m, n) VALUES (?, ?, 1) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n",
  ).bind(key, minute).first();
  return (row?.n || 0) > limit;
}

// ---------------------------------------------------------------- текст уведомления
const TEXTS = {
  ru: { km: "км", closed: " (закрыто)", none: "Нет цен в радиусе поиска", route: "🧭 Маршрут к №1" },
  de: { km: "km", closed: " (geschlossen)", none: "Keine Preise im Suchradius", route: "🧭 Route zu Nr. 1" },
};
const fmtKm = (km, unit) => `${km < 10 ? km.toFixed(1).replace(".", ",") : Math.round(km)} ${unit}`;

/** 2 самые дешёвые (сначала открытые, при равной цене — ближе). Та же логика, что morningMessage() в app.js. */
export function buildMessage(stations, sub) {
  const [apiName, short] = FUELS[sub.fuel] || FUELS.e5;
  const tx = TEXTS[sub.lang] || TEXTS.ru;
  const priceOf = s => {
    const f = (s.fuels || []).find(f => String(f.name).toLowerCase() === apiName);
    return f && typeof f.price === "number" && f.price > 0 ? f.price : null;
  };
  const top = stations.map(s => [s, priceOf(s)]).filter(([, p]) => p != null)
    .sort((a, b) => (!!b[0].isOpen - !!a[0].isOpen) || (a[1] - b[1]) || ((a[0].dist || 0) - (b[0].dist || 0)))
    .slice(0, 2);
  const lines = top.map(([s, p], i) =>
    `${i + 1}) ${(s.brand || "").trim() || (s.name || "").trim()} — ${p.toFixed(3).replace(".", ",")} € · ` +
    `${fmtKm(Number(s.dist) || 0, tx.km)}${s.isOpen ? "" : tx.closed}`);
  const c = top[0]?.[0].coords;
  return {
    title: `⛽ ${short} — ${sub.label || ""}`,
    body: lines.length ? lines.join("\n") : tx.none,
    route: c ? `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}&travelmode=driving` : null,
    action: tx.route,
  };
}

// ---------------------------------------------------------------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID)
async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

function ecJwk(publicRaw, dB64) {
  const pub = publicRaw instanceof Uint8Array ? publicRaw : unb64url(publicRaw);
  return { kty: "EC", crv: "P-256", x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ...(dB64 ? { d: dB64 } : {}), ext: true };
}

/**
 * Шифрование тела push-сообщения (aes128gcm).
 * test: { asPrivate, asPublic, salt } — фиксированные значения для проверки по примеру из RFC 8291.
 */
export async function encryptPayload(plaintext, uaPublicB64, authB64, test) {
  const uaPublic = unb64url(uaPublicB64);
  const auth = unb64url(authB64);
  let asKeys, asPublic;
  if (test) {
    asPublic = unb64url(test.asPublic);
    asKeys = { privateKey: await crypto.subtle.importKey("jwk", ecJwk(asPublic, test.asPrivate), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]) };
  } else {
    asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(auth, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = test ? unb64url(test.salt) : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const data = concat(typeof plaintext === "string" ? enc.encode(plaintext) : plaintext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, data));
  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic);   // rs = 4096
  return concat(header, ct);
}

const vapidCache = new Map();
async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const hit = vapidCache.get(aud);
  if (hit && hit.exp - Date.now() / 1000 > 3600) return hit.header;
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud, exp, sub: APP_URL.replace(/\/$/, "") })));
  const key = await crypto.subtle.importKey("jwk", ecJwk(env.VAPID_PUBLIC, env.VAPID_PRIVATE),
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  const value = `vapid t=${header}.${claims}.${b64url(sig)}, k=${env.VAPID_PUBLIC}`;
  vapidCache.set(aud, { exp, header: value });
  return value;
}

/** Отправить push. Возвращает HTTP-статус push-сервиса (404/410 — подписка больше не действует). */
export async function sendPush(env, sub, message) {
  const body = await encryptPayload(JSON.stringify(message), sub.keys.p256dh, sub.keys.auth);
  const resp = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuth(env, sub.endpoint),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(3 * 3600),
      urgency: "normal",
    },
    body,
  });
  return resp.status;
}

// ---------------------------------------------------------------- подписки
export function validSubscription(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some(r => r.test(u.hostname)) &&
      typeof sub.keys?.p256dh === "string" && typeof sub.keys?.auth === "string" &&
      unb64url(sub.keys.p256dh).length === 65 && unb64url(sub.keys.auth).length === 16;
  } catch { return false; }
}

/** Утреннее сообщение для одной подписки (строка из таблицы subs) — с ценами из кэша. */
export async function morningFor(env, row) {
  const body = JSON.parse(await getStations(env, row.lat, row.lng, row.radius));
  return buildMessage(body.stations || [], row);
}

/** Отправить и обработать результат: недействительные подписки удаляются. */
export async function deliver(env, row) {
  const msg = await morningFor(env, row);
  const status = await sendPush(env, JSON.parse(row.sub), msg);
  if (status === 404 || status === 410) {
    await env.DB.prepare("DELETE FROM subs WHERE endpoint = ?").bind(row.endpoint).run();
  }
  return status;
}
