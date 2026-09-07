// Вкладка «Команда»: люди из выгрузки и их ручные свойства — роль, информационные системы, статус.
// Профили лежат в IndexedDB (store people) и никогда не трогаются синхронизацией: при каждой
// отрисовке люди из свежей выгрузки сопоставляются с профилями по нормализованному имени.
import { t } from "./i18n.js";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as agg from "./agg.js";
import { fmtEstimate } from "./agg.js";

export const ROLES = ["developer", "qa", "analytic", "teamlead", "support", "pm", "devops"];
export const STATUSES = ["staff", "outstaff", "fired"];

// Ключ сопоставления: имя без регистра, лишних пробелов и «ё».
export const normName = (s) =>
  String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/ё/g, "е"); // после приведения к нижнему регистру, иначе «Ё» уцелеет

// Уникальные исполнители целевых и прочих задач, по алфавиту.
export function collectPeople(issues, others = []) {
  const map = new Map();
  for (const i of [...issues, ...others]) {
    if (!i.assigneeName) continue;
    const name = normName(i.assigneeName);
    if (!name || map.has(name)) continue;
    map.set(name, { name, displayName: i.assigneeName.trim(), login: i.assigneeLogin || "", key: i.assigneeKey || "" });
  }
  return [...map.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function emptyProfile(p) {
  return { name: p.name, displayName: p.displayName, login: p.login || "", key: p.key || "", role: "", systems: [], status: "" };
}

// Люди из выгрузки + их профили; профили тех, кого в выгрузке больше нет, идут в хвост с пометкой.
export function mergeProfiles(people, profiles) {
  const byName = new Map(profiles.map((p) => [p.name, p]));
  const rows = people.map((p) => {
    const saved = byName.get(p.name) || {};
    return { ...emptyProfile(p), ...saved, displayName: p.displayName, login: p.login, key: p.key, loaded: true };
  });
  const seen = new Set(people.map((p) => p.name));
  for (const p of profiles) if (!seen.has(p.name)) rows.push({ ...emptyProfile(p), ...p, loaded: false });
  return rows;
}

export async function saveProfile(row) {
  await db.putAll(db.STORES.people, [
    {
      name: row.name,
      displayName: row.displayName,
      login: row.login || "",
      key: row.key || "",
      role: row.role || "",
      systems: [...(row.systems || [])],
      status: row.status || "",
      updatedAt: Date.now()
    }
  ]);
}

export async function deleteProfile(name) {
  await db.delKeys(db.STORES.people, [name]);
}

// Справочник систем из настроек + системы, уже выбранные у людей (чтобы удалённая из справочника не пропала).
export function systemsList(rows) {
  const set = new Set(settings.get().infoSystems || []);
  for (const r of rows) for (const sName of r.systems || []) set.add(sName);
  return [...set];
}

// Разбор текста справочника: по строкам или через запятую, без дублей.
export function parseSystems(text) {
  const out = [];
  for (const part of String(text || "").split(/[\n,;]/)) {
    const v = part.trim();
    if (v && !out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function select(options, value, onChange) {
  const sel = el("select", "team-select");
  const none = el("option", null, t("team.none"));
  none.value = "";
  sel.append(none);
  for (const [id, label] of options) {
    const o = el("option", null, label);
    o.value = id;
    sel.append(o);
  }
  sel.value = value || "";
  sel.onchange = () => onChange(sel.value);
  return sel;
}

// Панель чипов: клик переключает систему у человека.
function chips(all, selected, onChange) {
  const box = el("div", "chips");
  if (!all.length) {
    box.append(el("span", "muted", t("team.noSystems")));
    return box;
  }
  for (const name of all) {
    const on = selected.includes(name);
    const chip = el("button", "chip" + (on ? " on" : ""), name);
    chip.type = "button";
    chip.onclick = () => {
      const next = on ? selected.filter((x) => x !== name) : [...selected, name];
      onChange(next);
    };
    box.append(chip);
  }
  return box;
}

export async function render(container, { notify = () => {} } = {}) {
  container.textContent = "";
  const [issues, others, profiles, sprints, epics, boards] = await Promise.all([
    db.all(db.STORES.issues),
    db.all(db.STORES.others),
    db.all(db.STORES.people),
    db.all(db.STORES.sprints),
    db.all(db.STORES.epics),
    db.all(db.STORES.boards)
  ]);

  const people = collectPeople(issues, others);
  const rows = mergeProfiles(people, profiles);
  container.append(el("p", "hint", t("team.hint")));
  if (!rows.length) {
    container.append(el("div", "empty", t("team.empty")));
    return;
  }

  // Команда (доска) и объёмы — из той же модели, что и «Гант по людям».
  const model = agg.buildModel({ issues, others, sprints, epics, boards, mode: "assignee" });
  const stats = new Map(model.groups.map((g) => [normName(g.label), g]));

  const allSystems = systemsList(rows);
  const roleOptions = ROLES.map((r) => [r, t(`role.${r}`)]);
  const statusOptions = STATUSES.map((st) => [st, t(`pstatus.${st}`)]);

  const table = el("table", "team-table");
  const thead = el("thead");
  const hr = el("tr");
  for (const key of ["#", "team.name", "team.board", "team.issues", "team.role", "team.systems", "team.status", ""]) {
    hr.append(el("th", null, key === "#" || key === "" ? key : t(key)));
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  rows.forEach((row, i) => {
    const tr = el("tr", row.loaded ? "" : "stale");
    tr.append(el("td", "tnum", `${i + 1}.`));

    const nameCell = el("td", "tname");
    nameCell.append(el("div", "tname-main", row.displayName));
    const sub = [row.login, row.loaded ? "" : t("team.notLoaded")].filter(Boolean).join(" · ");
    if (sub) nameCell.append(el("div", "muted small", sub));
    tr.append(nameCell);

    const g = stats.get(row.name);
    tr.append(el("td", null, g && g.team ? g.team.name : t("team.none")));
    const issuesCell = el("td", "tissues");
    if (g) {
      issuesCell.append(el("span", "badge b-count", String(g.count)), el("span", "badge b-sum", fmtEstimate(g.sum)));
      if (g.otherCount) issuesCell.append(el("span", "badge b-other", `+${g.otherCount} · ${fmtEstimate(g.otherSum)}`));
    } else {
      issuesCell.textContent = t("team.none");
    }
    tr.append(issuesCell);

    const save = async (patch) => {
      Object.assign(row, patch);
      await saveProfile(row);
      notify(t("team.saved"));
    };
    const roleCell = el("td");
    roleCell.append(select(roleOptions, row.role, (v) => save({ role: v })));
    tr.append(roleCell);

    const sysCell = el("td", "tsystems");
    const redraw = () => {
      sysCell.textContent = "";
      sysCell.append(
        chips(allSystems, row.systems || [], async (next) => {
          await save({ systems: next });
          redraw();
        })
      );
    };
    redraw();
    tr.append(sysCell);

    const statusCell = el("td");
    statusCell.append(select(statusOptions, row.status, (v) => save({ status: v })));
    tr.append(statusCell);

    const actions = el("td", "tactions");
    if (!row.loaded) {
      const del = el("button", "link", "×");
      del.title = t("team.forget");
      del.onclick = async () => {
        await deleteProfile(row.name);
        render(container, { notify });
      };
      actions.append(del);
    }
    tr.append(actions);
    tbody.append(tr);
  });
  table.append(tbody);

  const wrap = el("div", "team-wrap");
  wrap.append(table);
  container.append(wrap);
}
