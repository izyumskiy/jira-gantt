// Сборка приложения: вкладки, поиск эпиков, синхронизация, отрисовка диаграмм, настройки.
import { t, setLang, applyI18n, getLang } from "./i18n.js";
import * as settings from "./settings.js";
import * as db from "./db.js";
import * as jira from "./jira.js";
import * as sync from "./sync.js";
import * as agg from "./agg.js";
import * as gantt from "./gantt.js";
import * as team from "./team.js";
import { classify } from "./status.js";

const $ = (sel) => document.querySelector(sel);
const state = { results: [], selected: new Set(), boards: [] };

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

// Четыре даты эпика: создан, плановое начало, плановое завершение, срок исполнения.
function epicDates(epic) {
  const box = document.createElement("span");
  box.className = "idates";
  const items = [
    ["search.created", "search.createdFull", epic.created],
    ["search.plannedStart", "search.plannedStartFull", epic.plannedStart],
    ["search.plannedEnd", "search.plannedEndFull", epic.plannedEnd],
    ["search.due", "search.dueFull", epic.dueDate]
  ];
  for (const [label, full, value] of items) {
    const item = document.createElement("span");
    item.className = "idate" + (value ? "" : " idate-empty"); // не «empty»: это глобальная плашка «Нет данных»
    item.title = `${t(full)}: ${fmtDay(value)}`;
    const k = document.createElement("span");
    k.className = "idate-k";
    k.textContent = t(label);
    const v = document.createElement("span");
    v.className = "idate-v";
    v.textContent = fmtDay(value);
    item.append(k, v);
    box.append(item);
  }
  return box;
}

function epicRow(epic, checked, index) {
  const row = document.createElement("label");
  row.className = "item";
  row.dataset.key = epic.key;
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
  const prj = document.createElement("span");
  prj.className = "iprj";
  prj.textContent = epic.projectName || epic.projectKey || "";
  row.append(num, cb, key, sum, epicDates(epic), status, prj);
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
  renderStatusSummary($("#resultsSummary"), state.results);
  if (!state.results.length) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = t("search.empty");
    box.append(p);
    return;
  }
  sortEpics(state.results).forEach((e, i) => box.append(epicRow(e, state.selected.has(e.key), i)));
}

async function renderStored() {
  const stored = await sync.selectedEpics();
  const box = $("#storedList");
  box.textContent = "";
  renderStatusSummary($("#storedSummary"), stored);
  sortEpics(stored).forEach((e, i) => box.append(epicRow(e, state.selected.has(e.key), i)));
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

async function drawGantt(mode, container) {
  try {
    const [issues, others, sprints, epics, boards] = await Promise.all([
      db.all(db.STORES.issues),
      db.all(db.STORES.others),
      db.all(db.STORES.sprints),
      db.all(db.STORES.epics),
      db.all(db.STORES.boards)
    ]);
    const model = agg.buildModel({ issues, others, sprints, epics, boards, mode });
    gantt.render(container, model, { mode });
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

async function boot() {
  const s = await settings.load();
  setLang(s.lang);
  applyI18n();
  await db.open();

  document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

  $("#lang").onchange = async () => {
    await settings.save({ lang: $("#lang").value });
    setLang($("#lang").value);
    applyI18n();
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
  $("#btnSelectAll").onclick = () => {
    state.results.forEach((e) => state.selected.add(e.key));
    renderResults();
    renderStored();
    renderSelCount();
  };
  $("#btnClear").onclick = () => {
    state.selected.clear();
    renderResults();
    renderStored();
    renderSelCount();
  };
  $("#btnSave").onclick = doSaveSelection;
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
  stored.forEach((e) => state.selected.add(e.key));
  await renderStored();
  renderSelCount();
  renderResults();
  await refreshHeader();
  if (!s.baseUrl) showTab("settings");
}

boot().catch(fail);
