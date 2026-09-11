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
// epicKey — если задан, у каждой команды дополнительно считается ряд «задачи эпика по неделям».
export function buildFlow({ rows, teamOf, weeks = 16, now = Date.now(), epicKey = "" }) {
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
    overflow
  };
}

// Доля потока команды, уходящая на эпик: завершённые задачи эпика к всем завершённым задачам.
export function epicShare(teamFlow, epicKey) {
  const done = teamFlow.byEpic.get(epicKey) || 0;
  return { done, total: teamFlow.total, share: teamFlow.total ? done / teamFlow.total : 0 };
}
