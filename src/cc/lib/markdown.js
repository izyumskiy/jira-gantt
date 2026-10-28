// Минимальный рендер Markdown — ровно то подмножество, что используется в
// docs/*.md: заголовки, абзацы, списки, таблицы, разделители, жирный/курсив,
// код и ссылки. Нужен, чтобы справка в расширении бралась из того же файла,
// что лежит в репозитории, а не дублировалась в HTML.

import { escapeHtml } from './format.js';

/** Безопасная ссылка: только http(s) и относительные пути. */
function safeHref(raw) {
  const href = raw.trim();
  if (/^https?:\/\//i.test(href)) return href;
  if (/^[\w./-]+$/.test(href)) return href;
  return '';
}

/** Разметка внутри строки. Текст уже должен быть экранирован. */
function inline(text) {
  return text
    .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, (_, bold) => `<strong>${bold}</strong>`)
    .replace(/\*([^*]+)\*/g, (_, em) => `<em>${em}</em>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, href) => {
      const url = safeHref(href);
      return url ? `<a href="${url}" target="_blank" rel="noopener">${label}</a>` : whole;
    });
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isTableDivider = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line);
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/**
 * Markdown → HTML.
 * @param {string} source
 * @returns {string}
 */
export function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    // Разделитель
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Заголовок
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = level === 2 || level === 3 ? ` id="${slug(text)}"` : '';
      out.push(`<h${level}${id}>${inline(escapeHtml(text))}</h${level}>`);
      i++;
      continue;
    }

    // Таблица
    if (isTableRow(line) && isTableDivider(lines[i + 1] || '')) {
      const head = cells(line).map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('');
      const body = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) {
        body.push(`<tr>${cells(lines[i]).map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`);
        i++;
      }
      out.push(`<div class="md-table"><table><thead><tr>${head}</tr></thead><tbody>${body.join('')}</tbody></table></div>`);
      continue;
    }

    // Список (маркированный или нумерованный)
    const bullet = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const items = [];
      while (i < lines.length) {
        const item = /^\s*([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (!item) {
          // продолжение пункта на следующей строке
          if (items.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i])) {
            items[items.length - 1] += ` ${inline(escapeHtml(lines[i].trim()))}`;
            i++;
            continue;
          }
          break;
        }
        items.push(inline(escapeHtml(item[2].trim())));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((it) => `<li>${it}</li>`).join('')}</${tag}>`);
      continue;
    }

    // Абзац: мягкие переносы склеиваем
    const buffer = [];
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,4}\s|\s*([-*]|\d+\.)\s)/.test(lines[i])
      && !isTableRow(lines[i])
      && !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])) {
      buffer.push(lines[i].trim());
      i++;
    }
    if (buffer.length) out.push(`<p>${inline(escapeHtml(buffer.join(' ')))}</p>`);
  }

  return out.join('\n');
}

/** Заголовки второго уровня — для оглавления. */
export function tableOfContents(source) {
  const out = [];
  for (const line of String(source).split('\n')) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

/** Идентификатор якоря по тексту заголовка. */
export function slug(text) {
  return String(text).toLowerCase().replace(/[^\wа-яё]+/gi, '-').replace(/^-+|-+$/g, '');
}
