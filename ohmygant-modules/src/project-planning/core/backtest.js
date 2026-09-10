// Последовательный backtest завершённых инициатив. Для каждого среза используются
// только инициативы, завершившиеся до старта проверяемой — без look-ahead.
import { daysBetween, isWorkingDay } from "./calendar.js";
import { samePerson } from "./identity.js";

function quantile(values, percentile) {
  const rows = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!rows.length) return null;
  const position = (rows.length - 1) * Math.min(1, Math.max(0, percentile));
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? rows[low] : rows[low] + (rows[high] - rows[low]) * (position - low);
}

function actualHours(issue) {
  const worklogs = (issue.worklogs || []).reduce((sum, row) => sum + Number(row.timeSpentSeconds || 0), 0);
  return (worklogs || Number(issue.timeSpentSeconds || issue.timeSpentHours * 3600 || 0)) / 3600;
}

function actorKey(actor = {}) {
  return String(actor.accountId || actor.username || actor.key || actor.displayName || "").toLocaleLowerCase("ru-RU");
}

function initiativeStart(rows) {
  const candidates = rows.flatMap((issue) => [
    issue.plannedStart,
    issue.epicPlannedStart,
    ...(issue.sprints || []).map((sprint) => sprint.startDate),
    issue.created
  ]).filter(Boolean).sort();
  return candidates[0] || "";
}

function initiativeEnd(rows) {
  return rows.map((issue) => issue.resolved).filter(Boolean).sort().at(-1) || "";
}

function dailyCapacity(rows, employees, hoursPerDay) {
  const actors = new Map();
  for (const issue of rows) {
    const key = actorKey(issue.assignee);
    if (key) actors.set(key, issue.assignee);
  }
  if (!actors.size) return hoursPerDay;
  return [...actors.values()].reduce((sum, actor) => {
    const employee = employees.find((candidate) => samePerson(candidate, actor));
    const commitment = employee ? Math.max(0.05, Math.min(1, Number(employee.commitment || 100) / 100)) : 1;
    return sum + commitment * hoursPerDay;
  }, 0);
}

function drift(values) {
  if (values.length < 6) return null;
  const recent = quantile(values.slice(-3), 0.5);
  const baseline = quantile(values.slice(0, -3), 0.5);
  const change = baseline > 0 ? recent / baseline - 1 : 0;
  return {
    baseline: Number(baseline.toFixed(3)),
    recent: Number(recent.toFixed(3)),
    changePercent: Math.round(change * 100),
    alert: Math.abs(change) >= 0.2
  };
}

export function backtestPortfolio(history = [], employees = [], hoursPerDay = 8) {
  const groups = new Map();
  for (const issue of history) {
    if (!issue.epicKey || !issue.created || !issue.resolved) continue;
    if (!groups.has(issue.epicKey)) groups.set(issue.epicKey, { key: issue.epicKey, rows: [] });
    groups.get(issue.epicKey).rows.push(issue);
  }

  const initiatives = [...groups.values()].map((group) => {
    const estimateHours = group.rows.reduce((sum, issue) => sum + Number(issue.originalEstimateSeconds || 0) / 3600, 0);
    const spentHours = group.rows.reduce((sum, issue) => sum + actualHours(issue), 0);
    const start = initiativeStart(group.rows);
    const end = initiativeEnd(group.rows);
    const actualDays = daysBetween(start, end, (date) => isWorkingDay(date)).length;
    const capacityHours = dailyCapacity(group.rows, employees, hoursPerDay);
    const idealDays = estimateHours / Math.max(1, capacityHours);
    if (!(estimateHours > 0) || !(spentHours > 0) || !(actualDays > 0) || !(idealDays > 0) || !start || !end) return null;
    return {
      key: group.key,
      start,
      end,
      estimateHours,
      actualHours: spentHours,
      actualDays,
      idealDays,
      effortRatio: spentHours / estimateHours,
      durationRatio: actualDays / idealDays
    };
  }).filter(Boolean).sort((left, right) => Date.parse(left.start) - Date.parse(right.start) || Date.parse(left.end) - Date.parse(right.end));

  const rows = [];
  for (const current of initiatives) {
    const currentStart = Date.parse(current.start);
    const previous = initiatives.filter((candidate) => Date.parse(candidate.end) < currentStart);
    if (previous.length < 3) continue;
    const durationRatios = previous.map((row) => row.durationRatio);
    const effortRatios = previous.map((row) => row.effortRatio);
    const p50 = current.idealDays * quantile(durationRatios, 0.5);
    const p80 = current.idealDays * quantile(durationRatios, 0.8);
    const p90 = current.idealDays * quantile(durationRatios, 0.9);
    const effortP50 = current.estimateHours * quantile(effortRatios, 0.5);
    const effortP80 = current.estimateHours * quantile(effortRatios, 0.8);
    const effortP90 = current.estimateHours * quantile(effortRatios, 0.9);
    rows.push({
      key: current.key,
      start: current.start,
      end: current.end,
      trainingSample: previous.length,
      estimateHours: current.estimateHours,
      actualHours: current.actualHours,
      actualDays: current.actualDays,
      p50,
      p80,
      p90,
      effortP50,
      effortP80,
      effortP90,
      effortAbsoluteError: Math.abs(effortP50 - current.actualHours),
      durationAbsoluteError: Math.abs(p50 - current.actualDays)
    });
  }

  const totalActualHours = rows.reduce((sum, row) => sum + row.actualHours, 0);
  const totalPredictedHours = rows.reduce((sum, row) => sum + row.effortP50, 0);
  const totalActualDays = rows.reduce((sum, row) => sum + row.actualDays, 0);
  const dateCoverage = {
    p50: rows.length ? Number((rows.filter((row) => row.actualDays <= row.p50).length / rows.length).toFixed(2)) : null,
    p80: rows.length ? Number((rows.filter((row) => row.actualDays <= row.p80).length / rows.length).toFixed(2)) : null,
    p90: rows.length ? Number((rows.filter((row) => row.actualDays <= row.p90).length / rows.length).toFixed(2)) : null
  };
  const effortCoverage = {
    p50: rows.length ? Number((rows.filter((row) => row.actualHours <= row.effortP50).length / rows.length).toFixed(2)) : null,
    p80: rows.length ? Number((rows.filter((row) => row.actualHours <= row.effortP80).length / rows.length).toFixed(2)) : null,
    p90: rows.length ? Number((rows.filter((row) => row.actualHours <= row.effortP90).length / rows.length).toFixed(2)) : null
  };
  const maeDays = rows.length ? Number((rows.reduce((sum, row) => sum + row.durationAbsoluteError, 0) / rows.length).toFixed(1)) : null;
  const wapeDays = totalActualDays ? Number((rows.reduce((sum, row) => sum + row.durationAbsoluteError, 0) / totalActualDays).toFixed(3)) : null;
  return {
    sample: rows.length,
    eligibleInitiatives: initiatives.length,
    excludedForOverlap: Math.max(0, initiatives.length - Math.min(3, initiatives.length) - rows.length),
    maeDays,
    wapeDays,
    coverage: dateCoverage,
    dates: { maeDays, wape: wapeDays, coverage: dateCoverage },
    effort: {
      maeHours: rows.length ? Number((rows.reduce((sum, row) => sum + row.effortAbsoluteError, 0) / rows.length).toFixed(1)) : null,
      wape: totalActualHours ? Number((rows.reduce((sum, row) => sum + row.effortAbsoluteError, 0) / totalActualHours).toFixed(3)) : null,
      bias: totalActualHours ? Number((totalPredictedHours / totalActualHours).toFixed(3)) : null,
      coverage: effortCoverage
    },
    drift: {
      effort: drift(initiatives.map((row) => row.effortRatio)),
      duration: drift(initiatives.map((row) => row.durationRatio))
    },
    rows: rows.slice(-10)
  };
}
