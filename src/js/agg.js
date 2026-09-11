// Агрегация: из задач и спринтов собираем модель для диаграммы Ганта.
//
// Колонки — не спринты, а ВРЕМЕННЫЕ СЕКЦИИ равной длины (шаг = типичная длина спринта),
// отсчитанные от начала текущего спринта. Спринт попадает в секцию по своей середине,
// поэтому спринты разных команд (досок), идущие параллельно, оказываются в одной колонке.
// Команда спринта = доска, на которой он заведён (другого понятия «команда» в Jira Server нет).
import { t } from "./i18n.js";
import * as settings from "./settings.js";
import { classify, isDoneStatus, isCancelledStatus } from "./status.js";

// ---------- оценки ----------

export function estimateOf(issue) {
  // Отменённые задачи в суммах дней не участвуют (в количестве — участвуют).
  if (isCancelledStatus(issue.statusName)) return 0;
  const f = settings.get().estimateField;
  if (f === "points") return Number(issue.storyPoints) || 0;
  if (f === "remaining") return Number(issue.remainingEstimate) || 0;
  return Number(issue.originalEstimate) || 0;
}

// Оценка оставшейся работы: «По людям» показывает загрузку, а не план, поэтому там берётся
// remaining estimate, если поле заполнено, и только при пустом — original estimate. Нулевой
// остаток — это заполненное поле: у доделанной задачи работы действительно не осталось.
// Для story points остатка в Jira нет — работает обычная оценка.
export function workEstimateOf(issue) {
  if (isCancelledStatus(issue.statusName)) return 0;
  if (settings.get().estimateField === "points") return Number(issue.storyPoints) || 0;
  const rem = issue.remainingEstimate;
  if (rem !== null && rem !== undefined && rem !== "") return Number(rem) || 0;
  return Number(issue.originalEstimate) || 0;
}

// Ёмкость спринта в единицах оценки: длительность спринта (рабочих дней) × часов в дне.
// Для story points сравнивать не с чем — возвращаем 0 (подсветка перегруза выключена).
export function sprintCapacity() {
  const s = settings.get();
  if (s.estimateField === "points") return 0;
  const days = Number(s.sprintDays) || 0;
  const hpd = Number(s.hoursPerDay) || 8;
  return days > 0 ? days * hpd * 3600 : 0;
}

export function isPoints() {
  return settings.get().estimateField === "points";
}

const round = (n, p = 1) => Math.round(n * 10 ** p) / 10 ** p;

export function fmtEstimate(value) {
  if (!value) return t("dash");
  if (isPoints()) return `${round(value, 2)} ${t("unit.sp")}`;
  const hpd = Number(settings.get().hoursPerDay) || 8;
  const hours = value / 3600;
  if (hours >= hpd) return `${round(hours / hpd, 1)}${t("unit.d")}`;
  return `${round(hours, 1)}${t("unit.h")}`;
}

// Категории статуса может не быть (задача из старой выгрузки) — тогда решаем по названию.
export function isDone(issue) {
  return isDoneStatus(issue.statusName, issue.statusCategory);
}

// ---------- спринты и время ----------

const DAY = 86400000;
const ts = (s) => (s ? Date.parse(s) || null : null);
const startOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

function sortSprints(list) {
  return [...list].sort((a, b) => {
    const as = ts(a.startDate);
    const bs = ts(b.startDate);
    if (as && bs && as !== bs) return as - bs;
    if (as && !bs) return -1;
    if (!as && bs) return 1;
    return a.id - b.id;
  });
}

const isClosed = (s) => s.state === "CLOSED" || !!s.completeDate;

// Текущий спринт: активный (по датам, если активных несколько), иначе тот, в чьи даты попадает
// сегодня, иначе ближайший будущий.
export function currentSprint(sprints) {
  const now = Date.now();
  const inRange = (s) => {
    const a = ts(s.startDate);
    const b = ts(s.endDate);
    return a && b && a <= now && now <= b;
  };
  const active = sortSprints(sprints.filter((s) => s.state === "ACTIVE"));
  return (
    active.find(inRange) ||
    active[0] ||
    sortSprints(sprints).find(inRange) ||
    sortSprints(sprints.filter((s) => !isClosed(s) && (ts(s.startDate) || 0) > now))[0] ||
    null
  );
}

// Типичная длина спринта в днях — самая частая среди спринтов с датами (по умолчанию 14).
export function sprintStepDays(sprints) {
  const freq = new Map();
  for (const s of sprints) {
    const a = ts(s.startDate);
    const b = ts(s.endDate);
    if (!a || !b || b <= a) continue;
    const d = Math.max(1, Math.round((b - a) / DAY));
    freq.set(d, (freq.get(d) || 0) + 1);
  }
  let best = 14;
  let bestN = 0;
  for (const [d, n] of freq) {
    if (n > bestN || (n === bestN && d < best)) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

export const NO_DATES_ID = "sec:nodate";

// Секции от текущего спринта в будущее; хвост секций без задач отбрасываем, а пустые
// секции между занятыми оставляем — шкала времени должна быть честной.
export function timeline(sprints, issues, now = Date.now()) {
  const cur = currentSprint(sprints);
  if (!cur) return [];
  const stepDays = sprintStepDays(sprints);
  const step = stepDays * DAY;
  const today = startOfDay(now);
  const dayOf = (v) => (ts(v) != null ? startOfDay(ts(v)) : null);

  // Идущие сегодня спринты (по дням, конец включительно): у команд они сдвинуты друг относительно
  // друга, поэтому точка отсчёта секций — начало самого раннего из них типовой длины. Так недельный
  // спринт одной команды не сдвигает шкалу для всех остальных.
  const running = sprints.filter((s) => {
    if (isClosed(s)) return false;
    const a = dayOf(s.startDate);
    const b = dayOf(s.endDate);
    return a != null && b != null && a <= today && today <= b;
  });
  const typical = running.filter((s) => Math.round((dayOf(s.endDate) - dayOf(s.startDate)) / DAY) === stepDays);
  const anchors = typical.length ? typical : running;
  const origin = anchors.length ? Math.min(...anchors.map((s) => dayOf(s.startDate))) : startOfDay(ts(cur.startDate) || now);

  // Кандидаты: незакрытые спринты, не завершившиеся до сегодня (закончившийся вчера, но не закрытый
  // в Jira, на график не идёт), плюс спринты без дат.
  const candidates = sprints.filter((s) => {
    if (isClosed(s)) return false;
    const b = dayOf(s.endDate);
    return b == null || b >= today;
  });

  const byIndex = new Map();
  let noDates = null;
  for (const s of sortSprints(candidates)) {
    const a = dayOf(s.startDate);
    const b = dayOf(s.endDate);
    if (a == null) {
      noDates = noDates || { id: NO_DATES_ID, index: Infinity, start: null, end: null, sprints: [] };
      noDates.sprints.push(s);
      continue;
    }
    // Всё, что идёт сегодня, — в «текущем»; остальное — по середине спринта относительно отсчёта.
    const isRunning = a <= today && (b == null || today <= b);
    const mid = b != null && b > a ? (a + b) / 2 : a;
    const index = isRunning ? 0 : Math.max(0, Math.floor((mid - origin) / step));
    if (!byIndex.has(index)) {
      byIndex.set(index, { id: `sec:${index}`, index, start: origin + index * step, end: origin + (index + 1) * step, sprints: [] });
    }
    byIndex.get(index).sprints.push(s);
  }

  const used = new Set(issues.map((i) => i.sprintId).filter((v) => v != null));
  const hasIssues = (sec) => sec.sprints.some((s) => used.has(s.id));
  let last = 0;
  for (const sec of byIndex.values()) if (hasIssues(sec)) last = Math.max(last, sec.index);

  const sections = [];
  for (let i = 0; i <= last; i++) {
    sections.push(
      byIndex.get(i) || { id: `sec:${i}`, index: i, start: origin + i * step, end: origin + (i + 1) * step, sprints: [] }
    );
  }
  if (noDates && hasIssues(noDates)) sections.push(noDates);
  for (const sec of sections) sec.label = sectionLabel(sec);
  return sections;
}

// ---------- команды ----------

const TEAM_COLORS = 8;

// Команды = доски: у каждой свой цвет (индекс палитры), безкомандные спринты — серые.
// Слова, которые не могут быть именем команды: служебные и любые числа/даты.
const SPRINT_STOP = /^(sprint\d*|спринт[а-яё]*|служебн[а-яё]*|доска|board|the)$/i;
const isNumberish = (w) => /^[\d.,/-]+$/.test(w);

// Имя доски из названий её спринтов: у команд оно обычно зашито в название
// («20.2026 WEB[08.10 - 21.10]» → WEB). Берём слово, которое встречается чаще других.
export function nameFromSprints(names) {
  const freq = new Map();
  for (const raw of names) {
    const clean = String(raw || "")
      .replace(/\[[^\]]*\]/g, " ") // диапазоны дат в скобках
      .replace(/[()«»"'|]/g, " ")
      .trim();
    const seen = new Set();
    for (const word of clean.split(/[\s,;:_—–-]+/)) {
      const w = word.trim();
      if (w.length < 2 || isNumberish(w) || SPRINT_STOP.test(w) || !/[\p{L}]/u.test(w)) continue;
      const key = w.toLowerCase();
      if (seen.has(key)) continue; // одно слово — один голос от спринта
      seen.add(key);
      if (!freq.has(key)) freq.set(key, { word: w, count: 0 });
      freq.get(key).count += 1;
    }
  }
  const best = [...freq.values()].sort(
    (a, b) => b.count - a.count || b.word.length - a.word.length || a.word.localeCompare(b.word)
  )[0];
  return best ? best.word : "";
}

// Команды Tempo: соответствие человек → команда. Ключ, логин и имя — три способа найти,
// потому что в задачах Jira отдаёт то одно, то другое.
export function buildTempoIndex(tempo) {
  const byKey = new Map();
  const byLogin = new Map();
  const byName = new Map();
  const teams = new Map();
  const size = new Map();
  const norm = (v) => String(v || "").trim().toLowerCase().replace(/ё/g, "е");
  const add = (map, id, team) => {
    if (!id) return;
    if (!map.has(id)) map.set(id, []);
    if (!map.get(id).includes(team)) map.get(id).push(team);
  };
  [...tempo]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .forEach((tm, i) => {
      const team = { id: `t:${tm.id}`, name: tm.name, color: i % TEAM_COLORS, tempo: true, members: (tm.members || []).length };
      teams.set(team.id, team);
      size.set(team.id, (tm.members || []).length);
      for (const m of tm.members || []) {
        add(byKey, m.key, team);
        add(byLogin, m.login, team);
        add(byName, norm(m.name), team);
      }
    });
  // Человек может числиться в нескольких командах: берём самую малочисленную — она конкретнее,
  // а команда «по умолчанию» обычно самая большая.
  const of = (person) => {
    if (!person) return null;
    const found = [
      ...(byKey.get(person.key) || []),
      ...(byLogin.get(person.login) || []),
      ...(byName.get(norm(person.name)) || [])
    ];
    if (!found.length) return null;
    return [...new Set(found)].sort((a, b) => size.get(a.id) - size.get(b.id) || a.name.localeCompare(b.name))[0];
  };
  return { teams, of, size: teams.size };
}

function buildTeams(sprints, boards) {
  const boardName = new Map(boards.map((b) => [String(b.id), b.name]));
  const byBoard = new Map();
  for (const s of sprints) {
    if (!s.boardId) continue;
    const id = String(s.boardId);
    if (!byBoard.has(id)) byBoard.set(id, []);
    byBoard.get(id).push(s.name);
  }
  const teams = new Map();
  [...byBoard.keys()]
    .map((id) => {
      const known = boardName.get(id);
      if (known) return { id, name: known, derived: false };
      // Доска недоступна или удалена — выводим имя из названий её спринтов.
      const guess = nameFromSprints(byBoard.get(id));
      return guess
        ? { id, name: guess, derived: true, hint: t("gantt.teamFromSprints", { id }) }
        : { id, name: `#${id}`, derived: false };
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((tm, i) => teams.set(tm.id, { ...tm, color: i % TEAM_COLORS }));
  const none = { id: "", name: t("gantt.noTeam"), color: -1 };
  return { teams, none, of: (sprint) => (sprint && sprint.boardId ? teams.get(String(sprint.boardId)) : null) || none };
}

// ---------- модель ----------

// Ячейка хранит и список задач — для всплывающего окна по клику на полосу.
function emptyCell() {
  return { count: 0, sum: 0, bySprint: new Map(), issues: [] };
}

function addTo(cell, sprintId, est, brief) {
  cell.count += 1;
  cell.sum += est;
  cell.issues.push(brief);
  if (sprintId == null) return;
  if (!cell.bySprint.has(sprintId)) cell.bySprint.set(sprintId, { count: 0, sum: 0, issues: [] });
  const part = cell.bySprint.get(sprintId);
  part.count += 1;
  part.sum += est;
  part.issues.push(brief);
}

// Краткая карточка задачи для списков.
function briefOf(issue, est, done) {
  return {
    key: issue.key,
    summary: issue.summary || "",
    statusName: issue.statusName || "",
    statusCategory: issue.statusCategory || "",
    assigneeName: issue.assigneeName || "",
    sprintName: issue.sprintName || "",
    sprintId: issue.sprintId ?? null,
    estimate: est,
    done
  };
}

export const BACKLOG_ID = "sec:backlog";

// mode: "epicPeople" (эпики → исполнители, вкладка «По эпикам») | "assignee" (люди → проекты);
// others — задачи людей вне целевых эпиков (учитываются только по людям).
// timelineIssues — по каким задачам строить шкалу времени. Передаётся вся выгрузка, чтобы шкала
// была одинаковой на всех вкладках и не менялась от фильтров.
export function buildModel({ issues, others = [], sprints, epics, boards = [], tempo = [], mode, timelineIssues = null }) {
  const epicLike = mode !== "assignee"; // группы — эпики
  // «По людям» — про загрузку: берём остаток, если он проставлен, иначе исходную оценку.
  const estOf = mode === "assignee" ? workEstimateOf : estimateOf;
  const teamsInfo = buildTeams(sprints, boards);
  const tempoInfo = buildTempoIndex(tempo);
  const sprintById = new Map(sprints.map((s) => [s.id, s]));
  const columns = timeline(sprints, timelineIssues || [...issues, ...others]);
  // Внутри секции спринты идут по командам, чтобы цвета в колонке не перемешивались.
  for (const sec of columns) {
    sec.sprints.sort((a, b) => teamsInfo.of(a).name.localeCompare(teamsInfo.of(b).name) || a.id - b.id);
  }
  const sectionOfSprint = new Map();
  for (const sec of columns) for (const s of sec.sprints) sectionOfSprint.set(s.id, sec.id);

  const epicById = new Map(epics.map((e) => [e.key, e]));
  const groups = new Map();
  const groupKeyOf = (i) => (epicLike ? i.epicKey || "" : i.assigneeKey || "");
  // Вложенная строка: проект (epic/assignee) или исполнитель (epicPeople).
  // Подпись эпика: ключ + Epic Name (или название, если поле пустое).
  const epicLabel = (key) => {
    const e = epicById.get(key);
    return key ? `${key} · ${e?.epicName || e?.summary || ""}`.trim() : t("dash");
  };
  // Вложенная строка: исполнитель (по эпикам) или эпик (по людям).
  const childOf = (i) =>
    mode === "epicPeople"
      ? { key: i.assigneeKey || "", label: i.assigneeName || t("gantt.noAssignee") }
      : { key: i.epicKey || "", label: epicLabel(i.epicKey || "") };
  // Подпись эпика — Epic Name; если поле пустое или не найдено в Jira — название эпика.
  const groupLabelOf = (i) => {
    if (epicLike) {
      const k = i.epicKey || "";
      if (!k) return t("dash");
      return epicLabel(k);
    }
    return i.assigneeName || t("gantt.noAssignee");
  };

  for (const issue of issues) {
    const gk = groupKeyOf(issue);
    if (!groups.has(gk)) {
      const epic = epicLike ? epicById.get(gk) : null;
      const cls = epic ? classify(epic.statusName, epic.statusCategory) : null;
      groups.set(gk, {
        key: gk,
        label: groupLabelOf(issue),
        status: epic ? { name: epic.statusName || "", category: epic.statusCategory || "", id: cls.id } : null,
        statusRank: cls ? cls.rank : 0,
        dueDate: epic ? epic.dueDate || "" : "", // срок исполнения эпика — веха на диаграмме
        login: mode === "assignee" ? issue.assigneeLogin || "" : "",
        team: null,
        teamVotes: new Map(),
        count: 0,
        done: 0,
        other: 0,
        sum: 0,
        noSprint: 0,
        // Реальные названия статусов из загруженных задач — из них строятся ссылки на JQL.
        doneStatuses: new Set(),
        openStatuses: new Set(),
        cells: new Map(),
        // Бэклог: задачи без спринта и не в статусе «Готово».
        backlog: emptyCell(),
        projects: new Map(),
        // Прочие эпики человека: итоги, ячейки по секциям и разбивка по эпикам.
        otherCount: 0,
        otherSum: 0,
        otherCells: new Map(),
        otherEpics: new Map()
      });
    }
    const g = groups.get(gk);
    const est = estOf(issue);
    const done = isDone(issue);
    g.count += 1;
    g.sum += est;
    done ? (g.done += 1) : (g.other += 1);
    const statusName = (issue.statusName || "").trim();
    if (statusName) (done ? g.doneStatuses : g.openStatuses).add(statusName);

    const child = childOf(issue);
    const pk = child.key;
    if (!g.projects.has(pk)) {
      // issues — все задачи строки (и вне таймлайна): для остатка работы в критическом пути.
      g.projects.set(pk, {
        key: pk,
        label: child.label,
        // target — эпик отмечен галочкой на «Поиске» (для подсветки на вкладке «По людям»)
        target: mode === "assignee" ? !!epicById.get(pk) && !epicById.get(pk).hidden : false,
        count: 0,
        sum: 0,
        noSprint: 0,
        cells: new Map(),
        backlog: emptyCell(),
        issues: []
      });
    }
    const p = g.projects.get(pk);
    p.count += 1;
    p.sum += est;

    const brief = briefOf(issue, est, done);
    p.issues.push(brief);
    if (issue.sprintId == null) {
      // Выполненную задачу вне спринта считать нечего — в бэклог идут только незакрытые.
      if (!done) {
        g.noSprint += 1;
        p.noSprint += 1;
        addTo(g.backlog, null, est, brief);
        addTo(p.backlog, null, est, brief);
      }
      continue; // задачи вне спринтов на секции не влияют
    }

    // Команда человека — доска, где лежит больше всего его задач (включая закрытые спринты).
    const team = teamsInfo.of(sprintById.get(issue.sprintId));
    if (team.id) g.teamVotes.set(team.id, (g.teamVotes.get(team.id) || 0) + 1);

    const secId = sectionOfSprint.get(issue.sprintId);
    if (!secId) continue; // прошлые спринты вне таймлайна
    for (const bag of [g.cells, p.cells]) {
      if (!bag.has(secId)) bag.set(secId, emptyCell());
      addTo(bag.get(secId), issue.sprintId, est, brief);
    }
  }

  if (mode === "assignee") {
    for (const issue of others) {
      const g = groups.get(issue.assigneeKey || "");
      if (!g) continue; // людей берём только из целевых эпиков
      const est = estOf(issue);
      g.otherCount += 1;
      g.otherSum += est;
      const ek = issue.epicKey || "";
      if (!g.otherEpics.has(ek)) g.otherEpics.set(ek, { key: ek, summary: issue.epicSummary || "", count: 0, sum: 0 });
      const oe = g.otherEpics.get(ek);
      oe.count += 1;
      oe.sum += est;
      if (issue.sprintId == null) continue;
      const team = teamsInfo.of(sprintById.get(issue.sprintId));
      if (team.id) g.teamVotes.set(team.id, (g.teamVotes.get(team.id) || 0) + 1);
      const secId = sectionOfSprint.get(issue.sprintId);
      if (!secId) continue;
      const brief = briefOf(issue, est, isDone(issue));
      if (!g.otherCells.has(secId)) g.otherCells.set(secId, emptyCell());
      addTo(g.otherCells.get(secId), issue.sprintId, est, brief);
      // Прочие эпики показываем такими же вложенными строками, как целевые.
      if (!g.projects.has(ek)) {
        g.projects.set(ek, {
          key: ek,
          label: ek ? `${ek} · ${issue.epicSummary || ""}`.trim() : t("gantt.noEpic"),
          target: false,
          count: 0,
          sum: 0,
          noSprint: 0,
          cells: new Map(),
          backlog: emptyCell(),
          issues: []
        });
      }
      const op = g.projects.get(ek);
      op.count += 1;
      op.sum += est;
      op.issues.push(brief);
      if (!op.cells.has(secId)) op.cells.set(secId, emptyCell());
      addTo(op.cells.get(secId), issue.sprintId, est, brief);
    }
  }

  // «По эпикам и людям»: внутри эпика показываем только людей с задачами в секциях диаграммы
  // (текущий и будущие спринты) или в бэклоге (без спринта, не готово). Итоги эпика — по всем задачам.
  if (mode === "epicPeople") {
    for (const g of groups.values()) {
      for (const [key, p] of g.projects) if (!p.cells.size && !p.backlog.count) g.projects.delete(key);
    }
  }
  // «По людям»: внутри человека — только эпики с задачами в текущем/будущих спринтах или в
  // бэклоге; сами люди без такой работы с вкладки убираются.
  if (mode === "assignee") {
    for (const [key, g] of groups) {
      for (const [pk, p] of g.projects) if (!p.cells.size && !p.backlog.count) g.projects.delete(pk);
      if (!g.cells.size && !g.otherCells.size && !g.backlog.count) groups.delete(key);
    }
  }

  const list = [...groups.values()].map((g) => {
    // Команда человека: из Tempo, если он там числится; иначе по доске, где больше его задач.
    let team = tempoInfo.of({ key: g.key, login: g.login, name: g.label }) || teamsInfo.none;
    let best = 0;
    if (team === teamsInfo.none) {
      for (const [id, n] of g.teamVotes) {
        if (n > best) {
          best = n;
          team = teamsInfo.teams.get(id) || teamsInfo.none;
        }
      }
    }
    return {
      ...g,
      team: mode === "assignee" ? team : null,
      projects: [...g.projects.values()].sort((a, b) => Number(b.target) - Number(a.target) || b.sum - a.sum || b.count - a.count),
      otherEpics: [...g.otherEpics.values()].sort((a, b) => b.sum - a.sum || b.count - a.count)
    };
  });

  if (epicLike) {
    // Эпики: сначала то, что в работе и на бизнес-тесте, ниже — «сделать» и «new», в самом низу готовое.
    list.sort((a, b) => a.statusRank - b.statusRank || b.sum - a.sum || b.count - a.count);
  } else {
    // Люди: по командам (безкомандные в конце), внутри команды — по объёму работы.
    const teamOrder = (g) => (g.team.id ? g.team.name : "￿");
    list.sort((a, b) => teamOrder(a).localeCompare(teamOrder(b)) || b.sum - a.sum || b.count - a.count);
  }

  // Максимум по ячейкам проектов — для относительной заливки полос.
  let max = 0;
  for (const g of list) {
    for (const p of g.projects) {
      for (const c of p.cells.values()) max = Math.max(max, c.sum || c.count);
      max = Math.max(max, p.backlog.sum || p.backlog.count);
    }
    for (const c of g.otherCells.values()) max = Math.max(max, c.sum || c.count);
  }

  const visibleTeams = new Map();
  for (const sec of columns) for (const s of sec.sprints) {
    const tm = teamsInfo.of(s);
    visibleTeams.set(tm.id, tm);
  }

  return {
    columns,
    groups: list,
    maxCell: max,
    currentId: columns.length ? columns[0].id : null,
    teams: [...visibleTeams.values()],
    teamOf: teamsInfo.of,
    teamOfSprint: (id) => teamsInfo.of(sprintById.get(id)),
    sprintById,
    targetKeys: epics.map((e) => e.key),
    childKind: mode === "epicPeople" ? "person" : "epic"
  };
}

export function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(+d)) return "";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" });
}

// Подпись секции: «31.08 – 13.09»; секция без дат — словами.
export function sectionLabel(sec) {
  if (sec.id === NO_DATES_ID) return t("gantt.noDates");
  return `${fmtDate(new Date(sec.start).toISOString())} – ${fmtDate(new Date(sec.end - 1).toISOString())}`;
}
