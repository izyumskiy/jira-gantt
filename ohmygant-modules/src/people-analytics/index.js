import { analyze, helpers } from "./core/metrics.js";
import {
  MODULE_API_VERSION,
  assertPeriod,
  defineModuleManifest,
  progressReporter,
  requirePort
} from "../contracts.js";

export const peopleAnalyticsManifest = defineModuleManifest({
  id: "asna.people-analytics",
  version: "1.0.0",
  title: "Аналитика сотрудников",
  kind: "analytics",
  route: "analytics",
  readOnly: true,
  capabilities: ["tempo:teams:read", "tempo:members:read", "jira:issues:read", "jira:worklogs:read"],
  styles: ["./people-analytics/module.css"]
});

function normalizeSettings(value = {}) {
  return {
    ...value.peopleAnalysis,
    ...value,
    doneStatuses: value.doneStatuses || value.peopleAnalysis?.doneStatuses || ""
  };
}

/**
 * Headless API модуля аналитики.
 * dataSource должен реализовать listTeams(onProgress) и loadTeam(team, from, to, onProgress).
 * settingsProvider может быть функцией или портом с get().
 */
export function createPeopleAnalyticsModule({
  dataSource,
  settingsProvider = () => ({}),
  engine = analyze
} = {}) {
  const readSettings = typeof settingsProvider === "function"
    ? settingsProvider
    : requirePort(settingsProvider, "get", peopleAnalyticsManifest.id);

  function analyzeSnapshot({ teams, members, issues, period, settings: overrideSettings } = {}) {
    if (!Array.isArray(teams) || !teams.length) throw new Error("Для анализа нужна хотя бы одна Tempo-команда");
    if (!Array.isArray(members)) throw new Error("Состав сотрудников должен быть массивом");
    if (!Array.isArray(issues)) throw new Error("Набор задач Jira должен быть массивом");
    assertPeriod(period?.from, period?.to);
    return engine(
      teams,
      members.filter((member) => member?.active !== false),
      issues,
      normalizeSettings(overrideSettings || readSettings()),
      period
    );
  }

  async function listTeams({ onProgress } = {}) {
    const listTeamsPort = requirePort(dataSource, "listTeams", peopleAnalyticsManifest.id);
    const teams = await listTeamsPort(progressReporter(onProgress));
    return (teams || []).filter((team) => team?.active !== false);
  }

  async function loadTeam({ team, from, to, onProgress } = {}) {
    const loadTeamPort = requirePort(dataSource, "loadTeam", peopleAnalyticsManifest.id);
    if (!team?.id) throw new Error("Выберите Tempo-команду");
    assertPeriod(from, to);
    return loadTeamPort(team, from, to, progressReporter(onProgress));
  }

  async function analyzeTeam(request = {}) {
    const snapshot = await loadTeam(request);
    const analytics = analyzeSnapshot({
      teams: [request.team],
      members: snapshot.members || [],
      issues: snapshot.issues || [],
      period: { from: request.from, to: request.to },
      settings: request.settings
    });
    return { snapshot, analytics };
  }

  return Object.freeze({
    apiVersion: MODULE_API_VERSION,
    manifest: peopleAnalyticsManifest,
    listTeams,
    loadTeam,
    analyzeTeam,
    analyzeSnapshot
  });
}

export { analyze, helpers };
