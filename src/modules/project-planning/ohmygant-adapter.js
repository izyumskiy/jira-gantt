// Адаптер к сервисам текущей версии Jira OhMyGant.
import * as settings from "../../js/settings.js";
import { loadRepositoryAnalysis } from "../../js/project-forecast/repository-analysis.js";
import { loadRequirementSource } from "../../js/project-forecast/source.js";
import * as sync from "../../js/project-forecast/sync.js";
import { createProjectPlanningModule } from "./index.js";

export function createOhMyGantProjectPlanningModule() {
  return createProjectPlanningModule({
    sources: { load: (reference, onProgress) => loadRequirementSource(reference, onProgress) },
    workforce: { loadContext: (request) => sync.loadContext(request) },
    repositories: { analyze: (source, onProgress) => loadRepositoryAnalysis(source, onProgress) },
    settingsProvider: () => settings.get()
  });
}
