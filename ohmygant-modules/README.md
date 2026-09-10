# Модули для MR в актуальный Jira OhMyGant

Самостоятельный пакет двух read-only модулей:

- `asna.people-analytics` — аналитика сотрудников по Tempo-командам и истории Jira;
- `asna.project-planning` — системный анализ, декомпозиция, оценка P50/P80/P90 и календарный прогноз поверх активных эпиков.

Папка является единственным источником бизнес-логики. Текущая версия расширения использует её через тонкие реэкспорты в `src/modules/`; копий расчётного кода там нет.

## Что входит

```text
ohmygant-modules/
├─ package.json
├─ README.md
├─ integration/
│  ├─ INTEGRATION.md
│  └─ adapter-template.js
├─ src/
│  ├─ contracts.js
│  ├─ index.js
│  ├─ people-analytics/
│  │  ├─ index.js
│  │  ├─ module.css
│  │  └─ core/metrics.js
│  └─ project-planning/
│     ├─ index.js
│     ├─ module.css
│     ├─ core/
│     └─ repository/
└─ tests/package-selftest.mjs
```

В пакет намеренно не входят текущие `app.js`, DOM-страницы, IndexedDB, токены, Jira/Tempo/Confluence/GitLab-клиенты и `chrome.*`. Ими владеет принимающая оболочка.

## Подключение

```js
import {
  createPeopleAnalyticsModule,
  createProjectPlanningModule,
  moduleCatalog
} from "./ohmygant-modules/src/index.js";
```

Интеграция выполняется через read-only порты. Рабочий шаблон композиции находится в `integration/adapter-template.js`, пошаговая карта MR — в `integration/INTEGRATION.md`, а соответствие страниц и gateway текущей оболочки — в `integration/CURRENT-SHELL-MAP.md`.

## Проверка

Из этой папки:

```powershell
npm test
```

Из корня текущего расширения дополнительно выполняются предметные и браузерные тесты:

```powershell
node dev/module-contract-selftest.mjs
node dev/project-forecast-selftest.mjs
node dev/project-forecast-browser-smoke.mjs
```

Архив для переноса не требуется: в MR добавляется папка целиком либо её `src/` переносится в каталог бизнес-модулей новой архитектуры с сохранением относительной структуры.
