import { analyze, helpers } from "../src/js/people-metrics.js";
import { normalizeTeam, normalizeMember, selectActiveMembers } from "../src/js/people-tempo.js";
import { buildPeriodQueries, issueTouchesPeriod } from "../src/js/people-analysis-sync.js";

const log = document.querySelector("#log");
let failures = 0;
function check(name, condition, details = "") {
  const row = document.createElement("div");
  row.className = condition ? "ok" : "fail";
  row.textContent = `${condition ? "OK" : "FAIL"}  ${name}${details ? ` — ${details}` : ""}`;
  log.append(row);
  if (!condition) failures += 1;
}

const tempoTeam = normalizeTeam({ id: 7, name: "Platform", active: true });
const inactiveTeam = normalizeTeam({ id: 8, name: "Archive", archived: true });
const alice = normalizeMember({
  member: { name: "alice", key: "alice", displayname: "Alice", activeInJira: true },
  membership: { role: { name: "Backend" }, availability: 100, dateFrom: "2020-01-01" },
  grade: "Senior",
  skills: ["Java", "SQL"]
}, tempoTeam);
const inactiveMember = normalizeMember({ member: { name: "old", activeInJira: false } }, tempoTeam);
const todayAtNoon = new Date(2026, 8, 8, 12).getTime();
const activeUntilToday = normalizeMember({
  member: { name: "today", type: "USER", activeInJira: true },
  membership: { dateFrom: "2026-01-01", dateTo: "2026-09-08" }
}, tempoTeam, todayAtNoon);
const selectedMembers = selectActiveMembers([
  { teamId: 7, member: { name: "alice", type: "USER", activeInJira: true }, membership: { role: { name: "Backend" } } },
  { teamId: 7, member: { name: "alice", type: "GROUP_USER", activeInJira: true }, membership: { role: { name: "Developers" } } },
  { teamId: 8, member: { name: "mallory", type: "USER", activeInJira: true } },
  { teamId: 7, member: { name: "jira-group", type: "GROUP", activeInJira: true } },
  { teamId: 7, member: { name: "disabled", type: "USER", activeInJira: "false" } }
], tempoTeam, todayAtNoon);

check("active Tempo team is accepted", tempoTeam.active === true);
check("archived Tempo team is rejected", inactiveTeam.active === false);
check("Tempo role, grade and skills are preserved", alice.role === "Backend" && alice.grade === "Senior" && alice.skills.join(",") === "Java,SQL");
check("inactive Jira account is rejected", inactiveMember.active === false);
check("membership end date includes the whole last day", activeUntilToday.active === true);
check("members returned for another team are rejected", selectedMembers.crossTeam === 1 && selectedMembers.members.every((member) => member.teamId === "7"));
check("USER and GROUP_USER duplicates are merged", selectedMembers.members.length === 1 && selectedMembers.duplicates === 1);
check("GROUP rows and string inactive flags are rejected", selectedMembers.inactive === 2);

const periodQueries = buildPeriodQueries(["alice", "bob"], "2026-08-01", "2026-08-31");
check("assignment-history query is strictly bounded by updated date",
  periodQueries[0].jql.includes('updated >= "2026-08-01"') && periodQueries[0].jql.includes('updated < "2026-09-01"'));
check("worklog query is strictly bounded by the selected period",
  periodQueries[1].jql.includes('worklogDate >= "2026-08-01"') && periodQueries[1].jql.includes('worklogDate <= "2026-08-31"'));
check("old untouched issue is excluded by client period guard", !issueTouchesPeriod({
  created: "2024-01-01", updated: "2025-01-01", histories: [], worklogs: []
}, "2026-08-01", "2026-08-31"));
check("issue with a worklog in period passes client period guard", issueTouchesPeriod({
  created: "2024-01-01", updated: "2025-01-01", histories: [], worklogs: [{ started: "2026-08-15T10:00:00Z" }]
}, "2026-08-01", "2026-08-31"));

const settings = {
  sleDays: 14, longDays: 30, legacyDays: 180, confidenceSample: 4, reopenWarningPercent: 20,
  bugTypes: "Bug,Ошибка", activeStatuses: "IN PROGRESS,CODE REVIEW", waitStatuses: "WAITING", doneStatuses: "ON PROD",
  weights: { speed: 25, predictability: 20, quality: 20, estimation: 25, ownership: 10 }
};
const at = (day, hour = 12) => `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
function issue(index, options = {}) {
  const started = 2 + index * 4, resolved = started + (options.slow ? 12 : 3);
  const histories = [
    { at: at(started), items: [{ field: "status", fromString: "To Do", toString: "In Progress" }] },
    { at: at(started + 1), items: [{ field: "status", fromString: "In Progress", toString: "Code Review" }] },
    ...(options.reopened ? [
      { at: at(started + 2), items: [{ field: "status", fromString: "Code Review", toString: "Done" }] },
      { at: at(started + 2, 18), items: [{ field: "status", fromString: "Done", toString: "In Progress" }] }
    ] : []),
    { at: at(resolved), items: [{ field: "status", fromString: options.reopened ? "In Progress" : "Code Review", toString: "Done" }] },
    ...(options.reassignedAfter ? [{ at: at(resolved + 1), items: [{ field: "assignee", from: "alice", fromString: "Alice", to: "bob", toString: "Bob" }] }] : [])
  ];
  return {
    key: `PLAT-${index + 1}`, summary: `Issue ${index + 1}`,
    assignee: options.reassignedAfter ? { username: "bob", displayName: "Bob" } : { username: "alice", displayName: "Alice" },
    type: index === 0 ? "Bug" : "Story", priority: index === 1 ? "High" : "Medium", status: "Done",
    project: { key: "PLAT", name: "Platform" }, created: at(started - 1), resolved: at(resolved), updated: at(resolved + 1),
    originalEstimateSeconds: 8 * 3600, timeSpentSeconds: 8 * 3600,
    labels: ["backend"], components: ["API"], sprints: [{ id: "1", name: "Sprint", endDate: at(resolved + 1) }], histories,
    worklogs: [{ username: "alice", displayName: "Alice", started: at(started + 1), timeSpentSeconds: 8 * 3600 }]
  };
}
const issues = [issue(0, { reopened: true }), issue(1), issue(2), issue(3, { reassignedAfter: true })];
const report = analyze([tempoTeam], [alice], issues, settings, { from: "2026-08-01", to: "2026-08-31" });
const employee = report.employees[0];

check("completion is attributed to owner at resolution", employee.closed === 4, String(employee.closed));
check("reopen is detected as Done → active", employee.reopened === 1 && employee.reopenRate === .25, String(employee.reopenRate));
check("plan/fact median is calculated", employee.estimate.known === 4 && employee.estimate.medianRatio === 1);
check("Tempo worklogs are limited to employee and period", employee.loggedSeconds === 32 * 3600, String(employee.loggedSeconds));
check("combined score and confidence are available", Number.isFinite(employee.score) && employee.confidence >= 80, `${employee.score}/${employee.confidence}`);
check("skills are inferred from Jira evidence", employee.inferredSkills.some((row) => row.name === "API"));
check("team comparison is aggregated", report.teams[0].closed === 4 && report.teams[0].projects[0].key === "PLAT");
check("ownerAt helper handles post-resolution reassignment", helpers.sameUser(helpers.ownerAt(issues[3], issues[3].resolved), alice));

const total = document.createElement("div");
total.className = failures ? "fail" : "ok";
total.textContent = failures ? `${failures} FAILED` : "ALL PASSED";
log.prepend(total);
