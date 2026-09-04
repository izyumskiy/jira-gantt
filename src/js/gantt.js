// Отрисовка диаграммы Ганта: слева дерево (эпик/исполнитель → проекты [+ «Прочие»]), справа полосы
// по временным секциям. Группы: у эпика одна жёлтая полоса-итог; у человека полоса делится на
// жёлтую (целевые эпики) и серую (прочие эпики) части пропорционально объёму. Вложенные строки
// рисуются тонкими голубыми отрезками — по одному на каждый спринт секции.
import { t } from "./i18n.js";
import { fmtEstimate, NO_DATES_ID, BACKLOG_ID } from "./agg.js";
import * as settings from "./settings.js";
import { cfId, escapeJql } from "./jira.js";
import { normName } from "./team.js";

const collapsed = { epic: new Set(), epicPeople: new Set(), assignee: new Set() };

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
  d.title = team ? team.name : "";
  return d;
}

// Бейджи строки: всего задач, [осталось — у эпиков], [прочие эпики — у людей], оценка.
function badges(count, sum, { left = null, other = null } = {}) {
  const wrap = el("span", "badges");
  wrap.append(el("span", "badge b-count", String(count)));
  if (left != null) {
    const b = el("span", "badge b-left", String(left));
    b.title = t("gantt.left");
    wrap.append(b);
  }
  wrap.append(el("span", "badge b-sum", fmtEstimate(sum)));
  if (other && other.count) {
    const b = el("span", "badge b-other", `+${other.count} · ${fmtEstimate(other.sum)}`);
    b.title = t("gantt.othersHint");
    wrap.append(b);
  }
  return wrap;
}

function fillOf(value, maxCell) {
  const weight = maxCell ? Math.max(0.12, value / maxCell) : 1;
  return `${Math.round(weight * 100)}%`;
}

function numbers(count, sum) {
  return [el("span", "bar-count", String(count)), el("span", "bar-sum", fmtEstimate(sum))];
}

// Жёлтая полоса-итог эпика; по клику — список задач ячейки.
function groupBar(cell, maxCell, title) {
  const bar = el("div", "bar bar-group clickable");
  bar.style.setProperty("--fill", fillOf(cell.sum || cell.count, maxCell));
  bar.append(...numbers(cell.count, cell.sum));
  bar.title = t("gantt.clickIssues");
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

// Вложенная строка (проект, «Прочие»): тонкий голубой отрезок на каждый спринт секции.
function nestedCell(cell, section, model, rowLabel) {
  const td = el("td", "c-cell");
  if (!cell || !cell.count) return td;
  const stack = el("div", "stack");
  for (const s of section.sprints) {
    const part = cell.bySprint.get(s.id);
    if (!part) continue;
    const team = model.teamOf(s);
    const bar = el("div", "bar nested clickable");
    bar.style.setProperty("--fill", fillOf(part.sum || part.count, model.maxCell));
    bar.title = `${s.name} · ${team.name}`;
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
  bar.style.setProperty("--fill", fillOf(cell.sum || cell.count, model.maxCell));
  bar.append(el("span", "bar-sprint", t("gantt.backlog")), ...numbers(cell.count, cell.sum));
  bar.onclick = (e) => showIssues(e.currentTarget, `${rowLabel} · ${t("gantt.backlog")}`, cell.issues);
  td.append(bar);
  return td;
}

function emptyCells(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(el("td", "c-cell"));
  return out;
}

export function render(container, model, opts) {
  const { mode, profiles = [], highlightChild = "", onChildClick = null } = opts;
  const epicLike = mode !== "assignee";
  // Профили людей (вкладка «Команда») — по нормализованному имени.
  const profileOf = new Map(profiles.map((p) => [p.name, p]));
  container.textContent = "";

  if (!model.groups.length) {
    container.append(el("div", "empty", t("gantt.noData")));
    return;
  }
  if (!model.columns.length) {
    container.append(el("div", "empty", t("gantt.noSprints")));
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
  if (model.teams.length) {
    const legend = el("span", "legend");
    legend.append(el("span", "legend-title", t("gantt.teams")));
    for (const tm of model.teams) {
      const item = el("span", "legend-item");
      item.append(dot(tm), el("span", null, tm.name));
      legend.append(item);
    }
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
  th0.append(el("span", "th-hint", ` / ${model.childKind === "person" ? t("gantt.assignee") : t("gantt.project")}`));
  hr.append(th0);
  for (const sec of model.columns) {
    const th = el("th", "c-sprint" + (sec.id === model.currentId ? " current" : ""));
    if (sec.id === NO_DATES_ID) th.append(el("div", "sp-name", t("gantt.noDates")));
    if (sec.id === model.currentId) th.append(el("div", "sp-name", t("gantt.current")));
    const list = el("div", "sp-list");
    for (const s of sec.sprints) {
      const item = el("div", "sp-item");
      item.title = `${s.name} · ${model.teamOf(s).name}`;
      item.append(dot(model.teamOf(s)), el("span", "sp-item-name", s.name));
      list.append(item);
    }
    th.append(list);
    hr.append(th);
  }
  // Справа от спринтов — «Бэклог»: задачи без спринта и не в статусе «Готово».
  const showBacklog = epicLike;
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
      const members = model.groups.filter((x) => x.team && x.team.id === g.team.id);
      const tr = el("tr", "g-row team");
      const td = el("td", "c-name");
      td.append(dot(g.team), el("span", "tlabel", g.team.name));
      td.append(
        badges(
          members.reduce((n, x) => n + x.count, 0),
          members.reduce((n, x) => n + x.sum, 0)
        )
      );
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
    if (profile && profile.role) {
      const role = el("span", "lozenge lz-role", t(`role.${profile.role}`));
      role.title = t("team.role");
      name.append(role);
    }
    // На «По эпикам и людям» цифры не показываем — только дерево и полосы (итоги есть в подсказке).
    const showBadges = mode !== "epicPeople";
    if (showBadges) {
      name.append(
        badges(g.count, g.sum, {
          left: epicLike ? g.other : null,
          other: mode === "assignee" ? { count: g.otherCount, sum: g.otherSum } : null
        })
      );
    }
    tr.append(name);
    for (const sec of model.columns) {
      const td = el("td", "c-cell");
      const cell = g.cells.get(sec.id);
      if (mode === "assignee") {
        const split = splitBar(cell, g.otherCells.get(sec.id));
        if (split) td.append(split);
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
    tbody.append(tr);

    if (isCollapsed) return;
    for (const p of g.projects) {
      const ptr = el("tr", "g-row proj" + (highlightChild && p.key === highlightChild ? " hl" : ""));
      const pname = el("td", "c-name");
      let plabel;
      if (model.childKind === "person" && onChildClick) {
        // Имя человека — кнопка: раскрывает его эпики, остальные сворачивает.
        plabel = el("button", "plabel plabel-link", p.label);
        plabel.title = t("gantt.personClick", { name: p.label });
        plabel.onclick = () => onChildClick(p.key, p.label);
      } else {
        plabel = el("span", "plabel", p.label);
      }
      pname.append(el("span", "indent"), plabel);
      if (showBadges) pname.append(badges(p.count, p.sum));
      ptr.append(pname);
      for (const sec of model.columns) ptr.append(nestedCell(p.cells.get(sec.id), sec, model, `${g.label} · ${p.label}`));
      if (showBacklog) ptr.append(backlogNested(p.backlog, model, `${g.label} · ${p.label}`));
      tbody.append(ptr);
    }
    // «Прочие» — задачи человека в эпиках вне выбранных.
    if (mode === "assignee" && g.otherCount) {
      const otr = el("tr", "g-row proj others");
      const oname = el("td", "c-name");
      const olabel = el("span", "plabel plabel-others", t("gantt.others"));
      olabel.title = t("gantt.othersHint");
      oname.append(el("span", "indent"), olabel, badges(g.otherCount, g.otherSum));
      otr.append(oname);
      for (const sec of model.columns) otr.append(nestedCell(g.otherCells.get(sec.id), sec, model, `${g.label} · ${t("gantt.others")}`));
      tbody.append(otr);
    }
  });
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);
}

// Статус эпика — лейбл в стиле Jira: цвет берётся из таблицы статусов.
function lozenge(status) {
  const node = el("span", `lozenge lz-s-${status.id || "other"}`, status.name);
  node.title = status.name;
  return node;
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
  if (tip && !tip.contains(e.target) && !e.target.closest(".glabel") && !e.target.closest(".bar.clickable")) closeTooltip();
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
  const r = anchor.getBoundingClientRect();
  const top = Math.min(window.innerHeight - tip.offsetHeight - 12, r.bottom + 6);
  tip.style.top = `${Math.max(8, top)}px`;
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 12, r.left))}px`;
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

  tip.append(el("div", "tip-sub", t("tip.byProject")));
  const tbl = el("table", "tip-table");
  for (const p of g.projects) {
    const tr = el("tr");
    const nameCell = el("td", "tp-name");
    nameCell.append(maybeLink(p.label, scope ? issuesUrl(`${scope} AND project = "${p.key}"`) : "", "tip-link"));
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
  const r = anchor.getBoundingClientRect();
  const top = Math.min(window.innerHeight - tip.offsetHeight - 12, r.bottom + 6);
  tip.style.top = `${Math.max(8, top)}px`;
  tip.style.left = `${Math.max(8, Math.min(window.innerWidth - tip.offsetWidth - 12, r.left))}px`;
}

export function resetCollapse() {
  for (const set of Object.values(collapsed)) set.clear();
}
