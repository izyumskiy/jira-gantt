// Общие чистые операции календаря для портфельного и проектного планировщиков.
export const DAY_MS = 86_400_000;

export function parseDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const text = String(value || "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return date.getFullYear() === Number(iso[1]) && date.getMonth() === Number(iso[2]) - 1 && date.getDate() === Number(iso[3]) ? date : null;
  }
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text);
  if (ru) {
    const date = new Date(Number(ru[3]), Number(ru[2]) - 1, Number(ru[1]));
    return date.getFullYear() === Number(ru[3]) && date.getMonth() === Number(ru[2]) - 1 && date.getDate() === Number(ru[1]) ? date : null;
  }
  return null;
}

export function dateKey(value) {
  const date = parseDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function addDays(value, amount) {
  const date = parseDate(value);
  if (!date) return null;
  date.setDate(date.getDate() + Number(amount || 0));
  return date;
}

export function isWorkingDay(value, holidays = new Set()) {
  const date = parseDate(value);
  if (!date) return false;
  const day = date.getDay();
  return day !== 0 && day !== 6 && !holidays.has(dateKey(date));
}

export function daysBetween(from, to, predicate = () => true) {
  const start = parseDate(from);
  const end = parseDate(to);
  if (!start || !end || start > end) return [];
  const out = [];
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) if (predicate(cursor)) out.push(dateKey(cursor));
  return out;
}
