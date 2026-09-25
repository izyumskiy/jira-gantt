// Заметки к эпику и истории (ТЗ «Эпик — история», Р4): строка заметки под строкой объекта, окно
// правки и история прежних заметок. Общее для ракурсов «По эпикам» и «Эпик — история», поэтому
// живёт отдельно от их отрисовки.
//
// Заметка — комментарий Jira, начинающийся с кодового слова (omg comment); действует последняя,
// прежние остаются историей. Правка публикует новый комментарий в ту же задачу.
import { t } from "./i18n.js";
import * as gantt from "./gantt.js";
import * as omg from "./omg.js";
import { addComment as jiraAddComment } from "./jira.js";

// Запись в Jira — через это, чтобы самопроверка могла подменить её заглушкой.
export const api = { addComment: (key, text) => jiraAddComment(key, text) };

const el = gantt.el;

export function fmtDateTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(+d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
}

export function popoverHead(box, title, sub = "") {
  const head = el("div", "tip-head");
  const strong = el("strong", null, title);
  if (sub) strong.append(el("div", "tip-sub-title", sub));
  const close = el("button", "tip-close", "×");
  close.title = t("tip.close");
  close.onclick = gantt.closeTooltip;
  head.append(strong, close);
  box.append(head);
}

// Действующая заметка объекта, если строки заметок включены.
export function noteToShow(rec, opts) {
  return opts && opts.show !== false ? omg.latestNote(rec) : null;
}

// Галочка «Заметки» на панели ракурса.
export function notesToggle(opts) {
  const box = el("label", "legend s-notes-toggle");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = opts.show !== false;
  cb.onchange = () => (opts.onToggle ? opts.onToggle(cb.checked) : null);
  box.append(cb, el("span", null, t("note.toggle")));
  return box;
}

// Строка заметки — только когда заметка есть: первые две строки текста, автор и дата, полный текст
// при наведении; ✎ и «История (N)»; старше порога — пометка «заметке N дн.». cells — сколько пустых
// ячеек нужно справа (секции шкалы и «Бэклог»).
export function noteRow({ target, note, cells, opts, indent, due }) {
  const tr = el("tr", "g-row s-note");
  tr.dataset.note = target.key;
  const td = el("td", "c-name");
  const wrap = el("div", "s-note-wrap");
  wrap.append(el("span", indent));
  const box = el("div", "s-note-box");
  const text = el("div", "s-note-text", note.text);
  text.title = note.text;
  const meta = el("div", "s-note-meta");
  meta.append(el("span", "s-note-who", [note.author, fmtDateTime(note.created)].filter(Boolean).join(" · ")));
  const age = omg.noteAgeDays(note);
  const stale = Number(opts.staleDays) > 0 ? Number(opts.staleDays) : 14;
  if (age != null && age > stale) {
    const s = el("span", "s-note-stale", t("note.stale", { n: age }));
    s.title = t("note.staleHint", { n: stale });
    meta.append(s);
  }
  const ed = el("button", "pop-btn link s-note-edit", "✎");
  ed.type = "button";
  ed.title = t("note.edit");
  ed.setAttribute("aria-label", t("note.edit"));
  ed.onclick = (ev) => {
    ev.stopPropagation();
    showNoteEditor(ed, target, opts);
  };
  meta.append(ed);
  const hist = omg.noteHistory(target.rec);
  if (hist.length) {
    const h = el("button", "pop-btn link s-note-hist", t("note.history", { n: hist.length }));
    h.type = "button";
    h.onclick = (ev) => {
      ev.stopPropagation();
      showNoteHistory(h, target);
    };
    meta.append(h);
  }
  box.append(text, meta);
  wrap.append(box);
  td.append(wrap);
  tr.append(td);
  for (let i = 0; i < cells; i++) tr.append(el("td", "c-cell s-note-cell"));
  if (due) gantt.addDueLine(tr, due, false);
  return tr;
}

// Публикация заметки в Jira: возвращает саму заметку (автор и дата — из ответа Jira) или бросает.
export async function publishNote(key, text) {
  const res = await api.addComment(key, omg.noteComment(text));
  return omg.noteFromComment(res) || { id: "", text, created: new Date().toISOString(), author: "" };
}

export function publishError(key, e) {
  const noRight = e && (e.code === 401 || e.code === 403);
  return t("note.publishError", { key, msg: e && e.message ? e.message : String(e) }) + (noRight ? ` ${t("story.noPermission")}` : "");
}

// Правка: форма с текстом последней заметки; «Сохранить в Jira» публикует новый комментарий
// (omg comment) в ту же задачу, старая заметка остаётся в истории.
export function showNoteEditor(anchor, target, opts) {
  const box = el("div", "tooltip tip-note");
  popoverHead(box, t("note.editTitle", { key: target.key }), target.label);
  const cur = omg.latestNote(target.rec);
  const ta = el("textarea", "cmt-input s-note-input");
  ta.rows = 5;
  ta.value = cur ? cur.text : "";
  ta.placeholder = t("note.placeholder");
  const save = el("button", "primary s-note-save", t("story.publish"));
  save.type = "button";
  const msg = el("div", "small muted s-note-msg", t("note.notifyWarn"));
  const actions = el("div", "s-proj-actions");
  actions.append(save);
  box.append(ta, actions, msg);
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text) {
      msg.textContent = t("note.empty");
      return;
    }
    save.disabled = true;
    msg.textContent = t("story.publishing");
    let note;
    try {
      note = await publishNote(target.key, text);
    } catch (e) {
      const err = publishError(target.key, e);
      msg.textContent = err;
      save.disabled = false;
      if (opts.notify) opts.notify(err, "error");
      return;
    }
    gantt.closeTooltip();
    if (opts.onNoteAdded) await opts.onNoteAdded(target.kind, target.key, note);
  };
  gantt.openPopover(box, anchor);
  ta.focus();
  return box;
}

export function showNoteHistory(anchor, target) {
  const box = el("div", "tooltip tip-note");
  popoverHead(box, t("note.historyTitle", { key: target.key }), target.label);
  const list = el("div", "cmt-list");
  for (const n of omg.noteHistory(target.rec)) {
    const item = el("div", "cmt-item");
    const meta = el("div", "cmt-meta");
    meta.append(el("span", "cmt-author", n.author || t("dash")), el("span", "muted", fmtDateTime(n.created)));
    item.append(meta, el("div", "cmt-body", n.text));
    list.append(item);
  }
  box.append(list);
  gantt.openPopover(box, anchor);
  return box;
}
