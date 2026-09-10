// Чистая политика базовой оценки. Классификация предметных областей передаётся
// снаружи, поэтому модуль не зависит от UI, источников данных или конкретных проектов.

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const roundHours = (value) => Math.max(2, Math.round(Number(value || 0) / 2) * 2);

function median(values) {
  const rows = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
}

function issueHours(issue) {
  const actual = Number(issue.timeSpentSeconds || 0) / 3600;
  const estimate = Number(issue.originalEstimateSeconds || 0) / 3600;
  return actual > 0 ? actual : estimate > 0 ? estimate : null;
}

function complexityMultiplier(text, normalize, tokenize) {
  const normalized = normalize(text);
  let value = 1;
  if (/интеграц|миграц|источник|внешн|нескольк систем/.test(normalized)) value += 0.25;
  if (/роль|доступ|персональн|безопасн/.test(normalized)) value += 0.15;
  if (/реальн времени|онлайн|sla|производительн|миллион|больш.*объем/.test(normalized)) value += 0.25;
  if (tokenize(text).length > 35) value += 0.15;
  return clamp(value, 0.8, 1.8);
}

function explanation({ method, label, formula, resultHours, inputs, evidenceKeys = [] }) {
  return {
    stage: "base-estimate",
    method,
    label,
    formula,
    resultHours,
    inputs,
    evidenceKeys: evidenceKeys.filter(Boolean)
  };
}

export function createEstimationPolicy({ areas, classify, tokenize, normalize }) {
  if (!Array.isArray(areas) || typeof classify !== "function" || typeof tokenize !== "function" || typeof normalize !== "function") {
    throw new Error("Estimation policy requires areas, classify, tokenize and normalize");
  }

  function analoguesFor(row, history) {
    const target = new Set(tokenize(row.text));
    if (!target.size) return [];
    return (history || []).map((issue) => {
      const effort = issueHours(issue);
      if (!(effort > 0)) return null;
      const issueWords = tokenize(`${issue.summary} ${issue.type} ${(issue.components || []).join(" ")} ${(issue.labels || []).join(" ")}`);
      const overlap = issueWords.filter((word) => target.has(word)).length;
      const areaBonus = classify(issue.summary).id === classify(row.text).id ? 1.5 : 0;
      const similarity = (overlap + areaBonus) / Math.max(3, Math.sqrt(target.size * Math.max(1, issueWords.length)));
      return similarity > 0.08 ? { key: issue.key, summary: issue.summary, hours: effort, similarity } : null;
    }).filter(Boolean).sort((left, right) => right.similarity - left.similarity).slice(0, 7);
  }

  function estimate(row, history) {
    const area = areas.find((candidate) => candidate.id === row.areaHint) || classify(row.text);
    const analogues = analoguesFor(row, history);
    const historical = median(analogues.slice(0, 5).map((item) => item.hours));
    if (row.explicitHours > 0) {
      const hours = roundHours(row.explicitHours);
      return {
        hours, area, confidence: 90, basis: `${row.key || "Jira"}: Initial Estimate`, analogues,
        explanation: explanation({
          method: "jira-initial-estimate", label: "Initial Estimate Jira", formula: "Initial Estimate",
          resultHours: hours, inputs: [{ label: "Initial Estimate", value: row.explicitHours, unit: "ч" }], evidenceKeys: [row.key]
        })
      };
    }
    if (row.actualHours > 0) {
      const hours = roundHours(row.actualHours);
      return {
        hours, area, confidence: 85, basis: `${row.key || "Jira"}: фактический worklog`, analogues,
        explanation: explanation({
          method: "jira-worklog", label: "Фактический worklog Jira/Tempo", formula: "Фактически списанное время",
          resultHours: hours, inputs: [{ label: "Worklog", value: row.actualHours, unit: "ч" }], evidenceKeys: [row.key]
        })
      };
    }
    if (row.suggestedHours > 0) {
      const repositoryWeight = historical == null ? 1 : 0.6;
      const historyWeight = historical == null ? 0 : 0.4;
      const raw = row.suggestedHours * repositoryWeight + Number(historical || 0) * historyWeight;
      const hours = roundHours(raw);
      return {
        hours, area, confidence: historical == null ? 70 : 78,
        basis: historical == null
          ? row.estimateBasis || "read-only анализ репозитория"
          : `${row.estimateBasis || "read-only анализ репозитория"} + медиана ${analogues.length} похожих задач Jira`,
        analogues,
        explanation: explanation({
          method: historical == null ? "repository-evidence" : "repository-history-blend",
          label: historical == null ? "Технический ориентир" : "Технический ориентир + аналоги",
          formula: historical == null ? "Технический ориентир" : "Технический ориентир × 60% + медиана аналогов × 40%",
          resultHours: hours,
          inputs: [
            { label: "Технический ориентир", value: row.suggestedHours, unit: "ч", weight: repositoryWeight },
            ...(historical == null ? [] : [{ label: "Медиана аналогов", value: historical, unit: "ч", weight: historyWeight, sample: analogues.length }])
          ],
          evidenceKeys: [row.key, ...analogues.map((item) => item.key)]
        })
      };
    }

    const complexity = complexityMultiplier(row.text, normalize, tokenize);
    const heuristic = area.hours * complexity;
    const heuristicWeight = historical == null ? 1 : 0.35;
    const historyWeight = historical == null ? 0 : 0.65;
    const raw = heuristic * heuristicWeight + Number(historical || 0) * historyWeight;
    const hours = roundHours(clamp(raw, 6, 120));
    return {
      hours, area,
      confidence: historical == null ? 35 : clamp(45 + analogues.length * 7, 45, 80),
      basis: historical == null ? `норматив по типу работ «${area.label}»` : `медиана ${analogues.length} похожих задач Jira`,
      analogues,
      explanation: explanation({
        method: historical == null ? "area-heuristic" : "area-history-blend",
        label: historical == null ? "Норматив типа работ" : "Норматив + исторические аналоги",
        formula: historical == null
          ? "Норматив области × коэффициент сложности"
          : "Норматив области × сложность × 35% + медиана аналогов × 65%",
        resultHours: hours,
        inputs: [
          { label: `Норматив «${area.label}»`, value: area.hours, unit: "ч", weight: heuristicWeight },
          { label: "Коэффициент сложности", value: complexity, unit: "×" },
          ...(historical == null ? [] : [{ label: "Медиана аналогов", value: historical, unit: "ч", weight: historyWeight, sample: analogues.length }])
        ],
        evidenceKeys: [row.key, ...analogues.map((item) => item.key)]
      })
    };
  }

  return Object.freeze({ estimate, analoguesFor });
}
