// Расчёты по эпикам и людям (А1): одни и те же функции для карточки эпика, списка «Сохранённые
// эпики», окна «кто может подменить», вкладки «По людям», сводки и восстановления истории.
// Без DOM и сети: все данные приходят параметрами, включая момент расчёта.
import { t } from "./i18n.js";
import * as agg from "./agg.js";
import * as flowlib from "./flow.js";

export { personLoad } from "./agg.js";

// Счётчики эпиков для списка и карточки: списано, готовность по оценкам, задачи по проектам.
// Исключённые типы (по умолчанию User Story) — контейнеры для задач: в количестве задач, оценках
// и готовности их нет. Списанное на них время остаётся в сумме «Списано» — это реально потраченные часы.
// Возвращает Map: ключ эпика → { spent, pct, issueKeys }.
export function epicCounters(epics, issues, { excludeTypes = [] } = {}) {
  const out = new Map(
    epics.map((e) => [
      e.key,
      {
        spent: { epic: e.timeSpent || 0, issues: 0, withLogs: 0, total: 0 },
        pct: { done: 0, total: 0, doneCount: 0, count: 0, projects: new Map() },
        issueKeys: []
      }
    ])
  );
  for (const i of issues) {
    const acc = out.get(i.epicKey);
    if (!acc) continue;
    acc.issueKeys.push(i.key);
    acc.spent.issues += i.timeSpent || 0;
    if (flowlib.isExcludedType(i.typeName, excludeTypes)) continue;
    acc.spent.total += 1;
    if (i.timeSpent) acc.spent.withLogs += 1;
    const p = acc.pct;
    const est = agg.estimateOf(i);
    p.count += 1;
    p.total += est;
    const pk = i.projectKey || t("dash");
    if (!p.projects.has(pk)) p.projects.set(pk, { key: pk, name: i.projectName || pk, count: 0 });
    p.projects.get(pk).count += 1;
    if (agg.isDone(i)) {
      p.doneCount += 1;
      p.done += est;
    }
  }
  return out;
}

// Команда человека для истории потока: ручная (вкладка «Команда») важнее Tempo — так же, как на
// «По людям». Доски здесь нет: у завершённой задачи спринт для потока не важен.
export function flowTeamOf({ tempo = [], profiles = [] }) {
  const manual = agg.buildManualTeams(profiles);
  const index = agg.buildTempoIndex(tempo);
  return (p) => manual.of(p) || index.of(p);
}

// Поток команд и доля эпика: команды, работавшие над эпиком, их доли и остаток задач эпика.
// remaining можно передать готовым — так считается прошлая неделя при восстановлении истории (Б3).
export function epicFlowState({ epic, rows, tempo = [], profiles = [], issues, excludeTypes = [], weeks = 52, now = Date.now(), remaining = null }) {
  const model = flowlib.buildFlow({
    excludeTypes,
    rows,
    teamOf: flowTeamOf({ tempo, profiles }),
    weeks,
    epicKey: epic.key,
    now
  });
  const teams = model.teams.filter((x) => (x.byEpic.get(epic.key) || 0) > 0);
  // незакрытый эпик всё ещё в работе — его период активности тянется до конца окна
  if (remaining == null) {
    remaining = issues.filter(
      (i) => i.epicKey === epic.key && !agg.isDone(i) && !flowlib.isExcludedType(i.typeName, excludeTypes)
    ).length;
  }
  const open = remaining > 0;
  const shares = new Map(teams.map((x) => [x.team.id, flowlib.epicShare(x, epic.key, { open })]));
  return { model, teams, remaining, open, shares };
}

// Конец дня срока исполнения эпика в мс (срок — дата без времени).
export function dueMsOf(epic) {
  if (!epic || !epic.dueDate) return NaN;
  const d = new Date(epic.dueDate.length === 10 ? `${epic.dueDate}T23:59:59` : epic.dueDate);
  return d.getTime();
}

// Прогноз по выбранным командам + шанс успеть и запас до срока. run — функция прогона: по
// умолчанию здесь же (для проверок и восстановления), на странице — фоновый поток (forecastClient).
//
// Детерминизм (Б2): зерно — ключ эпика, отсчёт — понедельник недели (today). Одинаковые данные
// в пределах недели дают одинаковые даты; если за неделю ничего не закрыто, прогноз через неделю
// сдвинется на неделю — это настоящий сдвиг, а не шум.
export async function epicForecast({
  epic,
  flow,
  teams = flow.teams,
  runs = 10000,
  today = Date.now(),
  now = flowlib.mondayOf(today),
  seed = epic.key,
  run = null
}) {
  const args = { teams, shares: flow.shares, epicKey: epic.key, remaining: flow.remaining, runs, now, seed };
  const res = run ? await run(args) : flowlib.forecastForTeams({ ...args, rnd: seed ? flowlib.seededRandom(seed) : Math.random });
  const outlook = res && res.fc ? flowlib.dueOutlook(res.fc, dueMsOf(epic), now) : { chance: null, buffer: null };
  return { ...res, ...outlook };
}

// Открытые задачи эпика, прошедшие не меньше N спринтов, — «хронические переносы».
export function carriedOverCount(issues, epicKey, { excludeTypes = [], sprints = 3 } = {}) {
  return issues.filter(
    (i) => i.epicKey === epicKey && !agg.isDone(i) && !flowlib.isExcludedType(i.typeName, excludeTypes) && (i.sprintCount || 0) >= sprints
  ).length;
}

// Состояние эпика для истории и «Сводки» (Б1): счётчики, прогноз, шанс успеть, запас, команды.
// Плоский объект без Map и Date — чтобы лежать в IndexedDB и сравниваться между снимками.
function toState(epic, counters, flow, fc, carriedOver) {
  const pct = counters.pct;
  // Местная дата «ГГГГ-ММ-ДД»: через toISOString дата уехала бы на день назад восточнее Гринвича.
  const iso = (d) => {
    if (!(d instanceof Date)) return "";
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  };
  const lastById = new Map(((fc && fc.fc && fc.fc.last) || []).map((x) => [x.team.id, x.pct]));
  return {
    epicKey: epic.key,
    summary: epic.summary || "",
    epicName: epic.epicName || "",
    statusName: epic.statusName || "",
    statusCategory: epic.statusCategory || "",
    dueDate: epic.dueDate || "",
    resolved: epic.resolved || "",
    total: pct.count,
    done: pct.doneCount,
    remaining: pct.count - pct.doneCount,
    estTotal: pct.total,
    estDone: pct.done,
    carriedOver,
    p50: fc && fc.fc ? iso(fc.fc.dates.p50) : "",
    p85: fc && fc.fc ? iso(fc.fc.dates.p85) : "",
    chance: fc ? fc.chance ?? null : null,
    buffer: fc ? fc.buffer ?? null : null,
    reason: fc && fc.fc ? "" : (fc && fc.reason) || "none",
    historyWeeks: fc && fc.history ? fc.history.weeks : 0,
    teams: flow.teams.map((x) => {
      const sh = flow.shares.get(x.team.id);
      const act = (sh && (sh.active || sh)) || { share: 0 };
      return { id: x.team.id, name: x.team.name || "", share: Math.round(act.share * 1000) / 1000, last: lastById.get(x.team.id) || 0 };
    })
  };
}

// Состояния всех эпиков портфеля. Прогнозы — через run (на странице — фоновый поток), параллельно.
export async function portfolioStates({ epics, issues, flowRows, tempo = [], profiles = [], excludeTypes = [], weeks = 52, carrySprints = 3, runs = 10000, today = Date.now(), run = null }) {
  const counters = epicCounters(epics, issues, { excludeTypes });
  const out = await Promise.all(
    epics.map(async (epic) => {
      const flow = epicFlowState({ epic, rows: flowRows, tempo, profiles, issues, excludeTypes, weeks, now: today });
      const fc = flow.teams.length && flow.remaining ? await epicForecast({ epic, flow, runs, today, run }) : null;
      return toState(epic, counters.get(epic.key), flow, fc, carriedOverCount(issues, epic.key, { excludeTypes, sprints: carrySprints }));
    })
  );
  return new Map(out.map((st) => [st.epicKey, st]));
}

// Передышка для страницы между кусками тяжёлого расчёта. Не setTimeout: в фоновой вкладке (а
// автообновление работает именно там) Chrome замедляет таймеры до раза в секунду и реже.
// Сообщения MessageChannel не замедляются.
export function yieldToPage() {
  if (typeof MessageChannel === "undefined") return Promise.resolve();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

// Восстановление истории (Б3): состояние эпика на конец каждой прошедшей недели W.
//   объём — задачи эпика, созданные до конца W; остаток — не закрытые к концу W (agg.closedAt);
//   поток команд — только история завершений до начала W; доли — на момент W;
//   прогноз — как текущий (Б2), но 2 000 прогонов и отсчёт от понедельника W.
// flowStart — понедельник первой полной недели истории потока, lastWeek — понедельник последней
// полной недели; skipWeeks — недели с настоящими записями, их не трогаем. Первая неделя — не
// раньше создания эпика и не раньше, чем через FORECAST_MIN_WEEKS недель истории потока.
// Срок исполнения, состав команд и эпик задачи — текущие (ограничения восстановления).
export async function restoreEpicWeeks({
  epic,
  issues,
  flowRows,
  tempo = [],
  profiles = [],
  excludeTypes = [],
  flowStart,
  lastWeek,
  skipWeeks = new Set(),
  runs = 2000,
  run = null
}) {
  const WEEK = 7 * 86400000;
  const scopeAll = issues.filter((i) => i.epicKey === epic.key && !flowlib.isExcludedType(i.typeName, excludeTypes));
  let from = flowlib.mondayOf(flowStart + flowlib.FORECAST_MIN_WEEKS * WEEK + 12 * 3600000);
  const created = Date.parse(epic.created || "");
  if (Number.isFinite(created)) from = Math.max(from, flowlib.mondayOf(created));
  const resolved = Date.parse(epic.resolved || "");

  const jobs = [];
  // Шаг — через mondayOf: переход на летнее время не должен сдвигать недели.
  for (let week = from; week <= lastWeek; week = flowlib.mondayOf(week + WEEK + 12 * 3600000)) {
    const key = flowlib.weekKey(week);
    if (skipWeeks.has(key)) continue;
    // Отдаём управление странице каждые несколько недель: расчёт потока идёт в основном потоке,
    // и без передышек интерфейс подвисал бы на сотни миллисекунд (А3).
    if (jobs.length && jobs.length % 5 === 0) await yieldToPage();
    const end = week + WEEK;
    const scope = scopeAll.filter((i) => !i.created || Date.parse(i.created) < end);
    const closed = scope.filter((i) => {
      const c = agg.closedAt(i);
      return !!c && Date.parse(c) < end;
    });
    const remaining = scope.length - closed.length;
    const weeksAvail = Math.round((week - flowStart) / WEEK);
    const flow = epicFlowState({ epic, rows: flowRows, tempo, profiles, issues: [], excludeTypes, weeks: weeksAvail + 1, now: week, remaining });
    const counters = {
      pct: {
        count: scope.length,
        doneCount: closed.length,
        total: scope.reduce((n, i) => n + agg.estimateOf(i), 0),
        done: closed.reduce((n, i) => n + agg.estimateOf(i), 0)
      }
    };
    const doneThen = Number.isFinite(resolved) && resolved < end;
    const epicThen = { ...epic, statusName: "", statusCategory: doneThen ? "done" : "", resolved: doneThen ? epic.resolved : "" };
    jobs.push(
      (async () => {
        const fc = flow.teams.length && remaining ? await epicForecast({ epic: epicThen, flow, runs, today: week, run }) : null;
        return {
          ...toState(epicThen, counters, flow, fc, null),
          week: key,
          restored: true,
          approximate: weeksAvail < flowlib.FORECAST_OK_WEEKS
        };
      })()
    );
  }
  return Promise.all(jobs);
}
