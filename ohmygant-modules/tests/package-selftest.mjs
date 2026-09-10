import assert from "node:assert/strict";
import {
  MODULE_API_VERSION,
  createPeopleAnalyticsModule,
  createProjectPlanningModule,
  moduleCatalog
} from "../src/index.js";

assert.equal(MODULE_API_VERSION, "1.0.0");
assert.deepEqual(moduleCatalog.map((item) => item.id), ["asna.people-analytics", "asna.project-planning"]);
assert.ok(moduleCatalog.every((item) => item.readOnly));
assert.equal(moduleCatalog.find((item) => item.id === "asna.project-planning").version, "2.0.0");
assert.ok(moduleCatalog.every((item) => item.styles.every((style) => style.startsWith("./"))), "CSS paths должны быть относительны корню переносимого src");

const team = { id: "tempo-1", name: "Команда продукта", active: true };
const member = {
  id: "tempo-1::ivan", teamId: team.id, teamName: team.name,
  username: "ivan", displayName: "Иванов Иван", role: "Backend-разработчик",
  commitment: 100, active: true
};
const historicalIssue = {
  key: "SAMPLE-100", summary: "Backend API", assignee: { username: "ivan", displayName: "Иванов Иван" },
  status: "Done", statusCategory: "done", created: "2026-08-01T10:00:00+03:00",
  resolved: "2026-08-02T18:00:00+03:00", updated: "2026-08-02T18:00:00+03:00",
  originalEstimateSeconds: 8 * 3600, timeSpentSeconds: 8 * 3600, worklogs: []
};

const analytics = createPeopleAnalyticsModule({
  dataSource: {
    listTeams: async () => [team],
    loadTeam: async () => ({ members: [member], issues: [historicalIssue], meta: { teamId: team.id } })
  },
  settingsProvider: () => ({ doneStatuses: "Done" })
});
assert.equal((await analytics.listTeams()).length, 1);
assert.equal((await analytics.analyzeTeam({ team, from: "2026-08-01", to: "2026-08-31" })).analytics.employees.length, 1);

const employee = {
  id: "person::ivan", username: "ivan", displayName: "Иванов Иван",
  roles: ["Backend-разработчик"], commitment: 100, score: 80, confidence: 80, estimateRatio: 1
};
const jiraSource = {
  type: "jira", key: "SAMPLE-200", title: "Backend API",
  description: "Реализовать backend API. Критерии приёмки: контракт и тесты согласованы.",
  comments: [], children: []
};
const planning = createProjectPlanningModule({
  sources: { load: async () => jiraSource },
  workforce: {
    loadContext: async () => ({ employees: [employee], history: [historicalIssue], workload: [], vacations: [] })
  },
  settingsProvider: () => ({ hoursPerDay: 8 })
});
const forecast = await planning.run({
  project: "SAMPLE-200", people: [employee], teams: [team],
  historyFrom: "2026-08-01", historyTo: "2026-08-31", planningStart: "2026-09-14"
});
assert.ok(forecast.analysis.baseHours > 0);
assert.ok(forecast.result.scenarios.realistic.end);
assert.ok(Array.isArray(forecast.result.portfolio.capacity));
assert.ok(forecast.result.workItems.every((item) => item.estimateExplanation?.scenarios?.p80));

console.log("OhMyGant MR package self-test: OK");
