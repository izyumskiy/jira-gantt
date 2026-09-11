// Отрисовка диаграммы Ганта: слева дерево (эпик → исполнители, исполнитель → эпики), справа полосы
// по временным секциям. Группы: у эпика одна жёлтая полоса-итог; у человека полоса делится на
// жёлтую (целевые эпики) и серую (прочие эпики) части пропорционально объёму. Вложенные строки
// рисуются тонкими голубыми отрезками — по одному на каждый спринт секции.
import { t } from "./i18n.js";
import { fmtEstimate, NO_DATES_ID, BACKLOG_ID, sprintCapacity } from "./agg.js";
import * as settings from "./settings.js";
import { cfId, escapeJql, comments as jiraComments, addComment as jiraAddComment, userSearch as jiraUserSearch } from "./jira.js";

// Комментарии эпика — через это, чтобы самопроверка могла подменить Jira заглушкой.
export const commentsApi = {
  list: (key) => jiraComments(key),
  add: (key, text) => jiraAddComment(key, text),
  users: (query) => jiraUserSearch(query)
};
const RECENT_COMMENTS = 5;

// Позиционирование всплывающих окон: ниже якоря, если помещается; иначе выше; иначе прижимаем
// к нижнему краю экрана. Вызывается повторно, когда содержимое подгрузилось и высота выросла.
export function placePopover(box, anchor) {
  if (!box || !anchor || !box.isConnected) return;
  const margin = 8;
  const r = anchor.getBoundingClientRect();
  const h = box.offsetHeight;
  const w = box.offsetWidth;
  const below = window.innerHeight - r.bottom - margin;
  const above = r.top - margin;
  let top;
  if (h <= below) top = r.bottom + 6;
  else if (h <= above) top = r.top - h - 6;
  else top = Math.max(margin, window.innerHeight - h - margin);
  box.style.top = `${top}px`;
  box.style.left = `${Math.max(margin, Math.min(window.innerWidth - w - margin, r.left))}px`;
}

// Эпики с включённой подсветкой критического пути (ключи).
const criticalOn = new Set();

const DAY_MS_C = 86400000;
function workdaysUntil(dueIso, now = Date.now()) {
  const due = new Date(dueIso.length === 10 ? `${dueIso}T00:00:00` : dueIso);
  if (Number.isNaN(+due)) return null;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  let n = 0;
  for (let x = new Date(d.getTime() + DAY_MS_C); x <= due; x = new Date(x.getTime() + DAY_MS_C)) {
    const wd = x.getDay();
    if (wd !== 0 && wd !== 6) n += 1;
  }
  return n;
}

// Критический путь по людям эпика: вариант 1 — чьи открытые задачи заканчиваются позже всех
// (при равенстве — больший остаток; без спринтов — просто больший остаток); вариант 2 — чей остаток
// оценок больше ёмкости в рабочих днях до срока эпика. Возвращает Map key → [причины].
export function criticalPeople(g, model) {
  const reasons = new Map();
  const add = (key, text) => reasons.set(key, [...(reasons.get(key) || []), text]);
  const stats = g.projects
    .map((p) => {
      // Остаток — по всем открытым задачам человека в эпике, включая лежащие в закрытых спринтах.
      const open = (p.issues || []).filter((i) => !i.done);
      const remaining = open.reduce((n, i) => n + (i.estimate || 0), 0);
      let lastEnd = null;
      let lastName = "";
      for (const i of open) {
        const sp = i.sprintId != null ? model.sprintById.get(i.sprintId) : null;
        const end = sp && sp.endDate ? Date.parse(sp.endDate) : null;
        if (end != null && (lastEnd == null || end > lastEnd)) {
          lastEnd = end;
          lastName = sp.name;
        }
      }
      return { p, open, remaining, lastEnd, lastName };
    })
    .filter((x) => x.open.length);
  if (!stats.length) return reasons;

  // Вариант 1.
  const withEnd = stats.filter((x) => x.lastEnd != null);
  const pool = withEnd.length ? withEnd : stats;
  const top = pool.reduce((a, b) => (b.lastEnd !== a.lastEnd && withEnd.length ? (b.lastEnd > a.lastEnd ? b : a) : b.remaining > a.remaining ? b : a));
  if (top.remaining > 0 || top.lastEnd != null) {
    add(
      top.p.key,
      top.lastEnd != null
        ? t("crit.defines", { rem: fmtEstimate(top.remaining), sprint: top.lastName })
        : t("crit.definesNoSprint", { rem: fmtEstimate(top.remaining) })
    );
  }

  // Вариант 2: ёмкость до срока = рабочие дни × часов в дне.
  if (g.dueDate) {
    const days = workdaysUntil(g.dueDate);
    if (days != null) {
      const cap = days * (Number(settings.get().hoursPerDay) || 8) * 3600;
      for (const x of stats) {
        if (x.remaining > cap) {
          add(x.p.key, t("crit.overCapacity", { rem: fmtEstimate(x.remaining), cap: fmtEstimate(cap), due: fmtDue(Date.parse(g.dueDate.length === 10 ? `${g.dueDate}T00:00:00` : g.dueDate)) }));
        }
      }
    }
  }
  return reasons;
}

function criticalButton(g, model, rerender) {
  const on = criticalOn.has(g.key);
  const btn = el("button", "crit-btn" + (on ? " on" : ""), "⚡");
  btn.type = "button";
  btn.title = on ? t("crit.on") : t("crit.button");
  btn.onclick = (e) => {
    e.stopPropagation();
    on ? criticalOn.delete(g.key) : criticalOn.add(g.key);
    rerender();
  };
  return btn;
}
import { normName } from "./team.js";

const collapsed = { epic: new Set(), epicPeople: new Set(), assignee: new Set() };

// В шапке секции показываем не больше стольких спринтов; остальные — по клику на шапку.
const HEADER_SPRINTS = 7;
const expandedHeaders = new Set();

// Свернуть/развернуть группы снаружи (фильтр по человеку на «Ганте по эпикам и людям»).
export function setCollapsed(mode, keys) {
  collapsed[mode] = new Set(keys);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const teamClass = (team) => (team && team.color >= 0 ? `tc-${team.color}` : "tc-none");

function dot(team) {
  const d = el("i", `dot ${teamClass(team)}`);
  d.title = team ? team.hint || team.name : "";
  return d;
}

// Доля готовых задач в ячейке: по оценке, а если оценок нет — по количеству. Это и есть зелёная заливка.
function doneShare(issues) {
  const total = issues.reduce((n, i) => n + (i.estimate || 0), 0);
  if (total > 0) return issues.reduce((n, i) => n + (i.done ? i.estimate || 0 : 0), 0) / total;
  return issues.length ? issues.filter((i) => i.done).length / issues.length : 0;
}

function applyDone(bar, issues) {
  const done = issues.filter((i) => i.done).length;
  bar.style.setProperty("--fill", `${Math.round(doneShare(issues) * 100)}%`);
  bar.dataset.done = `${done}/${issues.length}`;
  return t("gantt.doneShare", { done, total: issues.length });
}

function numbers(count, sum) {
  return [el("span", "bar-count", String(count)), el("span", "bar-sum", fmtEstimate(sum))];
}

// Жёлтая полоса-итог эпика; по клику — список задач ячейки.
function groupBar(cell, maxCell, title) {
  const bar = el("div", "bar bar-group clickable");
  const doneText = applyDone(bar, cell.issues);
  bar.append(...numbers(cell.count, cell.sum));
  bar.title = `${doneText} · ${t("gantt.clickIssues")}`;
  bar.onclick = (e) => showIssues(e.currentTarget, title, cell.issues);
  return bar;
}

// Подпись секции для заголовка списка задач: имена её спринтов.
function sectionTitle(sec) {
  if (sec.id === BACKLOG_ID) return t("gantt.backlog");
  if (sec.id === NO_DATES_ID) return t("gantt.noDates");
  return sec.sprints.map((s) => s.name).join(", ") || t("gantt.current");
}

// Полоса человека: слева жёлтая часть (целевые эпики), справа серая (прочие), ширины — по объёму.
function splitBar(target, other) {
  const tc = target ? target.count : 0;
  const ts = target ? target.sum : 0;
  const oc = other ? other.count : 0;
  const os = other ? other.sum : 0;
  if (!tc && !oc) return null;
  const bar = el("div", "bar bar-split");
  let share = ts + os ? ts / (ts + os) : tc / (tc + oc);
  if (tc && oc) share = Math.min(0.8, Math.max(0.2, share)); // обеим частям нужно место под цифры
  if (tc) {
    const part = el("div", "part part-target");
    part.style.flexBasis = oc ? `${Math.round(share * 100)}%` : "100%";
    part.title = t("gantt.targetPart");
    part.append(...numbers(tc, ts));
    bar.append(part);
  }
  if (oc) {
    const part = el("div", "part part-other");
    part.style.flexBasis = tc ? `${Math.round((1 - share) * 100)}%` : "100%";
    part.title = t("gantt.otherPart");
    part.append(...numbers(oc, os));
    bar.append(part);
  }
  return bar;
}

// Вложенная строка (исполнитель или эпик): тонкий голубой отрезок на каждый спринт секции.
function nestedCell(cell, section, model, rowLabel) {
  const td = el("td", "c-cell");
  if (!cell || !cell.count) return td;
  const stack = el("div", "stack");
  for (const s of section.sprints) {
    const part = cell.bySprint.get(s.id);
    if (!part) continue;
    const team = model.teamOf(s);
    const bar = el("div", "bar nested clickable");
    const doneText = applyDone(bar, part.issues);
    bar.title = `${s.name} · ${team.name} · ${doneText}`;
    bar.append(el("span", "bar-sprint", s.name), ...numbers(part.count, part.sum));
    bar.onclick = (e) => showIssues(e.currentTarget, `${rowLabel} · ${s.name}`, part.issues);
    stack.append(bar);
  }
  td.append(stack);
  return td;
}

// Ячейка бэклога вложенной строки: один голубой отрезок без имени спринта.
function backlogNested(cell, model, rowLabel) {
  const td = el("td", "c-cell c-backlog");
  if (!cell || !cell.count) return td;
  const bar = el("div", "bar nested clickable");
  applyDone(bar, cell.issues); // бэклог по определению не готов — заливки не будет
  bar.append(el("span", "bar-sprint", t("gantt.backlog")), ...numbers(cell.count, cell.sum));
  bar.onclick = (e) => showIssues(e.currentTarget, `${rowLabel} · ${t("gantt.backlog")}`, cell.issues);
  td.append(bar);
  return td;
}

// ---------- веха срока исполнения эпика ----------

const DAY_MS = 86400000;
const DUE_SOON_DAYS = 14;

function dayStart(v) {
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(+d)) return null;
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDue(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// Куда ставить веху: индекс колонки, доля по ширине (0..1), край (если срок вне графика), цвет, подписи.
function dueInfo(g, model) {
  if (!g.dueDate) return null;
  const due = dayStart(g.dueDate);
  if (due == null) return null;
  const dated = model.columns.map((sec, index) => ({ sec, index })).filter(({ sec }) => sec.start != null);
  if (!dated.length) return null;

  let colIndex;
  let frac;
  let edge = null;
  const hit = dated.find(({ sec }) => due >= sec.start && due < sec.end);
  if (hit) {
    colIndex = hit.index;
    frac = (due - hit.sec.start) / (hit.sec.end - hit.sec.start);
  } else if (due < dated[0].sec.start) {
    colIndex = dated[0].index;
    frac = 0;
    edge = "left";
  } else {
    colIndex = dated[dated.length - 1].index;
    frac = 1;
    edge = "right";
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((due - today.getTime()) / DAY_MS);
  const done = g.status && g.status.id === "done";
  const cls = done ? "due-green" : days <= DUE_SOON_DAYS ? "due-red" : "due-gray";
  const date = fmtDue(due);
  let title = done
    ? t("gantt.dueDone", { date })
    : days === 0
      ? t("gantt.dueToday", { date })
      : days > 0
        ? t("gantt.dueIn", { date, n: days })
        : t("gantt.dueOverdue", { date, n: -days });
  if (edge === "left") title += ` · ${t("gantt.dueBeforeChart")}`;
  if (edge === "right") title += ` · ${t("gantt.dueAfterChart")}`;
  const p = (n) => String(n).padStart(2, "0");
  const short = `${p(new Date(due).getDate())}.${p(new Date(due).getMonth() + 1)}`;
  const label = edge === "left" ? `◀ ${short}` : edge === "right" ? `${short} ▶` : `◆ ${short}`;
  return { colIndex, frac, edge, cls, title, label };
}

// Линия вехи в ячейке строки; у строки эпика — ещё и флажок с датой.
function addDueLine(row, info, withFlag) {
  const td = row.children[1 + info.colIndex];
  if (!td) return;
  td.classList.add("has-due");
  const x = `${Math.round(info.frac * 100)}%`;
  const line = el("i", `due-line ${info.cls}` + (info.edge ? ` edge-${info.edge}` : ""));
  line.style.setProperty("--x", x);
  td.append(line);
  if (withFlag) {
    const flag = el("span", `due-flag ${info.cls}` + (info.edge ? ` edge-${info.edge}` : ""), info.label);
    flag.style.setProperty("--x", x);
    flag.title = info.title;
    td.append(flag);
  }
}

function emptyCells(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(el("td", "c-cell"));
  return out;
}

// Перерисовка стирает таблицу целиком, страница на миг становится короче и браузер сбрасывает
// прокрутку. Запоминаем её (страницы и самой таблицы) и возвращаем после сборки DOM.
function keepScroll(container) {
  const scroller = document.scrollingElement || document.documentElement;
  const pageY = scroller.scrollTop;
  const wrap = container.querySelector(".gantt-wrap");
  const left = wrap ? wrap.scrollLeft : 0;
  const top = wrap ? wrap.scrollTop : 0;
  return () => {
    const next = container.querySelector(".gantt-wrap");
    if (next) {
      next.scrollLeft = left;
      next.scrollTop = top;
    }
    scroller.scrollTop = pageY;
  };
}

export function render(container, model, opts) {
  const { mode, profiles = [], highlightChild = "", onChildClick = null, personLoad = null } = opts;
  const epicLike = mode !== "assignee";
  // Профили людей (вкладка «Команда») — по нормализованному имени.
  const profileOf = new Map(profiles.map((p) => [p.name, p]));
  const restoreScroll = keepScroll(container);
  container.textContent = "";

  if (!model.groups.length) {
    container.append(el("div", "empty", t("gantt.noData")));
    restoreScroll();
    return;
  }
  if (!model.columns.length) {
    container.append(el("div", "empty", t("gantt.noSprints")));
    restoreScroll();
    return;
  }

  // Панель: свернуть/развернуть + легенда команд.
  const bar = el("div", "gantt-bar");
  const expand = el("button", "link", t("gantt.expandAll"));
  const collapse = el("button", "link", t("gantt.collapseAll"));
  expand.onclick = () => {
    collapsed[mode].clear();
    render(container, model, opts);
  };
  collapse.onclick = () => {
    model.groups.forEach((g) => collapsed[mode].add(g.key));
    render(container, model, opts);
  };
  bar.append(expand, collapse);
  const doneLegend = el("span", "legend legend-done");
  doneLegend.append(el("i", "swatch swatch-done"), el("span", null, t("gantt.legendDone")));
  bar.append(doneLegend);
  if (epicLike) {
    const dueLegend = el("span", "legend legend-done");
    dueLegend.append(el("i", "swatch swatch-due"), el("span", null, t("gantt.legendDue")));
    bar.append(dueLegend);
  }
  if (model.teams.length) {
    // Команд может быть много — список в горизонтальной прокрутке, панель не растёт.
    const legend = el("span", "legend legend-teams");
    legend.append(el("span", "legend-title", t("gantt.teams")));
    const scroll = el("span", "legend-scroll");
    for (const tm of model.teams) {
      const item = el("span", "legend-item" + (tm.derived ? " derived" : ""));
      if (tm.hint) item.title = tm.hint;
      item.append(dot(tm), el("span", null, tm.name));
      scroll.append(item);
    }
    legend.append(scroll);
    bar.append(legend);
  }
  container.append(bar);

  const wrap = el("div", "gantt-wrap");
  const table = el("table", `gantt mode-${mode}`); // на вкладке по людям колонка имён шире

  // Заголовок секции: только имена её спринтов с цветом команды и пометка «текущий».
  // Даты не показываем: период секции — расчётная величина с шагом в календарных днях,
  // с реальными границами спринтов (без выходных) он расходится и только путает.
  const thead = el("thead");
  const hr = el("tr");
  const th0 = el("th", "c-name");
  th0.append(el("span", null, epicLike ? t("gantt.epic") : t("gantt.assignee")));
  const childTitle = { person: t("gantt.assignee"), epic: t("gantt.epic") }[model.childKind] || t("gantt.project");
  th0.append(el("span", "th-hint", ` / ${childTitle}`));
  hr.append(th0);
  for (const sec of model.columns) {
    const th = el("th", "c-sprint" + (sec.id === model.currentId ? " current" : ""));
    if (sec.id === NO_DATES_ID) th.append(el("div", "sp-name", t("gantt.noDates")));
    if (sec.id === model.currentId) th.append(el("div", "sp-name", t("gantt.current")));
    const list = el("div", "sp-list");
    const expanded = expandedHeaders.has(sec.id);
    const shown = expanded ? sec.sprints : sec.sprints.slice(0, HEADER_SPRINTS);
    for (const s of shown) {
      const item = el("div", "sp-item");
      item.title = `${s.name} · ${model.teamOf(s).name}`;
      item.append(dot(model.teamOf(s)), el("span", "sp-item-name", s.name));
      list.append(item);
    }
    th.append(list);
    if (sec.sprints.length > HEADER_SPRINTS) {
      // Длинный список спринтов не должен вытеснять таблицу: остаток — за строкой «ещё N».
      const hidden = sec.sprints.length - HEADER_SPRINTS;
      th.append(el("div", "sp-more", expanded ? t("gantt.headerLess") : t("gantt.headerMore", { n: hidden })));
      th.classList.add("expandable");
      th.title = expanded ? t("gantt.headerLess") : t("gantt.headerMore", { n: hidden });
      th.onclick = () => {
        expanded ? expandedHeaders.delete(sec.id) : expandedHeaders.add(sec.id);
        render(container, model, opts);
      };
    }
    hr.append(th);
  }
  // Справа от спринтов — «Бэклог»: задачи без спринта и не в статусе «Готово» (на всех вкладках;
  // у человека — по его задачам целевых эпиков, «прочие» вне спринтов не загружаются).
  const showBacklog = true;
  if (showBacklog) {
    const th = el("th", "c-sprint backlog");
    th.append(el("div", "sp-name", t("gantt.backlog")));
    th.append(el("div", "sp-date", t("gantt.backlogHint")));
    hr.append(th);
  }
  const extraCols = showBacklog ? 1 : 0;
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  let lastTeamId = null;
  model.groups.forEach((g, index) => {
    // На вкладке по людям перед первым человеком команды — строка-заголовок команды.
    if (mode === "assignee" && g.team && g.team.id !== lastTeamId) {
      lastTeamId = g.team.id;
      const tr = el("tr", "g-row team");
      const td = el("td", "c-name");
      const tname = el("span", "tlabel" + (g.team.derived ? " derived" : ""), g.team.name);
      if (g.team.hint) tname.title = g.team.hint;
      td.append(dot(g.team), tname);
      tr.append(td, ...emptyCells(model.columns.length + extraCols));
      tbody.append(tr);
    }

    const isCollapsed = collapsed[mode].has(g.key);
    const tr = el("tr", "g-row group");
    const name = el("td", "c-name");
    const twisty = el("button", "twisty", isCollapsed ? "▸" : "▾");
    twisty.onclick = () => {
      isCollapsed ? collapsed[mode].delete(g.key) : collapsed[mode].add(g.key);
      render(container, model, opts);
    };
    if (epicLike) name.append(el("span", "gnum", `${index + 1}.`));
    const profile = mode === "assignee" ? profileOf.get(normName(g.label)) || null : null;
    const label = el("button", "glabel" + (profile && profile.status ? ` p-${profile.status}` : ""), g.label);
    label.title = g.label + (profile && profile.status ? ` · ${t(`pstatus.${profile.status}`)}` : "");
    label.onclick = (e) => showTooltip(e.currentTarget, g, mode, model, profile);
    name.append(twisty, label);
    if (g.status && g.status.name) name.append(lozenge(g.status));
    if (epicLike && g.key) name.append(commentButton(g.key, g.label));
    const critical = model.childKind === "person" && g.key && criticalOn.has(g.key) ? criticalPeople(g, model) : null;
    if (model.childKind === "person" && g.key) {
      const cb = criticalButton(g, model, () => render(container, model, opts));
      if (critical) cb.title = critical.size ? [...critical.values()].flat().join("; ") : t("crit.none");
      name.append(cb);
    }
    if (profile && profile.role) {
      const role = el("span", "lozenge lz-role", t(`role.${profile.role}`));
      role.title = t("team.role");
      name.append(role);
    }
    if (mode === "assignee" && g.key) name.append(compareButton(g.label, profile, profiles, personLoad));
    tr.append(name);
    const capacity = mode === "assignee" ? sprintCapacity() : 0;
    for (const sec of model.columns) {
      const td = el("td", "c-cell");
      const cell = g.cells.get(sec.id);
      if (mode === "assignee") {
        const other = g.otherCells.get(sec.id);
        const split = splitBar(cell, other);
        if (split) {
          // Перегрузка спринта: суммарные оценки человека за секцию больше ёмкости спринта.
          const load = (cell ? cell.sum : 0) + (other ? other.sum : 0);
          if (capacity > 0 && load > capacity) {
            split.classList.add("overload");
            split.title = t("gantt.overload", { sum: fmtEstimate(load), cap: fmtEstimate(capacity) });
          }
          td.append(split);
        }
      } else if (cell && cell.count) {
        td.append(groupBar(cell, model.maxCell, `${g.label} · ${sectionTitle(sec)}`));
      }
      tr.append(td);
    }
    if (showBacklog) {
      const td = el("td", "c-cell c-backlog");
      if (g.backlog.count) td.append(groupBar(g.backlog, model.maxCell, `${g.label} · ${t("gantt.backlog")}`));
      tr.append(td);
    }
    // Веха срока исполнения — по строкам эпика (на «По людям» строки — люди, там её нет).
    const due = epicLike ? dueInfo(g, model) : null;
    if (due) addDueLine(tr, due, true);
    tbody.append(tr);

    if (isCollapsed) return;
    for (const p of g.projects) {
      const ptr = el("tr", "g-row proj" + (highlightChild && p.key === highlightChild ? " hl" : "") + (p.target ? " epic-target" : ""));
      const pname = el("td", "c-name");
      let plabel;
      const isPersonChild = model.childKind === "person";
      if (onChildClick) {
        // Клик по вложенной строке раскрывает связанные группы, остальные сворачивает.
        // У человека дополнительно статус из профиля «Команды»: уволенный — серым, аутстаф — жёлтым.
        const prof = isPersonChild ? profileOf.get(normName(p.label)) : null;
        plabel = el("button", "plabel plabel-link" + (prof && prof.status ? ` p-${prof.status}` : ""), p.label);
        plabel.title = isPersonChild
          ? t("gantt.personClick", { name: p.label }) + (prof && prof.status ? ` · ${t(`pstatus.${prof.status}`)}` : "")
          : t("gantt.epicClick", { name: p.label }) + (p.target ? ` · ${t("gantt.targetEpic")}` : "");
        plabel.onclick = () => onChildClick(p.key, p.label);
      } else {
        plabel = el("span", "plabel", p.label);
        plabel.title = p.label + (p.target ? ` · ${t("gantt.targetEpic")}` : "");
      }
      pname.append(el("span", "indent"), plabel);
      if (isPersonChild && p.key) pname.append(compareButton(p.label, profileOf.get(normName(p.label)) || null, profiles, personLoad));
      ptr.append(pname);
      for (const sec of model.columns) ptr.append(nestedCell(p.cells.get(sec.id), sec, model, `${g.label} · ${p.label}`));
      if (showBacklog) ptr.append(backlogNested(p.backlog, model, `${g.label} · ${p.label}`));
      if (due) addDueLine(ptr, due, false);
      // Критический путь: полосы критичного человека — с оранжевой обводкой, у имени — ⚡ с причиной.
      if (critical && critical.has(p.key)) {
        ptr.classList.add("crit-row");
        ptr.querySelectorAll(".bar").forEach((b) => b.classList.add("crit"));
        const mark = el("span", "crit-mark", "⚡");
        mark.title = critical.get(p.key).join("; ");
        plabel.after(mark);
      }
      tbody.append(ptr);
    }
  });
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);
  restoreScroll();
}

// Статус эпика — лейбл в стиле Jira: цвет берётся из таблицы статусов.
function lozenge(status) {
  const node = el("span", `lozenge lz-s-${status.id || "other"}`, status.name);
  node.title = status.name;
  return node;
}

// ---------- комментарии эпика (в Jira) ----------

function commentButton(key, label) {
  const btn = el("button", "cmt-btn", "💬");
  btn.type = "button";
  btn.title = t("cmt.button");
  btn.onclick = (e) => {
    e.stopPropagation();
    showComments(e.currentTarget, key, label);
  };
  return btn;
}

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function showComments(anchor, key, label) {
  closeTooltip();
  tip = el("div", "tooltip tip-comments");
  const head = el("div", "tip-head");
  const strong = el("strong");
  strong.append(maybeLink(t("cmt.title", { key }), browseUrl(key), "tip-link"));
  strong.append(el("div", "tip-sub-title", label));
  head.append(strong);
  const close = el("button", "tip-close", "×");
  close.title = t("tip.close");
  close.onclick = closeTooltip;
  head.append(close);
  tip.append(head);

  // Ввод нового комментария.
  const form = el("div", "cmt-form");
  const ta = el("textarea", "cmt-input");
  ta.placeholder = t("cmt.placeholder");
  ta.rows = 3;
  const save = el("button", "primary cmt-save", t("cmt.save"));
  save.type = "button";
  save.disabled = true;
  const note = el("span", "muted small cmt-note", t("cmt.mentionHint"));
  ta.oninput = () => {
    save.disabled = !ta.value.trim();
    mentionsOnInput();
  };
  form.append(ta, save, note);
  tip.append(form);

  // Упоминания через @: список пользователей Jira под полем, вставка разметки [~логин].
  const menu = el("div", "mention-list");
  menu.hidden = true;
  form.append(menu);
  let mentionItems = [];
  let mentionIdx = 0;
  let mentionTimer = null;
  let mentionSeq = 0;
  const mentionQuery = () => {
    const before = ta.value.slice(0, ta.selectionStart);
    const m = before.match(/(^|\s)@([^\s@]*)$/);
    return m ? { query: m[2], start: before.length - m[2].length - 1 } : null;
  };
  const closeMentions = () => {
    menu.hidden = true;
    menu.textContent = "";
    mentionItems = [];
  };
  const renderMentions = () => {
    menu.textContent = "";
    if (!mentionItems.length) {
      menu.append(el("div", "mention-empty muted", t("cmt.mentionNone")));
      return;
    }
    mentionItems.forEach((u, i) => {
      const item = el("div", "mention-item" + (i === mentionIdx ? " active" : ""));
      item.append(el("span", "mention-name", u.displayName), el("span", "mention-login muted", `@${u.name}`));
      item.onmousedown = (e) => {
        e.preventDefault(); // не терять фокус textarea
        pickMention(u);
      };
      menu.append(item);
    });
  };
  const pickMention = (u) => {
    const q = mentionQuery();
    if (!q) return;
    const after = ta.value.slice(ta.selectionStart);
    const inserted = `[~${u.name}] `;
    ta.value = ta.value.slice(0, q.start) + inserted + after;
    const pos = q.start + inserted.length;
    ta.setSelectionRange(pos, pos);
    save.disabled = !ta.value.trim();
    closeMentions();
    ta.focus();
  };
  function mentionsOnInput() {
    const q = mentionQuery();
    clearTimeout(mentionTimer);
    if (!q) return closeMentions();
    menu.hidden = false;
    menu.textContent = "";
    menu.append(el("div", "mention-empty muted", t("cmt.mentionSearching")));
    const seq = ++mentionSeq;
    mentionTimer = setTimeout(async () => {
      try {
        const users = await commentsApi.users(q.query);
        if (seq !== mentionSeq) return; // уже набрали дальше
        mentionItems = users.slice(0, 10);
        mentionIdx = 0;
        renderMentions();
      } catch (e) {
        if (seq !== mentionSeq) return;
        menu.textContent = "";
        menu.append(el("div", "cmt-error", t("cmt.error", { msg: e && e.message ? e.message : e })));
      }
    }, 250);
  }
  ta.onkeydown = (e) => {
    if (menu.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!mentionItems.length) return;
      mentionIdx = (mentionIdx + (e.key === "ArrowDown" ? 1 : mentionItems.length - 1)) % mentionItems.length;
      renderMentions();
    } else if ((e.key === "Enter" || e.key === "Tab") && mentionItems.length) {
      e.preventDefault();
      pickMention(mentionItems[mentionIdx]);
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeMentions();
    }
  };

  // Последние комментарии — в прокручиваемой зоне.
  const listTitle = el("div", "tip-sub", t("cmt.recent", { n: RECENT_COMMENTS }));
  const list = el("div", "cmt-list");
  tip.append(listTitle, list);

  const renderList = (all) => {
    list.textContent = "";
    const recent = [...all]
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, RECENT_COMMENTS);
    if (!recent.length) {
      list.append(el("div", "muted", t("cmt.empty")));
      return;
    }
    for (const c of recent) {
      const item = el("div", "cmt-item");
      const meta = el("div", "cmt-meta");
      meta.append(el("span", "cmt-author", c.author?.displayName || c.author?.name || t("dash")), el("span", "muted", fmtDateTime(c.created)));
      item.append(meta, el("div", "cmt-body", String(c.body || "").replace(/\[~([^\]]+)\]/g, "@$1")));
      list.append(item);
    }
  };
  const load = async () => {
    list.textContent = "";
    list.append(el("div", "muted", t("cmt.loading")));
    try {
      renderList(await commentsApi.list(key));
    } catch (e) {
      list.textContent = "";
      list.append(el("div", "cmt-error", t("cmt.error", { msg: e && e.message ? e.message : e })));
    }
    placePopover(tip, anchor); // список подгрузился — окно выросло
  };
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    save.disabled = true;
    note.textContent = t("cmt.saving");
    try {
      await commentsApi.add(key, text);
      ta.value = "";
      note.textContent = t("cmt.saved");
      await load();
    } catch (e) {
      note.textContent = t("cmt.error", { msg: e && e.message ? e.message : e });
      save.disabled = false;
    }
  };
  load();

  document.body.append(tip);
  placePopover(tip, anchor);
  ta.focus();
}

// ---------- сравнение с коллегами: кто может подменить ----------

function compareButton(name, profile, profiles, personLoad) {
  const btn = el("button", "cmp-btn", "⇄");
  btn.type = "button";
  btn.title = t("cmp.button");
  btn.onclick = (e) => {
    e.stopPropagation();
    showCompare(e.currentTarget, name, profile, profiles, personLoad);
  };
  return btn;
}

// Занятость человека по ближайшим спринтам: процент от ёмкости спринта (длительность × часы в дне).
function loadCells(displayName, personLoad) {
  const box = el("span", "load-cells");
  const row = personLoad.byName.get(normName(displayName)) || new Map();
  for (const sec of personLoad.sections) {
    const sum = row.get(sec.id) || 0;
    const pct = personLoad.capacity > 0 ? Math.round((sum / personLoad.capacity) * 100) : null;
    const chip = el("span", "load-chip" + (pct != null && pct > 100 ? " over" : ""), pct != null ? `${pct}%` : fmtEstimate(sum));
    chip.title = `${sec.title} · ${
      pct != null
        ? t("cmp.loadHint", { caption: sec.caption, sum: fmtEstimate(sum), cap: fmtEstimate(personLoad.capacity), pct })
        : t("cmp.loadNoCap", { caption: sec.caption, sum: fmtEstimate(sum) })
    }`;
    box.append(chip);
  }
  return box;
}

// Кандидаты: та же роль, хотя бы одна общая система, не уволен, не сам; по числу общих систем.
export function standIns(profile, profiles) {
  if (!profile || !profile.role || !(profile.systems || []).length) return { candidates: [], uncovered: [] };
  const mine = new Set(profile.systems);
  const candidates = profiles
    .filter((p) => p.name !== profile.name && p.role === profile.role && p.status !== "fired")
    .map((p) => ({ profile: p, common: (p.systems || []).filter((x) => mine.has(x)) }))
    .filter((c) => c.common.length)
    .sort((a, b) => b.common.length - a.common.length || a.profile.displayName.localeCompare(b.profile.displayName));
  const covered = new Set(candidates.flatMap((c) => c.common));
  return { candidates, uncovered: profile.systems.filter((x) => !covered.has(x)) };
}

function showCompare(anchor, name, profile, profiles, personLoad = null) {
  closeTooltip();
  tip = el("div", "tooltip tip-compare");
  const head = el("div", "tip-head");
  const strong = el("strong", null, t("cmp.title", { name }));
  head.append(strong);
  const close = el("button", "tip-close", "×");
  close.title = t("tip.close");
  close.onclick = closeTooltip;
  head.append(close);
  tip.append(head);

  if (!profile || !profile.role || !(profile.systems || []).length) {
    tip.append(el("div", "muted", t("cmp.noProfile")));
  } else {
    const me = el("div", "tip-profile");
    me.append(el("span", "lozenge lz-role", t(`role.${profile.role}`)));
    for (const sName of profile.systems) me.append(el("span", "chip on static", sName));
    tip.append(me);

    const { candidates, uncovered } = standIns(profile, profiles);
    const showLoad = personLoad && personLoad.sections.length;
    tip.append(
      el(
        "div",
        "tip-sub",
        showLoad
          ? `${t("cmp.candidates")} · ${t("cmp.load")}: ${personLoad.sections.map((s) => s.caption).join(" · ")}`
          : t("cmp.candidates")
      )
    );
    if (!candidates.length) {
      tip.append(el("div", "muted", t("cmp.none")));
    } else {
      const tbl = el("table", "tip-table cmp-table");
      for (const c of candidates) {
        const tr = el("tr");
        const who = el("td", "tp-name");
        who.append(el("div", "cmp-name" + (c.profile.status ? ` p-${c.profile.status}` : ""), c.profile.displayName));
        if (c.profile.status === "outstaff") who.append(el("div", "small muted", t("pstatus.outstaff")));
        if (showLoad) {
          const loadCell = el("td", "cmp-load");
          loadCell.append(loadCells(c.profile.displayName, personLoad));
          tr.append(who, loadCell);
        }
        const sys = el("td", "cmp-systems");
        const common = new Set(c.common);
        // Сначала общие (подсвечены), потом остальные системы кандидата серым.
        for (const sName of [...c.common, ...(c.profile.systems || []).filter((x) => !common.has(x))]) {
          sys.append(el("span", "chip static" + (common.has(sName) ? " on" : ""), sName));
        }
        if (!showLoad) tr.append(who);
        tr.append(sys, el("td", "tp-num", t("cmp.common", { n: c.common.length })));
        tbl.append(tr);
      }
      tip.append(tbl);
    }

    const unc = el("div", "cmp-uncovered");
    unc.append(el("span", "tip-k", `${t("cmp.uncovered")}: `));
    if (uncovered.length) for (const sName of uncovered) unc.append(el("span", "chip static uncovered", sName));
    else unc.append(el("span", "muted", t("cmp.allCovered")));
    tip.append(unc);
  }
  tip.append(el("div", "small muted cmp-criteria", t("cmp.criteria")));

  document.body.append(tip);
  placePopover(tip, anchor);
}

// ---------- ссылки в Jira ----------

function jiraBase() {
  return (settings.get().baseUrl || "").trim().replace(/\/+$/, "");
}

function browseUrl(key) {
  const base = jiraBase();
  return base && key ? `${base}/browse/${encodeURIComponent(key)}` : "";
}

function issuesUrl(jql) {
  const base = jiraBase();
  return base && jql ? `${base}/issues/?jql=${encodeURIComponent(jql)}` : "";
}

// JQL всех задач группы: эпика или исполнителя.
function scopeJql(g, mode) {
  const f = settings.get().fields;
  if (mode !== "assignee") {
    if (!g.key) return "";
    const field = f.epicLink ? `cf[${cfId(f.epicLink)}]` : '"Epic Link"';
    return `${field} = ${g.key}`;
  }
  if (!g.key) return "assignee is EMPTY";
  return `assignee = "${g.login || g.key}"`;
}

function sprintEmptyJql() {
  const f = settings.get().fields;
  return f.sprint ? `cf[${cfId(f.sprint)}] is EMPTY` : "Sprint is EMPTY";
}

// Текст превращаем в ссылку, только если адрес Jira задан; иначе оставляем как есть.
function maybeLink(text, url, cls) {
  if (!url) return el("span", cls, text);
  const a = el("a", cls, text);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// ---------- подсказка по эпику / исполнителю ----------

let tip = null;

function closeTooltip() {
  if (tip) {
    tip.remove();
    tip = null;
  }
}
document.addEventListener("keydown", (e) => e.key === "Escape" && closeTooltip());
document.addEventListener("click", (e) => {
  if (tip && !tip.contains(e.target) && !e.target.closest(".glabel") && !e.target.closest(".bar.clickable") && !e.target.closest(".cmp-btn") && !e.target.closest(".cmt-btn")) closeTooltip();
});

// Список задач ячейки: ключ со ссылкой в Jira, название, статус, оценка.
function showIssues(anchor, title, issues) {
  closeTooltip();
  tip = el("div", "tooltip tip-issues");
  const head = el("div", "tip-head");
  const strong = el("strong", null, title);
  strong.append(el("div", "tip-sub-title", t("tip.issuesCount", { n: issues.length })));
  head.append(strong);
  const close = el("button", "tip-close", "×");
  close.title = t("tip.close");
  close.onclick = closeTooltip;
  head.append(close);
  tip.append(head);

  const tbl = el("table", "tip-table issues-table");
  const sorted = [...issues].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  for (const it of sorted) {
    const tr = el("tr", it.done ? "issue-done" : "");
    const keyCell = el("td", "ti-key");
    keyCell.append(maybeLink(it.key, browseUrl(it.key), "tip-link"));
    const sumCell = el("td", "ti-summary");
    const summaryLink = maybeLink(it.summary || t("dash"), browseUrl(it.key), "ti-summary-link");
    summaryLink.title = it.summary;
    sumCell.append(summaryLink);
    if (it.statusName) sumCell.append(el("div", "ti-status", it.statusName + (it.assigneeName ? ` · ${it.assigneeName}` : "")));
    tr.append(keyCell, sumCell, el("td", "tp-num", fmtEstimate(it.estimate)));
    tbl.append(tr);
  }
  tip.append(tbl);

  document.body.append(tip);
  placePopover(tip, anchor);
}

function showTooltip(anchor, g, mode, model, profile = null) {
  const epicLike = mode !== "assignee";
  closeTooltip();
  tip = el("div", "tooltip");
  const scope = scopeJql(g, mode);
  const headUrl = epicLike ? browseUrl(g.key) : issuesUrl(scope);

  const head = el("div", "tip-head");
  const title = el("strong");
  title.append(maybeLink(g.label, headUrl, "tip-link"));
  head.append(title);
  if (g.team) {
    const teamLine = el("div", "tip-team");
    teamLine.append(dot(g.team), el("span", null, `${t("gantt.team")}: ${g.team.name}`));
    title.append(teamLine);
  }
  // Свойства из профиля «Команды»: роль, статус и информационные системы.
  if (mode === "assignee") {
    const meta = el("div", "tip-profile");
    if (profile && profile.role) meta.append(el("span", "lozenge lz-role", t(`role.${profile.role}`)));
    if (profile && profile.status) meta.append(el("span", `tip-pstatus p-${profile.status}`, t(`pstatus.${profile.status}`)));
    const sys = el("div", "tip-systems");
    sys.append(el("span", "tip-k", `${t("tip.systems")}: `));
    const list = profile && profile.systems && profile.systems.length ? profile.systems : null;
    if (list) for (const name of list) sys.append(el("span", "chip on static", name));
    else sys.append(el("span", "muted", t("tip.noSystems")));
    meta.append(sys);
    title.append(meta);
  }
  const close = el("button", "tip-close", "×");
  close.title = t("tip.close");
  close.onclick = closeTooltip;
  head.append(close);
  tip.append(head);

  const rows = el("div", "tip-rows");
  // Каждое число — ссылка на соответствующую выборку задач в Jira.
  const line = (k, v, jql) => {
    const r = el("div", "tip-row");
    const value = maybeLink(v, jql ? issuesUrl(jql) : "", "tip-v tip-link");
    if (!jql) value.className = "tip-v";
    r.append(el("span", "tip-k", k), value);
    return r;
  };
  const within = (extra) => (scope && extra ? `${scope} AND ${extra}` : "");
  // Перечисляем реальные статусы задач, а не категорию: «On Prod» у нас готов, а в Jira он жёлтый.
  const inStatuses = (set) =>
    set.size ? `status in (${[...set].map((x) => `"${escapeJql(x)}"`).join(", ")})` : "";
  const doneJql = within(inStatuses(g.doneStatuses));
  const openJql = within(inStatuses(g.openStatuses));

  rows.append(line(t("tip.total"), String(g.count), scope));
  rows.append(line(t("tip.done"), String(g.done), doneJql));
  rows.append(line(t("tip.other"), String(g.other), openJql));
  rows.append(
    line(
      t("tip.noSprint"),
      String(g.noSprint),
      g.openStatuses.size ? within(`${sprintEmptyJql()} AND ${inStatuses(g.openStatuses)}`) : ""
    )
  );
  rows.append(line(t("tip.sum"), fmtEstimate(g.sum)));
  if (mode === "assignee" && g.otherCount) {
    const f = settings.get().fields;
    const cf = f.epicLink ? `cf[${cfId(f.epicLink)}]` : '"Epic Link"';
    const keys = model && model.targetKeys ? model.targetKeys : [];
    const notTarget = keys.length ? ` AND (${cf} not in (${keys.join(",")}) OR ${cf} is EMPTY)` : "";
    const othersJql = scope ? `${scope} AND (sprint in openSprints() OR sprint in futureSprints())${notTarget}` : "";
    rows.append(line(t("tip.others"), `${g.otherCount} · ${fmtEstimate(g.otherSum)}`, othersJql));
  }
  tip.append(rows);

  // Вложенные строки — проекты (по людям) или исполнители (по эпикам); ссылки по соответствующему полю.
  const byPerson = model && model.childKind === "person";
  tip.append(el("div", "tip-sub", byPerson ? t("tip.byAssignee") : t("tip.byProject")));
  const tbl = el("table", "tip-table");
  for (const p of g.projects) {
    const tr = el("tr");
    const nameCell = el("td", "tp-name");
    const childJql = byPerson ? (p.key ? `assignee = "${escapeJql(p.key)}"` : "assignee is EMPTY") : `project = "${p.key}"`;
    nameCell.append(maybeLink(p.label, scope ? issuesUrl(`${scope} AND ${childJql}`) : "", "tip-link"));
    tr.append(nameCell, el("td", "tp-num", String(p.count)), el("td", "tp-num", fmtEstimate(p.sum)));
    tbl.append(tr);
  }
  tip.append(tbl);

  if (mode === "assignee" && g.otherEpics && g.otherEpics.length) {
    tip.append(el("div", "tip-sub", t("tip.otherEpics")));
    const otbl = el("table", "tip-table");
    for (const oe of g.otherEpics) {
      const tr = el("tr");
      const nameCell = el("td", "tp-name");
      const label = oe.key ? `${oe.key} · ${oe.summary}`.trim() : t("dash");
      nameCell.append(maybeLink(label, oe.key ? browseUrl(oe.key) : "", "tip-link"));
      tr.append(nameCell, el("td", "tp-num", String(oe.count)), el("td", "tp-num", fmtEstimate(oe.sum)));
      otbl.append(tr);
    }
    tip.append(otbl);
  }

  document.body.append(tip);
  placePopover(tip, anchor);
}

export function resetCollapse() {
  for (const set of Object.values(collapsed)) set.clear();
}
