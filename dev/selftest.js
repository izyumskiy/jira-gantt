// Дев-проверка чистой логики без Jira и без Chrome: подменяем chrome.storage и гоняем агрегацию.
globalThis.chrome = {
  storage: { local: { _d: {}, async get(k) { return { [k]: this._d[k] }; }, async set(o) { Object.assign(this._d, o); } } },
  permissions: { async contains() { return true; }, async request() { return true; } },
  runtime: { getURL: (p) => p }
};

import { setLang, applyI18n, t } from "../src/js/i18n.js";
import * as settings from "../src/js/settings.js";
import * as agg from "../src/js/agg.js";
import * as gantt from "../src/js/gantt.js";
import { parseSprint } from "../src/js/sync.js";
import { classify, isDoneStatus } from "../src/js/status.js";
import { collectPeople, mergeProfiles, parseSystems, systemsList, normName } from "../src/js/team.js";

const log = document.getElementById("log");

// Временно включает свой список завершающих статусов.
async function withDoneSetting(value, fn) {
  await settings.save({ doneStatuses: value });
  try {
    return fn();
  } finally {
    await settings.save({ doneStatuses: "" });
  }
}
let failures = 0;
function check(name, cond, extra = "") {
  const div = document.createElement("div");
  div.className = cond ? "t-ok" : "t-fail";
  div.textContent = `${cond ? "OK  " : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`;
  log.append(div);
  if (!cond) failures++;
}

const day = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * day).toISOString();

// Две команды: Alpha (доска 3) со спринтами 1–4 и Beta (доска 7) со спринтами 5–6, сдвинутыми на 2 дня.
const boards = [{ id: 3, name: "Alpha" }, { id: 7, name: "Beta" }];
const sprints = [
  { id: 1, name: "Sprint 1", state: "CLOSED", startDate: iso(-28), endDate: iso(-14), completeDate: iso(-14), boardId: 3 },
  { id: 2, name: "Sprint 2", state: "ACTIVE", startDate: iso(-3), endDate: iso(11), boardId: 3 },
  { id: 3, name: "Sprint 3", state: "FUTURE", startDate: iso(11), endDate: iso(25), boardId: 3 },
  { id: 4, name: "Sprint 4", state: "FUTURE", startDate: iso(25), endDate: iso(39), boardId: 3 },
  { id: 5, name: "B-Sprint 1", state: "ACTIVE", startDate: iso(-1), endDate: iso(13), boardId: 7 },
  { id: 6, name: "B-Sprint 2", state: "FUTURE", startDate: iso(13), endDate: iso(27), boardId: 7 },
  { id: 9, name: "Someday", state: "FUTURE", startDate: null, endDate: null, boardId: 7 }
];

const H = 3600;
const STATUS = {
  new: { statusName: "К выполнению", statusCategory: "new" },
  prog: { statusName: "В работе", statusCategory: "indeterminate" },
  done: { statusName: "Готово", statusCategory: "done" },
  prod: { statusName: "On Prod", statusCategory: "indeterminate" }
};
const mk = (key, epic, prj, who, sprintId, hours, st = "new") => ({
  key, epicKey: epic, projectKey: prj, projectName: prj + " project",
  assigneeKey: who ? who.toLowerCase() : "", assigneeName: who || "", assigneeLogin: who ? who.toLowerCase() : "",
  sprintId, sprintName: sprintId ? "Sprint " + sprintId : "",
  originalEstimate: hours * H, remainingEstimate: hours * H, storyPoints: hours,
  ...STATUS[st]
});

const issues = [
  mk("A-1", "EP-1", "AAA", "Ivan", 2, 8, "done"),
  mk("A-2", "EP-1", "AAA", "Ivan", 2, 4, "prog"),
  mk("A-3", "EP-1", "BBB", "Olga", 3, 16, "prod"),
  mk("A-4", "EP-1", "BBB", null, null, 2, "done"),   // без спринта и уже готова — нигде не считается
  mk("A-6", "EP-1", "AAA", "Olga", null, 5, "new"),  // без спринта и не сделана — попадёт в «без спринта»
  mk("A-5", "EP-1", "AAA", "Ivan", 1, 40, "new"),    // закрытый спринт — вне таймлайна
  mk("A-7", "EP-1", "AAA", "Petr", 5, 6, "prog"),    // команда Beta, тот же период, что Sprint 2
  mk("B-1", "EP-2", "CCC", "Olga", 2, 24, "prog"),
  mk("B-2", "EP-2", "BBB", "Ivan", 3, 6, "done"),
  mk("C-1", "EP-3", "DDD", "Petr", 5, 3, "prog"),
  mk("D-1", "EP-4", "DDD", "Petr", 6, 3, "new"),
  mk("E-1", "EP-5", "DDD", "Petr", 9, 3, "new")      // спринт без дат
];
// Задачи людей вне целевых эпиков (снимок на текущий/будущие спринты).
const others = [
  { ...mk("X-1", "EP-9", "XXX", "Ivan", 2, 8, "prog"), epicSummary: "Миграция" },
  { ...mk("X-2", "EP-8", "XXX", "Petr", 6, 4, "new"), epicSummary: "Инфра" },
  { ...mk("X-3", "", "XXX", "Petr", 6, 2, "new"), epicSummary: "" }
];
const epics = [
  { key: "EP-1", summary: "Личный кабинет", statusName: "В работе", statusCategory: "indeterminate" },
  { key: "EP-2", summary: "Биллинг", statusName: "Готово", statusCategory: "done" },
  { key: "EP-3", summary: "Отчёты", statusName: "Бизнес тест", statusCategory: "indeterminate" },
  { key: "EP-4", summary: "Импорт", statusName: "Сделать", statusCategory: "new" },
  { key: "EP-5", summary: "Уведомления", statusName: "New", statusCategory: "new" }
];

await settings.load();
await settings.save({
  lang: "ru",
  estimateField: "original",
  hoursPerDay: 8,
  baseUrl: "https://jira.example.local/",
  fields: { epicLink: "customfield_10100", sprint: "customfield_10101", storyPoints: "" }
});
setLang("ru");
applyI18n();

// 1. разбор строкового спринта Jira Server
const raw =
  "com.atlassian.greenhopper.service.sprint.Sprint@6f0[id=57,rapidViewId=12,state=ACTIVE,name=Спринт 5, релиз,startDate=2026-01-09T10:00:00.000+03:00,endDate=2026-01-23T10:00:00.000+03:00,completeDate=<null>,sequence=57,goal=]";
const ps = parseSprint(raw);
check("parseSprint id", ps && ps.id === 57, JSON.stringify(ps));
check("parseSprint name", ps && ps.name === "Спринт 5, релиз", ps && ps.name);
check("parseSprint state", ps && ps.state === "ACTIVE");
check("parseSprint completeDate=null", ps && ps.completeDate === null);
check("parseSprint boardId", ps && ps.boardId === 12);
check("parseSprint объектом", parseSprint({ id: 9, name: "X", state: "future" }).state === "FUTURE");

// 2. текущий спринт и временные секции
check("currentSprint = активный по датам", agg.currentSprint(sprints)?.id === 2, String(agg.currentSprint(sprints)?.id));
check("шаг секции = самая частая длина спринта", agg.sprintStepDays(sprints) === 14, String(agg.sprintStepDays(sprints)));
const cols = agg.timeline(sprints, issues);
check("секция 0 начинается с текущего спринта", cols[0]?.id === "sec:0" && cols[0].sprints.some((s) => s.id === 2));
check("спринты двух команд в одной секции", cols[0]?.sprints.map((s) => s.id).join(",") === "2,5", cols[0]?.sprints.map((s) => s.id).join(","));
check("вторая секция: Sprint 3 + B-Sprint 2", cols[1]?.sprints.map((s) => s.id).join(",") === "3,6", cols[1]?.sprints.map((s) => s.id).join(","));
check("пустой хвост (Sprint 4) обрезан, спринт без дат — последняя колонка",
  cols.map((c) => c.id).join(",") === "sec:0,sec:1,sec:nodate", cols.map((c) => c.id).join(","));
check("подпись секции — диапазон дат", /^\d{2}\.\d{2} – \d{2}\.\d{2}$/.test(cols[0].label), cols[0].label);

// 3. модель по эпикам
const m1 = agg.buildModel({ issues, sprints, epics, boards, mode: "epic" });
const ep1 = m1.groups.find((g) => g.key === "EP-1");
check("EP-1 всего задач", ep1.count === 7, String(ep1.count));
check("EP-1 без спринта — только невыполненные", ep1.noSprint === 1, String(ep1.noSprint));
check("EP-1 сумма оценок = 81ч", ep1.sum === 81 * H, String(ep1.sum / H));
check("EP-1 секция 0 = 3 задачи / 18ч (обе команды)", ep1.cells.get("sec:0")?.count === 3 && ep1.cells.get("sec:0")?.sum === 18 * H,
  JSON.stringify([ep1.cells.get("sec:0")?.count, ep1.cells.get("sec:0")?.sum / H]));
const aaa = ep1.projects.find((p) => p.key === "AAA");
check("AAA в секции 0 разложен по спринтам 2 и 5", [...(aaa.cells.get("sec:0")?.bySprint.keys() || [])].join(",") === "2,5",
  [...(aaa.cells.get("sec:0")?.bySprint.keys() || [])].join(","));
check("EP-1 закрытый спринт не в ячейках", ![...ep1.cells.values()].some((c) => c.bySprint.has(1)));
check("EP-1 проекты AAA+BBB", ep1.projects.map((p) => p.key).sort().join(",") === "AAA,BBB");
check("EP-1 подпись с ключом и названием", ep1.label.includes("EP-1") && ep1.label.includes("Личный кабинет"), ep1.label);
check("EP-1 готовых задач (включая On Prod)", ep1.done === 3, String(ep1.done));
check("EP-1 задач в прочих статусах", ep1.other === 4, String(ep1.other));
check("EP-1 разбивка сходится с общим", ep1.done + ep1.other === ep1.count);
check("EP-1 статус эпика из Jira", ep1.status?.name === "В работе" && ep1.status?.category === "indeterminate", JSON.stringify(ep1.status));
const ep2 = m1.groups.find((g) => g.key === "EP-2");
check("EP-2 статус эпика", ep2.status?.category === "done", JSON.stringify(ep2.status));
check("isDone по имени статуса без категории", agg.isDone({ statusName: "Закрыт" }) && !agg.isDone({ statusName: "В работе" }));
check("легенда: две команды", m1.teams.map((x) => x.name).join(",") === "Alpha,Beta", m1.teams.map((x) => x.name).join(","));
check("команда спринта по доске", m1.teamOfSprint(5)?.name === "Beta" && m1.teamOfSprint(2)?.name === "Alpha");

// 3b. классификация статусов и порядок эпиков
const cls = (n, c = "") => classify(n, c).id;
check("classify «В работе»", cls("В работе") === "progress");
check("classify «Бизнес тест»", cls("Бизнес-тест") === "test", cls("Бизнес-тест"));
check("classify «На тестировании»", cls("На тестировании") === "test");
check("classify «Сделать»", cls("Сделать") === "todo");
check("classify «New»", cls("New") === "new");
check("classify «Готово»", cls("Готово") === "done");
check("classify неизвестного по категории", classify("Согласование", "indeterminate").rank === 3, JSON.stringify(classify("Согласование", "indeterminate")));
check("classify «On Prod» → готово", cls("On Prod") === "done", cls("On Prod"));
check("«On Prod» готов вопреки жёлтой категории", isDoneStatus("On Prod", "indeterminate"));
check("«На проде» готов", isDoneStatus("На проде", "indeterminate"));
check("«Preprod testing» не готов", !isDoneStatus("Preprod testing", "indeterminate"), cls("Preprod testing"));
check("«Готовим релиз» не готово", !isDoneStatus("Готовим релиз", "indeterminate"), cls("Готовим релиз"));
check("classify «Cancel» → готово", cls("Cancel") === "done", cls("Cancel"));
check("«Cancelled» готов вопреки категории", isDoneStatus("Cancelled", "indeterminate"));
check("«Отменена» готова", isDoneStatus("Отменена", "new"));
check("выполненная задача без спринта не в счётчике", agg.buildModel({ issues: [mk("Z-1", "EP-1", "AAA", "Ivan", null, 4, "done")], sprints, epics, boards, mode: "epic" }).groups[0].noSprint === 0);
check("категория done без знакомого имени всё равно готова", isDoneStatus("Ушло клиенту", "done"));
check("статус из настроек попадает в готово", await withDoneSetting("Sign off", () => isDoneStatus("Sign off", "indeterminate")));
check("чужой статус без настройки не готов", !isDoneStatus("Sign off", "indeterminate"));
check(
  "порядок эпиков: в работе → тест → сделать → new → готово",
  m1.groups.map((g) => g.key).join(",") === "EP-1,EP-3,EP-4,EP-5,EP-2",
  m1.groups.map((g) => `${g.key}:${g.statusRank}`).join(" ")
);

// 4. модель по людям: команды
const m2 = agg.buildModel({ issues, others, sprints, epics, boards, mode: "assignee" });
const m1o = agg.buildModel({ issues, others, sprints, epics, boards, mode: "epic" });
check("«прочие» не влияют на Гант по эпикам", m1o.groups.every((g) => g.otherCount === 0) && !m1o.groups.some((g) => g.key === "EP-9"));
const ivan = m2.groups.find((g) => g.key === "ivan");
check("Ivan всего задач", ivan.count === 4, String(ivan.count));
check("Ivan секция 1 = 1 задача / 6ч", ivan.cells.get("sec:1")?.count === 1 && ivan.cells.get("sec:1")?.sum === 6 * H);
check("Ivan готовых задач", ivan.done === 2, String(ivan.done));
check("Ivan задач в прочих статусах", ivan.other === 2, String(ivan.other));
check("у исполнителя нет лейбла статуса", ivan.status === null);
check("Ivan в команде Alpha", ivan.team?.name === "Alpha", ivan.team?.name);
check("Ivan: прочие эпики — 1 задача / 8ч", ivan.otherCount === 1 && ivan.otherSum === 8 * H, `${ivan.otherCount} / ${ivan.otherSum / H}`);
check("Ivan: целевые итоги не смешаны с прочими", ivan.count === 4 && ivan.sum === 58 * H, `${ivan.count} / ${ivan.sum / H}`);
check("Ivan: прочие в секции 0 по спринту 2", ivan.otherCells.get("sec:0")?.bySprint.get(2)?.count === 1);
check("Ivan: список прочих эпиков", ivan.otherEpics.map((e) => `${e.key}:${e.summary}`).join(",") === "EP-9:Миграция", JSON.stringify(ivan.otherEpics));
const petr = m2.groups.find((g) => g.key === "petr");
check("Petr в команде Beta", petr.team?.name === "Beta", petr.team?.name);
check("Petr: прочие — 2 задачи / 6ч, задача без эпика учтена", petr.otherCount === 2 && petr.otherSum === 6 * H, `${petr.otherCount} / ${petr.otherSum / H}`);
check("Petr: прочие эпики отсортированы по объёму, без эпика — прочерком", petr.otherEpics.map((e) => e.key || "—").join(",") === "EP-8,—", petr.otherEpics.map((e) => e.key).join(","));
const nobody = m2.groups.find((g) => g.key === "");
check("группа «без исполнителя»", nobody && nobody.label === t("gantt.noAssignee"), nobody && nobody.label);
check("без спринтов — без команды", nobody.team?.id === "" && nobody.team?.name === t("gantt.noTeam"), nobody.team?.name);
check("люди отсортированы по командам: Alpha, Beta, без команды",
  m2.groups.map((g) => `${g.team.name}/${g.label}`).join(","),
  m2.groups.map((g) => `${g.team.name}/${g.label}`).join(","));
check("порядок команд", m2.groups.map((g) => g.team.name).join(",") === "Alpha,Alpha,Beta,Без команды", m2.groups.map((g) => g.team.name).join(","));

// 4b. вкладка «Команда»: люди из выгрузки и сопоставление профилей по имени
const people = collectPeople(issues, others);
check("люди из выгрузки — уникальные исполнители по алфавиту", people.map((p) => p.displayName).join(",") === "Ivan,Olga,Petr", people.map((p) => p.displayName).join(","));
check("без исполнителя в списке нет", !people.some((p) => !p.displayName));
check("normName: регистр, пробелы, ё", normName("  Иван  Ёлкин ") === "иван елкин", normName("  Иван  Ёлкин "));
const profiles = [
  { name: "ivan", displayName: "Ivan", role: "developer", systems: ["CRM"], status: "staff" },
  { name: "maria", displayName: "Maria", role: "qa", systems: [], status: "fired" }
];
const merged = mergeProfiles(people, profiles);
check("профиль Ivan сопоставлен по имени", merged.find((r) => r.name === "ivan")?.role === "developer" && merged.find((r) => r.name === "ivan")?.loaded === true);
check("у новых людей пустой профиль", merged.find((r) => r.name === "olga")?.role === "" && Array.isArray(merged.find((r) => r.name === "olga")?.systems));
check("профиль ушедшего из выгрузки сохранён с пометкой", merged.find((r) => r.name === "maria")?.loaded === false, JSON.stringify(merged.map((r) => `${r.name}:${r.loaded}`)));
check("порядок: сначала выгрузка, потом остальные", merged.map((r) => r.name).join(",") === "ivan,olga,petr,maria", merged.map((r) => r.name).join(","));
check("parseSystems: строки/запятые/дубли", parseSystems("CRM\nBilling, crm ;Mobile").join("|") === "CRM|Billing|Mobile", parseSystems("CRM\nBilling, crm ;Mobile").join("|"));
await settings.save({ infoSystems: ["Billing"] });
check("справочник систем дополняется выбранными у людей", systemsList(merged).join("|") === "Billing|CRM", systemsList(merged).join("|"));
await settings.save({ infoSystems: [] });

// 4c. модель «эпики → исполнители» (Гант по эпикам и людям)
const m3 = agg.buildModel({ issues, others, sprints, epics, boards, mode: "epicPeople" });
check("epicPeople: группы — те же эпики в том же порядке", m3.groups.map((g) => g.key).join(",") === m1.groups.map((g) => g.key).join(","), m3.groups.map((g) => g.key).join(","));
const ep1p = m3.groups.find((g) => g.key === "EP-1");
check("epicPeople: вложенные строки — исполнители (A-4 без спринта и готова → «Без исполнителя» скрыт)",
  ep1p.projects.map((p) => p.label).sort().join(",") === "Ivan,Olga,Petr", ep1p.projects.map((p) => p.label).join(","));
check("epicPeople: ключ вложенной строки — ключ исполнителя", ep1p.projects.some((p) => p.key === "ivan"));
check("epicPeople: итоги эпика совпадают с «Гантом по эпикам»", ep1p.count === ep1.count && ep1p.sum === ep1.sum && ep1p.backlog.count === ep1.backlog.count);
check("epicPeople: Ivan в EP-1 — 3 задачи (2 в секции 0)", ep1p.projects.find((p) => p.key === "ivan")?.count === 3 && ep1p.projects.find((p) => p.key === "ivan")?.cells.get("sec:0")?.count === 2);
check("epicPeople: статус эпика и сортировка сохранены", ep1p.status?.id === "progress" && m3.childKind === "person");
check("epicPeople: «прочие» не учитываются", m3.groups.every((g) => g.otherCount === 0));
// внутри эпика — только люди с задачами в текущем/будущих спринтах или в бэклоге
const m3f = agg.buildModel({
  issues: [
    mk("F-1", "EP-1", "AAA", "Ivan", 2, 8, "prog"),     // текущий спринт → виден
    mk("F-2", "EP-1", "AAA", "Zed", 1, 4, "prog"),      // только закрытый спринт → скрыт
    mk("F-3", "EP-1", "AAA", "Yan", null, 2, "done"),   // без спринта, но готово → скрыт
    mk("F-4", "EP-1", "AAA", "Kim", null, 2, "new"),    // без спринта, не готово (бэклог) → виден
    mk("F-5", "EP-1", "AAA", "Lee", 9, 1, "new")        // будущий спринт без дат → виден
  ],
  sprints, epics, boards, mode: "epicPeople"
});
const f1 = m3f.groups.find((g) => g.key === "EP-1");
check("epicPeople: скрыты люди только с закрытыми спринтами или готовыми задачами без спринта",
  f1.projects.map((p) => p.label).sort().join(",") === "Ivan,Kim,Lee", f1.projects.map((p) => p.label).join(","));
check("epicPeople: итоги эпика при этом по всем задачам", f1.count === 5 && f1.sum === 17 * H, `${f1.count} / ${f1.sum / H}`);
const m1f = agg.buildModel({ issues: [mk("F-2", "EP-1", "AAA", "Zed", 1, 4, "prog")], sprints, epics, boards, mode: "epic" });
check("на «По эпикам» проекты не отсеиваются", m1f.groups[0].projects.length === 1);

const g3 = document.createElement("div");
document.body.append(g3);
let clicked = null;
gantt.render(g3, m3, { mode: "epicPeople", highlightChild: "ivan", onChildClick: (k, n) => (clicked = `${k}:${n}`) });
check("epicPeople: колонка «Бэклог» и нумерация как у эпиков", g3.querySelectorAll("thead .c-sprint.backlog").length === 1 && g3.querySelectorAll(".gnum").length === m3.groups.length);
check("epicPeople: имена людей — кнопки", g3.querySelectorAll(".g-row.proj .plabel-link").length > 0);
check("epicPeople: лейблов с цифрами нет ни у эпиков, ни у людей", g3.querySelectorAll(".badges").length === 0, String(g3.querySelectorAll(".badges").length));
check("epicPeople: строка выбранного человека подсвечена", [...g3.querySelectorAll(".g-row.proj.hl")].every((r) => r.querySelector(".plabel").textContent === "Ivan") && g3.querySelectorAll(".g-row.proj.hl").length === 2, String(g3.querySelectorAll(".g-row.proj.hl").length));
g3.querySelector(".g-row.proj .plabel-link").click();
check("epicPeople: клик по имени отдаёт ключ и имя", /^[a-z]+:.+$/.test(clicked || ""), clicked);
gantt.setCollapsed("epicPeople", ["EP-1"]);
gantt.render(g3, m3, { mode: "epicPeople" });
const ep1Row3 = [...g3.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith("EP-1"));
check("epicPeople: setCollapsed сворачивает указанные эпики", ep1Row3.nextElementSibling?.classList.contains("group") && ep1Row3.querySelector(".twisty").textContent === "▸",
  `${ep1Row3.nextElementSibling?.className} / ${ep1Row3.querySelector(".twisty").textContent}`);
gantt.resetCollapse();
g3.remove();

// 5. форматирование оценок
check("fmtEstimate 4ч", agg.fmtEstimate(4 * H) === "4ч", agg.fmtEstimate(4 * H));
check("fmtEstimate 12ч -> 1.5д", agg.fmtEstimate(12 * H) === "1.5д", agg.fmtEstimate(12 * H));
check("fmtEstimate 0 -> прочерк", agg.fmtEstimate(0) === "—");
await settings.save({ estimateField: "points" });
check("fmtEstimate story points", agg.fmtEstimate(5) === "5 SP", agg.fmtEstimate(5));
await settings.save({ estimateField: "original" });

// 6. переключение языка
setLang("en");
check("i18n en", t("gantt.epic") === "Epic");
setLang("ru");
check("i18n ru", t("gantt.epic") === "Эпик");

// Профили с вкладки «Команда»: Ivan уволен, Olga — аутстаф, у Petr профиля нет.
const peopleProfiles = [
  { name: "ivan", displayName: "Ivan", role: "developer", status: "fired", systems: ["CRM", "Billing"] },
  { name: "olga", displayName: "Olga", role: "qa", status: "outstaff", systems: [] }
];
gantt.render(document.getElementById("g1"), m1, { mode: "epic" });
gantt.render(document.getElementById("g2"), m2, { mode: "assignee", profiles: peopleProfiles });

// 7. отрисовка
const lz = document.querySelectorAll("#g1 .lozenge");
check("лейбл статуса у каждого эпика", lz.length === m1.groups.length, String(lz.length));
const lzClasses = [...lz].map((n) => n.className.replace("lozenge ", ""));
check("свой класс на каждый статус", new Set(lzClasses).size === 5, lzClasses.join(" "));
check("первым идёт эпик в работе", lz[0].textContent === "В работе", lz[0].textContent);
check("в Ганте по людям лейблов статуса нет (только роли)", document.querySelectorAll("#g2 .lozenge:not(.lz-role)").length === 0);

const nums = [...document.querySelectorAll("#g1 .gnum")].map((n) => n.textContent);
check("эпики пронумерованы подряд", nums.join(" ") === "1. 2. 3. 4. 5.", nums.join(" "));
check("исполнители не нумеруются", document.querySelectorAll("#g2 .gnum").length === 0);
check("на «По эпикам» и «По людям» лейблы с цифрами остались",
  document.querySelectorAll("#g1 .g-row.group .badges").length === m1.groups.length && document.querySelectorAll("#g2 .g-row.group .badges").length === m2.groups.length);

// зелёная заливка — доля готовых задач по оценке
const ep1Sec0Bar = [...document.querySelectorAll("#g1 .g-row.group")][0].querySelectorAll(".c-cell")[0].querySelector(".bar-group");
check("заливка полосы EP-1 в секции 0 = доля готовых по оценке (8ч из 18ч → 44%)", ep1Sec0Bar.style.getPropertyValue("--fill") === "44%" && ep1Sec0Bar.dataset.done === "1/3",
  `${ep1Sec0Bar.style.getPropertyValue("--fill")} / ${ep1Sec0Bar.dataset.done}`);
check("заливка полосы бэклога — 0% (там нет готовых)", [...document.querySelectorAll("#g1 .g-row.group")][0].querySelector("td.c-backlog .bar").style.getPropertyValue("--fill") === "0%");
check("вложенный отрезок Sprint 2 у AAA: 8ч из 12ч готово → 67%",
  [...document.querySelectorAll("#g1 .g-row.proj")][0].querySelectorAll(".c-cell")[0].querySelector(".bar").style.getPropertyValue("--fill") === "67%",
  [...document.querySelectorAll("#g1 .g-row.proj")][0].querySelectorAll(".c-cell")[0].querySelector(".bar").style.getPropertyValue("--fill"));
check("легенда про зелёную заливку", document.querySelector("#g1 .legend-done")?.textContent.includes(t("gantt.legendDone")));
check("полосы групп — жёлтые (.bar-group), у проектов их нет",
  document.querySelectorAll("#g1 .g-row.group .bar").length > 0 &&
  [...document.querySelectorAll("#g1 .g-row.group .bar")].every((b) => b.classList.contains("bar-group")) &&
  document.querySelectorAll("#g1 .g-row.proj .bar-group").length === 0);
const firstProjBars = [...[...document.querySelectorAll("#g1 .g-row.proj")][0].querySelectorAll(".c-cell")[0].querySelectorAll(".bar")];
check("у проекта в секции 0 два вложенных голубых отрезка",
  firstProjBars.length === 2 && firstProjBars.every((b) => b.classList.contains("nested") && !b.classList.contains("bar-group")),
  firstProjBars.map((b) => b.className).join("|"));
check("в отрезках подписаны спринты", firstProjBars.map((b) => b.querySelector(".bar-sprint").textContent).join("|") === "Sprint 2|B-Sprint 1",
  firstProjBars.map((b) => b.querySelector(".bar-sprint").textContent).join("|"));
check("вложенные отрезки ниже групповых",
  firstProjBars[0].getBoundingClientRect().height < document.querySelector("#g1 .g-row.group .bar").getBoundingClientRect().height,
  `${firstProjBars[0].getBoundingClientRect().height} < ${document.querySelector("#g1 .g-row.group .bar").getBoundingClientRect().height}`);
check("колонка секции стала 264px", getComputedStyle(document.documentElement).getPropertyValue("--col-w").trim() === "264px",
  getComputedStyle(document.documentElement).getPropertyValue("--col-w"));
check("в заголовке секции перечислены спринты обеих команд",
  [...document.querySelectorAll("#g1 thead .c-sprint")][0].querySelectorAll(".sp-item").length === 2);
const heads = [...document.querySelectorAll("#g1 thead .c-sprint")].map((th) => th.textContent);
check("в заголовках секций нет дат", heads.every((h) => !/\d{2}\.\d{2}/.test(h)), heads.join(" | "));
check("текущая секция помечена словом «текущий», без дат", [...document.querySelectorAll("#g1 thead .c-sprint")][0].querySelector(".sp-name")?.textContent === t("gantt.current"),
  [...document.querySelectorAll("#g1 thead .c-sprint")][0].querySelector(".sp-name")?.textContent);
check("у второй секции подписи нет — только спринты", ![...document.querySelectorAll("#g1 thead .c-sprint")][1].querySelector(".sp-name"));
check("секция без дат подписана «Без дат»", [...document.querySelectorAll("#g1 thead .c-sprint:not(.backlog)")].at(-1).querySelector(".sp-name")?.textContent === t("gantt.noDates"));
check("легенда команд отрисована", document.querySelectorAll("#g1 .legend-item").length === 2);
const left = [...document.querySelectorAll("#g1 .g-row.group .badge.b-left")].map((b) => b.textContent);
check("жёлтый баллон «осталось» у каждого эпика", left.length === 5 && left[0] === "4", left.join(" "));
check("у исполнителей жёлтого баллона нет", document.querySelectorAll("#g2 .badge.b-left").length === 0);
const ivanRow = [...document.querySelectorAll("#g2 .g-row.group")].find((r) => r.querySelector(".glabel").textContent === "Ivan");
const ivanSplit = ivanRow.querySelectorAll(".c-cell")[0].querySelector(".bar-split");
check("полоса человека разделена на жёлтую и серую части", !!ivanSplit && ivanSplit.querySelectorAll(".part").length === 2 &&
  !!ivanSplit.querySelector(".part-target") && !!ivanSplit.querySelector(".part-other"));
check("в жёлтой части — целевые (2 · 1.5д), в серой — прочие (1 · 1д)",
  ivanSplit.querySelector(".part-target").textContent === "21.5д" && ivanSplit.querySelector(".part-other").textContent === "11д",
  `${ivanSplit.querySelector(".part-target").textContent} | ${ivanSplit.querySelector(".part-other").textContent}`);
const tShare = parseFloat(ivanSplit.querySelector(".part-target").style.flexBasis);
check("ширины частей пропорциональны оценке (12ч против 8ч → 60%)", tShare === 60, String(tShare));
check("в секции 1 у Ivan только жёлтая часть на всю ширину",
  ivanRow.querySelectorAll(".c-cell")[1].querySelectorAll(".part").length === 1 &&
  ivanRow.querySelectorAll(".c-cell")[1].querySelector(".part-target").style.flexBasis === "100%");
check("строка «Прочие» у Ivan и Petr", document.querySelectorAll("#g2 .g-row.others").length === 2);
check("«Прочие» у Ivan: 1 задача / 8ч, голубой отрезок Sprint 2",
  ivanRow.nextElementSibling && [...document.querySelectorAll("#g2 .g-row.others")][0].querySelector(".bar.nested .bar-sprint")?.textContent === "Sprint 2");
check("серый бейдж прочих у человека (8ч = 1д)", ivanRow.querySelector(".badge.b-other")?.textContent === "+1 · 1д", ivanRow.querySelector(".badge.b-other")?.textContent);
check("у эпиков серого бейджа нет", document.querySelectorAll("#g1 .badge.b-other").length === 0);
// профиль человека на вкладке по людям: цвет имени, лейбл роли, ширина колонки
const labelOf = (name) => [...document.querySelectorAll("#g2 .glabel")].find((b) => b.textContent === name);
check("уволенный — серое имя (класс p-fired)", labelOf("Ivan").classList.contains("p-fired") && getComputedStyle(labelOf("Ivan")).color === getComputedStyle(document.querySelector("#g2 .gantt-bar .legend-title")).color,
  `${labelOf("Ivan").className} / ${getComputedStyle(labelOf("Ivan")).color}`);
check("аутстаф — жёлтое имя (класс p-outstaff)", labelOf("Olga").classList.contains("p-outstaff") && getComputedStyle(labelOf("Olga")).color === "rgb(161, 98, 7)", getComputedStyle(labelOf("Olga")).color);
check("без профиля — обычное имя", !labelOf("Petr").className.includes("p-"));
const roleOf = (name) => labelOf(name).parentElement.querySelector(".lozenge.lz-role");
check("зелёный лейбл роли у Ivan и Olga", roleOf("Ivan")?.textContent === "Developer" && roleOf("Olga")?.textContent === "QA" && !roleOf("Petr"),
  `${roleOf("Ivan")?.textContent} / ${roleOf("Olga")?.textContent}`);
check("лейбл роли зелёный", getComputedStyle(roleOf("Ivan")).backgroundColor === "rgb(227, 252, 239)", getComputedStyle(roleOf("Ivan")).backgroundColor);
check("на вкладке по людям колонка имён на 20% шире (456px)",
  Math.round(document.querySelector("#g2 thead .c-name").getBoundingClientRect().width) === 456 && Math.round(document.querySelector("#g1 thead .c-name").getBoundingClientRect().width) === 380,
  `${document.querySelector("#g2 thead .c-name").getBoundingClientRect().width} / ${document.querySelector("#g1 thead .c-name").getBoundingClientRect().width}`);
check("на вкладке по эпикам лейблов роли нет", document.querySelectorAll("#g1 .lz-role").length === 0);

// бэклог: колонка справа, задачи без спринта и не готово
check("EP-1 бэклог: 1 задача / 5ч (A-6; готовая A-4 не считается)", ep1.backlog.count === 1 && ep1.backlog.sum === 5 * H && ep1.backlog.issues[0].key === "A-6",
  JSON.stringify([ep1.backlog.count, ep1.backlog.sum / H]));
const g1Heads = [...document.querySelectorAll("#g1 thead .c-sprint")];
check("колонка «Бэклог» — последняя на вкладке по эпикам", g1Heads.at(-1).classList.contains("backlog") && g1Heads.at(-1).textContent.includes(t("gantt.backlog")));
check("на вкладке по людям колонки «Бэклог» нет", document.querySelectorAll("#g2 thead .c-sprint.backlog").length === 0);
const ep1Row = [...document.querySelectorAll("#g1 .g-row.group")][0];
const backlogBar = ep1Row.querySelector("td.c-backlog .bar");
check("у EP-1 в бэклоге жёлтая полоса 1 · 5ч", backlogBar?.classList.contains("bar-group") && backlogBar.textContent === "15ч", backlogBar?.textContent);
const aaaRow = ep1Row.nextElementSibling;
check("у проекта AAA в бэклоге голубой отрезок", aaaRow.querySelector("td.c-backlog .bar.nested")?.textContent.includes("5ч"));
check("число ячеек в строке = секции + бэклог", ep1Row.querySelectorAll("td").length === 1 + m1.columns.length + 1);

// клик по жёлтой полосе — список задач со ссылками
ep1Row.querySelectorAll(".c-cell")[0].querySelector(".bar-group").click();
let issueRows = [...document.querySelectorAll(".tooltip.tip-issues .issues-table tr")];
check("по клику на полосу EP-1 в секции 0 — 3 задачи", issueRows.length === 3, String(issueRows.length));
check("задачи отсортированы по ключу", issueRows.map((r) => r.querySelector(".ti-key").textContent).join(",") === "A-1,A-2,A-7", issueRows.map((r) => r.querySelector(".ti-key").textContent).join(","));
check("ключ и название ведут в Jira в новой вкладке", issueRows.every((r) => r.querySelector(".ti-key a")?.target === "_blank" && r.querySelector(".ti-key a").href.endsWith("/browse/" + r.querySelector(".ti-key").textContent)));
check("готовая задача помечена", issueRows.find((r) => r.querySelector(".ti-key").textContent === "A-1")?.classList.contains("issue-done"));
check("заголовок окна — эпик и спринты секции", document.querySelector(".tooltip.tip-issues strong").textContent.includes("Sprint 2") && document.querySelector(".tooltip.tip-issues strong").textContent.includes("EP-1"));
check("окно не закрылось от собственного клика", !!document.querySelector(".tooltip.tip-issues"));
backlogBar.click();
issueRows = [...document.querySelectorAll(".tooltip.tip-issues .issues-table tr")];
check("клик по бэклогу — задача A-6", issueRows.length === 1 && issueRows[0].querySelector(".ti-key").textContent === "A-6");
document.querySelector(".tip-close").click();
check("окно закрывается крестиком", !document.querySelector(".tooltip"));
const teamRows = [...document.querySelectorAll("#g2 .g-row.team .tlabel")].map((n) => n.textContent);
check("строки команд на вкладке по людям", teamRows.join(",") === "Alpha,Beta,Без команды", teamRows.join(","));

document.querySelector("#g1 .glabel").click();
const tipRows = [...document.querySelectorAll(".tooltip .tip-row")].map((r) => r.textContent);
check("в подсказке 5 строк итогов", tipRows.length === 5, String(tipRows.length));
check("строка «Готово» в подсказке", tipRows.some((x) => x.includes(t("tip.done"))), tipRows.join(" | "));
check("строка «прочие статусы» в подсказке", tipRows.some((x) => x.includes(t("tip.other"))));

// 8. ссылки в подсказке
const links = [...document.querySelectorAll(".tooltip a")];
check("все ссылки открываются в новой вкладке", links.length > 0 && links.every((a) => a.target === "_blank" && a.rel.includes("noopener")), String(links.length));
const head = document.querySelector(".tooltip .tip-head a");
check("заголовок ведёт на эпик", head?.href === "https://jira.example.local/browse/EP-1", head?.href);
const hrefs = links.map((a) => decodeURIComponent(a.href));
check("ссылка «всего задач» — JQL по эпику", hrefs.some((h) => h.endsWith("/issues/?jql=cf[10100] = EP-1")), hrefs[1]);
check("ссылка «Готово» — по реальным статусам", hrefs.some((h) => h.includes('AND status in ("Готово", "On Prod")')), hrefs.join(" | "));
check("ссылка «прочие» — по открытым статусам", hrefs.some((h) => h.includes('AND status in ("В работе", "К выполнению")')), hrefs.join(" | "));
check("ссылка «без спринта» — пустой спринт и открытые статусы", hrefs.some((h) => h.includes("cf[10101] is EMPTY AND status in (")), hrefs.join(" | "));
check("строка проекта ведёт на JQL с проектом", hrefs.some((h) => h.includes('AND project = "AAA"')), hrefs.filter((h) => h.includes("project")).join(" | "));
check("суммарная оценка без ссылки", !document.querySelector(".tooltip .tip-row:nth-child(5) a"));

document.querySelector(".tip-close").click();
document.querySelector("#g2 .glabel").click();
const aHrefs = [...document.querySelectorAll(".tooltip a")].map((a) => decodeURIComponent(a.href));
check("подсказка по исполнителю ссылается на assignee", aHrefs.filter((h) => h.includes("/issues/")).every((h) => h.includes('assignee = "ivan"')), aHrefs[0]);
check("в подсказке исполнителя указана команда", document.querySelector(".tooltip .tip-team")?.textContent.includes("Alpha"));
check("в подсказке Ivan — информационные системы CRM и Billing",
  [...document.querySelectorAll(".tooltip .tip-systems .chip")].map((c) => c.textContent).join(",") === "CRM,Billing",
  [...document.querySelectorAll(".tooltip .tip-systems .chip")].map((c) => c.textContent).join(","));
check("в подсказке Ivan — роль и статус", document.querySelector(".tooltip .tip-profile .lz-role")?.textContent === "Developer" && document.querySelector(".tooltip .tip-pstatus")?.textContent === t("pstatus.fired"));
document.querySelector(".tip-close").click();
labelOf("Petr").click();
check("у человека без профиля — «не указаны»", document.querySelector(".tooltip .tip-systems")?.textContent.includes(t("tip.noSystems")) && !document.querySelector(".tooltip .lz-role"));
document.querySelector(".tip-close").click();
labelOf("Ivan").click();
check("в подсказке исполнителя — строка прочих эпиков", [...document.querySelectorAll(".tooltip .tip-row")].some((r) => r.textContent.includes(t("tip.others")) && r.textContent.includes("1 · 1д")));
check("ссылка прочих — открытые/будущие спринты без целевых эпиков",
  aHrefs.some((h) => h.includes("sprint in openSprints() OR sprint in futureSprints()") && h.includes("cf[10100] not in (EP-1,EP-2,EP-3,EP-4,EP-5)")),
  aHrefs.find((h) => h.includes("openSprints")) || "");
check("таблица прочих эпиков со ссылкой на эпик", document.querySelector('.tooltip a[href="https://jira.example.local/browse/EP-9"]')?.textContent === "EP-9 · Миграция");
document.querySelector(".tip-close").click();
document.querySelector("#g1 .glabel").click();

const total = document.createElement("div");
total.className = failures ? "t-fail" : "t-ok";
total.textContent = failures ? `${failures} FAILED` : "ALL PASSED";
log.prepend(total);
