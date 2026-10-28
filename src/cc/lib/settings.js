// Настройки Control Chart (chrome.storage.local, свой ключ «cc»). В IndexedDB лежат только данные.
//
// Control Chart встроен в OhMyGant: подключение к Jira у них общее. Адрес, PAT и язык интерфейса
// берутся из настроек OhMyGant (ключ «settings»), своих полей подключения у Control Chart нет —
// иначе одну и ту же Jira пришлось бы настраивать дважды.

const KEY = 'cc';
const HOST_KEY = 'settings';

export const DEFAULTS = {
  storyPointsField: '',        // customfield_10004, определяется автоматически
  // Заголовки целиком (255 — предел Jira) и метки включены по умолчанию: база общая для всех
  // инструментов плагина, и анализ по ней должен видеть задачу полностью, а не обрезок.
  storeSummaries: true,        // хранить ли заголовки задач (самое дорогое поле)
  summaryMaxLen: 255,
  storeAssignee: true,
  storeLabels: true,
  pageSize: 50,                // задач за запрос (agile API с changelog не любит больше)
  lastBoardId: null,
  chart: {},                   // настройки графика по доскам: { [boardId]: {...} }
};

async function readOwn() {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY] && typeof got[KEY] === 'object' ? got[KEY] : {};
}

export async function loadSettings() {
  const got = await chrome.storage.local.get([KEY, HOST_KEY]);
  const own = got[KEY] && typeof got[KEY] === 'object' ? got[KEY] : {};
  const host = got[HOST_KEY] || {};
  const token = String(host.pat || '').trim();
  return {
    ...DEFAULTS,
    ...own,
    // Общие с OhMyGant: подключение и язык. Сначала сессия браузера, при отказе — PAT (как у него).
    baseUrl: normalizeBaseUrl(host.baseUrl),
    token,
    authMode: token ? 'auto' : 'cookie',
    locale: host.lang || '',
  };
}

/** Сохраняет только собственные поля Control Chart; подключение и язык меняются в OhMyGant. */
export async function saveSettings(patch) {
  const own = { ...(await readOwn()) };
  for (const k of Object.keys(DEFAULTS)) if (k in patch) own[k] = patch[k];
  await chrome.storage.local.set({ [KEY]: own });
  return loadSettings();
}

export async function getChartPrefs(boardId) {
  const own = await readOwn();
  return own.chart?.[String(boardId)] || null;
}

export async function setChartPrefs(boardId, prefs) {
  const own = { ...(await readOwn()) };
  own.chart = { ...(own.chart || {}), [String(boardId)]: prefs };
  await chrome.storage.local.set({ [KEY]: own });
}

/** Нормализует базовый URL: без хвостового слэша, без /secure/… */
export function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let url;
  try {
    url = new URL(value.includes('://') ? value : `https://${value}`);
  } catch {
    return '';
  }
  const path = url.pathname.replace(/\/+$/, '');
  // Jira может стоять в подпути (…/jira). Отрезаем только служебные хвосты.
  const base = path.replace(/\/(secure|browse|projects|rest)(\/.*)?$/, '');
  return `${url.origin}${base}`;
}

/** Шаблон host-permission для базового URL. */
export function originPattern(baseUrl) {
  if (!baseUrl) return null;
  try {
    return `${new URL(baseUrl).origin}/*`;
  } catch {
    return null;
  }
}

export async function hasHostPermission(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) return false;
  return chrome.permissions.contains({ origins: [pattern] });
}

/** Запрос host-permission (вызывать только из обработчика клика). */
export async function requestHostPermission(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) return false;
  return chrome.permissions.request({ origins: [pattern] });
}
