// Срок приёмки заказчиком (US-3): по истории статусов эпиков, побывавших в бизнес-тесте (БТ).
// Приёмка — от первого входа в БТ до первого «Готово» после него, в рабочих днях по календарю.
// Заказчик — постановщик эпика. Выгрузка раз в сутки, результат — в meta.acceptance.
import * as db from "./db.js";
import * as jira from "./jira.js";
import * as settings from "./settings.js";
import * as workcal from "./workcal.js";
import { isDoneStatus } from "./status.js";
import { normName } from "./team.js";
import { parseTypeList } from "./flow.js";

const META_KEY = "acceptance";
const DAY = 86400000;

export function btStatuses(s) {
  return parseTypeList(s && s.btStatuses);
}

// Приёмка одного эпика из ответа Jira с expand=changelog.
// shortcut: история изменений из поиска не дочитывается постранично — у эпика переходов статуса
// немного; если Jira начнёт обрезать (больше 100 записей), дочитывать через /issue/{key}?expand=changelog.
export function parseAcceptance(issue, bt, reporterField = "reporter") {
  const f = issue.fields || {};
  const isBt = (name) => bt.includes(String(name || "").trim().toLowerCase());
  const moves = [];
  for (const h of (issue.changelog && issue.changelog.histories) || []) {
    for (const it of h.items || []) if (it.field === "status") moves.push({ at: Date.parse(h.created), to: it.toString });
  }
  moves.sort((a, b) => a.at - b.at);
  let start = null;
  let end = null;
  let returned = false;
  for (const m of moves) {
    if (start == null) {
      if (isBt(m.to)) start = m.at;
      continue;
    }
    if (isDoneStatus(m.to, "")) {
      end = m.at;
      break;
    }
    if (!isBt(m.to)) returned = true;
  }
  if (start == null) return null;
  const rep = f[reporterField] || {};
  const inBt = end == null && isBt(f.status && f.status.name);
  if (end == null && !inBt) return null; // ушёл из БТ и не дошёл до «Готово» — приёмки пока нет
  return {
    key: issue.key,
    customer: normName(rep.displayName || rep.name || ""),
    customerName: rep.displayName || rep.name || "",
    start,
    end,
    returned,
    days: end != null ? workcal.workdaysBetween(start, end) : null
  };
}

// Выгрузка раз в сутки (force — сейчас). Возвращает приёмки: завершённые и идущие.
export async function load({ force = false, now = Date.now() } = {}) {
  const row = await db.metaGet(META_KEY);
  if (!force && row && now - row.at < DAY) return row.items;
  const s = settings.get();
  const bt = btStatuses(s);
  if (!bt.length) return [];
  const reporterField = (s.fields && s.fields.epicReporter) || "reporter";
  const days = Math.round((Number(s.btHistoryMonths) || 18) * 30.4);
  // В JQL — имена в написании из настроек (Jira сравнивает статусы без учёта регистра).
  const names = String(s.btStatuses || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const jql = `issuetype = Epic AND status WAS IN (${names.map((n) => `"${jira.escapeJql(n)}"`).join(",")}) AND updated >= -${days}d`;
  const issues = await jira.search(jql, ["status", reporterField], null, ["changelog"]);
  const items = issues.map((i) => parseAcceptance(i, bt, reporterField)).filter(Boolean);
  await db.metaSet(META_KEY, { at: now, items });
  return items;
}

const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);

// Статистика заказчика: его завершённые приёмки и общие (все заказчики).
export function customerStats(items, customer) {
  const done = items.filter((x) => x.days != null);
  const own = done.filter((x) => x.customer === customer);
  const sorted = own.map((x) => x.days).sort((a, b) => a - b);
  return {
    n: own.length,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    returnRate: own.length ? own.filter((x) => x.returned).length / own.length : null,
    own: own.map((x) => x.days),
    all: done.map((x) => x.days)
  };
}

// Выборка срока приёмки живёт рядом с прогнозом портфеля (считается в фоновом потоке).
export { acceptanceSampler } from "./portfolio.js";
