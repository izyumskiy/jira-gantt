// Недельный поток команд: сколько задач команда доводит до завершения за неделю, и какая часть
// этого потока уходит на конкретный эпик. Основа прогноза сроков (складывать оценки нельзя —
// перцентили не складываются, а циклы задач перекрываются, поэтому считаем по потоку).
const DAY = 86400000;
const WEEK = 7 * DAY;

// Понедельник недели, к которой относится момент времени (локальное время).
export function mondayOf(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  const shift = (d.getDay() + 6) % 7; // 0 = понедельник
  return d.getTime() - shift * DAY;
}

// Ключ недели: понедельник в локальном времени, «ГГГГ-ММ-ДД».
export function weekKey(ms) {
  const d = new Date(mondayOf(ms));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isoWeekKey(ms) {
  const d = new Date(mondayOf(ms) + 3 * DAY); // четверг определяет номер недели по ISO
  const start = new Date(d.getFullYear(), 0, 4);
  const week = 1 + Math.round((d - mondayOf(start.getTime())) / WEEK);
  return `${d.getFullYear()}-${String(week).padStart(2, "0")}`;
}

export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Границы окна: только полные недели. Текущая неделя неполная — отбрасывается, первая неделя окна
// тоже (запрос по -Nw начинается в середине недели). Недели с нулём остаются: отпуска и праздники
// — это тоже поток.
export function fullWeeks(weeks, now = Date.now()) {
  const lastEnd = mondayOf(now) - 1;
  const firstStart = mondayOf(now - weeks * WEEK) + WEEK;
  const keys = [];
  for (let ms = firstStart; ms < lastEnd; ms += WEEK) keys.push(ms);
  return { from: firstStart, to: lastEnd, starts: keys };
}

// Типы задач, которые прогноз не считает (по умолчанию User Story): история — контейнер для
// задач, а не единица работы, и в потоке она удваивала бы то, что уже посчитано её подзадачами.
// Список из настроек через запятую; сравнение по названию типа без учёта регистра.
export function parseTypeList(text) {
  return String(text || "")
    .split(/[,;\n]/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// Типы историй (ракурс «Эпик — история», Р2), в нижнем регистре.
export function storyTypes(s) {
  return parseTypeList(s && s.storyTypes);
}

// Типы задач, не учитываемые в подсчётах: один набор на всех экранах — список, карточка, прогноз,
// «Сводка», «По эпикам» и загрузка людей (Р9). Типы историй входят всегда, даже если их нет в
// «Типах задач, не учитываемых в подсчётах»: история — контейнер, а не задача (Р2). s — настройки.
export function excludedTypes(s) {
  return [...new Set([...parseTypeList(s && s.forecastExcludeTypes), ...storyTypes(s)])];
}

// Те же типы в написании из настроек — для JQL-ссылок в Jira.
export function excludedTypeNames(s) {
  const seen = new Set();
  const out = [];
  for (const x of `${(s && s.forecastExcludeTypes) || ""},${(s && s.storyTypes) || ""}`.split(/[,;\n]/)) {
    const name = x.trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push(name);
    }
  }
  return out;
}

// Связи задачи с историей (Р2): список из настройки «Связь задачи с историей» через запятую.
// Связь подходит, если совпало название её типа в Jira («Relates») или подпись, которую Jira
// показывает на странице задачи («relates to», «is subtask of»), — без учёта регистра.
// Пустая настройка — подходит любая связь.
export function linkMatcher(setting) {
  const list = parseTypeList(setting);
  if (!list.length) return () => true;
  return (l) => !!l && (list.includes(String(l.type || "").trim().toLowerCase()) || list.includes(String(l.desc || "").trim().toLowerCase()));
}

export function isExcludedType(typeName, excluded) {
  return !!typeName && excluded.includes(String(typeName).trim().toLowerCase());
}

// rows — записи хранилища flow (завершённые задачи с датой), teamOf — функция «человек → команда».
// epicKey — если задан, у каждой команды дополнительно считается ряд «задачи эпика по неделям».
// excludeTypes — типы задач (в нижнем регистре), которые в поток не попадают.
export function buildFlow({ rows, teamOf, weeks = 16, now = Date.now(), epicKey = "", excludeTypes = [] }) {
  const win = fullWeeks(weeks, now);
  const index = new Map(win.starts.map((ms, i) => [ms, i]));
  const teams = new Map();
  const noTeam = { id: "", name: "", color: -1 };

  for (const r of rows) {
    if (!r.resolved) continue;
    if (isExcludedType(r.typeName, excludeTypes)) continue;
    const ms = mondayOf(Date.parse(r.resolved));
    const slot = index.get(ms);
    if (slot === undefined) continue; // вне окна полных недель
    const team = teamOf({ key: r.assigneeKey, login: r.assigneeLogin, name: r.assigneeName }) || noTeam;
    if (!teams.has(team.id)) {
      teams.set(team.id, {
        team,
        perWeek: new Array(win.starts.length).fill(0),
        epicPerWeek: new Array(win.starts.length).fill(0),
        total: 0,
        byEpic: new Map()
      });
    }
    const acc = teams.get(team.id);
    acc.perWeek[slot] += 1;
    acc.total += 1;
    if (r.epicKey) acc.byEpic.set(r.epicKey, (acc.byEpic.get(r.epicKey) || 0) + 1);
    if (epicKey && r.epicKey === epicKey) acc.epicPerWeek[slot] += 1;
  }

  const list = [...teams.values()]
    .map((x) => ({
      ...x,
      median: median(x.perWeek),
      max: Math.max(0, ...x.perWeek),
      weeks: x.perWeek.length
    }))
    .sort((a, b) => b.total - a.total);
  return { ...win, weeksCount: win.starts.length, teams: list };
}

// Прогноз срока по потоку. В каждом прогоне для каждой команды тянем недели её истории с
// возвратом; неделя даёт flow × доля_потока задач эпика. Срок прогона — максимум по командам:
// эпик готов, когда закончит последняя. Оценки не складываем (перцентили не складываются,
// а циклы задач перекрываются).
export const FORECAST_MIN_WEEKS = 5;
export const FORECAST_OK_WEEKS = 12;

export function forecastDelivery({ teams, runs = 10000, now = Date.now(), rnd = Math.random, maxWeeks = 260 }) {
  const usable = teams.filter((x) => x.remaining > 0 && x.share > 0 && x.perWeek.some((n) => n > 0));
  if (!usable.length) return null;

  const durations = [];
  const lastByTeam = new Map();
  let overflow = 0;
  for (let r = 0; r < runs; r++) {
    let worst = 0;
    let worstTeam = null;
    for (const x of usable) {
      let done = 0;
      let w = 0;
      while (done < x.remaining && w < maxWeeks) {
        done += x.perWeek[Math.floor(rnd() * x.perWeek.length)] * x.share;
        w += 1;
      }
      if (w >= maxWeeks) overflow += 1;
      if (w > worst) {
        worst = w;
        worstTeam = x;
      }
    }
    durations.push(worst);
    if (worstTeam) lastByTeam.set(worstTeam.team.id, (lastByTeam.get(worstTeam.team.id) || 0) + 1);
  }
  durations.sort((a, b) => a - b);
  const at = (p) => durations[Math.min(durations.length - 1, Math.floor((p / 100) * durations.length))];
  const weeks = { p50: at(50), p85: at(85), p95: at(95) };
  const date = (w) => new Date(now + w * 7 * DAY);
  const last = [...lastByTeam.entries()]
    .map(([id, n]) => ({ team: usable.find((x) => x.team.id === id).team, runs: n, pct: Math.round((n / runs) * 100) }))
    .sort((a, b) => b.runs - a.runs);
  return {
    runs,
    weeks,
    dates: { p50: date(weeks.p50), p85: date(weeks.p85), p95: date(weeks.p95) },
    last,
    teams: usable,
    overflow,
    durations // отсортированные сроки прогонов в неделях — для шанса успеть к сроку
  };
}

// Шанс успеть и запас до срока исполнения (dueMs — конец дня срока). Шанс — доля прогонов,
// закончившихся не позже срока; запас — срок минус прогноз 85%, в неделях (меньше нуля — опаздываем).
export function dueOutlook(fc, dueMs, now = Date.now()) {
  if (!fc || !Number.isFinite(dueMs)) return { chance: null, buffer: null };
  const inTime = fc.durations.filter((w) => now + w * 7 * DAY <= dueMs).length;
  return {
    chance: inTime / fc.durations.length,
    buffer: Math.round(((dueMs - fc.dates.p85.getTime()) / (7 * DAY)) * 10) / 10
  };
}

// Генератор случайных чисел с зерном (mulberry32 от хеша строки): одинаковое зерно — одинаковые
// прогоны. Нужен, чтобы прогноз менялся только от данных, а не от случая.
export function seededRandom(seed) {
  let h = 1779033703 ^ String(seed).length;
  for (const ch of String(seed)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Доля потока команды, уходящая на эпик. Считается в трёх окнах, потому что «за всё окно истории»
// размывает долю: эпик живёт лишь часть года, а знаменатель берёт весь год целиком.
//   share  — за всё окно истории: след эпика в годовом потоке команды;
//   active — за период активности эпика: от первой недели с его завершениями до последней
//            (у незакрытого эпика — до конца окна, он всё ещё в работе). Нули внутри периода
//            остаются: паузы — часть темпа;
//   recent — последние RECENT_WEEKS недель периода активности: текущий темп.
export const RECENT_WEEKS = 8;

function sliceShare(teamFlow, from, to) {
  let done = 0;
  let total = 0;
  for (let i = from; i <= to; i++) {
    done += teamFlow.epicPerWeek[i] || 0;
    total += teamFlow.perWeek[i] || 0;
  }
  return { from, to, weeks: to - from + 1, done, total, share: total ? done / total : 0 };
}

export function epicShare(teamFlow, epicKey, { open = false, recent = RECENT_WEEKS } = {}) {
  const done = teamFlow.byEpic.get(epicKey) || 0;
  const total = teamFlow.total;
  const out = { done, total, share: total ? done / total : 0, active: null, recent: null };
  // ряд epicPerWeek заполняется для эпика, переданного в buildFlow; для любого другого ключа
  // (и когда завершений нет) периода активности не существует
  const ep = done ? teamFlow.epicPerWeek || [] : [];
  const from = ep.findIndex((n) => n > 0);
  if (from < 0) return out;
  let to = from;
  for (let i = ep.length - 1; i > from; i--) {
    if (ep[i] > 0) {
      to = i;
      break;
    }
  }
  if (open) to = ep.length - 1;
  out.active = sliceShare(teamFlow, from, to);
  out.recent = sliceShare(teamFlow, Math.max(from, to - recent + 1), to);
  return out;
}

// Для прогноза берём самую свежую оценку темпа: последние недели → период активности → всё окно.
// Ноль в узком окне (команда пока не бралась за эпик) откатывает на более широкое.
export function forecastShare(s) {
  if (s.recent && s.recent.share) return s.recent.share;
  if (s.active && s.active.share) return s.active.share;
  return s.share;
}

// Прогноз по выбранным командам. Остаток задач эпика целиком делят выбранные команды —
// пропорционально их вкладу в эпик (кого сняли, тот больше не работает над остатком). История
// каждой команды — недели текущего периода работы выбранных команд над эпиком: от самой ранней
// недели с их завершениями до конца окна, но не короче FORECAST_OK_WEEKS (иначе пара недель
// случайного всплеска решала бы срок). Доля потока — самая свежая оценка (forecastShare).
export function forecastForTeams({ teams, shares, epicKey, remaining, runs = 10000, now = Date.now(), rnd = Math.random }) {
  if (!teams.length || !remaining) return { reason: "none" };
  const epicDone = teams.reduce((n, x) => n + (x.byEpic.get(epicKey) || 0), 0);
  if (!epicDone) return { reason: "none" };
  const to = teams[0].perWeek.length - 1;
  const froms = teams.map((x) => shares.get(x.team.id)?.active?.from).filter((v) => v != null);
  const start = froms.length ? Math.min(...froms) : 0;
  const from = Math.max(0, Math.min(start, to - FORECAST_OK_WEEKS + 1));
  const history = { from, to, weeks: to - from + 1 };
  if (history.weeks < FORECAST_MIN_WEEKS) return { reason: "short", weeks: history.weeks, history };
  const input = teams.map((x) => ({
    team: x.team,
    perWeek: x.perWeek.slice(from, to + 1),
    share: forecastShare(shares.get(x.team.id)),
    remaining: (remaining * (x.byEpic.get(epicKey) || 0)) / epicDone
  }));
  const fc = forecastDelivery({ teams: input, runs, now, rnd });
  return fc ? { fc, history } : { reason: "none", history };
}
