# Модули для MR в актуальный Jira OhMyGant

Самостоятельный пакет двух read-only модулей:

- `asna.people-analytics` — аналитика сотрудников по Tempo-командам и истории Jira;
- `asna.project-planning` — системный анализ, декомпозиция, оценка P50/P80/P90 и календарный прогноз поверх активных эпиков.

Папка является единственным источником бизнес-логики. Текущая версия расширения использует её через тонкие реэкспорты в `src/modules/`; копий расчётного кода там нет.

Архитектурные границы, устранённые нарушения и обязательные инварианты описаны в [`ARCHITECTURE_REVIEW.md`](./ARCHITECTURE_REVIEW.md).

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
│     │  ├─ source-composition.js
│     │  ├─ classification.js
│     │  ├─ requirements.js
│     │  ├─ system-analysis.js
│     │  ├─ estimation.js
│     │  ├─ staffing.js
│     │  ├─ explainability.js
│     │  ├─ backtest.js
│     │  ├─ calibration.js
│     │  ├─ portfolio.js
│     │  └─ domain.js
│     └─ repository/
└─ tests/package-selftest.mjs
```

В пакет намеренно не входят текущие `app.js`, DOM-страницы, IndexedDB, токены, Jira/Tempo/Confluence/GitLab-клиенты и `chrome.*`. Ими владеет принимающая оболочка.

Пакет не содержит сопоставлений конкретных Jira-проектов с репозиториями и специальных оценок для отдельных технологических кейсов. Технический контур передаётся через порт только по подтверждённым ссылкам источника.

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

`analysis.js` только оркестрирует независимые политики извлечения требований, системного анализа, оценки и подбора исполнителей. Результат планирования содержит `estimateExplanation` для каждой работы: источник базовой оценки и отдельные формулы P50/P80/P90. `portfolio.backtest` содержит последовательную проверку часов и дат завершённых инициатив без использования данных из будущего.

Из корня текущего расширения дополнительно выполняются предметные и браузерные тесты:

```powershell
node dev/module-contract-selftest.mjs
node dev/project-forecast-selftest.mjs
node dev/project-forecast-browser-smoke.mjs
```

Архив для переноса не требуется: в MR добавляется папка целиком либо её `src/` переносится в каталог бизнес-модулей новой архитектуры с сохранением относительной структуры.
