"""Утреннее push-уведомление TankKarte: 2 самые дешёвые заправки вокруг сохранённой точки.

Запускается GitHub Actions (.github/workflows/morning.yml). Секреты:
  TK_MORNING     — код из приложения (Настройки → Утреннее уведомление): подписка + точка поиска
  VAPID_PRIVATE  — закрытый ключ для Web Push (пара к VAPID_PUBLIC в app.js)
  TK_API_KEY     — (необязательно) свой ключ Tankerkönig
Локальная проверка без отправки:  python .github/morning.py --dry-run
"""
import base64
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API_URL = "https://creativecommons.tankerkoenig.de/api/v4/stations/search"
DEMO_KEY = "00000000-0000-0000-0000-000000000002"
APP_URL = "https://godslave07.github.io/tankkarte/"
FUELS = {"e5": ("super e5", "E5"), "e10": ("super e10", "E10"), "diesel": ("diesel", "Diesel")}
# Расписание в UTC: "30 4" = 6:30 летом (UTC+2), "30 5" = 6:30 зимой (UTC+1). Срабатывает только подходящее.
SCHEDULE_OFFSET_H = {"30 4 * * *": 2, "30 5 * * *": 1}


def berlin_now():
    """Время в Берлине по правилу ЕС (летнее время: с последнего воскресенья марта
    до последнего воскресенья октября, переход в 01:00 UTC) — без зависимости от tzdata."""
    utc = datetime.now(timezone.utc)

    def last_sunday(month):
        d = datetime(utc.year, month, 31, 1, tzinfo=timezone.utc)
        return d - timedelta(days=(d.weekday() + 1) % 7)

    hours = 2 if last_sunday(3) <= utc < last_sunday(10) else 1
    return utc.astimezone(timezone(timedelta(hours=hours), f"UTC+{hours}"))


def load_config():
    raw = os.environ.get("TK_MORNING", "").strip()
    if not raw:
        sys.exit("Нет секрета TK_MORNING (код из приложения).")
    raw += "=" * (-len(raw) % 4)
    return json.loads(base64.b64decode(raw).decode("utf-8"))


def should_send(cfg, now):
    sched = os.environ.get("SCHEDULE", "").strip()
    if not sched:  # ручной запуск (workflow_dispatch) — отправляем всегда
        return True, "ручной запуск"
    want = SCHEDULE_OFFSET_H.get(sched)
    offset = now.utcoffset().total_seconds() / 3600
    if want is not None and offset != want:
        return False, f"расписание {sched!r} для UTC+{want}, сейчас UTC+{offset:g}"
    if not cfg.get("weekends", True) and now.weekday() >= 5:
        return False, "выходной"
    return True, "по расписанию"


def fetch_stations(cfg):
    q = urllib.parse.urlencode({
        "apikey": os.environ.get("TK_API_KEY") or DEMO_KEY,
        "lat": f"{cfg['lat']:.6f}", "lng": f"{cfg['lng']:.6f}", "rad": cfg.get("radius", 10),
    })
    req = urllib.request.Request(f"{API_URL}?{q}", headers={"User-Agent": "TankKarte-morning"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("stations", [])


def price_of(st, api_name):
    for f in st.get("fuels") or []:
        if str(f.get("name", "")).lower() == api_name and isinstance(f.get("price"), (int, float)) and f["price"] > 0:
            return float(f["price"])
    return None


# Тексты уведомления (язык выбирается в приложении и приходит в коде TK_MORNING как "lang").
TEXTS = {
    "ru": {"km": "км", "closed": " (закрыто)", "none": "Нет цен в радиусе поиска", "route": "🧭 Маршрут к №1"},
    "de": {"km": "km", "closed": " (geschlossen)", "none": "Keine Preise im Suchradius", "route": "🧭 Route zu Nr. 1"},
}


def fmt_km(km, unit="км"):
    return f"{km:.1f}".replace(".", ",") + f" {unit}" if km < 10 else f"{round(km)} {unit}"


def build_message(stations, cfg):
    """Та же логика, что morningMessage() в app.js."""
    api_name, short = FUELS.get(cfg.get("fuel", "e5"), FUELS["e5"])
    tx = TEXTS.get(cfg.get("lang"), TEXTS["ru"])
    rows = [(s, price_of(s, api_name)) for s in stations]
    rows = [(s, p) for s, p in rows if p is not None]
    rows.sort(key=lambda sp: (not sp[0].get("isOpen"), sp[1], float(sp[0].get("dist") or 0)))
    top = rows[:2]
    lines = []
    for i, (s, p) in enumerate(top):
        name = (s.get("brand") or "").strip() or (s.get("name") or "").strip()
        closed = "" if s.get("isOpen") else tx["closed"]
        price = f"{p:.3f}".replace(".", ",")
        lines.append(f"{i + 1}) {name} — {price} € · {fmt_km(float(s.get('dist') or 0), tx['km'])}{closed}")
    route = None
    if top:
        c = top[0][0].get("coords") or {}
        route = ("https://www.google.com/maps/dir/?api=1&destination="
                 f"{c.get('lat')},{c.get('lng')}&travelmode=driving")
    return {
        "title": f"⛽ {short} — {cfg.get('label', '')}",
        "body": "\n".join(lines) if lines else tx["none"],
        "route": route,
        "action": tx["route"],
    }


def send(cfg, msg):
    from pywebpush import webpush, WebPushException
    try:
        webpush(
            subscription_info=cfg["sub"],
            data=json.dumps(msg, ensure_ascii=False),
            vapid_private_key=os.environ["VAPID_PRIVATE"].strip(),
            vapid_claims={"sub": APP_URL.rstrip("/")},
            ttl=3 * 3600,
        )
    except WebPushException as e:
        status = getattr(e.response, "status_code", None)
        if status in (404, 410):
            sys.exit("Подписка больше не действует: в приложении нажмите «Включить на этом телефоне» "
                     "и обновите секрет TK_MORNING.")
        raise


def main():
    dry = "--dry-run" in sys.argv
    cfg = load_config()
    now = berlin_now()
    ok, why = should_send(cfg, now)
    print(f"{now:%Y-%m-%d %H:%M %Z}: {why}")
    if not ok:
        return
    msg = build_message(fetch_stations(cfg), cfg)
    print(json.dumps(msg, ensure_ascii=False, indent=2))
    if not dry:
        send(cfg, msg)
        print("Отправлено.")


if __name__ == "__main__":
    main()
