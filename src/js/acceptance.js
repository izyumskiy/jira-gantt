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

// Хранится сырая история статусов (разбирается при чтении по текущим настройкам); прежние ключи
// «acceptance» и «customers» хранили уже разобранные данные — формат другой.
const META_KEY = "customersRaw";
const DAY = 86400000;

// Название статуса для сравнения: без регистра, «ё», лишних и неразрывных пробелов, дефисов и
// подчёркиваний — «Бизнес-тест», «БИЗНЕС  ТЕСТ» и «бизнес тест» — одно и то же.
export const normStatus = (x) => String(x || "").toLowerCase().replace(/ё/g, "е").replace(/[\s\u00a0_\-–—]+/g, " ").trim();

// Статусы бизнес-теста из настроек — через запятую, можно на разных языках («бизнес тест, business test»).
export function btStatuses(s) {
  return parseTypeList(s && s.btStatuses).map(normStatus);
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
  const isBt = (name) => bt.includes(normStatus(name));
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
// Хранится только нужное: поля эпика и переходы статусов. Разбор — при каждом чтении, по текущим
// «Статусам бизнес-теста»: правка настройки действует сразу, без новой выгрузки.
const slim = (i, reporterField) => {
  const f = i.fields || {};
  const rep = f[reporterField] || {};
  return {
    key: i.key,
    fields: {
      summary: f.summary || "",
      created: f.created || "",
      status: { name: (f.status && f.status.name) || "", statusCategory: { key: (f.status && f.status.statusCategory && f.status.statusCategory.key) || "" } },
      [reporterField]: { displayName: rep.displayName || "", name: rep.name || "" }
    },
    changelog: {
      histories: ((i.changelog && i.changelog.histories) || [])
        .map((h) => ({ created: h.created, items: (h.items || []).filter((it) => it.field === "status").map((it) => ({ field: "status", toString: it.toString })) }))
        .filter((h) => h.items.length)
    }
  };
};

export async function load({ force = false, now = Date.now(), onPage = null } = {}) {
  const s = settings.get();
  const bt = btStatuses(s);
  const reporterField = (s.fields && s.fields.epicReporter) || "reporter";
  let row = await db.metaGet(META_KEY);
  if (force || !row || now - row.at >= DAY || row.reporterField !== reporterField) {
    const days = Math.max(365, Math.round((Number(s.btHistoryMonths) || 18) * 30.4));
    const jql = `issuetype = Epic AND updated >= -${days}d ORDER BY updated DESC`;
    const issues = await jira.search(jql, ["summary", "status", "created", reporterField], onPage, ["changelog"], 50);
    row = { at: now, reporterField, raw: issues.map((i) => slim(i, reporterField)) };
    await db.metaSet(META_KEY, row);
  }
  return row.raw.map((i) => parseEpic(i, bt, row.reporterField, now));
}

// Статусы, которые встречались в истории выгруженных эпиков, — подсказка, если бизнес-тест не найден.
export async function seenStatuses() {
  const row = await db.metaGet(META_KEY);
  const out = new Set();
  for (const i of (row && row.raw) || []) for (const h of i.changelog.histories) for (const it of h.items) if (it.toString) out.add(it.toString);
  return [...out].sort((a, b) => a.localeCompare(b, "ru"));
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

// Медиана отсортированного списка: при чётном числе — среднее двух средних.
const median = (sorted) => {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : Math.round(((sorted[m - 1] + sorted[m]) / 2) * 10) / 10;
};
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
        btMedian: median(finished),
        btAvg: avg(finished),
        btMax: finished.length ? finished[finished.length - 1] : null,
        toDoneMedian: median(toDone),
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
