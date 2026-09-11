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

// rows — записи хранилища flow (завершённые задачи с датой), teamOf — функция «человек → команда».
export function buildFlow({ rows, teamOf, weeks = 16, now = Date.now() }) {
  const win = fullWeeks(weeks, now);
  const index = new Map(win.starts.map((ms, i) => [ms, i]));
  const teams = new Map();
  const noTeam = { id: "", name: "", color: -1 };

  for (const r of rows) {
    if (!r.resolved) continue;
    const ms = mondayOf(Date.parse(r.resolved));
    const slot = index.get(ms);
    if (slot === undefined) continue; // вне окна полных недель
    const team = teamOf({ key: r.assigneeKey, login: r.assigneeLogin, name: r.assigneeName }) || noTeam;
    if (!teams.has(team.id)) {
      teams.set(team.id, { team, perWeek: new Array(win.starts.length).fill(0), total: 0, byEpic: new Map() });
    }
    const acc = teams.get(team.id);
    acc.perWeek[slot] += 1;
    acc.total += 1;
    if (r.epicKey) acc.byEpic.set(r.epicKey, (acc.byEpic.get(r.epicKey) || 0) + 1);
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

// Доля потока команды, уходящая на эпик: завершённые задачи эпика к всем завершённым задачам.
export function epicShare(teamFlow, epicKey) {
  const done = teamFlow.byEpic.get(epicKey) || 0;
  return { done, total: teamFlow.total, share: teamFlow.total ? done / teamFlow.total : 0 };
}
