// Единая публичная точка входа для новой версии Jira OhMyGant.
export { MODULE_API_VERSION } from "./contracts.js";
export {
  analyze,
  createPeopleAnalyticsModule,
  helpers,
  peopleAnalyticsManifest
} from "./people-analytics/index.js";
export {
  aggregateActiveProjects,
  analyzeProject,
  backtestCalibration,
  backtestPortfolio,
  buildCalibration,
  buildPortfolioCalendar,
  buildTechnologyProfile,
  calibrateWorkload,
  calibrationFor,
  composeProjectSource,
  createProjectPlanningModule,
  detectProjectIntent,
  evaluateProject,
  excludeProjectWorkload,
  forecastProject,
  multitaskingProfiles,
  portfolioCapacitySummary,
  projectPlanningManifest,
  projectScopeKeys,
  repositoryWorkItems,
  scenarioFactors,
  vacationDays,
  vacationWindow
} from "./project-planning/index.js";

import { peopleAnalyticsManifest } from "./people-analytics/index.js";
import { projectPlanningManifest } from "./project-planning/index.js";

export const moduleCatalog = Object.freeze([
  peopleAnalyticsManifest,
  projectPlanningManifest
]);
