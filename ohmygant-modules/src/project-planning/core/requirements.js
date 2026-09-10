// Извлечение требований и сверка задач Jira с техническими сигналами репозитория.
import { classifyWork, normalizeText, plainLines, tokenize, unique } from "./classification.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

function isRequirement(line) {
  if (line.length < 12 || line.length > 420) return false;
  if (/^(цель|описание|контекст|требования|результат|важно|примечание|вопросы?)\s*:?\s*$/i.test(line)) return false;
  return /долж|нуж|необходим|реализ|добав|созда|отображ|загруж|выгруж|формир|рассчит|пользоват|сервис|данн|интеграц|настро|поддерж/i.test(line)
    || /[.!?]$/.test(line);
}

const CONCEPTS = [
  ["dependencies", /composer|npm|pip|пакет|зависимост|dependenc/i], ["runtime", /\bphp\b|\bnode(?:\.js)?\b|python|java|runtime/i],
  ["upgrade", /обнов|переход|верс|upgrade/i], ["compatibility", /совместим|несовместим|breaking|deprecated|устар/i],
  ["regression", /регресс|тест|провер|phpunit/i], ["ci", /\bci\b|gitlab-ci|pipeline|docker|runtime|сборк/i],
  ["migration", /миграц|backfill|перенос/i], ["api", /\bapi\b|endpoint|интеграц/i],
  ["frontend", /frontend|фронтенд|интерфейс|экран|форма|react|vue|angular/i],
  ["data", /airflow|\bdag\b|\betl\b|\bdwh\b|витрин|хранилищ|pipeline|sql/i],
  ["analytics", /superset|дашборд|dashboard|отчет/i]
];

function concepts(value) {
  return new Set(CONCEPTS.filter(([, matcher]) => matcher.test(String(value || ""))).map(([name]) => name));
}

function coverageScore(base, repository) {
  const baseWords = new Set(tokenize(base.text));
  const repositoryWords = new Set(tokenize(repository.text));
  const overlap = [...repositoryWords].filter((word) => baseWords.has(word)).length;
  const union = new Set([...baseWords, ...repositoryWords]).size || 1;
  const baseConcepts = concepts(base.text);
  const repositoryConcepts = concepts(repository.text);
  const conceptOverlap = [...repositoryConcepts].filter((concept) => baseConcepts.has(concept)).length;
  let score = overlap / union * 0.35;
  score += conceptOverlap / Math.max(1, repositoryConcepts.size) * 0.35;
  if (classifyWork(base.text).id === (repository.areaHint || classifyWork(repository.text).id)) score += 0.12;
  const kindRules = {
    "dependency-audit": baseConcepts.has("dependencies") || baseConcepts.has("runtime") || /security|поддерж|package/i.test(base.text),
    "dependency-upgrade": baseConcepts.has("upgrade") && (baseConcepts.has("dependencies") || baseConcepts.has("runtime")),
    "breaking-changes": baseConcepts.has("compatibility") || /синтаксис|заглушк|устранить/i.test(base.text),
    regression: baseConcepts.has("regression"),
    "ci-runtime": baseConcepts.has("ci"),
    "data-pipeline": baseConcepts.has("data"),
    "data-migration": baseConcepts.has("data") && baseConcepts.has("migration"),
    "frontend-implementation": baseConcepts.has("frontend"),
    "backend-implementation": baseConcepts.has("api"),
    "integration-change": baseConcepts.has("api")
  };
  if (kindRules[repository.repositoryKind]) score += 0.35;
  return clamp(score, 0, 1);
}

function appendUnique(base, additions, threshold = 0.62) {
  const rows = base.slice();
  for (const row of additions) {
    const candidateWords = tokenize(row.title);
    const duplicate = rows.some((existing) => {
      const normalized = normalizeText(existing.text);
      return candidateWords.filter((word) => normalized.includes(word)).length >= Math.max(2, Math.ceil(candidateWords.length * threshold));
    });
    if (!duplicate) rows.push(row);
  }
  return rows;
}

export function reconcileRequirements(baseRows, repositoryRows) {
  const rows = baseRows.map((row) => ({ ...row, repositoryEvidence: [...(row.repositoryEvidence || [])] }));
  const coverage = [];
  for (const repository of repositoryRows) {
    const candidates = rows
      .filter((row) => row.origin !== "gitlab")
      .map((row, index) => ({ row, index, score: coverageScore(row, repository) }))
      .sort((left, right) => right.score - left.score);
    const match = candidates[0];
    if (match && match.score >= 0.42) {
      const target = rows[match.index];
      const targetEstimateHours = Number(target.explicitHours || target.actualHours || target.suggestedHours || 0);
      target.repositoryEvidence.push({
        kind: repository.repositoryKind,
        title: repository.title,
        suggestedHours: repository.suggestedHours,
        basis: repository.estimateBasis
      });
      target.evidenceSources = unique([...(target.evidenceSources || []), "GitLab"]);
      if (!(target.explicitHours > 0) && !(target.actualHours > 0)) {
        target.suggestedHours = Math.max(Number(target.suggestedHours || 0), Number(repository.suggestedHours || 0));
        target.estimateBasis = `${target.estimateBasis || "Jira"}; подтверждено GitLab: ${repository.estimateBasis}`;
      }
      coverage.push({
        action: "merged", repositoryKind: repository.repositoryKind, repositoryTitle: repository.title,
        targetKey: target.key || "", targetTitle: target.title, score: Number(match.score.toFixed(2)), addedHours: 0,
        targetEstimateHours, repositorySuggestedHours: Number(repository.suggestedHours || 0)
      });
    } else {
      rows.push(repository);
      coverage.push({
        action: "added", repositoryKind: repository.repositoryKind, repositoryTitle: repository.title,
        targetKey: "", targetTitle: "", score: Number((match?.score || 0).toFixed(2)), addedHours: repository.suggestedHours,
        targetEstimateHours: 0, repositorySuggestedHours: Number(repository.suggestedHours || 0)
      });
    }
  }
  return { rows, coverage };
}

export function requirementRows(source) {
  const children = (source.children || []).filter((item) => item.summary);
  const childRows = children.map((item) => ({
    key: item.key || "",
    title: item.summary,
    text: [item.summary, item.description].filter(Boolean).join(". "),
    explicitHours: Number(item.originalEstimateSeconds || 0) / 3600,
    actualHours: Number(item.timeSpentSeconds || 0) / 3600,
    type: item.type || "", origin: "jira", originLabel: "Jira", evidenceSources: ["Jira"],
    dependsOnKeys: item.dependsOnKeys || []
  }));
  const lines = plainLines([source.description, ...(source.comments || []).map((row) => row.body || row)].filter(Boolean).join("\n"));
  const selected = unique(lines.filter(isRequirement).map((line) => line.replace(/[.;]+$/, "").trim())).slice(0, 18);
  const requirementsOrigin = source.documents?.businessRequirements?.provided || source.documents?.systemAnalysis?.provided ? "confluence" : "jira-description";
  const requirementsLabel = requirementsOrigin === "confluence" ? "Jira + Confluence" : "Описание Jira";
  const textRows = selected.map((title) => ({
    key: "", title, text: title, explicitHours: 0, actualHours: 0, type: "",
    origin: requirementsOrigin, originLabel: requirementsLabel, evidenceSources: requirementsOrigin === "confluence" ? ["Jira", "Confluence"] : ["Jira"]
  }));
  const repositoryRows = (source.repositoryAnalysis?.workItems || []).map((item) => ({
    key: "", title: item.title, text: item.text || item.title,
    explicitHours: 0, actualHours: 0, suggestedHours: Number(item.suggestedHours || 0),
    estimateBasis: item.basis || "read-only анализ репозитория", type: "Repository analysis",
    origin: "gitlab", originLabel: "GitLab-анализ", evidenceSources: ["GitLab"], repositoryKind: item.kind || "technical",
    areaHint: item.area || ""
  }));
  let baseRows = [];
  if (childRows.length) {
    const childText = childRows.map((row) => normalizeText(row.text));
    const missing = textRows.filter((row) => {
      const candidate = normalizeText(row.title);
      const candidateWords = tokenize(candidate);
      return !childText.some((existing) => existing.includes(candidate) || candidateWords.filter((word) => existing.includes(word)).length >= Math.max(2, Math.ceil(candidateWords.length * 0.6)));
    });
    baseRows = appendUnique(childRows, missing, 0.6);
  } else if (textRows.length) {
    baseRows = textRows;
  } else {
    baseRows = [{
      key: "", title: source.title || "Реализация требований проекта", text: [source.title, source.description].filter(Boolean).join(". "),
      explicitHours: 0, actualHours: 0, type: "", origin: "jira-description", originLabel: "Описание Jira", evidenceSources: ["Jira"]
    }];
  }
  const reconciliation = reconcileRequirements(baseRows, repositoryRows);
  return { rows: reconciliation.rows.slice(0, 30), repositoryCoverage: reconciliation.coverage };
}
