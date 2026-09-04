// Сборка приложения: вкладки, поиск эпиков, синхронизация, отрисовка диаграмм, настройки.
import { t, setLang, applyI18n, getLang } from "./i18n.js";
import * as settings from "./settings.js";
import * as db from "./db.js";
import * as jira from "./jira.js";
import * as sync from "./sync.js";
import * as agg from "./agg.js";
import * as gantt from "./gantt.js";
import * as team from "./team.js";
import { classify, isDoneStatus } from "./status.js";

const $ = (sel) => document.querySelector(sel);
const state = { results: [], selected: new Set(), boards: [], filter: { label: "", assignee: "" } };

// ---------- статус-строка ----------

let statusTimer = null;
function status(msg, kind = "info") {
  const box = $("#status");
  box.textContent = msg;
  box.className = `status ${kind}`;
  clearTimeout(statusTimer);
  if (kind !== "error") statusTimer = setTimeout(() => box.classList.add("hidden"), 4000);
}
function hideStatus() {
  $("#status").classList.add("hidden");
}
function fail(e) {
  console.error(e);
  status(e && e.message ? e.message : String(e), "error");
}

// ---------- вкладки ----------

function showTab(name) {
  applyTopHeight(); // содержимое верхней панели меняется — её высота тоже
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  $(`#page-${name}`).classList.remove("hidden");
  if (name === "epics") drawGantt("epic", $("#page-epics"));
  if (name === "people") drawGantt("assignee", $("#page-people"));
  if (name === "team") team.render($("#page-team"), { notify: (m) => status(m) }).catch(fail);
}

// ---------- поиск эпиков ----------

// Дата Jira («2026-09-03» или ISO с временем) → «03.09.26»; пусто → прочерк.
function fmtDay(v) {
  if (!v) return t("dash");
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(+d)) return t("dash");
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
}

const DATE_COLS = [
  ["search.created", "search.createdFull", (e) => e.created],
  ["search.plannedStart", "search.plannedStartFull", (e) => e.plannedStart],
  ["search.plannedEnd", "search.plannedEndFull", (e) => e.plannedEnd],
  ["search.due", "search.dueFull", (e) => e.dueDate]
];

const DAY_MS = 86400000;
const DUE_SOON_DAYS = 14;

// Полночь локального дня для даты Jira («2026-09-03» или ISO с временем).
function dayStart(v) {
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(+d)) return null;
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Сколько дней до срока: 0 — сегодня, отрицательное — просрочен; null — срока нет.
export function daysUntil(dateStr, now = Date.now()) {
  if (!dateStr) return null;
  const due = dayStart(dateStr);
  if (due == null) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((due - today.getTime()) / DAY_MS);
}

// Срок «горит»: наступает в ближайшие 14 дней или уже прошёл, а эпик ещё не готов.
export function isDueSoon(epic, now = Date.now()) {
  if (isDoneStatus(epic.statusName, epic.statusCategory)) return false;
  const n = daysUntil(epic.dueDate, now);
  return n != null && n <= DUE_SOON_DAYS;
}

function dueHint(n) {
  if (n === 0) return t("search.dueToday");
  return n > 0 ? t("search.dueSoon", { n }) : t("search.overdue", { n: -n });
}

// Четыре даты эпика: создан, плановое начало, плановое завершение, срок исполнения. Подписи — в шапке списка.
function epicDates(epic) {
  const box = document.createElement("span");
  box.className = "idates";
  for (const [key, full, get] of DATE_COLS) {
    const value = get(epic);
    const item = document.createElement("span");
    item.className = "idate" + (value ? "" : " idate-empty"); // не «empty»: это глобальная плашка «Нет данных»
    item.title = `${t(full)}: ${fmtDay(value)}`;
    item.textContent = fmtDay(value);
    if (key === "search.due" && isDueSoon(epic)) {
      item.classList.add("idate-due");
      item.title += ` · ${dueHint(daysUntil(epic.dueDate))}`;
    }
    box.append(item);
  }
  return box;
}

// Исполнитель или постановщик эпика — отдельная ячейка строки. Исполнитель кликабелен: фильтр по имени.
function epicPerson(label, value, clickable) {
  const cell = document.createElement("span");
  cell.className = "iperson" + (value ? "" : " iperson-empty");
  cell.title = `${t(label)}: ${value || t("dash")}`;
  cell.textContent = value || t("dash");
  if (clickable && value) {
    cell.classList.add("iperson-link");
    if (state.filter.assignee === value) cell.classList.add("on");
    cell.title = t("search.filterByAssignee", { v: value });
    cell.onclick = (e) => {
      e.preventDefault(); // строка — <label>, иначе клик переключит галку
      setFilter({ assignee: state.filter.assignee === value ? "" : value });
    };
  }
  return cell;
}

const LABELS_INLINE = 3;

function labelChip(label) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "lchip" + (state.filter.label === label ? " on" : "");
  chip.textContent = label;
  chip.title = t("search.filterByLabel", { v: label });
  chip.onclick = (e) => {
    e.preventDefault();
    closeLabelPopover();
    setFilter({ label: state.filter.label === label ? "" : label });
  };
  return chip;
}

// Метки эпика в одну строку: первые три чипом, остальные — за чипом «ещё N» (всплывашка с ними).
function epicLabels(epic) {
  const box = document.createElement("span");
  box.className = "ilabels";
  const labels = [...(epic.labels || [])];
  // Активная метка всегда видна, даже если по алфавиту она дальше третьей.
  if (state.filter.label && labels.includes(state.filter.label)) {
    labels.splice(labels.indexOf(state.filter.label), 1);
    labels.unshift(state.filter.label);
  }
  if (!labels.length) {
    const dash = document.createElement("span");
    dash.className = "iperson-empty";
    dash.textContent = t("dash");
    box.append(dash);
    return box;
  }
  labels.slice(0, LABELS_INLINE).forEach((l) => box.append(labelChip(l)));
  const rest = labels.slice(LABELS_INLINE);
  if (rest.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "lchip lmore";
    more.textContent = `+${rest.length}`;
    more.title = rest.join(", ");
    more.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLabelPopover(more, rest);
    };
    box.append(more);
  }
  return box;
}

let labelPopover = null;
function closeLabelPopover() {
  if (labelPopover) {
    labelPopover.remove();
    labelPopover = null;
  }
}
document.addEventListener("click", (e) => {
  if (labelPopover && !labelPopover.contains(e.target)) closeLabelPopover();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeLabelPopover());

function openLabelPopover(anchor, labels) {
  closeLabelPopover();
  labelPopover = document.createElement("div");
  labelPopover.className = "lpop";
  labels.forEach((l) => labelPopover.append(labelChip(l)));
  document.body.append(labelPopover);
  const r = anchor.getBoundingClientRect();
  labelPopover.style.top = `${Math.min(window.innerHeight - labelPopover.offsetHeight - 8, r.bottom + 4)}px`;
  labelPopover.style.left = `${Math.max(8, Math.min(window.innerWidth - labelPopover.offsetWidth - 8, r.left))}px`;
}

// Флаги «скрыт» у всех сохранённых эпиков — по текущим галочкам.
async function persistHidden() {
  const stored = await sync.selectedEpics();
  const map = {};
  for (const e of stored) map[e.key] = !state.selected.has(e.key);
  await sync.setHidden(map);
}

// ---------- фильтры списка эпиков ----------

function setFilter(patch) {
  state.filter = { ...state.filter, ...patch };
  renderResults();
  renderStored();
}

function hasFilter() {
  return !!(state.filter.label || state.filter.assignee);
}

function applyFilter(list) {
  const { label, assignee } = state.filter;
  return list.filter((e) => (!label || (e.labels || []).includes(label)) && (!assignee || e.assigneeName === assignee));
}

// Активные фильтры и кнопка «Снять фильтры» — в шапке списка, в ячейке «Название».
function filterControls() {
  const box = document.createElement("span");
  box.className = "ifilters";
  box.append(Object.assign(document.createElement("span"), { className: "ifilters-title", textContent: t("search.filters") }));
  const active = [
    ["search.filterLabel", state.filter.label, () => setFilter({ label: "" })],
    ["search.filterAssignee", state.filter.assignee, () => setFilter({ assignee: "" })]
  ].filter(([, v]) => v);
  for (const [kind, value, remove] of active) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "lchip on";
    chip.textContent = `${t(kind)}: ${value} ×`;
    chip.onclick = (e) => {
      e.preventDefault();
      remove();
    };
    box.append(chip);
  }
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "link clear-filters";
  clear.textContent = t("search.clearFilters");
  clear.disabled = !hasFilter();
  clear.onclick = (e) => {
    e.preventDefault();
    setFilter({ label: "", assignee: "" });
  };
  box.append(clear);
  return box;
}

// Шапка списка эпиков: та же сетка, что у строк; липнет под верхней панелью при прокрутке.
function listHead() {
  const head = document.createElement("div");
  head.className = "item list-head";
  const cell = (cls, text) => {
    const c = document.createElement("span");
    c.className = cls;
    c.textContent = text;
    return c;
  };
  const dates = document.createElement("span");
  dates.className = "idates";
  for (const [label, full] of DATE_COLS) {
    const c = cell("idate", t(label));
    c.title = t(full);
    dates.append(c);
  }
  head.append(
    cell("inum", "#"), cell("", ""), cell("ikey", t("search.col.key")), cell("isum", t("search.col.name")), dates,
    cell("ilabels", t("search.col.labels")),
    cell("iperson", t("search.assignee")), cell("iperson", t("search.reporter")), cell("istatus", t("search.col.status"))
  );
  // Активные фильтры и «Снять фильтры» — второй строкой шапки во всю ширину, чтобы не зависеть от ширины колонок.
  if (hasFilter()) head.append(filterControls());
  return head;
}

function epicRow(epic, checked, index) {
  const row = document.createElement("label");
  row.className = "item" + (isDueSoon(epic) ? " due-soon" : "");
  row.dataset.key = epic.key;
  if (isDueSoon(epic)) row.title = dueHint(daysUntil(epic.dueDate));
  const num = document.createElement("span");
  num.className = "inum";
  num.textContent = `${index + 1}.`;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.onchange = () => {
    cb.checked ? state.selected.add(epic.key) : state.selected.delete(epic.key);
    // Один и тот же эпик может стоять и в сохранённых, и в найденных — держим галки синхронными.
    document
      .querySelectorAll(`.item[data-key="${CSS.escape(epic.key)}"] input`)
      .forEach((other) => (other.checked = cb.checked));
    renderSelCount();
    // Снятая галочка сразу скрывает эпик на «Ганте по эпикам» (флаг в базе, переживает перезагрузку).
    sync.setHidden({ [epic.key]: !cb.checked }).catch(fail);
  };
  const key = document.createElement("span");
  key.className = "ikey";
  key.textContent = epic.key;
  const sum = document.createElement("span");
  sum.className = "isum";
  sum.textContent = epic.summary;
  // Статус эпика — тот же лейбл и палитра, что на «Ганте по эпикам».
  const status = document.createElement("span");
  status.className = "istatus";
  if (epic.statusName) {
    const lz = document.createElement("span");
    lz.className = `lozenge lz-s-${classify(epic.statusName, epic.statusCategory).id}`;
    lz.textContent = epic.statusName;
    lz.title = epic.statusName;
    status.append(lz);
  }
  row.append(
    num, cb, key, sum, epicDates(epic),
    epicLabels(epic),
    epicPerson("search.assignee", epic.assigneeName, true),
    epicPerson("search.reporter", epic.reporterName, false),
    status
  );
  return row;
}

// Порядок как на «Ганте по эпикам»: по статусу (в работе → тест → сделать → new → готово), внутри — по названию.
function sortEpics(list) {
  return [...list].sort(
    (a, b) =>
      classify(a.statusName, a.statusCategory).rank - classify(b.statusName, b.statusCategory).rank ||
      (a.summary || "").localeCompare(b.summary || "", undefined, { sensitivity: "base" }) ||
      a.key.localeCompare(b.key)
  );
}

// Сводка над списком: всего эпиков и сколько в каждом статусе (в том же порядке, что и список).
function renderStatusSummary(box, list) {
  box.textContent = "";
  if (!list.length) return;
  const counts = new Map();
  for (const e of list) {
    const name = e.statusName || t("dash");
    if (!counts.has(name)) counts.set(name, { name, id: classify(e.statusName, e.statusCategory).id, rank: classify(e.statusName, e.statusCategory).rank, count: 0 });
    counts.get(name).count += 1;
  }
  const total = document.createElement("span");
  total.className = "ssum-total";
  total.textContent = t("search.total", { n: list.length });
  box.append(total);
  for (const c of [...counts.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))) {
    const item = document.createElement("span");
    item.className = "ssum-item";
    const lz = document.createElement("span");
    lz.className = `lozenge lz-s-${c.id}`;
    lz.textContent = c.name;
    const n = document.createElement("span");
    n.className = "ssum-count";
    n.textContent = String(c.count);
    item.append(lz, n);
    box.append(item);
  }
}

function renderSelCount() {
  $("#selCount").textContent = t("search.selected", { n: state.selected.size });
}

function renderResults() {
  const box = $("#results");
  box.textContent = "";
  const shown = applyFilter(state.results);
  renderStatusSummary($("#resultsSummary"), shown);
  if (state.results.length || hasFilter()) box.append(listHead());
  if (!shown.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = t("search.empty");
    box.append(p);
    return;
  }
  sortEpics(shown).forEach((e, i) => box.append(epicRow(e, state.selected.has(e.key), i)));
}

async function renderStored() {
  const stored = await sync.selectedEpics();
  const box = $("#storedList");
  box.textContent = "";
  const shown = applyFilter(stored);
  renderStatusSummary($("#storedSummary"), shown);
  if (stored.length || hasFilter()) box.append(listHead());
  sortEpics(shown).forEach((e, i) => box.append(epicRow(e, state.selected.has(e.key), i)));
  if (!stored.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = t("search.empty");
    box.append(p);
  }
  return stored;
}

async function doFind() {
  try {
    status(t("st.epicsLoading"));
    state.results = await sync.searchEpics($("#q").value);
    renderResults();
    hideStatus();
  } catch (e) {
    fail(e);
  }
}

async function doSaveSelection() {
  try {
    const known = new Map();
    for (const e of state.results) known.set(e.key, e);
    for (const e of await sync.selectedEpics()) if (!known.has(e.key)) known.set(e.key, e);
    const epics = [...state.selected].map((k) => known.get(k)).filter(Boolean);
    await sync.saveSelection(epics);
    await renderStored();
    await doSync({ full: true });
  } catch (e) {
    fail(e);
  }
}

// ---------- синхронизация ----------

let syncing = false;
async function doSync({ full = false } = {}) {
  if (syncing) return;
  syncing = true;
  $("#btnRefresh").disabled = $("#btnReload").disabled = true;
  try {
    const result = await sync.sync({ full, onProgress: (m) => status(m) });
    await refreshHeader();
    if (result.othersError) status(result.othersError, "error");
    gantt.resetCollapse();
    const active = document.querySelector(".tab.active")?.dataset.tab;
    if (active === "epics") drawGantt("epic", $("#page-epics"));
    if (active === "people") drawGantt("assignee", $("#page-people"));
  } catch (e) {
    fail(e);
  } finally {
    syncing = false;
    $("#btnRefresh").disabled = $("#btnReload").disabled = false;
  }
}

async function refreshHeader() {
  const [epics, issues, sprints] = await Promise.all([
    db.all(db.STORES.epics),
    db.all(db.STORES.issues),
    db.all(db.STORES.sprints)
  ]);
  $("#stats").textContent = t("toolbar.stats", { e: epics.length, i: issues.length, s: sprints.length });
  const ls = settings.get().lastSync;
  $("#lastSync").textContent = t("toolbar.lastSync", {
    t: ls ? new Date(ls).toLocaleString() : t("toolbar.never")
  });
}

// ---------- диаграммы ----------

const NO_ASSIGNEE = "__none__";

// Выпадающий список исполнителей эпиков: «все», затем люди по алфавиту, затем «без исполнителя».
function renderEpicAssigneeFilter(epics) {
  const sel = $("#epicAssignee");
  const current = settings.get().epicAssigneeFilter || "";
  sel.textContent = "";
  const add = (value, label) => {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.append(o);
  };
  add("", t("gantt.filterAll"));
  const people = new Map();
  let unassigned = 0;
  for (const e of epics) {
    if (e.assigneeKey) {
      if (!people.has(e.assigneeKey)) people.set(e.assigneeKey, { name: e.assigneeName || e.assigneeKey, count: 0 });
      people.get(e.assigneeKey).count += 1;
    } else unassigned += 1;
  }
  for (const [key, p] of [...people.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) add(key, `${p.name} (${p.count})`);
  if (unassigned) add(NO_ASSIGNEE, `${t("gantt.filterNone")} (${unassigned})`);
  // Выбранного человека могло не остаться в выгрузке — тогда фильтр сбрасывается на «все».
  sel.value = [...sel.options].some((o) => o.value === current) ? current : "";
  if (sel.value !== current) settings.save({ epicAssigneeFilter: "" });
}

// Пояснение над Гантом: сколько эпиков скрыто галочками и какие фильтры пришли со страницы поиска.
function renderGanttFilterNote(hiddenCount) {
  const box = $("#ganttFilterNote");
  box.textContent = "";
  const parts = [];
  if (hiddenCount) parts.push(t("gantt.hiddenUnchecked", { n: hiddenCount }));
  if (state.filter.label) parts.push(`${t("search.filterLabel")}: ${state.filter.label}`);
  if (state.filter.assignee) parts.push(`${t("search.filterAssignee")}: ${state.filter.assignee}`);
  if (!parts.length) return;
  box.append(`${t("gantt.fromSearch")} ${parts.join(" · ")}`);
  if (hasFilter()) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "link";
    clear.textContent = t("gantt.clearSearchFilters");
    clear.onclick = () => {
      setFilter({ label: "", assignee: "" });
      drawGantt("epic", $("#page-epics"));
    };
    box.append(clear);
  }
}

function epicMatchesFilter(epic, filter) {
  if (!filter) return true;
  if (filter === NO_ASSIGNEE) return !epic.assigneeKey;
  return epic.assigneeKey === filter;
}

async function drawGantt(mode, container) {
  try {
    const [issues, others, sprints, epics, boards, profiles] = await Promise.all([
      db.all(db.STORES.issues),
      db.all(db.STORES.others),
      db.all(db.STORES.sprints),
      db.all(db.STORES.epics),
      db.all(db.STORES.boards),
      db.all(db.STORES.people)
    ]);
    let target = container;
    let epicsShown = epics;
    let issuesShown = issues;
    if (mode === "epic") {
      // Фильтр по исполнителю эпика: диаграмма строится только по подходящим эпикам и их задачам.
      renderEpicAssigneeFilter(epics);
      const filter = settings.get().epicAssigneeFilter || "";
      // Снятые галочки и фильтры со страницы «Поиск эпиков» действуют и здесь.
      const visible = epics.filter((e) => !e.hidden);
      epicsShown = applyFilter(visible.filter((e) => epicMatchesFilter(e, filter)));
      renderGanttFilterNote(epics.length - visible.length);
      const keep = new Set(epicsShown.map((e) => e.key));
      issuesShown = issues.filter((i) => keep.has(i.epicKey));
      target = $("#epicsChart");
    }
    const model = agg.buildModel({ issues: issuesShown, others, sprints, epics: epicsShown, boards, mode });
    // Профили с вкладки «Команда» (роль, статус, системы) нужны только на вкладке по людям.
    gantt.render(target, model, { mode, profiles: mode === "assignee" ? profiles : [] });
  } catch (e) {
    fail(e);
  }
}

// ---------- настройки ----------

function fillSettingsForm() {
  const s = settings.get();
  $("#baseUrl").value = s.baseUrl;
  $("#pat").value = s.pat;
  $("#estimateField").value = s.estimateField;
  $("#hoursPerDay").value = s.hoursPerDay;
  $("#doneStatuses").value = s.doneStatuses;
  $("#infoSystems").value = (s.infoSystems || []).join("\n");
  $("#lang").value = s.lang;
  renderBoards();
  renderDetected();
  renderDateFieldSelects();
  renderUserFieldSelects();
}

// Селекты плановых полей: все поля типа «дата» из Jira + текущее значение, если его нет в списке.
function renderDateFieldSelects() {
  const s = settings.get();
  for (const [sel, key] of [[$("#plannedStartField"), "plannedStart"], [$("#plannedEndField"), "plannedEnd"]]) {
    sel.textContent = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = t("set.fieldAuto");
    sel.append(none);
    const list = [...(s.dateFields || [])];
    const cur = s.fields[key];
    if (cur && !list.some((f) => f.id === cur)) list.push({ id: cur, name: cur });
    for (const f of list) {
      const o = document.createElement("option");
      o.value = f.id;
      o.textContent = `${f.name} (${f.id})`;
      sel.append(o);
    }
    sel.value = cur || "";
  }
}

// Селекты полей «исполнитель/постановщик эпика»: стандартные assignee/reporter/creator + поля-пользователи из Jira.
function renderUserFieldSelects() {
  const s = settings.get();
  const standard = [
    ["assignee", t("set.stdAssignee")],
    ["reporter", t("set.stdReporter")],
    ["creator", t("set.stdCreator")]
  ];
  for (const [sel, key, dflt] of [[$("#epicAssigneeField"), "epicAssignee", "assignee"], [$("#epicReporterField"), "epicReporter", "reporter"]]) {
    sel.textContent = "";
    const cur = s.fields[key] || dflt;
    const list = [...standard];
    for (const f of s.userFields || []) if (!list.some(([id]) => id === f.id)) list.push([f.id, `${f.name} (${f.id})`]);
    if (!list.some(([id]) => id === cur)) list.push([cur, cur]);
    for (const [id, label] of list) {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = label;
      sel.append(o);
    }
    sel.value = cur;
  }
}

function renderDetected() {
  const f = settings.get().fields;
  $("#detected").textContent = t("set.detected", {
    e: f.epicLink || t("dash"),
    s: f.sprint || t("dash"),
    p: f.storyPoints || t("dash"),
    ps: f.plannedStart || t("dash"),
    pe: f.plannedEnd || t("dash")
  });
}

function renderBoards() {
  const sel = $("#board");
  const s = settings.get();
  sel.textContent = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = t("set.boardNone");
  sel.append(none);
  const list = state.boards.length
    ? state.boards
    : s.boardId
      ? [{ id: s.boardId, name: s.boardName || `#${s.boardId}` }]
      : [];
  for (const b of list) {
    const o = document.createElement("option");
    o.value = String(b.id);
    o.textContent = `${b.name} (#${b.id})`;
    sel.append(o);
  }
  sel.value = s.boardId ? String(s.boardId) : "";
}

async function saveSettingsForm() {
  const baseUrl = $("#baseUrl").value.trim();
  const boardId = $("#board").value;
  const boardName = $("#board").selectedOptions[0]?.textContent || "";
  await settings.save({
    baseUrl,
    pat: $("#pat").value.trim(),
    estimateField: $("#estimateField").value,
    hoursPerDay: Number($("#hoursPerDay").value) || 8,
    doneStatuses: $("#doneStatuses").value.trim(),
    infoSystems: team.parseSystems($("#infoSystems").value),
    fields: {
      plannedStart: $("#plannedStartField").value,
      plannedEnd: $("#plannedEndField").value,
      epicAssignee: $("#epicAssigneeField").value || "assignee",
      epicReporter: $("#epicReporterField").value || "reporter"
    },
    boardId,
    boardName: boardId ? boardName : ""
  });
  status(t("set.saved"));
  await refreshHeader();
}

async function ensurePermission() {
  const url = $("#baseUrl").value.trim() || settings.get().baseUrl;
  if (!url) throw new jira.JiraError(t("err.noBaseUrl"), 0);
  if (await jira.hasPermission(url)) return true;
  const granted = await jira.requestPermission(url);
  if (!granted) throw new jira.JiraError(t("err.noPermission"), 0);
  return true;
}

// ---------- запуск ----------

// Верхняя панель тоже липкая; шапке списка нужно знать её высоту, чтобы встать ровно под ней.
// Высота меняется, когда подставляются тексты (локализация) и когда панель переносится на две строки,
// поэтому пересчитываем после applyI18n, по ResizeObserver и на всякий случай при прокрутке.
let applyTopHeight = () => {};
function trackTopHeight() {
  const top = document.querySelector(".top");
  let last = "";
  applyTopHeight = () => {
    const h = `${Math.ceil(top.getBoundingClientRect().height)}px`;
    if (h !== last) {
      last = h;
      document.documentElement.style.setProperty("--top-h", h);
    }
  };
  applyTopHeight();
  if (window.ResizeObserver) new ResizeObserver(applyTopHeight).observe(top);
  window.addEventListener("resize", applyTopHeight);
  window.addEventListener("scroll", applyTopHeight, { passive: true });
}

// Текущая дата в шапке (дд.мм.гггг); обновляется раз в минуту — вкладка может жить сутками.
function showToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  $("#today").textContent = `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

async function boot() {
  trackTopHeight();
  showToday();
  setInterval(showToday, 60000);
  const s = await settings.load();
  setLang(s.lang);
  applyI18n();
  applyTopHeight();
  await db.open();

  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

  $("#lang").onchange = async () => {
    await settings.save({ lang: $("#lang").value });
    setLang($("#lang").value);
    applyI18n();
    applyTopHeight();
    fillSettingsForm();
    renderSelCount();
    renderResults();
    await renderStored();
    await refreshHeader();
    const active = document.querySelector(".tab.active")?.dataset.tab;
    if (active === "epics") drawGantt("epic", $("#page-epics"));
    if (active === "people") drawGantt("assignee", $("#page-people"));
    if (active === "team") team.render($("#page-team"), { notify: (m) => status(m) }).catch(fail);
  };

  $("#btnFind").onclick = async () => {
    try {
      await ensurePermission();
      await doFind();
    } catch (e) {
      fail(e);
    }
  };
  $("#q").onkeydown = (e) => e.key === "Enter" && $("#btnFind").click();
  $("#btnSelectAll").onclick = async () => {
    state.results.forEach((e) => state.selected.add(e.key));
    await persistHidden();
    renderResults();
    renderStored();
    renderSelCount();
  };
  $("#btnClear").onclick = async () => {
    state.selected.clear();
    await persistHidden();
    renderResults();
    renderStored();
    renderSelCount();
  };
  $("#btnSave").onclick = doSaveSelection;
  $("#epicAssignee").onchange = async () => {
    await settings.save({ epicAssigneeFilter: $("#epicAssignee").value });
    drawGantt("epic", $("#page-epics"));
  };
  $("#btnRefresh").onclick = () => doSync({ full: false });
  $("#btnReload").onclick = () => doSync({ full: true });

  $("#btnGrant").onclick = async () => {
    try {
      await ensurePermission();
      status(t("st.done"));
    } catch (e) {
      fail(e);
    }
  };
  $("#btnTest").onclick = async () => {
    try {
      await saveSettingsForm();
      await ensurePermission();
      status(t("st.connecting"));
      const me = await jira.myself();
      status(t("st.ok", { name: me.displayName || me.name }));
    } catch (e) {
      fail(e);
    }
  };
  $("#btnDetect").onclick = async () => {
    try {
      await saveSettingsForm();
      await ensurePermission();
      await sync.detectFields();
      renderDetected();
      renderDateFieldSelects();
      renderUserFieldSelects();
      status(t("st.done"));
    } catch (e) {
      fail(e);
    }
  };
  $("#btnBoards").onclick = async () => {
    try {
      await saveSettingsForm();
      await ensurePermission();
      state.boards = await jira.boards();
      renderBoards();
      status(t("st.done"));
    } catch (e) {
      fail(e);
    }
  };
  $("#btnSaveSettings").onclick = () => saveSettingsForm().catch(fail);
  $("#btnWipe").onclick = async () => {
    await db.clearAll();
    await settings.save({ lastSync: 0 });
    state.selected.clear();
    await renderStored();
    await refreshHeader();
    status(t("set.wipeDone"));
  };

  fillSettingsForm();
  const stored = await renderStored();
  stored.forEach((e) => !e.hidden && state.selected.add(e.key));
  await renderStored();
  renderSelCount();
  renderResults();
  await refreshHeader();
  if (!s.baseUrl) showTab("settings");
}

boot().catch(fail);
