// Форматирование значений для интерфейса — с учётом выбранного языка.
// Даты и числа отдаём Intl, единицы измерения берём из словаря.

import { minToDate, MIN_PER_DAY } from './codec.js';
import { t, forms, intlTag, getLocale } from './i18n.js';

export { MIN_PER_DAY } from './codec.js';

const formatters = new Map();

function dateFormatter(options) {
  const key = `${getLocale()}|${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(intlTag(), options);
    formatters.set(key, formatter);
  }
  return formatter;
}

/** Дробная часть только когда она есть: 3 → «3», 3.14 → «3.1». */
function trim(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Длительность в минутах → «3д 4ч» / «3d 4h». */
export function formatDuration(min) {
  if (!Number.isFinite(min)) return t('units.unknown');
  const d = t('units.days');
  const h = t('units.hours');
  const m = t('units.minutes');
  const total = Math.max(0, Math.round(min));
  const days = Math.floor(total / MIN_PER_DAY);
  const hours = Math.floor((total % MIN_PER_DAY) / 60);
  const minutes = total % 60;
  if (days >= 10) return `${days}${d}`;
  if (days > 0) return hours ? `${days}${d} ${hours}${h}` : `${days}${d}`;
  if (hours > 0) return minutes ? `${hours}${h} ${minutes}${m}` : `${hours}${h}`;
  return `${minutes}${m}`;
}

/** Длительность в днях — для осей и таблиц. */
export function formatDays(min) {
  if (!Number.isFinite(min)) return t('units.unknown');
  const days = min / MIN_PER_DAY;
  if (days >= 1) return `${trim(days)}${t('units.days')}`;
  return `${trim(min / 60)}${t('units.hours')}`;
}

export function formatDate(min) {
  return dateFormatter({ day: 'numeric', month: 'short', year: 'numeric' }).format(minToDate(min));
}

export function formatDateShort(min) {
  return dateFormatter({ day: 'numeric', month: 'short' }).format(minToDate(min));
}

export function formatDateTime(min) {
  return dateFormatter({
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(minToDate(min));
}

/** Технический формат для полей ввода и имён файлов — не зависит от языка. */
export function formatIsoDate(min) {
  const d = minToDate(min);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return t('units.unknown');
  const units = forms('units.bytes');
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 && i > 0 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
