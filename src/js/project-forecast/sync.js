// Read-only загрузка данных для прогноза: Tempo roster, Jira history, workload и отпуска.
import * as db from "../db.js";
import * as jira from "../jira.js";
import * as settings from "../settings.js";
import * as tempo from "../people-tempo.js";
import { analyze } from "../people-metrics.js";
import { buildPeriodQueries, issueTouchesPeriod, mapIssue } from "../people-analysis-sync.js";
import { normalizeIdentity, samePerson } from "./domain.js";
import { jiraDependencyKeys } from "./jira-links.js";
import { resolveFields } from "./jira-fields.js";

export { resolveFields } from "./jira-fields.js";

const USER_CHUNK = 30;
const DETAIL_CONCURRENCY = 6;

const chunks = (items, size) => {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
};

const quoted = (value) => `"${jira.escapeJql(value)}"`;

function identity(member) {
  return normalizeIdentity(member.accountId || member.username || member.key || member.displayName || member.id);
}

function aliases(member) {
  return [member.accountId, member.username, member.key, member.displayName].map(normalizeIdentity).filter(Boolean);
}

export function mergeRoster(members) {
  const people = new Map();
  for (const member of members || []) {
    const key = identity(member);
    if (!key) continue;
    if (!people.has(key)) {
      people.set(key, {
        id: `person::${key}`,
        accountId: member.accountId || "",
        username: member.username || "",
        key: member.key || "",
        displayName: member.displayName || member.username || member.key || "",
        avatarUrl: member.avatarUrl || "",
        teamIds: [],
        teamNames: [],
        roles: [],
        skills: [],
        grade: "",
        commitment: 0,
        aliases: [],
        memberships: []
      });
    }
    const person = people.get(key);
    person.memberships.push(member);
    if (member.teamId && !person.teamIds.includes(member.teamId)) person.teamIds.push(member.teamId);
    if (member.teamName && !person.teamNames.includes(member.teamName)) person.teamNames.push(member.teamName);
    for (const role of String(member.role || "").split(",").map((row) => row.trim()).filter(Boolean)) {
      if (!person.roles.includes(role)) person.roles.push(role);
    }
    for (const skill of member.skills || []) if (skill && !person.skills.includes(skill)) person.skills.push(skill);
    person.grade ||= member.grade || "";
    person.commitment = Math.min(100, person.commitment + Math.max(0, Number(member.commitment || 0)));
    person.aliases = [...new Set([...person.aliases, ...aliases(member)])];
  }
  return [...people.values()].sort((left, right) => left.displayName.localeCompare(right.displayName, "ru"));
}

export async function loadRoster(onProgress) {
  onProgress?.("Tempo: загружаю активные команды");
  const teams = await tempo.activeTeams();
  if (!teams.length) throw new Error("Tempo не вернул активных команд");
  onProgress?.(`Tempo: загружаю сотрудников ${teams.length} команд`);
  const roster = await tempo.activeRoster(teams, (done, total) => onProgress?.(`Tempo: составы команд — ${done}/${total}`));
  const people = mergeRoster(roster.members);
  if (!people.length) throw new Error("Tempo не вернул активных сотрудников");
  await db.clear(db.STORES.pfRoster);
  await db.putAll(db.STORES.pfRoster, people);
  await db.metaSet("projectForecastRoster", {
    at: Date.now(),
    teamCount: teams.length,
    peopleCount: people.length,
    warnings: roster.warnings
  });
  return { teams, people, memberships: roster.members, warnings: roster.warnings };
}

async function parallel(items, limit, worker, onProgress) {
  const out = new Array(items.length);
  let cursor = 0;
  let completed = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      out[index] = await worker(items[index]);
      completed += 1;
      onProgress?.(completed, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

function embeddedWorklogs(issue) {
  const page = issue.fields?.worklog;
  const rows = Array.isArray(page) ? page : page?.worklogs || [];
  const total = Array.isArray(page) ? rows.length : Number(page?.total ?? rows.length);
  return { rows, needsFull: Number(issue.fields?.timespent || 0) > 0 && total > rows.length };
}

async function loadHistory(users, from, to, fields, sprintField, epicLinkField, onProgress, warnings) {
  const rawByKey = new Map();
  const jobs = chunks(users, USER_CHUNK).flatMap((group) => buildPeriodQueries(group, from, to));
  await parallel(jobs, 3, async (job) => {
    try {
      const rows = await jira.searchExpanded(`${job.jql} ORDER BY updated DESC`, fields, (loaded, total) =>
        onProgress?.(`Jira: ${job.label} — ${loaded}/${total}`));
      rows.forEach((issue) => rawByKey.set(issue.key, issue));
    } catch (error) {
      if (job.fallbackJql) {
        warnings.push(`История назначений недоступна: ${error.message}`);
        const rows = await jira.searchExpanded(`${job.fallbackJql} ORDER BY updated DESC`, fields);
        rows.forEach((issue) => rawByKey.set(issue.key, issue));
      } else if (job.required) {
        throw error;
      } else {
        warnings.push(`${job.label}: ${error.message}`);
      }
    }
  });

  const raw = [...rawByKey.values()];
  const details = await parallel(raw, DETAIL_CONCURRENCY, async (issue) => {
    const embedded = embeddedWorklogs(issue);
    if (!embedded.needsFull) return embedded.rows;
    try {
      return await jira.issueWorklogs(issue.key);
    } catch (error) {
      warnings.push(`${issue.key} worklog: ${error.message}`);
      return embedded.rows;
    }
  }, (done, total) => onProgress?.(`Jira: проверяю worklog — ${done}/${total}`));

  return raw
    .map((issue, index) => ({
      ...mapIssue(issue, sprintField, details[index]),
      epicKey: String(customValue(issue.fields || {}, epicLinkField)?.key || customValue(issue.fields || {}, epicLinkField) || "")
    }))
    .filter((issue) => issueTouchesPeriod(issue, from, to));
}

function sprintWindow(sprints) {
  const rows = (sprints || []).slice();
  const today = new Date().toISOString().slice(0, 10);
  const sprint = rows.find((item) => /active/i.test(item.state || ""))
    || rows.filter((item) => !/closed/i.test(item.state || "") && (!item.endDate || item.endDate >= today))
      .sort((left, right) => String(left.startDate || "9999").localeCompare(String(right.startDate || "9999")))[0]
    || rows.sort((left, right) => String(right.endDate || "").localeCompare(String(left.endDate || "")))[0];
  return { start: sprint?.startDate || "", end: sprint?.endDate || "", sprint };
}

function userOf(raw) {
  return raw ? {
    accountId: raw.accountId || "",
    username: raw.name || raw.username || "",
    key: raw.key || "",
    displayName: raw.displayName || raw.name || ""
  } : null;
}

function customValue(fields, id) {
  if (!id) return "";
  const value = fields[id];
  if (value && typeof value === "object" && !Array.isArray(value)) return value.value || value.name || value.key || value.id || "";
  return value || "";
}

function mapPlanningIssue(raw, resolvedFields, hoursPerDay) {
  const fields = raw.fields || {};
  const sprintMapped = mapIssue(raw, resolvedFields.sprint, []).sprints;
  const sprint = sprintWindow(sprintMapped);
  const epicValue = customValue(fields, resolvedFields.epicLink);
  const epicKey = typeof epicValue === "string" ? epicValue : epicValue?.key || "";
  const labels = fields.labels || [];
  const estimateSeconds = Number(fields.timeoriginalestimate || 0);
  const remainingSeconds = Number(fields.timeestimate || 0);
  const timeSpentSeconds = Number(fields.timespent || 0);
  return {
    key: raw.key,
    summary: fields.summary || "",
    description: fields.description || "",
    created: fields.created || "",
    status: fields.status?.name || "",
    statusCategory: fields.status?.statusCategory?.key || fields.status?.statusCategory?.name || "",
    type: fields.issuetype?.name || "",
    priority: fields.priority?.name || "",
    assignee: userOf(fields.assignee),
    projectKey: fields.project?.key || "",
    labels,
    components: (fields.components || []).map((item) => item.name || item.value).filter(Boolean),
    epicKey,
    sprints: sprintMapped,
    sprintId: sprint.sprint?.id || "",
    estimateDays: estimateSeconds > 0 ? estimateSeconds / 3600 / hoursPerDay : 0,
    remainingDays: remainingSeconds > 0 ? remainingSeconds / 3600 / hoursPerDay : 0,
    originalHours: estimateSeconds / 3600,
    remainingHours: remainingSeconds / 3600,
    timeSpentHours: timeSpentSeconds / 3600,
    dependsOnKeys: jiraDependencyKeys(fields.issuelinks),
    updated: fields.updated || "",
    plannedStart: customValue(fields, resolvedFields.plannedStart),
    plannedEnd: customValue(fields, resolvedFields.plannedEnd) || fields.duedate || "",
    sprintStart: sprint.start,
    sprintEnd: sprint.end,
    isBaza: labels.some((label) => String(label).toUpperCase() === "BAZA")
  };
}

async function loadCurrent(users, resolvedFields, hoursPerDay, onProgress, warnings) {
  const baseFields = [
    "summary", "description", "assignee", "project", "issuetype", "priority", "status", "resolution", "labels", "components", "duedate", "created", "updated", "issuelinks",
    "timeoriginalestimate", "timeestimate", "timespent", resolvedFields.sprint, resolvedFields.epicLink,
    resolvedFields.plannedStart, resolvedFields.plannedEnd
  ].filter(Boolean);
  const workload = new Map();
  const vacations = new Map();
  const cachedEpics = await db.all(db.STORES.epics);
  const epicMeta = new Map(cachedEpics.map((epic) => [epic.key, {
    key: epic.key,
    summary: epic.summary || "",
    labels: epic.labels || [],
    plannedStart: epic.plannedStart || "",
    plannedEnd: epic.plannedEnd || epic.dueDate || ""
  }]));
  const bazaEpics = new Set(cachedEpics.filter((epic) => (epic.labels || []).some((label) => String(label).toUpperCase() === "BAZA")).map((epic) => epic.key));
  const refreshedEpics = new Set();

  for (const group of chunks(users, USER_CHUNK)) {
    const list = group.map(quoted).join(",");
    const workloadJql = `assignee in (${list}) AND resolution = EMPTY ORDER BY updated DESC`;
    const vacationJql = `assignee in (${list}) AND summary ~ "Отпуск" ORDER BY created ASC`;
    const [openRows, vacationRows] = await Promise.all([
      jira.search(workloadJql, baseFields, (loaded, total) => onProgress?.(`Jira: активная нагрузка — ${loaded}/${total}`)),
      jira.search(vacationJql, baseFields, (loaded, total) => onProgress?.(`Jira: отпуска — ${loaded}/${total}`)).catch((error) => {
        warnings.push(`Отпуска Jira: ${error.message}`);
        return [];
      })
    ]);
    const mappedOpen = openRows.map((issue) => mapPlanningIssue(issue, resolvedFields, hoursPerDay));
    const epicKeysToRefresh = [...new Set(mappedOpen.map((issue) => issue.epicKey).filter((key) => key && !refreshedEpics.has(key)))];
    epicKeysToRefresh.forEach((key) => refreshedEpics.add(key));
    const epicPages = await parallel(chunks(epicKeysToRefresh, 80), 3, async (epicKeys) => {
      try {
        return await jira.search(`key in (${epicKeys.map(quoted).join(",")})`, ["summary", "labels", "duedate", resolvedFields.plannedStart, resolvedFields.plannedEnd].filter(Boolean));
      } catch (error) {
        warnings.push(`Метаданные активных эпиков: ${error.message}`);
        return [];
      }
    });
    for (const epics of epicPages) {
      for (const epic of epics || []) {
        const labels = epic.fields?.labels || [];
        epicMeta.set(epic.key, {
          key: epic.key,
          summary: epic.fields?.summary || epic.key,
          labels,
          plannedStart: customValue(epic.fields || {}, resolvedFields.plannedStart),
          plannedEnd: customValue(epic.fields || {}, resolvedFields.plannedEnd) || epic.fields?.duedate || ""
        });
        if (labels.some((label) => String(label).toUpperCase() === "BAZA")) bazaEpics.add(epic.key);
        else bazaEpics.delete(epic.key);
      }
    }
    let unscheduled = 0;
    for (const issue of mappedOpen) {
      const epic = epicMeta.get(issue.epicKey) || {};
      issue.epicSummary = epic.summary || "";
      issue.epicLabels = epic.labels || [];
      issue.epicPlannedStart = epic.plannedStart || "";
      issue.epicPlannedEnd = epic.plannedEnd || "";
      issue.isBaza ||= bazaEpics.has(issue.epicKey);
      if (/cancel|отмен/i.test(issue.status)) continue;
      const scheduled = issue.plannedStart || issue.plannedEnd || issue.sprintStart || issue.sprintEnd || issue.epicPlannedStart || issue.epicPlannedEnd;
      if (!scheduled && !issue.isBaza) {
        unscheduled += 1;
      }
      issue.scheduled = Boolean(scheduled);
      workload.set(issue.key, issue);
    }
    if (unscheduled) warnings.push(`Найдено задач бэклога без Sprint и Planned Start/End: ${unscheduled}; они показаны как риск, но не блокируют календарь.`);
    vacationRows.forEach((issue) => vacations.set(issue.key, mapPlanningIssue(issue, resolvedFields, hoursPerDay)));
  }
  for (const key of vacations.keys()) workload.delete(key);
  return { workload: [...workload.values()], vacations: [...vacations.values()], epics: [...epicMeta.values()] };
}

function localAssignee(issue) {
  return {
    key: issue.assigneeKey || "",
    username: issue.assigneeLogin || "",
    displayName: issue.assigneeName || ""
  };
}

function localIssueDone(issue, doneStatuses) {
  return String(issue.statusCategory || "").toLowerCase() === "done" || doneStatuses.has(normalizeIdentity(issue.statusName));
}

export async function loadActiveProjects(people, hoursPerDay = 8) {
  const [epics, issues, others, sprints] = await Promise.all([
    db.all(db.STORES.epics), db.all(db.STORES.issues), db.all(db.STORES.others), db.all(db.STORES.sprints)
  ]);
  const selected = (people || []).filter(Boolean);
  const doneStatuses = new Set(String(settings.get().doneStatuses || "").split(",").map(normalizeIdentity).filter(Boolean));
  const epicByKey = new Map(epics.map((epic) => [epic.key, epic]));
  const sprintById = new Map(sprints.map((sprint) => [Number(sprint.id), sprint]));
  const groups = new Map();
  for (const issue of [...issues, ...others]) {
    const employee = selected.find((person) => samePerson(person, localAssignee(issue)));
    if (!employee || localIssueDone(issue, doneStatuses)) continue;
    const epicKey = issue.epicKey || "";
    const epic = epicByKey.get(epicKey) || {};
    const key = epicKey || `${issue.projectKey || "JIRA"}::no-epic`;
    if (!groups.has(key)) groups.set(key, {
      key: epicKey,
      summary: epic.summary || issue.epicSummary || "Задачи без эпика",
      labels: epic.labels || [],
      isBaza: (epic.labels || []).some((label) => String(label).toUpperCase() === "BAZA"),
      plannedStart: epic.plannedStart || "",
      plannedEnd: epic.plannedEnd || epic.dueDate || "",
      taskCount: 0,
      remainingHours: 0,
      people: new Set(),
      sprints: new Map()
    });
    const group = groups.get(key);
    const estimateSeconds = Number(issue.remainingEstimate || 0) || Number(issue.originalEstimate || 0);
    group.taskCount += 1;
    group.remainingHours += estimateSeconds > 0 ? estimateSeconds / 3600 : Number(hoursPerDay || 8);
    group.people.add(employee.displayName || employee.username || employee.id);
    const sprint = sprintById.get(Number(issue.sprintId));
    if (sprint) group.sprints.set(sprint.id, { id: sprint.id, name: sprint.name || `#${sprint.id}`, start: sprint.startDate || "", end: sprint.endDate || "", state: sprint.state || "" });
  }
  return [...groups.values()].map((group) => ({
    ...group,
    remainingHours: Math.round(group.remainingHours),
    people: [...group.people],
    sprints: [...group.sprints.values()].sort((left, right) => String(left.start).localeCompare(String(right.start)))
  })).sort((left, right) => Number(right.isBaza) - Number(left.isBaza) || String(left.plannedEnd || "9999").localeCompare(String(right.plannedEnd || "9999")));
}

export async function loadContext({ teams, people, from, to, onProgress }) {
  const selected = (people || []).filter(Boolean);
  if (!selected.length) throw new Error("Выберите сотрудников");
  const memberships = selected.flatMap((person) => person.memberships || []);
  const users = [...new Set(selected.map((person) => person.username || person.key || person.accountId).filter(Boolean))];
  if (!users.length) throw new Error("Tempo не передал Jira-логины выбранных сотрудников");

  const current = settings.get();
  const resolvedFields = await resolveFields();
  const historyFields = [
    "summary", "assignee", "reporter", "issuetype", "priority", "status", "resolution", "project",
    "created", "resolutiondate", "updated", "timeoriginalestimate", "timeestimate", "timespent", "worklog",
    "labels", "components", "fixVersions", resolvedFields.sprint, resolvedFields.epicLink
  ].filter(Boolean);
  const warnings = [];
  onProgress?.(`Jira: история сотрудников за ${from}–${to}`);
  const [history, currentData] = await Promise.all([
    loadHistory(users, from, to, historyFields, resolvedFields.sprint, resolvedFields.epicLink, onProgress, warnings),
    loadCurrent(users, resolvedFields, current.hoursPerDay, onProgress, warnings)
  ]);

  const analytics = analyze(teams, memberships, history, {
    ...current.peopleAnalysis,
    doneStatuses: current.doneStatuses
  }, { from, to });
  const metrics = new Map(analytics.employees.map((employee) => [employee.id, employee]));
  const employees = selected.map((person) => {
    const metric = metrics.get(person.id);
    return {
      ...person,
      score: metric?.score ?? null,
      confidence: metric?.confidence ?? null,
      estimateRatio: metric?.estimate?.medianRatio ?? null,
      completed: metric?.closed || 0
    };
  });

  await db.clear(db.STORES.pfWorkload);
  await db.clear(db.STORES.pfVacations);
  await db.putAll(db.STORES.pfWorkload, currentData.workload);
  await db.putAll(db.STORES.pfVacations, currentData.vacations);
  await db.metaSet("projectForecastContext", {
    at: Date.now(), from, to, employeeIds: employees.map((employee) => employee.id),
    historyCount: history.length, workloadCount: currentData.workload.length,
    vacationCount: currentData.vacations.length, warnings
  });
  return { ...currentData, employees, history, warnings: [...new Set(warnings)] };
}
