// Прогноз сроков методом Монте-Карло по историческому недельному потоку.
//
// Идея: складывать оценки задач нельзя (перцентили не складываются, а циклы
// перекрываются и очереди считаются дважды). Поэтому считаем не время задач,
// а поток: сколько задач команда доводит до «Готово» за неделю. Дальше тянем
// случайные недели из истории, пока не наберём нужный объём, и повторяем тысячи
// раз — получается распределение сроков, из которого берём перцентили.
//
// Несколько команд не складываются, а идут параллельно: в каждом прогоне
// длительность проекта равна максимуму по командам. Даже если каждая держит
// свой 85-й перцентиль, все три сразу держат его лишь в 0,85³ ≈ 61% случаев —
// симуляция это учитывает автоматически.

import { unpackSteps, minToDate, toMin as dateToMin, MIN_PER_DAY } from './codec.js';
import { doneAtFrom, percentile } from './control-chart.js';

export const DAYS_IN_WEEK = 7;

/** Начало недели (понедельник, 00:00 локального времени). */
export function weekStart(min) {
  const d = minToDate(min);
  d.setHours(0, 0, 0, 0);
  const weekday = (d.getDay() + 6) % 7; // 0 — понедельник
  d.setDate(d.getDate() - weekday);
  return dateToMin(d);
}

/** Следующая неделя. Считаем через даты, чтобы переход на летнее время не сдвигал сетку. */
export function nextWeek(min) {
  const d = minToDate(min);
  d.setDate(d.getDate() + DAYS_IN_WEEK);
  return dateToMin(d);
}

/**
 * Моменты завершения задач: вход в статусы «Готово» внутри диапазона.
 * В отличие от расчёта графика здесь не требуется время в статусах цикла —
 * задача считается завершённой, даже если по рабочим статусам не проходила.
 */
export function completions(issues, doneCodes, fromMin = -Infinity, toMin = Infinity) {
  const out = [];
  for (const rec of issues) {
    const doneAt = doneAtFrom(unpackSteps(rec.tr, rec.c), doneCodes);
    if (doneAt < 0 || doneAt < fromMin || doneAt > toMin) continue;
    out.push(doneAt);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Недельный поток по моментам завершения.
 * Неполные недели по краям диапазона выбрасываются: они занижают поток.
 * Недели без завершений остаются нулями — праздники и отпуска это тоже поток.
 * @returns {{start:number, count:number}[]}
 */
export function weeklyThroughput(doneMins, fromMin, toMin) {
  let first = weekStart(fromMin);
  if (first < fromMin) first = nextWeek(first);      // первая неделя неполная
  let last = weekStart(toMin);
  // Неделя покрывает минуты [last, nextWeek(last) - 1]; если её последняя минута
  // выходит за диапазон, неделя ещё не закончилась и в выборку не идёт.
  if (nextWeek(last) - 1 > toMin) last = weekStart(last - 1);
  if (last < first) return [];

  const buckets = new Map();
  for (const min of doneMins) {
    const key = weekStart(min);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  const weeks = [];
  for (let start = first; start <= last; start = nextWeek(start)) {
    weeks.push({ start, count: buckets.get(start) || 0 });
  }
  return weeks;
}

/** Сводка по потоку: медиана, минимум, максимум и среднее за неделю. */
export function throughputStats(weeks) {
  if (!weeks.length) return { weeks: 0, median: 0, min: 0, max: 0, avg: 0, total: 0 };
  const counts = weeks.map((w) => w.count).sort((a, b) => a - b);
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    weeks: counts.length,
    median: percentile(counts, 50),
    min: counts[0],
    max: counts[counts.length - 1],
    avg: total / counts.length,
    total,
  };
}

/**
 * Детерминированный генератор: при тех же входных данных прогноз не дрожит
 * от перерисовки к перерисовке. Mulberry32.
 */
export function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Симуляция. Каждая команда набирает свой объём из своей истории,
 * длительность прогона — максимум по командам.
 * @param {{counts:number[], target:number}[]} teams
 */
export function simulate(teams, { trials = 10000, maxWeeks = 520, seed = 1 } = {}) {
  const next = rng(seed);
  const durations = new Array(trials);
  const blocked = new Array(teams.length).fill(0);
  let converged = true;

  for (let trial = 0; trial < trials; trial++) {
    let worst = 0;
    let worstTeam = -1;
    for (let i = 0; i < teams.length; i++) {
      const { counts, target } = teams[i];
      let done = 0;
      let weeks = 0;
      while (done < target && weeks < maxWeeks) {
        done += counts[Math.floor(next() * counts.length)];
        weeks++;
      }
      if (weeks >= maxWeeks) converged = false;
      if (weeks > worst) {
        worst = weeks;
        worstTeam = i;
      }
    }
    durations[trial] = worst;
    if (worstTeam >= 0) blocked[worstTeam]++;
  }
  return { durations, blocked, converged };
}

/**
 * Полный прогноз: перцентили сроков, вклад команд и гистограмма исходов.
 * @param {{name:string, counts:number[], tasks:number, share:number}[]} teams
 */
export function forecast(teams, { trials = 10000, growth = 0, seed = 1 } = {}) {
  const usable = teams.filter((team) => team.counts.length && team.tasks > 0 && team.share > 0);
  if (!usable.length) return null;

  const prepared = usable.map((team) => ({
    ...team,
    // Доля потока учитывается через объём: если проекту достаётся 40% команды,
    // то ради своих 30 задач команда должна выпустить 75. Так сохраняется
    // настоящая «рваность» недель, а не сглаженные дробные значения.
    target: Math.ceil((team.tasks * (1 + growth)) / team.share),
  }));

  const { durations, blocked, converged } = simulate(prepared, { trials, seed });
  const sorted = durations.slice().sort((a, b) => a - b);

  const histogram = [];
  for (const weeks of sorted) {
    const last = histogram[histogram.length - 1];
    if (last && last.weeks === weeks) last.count++;
    else histogram.push({ weeks, count: 1 });
  }

  return {
    trials,
    converged,
    weeks: {
      p50: Math.ceil(percentile(sorted, 50)),
      p85: Math.ceil(percentile(sorted, 85)),
      p95: Math.ceil(percentile(sorted, 95)),
    },
    blocked: usable.map((team, i) => ({ name: team.name, share: blocked[i] / trials })),
    histogram,
  };
}

/** Дата через `weeks` недель от `startMin`. */
export function dateAfterWeeks(startMin, weeks) {
  const d = minToDate(startMin);
  d.setDate(d.getDate() + weeks * DAYS_IN_WEEK);
  return dateToMin(d);
}
