// Ракурс «Эпик — история» (ТЗ «Эпик — история», Р3, Р5): модель без интерфейса.
// Проект → эпик → история, полосы по тем же временным секциям, что на других ракурсах.
//
// Правила подсчёта:
// - итог эпика — по задачам эпика (Epic Link), каждая один раз, без исключённых типов (истории и
//   «Типы задач, не учитываемые в подсчётах»); совпадает с «Сохранёнными эпиками» и «По эпикам»;
// - итог истории — по её задачам (связь из настроек, в любую сторону), своим и чужим. Чужие — из
//   другого эпика или без эпика: в итог истории входят, в итоги эпика и проекта — нет;
// - «Без истории» — задачи эпика, у которых нет ни одной истории в этом эпике;
// - итог проекта — сумма итогов его эпиков.
import * as agg from "./agg.js";
import { classify } from "./status.js";
import { isExcludedType } from "./flow.js";
import * as prio from "./priority.js";
import * as omg from "./omg.js";

export const NO_PROJECT = "";
const numKey = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

// Проект эпика: действующая метка (omg project) или null — «Без проекта».
export function projectOf(epic) {
  const p = epic && epic.omg ? epic.omg.project : null;
  return p && p.name ? p : null;
}

// Группировка эпиков в проекты. Названия сравниваются без учёта регистра и лишних пробелов;
// показывается написание из самой свежей метки.
export function groupProjects(epics) {
  const out = new Map();
  for (const e of epics) {
    const p = projectOf(e);
    const key = p ? omg.projectKey(p.name) : NO_PROJECT;
    const name = p ? p.name.trim().replace(/\s+/g, " ") : "";
    if (!out.has(key)) out.set(key, { key, name, created: p ? p.created || "" : "", epics: [] });
    const g = out.get(key);
    if (p && (Date.parse(p.created || "") || 0) > (Date.parse(g.created || "") || 0)) {
      g.name = name;
      g.created = p.created || "";
    }
    g.epics.push(e);
  }
  return out;
}

function newNode(extra = {}) {
  return {
    count: 0,
    done: 0,
    other: 0,
    sum: 0,
    noSprint: 0,
    doneStatuses: new Set(),
    openStatuses: new Set(),
    cells: new Map(),
    backlog: agg.emptyCell(),
    ...extra
  };
}

// Задача в узел: счётчики и место на шкале (спринт → секция, вне спринта в работе → текущая секция,
// прочее без спринта и не готовое → бэклог) — как на «По эпикам».
function addIssue(node, issue, brief, ctx) {
  node.count += 1;
  node.sum += brief.estimate;
  brief.done ? (node.done += 1) : (node.other += 1);
  const st = (issue.statusName || "").trim();
  if (st) (brief.done ? node.doneStatuses : node.openStatuses).add(st);
  const cellOf = (id) => {
    if (!node.cells.has(id)) node.cells.set(id, agg.emptyCell());
    return node.cells.get(id);
  };
  if (issue.sprintId == null) {
    if (ctx.currentId && agg.isOffSprintWork(issue)) {
      agg.addTo(cellOf(ctx.currentId), agg.OFF_SPRINT_ID, brief.estimate, brief);
      return;
    }
    if (!brief.done) {
      node.noSprint += 1;
      agg.addTo(node.backlog, null, brief.estimate, brief);
    }
    return;
  }
  const secId = ctx.sectionOfSprint.get(issue.sprintId);
  if (secId) agg.addTo(cellOf(secId), issue.sprintId, brief.estimate, brief);
}

const statusOf = (x) => {
  const cls = classify(x.statusName, x.statusCategory);
  return { status: { name: x.statusName || "", category: x.statusCategory || "", id: cls.id }, statusRank: cls.rank };
};

// Веха проекта: ближайшая из вех незавершённых эпиков; если все эпики завершены — самая поздняя.
export function projectMilestone(epicNodes) {
  const open = epicNodes.filter((e) => e.milestone && e.status.id !== "done");
  const pool = open.length ? open : epicNodes.filter((e) => e.milestone);
  if (!pool.length) return null;
  const at = (e) => Date.parse(e.milestone.date.length === 10 ? `${e.milestone.date}T00:00:00` : e.milestone.date) || 0;
  const pick = pool.reduce((a, b) => (open.length ? (at(b) < at(a) ? b : a) : at(b) > at(a) ? b : a));
  return pick.milestone;
}

// Приоритет проекта: самый высокий среди незавершённых эпиков; все завершены — среди всех.
export function projectPriority(epicNodes, order) {
  const open = epicNodes.filter((e) => e.status.id !== "done");
  return prio.highest((open.length ? open : epicNodes).map((e) => e.priority), order);
}

// epics — эпики для показа (после галочек и фильтров), issues — задачи выбранных эпиков,
// linked — чужие задачи историй (хранилище linked), priorities — порядок приоритетов Jira.
// storyTypes / excludeTypes — в нижнем регистре; linkType — тип связи задачи с историей.
export function buildStoryModel({
  epics,
  issues,
  linked = [],
  sprints,
  boards = [],
  priorities = [],
  storyTypes = [],
  excludeTypes = [],
  excludeTypeNames = [],
  linkType = "",
  timelineIssues = null
}) {
  // Шкала и команды — те же, что на «По эпикам»: берём их из общей модели.
  const base = agg.buildModel({ issues: [], others: [], sprints, epics: [], boards, mode: "epicPeople", timelineIssues: timelineIssues || [...issues, ...linked] });
  const sectionOfSprint = new Map();
  for (const sec of base.columns) for (const s of sec.sprints) sectionOfSprint.set(s.id, sec.id);
  const ctx = { currentId: base.currentId, sectionOfSprint };

  const isStory = (i) => isExcludedType(i.typeName, storyTypes);
  const isEpicType = (typeName) => String(typeName || "").trim().toLowerCase() === "epic";
  const counted = (i) => !isExcludedType(i.typeName, excludeTypes) && !isStory(i) && !isEpicType(i.typeName);
  const lt = String(linkType || "").trim().toLowerCase();
  const okLink = (l) => !lt || String(l.type || "").toLowerCase() === lt;

  const issueByKey = new Map(issues.map((i) => [i.key, i]));
  const linkedByKey = new Map(linked.map((i) => [i.key, i]));
  // Обратные связи: задача хранит связь с историей — история её «видит», даже если у самой истории
  // связь не записана (данные с разных синхронизаций).
  const reverse = new Map();
  for (const i of [...issues, ...linked]) {
    for (const l of i.links || []) {
      if (!okLink(l)) continue;
      if (!reverse.has(l.key)) reverse.set(l.key, new Set());
      reverse.get(l.key).add(i.key);
    }
  }
  const byEpic = new Map();
  for (const i of issues) {
    const k = i.epicKey || "";
    if (!byEpic.has(k)) byEpic.set(k, []);
    byEpic.get(k).push(i);
  }
  const briefFor = (it) => agg.briefOf(it, agg.estimateOf(it), agg.isDone(it));

  const buildEpic = (e) => {
    const list = byEpic.get(e.key) || [];
    const node = newNode({
      key: e.key,
      epic: e,
      label: `${e.key} · ${e.epicName || e.summary || ""}`.trim(),
      priority: e.priority || null,
      milestone: agg.epicMilestone(e),
      dueDate: e.dueDate || "",
      ...statusOf(e),
      stories: [],
      noStory: newNode({ key: "" }),
      projects: new Map() // исполнители — для подсказки эпика, как на «По эпикам»
    });
    const inStory = new Set(); // задачи этого эпика, у которых есть история в этом эпике
    for (const s of list.filter(isStory)) {
      const sn = newNode({ key: s.key, story: s, label: `${s.key} · ${s.summary || ""}`.trim(), priority: s.priority || null, ...statusOf(s), foreign: 0, missing: [], ownSprint: null });
      const rel = new Map(); // ключ задачи → тип задачи на том конце (для «не загружена»)
      for (const l of s.links || []) if (okLink(l)) rel.set(l.key, l.typeName || "");
      for (const k of reverse.get(s.key) || []) if (!rel.has(k)) rel.set(k, "");
      for (const [k, typeName] of rel) {
        const it = issueByKey.get(k) || linkedByKey.get(k);
        if (!it) {
          // Эпик или другая история на том конце — не задача истории; прочее — не загрузилось.
          if (!isEpicType(typeName) && !isExcludedType(typeName, storyTypes) && !byEpic.has(k)) sn.missing.push(k);
          continue;
        }
        if (!counted(it)) continue;
        const brief = briefFor(it);
        if ((it.epicKey || "") !== e.key) {
          brief.foreignEpic = it.epicKey || "";
          sn.foreign += 1;
        } else inStory.add(k);
        addIssue(sn, it, brief, ctx);
      }
      sn.missing.sort(numKey);
      // История без задач, но со своим спринтом — полоса по спринту самой истории, без оценки.
      if (!sn.count && s.sprintId != null && sectionOfSprint.has(s.sprintId)) {
        sn.ownSprint = { secId: sectionOfSprint.get(s.sprintId), sprintId: s.sprintId, sprintName: s.sprintName || "" };
      }
      node.stories.push(sn);
    }
    for (const it of list.filter(counted)) {
      const brief = briefFor(it);
      addIssue(node, it, brief, ctx);
      if (!inStory.has(it.key)) addIssue(node.noStory, it, briefFor(it), ctx);
      const pk = it.assigneeKey || "";
      if (!node.projects.has(pk)) node.projects.set(pk, { key: pk, label: it.assigneeName || "", count: 0, sum: 0 });
      const p = node.projects.get(pk);
      p.count += 1;
      p.sum += brief.estimate;
    }
    node.projects = [...node.projects.values()].sort((a, b) => b.sum - a.sum || b.count - a.count);
    node.stories.sort((a, b) => prio.compare(a.priority, b.priority, priorities) || numKey(a.key, b.key));
    return node;
  };

  const projects = [];
  for (const g of groupProjects(epics).values()) {
    const epicNodes = g.epics.map(buildEpic);
    epicNodes.sort((a, b) => prio.compare(a.priority, b.priority, priorities) || a.statusRank - b.statusRank || numKey(a.key, b.key));
    const pn = newNode({ key: g.key, name: g.name, epics: epicNodes, storyCount: 0 });
    for (const en of epicNodes) {
      pn.storyCount += en.stories.length;
      for (const it of byEpic.get(en.key) || []) if (counted(it)) addIssue(pn, it, briefFor(it), ctx);
    }
    pn.priority = projectPriority(epicNodes, priorities);
    pn.milestone = projectMilestone(epicNodes);
    pn.allDone = epicNodes.length > 0 && epicNodes.every((e) => e.status.id === "done");
    pn.status = { id: pn.allDone ? "done" : "" };
    projects.push(pn);
  }
  // Диагностика: какие типы задач есть в показанных эпиках. Если историй не нашлось нигде, ракурс
  // покажет этот список — обычно «Типы историй» не совпадают с названием типа в Jira.
  const typeCounts = new Map();
  let storyTotal = 0;
  for (const e of epics) {
    for (const i of byEpic.get(e.key) || []) {
      const name = String(i.typeName || "").trim() || "—";
      typeCounts.set(name, (typeCounts.get(name) || 0) + 1);
      if (isStory(i)) storyTotal += 1;
    }
  }
  projects.sort(
    (a, b) =>
      Number(a.key === NO_PROJECT) - Number(b.key === NO_PROJECT) ||
      prio.compare(a.priority, b.priority, priorities) ||
      a.name.localeCompare(b.name)
  );

  return {
    columns: base.columns,
    currentId: base.currentId,
    teams: base.teams,
    teamOf: base.teamOf,
    teamOfSprint: base.teamOfSprint,
    sprintById: base.sprintById,
    maxCell: 0,
    projects,
    priorities,
    childKind: "person",
    excludeTypeNames,
    storyTotal,
    // Типы, похожие на истории, — кандидаты для кнопки «Считать историями».
    storyCandidates: [...typeCounts.keys()].filter((n) => /stor|истор/i.test(n) && !isExcludedType(n, storyTypes)),
    typeCounts: [...typeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n }))
  };
}
