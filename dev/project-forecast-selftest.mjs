import assert from "node:assert/strict";
import {
  dateKey,
  forecastProject,
  scenarioFactors,
  vacationDays,
  vacationWindow
} from "../src/js/project-forecast/domain.js";
import { analyzeProject, composeProjectSource } from "../src/js/project-forecast/analysis.js";
import { confluenceContextPath, confluencePageId, issueSourceKey, loadRequirementSource } from "../src/js/project-forecast/source.js";
import { mergeRoster } from "../src/js/project-forecast/sync.js";
import { repositoriesFor } from "../src/js/project-forecast/repository-analysis.js";
import {
  backtestPortfolio,
  buildTechnologyProfile,
  calibrateWorkload,
  detectProjectIntent,
  multitaskingProfiles,
  repositoryWorkItems
} from "../src/modules/project-planning/index.js";
import { backtestCalibration, buildCalibration, calibrationFor } from "../src/js/project-forecast/calibration.js";
import { jiraDependencyKeys } from "../src/js/project-forecast/jira-links.js";

const ivan = {
  id: "person::ivan",
  username: "ivan",
  displayName: "Иванов Иван",
  commitment: 100,
  score: 80,
  confidence: 100,
  estimateRatio: 1
};
const petr = {
  id: "person::petr",
  username: "petr",
  displayName: "Петров Пётр",
  commitment: 100,
  score: 80,
  confidence: 100,
  estimateRatio: 1
};

const roster = mergeRoster([
  { id: "1::ivan", teamId: "1", teamName: "Команда данных", username: "ivan", displayName: "Иванов Иван", role: "Backend", commitment: 60, active: true, skills: ["Python"] },
  { id: "2::ivan", teamId: "2", teamName: "Команда продукта", username: "ivan", displayName: "Иванов Иван", role: "Reviewer", commitment: 40, active: true, skills: ["SQL"] }
]);
assert.equal(roster.length, 1, "Сотрудник из нескольких команд должен отображаться один раз");
assert.deepEqual(roster[0].teamNames, ["Команда данных", "Команда продукта"]);
assert.equal(roster[0].commitment, 100);
assert.equal(issueSourceKey("https://jira.example.test/browse/SAMPLE-752"), "SAMPLE-752");
assert.equal(issueSourceKey("sample-3105"), "SAMPLE-3105");
assert.equal(confluencePageId("https://confluence.example.test/pages/viewpage.action?pageId=77728022"), "77728022");
assert.equal(confluencePageId("https://example.test/wiki/spaces/DEMO/pages/77728022/Requirements"), "77728022");
assert.equal(confluenceContextPath("https://confluence.example.test/pages/viewpage.action?pageId=1"), "");
assert.equal(confluenceContextPath("https://example.test/wiki/spaces/DEMO/pages/1/Requirements"), "/wiki");
const savedChrome = globalThis.chrome;
const savedFetch = globalThis.fetch;
globalThis.chrome = { permissions: { contains: async () => true, request: async () => true } };
globalThis.fetch = async () => ({
  status: 404,
  ok: false,
  text: async () => JSON.stringify({ statusCode: 404, data: { authorized: false, valid: true } })
});
await assert.rejects(
  loadRequirementSource("https://confluence.example.test/pages/viewpage.action?pageId=77728022"),
  (error) => error.code === "CONFLUENCE_AUTH_REQUIRED"
    && error.actionUrl.includes("pageId=77728022")
    && !error.message.includes("statusCode")
);
globalThis.chrome = savedChrome;
globalThis.fetch = savedFetch;
assert.deepEqual(repositoriesFor({ key: "SAMPLE-1", title: "Обновление backend" }), [], "Ключ и название проекта не должны неявно выбирать репозиторий");
assert.deepEqual(repositoriesFor({ key: "SAMPLE-2", title: "Новый frontend экран" }), [], "Технологические слова не должны неявно выбирать репозиторий");
assert.deepEqual(repositoriesFor({
  key: "OTHER-1",
  description: "Код: https://gitlab.example.test/team/product/-/tree/main"
}).map((row) => row.id), ["team/product"], "Явная GitLab-ссылка должна подключать репозиторий без жёсткой привязки к Jira-проекту");
assert.deepEqual(repositoriesFor({ key: "OTHER-2", description: "Репозиторий https://gitlab.example.test/group/subgroup/product" }).map((row) => row.id), ["group/subgroup/product"]);
assert.deepEqual(repositoriesFor({
  key: "OTHER-3",
  remoteLinks: [{ url: "https://code.example.test/group/service", title: "Repository", applicationType: "GitLab" }]
}).map((row) => [row.origin, row.id]), [["https://code.example.test", "group/service"]], "Jira remote link должен поддерживать произвольный GitLab-домен");

const airflowProfile = buildTechnologyProfile({
  paths: ["pyproject.toml", "dags/orders.py", "dags/tests/test_orders.py", "models/orders.sql", ".gitlab-ci.yml"],
  contents: new Map([
    ["pyproject.toml", "[project]\ndependencies = ['apache-airflow', 'dbt-core', 'pytest']"],
    [".gitlab-ci.yml", "test: pytest"]
  ]),
  languages: { Python: 82, SQL: 18 }
});
assert.ok(airflowProfile.technologies.includes("Airflow"));
assert.ok(airflowProfile.technologies.includes("dbt"));
const airflowItems = repositoryWorkItems({ label: "data-service", area: "data", technologyProfile: airflowProfile }, {
  key: "SAMPLE-999",
  title: "Добавить Airflow DAG загрузки заказов",
  description: "Нужны новая витрина и сверка данных. Провести тестирование."
});
assert.ok(airflowItems.some((item) => item.kind === "data-pipeline"));
const airflowAnalysis = analyzeProject({
  source: composeProjectSource({
    jira: { type: "jira", key: "SAMPLE-999", title: "Добавить загрузку заказов", description: "Нужны новая витрина и сверка данных.", comments: [], children: [] },
    repositoryAnalysis: { requested: true, complete: true, repositories: [{ technologyProfile: airflowProfile }], workItems: airflowItems }
  }),
  employees: [ivan],
  history: []
});
assert.ok(airflowAnalysis.technologies.includes("Airflow"), "Подтверждённый GitLab-стек должен попадать в системный анализ");

const frontendProfile = buildTechnologyProfile({
  paths: ["apps/web/package.json", "apps/web/src/App.tsx", "apps/web/src/App.test.tsx", "Dockerfile"],
  contents: new Map([["apps/web/package.json", JSON.stringify({ dependencies: { react: "18.3.0" }, devDependencies: { typescript: "5.6.0", vitest: "2.0.0" } })]]),
  languages: { TypeScript: 95, CSS: 5 }
});
assert.ok(frontendProfile.technologies.includes("React"));
assert.ok(repositoryWorkItems({ label: "frontend", area: "frontend", technologyProfile: frontendProfile }, {
  title: "Добавить экран управления заказами",
  description: "Реализовать интерфейс и состояния ошибок"
}).some((item) => item.kind === "frontend-implementation"));
const screenUpdateItems = repositoryWorkItems({ label: "web-client", technologyProfile: frontendProfile }, {
  title: "Обновить экран управления заказами",
  description: "Изменить интерфейс и состояния ошибок"
});
assert.ok(screenUpdateItems.some((item) => item.kind === "frontend-implementation"));
assert.ok(!screenUpdateItems.some((item) => item.kind === "dependency-upgrade"), "Обычное обновление UI не должно считаться обновлением зависимостей");

const dependencyProfile = buildTechnologyProfile({
  paths: ["composer.json", "composer.lock", "app/Http/Controller.php", "tests/Feature/SmokeTest.php", ".gitlab-ci.yml"],
  contents: new Map([
    ["composer.json", JSON.stringify({ require: { php: "^8.2", "vendor/runtime-core": "^4.0" }, "require-dev": { "phpunit/phpunit": "^10" } })],
    ["composer.lock", JSON.stringify({ packages: [{ name: "vendor/runtime-core", version: "v4.2.0" }], "packages-dev": [] })],
    [".gitlab-ci.yml", "phpunit"]
  ]),
  languages: { PHP: 100 }
});
assert.equal(detectProjectIntent({ title: "Обновить зависимости", description: "Обновить Composer-пакеты" }).upgrade, true);
const dependencyItems = repositoryWorkItems({ label: "backend-service", area: "backend", technologyProfile: dependencyProfile }, {
  title: "Обновить зависимости",
  description: "Обновить Composer-зависимости и выполнить регрессию"
});
assert.ok(dependencyItems.some((item) => item.kind === "dependency-audit"));
assert.ok(dependencyItems.some((item) => item.kind === "dependency-upgrade"));
assert.ok(dependencyItems.some((item) => item.kind === "breaking-changes"));

assert.equal(dateKey("2026-09-14T12:00:00+03:00"), "2026-09-14");
assert.deepEqual(vacationWindow({
  key: "TEST-1",
  summary: "Отпуск: Иванов, 14.09.2026-16.09.2026",
  status: "Сделать",
  assignee: { username: "ivan" }
}), {
  key: "TEST-1",
  assignee: { username: "ivan" },
  from: "2026-09-14",
  to: "2026-09-16"
});
assert.deepEqual(vacationWindow({
  key: "TEST-OLD",
  summary: "Отпуск Сементин 14.09 - 18.09",
  created: "2026-08-20T12:00:00+03:00",
  assignee: { username: "ivan" }
}), {
  key: "TEST-OLD",
  assignee: { username: "ivan" },
  from: "2026-09-14",
  to: "2026-09-18"
});

const vacationCalendar = vacationDays([
  { key: "TEST-1", summary: "Отпуск: Иванов, 14.09.2026-15.09.2026", assignee: { username: "ivan" } },
  { key: "TEST-2", summary: "Отпуск: Иванов, 15.09.2026-16.09.2026", assignee: { username: "ivan" } }
], [ivan]);
assert.equal(vacationCalendar.byEmployee.get(ivan.id).size, 3, "Пересекающиеся части отпуска не должны дублировать дни");

assert.deepEqual(scenarioFactors([ivan, petr], 0), {
  optimistic: 1,
  realistic: 1,
  pessimistic: 1.2,
  estimateRatio: 1,
  confidence: 100,
  score: 80
});

const parallel = forecastProject({
  employees: [ivan, petr],
  scopeDays: 2,
  planningStart: "2026-09-14",
  unknownPercent: 0,
  workload: [],
  vacations: []
});
assert.equal(parallel.scenarios.realistic.start, "2026-09-14");
assert.equal(parallel.scenarios.realistic.end, "2026-09-14");
assert.equal(parallel.employees[0].allocatedDays, 1);
assert.equal(parallel.employees[1].allocatedDays, 1);

const withVacation = forecastProject({
  employees: [ivan, petr],
  scopeDays: 2,
  planningStart: "2026-09-14",
  unknownPercent: 0,
  workload: [],
  vacations: [{ key: "TEST-3", summary: "Отпуск: Иванов, 14.09.2026-14.09.2026", assignee: { username: "ivan" } }]
});
assert.equal(withVacation.scenarios.realistic.end, "2026-09-15");

const regularProject = forecastProject({
  employees: [ivan],
  scopeDays: 1,
  planningStart: "2026-09-14",
  unknownPercent: 0,
  workload: [{ key: "TEST-4", assignee: { username: "ivan" }, remainingDays: 3, isBaza: false }],
  vacations: []
});
assert.equal(regularProject.scenarios.realistic.end, "2026-09-17");

const bazaProject = forecastProject({
  employees: [ivan],
  scopeDays: 1,
  planningStart: "2026-09-14",
  unknownPercent: 0,
  projectIsBaza: true,
  workload: [{ key: "TEST-4", assignee: { username: "ivan" }, remainingDays: 3, isBaza: false }],
  vacations: []
});
assert.equal(bazaProject.scenarios.realistic.end, "2026-09-14");
assert.ok(bazaProject.warnings.some((warning) => warning.includes("BAZA")));

const parallelPortfolio = forecastProject({
  employees: [ivan],
  scopeDays: 1,
  planningStart: "2026-09-14",
  unknownPercent: 0,
  workload: [{
    key: "ACTIVE-OLD-1", epicKey: "ACTIVE-OLD", epicSummary: "Активный эпик", assignee: { username: "ivan" },
    remainingHours: 20, remainingScenarios: { optimistic: 20, realistic: 20, pessimistic: 20 },
    scheduled: true, sprints: [{ id: 1, name: "Sprint 1", state: "active", startDate: "2026-09-14", endDate: "2026-09-18" }]
  }],
  vacations: []
});
assert.equal(parallelPortfolio.scenarios.realistic.start, "2026-09-14", "Новый проект должен использовать свободную ёмкость активного спринта");
assert.equal(parallelPortfolio.scenarios.realistic.end, "2026-09-15", "Активный эпик и новый проект должны выполняться параллельно");
assert.equal(parallelPortfolio.portfolio.activeProjects[0].predictedEnd, "2026-09-18");
assert.equal(parallelPortfolio.portfolio.portfolioDelayDays, 1, "Должен быть виден чистый сдвиг срока от активного портфеля");
assert.ok(parallelPortfolio.portfolio.activeProjects[0].criticalPressureHours > 0, "Должно быть объяснено влияние активного эпика на критический путь");
assert.ok(parallelPortfolio.portfolio.capacity.every((row) => row.occupiedHours + row.projectHours <= row.capacityHours + 0.01), "Активные эпики и новый проект не должны превышать доступную ёмкость");

const spilloverPortfolio = forecastProject({
  employees: [ivan], scopeDays: 1, planningStart: "2026-09-14", unknownPercent: 0,
  workload: [{
    key: "ACTIVE-OVER-1", epicKey: "ACTIVE-OVER", assignee: { username: "ivan" }, remainingHours: 48,
    remainingScenarios: { optimistic: 48, realistic: 48, pessimistic: 48 }, scheduled: true,
    sprints: [{ id: 1, name: "Sprint 1", state: "active", startDate: "2026-09-14", endDate: "2026-09-18" }]
  }], vacations: []
});
assert.ok(spilloverPortfolio.portfolio.activeProjects[0].spilloverHours > 0, "Перегрузка спринта должна прогнозировать spillover");

const dependencySchedule = forecastProject({
  employees: [ivan, petr], planningStart: "2026-09-14", unknownPercent: 0, workload: [], vacations: [],
  workItems: [
    { id: "B", title: "Зависимая работа", estimateHours: 8, assigneeId: petr.id, dependsOn: ["A"] },
    { id: "A", title: "Контракт", estimateHours: 8, assigneeId: ivan.id, dependsOn: [] }
  ]
});
assert.equal(dependencySchedule.workItems.find((item) => item.id === "A").start, "2026-09-14");
assert.equal(dependencySchedule.workItems.find((item) => item.id === "B").start, "2026-09-15", "Порядок входного массива не должен нарушать зависимости");

const resourceChain = forecastProject({
  employees: [ivan], planningStart: "2026-09-14", unknownPercent: 0, workload: [], vacations: [],
  workItems: [
    { id: "R-1", title: "Первая работа", estimateHours: 8, assigneeId: ivan.id },
    { id: "R-2", title: "Вторая работа", estimateHours: 8, assigneeId: ivan.id }
  ]
});
assert.deepEqual(resourceChain.portfolio.criticalPath, ["R-1", "R-2"], "Критический путь должен учитывать очередь работ одного сотрудника, а не только явные Jira links");

const inferredWorkload = calibrateWorkload([{ key: "ACTIVE-1", summary: "Backend API", type: "Task", status: "В работе", assignee: { username: "ivan" }, scheduled: true }], [
  { key: "OLD-1", summary: "Backend API", type: "Task", assignee: { username: "ivan" }, timeSpentSeconds: 24 * 3600 },
  { key: "OLD-2", summary: "Backend endpoint", type: "Task", assignee: { username: "ivan" }, timeSpentSeconds: 20 * 3600 },
  { key: "OLD-3", summary: "Backend API method", type: "Task", assignee: { username: "ivan" }, timeSpentSeconds: 28 * 3600 }
], [ivan], 8);
assert.match(inferredWorkload.workload[0].remainingSource, /исторических аналогов/);
assert.equal(inferredWorkload.workload[0].remainingHours, 13.2, "Для начатой задачи должен использоваться исторический остаток по статусу, а не один день");

const staleRemaining = calibrateWorkload([{
  key: "ACTIVE-STALE", summary: "Backend", status: "В работе", assignee: { username: "ivan" },
  originalHours: 40, remainingHours: 40, timeSpentHours: 16, scheduled: true
}], [], [ivan], 8);
assert.equal(staleRemaining.workload[0].remainingHours, 24, "Необновлённый Remaining Estimate не должен повторно учитывать списанные часы");
assert.match(staleRemaining.workload[0].remainingSource, /не обновлялся/);
assert.ok(staleRemaining.warnings.some((warning) => warning.includes("Remaining Estimate")));

assert.deepEqual(jiraDependencyKeys([{
  type: { inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: "LINK-10" }
}, {
  type: { inward: "depends on", outward: "is required for" }, inwardIssue: { key: "LINK-11" }
}]), ["LINK-10", "LINK-11"]);

const bazaKeepsStarted = forecastProject({
  employees: [ivan], scopeDays: 1, planningStart: "2026-09-14", unknownPercent: 0, projectIsBaza: true,
  workload: [{
    key: "ACTIVE-STARTED", epicKey: "ACTIVE-OLD", assignee: { username: "ivan" }, status: "В работе", inProgress: true,
    remainingHours: 8, remainingScenarios: { optimistic: 8, realistic: 8, pessimistic: 8 }, scheduled: true,
    plannedStart: "2026-09-14", plannedEnd: "2026-09-14", isBaza: false
  }], vacations: []
});
assert.equal(bazaKeepsStarted.scenarios.realistic.end, "2026-09-15", "BAZA не должен прерывать уже начатую работу задним числом");
assert.deepEqual(bazaKeepsStarted.portfolio.displacedIssueKeys, []);

const multitaskingHistory = [
  ["S-1", "E-1", "SP-1", 8], ["S-2", "E-2", "SP-2", 8], ["S-3", "E-3", "SP-3", 8],
  ["M-1", "E-4", "SP-M", 16], ["M-2", "E-5", "SP-M", 16], ["M-3", "E-4", "SP-M", 16], ["M-4", "E-5", "SP-M", 16]
].map(([key, epicKey, sprintId, actual]) => ({
  key, epicKey, summary: "Backend", assignee: { username: "ivan" }, originalEstimateSeconds: 8 * 3600,
  timeSpentSeconds: actual * 3600, sprints: [{ id: sprintId }]
}));
const multitasking = multitaskingProfiles(multitaskingHistory, [ivan])[0];
assert.equal(multitasking.factor, 1.5, "Подтверждённая историей многозадачность должна корректировать календарный коэффициент");
assert.ok(multitasking.confidence > 0);
const portfolioDates = ["2026-01-05", "2026-02-02", "2026-03-02", "2026-04-06", "2026-05-04", "2026-06-01"];
const portfolioHistory = portfolioDates.map((day, index) => ({
  key: `EP-${index + 1}-1`, epicKey: `EP-${index + 1}`, summary: "Backend", assignee: { username: "ivan" },
  created: `${day}T10:00:00+03:00`, resolved: `${day}T18:00:00+03:00`,
  originalEstimateSeconds: 8 * 3600, timeSpentSeconds: 8 * 3600
}));
const portfolioBacktest = backtestPortfolio(portfolioHistory, [ivan], 8);
assert.equal(portfolioBacktest.sample, 3);
assert.equal(portfolioBacktest.maeDays, 0);
assert.equal(portfolioBacktest.coverage.p80, 1);
assert.equal(portfolioBacktest.eligibleInitiatives, 6);
assert.equal(portfolioBacktest.effort.wape, 0);
assert.equal(portfolioBacktest.effort.coverage.p80, 1);
assert.equal(portfolioBacktest.dates.maeDays, 0);

const overlappingHistory = [1, 2, 3, 4].map((index) => ({
  key: `OVERLAP-${index}-1`, epicKey: `OVERLAP-${index}`, summary: "Backend", assignee: { username: "ivan" },
  created: "2026-01-05T10:00:00+03:00", resolved: "2026-02-06T18:00:00+03:00",
  originalEstimateSeconds: 8 * 3600, timeSpentSeconds: 8 * 3600
}));
assert.equal(backtestPortfolio(overlappingHistory, [ivan], 8).sample, 0, "Пересекающиеся инициативы не должны использовать незавершённые на дату старта данные");

const analysis = analyzeProject({
  source: {
    type: "jira",
    key: "SAMPLE-752",
    title: "Выгрузка витрины и дашборд",
    description: "Нужно создать DAG Airflow для ежедневной загрузки витрины. В Superset должен отображаться дашборд. Критерии приёмки согласованы владельцем."
  },
  history: [
    { key: "SAMPLE-700", summary: "DAG загрузки витрины", type: "Task", originalEstimateSeconds: 28 * 3600, timeSpentSeconds: 32 * 3600, components: ["Airflow"] },
    { key: "SAMPLE-701", summary: "Airflow загрузка данных", type: "Task", originalEstimateSeconds: 32 * 3600, timeSpentSeconds: 30 * 3600, components: ["Airflow"] }
  ],
  employees: [ivan, petr],
  hoursPerDay: 8
});
assert.ok(analysis.baseHours > 0, "Системный анализ должен сам сформировать оценку");
assert.ok(analysis.technologies.includes("Airflow"));
assert.ok(analysis.technologies.includes("Superset"));
assert.ok(analysis.workItems.every((item) => item.assigneeId), "Каждая работа должна иметь ответственного");
assert.ok(analysis.workItems.every((item) => item.estimateExplanation?.resultHours === item.estimateHours), "Каждая базовая оценка должна иметь проверяемое объяснение");

const jiraProject = {
  type: "jira", key: "SAMPLE-752", title: "Проект витрины", description: "Нужно подготовить ежедневную витрину.",
  comments: [], children: []
};
const withoutArticles = analyzeProject({
  source: composeProjectSource({ jira: jiraProject }), history: [], employees: [ivan], hoursPerDay: 8
});
assert.equal(withoutArticles.source.documents.businessRequirements.provided, false);
assert.equal(withoutArticles.source.documents.systemAnalysis.provided, false);
assert.ok(withoutArticles.questions.some((question) => question.includes("Бизнес-требования не проработаны")));
assert.equal(withoutArticles.systemAnalysis.mode, "express");
assert.ok(withoutArticles.systemAnalysis.components.length > 0);
assert.ok(withoutArticles.systemAnalysis.interactions.length > 0);
assert.ok(withoutArticles.workItems.some((item) => item.title === "Экспресс-системный анализ"));
assert.ok(withoutArticles.recommendedUnknownPercent >= 8 && withoutArticles.recommendedUnknownPercent <= 35);
assert.equal(withoutArticles.completeness.total, 0);

const withArticles = analyzeProject({
  source: composeProjectSource({
    jira: jiraProject,
    businessRequirements: { type: "confluence", title: "Бизнес-требования", url: "https://confluence/page/1", description: "Нужен дашборд для контроля ежедневной загрузки. Критерий приёмки: данные обновляются ежедневно." },
    systemAnalysis: { type: "confluence", title: "Системный анализ", url: "https://confluence/page/2", description: "DAG Airflow загружает данные в DWH, Superset читает витрину." }
  }),
  history: [], employees: [ivan], hoursPerDay: 8
});
assert.equal(withArticles.source.documents.businessRequirements.provided, true);
assert.equal(withArticles.source.documents.systemAnalysis.provided, true);
assert.equal(withArticles.systemAnalysis.mode, "provided");
assert.ok(withArticles.technologies.includes("Airflow"));
assert.ok(withArticles.technologies.includes("Superset"));

const complexProject = analyzeProject({
  source: composeProjectSource({
    jira: {
      type: "jira", key: "SAMPLE-999", title: "Межсистемная платформа",
      description: [
        "Нужно интегрировать внешний API с backend и frontend.",
        "Нужно создать несколько DAG Airflow для загрузки больших объёмов данных в DWH.",
        "Нужно реализовать витрины и дашборды Superset с SLA в реальном времени.",
        "Нужно настроить роли, авторизацию и ограничения доступа.",
        "Нужно выполнить миграцию данных и обеспечить производительность.",
        "Нужно реализовать экран контроля и обработку ошибок."
      ].join("\n"), comments: [], children: []
    }
  }),
  history: [], employees: [ivan], hoursPerDay: 8
});
assert.ok(complexProject.complexity.score > withoutArticles.complexity.score);
assert.ok(complexProject.recommendedUnknownPercent > withoutArticles.recommendedUnknownPercent, "Резерв должен зависеть от сложности проекта");

const repositoryBacked = analyzeProject({
  source: composeProjectSource({
    jira: { type: "jira", key: "SAMPLE-300", title: "Обновление зависимостей backend", description: "Обновить зависимости backend и устранить несовместимости. Критерии приёмки: сервис проходит регрессионные тесты.", comments: [], children: [] },
    repositoryAnalysis: {
      requested: true, complete: true, repositories: [{ id: "group/backend-service" }], warnings: [],
      workItems: [{ kind: "breaking-changes", area: "backend", title: "Адаптация несовместимых изменений · backend-service", text: "Исправить подтверждённые несовместимости backend.", suggestedHours: 46, basis: "composer.lock · состав зависимостей" }]
    }
  }),
  history: [],
  employees: [{ ...ivan, roles: ["Backend-разработчик"] }],
  hoursPerDay: 8
});
assert.equal(repositoryBacked.repositoryAnalysis.complete, true);
assert.ok(repositoryBacked.workItems.some((item) => item.basis.includes("composer.lock")), "Сигнал репозитория должен участвовать в оценке");
assert.ok(repositoryBacked.workItems.some((item) => item.estimateHours === 46));

const missingFrontend = analyzeProject({
  source: { type: "jira", key: "SAMPLE-6000", title: "Новый экран", description: "Нужно реализовать frontend экран и backend API. Критерии приёмки согласованы.", children: [] },
  history: [],
  employees: [{ ...ivan, roles: ["Backend-разработчик"] }],
  hoursPerDay: 8
});
assert.ok(missingFrontend.staffingGaps.some((gap) => gap.area === "frontend"), "При отсутствии frontend-разработчика нужно показать предупреждение");

const noDoubleCount = analyzeProject({
  source: composeProjectSource({
    jira: {
      type: "jira", key: "TARGET-100", title: "Обновление зависимостей сервиса", description: "Обновить зависимости backend, устранить несовместимости и провести регрессию. Критерии приёмки согласованы.", comments: [],
      children: [
        { key: "TARGET-101", summary: "Обновление обязательных зависимостей", description: "Обновить обязательные пакеты и устранить несовместимости. Критерии приёмки: приложение запускается.", originalEstimateSeconds: 24 * 3600, assignee: { username: "ivan" } },
        { key: "TARGET-102", summary: "Регрессионное тестирование обновления", description: "Проверить критичные сценарии после обновления. Критерии приёмки: регресс пройден.", originalEstimateSeconds: 20 * 3600, assignee: { username: "qa" } }
      ]
    },
    repositoryAnalysis: {
      requested: true, complete: true, repositories: [{ id: "group/backend-service" }], warnings: [],
      workItems: [
        { kind: "dependency-upgrade", area: "backend", title: "Обновление обязательных зависимостей · backend-service", text: "Обновить обязательные пакеты и устранить несовместимости.", suggestedHours: 38, basis: "dependency manifests" },
        { kind: "regression", area: "qa", title: "Регрессионное тестирование обновления · backend-service", text: "Проверить критичные сценарии после обновления.", suggestedHours: 26, basis: "tests" }
      ]
    }
  }),
  history: [],
  employees: [{ ...ivan, roles: ["Backend-разработчик"] }, { ...petr, id: "person::qa", username: "qa", roles: ["QA-инженер"] }],
  hoursPerDay: 8
});
assert.equal(noDoubleCount.reconciliation.repositoryCoverage.filter((row) => row.action === "merged").length, 2, "GitLab-работы должны объединяться с покрывающими задачами Jira");
assert.equal(noDoubleCount.workItems.filter((item) => item.origin === "gitlab").length, 0, "Подтверждение GitLab не должно добавлять дублирующие часы");
assert.equal(noDoubleCount.reconciliation.qa.residualHours, 0, "QA не должен добавляться второй раз, если тестирование уже покрыто");
assert.ok(noDoubleCount.workItems.some((item) => item.repositoryEvidence?.length), "GitLab должен остаться доказательством существующей строки");
assert.equal(noDoubleCount.reconciliation.totalHours, noDoubleCount.baseHours, "Реестр слагаемых должен сходиться с базовой оценкой");
assert.equal(noDoubleCount.forecastStatus.confirmed, false, "Крупное расхождение Jira и GitLab должно оставлять прогноз предварительным");

const calibrationHistory = [
  ["H-1", 10, 10], ["H-2", 10, 12], ["H-3", 10, 14], ["H-4", 10, 16], ["H-5", 10, 18], ["H-6", 10, 20]
].map(([key, estimate, actual], index) => ({
  key, summary: "Backend API", components: ["Backend"], labels: [], assignee: { username: "ivan" },
  originalEstimateSeconds: estimate * 3600, timeSpentSeconds: actual * 3600,
  resolved: `2026-0${index + 1}-15T12:00:00+03:00`
}));
const calibrationModel = buildCalibration(calibrationHistory, [{ ...ivan, roles: ["Backend-разработчик"] }], () => ({ id: "backend" }));
const backendCalibration = calibrationFor({ model: calibrationModel, employee: ivan, areaId: "backend", fallbackSpreadPercent: 30, completeness: 100 });
assert.equal(backendCalibration.source, "employee-area");
assert.equal(backendCalibration.sample, 6);
assert.ok(backendCalibration.factors.realistic > backendCalibration.factors.optimistic);
assert.ok(backtestCalibration(calibrationModel).sample > 0, "Калибровка должна проверяться последовательным backtest без будущих данных");

const itemCalibrated = forecastProject({
  employees: [ivan, petr],
  workItems: [
    { id: "B-1", title: "Backend", estimateHours: 10, assigneeId: ivan.id, calibration: { source: "employee-area", factors: { optimistic: 1, realistic: 1.2, pessimistic: 1.5 } } },
    { id: "F-1", title: "Frontend", estimateHours: 10, assigneeId: petr.id, calibration: { source: "employee-area", factors: { optimistic: 1.5, realistic: 2, pessimistic: 2.5 } } }
  ],
  hoursPerDay: 8,
  planningStart: "2026-09-14",
  unknownPercent: 0,
  workload: [],
  vacations: []
});
assert.equal(itemCalibrated.factors.mode, "item-calibrated");
assert.equal(itemCalibrated.factors.realistic, 1.6, "P80 должен быть взвешен по коэффициентам конкретных работ");
assert.deepEqual(itemCalibrated.workItems.map((item) => item.forecastHours), [12, 20]);

const decomposed = forecastProject({
  employees: [ivan, petr],
  workItems: analysis.workItems,
  hoursPerDay: 8,
  planningStart: "2026-09-14",
  unknownPercent: 20,
  workload: [],
  vacations: []
});
assert.equal(decomposed.scopeHours, analysis.baseHours);
assert.ok(decomposed.workItems.every((item) => item.start && item.end));
assert.ok(decomposed.workItems.every((item) => item.estimateExplanation?.scenarios?.p80), "Каждая работа должна объяснять P50/P80/P90");
assert.ok(decomposed.workItems.every((item) => item.estimateExplanation.scenarios.p50.forecastHours <= item.estimateExplanation.scenarios.p80.forecastHours));
assert.ok(decomposed.workItems.every((item) => item.estimateExplanation.scenarios.p80.forecastHours <= item.estimateExplanation.scenarios.p90.forecastHours));
assert.ok(decomposed.workItems.every((item) => item.forecastHours === item.estimateExplanation.scenarios.p80.forecastHours));
assert.equal(
  decomposed.employees.reduce((sum, employee) => sum + employee.estimatedHours, 0),
  analysis.baseHours,
  "Сумма оценок сотрудников должна совпадать с оценкой проекта"
);

console.log("project-forecast-selftest: OK");
