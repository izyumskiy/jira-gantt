// Историческая калибровка оценки по сотруднику и типу работ.
// Модуль чистый: не обращается к DOM, Jira, Tempo или хранилищу.
import { samePerson } from "./identity.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export function quantile(values, percentile) {
  const sorted = (values || []).filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * clamp(percentile, 0, 1);
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

function issueActualSeconds(issue) {
  const worklog = (issue.worklogs || []).reduce((sum, row) => sum + Number(row.timeSpentSeconds || 0), 0);
  return worklog || Number(issue.timeSpentSeconds || 0);
}

function ownerFor(issue, employees) {
  return employees.find((employee) => samePerson(employee, issue.assignee || {}));
}

function profile(records, source, sourceLabel) {
  if (!records.length) return null;
  const ratios = records.map((row) => row.ratio);
  return {
    source,
    sourceLabel,
    sample: records.length,
    p50: quantile(ratios, 0.5),
    p80: quantile(ratios, 0.8),
    p90: quantile(ratios, 0.9),
    keys: records.slice().sort((left, right) => right.similarity - left.similarity).slice(0, 7).map((row) => row.key)
  };
}

function key(employeeId, areaId) {
  return `${employeeId}::${areaId}`;
}

export function buildCalibration(history = [], employees = [], classifyArea = () => ({ id: "backend" })) {
  const records = [];
  for (const issue of history) {
    const estimateSeconds = Number(issue.originalEstimateSeconds || 0);
    const actualSeconds = issueActualSeconds(issue);
    const employee = ownerFor(issue, employees);
    if (!employee || !(estimateSeconds > 0) || !(actualSeconds > 0)) continue;
    const ratio = actualSeconds / estimateSeconds;
    if (!Number.isFinite(ratio) || ratio < 0.2 || ratio > 5) continue;
    const area = classifyArea(`${issue.summary || ""} ${(issue.components || []).join(" ")} ${(issue.labels || []).join(" ")}`).id;
    records.push({
      key: issue.key || "",
      employeeId: employee.id,
      area,
      estimateHours: estimateSeconds / 3600,
      actualHours: actualSeconds / 3600,
      ratio,
      resolved: issue.resolved || issue.updated || "",
      similarity: 1
    });
  }

  const employeeArea = new Map();
  const employeeAll = new Map();
  const teamArea = new Map();
  for (const row of records) {
    const employeeAreaKey = key(row.employeeId, row.area);
    if (!employeeArea.has(employeeAreaKey)) employeeArea.set(employeeAreaKey, []);
    employeeArea.get(employeeAreaKey).push(row);
    if (!employeeAll.has(row.employeeId)) employeeAll.set(row.employeeId, []);
    employeeAll.get(row.employeeId).push(row);
    if (!teamArea.has(row.area)) teamArea.set(row.area, []);
    teamArea.get(row.area).push(row);
  }

  const profiles = employees.flatMap((employee) => {
    const areas = [...new Set(records.filter((row) => row.employeeId === employee.id).map((row) => row.area))];
    return areas.map((area) => profile(employeeArea.get(key(employee.id, area)) || [], "employee-area", `${employee.displayName || employee.username}: ${area}`));
  }).filter(Boolean);

  return { records, employeeArea, employeeAll, teamArea, profiles };
}

function pickProfile(model, employee, areaId) {
  const employeeAreaRows = model.employeeArea.get(key(employee.id, areaId)) || [];
  if (employeeAreaRows.length >= 3) return profile(employeeAreaRows, "employee-area", "сотрудник + тип работ");
  const employeeRows = model.employeeAll.get(employee.id) || [];
  if (employeeRows.length >= 5) return profile(employeeRows, "employee", "все работы сотрудника");
  const teamAreaRows = model.teamArea.get(areaId) || [];
  if (teamAreaRows.length >= 5) return profile(teamAreaRows, "team-area", "команда + тип работ");
  if (model.records.length >= 8) return profile(model.records, "team", "вся история выбранного состава");
  return null;
}

export function calibrationFor({ model, employee, areaId, fallbackSpreadPercent = 20, completeness = 50 }) {
  const selected = pickProfile(model, employee, areaId);
  const fallbackRatio = Number.isFinite(employee.estimateRatio) ? employee.estimateRatio : 1;
  const p50 = clamp(selected?.p50 ?? fallbackRatio, 0.65, 2.5);
  const fallbackSpread = clamp(fallbackSpreadPercent, 5, 100) / 100;
  const completenessFactor = clamp(completeness, 0, 100) / 100;
  const evidenceWeight = selected
    ? clamp(selected.sample / 8, 0.25, 1) * (0.55 + completenessFactor * 0.45)
    : 0;
  const empiricalP80Spread = selected ? clamp(selected.p80 / Math.max(0.01, selected.p50) - 1, 0.05, 1.25) : fallbackSpread;
  const empiricalP90Spread = selected ? clamp(selected.p90 / Math.max(0.01, selected.p50) - 1, empiricalP80Spread + 0.05, 1.8) : fallbackSpread + 0.2;
  const p80Spread = empiricalP80Spread * evidenceWeight + fallbackSpread * (1 - evidenceWeight);
  const p90Spread = empiricalP90Spread * evidenceWeight + (fallbackSpread + 0.2) * (1 - evidenceWeight);
  const confidence = Math.round(clamp(
    (selected ? 35 + Math.min(45, selected.sample * 6) : 20) * (0.7 + completenessFactor * 0.3),
    10,
    90
  ));
  return {
    area: areaId,
    source: selected?.source || "fallback",
    sourceLabel: selected?.sourceLabel || "общая точность сотрудника + сложность проекта",
    sample: selected?.sample || 0,
    confidence,
    keys: selected?.keys || [],
    factors: {
      optimistic: Number(p50.toFixed(3)),
      realistic: Number((p50 * (1 + p80Spread)).toFixed(3)),
      pessimistic: Number((p50 * (1 + p90Spread)).toFixed(3))
    }
  };
}

export function backtestCalibration(model) {
  const sorted = model.records.slice().sort((left, right) => String(left.resolved).localeCompare(String(right.resolved)));
  const evaluated = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    const previous = sorted.slice(0, index);
    let candidates = previous.filter((row) => row.employeeId === current.employeeId && row.area === current.area);
    let source = "employee-area";
    if (candidates.length < 3) {
      candidates = previous.filter((row) => row.employeeId === current.employeeId);
      source = "employee";
    }
    if (candidates.length < 3) {
      candidates = previous.filter((row) => row.area === current.area);
      source = "team-area";
    }
    if (candidates.length < 3) continue;
    const ratios = candidates.map((row) => row.ratio);
    const predictedRatio = quantile(ratios, 0.5);
    const predictedHours = current.estimateHours * predictedRatio;
    const predictedP80Hours = current.estimateHours * quantile(ratios, 0.8);
    const predictedP90Hours = current.estimateHours * quantile(ratios, 0.9);
    evaluated.push({
      key: current.key,
      source,
      actualHours: current.actualHours,
      predictedHours,
      predictedP80Hours,
      predictedP90Hours,
      absoluteError: Math.abs(predictedHours - current.actualHours),
      signedError: predictedHours - current.actualHours
    });
  }
  const actual = evaluated.reduce((sum, row) => sum + row.actualHours, 0);
  const predicted = evaluated.reduce((sum, row) => sum + row.predictedHours, 0);
  const absoluteError = evaluated.reduce((sum, row) => sum + row.absoluteError, 0);
  return {
    sample: evaluated.length,
    wape: actual > 0 ? Number((absoluteError / actual).toFixed(3)) : null,
    bias: actual > 0 ? Number((predicted / actual).toFixed(3)) : null,
    coverage: {
      p50: evaluated.length ? Number((evaluated.filter((row) => row.actualHours <= row.predictedHours).length / evaluated.length).toFixed(2)) : null,
      p80: evaluated.length ? Number((evaluated.filter((row) => row.actualHours <= row.predictedP80Hours).length / evaluated.length).toFixed(2)) : null,
      p90: evaluated.length ? Number((evaluated.filter((row) => row.actualHours <= row.predictedP90Hours).length / evaluated.length).toFixed(2)) : null
    },
    rows: evaluated.slice(-10)
  };
}
