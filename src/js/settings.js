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
  requestTimeoutSec: 30, // таймаут запроса к Jira: без VPN запрос иначе висит больше минуты
  // Автообновление (Б8): один раз за рабочий день, как только Jira доступна (VPN).
  autoSync: { enabled: false, days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" },
  teams: [], // справочник команд для ручного распределения людей (вкладка «Команда»)
  doneStatuses: "", // статусы своего потока, которые считаем завершёнными, через запятую
  forecastExcludeTypes: "User Story", // типы задач, которые прогноз сроков не считает, через запятую
  // Ракурс «Эпик — история» (ТЗ «Эпик — история», Р2): какие задачи — истории, какой связью к ним
  // привязаны задачи, через сколько дней заметка считается устаревшей.
  // Jira отдаёт название типа на языке пользователя: «Story» в русском интерфейсе — «История».
  storyTypes: "User Story, Story, История",
  storyLinkType: "Relates",
  noteStaleDays: 14,
  storyShowNotes: true, // галочка «Заметки» на ракурсе «Эпик — история» (Р4)
  nameWidths: {}, // ширина колонки названий, px, по ракурсам: { epicPeople, assignee, epicStories }
  // Пороги «Сводки» (Б10).
  summary: {
    chanceGreen: 85, // шанс успеть, %: не ниже — зелёный
    chanceYellow: 50, // не ниже — жёлтый, ниже — красный
    shiftDays: 7, // значимый сдвиг прогноза, дней
    scopePct: 10, // рост/сокращение объёма, %
    scopeAbs: 5, // … или задач
    nearWeeks: 2, // «близко к завершению»: прогноз 85% не дальше, недель
    nearDonePct: 90, // … или готово, %
    stallWeeks: 3, // недель без закрытий — «застой», «застрял на финише»
    meltWeeks: 3, // недель снижения запаса — «запас тает»
    carrySprints: 3, // спринтов — «повторный перенос»
    idlePct: 50, // загрузка ниже, % — «простой рядом с опозданием»
    spreadFlow: 2, // потока на эпик в работе меньше, задач в неделю — «распыление»
    spreadWeeks: 4, // окно «эпиков в работе» у команды, недель
    bottleneckPct: 50, // доля прогонов, где команда замыкает, % — «узкое место»
    noEstimatePct: 20, // доля задач без оценки, % — «нет оценок»
    attention: 7 // размер «Требует внимания»
  },
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
export const SCHEMA = 2;
export const MIGRATIONS = [
  // 1: окно истории потока по умолчанию стало годом. Старое умолчание (16) поднимаем, выбранное
  // вручную другое значение не трогаем.
  (s) => {
    if (Number(s.flowWeeks) === 16) s.flowWeeks = 52;
  },
  // 2: «Типы историй» по умолчанию понимают и русское название типа («История»). Прежнее
  // нетронутое умолчание «User Story» поднимаем, выбранное вручную не трогаем.
  (s) => {
    if (String(s.storyTypes || "").trim().toLowerCase() === "user story") s.storyTypes = DEFAULTS.storyTypes;
  }
];

let cache = null;

// Страница плагина может быть открыта дважды (вкладка пользователя и автообновление). Кэш каждой
// страницы подтягивает изменения, сделанные другой, — иначе сохранение формы в одной вкладке
// откатило бы поля, записанные другой (например, время последней синхронизации).
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  try {
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== "local" || !changes[KEY] || !changes[KEY].newValue) return;
      const raw = changes[KEY].newValue;
      cache = { ...DEFAULTS, ...raw, fields: { ...DEFAULTS.fields, ...(raw.fields || {}) }, summary: { ...DEFAULTS.summary, ...(raw.summary || {}) }, autoSync: { ...DEFAULTS.autoSync, ...(raw.autoSync || {}) } };
    });
  } catch {
    // окружение без событий хранилища (тесты) — работаем без синхронизации кэша
  }
}

export async function load() {
  listen();
  if (cache) return cache;
  const raw = (await chrome.storage.local.get(KEY))[KEY] || {};
  cache = { ...DEFAULTS, ...raw, fields: { ...DEFAULTS.fields, ...(raw.fields || {}) }, summary: { ...DEFAULTS.summary, ...(raw.summary || {}) }, autoSync: { ...DEFAULTS.autoSync, ...(raw.autoSync || {}) } };
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
  cache = { ...cur, ...patch, fields: { ...cur.fields, ...(patch.fields || {}) }, summary: { ...cur.summary, ...(patch.summary || {}) }, autoSync: { ...cur.autoSync, ...(patch.autoSync || {}) } };
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
