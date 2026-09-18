// Отрисовка ракурса «Эпик — история» (ТЗ «Эпик — история», Р3, Р5): проект → эпик → история,
// полосы по временным секциям — та же механика, что на «По эпикам» (жёлтые полосы-итоги у проекта и
// эпика, голубые отрезки по спринтам у истории). Проект эпика меняется из плагина новым
// комментарием (omg project) в эпик.
import { t } from "./i18n.js";
import * as gantt from "./gantt.js";
import * as prio from "./priority.js";
import * as omg from "./omg.js";
import { NO_PROJECT, projectOf } from "./stories.js";
import { addComment as jiraAddComment } from "./jira.js";

// Запись в Jira — через это, чтобы самопроверка могла подменить её заглушкой.
export const api = { addComment: (key, text) => jiraAddComment(key, text) };

const el = gantt.el;
const NONE = "__none__";

// Свёрнутость: по умолчанию (до первого действия и после «Обновить») свёрнуто всё — видны проекты.
const collapsed = new Set();
let seeded = false;
export function resetCollapse() {
  collapsed.clear();
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

// Полосы-итоги (проект, эпик): жёлтая полоса на секцию и бэклог.
function groupCells(node, model, label) {
  const out = [];
  for (const sec of model.columns) {
    const td = el("td", "c-cell");
    const cell = node.cells.get(sec.id);
    if (cell && cell.count) td.append(gantt.groupBar(cell, model.maxCell, `${label} · ${gantt.sectionTitle(sec)}`));
    out.push(td);
  }
  const bl = el("td", "c-cell c-backlog");
  if (node.backlog.count) bl.append(gantt.groupBar(node.backlog, model.maxCell, `${label} · ${t("gantt.backlog")}`));
  out.push(bl);
  return out;
}

// Вложенные строки (история, «Без истории»): голубой отрезок на каждый спринт секции.
function nestedCells(node, model, label) {
  return [...model.columns.map((sec) => gantt.nestedCell(node.cells.get(sec.id), sec, model, label)), gantt.backlogNested(node.backlog, model, label)];
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

  container.append(
    gantt.chartBar(model, {
      withDue: true,
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
    })
  );

  const wrap = el("div", "gantt-wrap");
  const table = el("table", "gantt mode-epicStories");
  table.append(gantt.chartHead(model, rerender, { title: t("story.project"), hint: ` / ${t("gantt.epic")} / ${t("story.story")}` }));
  const tbody = el("tbody");
  const projectNames = model.projects.filter((p) => p.key !== NO_PROJECT).map((p) => p.name);

  model.projects.forEach((p) => {
    const pc = collapsed.has(pKey(p));
    const ptr = el("tr", "g-row group s-project");
    ptr.dataset.project = p.key;
    const pname = el("td", "c-name");
    const plabel = p.key === NO_PROJECT ? t("story.noProject") : p.name;
    pname.append(twisty(pc, () => toggle(pKey(p))), prio.icon(p.priority, model.priorities, t), el("span", "s-label", plabel));
    pname.append(el("span", "s-meta", t("story.projectMeta", { e: p.epics.length, s: p.storyCount })));
    if (p.key !== NO_PROJECT && opts.epicsOfProject) pname.append(renameButton(p, opts));
    ptr.append(pname, ...groupCells(p, model, plabel));
    const pdue = gantt.dueInfo({ milestone: p.milestone, status: p.status }, model);
    if (pdue) gantt.addDueLine(ptr, pdue, true);
    tbody.append(ptr);
    if (pc) return;

    p.epics.forEach((en) => {
      const ec = collapsed.has(eKey(en));
      const etr = el("tr", "g-row group s-epic");
      etr.dataset.epic = en.key;
      const ename = el("td", "c-name");
      const label = el("button", "glabel", en.label);
      label.title = en.label;
      label.onclick = (ev) => gantt.showTooltip(ev.currentTarget, en, "epicPeople", model);
      ename.append(el("span", "indent"), twisty(ec, () => toggle(eKey(en))), prio.icon(en.priority, model.priorities, t), label);
      if (en.status && en.status.name) ename.append(gantt.lozenge(en.status));
      if (opts.onProjectSet) ename.append(projectButton(en, projectNames, opts));
      ename.append(gantt.commentButton(en.key, en.label));
      etr.append(ename, ...groupCells(en, model, en.label));
      const edue = gantt.dueInfo(en, model);
      if (edue) gantt.addDueLine(etr, edue, true);
      tbody.append(etr);
      if (ec) return;

      for (const sn of en.stories) {
        const str = el("tr", "g-row proj s-story");
        str.dataset.story = sn.key;
        const sname = el("td", "c-name");
        const link = gantt.maybeLink(sn.label, gantt.browseUrl(sn.key), "plabel s-story-link");
        const hint = [t("story.hint", { n: sn.count, f: sn.foreign })];
        if (sn.missing.length) hint.push(t("story.missing", { list: sn.missing.join(", ") }));
        link.title = `${sn.label}\n${hint.join("\n")}`;
        sname.append(el("span", "indent indent2"), prio.icon(sn.priority, model.priorities, t), link);
        if (sn.status && sn.status.name) sname.append(gantt.lozenge(sn.status));
        if (sn.foreign) {
          const f = el("span", "s-foreign", t("story.foreignBadge", { n: sn.foreign }));
          f.title = t("story.foreignHint");
          sname.append(f);
        }
        if (sn.missing.length) {
          const m = el("span", "s-missing", `⚠ ${sn.missing.length}`);
          m.title = t("story.missing", { list: sn.missing.join(", ") });
          sname.append(m);
        }
        str.append(sname, ...nestedCells(sn, model, `${en.label} · ${sn.label}`));
        // История без задач, но со своим спринтом — отрезок по спринту самой истории, без оценки.
        if (sn.ownSprint) {
          const idx = model.columns.findIndex((c) => c.id === sn.ownSprint.secId);
          const td = str.children[1 + idx];
          if (td) {
            const bar = el("div", "bar nested own-sprint");
            bar.append(el("span", "bar-sprint", sn.ownSprint.sprintName));
            bar.title = t("story.ownSprint", { sprint: sn.ownSprint.sprintName });
            td.append(bar);
          }
        }
        if (edue) gantt.addDueLine(str, edue, false);
        tbody.append(str);
      }
      if (en.noStory.count) {
        const ntr = el("tr", "g-row proj s-nostory");
        const nname = el("td", "c-name");
        nname.append(el("span", "indent indent2"), el("span", "plabel plabel-others", t("story.noStory")));
        ntr.append(nname, ...nestedCells(en.noStory, model, `${en.label} · ${t("story.noStory")}`));
        if (edue) gantt.addDueLine(ntr, edue, false);
        tbody.append(ntr);
      }
    });
  });
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);
  restoreScroll();
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
