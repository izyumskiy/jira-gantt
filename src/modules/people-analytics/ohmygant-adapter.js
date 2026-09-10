// Адаптер текущей версии Jira OhMyGant. Новая оболочка может заменить его своими портами.
import * as loader from "../../js/people-analysis-sync.js";
import * as settings from "../../js/settings.js";
import { createPeopleAnalyticsModule } from "./index.js";

export function createOhMyGantPeopleAnalyticsModule() {
  return createPeopleAnalyticsModule({
    dataSource: {
      listTeams: (onProgress) => loader.loadTeams(onProgress),
      loadTeam: (team, from, to, onProgress) => loader.loadTeam(team, from, to, onProgress)
    },
    settingsProvider: () => settings.get()
  });
}
