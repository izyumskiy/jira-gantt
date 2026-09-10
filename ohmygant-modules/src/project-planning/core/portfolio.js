// Чистая модель портфеля: остатки активных задач, многозадачность
// и распределение существующих эпиков внутри спринтов.
import { addDays, dateKey, daysBetween, isWorkingDay, parseDate } from "./calendar.js";
import { samePerson } from "./identity.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const median = (values) => quantile(values, 0.5);
const uniq = (values) => [...new Set(values.filter(Boolean))];

function quantile(values, percentile) {
  const rows = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!rows.length) return null;
  const position = (rows.length - 1) * clamp(percentile, 0, 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? rows[low] : rows[low] + (rows[high] - rows[low]) * (position - low);
}

function actualHours(issue) {
  const worklogs = (issue.worklogs || []).reduce((sum, row) => sum + Number(row.timeSpentSeconds || 0), 0);
  return (worklogs || Number(issue.timeSpentSeconds || issue.timeSpentHours * 3600 || 0)) / 3600;
}

function employeeFor(actor, employees) {
  return employees.find((employee) => samePerson(employee, actor || {}));
}

function statusProgress(issue) {
  const status = `${issue.statusCategory || ""} ${issue.status || ""}`.toLocaleLowerCase("ru-RU");
  if (/done|готов|закры|resolved|выполн/.test(status)) return 0;
  if (/review|ревью|тест|qa|прием|sign off/.test(status)) return 0.25;
  if (/progress|работ|разработ|doing|implement/.test(status)) return 0.55;
  return 1;
}

function issueWords(issue) {
  return new Set(`${issue.summary || ""} ${(issue.components || []).join(" ")}`
    .toLocaleLowerCase("ru-RU").replace(/ё/g, "е").split(/[^a-zа-я0-9+#.]+/i).filter((word) => word.length >= 4));
}

function similarity(left, right) {
  let score = left.type && left.type === right.type ? 3 : 0;
  const leftComponents = new Set(left.components || []);
  score += (right.components || []).filter((item) => leftComponents.has(item)).length * 2;
  const words = issueWords(left);
  score += [...issueWords(right)].filter((word) => words.has(word)).length;
  return score;
}

function analogueHours(issue, history, employees) {
  const employee = employeeFor(issue.assignee, employees);
  const candidates = (history || []).map((row) => {
    const hours = actualHours(row);
    if (!(hours > 0) || (employee && !samePerson(employee, row.assignee || {}))) return null;
    return { hours, score: similarity(issue, row), key: row.key || "" };
  }).filter(Boolean).sort((left, right) => right.score - left.score);
  const personal = candidates.filter((row) => row.score >= 3).slice(0, 12);
  const sample = personal.length >= 3 ? personal : candidates.slice(0, 12);
  const values = sample.map((row) => row.hours);
  return { sample: values.length, p50: median(values), p80: quantile(values, 0.8), p90: quantile(values, 0.9), keys: sample.slice(0, 5).map((row) => row.key) };
}

function isInProgress(issue) {
  const status = `${issue.statusCategory || ""} ${issue.status || ""}`.toLocaleLowerCase("ru-RU");
  return /indeterminate|progress|работ|разработ|review|ревью|тест|qa|прием|doing/.test(status);
}

export function calibrateWorkload(workload = [], history = [], employees = [], hoursPerDay = 8) {
  const warnings = [];
  const rows = workload.map((issue) => {
    const explicitRemaining = Number(issue.remainingHours || 0) || Number(issue.remainingDays || 0) * hoursPerDay;
    const original = Number(issue.originalHours || 0) || Number(issue.estimateDays || 0) * hoursPerDay;
    const spent = Number(issue.timeSpentHours || 0);
    const employee = employeeFor(issue.assignee, employees);
    const ratio = clamp(employee?.estimateRatio || 1, 0.7, 2.5);
    const analogues = analogueHours(issue, history, employees);
    let remainingHours = 0;
    let remainingSource = "";
    let remainingConfidence = 0;
    const staleRemaining = explicitRemaining > 0 && original > 0 && spent > 0 && Math.abs(explicitRemaining - original) < 0.1;
    if (staleRemaining && original > spent) {
      remainingHours = (original - spent) * ratio;
      remainingSource = "Initial Estimate − Time Spent; Remaining Estimate не обновлялся";
      remainingConfidence = 60;
      warnings.push(`${issue.key || issue.summary}: Remaining Estimate совпадает с Initial Estimate после списания времени; использован расчётный остаток.`);
    } else if (explicitRemaining > 0) {
      remainingHours = explicitRemaining * Math.sqrt(ratio);
      remainingSource = "Jira Remaining Estimate";
      remainingConfidence = 90;
    } else if (original > 0 && original > spent) {
      remainingHours = (original - spent) * ratio;
      remainingSource = spent > 0 ? "Initial Estimate − Time Spent" : "Jira Initial Estimate";
      remainingConfidence = spent > 0 ? 80 : 70;
    } else if (analogues.p50 > 0) {
      remainingHours = analogues.p50 * statusProgress(issue);
      remainingSource = `${analogues.sample} исторических аналогов`;
      remainingConfidence = clamp(35 + analogues.sample * 5, 40, 70);
    } else {
      remainingHours = hoursPerDay * (isInProgress(issue) ? 1.5 : 2);
      remainingSource = "Норматив без исторических аналогов";
      remainingConfidence = 15;
      warnings.push(`${issue.key || issue.summary}: нет Jira-оценки и исторических аналогов.`);
    }
    remainingHours = Math.max(0, remainingHours);
    const empiricalP80 = analogues.p50 > 0 ? analogues.p80 / analogues.p50 : null;
    const empiricalP90 = analogues.p50 > 0 ? analogues.p90 / analogues.p50 : null;
    const fallbackSpread = remainingConfidence >= 80 ? 0.15 : remainingConfidence >= 50 ? 0.3 : 0.5;
    const p80Factor = clamp(empiricalP80 || 1 + fallbackSpread, 1.05, 2.5);
    const p90Factor = clamp(empiricalP90 || p80Factor + 0.25, p80Factor, 3.5);
    const sprints = issue.sprints || [];
    const scheduled = Boolean(issue.plannedStart || issue.plannedEnd || issue.sprintStart || issue.sprintEnd || sprints.some((sprint) => !/closed/i.test(sprint.state || "")));
    return {
      ...issue,
      inProgress: isInProgress(issue),
      scheduled,
      remainingHours: Number(remainingHours.toFixed(1)),
      remainingDays: Number((remainingHours / hoursPerDay).toFixed(3)),
      remainingSource,
      remainingConfidence,
      analogueKeys: analogues.keys,
      remainingScenarios: {
        optimistic: Number(remainingHours.toFixed(1)),
        realistic: Number((remainingHours * p80Factor).toFixed(1)),
        pessimistic: Number((remainingHours * p90Factor).toFixed(1))
      }
    };
  });
  return { workload: rows, warnings: uniq(warnings) };
}

export function multitaskingProfiles(history = [], employees = []) {
  const records = [];
  for (const issue of history) {
    const employee = employeeFor(issue.assignee, employees);
    const estimate = Number(issue.originalEstimateSeconds || 0) / 3600;
    const actual = actualHours(issue);
    const sprintIds = (issue.sprints || []).map((sprint) => String(sprint.id || sprint.name || "")).filter(Boolean);
    if (!employee || !issue.epicKey || !sprintIds.length || !(estimate > 0) || !(actual > 0)) continue;
    records.push({ employeeId: employee.id, epicKey: issue.epicKey, sprintIds, ratio: actual / estimate });
  }
  return employees.map((employee) => {
    const own = records.filter((row) => row.employeeId === employee.id);
    const single = [];
    const multi = [];
    for (const row of own) {
      const concurrentEpics = new Set(own.filter((other) => other.sprintIds.some((id) => row.sprintIds.includes(id))).map((other) => other.epicKey)).size;
      (concurrentEpics > 1 ? multi : single).push(row.ratio);
    }
    const enough = single.length >= 3 && multi.length >= 3;
    const factor = enough ? clamp(median(multi) / Math.max(0.01, median(single)), 1, 1.5) : 1;
    return {
      employeeId: employee.id,
      factor: Number(factor.toFixed(2)),
      confidence: enough ? Math.round(clamp((single.length + multi.length) * 6, 35, 90)) : 0,
      singleSample: single.length,
      multiSample: multi.length
    };
  });
}

function employeeCapacity(employee) {
  return Math.max(0.1, clamp(employee.commitment || 100, 10, 100) / 100);
}

function sprintWindow(issue, planningStart) {
  const sprints = (issue.sprints || []).filter((sprint) => !/closed/i.test(sprint.state || ""));
  const active = sprints.find((sprint) => /active/i.test(sprint.state || ""));
  const future = sprints.filter((sprint) => !sprint.endDate || dateKey(sprint.endDate) >= planningStart)
    .sort((left, right) => String(left.startDate || "9999").localeCompare(String(right.startDate || "9999")))[0];
  const sprint = active || future || null;
  const from = dateKey(issue.plannedStart || sprint?.startDate || issue.sprintStart || issue.epicPlannedStart || planningStart) || planningStart;
  const to = dateKey(issue.plannedEnd || sprint?.endDate || issue.sprintEnd || issue.epicPlannedEnd) || "";
  return { from: from < planningStart ? planningStart : from, to, sprint };
}

function taskPriority(task, day, capacity, holidays) {
  const deadlineDays = task.to ? Math.max(1, daysBetween(day, task.to, (date) => isWorkingDay(date, holidays)).length) : 999;
  const slack = deadlineDays * capacity - task.remaining;
  return (task.issue.isBaza ? 10000 : 0)
    + (task.issue.inProgress ? 4000 : 0)
    + (/active/i.test(task.sprint?.state || "") ? 1500 : 0)
    + (task.to && day > task.to ? 2000 : 0)
    - slack;
}

function dependenciesReady(task, tasksByKey, completedAt, day) {
  for (const dependency of task.issue.dependsOnKeys || []) {
    if (!tasksByKey.has(dependency)) continue;
    const completed = completedAt.get(dependency);
    if (!completed || completed >= day) return false;
  }
  return true;
}

export function buildPortfolioCalendar({ employees = [], workload = [], absences = new Map(), planningStart, holidays = new Set(), projectIsBaza = false, horizonDays = 1095, hoursPerDay = 8, scenario = "realistic" }) {
  const busy = new Map(employees.map((employee) => [employee.id, new Map()]));
  const ignoredWorkload = [];
  const skippedBacklog = [];
  const displacedIssues = [];
  const tasks = [];
  for (const issue of workload) {
    const employee = employeeFor(issue.assignee, employees);
    if (!employee) {
      ignoredWorkload.push(issue.key || issue.summary || "unknown");
      continue;
    }
    if (projectIsBaza && !issue.isBaza && !issue.inProgress) {
      displacedIssues.push(issue);
      continue;
    }
    if (issue.scheduled === false && !issue.isBaza && !issue.inProgress) {
      skippedBacklog.push(issue);
      continue;
    }
    const window = sprintWindow(issue, planningStart);
    const hours = Number(issue.remainingScenarios?.[scenario] ?? issue.remainingHours ?? Number(issue.remainingDays || 0) * hoursPerDay);
    if (!(hours > 0)) {
      ignoredWorkload.push(issue.key || issue.summary || "unknown");
      continue;
    }
    tasks.push({
      issue, employee, employeeId: employee.id, from: window.from, to: window.to, sprint: window.sprint,
      initial: hours / hoursPerDay, remaining: hours / hoursPerDay, start: "", end: "", afterDeadlineDays: 0,
      days: new Map()
    });
  }
  const tasksByKey = new Map(tasks.map((task) => [task.issue.key, task]));
  const completedAt = new Map();
  const allocate = (task, day, amount) => {
    if (!(amount > 0)) return 0;
    const used = Math.min(amount, task.remaining);
    task.remaining -= used;
    task.start ||= day;
    task.end = day;
    task.days.set(day, (task.days.get(day) || 0) + used);
    if (task.to && day > task.to) task.afterDeadlineDays += used;
    const dayBusy = busy.get(task.employeeId);
    dayBusy.set(day, (dayBusy.get(day) || 0) + used);
    if (task.remaining <= 0.0001) completedAt.set(task.issue.key, day);
    return used;
  };

  let cursor = parseDate(planningStart);
  for (let iteration = 0; iteration < horizonDays && tasks.some((task) => task.remaining > 0.0001); iteration += 1) {
    const day = dateKey(cursor);
    if (isWorkingDay(cursor, holidays)) {
      for (const employee of employees) {
        if (absences.get(employee.id)?.has(day)) continue;
        const capacity = employeeCapacity(employee);
        let available = capacity;
        const candidates = tasks.filter((task) => task.employeeId === employee.id && task.remaining > 0.0001 && task.from <= day && dependenciesReady(task, tasksByKey, completedAt, day))
          .sort((left, right) => taskPriority(right, day, capacity, holidays) - taskPriority(left, day, capacity, holidays));
        for (const task of candidates.filter((item) => item.to && day <= item.to)) {
          const remainingDays = Math.max(1, daysBetween(day, task.to, (date) => isWorkingDay(date, holidays)).length);
          const quota = Math.min(task.remaining / remainingDays, available);
          available -= allocate(task, day, quota);
          if (available <= 0.0001) break;
        }
        if (available > 0.0001) {
          const urgent = candidates.filter((task) =>
            (!task.to && (task.issue.inProgress || task.issue.isBaza || task.issue.scheduled == null))
            || (task.to && day > task.to)
          );
          for (const task of urgent) {
            available -= allocate(task, day, available);
            if (available <= 0.0001) break;
          }
        }
      }
    }
    cursor = addDays(cursor, 1);
  }

  for (const task of tasks) if (task.remaining > 0.0001) ignoredWorkload.push(task.issue.key || task.issue.summary || "unknown");
  const allocations = tasks.map((task) => ({
    key: task.issue.key,
    epicKey: task.issue.epicKey || "",
    groupId: task.issue.epicKey || `${task.issue.projectKey || "JIRA"}::no-epic`,
    employeeId: task.employeeId,
    start: task.start,
    end: task.end,
    deadline: task.to,
    hours: Number(((task.initial - task.remaining) * hoursPerDay).toFixed(1)),
    remainingHours: Number((task.remaining * hoursPerDay).toFixed(1)),
    spilloverHours: Number((task.afterDeadlineDays * hoursPerDay).toFixed(1)),
    days: Object.fromEntries([...task.days].map(([day, value]) => [day, Number((value * hoursPerDay).toFixed(2))]))
  }));
  return {
    busy,
    allocations,
    activeProjects: aggregateActiveProjects(tasks.map((task) => task.issue), allocations, scenario, hoursPerDay),
    ignoredWorkload: uniq(ignoredWorkload),
    skippedBacklog,
    displacedIssues,
    unknownEstimates: tasks.filter((task) => Number(task.issue.remainingConfidence || 0) < 30).map((task) => task.issue.key || task.issue.summary || "unknown")
  };
}

export function aggregateActiveProjects(workload = [], allocations = [], scenario = "realistic", hoursPerDay = 8) {
  const allocationByKey = new Map(allocations.map((row) => [row.key, row]));
  const groups = new Map();
  for (const issue of workload) {
    const key = issue.epicKey || `${issue.projectKey || "JIRA"}::no-epic`;
    if (!groups.has(key)) groups.set(key, {
      groupId: key,
      key: issue.epicKey || "",
      summary: issue.epicSummary || "Задачи без эпика",
      labels: [], isBaza: false, plannedStart: "", plannedEnd: "", taskCount: 0,
      remainingHours: 0, allocatedHours: 0, people: new Set(), sprints: new Map(), predictedStart: "", predictedEnd: "",
      spilloverHours: 0, lowConfidenceTasks: 0, inProgressTasks: 0
    });
    const group = groups.get(key);
    const allocation = allocationByKey.get(issue.key);
    group.summary = issue.epicSummary || group.summary;
    group.labels = uniq([...group.labels, ...(issue.epicLabels || []), ...(issue.labels || [])]);
    group.isBaza ||= Boolean(issue.isBaza);
    group.plannedStart ||= issue.epicPlannedStart || issue.plannedStart || "";
    group.plannedEnd ||= issue.epicPlannedEnd || issue.plannedEnd || "";
    group.taskCount += 1;
    group.remainingHours += Number(issue.remainingScenarios?.[scenario] ?? issue.remainingHours ?? Number(issue.remainingDays || 0) * hoursPerDay);
    group.allocatedHours += Number(allocation?.hours || 0);
    if (issue.inProgress) group.inProgressTasks += 1;
    if (Number(issue.remainingConfidence || 0) < 50) group.lowConfidenceTasks += 1;
    group.people.add(issue.assignee?.displayName || issue.assignee?.username || issue.assignee?.key || "Не назначен");
    for (const sprint of issue.sprints || []) if (sprint.id || sprint.name) group.sprints.set(String(sprint.id || sprint.name), {
      id: sprint.id || "", name: sprint.name || "", start: sprint.startDate || "", end: sprint.endDate || "", state: sprint.state || ""
    });
    if (allocation?.start && (!group.predictedStart || allocation.start < group.predictedStart)) group.predictedStart = allocation.start;
    if (allocation?.end && allocation.end > group.predictedEnd) group.predictedEnd = allocation.end;
    group.spilloverHours += Number(allocation?.spilloverHours || 0);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    remainingHours: Number(group.remainingHours.toFixed(1)),
    allocatedHours: Number(group.allocatedHours.toFixed(1)),
    spilloverHours: Number(group.spilloverHours.toFixed(1)),
    people: [...group.people],
    sprints: [...group.sprints.values()].sort((left, right) => String(left.start).localeCompare(String(right.start)))
  })).sort((left, right) => Number(right.isBaza) - Number(left.isBaza) || String(left.predictedEnd || left.plannedEnd || "9999").localeCompare(String(right.predictedEnd || right.plannedEnd || "9999")));
}

export function portfolioCapacitySummary({ employees = [], busy = new Map(), workload = [], absences = new Map(), holidays = new Set(), from, to, hoursPerDay = 8 }) {
  if (!from || !to) return [];
  return employees.map((employee) => {
    const days = daysBetween(from, to, (date) => isWorkingDay(date, holidays) && !absences.get(employee.id)?.has(dateKey(date)));
    const capacityHours = days.length * employeeCapacity(employee) * hoursPerDay;
    const occupiedHours = days.reduce((sum, day) => sum + Number(busy.get(employee.id)?.get(day) || 0) * hoursPerDay, 0);
    const epics = uniq(workload.filter((issue) => samePerson(employee, issue.assignee || {})).map((issue) => issue.epicKey || issue.projectKey));
    return {
      employeeId: employee.id,
      name: employee.displayName || employee.username || employee.id,
      capacityHours: Number(capacityHours.toFixed(1)),
      occupiedHours: Number(occupiedHours.toFixed(1)),
      freeHours: Number(Math.max(0, capacityHours - occupiedHours).toFixed(1)),
      utilizationPercent: capacityHours ? Math.round(occupiedHours / capacityHours * 100) : 0,
      activeEpicCount: epics.length,
      activeEpics: epics
    };
  });
}


// Совместимый реэкспорт: прямые импорты из portfolio.js продолжают работать.
export { backtestPortfolio } from "./backtest.js";
