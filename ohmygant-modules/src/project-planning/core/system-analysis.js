// Оценка полноты требований, сложности и построение экспресс-системного контура.
import { classifyWork, normalizeText, unique } from "./classification.js";

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export function buildQuestions(source, requirements, technologies) {
  const text = normalizeText([source.title, source.description, ...requirements.map((row) => row.text)].join(" "));
  const questions = [];
  if (source.documents && !source.documents.businessRequirements?.provided) questions.push("Бизнес-требования не проработаны: необходимо зафиксировать цели, границы и критерии успеха в Confluence.");
  if (String(source.description || "").trim().length < 120) questions.push("Какой бизнес-результат и измеримый критерий успеха должны быть получены?");
  if (!/критери|приемк|acceptance|готово когда|результат/.test(text)) questions.push("Каковы критерии приёмки и кто подтверждает результат?");
  if (/интеграц|airflow|etl|загрузк|api|источник/.test(text) && !/источник данных|source|откуда|endpoint|система источник/.test(text)) questions.push("Какие системы и наборы данных являются источниками, каковы форматы и владельцы?");
  if (/данн|airflow|etl|витрин|superset|api/.test(text) && !/объем|sla|частот|расписан|latency|производительн/.test(text)) questions.push("Каковы объёмы, частота обновления, SLA и требования к производительности?");
  if (/интерфейс|frontend|фронтенд|экран|форма/.test(text) && !/макет|figma|прототип|дизайн/.test(text)) questions.push("Есть ли согласованный макет и состояния интерфейса, включая ошибки и пустые данные?");
  if (/роль|доступ|авторизац|персональн/.test(text) && !/матриц|какие роли|permission/.test(text)) questions.push("Какие роли и ограничения доступа должны применяться?");
  if (!/срок|дедлайн|planned end|до \d|релиз/.test(text)) questions.push("Есть ли обязательный срок или внешняя дата запуска?");
  if (!technologies.length) questions.push("Какие из уже используемых компонентов должны быть изменены и в каких репозиториях?");
  return questions.slice(0, 8);
}

export function projectCompleteness(source) {
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

export function projectComplexity(source, requirements, technologies, questions, completeness) {
  const text = normalizeText(`${source.title} ${source.description}`);
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

export function expressSystemAnalysis(source, requirements, technologies, questions, complexity) {
  const text = normalizeText(`${source.title} ${source.description}`);
  const provided = Boolean(source.documents?.systemAnalysis?.provided);
  const components = technologies.length ? technologies : unique(requirements.map((row) => classifyWork(row.text).label));
  const interactions = [];
  if (/airflow|etl|elt|загрузк|витрин|dwh|хранилищ/.test(text)) interactions.push("Источник данных → обработка/загрузка → хранилище или витрина → потребитель");
  if (/api|endpoint|интеграц|webhook/.test(text)) interactions.push("Система-инициатор → существующий API/интеграционный контракт → целевая система");
  if (/frontend|фронтенд|интерфейс|экран|форма/.test(text)) interactions.push("Пользователь → интерфейс → существующий backend/API → данные");
  if (/superset|дашборд|отчет|аналитик/.test(text)) interactions.push("Подготовленная витрина → аналитический слой → бизнес-пользователь");
  if (!interactions.length) interactions.push("Пользовательский сценарий → изменяемый компонент → проверяемый результат");
  const risks = [];
  if (questions.some((question) => /объем|sla|производительн|частот/i.test(question))) risks.push("Не зафиксированы объёмы, частота или SLA");
  if (questions.some((question) => /критери.*приемк|подтверждает результат/i.test(question))) risks.push("Не определены полные критерии приёмки и владелец результата");
  if (questions.some((question) => /источник|наборы данных|формат/i.test(question))) risks.push("Требуется подтвердить источники и контракты данных");
  if (questions.some((question) => /роль|доступ/i.test(question))) risks.push("Требуется подтвердить матрицу доступов");
  const assumptions = [
    "Используются только уже применяемые компоненты и практики.",
    "Технологии, которых нет в Jira/Confluence или истории, не предполагаются.",
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
