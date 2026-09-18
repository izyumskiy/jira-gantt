// Кодовые слова в комментариях Jira (ТЗ «Эпик — история», Р3, Р4): метка проекта эпика
// «(omg project) Название» и заметка «(omg comment) текст». Только разбор — без Jira и интерфейса,
// чтобы его проверял селфтест.
//
// Кодовое слово ищется в начале комментария (после пробелов), без учёта регистра. Круглые скобки,
// а не квадратные: квадратные в вики-разметке Jira Server — ссылка.

export const PROJECT_TAG = "(omg project)";
export const NOTE_TAG = "(omg comment)";

const PROJECT_RE = /^\s*\(\s*omg\s+project\s*\)/i;
const NOTE_RE = /^\s*\(\s*omg\s+comment\s*\)/i;

const createdMs = (c) => Date.parse(c.created || "") || 0;
const authorOf = (c) => (c.author && (c.author.displayName || c.author.name)) || "";

// Разбор комментариев одной задачи. Возвращает только то, что нужно плагину, — остальные
// комментарии в базу не пишутся:
//   project — действующая метка проекта (последняя по дате создания; правка комментария её место не
//             меняет) или null: меток нет или последняя с пустым названием — «Без проекта»;
//   notes   — все заметки по дате создания, последняя — действующая, остальные — история.
export function parseComments(comments) {
  const list = [...(Array.isArray(comments) ? comments : [])]
    .filter((c) => c && typeof c.body === "string")
    .sort((a, b) => createdMs(a) - createdMs(b) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  let project = null;
  const notes = [];
  for (const c of list) {
    if (PROJECT_RE.test(c.body)) {
      // Название — остаток первой строки после кодового слова.
      const name = c.body.replace(PROJECT_RE, "").split(/\r?\n/)[0].trim();
      project = name ? { name, created: c.created || "", author: authorOf(c) } : null;
    } else if (NOTE_RE.test(c.body)) {
      notes.push({ id: String(c.id || ""), text: c.body.replace(NOTE_RE, "").trim(), created: c.created || "", author: authorOf(c) });
    }
  }
  return { project, notes };
}

// Ключ сравнения названий проектов: без учёта регистра и лишних пробелов («Проект» = «ПРОЕКТ »).
export function projectKey(name) {
  return String(name || "").trim().replace(/\s+/g, " ").toLowerCase();
}

// Текст нового комментария с кодовым словом (для публикации из плагина, Р3/Р4).
export function projectComment(name) {
  const n = String(name || "").trim();
  return n ? `${PROJECT_TAG} ${n}` : PROJECT_TAG;
}

export function noteComment(text) {
  return `${NOTE_TAG}\n${String(text || "").trim()}`;
}

// ---------- заметки (Р4) ----------

// Действующая заметка — последняя; остальные — история.
export function latestNote(rec) {
  const list = rec && Array.isArray(rec.notes) ? rec.notes : [];
  return list.length ? list[list.length - 1] : null;
}

// Предыдущие заметки, новые первыми.
export function noteHistory(rec) {
  const list = rec && Array.isArray(rec.notes) ? rec.notes : [];
  return list.slice(0, -1).reverse();
}

// Сколько полных дней заметке; null — дата неизвестна.
export function noteAgeDays(note, now = Date.now()) {
  const c = Date.parse((note && note.created) || "");
  return c ? Math.max(0, Math.floor((now - c) / 86400000)) : null;
}

// Заметка из ответа Jira на публикацию комментария (там автор и дата уже настоящие).
export function noteFromComment(comment) {
  return comment && typeof comment.body === "string" ? parseComments([comment]).notes[0] || null : null;
}
