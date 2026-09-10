// Чистые предметные анализаторы: техническая работа возникает только при совпадении
// подтверждённого стека репозитория и намерения, выраженного в Jira/Confluence.

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const roundHours = (value) => Math.max(2, Math.round(Number(value || 0) / 2) * 2);
const normalize = (value) => String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");

const sourceText = (source = {}) => [
  source.title,
  source.description,
  ...(source.comments || []).map((item) => item?.body || item),
  ...(source.children || []).flatMap((item) => [item.summary, item.description])
].filter(Boolean).join("\n");

export function detectProjectIntent(source = {}) {
  const text = normalize(sourceText(source));
  return {
    text,
    upgrade: /обнов|upgrade|переход\w*\s+на\s+(?:нов|следующ)|поднят\w*\s+верси/.test(text),
    dependency: /зависим|пакет|composer|npm|pip|библиотек|dependency/.test(text),
    migration: /миграц|перенос|переезд|backfill|пересчет/.test(text),
    frontend: /frontend|фронтенд|интерфейс|экран|форма|страниц|\bui\b/.test(text),
    api: /backend|бэкенд|\bapi\b|endpoint|webhook|сервис/.test(text),
    integration: /интеграц|webhook|внешн\w*\s+систем|обмен\w*\s+данн/.test(text),
    data: /airflow|\bdag\b|\betl\b|\belt\b|\bdwh\b|витрин|хранилищ|пайплайн|pipeline|загрузк\w*\s+данн/.test(text),
    analytics: /superset|дашборд|dashboard|отчет|витрин|аналитик/.test(text),
    schema: /схем\w*\s+данн|таблиц|колонк|структур\w*\s+данн|миграц\w*\s+(?:бд|данн)|backfill/.test(text),
    ciRuntime: /gitlab-ci|\bci\/?cd\b|docker|runtime|сборк|деплой|deploy|образ/.test(text),
    technologyUpgrade: /framework|фреймворк|runtime|платформ\w*\s+верс|верс\w*\s+(?:язык|платформ|фреймворк)/.test(text),
    security: /уязвим|security|cve|безопасн/.test(text),
    testing: /тест|регресс|qa|провер|приемк/.test(text)
  };
}

function workItem(kind, area, title, text, suggestedHours, basis) {
  return { kind, area, title, text, suggestedHours: roundHours(suggestedHours), basis };
}

function repositoryArea(repository) {
  if (repository.area) return repository.area;
  const profile = repository.technologyProfile || {};
  const technologies = (profile.technologies || []).join(" ");
  if (profile.scope?.dagFiles || profile.scope?.sqlFiles || /Airflow|dbt|Superset|SQL|DWH/i.test(technologies)) return "data";
  const frontend = /React|Vue|Angular|Next\.js|Nuxt|TypeScript/i.test(technologies);
  const server = /PHP|Python|Java|JVM|Go|Rust|Ruby/i.test(technologies);
  return frontend && !server ? "frontend" : "backend";
}

function dependencyChangeItems(repository, intent) {
  const profile = repository.technologyProfile;
  if (!intent.upgrade || !(intent.dependency || intent.security || intent.ciRuntime || intent.technologyUpgrade)) return [];
  if (!(profile.dependencies.direct > 0 || profile.runtimes.length)) return [];
  const stack = profile.technologies.slice(0, 3).join(", ") || repository.label;
  const dependencyCount = profile.dependencies.direct;
  const runtime = profile.runtimes.join(", ") || "runtime определяется конфигурацией";
  return [
    workItem(
      "dependency-audit", repositoryArea(repository), `Аудит совместимости зависимостей · ${repository.label}`,
      `Зафиксировать текущие и целевые версии, проверить ограничения совместимости обнаруженного стека ${stack}.`,
      clamp(8 + dependencyCount * 0.35, 10, 32),
      `${dependencyCount} прямых зависимостей · ${runtime}`
    ),
    workItem(
      "dependency-upgrade", repositoryArea(repository), `Обновление зависимостей · ${repository.label}`,
      "Обновить только используемые зависимости и конфигурацию запуска в рамках существующей архитектуры.",
      clamp(12 + dependencyCount * 0.5, 14, 60),
      `${dependencyCount} прямых зависимостей · ${profile.dependencies.locked} зафиксированных зависимостей`
    ),
    workItem(
      "breaking-changes", repositoryArea(repository), `Адаптация несовместимых изменений · ${repository.label}`,
      "Устранить подтверждённые несовместимости приложения, конфигурации и интеграционных контрактов.",
      clamp(16 + dependencyCount * 0.55, 20, 72),
      `${stack} · масштаб исходного кода ${profile.scope.sourceFiles} файлов`
    )
  ];
}

function dataItems(repository, intent) {
  const profile = repository.technologyProfile;
  const confirmed = profile.technologies.some((item) => /Airflow|dbt|SQL|Python|Superset/i.test(item));
  if (!(intent.data || intent.schema || intent.analytics) || !confirmed) return [];
  const rows = [];
  if (intent.data) rows.push(workItem(
    "data-pipeline", "data", `Изменение контура данных · ${repository.label}`,
    "Уточнить входные и выходные контракты, реализовать обработку в существующем контуре и обеспечить повторяемый запуск.",
    clamp(20 + Math.min(profile.scope.dagFiles, 8) * 2 + Math.min(profile.scope.sqlFiles, 12), 24, 72),
    `${profile.technologies.join(", ") || "контур данных"} · DAG ${profile.scope.dagFiles} · SQL ${profile.scope.sqlFiles}`
  ));
  if (intent.schema || intent.migration) rows.push(workItem(
    "data-migration", "data", `Миграция и сверка данных · ${repository.label}`,
    "Подготовить обратимо выполняемое изменение схемы/данных, контроль полноты и сверку результата.",
    clamp(16 + Math.min(profile.scope.migrationFiles, 10) * 2, 20, 56),
    `${profile.scope.migrationFiles} файлов миграций · ${profile.scope.sqlFiles} SQL-файлов`
  ));
  return rows;
}

function applicationItems(repository, intent) {
  const profile = repository.technologyProfile;
  const area = repositoryArea(repository);
  const rows = [];
  if (intent.frontend && (area === "frontend" || profile.technologies.some((item) => /React|Vue|Angular|Next|Nuxt|Node|TypeScript/i.test(item)))) rows.push(workItem(
    "frontend-implementation", "frontend", `Изменения пользовательского интерфейса · ${repository.label}`,
    "Реализовать состояния интерфейса и интеграцию с существующим API в обнаруженном frontend-стеке.",
    clamp(20 + Math.sqrt(Math.max(1, profile.scope.sourceFiles)) * 1.5, 24, 64),
    `${profile.technologies.join(", ") || "frontend"} · подтверждено ${profile.scope.sourceFiles} исходных файлов`
  ));
  if ((intent.api || intent.integration) && area !== "frontend") rows.push(workItem(
    intent.integration ? "integration-change" : "backend-implementation", "backend",
    `${intent.integration ? "Интеграционный контракт" : "Изменение backend/API"} · ${repository.label}`,
    intent.integration
      ? "Подтвердить контракт обмена, обработку ошибок, идемпотентность и наблюдаемость в существующей архитектуре."
      : "Реализовать изменение в существующем backend-контуре с сохранением контрактов и обратной совместимости.",
    clamp(22 + Math.sqrt(Math.max(1, profile.scope.sourceFiles)) * 1.5, 26, 72),
    `${profile.technologies.join(", ") || "backend"} · подтверждено ${profile.scope.sourceFiles} исходных файлов`
  ));
  return rows;
}

function crossCuttingItems(repository, intent, implementationItems) {
  const profile = repository.technologyProfile;
  const area = repositoryArea(repository);
  if (!implementationItems.length) return [];
  const rows = [];
  if (profile.tests.files || intent.testing) rows.push(workItem(
    "regression", "qa", `Регрессионная проверка · ${repository.label}`,
    "Проверить затронутые сценарии существующими тестовыми средствами и вручную закрыть непокрытые критичные ветки.",
    clamp(12 + Math.sqrt(Math.max(1, profile.tests.files)) * 2, 14, 52),
    `${profile.tests.files} файлов тестового контура${profile.tests.tools.length ? ` · ${profile.tests.tools.join(", ")}` : ""}`
  ));
  if (profile.delivery.ciFiles.length && (intent.upgrade || intent.ciRuntime || intent.migration)) rows.push(workItem(
    "ci-runtime", area === "frontend" ? "frontend" : "backend", `Проверка CI и runtime · ${repository.label}`,
    "Подтвердить сборку, версии runtime, миграции и запуск в существующем CI/CD без внедрения нового инструментария.",
    clamp(8 + profile.delivery.ciFiles.length * 2, 10, 24),
    `обнаружены ${profile.delivery.ciFiles.join(", ")}`
  ));
  return rows;
}

export function repositoryWorkItems(repository, source) {
  const intent = detectProjectIntent(source);
  const implementation = [
    ...dependencyChangeItems(repository, intent),
    ...dataItems(repository, intent),
    ...applicationItems(repository, intent)
  ];
  const rows = [...implementation, ...crossCuttingItems(repository, intent, implementation)];
  return [...new Map(rows.map((item) => [`${item.kind}:${item.area}`, item])).values()];
}
