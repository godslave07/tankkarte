"use strict";
/* Переводы интерфейса TankKarte: русский / немецкий.
 * В HTML: data-i18n (текст), data-i18n-html (разметка), data-i18n-ph (placeholder),
 * data-i18n-title (title + aria-label), data-i18n-aria (только aria-label). В JS: t("ключ", {параметры}). */
const I18N = {
  ru: {
    appTitle: "TankKarte — цены на топливо",
    mapAria: "Карта заправок",
    searchPh: "Город или адрес в Германии",
    searchAria: "Населённый пункт",
    suggestAria: "Подсказки",
    myLocation: "Моё местоположение",
    settings: "Настройки",
    fuelAria: "Вид топлива",
    radiusAria: "Радиус поиска",
    km: "км",
    listAria: "Список заправок",
    refresh: "Обновить",
    sortAria: "Сортировка",
    byPrice: "По цене",
    byDist: "По расстоянию",
    language: "Язык",
    apiKeyLabel: "API-ключ Tankerkönig",
    apiKeyHint: 'Бесплатный ключ: <a href="https://creativecommons.tankerkoenig.de/" target="_blank" rel="noopener">creativecommons.tankerkoenig.de</a>. ' +
      "Необязательно: без него используется общий ключ. Свой ключ хранится только на этом устройстве.",
    hideClosed: "Скрывать закрытые заправки",
    morningTitle: "☀️ Утреннее уведомление",
    morningIntro: "Каждое утро — 2 самые дешёвые заправки вокруг точки:",
    weekends: "Также по выходным",
    mEnable: "🔔 Включить на этом телефоне",
    mLastStep: "<b>Последний шаг:</b> скопируйте код и вставьте его в GitHub как секрет <code>TK_MORNING</code>.",
    mCopy: "📋 Скопировать код",
    mTest: "Пример уведомления",
    credits: "Данные: MTS-K через Tankerkönig (CC BY 4.0). Карта и геокодинг: © участники OpenStreetMap.",
    cancel: "Отмена",
    save: "Сохранить",

    justNow: "только что",
    minAgo: "{n} мин назад",
    errNet: "Нет соединения с сервером",
    errKey: "Неверный API-ключ Tankerkönig — проверьте настройки.",
    err429: "Слишком много запросов к Tankerkönig, попробуйте позже.",
    errTk: "Ошибка Tankerkönig ({s})",
    geoNet: "Поиск мест недоступен — нет сети",
    geoErr: "Поиск мест: ошибка {s}",
    notFound: "«{q}» не найден в Германии",
    winHint: "Проверьте, что в Windows включено «Расположение» и разрешён доступ для приложений: " +
      "Параметры → Конфиденциальность и защита → Расположение.",
    geoUnsupported: "Браузер не поддерживает геолокацию.",
    geoHttps: "Геолокация работает только по HTTPS или на localhost.",
    geoDenied: "Нет доступа к местоположению.",
    geoDeniedHint: "1) В браузере: значок слева от адреса → «Геоданные» → «Разрешить». " +
      "2) Если там уже «Разрешено», доступ закрыт в Windows: " +
      "Параметры → Конфиденциальность и защита → Расположение — включите «Службы определения расположения» " +
      "и «Разрешить классическим приложениям доступ к расположению». Затем нажмите «Повторить».",
    geoTimeout: "Местоположение не определилось за 15 секунд.",
    tryAgain: "Попробуйте ещё раз. ",
    geoUnavailable: "Устройство не смогло определить местоположение.",
    attrRoutes: "Маршруты",
    attrPrices: "Цены",
    fromCenter: " от центра поиска",
    straightLine: "{d} по прямой",
    durMin: "{m} мин",
    durH: "{h} ч {m} мин",
    cheapest: "⭐ Дешевле всех · {fuel}",
    nearestOf: " · ближайшая из {n}",
    open: "открыто",
    closed: "закрыто",
    gmapsTitle: "Маршрут в Google Maps",
    go: "🧭 Поехать",
    pinBest: "⭐ ДЕШЕВЛЕ ВСЕХ",
    noPrice: "нет цены",
    loading: "Загрузка…",
    emptyStart: "Разрешите геолокацию или введите город.",
    emptyNone: "В радиусе {r} км заправок не найдено.",
    searching: "Поиск заправок…",
    whereSearch: "Где искать?",
    offlineFrom: "нет сети, данные от {t}",
    updated: "обновлено {ago}",
    fromYou: "{d} от вас",
    fromPoint: "{d} от точки поиска",
    badgeBest: "⭐ САМАЯ НИЗКАЯ ЦЕНА",
    close: "Закрыть",
    openChip: "● Открыто",
    closedChip: "● Закрыто",
    priceChanged: "цена изменена {t}",
    notSold: "нет в продаже",
    goGmaps: "🧭 Поехать — Google Maps",
    listBtn: "Список",
    offlineSaved: "Нет сети — показаны сохранённые цены от {t} ({label}).",
    offlineSavedShort: "Нет сети — показаны сохранённые цены от {t}.",
    offlineNoData: "Нет сети и нет сохранённых данных.",
    nearMe: "Рядом со мной",
    orTypePlace: "Или введите населённый пункт. ",
    retry: "Повторить",
    justUpdated: "Цены только что обновлены",
    backOnline: "Сеть снова доступна",
    mClosed: " (закрыто)",
    mNoPrices: "Нет цен в радиусе поиска",
    mRoute: "🧭 Маршрут к №1",
    nearHome: "Рядом с домом",
    curLoc: "Текущее местоположение",
    mNeedSearch: "Сначала найдите заправки (геолокация или город).",
    mCreated: "Код создан {t} для: {p}.",
    mUnsupported: "Этот браузер не поддерживает уведомления. На Android откройте TankKarte в Chrome / с рабочего стола.",
    mAsking: "Запрашиваю разрешение…",
    mDenied: "Уведомления запрещены — разрешите их для TankKarte в настройках телефона/браузера.",
    mFail: "Не получилось: {m}",
    copied: "Код скопирован",
    enableFirst: "Сначала включите уведомления",
  },

  de: {
    appTitle: "TankKarte — Spritpreise",
    mapAria: "Tankstellenkarte",
    searchPh: "Ort oder Adresse in Deutschland",
    searchAria: "Ort",
    suggestAria: "Vorschläge",
    myLocation: "Mein Standort",
    settings: "Einstellungen",
    fuelAria: "Kraftstoff",
    radiusAria: "Suchradius",
    km: "km",
    listAria: "Tankstellenliste",
    refresh: "Aktualisieren",
    sortAria: "Sortierung",
    byPrice: "Nach Preis",
    byDist: "Nach Entfernung",
    language: "Sprache",
    apiKeyLabel: "Tankerkönig-API-Schlüssel",
    apiKeyHint: 'Kostenloser Schlüssel: <a href="https://creativecommons.tankerkoenig.de/" target="_blank" rel="noopener">creativecommons.tankerkoenig.de</a>. ' +
      "Optional: ohne ihn wird ein gemeinsamer Schlüssel verwendet. Ihr Schlüssel bleibt nur auf diesem Gerät.",
    hideClosed: "Geschlossene Tankstellen ausblenden",
    morningTitle: "☀️ Morgen-Benachrichtigung",
    morningIntro: "Jeden Morgen die 2 günstigsten Tankstellen rund um:",
    weekends: "Auch am Wochenende",
    mEnable: "🔔 Auf diesem Handy aktivieren",
    mLastStep: "<b>Letzter Schritt:</b> Code kopieren und in GitHub als Secret <code>TK_MORNING</code> einfügen.",
    mCopy: "📋 Code kopieren",
    mTest: "Beispiel anzeigen",
    credits: "Daten: MTS-K über Tankerkönig (CC BY 4.0). Karte und Ortssuche: © OpenStreetMap-Mitwirkende.",
    cancel: "Abbrechen",
    save: "Speichern",

    justNow: "gerade eben",
    minAgo: "vor {n} Min.",
    errNet: "Keine Verbindung zum Server",
    errKey: "Ungültiger Tankerkönig-API-Schlüssel — bitte Einstellungen prüfen.",
    err429: "Zu viele Anfragen an Tankerkönig, bitte später erneut versuchen.",
    errTk: "Tankerkönig-Fehler ({s})",
    geoNet: "Ortssuche nicht erreichbar — kein Netz",
    geoErr: "Ortssuche: Fehler {s}",
    notFound: "„{q}“ wurde in Deutschland nicht gefunden",
    winHint: "Prüfen Sie, ob in Windows „Standort“ aktiviert und der Zugriff für Apps erlaubt ist: " +
      "Einstellungen → Datenschutz und Sicherheit → Standort.",
    geoUnsupported: "Der Browser unterstützt keine Standortbestimmung.",
    geoHttps: "Standortbestimmung funktioniert nur über HTTPS oder auf localhost.",
    geoDenied: "Kein Zugriff auf den Standort.",
    geoDeniedHint: "1) Im Browser: Symbol links neben der Adresse → „Standort“ → „Zulassen“. " +
      "2) Steht dort bereits „Zugelassen“, ist der Zugriff in Windows gesperrt: " +
      "Einstellungen → Datenschutz und Sicherheit → Standort — „Standortdienste“ und " +
      "„Desktop-Apps Zugriff auf Ihren Standort erlauben“ einschalten. Dann „Erneut versuchen“ tippen.",
    geoTimeout: "Standort konnte in 15 Sekunden nicht ermittelt werden.",
    tryAgain: "Bitte erneut versuchen. ",
    geoUnavailable: "Das Gerät konnte den Standort nicht ermitteln.",
    attrRoutes: "Routen",
    attrPrices: "Preise",
    fromCenter: " ab Suchpunkt",
    straightLine: "{d} Luftlinie",
    durMin: "{m} Min.",
    durH: "{h} Std. {m} Min.",
    cheapest: "⭐ Am günstigsten · {fuel}",
    nearestOf: " · nächste von {n}",
    open: "geöffnet",
    closed: "geschlossen",
    gmapsTitle: "Route in Google Maps",
    go: "🧭 Losfahren",
    pinBest: "⭐ AM GÜNSTIGSTEN",
    noPrice: "kein Preis",
    loading: "Wird geladen…",
    emptyStart: "Standort erlauben oder Ort eingeben.",
    emptyNone: "Keine Tankstellen im Umkreis von {r} km.",
    searching: "Suche Tankstellen…",
    whereSearch: "Wo suchen?",
    offlineFrom: "offline, Daten von {t}",
    updated: "aktualisiert {ago}",
    fromYou: "{d} von Ihnen",
    fromPoint: "{d} vom Suchpunkt",
    badgeBest: "⭐ NIEDRIGSTER PREIS",
    close: "Schließen",
    openChip: "● Geöffnet",
    closedChip: "● Geschlossen",
    priceChanged: "Preis geändert {t}",
    notSold: "nicht erhältlich",
    goGmaps: "🧭 Route — Google Maps",
    listBtn: "Liste",
    offlineSaved: "Kein Netz — gespeicherte Preise von {t} ({label}).",
    offlineSavedShort: "Kein Netz — gespeicherte Preise von {t}.",
    offlineNoData: "Kein Netz und keine gespeicherten Daten.",
    nearMe: "In meiner Nähe",
    orTypePlace: "Oder einen Ort eingeben. ",
    retry: "Erneut versuchen",
    justUpdated: "Preise wurden gerade aktualisiert",
    backOnline: "Wieder online",
    mClosed: " (geschlossen)",
    mNoPrices: "Keine Preise im Suchradius",
    mRoute: "🧭 Route zu Nr. 1",
    nearHome: "Zuhause",
    curLoc: "Aktueller Standort",
    mNeedSearch: "Zuerst Tankstellen suchen (Standort oder Ort).",
    mCreated: "Code erstellt {t} für: {p}.",
    mUnsupported: "Dieser Browser unterstützt keine Benachrichtigungen. Unter Android TankKarte in Chrome bzw. vom Startbildschirm öffnen.",
    mAsking: "Frage Berechtigung an…",
    mDenied: "Benachrichtigungen blockiert — bitte für TankKarte in den Handy-/Browser-Einstellungen erlauben.",
    mFail: "Fehlgeschlagen: {m}",
    copied: "Code kopiert",
    enableFirst: "Bitte zuerst Benachrichtigungen aktivieren",
  },
};

const LANGS = ["ru", "de"];
let LANG = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem("tk.lang"));
    if (LANGS.includes(saved)) return saved;
    // Новые пользователи с немецким телефоном — сразу немецкий; у остальных остаётся русский.
    if (!localStorage.getItem("tk.prefs") && /^de\b/i.test(navigator.language || "")) return "de";
  } catch { /* localStorage недоступен */ }
  return "ru";
})();

function t(key, params) {
  let s = I18N[LANG][key] ?? I18N.ru[key] ?? key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  return s;
}

/** «N заправок» с правильным склонением. */
function tStations(n) {
  if (LANG === "de") return `${n} ${n === 1 ? "Tankstelle" : "Tankstellen"}`;
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? "заправка"
    : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? "заправки" : "заправок";
  return `${n} ${w}`;
}

/** Применить язык к статичной разметке. */
function applyStaticI18n(root = document) {
  document.documentElement.lang = LANG;
  document.title = t("appTitle");
  root.querySelectorAll("[data-i18n]").forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll("[data-i18n-html]").forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  root.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  root.querySelectorAll("[data-i18n-title]").forEach(el => {
    el.title = t(el.dataset.i18nTitle); el.setAttribute("aria-label", t(el.dataset.i18nTitle));
  });
  root.querySelectorAll("[data-i18n-aria]").forEach(el => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
}
