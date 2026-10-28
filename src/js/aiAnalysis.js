// AI-анализ срока эпика (US-5): входы портфеля из данных плагина → расчёт (portfolio.js, US-4) →
// факторы и шаблонное объяснение → хранилище aiForecasts. Поправки LLM (US-8) и текст LLM (US-9) —
// следующие этапы: здесь у них уже есть место (adjustments, text).
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as flowlib from "./flow.js";
import * as agg from "./agg.js";
import * as workcal from "./workcal.js";
import * as acceptance from "./acceptance.js";
import { flowTeamOf, dueMsOf } from "./analytics.js";
import { runPortfolio } from "./forecastClient.js";
import { normName } from "./team.js";
import { isDoneStatus } from "./status.js";
import { t } from "./i18n.js";

const DAY = 86400000;
const RECENT_MS = 8 * 7 * DAY; // кто закрывал задачи эпика — за последние 8 недель

const isBt = (status, s) => acceptance.btStatuses(s).includes(String(status || "").trim().toLowerCase());

// Входы расчёта. Чистая функция: данные плагина → аргументы portfolioForecast и сведения для факторов.
export function buildInputs({ targetKey, epics, issues, flowRows, tempo = [], profiles = [], s, accItems = [], today = Date.now() }) {
  const target = epics.find((e) => e.key === targetKey);
  if (!target) return { reason: "noEpic" };
  if (isDoneStatus(target.statusName, target.statusCategory)) return { reason: "done" };
  const signs = flowlib.stubSigns(s);
  const excludeTypes = flowlib.excludedTypes(s);
  const teamOf = flowTeamOf({ tempo, profiles });
  const weeks = Number(s.flowWeeks) || 52;
  const now = flowlib.mondayOf(today);
  const teamName = new Map();
  const teamFlow = new Map();
  const portfolio = [];
  let tModel = null;
  let tTeams = [];
  let tRemaining = 0;
  let tStubs = [];
  for (const e of epics.filter((x) => !x.hidden && !isDoneStatus(x.statusName, x.statusCategory))) {
    const model = flowlib.buildFlow({ rows: flowRows, teamOf, weeks, epicKey: e.key, excludeTypes, stubs: signs, now: today });
    const open = issues.filter((i) => i.epicKey === e.key && !agg.isDone(i) && !flowlib.isExcludedType(i.typeName, excludeTypes));
    const stubs = open.filter((i) => flowlib.isStub(i.summary, signs));
    const remaining = open.length - stubs.length;
    const teams = model.teams.filter((x) => (x.byEpic.get(e.key) || 0) > 0);
    const epicDone = teams.reduce((n, x) => n + x.byEpic.get(e.key), 0);
    for (const x of teams) {
      teamName.set(x.team.id, x.team.name);
      teamFlow.set(x.team.id, x);
    }
    const slots = teams.map((x) => ({
      team: x.team.id,
      remaining: (remaining * x.byEpic.get(e.key)) / epicDone,
      share: flowlib.forecastShare(flowlib.epicShare(x, e.key, { open: remaining > 0 }))
    }));
    portfolio.push({ key: e.key, slots });
    if (e.key === targetKey) {
      tModel = model;
      tTeams = teams;
      tRemaining = remaining;
      tStubs = stubs.map((i) => i.key);
    }
  }

  // Окно истории — как у текущего прогноза эпика: от начала работы его команд, не короче 12 недель.
  const to = tModel.weeksCount - 1;
  const froms = tTeams.map((x) => flowlib.epicShare(x, targetKey, { open: tRemaining > 0 }).active?.from).filter((v) => v != null);
  const start = froms.length ? Math.min(...froms) : 0;
  const from = Math.max(0, Math.min(start, to - flowlib.FORECAST_OK_WEEKS + 1));
  const inBt = isBt(target.statusName, s);
  if (!inBt && to - from + 1 < flowlib.FORECAST_MIN_WEEKS) return { reason: "short" };
  const history = {};
  for (const [id, x] of teamFlow) history[id] = { perWeek: x.perWeek.slice(from, to + 1), starts: tModel.starts.slice(from, to + 1) };

  // Приёмка заказчика (постановщика эпика); эпик в БТ — от даты входа.
  const customer = normName(target.reporterName);
  const acc = accItems.length ? acceptance.customerStats(accItems, customer) : null;
  const open = accItems.find((x) => x.key === targetKey && x.end == null);
  const btSince = inBt ? (open ? open.start : today) : null;
  const tgt = portfolio.find((x) => x.key === targetKey);
  Object.assign(tgt, {
    inBt: btSince,
    inBtElapsed: btSince != null ? workcal.workdaysBetween(btSince, today) : 0,
    acceptance: acc && acc.all.length ? { own: acc.own, all: acc.all, n: acc.n } : null,
    btFactor: 1,
    blockers: [],
    offDays: []
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
    meta: { target, teams: tTeams, teamName, teamOf, history, remaining: tRemaining, stubs: tStubs, acc, customerName: target.reporterName || "", btSince, accEmpty: !accItems.length }
  };
}

// Факторы срока (А5.1) — из расчёта и входов. Числа отсюда — единственные, которые видит объяснение.
export function buildFactors({ res, meta, flowRows, today = Date.now(), s }) {
  const key = meta.target.key;
  const since = today - RECENT_MS;
  const recent = flowRows.filter((r) => r.epicKey === key && r.resolved && Date.parse(r.resolved) >= since);
  const shares = meta.teams.map((x) => {
    const share = flowlib.forecastShare(flowlib.epicShare(x, key, { open: meta.remaining > 0 }));
    const people = [...new Set(recent.filter((r) => meta.teamOf({ key: r.assigneeKey, login: r.assigneeLogin, name: r.assigneeName })?.id === x.team.id).map((r) => r.assigneeName))];
    // темп — медиана недель того же окна истории, что у прогноза
    return { team: x.team.name || t("dash"), share: Math.round(share * 100), pace: flowlib.median(meta.history[x.team.id]?.perWeek || []), people };
  });
  const p95 = res.done.p95;
  let holidays = 0;
  for (let ms = today; ms < p95; ms += DAY) {
    const d = new Date(ms).getDay();
    if (d !== 0 && d !== 6 && !workcal.isWorkday(ms, workcal.current(), s)) holidays += 1;
  }
  const acc = meta.acc;
  return {
    dates: { dev: res.dev, done: res.done, chance: res.chance },
    remaining: { total: meta.remaining, stubs: meta.stubs.length },
    shares,
    last: res.last.map((x) => ({ team: meta.teamName.get(x.team) || x.team, pct: x.pct })),
    release: res.contributions.release,
    blockers: res.contributions.blockers,
    acceptance: acc
      ? { customer: meta.customerName, n: acc.n, median: acc.median, p95: acc.p95, returnRate: acc.returnRate == null ? null : Math.round(acc.returnRate * 100), noHistory: acc.n === 0, btSince: meta.btSince }
      : { customer: meta.customerName, none: true },
    holidays,
    spread: Math.round((res.done.p95 - res.done.p50) / DAY),
    blockersAssessed: false
  };
}

const fmt = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "2-digit" });

// Шаблонное объяснение — без LLM (и запасной текст, если LLM ошибся).
export function templateText(f) {
  const out = [t("ai.tplDate", { done: fmt(f.dates.done.p95), dev: fmt(f.dates.dev.p95) })];
  out.push(t("ai.tplRemaining", { n: Math.round(f.remaining.total), stubs: f.remaining.stubs }));
  if (f.last.length) out.push(t("ai.tplLast", { team: f.last[0].team, pct: f.last[0].pct }));
  if (f.release) out.push(t("ai.tplRelease", { days: Math.abs(f.release) }));
  if (!f.blockersAssessed) out.push(t("ai.tplNoBlockers"));
  else if (f.blockers) out.push(t("ai.tplBlockers", { days: f.blockers }));
  const a = f.acceptance;
  if (a.none) out.push(t("ai.tplNoAcceptance"));
  else if (a.noHistory) out.push(t("ai.tplAccGeneral", { customer: a.customer || t("dash") }));
  else out.push(t("ai.tplAcc", { customer: a.customer, n: a.n, median: a.median, p95: a.p95, ret: a.returnRate }));
  if (f.holidays) out.push(t("ai.tplHolidays", { n: f.holidays }));
  out.push(t("ai.tplSpread", { days: f.spread }));
  return out.join(" ");
}

export async function getAll() {
  return new Map((await db.all(db.STORES.aiForecasts)).map((r) => [r.key, r]));
}

// Анализ эпика: данные из базы, приёмки из Jira (раз в сутки), расчёт в фоновом потоке, сохранение.
export async function analyze(epicKey, { today = Date.now() } = {}) {
  const s = settings.get();
  const [epics, issues, flowRows, tempo, profiles, prev] = await Promise.all([
    db.all(db.STORES.epics),
    db.all(db.STORES.issues),
    db.all(db.STORES.flow),
    db.all(db.STORES.tempo),
    db.all(db.STORES.people),
    db.getOne(db.STORES.aiForecasts, epicKey)
  ]);
  let accItems = [];
  let accError = "";
  try {
    accItems = await acceptance.load();
  } catch (e) {
    accError = e && e.message ? e.message : String(e);
  }
  const input = buildInputs({ targetKey: epicKey, epics, issues, flowRows, tempo, profiles, s, accItems, today });
  if (input.reason) throw new Error(t(`ai.reason.${input.reason}`));
  const res = await runPortfolio(input.args);
  if (!res) throw new Error(t("ai.reason.noHistory"));
  const factors = buildFactors({ res, meta: input.meta, flowRows, today, s });
  const rec = { key: epicKey, at: Date.now(), res, factors, text: templateText(factors), adjustments: prev?.adjustments || {}, accError };
  await db.putAll(db.STORES.aiForecasts, [rec]);
  return rec;
}
