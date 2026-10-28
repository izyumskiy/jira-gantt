// Прогноз портфеля (US-4): все выбранные эпики в одном прогоне, неделя за неделей. Команда каждую
// неделю «проживает» одну неделю своей истории — общую для её эпиков; эпик получает свою долю потока.
// Доля закончившего эпика делится между оставшимися эпиками команды (освобождение). Поток приводится
// к рабочим дням по календарю. К концу разработки прибавляется приёмка заказчика (US-3).
// Чистые функции без DOM и сети: считаются и в фоновом потоке (forecast.worker.js).
import { seededRandom } from "./flow.js";
import { isWorkday, addWorkdays } from "./workcal.js";

const DAY = 86400000;
const WEEK = 7 * DAY;

// Выборка срока приёмки (рабочих дней): своя история заказчика с весом n / (n + 3), иначе общая.
// elapsed — сколько эпик уже в БТ: берутся только приёмки длиннее; таких нет — 5 дней сверх прошедшего.
export function acceptanceSampler(st, { elapsed = 0, rnd = Math.random } = {}) {
  const longer = (list) => list.filter((d) => d > elapsed);
  const own = longer(st.own || []);
  const all = longer(st.all || []);
  const w = st.n / (st.n + 3);
  return () => {
    const pool = own.length && rnd() < w ? own : all.length ? all : own;
    if (!pool.length) return elapsed + 5;
    return pool[Math.floor(rnd() * pool.length)];
  };
}

// Задержка блокировки (US-8): перегруз людей в часах → рабочие недели. Люди работают параллельно —
// берётся наибольший перегруз.
export function overloadDelayWeeks(hoursByPerson, hoursPerDay = 8) {
  const worst = Math.max(0, ...hoursByPerson);
  return worst / (5 * hoursPerDay);
}

// Рабочих дней в неделе с понедельника start по календарю cal и ручным правкам s.
function weekWorkdays(start, cal, s) {
  let n = 0;
  for (let i = 0; i < 7; i++) if (isWorkday(start + i * DAY + 12 * 3600000, cal, s)) n += 1;
  return n;
}

// Один вариант расчёта. epics — входы эпиков (см. portfolioForecast), history — история команд.
export function simulate({ epics, history, target, now, runs, rnd, redistribute, useBlockers, cal, s, maxWeeks = 260 }) {
  // История команды на пятидневную неделю; будущая неделя — по её рабочим дням.
  const norm = new Map();
  for (const [team, h] of Object.entries(history)) {
    norm.set(
      team,
      h.perWeek.map((n, i) => {
        const wd = h.starts ? weekWorkdays(h.starts[i], cal, s) : 5;
        return wd ? (n * 5) / wd : n;
      })
    );
  }
  const future = [];
  const factor = (k) => (future[k] ??= weekWorkdays(now + k * WEEK, cal, s) / 5);

  const tIndex = epics.findIndex((e) => e.key === target);
  const t = epics[tIndex];
  const devMs = [];
  const doneMs = [];
  const lastTeam = new Map();
  let overflow = 0;
  const sOff = { ...s, calendarOff: [...(s.calendarOff || []), ...((t && t.offDays) || [])] };
  const pick = t && t.acceptance ? acceptanceSampler(t.acceptance, { elapsed: t.inBtElapsed || 0, rnd }) : null;

  for (let r = 0; r < runs; r++) {
    // Слоты «эпик × команда» с остатком и текущей долей.
    const slots = [];
    const byTeam = new Map();
    const openSlots = new Array(epics.length).fill(0);
    epics.forEach((e, ei) => {
      if (e.inBt != null) return; // уже в бизнес-тесте — разработку не моделируем
      for (const sl of e.slots) {
        if (!(sl.remaining > 0) || !(sl.share > 0) || !norm.get(sl.team)?.length) continue;
        const x = { ei, team: sl.team, rem: sl.remaining, share: sl.share, done: false };
        slots.push(x);
        openSlots[ei] += 1;
        if (!byTeam.has(sl.team)) byTeam.set(sl.team, []);
        byTeam.get(sl.team).push(x);
      }
    });
    const devWeeks = new Array(epics.length).fill(0);
    let lastSlot = null;
    let left = slots.length;
    for (let k = 0; left > 0 && k < maxWeeks; k++) {
      const f = factor(k);
      for (const [team, list] of byTeam) {
        const hist = norm.get(team);
        const base = hist[Math.floor(rnd() * hist.length)] * f;
        const finished = [];
        for (const x of list) {
          if (x.done) continue;
          x.rem -= base * x.share;
          if (x.rem <= 0) finished.push(x);
        }
        for (const x of finished) {
          x.done = true;
          left -= 1;
          openSlots[x.ei] -= 1;
          if (openSlots[x.ei] === 0) devWeeks[x.ei] = k + 1;
          if (x.ei === tIndex) lastSlot = x;
          if (!redistribute) continue;
          const others = list.filter((o) => !o.done);
          const total = others.reduce((n, o) => n + o.share, 0);
          if (total > 0) for (const o of others) o.share += (x.share * o.share) / total;
        }
      }
      if (k + 1 >= maxWeeks && left > 0) overflow += 1;
    }
    if (!t || (t.inBt == null && !slots.some((x) => x.ei === tIndex))) continue; // у эпика нет истории потока
    let weeks = t.inBt != null ? 0 : devWeeks[tIndex] || (openSlots[tIndex] ? maxWeeks : 0);
    if (useBlockers) for (const b of t.blockers || []) if (rnd() < b.p) weeks += b.weeks;
    const dev = t.inBt != null ? t.inBt : now + weeks * WEEK;
    devMs.push(dev);
    if (lastSlot) lastTeam.set(lastSlot.team, (lastTeam.get(lastSlot.team) || 0) + 1);
    if (!pick) {
      doneMs.push(dev);
      continue;
    }
    // Срок приёмки × поправка LLM; эпик в БТ — не меньше прошедшего + 1 день.
    const days = Math.max(Math.round(pick() * (t.btFactor || 1)), t.inBt != null ? (t.inBtElapsed || 0) + 1 : 1);
    doneMs.push(addWorkdays(dev, days, cal, sOff));
  }
  return { devMs, doneMs, lastTeam, overflow };
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const percentiles = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  return { p50: pct(sorted, 50), p85: pct(sorted, 85), p95: pct(sorted, 95) };
};

// Прогноз эпика target внутри портфеля. Входы — простые данные (уходят в фоновый поток):
//   epics: [{ key, slots: [{ team, remaining, share }], inBt: ms | null, inBtElapsed, acceptance:
//            { own, all, n } | null, btFactor, blockers: [{ weeks, p }], offDays: ["ГГГГ-ММ-ДД"] }]
//   history: { [команда]: { perWeek: [...], starts: [понедельники недель, мс] } }
//   cal: производственный календарь (workcal.parseCalendar) или null; overrides: ручные правки.
// Вклады влияния — разница P95 трёх вариантов на одном зерне: сам по себе → с освобождением →
// с освобождением и блокировками.
export function portfolioForecast({ epics, history, target, now, seed = target, runs = 10000, dueMs = NaN, cal = null, overrides = {} }) {
  const s = { calendarOff: overrides.calendarOff || [], calendarWork: overrides.calendarWork || [] };
  const run = (opts) => simulate({ epics, history, target, now, cal, s, rnd: seededRandom(seed), ...opts });
  const full = run({ runs, redistribute: true, useBlockers: true });
  if (!full.devMs.length) return null;
  const solo = run({ runs: Math.round(runs / 2), redistribute: false, useBlockers: false });
  const freed = run({ runs: Math.round(runs / 2), redistribute: true, useBlockers: false });
  const p95 = (x) => percentiles(x.doneMs).p95;
  const days = (ms) => Math.round(ms / DAY);
  const total = full.devMs.length;
  return {
    runs: total,
    dev: percentiles(full.devMs),
    done: percentiles(full.doneMs),
    chance: Number.isFinite(dueMs) ? full.doneMs.filter((ms) => ms <= dueMs).length / total : null,
    last: [...full.lastTeam].map(([team, n]) => ({ team, pct: Math.round((n / total) * 100) })).sort((a, b) => b.pct - a.pct),
    contributions: { release: days(p95(freed) - p95(solo)), blockers: days(p95(full) - p95(freed)) },
    soloP95: p95(solo),
    overflow: full.overflow
  };
}
