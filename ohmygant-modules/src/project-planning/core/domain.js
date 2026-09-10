// Чистая расчётная модель прогноза проекта. Здесь нет DOM, Jira API и IndexedDB.
import { addDays, dateKey, daysBetween, isWorkingDay, parseDate } from "./calendar.js";
import { normalizeIdentity, personAliases, samePerson } from "./identity.js";
import { buildPortfolioCalendar, portfolioCapacitySummary } from "./portfolio.js";

export { DAY_MS, addDays, dateKey, daysBetween, isWorkingDay, parseDate } from "./calendar.js";
export { normalizeIdentity, personAliases, samePerson } from "./identity.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

function datesFromText(value, fallbackYear) {
  const text = String(value || "");
  const matches = [...text.matchAll(/(\d{2})\.(\d{2})\.(\d{4})/g)];
  if (matches.length >= 2) {
    const toIso = (match) => `${match[3]}-${match[2]}-${match[1]}`;
    const from = toIso(matches[0]);
    const to = toIso(matches[1]);
    return parseDate(from) && parseDate(to) && parseDate(from) <= parseDate(to) ? { from, to } : null;
  }

  const short = /(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s*[-–—]\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/.exec(text);
  if (!short) return null;
  const baseYear = Number(short[3] || fallbackYear);
  if (!baseYear) return null;
  const endYear = Number(short[6] || (Number(short[5]) < Number(short[2]) ? baseYear + 1 : baseYear));
  const from = `${baseYear}-${String(short[2]).padStart(2, "0")}-${String(short[1]).padStart(2, "0")}`;
  const to = `${endYear}-${String(short[5]).padStart(2, "0")}-${String(short[4]).padStart(2, "0")}`;
  return parseDate(from) && parseDate(to) && parseDate(from) <= parseDate(to) ? { from, to } : null;
}

export function vacationWindow(issue = {}) {
  if (!/отпуск|vacation/i.test(String(issue.summary || ""))) return null;
  if (/cancel|отмен/i.test(String(issue.status || ""))) return null;

  const explicitFrom = dateKey(issue.plannedStart || issue.startDate);
  const explicitTo = dateKey(issue.plannedEnd || issue.endDate);
  const fallbackYear = parseDate(issue.created)?.getFullYear() || new Date().getFullYear();
  const range = explicitFrom && explicitTo
    ? { from: explicitFrom, to: explicitTo }
    : datesFromText(issue.summary, fallbackYear) || datesFromText(issue.description, fallbackYear);
  if (!range) return null;

  return {
    key: issue.key || "",
    assignee: issue.assignee || null,
    from: range.from,
    to: range.to
  };
}

export function vacationDays(issues, employees, holidays = new Set()) {
  const byEmployee = new Map(employees.map((employee) => [employee.id, new Set()]));
  const ignored = [];
  for (const issue of issues || []) {
    const window = vacationWindow(issue);
    if (!window) {
      ignored.push(issue.key || issue.summary || "unknown");
      continue;
    }
    const employee = employees.find((candidate) => samePerson(candidate, window.assignee));
    if (!employee) continue;
    for (const day of daysBetween(window.from, window.to, (date) => isWorkingDay(date, holidays))) {
      byEmployee.get(employee.id).add(day);
    }
  }
  return { byEmployee, ignored };
}

function employeeCapacity(employee) {
  const commitment = clamp(employee.commitment || 100, 10, 100) / 100;
  return Math.max(0.1, commitment);
}

function availableOn(employee, day, busy, absences, holidays) {
  const key = dateKey(day);
  if (!isWorkingDay(day, holidays) || absences.get(employee.id)?.has(key)) return 0;
  return Math.max(0, employeeCapacity(employee) - (busy.get(employee.id)?.get(key) || 0));
}

function weightedAverage(rows, getter, fallback) {
  let sum = 0;
  let weight = 0;
  for (const row of rows) {
    const value = Number(getter(row));
    if (!Number.isFinite(value)) continue;
    const confidence = clamp(row.confidence ?? 25, 10, 100);
    sum += value * confidence;
    weight += confidence;
  }
  return weight ? sum / weight : fallback;
}

export function scenarioFactors(employees, unknownPercent = 20) {
  const estimateRatio = clamp(weightedAverage(employees, (row) => row.estimateRatio, 1), 0.65, 2.5);
  const confidence = clamp(weightedAverage(employees, (row) => row.confidence, 25), 0, 100);
  const score = clamp(weightedAverage(employees, (row) => row.score, 65), 0, 100);
  const unknown = clamp(unknownPercent, 0, 200) / 100;
  const confidencePenalty = (100 - confidence) / 500;
  const reliabilityPenalty = Math.max(0, 75 - score) / 250;
  const p50 = estimateRatio;
  const p80 = p50 * (1 + unknown);
  const p90 = p80 * (1.2 + confidencePenalty + reliabilityPenalty);
  return {
    optimistic: Number(p50.toFixed(3)),
    realistic: Number(p80.toFixed(3)),
    pessimistic: Number(p90.toFixed(3)),
    estimateRatio: Number(estimateRatio.toFixed(2)),
    confidence: Math.round(confidence),
    score: Math.round(score)
  };
}

function cloneBusy(source) {
  return new Map([...source].map(([employeeId, rows]) => [employeeId, new Map(rows)]));
}

function emptyBusy(employees) {
  return new Map(employees.map((employee) => [employee.id, new Map()]));
}

function relieveBusy(source, employeeId, fraction = 0.25) {
  const relieved = cloneBusy(source);
  const rows = relieved.get(employeeId);
  if (rows) for (const [day, value] of rows) rows.set(day, Math.max(0, value * (1 - fraction)));
  return relieved;
}

function workingDelayDays(fasterEnd, slowerEnd, holidays) {
  if (!fasterEnd || !slowerEnd || fasterEnd >= slowerEnd) return 0;
  return Math.max(0, daysBetween(fasterEnd, slowerEnd, (date) => isWorkingDay(date, holidays)).length - 1);
}

function nextDay(value) {
  return dateKey(addDays(value, 1));
}

function laterDate(left, right) {
  if (!left) return right || "";
  if (!right) return left;
  return parseDate(left) >= parseDate(right) ? left : right;
}

function calibratedFactor(item, scenario, fallbackFactors, minimumUnknownPercent = 0) {
  const factors = item.calibration?.factors;
  if (!factors) return Number(fallbackFactors[scenario] || 1);
  const optimistic = clamp(factors.optimistic || 1, 0.4, 4);
  const minimumUnknown = clamp(minimumUnknownPercent, 0, 200) / 100;
  const realistic = Math.max(clamp(factors.realistic || optimistic, optimistic, 5), optimistic * (1 + minimumUnknown));
  const pessimistic = Math.max(clamp(factors.pessimistic || realistic, realistic, 6), realistic);
  return scenario === "optimistic" ? optimistic : scenario === "realistic" ? realistic : pessimistic;
}

function topologicalWorkItems(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const indegree = new Map(items.map((item) => [item.id, 0]));
  const followers = new Map(items.map((item) => [item.id, []]));
  for (const item of items) {
    for (const dependency of item.dependsOn || []) {
      if (!byId.has(dependency)) continue;
      indegree.set(item.id, indegree.get(item.id) + 1);
      followers.get(dependency).push(item.id);
    }
  }
  const queue = items.filter((item) => indegree.get(item.id) === 0);
  const ordered = [];
  while (queue.length) {
    const item = queue.shift();
    ordered.push(item);
    for (const follower of followers.get(item.id) || []) {
      indegree.set(follower, indegree.get(follower) - 1);
      if (indegree.get(follower) === 0) queue.push(byId.get(follower));
    }
  }
  const cyclic = items.filter((item) => !ordered.some((row) => row.id === item.id));
  return { items: [...ordered, ...cyclic], cyclic: cyclic.map((item) => item.id) };
}

function criticalPath(rows) {
  if (!rows.length) return [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  let current = rows.slice().filter((row) => row.end).sort((left, right) => String(right.end).localeCompare(String(left.end)))[0];
  const path = [];
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.id);
    current = [...(current.dependsOn || []), current.resourcePredecessorId].filter(Boolean).map((id) => byId.get(id)).filter(Boolean)
      .sort((left, right) => String(right.end || "").localeCompare(String(left.end || "")))[0];
  }
  return path;
}

function scheduleWorkItems({ employees, busy: sourceBusy, absences, holidays, planningStart, workItems, factor, horizonDays, hoursPerDay }) {
  const busy = cloneBusy(sourceBusy);
  const byEmployee = new Map(employees.map((employee) => [employee.id, employee]));
  const allocations = new Map(employees.map((employee) => [employee.id, 0]));
  const completed = new Map();
  const lastByEmployee = new Map();
  const rows = [];
  let projectStart = "";
  let projectEnd = "";
  let totalRemaining = 0;

  const ordered = topologicalWorkItems(workItems);
  for (const item of ordered.items) {
    const employee = byEmployee.get(item.assigneeId) || employees[0];
    const dependencyEnd = (item.dependsOn || []).reduce((latest, id) => laterDate(latest, completed.get(id)?.end), "");
    const earliest = laterDate(planningStart, dependencyEnd ? nextDay(dependencyEnd) : "");
    const appliedFactor = typeof factor === "function" ? factor(item) : factor;
    const demandDays = Math.max(0, Number(item.estimateHours || 0) * appliedFactor / hoursPerDay);
    let remaining = demandDays;
    let cursor = parseDate(earliest);
    let first = "";
    let finish = "";
    let iterations = 0;
    while (remaining > 0.0001 && iterations < horizonDays) {
      const key = dateKey(cursor);
      const capacity = availableOn(employee, cursor, busy, absences, holidays);
      if (capacity > 0) {
        const used = Math.min(capacity, remaining);
        busy.get(employee.id).set(key, (busy.get(employee.id).get(key) || 0) + used);
        allocations.set(employee.id, allocations.get(employee.id) + used);
        remaining -= used;
        first ||= key;
        finish = key;
      }
      cursor = addDays(cursor, 1);
      iterations += 1;
    }
    totalRemaining += remaining;
    const row = {
      ...item,
      assigneeId: employee.id,
      assigneeName: employee.displayName || employee.username || employee.id,
      resourcePredecessorId: lastByEmployee.get(employee.id) || "",
      forecastHours: Number((demandDays * hoursPerDay).toFixed(1)),
      scenarioFactor: Number(appliedFactor.toFixed(3)),
      start: first,
      end: finish,
      remainingHours: Number((remaining * hoursPerDay).toFixed(1))
    };
    rows.push(row);
    completed.set(item.id, row);
    lastByEmployee.set(employee.id, item.id);
    if (first && (!projectStart || parseDate(first) < parseDate(projectStart))) projectStart = first;
    projectEnd = laterDate(projectEnd, finish);
  }
  const starts = rows.map((row) => row.start).filter(Boolean).sort();
  return {
    start: starts[0] || projectStart,
    end: projectEnd,
    remaining: Number(totalRemaining.toFixed(2)),
    allocations,
    workItems: rows,
    criticalPath: criticalPath(rows),
    dependencyCycles: ordered.cyclic
  };
}

export function forecastProject(input) {
  const employees = (input.employees || []).filter((employee) => employee?.id);
  if (!employees.length) throw new Error("Выберите хотя бы одного сотрудника");
  const hoursPerDay = clamp(input.hoursPerDay || 8, 1, 24);
  const workItems = (input.workItems || []).filter((item) => Number(item?.estimateHours) > 0).map((item, index) => ({
    ...item,
    id: item.id || `WORK-${index + 1}`,
    estimateHours: Number(item.estimateHours),
    assigneeId: item.assigneeId || employees[index % employees.length].id,
    dependsOn: item.dependsOn || []
  }));
  // Совместимость с сохранёнными расчётами версии 1.3: новый интерфейс scopeDays не использует.
  if (!workItems.length && Number(input.scopeDays) > 0) {
    const totalHours = Number(input.scopeDays) * hoursPerDay;
    employees.forEach((employee, index) => workItems.push({
      id: `LEGACY-${index + 1}`,
      title: "Объём проекта",
      estimateHours: totalHours / employees.length,
      assigneeId: employee.id,
      dependsOn: []
    }));
  }
  if (!workItems.length) throw new Error("Системный анализ не сформировал оцениваемых работ");
  const scopeHours = workItems.reduce((sum, item) => sum + item.estimateHours, 0);
  const scopeDays = scopeHours / hoursPerDay;
  const planningStart = dateKey(input.planningStart || new Date());
  if (!planningStart) throw new Error("Проверьте дату начала расчёта");

  const holidays = new Set(input.holidays || []);
  const horizonDays = clamp(input.horizonDays || 1095, 30, 3650);
  const vacations = vacationDays(input.vacations || [], employees, holidays);
  const fallbackFactors = scenarioFactors(employees, input.unknownPercent);
  const activeEpicsByEmployee = new Map(employees.map((employee) => [employee.id, new Set(
    (input.workload || []).filter((issue) => samePerson(employee, issue.assignee || {})).map((issue) => issue.epicKey || issue.projectKey).filter(Boolean)
  )]));
  const factorFor = (scenario) => (item) => {
    const employee = employees.find((candidate) => candidate.id === item.assigneeId) || employees[0];
    const observed = activeEpicsByEmployee.get(employee.id)?.size
      ? clamp(employee.multitaskingFactor || 1, 1, 1.5)
      : 1;
    const contextFactor = scenario === "optimistic" ? 1 + (observed - 1) * 0.5
      : scenario === "realistic" ? observed
      : 1 + (observed - 1) * 1.25;
    return calibratedFactor(item, scenario, fallbackFactors, input.unknownPercent) * contextFactor;
  };
  const weightedFactor = (scenario) => workItems.reduce((sum, item) => sum + item.estimateHours * factorFor(scenario)(item), 0) / scopeHours;
  const factors = {
    ...fallbackFactors,
    optimistic: Number(weightedFactor("optimistic").toFixed(3)),
    realistic: Number(weightedFactor("realistic").toFixed(3)),
    pessimistic: Number(weightedFactor("pessimistic").toFixed(3)),
    mode: workItems.some((item) => item.calibration) ? "item-calibrated" : "legacy"
  };
  const schedule = (scenario) => {
    const calendar = buildPortfolioCalendar({
      employees, workload: input.workload || [], absences: vacations.byEmployee, planningStart, holidays,
      projectIsBaza: Boolean(input.projectIsBaza), horizonDays, hoursPerDay, scenario
    });
    const scheduled = scheduleWorkItems({
      employees, busy: calendar.busy, absences: vacations.byEmployee, holidays, planningStart,
      workItems, factor: factorFor(scenario), horizonDays, hoursPerDay
    });
    return { scheduled, calendar };
  };
  const optimisticRun = schedule("optimistic");
  const realisticRun = schedule("realistic");
  const pessimisticRun = schedule("pessimistic");
  const publicScenario = ({ scheduled, calendar }) => ({
    ...scheduled,
    portfolio: {
      activeProjects: calendar.activeProjects,
      skippedBacklogKeys: calendar.skippedBacklog.map((issue) => issue.key).filter(Boolean),
      displacedIssueKeys: calendar.displacedIssues.map((issue) => issue.key).filter(Boolean),
      ignoredWorkload: calendar.ignoredWorkload,
      unknownEstimates: calendar.unknownEstimates
    }
  });
  const optimistic = publicScenario(optimisticRun);
  const realistic = publicScenario(realisticRun);
  const pessimistic = publicScenario(pessimisticRun);

  const withoutPortfolio = scheduleWorkItems({
    employees, busy: emptyBusy(employees), absences: vacations.byEmployee, holidays, planningStart,
    workItems, factor: factorFor("realistic"), horizonDays, hoursPerDay
  });
  const portfolioDelayDays = workingDelayDays(withoutPortfolio.end, realistic.end, holidays);
  const criticalEmployeeIds = new Set(realistic.criticalPath.map((id) => realistic.workItems.find((item) => item.id === id)?.assigneeId).filter(Boolean));
  const activeProjects = realistic.portfolio.activeProjects.map((project) => {
    const relevant = realisticRun.calendar.allocations.filter((row) => row.groupId === project.groupId && criticalEmployeeIds.has(row.employeeId));
    const pressureHours = relevant.reduce((sum, allocation) => sum + Object.entries(allocation.days || {})
      .filter(([day]) => day >= (realistic.start || planningStart) && day <= (realistic.end || planningStart))
      .reduce((daySum, [, hours]) => daySum + Number(hours || 0), 0), 0);
    return {
      ...project,
      parallelWithProject: Boolean(project.predictedStart && project.predictedEnd && project.predictedStart <= realistic.end && project.predictedEnd >= realistic.start),
      criticalPressureHours: Number(pressureHours.toFixed(1)),
      criticalPressureDays: Number((pressureHours / hoursPerDay).toFixed(1))
    };
  });

  const resourceSensitivity = [...criticalEmployeeIds].map((employeeId) => {
    const employee = employees.find((row) => row.id === employeeId);
    const relieved = scheduleWorkItems({
      employees, busy: relieveBusy(realisticRun.calendar.busy, employeeId, 0.25), absences: vacations.byEmployee,
      holidays, planningStart, workItems, factor: factorFor("realistic"), horizonDays, hoursPerDay
    });
    const releasedHours = [...(realisticRun.calendar.busy.get(employeeId) || new Map())]
      .filter(([day]) => day >= planningStart && day <= (realistic.end || planningStart))
      .reduce((sum, [, days]) => sum + Number(days || 0) * hoursPerDay * 0.25, 0);
    return {
      employeeId,
      name: employee?.displayName || employee?.username || employeeId,
      assumption: "Высвободить 25% ёмкости от активных эпиков",
      releasedHours: Number(releasedHours.toFixed(1)),
      projectedEnd: relieved.end,
      savedWorkdays: workingDelayDays(relieved.end, realistic.end, holidays)
    };
  }).filter((row) => row.releasedHours > 0).sort((left, right) => right.savedWorkdays - left.savedWorkdays || right.releasedHours - left.releasedHours);

  const employeeRows = employees.map((employee) => {
    const assigned = workItems.filter((item) => item.assigneeId === employee.id);
    const assignedHours = assigned.reduce((sum, item) => sum + item.estimateHours, 0);
    const specializedFactor = assignedHours > 0
      ? assigned.reduce((sum, item) => sum + item.estimateHours * factorFor("realistic")(item), 0) / assignedHours
      : null;
    return {
    id: employee.id,
    name: employee.displayName || employee.username || employee.key || employee.id,
    commitment: Math.round(employeeCapacity(employee) * 100),
    score: Number.isFinite(employee.score) ? employee.score : null,
    confidence: Number.isFinite(employee.confidence) ? employee.confidence : null,
    estimateRatio: Number.isFinite(employee.estimateRatio) ? employee.estimateRatio : null,
    multitaskingFactor: Number.isFinite(employee.multitaskingFactor) ? employee.multitaskingFactor : 1,
    multitaskingConfidence: Number(employee.multitaskingProfile?.confidence || 0),
    specializedFactor: Number.isFinite(specializedFactor) ? Number(specializedFactor.toFixed(2)) : null,
    vacationDays: [...(vacations.byEmployee.get(employee.id) || [])].filter((day) => day >= planningStart).length,
    estimatedHours: Number(workItems.filter((item) => item.assigneeId === employee.id).reduce((sum, item) => sum + item.estimateHours, 0).toFixed(1)),
    forecastHours: Number(((realistic.allocations.get(employee.id) || 0) * hoursPerDay).toFixed(1)),
    allocatedDays: Number((realistic.allocations.get(employee.id) || 0).toFixed(1))
  };
  });

  const projectForecastByEmployee = new Map([...realistic.allocations].map(([employeeId, days]) => [employeeId, days * hoursPerDay]));
  const capacity = portfolioCapacitySummary({
    employees, busy: realisticRun.calendar.busy, workload: input.workload || [], absences: vacations.byEmployee,
    holidays, from: planningStart, to: realistic.end || planningStart, hoursPerDay
  }).map((row) => ({
    ...row,
    projectHours: Number((projectForecastByEmployee.get(row.employeeId) || 0).toFixed(1)),
    freeHours: Number(Math.max(0, row.capacityHours - row.occupiedHours - (projectForecastByEmployee.get(row.employeeId) || 0)).toFixed(1)),
    totalUtilizationPercent: row.capacityHours
      ? Math.round(Math.min(1, (row.occupiedHours + (projectForecastByEmployee.get(row.employeeId) || 0)) / row.capacityHours) * 100)
      : 0
  }));
  const warnings = [];
  if (realisticRun.calendar.unknownEstimates.length) warnings.push(`У ${realisticRun.calendar.unknownEstimates.length} активных задач остаток рассчитан по слабому источнику; диапазон срока расширен.`);
  if (realisticRun.calendar.ignoredWorkload.length) warnings.push(`Не удалось полностью разместить нагрузку по задачам: ${realisticRun.calendar.ignoredWorkload.length}.`);
  if (realisticRun.calendar.skippedBacklog.length) warnings.push(`Неспланированный backlog не блокировал календарь: ${realisticRun.calendar.skippedBacklog.length} задач.`);
  if (vacations.ignored.length) warnings.push(`Не удалось определить даты у ${vacations.ignored.length} отпускных задач.`);
  if (employees.some((employee) => !Number.isFinite(employee.score))) warnings.push("Для части сотрудников недостаточно истории: применён нейтральный коэффициент надёжности.");
  const fallbackCalibration = workItems.filter((item) => item.calibration?.source === "fallback").length;
  if (fallbackCalibration) warnings.push(`Для ${fallbackCalibration} работ недостаточно специализированной истории: использована резервная модель сложности.`);
  if (input.projectIsBaza && realisticRun.calendar.displacedIssues.length) warnings.push(`Проект BAZA вытесняет ${realisticRun.calendar.displacedIssues.length} ещё не начатых неприоритетных задач; затронутые ключи показаны в портфельной диагностике.`);
  const spilloverProjects = realistic.portfolio.activeProjects.filter((project) => project.spilloverHours > 0);
  if (spilloverProjects.length) warnings.push(`Прогнозируется перенос за границу спринта/Planned End у ${spilloverProjects.length} активных эпиков.`);
  if (portfolioDelayDays) warnings.push(`Текущий портфель активных эпиков сдвигает P80 нового проекта на ${portfolioDelayDays} раб. дн. относительно свободной команды.`);
  if (realistic.dependencyCycles.length) warnings.push(`В зависимостях проекта найден цикл: ${realistic.dependencyCycles.join(", ")}.`);
  if (realistic.remaining > 0) warnings.push("Горизонта расчёта недостаточно для размещения реалистичного сценария.");

  return {
    generatedAt: new Date().toISOString(),
    planningStart,
    scopeHours: Number(scopeHours.toFixed(1)),
    scopeDays,
    hoursPerDay,
    workItems: realistic.workItems,
    factors,
    scenarios: { optimistic, realistic, pessimistic },
    employees: employeeRows,
    portfolio: {
      activeProjects,
      capacity,
      displacedIssueKeys: realistic.portfolio.displacedIssueKeys,
      skippedBacklogKeys: realistic.portfolio.skippedBacklogKeys,
      criticalPath: realistic.criticalPath,
      spilloverProjectKeys: spilloverProjects.map((project) => project.key || project.summary),
      portfolioDelayDays,
      endWithoutPortfolio: withoutPortfolio.end,
      resourceSensitivity
    },
    workloadCount: (input.workload || []).length,
    vacationIssueCount: (input.vacations || []).length,
    warnings
  };
}
