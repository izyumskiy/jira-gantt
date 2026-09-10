import { analyzeProject, composeProjectSource } from "./core/analysis.js";
import { forecastProject } from "./core/domain.js";
import * as portfolioModel from "./core/portfolio.js";
import {
  MODULE_API_VERSION,
  assertPeriod,
  defineModuleManifest,
  progressReporter,
  requirePort
} from "../contracts.js";

export const projectPlanningManifest = defineModuleManifest({
  id: "asna.project-planning",
  version: "1.2.0",
  title: "Планирование проектов",
  kind: "planning",
  route: "forecast",
  readOnly: true,
  capabilities: [
    "jira:issues:read", "jira:sprints:read", "jira:worklogs:read",
    "tempo:members:read", "confluence:pages:read", "gitlab:repositories:read"
  ],
  styles: ["./project-planning/module.css"]
});

export function projectScopeKeys(source = {}) {
  return new Set([
    source.key,
    ...(source.children || []).map((issue) => issue?.key)
  ].filter(Boolean).map((key) => String(key).toUpperCase()));
}

/** Исключает оцениваемый проект из фоновой загрузки, не изменяя исходный массив. */
export function excludeProjectWorkload(workload = [], source = {}) {
  const keys = projectScopeKeys(source);
  const projectKey = String(source.key || "").toUpperCase();
  const kept = [];
  const excluded = [];
  for (const issue of workload || []) {
    const issueKey = String(issue?.key || "").toUpperCase();
    const epicKey = String(issue?.epicKey || "").toUpperCase();
    if (keys.has(issueKey) || (projectKey && epicKey === projectKey)) excluded.push(issue);
    else kept.push(issue);
  }
  return { workload: kept, excluded };
}

/**
 * Детерминированное ядро планирования для уже загруженных данных.
 * Все сетевые операции должны быть выполнены интеграционными портами до вызова.
 */
export function evaluateProject({
  jiraSource,
  businessRequirements = null,
  systemAnalysis = null,
  repositoryAnalysis = null,
  context = {},
  hoursPerDay = 8,
  planningStart,
  unknownPercent = 0,
  projectIsBaza = false,
  holidays = [],
  excludeOwnWorkload = true
} = {}) {
  const source = composeProjectSource({ jira: jiraSource, businessRequirements, systemAnalysis, repositoryAnalysis });
  const profileByEmployee = new Map(portfolioModel.multitaskingProfiles(context.history || [], context.employees || []).map((profile) => [profile.employeeId, profile]));
  const employees = (context.employees || []).map((employee) => {
    const calculated = profileByEmployee.get(employee.id);
    const profile = calculated?.confidence ? calculated : employee.multitaskingProfile || calculated;
    return {
      ...employee,
      multitaskingFactor: profile?.factor || employee.multitaskingFactor || 1,
      multitaskingProfile: profile || null
    };
  });
  const analysis = analyzeProject({
    source,
    history: context.history || [],
    employees,
    hoursPerDay
  });
  const workloadResult = excludeOwnWorkload
    ? excludeProjectWorkload(context.workload || [], source)
    : { workload: context.workload || [], excluded: [] };
  const calibratedWorkload = portfolioModel.calibrateWorkload(workloadResult.workload, context.history || [], employees, hoursPerDay);
  const portfolioBacktest = context.portfolioBacktest || portfolioModel.backtestPortfolio(context.history || [], employees, hoursPerDay);
  const result = forecastProject({
    employees,
    workload: calibratedWorkload.workload,
    vacations: context.vacations || [],
    workItems: analysis.workItems,
    hoursPerDay,
    planningStart,
    unknownPercent,
    projectIsBaza,
    holidays
  });
  result.appliedUnknownPercent = Number(unknownPercent || 0);
  result.workloadDiagnostics = {
    received: (context.workload || []).length,
    used: calibratedWorkload.workload.length,
    excludedProjectIssues: workloadResult.excluded.map((issue) => issue.key).filter(Boolean)
  };
  result.warnings = [...new Set([...(calibratedWorkload.warnings || []), ...(result.warnings || [])])];
  result.portfolio = {
    ...(result.portfolio || {}),
    backtest: portfolioBacktest
  };
  const activeProjects = result.portfolio.activeProjects?.length
    ? result.portfolio.activeProjects
    : context.activeProjects || [];
  return {
    source,
    analysis,
    result,
    activeProjects: activeProjects.filter((project) =>
      String(project?.key || "").toUpperCase() !== String(source.key || "").toUpperCase()
    ),
    context: {
      ...context,
      employees,
      workload: calibratedWorkload.workload,
      activeProjects,
      portfolioBacktest,
      warnings: [...new Set([...(context.warnings || []), ...(calibratedWorkload.warnings || [])])]
    }
  };
}

function expectedSource(source, type, fieldName) {
  if (!source || source.type !== type) {
    throw new Error(`${fieldName}: ожидается источник ${type === "jira" ? "Jira" : "Confluence"}`);
  }
  return source;
}

/**
 * Оркестратор модуля. Порты описывают только чтение; запись в Jira/Tempo/GitLab отсутствует.
 */
export function createProjectPlanningModule({
  sources,
  workforce,
  repositories = null,
  settingsProvider = () => ({ hoursPerDay: 8 })
} = {}) {
  const loadSource = requirePort(sources, "load", projectPlanningManifest.id);
  const loadContext = requirePort(workforce, "loadContext", projectPlanningManifest.id);
  const analyzeRepository = repositories?.analyze
    ? repositories.analyze.bind(repositories)
    : null;
  const readSettings = typeof settingsProvider === "function"
    ? settingsProvider
    : requirePort(settingsProvider, "get", projectPlanningManifest.id);

  async function run(request = {}) {
    const progress = progressReporter(request.onProgress);
    if (!String(request.project || "").trim()) throw new Error("Укажите проект или эпик Jira");
    if (!Array.isArray(request.people) || !request.people.length) throw new Error("Выберите хотя бы одного сотрудника");
    assertPeriod(request.historyFrom, request.historyTo);

    progress("Читаю проект Jira и существующую декомпозицию");
    const jiraSource = expectedSource(await loadSource(request.project, progress), "jira", "Проект");
    let businessRequirements = null;
    let systemAnalysis = null;
    if (String(request.businessRequirements || "").trim()) {
      progress("Читаю бизнес-требования Confluence");
      try {
        businessRequirements = expectedSource(await loadSource(request.businessRequirements, progress), "confluence", "Бизнес-требования");
      } catch (error) {
        error.documentKind = "businessRequirements";
        throw error;
      }
    }
    if (String(request.systemAnalysis || "").trim()) {
      progress("Читаю системный анализ Confluence");
      try {
        systemAnalysis = expectedSource(await loadSource(request.systemAnalysis, progress), "confluence", "Системный анализ");
      } catch (error) {
        error.documentKind = "systemAnalysis";
        throw error;
      }
    }

    let composed = composeProjectSource({ jira: jiraSource, businessRequirements, systemAnalysis });
    let repositoryAnalysis = null;
    if (request.expressAnalysis && analyzeRepository) {
      progress("Проверяю технический контур в известных GitLab-репозиториях");
      repositoryAnalysis = await analyzeRepository(composed, progress);
      composed = composeProjectSource({ jira: jiraSource, businessRequirements, systemAnalysis, repositoryAnalysis });
    }

    progress("Загружаю историю, активные проекты, спринты и отпуска");
    const context = await loadContext({
      teams: request.teams || [],
      people: request.people,
      from: request.historyFrom,
      to: request.historyTo,
      onProgress: progress
    });
    progress("Выполняю системный анализ и рассчитываю прогноз");
    const currentSettings = readSettings() || {};
    return evaluateProject({
      jiraSource,
      businessRequirements,
      systemAnalysis,
      repositoryAnalysis,
      context,
      hoursPerDay: Number(request.hoursPerDay || currentSettings.hoursPerDay || 8),
      planningStart: request.planningStart,
      unknownPercent: request.unknownPercent,
      projectIsBaza: request.projectIsBaza,
      holidays: request.holidays || [],
      excludeOwnWorkload: request.excludeOwnWorkload !== false
    });
  }

  return Object.freeze({
    apiVersion: MODULE_API_VERSION,
    manifest: projectPlanningManifest,
    run,
    evaluate: evaluateProject,
    excludeProjectWorkload,
    projectScopeKeys
  });
}

export { analyzeProject, composeProjectSource, forecastProject };
export {
  backtestCalibration,
  buildCalibration,
  calibrationFor,
  quantile
} from "./core/calibration.js";
export {
  DAY_MS,
  addDays,
  dateKey,
  daysBetween,
  isWorkingDay,
  normalizeIdentity,
  parseDate,
  personAliases,
  samePerson,
  scenarioFactors,
  vacationDays,
  vacationWindow
} from "./core/domain.js";
export { buildTechnologyProfile } from "./repository/technology-profile.js";
export { detectProjectIntent, repositoryWorkItems } from "./repository/work-items.js";
export {
  aggregateActiveProjects,
  backtestPortfolio,
  buildPortfolioCalendar,
  calibrateWorkload,
  multitaskingProfiles,
  portfolioCapacitySummary
} from "./core/portfolio.js";
