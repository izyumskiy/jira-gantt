// Бизнес-заказчики и срок приёмки (US-3): по истории статусов эпиков за год. Заказчик — постановщик
// эпика. Приёмка для прогноза — от первого входа в бизнес-тест (БТ) до первого «Готово» после него,
// в рабочих днях по календарю. Выгрузка раз в сутки, результат — в meta.customers.
import * as db from "./db.js";
import * as jira from "./jira.js";
import * as settings from "./settings.js";
import * as workcal from "./workcal.js";
import { isDoneStatus, classify } from "./status.js";
import { normName } from "./team.js";
import { parseTypeList } from "./flow.js";

const META_KEY = "customers"; // прежний ключ «acceptance» хранил только эпики из БТ — формат другой
const DAY = 86400000;

export function btStatuses(s) {
  return parseTypeList(s && s.btStatuses);
}

// Эпик из ответа Jira с expand=changelog — для экрана «Бизнес-заказчики» и срока приёмки:
//   started — первый переход из «Новой»/«К выполнению» дальше по процессу (начали делать);
//   done — когда перевели в «Готово» (последний вход, если эпик сейчас готов);
//   btDays — сколько рабочих дней эпик пробыл в бизнес-тесте: сумма всех заходов, текущий — по сегодня;
//   btNow — с какого момента эпик сейчас в БТ;
//   start / end / days — приёмка для прогноза: от первого входа в БТ до первого «Готово» после него,
//   включая возвраты на доработку; returned — был возврат.
// shortcut: история изменений из поиска не дочитывается постранично — у эпика переходов статуса
// немного; если Jira начнёт обрезать (больше 100 записей), дочитывать через /issue/{key}?expand=changelog.
export function parseEpic(issue, bt, reporterField = "reporter", now = Date.now()) {
  const f = issue.fields || {};
  const isBt = (name) => bt.includes(String(name || "").trim().toLowerCase());
  const isDone = (name) => isDoneStatus(name, "");
  const moves = [];
  for (const h of (issue.changelog && issue.changelog.histories) || []) {
    for (const it of h.items || []) if (it.field === "status") moves.push({ at: Date.parse(h.created), to: it.toString });
  }
  moves.sort((a, b) => a.at - b.at);
  let started = null;
  let doneAt = null;
  let start = null;
  let end = null;
  let returned = false;
  let btDays = null;
  let open = null;
  for (const m of moves) {
    const cls = classify(m.to, "").id;
    if (started == null && cls !== "new" && cls !== "todo") started = m.at;
    if (open != null && !isBt(m.to)) {
      btDays += workcal.workdaysBetween(open, m.at);
      open = null;
    }
    if (isBt(m.to) && open == null) {
      open = m.at;
      btDays = btDays || 0;
      if (start == null) start = m.at;
    }
    if (start != null && end == null) {
      if (isDone(m.to)) end = m.at;
      else if (!isBt(m.to)) returned = true;
    }
    if (isDone(m.to)) doneAt = m.at;
  }
  const status = (f.status && f.status.name) || "";
  const btNow = open != null && isBt(status) ? open : null;
  if (btNow != null) btDays += workcal.workdaysBetween(btNow, now);
  const rep = f[reporterField] || {};
  return {
    key: issue.key,
    summary: f.summary || "",
    status,
    statusCategory: (f.status && f.status.statusCategory && f.status.statusCategory.key) || "",
    customer: normName(rep.displayName || rep.name || ""),
    customerName: rep.displayName || rep.name || "",
    created: Date.parse(f.created) || null,
    started,
    done: isDoneStatus(status, (f.status && f.status.statusCategory && f.status.statusCategory.key) || "") ? doneAt : null,
    btDays,
    btNow,
    start,
    end,
    returned,
    days: end != null ? workcal.workdaysBetween(start, end) : null
  };
}

// Приёмка одного эпика: null, если эпик не был в БТ или ушёл из БТ и не дошёл до «Готово».
export function parseAcceptance(issue, bt, reporterField = "reporter", now = Date.now()) {
  const r = parseEpic(issue, bt, reporterField, now);
  if (r.start == null) return null;
  if (r.end == null && r.btNow == null) return null;
  return r;
}

// Выгрузка раз в сутки (force — сейчас): все эпики, обновлённые за год (или за «Историю приёмок»,
// если она длиннее), с историей статусов. Экран «Бизнес-заказчики» показывает их все, прогноз берёт
// приёмки (days) и эпики, которые сейчас в БТ (btNow).
export async function load({ force = false, now = Date.now(), onPage = null } = {}) {
  const row = await db.metaGet(META_KEY);
  if (!force && row && now - row.at < DAY) return row.items;
  const s = settings.get();
  const bt = btStatuses(s);
  const reporterField = (s.fields && s.fields.epicReporter) || "reporter";
  const days = Math.max(365, Math.round((Number(s.btHistoryMonths) || 18) * 30.4));
  const jql = `issuetype = Epic AND updated >= -${days}d ORDER BY updated DESC`;
  const issues = await jira.search(jql, ["summary", "status", "created", reporterField], onPage, ["changelog"], 50);
  const items = issues.map((i) => parseEpic(i, bt, reporterField, now));
  await db.metaSet(META_KEY, { at: now, items });
  return items;
}

// Когда выгружали в последний раз (для экрана).
export async function loadedAt() {
  const row = await db.metaGet(META_KEY);
  return row ? row.at : null;
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

const avg = (list) => (list.length ? Math.round((list.reduce((n, x) => n + x, 0) / list.length) * 10) / 10 : null);

// Экран «Бизнес-заказчики»: эпики за последний год (созданные, готовые за год или ещё не готовые),
// сгруппированные по заказчику, со сводкой ожидания в БТ. Заказчики — по алфавиту.
export function customersReport(items, now = Date.now()) {
  const yearAgo = now - 365 * DAY;
  const inYear = items.filter((x) => (x.created != null && x.created >= yearAgo) || (x.done != null && x.done >= yearAgo) || (x.done == null && !isDoneStatus(x.status, x.statusCategory)));
  const groups = new Map();
  for (const x of inYear) {
    const k = x.customer || "";
    if (!groups.has(k)) groups.set(k, { customer: k, name: x.customerName, epics: [] });
    groups.get(k).epics.push(x);
  }
  const out = [];
  for (const g of groups.values()) {
    const finished = g.epics.filter((x) => x.btDays != null && x.btNow == null).map((x) => x.btDays).sort((a, b) => a - b);
    const toDone = g.epics.filter((x) => x.days != null).map((x) => x.days).sort((a, b) => a - b);
    const now_ = g.epics.filter((x) => x.btNow != null);
    g.epics.sort((a, b) => (b.started || b.created || 0) - (a.started || a.created || 0));
    out.push({
      ...g,
      summary: {
        epics: g.epics.length,
        done: g.epics.filter((x) => x.done != null).length,
        bt: finished.length,
        btMedian: percentile(finished, 50),
        btAvg: avg(finished),
        btMax: finished.length ? finished[finished.length - 1] : null,
        toDoneMedian: percentile(toDone, 50),
        returned: g.epics.filter((x) => x.returned).length,
        inBt: now_.length,
        inBtMax: now_.length ? Math.max(...now_.map((x) => x.btDays)) : null
      }
    });
  }
  return out.sort((a, b) => (a.name || "яяя").localeCompare(b.name || "яяя", "ru"));
}

// Выборка срока приёмки живёт рядом с прогнозом портфеля (считается в фоновом потоке).
export { acceptanceSampler } from "./portfolio.js";
