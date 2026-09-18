// Правила «Сводки» (Б4): из состояния эпиков, истории и выгрузки — короткий список сигналов.
// Чистый модуль: без DOM, сети и настроек — всё приходит параметрами, тексты собирает интерфейс
// по типу сигнала (ключ словаря sig.<type>) и параметрам.
//
// Сигнал: { id, type, group, severity, rank, epicKey?, team?, person?, params }
//   group    — changes | near | late | resources | quality
//   severity — critical | warning | info
//   rank     — величина для сортировки внутри важности (сколько недель опоздания и т.п.)
import * as agg from "./agg.js";
import * as flowlib from "./flow.js";

const DAY = 86400000;
const WEEK = 7 * DAY;
export const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };
export const GROUPS = ["changes", "near", "late", "resources", "quality"];

const dayMs = (iso) => (iso ? Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso) : NaN);
const isDoneState = (st) => st.statusCategory === "done";

// Доля готового: по оценкам, а без оценок — по числу задач.
export function donePct(st) {
  if (st.estTotal > 0) return (st.estDone / st.estTotal) * 100;
  return st.total ? (st.done / st.total) * 100 : 0;
}

// Цвет эпика: зелёный / жёлтый / красный / без срока / готов / нет прогноза.
export function colorOf(st, th, now = Date.now()) {
  if (isDoneState(st)) return "done";
  if (!st.dueDate) return "nodue";
  if (dayMs(st.dueDate) + DAY <= now) return "red"; // срок прошёл
  if (st.chance == null) return "unknown";
  const pct = st.chance * 100;
  if (pct >= th.chanceGreen) return "green";
  if (pct >= th.chanceYellow) return "yellow";
  return "red";
}

// Рабочих дней между двумя моментами (без выходных), грубо — по календарным дням.
function workdaysBetween(from, to) {
  let n = 0;
  for (let t = from + DAY; t <= to; t += DAY) {
    const d = new Date(t).getDay();
    if (d !== 0 && d !== 6) n += 1;
  }
  return n;
}

export function computeSignals({
  current, // Map ключ эпика → состояние (последняя синхронизация)
  base = null, // Map ключ эпика → состояние (база сравнения) или null
  weekly = new Map(), // Map ключ эпика → недельные записи по возрастанию недели
  issues = [], // задачи выбранных эпиков
  others = [], // задачи людей в чужих эпиках
  flowRows = [], // история завершений
  teamOf = () => null, // человек { key, login, name } → команда (ручная → Tempo)
  teamSize = () => 0, // id команды → число участников
  load = null, // agg.personLoad: { capacity, byName, sections }
  model = null, // модель «По людям» (agg.buildModel, mode assignee): колонки и команды людей
  profiles = [], // профили вкладки «Команда»
  lastSync = 0,
  apiLimited = false,
  thresholds: th,
  excludeTypes = [],
  now = Date.now()
}) {
  const out = [];
  const add = (sig) => out.push({ rank: 0, params: {}, ...sig, id: [sig.type, sig.epicKey || "", sig.team || "", sig.person || ""].join("|") });
  const open = (i) => !agg.isDone(i) && !flowlib.isExcludedType(i.typeName, excludeTypes);
  const byEpic = new Map();
  for (const i of issues) {
    if (!byEpic.has(i.epicKey)) byEpic.set(i.epicKey, []);
    byEpic.get(i.epicKey).push(i);
  }
  const closedSince = (epicKey, ms) =>
    (byEpic.get(epicKey) || []).some((i) => {
      const c = agg.closedAt(i);
      return !!c && Date.parse(c) >= ms;
    });

  // ---------- 4.1 что изменилось ----------
  if (base) {
    for (const [key, st] of current) {
      const was = base.get(key);
      if (!was) {
        add({ type: "epicAdded", group: "changes", severity: "info", epicKey: key });
        continue;
      }
      if (isDoneState(st) && !isDoneState(was)) add({ type: "epicDone", group: "changes", severity: "info", epicKey: key });
      else if ((st.statusName || "") !== (was.statusName || "") && st.statusName && was.statusName) {
        add({ type: "status", group: "changes", severity: "info", epicKey: key, params: { from: was.statusName, to: st.statusName } });
      }
      const dTotal = st.total - was.total;
      const pctOf = (d, b) => (b > 0 ? (Math.abs(d) / b) * 100 : d ? 100 : 0);
      const dEst = st.estTotal - was.estTotal;
      if (dTotal > 0 && (dTotal >= th.scopeAbs || pctOf(dTotal, was.total) >= th.scopePct)) {
        add({ type: "scopeUp", group: "changes", severity: "warning", epicKey: key, rank: dTotal, params: { from: was.total, to: st.total, n: dTotal } });
      } else if (dEst > 0 && pctOf(dEst, was.estTotal) >= th.scopePct) {
        add({ type: "scopeUpEst", group: "changes", severity: "warning", epicKey: key, rank: Math.round(pctOf(dEst, was.estTotal)), params: { pct: Math.round(pctOf(dEst, was.estTotal)) } });
      } else if (dTotal < 0 && (-dTotal >= th.scopeAbs || pctOf(dTotal, was.total) >= th.scopePct)) {
        add({ type: "scopeDown", group: "changes", severity: "info", epicKey: key, rank: -dTotal, params: { from: was.total, to: st.total, n: -dTotal } });
      }
      if (st.p85 && was.p85) {
        const days = Math.round((dayMs(st.p85) - dayMs(was.p85)) / DAY);
        if (Math.abs(days) >= th.shiftDays) {
          add({
            type: days > 0 ? "shiftLater" : "shiftEarlier",
            group: "changes",
            severity: days > 0 ? "warning" : "info",
            epicKey: key,
            rank: Math.abs(days),
            params: { days: Math.abs(days), from: was.p85, to: st.p85 }
          });
        }
      }
      if ((st.dueDate || "") !== (was.dueDate || "")) {
        add({ type: "dueChanged", group: "changes", severity: "warning", epicKey: key, params: { from: was.dueDate || "", to: st.dueDate || "" } });
      }
      if ((st.carriedOver || 0) > (was.carriedOver || 0)) {
        add({ type: "carryNew", group: "changes", severity: "warning", epicKey: key, rank: st.carriedOver - (was.carriedOver || 0), params: { n: st.carriedOver - (was.carriedOver || 0) } });
      }
      if (st.done > was.done) add({ type: "progress", group: "changes", severity: "info", epicKey: key, rank: st.done - was.done, params: { n: st.done - was.done } });
    }
  }

  // ---------- 4.2 близко к завершению и 4.3 где опаздываем ----------
  for (const [key, st] of current) {
    if (isDoneState(st) || st.remaining <= 0) continue;
    const pct = donePct(st);
    const nearByForecast = st.p85 && dayMs(st.p85) - now <= th.nearWeeks * WEEK;
    const stalled = !closedSince(key, now - th.stallWeeks * WEEK);
    if (nearByForecast || pct >= th.nearDonePct) {
      add({ type: "near", group: "near", severity: "info", epicKey: key, rank: Math.round(pct), params: { pct: Math.round(pct), date: st.p85 || "" } });
    }
    if (pct >= th.nearDonePct && stalled) {
      add({ type: "stuckFinish", group: "near", severity: "warning", epicKey: key, rank: Math.round(pct), params: { pct: Math.round(pct), weeks: th.stallWeeks } });
    } else if (stalled && st.statusCategory === "indeterminate") {
      add({ type: "stall", group: "late", severity: "warning", epicKey: key, params: { weeks: th.stallWeeks } });
    }

    if (st.dueDate && dayMs(st.dueDate) + DAY <= now) {
      const days = Math.floor((now - dayMs(st.dueDate)) / DAY);
      add({ type: "overdue", group: "late", severity: "critical", epicKey: key, rank: days, params: { days, due: st.dueDate } });
    } else if (st.chance != null) {
      const chance = Math.round(st.chance * 100);
      const late = st.buffer != null && st.buffer < 0 ? -st.buffer : 0;
      if (chance < th.chanceYellow) {
        add({ type: "lowChance", group: "late", severity: "critical", epicKey: key, rank: 100 - chance + late, params: { chance, buffer: st.buffer } });
      } else if (chance < th.chanceGreen) {
        add({ type: "riskChance", group: "late", severity: "warning", epicKey: key, rank: 100 - chance, params: { chance, buffer: st.buffer } });
      }
    }

    // Запас тает: meltWeeks недель подряд снижался (нужно meltWeeks + 1 точек с запасом).
    const pts = (weekly.get(key) || []).filter((r) => r.buffer != null).slice(-(th.meltWeeks + 1));
    if (pts.length === th.meltWeeks + 1 && pts.every((r, i) => i === 0 || r.buffer < pts[i - 1].buffer)) {
      add({
        type: "melting",
        group: "late",
        severity: "warning",
        epicKey: key,
        rank: Math.round((pts[0].buffer - pts[pts.length - 1].buffer) * 10) / 10,
        params: { from: pts[0].buffer, to: pts[pts.length - 1].buffer, weeks: th.meltWeeks }
      });
    }
    if (st.carriedOver > 0) add({ type: "chronicCarry", group: "late", severity: "warning", epicKey: key, rank: st.carriedOver, params: { n: st.carriedOver, sprints: th.carrySprints } });
  }

  // ---------- 4.4 ресурсы ----------
  const colors = new Map([...current].map(([k, st]) => [k, colorOf(st, th, now)]));
  if (load && load.capacity > 0) {
    // Перегруз — единственный сигнал с именем человека.
    for (const [person, row] of load.byName) {
      let worst = null;
      for (const sec of load.sections) {
        const v = row.get(sec.id) || 0;
        if (v > load.capacity && (!worst || v > worst.v)) worst = { v, sec };
      }
      if (worst) {
        const pct = Math.round((worst.v / load.capacity) * 100);
        const display = displayName(person, issues, others);
        add({ type: "overload", group: "resources", severity: "warning", person: display, rank: pct, params: { person: display, pct, section: worst.sec.caption } });
      }
    }

    // Простой рядом с опозданием: загрузка команды в двух ближайших секциях низкая, а у жёлтого или
    // красного эпика есть незапланированные задачи людей этой команды.
    const secs = load.sections.slice(0, 2);
    const teamLoad = new Map();
    for (const [person, row] of load.byName) {
      const team = teamOf({ name: person });
      if (!team || !team.id) continue;
      const acc = teamLoad.get(team.id) || { team, sum: 0 };
      for (const sec of secs) acc.sum += row.get(sec.id) || 0;
      teamLoad.set(team.id, acc);
    }
    const backlogByTeam = new Map();
    for (const i of issues) {
      if (i.sprintId != null || !open(i) || agg.isOffSprintWork(i)) continue;
      const color = colors.get(i.epicKey);
      if (color !== "yellow" && color !== "red") continue;
      const team = teamOf({ key: i.assigneeKey, login: i.assigneeLogin, name: i.assigneeName });
      if (!team || !team.id) continue;
      const m = backlogByTeam.get(team.id) || { team, epics: new Map() };
      m.epics.set(i.epicKey, (m.epics.get(i.epicKey) || 0) + 1);
      backlogByTeam.set(team.id, m);
    }
    for (const [id, m] of backlogByTeam) {
      const members = teamSize(id);
      if (!members || !secs.length) continue;
      const sum = (teamLoad.get(id) || { sum: 0 }).sum;
      const pct = Math.round((sum / (members * load.capacity * secs.length)) * 100);
      if (pct >= th.idlePct) continue;
      const [epicKey, n] = [...m.epics].sort((a, b) => b[1] - a[1])[0];
      add({ type: "idleNearLate", group: "resources", severity: "warning", team: m.team.name, epicKey, rank: th.idlePct - pct, params: { team: m.team.name, pct, n } });
    }
  }

  // Распыление: поток команды за последние недели делится на слишком много эпиков.
  const since = now - th.spreadWeeks * WEEK;
  const teamWork = new Map();
  for (const r of flowRows) {
    if (!r.resolved || Date.parse(r.resolved) < since || flowlib.isExcludedType(r.typeName, excludeTypes)) continue;
    const team = teamOf({ key: r.assigneeKey, login: r.assigneeLogin, name: r.assigneeName });
    if (!team || !team.id) continue;
    const acc = teamWork.get(team.id) || { team, n: 0, epics: new Set() };
    acc.n += 1;
    if (r.epicKey) acc.epics.add(r.epicKey);
    teamWork.set(team.id, acc);
  }
  for (const acc of teamWork.values()) {
    const epics = acc.epics.size;
    if (epics < 2) continue;
    const perWeek = acc.n / th.spreadWeeks;
    const perEpic = perWeek / epics;
    if (perEpic < th.spreadFlow) {
      add({
        type: "spread",
        group: "resources",
        severity: "warning",
        team: acc.team.name,
        rank: epics,
        params: { team: acc.team.name, epics, perWeek: Math.round(perWeek * 10) / 10, perEpic: Math.round(perEpic * 10) / 10 }
      });
    }
  }

  // Узкое место: команда замыкает большинство прогонов в нескольких эпиках.
  const lastByTeam = new Map();
  for (const [key, st] of current) {
    if (isDoneState(st)) continue;
    for (const tm of st.teams || []) {
      if (tm.last < th.bottleneckPct) continue;
      const acc = lastByTeam.get(tm.id) || { name: tm.name, epics: [] };
      acc.epics.push(key);
      lastByTeam.set(tm.id, acc);
    }
  }
  for (const acc of lastByTeam.values()) {
    if (acc.epics.length >= 2) {
      add({ type: "bottleneck", group: "resources", severity: "warning", team: acc.name, rank: acc.epics.length, params: { team: acc.name, n: acc.epics.length, epics: acc.epics.join(", ") } });
    }
  }

  // Задачи у уволенных: открытые, в текущих/будущих спринтах или в бэклоге.
  const fired = new Set(profiles.filter((p) => p.status === "fired").map((p) => p.name));
  if (fired.size) {
    const timeline = new Set((model ? model.columns : []).flatMap((c) => c.sprints.map((s) => s.id)));
    const count = new Map();
    for (const i of [...issues, ...others]) {
      if (!open(i) || !i.assigneeName) continue;
      if (i.sprintId != null && !timeline.has(i.sprintId)) continue;
      const who = agg.normPersonName(i.assigneeName);
      if (!fired.has(who)) continue;
      count.set(i.assigneeName, (count.get(i.assigneeName) || 0) + 1);
    }
    for (const [person, n] of count) add({ type: "firedTasks", group: "resources", severity: "critical", person, rank: n, params: { person, n } });
  }

  // Задачи без исполнителя в текущем спринте.
  if (model && model.columns.length) {
    const currentSprints = new Set(model.columns[0].sprints.map((s) => s.id));
    const count = new Map();
    for (const i of issues) {
      if (!open(i) || i.assigneeKey || !currentSprints.has(i.sprintId)) continue;
      count.set(i.epicKey, (count.get(i.epicKey) || 0) + 1);
    }
    for (const [epicKey, n] of count) add({ type: "unassigned", group: "resources", severity: "warning", epicKey, rank: n, params: { n } });
  }

  // ---------- 4.5 качество данных ----------
  for (const [key, st] of current) {
    if (isDoneState(st)) continue;
    if (!st.dueDate) add({ type: "noDue", group: "quality", severity: "info", epicKey: key });
    const list = (byEpic.get(key) || []).filter((i) => !flowlib.isExcludedType(i.typeName, excludeTypes));
    const noEst = list.filter((i) => !agg.estimateOf(i)).length;
    if (list.length && (noEst / list.length) * 100 > th.noEstimatePct) {
      add({ type: "noEstimate", group: "quality", severity: "info", epicKey: key, rank: noEst, params: { pct: Math.round((noEst / list.length) * 100), n: noEst } });
    }
    if (st.remaining > 0 && st.reason === "short") add({ type: "shortHistory", group: "quality", severity: "info", epicKey: key, params: { weeks: st.historyWeeks } });
    else if (st.remaining > 0 && st.p85 && st.historyWeeks && st.historyWeeks < flowlib.FORECAST_OK_WEEKS) {
      add({ type: "roughHistory", group: "quality", severity: "info", epicKey: key, params: { weeks: st.historyWeeks } });
    }
  }
  if (model) {
    const noTeam = model.groups.filter((g) => !g.team || !g.team.id).map((g) => g.label);
    if (noTeam.length) add({ type: "noTeam", group: "quality", severity: "info", rank: noTeam.length, params: { n: noTeam.length, names: noTeam.slice(0, 5).join(", ") } });
  }
  if (lastSync && workdaysBetween(lastSync, now) > 3) {
    add({ type: "stale", group: "quality", severity: "warning", params: { days: workdaysBetween(lastSync, now) } });
  }
  if (apiLimited) add({ type: "apiLimited", group: "quality", severity: "info" });

  return out;
}

// Имя человека для текста: загрузка хранится по нормализованному имени, показываем как в Jira.
function displayName(norm, issues, others) {
  for (const i of [...issues, ...others]) if (i.assigneeName && agg.normPersonName(i.assigneeName) === norm) return i.assigneeName;
  return norm;
}

// «Требует внимания»: по важности, затем по величине; не больше limit.
export function attention(signals, limit = 7) {
  return [...signals]
    .filter((s) => s.severity !== "info")
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.rank - a.rank)
    .slice(0, limit);
}

// ---------- «Принято» ----------
// Принятый сигнал скрывается, пока его величина не ухудшится сверх порога: шанс упал ещё на
// 10 пунктов, опоздание выросло ещё на неделю и т. п. Для сигналов без величины — пока не
// поменялись их параметры. Исчезнувший и вернувшийся сигнал — новый случай: отметку снимаем.
export function ackDelta(type, th) {
  const d = {
    overdue: 7,
    lowChance: 10,
    riskChance: 10,
    melting: 1,
    shiftLater: th.shiftDays,
    scopeUp: th.scopeAbs,
    scopeUpEst: th.scopePct,
    carryNew: 1,
    chronicCarry: 1,
    overload: 10,
    idleNearLate: 10,
    spread: 1,
    bottleneck: 1,
    firedTasks: 1,
    unassigned: 1,
    noEstimate: 1
  };
  return type in d ? d[type] : null;
}

const paramsKey = (sig) => JSON.stringify(sig.params || {});

export function ackOf(sig) {
  return { rank: sig.rank, key: paramsKey(sig) };
}

export function isAcked(sig, acks, th) {
  const a = acks && acks[sig.id];
  if (!a) return false;
  const delta = ackDelta(sig.type, th);
  if (delta == null) return a.key === paramsKey(sig);
  return sig.rank < a.rank + delta;
}

// Отметки тех сигналов, которых больше нет, — убрать.
export function pruneAcks(acks, signals) {
  const ids = new Set(signals.map((s) => s.id));
  return Object.fromEntries(Object.entries(acks || {}).filter(([id]) => ids.has(id)));
}

// Новые для счётчика на вкладке: важность «внимание» и «критично», не приняты, не показаны при
// прошлом просмотре сводки.
export function freshCount(signals, acks, seenIds, th) {
  const seen = new Set(seenIds || []);
  return signals.filter((s) => s.severity !== "info" && !isAcked(s, acks, th) && !seen.has(s.id)).length;
}
