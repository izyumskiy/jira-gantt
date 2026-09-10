import assert from "node:assert/strict";
import {
  MODULE_API_VERSION,
  createPeopleAnalyticsModule,
  createProjectPlanningModule,
  excludeProjectWorkload,
  moduleCatalog
} from "../src/modules/index.js";

assert.equal(MODULE_API_VERSION, "1.0.0");
assert.deepEqual(moduleCatalog.map((module) => module.id), [
  "asna.people-analytics",
  "asna.project-planning"
]);
assert.ok(moduleCatalog.every((module) => module.readOnly));
assert.equal(moduleCatalog.find((module) => module.id === "asna.project-planning").version, "2.0.0");

const team = { id: "tempo-1", name: "Команда продукта", active: true };
const member = {
  id: "tempo-1::ivan",
  teamId: team.id,
  teamName: team.name,
  username: "ivan",
  displayName: "Иванов Иван",
  role: "Backend-разработчик",
  commitment: 100,
  active: true
};
const historyIssue = {
  key: "SAMPLE-100",
  summary: "Backend API",
  assignee: { username: "ivan", displayName: "Иванов Иван" },
  status: "Done",
  statusCategory: "done",
  created: "2026-08-01T10:00:00+03:00",
  resolved: "2026-08-03T10:00:00+03:00",
  updated: "2026-08-03T10:00:00+03:00",
  originalEstimateSeconds: 8 * 3600,
  timeSpentSeconds: 8 * 3600,
  worklogs: []
};

const people = createPeopleAnalyticsModule({
  dataSource: {
    listTeams: async () => [team, { id: "old", name: "Archive", active: false }],
    loadTeam: async () => ({
      members: [member],
      issues: [historyIssue],
      meta: { teamId: team.id, from: "2026-08-01", to: "2026-08-31" }
    })
  },
  settingsProvider: () => ({ doneStatuses: "Done" })
});
assert.equal((await people.listTeams()).length, 1);
const peopleResult = await people.analyzeTeam({ team, from: "2026-08-01", to: "2026-08-31" });
assert.equal(peopleResult.analytics.employees.length, 1);
assert.equal(peopleResult.analytics.employees[0].assignee, "Иванов Иван");
const headlessPeople = createPeopleAnalyticsModule({ settingsProvider: () => ({ doneStatuses: "Done" }) });
assert.equal(headlessPeople.analyzeSnapshot({
  teams: [team], members: [member], issues: [historyIssue],
  period: { from: "2026-08-01", to: "2026-08-31" }
}).employees.length, 1);

const ownWorkload = { key: "TARGET-101", epicKey: "TARGET-100", assignee: { username: "ivan" }, remainingDays: 10 };
const otherWorkload = { key: "BAZA-1", epicKey: "BAZA-100", assignee: { username: "ivan" }, remainingDays: 1, isBaza: true };
const filtered = excludeProjectWorkload([ownWorkload, otherWorkload], {
  key: "TARGET-100",
  children: [{ key: "TARGET-101" }]
});
assert.deepEqual(filtered.workload.map((issue) => issue.key), ["BAZA-1"]);
assert.deepEqual(filtered.excluded.map((issue) => issue.key), ["TARGET-101"]);

const employee = {
  id: "person::ivan",
  username: "ivan",
  displayName: "Иванов Иван",
  roles: ["Backend-разработчик"],
  commitment: 100,
  score: 80,
  confidence: 80,
  estimateRatio: 1
};
const jiraSource = {
  type: "jira",
  key: "TARGET-100",
  title: "Обновление зависимостей backend",
  description: "Нужно обновить зависимости backend. Критерии приёмки: API работает и тесты проходят.",
  comments: [],
  children: [{
    type: "jira",
    key: "TARGET-101",
    title: "Обновить зависимости",
    summary: "Обновить зависимости",
    description: "Обновить зависимости и устранить несовместимости. Критерии приёмки: тесты проходят.",
    originalEstimateSeconds: 16 * 3600,
    remainingEstimateSeconds: 16 * 3600,
    assignee: { username: "ivan" }
  }]
};
const planning = createProjectPlanningModule({
  sources: { load: async () => jiraSource },
  workforce: {
    loadContext: async () => ({
      employees: [employee],
      history: [historyIssue],
      workload: [ownWorkload, otherWorkload],
      vacations: [],
      activeProjects: [
        { key: "TARGET-100", summary: "Оцениваемый проект" },
        { key: "BAZA-100", summary: "Внешняя нагрузка" }
      ]
    })
  },
  settingsProvider: () => ({ hoursPerDay: 8 })
});
const plan = await planning.run({
  project: "TARGET-100",
  people: [employee],
  teams: [team],
  historyFrom: "2026-08-01",
  historyTo: "2026-08-31",
  planningStart: "2026-09-14"
});
assert.equal(plan.result.workloadDiagnostics.received, 2);
assert.equal(plan.result.workloadDiagnostics.used, 1);
assert.deepEqual(plan.result.workloadDiagnostics.excludedProjectIssues, ["TARGET-101"]);
assert.equal(plan.result.workloadCount, 1);
assert.ok(plan.analysis.baseHours > 0);
assert.deepEqual(plan.activeProjects.map((project) => project.key), ["BAZA-100"]);
assert.ok(Number.isFinite(plan.result.portfolio.portfolioDelayDays));
assert.ok(Array.isArray(plan.result.portfolio.capacity));
assert.ok(Array.isArray(plan.result.portfolio.resourceSensitivity));
assert.ok(plan.result.workItems.every((item) => item.estimateExplanation?.scenarios?.p80));

console.log("Module contract self-test: OK");
