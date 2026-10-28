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
import { normName } from "./team.js";
import { isDoneStatus } from "./status.js";
import * as jira from "./jira.js";
import * as llm from "../llm/client.js";
import * as adjustments from "../llm/adjustments.js";
import * as explanation from "../llm/explanation.js";
import { t } from "./i18n.js";

const DAY = 86400000;
const RECENT_MS = 8 * 7 * DAY; // кто закрывал задачи эпика — за последние 8 недель

const isBt = (status, s) => acceptance.btStatuses(s).includes(String(status || "").trim().toLowerCase());

// Входы расчёта. Чистая функция: данные плагина → аргументы portfolioForecast и сведения для факторов.
// adj — действующие поправки LLM (adjustments.effective, у блокировок уже есть weeks) или null.
export function buildInputs({ targetKey, epics, issues, flowRows, tempo = [], profiles = [], s, accItems = [], today = Date.now(), adj = null }) {
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
    const llmStubs = new Set(e.key === targetKey && adj ? adj.stubs.map((x) => x.key) : []);
    const stubs = open.filter((i) => flowlib.isStub(i.summary, signs) || llmStubs.has(i.key));
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
    meta: { target, teams: tTeams, teamName, teamOf, history, remaining: tRemaining, stubs: tStubs, acc, customerName: target.reporterName || "", btSince, accEmpty: !accItems.length, adj }
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
  const adj = meta.adj;
  return {
    dates: { dev: res.dev, done: res.done, chance: res.chance },
    remaining: { total: meta.remaining, stubs: meta.stubs.length },
    shares,
    last: res.last.map((x) => ({ team: meta.teamName.get(x.team) || x.team, pct: x.pct })),
    release: res.contributions.release,
    blockers: res.contributions.blockers,
    acceptance: {
      ...(acc
        ? { customer: meta.customerName, n: acc.n, median: acc.median, p95: acc.p95, returnRate: acc.returnRate == null ? null : Math.round(acc.returnRate * 100), noHistory: acc.n === 0, btSince: meta.btSince }
        : { customer: meta.customerName, none: true }),
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
  if (f.last.length) out.push(t("ai.tplLast", { team: f.last[0].team, pct: f.last[0].pct }));
  if (f.release) out.push(t("ai.tplRelease", { days: Math.abs(f.release) }));
  if (f.llmError) out.push(t("ai.tplLlmFailed"));
  if (!f.blockersAssessed) out.push(t("ai.tplNoBlockers"));
  else if (f.blockers) out.push(t("ai.tplBlockers", { days: f.blockers }));
  else out.push(t("ai.tplBlockersNone"));
  const a = f.acceptance;
  if (a.none) out.push(t("ai.tplNoAcceptance"));
  else if (a.noHistory) out.push(t("ai.tplAccGeneral", { customer: a.customer || t("dash") }));
  else out.push(t("ai.tplAcc", { customer: a.customer, n: a.n, median: a.median, p95: a.p95, ret: a.returnRate }));
  if (a.factor) out.push(t("ai.tplBtFactor", { f: a.factor, reason: a.factorReason || t("dash") }));
  for (const x of a.absence || []) out.push(t("ai.tplAbsence", { from: x.from, to: x.to }));
  if (f.holidays) out.push(t("ai.tplHolidays", { n: f.holidays }));
  out.push(t("ai.tplSpread", { days: f.spread }));
  return out.join(" ");
}

// Заглушки от LLM по всем анализам (без отключённых): ключ задачи → причина. Для пометки в списке задач.
export function llmStubs(results) {
  const out = new Map();
  for (const rec of results.values()) {
    const adj = adjustments.effective(rec.adjustments, rec.disabled);
    for (const x of adj ? adj.stubs : []) out.set(x.key, x.reason);
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
      stub_by_settings: flowlib.isStub(i.summary, signs)
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
  const common = { targetKey: epicKey, epics, issues, flowRows, tempo, profiles, s, accItems, today };
  const base = buildInputs(common);
  if (base.reason) throw new Error(t(`ai.reason.${base.reason}`));

  // Загрузка людей по ближайшим секциям — как на «По людям», с разбивкой по эпикам.
  const excl = flowlib.excludedTypes(s);
  const model = agg.buildModel({ issues, others, sprints, epics, boards, tempo, profiles, mode: "assignee", timelineIssues: [...issues, ...others] });
  const load = agg.personLoad(model, issues, others, excl);
  const tasks = issues.filter((i) => i.epicKey === epicKey && !flowlib.isExcludedType(i.typeName, excl));
  const people = new Map(tasks.filter((i) => i.assigneeName).map((i) => [agg.normPersonName(i.assigneeName), i.assigneeName]));
  const portfolio = new Set(base.args.epics.map((e) => e.key).filter((k) => k !== epicKey));
  const ctx = { portfolio, people, norm: agg.normPersonName, sections: new Map(load.sections.map((x) => [String(x.id), x.title])), openTasks: new Set(tasks.filter((i) => !agg.isDone(i)).map((i) => i.key)) };

  let raw = prev ? prev.adjustments || null : null;
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
