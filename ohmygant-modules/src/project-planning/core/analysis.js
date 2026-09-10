// Детерминированный оркестратор первичного системного анализа и оценки.
// Сеть и UI находятся за пределами ядра; политики вынесены в отдельные файлы.
import { backtestCalibration, buildCalibration, calibrationFor } from "./calibration.js";
import { AREAS, TECHNOLOGIES, classifyWork, normalizeText, plainLines, tokenize, unique } from "./classification.js";
import { createEstimationPolicy } from "./estimation.js";
import { requirementRows } from "./requirements.js";
import { assignWork, staffingGaps } from "./staffing.js";
import { buildQuestions, expressSystemAnalysis, projectCompleteness, projectComplexity } from "./system-analysis.js";

// Обратная совместимость для интеграций, импортировавших обе функции из analysis.js.
export { composeProjectSource } from "./source-composition.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const roundHours = (value) => Math.max(2, Math.round(Number(value || 0) / 2) * 2);
const estimateRequirement = createEstimationPolicy({
  areas: AREAS,
  classify: classifyWork,
  tokenize,
  normalize: normalizeText
}).estimate;

function resultText(title) {
  const clean = String(title || "").replace(/[.;]+$/, "").trim();
  return `Работающий и проверяемый результат: ${clean.charAt(0).toLocaleLowerCase("ru-RU")}${clean.slice(1)}`;
}

function estimateSystemAnalysis({ systemAnalysis, requirements, complexity, questions, source }) {
  const hours = systemAnalysis.mode === "provided"
    ? roundHours(clamp(4 + requirements.length * 0.5 + complexity.score * 0.5 + questions.length, 4, 24))
    : roundHours(clamp(8 + requirements.length * 1.5 + complexity.score * 2 + questions.length, 8, 64));
  return {
    id: "SA-01",
    sourceKey: source.key || "",
    title: systemAnalysis.mode === "express" ? "Экспресс-системный анализ" : "Проверка и уточнение системного анализа",
    result: "Определены границы, компоненты, взаимодействия, зависимости, допущения и критерии приёмки",
    workPool: systemAnalysis.mode === "express"
      ? "Экспресс-анализ требований, построение компонентного контура, выявление интеграций и рисков, фиксация вопросов"
      : "Проверка готового системного анализа, устранение пробелов и согласование открытых вопросов",
    area: AREAS[0],
    estimateHours: hours,
    confidence: questions.length ? 50 : 70,
    basis: `${complexity.label.toLocaleLowerCase("ru-RU")} сложность · ${requirements.length} требований · ${questions.length} вопросов`,
    estimateExplanation: {
      stage: "base-estimate",
      method: systemAnalysis.mode === "express" ? "express-system-analysis" : "system-analysis-review",
      label: systemAnalysis.mode === "express" ? "Экспресс-системный анализ" : "Проверка системного анализа",
      formula: systemAnalysis.mode === "express"
        ? "База + требования × 1,5 + сложность × 2 + открытые вопросы"
        : "База + требования × 0,5 + сложность × 0,5 + открытые вопросы",
      resultHours: hours,
      inputs: [
        { label: "Требования", value: requirements.length, unit: "шт." },
        { label: "Индекс сложности", value: complexity.score, unit: "балл" },
        { label: "Открытые вопросы", value: questions.length, unit: "шт." }
      ],
      evidenceKeys: [source.key].filter(Boolean)
    },
    origin: "system-analysis",
    originLabel: systemAnalysis.mode === "express" ? "Экспресс-анализ" : "Confluence",
    evidenceSources: systemAnalysis.mode === "express" ? ["Jira", ...(source.repositoryAnalysis?.requested ? ["GitLab"] : [])] : ["Confluence"],
    analogueKeys: [],
    dependsOn: [],
    questions: questions.slice(0, 4)
  };
}

function verificationItems({ implementation, questions }) {
  const qaCoveredHours = implementation.filter((item) => item.area.id === "qa").reduce((sum, item) => sum + item.estimateHours, 0);
  const nonQaItems = implementation.filter((item) => item.area.id !== "qa");
  const nonQaHours = nonQaItems.reduce((sum, item) => sum + item.estimateHours, 0);
  const targetHours = nonQaHours > 0 ? roundHours(clamp(nonQaHours * 0.18, 8, 80)) : 0;
  const residualHours = Math.max(0, targetHours - qaCoveredHours);
  const streamMap = new Map();
  for (const item of nonQaItems) {
    if (!streamMap.has(item.area.id)) streamMap.set(item.area.id, { area: item.area, items: [], hours: 0 });
    const stream = streamMap.get(item.area.id);
    stream.items.push(item);
    stream.hours += item.estimateHours;
  }
  const rawStreams = [...streamMap.values()];
  const streams = residualHours >= rawStreams.length * 2
    ? rawStreams
    : rawStreams.length ? [{ area: { id: "all", label: "Сквозные сценарии" }, items: nonQaItems, hours: nonQaHours }] : [];
  let remainder = residualHours;
  const items = residualHours > 0 ? streams.map((stream, index) => {
    const estimateHours = index === streams.length - 1
      ? remainder
      : Math.min(remainder - (streams.length - index - 1) * 2, roundHours(residualHours * stream.hours / Math.max(1, nonQaHours)));
    remainder -= estimateHours;
    return {
      id: `QA-${String(index + 1).padStart(2, "0")}`,
      sourceKey: "",
      title: `Проверка потока: ${stream.area.label}`,
      result: `${stream.area.label}: результат проверен сразу после готовности потока и подготовлен к общей приёмке`,
      workPool: "Непокрытая часть функциональной и интеграционной проверки, исправлений и подтверждения критериев приёмки",
      area: AREAS.find((area) => area.id === "qa"),
      estimateHours,
      confidence: 55,
      basis: `целевой QA-контур ${targetHours} ч − уже покрыто декомпозицией ${qaCoveredHours} ч; поток ${stream.area.label}`,
      estimateExplanation: {
        stage: "base-estimate",
        method: "residual-verification",
        label: "Непокрытая проверка",
        formula: "Целевой QA-контур − уже покрытая проверка",
        resultHours: estimateHours,
        inputs: [
          { label: "Целевой QA-контур", value: targetHours, unit: "ч" },
          { label: "Уже покрыто", value: qaCoveredHours, unit: "ч" },
          { label: `Доля потока «${stream.area.label}»`, value: stream.hours, unit: "ч реализации" }
        ],
        evidenceKeys: stream.items.map((item) => item.sourceKey).filter(Boolean)
      },
      origin: "qa-residual",
      originLabel: "Непокрытый QA",
      evidenceSources: ["Расчёт покрытия"],
      analogueKeys: [],
      dependsOn: stream.items.map((item) => item.id),
      questions: questions.filter((question) => /приемк/.test(normalizeText(question))).slice(0, 1)
    };
  }) : [];
  return { items, targetHours, coveredHours: qaCoveredHours, residualHours };
}

function implementationItems(requirements, history, questions) {
  const items = requirements.map((row, index) => {
    const estimate = estimateRequirement(row, history);
    return {
      id: `US-${String(index + 1).padStart(2, "0")}`,
      sourceKey: row.key,
      title: row.title,
      result: resultText(row.title),
      workPool: `${estimate.area.label}: уточнение деталей, реализация, самопроверка и подготовка результата к приёмке`,
      area: estimate.area,
      estimateHours: estimate.hours,
      confidence: estimate.confidence,
      basis: estimate.basis,
      estimateExplanation: estimate.explanation,
      origin: row.origin || "jira-description",
      originLabel: row.originLabel || "Jira",
      evidenceSources: row.evidenceSources || ["Jira"],
      repositoryEvidence: row.repositoryEvidence || [],
      analogueKeys: estimate.analogues.slice(0, 5).map((item) => item.key),
      dependsOn: ["SA-01"],
      questions: questions.filter((question) => {
        const normalizedQuestion = normalizeText(question);
        return estimate.area.id === "frontend" ? /макет|приемк/.test(normalizedQuestion)
          : ["data", "analytics"].includes(estimate.area.id) ? /данн|объем|sla|приемк/.test(normalizedQuestion)
          : /приемк|роль|компонент/.test(normalizedQuestion);
      }).slice(0, 2)
    };
  });
  const bySourceKey = new Map(items.filter((item) => item.sourceKey).map((item) => [item.sourceKey, item.id]));
  items.forEach((item, index) => {
    const linked = (requirements[index].dependsOnKeys || []).map((key) => bySourceKey.get(key)).filter(Boolean);
    item.dependsOn = unique(["SA-01", ...linked]);
  });
  return items;
}

function reconcileResult({ assigned, source, requirementResult, completeness, complexity, verification, history, employees }) {
  const gaps = staffingGaps(assigned, employees, history);
  const gapAreas = new Set(gaps.map((gap) => gap.area));
  const calibrationModel = buildCalibration(history, employees, classifyWork);
  const workItems = assigned.map((item) => {
    const employee = employees.find((candidate) => candidate.id === item.assigneeId) || employees[0];
    const calibration = calibrationFor({
      model: calibrationModel,
      employee,
      areaId: item.area?.id || "backend",
      fallbackSpreadPercent: complexity.recommendedUnknownPercent,
      completeness: completeness.score
    });
    return {
      ...item,
      staffingGap: gapAreas.has(item.area?.id),
      calibration,
      forecastConfidence: Math.round(Math.sqrt(Math.max(1, item.confidence) * Math.max(1, calibration.confidence)))
    };
  });
  const totalHours = workItems.reduce((sum, item) => sum + item.estimateHours, 0);
  const weightedConfidence = totalHours
    ? workItems.reduce((sum, item) => sum + item.forecastConfidence * item.estimateHours, 0) / totalHours
    : 0;
  const modelUncertaintyPercent = totalHours ? Math.round(workItems.reduce((sum, item) => {
    const factors = item.calibration.factors;
    return sum + item.estimateHours * Math.max(0, factors.realistic / Math.max(0.01, factors.optimistic) - 1) * 100;
  }, 0) / totalHours) : complexity.recommendedUnknownPercent;
  const ledgerKinds = [
    ["system-analysis", "Системный анализ"], ["jira", "Декомпозиция Jira"],
    ["confluence", "Требования Confluence"], ["jira-description", "Описание Jira"],
    ["gitlab", "Новые работы GitLab"], ["qa-residual", "Непокрытый QA-контур"]
  ];
  const ledger = ledgerKinds.map(([origin, label]) => {
    const rows = workItems.filter((item) => item.origin === origin);
    return { origin, label, hours: roundHours(rows.reduce((sum, item) => sum + item.estimateHours, 0)), itemIds: rows.map((item) => item.id) };
  }).filter((row) => row.itemIds.length);
  const confidence = Math.max(10, Math.round(weightedConfidence * (0.75 + completeness.score / 400)));
  const estimateConflicts = requirementResult.repositoryCoverage.filter((row) =>
    row.action === "merged" && row.targetEstimateHours > 0 && row.repositorySuggestedHours > 0 &&
    Math.abs(row.repositorySuggestedHours - row.targetEstimateHours) / row.targetEstimateHours > 0.5
  );
  const blockers = [];
  const highGaps = gaps.filter((gap) => gap.severity === "high");
  if (highGaps.length) blockers.push(`Не покрыты критичные роли: ${highGaps.map((gap) => gap.suggestedRole).join(", ")}.`);
  if (completeness.score < 60) blockers.push(`Полнота декомпозиции Jira ${completeness.score}% — ниже порога 60%.`);
  if (source.repositoryAnalysis?.requested && !source.repositoryAnalysis.complete) blockers.push("Технический контур GitLab подтверждён не полностью.");
  if (estimateConflicts.length) blockers.push(`По ${estimateConflicts.length} работам оценка Jira отличается от технического ориентира более чем на 50%.`);
  if (confidence < 55) blockers.push(`Доверие к прогнозу ${confidence}% — ниже порога 55%.`);
  return {
    workItems,
    gaps,
    totalHours,
    confidence,
    modelUncertaintyPercent,
    forecastStatus: {
      confirmed: blockers.length === 0,
      code: blockers.length ? "preliminary" : "confirmed",
      label: blockers.length ? "Предварительный прогноз" : "Прогноз подтверждён данными",
      blockers
    },
    calibration: {
      historicalTasks: calibrationModel.records.length,
      profiles: calibrationModel.profiles,
      backtest: backtestCalibration(calibrationModel),
      modelUncertaintyPercent
    },
    reconciliation: {
      repositoryCoverage: requirementResult.repositoryCoverage,
      estimateConflicts,
      qa: verification,
      ledger,
      totalHours: roundHours(totalHours)
    }
  };
}

export function analyzeProject({ source, history = [], employees = [], hoursPerDay = 8 }) {
  if (!source?.title && !source?.description) throw new Error("Источник требований не содержит текста для анализа");
  if (!employees.length) throw new Error("Выберите хотя бы одного сотрудника");
  const requirementResult = requirementRows(source);
  const requirements = requirementResult.rows;
  const explicitTechnologies = TECHNOLOGIES.filter(([, matcher]) => matcher.test(`${source.title} ${source.description}`)).map(([name]) => name);
  const repositoryTechnologies = (source.repositoryAnalysis?.repositories || []).flatMap((repository) => repository.technologyProfile?.technologies || []);
  const technologies = unique([...explicitTechnologies, ...repositoryTechnologies]).slice(0, 12);
  const questions = buildQuestions(source, requirements, technologies);
  const completeness = projectCompleteness(source);
  const complexity = projectComplexity(source, requirements, technologies, questions, completeness);
  const systemAnalysis = expressSystemAnalysis(source, requirements, technologies, questions, complexity);
  const implementation = implementationItems(requirements, history, questions);
  const analysisItem = estimateSystemAnalysis({ systemAnalysis, requirements, complexity, questions, source });
  const verification = verificationItems({ implementation, questions });
  const assigned = assignWork([analysisItem, ...implementation, ...verification.items], employees, history);
  const reconciled = reconcileResult({
    assigned,
    source,
    requirementResult,
    completeness,
    complexity,
    verification: { targetHours: verification.targetHours, coveredHours: verification.coveredHours, residualHours: verification.residualHours },
    history,
    employees
  });
  const firstLine = plainLines(source.description)[0] || source.title;
  return {
    source: { type: source.type || "jira", key: source.key || "", url: source.url || "", title: source.title || "Проект", documents: source.documents || null },
    goal: firstLine,
    technologies,
    requirements: requirements.map((row) => row.title),
    questions,
    completeness,
    systemAnalysis,
    complexity,
    repositoryAnalysis: source.repositoryAnalysis || null,
    staffingGaps: reconciled.gaps,
    forecastStatus: reconciled.forecastStatus,
    reconciliation: reconciled.reconciliation,
    calibration: reconciled.calibration,
    workItems: reconciled.workItems,
    baseHours: roundHours(reconciled.totalHours),
    baseDays: Number((reconciled.totalHours / Math.max(1, hoursPerDay)).toFixed(1)),
    confidence: reconciled.confidence,
    recommendedUnknownPercent: reconciled.modelUncertaintyPercent,
    basis: (source.children || []).length
      ? `Декомпозиция построена по ${source.children.length} существующим задачам Jira.`
      : `Декомпозиция построена по ${requirements.length} требованиям из описания; до ответов на вопросы это предварительная оценка.`
  };
}
