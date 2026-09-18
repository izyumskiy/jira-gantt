// Точность прогнозов (Б9): насколько прогнозам можно верить. Для каждого завершённого эпика
// прогнозы 85%, сделанные за 8, 4 и 2 недели до финиша (из недельных записей истории, в том
// числе восстановленных), сравниваются с фактической датой завершения. Показатель — доля
// случаев, когда факт уложился в прогноз; ожидаемо около 85%. Сильно ниже — прогноз оптимистичен,
// сильно выше — перестраховывается.
//
// Источник — история, а не список сохранённых эпиков: история эпика остаётся и после удаления
// из выбора. Эпик, удалённый до завершения, в проверку не попадёт — его финиша плагин не видел.
import * as agg from "./agg.js";
import * as flowlib from "./flow.js";

export const HORIZONS = [8, 4, 2];
export const MIN_CASES = 5; // меньше сравнений — выводов не делаем
export const OPTIMISTIC_BELOW = 75; // %: заметно ниже 85 — прогноз оптимистичен
export const CAUTIOUS_ABOVE = 95; // %: заметно выше — перестраховывается

const DAY = 86400000;
const WEEK = 7 * DAY;
const dayMs = (iso) => (iso ? Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso) : NaN);

// Дата завершения эпика: дата завершения эпика из Jira; если её нет — дата закрытия последней задачи.
export function finishOf(record, issues = []) {
  if (record.resolved) return record.resolved;
  let last = "";
  for (const i of issues) {
    const c = agg.closedAt(i);
    if (c && (!last || Date.parse(c) > Date.parse(last))) last = c;
  }
  return last;
}

// weekly — Map ключ эпика → недельные записи по возрастанию недели; issuesByEpic — Map ключ → задачи.
export function forecastAccuracy({ weekly, issuesByEpic = new Map(), horizons = HORIZONS }) {
  const rows = [];
  const byHorizon = Object.fromEntries(horizons.map((h) => [h, { n: 0, hits: 0 }]));
  let n = 0;
  let hits = 0;
  for (const [epicKey, records] of weekly) {
    const doneRec = records.find((r) => r.statusCategory === "done");
    if (!doneRec) continue;
    const finish = finishOf(doneRec, issuesByEpic.get(epicKey) || []);
    const finishMs = dayMs(finish);
    if (!Number.isFinite(finishMs)) continue;
    const byWeek = new Map(records.map((r) => [r.week, r]));
    const finishWeek = flowlib.mondayOf(finishMs);
    const forecasts = {};
    for (const h of horizons) {
      const rec = byWeek.get(flowlib.weekKey(finishWeek - h * WEEK + 12 * 3600000));
      if (!rec || !rec.p85) {
        forecasts[h] = null;
        continue;
      }
      // Попал: факт не позже конца дня прогноза 85%.
      const hit = finishMs < dayMs(rec.p85) + DAY;
      forecasts[h] = { p85: rec.p85, hit, restored: !!rec.restored };
      byHorizon[h].n += 1;
      if (hit) byHorizon[h].hits += 1;
      n += 1;
      if (hit) hits += 1;
    }
    if (horizons.some((h) => forecasts[h])) {
      rows.push({ epicKey, label: `${epicKey} · ${doneRec.epicName || doneRec.summary || ""}`.trim(), finish, forecasts });
    }
  }
  rows.sort((a, b) => dayMs(b.finish) - dayMs(a.finish));
  const share = n ? (hits / n) * 100 : null;
  let verdict = "few";
  if (n >= MIN_CASES) verdict = share < OPTIMISTIC_BELOW ? "optimistic" : share > CAUTIOUS_ABOVE ? "cautious" : "ok";
  return { rows, n, hits, share, byHorizon, verdict };
}
