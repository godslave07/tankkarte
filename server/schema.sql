-- База TankKarte (Cloudflare D1). Применяется при каждом развёртывании — только создание, данные не трогаются.
CREATE TABLE IF NOT EXISTS subs (
  endpoint  TEXT PRIMARY KEY,   -- адрес push-подписки телефона
  sub       TEXT NOT NULL,      -- подписка целиком (JSON: endpoint + ключи)
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  label     TEXT,
  home      INTEGER DEFAULT 0,
  fuel      TEXT NOT NULL,
  radius    INTEGER NOT NULL,
  lang      TEXT NOT NULL,
  weekends  INTEGER DEFAULT 1,
  time      TEXT NOT NULL,      -- «06:30» по Берлину, шаг 15 минут
  created   INTEGER,
  last_sent TEXT,               -- дата последней утренней рассылки
  last_test INTEGER,
  fails     INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS subs_time ON subs (time);

CREATE TABLE IF NOT EXISTS price_cache (
  key  TEXT PRIMARY KEY,        -- «lat,lng,radius» (координаты округлены до ~100 м)
  at   INTEGER NOT NULL,
  body TEXT NOT NULL
);
