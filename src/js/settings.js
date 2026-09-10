// Настройки плагина в chrome.storage.local.
const KEY = "settings";

export const DEFAULTS = {
  lang: "ru",
  baseUrl: "",
  pat: "",
  estimateField: "original", // original | remaining | points
  hoursPerDay: 8,
  sprintDays: 10, // длительность спринта в рабочих днях — ёмкость человека на спринт
  doneStatuses: "", // статусы своего потока, которые считаем завершёнными, через запятую
  infoSystems: [], // справочник информационных систем для вкладки «Команда»
  boardId: "",
  boardName: "",
  // version растёт, когда добавляются новые определяемые поля — тогда detectFields запускается заново.
  fields: {
    version: 0,
    epicLink: "",
    epicName: "",
    sprint: "",
    storyPoints: "",
    plannedStart: "",
    plannedEnd: "",
    epicAssignee: "assignee", // из какого поля брать исполнителя эпика
    epicReporter: "reporter" // из какого — постановщика
  },
  dateFields: [], // все поля типа дата/дата-время из Jira — для ручного выбора плановых дат
  userFields: [], // все поля типа «пользователь» — для выбора исполнителя/постановщика эпика
  epicAssigneeFilter: "", // фильтр «Ганта по эпикам» по исполнителю эпика: "" — все, "__none__" — без исполнителя
  peopleAnalysis: {
    sleDays: 14,
    longDays: 30,
    legacyDays: 180,
    confidenceSample: 10,
    reopenWarningPercent: 20,
    bugTypes: "Ошибка,Bug,Defect",
    activeStatuses: "В РАБОТЕ,IN PROGRESS,РАЗРАБОТКА,CODE REVIEW,TO TEST,TESTING,БИЗНЕС ТЕСТ,REVIEW",
    waitStatuses: "ОЖИДАНИЕ,WAITING,ON HOLD,BLOCKED,ЗАБЛОКИРОВАНО",
    weights: { speed: 25, predictability: 20, quality: 20, estimation: 25, ownership: 10 }
  },
  lastSync: 0
};

let cache = null;

export async function load() {
  if (cache) return cache;
  const raw = (await chrome.storage.local.get(KEY))[KEY] || {};
  cache = {
    ...DEFAULTS,
    ...raw,
    fields: { ...DEFAULTS.fields, ...(raw.fields || {}) },
    peopleAnalysis: {
      ...DEFAULTS.peopleAnalysis,
      ...(raw.peopleAnalysis || {}),
      weights: { ...DEFAULTS.peopleAnalysis.weights, ...(raw.peopleAnalysis?.weights || {}) }
    }
  };
  return cache;
}

export async function save(patch) {
  const cur = await load();
  cache = {
    ...cur,
    ...patch,
    fields: { ...cur.fields, ...(patch.fields || {}) },
    peopleAnalysis: patch.peopleAnalysis
      ? { ...cur.peopleAnalysis, ...patch.peopleAnalysis, weights: { ...cur.peopleAnalysis.weights, ...(patch.peopleAnalysis.weights || {}) } }
      : cur.peopleAnalysis
  };
  await chrome.storage.local.set({ [KEY]: cache });
  return cache;
}

export function get() {
  return cache || DEFAULTS;
}

// Нормализованный origin Jira (без хвостового слэша и пути).
export function originOf(baseUrl) {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "";
  }
}
