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
import { parseSprint, datesFromName } from "../src/js/sync.js";
import { classify, isDoneStatus } from "../src/js/status.js";
import { collectPeople, mergeProfiles, parseSystems, systemsList, normName, roleSummary } from "../src/js/team.js";
import { parseConfig, exportConfig, applyConfig } from "../src/js/configio.js";
import * as dbm from "../src/js/db.js";

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
const ymd = (offsetDays) => { const x = new Date(Date.now() + offsetDays * day); const p = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
const epics = [
  { key: "EP-1", summary: "Личный кабинет", statusName: "В работе", statusCategory: "indeterminate", dueDate: ymd(5) },
  { key: "EP-2", summary: "Биллинг", statusName: "Готово", statusCategory: "done", dueDate: ymd(-10) },
  { key: "EP-3", summary: "Отчёты", statusName: "Бизнес тест", statusCategory: "indeterminate", dueDate: ymd(40) },
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

// 1b. даты из названия спринта (запасной вариант)
const dn = (name) => { const r = datesFromName(name, new Date(2026, 8, 4)); return r ? `${r.startDate.slice(0, 10)}..${r.endDate.slice(0, 10)}` : null; };
check("datesFromName: «20.2026 WEB[08.10 - 21.10]» → год из названия", dn("20.2026 WEB[08.10 - 21.10]") === "2026-10-08..2026-10-21", dn("20.2026 WEB[08.10 - 21.10]"));
check("datesFromName: переход через Новый год", dn("26.2026 WEB[31.12 - 13.01]") === "2026-12-31..2027-01-13", dn("26.2026 WEB[31.12 - 13.01]"));
check("datesFromName: без года — текущий", dn("Sprint1 Disc [14.06 - 28.06]") === "2026-06-14..2026-06-28", dn("Sprint1 Disc [14.06 - 28.06]"));
check("datesFromName: полные даты", dn("Релиз 05.11.2026 – 18.11.2026") === "2026-11-05..2026-11-18", dn("Релиз 05.11.2026 – 18.11.2026"));
check("datesFromName: обычное имя — null", dn("Sprint 3") === null && dn("Бэклог") === null);

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

// 2b. секции при сдвинутых спринтах команд (дефект: два спринта одной команды в «текущем»)
{
  const at = (offsetDays, h = 12) => { const x = new Date(); x.setHours(h, 0, 0, 0); x.setDate(x.getDate() + offsetDays); return x.toISOString(); };
  const teams = [
    { id: 17, name: "17.2026 WEB", state: "ACTIVE", startDate: at(-13, 10), endDate: at(0, 10), boardId: 1 },   // заканчивается сегодня утром
    { id: 18, name: "18.2026 WEB", state: "FUTURE", startDate: at(1, 10), endDate: at(14, 10), boardId: 1 },
    { id: 19, name: "19.2026 WEB", state: "FUTURE", startDate: at(15, 10), endDate: at(28, 10), boardId: 1 },
    { id: 27, name: "17 BI", state: "ACTIVE", startDate: at(-2), endDate: at(4), boardId: 2 },                 // недельный спринт другой команды
    { id: 16, name: "16.2026 WEB", state: "ACTIVE", startDate: at(-27), endDate: at(-14), boardId: 1 }         // не закрыт в Jira, но давно кончился
  ];
  const tIssues = [mk("W-1", "EP-1", "AAA", "Ivan", 17, 1), mk("W-2", "EP-1", "AAA", "Ivan", 18, 1), mk("W-3", "EP-1", "AAA", "Ivan", 19, 1), mk("W-4", "EP-1", "AAA", "Ivan", 27, 1), mk("W-5", "EP-1", "AAA", "Ivan", 16, 1)];
  const cols = agg.timeline(teams, tIssues);
  const secOf = (id) => cols.find((c) => c.sprints.some((s) => s.id === id))?.id || "—";
  check("сдвиг команд: спринт, идущий сегодня, и недельный чужой — в «текущем»", secOf(17) === "sec:0" && secOf(27) === "sec:0", `${secOf(17)} / ${secOf(27)}`);
  check("сдвиг команд: следующий спринт команды — в следующей секции, не в «текущем»", secOf(18) === "sec:1" && secOf(19) === "sec:2", `${secOf(18)} / ${secOf(19)}`);
  check("сдвиг команд: спринт, закончившийся до сегодня, на график не попадает", secOf(16) === "—", secOf(16));
}

// 2c. шкала одинакова на вкладках и не зависит от фильтров
{
  const all = [...issues, ...others];
  const cols1 = agg.buildModel({ issues, others, sprints, epics, boards, mode: "epicPeople", timelineIssues: all }).columns.map((c) => c.id);
  const cols2 = agg.buildModel({ issues, others, sprints, epics, boards, mode: "assignee", timelineIssues: all }).columns.map((c) => c.id);
  check("колонки одинаковы на «По эпикам» и «По людям»", cols1.join(",") === cols2.join(","), `${cols1.join(",")} / ${cols2.join(",")}`);
  const oneEpic = agg.buildModel({
    issues: issues.filter((i) => i.epicKey === "EP-3"),
    others, sprints, epics, boards, mode: "epicPeople", timelineIssues: all
  }).columns.map((c) => c.id);
  check("фильтр по одному эпику не укорачивает шкалу", oneEpic.join(",") === cols1.join(","), oneEpic.join(","));
}

// 3. модель по эпикам
const m1 = agg.buildModel({ issues, sprints, epics, boards, mode: "epicPeople" });
const ep1 = m1.groups.find((g) => g.key === "EP-1");
check("EP-1 всего задач", ep1.count === 7, String(ep1.count));
check("EP-1 без спринта — только невыполненные", ep1.noSprint === 1, String(ep1.noSprint));
check("EP-1 сумма оценок = 81ч", ep1.sum === 81 * H, String(ep1.sum / H));
check("EP-1 секция 0 = 3 задачи / 18ч (обе команды)", ep1.cells.get("sec:0")?.count === 3 && ep1.cells.get("sec:0")?.sum === 18 * H,
  JSON.stringify([ep1.cells.get("sec:0")?.count, ep1.cells.get("sec:0")?.sum / H]));
check("EP-1 в секции 0 разложен по спринтам 2 и 5 (две команды)", [...(ep1.cells.get("sec:0")?.bySprint.keys() || [])].join(",") === "2,5",
  [...(ep1.cells.get("sec:0")?.bySprint.keys() || [])].join(","));
check("EP-1 закрытый спринт не в ячейках", ![...ep1.cells.values()].some((c) => c.bySprint.has(1)));
check("EP-1 вложенные строки — исполнители (A-4 без спринта и готова → «Без исполнителя» скрыт)", ep1.projects.map((p) => p.label).sort().join(",") === "Ivan,Olga,Petr", ep1.projects.map((p) => p.label).join(","));
check("EP-1 подпись: ключ и название (Epic Name пуст)", ep1.label === "EP-1 · Личный кабинет", ep1.label);
const mlab = agg.buildModel({ issues: [mk("L-1", "EP-1", "AAA", "Ivan", 2, 1)], sprints, epics: [{ ...epics[0], epicName: "ЛК", labels: ["q4"] }], boards, mode: "epicPeople" });
check("подпись эпика — Epic Name, если поле заполнено", mlab.groups[0].label === "EP-1 · ЛК", mlab.groups[0].label);
check("EP-1 готовых задач (включая On Prod)", ep1.done === 3, String(ep1.done));
check("EP-1 задач в прочих статусах", ep1.other === 4, String(ep1.other));
check("EP-1 разбивка сходится с общим", ep1.done + ep1.other === ep1.count);
check("EP-1 статус эпика из Jira", ep1.status?.name === "В работе" && ep1.status?.category === "indeterminate", JSON.stringify(ep1.status));
const ep2 = m1.groups.find((g) => g.key === "EP-2");
check("EP-2 статус эпика", ep2.status?.category === "done", JSON.stringify(ep2.status));
check("isDone по имени статуса без категории", agg.isDone({ statusName: "Закрыт" }) && !agg.isDone({ statusName: "В работе" }));
check("легенда: две команды", m1.teams.map((x) => x.name).join(",") === "Alpha,Beta", m1.teams.map((x) => x.name).join(","));
check("команда спринта по доске", m1.teamOfSprint(5)?.name === "Beta" && m1.teamOfSprint(2)?.name === "Alpha");

// 3a. отменённые задачи: в количестве есть, в сумме дней нет
{
  const mc = agg.buildModel({
    issues: [mk("K-1", "EP-1", "AAA", "Ivan", 2, 8, "prog"), { ...mk("K-2", "EP-1", "AAA", "Ivan", 2, 4, "done"), statusName: "Cancelled", statusCategory: "indeterminate" }, { ...mk("K-3", "EP-1", "AAA", "Ivan", null, 6, "new"), statusName: "Отменена" }],
    sprints, epics, boards, mode: "epicPeople"
  });
  const kg = mc.groups[0];
  check("отмена: количество считает все задачи", kg.count === 3, String(kg.count));
  check("отмена: сумма дней без отменённых (8ч, а не 18ч)", kg.sum === 8 * H, String(kg.sum / H));
  check("отмена: в ячейке секции 2 задачи, но 8ч", kg.cells.get("sec:0")?.count === 2 && kg.cells.get("sec:0")?.sum === 8 * H);
  check("отмена: отменённая без спринта не в бэклоге (она готова)", kg.backlog.count === 0);
  check("отмена: считается готовой", kg.done === 2 && kg.other === 1, `${kg.done}/${kg.other}`);
}

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
// «По людям»: внутри человека — эпики (ключ + Epic Name), только с задачами в секциях таймлайна
check("внутри Ivan — эпики (целевые и прочие), а не проекты", ivan.projects.map((p) => p.key).sort().join(",") === "EP-1,EP-2,EP-9", ivan.projects.map((p) => p.label).join(" | "));
check("прочий эпик EP-9 подписан ключом и названием, не помечен целевым",
  ivan.projects.find((p) => p.key === "EP-9")?.label === "EP-9 · Миграция" && ivan.projects.find((p) => p.key === "EP-9")?.target === false,
  ivan.projects.find((p) => p.key === "EP-9")?.label);
check("целевые эпики помечены target", ivan.projects.filter((p) => p.target).map((p) => p.key).sort().join(",") === "EP-1,EP-2");
{
  const hid = agg.buildModel({ issues, others, sprints, epics: epics.map((e) => (e.key === "EP-1" ? { ...e, hidden: true } : e)), boards, mode: "assignee" });
  const iv = hid.groups.find((g) => g.key === "ivan");
  check("снятая галочка на «Поиске» → эпик без подсветки", iv.projects.find((p) => p.key === "EP-1")?.target === false);
}
check("подпись вложенного эпика — ключ и название", ivan.projects.find((p) => p.key === "EP-1")?.label === "EP-1 · Личный кабинет", ivan.projects.find((p) => p.key === "EP-1")?.label);
check("childKind по людям = epic", m2.childKind === "epic");
{
  const only = agg.buildModel({
    issues: [mk("Z-1", "EP-1", "AAA", "Ivan", 1, 8, "prog"), mk("Z-2", "EP-2", "BBB", "Ivan", 2, 4, "prog")],
    sprints, epics, boards, mode: "assignee"
  });
  check("эпик только с задачами в закрытом спринте внутрь человека не попадает",
    only.groups[0].projects.map((p) => p.key).join(",") === "EP-2", only.groups[0].projects.map((p) => p.key).join(","));
}
// перегрузка спринта: ёмкость = длительность спринта × часов в дне
await settings.save({ sprintDays: 1, hoursPerDay: 8 });
check("sprintCapacity = 1д × 8ч", agg.sprintCapacity() === 8 * H, String(agg.sprintCapacity() / H));
await settings.save({ estimateField: "points" });
check("для story points подсветка перегруза выключена", agg.sprintCapacity() === 0);
await settings.save({ estimateField: "original" });
check("Ivan: прочие эпики — 1 задача / 8ч", ivan.otherCount === 1 && ivan.otherSum === 8 * H, `${ivan.otherCount} / ${ivan.otherSum / H}`);
check("Ivan: целевые итоги не смешаны с прочими", ivan.count === 4 && ivan.sum === 58 * H, `${ivan.count} / ${ivan.sum / H}`);
check("Ivan: прочие в секции 0 по спринту 2", ivan.otherCells.get("sec:0")?.bySprint.get(2)?.count === 1);
check("Ivan: список прочих эпиков", ivan.otherEpics.map((e) => `${e.key}:${e.summary}`).join(",") === "EP-9:Миграция", JSON.stringify(ivan.otherEpics));
const petr = m2.groups.find((g) => g.key === "petr");
check("Petr в команде Beta", petr.team?.name === "Beta", petr.team?.name);
check("Petr: прочие — 2 задачи / 6ч, задача без эпика учтена", petr.otherCount === 2 && petr.otherSum === 6 * H, `${petr.otherCount} / ${petr.otherSum / H}`);
check("Petr: прочие эпики отсортированы по объёму, без эпика — прочерком", petr.otherEpics.map((e) => e.key || "—").join(",") === "EP-8,—", petr.otherEpics.map((e) => e.key).join(","));
// «Без исполнителя» в фикстуре — только задача без спринта и готовая, значит человека на вкладке нет.
check("человек без задач в текущих/будущих спринтах убран с вкладки", !m2.groups.some((g) => g.key === ""), m2.groups.map((g) => g.label).join(","));
{
  const withNobody = agg.buildModel({ issues: [...issues, { ...mk("N-1", "EP-1", "AAA", null, 2, 3, "new"), assigneeKey: "", assigneeName: "" }], others, sprints, epics, boards, mode: "assignee" });
  const nb = withNobody.groups.find((g) => g.key === "");
  check("человек с задачей в текущем спринте остаётся", nb && nb.label === t("gantt.noAssignee"), nb && nb.label);
}
{
  // Спринт без доски → человек без команды.
  const noBoard = agg.buildModel({
    issues: [mk("T-1", "EP-1", "AAA", "Ivan", 55, 3, "new")],
    sprints: [...sprints, { id: 55, name: "Free", state: "ACTIVE", startDate: iso(-1), endDate: iso(12), boardId: null }],
    epics, boards, mode: "assignee"
  });
  check("спринт без доски — человек без команды", noBoard.groups[0].team?.id === "" && noBoard.groups[0].team?.name === t("gantt.noTeam"), noBoard.groups[0].team?.name);
}
check("люди отсортированы по командам: Alpha, Beta, без команды",
  m2.groups.map((g) => `${g.team.name}/${g.label}`).join(","),
  m2.groups.map((g) => `${g.team.name}/${g.label}`).join(","));
check("порядок команд", m2.groups.map((g) => g.team.name).join(",") === "Alpha,Alpha,Beta", m2.groups.map((g) => g.team.name).join(","));

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
const rs = roleSummary([
  { name: "a", loaded: true, role: "developer", status: "staff" },
  { name: "b", loaded: true, role: "developer", status: "" },
  { name: "c", loaded: true, role: "qa", status: "outstaff" },      // аутстаф — не считаем
  { name: "d", loaded: true, role: "developer", status: "fired" },  // уволен — не считаем
  { name: "e", loaded: true, role: "", status: "staff" },           // без роли
  { name: "f", loaded: false, role: "devops", status: "staff" }     // не в выгрузке — не считаем
]);
check("сводка по ролям: без уволенных, аутстафа и ушедших из выгрузки", rs.total === 3 && rs.roles.map((x) => `${x.role}:${x.n}`).join(",") === "developer:2" && rs.noRole === 1, JSON.stringify(rs));
await settings.save({ infoSystems: ["Billing"] });
check("справочник систем дополняется выбранными у людей", systemsList(merged).join("|") === "Billing|CRM", systemsList(merged).join("|"));
await settings.save({ infoSystems: [] });

// Профили с вкладки «Команда»: Ivan уволен, Olga — аутстаф, у Petr профиля нет.
const peopleProfiles = [
  { name: "ivan", displayName: "Ivan", role: "developer", status: "fired", systems: ["CRM", "Billing"] },
  { name: "olga", displayName: "Olga", role: "qa", status: "outstaff", systems: [] }
];

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

// шапка секции: не больше 7 спринтов, остальные по клику
const manySprints = [sprints[1], ...Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `Someday ${i + 1}`, state: "FUTURE", startDate: null, endDate: null, boardId: 7 }))];
const manyIssues = Array.from({ length: 12 }, (_, i) => mk(`M-${i}`, "EP-1", "AAA", "Ivan", 100 + i, 1, "new"));
const mh = agg.buildModel({ issues: manyIssues, sprints: manySprints, epics, boards, mode: "epicPeople" });
const gh = document.createElement("div");
document.body.append(gh);
gantt.render(gh, mh, { mode: "epicPeople" });
const noDateTh = () => [...gh.querySelectorAll("thead .c-sprint:not(.backlog)")].at(-1);
check("в шапке секции «Без дат» показаны только 7 спринтов из 12", noDateTh().querySelectorAll(".sp-item").length === 7, String(noDateTh().querySelectorAll(".sp-item").length));
check("под списком — «ещё 5»", noDateTh().querySelector(".sp-more")?.textContent === t("gantt.headerMore", { n: 5 }), noDateTh().querySelector(".sp-more")?.textContent);
noDateTh().click();
check("клик по шапке раскрывает все 12", noDateTh().querySelectorAll(".sp-item").length === 12 && noDateTh().querySelector(".sp-more")?.textContent === t("gantt.headerLess"));
noDateTh().click();
check("повторный клик сворачивает обратно до 7", noDateTh().querySelectorAll(".sp-item").length === 7);
check("секция с ≤7 спринтами без переключателя", !gh.querySelector("thead .c-sprint.current .sp-more"));
gh.remove();

const g3 = document.createElement("div");
document.body.append(g3);
let clicked = null;
gantt.render(g3, m3, { mode: "epicPeople", highlightChild: "ivan", profiles: peopleProfiles, onChildClick: (k, n) => (clicked = `${k}:${n}`) });
const nameBtn = (n) => [...g3.querySelectorAll(".plabel-link")].find((b) => b.textContent === n);
check("epicPeople: уволенный Ivan — серым (p-fired)", nameBtn("Ivan")?.classList.contains("p-fired") && getComputedStyle(nameBtn("Ivan")).color !== getComputedStyle(nameBtn("Petr")).color,
  `${nameBtn("Ivan")?.className} / ${getComputedStyle(nameBtn("Ivan")).color} vs ${getComputedStyle(nameBtn("Petr")).color}`);
check("epicPeople: аутстаф Olga — жёлтым, Petr без профиля — обычный", nameBtn("Olga")?.classList.contains("p-outstaff") && !nameBtn("Petr")?.className.includes("p-"));
check("epicPeople: колонка «Бэклог» и нумерация как у эпиков", g3.querySelectorAll("thead .c-sprint.backlog").length === 1 && g3.querySelectorAll(".gnum").length === m3.groups.length);
check("epicPeople: имена людей — кнопки", g3.querySelectorAll(".g-row.proj .plabel-link").length > 0);
check("epicPeople: лейблов с цифрами нет ни у эпиков, ни у людей", g3.querySelectorAll(".badges").length === 0, String(g3.querySelectorAll(".badges").length));
check("epicPeople: имена людей кликабельны", g3.querySelectorAll(".g-row.proj .plabel-link").length > 0);
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

// 4d. загрузчик конфигурации — разбор и экспорт
const pc = parseConfig(JSON.stringify({ baseUrl: "https://jira.example.local/", fields: { plannedStart: "customfield_10407" }, infoSystems: "1С CRM\nСБИС", epics: [" prj-1 ", "PRJ-2"], people: [{ name: "Иван" }, { bad: 1 }] }));
check("parseConfig: поля, системы строкой, эпики с обрезкой, люди без имени отброшены",
  pc.baseUrl === "https://jira.example.local" && pc.fields.plannedStart === "customfield_10407" && pc.infoSystems.join("|") === "1С CRM|СБИС" && pc.epics.join(",") === "prj-1,PRJ-2" && pc.people.length === 1, JSON.stringify(pc));
let badJson = "";
try { parseConfig("{oops"); } catch (e) { badJson = e.message; }
check("parseConfig: битый JSON — понятная ошибка", badJson.startsWith(t("cfg.badJson", { msg: "" }).slice(0, 12)), badJson);
await settings.save({ infoSystems: ["1С CRM"], fields: { plannedStart: "customfield_10407", plannedEnd: "customfield_10408", epicAssignee: "assignee", epicReporter: "reporter" } });
const ec = await exportConfig();
check("exportConfig: версия, адрес Jira, поля, системы, эпики, люди", ec.version === 1 && ec.baseUrl === settings.get().baseUrl && ec.fields.plannedStart === "customfield_10407" && ec.infoSystems.join() === "1С CRM" && Array.isArray(ec.epics) && Array.isArray(ec.people), JSON.stringify(ec).slice(0, 200));
await settings.save({ infoSystems: [], fields: { plannedStart: "", plannedEnd: "", epicAssignee: "assignee", epicReporter: "reporter" } });

// применение без Jira (поля по id, эпиков нет): база очищается, справочник заменяется, профили создаются
await dbm.putAll(dbm.STORES.people, [{ name: "старый", displayName: "Старый", role: "qa", status: "staff", systems: ["Legacy"] }]);
await settings.save({ infoSystems: ["Legacy"] });
await dbm.clearEverything();
check("clearEverything очищает и профили", (await dbm.all(dbm.STORES.people)).length === 0);
const applyLog = [];
await applyConfig(parseConfig(JSON.stringify({ fields: { plannedStart: "customfield_1" }, infoSystems: ["A", "B"], people: [{ name: "Новый", role: "1C dev", status: "Аутстаф", systems: ["A", "C"] }] })), { onLog: (m) => applyLog.push(m) });
check("applyConfig: справочник систем заменён конфигом + системы людей", settings.get().infoSystems.join(",") === "A,B,C", settings.get().infoSystems.join(","));
const newProf = (await dbm.all(dbm.STORES.people)).find((p) => p.name === "новый");
check("applyConfig: профиль создан, роль и статус по подписям", newProf?.role === "onec" && newProf?.status === "outstaff" && newProf.systems.join() === "A,C", JSON.stringify(newProf));
check("applyConfig: поле по id записано", settings.get().fields.plannedStart === "customfield_1");
await dbm.clearEverything();
await settings.save({ infoSystems: [], fields: { plannedStart: "", plannedEnd: "", epicAssignee: "assignee", epicReporter: "reporter" } });

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

gantt.render(document.getElementById("g1"), m1, { mode: "epicPeople", onChildClick: () => {} });
const rowOf = (name) => [...document.querySelectorAll("#g1 .g-row.proj")].find((r) => r.querySelector(".plabel").textContent === name);
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
check("цифр нет у фамилий на обеих вкладках, у эпиков внутри людей — есть",
  document.querySelectorAll("#g1 .badges").length === 0 &&
    document.querySelectorAll("#g2 .g-row.group .badges").length === 0 &&
    document.querySelectorAll("#g2 .g-row.proj .badges").length > 0,
  `${document.querySelectorAll("#g1 .badges").length} / ${document.querySelectorAll("#g2 .g-row.group .badges").length} / ${document.querySelectorAll("#g2 .g-row.proj .badges").length}`);

// зелёная заливка — доля готовых задач по оценке
const ep1Sec0Bar = [...document.querySelectorAll("#g1 .g-row.group")][0].querySelectorAll(".c-cell")[0].querySelector(".bar-group");
check("заливка полосы EP-1 в секции 0 = доля готовых по оценке (8ч из 18ч → 44%)", ep1Sec0Bar.style.getPropertyValue("--fill") === "44%" && ep1Sec0Bar.dataset.done === "1/3",
  `${ep1Sec0Bar.style.getPropertyValue("--fill")} / ${ep1Sec0Bar.dataset.done}`);
check("заливка полосы бэклога — 0% (там нет готовых)", [...document.querySelectorAll("#g1 .g-row.group")][0].querySelector("td.c-backlog .bar").style.getPropertyValue("--fill") === "0%");
check("вложенный отрезок Sprint 2 у Ivan: 8ч из 12ч готово → 67%",
  rowOf("Ivan").querySelectorAll(".c-cell")[0].querySelector(".bar").style.getPropertyValue("--fill") === "67%",
  rowOf("Ivan").querySelectorAll(".c-cell")[0].querySelector(".bar").style.getPropertyValue("--fill"));
check("легенда про зелёную заливку", document.querySelector("#g1 .legend-done")?.textContent.includes(t("gantt.legendDone")));
// вехи срока исполнения
const flags = [...document.querySelectorAll("#g1 .due-flag")];
const flagOf = (key) => [...document.querySelectorAll("#g1 .g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith(key))?.querySelector(".due-flag");
check("вехи есть у трёх эпиков со сроком, у EP-4/EP-5 без срока — нет", flags.length === 3 && !flagOf("EP-4") && !flagOf("EP-5"), String(flags.length));
const df1 = flagOf("EP-1");
check("EP-1: срок через 5 дн. — в секции 0, доля (5+3)/14 = 57%", df1 && df1.parentElement === [...document.querySelectorAll("#g1 .g-row.group")][0].children[1] && df1.style.getPropertyValue("--x") === "57%",
  `${df1?.style.getPropertyValue("--x")}`);
check("EP-1: красная (≤14 дней), подпись с датой", df1?.classList.contains("due-red") && /◆ \d{2}\.\d{2}/.test(df1.textContent) && df1.title.includes("5"), `${df1?.className} / ${df1?.textContent} / ${df1?.title}`);
check("EP-1: линия проходит и через строки проектов", [...document.querySelectorAll("#g1 .g-row.group")][0].nextElementSibling.querySelector(".due-line.due-red") != null);
const df3 = flagOf("EP-3");
check("EP-3: срок за графиком — стрелка у правого края последней датированной секции", df3?.classList.contains("edge-right") && df3.parentElement === [...document.querySelectorAll("#g1 .g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith("EP-3")).children[2] && df3.textContent.endsWith("▶") && df3.title.includes(t("gantt.dueAfterChart")),
  `${df3?.className} / ${df3?.textContent}`);
check("EP-3: серая (далеко)", df3?.classList.contains("due-gray"));
const df2 = flagOf("EP-2");
check("EP-2: готов и просрочен — зелёная у левого края первой секции", df2?.classList.contains("due-green") && df2.classList.contains("edge-left") && df2.textContent.startsWith("◀") && df2.title.includes(t("gantt.dueDone", { date: "" }).split("·").pop().trim()),
  `${df2?.className} / ${df2?.title}`);
check("на «По людям» вех нет", document.querySelectorAll("#g2 .due-flag, #g2 .due-line").length === 0);
check("легенда вехи на вкладке по эпикам", document.querySelector("#g1 .swatch-due") != null);
check("веха срока лежит ниже липкой колонки имён (не наезжает при горизонтальной прокрутке)",
  Number(getComputedStyle(document.querySelector("#g1 tbody .c-name")).zIndex) > Number(getComputedStyle(document.querySelector("#g1 .due-flag")).zIndex) &&
    Number(getComputedStyle(document.querySelector("#g1 tbody .c-name")).zIndex) > Number(getComputedStyle(document.querySelector("#g1 .due-line")).zIndex),
  `${getComputedStyle(document.querySelector("#g1 tbody .c-name")).zIndex} / ${getComputedStyle(document.querySelector("#g1 .due-flag")).zIndex}`);
check("шапка таблицы выше строк тела", Number(getComputedStyle(document.querySelector("#g1 thead th.c-sprint")).zIndex) > Number(getComputedStyle(document.querySelector("#g1 tbody .c-name")).zIndex));
check("полосы групп — жёлтые (.bar-group), у проектов их нет",
  document.querySelectorAll("#g1 .g-row.group .bar").length > 0 &&
  [...document.querySelectorAll("#g1 .g-row.group .bar")].every((b) => b.classList.contains("bar-group")) &&
  document.querySelectorAll("#g1 .g-row.proj .bar-group").length === 0);
const firstProjBars = [...rowOf("Ivan").querySelectorAll(".c-cell")[0].querySelectorAll(".bar")];
check("у Ivan в секции 0 один вложенный голубой отрезок (Sprint 2), у Petr — B-Sprint 1",
  firstProjBars.length === 1 && firstProjBars[0].classList.contains("nested") && firstProjBars[0].querySelector(".bar-sprint").textContent === "Sprint 2" &&
    rowOf("Petr").querySelectorAll(".c-cell")[0].querySelector(".bar .bar-sprint")?.textContent === "B-Sprint 1",
  firstProjBars.map((b) => b.className).join("|"));
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
check("легенда команд отрисована — в горизонтальной прокрутке", document.querySelectorAll("#g1 .legend-scroll .legend-item").length === 2 && getComputedStyle(document.querySelector("#g1 .legend-scroll")).overflowX === "auto");
check("подписи легенды короткие", document.querySelector("#g1 .legend-done").textContent === t("gantt.legendDone") && t("gantt.legendDone") === "доля готовых задач" && t("gantt.legendDue") === "срок исполнения");
check("на «По эпикам» цифры скрыты — жёлтого баллона «осталось» нет", document.querySelectorAll("#g1 .badge.b-left").length === 0);
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
check("строки «Прочие» больше нет — прочие эпики отдельными строками", document.querySelectorAll("#g2 .g-row.others").length === 0);
const ivanChildren = [];
for (let r = ivanRow.nextElementSibling; r && r.classList.contains("proj"); r = r.nextElementSibling) ivanChildren.push(r);
check("у Ivan среди вложенных строк — прочий эпик EP-9", ivanChildren.some((r) => r.querySelector(".plabel").textContent.startsWith("EP-9")),
  ivanChildren.map((r) => r.querySelector(".plabel").textContent).join(" | "));
check("целевые эпики подсвечены жёлтым, прочий — нет",
  ivanChildren.filter((r) => r.classList.contains("epic-target")).every((r) => !r.querySelector(".plabel").textContent.startsWith("EP-9")) &&
    !ivanChildren.find((r) => r.querySelector(".plabel").textContent.startsWith("EP-9")).classList.contains("epic-target"),
  ivanChildren.map((r) => `${r.querySelector(".plabel").textContent}:${r.classList.contains("epic-target")}`).join(" | "));
check("целевые эпики идут выше прочих", ivanChildren.findIndex((r) => r.querySelector(".plabel").textContent.startsWith("EP-9")) === ivanChildren.length - 1,
  ivanChildren.map((r) => r.querySelector(".plabel").textContent).join(" | "));
check("серого бейджа прочих у фамилии больше нет — прочие эпики отдельными строками", !ivanRow.querySelector(".badge.b-other"));
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
check("без профилей лейблов роли нет", document.querySelectorAll("#g1 .lz-role").length === 0);

// бэклог: колонка справа, задачи без спринта и не готово
check("EP-1 бэклог: 1 задача / 5ч (A-6; готовая A-4 не считается)", ep1.backlog.count === 1 && ep1.backlog.sum === 5 * H && ep1.backlog.issues[0].key === "A-6",
  JSON.stringify([ep1.backlog.count, ep1.backlog.sum / H]));
const g1Heads = [...document.querySelectorAll("#g1 thead .c-sprint")];
check("колонка «Бэклог» — последняя на вкладке по эпикам", g1Heads.at(-1).classList.contains("backlog") && g1Heads.at(-1).textContent.includes(t("gantt.backlog")));
check("на вкладке по людям тоже есть колонка «Бэклог»", document.querySelectorAll("#g2 thead .c-sprint.backlog").length === 1);
const olgaRow2 = [...document.querySelectorAll("#g2 .g-row.group")].find((r) => r.querySelector(".glabel").textContent === "Olga");
check("у Olga в бэклоге A-6 (без спринта, не готово): жёлтая полоса 1 · 5ч", olgaRow2.querySelector("td.c-backlog .bar.bar-group")?.textContent === "15ч", olgaRow2.querySelector("td.c-backlog .bar")?.textContent);
check("у Ivan бэклог пуст (A-5 в закрытом спринте — не бэклог)", !ivanRow.querySelector("td.c-backlog .bar"));
check("строки проектов и «Прочие» тоже с ячейкой бэклога — число ячеек одинаково", [...document.querySelectorAll("#g2 .g-row")].every((r) => r.querySelectorAll("td").length === 1 + m2.columns.length + 1));
const ep1Row = [...document.querySelectorAll("#g1 .g-row.group")][0];
const backlogBar = ep1Row.querySelector("td.c-backlog .bar");
check("у EP-1 в бэклоге жёлтая полоса 1 · 5ч", backlogBar?.classList.contains("bar-group") && backlogBar.textContent === "15ч", backlogBar?.textContent);
check("у Olga в бэклоге голубой отрезок (A-6)", rowOf("Olga").querySelector("td.c-backlog .bar.nested")?.textContent.includes("5ч"));
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
check("строки команд на вкладке по людям", teamRows.join(",") === "Alpha,Beta", teamRows.join(","));
{
  // Ivan в секции 0: 12ч целевых + 4ч прочих = 16ч > ёмкости 8ч (1 день × 8ч) → красная обводка.
  await settings.save({ sprintDays: 1 });
  const gO = document.createElement("div");
  document.body.append(gO);
  gantt.render(gO, m2, { mode: "assignee" });
  const rowIvan = [...gO.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent === "Ivan");
  const cells = rowIvan.querySelectorAll(".c-cell");
  check("перегруженная секция обведена красным", cells[0].querySelector(".bar-split")?.classList.contains("overload"), cells[0].querySelector(".bar-split")?.className);
  check("в подсказке — нагрузка и ёмкость", (cells[0].querySelector(".bar-split")?.title || "").includes("2.5д") && cells[0].querySelector(".bar-split").title.includes("1д"), cells[0].querySelector(".bar-split")?.title);
  check("секция в пределах ёмкости не обведена", !cells[1].querySelector(".bar-split")?.classList.contains("overload"));
  await settings.save({ sprintDays: 10 });
  gantt.render(gO, m2, { mode: "assignee" });
  check("при ёмкости 10д перегрузки нет", gO.querySelectorAll(".bar.overload").length === 0);
  gO.remove();
}

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
check("строка исполнителя в подсказке эпика ведёт на JQL с assignee", hrefs.some((h) => h.includes('AND assignee = "ivan"')), hrefs.filter((h) => h.includes("assignee")).join(" | "));
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

// 9. «кто может подменить»
const cmpProfiles = [
  { name: "ivan", displayName: "Ivan", role: "developer", status: "staff", systems: ["CRM", "Billing", "Mobile"] },
  { name: "petr", displayName: "Petr", role: "developer", status: "staff", systems: ["CRM", "Web"] },
  { name: "olga", displayName: "Olga", role: "developer", status: "outstaff", systems: ["Billing", "CRM"] },
  { name: "kim", displayName: "Kim", role: "developer", status: "staff", systems: ["Web"] },        // нет общих систем
  { name: "zed", displayName: "Zed", role: "qa", status: "staff", systems: ["CRM"] },              // другая роль
  { name: "lee", displayName: "Lee", role: "developer", status: "fired", systems: ["CRM", "Mobile"] } // уволен
];
const si = gantt.standIns(cmpProfiles[0], cmpProfiles);
check("standIns: та же роль, общие системы, без уволенных; по числу общих", si.candidates.map((c) => `${c.profile.displayName}:${c.common.join("+")}`).join(",") === "Olga:Billing+CRM,Petr:CRM",
  si.candidates.map((c) => `${c.profile.displayName}:${c.common.join("+")}`).join(","));
check("standIns: системы без замены — Mobile", si.uncovered.join(",") === "Mobile", si.uncovered.join(","));
check("standIns: без роли/систем — пусто", gantt.standIns({ name: "x", role: "", systems: ["CRM"] }, cmpProfiles).candidates.length === 0);

const g4 = document.createElement("div");
document.body.append(g4);
gantt.render(g4, m2, { mode: "assignee", profiles: cmpProfiles });
const cmpBtnOf = (n) => [...g4.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent === n)?.querySelector(".cmp-btn");
check("пиктограмма ⇄ у каждого человека на «По людям»", g4.querySelectorAll(".g-row.group .cmp-btn").length === m2.groups.filter((g) => g.key).length && !cmpBtnOf("Без исполнителя"));
cmpBtnOf("Ivan").click();
const cmpTip = document.querySelector(".tooltip.tip-compare");
check("окно «Замена для Ivan» открылось и не закрылось от своего клика", !!cmpTip && cmpTip.textContent.includes(t("cmp.title", { name: "Ivan" })));
const rowsCmp = [...cmpTip.querySelectorAll(".cmp-table tr")];
check("кандидаты: Olga (2 общих), Petr (1); Kim, Zed, Lee отсутствуют", rowsCmp.map((r) => r.querySelector(".cmp-name").textContent).join(",") === "Olga,Petr", rowsCmp.map((r) => r.querySelector(".cmp-name").textContent).join(","));
check("общие системы подсвечены, остальные — нет", [...rowsCmp[1].querySelectorAll(".chip")].map((c) => `${c.textContent}${c.classList.contains("on") ? "*" : ""}`).join(",") === "CRM*,Web",
  [...rowsCmp[1].querySelectorAll(".chip")].map((c) => `${c.textContent}${c.classList.contains("on") ? "*" : ""}`).join(","));
check("аутстаф-кандидат помечен", rowsCmp[0].querySelector(".cmp-name").classList.contains("p-outstaff"));
check("системы без замены: Mobile", [...cmpTip.querySelectorAll(".cmp-uncovered .chip")].map((c) => c.textContent).join(",") === "Mobile");
cmpTip.querySelector(".tip-close").click();
cmpBtnOf("Petr").click();
check("у Petr без замены — Web (Kim той же роли, но Web общий) → все покрыты? нет: Kim имеет Web",
  [...document.querySelectorAll(".tooltip.tip-compare .cmp-table .cmp-name")].map((n) => n.textContent).join(",") === "Ivan,Kim,Olga" && document.querySelector(".tooltip.tip-compare .cmp-uncovered").textContent.includes(t("cmp.allCovered")),
  [...document.querySelectorAll(".tooltip.tip-compare .cmp-table .cmp-name")].map((n) => n.textContent).join(","));
document.querySelector(".tip-close").click();
// на «По эпикам и людям» — тоже
gantt.render(g3, m3, { mode: "epicPeople", profiles: cmpProfiles, onChildClick: () => {} });
check("пиктограмма ⇄ у людей внутри эпиков", g3.querySelectorAll(".g-row.proj .cmp-btn").length > 0);
g3.querySelector(".g-row.proj .cmp-btn").click();
check("окно сравнения открывается и на «По эпикам и людям»", !!document.querySelector(".tooltip.tip-compare"));
document.querySelector(".tip-close").click();
g4.remove();

// 9b. критический путь на «По эпикам и людям»
{
  gantt.render(g3, m3, { mode: "epicPeople", onChildClick: () => {} });
  const ep1g = m3.groups.find((g) => g.key === "EP-1");
  const crit = gantt.criticalPeople(ep1g, m3);
  check("критический путь: Petr определяет конец (последний спринт), Ivan не укладывается в срок (44ч > ёмкости)",
    crit.has("petr") && crit.get("petr")[0].includes("B-Sprint 1") && crit.has("ivan") && crit.get("ivan").some((r) => r.includes("5.5д")) && !crit.has("olga"),
    JSON.stringify([...crit]));
  const ep1Row3 = [...g3.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith("EP-1"));
  const critBtn = ep1Row3.querySelector(".crit-btn");
  check("пиктограмма ⚡ рядом с 💬 у эпика, по умолчанию выключена", !!critBtn && critBtn.previousElementSibling?.classList.contains("cmt-btn") && !critBtn.classList.contains("on"));
  check("на «По людям» пиктограммы ⚡ нет", document.querySelectorAll("#g2 .crit-btn").length === 0);
  check("без включения обводок нет", g3.querySelectorAll(".bar.crit").length === 0);
  critBtn.click();
  const rowsCrit = [...g3.querySelectorAll(".g-row.proj.crit-row")].map((r) => r.querySelector(".plabel").textContent);
  check("после клика подсвечены строки Petr и Ivan", rowsCrit.sort().join(",") === "Ivan,Petr", rowsCrit.join(","));
  check("полосы критичных — с классом crit, у Olga — нет",
    g3.querySelectorAll(".g-row.proj.crit-row .bar.crit").length > 0 && g3.querySelectorAll(".g-row.proj:not(.crit-row) .bar.crit").length === 0);
  check("у имени критичного — ⚡ с причиной", [...g3.querySelectorAll(".g-row.proj.crit-row .crit-mark")].every((m) => m.title.length > 10));
  const critBtn2 = [...g3.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith("EP-1")).querySelector(".crit-btn");
  check("пиктограмма включена, подсказка с причинами", critBtn2.classList.contains("on") && critBtn2.title.includes("B-Sprint 1"));
  critBtn2.click();
  check("повторный клик снимает подсветку", g3.querySelectorAll(".bar.crit, .crit-row").length === 0);
}

// 10. комментарии эпика (Jira подменена заглушкой)
const fakeComments = Array.from({ length: 7 }, (_, i) => ({ id: String(i), body: `Комментарий ${i + 1}`, author: { displayName: "Ivan" }, created: new Date(Date.now() - (7 - i) * day).toISOString() }));
const added = [];
gantt.commentsApi.list = async () => fakeComments;
gantt.commentsApi.add = async (key, text) => { added.push({ key, text }); fakeComments.push({ id: "n", body: text, author: { displayName: "Me" }, created: new Date().toISOString() }); };
const cmtBtn = [...document.querySelectorAll("#g1 .g-row.group")][0].querySelector(".cmt-btn");
check("пиктограмма 💬 у каждого эпика на «По эпикам», у людей на «По людям» нет",
  document.querySelectorAll("#g1 .g-row.group .cmt-btn").length === m1.groups.length && document.querySelectorAll("#g2 .cmt-btn").length === 0);
cmtBtn.click();
await new Promise((r) => setTimeout(r, 30));
const cmtTip = document.querySelector(".tooltip.tip-comments");
check("окно комментариев открылось с полем ввода и списком", !!cmtTip && !!cmtTip.querySelector(".cmt-input") && !!cmtTip.querySelector(".cmt-list"));
check("показаны последние 5 из 7, новейший первым", [...cmtTip.querySelectorAll(".cmt-item .cmt-body")].map((n) => n.textContent).join(",") === "Комментарий 7,Комментарий 6,Комментарий 5,Комментарий 4,Комментарий 3",
  [...cmtTip.querySelectorAll(".cmt-item .cmt-body")].map((n) => n.textContent).join(","));
check("список в прокручиваемой зоне", getComputedStyle(cmtTip.querySelector(".cmt-list")).overflowY === "auto" && getComputedStyle(cmtTip.querySelector(".cmt-list")).maxHeight === "220px");
const saveBtn = cmtTip.querySelector(".cmt-save");
check("кнопка сохранить неактивна при пустом поле", saveBtn.disabled);
const ta = cmtTip.querySelector(".cmt-input");
ta.value = "Новый комментарий из теста"; ta.dispatchEvent(new Event("input"));
check("кнопка активна после ввода", !saveBtn.disabled);
saveBtn.click();
await new Promise((r) => setTimeout(r, 50));
check("сохранение ушло в Jira с ключом эпика и текстом", added.length === 1 && added[0].key === "EP-1" && added[0].text === "Новый комментарий из теста", JSON.stringify(added));
check("после сохранения поле очищено, список обновлён, новый — первым", ta.value === "" && cmtTip.querySelector(".cmt-item .cmt-body").textContent === "Новый комментарий из теста" && cmtTip.querySelectorAll(".cmt-item").length === 5);
check("статус «Сохранено»", cmtTip.querySelector(".cmt-note").textContent === t("cmt.saved"));
// упоминания через @
const userQueries = [];
gantt.commentsApi.users = async (q) => { userQueries.push(q); return [{ name: "ielkin", displayName: "Иван Ёлкин" }, { name: "ivanov", displayName: "Иван Иванов" }].filter((u) => u.displayName.toLowerCase().includes(q.toLowerCase())); };
ta.value = "Посмотри, @Ив"; ta.setSelectionRange(ta.value.length, ta.value.length); ta.dispatchEvent(new Event("input"));
await new Promise((r) => setTimeout(r, 350));
const menu = cmtTip.querySelector(".mention-list");
check("по @ появился список пользователей из Jira", !menu.hidden && userQueries.at(-1) === "Ив" && menu.querySelectorAll(".mention-item").length === 2, `${menu.hidden} / ${userQueries.at(-1)} / ${menu.querySelectorAll(".mention-item").length}`);
ta.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
check("стрелка вниз переключает выбор", menu.querySelectorAll(".mention-item")[1].classList.contains("active"));
ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
check("Enter вставляет разметку упоминания [~логин]", ta.value === "Посмотри, [~ivanov] " && menu.hidden, JSON.stringify(ta.value));
ta.value = "письмо на mail@site.ru"; ta.setSelectionRange(ta.value.length, ta.value.length); ta.dispatchEvent(new Event("input"));
await new Promise((r) => setTimeout(r, 350));
check("@ внутри слова (e-mail) список не открывает", menu.hidden);
check("в списке комментариев [~логин] показывается как @логин", (() => { fakeComments.push({ id: "m", body: "Спасибо, [~ielkin]!", author: { displayName: "Me" }, created: new Date(Date.now() + 1000).toISOString() }); return true; })());
cmtTip.querySelector(".tip-close").click();
cmtBtn.click();
await new Promise((r) => setTimeout(r, 30));
check("…и он первый в списке", document.querySelector(".tooltip.tip-comments .cmt-item .cmt-body")?.textContent === "Спасибо, @ielkin!", document.querySelector(".tooltip.tip-comments .cmt-item .cmt-body")?.textContent);
document.querySelector(".tooltip.tip-comments .tip-close").click();
gantt.render(g3, m3, { mode: "epicPeople", onChildClick: () => {} });
check("пиктограмма 💬 есть и на «По эпикам и людям»", g3.querySelectorAll(".g-row.group .cmt-btn").length === m3.groups.length);

const total = document.createElement("div");
total.className = failures ? "t-fail" : "t-ok";
total.textContent = failures ? `${failures} FAILED` : "ALL PASSED";
log.prepend(total);
