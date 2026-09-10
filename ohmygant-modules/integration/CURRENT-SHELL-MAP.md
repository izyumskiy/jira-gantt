# Карта функций текущей оболочки

Эти файлы не входят в переносимое ядро, потому что зависят от DOM, IndexedDB, `chrome.*` и конкретных REST-клиентов. При подготовке MR они служат референсом для подключения к API актуального OhMyGant.

## Аналитика сотрудников

| Назначение | Реализация текущей версии | Действие в новом OhMyGant |
|---|---|---|
| Страница и CSV | `src/js/people-analytics.js` | Перенести сценарий в UI-компоненты новой версии |
| Активные Tempo-команды | `src/js/people-tempo.js` | Реализовать `analyticsGateway.listActiveTeams()` |
| Периодическая выгрузка Jira | `src/js/people-analysis-sync.js` | Реализовать `analyticsGateway.loadTeamPeriod()` |
| Композиция старой оболочки | `src/modules/people-analytics/ohmygant-adapter.js` | Не копировать; заменить новым composition root |

## Прогноз проекта

| Назначение | Реализация текущей версии | Действие в новом OhMyGant |
|---|---|---|
| Страница прогноза | `src/js/project-forecast/page.js` | Перенести сценарий в UI-компоненты новой версии |
| Jira/Confluence source | `src/js/project-forecast/source.js` | Реализовать `requirementsGateway.load()` |
| Tempo roster, история и нагрузка | `src/js/project-forecast/sync.js` | Реализовать `workforceGateway.loadContext()` |
| Схема полей Jira | `src/js/project-forecast/jira-fields.js` | Переиспользовать field registry новой версии |
| Jira dependencies | `src/js/project-forecast/jira-links.js` | Перенести mapping в Jira gateway |
| Read-only GitLab | `src/js/project-forecast/repository-analysis.js` | Реализовать опциональный `repositoryGateway.analyze()` |
| Композиция старой оболочки | `src/modules/project-planning/ohmygant-adapter.js` | Не копировать; заменить новым composition root |

## Общее правило

Бизнес-формулы нельзя переносить из файлов оболочки или дублировать в gateway. Источник истины для вычислений — только `ohmygant-modules/src/`. Gateway загружает и нормализует факты, UI отображает результат публичного API.
