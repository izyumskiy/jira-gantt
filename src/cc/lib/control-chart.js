// Расчёт Control Chart по компактным записям задач.
//
// Логика повторяет Jira (confluence.atlassian.com/jirasoftware/control-chart):
//  • точка = завершённая задача; X — момент попадания в колонку «Готово»,
//    Y — время цикла: суммарное время, проведённое в выбранных колонках;
//  • скользящее среднее по окну, размер которого зависит от объёма выборки;
//  • полоса ±1σ вокруг скользящего среднего;
//  • горизонтальная линия общего среднего.

import { unpackSteps, toSegments, nowMin, MIN_PER_DAY } from './codec.js';

export { MIN_PER_DAY };

/** Статусы выбранных колонок доски → Set кодов. */
export function statusSet(board, columnNames) {
  const set = new Set();
  for (const col of board?.columns || []) {
    if (!columnNames || columnNames.includes(col.name)) {
      for (const code of col.st || []) set.add(code);
    }
  }
  return set;
}

/** Колонки, которые по умолчанию считаются завершающими. */
export function defaultDoneColumns(board, statusDict) {
  const columns = board?.columns || [];
  const done = columns.filter((col) =>
    (col.st || []).length && (col.st || []).every((code) => statusDict.category(code) === 'done'));
  if (done.length) return done.map((c) => c.name);
  return columns.length ? [columns[columns.length - 1].name] : [];
}

/** Колонки «в работе» по умолчанию: всё, кроме первой и завершающих. */
export function defaultCycleColumns(board, statusDict) {
  const columns = board?.columns || [];
  const doneNames = new Set(defaultDoneColumns(board, statusDict));
  const middle = columns.filter((c, i) => i > 0 && !doneNames.has(c.name));
  return (middle.length ? middle : columns.filter((c) => !doneNames.has(c.name))).map((c) => c.name);
}

/**
 * Сколько задач прошло через каждый статус и сколько времени там суммарно
 * проведено. Нужно, чтобы показать в интерфейсе статусы, которых нет ни в одной
 * колонке доски (их время иначе молча выпадает из расчёта).
 * @returns {Map<number, {issues:number, minutes:number}>}
 */
export function statusUsage(issues, until = nowMin()) {
  const usage = new Map();
  for (const rec of issues) {
    const steps = unpackSteps(rec.tr, rec.c);
    const seen = new Set();
    for (const seg of toSegments(steps, until)) {
      let entry = usage.get(seg.s);
      if (!entry) {
        entry = { issues: 0, minutes: 0 };
        usage.set(seg.s, entry);
      }
      entry.minutes += Math.max(0, seg.to - seg.from);
      if (!seen.has(seg.s)) {
        entry.issues++;
        seen.add(seg.s);
      }
    }
  }
  return usage;
}

/** Статусы всех колонок доски (для проверки «замаплен ли статус»). */
export function mappedStatuses(board) {
  const set = new Set();
  for (const col of board?.columns || []) {
    for (const code of col.st || []) set.add(code);
  }
  return set;
}

/** Статусы «Готово» по умолчанию — коды, а не имена колонок. */
export function defaultDoneStatuses(board, statusDict) {
  return [...statusSet(board, defaultDoneColumns(board, statusDict))];
}

/** Статусы цикла по умолчанию — коды. */
export function defaultCycleStatuses(board, statusDict) {
  return [...statusSet(board, defaultCycleColumns(board, statusDict))];
}

/** Момент входа в финальный непрерывный «готовый» участок; -1, если не готово. */
export function doneAtFrom(steps, doneCodes) {
  if (!steps.length) return -1;
  if (!doneCodes.has(steps[steps.length - 1].s)) return -1;
  let idx = steps.length - 1;
  while (idx > 0 && doneCodes.has(steps[idx - 1].s)) idx--;
  return steps[idx].t;
}

/**
 * Считает точки графика.
 * @param {object[]} issues — записи из IndexedDB
 * @param {object} opts
 * @returns {{points:Array, stats:object, excluded:object}}
 */
export function computePoints(issues, opts) {
  const {
    cycleCodes,
    doneCodes,
    fromMin = -Infinity,
    toMin = Infinity,
    typeCodes = null,      // Set|null — фильтр по типам задач
    assigneeCodes = null,  // Set|null
    until = nowMin(),
  } = opts;

  const points = [];
  const excluded = { notDone: 0, outOfRange: 0, noTime: 0, filtered: 0 };
  // Разбивка отброшенных по статусам: где задачи «застряли» и куда утекло
  // время у тех, кто не набрал ни минуты в выбранных колонках.
  const details = { notDoneByStatus: new Map(), noTimeByStatus: new Map() };
  const bump = (map, code) => map.set(code, (map.get(code) || 0) + 1);

  for (const rec of issues) {
    if (typeCodes && !typeCodes.has(rec.ty)) { excluded.filtered++; continue; }
    if (assigneeCodes && !assigneeCodes.has(rec.as ?? -1)) { excluded.filtered++; continue; }

    const steps = unpackSteps(rec.tr, rec.c);
    const doneAt = doneAtFrom(steps, doneCodes);
    if (doneAt < 0) {
      excluded.notDone++;
      bump(details.notDoneByStatus, steps.length ? steps[steps.length - 1].s : rec.s);
      continue;
    }
    if (doneAt < fromMin || doneAt > toMin) { excluded.outOfRange++; continue; }

    const segments = toSegments(steps, Math.max(until, doneAt));
    let cycle = 0;
    const breakdown = new Map();
    const elsewhere = new Set();
    for (const seg of segments) {
      if (seg.from >= doneAt) break;
      const span = Math.min(seg.to, doneAt) - seg.from;
      if (span <= 0) continue;
      if (!cycleCodes.has(seg.s)) {
        elsewhere.add(seg.s);
        continue;
      }
      cycle += span;
      breakdown.set(seg.s, (breakdown.get(seg.s) || 0) + span);
    }
    if (cycle <= 0) {
      excluded.noTime++;
      for (const code of elsewhere) bump(details.noTimeByStatus, code);
      continue;
    }

    points.push({
      i: rec.i,
      k: rec.k,
      pj: rec.pj,
      ty: rec.ty,
      as: rec.as ?? -1,
      su: rec.su || '',
      ts: rec.ts ?? -1,
      created: rec.c,
      doneAt,
      cycle,
      lead: doneAt - rec.c,
      breakdown: [...breakdown.entries()].sort((a, b) => b[1] - a[1]),
    });
  }

  points.sort((a, b) => a.doneAt - b.doneAt || a.i - b.i);
  return { points, excluded, details };
}

/**
 * Разбивка точек графика по исполнителям.
 * Считает статистику по той же выборке, что показана на графике, поэтому
 * фильтры периода и типов уже применены.
 * @returns {{code:number, points:Array, stats:object}[]}
 */
export function byAssignee(points) {
  const groups = new Map();
  for (const p of points) {
    const code = p.as ?? -1;
    let group = groups.get(code);
    if (!group) {
      group = [];
      groups.set(code, group);
    }
    group.push(p);
  }
  return [...groups.entries()].map(([code, list]) => ({
    code,
    points: list,
    stats: summarize(list),
  }));
}

/** Границы выбросов по правилу межквартильного размаха. */
export function outlierThreshold(values) {
  if (values.length < 8) return Infinity;
  const sorted = values.slice().sort((a, b) => a - b);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  return q3 + 1.5 * (q3 - q1);
}

export function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const pos = (sortedValues.length - 1) * (p / 100);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

/**
 * Скользящее среднее и σ по окну, центрированному на каждой точке.
 * Размер окна = доля выборки (как в Jira, окно подстраивается под объём).
 */
export function rollingAverage(points, percent = 0.1, minWindow = 3) {
  const n = points.length;
  if (!n) return [];
  const window = Math.max(minWindow, Math.min(n, Math.round(n * percent) || minWindow));
  const half = Math.floor(window / 2);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let lo = i - half;
    let hi = i + half;
    if (lo < 0) { hi += -lo; lo = 0; }
    if (hi > n - 1) { lo -= hi - (n - 1); hi = n - 1; }
    if (lo < 0) lo = 0;
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += points[j].cycle;
    const count = hi - lo + 1;
    const avg = sum / count;
    let variance = 0;
    for (let j = lo; j <= hi; j++) variance += (points[j].cycle - avg) ** 2;
    const sd = Math.sqrt(variance / count);
    out[i] = { x: points[i].doneAt, avg, sd, lo: Math.max(0, avg - sd), hi: avg + sd };
  }
  return { series: out, window };
}

/** Сводная статистика по точкам (в минутах). */
export function summarize(points) {
  const values = points.map((p) => p.cycle).sort((a, b) => a - b);
  if (!values.length) {
    return { count: 0, avg: 0, median: 0, p50: 0, p85: 0, p95: 0, min: 0, max: 0, sd: 0, cv: 0 };
  }
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  return {
    count: values.length,
    avg,
    median: percentile(values, 50),
    p50: percentile(values, 50),
    p85: percentile(values, 85),
    p95: percentile(values, 95),
    min: values[0],
    max: values[values.length - 1],
    sd,
    // Коэффициент вариации: разброс относительно самой величины.
    cv: avg > 0 ? sd / avg : 0,
  };
}

/**
 * Полный расчёт: точки + отсев выбросов + скользящее среднее + статистика.
 */
export function buildChart(issues, opts) {
  const { points: raw, excluded, details } = computePoints(issues, opts);
  let points = raw;
  let outliers = [];
  if (opts.excludeOutliers && raw.length) {
    const limit = outlierThreshold(raw.map((p) => p.cycle));
    outliers = raw.filter((p) => p.cycle > limit);
    points = raw.filter((p) => p.cycle <= limit);
  }
  const rolling = rollingAverage(points, opts.rollingPercent ?? 0.1);
  const stats = summarize(points);
  return {
    points,
    outliers,
    excluded: { ...excluded, outliers: outliers.length },
    details,
    rolling: rolling.series || [],
    rollingWindow: rolling.window || 0,
    stats,
  };
}
