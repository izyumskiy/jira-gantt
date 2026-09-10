// Детерминированный первичный системный анализ и оценка по требованиям.
// Модуль не обращается к сети: источник и история Jira передаются снаружи.
import { backtestCalibration, buildCalibration, calibrationFor } from "./calibration.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const median = (values) => {
  const rows = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};
const normalize = (value) => String(value || "")
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9+#.]+/gi, " ")
  .trim();
const uniq = (values) => [...new Set(values.filter(Boolean))];
const roundHours = (value) => Math.max(2, Math.round(Number(value || 0) / 2) * 2);

const STOP = new Set("и в во на по для из от до с со к ко о об а но или что это как при над под за уже нужно должен должна должны будет быть есть через без между после перед проект задача задачи функционал система данные".split(" "));

const AREAS = [
  { id: "analysis", label: "Системный анализ", hours: 12, words: ["требован", "анализ", "согласован", "сценари", "бизнес", "процесс"] },
  { id: "frontend", label: "Frontend", hours: 24, words: ["frontend", "фронтенд", "ui", "ux", "интерфейс", "форма", "экран", "страниц", "виджет"] },
  { id: "backend", label: "Backend / API", hours: 28, words: ["backend", "бэкенд", "api", "endpoint", "rest", "сервис", "интеграц", "webhook"] },
  { id: "data", label: "Платформа данных", hours: 32, words: ["airflow", "dag", "etl", "elt", "dwh", "хранилищ", "витрин", "pipeline", "пайплайн", "загрузк", "sql", "баз данных"] },
  { id: "analytics", label: "BI / аналитика", hours: 24, words: ["superset", "dashboard", "дашборд", "отчет", "аналитик", "график", "метрик"] },
  { id: "qa", label: "Проверка результата", hours: 16, words: ["qa", "тест", "провер", "приемк", "acceptance"] },
  { id: "access", label: "Доступы и роли", hours: 18, words: ["роль", "прав", "доступ", "авторизац", "аутентификац", "permission"] }
];

const TECHNOLOGIES = [
  ["Laravel", /\blaravel\b/i],
  ["PHP / Composer", /\bphp\b|\bcomposer\b/i],
  ["Airflow", /\bairflow\b|\bdag\b/i],
  ["Superset", /\bsuperset\b/i],
  ["SQL / DWH", /\bsql\b|\bdwh\b|хранилищ|витрин/i],
  ["REST API", /\brest\b|\bapi\b|endpoint/i],
  ["Frontend", /frontend|фронтенд|интерфейс|\bui\b/i],
  ["Backend", /backend|бэкенд|сервис/i]
];

function words(value) {
  return uniq(normalize(value).split(/\s+/).filter((word) => word.length >= 3 && !STOP.has(word)));
}

function classify(value) {
  const haystack = normalize(value);
  let best = AREAS[2];
  let score = 0;
  for (const area of AREAS) {
    const matched = area.words.filter((word) => haystack.includes(word)).length;
    if (matched > score) {
      best = area;
      score = matched;
    }
  }
  return best;
}

function plainLines(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\{[^}\n]+\}/g, " ")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]+|\d+[.)]|h\d\.|#+)\s*/, "").trim())
    .filter(Boolean);
}

function isRequirement(line) {
  if (line.length < 12 || line.length > 420) return false;
  if (/^(цель|описание|контекст|требования|результат|важно|примечание|вопросы?)\s*:?\s*$/i.test(line)) return false;
  return /долж|нуж|необходим|реализ|добав|созда|отображ|загруж|выгруж|формир|рассчит|пользоват|сервис|данн|интеграц|настро|поддерж/i.test(line)
    || /[.!?]$/.test(line);
}

const CONCEPTS = [
  ["laravel", /laravel/i], ["php", /\bphp\b/i], ["composer", /composer|пакет|зависимост/i],
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
  const baseWords = new Set(words(base.text));
  const repositoryWords = new Set(words(repository.text));
  const overlap = [...repositoryWords].filter((word) => baseWords.has(word)).length;
  const union = new Set([...baseWords, ...repositoryWords]).size || 1;
  const baseConcepts = concepts(base.text);
  const repositoryConcepts = concepts(repository.text);
  const conceptOverlap = [...repositoryConcepts].filter((concept) => baseConcepts.has(concept)).length;
  let score = overlap / union * 0.35;
  score += conceptOverlap / Math.max(1, repositoryConcepts.size) * 0.35;
  if (classify(base.text).id === (repository.areaHint || classify(repository.text).id)) score += 0.12;
  const kindRules = {
    "framework-upgrade": baseConcepts.has("laravel") && baseConcepts.has("upgrade"),
    "dependency-audit": baseConcepts.has("composer") || /security|поддерж|doctrine|predis|package/i.test(base.text),
    "dependency-upgrade": baseConcepts.has("upgrade") && /зависим|пакет|runtime|node|python|php|java/i.test(base.text),
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
    const candidateWords = words(row.title);
    const duplicate = rows.some((existing) => {
      const normalized = normalize(existing.text);
      return candidateWords.filter((word) => normalized.includes(word)).length >= Math.max(2, Math.ceil(candidateWords.length * threshold));
    });
    if (!duplicate) rows.push(row);
  }
  return rows;
}

function reconcileRepositories(baseRows, repositoryRows) {
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
      target.evidenceSources = uniq([...(target.evidenceSources || []), "GitLab"]);
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

function requirementRows(source) {
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
  const selected = uniq(lines.filter(isRequirement).map((line) => line.replace(/[.;]+$/, "").trim())).slice(0, 18);
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
    const childText = childRows.map((row) => normalize(row.text));
    const missing = textRows.filter((row) => {
      const candidate = normalize(row.title);
      const candidateWords = words(candidate);
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
  const reconciliation = reconcileRepositories(baseRows, repositoryRows);
  return { rows: reconciliation.rows.slice(0, 30), repositoryCoverage: reconciliation.coverage };
}

export function composeProjectSource({ jira, businessRequirements = null, systemAnalysis = null, repositoryAnalysis = null }) {
  if (!jira) throw new Error("Укажите проект или эпик Jira");
  const documents = {
    businessRequirements: {
      kind: "businessRequirements",
      label: "Бизнес-требования",
      provided: Boolean(businessRequirements),
      title: businessRequirements?.title || "",
      url: businessRequirements?.url || ""
    },
    systemAnalysis: {
      kind: "systemAnalysis",
      label: "Системный анализ",
      provided: Boolean(systemAnalysis),
      title: systemAnalysis?.title || "",
      url: systemAnalysis?.url || ""
    }
  };
  const sections = [
    jira.description || "",
    businessRequirements ? `Confluence — бизнес-требования: ${businessRequirements.title}\n${businessRequirements.description || ""}` : "",
    systemAnalysis ? `Confluence — системный анализ: ${systemAnalysis.title}\n${systemAnalysis.description || ""}` : ""
  ].filter(Boolean);
  return {
    ...jira,
    description: sections.join("\n\n"),
    comments: [
      ...(jira.comments || []),
      ...(businessRequirements?.comments || []),
      ...(systemAnalysis?.comments || [])
    ],
    documents,
    repositoryAnalysis
  };
}

function issueHours(issue) {
  const actual = Number(issue.timeSpentSeconds || 0) / 3600;
  const estimate = Number(issue.originalEstimateSeconds || 0) / 3600;
  return actual > 0 ? actual : estimate > 0 ? estimate : null;
}

function analoguesFor(row, history) {
  const target = new Set(words(row.text));
  if (!target.size) return [];
  return (history || []).map((issue) => {
    const effort = issueHours(issue);
    if (!(effort > 0)) return null;
    const issueWords = words(`${issue.summary} ${issue.type} ${(issue.components || []).join(" ")} ${(issue.labels || []).join(" ")}`);
    const overlap = issueWords.filter((word) => target.has(word)).length;
    const areaBonus = classify(issue.summary).id === classify(row.text).id ? 1.5 : 0;
    const similarity = (overlap + areaBonus) / Math.max(3, Math.sqrt(target.size * Math.max(1, issueWords.length)));
    return similarity > 0.08 ? { key: issue.key, summary: issue.summary, hours: effort, similarity } : null;
  }).filter(Boolean).sort((left, right) => right.similarity - left.similarity).slice(0, 7);
}

function complexityMultiplier(text) {
  const normalized = normalize(text);
  let value = 1;
  if (/интеграц|миграц|источник|внешн|нескольк систем/.test(normalized)) value += 0.25;
  if (/роль|доступ|персональн|безопасн/.test(normalized)) value += 0.15;
  if (/реальн времени|онлайн|sla|производительн|миллион|больш.*объем/.test(normalized)) value += 0.25;
  if (words(text).length > 35) value += 0.15;
  return clamp(value, 0.8, 1.8);
}

function estimateRequirement(row, history) {
  const area = AREAS.find((candidate) => candidate.id === row.areaHint) || classify(row.text);
  const analogues = analoguesFor(row, history);
  const historical = median(analogues.slice(0, 5).map((item) => item.hours));
  if (row.explicitHours > 0) return {
    hours: roundHours(row.explicitHours), area, confidence: 90,
    basis: `${row.key || "Jira"}: Initial Estimate`, analogues
  };
  if (row.actualHours > 0) return {
    hours: roundHours(row.actualHours), area, confidence: 85,
    basis: `${row.key || "Jira"}: фактический worklog`, analogues
  };
  if (row.suggestedHours > 0) return {
    hours: roundHours(historical == null ? row.suggestedHours : row.suggestedHours * 0.6 + historical * 0.4),
    area, confidence: historical == null ? 70 : 78,
    basis: historical == null
      ? row.estimateBasis || "read-only анализ репозитория"
      : `${row.estimateBasis || "read-only анализ репозитория"} + медиана ${analogues.length} похожих задач Jira`,
    analogues
  };
  const heuristic = area.hours * complexityMultiplier(row.text);
  const hours = historical == null ? heuristic : heuristic * 0.35 + historical * 0.65;
  return {
    hours: roundHours(clamp(hours, 6, 120)), area,
    confidence: historical == null ? 35 : clamp(45 + analogues.length * 7, 45, 80),
    basis: historical == null
      ? `норматив по типу работ «${area.label}»`
      : `медиана ${analogues.length} похожих задач Jira`,
    analogues
  };
}

function employeeAreas(employee, history) {
  const tokens = normalize([...(employee.roles || []), ...(employee.skills || []), employee.grade].join(" "));
  const result = new Set();
  for (const area of AREAS) if (area.words.some((word) => tokens.includes(word))) result.add(area.id);
  if (/разработчик|developer/.test(tokens)) result.add("backend");
  const historicalAreas = new Map();
  for (const issue of history || []) {
    const actor = issue.assignee || {};
    const aliases = [employee.accountId, employee.username, employee.key, employee.displayName, ...(employee.aliases || [])].map(normalize);
    const issueAliases = [actor.accountId, actor.username, actor.key, actor.displayName].map(normalize);
    if (aliases.some((alias) => alias && issueAliases.includes(alias))) {
      const area = classify(`${issue.summary} ${(issue.components || []).join(" ")}`).id;
      historicalAreas.set(area, (historicalAreas.get(area) || 0) + 1);
    }
  }
  for (const [area, count] of historicalAreas) if (count >= 3) result.add(area);
  return result;
}

function staffingGaps(items, employees, history) {
  const employeeAreaMap = new Map(employees.map((employee) => [employee.id, employeeAreas(employee, history)]));
  const required = new Map();
  for (const item of items) {
    if (!item.area?.id) continue;
    if (!required.has(item.area.id)) required.set(item.area.id, { area: item.area.id, label: item.area.label, hours: 0, itemIds: [] });
    const row = required.get(item.area.id);
    row.hours += Number(item.estimateHours || 0);
    row.itemIds.push(item.id);
  }
  const roles = {
    analysis: "системный или бизнес-аналитик",
    frontend: "frontend-разработчик",
    backend: "backend-разработчик",
    data: "разработчик платформы данных / ETL",
    analytics: "BI-разработчик / аналитик Superset",
    qa: "QA-инженер",
    access: "backend-разработчик с опытом IAM/доступов"
  };
  return [...required.values()].filter((requirement) =>
    !employees.some((employee) => employeeAreaMap.get(employee.id)?.has(requirement.area))
  ).map((requirement) => ({
    ...requirement,
    suggestedRole: roles[requirement.area] || requirement.label,
    severity: requirement.area === "analysis" ? "medium" : "high",
    message: `В выбранном составе не найден ${roles[requirement.area] || requirement.label}; ${Math.round(requirement.hours)} ч назначены предварительно.`
  }));
}

function assign(items, employees, history) {
  const allocated = new Map(employees.map((employee) => [employee.id, 0]));
  const areas = new Map(employees.map((employee) => [employee.id, employeeAreas(employee, history)]));
  return items.map((item) => {
    const ranked = employees.slice().sort((left, right) => {
      const leftMatch = areas.get(left.id)?.has(item.area.id) ? 2 : 0;
      const rightMatch = areas.get(right.id)?.has(item.area.id) ? 2 : 0;
      const leftReliability = Number.isFinite(left.score) ? left.score / 100 : 0.65;
      const rightReliability = Number.isFinite(right.score) ? right.score / 100 : 0.65;
      const leftLoad = allocated.get(left.id) / Math.max(0.1, Number(left.commitment || 100) / 100);
      const rightLoad = allocated.get(right.id) / Math.max(0.1, Number(right.commitment || 100) / 100);
      return (rightMatch + rightReliability - rightLoad / 200) - (leftMatch + leftReliability - leftLoad / 200);
    });
    const employee = ranked[0];
    allocated.set(employee.id, allocated.get(employee.id) + item.estimateHours);
    return { ...item, assigneeId: employee.id, assigneeName: employee.displayName || employee.username || employee.id };
  });
}

function buildQuestions(source, requirements, technologies) {
  const text = normalize([source.title, source.description, ...requirements.map((row) => row.text)].join(" "));
  const questions = [];
  if (source.documents && !source.documents.businessRequirements?.provided) questions.push("Бизнес-требования не проработаны: необходимо зафиксировать цели, границы и критерии успеха в Confluence.");
  if (String(source.description || "").trim().length < 120) questions.push("Какой бизнес-результат и измеримый критерий успеха должны быть получены?");
  if (!/критери|приемк|acceptance|готово когда|результат/.test(text)) questions.push("Каковы критерии приёмки и кто подтверждает результат?");
  if (/интеграц|airflow|etl|загрузк|api|источник/.test(text) && !/источник данных|source|откуда|endpoint|система источник/.test(text)) questions.push("Какие системы и наборы данных являются источниками, каковы форматы и владельцы?");
  if (/данн|airflow|etl|витрин|superset|api/.test(text) && !/объем|sla|частот|расписан|latency|производительн/.test(text)) questions.push("Каковы объёмы, частота обновления, SLA и требования к производительности?");
  if (/интерфейс|frontend|фронтенд|экран|форма/.test(text) && !/макет|figma|прототип|дизайн/.test(text)) questions.push("Есть ли согласованный макет и состояния интерфейса, включая ошибки и пустые данные?");
  if (/роль|доступ|авторизац|персональн/.test(text) && !/матриц|какие роли|permission/.test(text)) questions.push("Какие роли и ограничения доступа должны применяться?");
  if (!/срок|дедлайн|planned end|до \d|релиз/.test(text)) questions.push("Есть ли обязательный срок или внешняя дата запуска?");
  if (!technologies.length) questions.push("Какие из уже используемых в проекте компонентов должны быть изменены и в каких репозиториях?");
  return questions.slice(0, 8);
}

function projectCompleteness(source) {
  const children = source.children || [];
  if (!children.length) return {
    score: String(source.description || "").trim().length >= 120 ? 45 : 25,
    total: 0, described: 0, estimated: 0, assigned: 0, withAcceptance: 0,
    message: "В Jira нет дочерней декомпозиции; полнота рассчитана только по описанию проекта."
  };
  const described = children.filter((item) => String(item.description || "").trim().length >= 40).length;
  const estimated = children.filter((item) => Number(item.originalEstimateSeconds || 0) > 0).length;
  const assigned = children.filter((item) => item.assignee?.accountId || item.assignee?.username || item.assignee?.displayName).length;
  const withAcceptance = children.filter((item) => /критери|приемк|acceptance|готово когда|результат/i.test(item.description || "")).length;
  const score = Math.round((described + estimated + assigned + withAcceptance) / (children.length * 4) * 100);
  return {
    score, total: children.length, described, estimated, assigned, withAcceptance,
    message: score >= 80 ? "Декомпозиция Jira заполнена достаточно полно."
      : `Требуют заполнения: описание — ${children.length - described}, Initial Estimate — ${children.length - estimated}, ответственный — ${children.length - assigned}, критерии приёмки — ${children.length - withAcceptance}.`
  };
}

function projectComplexity(source, requirements, technologies, questions, completeness) {
  const text = normalize(`${source.title} ${source.description}`);
  const drivers = [];
  if (requirements.length >= 5) drivers.push({ label: `${requirements.length} функциональных блоков`, weight: requirements.length >= 12 ? 4 : 2 });
  if (technologies.length >= 3) drivers.push({ label: `${technologies.length} затронутых компонентов`, weight: technologies.length >= 5 ? 4 : 2 });
  if (/интеграц|api|endpoint|внешн.*систем|webhook/.test(text)) drivers.push({ label: "межсистемные интеграции", weight: 3 });
  if (/airflow|etl|elt|dwh|хранилищ|витрин|миграц|загрузк.*данн/.test(text)) drivers.push({ label: "контуры данных и загрузки", weight: 3 });
  if (/роль|доступ|авторизац|персональн|безопасн/.test(text)) drivers.push({ label: "доступы и безопасность", weight: 2 });
  if (/реальн времени|онлайн|sla|производительн|миллион|больш.*объем/.test(text)) drivers.push({ label: "нефункциональные ограничения", weight: 3 });
  if ((source.children || []).length >= 10) drivers.push({ label: `${source.children.length} существующих задач Jira`, weight: 2 });
  if (completeness.score < 50) drivers.push({ label: `низкая полнота Jira (${completeness.score}%)`, weight: 3 });
  else if (completeness.score < 75) drivers.push({ label: `частичная полнота Jira (${completeness.score}%)`, weight: 1 });
  if (questions.length >= 4) drivers.push({ label: `${questions.length} открытых вопросов`, weight: questions.length >= 7 ? 3 : 2 });
  if (source.repositoryAnalysis?.workItems?.length >= 3) drivers.push({ label: "подтверждённые репозиторием технические изменения", weight: 2 });
  const score = drivers.reduce((sum, driver) => sum + driver.weight, 0);
  const level = score >= 14 ? "veryHigh" : score >= 9 ? "high" : score >= 4 ? "medium" : "low";
  const labels = { low: "Низкая", medium: "Средняя", high: "Высокая", veryHigh: "Очень высокая" };
  const reserve = Math.round(clamp(8 + score * 2, 8, 40));
  return { score, level, label: labels[level], drivers, recommendedUnknownPercent: reserve };
}

function expressSystemAnalysis(source, requirements, technologies, questions, complexity) {
  const text = normalize(`${source.title} ${source.description}`);
  const provided = Boolean(source.documents?.systemAnalysis?.provided);
  const components = technologies.length
    ? technologies
    : uniq(requirements.map((row) => classify(row.text).label));
  const interactions = [];
  if (/airflow|etl|elt|загрузк|витрин|dwh|хранилищ/.test(text)) interactions.push("Источник данных → обработка/загрузка → хранилище или витрина → потребитель");
  if (/api|endpoint|интеграц|webhook/.test(text)) interactions.push("Система-инициатор → существующий API/интеграционный контракт → целевая система");
  if (/frontend|фронтенд|интерфейс|экран|форма/.test(text)) interactions.push("Пользователь → интерфейс → существующий backend/API → данные");
  if (/superset|дашборд|отчет|аналитик/.test(text)) interactions.push("Подготовленная витрина → Superset/аналитический слой → бизнес-пользователь");
  if (!interactions.length) interactions.push("Пользовательский сценарий → изменяемый компонент → проверяемый результат");
  const risks = [];
  if (questions.some((question) => /объем|sla|производительн|частот/i.test(question))) risks.push("Не зафиксированы объёмы, частота или SLA");
  if (questions.some((question) => /критери.*приемк|подтверждает результат/i.test(question))) risks.push("Не определены полные критерии приёмки и владелец результата");
  if (questions.some((question) => /источник|наборы данных|формат/i.test(question))) risks.push("Требуется подтвердить источники и контракты данных");
  if (questions.some((question) => /роль|доступ/i.test(question))) risks.push("Требуется подтвердить матрицу доступов");
  const assumptions = [
    "Используются только уже применяемые в проекте компоненты и практики.",
    "Технологии, которых нет в Jira/Confluence или истории проекта, не предполагаются.",
    "Открытые вопросы должны быть подтверждены до фиксации окончательной оценки."
  ];
  const extended = Boolean(source.repositoryAnalysis?.requested);
  return {
    mode: provided ? "provided" : "express",
    extended,
    title: provided
      ? extended ? "Системный анализ из Confluence проверен по репозиториям" : "Системный анализ из Confluence проверен и дополнен"
      : extended ? "Расширенный экспресс-анализ сформирован по Jira и репозиториям" : "Экспресс-системный анализ сформирован инструментом",
    components,
    interactions,
    risks,
    assumptions,
    complexity
  };
}

function resultText(title) {
  const clean = String(title || "").replace(/[.;]+$/, "").trim();
  return `Работающий и проверяемый результат: ${clean.charAt(0).toLocaleLowerCase("ru-RU")}${clean.slice(1)}`;
}

export function analyzeProject({ source, history = [], employees = [], hoursPerDay = 8 }) {
  if (!source?.title && !source?.description) throw new Error("Источник требований не содержит текста для анализа");
  if (!employees.length) throw new Error("Выберите хотя бы одного сотрудника");
  const requirementResult = requirementRows(source);
  const requirements = requirementResult.rows;
  const explicitTechnologies = TECHNOLOGIES.filter(([, matcher]) => matcher.test(`${source.title} ${source.description}`)).map(([name]) => name);
  const repositoryTechnologies = (source.repositoryAnalysis?.repositories || [])
    .flatMap((repository) => repository.technologyProfile?.technologies || []);
  const technologies = uniq([...explicitTechnologies, ...repositoryTechnologies]).slice(0, 12);
  const questions = buildQuestions(source, requirements, technologies);
  const completeness = projectCompleteness(source);
  const complexity = projectComplexity(source, requirements, technologies, questions, completeness);
  const systemAnalysis = expressSystemAnalysis(source, requirements, technologies, questions, complexity);
  const implementation = requirements.map((row, index) => {
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
      origin: row.origin || "jira-description",
      originLabel: row.originLabel || "Jira",
      evidenceSources: row.evidenceSources || ["Jira"],
      repositoryEvidence: row.repositoryEvidence || [],
      analogueKeys: estimate.analogues.slice(0, 5).map((item) => item.key),
      dependsOn: ["SA-01"],
      questions: questions.filter((question) => {
        const q = normalize(question);
        return estimate.area.id === "frontend" ? /макет|приемк/.test(q)
          : ["data", "analytics"].includes(estimate.area.id) ? /данн|объем|sla|приемк/.test(q)
          : /приемк|роль|компонент/.test(q);
      }).slice(0, 2)
    };
  });
  const implementationBySourceKey = new Map(implementation.filter((item) => item.sourceKey).map((item) => [item.sourceKey, item.id]));
  implementation.forEach((item, index) => {
    const linked = (requirements[index].dependsOnKeys || []).map((key) => implementationBySourceKey.get(key)).filter(Boolean);
    item.dependsOn = uniq(["SA-01", ...linked]);
  });

  const analysisHours = systemAnalysis.mode === "provided"
    ? roundHours(clamp(4 + requirements.length * 0.5 + complexity.score * 0.5 + questions.length, 4, 24))
    : roundHours(clamp(8 + requirements.length * 1.5 + complexity.score * 2 + questions.length, 8, 64));
  const implementationHours = implementation.reduce((sum, item) => sum + item.estimateHours, 0);
  const qaCoveredHours = implementation.filter((item) => item.area.id === "qa").reduce((sum, item) => sum + item.estimateHours, 0);
  const nonQaImplementationHours = implementationHours - qaCoveredHours;
  const targetVerificationHours = nonQaImplementationHours > 0 ? roundHours(clamp(nonQaImplementationHours * 0.18, 8, 80)) : 0;
  const residualVerificationHours = Math.max(0, targetVerificationHours - qaCoveredHours);
  const analysisItem = {
      id: "SA-01", sourceKey: source.key || "", title: systemAnalysis.mode === "express" ? "Экспресс-системный анализ" : "Проверка и уточнение системного анализа",
      result: "Определены границы, компоненты, взаимодействия, зависимости, допущения и критерии приёмки",
      workPool: systemAnalysis.mode === "express"
        ? "Экспресс-анализ требований, построение компонентного контура, выявление интеграций и рисков, фиксация вопросов"
        : "Проверка готового системного анализа, устранение пробелов и согласование открытых вопросов",
      area: AREAS[0], estimateHours: analysisHours, confidence: questions.length ? 50 : 70,
      basis: `${complexity.label.toLocaleLowerCase("ru-RU")} сложность · ${requirements.length} требований · ${questions.length} вопросов`,
      origin: "system-analysis", originLabel: systemAnalysis.mode === "express" ? "Экспресс-анализ" : "Confluence",
      evidenceSources: systemAnalysis.mode === "express" ? ["Jira", ...(source.repositoryAnalysis?.requested ? ["GitLab"] : [])] : ["Confluence"],
      analogueKeys: [], dependsOn: [], questions: questions.slice(0, 4)
    };
  const streamMap = new Map();
  for (const item of implementation.filter((row) => row.area.id !== "qa")) {
    if (!streamMap.has(item.area.id)) streamMap.set(item.area.id, { area: item.area, items: [], hours: 0 });
    const stream = streamMap.get(item.area.id);
    stream.items.push(item);
    stream.hours += item.estimateHours;
  }
  const rawStreams = [...streamMap.values()];
  const verificationStreams = residualVerificationHours >= rawStreams.length * 2
    ? rawStreams
    : rawStreams.length ? [{ area: { id: "all", label: "Сквозные сценарии" }, items: rawStreams.flatMap((stream) => stream.items), hours: nonQaImplementationHours }] : [];
  let verificationRemainder = residualVerificationHours;
  const verificationItems = residualVerificationHours > 0 ? verificationStreams.map((stream, index) => {
    const estimateHours = index === verificationStreams.length - 1
      ? verificationRemainder
      : Math.min(verificationRemainder - (verificationStreams.length - index - 1) * 2, roundHours(residualVerificationHours * stream.hours / Math.max(1, nonQaImplementationHours)));
    verificationRemainder -= estimateHours;
    return {
      id: `QA-${String(index + 1).padStart(2, "0")}`, sourceKey: "", title: `Проверка потока: ${stream.area.label}`,
      result: `${stream.area.label}: результат проверен сразу после готовности потока и подготовлен к общей приёмке`,
      workPool: "Непокрытая часть функциональной и интеграционной проверки, исправлений и подтверждения критериев приёмки",
      area: AREAS.find((area) => area.id === "qa"), estimateHours,
      confidence: 55,
      basis: `целевой QA-контур ${targetVerificationHours} ч − уже покрыто декомпозицией ${qaCoveredHours} ч; поток ${stream.area.label}`,
      origin: "qa-residual", originLabel: "Непокрытый QA", evidenceSources: ["Расчёт покрытия"],
      analogueKeys: [], dependsOn: stream.items.map((item) => item.id), questions: questions.filter((question) => /приемк/.test(normalize(question))).slice(0, 1)
    };
  }) : [];
  const workItems = [analysisItem, ...implementation, ...verificationItems];
  const assigned = assign(workItems, employees, history);
  const gaps = staffingGaps(assigned, employees, history);
  const gapAreas = new Set(gaps.map((gap) => gap.area));
  const calibrationModel = buildCalibration(history, employees, classify);
  const calibrationBacktest = backtestCalibration(calibrationModel);
  const assignedWithCoverage = assigned.map((item) => {
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
  const totalHours = assignedWithCoverage.reduce((sum, item) => sum + item.estimateHours, 0);
  const weightedConfidence = totalHours
    ? assignedWithCoverage.reduce((sum, item) => sum + item.forecastConfidence * item.estimateHours, 0) / totalHours
    : 0;
  const modelUncertaintyPercent = totalHours ? Math.round(assignedWithCoverage.reduce((sum, item) => {
    const factors = item.calibration.factors;
    return sum + item.estimateHours * Math.max(0, factors.realistic / Math.max(0.01, factors.optimistic) - 1) * 100;
  }, 0) / totalHours) : complexity.recommendedUnknownPercent;
  const ledgerKinds = [
    ["system-analysis", "Системный анализ"],
    ["jira", "Декомпозиция Jira"],
    ["confluence", "Требования Confluence"],
    ["jira-description", "Описание Jira"],
    ["gitlab", "Новые работы GitLab"],
    ["qa-residual", "Непокрытый QA-контур"]
  ];
  const ledger = ledgerKinds.map(([origin, label]) => {
    const rows = assignedWithCoverage.filter((item) => item.origin === origin);
    return { origin, label, hours: roundHours(rows.reduce((sum, item) => sum + item.estimateHours, 0)), itemIds: rows.map((item) => item.id) };
  }).filter((row) => row.itemIds.length);
  const confidence = Math.max(10, Math.round(weightedConfidence * (0.75 + completeness.score / 400)));
  const blockers = [];
  const estimateConflicts = requirementResult.repositoryCoverage.filter((row) => {
    if (row.action !== "merged" || !(row.targetEstimateHours > 0) || !(row.repositorySuggestedHours > 0)) return false;
    return Math.abs(row.repositorySuggestedHours - row.targetEstimateHours) / row.targetEstimateHours > 0.5;
  });
  const highGaps = gaps.filter((gap) => gap.severity === "high");
  if (highGaps.length) blockers.push(`Не покрыты критичные роли: ${highGaps.map((gap) => gap.suggestedRole).join(", ")}.`);
  if (completeness.score < 60) blockers.push(`Полнота декомпозиции Jira ${completeness.score}% — ниже порога 60%.`);
  if (source.repositoryAnalysis?.requested && !source.repositoryAnalysis.complete) blockers.push("Технический контур GitLab подтверждён не полностью.");
  if (estimateConflicts.length) blockers.push(`По ${estimateConflicts.length} работам оценка Jira отличается от технического ориентира более чем на 50%.`);
  if (confidence < 55) blockers.push(`Доверие к прогнозу ${confidence}% — ниже порога 55%.`);
  const forecastStatus = {
    confirmed: blockers.length === 0,
    code: blockers.length ? "preliminary" : "confirmed",
    label: blockers.length ? "Предварительный прогноз" : "Прогноз подтверждён данными",
    blockers
  };
  const firstLine = plainLines(source.description)[0] || source.title;

  return {
    source: {
      type: source.type || "jira", key: source.key || "", url: source.url || "", title: source.title || "Проект",
      documents: source.documents || null
    },
    goal: firstLine,
    technologies,
    requirements: requirements.map((row) => row.title),
    questions,
    completeness,
    systemAnalysis,
    complexity,
    repositoryAnalysis: source.repositoryAnalysis || null,
    staffingGaps: gaps,
    forecastStatus,
    reconciliation: {
      repositoryCoverage: requirementResult.repositoryCoverage,
      estimateConflicts,
      qa: {
        targetHours: targetVerificationHours,
        coveredHours: qaCoveredHours,
        residualHours: residualVerificationHours
      },
      ledger,
      totalHours: roundHours(totalHours)
    },
    calibration: {
      historicalTasks: calibrationModel.records.length,
      profiles: calibrationModel.profiles,
      backtest: calibrationBacktest,
      modelUncertaintyPercent
    },
    workItems: assignedWithCoverage,
    baseHours: roundHours(totalHours),
    baseDays: Number((totalHours / Math.max(1, hoursPerDay)).toFixed(1)),
    confidence,
    recommendedUnknownPercent: modelUncertaintyPercent,
    basis: (source.children || []).length
      ? `Декомпозиция построена по ${source.children.length} существующим задачам Jira.`
      : `Декомпозиция построена по ${requirements.length} требованиям из описания; до ответов на вопросы это предварительная оценка.`
  };
}
