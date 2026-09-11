// Настройки плагина в chrome.storage.local.
const KEY = "settings";

export const DEFAULTS = {
  schema: 0, // версия схемы настроек — поднимается миграциями в load()
  lang: "ru",
  baseUrl: "",
  pat: "",
  estimateField: "original", // original | remaining | points
  hoursPerDay: 8,
  sprintDays: 10, // длительность спринта в рабочих днях — ёмкость человека на спринт
  useTempoTeams: true, // брать команды людей из Tempo (если дополнение установлено)
  flowWeeks: 52, // окно истории завершённых задач (недель) — основа прогноза по потоку
  teams: [], // справочник команд для ручного распределения людей (вкладка «Команда»)
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

// Версия схемы настроек: миграции правят уже сохранённые значения, когда меняется умолчание.
export const SCHEMA = 1;
const MIGRATIONS = [
  // 1: окно истории потока по умолчанию стало годом. Старое умолчание (16) поднимаем, выбранное
  // вручную другое значение не трогаем.
  (s) => {
    if (Number(s.flowWeeks) === 16) s.flowWeeks = 52;
  }
];

let cache = null;

export async function load() {
  if (cache) return cache;
  const raw = (await chrome.storage.local.get(KEY))[KEY] || {};
  cache = { ...DEFAULTS, ...raw, fields: { ...DEFAULTS.fields, ...(raw.fields || {}) } };
  const from = Number(raw.schema) || 0;
  if (Object.keys(raw).length && from < SCHEMA) {
    for (let i = from; i < SCHEMA; i++) MIGRATIONS[i](cache);
  }
  if (cache.schema !== SCHEMA) {
    cache.schema = SCHEMA;
    await chrome.storage.local.set({ [KEY]: cache });
  }
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
