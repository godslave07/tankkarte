/* Воркер расписания TankKarte: каждые 15 минут рассылает утренние уведомления тем,
 * у кого выбрано текущее время (по Берлину). Подписки и цены — в общей базе D1. */
import { berlinNow, deliver } from "./lib.js";

export default {
  async scheduled(event, env, ctx) {
    const now = berlinNow(new Date(event.scheduledTime));
    const slotMin = Math.floor(now.mm / 15) * 15;
    const slot = `${String(now.hh).padStart(2, "0")}:${String(slotMin).padStart(2, "0")}`;
    const { results } = await env.DB.prepare(
      `SELECT * FROM subs WHERE time = ? AND (last_sent IS NULL OR last_sent <> ?) AND (weekends = 1 OR ? < 5)`,
    ).bind(slot, now.date, now.weekday).all();
    let sent = 0, failed = 0;
    for (const row of results) {
      try {
        const status = await deliver(env, row);
        if (status >= 200 && status < 300) {
          sent++;
          await env.DB.prepare("UPDATE subs SET last_sent = ?, fails = 0 WHERE endpoint = ?").bind(now.date, row.endpoint).run();
        } else {
          failed++;
          await env.DB.prepare("UPDATE subs SET fails = fails + 1 WHERE endpoint = ?").bind(row.endpoint).run();
        }
      } catch (e) {
        failed++;
        console.error("deliver", e);
      }
    }
    // Раз в сутки — чистка старого кэша цен.
    if (slot === "03:00") {
      await env.DB.prepare("DELETE FROM price_cache WHERE at < ?").bind(Date.now() - 24 * 3600_000).run();
    }
    console.log(`slot ${now.date} ${slot}: ${results.length} subs, sent ${sent}, failed ${failed}`);
  },
};
