// Тонкий слой локализации: t() + разметка через data-i18n.
import { DICT } from "./dict.js";

let lang = "ru";

export function setLang(l) {
  lang = DICT[l] ? l : "ru";
}
export function getLang() {
  return lang;
}
export function langs() {
  return Object.keys(DICT);
}

export function t(key, params) {
  const table = DICT[lang] || DICT.ru;
  let s = table[key] ?? DICT.ru[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}

// Проставляет подписи всем элементам с data-i18n / data-i18n-ph / data-i18n-title.
export function applyI18n(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.documentElement.lang = lang;
  document.title = t("app.title");
}
