// Отрисовка ракурса «Эпик — история» (ТЗ «Эпик — история», Р3, Р5): проект → эпик → история.
// Слева — выровненные колонки, как в таблице статуса: название, статус (точка и текст), «готово»
// (тонкая шкала и «N из M») и срок. Справа — тихая шкала: одна система полос, толщина — уровень
// (проект, эпик, история), цифры мелко под полосой, название спринта — в подсказке. Действия
// («Проект…», 💬, ✎) — при наведении на строку. Готовые истории эпика свёрнуты в одну строку.
// Проект эпика меняется новым комментарием (omg project) в эпик; заметки — комментарии
// (omg comment) в ту же задачу (Р4), строка заметки — только там, где заметка есть.
import { t } from "./i18n.js";
import * as gantt from "./gantt.js";
import * as prio from "./priority.js";
import * as omg from "./omg.js";
import { fmtEstimate } from "./agg.js";
import { NO_PROJECT, projectOf } from "./stories.js";
import { addComment as jiraAddComment } from "./jira.js";

// Запись в Jira — через это, чтобы самопроверка могла подменить её заглушкой.
export const api = { addComment: (key, text) => jiraAddComment(key, text) };

const el = gantt.el;
const NONE = "__none__";
const DUE_SOON_DAYS = 14;

// Свёрнутость: по умолчанию (до первого действия и после «Обновить») свёрнуто всё — видны проекты.
// Готовые истории эпика свёрнуты всегда, пока их не раскрыли.
const collapsed = new Set();
const openDone = new Set();
let seeded = false;
export function resetCollapse() {
  collapsed.clear();
  openDone.clear();
  seeded = false;
}
const pKey = (p) => `p:${p.key}`;
const eKey = (e) => `e:${e.key}`;

function twisty(isCollapsed, onToggle) {
  const b = el("button", "twisty", isCollapsed ? "▸" : "▾");
  b.type = "button";
  b.onclick = onToggle;
  return b;
}

// ---------- левая часть: колонки строки ----------

function fmtShort(iso) {
  const d = new Date(iso && iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (!iso || Number.isNaN(+d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}`;
}

// Статус — цветная точка по категории и название.
function statusCell(status) {
  const c = el("span", "s-st");
  if (status && status.name) {
    c.append(el("i", `s-dot s-dot-${status.id || "other"}`), el("span", "s-st-name", status.name));
    c.title = status.name;
  }
  return c;
}

// «Готово»: тонкая шкала и «N из M»; по щелчку — список задач (если он есть).
function progressCell(done, total, list, title) {
  const c = el(list && list.length ? "button" : "span", "s-pr" + (list && list.length ? " pop-btn s-progress" : "") + (total && done === total ? " all-done" : ""));
  if (!total) return c;
  const bar = el("span", "s-pr-bar");
  const fill = el("i");
  fill.style.width = `${Math.round((done / total) * 100)}%`;
  bar.append(fill);
  c.append(bar, el("span", "s-pr-text", t("story.progress", { done, n: total })));
  if (list && list.length) {
    c.type = "button";
    c.title = t("story.progressHint");
    c.onclick = (ev) => {
      ev.stopPropagation();
      gantt.showIssues(ev.currentTarget, title, list);
    };
  }
  return c;
}

// Срок: веха (◆ срок исполнения, ◇ плановое завершение), красным — прошёл или ближе 14 дней.
function dueCell(milestone, done) {
  const c = el("span", "s-due");
  if (!milestone) return c;
  const d = new Date(milestone.date.length === 10 ? `${milestone.date}T00:00:00` : milestone.date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.round((d - today) / 86400000);
  c.textContent = `${milestone.kind === "planned" ? "◇" : "◆"} ${fmtShort(milestone.date)}`;
  c.classList.add(done ? "s-due-done" : days <= DUE_SOON_DAYS ? "s-due-soon" : "s-due-far");
  if (milestone.kind === "planned") c.classList.add("s-due-planned");
  c.title = `${milestone.kind === "planned" ? t("gantt.plannedIn", { date: fmtShort(milestone.date), n: days }) : t("gantt.dueIn", { date: fmtShort(milestone.date), n: days })}`;
  return c;
}

// Строка названий: [отступ, раскрытие, приоритет, название + действия при наведении] | статус | готово | срок.
function nameCell({ indent = "", twist = null, icon = null, title, actions = [], marks = [], status = null, progress, due }) {
  const td = el("td", "c-name");
  const row = el("div", "s-cols");
  const main = el("div", "s-title");
  if (indent) main.append(el("span", indent));
  if (twist) main.append(twist);
  if (icon) main.append(icon);
  main.append(title, ...marks);
  if (actions.length) {
    const act = el("span", "s-actions");
    act.append(...actions);
    main.append(act);
  }
  row.append(main, statusCell(status), progress || el("span", "s-pr"), due || el("span", "s-due"));
  td.append(row);
  return td;
}

// Направляющие дерева: тонкая вертикальная линия от стрелки проекта (уровень 0) и эпика (уровень 1)
// вниз по строкам их блока, как направляющие отступов в редакторах кода; без уголков у каждой строки.
// start — начало линии на строке самого проекта или эпика (от стрелки вниз). hot — ключ блока, чья
// линия подсвечивается при наведении на строку.
const GUIDE_X = [12, 30];
function addGuides(tr, guides, hot) {
  const td = tr.querySelector(".c-name");
  for (const g of guides) {
    const line = el("i", "s-guide" + (g.start ? " s-guide-start" : ""));
    line.style.left = `${GUIDE_X[g.level]}px`;
    line.dataset.g = g.key;
    td.append(line);
  }
  if (hot) tr.dataset.hot = hot;
  return tr;
}

// Подсветка направляющей блока, в котором сейчас мышь.
function wireGuideHover(tbody) {
  let cur = "";
  const set = (key) => {
    if (key === cur) return;
    tbody.querySelectorAll(".s-guide.hot").forEach((g) => g.classList.remove("hot"));
    cur = key;
    if (key) tbody.querySelectorAll(".s-guide").forEach((g) => g.dataset.g === key && g.classList.add("hot"));
  };
  tbody.addEventListener("mouseover", (e) => set(e.target.closest("tr")?.dataset.hot || ""));
  tbody.addEventListener("mouseleave", () => set(""));
}

// ---------- правая часть: полосы по секциям ----------

// Полоса секции. Цвет один (синий): сделанное — насыщенным, остаток — бледным; доля готового — по
// оценке, без оценок — по количеству. Тип объекта — формой, как на классической диаграмме Ганта:
//   p — проект: «скобка» итоговой задачи — тонкая полоса с уголками на концах;
//   e — эпик: сплошной брусок;
//   s — история: тонкая линия; в первой секции, где у истории есть работа, — точка-начало (start).
// Цифры «задач · оценка» — мелко под полосой. Щелчок — список задач.
function sectionBar(cell, lvl, title, model, { start = false } = {}) {
  const b = el("div", `sbar sbar-${lvl} clickable` + (start ? " sbar-start" : ""));
  const est = cell.issues.reduce((n, i) => n + (i.estimate || 0), 0);
  const doneEst = cell.issues.reduce((n, i) => n + (i.done ? i.estimate || 0 : 0), 0);
  const doneN = cell.issues.filter((i) => i.done).length;
  const share = est > 0 ? doneEst / est : cell.issues.length ? doneN / cell.issues.length : 0;
  const track = el("span", "sbar-track" + (share >= 1 ? " all-done" : ""));
  const fill = el("i", "sbar-fill");
  fill.style.width = `${Math.round(share * 100)}%`;
  track.append(fill);
  const line = el("span", "sbar-line");
  if (start) line.append(el("i", "sbar-dot" + (share > 0 ? " done" : "")));
  line.append(track);
  b.append(line);
  if (lvl === "p") {
    // Уголки скобки: левый — цветом сделанного, если в секции что-то готово; правый — если готово всё.
    const caps = el("span", "sbar-caps");
    caps.append(el("i", "cap-l" + (share > 0 ? " done" : "")), el("i", "cap-r" + (share >= 1 ? " done" : "")));
    b.append(caps);
  }
  b.append(el("span", "sbar-num", `${cell.count} · ${fmtEstimate(cell.sum)}`));
  const sprints = model && cell.bySprint ? [...cell.bySprint.keys()].map((id) => model.sprintById.get(id)).filter(Boolean).map((s) => `${s.name} · ${model.teamOf(s).name}`) : [];
  b.title = [title, t("gantt.doneShare", { done: doneN, total: cell.issues.length }), ...sprints].join("\n");
  b.onclick = (ev) => gantt.showIssues(ev.currentTarget, title, cell.issues);
  return b;
}

// start — у истории точка-начало в первой секции, где у неё есть работа.
function barCells(node, model, lvl, label, { start = false } = {}) {
  const out = [];
  let first = start;
  for (const sec of model.columns) {
    const td = el("td", "c-cell s-cell");
    const cell = node.cells.get(sec.id);
    if (cell && cell.count) {
      td.append(sectionBar(cell, lvl, `${label} · ${gantt.sectionTitle(sec)}`, model, { start: first }));
      first = false;
    }
    out.push(td);
  }
  const bl = el("td", "c-cell c-backlog s-cell");
  if (node.backlog.count) bl.append(sectionBar(node.backlog, lvl, `${label} · ${t("gantt.backlog")}`, model));
  out.push(bl);
  return out;
}

// Кнопка-действие строки (видна при наведении).
function actionBtn(cls, text, title, onClick) {
  const b = el("button", `pop-btn s-act ${cls}`, text);
  b.type = "button";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.onclick = (ev) => {
    ev.stopPropagation();
    onClick(ev.currentTarget);
  };
  return b;
}

// Заголовок колонки названий: те же колонки, что в строках.
function nameHead() {
  const row = el("div", "s-cols s-head");
  const main = el("div", "s-title");
  main.append(el("span", null, t("story.project")), el("span", "th-hint", ` / ${t("gantt.epic")} / ${t("story.story")}`));
  row.append(main, el("span", "s-st", t("story.colStatus")), el("span", "s-pr", t("story.colDone")), el("span", "s-due", t("story.colDue")));
  return row;
}

export function render(container, model, opts = {}) {
  const restoreScroll = gantt.keepScroll(container);
  container.textContent = "";
  if (!model.projects.length) {
    container.append(el("div", "empty", t("gantt.noData")));
    restoreScroll();
    return;
  }
  if (!model.columns.length) {
    container.append(el("div", "empty", t("gantt.noSprints")));
    restoreScroll();
    return;
  }
  if (!seeded) {
    for (const p of model.projects) {
      collapsed.add(pKey(p));
      for (const e of p.epics) collapsed.add(eKey(e));
    }
    seeded = true;
  }
  const rerender = () => render(container, model, opts);
  const toggle = (key) => {
    collapsed.has(key) ? collapsed.delete(key) : collapsed.add(key);
    rerender();
  };

  const showNotes = opts.showNotes !== false;
  const bar = gantt.chartBar(model, {
    withDue: false,
    onExpand: () => {
      collapsed.clear();
      rerender();
    },
    onCollapse: () => {
      for (const p of model.projects) {
        collapsed.add(pKey(p));
        for (const e of p.epics) collapsed.add(eKey(e));
      }
      rerender();
    }
  });
  bar.classList.add("s-bar"); // легенда «доля готовых» — тем же синим, что и полосы
  // Галочка «Заметки»: показывает и скрывает строки заметок.
  const nt = el("label", "legend s-notes-toggle");
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = showNotes;
  cb.onchange = () => (opts.onToggleNotes ? opts.onToggleNotes(cb.checked) : null);
  nt.append(cb, el("span", null, t("note.toggle")));
  bar.insertBefore(nt, bar.children[2] || null);
  container.append(bar);

  // Историй не нашлось ни в одном эпике — говорим почему, а не молчим: какие типы задач есть в
  // эпиках и что указано в «Типах историй».
  if (!model.storyTotal && model.typeCounts && model.typeCounts.length) {
    const hint = el("div", "s-nostories");
    hint.append(
      el("strong", null, t("story.noneFound", { setting: opts.storyTypesText || "—" })),
      " ",
      t("story.noneFoundTypes", { types: model.typeCounts.map((x) => `${x.name} (${x.n})`).join(", ") })
    );
    // Похожий на историю тип — одной кнопкой добавить его в «Типы историй».
    for (const name of model.storyCandidates || []) {
      if (!opts.onAddStoryType) break;
      const b = el("button", "primary s-add-type", t("story.useType", { name }));
      b.type = "button";
      b.onclick = () => opts.onAddStoryType(name);
      hint.append(" ", b);
    }
    container.append(hint);
  }
  // Истории есть, но ни у одной нет задач по связи из настроек — показываем, какие связи есть у
  // историй в Jira, и даём выбрать нужную одной кнопкой.
  if (model.storyTotal && !model.storyTaskTotal) {
    const hint = el("div", "s-nostories");
    const types = model.linkTypeCounts || [];
    hint.append(el("strong", null, t("story.noTasks", { setting: opts.storyLinkText || "—" })), " ");
    hint.append(types.length ? t("story.noTasksTypes", { types: types.map((x) => `${x.name} (${x.n})`).join(", ") }) : t("story.noLinks"));
    for (const x of types) {
      if (!opts.onAddLinkType || x.name === "—") continue;
      const b = el("button", "primary s-add-type", t("story.useLink", { name: x.name }));
      b.type = "button";
      b.onclick = () => opts.onAddLinkType(x.name);
      hint.append(" ", b);
    }
    container.append(hint);
  }

  const wrap = el("div", "gantt-wrap");
  const table = el("table", "gantt mode-epicStories");
  gantt.applyNameWidth(table, "epicStories");
  table.append(gantt.chartHead(model, rerender, { widthKey: "epicStories", compact: true, nameHead: nameHead() }));
  const tbody = el("tbody");
  const projectNames = model.projects.filter((p) => p.key !== NO_PROJECT).map((p) => p.name);
  const noteOf = (rec) => (showNotes ? omg.latestNote(rec) : null);

  const storyRow = (en, sn, edue, guides) => {
    const str = el("tr", "g-row s-story" + (sn.status && sn.status.id === "done" ? " s-story-done" : ""));
    str.dataset.story = sn.key;
    const link = gantt.maybeLink("", gantt.browseUrl(sn.key), "plabel s-story-link");
    link.append(el("span", "s-key", sn.key), " ", el("span", null, sn.story.summary || ""));
    const hint = [t("story.hint", { n: sn.all.length, f: sn.foreign })];
    if (sn.missing.length) hint.push(t("story.missing", { list: sn.missing.join(", ") }));
    link.title = `${sn.label}\n${hint.join("\n")}`;
    const marks = [];
    if (sn.foreign) {
      const f = el("span", "s-foreign", `+${sn.foreign}`);
      f.title = `${t("story.foreignBadge", { n: sn.foreign })} — ${t("story.foreignHint")}`;
      marks.push(f);
    }
    if (sn.missing.length) {
      const m = el("span", "s-missing", `⚠ ${sn.missing.length}`);
      m.title = t("story.missing", { list: sn.missing.join(", ") });
      marks.push(m);
    }
    const target = { kind: "story", key: sn.key, label: sn.label, rec: sn.story.omg };
    const doneN = sn.all.filter((i) => i.done).length;
    str.append(
      nameCell({
        indent: "indent indent2",
        icon: prio.icon(sn.priority, model.priorities, t),
        title: link,
        marks,
        actions: opts.onNoteAdded ? [actionBtn("s-note-add", "✎", t("note.edit"), (a) => showNoteEditor(a, target, opts))] : [],
        status: sn.status,
        progress: progressCell(doneN, sn.all.length, sn.all, sn.label)
      }),
      ...barCells(sn, model, "s", sn.label, { start: true })
    );
    // История без задач, но со своим спринтом — штрихованный отрезок по спринту самой истории.
    if (sn.ownSprint) {
      const idx = model.columns.findIndex((c) => c.id === sn.ownSprint.secId);
      const td = str.children[1 + idx];
      if (td) {
        const own = el("div", "sbar sbar-s own-sprint");
        const line = el("span", "sbar-line");
        line.append(el("span", "sbar-track"));
        own.append(line);
        own.title = t("story.ownSprint", { sprint: sn.ownSprint.sprintName });
        td.append(own);
      }
    }
    if (edue) gantt.addDueLine(str, edue, false);
    tbody.append(addGuides(str, guides, eKey(en)));
    const note = noteOf(sn.story.omg);
    if (note) tbody.append(addGuides(noteRow({ target, note, model, opts, indent: "indent indent2", due: edue }), guides, eKey(en)));
  };

  model.projects.forEach((p) => {
    const pc = collapsed.has(pKey(p));
    const ptr = el("tr", "g-row group s-project");
    ptr.dataset.project = p.key;
    const plabel = p.key === NO_PROJECT ? t("story.noProject") : p.name;
    const ptitle = el("span", "s-label");
    ptitle.append(el("span", null, plabel), el("span", "s-meta", ` · ${t("story.projectMeta", { e: p.epics.length, s: p.storyCount })}`));
    ptr.append(
      nameCell({
        twist: twisty(pc, () => toggle(pKey(p))),
        icon: prio.icon(p.priority, model.priorities, t),
        title: ptitle,
        actions: p.key !== NO_PROJECT && opts.epicsOfProject ? [renameButton(p, opts)] : [],
        progress: progressCell(p.done, p.count),
        due: dueCell(p.milestone, p.allDone)
      }),
      ...barCells(p, model, "p", plabel)
    );
    tbody.append(addGuides(ptr, pc ? [] : [{ level: 0, key: pKey(p), start: true }], pKey(p)));
    if (pc) return;
    const pg = { level: 0, key: pKey(p) };

    p.epics.forEach((en) => {
      const ec = collapsed.has(eKey(en));
      const etr = el("tr", "g-row group s-epic");
      etr.dataset.epic = en.key;
      const label = el("button", "glabel");
      label.append(el("span", "s-key", en.key), " ", el("span", null, en.epic.epicName || en.epic.summary || ""));
      label.title = en.label;
      label.onclick = (ev) => gantt.showTooltip(ev.currentTarget, en, "epicPeople", model);
      const target = { kind: "epic", key: en.key, label: en.label, rec: en.epic.omg };
      const actions = [];
      if (opts.onProjectSet) actions.push(projectButton(en, projectNames, opts));
      actions.push(gantt.commentButton(en.key, en.label));
      if (opts.onNoteAdded) actions.push(actionBtn("s-note-add", "✎", t("note.edit"), (a) => showNoteEditor(a, target, opts)));
      etr.append(
        nameCell({
          indent: "indent",
          twist: twisty(ec, () => toggle(eKey(en))),
          icon: prio.icon(en.priority, model.priorities, t),
          title: label,
          actions,
          status: en.status,
          progress: progressCell(en.done, en.count),
          due: dueCell(en.milestone, en.status.id === "done")
        }),
        ...barCells(en, model, "e", en.label)
      );
      const edue = gantt.dueInfo(en, model);
      if (edue) gantt.addDueLine(etr, edue, false);
      // Заметка эпика — его собственная строка: видна и у свёрнутого эпика.
      const enote = noteOf(en.epic.omg);
      const eg = { level: 1, key: eKey(en) };
      const epicBlock = !ec || !!enote; // у эпика есть строки ниже — линия эпика нужна
      tbody.append(addGuides(etr, epicBlock ? [pg, { ...eg, start: true }] : [pg], epicBlock ? eKey(en) : pKey(p)));
      if (enote) tbody.append(addGuides(noteRow({ target, note: enote, model, opts, indent: "indent", due: edue }), [pg, eg], eKey(en)));
      if (ec) return;

      const open = en.stories.filter((sn) => !(sn.status && sn.status.id === "done"));
      const done = en.stories.filter((sn) => sn.status && sn.status.id === "done");
      for (const sn of open) storyRow(en, sn, edue, [pg, eg]);
      // Готовые истории — одной строкой, раскрываются по щелчку.
      if (done.length) {
        const isOpen = openDone.has(en.key);
        const dtr = el("tr", "g-row s-donegroup");
        dtr.dataset.epic = en.key;
        const tw = twisty(!isOpen, () => {
          isOpen ? openDone.delete(en.key) : openDone.add(en.key);
          rerender();
        });
        const doneTasks = done.reduce((n, sn) => n + sn.all.length, 0);
        const doneDone = done.reduce((n, sn) => n + sn.all.filter((i) => i.done).length, 0);
        dtr.append(
          nameCell({
            indent: "indent indent2",
            twist: tw,
            title: el("span", "plabel plabel-others", t("story.doneGroup", { n: done.length })),
            status: { id: "done", name: t("story.doneStatus") },
            progress: progressCell(doneDone, doneTasks)
          }),
          ...model.columns.map(() => el("td", "c-cell s-cell")),
          el("td", "c-cell c-backlog s-cell")
        );
        tbody.append(addGuides(dtr, [pg, eg], eKey(en)));
        if (isOpen) for (const sn of done) storyRow(en, sn, edue, [pg, eg]);
      }
      if (en.noStory.count) {
        const ntr = el("tr", "g-row s-nostory");
        ntr.append(
          nameCell({
            indent: "indent indent2",
            title: el("span", "plabel plabel-others", t("story.noStory")),
            progress: progressCell(en.noStory.done, en.noStory.count)
          }),
          ...barCells(en.noStory, model, "s", `${en.label} · ${t("story.noStory")}`)
        );
        if (edue) gantt.addDueLine(ntr, edue, false);
        tbody.append(addGuides(ntr, [pg, eg], eKey(en)));
      }
    });
  });
  wireGuideHover(tbody);
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);
  restoreScroll();
}

// ---------- заметки (Р4) ----------

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(+d)) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${String(d.getFullYear()).slice(-2)}`;
}

// Строка заметки — только когда заметка есть: первые две строки текста, автор и дата, полный текст
// при наведении; ✎ и «История (N)»; старше порога — пометка «заметке N дн.».
function noteRow({ target, note, model, opts, indent, due }) {
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
  for (let i = 0; i <= model.columns.length; i++) tr.append(el("td", "c-cell s-note-cell"));
  if (due) gantt.addDueLine(tr, due, false);
  return tr;
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
    let res;
    try {
      res = await api.addComment(target.key, omg.noteComment(text));
    } catch (e) {
      const noRight = e && (e.code === 401 || e.code === 403);
      const err = t("note.publishError", { key: target.key, msg: e && e.message ? e.message : String(e) }) + (noRight ? ` ${t("story.noPermission")}` : "");
      msg.textContent = err;
      save.disabled = false;
      if (opts.notify) opts.notify(err, "error");
      return;
    }
    // Автор и дата — из ответа Jira; если ответа нет — текущие.
    const note = omg.noteFromComment(res) || { id: "", text, created: new Date().toISOString(), author: "" };
    gantt.closeTooltip();
    if (opts.onNoteAdded) await opts.onNoteAdded(target.kind, target.key, note);
  };
  gantt.openPopover(box, anchor);
  ta.focus();
  return box;
}

function showNoteHistory(anchor, target) {
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

function popoverHead(box, title, sub = "") {
  const head = el("div", "tip-head");
  const strong = el("strong", null, title);
  if (sub) strong.append(el("div", "tip-sub-title", sub));
  const close = el("button", "tip-close", "×");
  close.title = t("tip.close");
  close.onclick = gantt.closeTooltip;
  head.append(strong, close);
  box.append(head);
}

// ---------- смена проекта эпика (Р3) ----------

function projectButton(en, projectNames, opts) {
  const b = el("button", "pop-btn s-proj-btn", t("story.projectBtn"));
  b.type = "button";
  b.title = t("story.projectBtnHint");
  b.onclick = (ev) => {
    ev.stopPropagation();
    showProjectPicker(b, en, projectNames, opts);
  };
  return b;
}

export function showProjectPicker(anchor, en, projectNames, opts) {
  const box = el("div", "tooltip tip-project");
  popoverHead(box, t("story.projectTitle", { key: en.key }), en.label);
  const cur = projectOf(en.epic);
  const sel = el("select", "s-proj-select");
  for (const name of projectNames) {
    const o = el("option", null, name);
    o.value = name;
    if (cur && omg.projectKey(cur.name) === omg.projectKey(name)) o.selected = true;
    sel.append(o);
  }
  const none = el("option", null, t("story.noProject"));
  none.value = NONE;
  if (!cur) none.selected = true;
  sel.append(none);
  const input = el("input", "s-proj-new");
  input.type = "text";
  input.placeholder = t("story.newProject");
  const save = el("button", "primary s-proj-save", t("story.publish"));
  save.type = "button";
  const msg = el("div", "small muted s-proj-msg", t("story.notifyWarn"));
  box.append(el("div", "tip-sub", t("story.pickProject")), sel, el("div", "tip-sub", t("story.orNewProject")), input, el("div", "s-proj-actions"), msg);
  box.querySelector(".s-proj-actions").append(save);
  save.onclick = async () => {
    const name = input.value.trim() || (sel.value === NONE ? "" : sel.value);
    if (name === (cur ? cur.name : "")) {
      gantt.closeTooltip();
      return;
    }
    save.disabled = true;
    msg.textContent = t("story.publishing");
    try {
      await api.addComment(en.key, omg.projectComment(name));
    } catch (e) {
      // Публикация не прошла — эпик остаётся на месте, сообщение — в строке статуса.
      const noRight = e && (e.code === 401 || e.code === 403);
      const text = t("story.publishError", { key: en.key, msg: e && e.message ? e.message : String(e) }) + (noRight ? ` ${t("story.noPermission")}` : "");
      msg.textContent = text;
      save.disabled = false;
      if (opts.notify) opts.notify(text, "error");
      return;
    }
    gantt.closeTooltip();
    await opts.onProjectSet(en.key, name);
  };
  gantt.openPopover(box, anchor);
  input.focus();
  return box;
}

// ---------- переименование проекта (Р3) ----------

function renameButton(p, opts) {
  const b = el("button", "pop-btn link s-rename", t("story.rename"));
  b.type = "button";
  b.onclick = (ev) => {
    ev.stopPropagation();
    showRename(b, p, opts);
  };
  return b;
}

// Новая метка публикуется во все эпики проекта из выборки пользователя (включая скрытые галочкой и
// фильтрами). Эпики проекта в чужих выборках плагин не видит — они останутся со старым названием.
export function showRename(anchor, p, opts) {
  const epics = opts.epicsOfProject(p.key);
  const box = el("div", "tooltip tip-project");
  popoverHead(box, t("story.renameTitle"), p.name);
  const input = el("input", "s-proj-new");
  input.type = "text";
  input.value = p.name;
  const save = el("button", "primary s-proj-save", t("story.publish"));
  save.type = "button";
  const msg = el("div", "small muted s-proj-msg", `${t("story.renameWarn", { n: epics.length })} ${t("story.renameScope")}`);
  box.append(input, el("div", "s-proj-actions"), msg);
  box.querySelector(".s-proj-actions").append(save);
  save.onclick = async () => {
    const name = input.value.trim();
    if (!name || name === p.name) {
      gantt.closeTooltip();
      return;
    }
    save.disabled = true;
    const ok = [];
    const failed = [];
    for (const e of epics) {
      msg.textContent = t("story.renaming", { i: ok.length + failed.length + 1, n: epics.length });
      try {
        await api.addComment(e.key, omg.projectComment(name));
        ok.push(e.key);
      } catch (err) {
        failed.push(e.key);
      }
    }
    gantt.closeTooltip();
    if (ok.length) await opts.onRenamed(ok, name);
    if (opts.notify) {
      opts.notify(
        failed.length ? t("story.renamePartial", { ok: ok.length, n: epics.length, list: failed.join(", ") }) : t("story.renamed", { n: ok.length, name }),
        failed.length ? "error" : "info"
      );
    }
  };
  gantt.openPopover(box, anchor);
  input.focus();
  input.select();
  return box;
}
