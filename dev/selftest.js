// Дев-проверка чистой логики без Jira и без Chrome: подменяем chrome.storage и гоняем агрегацию.
globalThis.chrome = {
  storage: {
    local: { _d: {}, async get(k) { return { [k]: this._d[k] }; }, async set(o) { Object.assign(this._d, o); } },
    onChanged: { _l: [], addListener(f) { this._l.push(f); } }
  },
  permissions: { async contains() { return true; }, async request() { return true; } },
  runtime: { getURL: (p) => p }
};

import { setLang, applyI18n, t } from "../src/js/i18n.js";
import * as settings from "../src/js/settings.js";
import * as agg from "../src/js/agg.js";
import * as gantt from "../src/js/gantt.js";
import { parseSprint, datesFromName, checkApis, searchEpics, epicKeysFrom, sync as runSync, backfillHistory } from "../src/js/sync.js";
import * as jiraApi from "../src/js/jira.js";
import * as analytics from "../src/js/analytics.js";
import * as summary from "../src/js/summary.js";
import * as summaryView from "../src/js/summaryView.js";
import * as trendCharts from "../src/js/trendCharts.js";
import * as autoSync from "../src/js/autoSync.js";
import * as accuracy from "../src/js/accuracy.js";
import { runForecast, workerAvailable } from "../src/js/forecastClient.js";
import { classify, isDoneStatus } from "../src/js/status.js";
import { collectPeople, mergeProfiles, parseSystems, systemsList, teamsList, normName, roleSummary } from "../src/js/team.js";
import { parseConfig, exportConfig, applyConfig } from "../src/js/configio.js";
import * as flowlib from "../src/js/flow.js";
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
check("шаг секции = ритм спринтов", agg.sprintStepDays(sprints) === 14, String(agg.sprintStepDays(sprints)));
// Ритм 14 дней при длительности 13 (конец спринта — накануне следующего старта): шаг, взятый из
// длительности, копил сдвиг и вставлял пустую секцию примерно каждые 13 колонок.
{
  const chain = [];
  for (let i = 0; i < 10; i++) {
    chain.push({ id: 100 + i, name: `S-${i}`, state: i === 0 ? "ACTIVE" : "FUTURE", startDate: iso(-1 + i * 14), endDate: iso(12 + i * 14), boardId: 42 });
  }
  check("шаг = ритм (14), а не длительность (13)", agg.sprintStepDays(chain) === 14, String(agg.sprintStepDays(chain)));
  const chainIssues = chain.map((sp, i) => mk(`S-${i}`, "EP-1", "AAA", "Ivan", sp.id, 1));
  const chainCols = agg.timeline(chain, chainIssues);
  check("пустых секций между соседними спринтами не появляется",
    chainCols.length === chain.length && chainCols.every((c) => c.sprints.length === 1),
    chainCols.map((c) => c.sprints.length).join(","));
}
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

// 2d. имя доски из названий спринтов, когда доска недоступна
{
  check("имя доски выводится из общего слова в названиях спринтов",
    agg.nameFromSprints(["20.2026 WEB[08.10 - 21.10]", "21.2026 WEB[22.10 - 04.11]", "19.2026 WEB[24.09 - 07.10]"]) === "WEB",
    agg.nameFromSprints(["20.2026 WEB[08.10 - 21.10]", "21.2026 WEB[22.10 - 04.11]"]));
  check("числа, даты и слово «спринт» именем не становятся",
    agg.nameFromSprints(["17 BI [07.09.26 - 13.09.26]", "18 BI [14.09.26 - 27.09.26]"]) === "BI" &&
      agg.nameFromSprints(["Sprint1 Disc [14.06 - 28.06]", "Sprint2 Disc [29.06 - 12.07]"]) === "Disc",
    agg.nameFromSprints(["Sprint1 Disc [14.06 - 28.06]", "Sprint2 Disc [29.06 - 12.07]"]));
  check("имя из скобок, если больше ничего нет", agg.nameFromSprints(["Служебный спринт (МДЛП)"]) === "МДЛП", agg.nameFromSprints(["Служебный спринт (МДЛП)"]));
  check("без подходящих слов — пусто", agg.nameFromSprints(["12.2026 [01.01 - 14.01]", "13.2026"]) === "");

  const mixed = agg.buildModel({
    issues: [mk("Q-1", "EP-1", "AAA", "Ivan", 71, 2, "prog"), mk("Q-2", "EP-1", "AAA", "Olga", 72, 2, "prog")],
    sprints: [
      { id: 71, name: "20.2026 WEB[08.10 - 21.10]", state: "ACTIVE", startDate: iso(-1), endDate: iso(12), boardId: 36 },
      { id: 72, name: "21.2026 WEB[22.10 - 04.11]", state: "FUTURE", startDate: iso(13), endDate: iso(26), boardId: 36 },
      { id: 73, name: "Sprint X", state: "ACTIVE", startDate: iso(-1), endDate: iso(12), boardId: 3 }
    ],
    epics, boards: [{ id: 3, name: "Alpha" }], mode: "assignee"
  });
  const derived = mixed.teams.find((x) => x.id === "36");
  check("недоступная доска подписана именем из спринтов, а не «#36»", derived?.name === "WEB" && derived?.derived === true, JSON.stringify(derived));
  check("у выведенного имени есть пояснение с номером доски", (derived?.hint || "").includes("36"), derived?.hint);
  check("известная доска сохраняет своё имя", mixed.teams.every((x) => x.id !== "3" || (x.name === "Alpha" && !x.derived)));
}

// 2e. команды из Tempo
{
  const tempo = [
    { id: 1, name: "Команда Tempo по умолчанию", members: [{ key: "", login: "ivan", name: "Ivan" }, { key: "", login: "olga", name: "Olga" }, { key: "", login: "petr", name: "Petr" }] },
    { id: 2, name: "1C", members: [{ key: "JIRAUSER1", login: "ivan", name: "Ivan" }] },
    { id: 3, name: "AlphaOne", members: [{ key: "", login: "", name: "Olga" }] }
  ];
  const mt = agg.buildModel({ issues, others, sprints, epics, boards, tempo, mode: "assignee" });
  const teamOf = (key) => mt.groups.find((g) => g.key === key)?.team;
  check("команда человека берётся из Tempo, а не из доски", teamOf("ivan")?.name === "1C" && teamOf("ivan")?.tempo === true, JSON.stringify(teamOf("ivan")));
  check("при нескольких командах выбирается самая малочисленная (не «по умолчанию»)", teamOf("olga")?.name === "AlphaOne", teamOf("olga")?.name);
  check("сопоставление по отображаемому имени работает", teamOf("olga")?.tempo === true);
  check("кого нет в Tempo — команда по доске", teamOf("petr")?.name === "Команда Tempo по умолчанию" || teamOf("petr")?.tempo === true, teamOf("petr")?.name);
  const noTempo = agg.buildModel({ issues, others, sprints, epics, boards, tempo: [], mode: "assignee" });
  check("без Tempo команда по-прежнему по доске", noTempo.groups.find((g) => g.key === "ivan")?.team?.name === "Alpha",
    noTempo.groups.find((g) => g.key === "ivan")?.team?.name);
}

// 2f. недельный поток и доля эпика
{
  const now = new Date(2026, 8, 11, 12, 0, 0).getTime(); // пятница
  const win = flowlib.fullWeeks(4, now);
  // из 4 недель запроса остаётся 3 полных: текущая неполная и первая (запрос начался в середине) отброшены
  check("окно из полных недель: текущая и первая неполная отброшены", new Date(win.to).getDay() === 0 && win.starts.length === 3,
    `${new Date(win.from).toDateString()} .. ${new Date(win.to).toDateString()} = ${win.starts.length}`);
  check("границы недель — понедельники", win.starts.every((ms) => new Date(ms).getDay() === 1));
  check("median", flowlib.median([1, 5, 3]) === 3 && flowlib.median([2, 4]) === 3 && flowlib.median([]) === 0);

  const day = (ms, n) => new Date(ms - n * 86400000).toISOString();
  const rows = [
    // команда A: 3 задачи на прошлой неделе (2 из них — эпик), 1 двумя неделями раньше
    { key: "F-1", resolved: day(now, 5), assigneeLogin: "ivan", epicKey: "EP-1" },
    { key: "F-2", resolved: day(now, 6), assigneeLogin: "ivan", epicKey: "EP-1" },
    { key: "F-3", resolved: day(now, 7), assigneeLogin: "ivan", epicKey: "EP-9" },
    { key: "F-4", resolved: day(now, 14), assigneeLogin: "ivan", epicKey: "EP-9" },
    // команда B: одна задача эпика
    { key: "F-5", resolved: day(now, 8), assigneeLogin: "olga", epicKey: "EP-1" },
    // вне окна: текущая неделя и слишком старое
    { key: "F-6", resolved: day(now, 1), assigneeLogin: "ivan", epicKey: "EP-1" },
    { key: "F-7", resolved: day(now, 120), assigneeLogin: "ivan", epicKey: "EP-1" }
  ];
  const teamA = { id: "t:1", name: "A", color: 0 };
  const teamB = { id: "t:2", name: "B", color: 1 };
  const model = flowlib.buildFlow({ rows, weeks: 4, now, teamOf: (p) => (p.login === "ivan" ? teamA : p.login === "olga" ? teamB : null) });
  const a = model.teams.find((x) => x.team.id === "t:1");
  check("завершения текущей и слишком старой недели в поток не попали", a.total === 4, String(a.total));
  check("недели без завершений остаются нулями", a.perWeek.join(",") === "0,1,3", a.perWeek.join(","));
  const share = flowlib.epicShare(a, "EP-1");
  check("доля потока команды на эпик — в задачах", share.done === 2 && share.total === 4 && Math.round(share.share * 100) === 50,
    JSON.stringify(share));
  check("медиана и пик потока", a.median === 1 && a.max === 3, `${a.median} / ${a.max}`);
  check("вторая команда считается отдельно", flowlib.epicShare(model.teams.find((x) => x.team.id === "t:2"), "EP-1").done === 1);
  check("человек без команды — отдельная строка", flowlib.buildFlow({ rows, weeks: 4, now, teamOf: () => null }).teams.length === 1);
  // ряд задач эпика по неделям — для гистограммы
  const withEpic = flowlib.buildFlow({ rows, weeks: 4, now, epicKey: "EP-1", teamOf: (p) => (p.login === "ivan" ? teamA : teamB) });
  const ae = withEpic.teams.find((x) => x.team.id === "t:1");
  check("ряд эпика по неделям не больше общего потока", ae.epicPerWeek.join(",") === "0,0,2" && ae.perWeek.join(",") === "0,1,3",
    `${ae.epicPerWeek.join(",")} / ${ae.perWeek.join(",")}`);
  // User Story и другие исключённые типы в поток не попадают
  const withStory = [...rows, { key: "F-8", resolved: day(now, 6), assigneeLogin: "ivan", epicKey: "EP-1", typeName: "User Story" }];
  const exc = flowlib.parseTypeList(" User Story, Эпик ;");
  check("список исключаемых типов: регистр и разделители", exc.join("|") === "user story|эпик", exc.join("|"));
  const noStory = flowlib.buildFlow({ rows: withStory, weeks: 4, now, epicKey: "EP-1", excludeTypes: exc, teamOf: () => teamA });
  const withStoryFlow = flowlib.buildFlow({ rows: withStory, weeks: 4, now, epicKey: "EP-1", teamOf: () => teamA });
  check("User Story не входит в поток и в долю эпика",
    noStory.teams[0].total === withStoryFlow.teams[0].total - 1 && noStory.teams[0].byEpic.get("EP-1") === withStoryFlow.teams[0].byEpic.get("EP-1") - 1,
    `${noStory.teams[0].total} / ${withStoryFlow.teams[0].total}`);
  check("isExcludedType: пустой тип не исключается", !flowlib.isExcludedType("", exc) && flowlib.isExcludedType("user STORY", exc));
  check("без epicKey ряд эпика пустой", flowlib.buildFlow({ rows, weeks: 4, now, teamOf: () => teamA }).teams[0].epicPerWeek.every((n) => n === 0));
  // доля за период активности: эпик жил только последнюю неделю (2 из 3), а за всё окно — 2 из 4
  const se = flowlib.epicShare(ae, "EP-1");
  check("доля за период активности не размывается пустыми неделями",
    se.active.weeks === 1 && se.active.done === 2 && se.active.total === 3 && Math.round(se.active.share * 100) === 67,
    JSON.stringify(se.active));
  check("доля за всё окно осталась прежней", se.done === 2 && se.total === 4 && Math.round(se.share * 100) === 50);
  const seOpen = flowlib.epicShare(ae, "EP-1", { open: true });
  check("у незакрытого эпика период тянется до конца окна", seOpen.active.to === ae.perWeek.length - 1);
  check("для прогноза берётся свежая доля", Math.round(flowlib.forecastShare(se) * 100) === 67);
  const noEpic = flowlib.epicShare(ae, "EP-404");
  check("у чужого эпика периода активности нет", noEpic.active === null && noEpic.share === 0);
}

// 2g. прогноз срока по потоку (детерминированный генератор)
{
  const seq = (() => { let i = 0; const vals = [0.1, 0.5, 0.9, 0.3, 0.7]; return () => vals[i++ % vals.length]; })();
  const teamA = { id: "t:1", name: "A" };
  const teamB = { id: "t:2", name: "B" };
  // A: поток 10/нед, на эпик идёт половина → 5 задач/нед, осталось 20 → 4 недели
  // B: поток 2/нед, на эпик идёт половина → 1 задача/нед, осталось 10 → 10 недель (замыкающая)
  const fc = flowlib.forecastDelivery({
    teams: [
      { team: teamA, perWeek: [10, 10, 10, 10, 10], share: 0.5, remaining: 20 },
      { team: teamB, perWeek: [2, 2, 2, 2, 2], share: 0.5, remaining: 10 }
    ],
    runs: 500,
    rnd: seq
  });
  check("срок прогона — максимум по командам, а не сумма", fc.weeks.p50 === 10 && fc.weeks.p85 === 10, JSON.stringify(fc.weeks));
  check("замыкающей названа медленная команда", fc.last[0].team.id === "t:2" && fc.last[0].pct === 100, JSON.stringify(fc.last.map((x) => `${x.team.id}:${x.pct}`)));
  check("даты считаются от недель", Math.round((fc.dates.p50 - Date.now()) / (7 * 86400000)) === 10);

  // доля потока решает: при доле 20% тот же объём занимает вдвое больше недель
  const slow = flowlib.forecastDelivery({ teams: [{ team: teamA, perWeek: [10, 10], share: 0.2, remaining: 20 }], runs: 200, rnd: seq });
  const fast = flowlib.forecastDelivery({ teams: [{ team: teamA, perWeek: [10, 10], share: 0.4, remaining: 20 }], runs: 200, rnd: seq });
  check("доля потока прямо влияет на срок", slow.weeks.p50 === 10 && fast.weeks.p50 === 5, `${slow.weeks.p50} / ${fast.weeks.p50}`);

  check("разброс истории даёт разброс сроков", (() => {
    const varied = flowlib.forecastDelivery({ teams: [{ team: teamA, perWeek: [0, 2, 10], share: 1, remaining: 10 }], runs: 2000 });
    return varied.weeks.p95 > varied.weeks.p50;
  })());
  check("без остатка задач прогноза нет", flowlib.forecastDelivery({ teams: [{ team: teamA, perWeek: [5], share: 1, remaining: 0 }] }) === null);
  check("при нулевом потоке прогноза нет", flowlib.forecastDelivery({ teams: [{ team: teamA, perWeek: [0, 0], share: 1, remaining: 5 }] }) === null);
  check("порог истории: 5 недель минимум, 12 надёжно", flowlib.FORECAST_MIN_WEEKS === 5 && flowlib.FORECAST_OK_WEEKS === 12);
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
// «По людям» — про загрузку: считаем остаток, если поле заполнено, иначе исходную оценку
{
  const half = { ...mk("R-1", "EP-1", "AAA", "Zoe", 2, 8, "prog"), remainingEstimate: 2 * H };
  const empty = { ...mk("R-2", "EP-1", "AAA", "Zoe", 2, 8, "prog"), remainingEstimate: null };
  const finished = { ...mk("R-3", "EP-1", "AAA", "Zoe", 2, 8, "done"), remainingEstimate: 0 };
  check("оценка остатка: заполненный remaining побеждает original", agg.workEstimateOf(half) === 2 * H, String(agg.workEstimateOf(half) / H));
  check("оценка остатка: пустой remaining откатывается на original", agg.workEstimateOf(empty) === 8 * H, String(agg.workEstimateOf(empty) / H));
  check("оценка остатка: нулевой remaining — это ноль, а не откат", agg.workEstimateOf(finished) === 0, String(agg.workEstimateOf(finished)));
  const set = [half, empty, finished];
  const load = agg.buildModel({ issues: set, others: [], sprints, epics, boards, mode: "assignee" });
  const zoe = load.groups.find((g) => g.key === "zoe");
  check("«По людям»: секция считается по остатку", zoe.cells.get("sec:0").sum === 10 * H, String(zoe.cells.get("sec:0").sum / H));
  check("«По людям»: итог человека тоже по остатку", zoe.sum === 10 * H, String(zoe.sum / H));
  const plan = agg.buildModel({ issues: set, others: [], sprints, epics, boards, mode: "epicPeople" });
  check("«По эпикам»: оценка осталась прежней", plan.groups[0].cells.get("sec:0").sum === 24 * H, String(plan.groups[0].cells.get("sec:0").sum / H));
}
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

// Диаграмма по умолчанию открывается свёрнутой, поэтому проверки по вложенным строкам рисуют
// её через явное «развернуть всё».
const renderOpen = (box, model, opts) => {
  gantt.setCollapsed(opts.mode, []);
  gantt.render(box, model, opts);
};

// шапка секции: не больше 7 спринтов, остальные по клику
const manySprints = [sprints[1], ...Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, name: `Someday ${i + 1}`, state: "FUTURE", startDate: null, endDate: null, boardId: 7 }))];
const manyIssues = Array.from({ length: 12 }, (_, i) => mk(`M-${i}`, "EP-1", "AAA", "Ivan", 100 + i, 1, "new"));
const mh = agg.buildModel({ issues: manyIssues, sprints: manySprints, epics, boards, mode: "epicPeople" });
const gh = document.createElement("div");
document.body.append(gh);
renderOpen(gh, mh, { mode: "epicPeople" });
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
renderOpen(g3, m3, { mode: "epicPeople", highlightChild: "ivan", profiles: peopleProfiles, onChildClick: (k, n) => (clicked = `${k}:${n}`) });
const nameBtn = (n) => [...g3.querySelectorAll(".plabel-link")].find((b) => b.textContent === n);
check("epicPeople: уволенный Ivan — серым (p-fired)", nameBtn("Ivan")?.classList.contains("p-fired") && getComputedStyle(nameBtn("Ivan")).color !== getComputedStyle(nameBtn("Petr")).color,
  `${nameBtn("Ivan")?.className} / ${getComputedStyle(nameBtn("Ivan")).color} vs ${getComputedStyle(nameBtn("Petr")).color}`);
check("epicPeople: аутстаф Olga — жёлтым, Petr без профиля — обычный", nameBtn("Olga")?.classList.contains("p-outstaff") && !nameBtn("Petr")?.className.includes("p-"));
check("epicPeople: колонка «Бэклог» и нумерация как у эпиков", g3.querySelectorAll("thead .c-sprint.backlog").length === 1 && g3.querySelectorAll(".gnum").length === m3.groups.length);
check("epicPeople: имена людей — кнопки", g3.querySelectorAll(".g-row.proj .plabel-link").length > 0);
check("epicPeople: лейблов с цифрами нет ни у эпиков, ни у людей", g3.querySelectorAll(".badges").length === 0, String(g3.querySelectorAll(".badges").length));
check("epicPeople: имена людей кликабельны", g3.querySelectorAll(".g-row.proj .plabel-link").length > 0);
// прокрутка не сбрасывается при сворачивании/разворачивании узла
{
  const wrap = g3.querySelector(".gantt-wrap");
  wrap.scrollLeft = 40;
  const row = g3.querySelector(".g-row.group");
  row.querySelector(".twisty").click();
  check("горизонтальная прокрутка таблицы сохраняется при сворачивании", g3.querySelector(".gantt-wrap").scrollLeft === 40,
    String(g3.querySelector(".gantt-wrap").scrollLeft));
  g3.querySelector(".g-row.group .twisty").click();
  check("и при разворачивании обратно", g3.querySelector(".gantt-wrap").scrollLeft === 40, String(g3.querySelector(".gantt-wrap").scrollLeft));
}
check("epicPeople: строка выбранного человека подсвечена", [...g3.querySelectorAll(".g-row.proj.hl")].every((r) => r.querySelector(".plabel").textContent === "Ivan") && g3.querySelectorAll(".g-row.proj.hl").length === 2, String(g3.querySelectorAll(".g-row.proj.hl").length));
g3.querySelector(".g-row.proj .plabel-link").click();
check("epicPeople: клик по имени отдаёт ключ и имя", /^[a-z]+:.+$/.test(clicked || ""), clicked);
gantt.setCollapsed("epicPeople", ["EP-1"]);
gantt.render(g3, m3, { mode: "epicPeople" });
const ep1Row3 = [...g3.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith("EP-1"));
check("epicPeople: setCollapsed сворачивает указанные эпики", ep1Row3.nextElementSibling?.classList.contains("group") && ep1Row3.querySelector(".twisty").textContent === "▸",
  `${ep1Row3.nextElementSibling?.className} / ${ep1Row3.querySelector(".twisty").textContent}`);
gantt.resetCollapse();
// по умолчанию (первая отрисовка режима и после «Обновить») все группы свёрнуты
{
  const gc = document.createElement("div");
  document.body.append(gc);
  gantt.render(gc, m3, { mode: "epicPeople" });
  const groups = [...gc.querySelectorAll(".g-row.group")];
  check("по умолчанию все группы свёрнуты", groups.length === m3.groups.length && groups.every((r) => r.querySelector(".twisty").textContent === "▸"),
    `${groups.length} / ${m3.groups.length}`);
  check("вложенных строк при этом нет", gc.querySelectorAll(".g-row.proj").length === 0, String(gc.querySelectorAll(".g-row.proj").length));
  gc.querySelector(".g-row.group .twisty").click();
  check("клик по стрелке раскрывает группу", gc.querySelectorAll(".g-row.proj").length > 0);
  gantt.render(gc, m3, { mode: "epicPeople" });
  check("после ручного раскрытия повторная отрисовка не сворачивает обратно", gc.querySelectorAll(".g-row.proj").length > 0);
  gantt.resetCollapse();
  gantt.render(gc, m3, { mode: "epicPeople" });
  check("resetCollapse (после «Обновить») снова сворачивает всё", gc.querySelectorAll(".g-row.proj").length === 0);
  gc.remove();
  gantt.resetCollapse();
}
g3.remove();

// Д1. задачи вне спринта, которые в работе (канбан), — в текущей секции
{
  const kb = [
    mk("K-1", "EP-1", "AAA", "Anna", null, 4, "prog"), // в работе без спринта → текущая секция
    mk("K-2", "EP-1", "AAA", "Anna", null, 2, "new"), // к выполнению → бэклог, как раньше
    mk("K-3", "EP-1", "AAA", "Anna", null, 3, "prod"), // On Prod: категория «В работе», но готова
    { ...mk("K-4", "EP-1", "AAA", "Anna", null, 5, "prog"), statusName: "Анализ" } // нестандартный статус категории «В работе»
  ];
  check("isOffSprintWork: в работе без спринта — да, On Prod и к выполнению — нет",
    agg.isOffSprintWork(kb[0]) && agg.isOffSprintWork(kb[3]) && !agg.isOffSprintWork(kb[1]) && !agg.isOffSprintWork(kb[2]) &&
    !agg.isOffSprintWork(mk("K-5", "EP-1", "AAA", "Anna", 2, 1, "prog")));
  const km = agg.buildModel({ issues: kb, sprints, epics, boards, mode: "epicPeople" });
  const kep = km.groups.find((g) => g.key === "EP-1");
  const kcur = kep.cells.get(km.currentId);
  check("в работе без спринта — в текущей секции, отрезком «Вне спринта» (и нестандартный статус тоже)",
    km.currentId === "sec:0" && kcur?.count === 2 && kcur.bySprint.get(agg.OFF_SPRINT_ID)?.count === 2,
    JSON.stringify({ cur: km.currentId, n: kcur?.count }));
  check("к выполнению без спринта — в бэклоге; счётчик «без спринта» без задач в работе",
    kep.backlog.count === 1 && kep.backlog.issues[0].key === "K-2" && kep.noSprint === 1, `${kep.backlog.count} / ${kep.noSprint}`);
  check("On Prod без спринта не попадает ни в секцию, ни в бэклог",
    ![...kcur.issues, ...kep.backlog.issues].some((i) => i.key === "K-3"));
  check("задачи вне спринта помечены для списка, задачи бэклога — нет",
    kcur.issues.every((i) => i.offSprint) && !kep.backlog.issues[0].offSprint);

  const kOther = [{ ...mk("K-9", "EP-9", "XXX", "Anna", null, 6, "prog"), epicSummary: "Чужой" }];
  const kp = agg.buildModel({ issues: kb, others: kOther, sprints, epics, boards, mode: "assignee" });
  const anna = kp.groups.find((g) => g.key === "anna");
  check("канбан-задача в чужом эпике — в «Прочих» текущей секции",
    anna?.otherCells.get(kp.currentId)?.count === 1 && anna.projects.some((pr) => pr.key === "EP-9"), JSON.stringify(anna?.projects.map((pr) => pr.key)));
  const kload = agg.personLoad(kp, kb, kOther);
  check("загрузка текущей секции включает задачи вне спринта, по остатку",
    kload.byName.get("anna")?.get(kp.currentId) === 15 * H, String((kload.byName.get("anna")?.get(kp.currentId) || 0) / H));
  check("загрузка по остатку: доделанная задача с нулевым остатком не грузит",
    agg.personLoad(kp, [{ ...mk("K-6", "EP-1", "AAA", "Boris", 2, 8, "prog"), remainingEstimate: 0 }], []).byName.get("boris")?.get(kp.currentId) === 0);

  const gk = document.createElement("div");
  document.body.append(gk);
  renderOpen(gk, km, { mode: "epicPeople" });
  const offBars = [...gk.querySelectorAll(".bar.nested.off-sprint")];
  check("в ячейке текущей секции — отрезок «Вне спринта»", offBars.length === 1 && offBars[0].textContent.includes(t("gantt.offSprint")),
    String(offBars.length));
  offBars[0].click();
  check("во всплывающем списке у таких задач — пиктограмма «вне спринта» с подсказкой",
    document.querySelectorAll(".tip-issues .ti-offsprint").length === 2 &&
      document.querySelector(".tip-issues .ti-offsprint").title === t("gantt.offSprintHint"));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  gk.remove();
  gantt.resetCollapse();
}

// 4d. загрузчик конфигурации — разбор и экспорт
const pc = parseConfig(JSON.stringify({ baseUrl: "https://jira.example.local/", fields: { plannedStart: "customfield_10407" }, infoSystems: "1С CRM\nСБИС", epics: [" prj-1 ", "PRJ-2"], people: [{ name: "Иван" }, { bad: 1 }] }));
check("parseConfig: поля, системы строкой, эпики с обрезкой, люди без имени отброшены",
  pc.baseUrl === "https://jira.example.local" && pc.fields.plannedStart === "customfield_10407" && pc.infoSystems.join("|") === "1С CRM|СБИС" && pc.epics.join(",") === "prj-1,PRJ-2" && pc.people.length === 1, JSON.stringify(pc));
let badJson = "";
try { parseConfig("{oops"); } catch (e) { badJson = e.message; }
check("parseConfig: битый JSON — понятная ошибка", badJson.startsWith(t("cfg.badJson", { msg: "" }).slice(0, 12)), badJson);
await settings.save({ infoSystems: ["1С CRM"], fields: { plannedStart: "customfield_10407", plannedEnd: "customfield_10408", epicAssignee: "assignee", epicReporter: "reporter" } });
const ec = await exportConfig();
check("exportConfig: версия, адрес Jira, поля, системы, эпики, люди", ec.version === 2 && ec.baseUrl === settings.get().baseUrl && ec.fields.plannedStart === "customfield_10407" && ec.infoSystems.join() === "1С CRM" && Array.isArray(ec.epics) && Array.isArray(ec.people), JSON.stringify(ec).slice(0, 200));
check("exportConfig: справочник команд и команда человека попадают в файл", Array.isArray(ec.teams) && ec.people.every((x) => "team" in x), JSON.stringify(ec.teams));
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
// команды: справочник из конфига + команда, названная только у человека
await applyConfig(parseConfig(JSON.stringify({ teams: "1C, Платформы данных", people: [{ name: "Зоя", team: "QA" }] })), { onLog: () => {} });
check("applyConfig: справочник команд заменён конфигом + команда человека", settings.get().teams.join(",") === "1C,Платформы данных,QA", settings.get().teams.join(","));
const zoeProf = (await dbm.all(dbm.STORES.people)).find((p) => p.name === "зоя");
check("applyConfig: команда записана в профиль", zoeProf?.team === "QA", JSON.stringify(zoeProf));
await dbm.clearEverything();
await settings.save({ infoSystems: [], fields: { plannedStart: "", plannedEnd: "", epicAssignee: "assignee", epicReporter: "reporter" } });

// 4e. ручное распределение по командам (вкладка «Команда») — когда Tempo API закрыт
{
  const profiles = [
    { name: "ivan", displayName: "Ivan", login: "ivan", key: "ivan", team: "Платформа" },
    { name: "olga", displayName: "Olga", login: "olga", key: "olga", team: "Биллинг" },
    { name: "petr", displayName: "Petr", login: "petr", key: "petr", team: "" }
  ];
  const manual = agg.buildManualTeams(profiles);
  check("ручные команды: только непустые, по алфавиту", [...manual.teams.values()].map((x) => x.name).join(",") === "Биллинг,Платформа",
    [...manual.teams.values()].map((x) => x.name).join(","));
  check("человек без команды остаётся без неё", manual.of({ login: "petr", name: "Petr" }) === null);
  check("сопоставление по логину и по имени", manual.of({ login: "ivan" }).name === "Платформа" && manual.of({ name: "Olga" }).name === "Биллинг");

  const byManual = agg.buildModel({ issues, others, sprints, epics, boards, tempo: [], profiles, mode: "assignee" });
  const ivanM = byManual.groups.find((g) => g.key === "ivan");
  check("«По людям»: без Tempo команда берётся из вкладки «Команда»", ivanM.team?.name === "Платформа", ivanM.team?.name);
  const tempoTeams = [{ id: 2, name: "1C", members: [{ key: "", login: "ivan", name: "Ivan" }] }];
  const withTempo = agg.buildModel({ issues, others, sprints, epics, boards, tempo: tempoTeams, profiles, mode: "assignee" });
  check("ручная команда важнее Tempo", withTempo.groups.find((g) => g.key === "ivan").team?.name === "Платформа",
    withTempo.groups.find((g) => g.key === "ivan").team?.name);
  const noProfiles = agg.buildModel({ issues, others, sprints, epics, boards, tempo: [], mode: "assignee" });
  check("без профилей команда по-прежнему по доске", noProfiles.groups.find((g) => g.key === "ivan").team?.name === "Alpha",
    noProfiles.groups.find((g) => g.key === "ivan").team?.name);
  await settings.save({ teams: ["QA"] });
  check("список команд = справочник + проставленные людям", teamsList(profiles).join(",") === "QA,Платформа,Биллинг", teamsList(profiles).join(","));
  await settings.save({ teams: [] });
}

// 4f. проверка доступности API перед выгрузкой
{
  const orig = window.fetch;
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/api/2/myself")) return json({ name: "ivan" });
    if (u.includes("/rest/api/2/search")) return json({ issues: [], total: 0 });
    if (u.includes("/rest/agile/1.0/board")) return json({ errorMessages: ["no permission"] }, 403);
    if (u.includes("/rest/tempo-teams")) return json({ errorMessages: ["not installed"] }, 404);
    return json({}, 404);
  };
  await settings.save({ useTempoTeams: true });
  const st = await checkApis();
  check("проверка API: ядро и поиск доступны", st.core.ok && st.search.ok && st.ok, JSON.stringify({ core: st.core.ok, search: st.search.ok }));
  check("проверка API: закрытые Agile и Tempo помечены", !st.agile.ok && !st.tempo.ok && st.limited === true, JSON.stringify({ agile: st.agile.code, tempo: st.tempo.code }));
  await settings.save({ useTempoTeams: false });
  check("выключённый Tempo проверкой не считается ошибкой", (await checkApis()).tempo.skipped === true);
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/rest/tempo-teams")) return json({ errorMessages: ["not installed"] }, 404);
    return json(u.includes("/rest/agile/") ? { values: [] } : { name: "ivan", issues: [], total: 0 });
  };
  check("выключенный Tempo при открытом Agile — не «ограничения API»", (await checkApis()).limited === false);
  await settings.save({ useTempoTeams: true });
  window.fetch = async () => json({ errorMessages: ["denied"] }, 403);
  const denied = await checkApis();
  check("недоступное ядро валит проверку целиком", !denied.core.ok && !denied.ok && !denied.search.ok, JSON.stringify(denied.core));
  window.fetch = orig;
}

// 4h. поиск эпиков: в поле ввода можно вставить список ключей
{
  check("ключи из строки: регистр, запятые, переводы строк, дубли",
    epicKeysFrom(" dbd-867, DBD-868\nDBD-868 текст PRJ_X-12 ").join(",") === "DBD-867,DBD-868,PRJ_X-12",
    epicKeysFrom(" dbd-867, DBD-868\nDBD-868 текст PRJ_X-12 ").join(","));
  check("текст без ключей ключей не даёт", epicKeysFrom("личный кабинет 2026").length === 0);

  const orig = window.fetch;
  const sent = [];
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
  window.fetch = async (url, opt) => {
    const b = opt && opt.body ? JSON.parse(opt.body) : {};
    if (b.jql) sent.push(b.jql);
    return json({ issues: [], total: 0, startAt: 0, maxResults: 50 });
  };
  const savedFields = { ...settings.get().fields };
  await settings.save({ fields: { ...savedFields, epicLink: "customfield_10100", sprint: "customfield_10101", version: 5 } });
  await searchEpics("dbd-867, DBD-868\nDBD-869");
  check("список ключей уходит одним key in (…), без поиска по названию", sent[0] === "key in (DBD-867,DBD-868,DBD-869) AND issuetype = Epic", sent[0]);
  sent.length = 0;
  await searchEpics("личный кабинет");
  check("текст ищется по названию", sent[0] === 'issuetype = Epic AND summary ~ "личный кабинет" ORDER BY updated DESC', sent[0]);
  sent.length = 0;
  await searchEpics("DBD-867 кабинет");
  check("ключ и текст вместе — два запроса, ключ не попадает в поиск по названию",
    sent.length === 2 && sent[0].startsWith("key in (DBD-867)") && sent[1].includes('summary ~ "кабинет"'), JSON.stringify(sent));
  sent.length = 0;
  await searchEpics("   ");
  check("пустая строка — все эпики", sent[0] === "issuetype = Epic ORDER BY updated DESC", sent[0]);
  await settings.save({ fields: savedFields });
  window.fetch = orig;
}

// 4i. обработчики-свойства не должны возвращать false: это отменяет действие по умолчанию
// (из-за такого `onkeydown` в поле поиска не набирался ни один символ).
{
  const sources = await Promise.all(
    ["app", "gantt", "team", "sync", "agg", "flow", "configio", "analytics", "forecastClient", "jira", "db", "settings"].map(async (n) => [
      n,
      await (await fetch(`../src/js/${n}.js`, { cache: "no-store" })).text()
    ])
  );
  const bad = [];
  for (const [name, code] of sources) {
    for (const m of code.matchAll(/\bon[a-z]+\s*=\s*\([^)]*\)\s*=>\s*(?!\{)([^;\n]+)/g)) {
      if (/&&|\|\|/.test(m[1])) bad.push(`${name}.js: ${m[0].slice(0, 70)}`);
    }
  }
  check("обработчики on* не возвращают результат логического выражения", bad.length === 0, bad.join(" | "));
  // Повторное объявление функции ломает загрузку модуля целиком, а селфтест app.js не импортирует.
  const dupes = [];
  for (const [name, code] of sources) {
    const seen = new Map();
    for (const m of code.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)) seen.set(m[1], (seen.get(m[1]) || 0) + 1);
    for (const [fn, n] of seen) if (n > 1) dupes.push(`${name}.js: ${fn} ×${n}`);
  }
  check("в модулях нет повторно объявленных функций", dupes.length === 0, dupes.join(" | "));
}

// 4j. прогноз по выбранным командам (переключатель в карточке эпика, можно несколько)
{
  const W = 20;
  const tf = (id, per, epicFrom, epicPer) => {
    const perWeek = new Array(W).fill(per);
    const epicPerWeek = perWeek.map((_, i) => (i >= epicFrom ? epicPer : 0));
    const done = epicPerWeek.reduce((a, b) => a + b, 0);
    return { team: { id, name: id }, perWeek, epicPerWeek, total: per * W, byEpic: new Map([["EP-1", done]]) };
  };
  const A = tf("A", 10, 15, 5); // 25 задач эпика за последние 5 недель, доля 50%
  const B = tf("B", 2, 17, 1); // 3 задачи эпика за последние 3 недели, доля 50%
  const shares = new Map([A, B].map((x) => [x.team.id, flowlib.epicShare(x, "EP-1", { open: true })]));
  const run = (teams) => flowlib.forecastForTeams({ teams, shares, epicKey: "EP-1", remaining: 28, runs: 50, rnd: () => 0.5 });

  const both = run([A, B]);
  check("все команды: остаток делится по вкладу в эпик (25 : 3)",
    both.fc.teams.find((x) => x.team.id === "A").remaining === 25 && both.fc.teams.find((x) => x.team.id === "B").remaining === 3,
    JSON.stringify(both.fc.teams.map((x) => [x.team.id, x.remaining])));
  check("история — период работы над эпиком, растянутый до 12 недель", both.history.from === 8 && both.history.weeks === 12, JSON.stringify(both.history));
  const onlyB = run([B]);
  check("выбрана одна команда — весь остаток на ней", onlyB.fc.teams.length === 1 && onlyB.fc.teams[0].remaining === 28, JSON.stringify(onlyB.fc.teams.map((x) => x.remaining)));
  const onlyA = run([A]);
  check("выбор команды меняет срок: медленная команда одна — дольше", onlyB.fc.weeks.p50 > onlyA.fc.weeks.p50, `${onlyA.fc.weeks.p50} / ${onlyB.fc.weeks.p50}`);
  check("история прогноза режется по периоду", onlyA.fc.teams[0].perWeek.length === onlyA.history.weeks, String(onlyA.fc.teams[0].perWeek.length));
  const shortT = { ...tf("C", 3, 0, 1), perWeek: [3, 3, 3], epicPerWeek: [1, 1, 1] };
  const shortShares = new Map([["C", flowlib.epicShare(shortT, "EP-1", { open: true })]]);
  check("меньше 5 недель истории — прогноз не строится",
    flowlib.forecastForTeams({ teams: [shortT], shares: shortShares, epicKey: "EP-1", remaining: 5 }).reason === "short");
  check("без остатка или без команд — прогноза нет", run([]).reason === "none" &&
    flowlib.forecastForTeams({ teams: [A], shares, epicKey: "EP-1", remaining: 0 }).reason === "none");
}

// А5. кэш настроек подтягивает изменения из другой вкладки
{
  const before = settings.get().lastSync;
  for (const f of chrome.storage.onChanged._l) f({ settings: { newValue: { ...settings.get(), lastSync: 123456 } } }, "local");
  check("А5: изменение настроек в другой вкладке попадает в кэш", settings.get().lastSync === 123456, String(settings.get().lastSync));
  await settings.save({ hoursPerDay: 8 });
  check("А5: сохранение формы не откатывает поле, записанное другой вкладкой", settings.get().lastSync === 123456);
  await settings.save({ lastSync: before });
}

// А2. синхронизация: сбор в памяти, запись одной транзакцией; обрыв VPN базу не портит
{
  const orig = window.fetch;
  const saved = { fields: { ...settings.get().fields }, useTempoTeams: settings.get().useTempoTeams, flowWeeks: settings.get().flowWeeks, timeout: settings.get().requestTimeoutSec };
  await settings.save({ fields: { ...saved.fields, epicLink: "customfield_10100", sprint: "customfield_10101", version: 5 }, useTempoTeams: false, flowWeeks: 4 });
  await dbm.clearAll();
  await dbm.putAll(dbm.STORES.epics, [{ key: "EP-A", summary: "Эпик А", statusName: "В работе", statusCategory: "indeterminate" }]);
  await dbm.putAll(dbm.STORES.issues, [{ ...mk("OLD-1", "EP-A", "AAA", "Ivan", null, 1, "prog") }]);
  await dbm.putAll(dbm.STORES.flow, [{ key: "F-OLD", resolved: new Date().toISOString(), assigneeLogin: "ivan" }]);
  await dbm.putAll(dbm.STORES.others, [{ ...mk("O-OLD", "EP-X", "XXX", "Ivan", 2, 1, "prog") }]);

  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const issue = (key) => ({
    key,
    fields: {
      summary: "Новая", project: { key: "AAA", name: "AAA" }, assignee: { name: "ivan", key: "ivan", displayName: "Ivan" },
      status: { name: "В работе", statusCategory: { key: "indeterminate" } }, issuetype: { name: "Task" },
      updated: new Date().toISOString(), customfield_10100: "EP-A", customfield_10101: null
    }
  });
  let flowFails = true;
  window.fetch = async (url, opt = {}) => {
    const u = String(url);
    const b = opt.body ? JSON.parse(opt.body) : {};
    if (u.includes("/rest/api/2/myself")) return json({ name: "ivan" });
    if (u.includes("/rest/agile/1.0/board")) return json({ values: [], isLast: true });
    if (u.includes("/rest/api/2/search")) {
      const jql = b.jql || "";
      if (jql.includes("resolutiondate >=")) {
        if (flowFails) throw new TypeError("Failed to fetch"); // VPN отвалился посреди синхронизации
        return json({ issues: [], total: 0 });
      }
      if (jql.includes("cf[10100] in")) return json({ issues: [issue("NEW-1")], total: 1 });
      if (jql.includes("key in (EP-A)")) return json({ issues: [{ key: "EP-A", fields: { summary: "Эпик А (обновлён)", status: { name: "В работе", statusCategory: { key: "indeterminate" } }, project: { key: "AAA" } } }], total: 1 });
      return json({ issues: [], total: 0 });
    }
    return json({}, 404);
  };

  let err = null;
  try { await runSync({ full: true }); } catch (e) { err = e; }
  const keysOf = async (st) => (await dbm.all(st)).map((x) => x.key).sort().join(",");
  check("А2: обрыв сети посреди сбора — синхронизация прерывается ошибкой «Jira недоступна»", err && err.kind === "network" && err.message === t("err.network"), err && err.message);
  check("А2: после обрыва задачи, история потока и чужие задачи не изменились",
    (await keysOf(dbm.STORES.issues)) === "OLD-1" && (await keysOf(dbm.STORES.flow)) === "F-OLD" && (await keysOf(dbm.STORES.others)) === "O-OLD",
    `${await keysOf(dbm.STORES.issues)} / ${await keysOf(dbm.STORES.flow)} / ${await keysOf(dbm.STORES.others)}`);
  check("А2: после обрыва эпик не обновлён", (await dbm.getOne(dbm.STORES.epics, "EP-A")).summary === "Эпик А");

  flowFails = false;
  err = null;
  try { await runSync({ full: true }); } catch (e) { err = e; }
  check("А2: успешная полная синхронизация записывает всё разом",
    !err && (await keysOf(dbm.STORES.issues)) === "NEW-1" && (await keysOf(dbm.STORES.flow)) === "" && (await keysOf(dbm.STORES.others)) === "" &&
      (await dbm.getOne(dbm.STORES.epics, "EP-A")).summary === "Эпик А (обновлён)",
    err ? err.message : `${await keysOf(dbm.STORES.issues)} / ${await keysOf(dbm.STORES.flow)}`);

  // вид ошибки: не авторизован
  window.fetch = async () => json({ errorMessages: ["denied"] }, 401);
  err = null;
  try { await jiraApi.myself(); } catch (e) { err = e; }
  check("А2: 401 — ошибка вида «не авторизован»", err && err.kind === "auth");

  // таймаут: запрос, который не отвечает, обрывается и считается недоступностью
  await settings.save({ requestTimeoutSec: 0.05 });
  window.fetch = (url, opt) => new Promise((_, reject) => opt.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const t0 = Date.now();
  err = null;
  try { await jiraApi.myself(); } catch (e) { err = e; }
  check("А2: зависший запрос обрывается по таймауту как «Jira недоступна»", err && err.kind === "network" && Date.now() - t0 < 2000, `${err && err.kind} ${Date.now() - t0} мс`);

  window.fetch = orig;
  await settings.save({ fields: saved.fields, useTempoTeams: saved.useTempoTeams, flowWeeks: saved.flowWeeks, requestTimeoutSec: saved.timeout });
  await dbm.clearAll();
}

// Б0. подготовка данных: дата создания, число спринтов, дата завершения эпика, пропавшие задачи
{
  check("Б0: дата закрытия — дата завершения, у готовых без неё — дата обновления, у открытых — пусто",
    agg.closedAt({ ...mk("Z-1", "EP-1", "AAA", "Ivan", 2, 1, "done"), resolved: "2026-05-01", updated: "2026-06-01" }) === "2026-05-01" &&
      agg.closedAt({ ...mk("Z-2", "EP-1", "AAA", "Ivan", 2, 1, "prod"), resolved: "", updated: "2026-06-02" }) === "2026-06-02" &&
      agg.closedAt({ ...mk("Z-3", "EP-1", "AAA", "Ivan", 2, 1, "prog"), resolved: "", updated: "2026-06-03" }) === "");

  const orig = window.fetch;
  const saved = { fields: { ...settings.get().fields }, useTempoTeams: settings.get().useTempoTeams, flowWeeks: settings.get().flowWeeks, lastSync: settings.get().lastSync };
  await settings.save({ fields: { ...saved.fields, epicLink: "customfield_10100", sprint: "customfield_10101", version: 5 }, useTempoTeams: false, flowWeeks: 4, lastSync: Date.now() - 3600000 });
  await dbm.clearAll();
  await dbm.metaSet("issueSchema", 6); // текущая схема задач — иначе «Обновить» станет полной выгрузкой
  await dbm.putAll(dbm.STORES.epics, [{ key: "EP-A", summary: "Эпик А" }]);
  await dbm.putAll(dbm.STORES.issues, [
    mk("KEEP-1", "EP-A", "AAA", "Ivan", null, 1, "prog"),
    mk("GONE-1", "EP-A", "AAA", "Ivan", null, 1, "prog"),
    mk("ELSE-1", "EP-Z", "AAA", "Ivan", null, 1, "prog")
  ]);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const status = { name: "В работе", statusCategory: { key: "indeterminate" } };
  const fieldsOf = (extra = {}) => ({ summary: "Задача", project: { key: "AAA" }, assignee: { name: "ivan", key: "ivan", displayName: "Ivan" }, status, issuetype: { name: "Task" }, updated: new Date().toISOString(), customfield_10100: "EP-A", ...extra });
  let keysFail = false;
  window.fetch = async (url, opt = {}) => {
    const u = String(url);
    const b = opt.body ? JSON.parse(opt.body) : {};
    if (u.includes("/rest/api/2/myself")) return json({ name: "ivan" });
    if (u.includes("/rest/agile/1.0/board")) return json({ values: [], isLast: true });
    if (u.includes("/rest/api/2/search")) {
      const jql = b.jql || "";
      if (jql.includes("key in (EP-A)")) return json({ issues: [{ key: "EP-A", fields: { summary: "Эпик А", status: { name: "Готово", statusCategory: { key: "done" } }, project: { key: "AAA" }, resolutiondate: "2026-09-01T10:00:00.000+0300" } }], total: 1 });
      if (jql.includes("in (EP-A)") && jql.includes("updated >=")) {
        return json({ issues: [{ key: "NEW-1", fields: fieldsOf({ created: "2026-08-01T09:00:00.000+0300", customfield_10101: [{ id: 11, name: "S1", state: "closed" }, { id: 12, name: "S2", state: "closed" }, { id: 13, name: "S3", state: "active" }] }) }], total: 1 });
      }
      if (jql.includes("in (EP-A)")) {
        if (keysFail) return json({ errorMessages: ["bad jql"] }, 400);
        return json({ issues: [{ key: "KEEP-1" }, { key: "NEW-1" }], total: 2 });
      }
      return json({ issues: [], total: 0 });
    }
    return json({}, 404);
  };
  let res = null;
  let err = null;
  try { res = await runSync({ full: false }); } catch (e) { err = e; }
  const keysNow = (await dbm.all(dbm.STORES.issues)).map((x) => x.key).sort().join(",");
  check("Б0: «Обновить» удаляет задачи, пропавшие из выбранных эпиков; задачи других эпиков не трогает",
    !err && keysNow === "ELSE-1,KEEP-1,NEW-1" && res.removed === 1, err ? err.message : `${keysNow} / ${res && res.removed}`);
  const newIssue = await dbm.getOne(dbm.STORES.issues, "NEW-1");
  check("Б0: у задачи сохранены дата создания и число спринтов", newIssue?.created?.startsWith("2026-08-01") && newIssue.sprintCount === 3, JSON.stringify({ c: newIssue?.created, n: newIssue?.sprintCount }));
  check("Б0: у эпика сохранена дата завершения", (await dbm.getOne(dbm.STORES.epics, "EP-A"))?.resolved?.startsWith("2026-09-01"));

  await dbm.putAll(dbm.STORES.issues, [mk("GONE-2", "EP-A", "AAA", "Ivan", null, 1, "prog")]);
  keysFail = true;
  err = null;
  try { res = await runSync({ full: false }); } catch (e) { err = e; }
  check("Б0: запрос ключей не прошёл — ничего не удаляется", !err && !!(await dbm.getOne(dbm.STORES.issues, "GONE-2")) && res.removed === 0, err ? err.message : String(res && res.removed));

  window.fetch = orig;
  await settings.save({ fields: saved.fields, useTempoTeams: saved.useTempoTeams, flowWeeks: saved.flowWeeks, lastSync: saved.lastSync });
  await dbm.clearAll();
}

// Б1. история: журнал синхронизаций и недельные записи пишутся в той же транзакции, что и данные
{
  const DAYMS = 86400000;
  const orig = window.fetch;
  const saved = { fields: { ...settings.get().fields }, useTempoTeams: settings.get().useTempoTeams, flowWeeks: settings.get().flowWeeks };
  await settings.save({ fields: { ...saved.fields, epicLink: "customfield_10100", sprint: "customfield_10101", version: 5 }, useTempoTeams: false, flowWeeks: 20 });
  await dbm.clearAll();
  const nowMs = Date.now();
  await dbm.putAll(dbm.STORES.epics, [{ key: "EP-A", summary: "Эпик А", dueDate: ymd(365) }]);
  await dbm.putAll(dbm.STORES.syncLog, [
    { syncId: nowMs - 31 * DAYMS, epicKey: "EP-A", total: 1 },
    { syncId: nowMs - 20 * DAYMS, epicKey: "EP-A", total: 2 }
  ]);
  await dbm.putAll(dbm.STORES.epicWeeks, [
    { epicKey: "EP-A", week: flowlib.weekKey(nowMs - 110 * 7 * DAYMS), restored: true },
    { epicKey: "EP-A", week: flowlib.weekKey(nowMs - 10 * 7 * DAYMS), restored: true }
  ]);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const st = (done) => (done ? { name: "Готово", statusCategory: { key: "done" } } : { name: "В работе", statusCategory: { key: "indeterminate" } });
  const person = { name: "ivan", key: "ivan", displayName: "Ivan" };
  const task = (key, done) => ({ key, fields: { summary: key, project: { key: "AAA" }, assignee: person, status: st(done), issuetype: { name: "Task" }, updated: new Date().toISOString(), created: new Date(nowMs - 100 * DAYMS).toISOString(), customfield_10100: "EP-A", timeoriginalestimate: 3600 } });
  const flowRows = [];
  for (let w = 1; w <= 12; w++) for (let i = 0; i < 3; i++) {
    flowRows.push({ key: `FL-${w}-${i}`, fields: { resolutiondate: new Date(nowMs - w * 7 * DAYMS - 2 * DAYMS).toISOString(), assignee: person, customfield_10100: "EP-A", status: st(true), issuetype: { name: "Task" }, project: { key: "AAA" } } });
  }
  window.fetch = async (url, opt = {}) => {
    const u = String(url);
    const b = opt.body ? JSON.parse(opt.body) : {};
    if (u.includes("/rest/api/2/myself")) return json({ name: "ivan" });
    if (u.includes("/rest/agile/1.0/board")) return json({ values: [], isLast: true });
    if (u.includes("/rest/api/2/search")) {
      const jql = b.jql || "";
      if (jql.includes("resolutiondate >=")) return json({ issues: flowRows, total: flowRows.length });
      if (jql.includes("key in (EP-A)")) return json({ issues: [{ key: "EP-A", fields: { summary: "Эпик А", status: st(false), project: { key: "AAA" }, duedate: ymd(365) } }], total: 1 });
      if (jql.includes("in (EP-A)")) return json({ issues: [task("T-1", true), task("T-2", false), task("T-3", false), task("T-4", false)], total: 4 });
      return json({ issues: [], total: 0 });
    }
    return json({}, 404);
  };
  let res = null;
  let err = null;
  try { res = await runSync({ full: true }); } catch (e) { err = e; }
  const log = await dbm.all(dbm.STORES.syncLog);
  const weeksRows = await dbm.all(dbm.STORES.epicWeeks);
  const cur = log.find((r) => r.syncId === res?.syncId);
  check("Б1: запись журнала на синхронизацию — со счётчиками и прогнозом",
    !err && cur && cur.total === 4 && cur.done === 1 && cur.remaining === 3 && !!cur.p85 && cur.chance === 1 && cur.buffer > 0,
    err ? err.message : JSON.stringify(cur && { total: cur.total, done: cur.done, p85: cur.p85, chance: cur.chance, buffer: cur.buffer, reason: cur.reason }));
  check("Б1: дата прогноза в истории — местная дата, понедельник (отсчёт от понедельника)",
    !!cur && new Date(`${cur.p85}T12:00:00`).getDay() === 1, cur && cur.p85);
  check("Б1: журнал старше 30 дней удалён, 20-дневный остался",
    !log.some((r) => r.syncId === nowMs - 31 * DAYMS) && log.some((r) => r.syncId === nowMs - 20 * DAYMS), String(log.length));
  const thisWeek = weeksRows.filter((r) => r.week === flowlib.weekKey(res?.syncId || nowMs));
  check("Б1: недельная запись текущей недели — настоящая", thisWeek.length === 1 && thisWeek[0].restored === false && thisWeek[0].p85 === cur?.p85);
  check("Б1: недельные записи старше 104 недель удалены, остальные на месте",
    !weeksRows.some((r) => r.week === flowlib.weekKey(nowMs - 110 * 7 * DAYMS)) && weeksRows.some((r) => r.week === flowlib.weekKey(nowMs - 10 * 7 * DAYMS)));
  try { res = await runSync({ full: false }); } catch (e) { err = e; }
  const weeks2 = (await dbm.all(dbm.STORES.epicWeeks)).filter((r) => r.week === flowlib.weekKey(nowMs));
  const log2 = await dbm.all(dbm.STORES.syncLog);
  check("Б1: вторая синхронизация недели — новая запись журнала, недельная перезаписана",
    weeks2.length === 1 && log2.filter((r) => r.syncId >= nowMs).length === 2, `${weeks2.length} / ${log2.length}`);
  await sync_saveSelectionCheck();
  async function sync_saveSelectionCheck() {
    const { saveSelection } = await import("../src/js/sync.js");
    await saveSelection([]);
    check("Б1: удаление эпика из выбора не удаляет его историю", (await dbm.all(dbm.STORES.epicWeeks)).some((r) => r.epicKey === "EP-A"));
  }

  // Б2. прогноз детерминирован в пределах недели: зерно — ключ эпика, отсчёт — понедельник
  const rows = flowRows.map((r) => ({ key: r.key, resolved: r.fields.resolutiondate, assigneeKey: "ivan", assigneeLogin: "ivan", assigneeName: "Ivan", epicKey: "EP-A", typeName: "" }));
  const iss = Array.from({ length: 20 }, (_, i) => mk(`D-${i}`, "EP-A", "AAA", "Ivan", null, 1, "prog"));
  const flowSt = analytics.epicFlowState({ epic: { key: "EP-A" }, rows, issues: iss, weeks: 20, now: nowMs });
  const monday = flowlib.mondayOf(nowMs);
  const tue = await analytics.epicForecast({ epic: { key: "EP-A", dueDate: ymd(365) }, flow: flowSt, today: monday + 1 * DAYMS + 3600000, runs: 3000 });
  const fri = await analytics.epicForecast({ epic: { key: "EP-A", dueDate: ymd(365) }, flow: flowSt, today: monday + 4 * DAYMS + 3600000, runs: 3000 });
  check("Б2: во вторник и в пятницу одной недели на тех же данных — те же даты прогноза",
    tue.fc.dates.p85.getTime() === fri.fc.dates.p85.getTime() && tue.fc.dates.p50.getTime() === fri.fc.dates.p50.getTime() && tue.chance === fri.chance,
    `${tue.fc.dates.p85.toISOString()} / ${fri.fc.dates.p85.toISOString()}`);
  const nextWeek = await analytics.epicForecast({ epic: { key: "EP-A" }, flow: flowSt, today: monday + 8 * DAYMS, runs: 3000 });
  check("Б2: через неделю без изменений данных прогноз сдвигается ровно на неделю",
    nextWeek.fc.dates.p85.getTime() - tue.fc.dates.p85.getTime() === 7 * DAYMS);

  window.fetch = orig;
  await settings.save({ fields: saved.fields, useTempoTeams: saved.useTempoTeams, flowWeeks: saved.flowWeeks });
  await dbm.clearAll();
}

// Б3. восстановление истории задним числом
{
  const DAYMS = 86400000;
  const WEEK = 7 * DAYMS;
  const nowMs = Date.now();
  const flowStart = flowlib.mondayOf(nowMs - 30 * WEEK) + WEEK;
  const lastWeek = flowlib.mondayOf(flowlib.mondayOf(nowMs) - 3 * DAYMS);
  const epic = { key: "EP-B", created: new Date(nowMs - 20 * WEEK).toISOString(), resolved: "", dueDate: ymd(200) };
  const closedTs = (i) => nowMs - (10 - i) * WEEK - DAYMS;
  const issuesB = Array.from({ length: 10 }, (_, i) => ({
    ...mk(`B3-${i}`, "EP-B", "AAA", "Ivan", null, 1, i < 6 ? "done" : "prog"),
    created: new Date(nowMs - 18 * WEEK).toISOString(),
    resolved: i < 6 ? new Date(closedTs(i)).toISOString() : ""
  }));
  // поздно добавленная задача — в объёме только с недели создания
  issuesB.push({ ...mk("B3-late", "EP-B", "AAA", "Ivan", null, 1, "prog"), created: new Date(nowMs - 3 * WEEK).toISOString(), resolved: "" });
  const flowRowsB = [];
  for (let w = 1; w <= 25; w++) for (let i = 0; i < 3; i++) {
    flowRowsB.push({ key: `FB-${w}-${i}`, resolved: new Date(nowMs - w * WEEK - 2 * DAYMS).toISOString(), assigneeKey: "ivan", assigneeLogin: "ivan", assigneeName: "Ivan", epicKey: w <= 12 && i === 0 ? "EP-B" : "EP-9", typeName: "" });
  }
  const skipKey = flowlib.weekKey(nowMs - 5 * WEEK);
  const recs = await analytics.restoreEpicWeeks({ epic, issues: issuesB, flowRows: flowRowsB, flowStart, lastWeek, skipWeeks: new Set([skipKey]), runs: 500 });
  const byWeek = new Map(recs.map((r) => [r.week, r]));
  const firstExpected = flowlib.weekKey(Math.max(flowlib.mondayOf(Date.parse(epic.created)), flowlib.mondayOf(flowStart + 5 * WEEK + 12 * 3600000)));
  check("Б3: восстановление начинается не раньше создания эпика и 5 недель истории потока",
    recs.length > 0 && recs.map((r) => r.week).sort()[0] === firstExpected, `${recs.map((r) => r.week).sort()[0]} / ${firstExpected}`);
  check("Б3: неделя с настоящей записью не восстанавливается", !byWeek.has(skipKey) && recs.every((r) => r.restored === true));
  check("Б3: текущая неделя не восстанавливается — только прошедшие", !byWeek.has(flowlib.weekKey(nowMs)) && byWeek.has(flowlib.weekKey(lastWeek)));
  const wk = flowlib.mondayOf(nowMs - 8 * WEEK);
  const endWk = wk + WEEK;
  const manualClosed = issuesB.filter((x) => x.resolved && Date.parse(x.resolved) < endWk && Date.parse(x.created) < endWk).length;
  const manualScope = issuesB.filter((x) => Date.parse(x.created) < endWk).length;
  const r8 = byWeek.get(flowlib.weekKey(wk));
  check("Б3: остаток на прошлую неделю совпадает с ручным подсчётом по датам создания и закрытия",
    r8 && r8.total === manualScope && r8.done === manualClosed && r8.remaining === manualScope - manualClosed,
    JSON.stringify(r8 && { total: r8.total, done: r8.done, remaining: r8.remaining, manualScope, manualClosed }));
  const rLast = byWeek.get(flowlib.weekKey(lastWeek));
  check("Б3: поздно добавленная задача входит в объём только с недели создания", r8.total === 10 && rLast.total === 11, `${r8.total} / ${rLast.total}`);
  check("Б3: на прошлых неделях есть прогноз, недели с короткой историей помечены ориентировочными",
    !!r8.p85 && recs.some((r) => r.approximate) && recs.some((r) => !r.approximate));
  check("Б3: эпик, закрытый позже, на прошлых неделях не «готов»", recs.every((r) => r.statusCategory !== "done"));

  // через хранилище: настоящие записи не перезаписываются, версия восстановления отмечена
  const saved = { flowWeeks: settings.get().flowWeeks, lastSync: settings.get().lastSync };
  await settings.save({ flowWeeks: 30, lastSync: nowMs });
  await dbm.clearAll();
  await dbm.putAll(dbm.STORES.epics, [epic]);
  await dbm.putAll(dbm.STORES.issues, issuesB);
  await dbm.putAll(dbm.STORES.flow, flowRowsB);
  const realWeek = flowlib.weekKey(nowMs - 4 * WEEK);
  await dbm.putAll(dbm.STORES.epicWeeks, [{ epicKey: "EP-B", week: realWeek, restored: false, total: 999 }]);
  const t0 = Date.now();
  const bf = await backfillHistory({ today: nowMs });
  const stored = await dbm.all(dbm.STORES.epicWeeks);
  check("Б3: настоящая запись недели после восстановления не изменилась",
    stored.find((r) => r.week === realWeek)?.total === 999 && stored.filter((r) => r.restored).length === bf.weeks && bf.weeks > 10, `${bf.weeks} недель за ${Date.now() - t0} мс`);
  check("Б3: версия восстановления отмечена", (await dbm.metaGet("backfillVersion", 0)) === 1);
  await settings.save(saved);
  await dbm.clearAll();
}

// Б4. правила сигналов: срабатывают на пороге и не срабатывают чуть ниже
{
  const DAYMS = 86400000;
  const now = Date.now();
  const th = { ...settings.DEFAULTS.summary };
  const d = (days) => { const x = new Date(now + days * DAYMS); const p2 = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; };
  const stOf = (o = {}) => ({ epicKey: "EP-1", statusName: "В работе", statusCategory: "indeterminate", dueDate: d(90), total: 100, done: 40, remaining: 60, estTotal: 0, estDone: 0, carriedOver: 0, p50: d(40), p85: d(50), chance: 0.95, buffer: 5, reason: "", historyWeeks: 30, teams: [], ...o });
  const run = (cur, base = null, extra = {}) => summary.computeSignals({ current: new Map(Object.entries(cur)), base: base ? new Map(Object.entries(base)) : null, thresholds: th, now, ...extra });
  const has = (sigs, type, epicKey) => sigs.some((x) => x.type === type && (!epicKey || x.epicKey === epicKey));
  const recent = [mk("RC-1", "EP-1", "AAA", "Ivan", 2, 1, "done")].map((i) => ({ ...i, resolved: new Date(now - 2 * DAYMS).toISOString() }));

  check("Б4: цвет — зелёный от 85%, жёлтый от 50%, красный ниже или срок прошёл",
    summary.colorOf(stOf({ chance: 0.85 }), th, now) === "green" && summary.colorOf(stOf({ chance: 0.84 }), th, now) === "yellow" &&
      summary.colorOf(stOf({ chance: 0.5 }), th, now) === "yellow" && summary.colorOf(stOf({ chance: 0.49 }), th, now) === "red" &&
      summary.colorOf(stOf({ dueDate: d(-2) }), th, now) === "red" && summary.colorOf(stOf({ dueDate: "" }), th, now) === "nodue" &&
      summary.colorOf(stOf({ statusCategory: "done" }), th, now) === "done");

  const base1 = { "EP-1": stOf() };
  check("Б4: рост объёма на 5 задач — сигнал, на 4 (из 100) — нет",
    has(run({ "EP-1": stOf({ total: 105, remaining: 65 }) }, base1, { issues: recent }), "scopeUp") && !has(run({ "EP-1": stOf({ total: 104, remaining: 64 }) }, base1, { issues: recent }), "scopeUp"));
  check("Б4: рост объёма на 10% у маленького эпика", has(run({ "EP-1": stOf({ total: 11 }) }, { "EP-1": stOf({ total: 10 }) }, { issues: recent }), "scopeUp"));
  check("Б4: сокращение объёма — информация", run({ "EP-1": stOf({ total: 94 }) }, base1, { issues: recent }).some((x) => x.type === "scopeDown" && x.severity === "info"));
  check("Б4: сдвиг прогноза на 7 дней позже — внимание, на 6 — нет",
    run({ "EP-1": stOf({ p85: d(57) }) }, base1, { issues: recent }).some((x) => x.type === "shiftLater" && x.severity === "warning" && x.params.days === 7) &&
      !has(run({ "EP-1": stOf({ p85: d(56) }) }, base1, { issues: recent }), "shiftLater"));
  check("Б4: прогноз раньше на неделю — информация", run({ "EP-1": stOf({ p85: d(43) }) }, base1, { issues: recent }).some((x) => x.type === "shiftEarlier" && x.severity === "info"));
  check("Б4: изменён срок исполнения", has(run({ "EP-1": stOf({ dueDate: d(100) }) }, base1, { issues: recent }), "dueChanged"));
  check("Б4: новые повторные переносы и прогресс", has(run({ "EP-1": stOf({ carriedOver: 2, done: 45 }) }, base1, { issues: recent }), "carryNew") && has(run({ "EP-1": stOf({ done: 45 }) }, base1, { issues: recent }), "progress"));
  check("Б4: эпик добавлен / завершён", has(run({ "EP-1": stOf(), "EP-2": stOf({ epicKey: "EP-2" }) }, base1, { issues: recent }), "epicAdded", "EP-2") && has(run({ "EP-1": stOf({ statusCategory: "done", statusName: "Готово" }) }, base1), "epicDone"));
  check("Б4: без базы блока «что изменилось» нет", !run({ "EP-1": stOf({ total: 200 }) }, null, { issues: recent }).some((x) => x.group === "changes"));

  check("Б4: срок прошёл — критично", run({ "EP-1": stOf({ dueDate: d(-3) }) }, null, { issues: recent }).some((x) => x.type === "overdue" && x.severity === "critical" && x.params.days >= 2));
  check("Б4: шанс 49% — критично, 50% — внимание, 85% — ничего",
    has(run({ "EP-1": stOf({ chance: 0.49 }) }, null, { issues: recent }), "lowChance") && has(run({ "EP-1": stOf({ chance: 0.5 }) }, null, { issues: recent }), "riskChance") &&
      !has(run({ "EP-1": stOf({ chance: 0.85 }) }, null, { issues: recent }), "riskChance"));
  const wk = (b) => ({ buffer: b });
  check("Б4: запас снижался 3 недели подряд — «запас тает»; с плато — нет",
    has(run({ "EP-1": stOf() }, null, { issues: recent, weekly: new Map([["EP-1", [wk(5), wk(4), wk(3), wk(2.5)]]]) }), "melting") &&
      !has(run({ "EP-1": stOf() }, null, { issues: recent, weekly: new Map([["EP-1", [wk(5), wk(4), wk(4), wk(3)]]]) }), "melting"));
  check("Б4: готово 90% — близко к завершению, 89% при далёком прогнозе — нет",
    has(run({ "EP-1": stOf({ done: 90, remaining: 10 }) }, null, { issues: recent }), "near") && !has(run({ "EP-1": stOf({ done: 89, remaining: 11 }) }, null, { issues: recent }), "near"));
  check("Б4: прогноз 85% в пределах 2 недель — близко к завершению", has(run({ "EP-1": stOf({ p85: d(10) }) }, null, { issues: recent }), "near"));
  check("Б4: 3 недели без закрытий: при 90% — «застрял на финише», при 40% — «застой»",
    has(run({ "EP-1": stOf({ done: 90, remaining: 10 }) }), "stuckFinish") && has(run({ "EP-1": stOf() }), "stall") && !has(run({ "EP-1": stOf() }, null, { issues: recent }), "stall"));
  check("Б4: хронические переносы", has(run({ "EP-1": stOf({ carriedOver: 3 }) }, null, { issues: recent }), "chronicCarry"));

  const H = 3600;
  const loadFix = { capacity: 80 * H, sections: [{ id: "sec:0", caption: "текущий" }, { id: "sec:1", caption: "+1" }], byName: new Map([["ivan", new Map([["sec:0", 100 * H]])], ["olga", new Map([["sec:0", 80 * H]])]]) };
  const people = [mk("P-1", "EP-1", "AAA", "Ivan", 2, 1, "prog"), mk("P-2", "EP-1", "AAA", "Olga", 2, 1, "prog")];
  const ov = run({ "EP-1": stOf() }, null, { issues: [...recent, ...people], load: loadFix }).filter((x) => x.type === "overload");
  check("Б4: перегруз — по имени, только выше 100%", ov.length === 1 && ov[0].person === "Ivan" && ov[0].params.pct === 125, JSON.stringify(ov.map((x) => x.params)));

  const teamQA = { id: "m:QA", name: "QA" };
  const teamOf = (p) => (["petr", "Petr"].includes(p.name) || p.login === "petr" ? teamQA : null);
  const idleLoad = { capacity: 80 * H, sections: [{ id: "sec:0", caption: "текущий" }, { id: "sec:1", caption: "+1" }], byName: new Map([["petr", new Map([["sec:0", 20 * H]])]]) };
  const backlogTask = mk("BL-1", "EP-1", "AAA", "Petr", null, 4, "new");
  check("Б4: простой рядом с опозданием: команда загружена на 13%, у жёлтого эпика её задачи в бэклоге",
    run({ "EP-1": stOf({ chance: 0.6 }) }, null, { issues: [...recent, backlogTask], load: idleLoad, teamOf, teamSize: () => 1 }).some((x) => x.type === "idleNearLate" && x.params.team === "QA" && x.params.pct === 13) &&
      !has(run({ "EP-1": stOf({ chance: 0.95 }) }, null, { issues: [...recent, backlogTask], load: idleLoad, teamOf, teamSize: () => 1 }), "idleNearLate"));

  const flowSpread = [];
  for (let w = 0; w < 4; w++) for (let e = 0; e < 5; e++) flowSpread.push({ key: `SP-${w}-${e}`, resolved: new Date(now - (w * 7 + 1) * DAYMS).toISOString(), assigneeLogin: "petr", assigneeName: "Petr", epicKey: `EP-S${e}` });
  check("Б4: распыление: 5 задач в неделю на 5 эпиков (1 на эпик) — сигнал",
    run({ "EP-1": stOf() }, null, { issues: recent, flowRows: flowSpread, teamOf }).some((x) => x.type === "spread" && x.params.epics === 5 && x.params.perEpic === 1) &&
      !has(run({ "EP-1": stOf() }, null, { issues: recent, flowRows: flowSpread, teamOf, thresholds: { ...th, spreadFlow: 1 } }), "spread"));

  const tm = (last) => [{ id: "t:1", name: "1C", share: 0.3, last }];
  check("Б4: узкое место — команда замыкает ≥50% прогонов в двух эпиках",
    has(run({ "EP-1": stOf({ teams: tm(60) }), "EP-2": stOf({ epicKey: "EP-2", teams: tm(50) }) }, null, { issues: recent }), "bottleneck") &&
      !has(run({ "EP-1": stOf({ teams: tm(60) }), "EP-2": stOf({ epicKey: "EP-2", teams: tm(49) }) }, null, { issues: recent }), "bottleneck"));

  const firedModel = { columns: [{ id: "sec:0", sprints: [{ id: 2 }] }], groups: [] };
  const firedIssues = [mk("FI-1", "EP-1", "AAA", "Ivan", 2, 1, "prog"), mk("FI-2", "EP-1", "AAA", "Ivan", null, 1, "new"), mk("FI-3", "EP-1", "AAA", "Ivan", 1, 1, "prog")];
  check("Б4: задачи у уволенных — критично, закрытые спринты не считаются",
    run({ "EP-1": stOf() }, null, { issues: [...recent, ...firedIssues], profiles: [{ name: "ivan", status: "fired" }], model: firedModel }).some((x) => x.type === "firedTasks" && x.severity === "critical" && x.params.n === 2));
  check("Б4: задачи без исполнителя в текущем спринте",
    run({ "EP-1": stOf() }, null, { issues: [...recent, { ...mk("UA-1", "EP-1", "AAA", null, 2, 1, "prog"), assigneeKey: "" }], model: firedModel }).some((x) => x.type === "unassigned" && x.params.n === 1));

  const q = run({ "EP-1": stOf({ dueDate: "", reason: "short", historyWeeks: 3, p85: "" }) }, null, {
    issues: [...recent, mk("NE-1", "EP-1", "AAA", "Ivan", 2, 0, "prog"), mk("NE-2", "EP-1", "AAA", "Ivan", 2, 0, "prog")],
    model: { columns: [], groups: [{ label: "Anna", team: { id: "" } }] },
    lastSync: now - 10 * DAYMS,
    apiLimited: true
  });
  check("Б4: качество данных — нет срока, нет оценок, мало истории, люди без команды, устаревшие данные, ограничения API",
    ["noDue", "noEstimate", "shortHistory", "noTeam", "stale", "apiLimited"].every((type) => has(q, type)), q.map((x) => x.type).join(","));

  const many = run({ "EP-1": stOf({ dueDate: d(-5) }), "EP-2": stOf({ epicKey: "EP-2", chance: 0.6 }), "EP-3": stOf({ epicKey: "EP-3", chance: 0.1 }) }, null, { issues: recent });
  const top = summary.attention(many, 2);
  check("Б4: «Требует внимания» — сначала критичные, по величине, без информационных, не больше лимита",
    top.length === 2 && top.every((x) => x.severity === "critical") && summary.attention(many, 10).every((x) => x.severity !== "info"), top.map((x) => x.type).join(","));
  check("Б4: у сигнала устойчивый ключ", many.every((x) => typeof x.id === "string" && x.id.startsWith(x.type)));
}

// Б5. вкладка «Сводка»: база сравнения, режим «за 7 дней», отрисовка, тексты; Б10 — пороги в конфигурации
{
  const DAYMS = 86400000;
  const now = Date.now();
  const d = (days) => { const x = new Date(now + days * DAYMS); const p2 = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; };
  const stOf = (o = {}) => ({ epicKey: "EP-1", summary: "Личный кабинет", epicName: "ЛК", statusName: "В работе", statusCategory: "indeterminate", dueDate: d(90), total: 100, done: 40, remaining: 60, estTotal: 0, estDone: 0, carriedOver: 0, p50: d(40), p85: d(50), chance: 0.95, buffer: 5.5, reason: "", historyWeeks: 30, teams: [], ...o });
  await dbm.clearAll();
  const s1 = now - 8 * DAYMS;
  const s2 = now - 1000;
  await dbm.putAll(dbm.STORES.epics, [{ key: "EP-1", summary: "Личный кабинет" }, { key: "EP-2", summary: "Биллинг" }]);
  await dbm.putAll(dbm.STORES.issues, [{ ...mk("S5-1", "EP-1", "AAA", "Ivan", 2, 1, "done"), resolved: new Date(now - DAYMS).toISOString() }, { ...mk("S5-2", "EP-2", "AAA", "Ivan", 2, 1, "done"), resolved: new Date(now - DAYMS).toISOString() }]);
  await dbm.putAll(dbm.STORES.sprints, sprints);
  await dbm.putAll(dbm.STORES.syncLog, [
    { ...stOf(), syncId: s1 },
    { ...stOf({ epicKey: "EP-2", summary: "Биллинг", epicName: "", chance: 0.3, buffer: -1.5 }), syncId: s1 },
    { ...stOf({ total: 106, remaining: 66, p85: d(58) }), syncId: s2 },
    { ...stOf({ epicKey: "EP-2", summary: "Биллинг", epicName: "", chance: 0.3, buffer: -1.5 }), syncId: s2 }
  ]);
  await dbm.putAll(dbm.STORES.epicWeeks, [2.5, 1, -0.5, -1.5].map((b, i) => ({ ...stOf({ epicKey: "EP-2", buffer: b }), week: flowlib.weekKey(now - (4 - i) * 7 * DAYMS), restored: true })));
  await dbm.metaSet("lastSyncId", s2);
  await dbm.metaSet("seenSyncId", s1);
  await settings.save({ lastSync: s2 });

  const session = await summaryView.openSession();
  check("Б5: при открытии база — прошлая отметка, отметка сдвигается на последнюю синхронизацию",
    session.baseSyncId === s1 && (await dbm.metaGet("seenSyncId")) === s2);
  const data = await summaryView.loadData({ session, now });
  check("Б5: изменения — относительно прошлого просмотра", data.signals.some((x) => x.type === "scopeUp" && x.epicKey === "EP-1") && data.signals.some((x) => x.type === "shiftLater"),
    data.signals.map((x) => x.type).join(","));
  check("Б5: запас тает — по недельным записям, в том числе восстановленным", data.signals.some((x) => x.type === "melting" && x.epicKey === "EP-2"));
  const again = await summaryView.loadData({ session: await summaryView.openSession(), now });
  check("Б5: ушли и вернулись без обновления — «что изменилось» пусто", !again.signals.some((x) => x.group === "changes"));
  const week = await summaryView.loadData({ mode: "week", session, now });
  check("Б5: «за 7 дней» — последняя синхронизация не позже недели назад", week.base && week.base.at === s1 && week.signals.some((x) => x.type === "scopeUp"));

  const shift = data.signals.find((x) => x.type === "shiftLater");
  const txt = summaryView.signalText(shift, data.current);
  check("Б5: текст сигнала — эпик с Epic Name и даты в виде ДД.ММ.ГГ", txt.includes("EP-1 · ЛК") && /\d\d\.\d\d\.\d\d → \d\d\.\d\d\.\d\d/.test(txt), txt);
  const low = data.signals.find((x) => x.type === "lowChance");
  check("Б5: запас со знаком и запятой", summaryView.signalText(low, data.current).includes("−1,5"), summaryView.signalText(low, data.current));

  const box = document.createElement("div");
  document.body.append(box);
  await summaryView.render(box, { session: { baseSyncId: s1 } });
  const rowsTxt = [...box.querySelectorAll(".sum-table tbody tr.clickable")].map((tr) => tr.textContent);
  check("Б5: вкладка — шапка, итог по цветам, «Требует внимания», 5 блоков, таблица портфеля",
    !!box.querySelector(".sum-head") && box.querySelectorAll(".sum-total").length >= 2 && box.querySelectorAll(".sum-attention .sig").length >= 1 &&
      box.querySelectorAll("details.sum-group:not(.sum-accuracy)").length === 5 && rowsTxt.length === 2, `${rowsTxt.length}`);
  check("Б5: портфель — от худшего запаса", rowsTxt[0].startsWith("EP-2"), rowsTxt.join(" | "));
  check("Б5: мини-график запаса — линия по недельным записям", !!box.querySelector(".sum-table tbody tr .spark polyline"));
  box.querySelector(".sum-table tbody tr.clickable").click();
  const opened = box.querySelector(".sum-table tbody tr.sum-detail:not([hidden])");
  check("Б6: клик по строке портфеля раскрывает графики эпика", !!opened && opened.dataset.key === "EP-2" && opened.querySelectorAll("svg").length >= 1, opened && opened.innerText.slice(0, 80));
  check("Б6.1: под таблицей — тренд запаса по жёлтым и красным эпикам", !!box.querySelector(".sum-trend-box svg") && box.querySelectorAll(".sum-trend-box .tr-legend-item:not(.off)").length === 1);
  box.remove();

  // Б10: пороги попадают в экспорт и импорт конфигурации
  await settings.save({ summary: { shiftDays: 9 } });
  const exported = await exportConfig();
  check("Б10: пороги «Сводки» и таймаут — в экспорте конфигурации", exported.summary.shiftDays === 9 && exported.summary.chanceGreen === 85 && exported.requestTimeoutSec === settings.get().requestTimeoutSec);
  await applyConfig(parseConfig(JSON.stringify({ summary: { shiftDays: 10, bogus: 5, chanceGreen: "x" } })), { onLog: () => {} });
  check("Б10: импорт порогов — только известные числовые, остальное по умолчанию",
    settings.get().summary.shiftDays === 10 && !("bogus" in settings.get().summary) && settings.get().summary.chanceGreen === 85, JSON.stringify(settings.get().summary));
  await settings.save({ summary: { ...settings.DEFAULTS.summary } });
  await dbm.clearAll();
}

// Этап 3: «Принято» (Б5) и счётчик новых сигналов, отчёт в буфер обмена (Б7)
{
  const th = { ...settings.DEFAULTS.summary };
  const sig = (type, rank, params = {}) => ({ id: `${type}|EP-1||`, type, rank, params, severity: "critical" });
  const acks = { [`lowChance|EP-1||`]: summary.ackOf(sig("lowChance", 60, { chance: 40 })) };
  check("«Принято»: сигнал скрыт, пока шанс не упадёт ещё на 10 пунктов",
    summary.isAcked(sig("lowChance", 65, { chance: 35 }), acks, th) && !summary.isAcked(sig("lowChance", 71, { chance: 29 }), acks, th));
  const acks2 = { [`stall|EP-1||`]: summary.ackOf(sig("stall", 0, { weeks: 3 })) };
  check("«Принято»: сигнал без величины скрыт, пока не поменялись параметры",
    summary.isAcked(sig("stall", 0, { weeks: 3 }), acks2, th) && !summary.isAcked(sig("stall", 0, { weeks: 4 }), acks2, th));
  check("«Принято»: отметки исчезнувших сигналов снимаются", Object.keys(summary.pruneAcks({ ...acks, "gone|X||": { rank: 1 } }, [sig("lowChance", 60)])).join() === "lowChance|EP-1||");
  check("счётчик: новые «внимание» и «критично», не принятые и не показанные",
    summary.freshCount([sig("lowChance", 60), { ...sig("stall", 0), id: "stall|EP-2||" }, { ...sig("noDue", 0), id: "noDue|EP-3||", severity: "info" }], acks, ["stall|EP-2||"], th) === 0 &&
      summary.freshCount([sig("lowChance", 60), { ...sig("stall", 0), id: "stall|EP-2||" }], {}, [], th) === 2);

  const DAYMS = 86400000;
  const now = Date.now();
  const d = (days) => { const x = new Date(now + days * DAYMS); const p2 = (n) => String(n).padStart(2, "0"); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; };
  const stOf = (o = {}) => ({ epicKey: "EP-1", summary: "Личный кабинет", epicName: "ЛК", statusName: "В работе", statusCategory: "indeterminate", dueDate: d(90), total: 100, done: 40, remaining: 60, estTotal: 0, estDone: 0, carriedOver: 0, p50: d(40), p85: d(50), chance: 0.95, buffer: 5.5, reason: "", historyWeeks: 30, teams: [], ...o });
  await dbm.clearAll();
  const s2 = now - 1000;
  await dbm.putAll(dbm.STORES.epics, [{ key: "EP-1", summary: "Личный кабинет" }, { key: "EP-2", summary: "Биллинг" }]);
  await dbm.putAll(dbm.STORES.issues, ["EP-1", "EP-2"].map((k, i) => ({ ...mk(`S3-${i}`, k, "AAA", "Ivan", 2, 1, "done"), resolved: new Date(now - DAYMS).toISOString() })));
  await dbm.putAll(dbm.STORES.syncLog, [{ ...stOf(), syncId: s2 }, { ...stOf({ epicKey: "EP-2", summary: "Биллинг", epicName: "", chance: 0.3, buffer: -1.5 }), syncId: s2 }]);
  await dbm.metaSet("lastSyncId", s2);
  await dbm.metaSet("seenSyncId", s2);
  await dbm.metaSet("seenSignalIds", []);
  await settings.save({ lastSync: s2, baseUrl: "https://jira.example.local/" });
  check("счётчик на вкладке до просмотра — 1 новый сигнал", (await summaryView.badgeCount()) === 1, String(await summaryView.badgeCount()));

  const box = document.createElement("div");
  document.body.append(box);
  let refreshed = 0;
  const draw = () => summaryView.render(box, { session: { baseSyncId: s2 }, onRefresh: () => { refreshed += 1; } });
  const data = await draw();
  check("после просмотра счётчик — 0", (await summaryView.badgeCount()) === 0);
  const md = summaryView.buildReport(data, { format: "md", baseUrl: settings.get().baseUrl });
  const txt = summaryView.buildReport(data, { format: "text", baseUrl: settings.get().baseUrl });
  check("отчёт Markdown: заголовок, итог по цветам, «Требует внимания» со ссылкой на эпик",
    md.startsWith("**") && md.includes(t("sum.color.red", { n: 1 })) && md.includes("[EP-2 · Биллинг](https://jira.example.local/browse/EP-2)") && md.includes(t("rep.critical")), md);
  check("отчёт текстом: ссылка в скобках, без разметки", !txt.includes("**") && txt.includes("(https://jira.example.local/browse/EP-2)"), txt);

  box.querySelector(".sum-attention .sig .sig-ack").click();
  await new Promise((r) => setTimeout(r, 50));
  check("кнопка «Принято» сохраняет отметку и просит перерисовать", refreshed === 1 && Object.keys((await dbm.metaGet("acks", {})) || {}).length === 1);
  await draw();
  check("принятый сигнал уходит из «Требует внимания», в блоке — приглушён",
    box.querySelectorAll(".sum-attention .sig").length === 0 && box.querySelectorAll("details .sig.acked").length === 1 &&
      !summaryView.buildReport(await summaryView.loadData({ session: { baseSyncId: s2 } }), { format: "text" }).includes(t("rep.critical")));
  box.querySelector("details .sig.acked .sig-ack").click();
  await new Promise((r) => setTimeout(r, 50));
  check("«Вернуть» снимает отметку", Object.keys((await dbm.metaGet("acks", {})) || {}).length === 0);
  box.remove();
  await settings.save({ baseUrl: "https://jira.example.local/" });
  await dbm.clearAll();
}

// Этап 4: одна синхронизация на все вкладки (А4) и автообновление с учётом VPN (Б8)
{
  const at = (dow, hh, mm = 0) => {
    // ближайший день недели dow (1 = пн … 7 = вс) в hh:mm
    const d = new Date(2026, 8, 14, hh, mm); // 14.09.2026 — понедельник
    d.setDate(d.getDate() + (dow - 1));
    return d.getTime();
  };
  const auto = { enabled: true, days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" };
  check("Б8: план — выключено / выходной / до окна / после окна / сегодня уже обновлялись / пора",
    autoSync.planAuto({ auto: { ...auto, enabled: false }, now: at(1, 10) }) === "disabled" &&
      autoSync.planAuto({ auto, now: at(6, 10) }) === "day" &&
      autoSync.planAuto({ auto, now: at(1, 8, 59) }) === "window" &&
      autoSync.planAuto({ auto, now: at(1, 18) }) === "window" &&
      autoSync.planAuto({ auto, now: at(1, 10), lastSync: at(1, 9, 30) }) === "done" &&
      autoSync.planAuto({ auto, now: at(2, 10), lastSync: at(1, 17) }) === "run");
  check("Б8: проба — любой ответ значит «доступна», ошибка сети — нет",
    (await autoSync.probeJira("https://jira.example.local/", { fetchImpl: async () => new Response("", { status: 401 }) })) === true &&
      (await autoSync.probeJira("https://jira.example.local", { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } })) === false);
  const t0 = Date.now();
  const hung = await autoSync.probeJira("https://jira.example.local", { timeoutMs: 50, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("abort")))) });
  check("Б8: проба без ответа (нет VPN) обрывается по таймауту", hung === false && Date.now() - t0 < 1000);
  const day = at(1, 10);
  let st = {};
  const r1 = autoSync.decideNotification({ ok: false, kind: "network", state: st, now: day });
  check("Б8: Jira недоступна — без уведомления, отмечено «недоступна»", !r1.notify && r1.state.lastAttempt === "unreachable");
  const r2 = autoSync.decideNotification({ ok: false, kind: "auth", state: r1.state, now: day });
  const r3 = autoSync.decideNotification({ ok: false, kind: "auth", state: r2.state, now: day + 3600000 });
  const r4 = autoSync.decideNotification({ ok: false, kind: "auth", state: r3.state, now: day + 86400000 });
  check("Б8: «войдите в Jira» — не чаще раза в день", r2.notify && !r3.notify && r4.notify);
  check("Б8: успех — уведомление всегда", autoSync.decideNotification({ ok: true, state: r4.state, now: day }).notify === true);

  // А4: пока замок держит другая вкладка, вторая синхронизация не запускается
  let release;
  const held = new Promise((r) => (release = r));
  const holding = navigator.locks.request(autoSync.SYNC_LOCK, () => held);
  let ran = 0;
  let busyCalled = 0;
  const second = await autoSync.withSyncLock(async () => { ran += 1; return 1; }, { onBusy: () => (busyCalled += 1) });
  check("А4: замок занят — синхронизация не запускается, сообщение «идёт в другой вкладке»", second.busy && ran === 0 && busyCalled === 1);
  release();
  await holding;
  await second.done;
  const third = await autoSync.withSyncLock(async () => { ran += 1; return 7; });
  check("А4: после освобождения замка синхронизация идёт", !third.busy && third.result === 7 && ran === 1);

  // сводка: «Jira была недоступна» — сигнал и строка в шапке
  const unr = summary.computeSignals({ current: new Map(), thresholds: settings.DEFAULTS.summary, unreachableAt: Date.now() });
  check("Б8: сигнал «Jira была недоступна — проверьте VPN»", unr.some((x) => x.type === "unreachable" && x.severity === "warning"));
  const saved = { auto: settings.get().autoSync, lastSync: settings.get().lastSync };
  await dbm.clearAll();
  await dbm.putAll(dbm.STORES.epics, [{ key: "EP-1", summary: "ЛК" }]);
  await dbm.putAll(dbm.STORES.syncLog, [{ epicKey: "EP-1", syncId: 111, total: 1, done: 0, remaining: 1, estTotal: 0, estDone: 0, dueDate: "", teams: [], statusCategory: "indeterminate" }]);
  await dbm.metaSet("lastSyncId", 111);
  await settings.save({ autoSync: { ...auto }, lastSync: Date.now() - 2 * 86400000 });
  chrome.storage.local._d.autoSyncState = { lastAttempt: "unreachable", lastAttemptAt: Date.now() };
  const dataU = await summaryView.loadData({ session: { baseSyncId: null } });
  check("Б8: сводка знает, что сегодня Jira была недоступна", dataU.unreachableAt > 0 && dataU.signals.some((x) => x.type === "unreachable"));
  delete chrome.storage.local._d.autoSyncState;

  // конфигурация: расписание — в экспорте, импорт только корректных полей
  const ex = await exportConfig();
  check("Б8: расписание автообновления — в экспорте", ex.autoSync && ex.autoSync.enabled === true && ex.autoSync.days.length === 5);
  await applyConfig(parseConfig(JSON.stringify({ autoSync: { enabled: false, days: [1, 3, 9, "x"], from: "08:30", to: "25:00" } })), { onLog: () => {} });
  check("Б8: импорт расписания — корректные поля, неверные отброшены",
    settings.get().autoSync.enabled === false && settings.get().autoSync.days.join() === "1,3" && settings.get().autoSync.from === "08:30" && settings.get().autoSync.to === "18:00",
    JSON.stringify(settings.get().autoSync));
  await settings.save({ autoSync: saved.auto, lastSync: saved.lastSync });
  await dbm.clearAll();
}

// Б9. точность прогнозов
{
  const W = 7 * 86400000;
  const finish = "2026-06-10";
  const fin = flowlib.mondayOf(Date.parse(`${finish}T12:00:00`));
  const wk = (weeksBefore) => flowlib.weekKey(fin - weeksBefore * W + 12 * 3600000);
  const recA = [
    { epicKey: "EP-A", week: wk(8), p85: "2026-06-20", statusCategory: "indeterminate", restored: true },
    { epicKey: "EP-A", week: wk(4), p85: "2026-06-01", statusCategory: "indeterminate" },
    { epicKey: "EP-A", week: wk(2), p85: "2026-06-10", statusCategory: "indeterminate" },
    { epicKey: "EP-A", week: wk(0), p85: "", statusCategory: "done", resolved: `${finish}T15:00:00.000+0300`, epicName: "ЛК" }
  ];
  // EP-B: даты завершения эпика нет — берётся дата закрытия последней задачи
  const recB = [
    { epicKey: "EP-B", week: wk(4), p85: "2026-06-30", statusCategory: "indeterminate" },
    { epicKey: "EP-B", week: wk(0), statusCategory: "done", resolved: "" }
  ];
  const recC = [{ epicKey: "EP-C", week: wk(4), p85: "2026-06-01", statusCategory: "indeterminate" }]; // не завершён
  const issB = [{ ...mk("B-1", "EP-B", "AAA", "Ivan", 2, 1, "done"), resolved: "2026-06-12T10:00:00" }, { ...mk("B-2", "EP-B", "AAA", "Ivan", 2, 1, "done"), resolved: "2026-06-05T10:00:00" }];
  const acc = accuracy.forecastAccuracy({ weekly: new Map([["EP-A", recA], ["EP-B", recB], ["EP-C", recC]]), issuesByEpic: new Map([["EP-B", issB]]) });
  const rowA = acc.rows.find((r) => r.epicKey === "EP-A");
  check("Б9: прогнозы за 8/4/2 недели сравниваются с фактом (финиш в день прогноза — попал)",
    rowA.forecasts[8].hit === true && rowA.forecasts[4].hit === false && rowA.forecasts[2].hit === true && rowA.forecasts[8].restored === true);
  check("Б9: без даты завершения эпика финиш — по последней закрытой задаче", acc.rows.find((r) => r.epicKey === "EP-B")?.finish === "2026-06-12T10:00:00");
  check("Б9: незавершённые эпики не участвуют, итог — доля попаданий", !acc.rows.some((r) => r.epicKey === "EP-C") && acc.n === 4 && acc.hits === 3 && acc.share === 75,
    JSON.stringify({ n: acc.n, hits: acc.hits }));
  check("Б9: по горизонтам", acc.byHorizon[4].n === 2 && acc.byHorizon[4].hits === 1 && acc.byHorizon[8].n === 1);
  const copies = (recs, n, from = 0) => Array.from({ length: n }, (_, i) => [`E${i + from}`, recs.map((r) => ({ ...r, epicKey: `E${i + from}` }))]);
  const hitsOnly = recA.filter((r) => r.week !== wk(4)); // за 8 и 2 недели — попадания
  const missOnly = recA.filter((r) => r.week === wk(4) || r.statusCategory === "done"); // за 4 недели — промах
  const okCase = accuracy.forecastAccuracy({ weekly: new Map([...copies(hitsOnly, 3), ...copies(missOnly, 1, 3)]) }); // 6 из 7 ≈ 86%
  const optCase = accuracy.forecastAccuracy({ weekly: new Map(copies(recA, 5)) }); // 10 из 15 ≈ 67%
  const cauCase = accuracy.forecastAccuracy({ weekly: new Map(copies(hitsOnly, 5)) }); // 10 из 10
  check("Б9: меньше 5 сравнений — выводов нет; ≈86% — можно верить; 67% — оптимистичен; 100% — перестраховка",
    acc.verdict === "few" && okCase.verdict === "ok" && optCase.verdict === "optimistic" && cauCase.verdict === "cautious",
    `${okCase.share} ${okCase.verdict} / ${optCase.share} ${optCase.verdict} / ${cauCase.share} ${cauCase.verdict}`);

  // через вкладку: история удалённого из выбора эпика участвует в проверке
  await dbm.clearAll();
  await dbm.putAll(dbm.STORES.epics, [{ key: "EP-X", summary: "Другой" }]);
  await dbm.putAll(dbm.STORES.syncLog, [{ epicKey: "EP-X", syncId: 222, total: 1, done: 0, remaining: 1, estTotal: 0, estDone: 0, dueDate: "", teams: [], statusCategory: "indeterminate" }]);
  await dbm.putAll(dbm.STORES.epicWeeks, recA);
  await dbm.metaSet("lastSyncId", 222);
  const box = document.createElement("div");
  document.body.append(box);
  const data = await summaryView.render(box, { session: { baseSyncId: null } });
  check("Б9: удалённый из выбора эпик остаётся в проверке точности", data.acc.rows.some((r) => r.epicKey === "EP-A") && !data.current.has("EP-A"));
  const accBox = box.querySelector("details.sum-accuracy");
  check("Б9: раздел в «Сводке» свёрнут, в нём таблица с ✓ / ✗", !!accBox && !accBox.open && accBox.querySelectorAll(".acc-table td.acc-hit").length === 2 && accBox.querySelectorAll(".acc-table td.acc-miss").length === 1);
  box.remove();
  await dbm.clearAll();
}

// Б6. графики тренда
{
  const pts = [
    { week: "2026-06-01", p50: "2026-08-01", p85: "2026-08-10", dueDate: "2026-09-01", buffer: 3, total: 10, done: 2, restored: true },
    { week: "2026-06-08", p50: "2026-08-10", p85: "2026-08-25", dueDate: "2026-09-01", buffer: 1, total: 12, done: 3, restored: true, approximate: true },
    { week: "2026-06-15", p50: "2026-08-20", p85: "2026-09-10", dueDate: "2026-09-01", buffer: -1.3, total: 14, done: 5 },
    { week: "2026-06-22", p50: "2026-08-25", p85: "2026-09-15", dueDate: "2026-09-20", buffer: 0.7, total: 15, done: 7 }
  ];
  check("Б6: неделя переноса срока исполнения", [...trendCharts.dueChanges(pts)].join(",") === "2026-06-22");
  check("Б6: неделя, с которой прогноз позже срока", trendCharts.crossingWeek(pts) === "2026-06-15" && trendCharts.crossingWeek(pts.slice(2)) === null);
  check("Б6: цвет эпика устойчив и из палитры", trendCharts.colorFor("EP-1") === trendCharts.colorFor("EP-1") && trendCharts.PALETTE.includes(trendCharts.colorFor("EP-7")));
  const weekly = new Map(Array.from({ length: 10 }, (_, i) => [`E-${i}`, pts]));
  check("Б6: на графике запаса не больше 8 линий", trendCharts.bufferSeries(weekly, [...weekly.keys()], (k) => k).length === 8);

  const host = document.createElement("div");
  document.body.append(host);
  const b = trendCharts.bufferChart(trendCharts.bufferSeries(weekly, ["E-0", "E-1"], (k) => k));
  host.append(b);
  check("Б6.1: линии запаса, выделенный ноль, отметка переноса срока, бледная восстановленная часть",
    b.querySelectorAll("line.tr-line").length === 6 && b.querySelectorAll("line.tr-zero").length === 1 && b.querySelectorAll(".tr-due-mark").length === 2 &&
      b.querySelectorAll("line.tr-line.restored").length === 2 && b.querySelectorAll("line.tr-line.approx").length === 2,
    `${b.querySelectorAll("line.tr-line").length} / ${b.querySelectorAll(".tr-due-mark").length}`);
  check("Б6.1: подсказка на точке — дата, запас и изменение с прошлой точки",
    [...b.querySelectorAll("circle title")].some((x) => /−2,3|-2.3/.test(x.textContent)), [...b.querySelectorAll("circle title")].map((x) => x.textContent)[2]);
  const f = trendCharts.forecastChart(pts);
  host.append(f);
  check("Б6.2: коридор 50–85%, линия 85%, срок ступенькой, отметка пересечения",
    !!f.querySelector("polygon.tr-band") && f.querySelectorAll("line.tr-p85").length === 3 && /H .* V /.test(f.querySelector("path.tr-due").getAttribute("d")) && !!f.querySelector("circle.tr-cross"));
  const bu = trendCharts.burnupChart(pts);
  check("Б6.3: две накопительные линии — всего и готово", bu.querySelectorAll("line.tr-total").length === 3 && bu.querySelectorAll("line.tr-done").length === 3);
  check("Б6: деления оси «круглые» и проходят через ноль",
    trendCharts.niceTicks(-38.4, 3.1).includes(0) && trendCharts.niceTicks(-38.4, 3.1).join(",") === "-30,-20,-10,0" && trendCharts.niceStep(37) === 10 && trendCharts.niceStep(4) === 1,
    trendCharts.niceTicks(-38.4, 3.1).join(","));
  check("Б6: одна недельная запись — графика нет", trendCharts.forecastChart(pts.slice(0, 1)) === null && trendCharts.burnupChart(pts.slice(0, 1)) === null);
  host.remove();
}

// А1. модуль расчётов: одни и те же числа для списка, карточки и сводки
{
  const exc = flowlib.parseTypeList("User Story");
  const iss = [
    mk("C-1", "EP-1", "AAA", "Ivan", 2, 8, "done"),
    mk("C-2", "EP-1", "BBB", "Ivan", 2, 4, "prog"),
    { ...mk("C-3", "EP-1", "AAA", "Ivan", null, 6, "new"), typeName: "User Story", timeSpent: 3600 },
    { ...mk("C-4", "EP-1", "AAA", "Olga", 3, 2, "prog"), timeSpent: 1800 }
  ];
  const c = analytics.epicCounters([{ key: "EP-1", timeSpent: 600 }], iss, { excludeTypes: exc }).get("EP-1");
  check("А1: счётчики эпика без User Story, а списанное на неё время — в сумме",
    c.pct.count === 3 && c.pct.doneCount === 1 && c.spent.total === 3 && c.spent.withLogs === 1 && c.spent.issues === 5400 && c.spent.epic === 600 && c.issueKeys.length === 4,
    JSON.stringify({ count: c.pct.count, done: c.pct.doneCount, spent: c.spent }));
  check("А1: задачи по проектам", c.pct.projects.get("AAA").count === 2 && c.pct.projects.get("BBB").count === 1);

  const DAYMS = 86400000;
  const nowMs = Date.now();
  const rows = [];
  for (let w = 1; w <= 20; w++) {
    const resolved = new Date(nowMs - w * 7 * DAYMS - 2 * DAYMS).toISOString();
    for (let i = 0; i < 10; i++) {
      rows.push({ key: `R-${w}-${i}`, resolved, assigneeKey: "ivan", assigneeLogin: "ivan", assigneeName: "Ivan", epicKey: w <= 6 && i < 4 ? "EP-1" : "EP-9", typeName: "" });
    }
  }
  const tempoRows = [{ id: 1, name: "1C", members: [{ key: "ivan", login: "ivan", name: "Ivan" }] }];
  const flow = analytics.epicFlowState({ epic: { key: "EP-1" }, rows, tempo: tempoRows, issues: iss, excludeTypes: exc, weeks: 30, now: nowMs });
  check("А1: остаток в прогнозе = всего − готово в счётчиках списка", flow.remaining === c.pct.count - c.pct.doneCount, `${flow.remaining}`);
  check("А1: команда потока — из Tempo", flow.teams.length === 1 && flow.teams[0].team.name === "1C", flow.teams.map((x) => x.team.name).join(","));
  const manualFlow = analytics.epicFlowState({ epic: { key: "EP-1" }, rows, tempo: tempoRows, profiles: [{ name: "ivan", login: "ivan", team: "Платформа" }], issues: iss, excludeTypes: exc, weeks: 30, now: nowMs });
  check("А1: ручная команда важнее Tempo и в потоке — как на «По людям»", manualFlow.teams[0].team.name === "Платформа");

  const far = { key: "EP-1", dueDate: ymd(365) };
  const near = { key: "EP-1", dueDate: ymd(1) };
  const localFar = await analytics.epicForecast({ epic: far, flow, seed: "EP-1", runs: 2000, now: nowMs });
  const localNear = await analytics.epicForecast({ epic: near, flow, seed: "EP-1", runs: 2000, now: nowMs });
  check("А1: шанс успеть и запас: далёкий срок — 100% и запас больше нуля", localFar.chance === 1 && localFar.buffer > 0, `${localFar.chance} / ${localFar.buffer}`);
  check("А1: срок завтра — шанс 0% и запас меньше нуля", localNear.chance === 0 && localNear.buffer < 0, `${localNear.chance} / ${localNear.buffer}`);
  check("А1: без срока исполнения шанса и запаса нет", (await analytics.epicForecast({ epic: { key: "EP-1" }, flow, seed: "EP-1", runs: 500, now: nowMs })).chance === null);
  const again = await analytics.epicForecast({ epic: far, flow, seed: "EP-1", runs: 2000, now: nowMs });
  check("А1: с одинаковым зерном прогноз одинаковый", JSON.stringify(again.fc.weeks) === JSON.stringify(localFar.fc.weeks));

  // А3. тот же прогноз в фоновом потоке — на эпике покрупнее, чтобы срок был не в одну неделю
  const bigIssues = Array.from({ length: 40 }, (_, i) => mk(`BIG-${i}`, "EP-1", "AAA", "Ivan", null, 1, "new"));
  const bigFlow = analytics.epicFlowState({ epic: { key: "EP-1" }, rows, tempo: tempoRows, issues: bigIssues, weeks: 30, now: nowMs });
  const bigLocal = await analytics.epicForecast({ epic: far, flow: bigFlow, seed: "EP-1", runs: 2000, now: nowMs });
  const viaWorker = await analytics.epicForecast({ epic: far, flow: bigFlow, seed: "EP-1", runs: 2000, now: nowMs, run: runForecast });
  check("А3: фоновый поток для прогнозов поднимается", workerAvailable());
  check("А3: прогноз в фоновом потоке совпадает с расчётом на странице",
    bigLocal.fc.weeks.p85 > 3 && JSON.stringify(viaWorker.fc.weeks) === JSON.stringify(bigLocal.fc.weeks) &&
      viaWorker.chance === bigLocal.chance && viaWorker.history.weeks === bigLocal.history.weeks,
    `${JSON.stringify(viaWorker.fc && viaWorker.fc.weeks)} / ${JSON.stringify(bigLocal.fc.weeks)}`);
  check("А3: даты прогноза из потока — настоящие даты", viaWorker.fc.dates.p85 instanceof Date);
}

// 4g. умолчания настроек
check("прогноз по умолчанию не считает User Story", settings.DEFAULTS.forecastExcludeTypes === "User Story");
check("окно истории потока по умолчанию — 52 недели", settings.DEFAULTS.flowWeeks === 52, String(settings.DEFAULTS.flowWeeks));

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

renderOpen(document.getElementById("g1"), m1, { mode: "epicPeople", onChildClick: () => {} });
const rowOf = (name) => [...document.querySelectorAll("#g1 .g-row.proj")].find((r) => r.querySelector(".plabel").textContent === name);
renderOpen(document.getElementById("g2"), m2, { mode: "assignee", profiles: peopleProfiles });

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
check("числовых меток нет ни у фамилий, ни у эпиков, ни у досок",
  document.querySelectorAll("#g1 .badges").length === 0 && document.querySelectorAll("#g2 .badges").length === 0,
  `${document.querySelectorAll("#g1 .badges").length} / ${document.querySelectorAll("#g2 .badges").length}`);
check("строка доски — только точка и название", document.querySelector("#g2 .g-row.team .c-name").textContent === document.querySelector("#g2 .g-row.team .tlabel").textContent,
  document.querySelector("#g2 .g-row.team .c-name").textContent);

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
check("подписи легенды короткие", document.querySelector("#g1 .legend-done").textContent === t("gantt.legendDone") && t("gantt.legendDone") === "доля готовых задач" && t("gantt.legendDue") === "срок ◆, план ◇");
check("на «По эпикам» цифры скрыты — жёлтого баллона «осталось» нет", document.querySelectorAll("#g1 .badge.b-left").length === 0);
check("у исполнителей жёлтого баллона нет", document.querySelectorAll("#g2 .badge.b-left").length === 0);
const ivanRow = [...document.querySelectorAll("#g2 .g-row.group")].find((r) => r.querySelector(".glabel").textContent === "Ivan");
const ivanCell0 = ivanRow.querySelectorAll(".c-cell")[0];
const ivanSplit = ivanCell0.querySelector(".bar-split");
check("полоса человека разделена на песочную и серую части, углы скруглены", !!ivanSplit && getComputedStyle(ivanSplit).borderRadius === "8px" && ivanSplit.querySelectorAll(".part").length === 2 &&
  !!ivanSplit.querySelector(".part-target") && !!ivanSplit.querySelector(".part-other"));
check("в частях — только число задач: 2 целевых и 1 прочая; оценки в них нет",
  ivanSplit.querySelector(".part-target").textContent === "2" && ivanSplit.querySelector(".part-other").textContent === "1" && !ivanSplit.querySelector(".part .bar-sum"),
  `${ivanSplit.querySelector(".part-target").textContent} | ${ivanSplit.querySelector(".part-other").textContent}`);
const ivanTotal = ivanCell0.querySelector(".bar-total");
check("общая оценка секции — круглой меткой справа ЗА полосой (1.5д + 1д)",
  ivanTotal?.textContent === "2.5д" && getComputedStyle(ivanTotal).borderRadius === "8px" && getComputedStyle(ivanTotal).borderTopWidth === "0px" && !ivanSplit.contains(ivanTotal) && ivanTotal.previousElementSibling === ivanSplit,
  `${ivanTotal?.textContent} / ${getComputedStyle(ivanTotal).borderRadius}`);
check("метки оценок одной ширины — суммы выровнены по строкам",
  new Set([...document.querySelectorAll("#g2 .bar-total")].map((x) => Math.round(x.getBoundingClientRect().width))).size === 1);
check("в подсказках частей — их оценки, в метке — общая",
  ivanSplit.querySelector(".part-target").title.includes("1.5д") && ivanSplit.querySelector(".part-other").title.includes("1д") && ivanTotal.title.includes("2.5д"),
  ivanTotal.title);
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
check("колонка дерева одинакова на «По эпикам» и «По людям» (456px)",
  Math.round(document.querySelector("#g1 thead .c-name").getBoundingClientRect().width) === 456 &&
    Math.round(document.querySelector("#g2 thead .c-name").getBoundingClientRect().width) === 456,
  `${document.querySelector("#g1 thead .c-name").getBoundingClientRect().width} / ${document.querySelector("#g2 thead .c-name").getBoundingClientRect().width}`);
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
  renderOpen(gO, m2, { mode: "assignee" });
  const rowIvan = [...gO.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent === "Ivan");
  const cells = rowIvan.querySelectorAll(".c-cell");
  check("перегруженная секция обведена красным", cells[0].querySelector(".bar-split")?.classList.contains("overload"), cells[0].querySelector(".bar-split")?.className);
  check("в подсказке — нагрузка и ёмкость", (cells[0].querySelector(".bar-split")?.title || "").includes("2.5д") && cells[0].querySelector(".bar-split").title.includes("1д"), cells[0].querySelector(".bar-split")?.title);
  check("секция в пределах ёмкости не обведена", !cells[1].querySelector(".bar-split")?.classList.contains("overload"));
  check("обводка перегрузки — на полосе, метка оценки вне её", !cells[0].querySelector(".bar-total")?.classList.contains("overload") && !cells[0].querySelector(".bar-split").contains(cells[0].querySelector(".bar-total")));
  await settings.save({ sprintDays: 10 });
  renderOpen(gO, m2, { mode: "assignee" });
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
// Занятость кандидатов по ближайшим спринтам (в окне замены).
const loadFixture = {
  capacity: 8 * H, // 1 день × 8 часов
  byName: new Map([
    ["petr", new Map([["sec:0", 12 * H], ["sec:1", 4 * H]])],
    ["olga", new Map([["sec:0", 2 * H]])]
  ]),
  sections: [
    { id: "sec:0", caption: t("cmp.loadCurrent"), title: "Sprint 2" },
    { id: "sec:1", caption: "+1", title: "Sprint 3" },
    { id: "sec:2", caption: "+2", title: "Sprint 4" }
  ]
};
const si = gantt.standIns(cmpProfiles[0], cmpProfiles);
check("standIns: та же роль, общие системы, без уволенных; по числу общих", si.candidates.map((c) => `${c.profile.displayName}:${c.common.join("+")}`).join(",") === "Olga:Billing+CRM,Petr:CRM",
  si.candidates.map((c) => `${c.profile.displayName}:${c.common.join("+")}`).join(","));
check("standIns: системы без замены — Mobile", si.uncovered.join(",") === "Mobile", si.uncovered.join(","));
check("standIns: без роли/систем — пусто", gantt.standIns({ name: "x", role: "", systems: ["CRM"] }, cmpProfiles).candidates.length === 0);

const g4 = document.createElement("div");
document.body.append(g4);
renderOpen(g4, m2, { mode: "assignee", profiles: cmpProfiles, personLoad: loadFixture });
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
// занятость: у Olga 2ч из 8ч = 25%, у Petr 12ч из 8ч = 150% (перегруз), третья секция пустая
const loadOf = (name) => [...rowsCmp].find((r) => r.querySelector(".cmp-name").textContent === name)?.querySelectorAll(".load-chip");
check("у каждого кандидата — занятость по трём ближайшим спринтам", loadOf("Olga")?.length === 3 && loadOf("Petr")?.length === 3);
check("проценты считаются от ёмкости спринта", [...loadOf("Olga")].map((c) => c.textContent).join(",") === "25%,0%,0%", [...loadOf("Olga")].map((c) => c.textContent).join(","));
check("перегрузка выделена", [...loadOf("Petr")].map((c) => c.textContent).join(",") === "150%,50%,0%" && loadOf("Petr")[0].classList.contains("over"),
  [...loadOf("Petr")].map((c) => `${c.textContent}${c.classList.contains("over") ? "!" : ""}`).join(","));
check("в подсказке чипа — спринт, часы и ёмкость", loadOf("Petr")[0].title.includes("Sprint 2") && loadOf("Petr")[0].title.includes("150"), loadOf("Petr")[0].title);
check("в заголовке блока перечислены секции", cmpTip.textContent.includes(t("cmp.load")) && cmpTip.textContent.includes("+1"));
check("системы без замены: Mobile", [...cmpTip.querySelectorAll(".cmp-uncovered .chip")].map((c) => c.textContent).join(",") === "Mobile");
cmpTip.querySelector(".tip-close").click();
cmpBtnOf("Petr").click();
check("у Petr без замены — Web (Kim той же роли, но Web общий) → все покрыты? нет: Kim имеет Web",
  [...document.querySelectorAll(".tooltip.tip-compare .cmp-table .cmp-name")].map((n) => n.textContent).join(",") === "Ivan,Kim,Olga" && document.querySelector(".tooltip.tip-compare .cmp-uncovered").textContent.includes(t("cmp.allCovered")),
  [...document.querySelectorAll(".tooltip.tip-compare .cmp-table .cmp-name")].map((n) => n.textContent).join(","));
document.querySelector(".tip-close").click();
// на «По эпикам и людям» — тоже
renderOpen(g3, m3, { mode: "epicPeople", profiles: cmpProfiles, onChildClick: () => {} });
check("пиктограмма ⇄ у людей внутри эпиков", g3.querySelectorAll(".g-row.proj .cmp-btn").length > 0);
g3.querySelector(".g-row.proj .cmp-btn").click();
check("окно сравнения открывается и на «По эпикам и людям»", !!document.querySelector(".tooltip.tip-compare"));
document.querySelector(".tip-close").click();
g4.remove();

// 9b. критический путь на «По эпикам и людям»
{
  renderOpen(g3, m3, { mode: "epicPeople", onChildClick: () => {} });
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

// 9c. позиционирование всплывающих окон (размеры окна подменяем: панель может быть скрыта)
{
  const realW = window.innerWidth;
  const realH = window.innerHeight;
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  const anchor = document.createElement("button");
  Object.assign(anchor.style, { position: "fixed", left: "40px", top: "760px", width: "20px", height: "20px" });
  document.body.append(anchor);
  const box = document.createElement("div");
  box.className = "tooltip";
  Object.assign(box.style, { width: "300px", height: "260px", maxHeight: "none" });
  document.body.append(box);

  gantt.placePopover(box, anchor);
  let top = parseFloat(box.style.top);
  check("окно у нижнего края экрана не уезжает за границу", top >= 8 && top + 260 <= 800, `${top} + 260`);
  box.style.height = "420px";
  gantt.placePopover(box, anchor);
  top = parseFloat(box.style.top);
  check("после роста содержимого окно всё ещё в экране", top >= 8 && top + 420 <= 800, `${top} + 420`);
  anchor.style.top = "10px";
  gantt.placePopover(box, anchor);
  check("у верхнего края окно открывается вниз", parseFloat(box.style.top) >= 30, box.style.top);
  check("окно не выходит за правый край", parseFloat(box.style.left) + 300 <= 1200);

  box.remove();
  anchor.remove();
  Object.defineProperty(window, "innerWidth", { value: realW, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: realH, configurable: true });
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
renderOpen(g3, m3, { mode: "epicPeople", onChildClick: () => {} });
check("пиктограмма 💬 есть и на «По эпикам и людям»", g3.querySelectorAll(".g-row.group .cmt-btn").length === m3.groups.length);

// Р7. Веха завершения: срок исполнения, а если его нет — плановое завершение.
{
  const msDue = agg.epicMilestone({ key: "E", dueDate: ymd(5), plannedEnd: ymd(20) });
  const msPlan = agg.epicMilestone({ key: "E", dueDate: "", plannedEnd: ymd(8) });
  check("Р7: срок исполнения важнее планового завершения", msDue.kind === "due" && msDue.date === ymd(5));
  check("Р7: без срока — веха по плановому завершению", msPlan.kind === "planned" && msPlan.date === ymd(8));
  check("Р7: без обеих дат вехи нет", agg.epicMilestone({ key: "E" }) === null && agg.epicMilestone(null) === null);

  const pe = [
    { key: "EP-1", summary: "Только плановое", statusName: "В работе", statusCategory: "indeterminate", dueDate: "", plannedEnd: ymd(5) },
    { key: "EP-2", summary: "Обе даты", statusName: "В работе", statusCategory: "indeterminate", dueDate: ymd(5), plannedEnd: ymd(8) },
    { key: "EP-3", summary: "Без дат", statusName: "В работе", statusCategory: "indeterminate", dueDate: "", plannedEnd: "" }
  ];
  const pm = agg.buildModel({ issues, others: [], sprints, epics: pe, boards, mode: "epicPeople" });
  const gOf = (k) => pm.groups.find((g) => g.key === k);
  const i1 = gantt.dueInfo(gOf("EP-1"), pm);
  const i2 = gantt.dueInfo(gOf("EP-2"), pm);
  check("Р7: плановая веха — значок ◇, подсказка «Плановое завершение», класс due-planned",
    i1 && i1.kind === "planned" && i1.label.startsWith("◇") && i1.cls.includes("due-planned") && i1.cls.includes("due-red") && i1.title.startsWith(t("gantt.plannedIn", { date: "", n: 5 }).split(" ")[0]),
    JSON.stringify(i1));
  check("Р7: обе даты — веха по сроку (◆), в подсказке и плановое завершение",
    i2 && i2.kind === "due" && i2.label.startsWith("◆") && !i2.cls.includes("due-planned") && i2.title.includes(t("gantt.alsoPlanned", { date: "" }).trim()),
    JSON.stringify(i2));
  check("Р7: у эпика без дат вехи нет", gantt.dueInfo(gOf("EP-3"), pm) === null);
  const one = agg.buildModel({ issues, others: [], sprints, epics: [{ ...pe[1], plannedEnd: ymd(5) }], boards, mode: "epicPeople" }).groups.find((g) => g.key === "EP-2");
  check("Р7: даты совпадают — плановое завершение в подсказке не дублируется", !gantt.dueInfo(one, pm).title.includes(t("gantt.alsoPlanned", { date: "" }).trim()));
  const gp = document.createElement("div");
  document.body.append(gp);
  renderOpen(gp, pm, { mode: "epicPeople" });
  const rowP = [...gp.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith("EP-1"));
  check("Р7: на «По эпикам» флажок ◇ у строки эпика и линия через вложенные строки",
    /◇ \d{2}\.\d{2}/.test(rowP.querySelector(".due-flag")?.textContent || "") && rowP.nextElementSibling?.querySelector(".due-line.due-planned") != null);
  // ⚡: «не укладывается» считается до той же вехи — у EP-1 только плановое завершение через 5 дн.
  const crit = gantt.criticalPeople(gOf("EP-1"), pm);
  check("Р7: критический путь считает ёмкость до плановой вехи", [...crit.values()].flat().some((r) => r.includes(t("crit.overCapacity", { rem: "", cap: "", due: "" }).split(":")[0])), JSON.stringify([...crit]));
  check("Р7: прогноз и «Сводка» считают только от срока исполнения — у эпика с одним плановым завершением срока нет",
    Number.isNaN(analytics.dueMsOf({ key: "EP-1", dueDate: "", plannedEnd: ymd(5) })));
  gp.remove();
}

// Р8. Ручной порядок эпиков на «По эпикам».
{
  const all = ["A", "B", "C", "D", "H"];
  const auto = ["A", "B", "C", "D"]; // H скрыт — в модели его нет
  check("Р8: без сохранённого порядка — автоматический, скрытые в конце", agg.effectiveEpicOrder(null, auto, all).join() === "A,B,C,D,H");
  check("Р8: новые эпики — в конец, между собой в автоматическом порядке; убранные выпадают",
    agg.effectiveEpicOrder(["C", "X", "A"], ["A", "B", "C", "D"], ["A", "B", "C", "D"]).join() === "C,A,B,D");
  check("Р8: перенос в начало и после эпика", agg.moveEpic(["A", "B", "C"], "C", null).join() === "C,A,B" && agg.moveEpic(["A", "B", "C"], "A", "B").join() === "B,A,C");
  // Между видимыми B и C скрыт H: брошенный после B эпик встаёт перед H, H остаётся на месте.
  check("Р8: бросок между видимыми при скрытом между ними — сразу после видимого, скрытый на своём месте",
    agg.moveEpic(["A", "B", "H", "C", "D"], "D", "B").join() === "A,B,D,H,C");
  check("Р8: неизвестный afterKey — порядок не меняется", agg.moveEpic(["A", "B"], "A", "Z").join() === "A,B");
  const grp = (k) => ({ key: k });
  check("Р8: группы переставляются по порядку, группы вне порядка — в конце",
    agg.applyEpicOrder([grp("A"), grp("B"), grp("C"), grp("Q")], ["C", "A", "B"]).map((g) => g.key).join() === "C,A,B,Q");

  // Отрисовка: ручка, номера, клавиатура, перетаскивание.
  const om = agg.buildModel({ issues, others: [], sprints, epics, boards, mode: "epicPeople" });
  const autoKeys = om.groups.map((g) => g.key);
  om.groups = agg.applyEpicOrder(om.groups, [autoKeys[2], autoKeys[0], autoKeys[1], ...autoKeys.slice(3)]);
  const calls = [];
  const go = document.createElement("div");
  document.body.append(go);
  gantt.setCollapsed("epicPeople", []);
  gantt.render(go, om, { mode: "epicPeople", onReorder: (k, a) => calls.push([k, a]) });
  const grows = () => [...go.querySelectorAll(".g-row.group")];
  const handleOf = (k) => [...go.querySelectorAll(".drag-handle")].find((h) => h.dataset.key === k);
  check("Р8: у каждого эпика ручка ⋮⋮ слева от номера", grows().every((r) => r.querySelector(".c-name").firstElementChild.classList.contains("drag-handle") && r.querySelector(".drag-handle + .gnum")));
  check("Р8: номера идут по новому порядку", grows()[0].querySelector(".glabel").textContent.startsWith(autoKeys[2]) && grows()[0].querySelector(".gnum").textContent === "1.");
  const order = om.groups.map((g) => g.key);
  handleOf(order[2]).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
  handleOf(order[0]).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
  handleOf(order[1]).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));
  handleOf(order[0]).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }));
  handleOf(order[0]).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  check("Р8: Alt+↑ — после эпика на две позиции выше, со второго места — в начало, с первого — ничего; Alt+↓ — после следующего; без Alt — ничего",
    JSON.stringify(calls) === JSON.stringify([[order[2], order[0]], [order[1], null], [order[0], order[1]]]), JSON.stringify(calls));
  calls.length = 0;
  // Перетаскивание: тащим последний эпик и бросаем в верхнюю половину блока первого.
  const dt = new DataTransfer();
  const last = order[order.length - 1];
  handleOf(last).dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
  const r0 = grows()[0].getBoundingClientRect();
  grows()[0].dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: r0.top + 1, dataTransfer: dt }));
  check("Р8: при перетаскивании видна линия-указатель над первым эпиком", grows()[0].classList.contains("drop-before"));
  grows()[0].dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: r0.top + 1, dataTransfer: dt }));
  check("Р8: бросок над первым эпиком — в начало", JSON.stringify(calls) === JSON.stringify([[last, null]]) && !go.querySelector(".drop-before, .drop-after"), JSON.stringify(calls));
  calls.length = 0;
  // Бросок на вложенную строку исполнителя: блок эпика — строка эпика и его исполнители; нижняя часть — после эпика.
  handleOf(order[0]).dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
  const child = [...go.querySelectorAll(".g-row.proj")].filter((r) => r.dataset.gkey === order[1]).at(-1);
  const rc = child.getBoundingClientRect();
  child.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: rc.bottom - 1, dataTransfer: dt }));
  child.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: rc.bottom - 1, dataTransfer: dt }));
  check("Р8: бросок на исполнителя эпика — после эпика целиком, не внутрь", JSON.stringify(calls) === JSON.stringify([[order[0], order[1]]]), JSON.stringify(calls));
  calls.length = 0;
  handleOf(order[1]).dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
  grows()[1].dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientY: grows()[1].getBoundingClientRect().top + 1, dataTransfer: dt }));
  grows()[1].dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientY: grows()[1].getBoundingClientRect().top + 1, dataTransfer: dt }));
  check("Р8: бросок на своё же место порядок не трогает", calls.length === 0, JSON.stringify(calls));
  handleOf(order[1]).dispatchEvent(new DragEvent("dragend", { bubbles: true }));
  gantt.render(go, om, { mode: "epicPeople" });
  check("Р8: без обработчика порядка (и на «По людям») ручек нет", !go.querySelector(".drag-handle") && !document.querySelector("#g2 .drag-handle"));
  go.remove();

  // Хранение: эпик, убранный из выбора, выпадает из порядка; экспорт и импорт конфигурации.
  const syncMod = await import("../src/js/sync.js");
  const keepEpics = await dbm.all(dbm.STORES.epics);
  await dbm.putAll(dbm.STORES.epics, [{ key: "ORD-1" }, { key: "ORD-2" }, { key: "ORD-3" }]);
  await dbm.metaSet(syncMod.EPIC_ORDER_KEY, ["ORD-3", "ORD-1", "ORD-2"]);
  await syncMod.saveSelection([...keepEpics, { key: "ORD-3" }, { key: "ORD-2" }]);
  check("Р8: эпик, убранный из выбора, выпадает из порядка", (await dbm.metaGet(syncMod.EPIC_ORDER_KEY)).join() === "ORD-3,ORD-2", JSON.stringify(await dbm.metaGet(syncMod.EPIC_ORDER_KEY)));
  check("Р8: порядок попадает в экспорт конфигурации", (await exportConfig()).epicOrder.join() === "ORD-3,ORD-2");
  check("Р8: импорт читает epicOrder (ключи в верхнем регистре, без дублей)", parseConfig(JSON.stringify({ epicOrder: [" ord-2", "ORD-3", "ord-2"] })).epicOrder.join() === "ORD-2,ORD-3");
  await applyConfig(parseConfig(JSON.stringify({ epicOrder: ["ORD-2", "ORD-9", "ORD-3"] })), { onLog: () => {} });
  check("Р8: импорт сохраняет порядок, эпики вне выбора отбрасываются", (await dbm.metaGet(syncMod.EPIC_ORDER_KEY)).join() === "ORD-2,ORD-3", JSON.stringify(await dbm.metaGet(syncMod.EPIC_ORDER_KEY)));
  await dbm.metaSet(syncMod.EPIC_ORDER_KEY, null);
  await syncMod.saveSelection(keepEpics);
}

// Р9. Истории не считаются на «По эпикам» и в загрузке людей.
{
  const ex = flowlib.excludedTypes({ forecastExcludeTypes: "User Story, user story;Epic Task" });
  check("Р9: исключённые типы — один набор, без учёта регистра; для JQL — написание из настроек без дублей",
    ex.join("|") === "user story|epic task" && flowlib.excludedTypeNames({ forecastExcludeTypes: "User Story, user story;Epic Task" }).join("|") === "User Story|Epic Task");
  const story = { ...mk("S-1", "EP-1", "AAA", "Story Owner", 2, 16, "new"), typeName: "User Story" };
  const storyOff = { ...mk("S-2", "EP-1", "AAA", "Story Owner", null, 8, "prog"), typeName: "User Story" };
  const withStories = [...issues, story, storyOff];
  const opt = { others: [], sprints, epics, boards, mode: "epicPeople", excludeTypes: ["user story"], excludeTypeNames: ["User Story"] };
  const base = agg.buildModel({ issues, ...opt }).groups.find((g) => g.key === "EP-1");
  const m9 = agg.buildModel({ issues: withStories, ...opt });
  const g9 = m9.groups.find((g) => g.key === "EP-1");
  check("Р9: итог эпика на «По эпикам» без историй — как без них вовсе", g9.count === base.count && g9.sum === base.sum && g9.other === base.other, `${g9.count}/${base.count}`);
  check("Р9: исполнитель, у которого в эпике только истории, строкой не выводится", !g9.projects.some((p) => p.label === "Story Owner"));
  check("Р9: история вне спринта в работе не попадает в текущую секцию",
    ![...g9.cells.values()].some((c) => c.issues.some((i) => i.key.startsWith("S-"))) && !g9.backlog.issues.some((i) => i.key.startsWith("S-")));
  const gAll = agg.buildModel({ issues: withStories, others: [], sprints, epics, boards, mode: "epicPeople" }).groups.find((g) => g.key === "EP-1");
  check("Р9: без списка исключений истории считались бы (проверка, что фильтр действительно работает)", gAll.count === base.count + 2);
  const mPeople = agg.buildModel({ issues: withStories, others: [], sprints, epics, boards, mode: "assignee", excludeTypes: ["user story"] });
  check("Р9: «По людям» по-прежнему показывает истории", mPeople.groups.some((g) => g.label === "Story Owner"));
  // Критический путь считается по тем же задачам — без историй.
  check("Р9: ⚡ критический путь не видит историй", !gantt.criticalPeople(g9, m9).has("story owner"));
  // Загрузка людей.
  const loadAll = agg.personLoad(m9, withStories, []);
  const loadEx = agg.personLoad(m9, withStories, [], ["user story"]);
  check("Р9: загрузка людей без историй", (loadAll.byName.get("story owner")?.size || 0) > 0 && !loadEx.byName.has("story owner"));
  // JQL подсказки эпика отсекает истории — число совпадает с выборкой в Jira.
  const g9box = document.createElement("div");
  document.body.append(g9box);
  renderOpen(g9box, m9, { mode: "epicPeople" });
  [...g9box.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith("EP-1")).querySelector(".glabel").click();
  const tipLinks = [...document.querySelectorAll(".tooltip .tip-rows a")].map((a) => decodeURIComponent(a.href));
  check("Р9: ссылки подсказки эпика — с issuetype not in (\"User Story\")", tipLinks.length > 0 && tipLinks.every((h) => h.includes('issuetype not in ("User Story")')), tipLinks[0]);
  document.querySelector(".tooltip .tip-close")?.click();
  g9box.remove();
}

// Р1. Ракурсы диаграммы — пиктограммы одной группой.
{
  const { DICT } = await import("../src/js/dict.js");
  const html = await (await fetch("../src/app.html", { cache: "no-store" })).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const group = doc.querySelector(".tabs .view-group");
  const views = group ? [...group.querySelectorAll(".tab")] : [];
  check("Р1: три ракурса в одной группе — «По эпикам», «По людям», «Эпик — история»",
    views.map((b) => b.dataset.tab).join() === "epicPeople,people,epicStories", views.map((b) => b.dataset.tab).join());
  check("Р1: у ракурсов пиктограммы, подпись — в подсказке и aria-label, на обоих языках",
    views.every((b) => b.classList.contains("tab-icon") && b.querySelector("svg") && !b.dataset.i18n && b.dataset.i18nTitle && b.dataset.i18nAria === b.dataset.i18nTitle &&
      DICT.ru[b.dataset.i18nTitle] && DICT.en[b.dataset.i18nTitle]));
  check("Р1: пиктограммы одного стиля с остальными (контур 24×24, линия 2)",
    [...doc.querySelectorAll(".tabs .tab-icon svg")].every((v) => v.getAttribute("viewBox") === "0 0 24 24" && v.getAttribute("stroke-width") === "2" && v.getAttribute("fill") === "none"));
  check("Р1: «Команда» — пиктограммой, вне группы ракурсов, подпись в подсказке", !!doc.querySelector('.tabs > .tab.tab-icon[data-tab="team"][data-i18n-title="tab.team"] svg') && !group.querySelector('[data-tab="team"]'));
  check("Р1: «Эпик — история» показан и ведёт на свою страницу", !views[2]?.hasAttribute("hidden") && !!doc.querySelector("#page-epicStories"));
  check("Р1: у группы есть подпись для экранного диктора", group?.dataset.i18nAria === "tab.views" && DICT.en["tab.views"]);
}

// Р2, Р6. Данные: приоритеты, связи, комментарии; пиктограммы приоритетов.
{
  const omgMod = await import("../src/js/omg.js");
  const prio = await import("../src/js/priority.js");
  const syncMod = await import("../src/js/sync.js");
  const cm = (id, created, body, author = "Иван") => ({ id: String(id), created, body, author: { displayName: author } });
  // Разбор меток проекта (Р3): последняя по дате создания, пустая — «Без проекта», регистр и пробелы.
  const p1 = omgMod.parseComments([
    cm(2, "2026-09-10T10:00:00.000+0300", "(omg project) Новый сайт"),
    cm(1, "2026-09-01T10:00:00.000+0300", "(omg project) Старый сайт"),
    cm(3, "2026-09-11T10:00:00.000+0300", "просто комментарий (omg project) не в начале")
  ]);
  check("Р3: действует последняя по дате метка проекта, текст не в начале — не метка", p1.project?.name === "Новый сайт", JSON.stringify(p1));
  check("Р3: последняя метка с пустым названием — «Без проекта»",
    omgMod.parseComments([cm(1, "2026-09-01T10:00:00Z", "(omg project) Сайт"), cm(2, "2026-09-02T10:00:00Z", "  (OMG Project)  \nлишнее")]).project === null);
  check("Р3: кодовое слово без учёта регистра и с пробелами в начале; название — первая строка без пробелов по краям",
    omgMod.parseComments([cm(1, "2026-09-01T10:00:00Z", "  (OMG  Project)   ПРОЕКТ  \nвторая строка")]).project?.name === "ПРОЕКТ");
  check("Р3: «Проект» и «ПРОЕКТ » — один проект", omgMod.projectKey("Проект") === omgMod.projectKey(" ПРОЕКТ  ") && omgMod.projectKey("Мой  проект") === "мой проект");
  check("Р3: квадратные скобки — не кодовое слово", omgMod.parseComments([cm(1, "2026-09-01T10:00:00Z", "[omg project] Сайт")]).project === null);
  const n1 = omgMod.parseComments([
    cm(5, "2026-09-05T10:00:00Z", "(omg comment)\nВторая заметка\nстрока 2", "Пётр"),
    cm(4, "2026-09-04T10:00:00Z", "(omg comment) Первая"),
    cm(6, "2026-09-06T10:00:00Z", "обычный комментарий")
  ]);
  check("Р4: заметки по дате, последняя — действующая, текст без кодового слова, обычные комментарии не попадают",
    n1.notes.length === 2 && n1.notes[0].text === "Первая" && n1.notes[1].text === "Вторая заметка\nстрока 2" && n1.notes[1].author === "Пётр", JSON.stringify(n1.notes));
  check("Р3/Р4: текст публикуемых комментариев", omgMod.projectComment(" Сайт ") === "(omg project) Сайт" && omgMod.projectComment("") === "(omg project)" && omgMod.noteComment(" Текст ") === "(omg comment)\nТекст");

  // Приоритеты (Р6).
  const order = [{ id: "1", name: "Highest" }, { id: "2", name: "High" }, { id: "3", name: "Medium" }, { id: "4", name: "Low" }, { id: "5", name: "Lowest" }];
  const P = (id) => order.find((x) => x.id === id);
  check("Р6: порядок из Jira, без приоритета — ниже самого низкого",
    prio.rankOf(P("1"), order) === 0 && prio.rankOf(P("5"), order) === 4 && prio.rankOf(null, order) === 5 && prio.compare(P("2"), P("4"), order) < 0 && prio.compare(null, P("5"), order) > 0);
  check("Р6: самый высокий из списка", prio.highest([P("4"), null, P("2"), P("3")], order)?.id === "2" && prio.highest([null], order) === null);
  check("Р6: запасной кружок — от красного к серому", prio.fallbackColor(P("1"), order) === "#de350b" && prio.fallbackColor(P("5"), order) === "#a5adba" && prio.fallbackColor(null, order) === "#a5adba");
  const bad = prio.icon({ id: "2", name: "High", iconUrl: "/no-such-icon.svg" }, order, t);
  const holder = document.createElement("div");
  holder.append(bad);
  document.body.append(holder);
  await new Promise((r) => setTimeout(r, 400));
  const dot = holder.querySelector(".prio-dot");
  check("Р6: пиктограмма не загрузилась — цветной кружок с названием в подсказке", !!dot && dot.title === "High" && !holder.querySelector("img"), holder.innerHTML);
  holder.remove();
  const good = prio.icon({ id: "1", name: "Highest", iconUrl: "https://jira.example.local/images/icons/priorities/highest.svg" }, order, t);
  check("Р6: пиктограмма из Jira — картинка с названием в подсказке", good.tagName === "IMG" && good.title === "Highest" && good.src.endsWith("highest.svg"));
  check("Р6: без приоритета — серый кружок «Приоритет не задан»", prio.icon(null, order, t).title === t("prio.none"));

  // Типы историй всегда вне подсчётов (Р2).
  check("Р2: типы историй входят в исключённые, даже если их нет в «Типах задач, не учитываемых в подсчётах»",
    flowlib.excludedTypes({ forecastExcludeTypes: "Sub-task", storyTypes: "Story, User Story" }).join("|") === "sub-task|story|user story" &&
      flowlib.excludedTypeNames({ forecastExcludeTypes: "User Story", storyTypes: "user story, Story" }).join("|") === "User Story|Story");

  // Связи (Р2).
  const links = syncMod.linksOf([
    { type: { name: "Relates" }, outwardIssue: { key: "T-1", fields: { issuetype: { name: "Task" } } } },
    { type: { name: "Blocks" }, inwardIssue: { key: "T-2", fields: { issuetype: { name: "Bug" } } } },
    { type: { name: "Relates" } }
  ]);
  check("Р2: связи — тип, подпись, ключ и тип задачи на том конце, в любую сторону", JSON.stringify(links) === JSON.stringify([{ type: "Relates", desc: "", key: "T-1", typeName: "Task" }, { type: "Blocks", desc: "", key: "T-2", typeName: "Bug" }]), JSON.stringify(links));
  const storyIs = (i) => flowlib.isExcludedType(i.typeName, ["user story"]);
  const iss = new Map([
    ["US-1", { key: "US-1", typeName: "User Story", links: [
      { type: "Relates", key: "T-1", typeName: "Task" }, { type: "relates", key: "X-9", typeName: "Task" }, { type: "Blocks", key: "X-8", typeName: "Task" },
      { type: "Relates", key: "EP-Q", typeName: "Epic" }, { type: "Relates", key: "US-7", typeName: "User Story" }, { type: "Relates", key: "EP-S", typeName: "" }] }],
    ["T-1", { key: "T-1", typeName: "Task", links: [{ type: "Relates", key: "X-5", typeName: "Task" }] }]
  ]);
  check("Р2: догружаются только чужие задачи историй по связи из настроек; эпики, истории и связи задач не в счёт",
    syncMod.linkedKeysToLoad({ issues: iss, isStory: storyIs, linkType: "Relates", epicKeys: ["EP-S"] }).join() === "X-9");

  // Синхронизация с заглушкой Jira: приоритеты, связи, комментарии, чужие задачи, порядок приоритетов.
  const orig = window.fetch;
  const saved = { fields: { ...settings.get().fields }, useTempoTeams: settings.get().useTempoTeams };
  await settings.save({ fields: { ...saved.fields, epicLink: "customfield_10100", sprint: "customfield_10101", version: 5 }, useTempoTeams: false, storyTypes: "User Story", storyLinkType: "Relates" });
  await dbm.clearAll();
  await dbm.putAll(dbm.STORES.epics, [{ key: "EP-S", summary: "Эпик С" }]);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
  const stt = { name: "В работе", statusCategory: { key: "indeterminate" } };
  const who = { name: "ivan", key: "ivan", displayName: "Ivan" };
  const hi = { id: "2", name: "High", iconUrl: "https://jira.example.local/high.svg" };
  const lnk = (key, typeName, name = "Relates") => ({ type: { name }, outwardIssue: { key, fields: { issuetype: { name: typeName } } } });
  const issue = (key, type, links = [], epic = "EP-S") => ({ key, fields: { summary: key, project: { key: "AAA" }, assignee: who, status: stt, issuetype: { name: type }, priority: hi, issuelinks: links, updated: new Date().toISOString(), created: new Date().toISOString(), customfield_10100: epic, timeoriginalestimate: 3600 } });
  const epicUpdated = "2026-09-17T10:00:00.000+0300";
  const commentReq = [];
  window.fetch = async (url, opt = {}) => {
    const u = String(url);
    const b = opt.body ? JSON.parse(opt.body) : {};
    if (u.includes("/rest/api/2/myself")) return json({ name: "ivan" });
    if (u.includes("/rest/api/2/priority")) return json([{ id: "1", name: "Highest", iconUrl: "h.svg" }, hi, { id: "3", name: "Medium", iconUrl: "m.svg" }]);
    if (u.includes("/rest/api/2/issue/US-1/comment")) return json({ comments: [cm(1, "2026-09-01T10:00:00Z", "(omg comment) Старая"), cm(2, "2026-09-02T10:00:00Z", "(omg comment) Свежая заметка")], total: 2 });
    if (u.includes("/rest/agile/1.0/board")) return json({ values: [], isLast: true });
    if (u.includes("/rest/api/2/search")) {
      const jql = b.jql || "";
      if ((b.fields || []).includes("comment")) {
        commentReq.push(jql);
        const rows = [];
        if (jql.includes("EP-S")) rows.push({ key: "EP-S", fields: { comment: { total: 2, comments: [cm(1, "2026-09-01T10:00:00Z", "(omg project) Сайт"), cm(2, "2026-09-03T10:00:00Z", "(omg comment) Заметка эпика")] } } });
        if (jql.includes("US-1")) rows.push({ key: "US-1", fields: { comment: { total: 2, comments: [cm(1, "2026-09-01T10:00:00Z", "(omg comment) Старая")] } } });
        return json({ issues: rows, total: rows.length });
      }
      if (jql.includes("resolutiondate >=")) return json({ issues: [], total: 0 });
      if (jql.includes("key in (EP-S)")) return json({ issues: [{ key: "EP-S", fields: { summary: "Эпик С", status: stt, project: { key: "AAA" }, priority: hi, updated: epicUpdated } }], total: 1 });
      if (jql.includes("in (EP-S)")) return json({ issues: [issue("US-1", "User Story", [lnk("T-1", "Task"), lnk("X-9", "Task"), lnk("EP-Q", "Epic"), lnk("X-8", "Task", "Blocks")]), issue("T-1", "Task", [lnk("US-1", "User Story")])], total: 2 });
      if (jql.includes("key in (X-9)")) return json({ issues: [issue("X-9", "Task", [], "EP-Z")], total: 1 });
      return json({ issues: [], total: 0 });
    }
    return json({}, 404);
  };
  let res = null;
  let err = null;
  try { res = await runSync({ full: true }); } catch (e) { err = e; }
  const us = await dbm.getOne(dbm.STORES.issues, "US-1");
  const t1 = await dbm.getOne(dbm.STORES.issues, "T-1");
  const ep = await dbm.getOne(dbm.STORES.epics, "EP-S");
  check("Р2: синхронизация прошла, ошибок комментариев и чужих задач нет", !err && res && !res.commentsError && !res.linkedError, err ? err.message : JSON.stringify(res && { c: res.commentsError, l: res.linkedError }));
  check("Р2: у задач приоритет и связи", t1?.priority?.name === "High" && t1.links.length === 1 && us?.links.length === 4);
  check("Р2: у эпика приоритет, время изменения и метка проекта", ep?.priority?.id === "2" && ep.updated === epicUpdated && ep.omg?.project?.name === "Сайт" && ep.omg.notes[0]?.text === "Заметка эпика", JSON.stringify(ep && ep.omg));
  check("Р2: у истории заметки; не все комментарии в поиске — догружены поштучно", us?.omg?.notes.length === 2 && us.omg.notes[1].text === "Свежая заметка", JSON.stringify(us && us.omg));
  check("Р2: комментарии обычных задач не запрашиваются", !commentReq.some((j) => j.includes("T-1")));
  const linkedRows = await dbm.all(dbm.STORES.linked);
  check("Р2: чужая задача истории загружена отдельно; эпик на том конце и связь другого типа — нет", linkedRows.map((r) => r.key).join() === "X-9" && linkedRows[0].epicKey === "EP-Z", linkedRows.map((r) => r.key).join());
  check("Р2: порядок приоритетов сохранён", (await dbm.metaGet("priorities"))?.map((p) => p.name).join() === "Highest,High,Medium");
  commentReq.length = 0;
  try { res = await runSync({ full: false }); } catch (e) { err = e; }
  const ep2 = await dbm.getOne(dbm.STORES.epics, "EP-S");
  check("Р2: «Обновить» — комментарии неизменившегося эпика не перечитываются, разбор сохраняется",
    !err && !commentReq.some((j) => j.includes("EP-S")) && ep2?.omg?.project?.name === "Сайт", JSON.stringify(commentReq));
  // Сбой запроса комментариев: разбор истории не теряется, об ошибке — отдельной строкой.
  const okFetch = window.fetch;
  window.fetch = async (url, opt = {}) => {
    const b = opt.body ? JSON.parse(opt.body) : {};
    if (String(url).includes("/rest/api/2/search") && (b.fields || []).includes("comment")) return json({ errorMessages: ["boom"] }, 500);
    return okFetch(url, opt);
  };
  try { res = await runSync({ full: false }); } catch (e) { err = e; }
  const us3 = await dbm.getOne(dbm.STORES.issues, "US-1");
  check("Р2: комментарии не прочитались — заметки истории прежние, синхронизация завершена, об ошибке сказано", !err && us3?.omg?.notes.length === 2 && !!res?.commentsError, err ? err.message : JSON.stringify(us3 && us3.omg));
  window.fetch = orig;
  await settings.save({ fields: saved.fields, useTempoTeams: saved.useTempoTeams });
  await dbm.clearAll();
}

// Р3, Р5. Ракурс «Эпик — история»: проекты, эпики, истории, чужие задачи, смена проекта.
{
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  const PR = [{ id: "1", name: "Highest", iconUrl: "" }, { id: "2", name: "High", iconUrl: "" }, { id: "3", name: "Medium", iconUrl: "" }, { id: "4", name: "Low", iconUrl: "" }];
  const P = (id) => ({ ...PR.find((x) => x.id === id) });
  const lab = (name, created) => ({ project: { name, created, author: "" }, notes: [] });
  const EPS = [
    { key: "E-1", summary: "Корзина", statusName: "В работе", statusCategory: "indeterminate", priority: P("2"), dueDate: ymd(10), omg: lab("Сайт", "2026-09-01T10:00:00Z") },
    { key: "E-2", summary: "Оплата", statusName: "В работе", statusCategory: "indeterminate", priority: P("1"), dueDate: "", plannedEnd: ymd(5), omg: lab(" САЙТ ", "2026-09-05T10:00:00Z") },
    { key: "E-3", summary: "Прочее", statusName: "Сделать", statusCategory: "new", priority: P("4") },
    { key: "E-4", summary: "Приложение", statusName: "Готово", statusCategory: "done", priority: P("3"), dueDate: ymd(-3), omg: lab("Мобилка", "2026-09-02T10:00:00Z") }
  ];
  const L = (key, typeName = "Task", type = "Relates") => ({ type, key, typeName });
  const iss = (key, epic, type, sprintId, hours, st, links = [], p = null) => ({ ...mk(key, epic, "AAA", "Ivan", sprintId, hours, st), typeName: type, links, priority: p });
  const ISS = [
    iss("US-1", "E-1", "User Story", null, 0, "prog", [L("T-1"), L("T-2"), L("X-9"), L("T-5"), L("M-1"), L("EPX", "Epic"), L("B-1", "Task", "Blocks")], P("3")),
    iss("US-2", "E-1", "User Story", null, 0, "new", [L("T-2")], P("2")),
    iss("US-3", "E-1", "User Story", 3, 0, "new", [], P("4")),
    iss("T-1", "E-1", "Task", 2, 4, "done"),
    iss("T-2", "E-1", "Task", 3, 8, "new"),
    iss("T-3", "E-1", "Task", 2, 2, "new"),
    iss("B-1", "E-1", "Task", 2, 1, "new"),
    iss("T-5", "E-2", "Task", 2, 3, "new"),
    iss("T-6", "E-3", "Task", 3, 5, "new"),
    iss("T-7", "E-4", "Task", 2, 1, "done")
  ];
  const LINKED = [iss("X-9", "EP-Z", "Task", 2, 6, "new")];
  const model = stories.buildStoryModel({ epics: EPS, issues: ISS, linked: LINKED, sprints, boards, priorities: PR, storyTypes: ["user story"], excludeTypes: ["user story"], excludeTypeNames: ["User Story"], linkType: "Relates" });
  const proj = (name) => model.projects.find((p) => p.name === name);
  const site = model.projects[0];
  check("Р5: проекты по приоритету (самый высокий у незавершённых эпиков), «Без проекта» внизу",
    model.projects.map((p) => p.name || "∅").join() === "САЙТ,Мобилка,∅", model.projects.map((p) => p.name || "∅").join());
  check("Р3: «Сайт» и « САЙТ » — один проект, написание из самой свежей метки", site.epics.map((e) => e.key).join() === "E-2,E-1" && site.name === "САЙТ");
  check("Р5: приоритет проекта — самый высокий у незавершённых эпиков; все готовы — среди всех", site.priority?.id === "1" && proj("Мобилка").priority?.id === "3");
  const e1 = site.epics.find((e) => e.key === "E-1");
  check("Р5: истории по приоритету, затем по ключу", e1.stories.map((s) => s.key).join() === "US-2,US-1,US-3", e1.stories.map((s) => s.key).join());
  const us1 = e1.stories.find((s) => s.key === "US-1");
  check("Р5: итог истории — её задачи по связи Relates, свои и чужие; эпик на том конце и связь другого типа — не в счёт",
    us1.count === 4 && us1.foreign === 2 && us1.sum === 21 * 3600, `${us1.count} / ${us1.foreign} / ${us1.sum / 3600}`);
  check("Р5: задача, которую не удалось загрузить, — в списке «не загружена»", us1.missing.join() === "M-1", us1.missing.join());
  check("Р5: итог эпика — по задачам эпика, каждая один раз; чужие и истории не входят",
    e1.count === 4 && e1.sum === 15 * 3600, `${e1.count} / ${e1.sum / 3600}`);
  check("Р5: задача в двух историях видна в обеих", e1.stories.find((s) => s.key === "US-2").count === 1 && [...us1.cells.values()].some((c) => c.issues.some((i) => i.key === "T-2")));
  check("Р5: «Без истории» — задачи эпика без истории в этом эпике (и связанные другим типом связи)",
    e1.noStory.issues === undefined && [...e1.noStory.cells.values()].flatMap((c) => c.issues.map((i) => i.key)).sort().join() === "B-1,T-3");
  const e2 = site.epics.find((e) => e.key === "E-2");
  check("Р5: задача эпика E-2 в истории эпика E-1 — в итоге E-2 один раз, у E-2 она «Без истории»",
    e2.count === 1 && e2.noStory.count === 1 && us1.cells.get([...us1.cells.keys()][0]).issues.some((i) => i.key === "T-5" && i.foreignEpic === "E-2"));
  check("Р5: чужая задача невыбранного эпика помечена эпиком", [...us1.cells.values()].flatMap((c) => c.issues).some((i) => i.key === "X-9" && i.foreignEpic === "EP-Z"));
  check("Р5: итог проекта — сумма итогов эпиков", site.count === e1.count + e2.count && site.sum === e1.sum + e2.sum);
  check("Р5: история без задач со своим спринтом — отрезок по спринту истории", !!e1.stories.find((s) => s.key === "US-3").ownSprint && e1.stories.find((s) => s.key === "US-3").ownSprint.sprintId === 3);
  check("Р5/Р7: веха проекта — ближайшая из вех незавершённых эпиков (плановое завершение E-2)", site.milestone?.date === ymd(5) && site.milestone.kind === "planned");
  check("Р5/Р7: все эпики проекта готовы — веха по самой поздней", proj("Мобилка").milestone?.date === ymd(-3));

  // Отрисовка.
  const box = document.createElement("div");
  document.body.append(box);
  const published = [];
  const set = [];
  const notes = [];
  let failKey = "";
  sv.api.addComment = async (key, text) => {
    if (key === failKey) throw new Error("403");
    published.push([key, text]);
  };
  const opts = {
    notify: (m, kind) => notes.push([m, kind]),
    onProjectSet: async (key, name) => set.push(["set", key, name]),
    onRenamed: async (keys, name) => set.push(["rename", keys.join(), name]),
    epicsOfProject: (key) => EPS.filter((e) => (stories.projectOf(e) ? omgKey(stories.projectOf(e).name) : "") === key)
  };
  const omgKey = (await import("../src/js/omg.js")).projectKey;
  sv.resetCollapse();
  sv.render(box, model, opts);
  check("Р5: по умолчанию видны только проекты", box.querySelectorAll(".s-project").length === 3 && !box.querySelector(".s-epic"));
  box.querySelector(".gantt-bar .link").click(); // «Развернуть всё»
  const rowsOf = (sel) => [...box.querySelectorAll(sel)];
  check("Р5: «Развернуть всё» — эпики, истории и «Без истории»", rowsOf(".s-epic").length === 4 && rowsOf(".s-story").length === 3 && rowsOf(".s-nostory").length === 4);
  check("Р6: у проекта, эпика и истории — пиктограмма приоритета", rowsOf(".s-project, .s-epic, .s-story").every((r) => r.querySelector(".prio-icon, .prio-dot")));
  const us1Row = rowsOf(".s-story").find((r) => r.dataset.story === "US-1");
  check("Р5: у истории отметка чужих задач и незагруженных", us1Row.querySelector(".s-foreign")?.textContent.includes("2") && us1Row.querySelector(".s-missing")?.textContent.includes("1"));
  us1Row.querySelector(".sbar.clickable").click();
  const tipText = document.querySelector(".tooltip.tip-issues")?.textContent || "";
  check("Р5: в списке задач истории чужие помечены эпиком", tipText.includes(t("story.fromEpic", { key: "EP-Z" })) || tipText.includes(t("story.fromEpic", { key: "E-2" })), tipText.slice(0, 200));
  document.querySelector(".tooltip .tip-close")?.click();
  check("Р5: у истории без задач — отрезок по её спринту", !!rowsOf(".s-story").find((r) => r.dataset.story === "US-3").querySelector(".sbar.own-sprint"));
  check("Р5: вехи проекта и эпика — в колонке «Срок» (◇ — плановое завершение), линия вехи — на шкале", /◇ \d{2}\.\d{2}/.test(rowsOf(".s-project")[0].querySelector(".s-due").textContent) && /◆ \d{2}\.\d{2}/.test(rowsOf(".s-epic").find((r) => r.dataset.epic === "E-1").querySelector(".s-due").textContent) && !!rowsOf(".s-epic").find((r) => r.dataset.epic === "E-1").querySelector(".due-line"));
  check("Р5: у эпика — «Проект…» и 💬, у проекта «Без проекта» нет «Переименовать…»",
    rowsOf(".s-epic").every((r) => r.querySelector(".s-proj-btn") && r.querySelector(".cmt-btn")) && !rowsOf(".s-project").at(-1).querySelector(".s-rename") && !!rowsOf(".s-project")[0].querySelector(".s-rename"));

  // Смена проекта (Р3): публикация метки в эпик и перенос локально.
  rowsOf(".s-epic").find((r) => r.dataset.epic === "E-3").querySelector(".s-proj-btn").click();
  let pop = document.querySelector(".tooltip.tip-project");
  check("Р3: в окне — существующие проекты, «Без проекта», поле нового и предупреждение о письме",
    [...pop.querySelectorAll("option")].map((o) => o.textContent).join() === `САЙТ,Мобилка,${t("story.noProject")}` && pop.querySelector("select").value === "__none__" && pop.textContent.includes(t("story.notifyWarn")));
  pop.querySelector(".s-proj-new").value = "Новый проект";
  pop.querySelector(".s-proj-save").click();
  await new Promise((r) => setTimeout(r, 20));
  check("Р3: в эпик опубликован комментарий (omg project) и проект сменён локально",
    JSON.stringify(published) === JSON.stringify([["E-3", "(omg project) Новый проект"]]) && JSON.stringify(set) === JSON.stringify([["set", "E-3", "Новый проект"]]), JSON.stringify([published, set]));
  published.length = 0;
  set.length = 0;
  rowsOf(".s-epic").find((r) => r.dataset.epic === "E-1").querySelector(".s-proj-btn").click();
  pop = document.querySelector(".tooltip.tip-project");
  pop.querySelector("select").value = "__none__";
  failKey = "E-1";
  pop.querySelector(".s-proj-save").click();
  await new Promise((r) => setTimeout(r, 20));
  check("Р3: публикация не прошла — эпик на месте, сообщение в строке статуса", !set.length && notes.at(-1)?.[1] === "error" && notes.at(-1)[0].includes("E-1"), JSON.stringify(notes));
  failKey = "";
  pop.querySelector(".s-proj-save").click();
  await new Promise((r) => setTimeout(r, 20));
  check("Р3: «Без проекта» — метка без названия", JSON.stringify(published) === JSON.stringify([["E-1", "(omg project)"]]) && set[0]?.[2] === "");
  published.length = 0;
  set.length = 0;

  // Переименование (Р3): во все эпики проекта из выборки; частичная ошибка.
  rowsOf(".s-project")[0].querySelector(".s-rename").click();
  pop = document.querySelector(".tooltip.tip-project");
  check("Р3: подтверждение переименования — число эпиков и предупреждение про чужие выборки",
    pop.textContent.includes(t("story.renameWarn", { n: 2 })) && pop.textContent.includes(t("story.renameScope")));
  pop.querySelector(".s-proj-new").value = "Портал";
  failKey = "E-2";
  pop.querySelector(".s-proj-save").click();
  await new Promise((r) => setTimeout(r, 30));
  check("Р3: переименование — метка в каждый эпик; не прошедшие остаются в старом проекте, их ключи в сообщении",
    published.map((x) => x.join(":")).join() === "E-1:(omg project) Портал" && JSON.stringify(set) === JSON.stringify([["rename", "E-1", "Портал"]]) && notes.at(-1)[1] === "error" && notes.at(-1)[0].includes("E-2"),
    JSON.stringify([published, set, notes.at(-1)]));
  failKey = "";
  box.remove();
}

// Р4. Заметки (omg comment) к эпику и истории: показ, история, правка.
{
  const omgMod = await import("../src/js/omg.js");
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  const ago = (d) => new Date(Date.now() - d * day).toISOString();
  const rec = { project: null, notes: [{ id: "1", text: "Старая", created: ago(30), author: "Иван" }, { id: "2", text: "Первая строка\nвторая\nтретья", created: ago(20), author: "Пётр" }] };
  check("Р4: действующая заметка — последняя, история — прежние, новые первыми",
    omgMod.latestNote(rec).id === "2" && omgMod.noteHistory(rec).map((n) => n.id).join() === "1" && omgMod.latestNote({ notes: [] }) === null && omgMod.noteHistory(null).length === 0);
  check("Р4: возраст заметки в днях", omgMod.noteAgeDays(rec.notes[1]) === 20 && omgMod.noteAgeDays({ created: "" }) === null);
  check("Р4: заметка из ответа Jira — автор и дата настоящие",
    JSON.stringify(omgMod.noteFromComment({ id: 9, body: "(omg comment)\nТекст", created: "2026-09-18T10:00:00Z", author: { displayName: "Анна" } })) === JSON.stringify({ id: "9", text: "Текст", created: "2026-09-18T10:00:00Z", author: "Анна" }) &&
      omgMod.noteFromComment({ body: "обычный" }) === null && omgMod.noteFromComment(null) === null);

  const EPS = [{ key: "N-E", summary: "Эпик с заметкой", statusName: "В работе", statusCategory: "indeterminate", omg: { project: { name: "Проект", created: ago(1) }, notes: rec.notes } }];
  const ISS = [
    { ...mk("N-S1", "N-E", "AAA", "Ivan", 2, 1, "new"), typeName: "User Story", links: [], omg: { project: null, notes: [{ id: "5", text: "Заметка истории", created: ago(2), author: "Ольга" }] } },
    { ...mk("N-S2", "N-E", "AAA", "Ivan", 2, 1, "new"), typeName: "User Story", links: [] },
    { ...mk("N-T1", "N-E", "AAA", "Ivan", 2, 3, "new"), typeName: "Task", links: [] }
  ];
  const model = stories.buildStoryModel({ epics: EPS, issues: ISS, sprints, boards, storyTypes: ["user story"], excludeTypes: ["user story"], linkType: "Relates" });
  const box = document.createElement("div");
  document.body.append(box);
  const added = [];
  const toggles = [];
  const notes = [];
  const opts = { staleDays: 14, notify: (m, k) => notes.push([m, k]), onToggleNotes: (on) => toggles.push(on), onNoteAdded: async (kind, key, note) => added.push([kind, key, note]) };
  sv.resetCollapse();
  sv.render(box, model, opts);
  box.querySelector(".gantt-bar .link").click(); // развернуть всё
  const noteRows = [...box.querySelectorAll(".s-note")];
  check("Р4: строка заметки — только там, где заметка есть (эпик, история N-S1); у проекта — нет", noteRows.map((r) => r.dataset.note).join() === "N-E,N-S1" && !box.querySelector(".s-project + .s-note"), noteRows.map((r) => r.dataset.note).join());
  const epicNote = noteRows[0];
  check("Р4: заметка эпика — текст (первые две строки), автор, дата, полный текст при наведении",
    epicNote.querySelector(".s-note-text").textContent.startsWith("Первая строка") && epicNote.querySelector(".s-note-text").title.includes("третья") && epicNote.querySelector(".s-note-who").textContent.includes("Пётр") &&
      getComputedStyle(epicNote.querySelector(".s-note-text")).webkitLineClamp === "2");
  check("Р4: заметка старше порога помечена «заметке N дн.»", epicNote.querySelector(".s-note-stale")?.textContent === t("note.stale", { n: 20 }) && !noteRows[1].querySelector(".s-note-stale"));
  check("Р4: заметка истории — только у своей истории", noteRows[1].textContent.includes("Заметка истории") && !noteRows[0].textContent.includes("Заметка истории"));
  const s2Row = box.querySelector('.s-story[data-story="N-S2"]');
  check("Р4: нет заметки — строки нет, добавить можно ✎ в действиях строки", !!s2Row.querySelector(".s-actions .s-note-add") && s2Row.nextElementSibling?.dataset.note !== "N-S2");
  check("Р4: «История (N)» — только когда есть прежние заметки", epicNote.querySelector(".s-note-hist")?.textContent === t("note.history", { n: 1 }) && !noteRows[1].querySelector(".s-note-hist"));
  epicNote.querySelector(".s-note-hist").click();
  check("Р4: в истории — прежние заметки с автором", document.querySelector(".tooltip.tip-note")?.textContent.includes("Старая") && document.querySelector(".tooltip.tip-note").textContent.includes("Иван"));
  document.querySelector(".tooltip .tip-close").click();

  // Правка: форма с последней заметкой, публикация нового комментария в ту же задачу.
  const sent = [];
  let fail = null;
  sv.api.addComment = async (key, text) => {
    if (fail) throw fail;
    sent.push([key, text]);
    return { id: "77", body: text, created: "2026-09-18T12:00:00.000+0300", author: { displayName: "Менеджер" } };
  };
  noteRows[1].querySelector(".s-note-edit").click();
  let pop = document.querySelector(".tooltip.tip-note");
  check("Р4: форма заполнена текстом последней заметки и предупреждает о письме", pop.querySelector("textarea").value === "Заметка истории" && pop.textContent.includes(t("note.notifyWarn")));
  pop.querySelector("textarea").value = "  Новая заметка\nвторая строка  ";
  pop.querySelector(".s-note-save").click();
  await new Promise((r) => setTimeout(r, 20));
  check("Р4: опубликован комментарий (omg comment) в ту же историю; заметка — с автором и датой из ответа Jira",
    JSON.stringify(sent) === JSON.stringify([["N-S1", "(omg comment)\nНовая заметка\nвторая строка"]]) && added[0]?.[0] === "story" && added[0][1] === "N-S1" && added[0][2].author === "Менеджер" && added[0][2].text === "Новая заметка\nвторая строка",
    JSON.stringify([sent, added]));
  s2Row.querySelector(".s-note-add").click();
  pop = document.querySelector(".tooltip.tip-note");
  pop.querySelector(".s-note-save").click();
  check("Р4: пустую заметку не публикуем", pop.querySelector(".s-note-msg").textContent === t("note.empty") && sent.length === 1);
  pop.querySelector("textarea").value = "Текст";
  fail = Object.assign(new Error("Forbidden"), { code: 403 });
  pop.querySelector(".s-note-save").click();
  await new Promise((r) => setTimeout(r, 20));
  check("Р4: нет права комментировать — понятное сообщение, заметка не добавлена",
    added.length === 1 && notes.at(-1)?.[1] === "error" && notes.at(-1)[0].includes(t("story.noPermission")), JSON.stringify(notes.at(-1)));
  fail = null;
  document.querySelector(".tooltip .tip-close")?.click();

  // Галочка «Заметки».
  const cbx = box.querySelector(".s-notes-toggle input");
  check("Р4: галочка «Заметки» на панели, по умолчанию включена", !!cbx && cbx.checked);
  cbx.checked = false;
  cbx.dispatchEvent(new Event("change"));
  sv.render(box, model, { ...opts, showNotes: false });
  check("Р4: снятая галочка скрывает строки заметок", JSON.stringify(toggles) === "[false]" && !box.querySelector(".s-note") && !box.querySelector(".s-notes-toggle input").checked);
  box.remove();
}

// Дефект: истории не выводились под эпиками — ракурс должен объяснять, почему историй нет.
{
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  const EPS = [{ key: "D-E", summary: "Эпик", statusName: "В работе", statusCategory: "indeterminate" }];
  const ISS = [
    { ...mk("D-1", "D-E", "AAA", "Ivan", 2, 1, "new"), typeName: "Story", links: [] },
    { ...mk("D-2", "D-E", "AAA", "Ivan", 2, 1, "new"), typeName: "Task", links: [] },
    { ...mk("D-3", "D-E", "AAA", "Ivan", 2, 1, "new"), typeName: "Task", links: [] }
  ];
  const miss = stories.buildStoryModel({ epics: EPS, issues: ISS, sprints, boards, storyTypes: ["user story"], excludeTypes: ["user story"] });
  check("Дефект: тип историй не совпал — историй 0, в модели типы задач эпика", miss.storyTotal === 0 && miss.typeCounts.map((x) => `${x.name}:${x.n}`).join() === "Task:2,Story:1", JSON.stringify(miss.typeCounts));
  const box = document.createElement("div");
  document.body.append(box);
  sv.resetCollapse();
  sv.render(box, miss, { storyTypesText: "User Story" });
  const hint = box.querySelector(".s-nostories");
  check("Дефект: над диаграммой — подсказка с типами задач и значением «Типов историй»", !!hint && hint.textContent.includes("Story (1)") && hint.textContent.includes("User Story"), hint && hint.textContent);
  const hit = stories.buildStoryModel({ epics: EPS, issues: ISS, sprints, boards, storyTypes: ["story"], excludeTypes: ["story"] });
  sv.render(box, hit, { storyTypesText: "Story" });
  box.querySelector(".gantt-bar .link").click();
  const added = [];
  sv.render(box, miss, { storyTypesText: "User Story", onAddStoryType: (n) => added.push(n) });
  box.querySelector(".s-add-type")?.click();
  check("Дефект: в подсказке кнопка «Считать историями» для похожего типа", JSON.stringify(added) === '["Story"]' && JSON.stringify(miss.storyCandidates) === '["Story"]');
  const ru = stories.buildStoryModel({ epics: EPS, issues: ISS.map((i) => (i.typeName === "Story" ? { ...i, typeName: "История" } : i)), sprints, boards, storyTypes: flowlib.storyTypes({ storyTypes: settings.DEFAULTS.storyTypes }), excludeTypes: [] });
  check("Дефект: по умолчанию «Типы историй» понимают русское «История»", ru.storyTotal === 1);
  const m1 = { storyTypes: " User Story " };
  const m2 = { storyTypes: "Epic Story" };
  settings.MIGRATIONS[1](m1);
  settings.MIGRATIONS[1](m2);
  check("Дефект: прежнее нетронутое умолчание «User Story» поднимается миграцией, своё значение не трогаем",
    m1.storyTypes === settings.DEFAULTS.storyTypes && m2.storyTypes === "Epic Story" && settings.SCHEMA >= 2);
  sv.render(box, hit, { storyTypesText: "Story" });
  box.querySelector(".gantt-bar .link").click();
  check("Дефект: при верном типе история под эпиком, подсказки нет", hit.storyTotal === 1 && ![...box.querySelectorAll(".s-nostories")].some((h) => h.textContent.includes(t("story.noneFound", { setting: "Story" }))) && box.querySelector('.s-story[data-story="D-1"]'));
  box.remove();
}

// Визуальные доработки: ширина колонки названий, строка проекта.
{
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  await settings.save({ nameWidths: {} });
  const gw = document.createElement("div");
  document.body.append(gw);
  const mw = agg.buildModel({ issues, others: [], sprints, epics, boards, mode: "epicPeople" });
  renderOpen(gw, mw, { mode: "epicPeople" });
  const tbl = gw.querySelector("table.gantt");
  const rz = tbl.querySelector("thead .c-name .col-resizer");
  const w = () => parseFloat(getComputedStyle(tbl).getPropertyValue("--name-w"));
  check("Ширина: у заголовка колонки названий — ручка, по умолчанию 456px", !!rz && w() === gantt.NAME_W_DEFAULT && rz.getAttribute("role") === "separator");
  rz.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100 }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 250 }));
  const live = w();
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 250 }));
  await new Promise((r) => setTimeout(r, 20));
  check("Ширина: тянем мышью — колонка шире, ширина запомнена для ракурса", live === 606 && settings.get().nameWidths.epicPeople === 606 && tbl.querySelector("thead .c-name").getBoundingClientRect().width >= 600, `${live} / ${JSON.stringify(settings.get().nameWidths)}`);
  const lbl = tbl.querySelector(".glabel");
  check("Ширина: подпись эпика растёт вместе с колонкой", parseFloat(getComputedStyle(lbl).maxWidth) === 606 - 200, getComputedStyle(lbl).maxWidth);
  renderOpen(gw, mw, { mode: "epicPeople" });
  check("Ширина: после перерисовки — сохранённая", w.call(null) === 606 || parseFloat(getComputedStyle(gw.querySelector("table.gantt")).getPropertyValue("--name-w")) === 606);
  const rz2 = gw.querySelector("thead .c-name .col-resizer");
  rz2.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  check("Ширина: стрелка ← — на 20px уже", settings.get().nameWidths.epicPeople === 586);
  rz2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 500 }));
  document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: -900 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  check("Ширина: не уже минимума", settings.get().nameWidths.epicPeople === gantt.NAME_W_MIN);
  rz2.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
  check("Ширина: двойной щелчок — по умолчанию", !("epicPeople" in settings.get().nameWidths) && parseFloat(getComputedStyle(gw.querySelector("table.gantt")).getPropertyValue("--name-w")) === gantt.NAME_W_DEFAULT);
  await settings.save({ nameWidths: { epicStories: 700 } });
  renderOpen(gw, mw, { mode: "epicPeople" });
  check("Ширина: у каждого ракурса своя", parseFloat(getComputedStyle(gw.querySelector("table.gantt")).getPropertyValue("--name-w")) === gantt.NAME_W_DEFAULT);
  gw.remove();

  const EPS = [{ key: "V-E", summary: "Эпик", statusName: "В работе", statusCategory: "indeterminate", omg: { project: { name: "Проект В", created: "2026-09-01T10:00:00Z" }, notes: [] } }];
  const ISS = [{ ...mk("V-1", "V-E", "AAA", "Ivan", 2, 4, "new"), typeName: "Task", links: [] }];
  const sm = stories.buildStoryModel({ epics: EPS, issues: ISS, sprints, boards, storyTypes: ["user story"], excludeTypes: ["user story"] });
  const sb = document.createElement("div");
  document.body.append(sb);
  sv.resetCollapse();
  sv.render(sb, sm, {});
  sb.querySelector(".gantt-bar .link").click(); // развернуть всё — нужна и строка эпика для сравнения
  const prow = sb.querySelector(".s-project");
  const bg = (td) => getComputedStyle(td).backgroundColor;
  check("Проект: ширина колонки ракурса — своя сохранённая (700px)", parseFloat(getComputedStyle(sb.querySelector("table.gantt")).getPropertyValue("--name-w")) === 700);
  check("Проект: строка залита целиком — от названия до бэклога, одним цветом", [...prow.children].every((td) => bg(td) === bg(prow.children[0])) && bg(prow.children[0]) !== bg(sb.querySelector(".s-epic > .c-cell")));
  const pb = prow.querySelector(".sbar-p");
  const eb = sb.querySelector(".s-epic .sbar-e .sbar-track");
  check("Проект: форма «скобка» — тонкая полоса с уголками на концах; у эпика — брусок без уголков",
    !!pb && pb.querySelector(".sbar-caps .cap-l") && pb.querySelector(".sbar-caps .cap-r") && Math.round(pb.querySelector(".sbar-track").getBoundingClientRect().height) === 5 &&
      !!eb && Math.round(eb.getBoundingClientRect().height) === 12 && !sb.querySelector(".s-epic .sbar-caps"));
  sb.remove();
  await settings.save({ nameWidths: {} });
}

// Дефект: у историй не показывались задачи — связь в Jira называется иначе, чем в настройке.
{
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  const EPS = [{ key: "K-E", summary: "Эпик", statusName: "В работе", statusCategory: "indeterminate" }];
  const L = (key, type, typeName = "Задача") => ({ type, key, typeName });
  const ISS = [
    { ...mk("K-S", "K-E", "AAA", "Ivan", null, 0, "new"), typeName: "История", links: [L("K-1", "Связано"), L("K-2", "Связано"), L("K-3", "Блокирует"), L("K-E", "Связано", "Epic")] },
    { ...mk("K-1", "K-E", "AAA", "Ivan", 2, 4, "new"), typeName: "Задача", links: [L("K-S", "Связано", "История")] },
    { ...mk("K-2", "K-E", "AAA", "Ivan", 2, 4, "new"), typeName: "Задача", links: [L("K-S", "Связано", "История")] },
    { ...mk("K-3", "K-E", "AAA", "Ivan", 3, 4, "new"), typeName: "Задача", links: [] }
  ];
  const opt = { epics: EPS, issues: ISS, sprints, boards, storyTypes: ["история"], excludeTypes: ["история"] };
  const miss = stories.buildStoryModel({ ...opt, linkType: "Relates" });
  check("Дефект связей: связь не совпала — у истории 0 задач, в модели типы связей историй",
    miss.storyTotal === 1 && miss.storyTaskTotal === 0 && miss.linkTypeCounts.map((x) => `${x.name}:${x.n}`).join() === "Связано:2,Блокирует:1", JSON.stringify(miss.linkTypeCounts));
  const box = document.createElement("div");
  document.body.append(box);
  const chosen = [];
  sv.resetCollapse();
  sv.render(box, miss, { storyLinkText: "Relates", onAddLinkType: (n) => chosen.push(n) });
  const hint = box.querySelector(".s-nostories");
  check("Дефект связей: подсказка — какие связи у историй и что в настройке", !!hint && hint.textContent.includes("Связано (2)") && hint.textContent.includes("Relates"), hint && hint.textContent);
  hint.querySelector(".s-add-type").click();
  check("Дефект связей: кнопка «Добавить связь» добавляет связь", JSON.stringify(chosen) === '["Связано"]');
  const hit = stories.buildStoryModel({ ...opt, linkType: "Связано" });
  sv.render(box, hit, { storyLinkText: "Связано" });
  box.querySelector(".gantt-bar .link").click();
  const row = box.querySelector('.s-story[data-story="K-S"]');
  check("Дефект связей: при верной связи задачи истории в её секциях, подсказки нет",
    hit.storyTaskTotal === 2 && !box.querySelector(".s-nostories") && row.querySelectorAll(".c-cell .sbar").length >= 1, `${hit.storyTaskTotal}`);
  const nolinks = stories.buildStoryModel({ ...opt, issues: ISS.map((i) => ({ ...i, links: [] })), linkType: "Relates" });
  sv.render(box, nolinks, { storyLinkText: "Relates" });
  check("Дефект связей: у историй нет связей вовсе — так и сказано", box.querySelector(".s-nostories")?.textContent.includes(t("story.noLinks")));
  box.remove();
}

// Истории, чьи задачи закрыты в прошлых спринтах: на шкале их нет — нужен счётчик «готово N из M».
{
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  const EPS = [{ key: "P-E", summary: "Эпик", statusName: "В работе", statusCategory: "indeterminate" }];
  const L = (key) => ({ type: "Relates", key, typeName: "Задача" });
  const ISS = [{ ...mk("P-S", "P-E", "AAA", "Ivan", null, 0, "prog"), typeName: "История", links: [L("AO-1"), L("AO-2"), L("AO-3")] }];
  // AO-1, AO-2 — из другого проекта, готовы в закрытом спринте 1; AO-3 — ещё не загружена.
  const LINKED = [{ ...mk("AO-1", "", "AO", "Ivan", 1, 4, "done"), typeName: "Задача", links: [] }, { ...mk("AO-2", "", "AO", "Ivan", 1, 2, "prod"), typeName: "Задача", links: [] }];
  const m = stories.buildStoryModel({ epics: EPS, issues: ISS, linked: LINKED, sprints, boards, storyTypes: ["история"], excludeTypes: ["история"], linkType: "Relates" });
  const sn = m.projects[0].epics[0].stories[0];
  check("История с задачами в прошлых спринтах: на шкале пусто, но задачи учтены", sn.all.length === 2 && sn.cells.size === 0 && sn.missing.join() === "AO-3");
  const box = document.createElement("div");
  document.body.append(box);
  sv.resetCollapse();
  sv.render(box, m, {});
  box.querySelector(".gantt-bar .link").click();
  const chip = box.querySelector('.s-story[data-story="P-S"] .s-progress');
  check("Счётчик «готово N из M» у истории, все готовы — зелёный", chip?.textContent === t("story.progress", { done: 2, n: 2 }) && chip.classList.contains("all-done"));
  chip.click();
  check("По счётчику — список всех задач истории, чужие помечены", document.querySelectorAll(".tooltip.tip-issues tr").length === 2 && document.querySelector(".tooltip.tip-issues").textContent.includes(t("story.noEpic")));
  document.querySelector(".tooltip .tip-close")?.click();
  check("Незагруженная задача — подсказка предлагает «Обновить»", box.querySelector('.s-story[data-story="P-S"] .s-missing').title.includes("AO-3") && t("story.missing", { list: "" }).includes("Обновить"));
  box.remove();
}

// «Обновить» и «Скачать» — одной кнопкой-пиктограммой с меню.
{
  const html = await (await fetch("../src/app.html", { cache: "no-store" })).text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const grp = doc.querySelector(".toolbar .sync-btn");
  check("Синхронизация: одна кнопка ↻ (пиктограмма, подпись в подсказке) и ▾ с меню «Обновить» / «Скачать заново»",
    !!grp && !!grp.querySelector("#btnRefresh svg") && !grp.querySelector("#btnRefresh").dataset.i18n && grp.querySelector("#btnRefresh").dataset.i18nTitle === "toolbar.refreshHint" &&
      grp.querySelector("#btnSyncMenu[aria-haspopup='menu']") && grp.querySelector("#syncMenu[hidden] #btnRefreshItem") && grp.querySelector("#syncMenu #btnReload") &&
      doc.querySelectorAll(".toolbar > button").length === 0);
}

// Задачи привязаны к истории разными связями: «relates to» и «is subtask of».
{
  const stories = await import("../src/js/stories.js");
  const syncMod = await import("../src/js/sync.js");
  const m = flowlib.linkMatcher("Relates, is subtask of");
  check("Связи: подходят по названию типа и по подписи, без учёта регистра; пустая настройка — любая",
    m({ type: "Relates" }) && m({ type: "Subtask", desc: "Is Subtask Of" }) && !m({ type: "Blocks", desc: "blocks" }) && flowlib.linkMatcher("")({ type: "X" }));
  const ls = syncMod.linksOf([
    { type: { name: "Subtask", inward: "is subtask of", outward: "has subtask" }, inwardIssue: { key: "DP-1", fields: { issuetype: { name: "Задача" } } } },
    { type: { name: "Relates", inward: "relates to", outward: "relates to" }, outwardIssue: { key: "AO-1", fields: { issuetype: { name: "Задача" } } } }
  ]);
  check("Связи: подпись берётся с нужной стороны связи", ls[0].desc === "is subtask of" && ls[1].desc === "relates to", JSON.stringify(ls));
  const EPS = [{ key: "S-E", summary: "Эпик", statusName: "В работе", statusCategory: "indeterminate" }];
  const ISS = [
    { ...mk("S-S", "S-E", "AAA", "Ivan", null, 0, "new"), typeName: "История", links: ls },
    { ...mk("DP-1", "S-E", "AAA", "Ivan", 2, 4, "new"), typeName: "Задача", links: [] },
    { ...mk("AO-1", "S-E", "AAA", "Ivan", 2, 2, "new"), typeName: "Задача", links: [] }
  ];
  const model = stories.buildStoryModel({ epics: EPS, issues: ISS, sprints, boards, storyTypes: ["история"], excludeTypes: ["история"], linkType: settings.DEFAULTS.storyLinkType });
  check("Связи: по умолчанию у истории задачи и по «relates to», и по «is subtask of»", model.projects[0].epics[0].stories[0].count === 2);
  check("Связи: догружаются чужие задачи и по «is subtask of»",
    syncMod.linkedKeysToLoad({ issues: new Map([["S-S", ISS[0]]]), isStory: (i) => i.typeName === "История", linkType: "Relates, is subtask of", epicKeys: ["S-E"] }).sort().join() === "AO-1,DP-1");
  const mg = { storyLinkType: "Relates" };
  const mine = { storyLinkType: "Связано" };
  settings.MIGRATIONS[2](mg);
  settings.MIGRATIONS[2](mine);
  check("Связи: нетронутое «Relates» поднимается миграцией до «Relates, is subtask of», своё не трогаем", mg.storyLinkType === "Relates, is subtask of" && mine.storyLinkType === "Связано" && settings.SCHEMA === 3);
}

// Новый вид «Эпик — история»: выровненные колонки, одна система полос, свёрнутые готовые истории.
{
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  const EPS = [{ key: "R-E", summary: "Эпик", statusName: "В работе", statusCategory: "indeterminate", dueDate: ymd(5) }];
  const L = (key) => ({ type: "Relates", key, typeName: "Задача" });
  const ISS = [
    { ...mk("R-S1", "R-E", "AAA", "Ivan", null, 0, "prog"), typeName: "История", links: [L("R-1")], summary: "Очень длинное название истории, которое точно не поместится в узкую колонку названий" },
    { ...mk("R-S2", "R-E", "AAA", "Ivan", null, 0, "done"), typeName: "История", links: [L("R-2")] },
    { ...mk("R-S3", "R-E", "AAA", "Ivan", null, 0, "done"), typeName: "История", links: [] },
    { ...mk("R-1", "R-E", "AAA", "Ivan", 2, 4, "new"), typeName: "Задача", links: [] },
    { ...mk("R-2", "R-E", "AAA", "Ivan", 1, 2, "done"), typeName: "Задача", links: [] }
  ];
  const m = stories.buildStoryModel({ epics: EPS, issues: ISS, sprints, boards, storyTypes: ["история"], excludeTypes: ["история"], linkType: "Relates" });
  const box = document.createElement("div");
  document.body.append(box);
  sv.resetCollapse();
  sv.render(box, m, { onNoteAdded: () => {} });
  box.querySelector(".gantt-bar .link").click();
  const head = box.querySelector("thead .c-name .s-head");
  check("Вид: у колонки названий заголовки «Статус», «Готово», «Срок»", !!head && head.textContent.includes(t("story.colStatus")) && head.textContent.includes(t("story.colDone")) && head.textContent.includes(t("story.colDue")));
  const erow = box.querySelector(".s-epic");
  check("Вид: у эпика — статус точкой и текстом, «готово N из M», срок в колонке", erow.querySelector(".s-st .s-dot-progress") && erow.querySelector(".s-pr").textContent === t("story.progress", { done: 1, n: 2 }) && /◆/.test(erow.querySelector(".s-due").textContent) && erow.querySelector(".s-due").classList.contains("s-due-soon"));
  check("Вид: колонки выровнены — «Статус» у всех строк с одного отступа", new Set([...box.querySelectorAll("tbody .s-st")].map((x) => Math.round(x.getBoundingClientRect().left))).size === 1);
  check("Вид: действия строки спрятаны до наведения", getComputedStyle(erow.querySelector(".s-actions")).display === "none");
  check("Вид: в полосах истории нет названия спринта — оно в подсказке", !box.querySelector(".s-story .bar-sprint") && box.querySelector('.s-story[data-story="R-S1"] .sbar').title.includes("Sprint 2"));
  const stories1 = [...box.querySelectorAll(".s-story")].map((r) => r.dataset.story).join();
  const dg = box.querySelector(".s-donegroup");
  check("Вид: готовые истории свёрнуты в одну строку «Готовые истории · 2»", stories1 === "R-S1" && dg && dg.textContent.includes(t("story.doneGroup", { n: 2 })) && dg.querySelector(".s-pr").textContent === t("story.progress", { done: 1, n: 1 }));
  dg.querySelector(".twisty").click();
  check("Вид: по щелчку готовые истории раскрываются", [...box.querySelectorAll(".s-story")].map((r) => r.dataset.story).join() === "R-S1,R-S2,R-S3");
  // Узкая колонка: отступы и приоритет не сжимаются — строки не съезжают, сжимается только название.
  const tblN = box.querySelector("table.gantt");
  tblN.style.setProperty("--name-w", "300px");
  const leftOf = (sel) => [...box.querySelectorAll(sel)].map((r) => Math.round(r.querySelector(".s-title .prio-icon, .s-title .prio-dot, .s-title .plabel").getBoundingClientRect().left));
  const storyLefts = new Set(leftOf(".s-story"));
  const ind = box.querySelector(".s-story .indent2");
  check("Вид: при узкой колонке отступы не сжимаются, строки историй выровнены", storyLefts.size === 1 && Math.round(ind.getBoundingClientRect().width) === 36, `${[...storyLefts]} / ${ind.getBoundingClientRect().width}`);
  tblN.style.removeProperty("--name-w");
  gantt.applyNameWidth(tblN, "epicStories");
  const th = box.querySelector("thead th.c-sprint.current");
  check("Вид: компактная шапка — «Текущий» и число спринтов, без списка", th.textContent.includes(t("gantt.current")) && th.querySelector(".sp-count") && !th.querySelector(".sp-list"));
  th.click();
  check("Вид: по щелчку по шапке — список спринтов секции", !!box.querySelector("thead th.c-sprint.current .sp-list .sp-item"));
  box.querySelector("thead th.c-sprint.current").click();
  box.remove();
}

// Release notes в окне «О плагине»: Markdown → HTML.
{
  const md = await import("../src/js/markdown.js");
  const html = md.toHtml([
    "# Заголовок",
    "",
    "Абзац с **жирным**, `кодом` и <script>alert(1)</script>.",
    "",
    "- Пункт один",
    "  продолжение пункта",
    "- [ссылка](https://example.com) и [файл](RELEASE_NOTES.md)",
    "  - вложенный",
    "",
    "1. Первый",
    "2. Второй",
    "",
    "| Версия | Что |",
    "|---|---|",
    "| 1.21.0 | Новый вид |"
  ].join("\n"));
  const box = document.createElement("div");
  box.innerHTML = html;
  check("Release notes: заголовок, абзац, жирный, код", box.querySelector("h2")?.textContent === "Заголовок" && box.querySelector("p strong")?.textContent === "жирным" && box.querySelector("p code")?.textContent === "кодом");
  check("Release notes: HTML из текста экранируется, скриптов нет", !box.querySelector("script") && box.querySelector("p").textContent.includes("<script>"));
  const lis = [...box.querySelectorAll("ul > li")];
  check("Release notes: список с переносом строк и вложенным пунктом", lis.length === 2 && lis[0].textContent === "Пункт один продолжение пункта" && lis[1].innerHTML.includes("<br>• вложенный"), lis.map((x) => x.innerHTML).join(" | "));
  check("Release notes: внешняя ссылка — в новой вкладке, файл — текстом", box.querySelector('a[href="https://example.com"][target="_blank"]')?.textContent === "ссылка" && !box.querySelector('a[href="RELEASE_NOTES.md"]') && lis[1].textContent.includes("файл"));
  check("Release notes: нумерованный список и таблица", box.querySelectorAll("ol > li").length === 2 && box.querySelector("table thead th")?.textContent === "Версия" && box.querySelector("table tbody td")?.textContent === "1.21.0" && box.querySelectorAll("table tbody tr").length === 1);
  const real = await (await fetch("../RELEASE_NOTES.md", { cache: "no-store" })).text();
  const rb = document.createElement("div");
  rb.innerHTML = md.toHtml(real);
  check("Release notes: настоящий RELEASE_NOTES.md разбирается — заголовки, списки, таблицы", rb.querySelectorAll("h3").length >= 5 && rb.querySelectorAll("table").length >= 2 && rb.querySelectorAll("li").length >= 10);
}

// Формы полос «Эпик — история»: монохром, скобка у проекта, брусок у эпика, линия с точкой у истории.
{
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  const EPS = [{ key: "F-E", summary: "Эпик", statusName: "В работе", statusCategory: "indeterminate", omg: { project: { name: "Проект Ф", created: "2026-09-01T10:00:00Z" }, notes: [] } }];
  const L = (key) => ({ type: "Relates", key, typeName: "Задача" });
  const ISS = [
    { ...mk("F-S", "F-E", "AAA", "Ivan", null, 0, "prog"), typeName: "История", links: [L("F-1"), L("F-2"), L("F-3")] },
    { ...mk("F-1", "F-E", "AAA", "Ivan", 2, 4, "done"), typeName: "Задача", links: [] },
    { ...mk("F-2", "F-E", "AAA", "Ivan", 3, 4, "new"), typeName: "Задача", links: [] },
    { ...mk("F-3", "F-E", "AAA", "Ivan", 4, 4, "new"), typeName: "Задача", links: [] },
    { ...mk("F-4", "F-E", "AAA", "Ivan", 3, 2, "new"), typeName: "Задача", links: [] }
  ];
  const m = stories.buildStoryModel({ epics: EPS, issues: ISS, sprints, boards, storyTypes: ["история"], excludeTypes: ["история"], linkType: "Relates" });
  const box = document.createElement("div");
  document.body.append(box);
  sv.resetCollapse();
  sv.render(box, m, {});
  box.querySelector(".gantt-bar .link").click();
  const srow = box.querySelector('.s-story[data-story="F-S"]');
  const dots = [...srow.querySelectorAll(".sbar-dot")];
  check("Формы: у истории — тонкая линия, точка-начало только в первой секции с работой", srow.querySelectorAll(".sbar-s").length >= 2 && dots.length === 1 && dots[0].closest("td") === srow.querySelector(".sbar-s").closest("td") && Math.round(srow.querySelector(".sbar-track").getBoundingClientRect().height) === 2);
  check("Формы: точка-начало насыщенная, если в секции есть сделанное", dots[0].classList.contains("done"));
  check("Формы: у «Без истории» — линия без точки", !!box.querySelector(".s-nostory .sbar-s") && !box.querySelector(".s-nostory .sbar-dot"));
  const fillColor = getComputedStyle(srow.querySelector(".sbar-fill")).backgroundColor;
  const restColor = getComputedStyle(srow.querySelector(".sbar-track")).backgroundColor;
  const pfill = getComputedStyle(box.querySelector(".s-project .sbar-fill")).backgroundColor;
  const efill = getComputedStyle(box.querySelector(".s-epic .sbar-fill")).backgroundColor;
  check("Формы: один цвет на всех уровнях — сделанное одним синим, остаток бледным", fillColor === pfill && fillColor === efill && fillColor !== restColor && fillColor !== "rgb(34, 160, 107)", `${fillColor} / ${restColor}`);
  const prs = [...box.querySelectorAll(".s-project .sbar-p")];
  const capsOk = prs.every((pr) => {
    const w = parseFloat(pr.querySelector(".sbar-fill").style.width);
    return pr.querySelector(".cap-l").classList.contains("done") === w > 0 && pr.querySelector(".cap-r").classList.contains("done") === w >= 100;
  });
  check("Формы: уголок скобки насыщенный слева, если что-то сделано, справа — только если сделано всё", prs.length >= 2 && capsOk && prs.some((pr) => !pr.querySelector(".cap-r").classList.contains("done")), prs.map((pr) => pr.querySelector(".sbar-fill").style.width).join());
  box.remove();
}

// Направляющие дерева на «Эпик — история».
{
  const stories = await import("../src/js/stories.js");
  const sv = await import("../src/js/storiesView.js");
  const EPS = [
    { key: "T-E1", summary: "Эпик 1", statusName: "В работе", statusCategory: "indeterminate", omg: { project: { name: "П", created: "2026-09-01T10:00:00Z" }, notes: [] } },
    { key: "T-E2", summary: "Эпик 2", statusName: "В работе", statusCategory: "indeterminate", omg: { project: { name: "П", created: "2026-09-01T10:00:00Z" }, notes: [] } }
  ];
  const L = (key) => ({ type: "Relates", key, typeName: "Задача" });
  const ISS = [
    { ...mk("T-S1", "T-E1", "AAA", "Ivan", null, 0, "prog"), typeName: "История", links: [L("T-1")] },
    { ...mk("T-S2", "T-E1", "AAA", "Ivan", null, 0, "new"), typeName: "История", links: [] },
    { ...mk("T-1", "T-E1", "AAA", "Ivan", 2, 4, "new"), typeName: "Задача", links: [] },
    { ...mk("T-2", "T-E2", "AAA", "Ivan", 2, 4, "new"), typeName: "Задача", links: [] }
  ];
  const m = stories.buildStoryModel({ epics: EPS, issues: ISS, sprints, boards, storyTypes: ["история"], excludeTypes: ["история"], linkType: "Relates" });
  const box = document.createElement("div");
  document.body.append(box);
  sv.resetCollapse();
  sv.render(box, m, {});
  check("Дерево: у свёрнутого проекта направляющих нет", !box.querySelector(".s-guide"));
  box.querySelector(".gantt-bar .link").click();
  const gOf = (tr) => [...tr.querySelectorAll(".c-name > .s-guide")].map((g) => `${g.dataset.g}${g.classList.contains("s-guide-start") ? "^" : ""}`).join(",");
  const pr = box.querySelector(".s-project");
  const e1 = box.querySelector('.s-epic[data-epic="T-E1"]');
  const s1 = box.querySelector('.s-story[data-story="T-S1"]');
  check("Дерево: у проекта линия начинается от стрелки", gOf(pr) === "p:п^", gOf(pr));
  check("Дерево: у эпика — линия проекта и начало своей; у истории — обе линии без начала", gOf(e1) === "p:п,e:T-E1^" && gOf(s1) === "p:п,e:T-E1", `${gOf(e1)} | ${gOf(s1)}`);
  const lx = [...s1.querySelectorAll(".s-guide")].map((g) => Math.round(g.getBoundingClientRect().left - s1.querySelector(".c-name").getBoundingClientRect().left));
  check("Дерево: линии стоят на отступах проекта и эпика", lx.join() === "12,30", lx.join());
  s1.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  const hot = [...box.querySelectorAll(".s-guide.hot")];
  check("Дерево: наведение на историю подсвечивает линию её эпика во всём блоке, и только её", hot.length >= 3 && hot.every((g) => g.dataset.g === "e:T-E1"));
  box.querySelector("tbody").dispatchEvent(new MouseEvent("mouseleave"));
  check("Дерево: мышь ушла — подсветка снята", !box.querySelector(".s-guide.hot"));
  check("Дерево: между эпиками разделитель заметнее", getComputedStyle(e1.querySelector("td")).boxShadow !== "none");
  box.remove();
}

// Заметки на «По эпикам»: строка под эпиком, ✎ и «Сохранить как заметку» в окне 💬.
{
  const notesMod = await import("../src/js/notes.js");
  const ago = (d) => new Date(Date.now() - d * day).toISOString();
  const epicsN = [
    { key: "EP-1", summary: "Личный кабинет", statusName: "В работе", statusCategory: "indeterminate", omg: { project: null, notes: [{ id: "1", text: "Старая", created: ago(40), author: "Иван" }, { id: "2", text: "Бэкенд готов на 80%", created: ago(30), author: "Пётр" }] } },
    { key: "EP-2", summary: "Биллинг", statusName: "В работе", statusCategory: "indeterminate" }
  ];
  const mN = agg.buildModel({ issues, others: [], sprints, epics: epicsN, boards, mode: "epicPeople" });
  const box = document.createElement("div");
  document.body.append(box);
  const added = [];
  const toggles = [];
  const notes = { show: true, staleDays: 14, onToggle: (on) => toggles.push(on), onNoteAdded: async (kind, key, note) => added.push([kind, key, note]) };
  renderOpen(box, mN, { mode: "epicPeople", notes });
  const noteRows = [...box.querySelectorAll(".s-note")];
  check("По эпикам: строка заметки под эпиком с заметкой; у эпика без неё строки нет",
    noteRows.map((r) => r.dataset.note).join() === "EP-1" && noteRows[0].previousElementSibling.querySelector(".glabel").textContent.startsWith("EP-1"), noteRows.map((r) => r.dataset.note).join());
  check("По эпикам: в строке — текст, автор, дата, пометка «заметке N дн.» и «История (1)»",
    noteRows[0].textContent.includes("Бэкенд готов") && noteRows[0].querySelector(".s-note-who").textContent.includes("Пётр") &&
      noteRows[0].querySelector(".s-note-stale")?.textContent === t("note.stale", { n: 30 }) && noteRows[0].querySelector(".s-note-hist")?.textContent === t("note.history", { n: 1 }));
  check("По эпикам: строка заметки занимает все колонки шкалы", noteRows[0].children.length === mN.columns.length + 2);
  const cbN = box.querySelector(".gantt-bar .s-notes-toggle input");
  check("По эпикам: на панели галочка «Заметки», включена", !!cbN && cbN.checked);
  cbN.checked = false;
  cbN.dispatchEvent(new Event("change"));
  check("По эпикам: снятая галочка сообщает наружу", JSON.stringify(toggles) === "[false]");
  renderOpen(box, mN, { mode: "epicPeople", notes: { ...notes, show: false } });
  check("По эпикам: при выключенных заметках строк нет", !box.querySelector(".s-note"));

  // 💬 → «Сохранить как заметку»: комментарий уходит с кодовым словом и становится заметкой.
  renderOpen(box, mN, { mode: "epicPeople", notes });
  const sent = [];
  notesMod.api.addComment = async (key, text) => {
    sent.push([key, text]);
    return { id: "9", body: text, created: "2026-09-24T10:00:00.000+0300", author: { displayName: "Менеджер" } };
  };
  const plain = [];
  gantt.commentsApi.add = async (key, text) => plain.push([key, text]);
  gantt.commentsApi.list = async () => [];
  const row1 = [...box.querySelectorAll(".g-row.group")].find((r) => r.querySelector(".glabel").textContent.startsWith("EP-1"));
  row1.querySelector(".cmt-btn").click();
  await new Promise((r) => setTimeout(r, 30));
  const pop = document.querySelector(".tooltip.tip-comments");
  const chk = pop.querySelector(".cmt-asnote");
  check("💬: в окне комментариев есть «Сохранить как заметку», по умолчанию снята", !!chk && !chk.checked && pop.textContent.includes(t("cmt.asNote")));
  const taC = pop.querySelector(".cmt-input");
  taC.value = "Обычный комментарий";
  taC.dispatchEvent(new Event("input"));
  pop.querySelector(".cmt-save").click();
  await new Promise((r) => setTimeout(r, 30));
  check("💬: без галочки — обычный комментарий, заметка не добавляется",
    JSON.stringify(plain) === JSON.stringify([["EP-1", "Обычный комментарий"]]) && !sent.length && !added.length);
  taC.value = "Риск: ждём доступы";
  taC.dispatchEvent(new Event("input"));
  chk.checked = true;
  pop.querySelector(".cmt-save").click();
  await new Promise((r) => setTimeout(r, 30));
  check("💬: с галочкой — комментарий с кодовым словом (omg comment) и заметка с автором из Jira",
    JSON.stringify(sent) === JSON.stringify([["EP-1", "(omg comment)\nРиск: ждём доступы"]]) && added[0]?.[0] === "epic" && added[0][1] === "EP-1" && added[0][2].text === "Риск: ждём доступы" && added[0][2].author === "Менеджер",
    JSON.stringify([sent, added]));
  check("💬: после сохранения заметкой поле очищено и галочка снята", taC.value === "" && !chk.checked && pop.querySelector(".cmt-note").textContent === t("cmt.savedNote"));
  document.querySelector(".tooltip .tip-close")?.click();
  renderOpen(box, mN, { mode: "epicPeople" });
  check("По эпикам: без заметок в опциях ни строк, ни галочки, а 💬 без «заметки»", !box.querySelector(".s-note") && !box.querySelector(".s-notes-toggle"));
  box.remove();
}

const total = document.createElement("div");
total.className = failures ? "t-fail" : "t-ok";
total.textContent = failures ? `${failures} FAILED` : "ALL PASSED";
log.prepend(total);
