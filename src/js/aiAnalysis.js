// AI-анализ срока эпика (US-5): входы портфеля из данных плагина → расчёт (portfolio.js, US-4) →
// факторы и шаблонное объяснение → хранилище aiForecasts. Поправки LLM (US-8): блокировки по загрузке
// людей, дополнительные заглушки, коэффициент к приёмке, отсутствие заказчика. Текст объяснения от
// LLM (US-9) — только при «Новом анализе»; «Пересчитать» — шаблонный текст.
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as flowlib from "./flow.js";
import * as agg from "./agg.js";
import * as workcal from "./workcal.js";
import * as acceptance from "./acceptance.js";
import { flowTeamOf, dueMsOf } from "./analytics.js";
import { runPortfolio } from "./forecastClient.js";
import { sampleShare } from "./portfolio.js";
import { normName } from "./team.js";
import { isDoneStatus } from "./status.js";
import * as jira from "./jira.js";
import * as llm from "../llm/client.js";
import * as adjustments from "../llm/adjustments.js";
import * as explanation from "../llm/explanation.js";
import { t } from "./i18n.js";

const DAY = 86400000;
const RECENT_MS = 8 * 7 * DAY; // кто закрывал задачи эпика — за последние 8 недель

// Вес плана в доле потока — как столько закрытых задач (исходная оценка бета-распределения).
export const PLAN_WEIGHT = 10;

// Доля потока команды в эпике как Beta(a, b): история — k задач эпика из n задач команды в окне доли;
// исходная оценка — доля часов эпика в ближайших спринтах людей команды (plan, вес PLAN_WEIGHT), без
// плана — Beta(0,5; 0,5).
export function shareBeta(win, plan = null) {
  const k = win.done || 0;
  const n = win.total || 0;
  const p0 = plan == null ? 0.5 : plan;
  const m0 = plan == null ? 1 : PLAN_WEIGHT;
  return { a: p0 * m0 + k, b: (1 - p0) * m0 + Math.max(0, n - k) };
}

// Доля эпика в плане команд: часы задач эпика / все часы людей команды в ближайших секциях.
export function planAllocation({ issues, others = [], sectionSprints, teamIdOf, epicKey }) {
  const epic = new Map();
  const total = new Map();
  for (const i of [...issues, ...others]) {
    if (agg.isDone(i) || !sectionSprints.has(i.sprintId)) continue;
    const id = teamIdOf(i);
    if (id == null) continue;
    const h = agg.workEstimateOf(i);
    total.set(id, (total.get(id) || 0) + h);
    if (i.epicKey === epicKey) epic.set(id, (epic.get(id) || 0) + h);
  }
  const out = new Map();
  for (const [id, h] of total) if (h > 0) out.set(id, (epic.get(id) || 0) / h);
  return out;
}

const isBt = (status, s) => acceptance.btStatuses(s).includes(String(status || "").trim().toLowerCase());

// Бизнес-тест по плану заглушек: окно их спринтов { from, to } и сколько рабочих дней плана приходится
// на БТ — от конца последнего спринта с задачами разработки (devEnd) до конца окна. Заглушки, стоящие
// в спринтах параллельно с разработкой, срок не удлиняют. Разработки в спринтах нет или она
// кончается позже заглушек — всё окно.
export function stubWindow(stubs, sprints, devTasks = []) {
  const byId = new Map(sprints.map((sp) => [sp.id, sp]));
  const dated = (list) => list.map((i) => byId.get(i.sprintId)).filter((sp) => sp && sp.startDate && sp.endDate);
  const list = dated(stubs);
  if (!list.length) return null;
  const from = Math.min(...list.map((sp) => Date.parse(sp.startDate)));
  const to = Math.max(...list.map((sp) => Date.parse(sp.endDate)));
  const dev = dated(devTasks);
  const devEnd = dev.length ? Math.max(...dev.map((sp) => Date.parse(sp.endDate))) : null;
  // Разработка в плане есть: на БТ — хвост после неё; кончаются в одном спринте — БТ идёт внутри
  // него (days = 0), сверх разработки не добавляется.
  if (devEnd != null && devEnd > from) return { from, to, devEnd, days: devEnd < to ? workcal.workdaysBetween(devEnd, to) : 0 };
  const days = workcal.workdaysBetween(from, to);
  return days > 0 ? { from, to, devEnd: null, days } : null;
}

// Переносы между спринтами — из истории. Задачи одного эпика одной команды в одном спринте
// переносятся вместе (недобрала команда спринт — уезжает его хвост), поэтому единица — группа
// «эпик × команда × спринт, в котором задачи закрыли»: перенос группы — наибольшее «прошла спринтов − 1»
// среди её задач. Пулы по командам (если групп хватает) и общий.
// shortcut: хранится только последний спринт задачи — группа собирается по нему; открытая группа,
// уже переносившаяся, берёт ту же выборку, что и новая.
export function slipPools(issues, teamIdOf, { since = 0, min = 8 } = {}) {
  const groups = new Map();
  for (const i of issues) {
    if (!agg.isDone(i) || !(i.sprintCount > 0) || i.sprintId == null) continue;
    if (i.resolved && Date.parse(i.resolved) < since) continue;
    const team = teamIdOf(i);
    const key = `${i.epicKey}|${team}|${i.sprintId}`;
    const g = groups.get(key) || { team, k: 0 };
    g.k = Math.max(g.k, i.sprintCount - 1);
    groups.set(key, g);
  }
  const pools = { all: [] };
  for (const g of groups.values()) {
    pools.all.push(g.k);
    if (g.team != null) (pools[g.team] ||= []).push(g.k);
  }
  for (const id of Object.keys(pools)) if (id !== "all" && pools[id].length < min) delete pools[id];
  return pools;
}

// Входы расчёта. Чистая функция: данные плагина → аргументы portfolioForecast и сведения для факторов.
// adj — действующие поправки LLM (adjustments.effective, у блокировок уже есть weeks) или null.
// planShares — доля эпика в плане команд (planAllocation), исходная оценка доли потока.
export function buildInputs({ targetKey, epics, issues, flowRows, tempo = [], profiles = [], sprints = [], s, accItems = [], today = Date.now(), adj = null, planShares = null }) {
  const target = epics.find((e) => e.key === targetKey);
  if (!target) return { reason: "noEpic" };
  if (isDoneStatus(target.statusName, target.statusCategory)) return { reason: "done" };
  const signs = flowlib.stubSigns(s);
  const supportSigns = flowlib.supportSigns(s);
  const excludeTypes = flowlib.excludedTypes(s);
  const teamOf = flowTeamOf({ tempo, profiles });
  const teamIdOf = (i) => (i.assigneeName ? teamOf({ key: i.assigneeKey, login: i.assigneeLogin, name: i.assigneeName })?.id : null);
  // План (вариант «б»): задачи разработки эпика в спринтах с датами идут по плану с переносами из
  // истории, задачи без спринта — по темпу закрытий.
  const sprintById = new Map(sprints.map((sp) => [sp.id, sp]));
  const datedSprint = (i) => {
    const sp = sprintById.get(i.sprintId);
    return sp && sp.startDate && sp.endDate ? sp : null;
  };
  const weeks = Number(s.flowWeeks) || 52;
  const now = flowlib.mondayOf(today);
  const teamName = new Map();
  const teamFlow = new Map();
  const portfolio = [];
  let tModel = null;
  let tTeams = [];
  let tRemaining = 0;
  let tStubs = [];
  let tSupport = [];
  let tDev = [];
  let tLeft = new Map();
  let tPlanned = [];
  let tShares = new Map();
  for (const e of epics.filter((x) => !x.hidden && !isDoneStatus(x.statusName, x.statusCategory))) {
    // История потока — без заглушек и задач сопровождения.
    const model = flowlib.buildFlow({ rows: flowRows, teamOf, weeks, epicKey: e.key, excludeTypes, stubs: [...signs, ...supportSigns], now: today });
    const open = issues.filter((i) => i.epicKey === e.key && !agg.isDone(i) && !flowlib.isExcludedType(i.typeName, excludeTypes));
    const isTarget = e.key === targetKey;
    const llmStubs = new Set(isTarget && adj ? adj.stubs.map((x) => x.key) : []);
    const llmSupport = new Set(isTarget && adj ? (adj.support || []).map((x) => x.key) : []);
    const stubs = open.filter((i) => flowlib.isStub(i.summary, signs) || llmStubs.has(i.key));
    const support = open.filter((i) => !stubs.includes(i) && (flowlib.isStub(i.summary, supportSigns) || llmSupport.has(i.key)));
    const dev = open.filter((i) => !stubs.includes(i) && !support.includes(i));
    const planned = isTarget ? dev.filter(datedSprint) : [];
    const flowDev = dev.filter((i) => !planned.includes(i));
    const remaining = flowDev.length;
    const teams = model.teams.filter((x) => (x.byEpic.get(e.key) || 0) > 0);
    const epicDone = teams.reduce((n, x) => n + x.byEpic.get(e.key), 0);
    for (const x of teams) {
      teamName.set(x.team.id, x.team.name);
      teamFlow.set(x.team.id, x);
    }
    // Остаток по командам — по исполнителям открытых задач. Без исполнителя или из команды без
    // истории по эпику — делится по прошлому вкладу команд.
    const known = new Set(teams.map((x) => x.team.id));
    const byTeam = new Map();
    let pool = 0;
    for (const i of flowDev) {
      const id = teamIdOf(i);
      if (id != null && known.has(id)) byTeam.set(id, (byTeam.get(id) || 0) + 1);
      else pool += 1;
    }
    const slots = teams.map((x) => {
      const win = flowlib.shareWindow(flowlib.epicShare(x, e.key, { open: remaining > 0 }));
      const plan = isTarget && planShares && planShares.has(x.team.id) ? planShares.get(x.team.id) : null;
      return { team: x.team.id, remaining: (byTeam.get(x.team.id) || 0) + (pool * x.byEpic.get(e.key)) / epicDone, share: win.share, ...shareBeta(win, plan) };
    });
    portfolio.push({ key: e.key, slots });
    if (e.key === targetKey) {
      tModel = model;
      tTeams = teams;
      tRemaining = remaining;
      tStubs = stubs.map((i) => i.key);
      tSupport = support.map((i) => i.key);
      tDev = dev;
      tPlanned = planned;
      tLeft = new Map(slots.map((x) => [x.team, x.remaining]));
      tShares = new Map(slots.map((x) => [x.team, { a: x.a, b: x.b, plan: planShares && planShares.has(x.team) ? planShares.get(x.team) : null }]));
      for (const i of planned) {
        const id = teamIdOf(i);
        if (id != null && known.has(id)) tLeft.set(id, (tLeft.get(id) || 0) + 1);
      }
    }
  }

  // Окно истории — как у текущего прогноза эпика: от начала работы его команд, не короче 12 недель.
  const to = tModel.weeksCount - 1;
  const froms = tTeams.map((x) => flowlib.epicShare(x, targetKey, { open: tRemaining > 0 }).active?.from).filter((v) => v != null);
  const start = froms.length ? Math.min(...froms) : 0;
  const from = Math.max(0, Math.min(start, to - flowlib.FORECAST_OK_WEEKS + 1));
  const inBt = isBt(target.statusName, s);
  // Всё в плане — история потока не нужна.
  if (!inBt && tRemaining > 0 && to - from + 1 < flowlib.FORECAST_MIN_WEEKS) return { reason: "short" };
  const history = {};
  for (const [id, x] of teamFlow) history[id] = { perWeek: x.perWeek.slice(from, to + 1), starts: tModel.starts.slice(from, to + 1) };

  // Приёмка заказчика (постановщика эпика); эпик в БТ — от даты входа.
  const customer = normName(target.reporterName);
  const acc = accItems.length ? acceptance.customerStats(accItems, customer) : null;
  const open = accItems.find((x) => x.key === targetKey && x.btNow != null);
  // Нет завершённых приёмок ни у кого — бизнес-тест закладывается по окну задач-заглушек эпика:
  // от начала первого их спринта до конца последнего (менеджеры ставят заглушки на время БТ).
  const stubWin = stubWindow(issues.filter((i) => tStubs.includes(i.key)), sprints, tDev);
  const btSince = inBt ? (open ? open.btNow : today) : null;
  const tgt = portfolio.find((x) => x.key === targetKey);
  const pools = slipPools(issues, teamIdOf, { since: today - weeks * 7 * DAY });
  let plan = null;
  if (tPlanned.length) {
    // Одна запись на группу «команда × спринт»: её задачи переносятся вместе.
    const byGroup = new Map();
    for (const i of tPlanned) {
      const sp = datedSprint(i);
      const id = teamIdOf(i);
      const end = Date.parse(sp.endDate);
      byGroup.set(`${id}|${sp.id}`, { end, len: Math.max(7 * DAY, end - Date.parse(sp.startDate)), pool: id != null && pools[id] ? String(id) : "all", sprint: sp.name });
    }
    const tasks = [...byGroup.values()];
    const last = tasks.reduce((a, b) => (b.end > a.end ? b : a));
    plan = {
      planned: tPlanned.length,
      unplanned: tRemaining,
      end: last.end,
      sprint: last.sprint || "",
      slipPct: pools.all.length ? Math.round((pools.all.filter((k) => k > 0).length / pools.all.length) * 100) : null,
      slipN: pools.all.length
    };
    tgt.plan = { tasks: tasks.map(({ end, len, pool }) => ({ end, len, pool })), pools, today };
  }
  Object.assign(tgt, {
    inBt: btSince,
    inBtElapsed: btSince != null ? workcal.workdaysBetween(btSince, today) : 0,
    acceptance: acc && acc.all.length ? { own: acc.own, all: acc.all, n: acc.n } : stubWin && stubWin.days > 0 ? { own: [], all: [stubWin.days], n: 0 } : null,
    btFactor: adj ? adj.btFactor : 1,
    blockers: adj ? adj.blockers.filter((b) => b.weeks > 0).map((b) => ({ weeks: b.weeks, p: b.p })) : [],
    offDays: adj ? adjustments.absenceDays(adj.absence) : []
  });
  return {
    args: {
      epics: portfolio,
      history,
      target: targetKey,
      now,
      seed: targetKey,
      runs: 10000,
      dueMs: dueMsOf(target),
      cal: workcal.current(),
      overrides: { calendarOff: s.calendarOff || [], calendarWork: s.calendarWork || [] }
    },
    meta: { target, teams: tTeams, teamName, teamOf, history, remaining: tRemaining, stubs: tStubs, support: tSupport, left: tLeft, shareBeta: tShares, plan, acc: acc && acc.all.length ? acc : null, stubWindow: stubWin, customerName: target.reporterName || "", btSince, accEmpty: !accItems.length, adj }
  };
}

// Факторы срока (А5.1) — из расчёта и входов. Числа отсюда — единственные, которые видит объяснение.
export function buildFactors({ res, meta, flowRows, today = Date.now(), s }) {
  const key = meta.target.key;
  const since = today - RECENT_MS;
  const recent = flowRows.filter((r) => r.epicKey === key && r.resolved && Date.parse(r.resolved) >= since);
  const rnd = flowlib.seededRandom(`${key}:share`);
  const shares = meta.teams.map((x) => {
    const share = flowlib.forecastShare(flowlib.epicShare(x, key, { open: meta.remaining > 0 }));
    // Разброс доли в прогонах (5–95%) и доля по плану спринтов.
    const sb = meta.shareBeta && meta.shareBeta.get(x.team.id);
    let range = null;
    if (sb) {
      const draws = Array.from({ length: 2000 }, () => sampleShare(sb, rnd)).sort((p, q) => p - q);
      range = { lo: Math.round(draws[100] * 100), hi: Math.round(draws[1899] * 100), mean: Math.round((sb.a / (sb.a + sb.b)) * 100) };
    }
    const people = [...new Set(recent.filter((r) => meta.teamOf({ key: r.assigneeKey, login: r.assigneeLogin, name: r.assigneeName })?.id === x.team.id).map((r) => r.assigneeName))];
    // темп — медиана недель того же окна истории, что у прогноза
    const left = Math.round((meta.left.get(x.team.id) || 0) * 10) / 10;
    return { team: x.team.name || t("dash"), share: range ? range.mean : Math.round(share * 100), range, plan: sb && sb.plan != null ? Math.round(sb.plan * 100) : null, pace: flowlib.median(meta.history[x.team.id]?.perWeek || []), left, people };
  }).filter((x) => x.left > 0); // команды без оставшихся задач на срок не влияют
  const p95 = res.done.p95;
  let holidays = 0;
  for (let ms = today; ms < p95; ms += DAY) {
    const d = new Date(ms).getDay();
    if (d !== 0 && d !== 6 && !workcal.isWorkday(ms, workcal.current(), s)) holidays += 1;
  }
  const acc = meta.acc;
  const adj = meta.adj;
  return {
    dates: { dev: res.dev, done: res.done, chance: res.chance },
    remaining: { total: meta.remaining + (meta.plan ? meta.plan.planned : 0), stubs: meta.stubs.length, support: (meta.support || []).length },
    plan: meta.plan ? { ...meta.plan, share: res.planShare } : null,
    shares,
    last: res.last.map((x) => ({ team: meta.teamName.get(x.team) || x.team, pct: x.pct })),
    release: res.contributions.release,
    blockers: res.contributions.blockers,
    acceptance: {
      ...(acc
        ? { customer: meta.customerName, n: acc.n, median: acc.median, p95: acc.p95, returnRate: acc.returnRate == null ? null : Math.round(acc.returnRate * 100), noHistory: acc.n === 0 }
        : meta.stubWindow
          ? { customer: meta.customerName, stubs: { ...meta.stubWindow } }
          : { customer: meta.customerName, none: true }),
      btSince: meta.btSince,
      loadError: meta.accError || "",
      factor: adj && adj.btFactor !== 1 ? adj.btFactor : null,
      factorReason: adj && adj.btFactor !== 1 ? adj.btFactorReason : "",
      absence: adj ? adj.absence.filter((a) => a.p >= adjustments.ABSENCE_MIN_P).map((a) => ({ from: a.from, to: a.to, reason: a.reason })) : []
    },
    holidays,
    spread: Math.round((res.done.p95 - res.done.p50) / DAY),
    blockersAssessed: !!adj,
    blockerList: adj ? adj.blockers.map((b) => ({ epic: b.epic, people: b.people, sections: b.sectionNames, hours: Math.max(0, ...b.hours), weeks: Math.round(b.weeks * 10) / 10, p: Math.round(b.p * 100), reason: b.reason })) : [],
    llmStubs: adj ? adj.stubs.length : 0,
    notes: adj ? adj.notes : [],
    llmError: meta.llmError || ""
  };
}

const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "2-digit" });

// Шаблонное объяснение — без LLM (и запасной текст, если LLM ошибся).
export function templateText(f) {
  const out = [t("ai.tplDate", { done: fmt(f.dates.done.p95), dev: fmt(f.dates.dev.p95) })];
  out.push(t("ai.tplRemaining", { n: Math.round(f.remaining.total), stubs: f.remaining.stubs }));
  if (f.remaining.support) out.push(t("ai.tplSupport", { n: f.remaining.support }));
  if (f.plan) {
    const p = f.plan;
    out.push(t("ai.tplPlan", { end: fmt(p.end), sprint: p.sprint, pct: p.slipPct ?? 0, dev: fmt(f.dates.dev.p95) }));
    if (p.unplanned) out.push(t("ai.tplUnplanned", { n: p.unplanned }));
  }
  if (f.last.length && (!f.plan || f.plan.unplanned)) out.push(t("ai.tplLast", { team: f.last[0].team, pct: f.last[0].pct }));
  if (f.release) out.push(t("ai.tplRelease", { days: Math.abs(f.release) }));
  if (f.llmError) out.push(t("ai.tplLlmFailed"));
  if (!f.blockersAssessed) out.push(t("ai.tplNoBlockers"));
  else if (f.blockers) out.push(t("ai.tplBlockers", { days: f.blockers }));
  else out.push(t("ai.tplBlockersNone"));
  const a = f.acceptance;
  if (a.loadError) out.push(t("ai.tplAccError"));
  if (a.none) out.push(t("ai.tplNoAcceptance"));
  else if (a.stubs && a.stubs.days === 0) out.push(t("ai.tplAccStubsInside", { to: fmt(a.stubs.to) }));
  else if (a.stubs) out.push(a.stubs.devEnd ? t("ai.tplAccStubsTail", { dev: fmt(a.stubs.devEnd), to: fmt(a.stubs.to), days: a.stubs.days }) : t("ai.tplAccStubs", { from: fmt(a.stubs.from), to: fmt(a.stubs.to), days: a.stubs.days }));
  else if (a.noHistory) out.push(t("ai.tplAccGeneral", { customer: a.customer || t("dash") }));
  else out.push(t("ai.tplAcc", { customer: a.customer, n: a.n, median: a.median, p95: a.p95, ret: a.returnRate }));
  if (a.factor) out.push(t("ai.tplBtFactor", { f: a.factor, reason: a.factorReason || t("dash") }));
  for (const x of a.absence || []) out.push(t("ai.tplAbsence", { from: x.from, to: x.to }));
  if (f.holidays) out.push(t("ai.tplHolidays", { n: f.holidays }));
  out.push(t("ai.tplSpread", { days: f.spread }));
  return out.join(" ");
}

// Заглушки и задачи сопровождения от LLM по всем анализам (без отключённых): ключ задачи →
// { kind: "stub" | "support", reason }. Для пометки в списке задач.
export function llmStubs(results) {
  const out = new Map();
  for (const rec of results.values()) {
    const adj = adjustments.effective(rec.adjustments, rec.disabled);
    for (const x of adj ? adj.stubs : []) out.set(x.key, { kind: "stub", reason: x.reason });
    for (const x of adj ? adj.support : []) out.set(x.key, { kind: "support", reason: x.reason });
  }
  return out;
}

export async function getAll() {
  return new Map((await db.all(db.STORES.aiForecasts)).map((r) => [r.key, r]));
}

const ymd = workcal.ymd;
const hours = (sec) => Math.round((sec / 3600) * 10) / 10;

// Описание эпика и последние 30 комментариев эпика и его историй — из Jira при запуске анализа.
// Jira недоступна — анализ идёт без них.
async function readComments(keys) {
  const out = { description: "", comments: [], error: "" };
  try {
    for (let i = 0; i < keys.length; i += 50) {
      for (const row of await jira.search(`key in (${keys.slice(i, i + 50).join(",")})`, ["comment", "description"])) {
        const f = row.fields || {};
        if (row.key === keys[0]) out.description = String(f.description || "").slice(0, 3000);
        for (const c of (f.comment && f.comment.comments) || []) {
          out.comments.push({ issue: row.key, author: (c.author && c.author.displayName) || "", date: String(c.created || "").slice(0, 10), text: String(c.body || "").slice(0, 500) });
        }
      }
    }
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  }
  out.comments.sort((a, b) => b.date.localeCompare(a.date));
  out.comments = out.comments.slice(0, 30);
  return out;
}

// Входы запроса поправок (ТЗ А4). Чистая функция, кроме переданных комментариев.
export function llmPayload({ target, issues, epics, sprints = [], s, load, ctx, meta, extra, today = Date.now() }) {
  const signs = flowlib.stubSigns(s);
  const supportSigns = flowlib.supportSigns(s);
  const stories = flowlib.storyTypes(s);
  const excl = flowlib.excludedTypes(s);
  const own = issues.filter((i) => i.epicKey === target.key);
  const tasks = own.filter((i) => !flowlib.isExcludedType(i.typeName, excl));
  const sprintById = new Map(sprints.map((sp) => [sp.id, sp]));
  const stubTasks = tasks.filter((i) => flowlib.isStub(i.summary, signs));
  const stubSprints = stubTasks.map((i) => sprintById.get(i.sprintId)).filter((sp) => sp && sp.startDate && sp.endDate);
  const holidays = [];
  for (let ms = today; ms < today + 183 * DAY; ms += DAY) {
    const d = new Date(ms).getDay();
    if (d !== 0 && d !== 6 && !workcal.isWorkday(ms, workcal.current(), s)) holidays.push(ymd(ms));
  }
  const acc = meta.acc;
  return {
    today: ymd(today),
    epic: { key: target.key, summary: target.summary || "", description: extra.description, status: target.statusName || "", due: target.dueDate || "" },
    tasks: tasks.map((i) => ({
      key: i.key,
      summary: i.summary,
      status: i.statusName,
      done: agg.isDone(i),
      assignee: i.assigneeName || "",
      estimate_h: hours(agg.workEstimateOf(i)),
      sprint: i.sprintName || "",
      stub_by_settings: flowlib.isStub(i.summary, signs),
      support_by_settings: !flowlib.isStub(i.summary, signs) && flowlib.isStub(i.summary, supportSigns)
    })),
    stories: own.filter((i) => flowlib.isExcludedType(i.typeName, stories)).map((i) => ({ key: i.key, summary: i.summary, status: i.statusName })),
    comments: extra.comments,
    load: adjustments.loadRows(load, { people: ctx.people, target: target.key, portfolio: ctx.portfolio }),
    customer: {
      name: meta.customerName,
      acceptances: acc ? acc.n : 0,
      median_days: acc ? acc.median : null,
      p95_days: acc ? acc.p95 : null,
      return_rate_pct: acc && acc.returnRate != null ? Math.round(acc.returnRate * 100) : null,
      in_business_test_since: meta.btSince ? ymd(meta.btSince) : null
    },
    stub_window: stubSprints.length
      ? {
          from: ymd(Math.min(...stubSprints.map((sp) => Date.parse(sp.startDate)))),
          to: ymd(Math.max(...stubSprints.map((sp) => Date.parse(sp.endDate)))),
          estimate_h: hours(stubTasks.reduce((n, i) => n + agg.workEstimateOf(i), 0))
        }
      : null,
    portfolio: epics
      .filter((e) => ctx.portfolio.has(e.key))
      .map((e) => ({
        key: e.key,
        summary: e.summary || "",
        status: e.statusName || "",
        shared_people: [...new Set(issues.filter((i) => i.epicKey === e.key && ctx.people.has(agg.normPersonName(i.assigneeName))).map((i) => i.assigneeName))]
      })),
    holidays
  };
}

// Анализ эпика: данные из базы, приёмки из Jira (раз в сутки), поправки LLM (withLlm — «Новый анализ»;
// иначе прежние поправки с отметками пользователя), расчёт в фоновом потоке, сохранение.
export async function analyze(epicKey, { today = Date.now(), withLlm = false } = {}) {
  const s = settings.get();
  const [epics, issues, others, sprints, boards, flowRows, tempo, profiles, prev] = await Promise.all([
    db.all(db.STORES.epics),
    db.all(db.STORES.issues),
    db.all(db.STORES.others),
    db.all(db.STORES.sprints),
    db.all(db.STORES.boards),
    db.all(db.STORES.flow),
    db.all(db.STORES.tempo),
    db.all(db.STORES.people),
    db.getOne(db.STORES.aiForecasts, epicKey)
  ]);
  if (withLlm && !llm.hasKey(s)) throw new Error(t("ai.noKey"));
  let accItems = [];
  let accError = "";
  try {
    accItems = await acceptance.load();
  } catch (e) {
    accError = e && e.message ? e.message : String(e);
  }
  // Загрузка людей по ближайшим секциям — как на «По людям», с разбивкой по эпикам; доля эпика в
  // плане команд — исходная оценка доли потока.
  const excl = flowlib.excludedTypes(s);
  const model = agg.buildModel({ issues, others, sprints, epics, boards, tempo, profiles, mode: "assignee", timelineIssues: [...issues, ...others] });
  const load = agg.personLoad(model, issues, others, excl);
  const teamOfP = flowTeamOf({ tempo, profiles });
  const sectionSprints = new Set(model.columns.filter((c) => c.start != null).slice(0, agg.LOAD_SECTIONS).flatMap((c) => c.sprints.map((sp) => sp.id)));
  const planShares = planAllocation({
    issues: issues.filter((i) => !flowlib.isExcludedType(i.typeName, excl)),
    others: others.filter((i) => !flowlib.isExcludedType(i.typeName, excl)),
    sectionSprints,
    teamIdOf: (i) => (i.assigneeName ? teamOfP({ key: i.assigneeKey, login: i.assigneeLogin, name: i.assigneeName })?.id : null),
    epicKey
  });
  const common = { targetKey: epicKey, epics, issues, flowRows, tempo, profiles, sprints, s, accItems, today, planShares };
  const base = buildInputs(common);
  if (base.reason) throw new Error(t(`ai.reason.${base.reason}`));
  const tasks = issues.filter((i) => i.epicKey === epicKey && !flowlib.isExcludedType(i.typeName, excl));
  const people = new Map(tasks.filter((i) => i.assigneeName).map((i) => [agg.normPersonName(i.assigneeName), i.assigneeName]));
  const portfolio = new Set(base.args.epics.map((e) => e.key).filter((k) => k !== epicKey));
  const ctx = { portfolio, people, norm: agg.normPersonName, sections: new Map(load.sections.map((x) => [String(x.id), x.title])), openTasks: new Set(tasks.filter((i) => !agg.isDone(i)).map((i) => i.key)) };

  let raw = prev ? adjustments.stored(prev.adjustments) : null;
  let llmError = prev ? prev.llmError || "" : "";
  if (withLlm) {
    const storyTypes = flowlib.storyTypes(s);
    const keys = [epicKey, ...issues.filter((i) => i.epicKey === epicKey && flowlib.isExcludedType(i.typeName, storyTypes)).map((i) => i.key)];
    const extra = await readComments(keys);
    const target = epics.find((e) => e.key === epicKey);
    const got = await adjustments.request({ payload: llmPayload({ target, issues, epics, sprints, s, load, ctx, meta: base.meta, extra, today }), ctx, s });
    raw = got.adj;
    llmError = got.adj ? "" : t("ai.llmFailed", { msg: got.error });
  }
  const disabled = (prev && prev.disabled) || [];
  const adj = adjustments.effective(raw, disabled);
  if (adj) {
    const opts = { norm: agg.normPersonName, target: epicKey, portfolio, hoursPerDay: Number(s.hoursPerDay) || 8 };
    adj.blockers = adj.blockers.map((b) => ({ ...b, ...adjustments.blockerDelay(b, load, opts) }));
  }
  const input = adj ? buildInputs({ ...common, adj }) : base;
  input.meta.llmError = llmError;
  input.meta.accError = accError;
  const res = await runPortfolio(input.args);
  if (!res) throw new Error(t("ai.reason.noHistory"));
  const factors = buildFactors({ res, meta: input.meta, flowRows, today, s });
  let text = null;
  let textError = "";
  if (withLlm) {
    const got = await explanation.request({ factors, lang: s.lang, s });
    text = got.text;
    textError = got.error;
  }
  const rec = { key: epicKey, at: Date.now(), res, factors, text: text || templateText(factors), textByLlm: !!text, textError, adjustments: raw, disabled, llmError, accError };
  await db.putAll(db.STORES.aiForecasts, [rec]);
  return rec;
}

// «Не учитывать» у поправки: отметка сохраняется и действует в следующих анализах; срок пересчитывается
// без запроса к LLM.
export async function setDisabled(epicKey, id, off) {
  const prev = await db.getOne(db.STORES.aiForecasts, epicKey);
  if (!prev) return null;
  const set = new Set(prev.disabled || []);
  if (off) set.add(id);
  else set.delete(id);
  await db.putAll(db.STORES.aiForecasts, [{ ...prev, disabled: [...set] }]);
  return analyze(epicKey);
}
