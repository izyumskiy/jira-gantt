// UI прогноза: источник требований → системный анализ → часы → календарь по загрузке Jira.
import * as db from "../db.js";
import * as settings from "../settings.js";
import { getLang } from "../i18n.js";
import { createOhMyGantProjectPlanningModule } from "../../modules/project-planning/ohmygant-adapter.js";
import * as sync from "./sync.js";

const planningModule = createOhMyGantProjectPlanningModule();

let root = null;
let context = null;
let initialized = false;
let shellLanguage = "";
let shellBaseUrl = "";

const state = {
  teams: [], people: [], selected: new Set(), context: null,
  source: null, analysis: null, result: null, activeProjects: [], draft: null, forecastHistory: []
};

const $ = (selector) => root.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const text = (ru, en) => getLang() === "en" ? en : ru;
const normalize = (value) => String(value || "").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
const num = (value, digits = 1) => Number.isFinite(Number(value)) ? new Intl.NumberFormat(getLang(), { maximumFractionDigits: digits }).format(Number(value)) : "—";
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const monthsAgo = (months) => {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

function deriveTeams(people) {
  const teams = new Map();
  for (const person of people) (person.teamIds || []).forEach((id, index) => teams.set(id, { id, name: person.teamNames?.[index] || id, active: true }));
  return [...teams.values()];
}

function shell() {
  const previous = readForm(false);
  shellLanguage = getLang();
  shellBaseUrl = String(settings.get().baseUrl || "").trim().replace(/\/+$/, "");
  root.innerHTML = `
    <div class="pf-head">
      <div><h2>${text("Прогноз проекта", "Project forecast")}</h2><p>${text("Системный анализ, оценка в человеко-часах и размещение поверх активных проектов Jira", "System analysis, person-hour estimate and scheduling over active Jira projects")}</p></div>
      <div class="pf-source"><span>Jira</span><strong>${esc(shellBaseUrl || text("не настроена", "not configured"))}</strong><button id="pfSettings">${text("Настройки подключения", "Connection settings")}</button></div>
    </div>

    <section class="card pf-scope">
      <div class="pf-section-title"><span>1</span><div><h3>${text("Источник и параметры анализа", "Analysis source and parameters")}</h3><small>${text("Ручная оценка не требуется: объём будет рассчитан по требованиям и истории Jira", "No manual estimate: scope is calculated from requirements and Jira history")}</small></div></div>
      <div class="pf-scope-grid">
        <label class="pf-full"><b>${text("Проект: ключ или ссылка Jira", "Project: Jira key or link")}</b><input id="pfSourceInput" type="text" placeholder="PROJ-123 или https://jira.../browse/PROJ-123"></label>
        <label class="pf-document"><b>${text("Бизнес-требования · Confluence", "Business requirements · Confluence")}</b><input id="pfBusinessRequirements" type="url" placeholder="https://confluence.../"><small>${text("Опционально. Пусто — бизнес-требования не проработаны.", "Optional. Empty means business requirements are not prepared.")}</small></label>
        <label class="pf-document"><b>${text("Системный анализ · Confluence", "System analysis · Confluence")}</b><input id="pfSystemAnalysis" type="url" placeholder="https://confluence.../"><small>${text("Опционально. Если статьи нет, инструмент сформирует экспресс-анализ.", "Optional. If absent, the tool generates an express analysis.")}</small></label>
        <label class="pf-check pf-express-option"><input id="pfExpressAnalysis" type="checkbox"><span><b>${text("Сформировать расширенный экспресс-системный анализ", "Generate extended express system analysis")}</b><small>${text("Read-only проверка эпика, задач, полноты требований и связанных GitLab-репозиториев", "Read-only review of the epic, issues, requirement coverage and linked GitLab repositories")}</small></span></label>
        <label><b>${text("Расчёт не раньше", "Calculate no earlier than")}</b><input id="pfStart" type="date" value="${today()}"></label>
        <label><b>${text("Минимальная неопределённость P80, %", "Minimum P80 uncertainty, %")}</b><input id="pfUnknown" type="number" min="0" max="200" step="5" value="0"><small>${text("Только нижняя граница; основное распределение рассчитывается по plan/fact аналогов", "Floor only; the main distribution is calibrated from analogue plan/fact")}</small></label>
        <label><b>${text("История сотрудника", "Employee history")}</b><select id="pfHistoryMonths"><option value="3">3 ${text("месяца", "months")}</option><option value="9">9 ${text("месяцев", "months")}</option><option value="12">${text("Год", "Year")}</option></select></label>
        <label class="pf-check"><input id="pfBaza" type="checkbox"><span><b>BAZA</b><small>${text("Новый проект важнее неприоритетной нагрузки", "New project precedes non-priority workload")}</small></span></label>
      </div>
    </section>

    <section class="card pf-roster">
      <div class="pf-section-title"><span id="pfParticipantCount">${state.selected.size}</span><div><h3>${text("Участники проекта", "Project participants")}</h3><small>${text("При пустом поиске отображаются только выбранные сотрудники", "When search is empty, only selected employees are shown")}</small></div><button id="pfLoadRoster" class="primary">${text("Обновить из Tempo", "Refresh from Tempo")}</button></div>
      <div class="pf-roster-tools"><input id="pfSearch" type="search" placeholder="${text("Имя, команда или роль", "Name, team or role")}"><button id="pfSelectVisible">${text("Выбрать найденных", "Select visible")}</button><button id="pfClear">${text("Очистить", "Clear")}</button><strong id="pfSelectedCount"></strong></div>
      <div id="pfPeople" class="pf-people"></div>
    </section>

    <section id="pfStaffingWarning" class="card pf-staffing hidden" aria-live="polite"></section>

    <section class="card pf-action">
      <div id="pfProgress" class="pf-progress is-empty" aria-live="polite"></div>
      <button id="pfCalculate" class="primary">${text("Провести анализ и рассчитать", "Analyze and forecast")}</button>
    </section>

    <section id="pfResult" class="hidden">
      <div id="pfDates" class="pf-date-cards"></div>
      <section class="card pf-analysis" id="pfAnalysis"></section>
      <section class="card pf-reconciliation" id="pfReconciliation"></section>
      <section class="card pf-breakdown"><h3>${text("Декомпозиция и приблизительный ход проекта", "Decomposition and approximate project course")}</h3><div class="pf-table-wrap"><table class="pf-work-table"><thead><tr><th>ID</th><th>${text("Образ результата / пул работ", "Result / work pool")}</th><th>${text("Источник", "Source")}</th><th>${text("Ответственный", "Owner")}</th><th>${text("Оценка", "Estimate")}</th><th>P80</th><th>${text("Доверие", "Confidence")}</th><th>${text("План", "Plan")}</th><th>${text("Основание", "Basis")}</th></tr></thead><tbody id="pfWorkRows"></tbody></table></div></section>
      <section class="card pf-active"><h3>${text("Портфель активных эпиков", "Active epic portfolio")}</h3><p>${text("Работы распределены внутри Sprint и Planned Start/End; свободная дневная ёмкость используется новым проектом параллельно.", "Work is spread within Sprint and Planned Start/End; remaining daily capacity is used by the new project in parallel.")}</p><div class="pf-table-wrap"><table><thead><tr><th>${text("Эпик", "Epic")}</th><th>${text("Приоритет", "Priority")}</th><th>${text("Сотрудники", "Employees")}</th><th>${text("Остаток", "Remaining")}</th><th>${text("Спринты / срок", "Sprints / date")}</th><th>${text("Перепрогноз", "Reforecast")}</th></tr></thead><tbody id="pfActiveRows"></tbody></table></div></section>
      <section class="card pf-active pf-capacity"><h3>${text("Ёмкость выбранных сотрудников", "Selected employee capacity")}</h3><p id="pfCriticalPath"></p><div class="pf-table-wrap"><table><thead><tr><th>${text("Сотрудник", "Employee")}</th><th>${text("Ёмкость до P80", "Capacity to P80")}</th><th>${text("Активные эпики", "Active epics")}</th><th>${text("Занято ими", "Occupied by them")}</th><th>${text("Новый проект", "New project")}</th><th>${text("Свободно", "Free")}</th></tr></thead><tbody id="pfCapacityRows"></tbody></table></div></section>
      <section class="card pf-jira-draft" id="pfJiraDraft"></section>
      <section class="card pf-breakdown"><h3>${text("Оценка по сотрудникам", "Employee estimate")}</h3><div class="pf-table-wrap"><table><thead><tr><th>${text("Сотрудник", "Employee")}</th><th>${text("Базовая оценка, ч", "Base estimate, h")}</th><th>P80, ч</th><th>${text("Надёжность", "Reliability")}</th><th>${text("Общий Fact / plan", "Overall Fact / plan")}</th><th>${text("Коэффициент назначенных работ", "Assigned-work factor")}</th><th>${text("Многозадачность", "Multitasking")}</th><th>${text("Отпуск, раб. дн.", "Vacation workdays")}</th></tr></thead><tbody id="pfEmployeeRows"></tbody></table></div></section>
      <section class="card pf-evidence" id="pfEvidence"></section>
    </section>`;
  writeForm(previous || state.draft);
}

function readForm(requireRoot = true) {
  if ((!root || !$("#pfSourceInput")) && requireRoot) return null;
  if (!root || !$("#pfSourceInput")) return state.draft;
  return {
    source: $("#pfSourceInput").value,
    businessRequirements: $("#pfBusinessRequirements").value,
    systemAnalysis: $("#pfSystemAnalysis").value,
    expressAnalysis: $("#pfExpressAnalysis").checked,
    planningStart: $("#pfStart").value,
    unknownPercent: $("#pfUnknown").value,
    historyMonths: $("#pfHistoryMonths").value,
    projectIsBaza: $("#pfBaza").checked,
    selectedIds: [...state.selected]
  };
}

function writeForm(draft) {
  if (!draft || !root || !$("#pfSourceInput")) return;
  $("#pfSourceInput").value = draft.source || (/\/browse\/[A-Z]+-\d+/i.test(draft.projectName || "") ? draft.projectName : "");
  $("#pfBusinessRequirements").value = draft.businessRequirements || "";
  $("#pfSystemAnalysis").value = draft.systemAnalysis || "";
  $("#pfExpressAnalysis").checked = Boolean(draft.expressAnalysis);
  $("#pfStart").value = draft.planningStart || today();
  $("#pfUnknown").value = draft.unknownPercent ?? 0;
  $("#pfHistoryMonths").value = String(draft.historyMonths || 3);
  $("#pfBaza").checked = Boolean(draft.projectIsBaza);
  state.selected = new Set(draft.selectedIds || state.selected);
}

async function persistDraft() {
  state.draft = readForm();
  await db.metaSet("projectForecastDraft", state.draft);
}

function invalidateForecast(message = "") {
  state.analysis = null;
  state.result = null;
  state.activeProjects = [];
  renderResult();
  db.metaSet("projectForecastResult", null).catch(() => {});
  if (message) progress(message, "warn");
}

function progress(message = "", kind = "loading") {
  const box = $("#pfProgress");
  box.textContent = message;
  box.className = `pf-progress ${message ? kind : "is-empty"}`;
}

function progressError(error) {
  progress(error?.message || String(error), "error");
  const box = $("#pfProgress");
  if (error?.actionUrl && /^https?:\/\//i.test(error.actionUrl)) {
    const link = document.createElement("a");
    link.href = error.actionUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = text("Открыть статью Confluence", "Open the Confluence page");
    box.append(" ", link);
  }
  const fieldByKind = {
    businessRequirements: "#pfBusinessRequirements",
    systemAnalysis: "#pfSystemAnalysis"
  };
  const field = fieldByKind[error?.documentKind];
  if (!field) return;
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = text("Продолжить без этой статьи", "Continue without this page");
  button.onclick = async () => {
    $(field).value = "";
    await persistDraft();
    calculate();
  };
  box.append(" ", button);
}

function visiblePeople() {
  const query = normalize($("#pfSearch").value);
  return query
    ? state.people.filter((person) => normalize(`${person.displayName} ${(person.teamNames || []).join(" ")} ${(person.roles || []).join(" ")}`).includes(query))
    : state.people.filter((person) => state.selected.has(person.id));
}

function initials(name) {
  return String(name || "?").split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function renderPeople() {
  const people = visiblePeople();
  $("#pfParticipantCount").textContent = String(state.selected.size);
  $("#pfSelectedCount").textContent = text(`Выбрано: ${state.selected.size}`, `Selected: ${state.selected.size}`);
  $("#pfPeople").innerHTML = people.map((person) => `
    <label class="pf-person ${state.selected.has(person.id) ? "selected" : ""}">
      <input type="checkbox" data-person-id="${esc(person.id)}" ${state.selected.has(person.id) ? "checked" : ""}>
      <span class="pf-avatar">${esc(initials(person.displayName))}</span>
      <span class="pf-person-main"><b>${esc(person.displayName)}</b><small>${esc((person.teamNames || []).join(", ") || "—")}</small></span>
      <span class="pf-person-meta"><b>${esc((person.roles || []).join(", ") || person.grade || "—")}</b><small>${num(person.commitment, 0)}%</small></span>
    </label>`).join("") || `<div class="pf-empty">${state.people.length ? text("Введите имя, команду или роль для поиска сотрудника", "Enter a name, team or role to find an employee") : text("Сначала загрузите активных сотрудников Tempo", "Load active Tempo employees first")}</div>`;
  $("#pfPeople").querySelectorAll("input[data-person-id]").forEach((checkbox) => {
    checkbox.onchange = () => {
      checkbox.checked ? state.selected.add(checkbox.dataset.personId) : state.selected.delete(checkbox.dataset.personId);
      renderPeople();
      invalidateForecast(text("Состав изменён — пересчитайте прогноз", "Staffing changed — recalculate the forecast"));
      persistDraft().catch(() => {});
    };
  });
}

async function loadRoster() {
  const button = $("#pfLoadRoster");
  button.disabled = true;
  try {
    await context.ensurePermission();
    progress(text("Загрузка активных команд и сотрудников Tempo", "Loading active Tempo teams and employees"));
    const loaded = await sync.loadRoster((message) => progress(message));
    state.teams = loaded.teams;
    state.people = loaded.people;
    state.selected = new Set([...state.selected].filter((id) => state.people.some((person) => person.id === id)));
    renderPeople();
    progress(text(`Готово: ${state.people.length} активных сотрудников`, `Done: ${state.people.length} active employees`), loaded.warnings.length ? "warn" : "ok");
  } catch (error) {
    progressError(error);
  } finally {
    button.disabled = false;
  }
}

function formatDate(value) {
  if (!value) return "—";
  const [year, month, day] = String(value).split("-");
  return year && month && day ? `${day}.${month}.${year}` : value;
}

function renderStaffingGaps() {
  const box = $("#pfStaffingWarning");
  const gaps = state.analysis?.staffingGaps || [];
  if (!gaps.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  const totalHours = gaps.reduce((sum, gap) => sum + Number(gap.hours || 0), 0);
  box.classList.remove("hidden");
  box.innerHTML = `<div class="pf-staffing-head"><div><span>${text("СОСТАВ НУЖНО УТОЧНИТЬ", "STAFFING NEEDS REVIEW")}</span><h3>${text("В выбранном составе не хватает специализаций", "Required specializations are missing")}</h3></div><b>${num(totalHours, 0)} ${text("ч под риском", "hours at risk")}</b></div>
    <p>${text("До корректировки сотрудники назначены на эти работы предварительно. Найдите и выберите специалиста нужной роли, затем пересчитайте прогноз.", "Until corrected, employees are assigned to this work provisionally. Find and select the required specialist, then recalculate the forecast.")}</p>
    <div class="pf-staffing-list">${gaps.map((gap) => `<div class="${esc(gap.severity || "high")}"><strong>${esc(gap.suggestedRole)}</strong><span>${num(gap.hours, 0)} ч · ${gap.itemIds.length} ${text("работ", "items")}</span><small>${esc(gap.message)}</small></div>`).join("")}</div>`;
}

function repositoryProfileMarkup(repository) {
  const profile = repository.technologyProfile || {};
  const stack = profile.technologies || [];
  const runtimes = profile.runtimes || [];
  const languages = (profile.languages || []).map((item) => `${item.name} ${num(item.share, 1)}%`);
  const tests = profile.tests || { files: repository.testFiles || 0, tools: [] };
  const scope = profile.scope || {};
  const stackText = stack.length
    ? esc(stack.join(" · "))
    : text("Стек не удалось подтвердить по доступным файлам", "Stack could not be verified from available files");
  const evidence = [
    runtimes.length ? `${text("Runtime", "Runtime")}: ${esc(runtimes.join(", "))}` : "",
    languages.length ? `${text("Языки", "Languages")}: ${esc(languages.join(", "))}` : "",
    `${text("Тестовый контур", "Test scope")}: ${num(tests.files || 0, 0)}${tests.tools?.length ? ` (${esc(tests.tools.join(", "))})` : ""}`,
    scope.files ? `${text("Просмотрено файлов", "Files inspected")}: ${num(scope.files, 0)}${scope.treeTruncated ? "+" : ""}` : ""
  ].filter(Boolean).join(" · ");
  return `<p class="pf-repository-stack"><b>${text("Обнаруженный стек", "Detected stack")}:</b> ${stackText}</p><small>${evidence}</small><small>${text("Проверенные технические файлы", "Inspected technical files")}: ${esc((repository.files || []).join(", ") || "—")}</small>`;
}

function estimateExplanationMarkup(item) {
  const explanation = item.estimateExplanation;
  if (!explanation?.base || !explanation?.scenarios) return "";
  const base = explanation.base;
  const inputs = (base.inputs || []).map((input) => {
    const weight = Number.isFinite(Number(input.weight)) ? ` × ${num(Number(input.weight) * 100, 0)}%` : "";
    const sample = input.sample ? ` · n=${num(input.sample, 0)}` : "";
    return `<li><span>${esc(input.label)}</span><b>${num(input.value, 2)} ${esc(input.unit || "")}${weight}</b><small>${sample}</small></li>`;
  }).join("");
  const scenarios = [explanation.scenarios.p50, explanation.scenarios.p80, explanation.scenarios.p90].filter(Boolean);
  return `<details class="pf-estimate-trace"><summary>${text("Показать формулу оценки", "Show estimate formula")}</summary>
    <p><b>${esc(base.label || text("Базовая оценка", "Base estimate"))}:</b> ${esc(base.formula || "—")} = ${num(base.resultHours, 1)} ч</p>
    ${inputs ? `<ul>${inputs}</ul>` : ""}
    <div>${scenarios.map((scenario) => `<span><b>${esc(scenario.percentile)}</b> ${num(scenario.baseHours, 1)} × ${num(scenario.calibration.factor, 3)} × ${num(scenario.multitasking.factor, 3)} = <strong>${num(scenario.forecastHours, 1)} ч</strong><small>${esc(scenario.calibration.sourceLabel)}${scenario.calibration.sample ? ` · n=${scenario.calibration.sample}` : ""}${scenario.multitasking.activeProjectCount ? ` · ${text("активных проектов", "active projects")}: ${scenario.multitasking.activeProjectCount}` : ""}</small></span>`).join("")}</div>
  </details>`;
}

function renderAnalysis() {
  const analysis = state.analysis;
  const documents = analysis.source.documents;
  const documentStatus = documents ? `<div class="pf-document-status">
    ${[documents.businessRequirements, documents.systemAnalysis].map((document) => {
      const generated = document?.kind === "systemAnalysis" && !document?.provided;
      const status = document?.provided ? text("Проработано", "Prepared") : generated ? text("Экспресс-анализ сформирован", "Express analysis generated") : text("Не проработано", "Not prepared");
      return `<div class="${document?.provided ? "ready" : generated ? "generated" : "missing"}"><span>${esc(document?.label || "")}</span><b>${status}</b>${document?.provided ? `<small>${esc(document.title)}</small>` : generated ? `<small>${esc(analysis.systemAnalysis?.title || text("Будет сформирован при следующем расчёте", "Will be generated on the next calculation"))}</small>` : ""}</div>`;
    }).join("")}
  </div>` : "";
  const express = analysis.systemAnalysis;
  const expressBlock = express ? `<div class="pf-express"><div class="pf-express-title"><div><span>${express.mode === "express" ? text("ЭКСПРЕСС-АНАЛИЗ", "EXPRESS ANALYSIS") : text("СИСТЕМНЫЙ КОНТУР", "SYSTEM OUTLINE")}</span><h4>${esc(express.title)}</h4></div><b>${text("Сложность", "Complexity")}: ${esc(analysis.complexity.label)} · ${text("модельная неопределённость P80", "model P80 uncertainty")} ${analysis.recommendedUnknownPercent}%</b></div><div class="pf-express-grid"><div><strong>${text("Компоненты", "Components")}</strong><p>${esc(express.components.join(", ") || "—")}</p></div><div><strong>${text("Взаимодействия", "Interactions")}</strong><ul>${express.interactions.map((row) => `<li>${esc(row)}</li>`).join("")}</ul></div><div><strong>${text("Риски и допущения", "Risks and assumptions")}</strong><ul>${[...express.risks, ...express.assumptions].map((row) => `<li>${esc(row)}</li>`).join("")}</ul></div></div></div>` : "";
  const repositoryAnalysis = analysis.repositoryAnalysis;
  const repositoryBlock = repositoryAnalysis?.requested ? `<div class="pf-repositories"><div class="pf-repositories-head"><div><span>READ-ONLY GITLAB</span><h4>${text("Технический контур проекта", "Project technical outline")}</h4></div><b class="${repositoryAnalysis.complete ? "ready" : "incomplete"}">${repositoryAnalysis.complete ? text("Проверен", "Verified") : text("Проверен частично", "Partially verified")}</b></div>
    ${repositoryAnalysis.repositories?.length ? `<div class="pf-repository-list">${repositoryAnalysis.repositories.map((repository) => `<div><a href="${esc(repository.url)}" target="_blank" rel="noreferrer">${esc(repository.label)}</a><small>${esc(repository.id)} · ${text("ветка", "branch")} ${esc(repository.branch || "—")}</small>${repositoryProfileMarkup(repository)}</div>`).join("")}</div>` : `<p>${text("Репозиторий не удалось подтвердить; прогноз продолжен только по Jira без предположений о стеке.", "Repository could not be verified; the forecast continued using Jira without stack assumptions.")}</p>`}
    ${repositoryAnalysis.warnings?.length ? `<ul>${repositoryAnalysis.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>` : ""}</div>` : "";
  const completenessBlock = analysis.completeness ? `<div class="pf-completeness"><span>${text("Полнота Jira", "Jira completeness")}</span><b>${analysis.completeness.score}%</b><i><u style="width:${analysis.completeness.score}%"></u></i><small>${esc(analysis.completeness.message || "")}</small></div>` : "";
  const forecastStatus = analysis.forecastStatus || { confirmed: true, label: text("Прогноз рассчитан", "Forecast calculated"), blockers: [] };
  $("#pfAnalysis").innerHTML = `<div class="pf-analysis-head"><div><span>${text("ПЕРВИЧНЫЙ СИСТЕМНЫЙ АНАЛИЗ", "INITIAL SYSTEM ANALYSIS")}</span><h3>${esc(analysis.source.key ? `${analysis.source.key} · ${analysis.source.title}` : analysis.source.title)}</h3><p>${esc(analysis.goal)}</p></div><div class="pf-analysis-total"><b class="pf-forecast-status ${forecastStatus.confirmed ? "confirmed" : "preliminary"}">${esc(forecastStatus.label)}</b><strong>${num(analysis.baseHours, 0)} ч</strong><small>${text("базовая оценка", "base estimate")} · ${text("доверие", "confidence")} ${analysis.confidence}%</small></div></div>
    ${documentStatus}${expressBlock}${repositoryBlock}<div class="pf-analysis-grid"><div><h4>${text("Выявлено", "Identified")}</h4><p>${analysis.requirements.length} ${text("требований", "requirements")} · ${analysis.workItems.length} ${text("работ", "work items")}</p><p>${analysis.technologies.length ? esc(analysis.technologies.join(", ")) : text("Технологии явно не указаны — требуется уточнение", "Technologies are not explicit — clarification required")}</p>${completenessBlock}<small>${esc(analysis.basis)}</small></div><div><h4>${text("Уточняющие вопросы", "Clarifying questions")}</h4>${analysis.questions.length ? `<ol>${analysis.questions.map((question) => `<li>${esc(question)}</li>`).join("")}</ol>` : `<p class="pf-ok">${text("Критичных открытых вопросов не выявлено", "No critical open questions")}</p>`}</div></div>`;
}

function renderReconciliation() {
  const analysis = state.analysis;
  const result = state.result;
  const reconciliation = analysis.reconciliation;
  if (!reconciliation) {
    $("#pfReconciliation").classList.add("hidden");
    return;
  }
  $("#pfReconciliation").classList.remove("hidden");
  const p50Hours = result.scopeHours * result.factors.optimistic;
  const p80Hours = result.workItems.reduce((sum, item) => sum + Number(item.forecastHours || 0), 0);
  const p90Hours = result.scopeHours * result.factors.pessimistic;
  const coverage = reconciliation.repositoryCoverage || [];
  const currentSignature = analysis.workItems.map((item) => item.sourceKey || item.title).join("|");
  const previous = state.forecastHistory.slice().reverse().find((row) => row.projectKey === analysis.source.key && row.generatedAt !== result.generatedAt);
  const historyBlock = previous ? `<div class="pf-change ${previous.scopeSignature !== currentSignature ? "scope-change" : "same-scope"}"><span>${previous.scopeSignature !== currentSignature ? text("ИЗМЕНЕНИЛСЯ SCOPE", "SCOPE CHANGED") : text("ПОВТОРНЫЙ ПРОГНОЗ ТОГО ЖЕ SCOPE", "SAME-SCOPE REFORECAST")}</span><b>${text("Базовая оценка", "Base estimate")}: ${num(previous.baseHours, 0)} → ${num(result.scopeHours, 0)} ч</b><b>P80: ${num(previous.p80Hours, 0)} → ${num(p80Hours, 0)} ч</b><small>${text("Предыдущая реалистичная дата", "Previous realistic date")}: ${formatDate(previous.realisticEnd)} → ${formatDate(result.scenarios.realistic.end)}</small></div>` : "";
  $("#pfReconciliation").innerHTML = `<div class="pf-reconciliation-head"><div><span>${text("ПРОВЕРКА АРИФМЕТИКИ", "ESTIMATE RECONCILIATION")}</span><h3>${text("Из чего получена финальная оценка", "How the final estimate was calculated")}</h3></div><strong>${num(reconciliation.totalHours, 0)} ч</strong></div>
    <div class="pf-ledger">${reconciliation.ledger.map((row) => `<div><span>${esc(row.label)}</span><b>${num(row.hours, 0)} ч</b><small>${esc(row.itemIds.join(", "))}</small></div>`).join("")}<div class="total"><span>${text("Базовый объём", "Base scope")}</span><b>${num(result.scopeHours, 0)} ч</b><small>${text("Сумма колонки «Оценка»", "Sum of the Estimate column")}</small></div></div>
    <div class="pf-formula"><div><span>P50</span><b>${num(p50Hours, 0)} ч</b><small>${num(result.scopeHours, 0)} × ${num(result.factors.optimistic, 2)}</small></div><div><span>P80</span><b>${num(p80Hours, 0)} ч</b><small>${text("Сумма персональных коэффициентов по типам работ", "Sum of per-person work-type factors")} · ×${num(result.factors.realistic, 2)}</small></div><div><span>P90</span><b>${num(p90Hours, 0)} ч</b><small>${num(result.scopeHours, 0)} × ${num(result.factors.pessimistic, 2)}</small></div></div>
    <div class="pf-coverage"><div><h4>${text("Сверка Jira ↔ GitLab", "Jira ↔ GitLab reconciliation")}</h4>${coverage.length ? `<ul>${coverage.map((row) => `<li class="${row.action}"><b>${row.action === "merged" ? text("Учтено в Jira", "Merged into Jira") : text("Добавлена новая работа", "New work added")}</b><span>${esc(row.repositoryTitle)}</span><small>${row.action === "merged" ? `${esc(row.targetKey || row.targetTitle)} · ${text("Jira", "Jira")} ${num(row.targetEstimateHours, 0)} ч / GitLab ${num(row.repositorySuggestedHours, 0)} ч · ${text("добавлено", "added")} 0 ч` : `+${num(row.addedHours, 0)} ч`}</small></li>`).join("")}</ul>` : `<p>${text("Расширенный GitLab-анализ не выполнялся.", "Extended GitLab analysis was not run.")}</p>`}</div><div><h4>${text("QA без двойного учёта", "QA without double counting")}</h4><p>${text("Целевой QA-контур", "Target QA scope")}: <b>${num(reconciliation.qa.targetHours, 0)} ч</b></p><p>${text("Уже покрыто задачами", "Already covered by work items")}: <b>${num(reconciliation.qa.coveredHours, 0)} ч</b></p><p>${text("Добавлено только непокрытое", "Only uncovered work added")}: <b>${num(reconciliation.qa.residualHours, 0)} ч</b></p></div></div>${historyBlock}`;
}

function renderResult() {
  const result = state.result;
  if (!result || !state.analysis) {
    $("#pfResult").classList.add("hidden");
    renderStaffingGaps();
    return;
  }
  $("#pfResult").classList.remove("hidden");
  renderStaffingGaps();
  const p80Hours = result.employees.reduce((sum, employee) => sum + employee.forecastHours, 0);
  const cards = [
    [text("Объём работ", "Work scope"), `${num(result.scopeHours, 0)} ч`, `${num(p80Hours, 0)} ч · P80`, "scope"],
    [text("Оптимистично · P50", "Optimistic · P50"), formatDate(result.scenarios.optimistic.end), `×${num(result.factors.optimistic, 2)}`, "optimistic"],
    [text("Реалистично · P80", "Realistic · P80"), formatDate(result.scenarios.realistic.end), `×${num(result.factors.realistic, 2)}`, "realistic"],
    [text("Пессимистично · P90", "Pessimistic · P90"), formatDate(result.scenarios.pessimistic.end), `×${num(result.factors.pessimistic, 2)}`, "pessimistic"]
  ];
  $("#pfDates").innerHTML = cards.map(([label, value, hint, cls]) => `<div class="card ${cls}"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(hint)}</small></div>`).join("");
  renderAnalysis();
  renderReconciliation();
  $("#pfWorkRows").innerHTML = result.workItems.map((item) => `<tr class="${item.staffingGap ? "staffing-gap" : ""}"><td><b>${esc(item.id)}</b>${item.sourceKey ? `<small>${esc(item.sourceKey)}</small>` : ""}</td><td><b>${esc(item.result || item.title)}</b><small>${esc(item.workPool || "")}</small>${item.questions?.length ? `<em>${esc(item.questions.join(" · "))}</em>` : ""}</td><td><span class="pf-origin ${esc(item.origin || "jira")}">${esc(item.originLabel || "Jira")}</span><small>${esc((item.evidenceSources || []).join(" + "))}</small></td><td>${esc(item.assigneeName)}${item.staffingGap ? `<small class="pf-gap-label">${text("Роль не подтверждена", "Role not covered")}</small>` : ""}</td><td>${num(item.estimateHours, 0)} ч</td><td>${num(item.forecastHours, 0)} ч<small>×${num(item.scenarioFactor, 2)}</small></td><td>${item.forecastConfidence == null ? "—" : `${num(item.forecastConfidence, 0)}%`}<small>${esc(item.calibration?.sourceLabel || "")}${item.calibration?.sample ? ` · n=${item.calibration.sample}` : ""}</small></td><td>${esc(formatDate(item.start))} — ${esc(formatDate(item.end))}</td><td>${esc(item.basis || "—")}${item.analogueKeys?.length ? `<small>${esc(item.analogueKeys.join(", "))}</small>` : ""}${item.repositoryEvidence?.length ? `<small>${text("GitLab подтверждений", "GitLab evidence")}: ${item.repositoryEvidence.length}</small>` : ""}${estimateExplanationMarkup(item)}</td></tr>`).join("");
  $("#pfActiveRows").innerHTML = state.activeProjects.map((project) => `<tr><td><b>${esc(project.key || "—")}</b><small>${esc(project.summary)}</small></td><td>${project.isBaza ? '<span class="pf-baza">BAZA</span>' : text("Обычный", "Regular")}</td><td>${esc(project.people.join(", "))}</td><td>${num(project.remainingHours, 0)} ч · ${project.taskCount} ${text("задач", "tasks")}<small>${project.inProgressTasks || 0} ${text("уже в работе", "already in progress")} · ${project.lowConfidenceTasks || 0} ${text("со слабой оценкой", "with weak estimate")}</small></td><td>${esc(project.sprints.map((sprint) => sprint.name).join(", ") || "—")}<small>${esc(project.plannedEnd ? `Planned End: ${formatDate(project.plannedEnd)}` : project.sprints.at(-1)?.end ? `до ${formatDate(project.sprints.at(-1).end)}` : "")}</small></td><td>${esc(formatDate(project.predictedEnd))}${project.spilloverHours > 0 ? `<small class="pf-gap-label">${text("Перенос", "Spillover")}: ${num(project.spilloverHours, 0)} ч</small>` : `<small>${text("В границах плана", "Within plan")}</small>`}${project.criticalPressureHours > 0 ? `<small>${text("Давление на критический путь", "Critical-path pressure")}: ${num(project.criticalPressureHours, 0)} ч</small>` : project.parallelWithProject ? `<small>${text("Идёт параллельно без прямого сдвига критического пути", "Runs in parallel without a direct critical-path shift")}</small>` : ""}</td></tr>`).join("") || `<tr><td colspan="6">${text("У выбранных сотрудников нет активных задач, влияющих на календарь.", "Selected employees have no active issues affecting the calendar.")}</td></tr>`;
  const criticalTitles = (result.portfolio?.criticalPath || []).map((id) => result.workItems.find((item) => item.id === id)?.title || id);
  const sensitivity = result.portfolio?.resourceSensitivity || [];
  const strongestSensitivity = sensitivity[0];
  $("#pfCriticalPath").innerHTML = `${criticalTitles.length
    ? `${text("Критический путь нового проекта", "New project critical path")}: <b>${esc(criticalTitles.join(" → "))}</b>`
    : text("Критический путь не определён.", "Critical path is not available.")}<br><span>${text("Влияние текущего портфеля на P80", "Current portfolio impact on P80")}: <b>+${num(result.portfolio?.portfolioDelayDays || 0, 0)} ${text("раб. дн.", "workdays")}</b>${result.portfolio?.endWithoutPortfolio ? ` · ${text("дата при свободной команде", "date with a free team")} ${formatDate(result.portfolio.endWithoutPortfolio)}` : ""}</span>${strongestSensitivity ? `<br><span>${text("What-if", "What-if")}: ${esc(strongestSensitivity.name)} — ${text("высвобождение 25% текущей нагрузки", "release 25% of current load")} → ${formatDate(strongestSensitivity.projectedEnd)} (${text("выигрыш", "gain")} ${num(strongestSensitivity.savedWorkdays, 0)} ${text("раб. дн.", "workdays")})</span>` : ""}`;
  $("#pfCapacityRows").innerHTML = (result.portfolio?.capacity || []).map((row) => `<tr><td><b>${esc(row.name)}</b><small>${row.utilizationPercent}% ${text("занято активными эпиками", "occupied by active epics")} · ${row.totalUtilizationPercent}% ${text("с новым проектом", "with new project")}</small></td><td>${num(row.capacityHours, 0)} ч</td><td>${row.activeEpicCount}<small>${esc(row.activeEpics.join(", ") || "—")}</small></td><td>${num(row.occupiedHours, 0)} ч</td><td>${num(row.projectHours, 0)} ч</td><td>${num(row.freeHours, 0)} ч</td></tr>`).join("");
  const confirmed = state.analysis.forecastStatus?.confirmed !== false;
  $("#pfJiraDraft").innerHTML = `<div><span>${confirmed ? text("РЕКОМЕНДУЕМЫЕ ПОЛЯ JIRA", "RECOMMENDED JIRA FIELDS") : text("ПРЕДВАРИТЕЛЬНЫЕ ПОЛЯ — ЕСТЬ БЛОКЕРЫ", "PRELIMINARY FIELDS — BLOCKERS EXIST")}</span><h3>${esc(state.analysis.source.title)}</h3><p>${confirmed ? text("Прогноз прошёл контроль полноты, ролей и технических источников.", "The forecast passed completeness, staffing and technical-source checks.") : text("Значения можно использовать для ориентира, но фиксировать как обязательство пока нельзя.", "Values may be used as guidance but should not yet be committed.")}</p></div><dl><div><dt>Initial Estimate</dt><dd>${num(result.scopeHours, 0)}h</dd></div><div><dt>Planned Start</dt><dd>${esc(result.scenarios.realistic.start || "—")}</dd></div><div><dt>Planned End</dt><dd>${esc(result.scenarios.realistic.end || "—")}</dd></div></dl>`;
  $("#pfEmployeeRows").innerHTML = result.employees.map((employee) => `<tr><td>${esc(employee.name)}</td><td>${num(employee.estimatedHours, 0)}</td><td>${num(employee.forecastHours, 0)}</td><td>${employee.score == null ? "—" : `${num(employee.score, 0)}/100`}<small>${text("доверие", "confidence")} ${employee.confidence == null ? "—" : num(employee.confidence, 0)}</small></td><td>${employee.estimateRatio == null ? "—" : `×${num(employee.estimateRatio, 2)}`}</td><td>${employee.specializedFactor == null ? "—" : `×${num(employee.specializedFactor, 2)}`}</td><td>×${num(employee.multitaskingFactor || 1, 2)}<small>${employee.multitaskingConfidence ? `${text("доверие", "confidence")} ${employee.multitaskingConfidence}%` : text("нет достаточной истории", "insufficient history")}</small></td><td>${employee.vacationDays}</td></tr>`).join("");
  const backtest = state.analysis.calibration?.backtest;
  const portfolioBacktest = result.portfolio?.backtest;
  const blockers = state.analysis.forecastStatus?.blockers || [];
  const warnings = [...blockers, ...(state.context?.warnings || []), ...(state.analysis.repositoryAnalysis?.warnings || []), ...result.warnings];
  const drift = portfolioBacktest?.drift;
  const driftText = [drift?.effort?.alert ? `${text("дрейф трудоёмкости", "effort drift")} ${drift.effort.changePercent > 0 ? "+" : ""}${drift.effort.changePercent}%` : "", drift?.duration?.alert ? `${text("дрейф сроков", "schedule drift")} ${drift.duration.changePercent > 0 ? "+" : ""}${drift.duration.changePercent}%` : ""].filter(Boolean).join(" · ");
  $("#pfEvidence").innerHTML = `<h3>${text("Основание и качество прогноза", "Forecast evidence and quality")}</h3><div class="pf-facts"><span>${text("Исторических задач", "Historical issues")} <b>${state.context?.history.length || 0}</b></span><span>${text("Plan/fact для калибровки", "Plan/fact calibration sample")} <b>${state.analysis.calibration?.historicalTasks || 0}</b></span><span>${text("Активных задач Jira", "Active Jira issues")} <b>${result.workloadCount}</b></span><span>${text("Активных эпиков", "Active epics")} <b>${state.activeProjects.length}</b></span><span>${text("Отпусков Jira", "Jira vacations")} <b>${result.vacationIssueCount}</b></span></div>${backtest?.sample ? `<div class="pf-backtest"><span>${text("Backtest задач", "Issue backtest")}</span><b>WAPE ${num(backtest.wape * 100, 0)}%</b><b>${text("смещение", "bias")} ×${num(backtest.bias, 2)}</b><b>P80 ${num(backtest.coverage?.p80 * 100, 0)}%</b><small>${backtest.sample} ${text("последовательных прогнозов без использования будущих данных", "sequential forecasts without future data")}</small></div>` : `<p class="pf-muted">${text("Для backtest задач пока недостаточно последовательных plan/fact.", "There are not enough sequential issue plan/fact records for backtesting.")}</p>`}${portfolioBacktest?.sample ? `<div class="pf-backtest ${driftText ? "has-drift" : ""}"><span>${text("Backtest завершённых инициатив", "Completed-initiative backtest")}</span><b>${text("часы WAPE", "hours WAPE")} ${num(portfolioBacktest.effort?.wape * 100, 0)}%</b><b>${text("даты MAE", "date MAE")} ${num(portfolioBacktest.dates?.maeDays, 1)} ${text("раб. дн.", "workdays")}</b><b>P80 ${text("часы", "hours")} ${num(portfolioBacktest.effort?.coverage?.p80 * 100, 0)}% · ${text("даты", "dates")} ${num(portfolioBacktest.dates?.coverage?.p80 * 100, 0)}%</b><small>${portfolioBacktest.sample} ${text("последовательных инициатив; используются только данные, завершённые до старта проверяемой инициативы", "sequential initiatives; only data completed before the evaluated initiative starts is used")}${driftText ? ` · ${esc(driftText)}` : ""}</small></div>` : `<p class="pf-muted">${text("Для backtest инициатив недостаточно завершённых непересекающихся инициатив с оценками.", "There are not enough completed non-overlapping estimated initiatives for backtesting.")}</p>`}${warnings.length ? `<h4>${text("Ограничения", "Limitations")}</h4><ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>` : `<p class="pf-ok">${text("Критичных ограничений данных не обнаружено", "No critical data limitations detected")}</p>`}`;
}

async function calculate() {
  const selected = state.people.filter((person) => state.selected.has(person.id));
  const form = readForm();
  if (!selected.length) return progress(text("Выберите хотя бы одного сотрудника", "Select at least one employee"), "error");
  if (!String(form.source || "").trim()) return progress(text("Укажите источник требований Jira или Confluence", "Specify Jira or Confluence requirements"), "error");
  const button = $("#pfCalculate");
  button.disabled = true;
  try {
    await context.ensurePermission();
    await persistDraft();
    const historyMonths = Number(form.historyMonths || 3);
    const evaluation = await planningModule.run({
      project: form.source,
      businessRequirements: form.businessRequirements,
      systemAnalysis: form.systemAnalysis,
      expressAnalysis: form.expressAnalysis,
      teams: state.teams.length ? state.teams : deriveTeams(state.people),
      people: selected,
      historyFrom: monthsAgo(historyMonths),
      historyTo: today(),
      planningStart: form.planningStart,
      unknownPercent: Number(form.unknownPercent || 0),
      projectIsBaza: form.projectIsBaza,
      onProgress: (message) => progress(message)
    });
    state.source = evaluation.source;
    state.context = evaluation.context;
    state.analysis = evaluation.analysis;
    state.result = evaluation.result;
    state.activeProjects = evaluation.activeProjects;
    const minimumReserve = Number(form.unknownPercent || 0);
    state.result.appliedUnknownPercent = minimumReserve;
    const p80Hours = state.result.workItems.reduce((sum, item) => sum + Number(item.forecastHours || 0), 0);
    const snapshot = {
      generatedAt: state.result.generatedAt,
      projectKey: state.analysis.source.key,
      scopeSignature: state.analysis.workItems.map((item) => item.sourceKey || item.title).join("|"),
      baseHours: state.result.scopeHours,
      p50Hours: Number((state.result.scopeHours * state.result.factors.optimistic).toFixed(1)),
      p80Hours: Number(p80Hours.toFixed(1)),
      p90Hours: Number((state.result.scopeHours * state.result.factors.pessimistic).toFixed(1)),
      realisticEnd: state.result.scenarios.realistic.end,
      confidence: state.analysis.confidence,
      status: state.analysis.forecastStatus?.code || "legacy",
      selectedIds: [...state.selected]
    };
    state.forecastHistory = [...state.forecastHistory, snapshot].slice(-30);
    await Promise.all([
      db.metaSet("projectForecastResult", { analysis: state.analysis, result: state.result, activeProjects: state.activeProjects }),
      db.metaSet("projectForecastHistory", state.forecastHistory)
    ]);
    renderResult();
    progress(text(`Готово: ${state.result.scopeHours} человеко-часов, реалистичная дата ${formatDate(state.result.scenarios.realistic.end)}`, `Done: ${state.result.scopeHours} person-hours, realistic date ${formatDate(state.result.scenarios.realistic.end)}`), state.analysis.forecastStatus?.confirmed && !state.result.warnings.length ? "ok" : "warn");
  } catch (error) {
    progressError(error);
  } finally {
    button.disabled = false;
  }
}

function bind() {
  $("#pfSettings").onclick = () => document.querySelector('[data-tab="settings"]').click();
  $("#pfLoadRoster").onclick = loadRoster;
  $("#pfSearch").oninput = renderPeople;
  $("#pfSelectVisible").onclick = () => { visiblePeople().forEach((person) => state.selected.add(person.id)); renderPeople(); invalidateForecast(text("Состав изменён — пересчитайте прогноз", "Staffing changed — recalculate the forecast")); persistDraft().catch(() => {}); };
  $("#pfClear").onclick = () => { state.selected.clear(); renderPeople(); invalidateForecast(text("Состав очищен", "Staffing cleared")); persistDraft().catch(() => {}); };
  $("#pfCalculate").onclick = calculate;
  root.querySelectorAll(".pf-scope input:not(#pfExpressAnalysis), .pf-scope select").forEach((input) => input.onchange = () => {
    persistDraft().catch(() => {});
    invalidateForecast(text("Параметры изменены — пересчитайте прогноз", "Parameters changed — recalculate the forecast"));
  });
  $("#pfExpressAnalysis").onchange = async () => {
    await persistDraft();
    invalidateForecast(text("Режим анализа изменён — пересчитайте прогноз", "Analysis mode changed — recalculate the forecast"));
    if (!$("#pfExpressAnalysis").checked) return;
    progress(text(
      "Расширенный анализ включён: связанные с Jira/Confluence GitLab-репозитории будут прочитаны без изменений",
      "Extended analysis enabled: GitLab repositories linked from Jira/Confluence will be read without changes"
    ), "ok");
  };
}

async function readLocal() {
  const [people, draft, saved, forecastHistory] = await Promise.all([
    db.all(db.STORES.pfRoster), db.metaGet("projectForecastDraft"), db.metaGet("projectForecastResult"), db.metaGet("projectForecastHistory")
  ]);
  state.people = people;
  state.teams = deriveTeams(people);
  state.draft = draft;
  state.selected = new Set(draft?.selectedIds || []);
  state.forecastHistory = Array.isArray(forecastHistory) ? forecastHistory : [];
  if (saved?.analysis && saved?.result) {
    state.analysis = saved.analysis;
    state.result = saved.result;
    state.activeProjects = saved.activeProjects || [];
  }
}

export async function init(container, options) {
  root = container;
  context = options;
  await readLocal();
  shell(); bind(); renderPeople(); renderResult();
  initialized = true;
}

export async function open() {
  if (!initialized) return;
  const baseUrl = String(settings.get().baseUrl || "").trim().replace(/\/+$/, "");
  if (shellLanguage !== getLang() || shellBaseUrl !== baseUrl) {
    state.draft = readForm();
    shell(); bind(); renderPeople(); renderResult();
  }
}
