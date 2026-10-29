// Производственный календарь РФ (US-1): файл d10xa/holidays-calendar, ручные правки — поверх.
// В файле holidays — все нерабочие дни (выходные и праздники с переносами), nowork — нерабочие по
// отдельным указам, preholidays — сокращённые (рабочие). Рабочий день — даты нет ни в holidays, ни в nowork.
import * as db from "./db.js";
import * as settings from "./settings.js";

export const CALENDAR_URL = "https://raw.githubusercontent.com/d10xa/holidays-calendar/master/json/calendar.json";
export const CALENDAR_ORIGIN = "https://raw.githubusercontent.com/*";
const META_KEY = "calendar";
const REFRESH_MS = 7 * 86400000;

let cal = null; // { off: Set<"ГГГГ-ММ-ДД">, from, to, loadedAt }

const pad = (n) => String(n).padStart(2, "0");
export const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

export function parseCalendar(json, loadedAt = Date.now()) {
  if (!json || !Array.isArray(json.holidays) || !json.holidays.length) throw new Error("bad calendar");
  const years = json.holidays.map((d) => Number(String(d).slice(0, 4))).filter(Number.isFinite);
  return { off: new Set([...json.holidays, ...(json.nowork || [])]), from: Math.min(...years), to: Math.max(...years), loadedAt };
}

export function current() {
  return cal;
}

// Подмена календаря — для селфтеста и после загрузки.
export function use(c) {
  cal = c;
}

export async function load() {
  const row = await db.metaGet(META_KEY);
  try {
    cal = row ? parseCalendar(row.json, row.loadedAt) : null;
  } catch {
    cal = null;
  }
  return cal;
}

// Загрузка файла. Разрешение на домен запрашивает кнопка «Обновить» (нужен щелчок пользователя).
export async function refresh() {
  const res = await fetch(CALENDAR_URL, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const parsed = parseCalendar(json);
  await db.metaSet(META_KEY, { json, loadedAt: parsed.loadedAt });
  cal = parsed;
  return cal;
}

// Раз в неделю при синхронизации — если разрешение уже выдано. Ошибка не мешает синхронизации.
export async function maybeRefresh(now = Date.now()) {
  if (cal && now - cal.loadedAt < REFRESH_MS) return;
  if (!(await chrome.permissions.contains({ origins: [CALENDAR_ORIGIN] }))) return;
  await refresh().catch(() => {});
}

export function hasYear(year, c = cal) {
  return !!c && year >= c.from && year <= c.to;
}

// Рабочий ли день (ms — любой момент суток). Ручные правки сильнее файла; года нет в файле — пн–пт.
export function isWorkday(ms, c = cal, s = settings.get()) {
  const key = ymd(ms);
  if ((s.calendarWork || []).includes(key)) return true;
  if ((s.calendarOff || []).includes(key)) return false;
  const d = new Date(ms);
  if (hasYear(d.getFullYear(), c)) return !c.off.has(key);
  return d.getDay() !== 0 && d.getDay() !== 6;
}

const nextDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d.getTime();
};
const dayStart = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// Рабочих дней в полуинтервале дней [день from, день to): время суток не важно.
export function workdaysBetween(from, to, c = cal, s = settings.get()) {
  const end = dayStart(to);
  let n = 0;
  for (let ms = dayStart(from); ms < end; ms = nextDay(ms)) if (isWorkday(ms, c, s)) n += 1;
  return n;
}

// День, когда пройдёт n рабочих дней после from (сам from не считается).
export function addWorkdays(from, n, c = cal, s = settings.get()) {
  let ms = dayStart(from);
  for (let left = Math.ceil(n); left > 0; ) {
    ms = nextDay(ms);
    if (isWorkday(ms, c, s)) left -= 1;
  }
  return ms;
}

// Даты из поля настроек: ГГГГ-ММ-ДД или ДД.ММ.ГГГГ, через запятую, пробел или с новой строки.
export function parseDates(text) {
  const out = [];
  for (const part of String(text || "").split(/[\s,;]+/)) {
    const iso = part.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const ru = part.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const v = iso ? part : ru ? `${ru[3]}-${ru[2]}-${ru[1]}` : "";
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
