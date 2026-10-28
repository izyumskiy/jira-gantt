// Движок локализации: выбор языка, подстановка значений, множественное число
// и простановка текстов в статическую разметку по атрибутам data-cc-i18n*.
//
// Тексты лежат отдельно — в messages.js.

import { MESSAGES, LOCALES, DEFAULT_LOCALE } from './messages.js';

export { LOCALES, DEFAULT_LOCALE };

let current = DEFAULT_LOCALE;
const listeners = new Set();

export function getLocale() {
  return current;
}

export function isSupported(code) {
  return Boolean(code && MESSAGES[code]);
}

/** Язык браузера → поддерживаемый код (иначе язык по умолчанию). */
export function detectLocale() {
  const candidates = [];
  if (typeof navigator !== 'undefined') {
    candidates.push(...(navigator.languages || []), navigator.language);
  }
  for (const tag of candidates) {
    const code = String(tag || '').slice(0, 2).toLowerCase();
    if (isSupported(code)) return code;
  }
  return DEFAULT_LOCALE;
}

/** Устанавливает язык; возвращает применённый код. */
export function setLocale(code) {
  const next = isSupported(code) ? code : DEFAULT_LOCALE;
  if (next === current) return current;
  current = next;
  for (const fn of listeners) fn(current);
  return current;
}

/** Подписка на смену языка. */
export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lookup(key) {
  const dict = MESSAGES[current] || MESSAGES[DEFAULT_LOCALE];
  const value = dict[key];
  if (value !== undefined) return value;
  const fallback = MESSAGES[DEFAULT_LOCALE][key];
  return fallback !== undefined ? fallback : key;
}

function substitute(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (
    params[name] === undefined || params[name] === null ? whole : String(params[name])
  ));
}

/**
 * Текст по ключу с подстановками: t('sync.saved', {saved: 10}).
 * Неизвестный ключ возвращается как есть — так его сразу видно в интерфейсе.
 */
export function t(key, params) {
  const value = lookup(key);
  const text = Array.isArray(value) ? value[0] : value;
  return substitute(String(text), params);
}

/** Формы множественного числа как массив. */
export function forms(key) {
  const value = lookup(key);
  return Array.isArray(value) ? value : [String(value)];
}

/** Индекс формы для числа по правилам текущего языка. */
export function pluralIndex(n, locale = current) {
  const count = Math.abs(Math.round(n));
  if (locale === 'ru') {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 0;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1;
    return 2;
  }
  return count === 1 ? 0 : 1;
}

/** «5 задач» / «5 issues» — число вместе с нужной формой слова. */
export function tn(key, n) {
  const list = forms(key);
  const index = Math.min(pluralIndex(n), list.length - 1);
  return `${n} ${list[index]}`;
}

// ------------------------------------------------- статическая разметка

// Атрибуты с префиксом cc-: Control Chart живёт на одной странице с OhMyGant, у которого своя
// разметка data-i18n и свой словарь — общие атрибуты переводчики затирали бы друг у друга.
const ATTRIBUTE_KEYS = [
  ['data-cc-i18n-title', 'title'],
  ['data-cc-i18n-placeholder', 'placeholder'],
  ['data-cc-i18n-aria-label', 'aria-label'],
];

/**
 * Расставляет тексты в разметке:
 *   data-cc-i18n="key"             → textContent
 *   data-cc-i18n-title="key"       → атрибут title
 *   data-cc-i18n-placeholder="key" → атрибут placeholder
 * Язык и заголовок документа меняем только на собственной странице (справка); внутри OhMyGant
 * документ чужой — им управляет он.
 */
export function applyStatic(root = document) {
  const scope = root.querySelectorAll ? root : document;
  for (const node of scope.querySelectorAll('[data-cc-i18n]')) {
    node.textContent = t(node.getAttribute('data-cc-i18n'));
  }
  for (const [attr, target] of ATTRIBUTE_KEYS) {
    for (const node of scope.querySelectorAll(`[${attr}]`)) {
      node.setAttribute(target, t(node.getAttribute(attr)));
    }
  }
  if (typeof document !== 'undefined' && scope === document) {
    document.documentElement.lang = current;
    const titleKey = document.documentElement.getAttribute('data-cc-i18n-doctitle');
    if (titleKey) document.title = t(titleKey);
  }
}

/** Тег локали для Intl: 'ru' → 'ru-RU', 'en' → 'en-GB' (день-месяц). */
export function intlTag() {
  return current === 'ru' ? 'ru-RU' : 'en-GB';
}
