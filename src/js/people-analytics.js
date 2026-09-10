// UI вкладки «Аналитика»: использует настройки, Jira-клиент и IndexedDB OhMyGant.
import * as db from "./db.js";
import * as settings from "./settings.js";
import { getLang } from "./i18n.js";
import { createOhMyGantPeopleAnalyticsModule } from "../modules/people-analytics/ohmygant-adapter.js";

const analyticsModule = createOhMyGantPeopleAnalyticsModule();

let root = null;
let context = null;
let initialized = false;
let shellLanguage = "";
let shellBaseUrl = "";
const state = { teams: [], members: [], issues: [], meta: null, analytics: null, selectedId: "" };
const $ = (selector) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const num = (value, digits = 1) => Number.isFinite(value) ? new Intl.NumberFormat(getLang(), { maximumFractionDigits: digits }).format(value) : "—";
const pct = (value) => Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
const hours = (seconds) => Number.isFinite(seconds) ? `${num(seconds / 3600, 1)} ч` : "—";
const day = (date) => date.toISOString().slice(0, 10);

function text(ru, en) { return getLang() === "en" ? en : ru; }
function monthsAgo(months) { const date = new Date(); date.setMonth(date.getMonth() - months); return day(date); }
function browse(key) { return `${settings.get().baseUrl.replace(/\/$/, "")}/browse/${encodeURIComponent(key)}`; }
function jiraBaseUrl() { return String(settings.get().baseUrl || "").trim().replace(/\/+$/, ""); }

function shell() {
  shellLanguage = getLang();
  shellBaseUrl = jiraBaseUrl();
  root.innerHTML = `
    <div class="pa-head">
      <div><h2>${text("Аналитика сотрудников", "People analytics")}</h2><p>${text("Активная Tempo-команда · задачи, спринты, статусы и worklog из Jira", "Active Tempo team · Jira issues, sprints, status history and worklogs")}</p></div>
      <div class="pa-source"><span>Jira</span><strong>${esc(shellBaseUrl || text("не настроена", "not configured"))}</strong><button id="paSettings">${text("Настройки подключения", "Connection settings")}</button></div>
    </div>
    <section class="card pa-flow">
      <div class="pa-step"><span>1</span><div><strong>${text("Команды Tempo", "Tempo teams")}</strong><small>${text("Загружается только список — без задач Jira", "Only the team list, without Jira issues")}</small></div><button id="paLoadTeams" class="primary">${text("Выгрузить команды", "Load teams")}</button></div>
      <div class="pa-step pa-step-main"><span>2</span><div class="pa-controls">
        <label><b>${text("Команда", "Team")}</b><select id="paTeam"><option value="">${text("Сначала загрузите команды", "Load teams first")}</option></select></label>
        <div class="pa-presets"><button data-months="1" class="active">1 ${text("месяц", "month")}</button><button data-months="3">3 ${text("месяца", "months")}</button><button data-months="9">9 ${text("месяцев", "months")}</button><button data-months="12">${text("Год", "Year")}</button><button data-months="custom">${text("Произвольный", "Custom")}</button></div>
        <div class="pa-dates"><label><b>${text("С", "From")}</b><input id="paFrom" type="date"></label><label><b>${text("По", "To")}</b><input id="paTo" type="date"></label></div>
      </div><button id="paLoad" class="primary" disabled>${text("Определить сотрудников и загрузить задачи", "Find people and load issues")}</button></div>
      <div id="paProgress" class="pa-progress hidden"></div>
    </section>
    <section id="paDashboard" class="hidden">
      <div id="paSummary" class="pa-summary"></div>
      <div id="paTeamSummary" class="card pa-team-summary"></div>
      <div class="pa-layout">
        <section class="card pa-list"><div class="pa-list-head"><div><h3>${text("Сотрудники", "Employees")}</h3><small id="paCount"></small></div><div class="row"><input id="paSearch" type="search" placeholder="${text("Имя или роль", "Name or role")}"><select id="paSort"><option value="score">${text("По оценке", "By score")}</option><option value="closed">${text("По завершениям", "By completed")}</option><option value="cycle">Cycle Time</option><option value="estimate">Plan / fact</option></select><button id="paExport">CSV</button></div></div><div class="pa-table-wrap"><table class="pa-table"><thead><tr><th>${text("Сотрудник", "Employee")}</th><th>${text("Оценка", "Score")}</th><th>${text("Закрыто", "Done")}</th><th>Cycle med / P75</th><th>Fact / plan</th><th>Reopen</th><th>${text("Доверие", "Confidence")}</th></tr></thead><tbody id="paRows"></tbody></table></div></section>
        <aside id="paDetail" class="card pa-detail"></aside>
      </div>
    </section>`;
}

function progress(message, kind = "") {
  const box = $("#paProgress");
  const displayKind = kind || "loading";
  box.className = `pa-progress ${displayKind}`;
  box.textContent = message;
  context?.notify?.(message, displayKind, !kind);
}

async function readLocal() {
  [state.teams, state.members, state.issues, state.meta] = await Promise.all([
    db.all(db.STORES.paTeams), db.all(db.STORES.paMembers), db.all(db.STORES.paIssues), db.metaGet("peopleAnalysis")
  ]);
}

function renderTeamSelect() {
  const select = $("#paTeam"), selected = select.value || state.meta?.teamId || "";
  select.innerHTML = `<option value="">${text("Выберите команду", "Choose a team")}</option>` + state.teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((team) => `<option value="${esc(team.id)}">${esc(team.name)}</option>`).join("");
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
  $("#paLoad").disabled = !select.value;
}

function applyPreset(value) {
  root.querySelectorAll(".pa-presets button").forEach((button) => button.classList.toggle("active", button.dataset.months === String(value)));
  if (value === "custom") return;
  $("#paTo").value = day(new Date());
  $("#paFrom").value = monthsAgo(Number(value));
}

async function loadTeams() {
  const button = $("#paLoadTeams"); button.disabled = true;
  try {
    await context.ensurePermission();
    const teams = await analyticsModule.listTeams({ onProgress: (message) => progress(message) });
    state.teams = teams; renderTeamSelect();
    progress(text(`Активных команд: ${teams.length}. Выберите команду и период.`, `Active teams: ${teams.length}. Choose team and period.`), "ok");
  } catch (error) { progress(error.message, "error"); }
  finally { button.disabled = false; }
}

async function loadSelected() {
  const team = state.teams.find((item) => item.id === $("#paTeam").value);
  const button = $("#paLoad"); button.disabled = true;
  try {
    await context.ensurePermission();
    const result = await analyticsModule.loadTeam({
      team,
      from: $("#paFrom").value,
      to: $("#paTo").value,
      onProgress: progress
    });
    state.members = result.members; state.issues = result.issues; state.meta = result.meta; state.selectedId = "";
    const elapsed = num(result.meta.loadDurationMs / 1000, 1);
    progress(text(`Готово за ${elapsed} с: ${result.members.length} сотрудников, ${result.issues.length} задач за выбранный период`, `Done in ${elapsed}s: ${result.members.length} employees, ${result.issues.length} issues in the selected period`), result.meta.warnings.length ? "warn" : "ok");
    calculate();
  } catch (error) { progress(error.message, "error"); }
  finally { button.disabled = !$("#paTeam").value; }
}

function calculate() {
  const team = state.teams.find((item) => item.id === state.meta?.teamId);
  if (!team || !state.members.length) { $("#paDashboard").classList.add("hidden"); return; }
  const current = settings.get();
  state.analytics = analyticsModule.analyzeSnapshot({
    teams: [team],
    members: state.members,
    issues: state.issues,
    settings: { ...current.peopleAnalysis, doneStatuses: current.doneStatuses },
    period: { from: state.meta.from, to: state.meta.to }
  });
  $("#paDashboard").classList.remove("hidden");
  renderSummary(); renderPeople();
}

function renderSummary() {
  const team = state.analytics.teams[0], employees = state.analytics.employees;
  const cards = [
    [text("Команда", "Team"), team.name, `${team.projects.length} ${text("проектов", "projects")}`],
    [text("Сотрудники", "Employees"), team.people, text("активные в Tempo", "active in Tempo")],
    [text("Завершено", "Completed"), team.closed, `${state.issues.length} ${text("связанных задач", "related issues")}`],
    ["Worklog", hours(team.loggedSeconds), `${state.meta.worklogCount || 0} ${text("записей", "entries")}`],
    ["Plan / fact", team.estimateRatio == null ? "—" : `×${num(team.estimateRatio, 2)}`, text("медиана команды", "team median")]
  ];
  $("#paSummary").innerHTML = cards.map(([label, value, note]) => `<div class="card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`).join("");
  const projects = team.projects.map((project) => `${project.key} · ${project.count}`).join(", ") || "—";
  $("#paTeamSummary").innerHTML = `<div><span>${text("КОМАНДА", "TEAM")}</span><h2>${esc(team.name)}</h2><p>${text("Проекты", "Projects")}: ${esc(projects)}</p></div><dl><div><dt>Cycle med / P75</dt><dd>${num(team.median, 1)} / ${num(team.p75, 1)} ${text("дн.", "d")}</dd></div><div><dt>${text("Медиана оценки", "Median score")}</dt><dd>${num(team.scoreMedian, 0)}</dd></div><div><dt>Reopen</dt><dd>${pct(team.reopenRate)}</dd></div><div><dt>${text("Спринт вовремя", "Sprint on time")}</dt><dd>${pct(team.sprintRate)}</dd></div></dl>`;
}

function filtered() {
  const query = $("#paSearch").value.trim().toLowerCase(), sort = $("#paSort").value;
  const rows = state.analytics.employees.filter((employee) => !query || `${employee.assignee} ${employee.member.role} ${employee.member.username}`.toLowerCase().includes(query));
  rows.sort((a, b) => sort === "closed" ? b.closed - a.closed : sort === "cycle" ? (a.median ?? Infinity) - (b.median ?? Infinity) : sort === "estimate" ? Math.abs((a.estimate.medianRatio ?? Infinity) - 1) - Math.abs((b.estimate.medianRatio ?? Infinity) - 1) : (b.score ?? -1) - (a.score ?? -1));
  return rows;
}
function initials(name) { return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(); }
function renderPeople() {
  const rows = filtered();
  if (!rows.some((employee) => employee.id === state.selectedId)) state.selectedId = rows[0]?.id || "";
  $("#paCount").textContent = `${rows.length} / ${state.analytics.employees.length}`;
  $("#paRows").innerHTML = rows.map((employee) => `<tr data-id="${esc(employee.id)}" class="${employee.id === state.selectedId ? "selected" : ""}"><td><span class="pa-avatar">${esc(initials(employee.assignee))}</span><b>${esc(employee.assignee)}</b><small>${esc(employee.member.role || employee.member.username)}</small></td><td><em class="pa-score ${employee.band.code}">${num(employee.score, 0)}</em></td><td>${employee.closed}</td><td>${num(employee.median, 1)} / ${num(employee.p75, 1)}</td><td>${employee.estimate.medianRatio == null ? "—" : `×${num(employee.estimate.medianRatio, 2)}`}</td><td>${pct(employee.reopenRate)}</td><td>${employee.confidence}/100</td></tr>`).join("") || `<tr><td colspan="7">${text("Нет сотрудников", "No employees")}</td></tr>`;
  $("#paRows").querySelectorAll("tr[data-id]").forEach((row) => row.onclick = () => { state.selectedId = row.dataset.id; renderPeople(); });
  const selected = state.analytics.employees.find((employee) => employee.id === state.selectedId);
  if (selected) renderDetail(selected);
}

function detailMetric(label, value) { return `<div><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`; }
function evidenceList(title, rows, cls = "") { return rows.length ? `<section class="pa-section ${cls}"><h4>${esc(title)}</h4><ul>${rows.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>` : ""; }
function renderDetail(employee) {
  const team = state.analytics.teams[0], scored = state.analytics.employees.filter((item) => Number.isFinite(item.score)).sort((a, b) => b.score - a.score), rank = scored.findIndex((item) => item.id === employee.id);
  const skills = employee.member.skills?.length ? employee.member.skills.map((skill) => `<i>${esc(skill)}</i>`).join("") : `<small>—</small>`;
  const inferred = employee.inferredSkills.map((skill) => `<i>${esc(skill.name)} · ${skill.count}</i>`).join("") || `<small>—</small>`;
  const portrait = employee.style.portrait.map((row) => `<div class="pa-trait"><b>${esc(row.trait)} · ${esc(row.value)}</b><span>${esc(row.evidence)}</span><small>${text("Уверенность", "Confidence")}: ${esc(row.confidence)}</small></div>`).join("") || "—";
  const achievements = employee.achievements.map((row) => `<li>${esc(row.text)} ${row.keys.map((key) => `<a target="_blank" href="${esc(browse(key))}">${esc(key)}</a>`).join(" ")}</li>`).join("");
  $("#paDetail").innerHTML = `<header><div><small>${esc(employee.team)}</small><h2>${esc(employee.assignee)}</h2><p>${esc(employee.band.label)}</p></div><em class="pa-big-score">${num(employee.score, 0)}<small>/100</small></em></header>
    <div class="pa-profile">${detailMetric(text("Tempo роль", "Tempo role"), employee.member.role || "—")}${detailMetric(text("Грейд", "Grade"), employee.member.grade || "—")}${detailMetric(text("Участие", "Commitment"), `${num(employee.member.commitment, 0)}%`)}</div>
    <section class="pa-section"><h4>${text("Навыки", "Skills")}</h4><label>${text("Официальные", "Official")}</label><div class="pa-tags">${skills}</div><label>${text("По задачам", "Inferred from issues")}</label><div class="pa-tags">${inferred}</div></section>
    <div class="pa-metrics">${detailMetric(text("Завершено", "Completed"), employee.closed)}${detailMetric("Cycle med / P75", `${num(employee.median, 1)} / ${num(employee.p75, 1)}`)}${detailMetric("SLE", pct(employee.sleRate))}${detailMetric("Worklog", hours(employee.loggedSeconds))}${detailMetric("Fact / plan", employee.estimate.medianRatio == null ? "—" : `×${num(employee.estimate.medianRatio, 2)}`)}${detailMetric("Reopen", pct(employee.reopenRate))}${detailMetric(text("Возвраты review/test", "Review/test returns"), pct(employee.returnRate))}${detailMetric(text("Багов исправлено", "Bugs fixed"), employee.bugCount)}${detailMetric(text("Переносы спринта", "Sprint carryover"), employee.sprint.carryover)}</div>
    <section class="pa-section"><h4>${text("Сравнение внутри команды", "Within-team comparison")}${rank >= 0 ? ` · ${rank + 1}/${scored.length}` : ""}</h4><div class="pa-compare">${detailMetric(text("Оценка / медиана", "Score / median"), `${num(employee.score, 0)} / ${num(team.scoreMedian, 0)}`)}${detailMetric("Cycle / team", `${num(employee.median, 1)} / ${num(team.median, 1)}`)}${detailMetric("Plan/fact / team", `${num(employee.estimate.medianRatio, 2)} / ${num(team.estimateRatio, 2)}`)}</div></section>
    <section class="pa-section"><h4>${text("Рабочий поведенческий профиль", "Work behaviour profile")}</h4><p class="muted">${text("Гипотезы по Jira/Tempo, не психологический диагноз.", "Evidence-based Jira/Tempo hypotheses, not a diagnosis.")}</p>${portrait}</section>
    ${achievements ? `<section class="pa-section"><h4>${text("Заслуги с доказательствами", "Evidence-backed achievements")}</h4><ul>${achievements}</ul></section>` : ""}
    ${evidenceList(text("Сильные сигналы", "Strengths"), employee.strengths, "positive")}${evidenceList(text("Риски", "Risks"), employee.risks, "negative")}${evidenceList(text("Ограничения данных", "Data limitations"), employee.notes)}`;
}

function exportCsv() {
  const header = ["team", "employee", "role", "grade", "score", "confidence", "closed", "cycle_median", "cycle_p75", "logged_hours", "actual_estimate_ratio", "reopen_rate"];
  const rows = state.analytics.employees.map((e) => [e.team, e.assignee, e.member.role, e.member.grade, e.score ?? "", e.confidence, e.closed, e.median ?? "", e.p75 ?? "", e.loggedSeconds / 3600, e.estimate.medianRatio ?? "", e.reopenRate ?? ""]);
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const url = URL.createObjectURL(new Blob(["\uFEFF" + [header, ...rows].map((row) => row.map(quote).join(";")).join("\r\n")], { type: "text/csv" }));
  const link = document.createElement("a"); link.href = url; link.download = `jira-team-${day(new Date())}.csv`; link.click(); URL.revokeObjectURL(url);
}

function bind() {
  $("#paSettings").onclick = () => document.querySelector('[data-tab="settings"]').click();
  $("#paLoadTeams").onclick = loadTeams;
  $("#paTeam").onchange = () => { $("#paLoad").disabled = !$("#paTeam").value; };
  root.querySelectorAll(".pa-presets button").forEach((button) => button.onclick = () => applyPreset(button.dataset.months));
  [$("#paFrom"), $("#paTo")].forEach((input) => input.onchange = () => applyPreset("custom"));
  $("#paLoad").onclick = loadSelected;
  $("#paSearch").oninput = renderPeople; $("#paSort").onchange = renderPeople; $("#paExport").onclick = exportCsv;
}

export async function init(container, options) {
  root = container; context = options;
  shell(); bind();
  $("#paFrom").value = monthsAgo(1); $("#paTo").value = day(new Date());
  initialized = true;
  await open();
}
export async function open() {
  if (!initialized) return;
  if (shellLanguage !== getLang() || shellBaseUrl !== jiraBaseUrl()) {
    shell(); bind();
    $("#paFrom").value = monthsAgo(1); $("#paTo").value = day(new Date());
  }
  await readLocal();
  renderTeamSelect();
  if (state.meta) {
    $("#paFrom").value = state.meta.from; $("#paTo").value = state.meta.to;
    root.querySelectorAll(".pa-presets button").forEach((button) => button.classList.toggle("active", button.dataset.months === "custom"));
  }
  calculate();
}
