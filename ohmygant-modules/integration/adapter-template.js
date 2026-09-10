// Шаблон composition root для актуального OhMyGant.
// Конкретные клиенты и хранилище остаются в принимающем приложении.
import {
  createPeopleAnalyticsModule,
  createProjectPlanningModule
} from "../src/index.js";

export function createBusinessModules({
  analyticsGateway,
  requirementsGateway,
  workforceGateway,
  repositoryGateway = null,
  settingsProvider = () => ({})
}) {
  const peopleAnalytics = createPeopleAnalyticsModule({
    dataSource: {
      listTeams: (onProgress) => analyticsGateway.listActiveTeams(onProgress),
      loadTeam: (team, from, to, onProgress) => analyticsGateway.loadTeamPeriod({ team, from, to, onProgress })
    },
    settingsProvider
  });

  const projectPlanning = createProjectPlanningModule({
    sources: {
      load: (reference, onProgress) => requirementsGateway.load(reference, onProgress)
    },
    workforce: {
      loadContext: (request) => workforceGateway.loadContext(request)
    },
    repositories: repositoryGateway ? {
      analyze: (source, onProgress) => repositoryGateway.analyze(source, onProgress)
    } : null,
    settingsProvider
  });

  return Object.freeze({ peopleAnalytics, projectPlanning });
}
