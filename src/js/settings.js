// Настройки плагина в chrome.storage.local.
const KEY = "settings";

export const DEFAULTS = {
  lang: "ru",
  baseUrl: "",
  pat: "",
  estimateField: "original", // original | remaining | points
  hoursPerDay: 8,
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
  lastSync: 0
};

let cache = null;

export async function load() {
  if (cache) return cache;
  const raw = (await chrome.storage.local.get(KEY))[KEY] || {};
  cache = { ...DEFAULTS, ...raw, fields: { ...DEFAULTS.fields, ...(raw.fields || {}) } };
  return cache;
}

export async function save(patch) {
  const cur = await load();
  cache = { ...cur, ...patch, fields: { ...cur.fields, ...(patch.fields || {}) } };
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
