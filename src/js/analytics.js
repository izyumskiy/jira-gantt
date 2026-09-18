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
export function epicFlowState({ epic, rows, tempo = [], profiles = [], issues, excludeTypes = [], weeks = 52, now = Date.now() }) {
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
  const remaining = issues.filter(
    (i) => i.epicKey === epic.key && !agg.isDone(i) && !flowlib.isExcludedType(i.typeName, excludeTypes)
  ).length;
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
export async function epicForecast({ epic, flow, teams = flow.teams, runs = 10000, now = Date.now(), seed = null, run = null }) {
  const args = { teams, shares: flow.shares, epicKey: epic.key, remaining: flow.remaining, runs, now, seed };
  const res = run ? await run(args) : flowlib.forecastForTeams({ ...args, rnd: seed ? flowlib.seededRandom(seed) : Math.random });
  const outlook = res && res.fc ? flowlib.dueOutlook(res.fc, dueMsOf(epic), now) : { chance: null, buffer: null };
  return { ...res, ...outlook };
}
