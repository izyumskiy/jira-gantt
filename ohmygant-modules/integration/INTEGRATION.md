# Карта MR в актуальный OhMyGant

## 1. Перенос

Добавить каталог `ohmygant-modules/src/` в дерево новой версии без изменения внутренней структуры. Пакет использует относительные ES module imports и не требует сборщика или внешних npm-зависимостей.

## 2. Composition root

Подключить `createPeopleAnalyticsModule()` и `createProjectPlanningModule()` в точке композиции приложения. Можно использовать `adapter-template.js`, заменив gateway-объекты реализациями актуального OhMyGant.

Модуль аналитики ожидает:

- `analyticsGateway.listActiveTeams(onProgress)`;
- `analyticsGateway.loadTeamPeriod({ team, from, to, onProgress })` → `{ members, issues, meta }`.

Модуль прогноза ожидает:

- `requirementsGateway.load(reference, onProgress)` → нормализованный источник Jira или Confluence;
- `workforceGateway.loadContext(request)` → `{ employees, history, workload, vacations, warnings? }`;
- опциональный `repositoryGateway.analyze(source, onProgress)` для read-only экспресс-анализа GitLab.

## 3. Требования к PlanningIssue

Адаптер передаёт факты Jira без расчётной логики:

- идентификаторы и исполнитель: `key`, `projectKey`, `epicKey`, `assignee`;
- состояние: `status`, `statusCategory`, `inProgress` при наличии;
- оценки: `originalHours`, `remainingHours`, `timeSpentHours`;
- календарь: полный `sprints[]`, `plannedStart`, `plannedEnd`, `epicPlannedStart`, `epicPlannedEnd`;
- приоритеты и связи: `isBaza`, `dependsOnKeys`;
- признаки аналогов: `summary`, `type`, `components`, `labels`.

Калибровка остатка, многозадачность, P50/P80/P90 и календарное распределение выполняются внутри модуля.

## 4. UI и маршруты

Манифесты объявляют маршруты `analysis` и `forecast`. Оболочка регистрирует их в своей навигации и сама решает, использовать приложенные CSS или собственные компоненты. Расчётные функции не зависят от разметки.

Если сохраняется текущая верстка, подключить:

```html
<link rel="stylesheet" href="path/to/people-analytics/module.css">
<link rel="stylesheet" href="path/to/project-planning/module.css">
```

## 5. Ограничения безопасности

- Все gateway-порты должны использовать только операции чтения.
- Токены и browser permissions не передаются в вычислительное ядро.
- В публичном API модулей отсутствуют методы создания или изменения Jira-задач.
- GitLab-анализ не изменяет репозитории.

## 6. Проверка MR

Обязательный минимум:

1. `npm test` внутри пакета.
2. Контрактный тест портов с fake gateways принимающего приложения.
3. Проверка обоих маршрутов в светлой и тёмной теме.
4. Проверка Jira Server/Data Center полей Sprint, Epic Link, Planned Start и Planned End.
5. Проверка сценариев: обычный проект, BAZA, отпуск, активный эпик со spillover, отсутствующий системный анализ и недостаточная роль.

## 7. Что не переносить из старой оболочки

Файлы `src/modules/*/ohmygant-adapter.js` относятся только к текущей версии и не входят в пакет. Их нельзя копировать в новый проект вслепую: они зависят от старых `settings.js`, `db.js`, Jira-клиента и структуры страниц.
