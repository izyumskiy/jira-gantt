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
  fields: { epicLink: "", sprint: "", storyPoints: "" },
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
