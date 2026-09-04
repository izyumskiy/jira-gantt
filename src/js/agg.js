// Агрегация: из задач и спринтов собираем модель для диаграммы Ганта.
//
// Колонки — не спринты, а ВРЕМЕННЫЕ СЕКЦИИ равной длины (шаг = типичная длина спринта),
// отсчитанные от начала текущего спринта. Спринт попадает в секцию по своей середине,
// поэтому спринты разных команд (досок), идущие параллельно, оказываются в одной колонке.
// Команда спринта = доска, на которой он заведён (другого понятия «команда» в Jira Server нет).
import { t } from "./i18n.js";
import * as settings from "./settings.js";
import { classify, isDoneStatus } from "./status.js";

// ---------- оценки ----------

export function estimateOf(issue) {
  const f = settings.get().estimateField;
  if (f === "points") return Number(issue.storyPoints) || 0;
  if (f === "remaining") return Number(issue.remainingEstimate) || 0;
  return Number(issue.originalEstimate) || 0;
}

export function isPoints() {
  return settings.get().estimateField === "points";
}

const round = (n, p = 1) => Math.round(n * 10 ** p) / 10 ** p;

export function fmtEstimate(value) {
  if (!value) return t("dash");
  if (isPoints()) return `${round(value, 2)} ${t("unit.sp")}`;
  const hpd = Number(settings.get().hoursPerDay) || 8;
  const hours = value / 3600;
  if (hours >= hpd) return `${round(hours / hpd, 1)}${t("unit.d")}`;
  return `${round(hours, 1)}${t("unit.h")}`;
}

// Категории статуса может не быть (задача из старой выгрузки) — тогда решаем по названию.
export function isDone(issue) {
  return isDoneStatus(issue.statusName, issue.statusCategory);
}

// ---------- спринты и время ----------

const DAY = 86400000;
const ts = (s) => (s ? Date.parse(s) || null : null);
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function sortSprints(list) {
  return [...list].sort((a, b) => {
    const as = ts(a.startDate);
    const bs = ts(b.startDate);
    if (as && bs && as !== bs) return as - bs;
    if (as && !bs) return -1;
    if (!as && bs) return 1;
    return a.id - b.id;
  });
}

const isClosed = (s) => s.state === "CLOSED" || !!s.completeDate;

// Текущий спринт: активный (по датам, если активных несколько), иначе тот, в чьи даты попадает
// сегодня, иначе ближайший будущий.
export function currentSprint(sprints) {
  const now = Date.now();
  const inRange = (s) => {
    const a = ts(s.startDate);
    const b = ts(s.endDate);
    return a && b && a <= now && now <= b;
  };
  const active = sortSprints(sprints.filter((s) => s.state === "ACTIVE"));
  return (
    active.find(inRange) ||
    active[0] ||
    sortSprints(sprints).find(inRange) ||
    sortSprints(sprints.filter((s) => !isClosed(s) && (ts(s.startDate) || 0) > now))[0] ||
    null
  );
}

// Типичная длина спринта в днях — самая частая среди спринтов с датами (по умолчанию 14).
export function sprintStepDays(sprints) {
  const freq = new Map();
  for (const s of sprints) {
    const a = ts(s.startDate);
    const b = ts(s.endDate);
    if (!a || !b || b <= a) continue;
    const d = Math.max(1, Math.round((b - a) / DAY));
    freq.set(d, (freq.get(d) || 0) + 1);
  }
  let best = 14;
  let bestN = 0;
  for (const [d, n] of freq) {
    if (n > bestN || (n === bestN && d < best)) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

export const NO_DATES_ID = "sec:nodate";

// Секции от текущего спринта в будущее; хвост секций без задач отбрасываем, а пустые
// секции между занятыми оставляем — шкала времени должна быть честной.
export function timeline(sprints, issues) {
  const cur = currentSprint(sprints);
  if (!cur) return [];
  const step = sprintStepDays(sprints) * DAY;
  const origin = startOfDay(ts(cur.startDate) || Date.now());

  const candidates = sprints.filter((s) => {
    if (s.id === cur.id) return true;
    if (isClosed(s)) return false;
    const end = ts(s.endDate);
    return !end || end >= origin;
  });

  const byIndex = new Map();
  let noDates = null;
  for (const s of sortSprints(candidates)) {
    const a = ts(s.startDate);
    const b = ts(s.endDate);
    if (!a) {
      noDates = noDates || { id: NO_DATES_ID, index: Infinity, start: null, end: null, sprints: [] };
      noDates.sprints.push(s);
      continue;
    }
    const mid = b && b > a ? (a + b) / 2 : a;
    const index = Math.max(0, Math.floor((mid - origin) / step));
    if (!byIndex.has(index)) {
      byIndex.set(index, { id: `sec:${index}`, index, start: origin + index * step, end: origin + (index + 1) * step, sprints: [] });
    }
    byIndex.get(index).sprints.push(s);
  }

  const used = new Set(issues.map((i) => i.sprintId).filter((v) => v != null));
  const hasIssues = (sec) => sec.sprints.some((s) => used.has(s.id));
  let last = 0;
  for (const sec of byIndex.values()) if (hasIssues(sec)) last = Math.max(last, sec.index);

  const sections = [];
  for (let i = 0; i <= last; i++) {
    sections.push(
      byIndex.get(i) || { id: `sec:${i}`, index: i, start: origin + i * step, end: origin + (i + 1) * step, sprints: [] }
    );
  }
  if (noDates && hasIssues(noDates)) sections.push(noDates);
  for (const sec of sections) sec.label = sectionLabel(sec);
  return sections;
}

// ---------- команды ----------

const TEAM_COLORS = 8;

// Команды = доски: у каждой свой цвет (индекс палитры), безкомандные спринты — серые.
function buildTeams(sprints, boards) {
  const boardName = new Map(boards.map((b) => [String(b.id), b.name]));
  const ids = [...new Set(sprints.map((s) => s.boardId).filter(Boolean).map(String))];
  const teams = new Map();
  ids
    .map((id) => ({ id, name: boardName.get(id) || `#${id}` }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((tm, i) => teams.set(tm.id, { ...tm, color: i % TEAM_COLORS }));
  const none = { id: "", name: t("gantt.noTeam"), color: -1 };
  return { teams, none, of: (sprint) => (sprint && sprint.boardId ? teams.get(String(sprint.boardId)) : null) || none };
}

// ---------- модель ----------

// Ячейка хранит и список задач — для всплывающего окна по клику на полосу.
function emptyCell() {
  return { count: 0, sum: 0, bySprint: new Map(), issues: [] };
}

function addTo(cell, sprintId, est, brief) {
  cell.count += 1;
  cell.sum += est;
  cell.issues.push(brief);
  if (sprintId == null) return;
  if (!cell.bySprint.has(sprintId)) cell.bySprint.set(sprintId, { count: 0, sum: 0, issues: [] });
  const part = cell.bySprint.get(sprintId);
  part.count += 1;
  part.sum += est;
  part.issues.push(brief);
}

// Краткая карточка задачи для списков.
function briefOf(issue, est, done) {
  return {
    key: issue.key,
    summary: issue.summary || "",
    statusName: issue.statusName || "",
    statusCategory: issue.statusCategory || "",
    assigneeName: issue.assigneeName || "",
    sprintName: issue.sprintName || "",
    estimate: est,
    done
  };
}

export const BACKLOG_ID = "sec:backlog";

// mode: "epic" | "assignee"; others — задачи людей вне целевых эпиков (учитываются только по людям).
export function buildModel({ issues, others = [], sprints, epics, boards = [], mode }) {
  const teamsInfo = buildTeams(sprints, boards);
  const sprintById = new Map(sprints.map((s) => [s.id, s]));
  const columns = timeline(sprints, issues);
  // Внутри секции спринты идут по командам, чтобы цвета в колонке не перемешивались.
  for (const sec of columns) {
    sec.sprints.sort((a, b) => teamsInfo.of(a).name.localeCompare(teamsInfo.of(b).name) || a.id - b.id);
  }
  const sectionOfSprint = new Map();
  for (const sec of columns) for (const s of sec.sprints) sectionOfSprint.set(s.id, sec.id);

  const epicById = new Map(epics.map((e) => [e.key, e]));
  const groups = new Map();
  const groupKeyOf = (i) => (mode === "epic" ? i.epicKey || "" : i.assigneeKey || "");
  const groupLabelOf = (i) => {
    if (mode === "epic") {
      const k = i.epicKey || "";
      return k ? `${k} · ${epicById.get(k)?.summary || ""}`.trim() : t("dash");
    }
    return i.assigneeName || t("gantt.noAssignee");
  };

  for (const issue of issues) {
    const gk = groupKeyOf(issue);
    if (!groups.has(gk)) {
      const epic = mode === "epic" ? epicById.get(gk) : null;
      const cls = epic ? classify(epic.statusName, epic.statusCategory) : null;
      groups.set(gk, {
        key: gk,
        label: groupLabelOf(issue),
        status: epic ? { name: epic.statusName || "", category: epic.statusCategory || "", id: cls.id } : null,
        statusRank: cls ? cls.rank : 0,
        login: mode === "assignee" ? issue.assigneeLogin || "" : "",
        team: null,
        teamVotes: new Map(),
        count: 0,
        done: 0,
        other: 0,
        sum: 0,
        noSprint: 0,
        // Реальные названия статусов из загруженных задач — из них строятся ссылки на JQL.
        doneStatuses: new Set(),
        openStatuses: new Set(),
        cells: new Map(),
        // Бэклог: задачи без спринта и не в статусе «Готово».
        backlog: emptyCell(),
        projects: new Map(),
        // Прочие эпики человека: итоги, ячейки по секциям и разбивка по эпикам.
        otherCount: 0,
        otherSum: 0,
        otherCells: new Map(),
        otherEpics: new Map()
      });
    }
    const g = groups.get(gk);
    const est = estimateOf(issue);
    const done = isDone(issue);
    g.count += 1;
    g.sum += est;
    done ? (g.done += 1) : (g.other += 1);
    const statusName = (issue.statusName || "").trim();
    if (statusName) (done ? g.doneStatuses : g.openStatuses).add(statusName);

    const pk = issue.projectKey || t("dash");
    if (!g.projects.has(pk)) {
      g.projects.set(pk, { key: pk, label: issue.projectName || pk, count: 0, sum: 0, noSprint: 0, cells: new Map(), backlog: emptyCell() });
    }
    const p = g.projects.get(pk);
    p.count += 1;
    p.sum += est;

    const brief = briefOf(issue, est, done);
    if (issue.sprintId == null) {
      // Выполненную задачу вне спринта считать нечего — в бэклог идут только незакрытые.
      if (!done) {
        g.noSprint += 1;
        p.noSprint += 1;
        addTo(g.backlog, null, est, brief);
        addTo(p.backlog, null, est, brief);
      }
      continue; // задачи вне спринтов на секции не влияют
    }

    // Команда человека — доска, где лежит больше всего его задач (включая закрытые спринты).
    const team = teamsInfo.of(sprintById.get(issue.sprintId));
    if (team.id) g.teamVotes.set(team.id, (g.teamVotes.get(team.id) || 0) + 1);

    const secId = sectionOfSprint.get(issue.sprintId);
    if (!secId) continue; // прошлые спринты вне таймлайна
    for (const bag of [g.cells, p.cells]) {
      if (!bag.has(secId)) bag.set(secId, emptyCell());
      addTo(bag.get(secId), issue.sprintId, est, brief);
    }
  }

  if (mode === "assignee") {
    for (const issue of others) {
      const g = groups.get(issue.assigneeKey || "");
      if (!g) continue; // людей берём только из целевых эпиков
      const est = estimateOf(issue);
      g.otherCount += 1;
      g.otherSum += est;
      const ek = issue.epicKey || "";
      if (!g.otherEpics.has(ek)) g.otherEpics.set(ek, { key: ek, summary: issue.epicSummary || "", count: 0, sum: 0 });
      const oe = g.otherEpics.get(ek);
      oe.count += 1;
      oe.sum += est;
      if (issue.sprintId == null) continue;
      const team = teamsInfo.of(sprintById.get(issue.sprintId));
      if (team.id) g.teamVotes.set(team.id, (g.teamVotes.get(team.id) || 0) + 1);
      const secId = sectionOfSprint.get(issue.sprintId);
      if (!secId) continue;
      if (!g.otherCells.has(secId)) g.otherCells.set(secId, emptyCell());
      addTo(g.otherCells.get(secId), issue.sprintId, est, briefOf(issue, est, isDone(issue)));
    }
  }

  const list = [...groups.values()].map((g) => {
    let team = teamsInfo.none;
    let best = 0;
    for (const [id, n] of g.teamVotes) {
      if (n > best) {
        best = n;
        team = teamsInfo.teams.get(id) || teamsInfo.none;
      }
    }
    return {
      ...g,
      team: mode === "assignee" ? team : null,
      projects: [...g.projects.values()].sort((a, b) => b.sum - a.sum || b.count - a.count),
      otherEpics: [...g.otherEpics.values()].sort((a, b) => b.sum - a.sum || b.count - a.count)
    };
  });

  if (mode === "epic") {
    // Эпики: сначала то, что в работе и на бизнес-тесте, ниже — «сделать» и «new», в самом низу готовое.
    list.sort((a, b) => a.statusRank - b.statusRank || b.sum - a.sum || b.count - a.count);
  } else {
    // Люди: по командам (безкомандные в конце), внутри команды — по объёму работы.
    const teamOrder = (g) => (g.team.id ? g.team.name : "￿");
    list.sort((a, b) => teamOrder(a).localeCompare(teamOrder(b)) || b.sum - a.sum || b.count - a.count);
  }

  // Максимум по ячейкам проектов — для относительной заливки полос.
  let max = 0;
  for (const g of list) {
    for (const p of g.projects) {
      for (const c of p.cells.values()) max = Math.max(max, c.sum || c.count);
      max = Math.max(max, p.backlog.sum || p.backlog.count);
    }
    for (const c of g.otherCells.values()) max = Math.max(max, c.sum || c.count);
  }

  const visibleTeams = new Map();
  for (const sec of columns) for (const s of sec.sprints) {
    const tm = teamsInfo.of(s);
    visibleTeams.set(tm.id, tm);
  }

  return {
    columns,
    groups: list,
    maxCell: max,
    currentId: columns.length ? columns[0].id : null,
    teams: [...visibleTeams.values()],
    teamOf: teamsInfo.of,
    teamOfSprint: (id) => teamsInfo.of(sprintById.get(id)),
    sprintById,
    targetKeys: epics.map((e) => e.key)
  };
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
}

// Подпись секции: «31.08 – 13.09»; секция без дат — словами.
export function sectionLabel(sec) {
  if (sec.id === NO_DATES_ID) return t("gantt.noDates");
  return `${fmtDate(new Date(sec.start).toISOString())} – ${fmtDate(new Date(sec.end - 1).toISOString())}`;
}
