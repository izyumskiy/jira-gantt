// Предварительная конфигурация: импорт JSON (поля, информационные системы, эпики, сотрудники)
// и экспорт текущего состояния в тот же формат.
//
// Формат файла:
// {
//   "version": 1,
//   "baseUrl":     "https://jira.company.local",
//   "fields":      { "plannedStart": "customfield_10407", "plannedEnd": "Planned End",
//                    "epicAssignee": "assignee", "epicReporter": "reporter" },
//   "infoSystems": ["1С CRM", "..."],
//   "epics":       ["PRJ-1", "PRJ-2"],
//   "people":      [{ "name": "Иван Ёлкин", "role": "developer", "status": "staff", "systems": ["1С CRM"] }]
// }
// Поле можно задать id (customfield_NNN / assignee / reporter / creator) или названием — тогда id
// ищется в Jira по имени и JQL-имени. Роль — id (developer, frontend, backend, onec, qa, analytic,
// teamlead, support, pm, devops, sysadm) или подпись (Developer, 1C dev, …); статус — staff /
// outstaff / fired или «Штатный сотрудник» / «Аутстаф» / «Уволен».
import { t } from "./i18n.js";
import * as settings from "./settings.js";
import * as db from "./db.js";
import * as jira from "./jira.js";
import * as sync from "./sync.js";
import { ROLES, STATUSES, normName, parseSystems, mergeProfiles, collectPeople } from "./team.js";

export const CONFIG_VERSION = 1;
const FIELD_KEYS = ["plannedStart", "plannedEnd", "epicAssignee", "epicReporter"];
const STANDARD_FIELDS = new Set(["assignee", "reporter", "creator", "duedate", "created"]);

export function parseConfig(text) {
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    throw new Error(t("cfg.badJson", { msg: e.message }));
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(t("cfg.badJson", { msg: "object expected" }));
  return {
    baseUrl: String(cfg.baseUrl || cfg.jiraUrl || "").trim().replace(/\/+$/, ""),
    fields: cfg.fields && typeof cfg.fields === "object" ? cfg.fields : {},
    infoSystems: Array.isArray(cfg.infoSystems) ? cfg.infoSystems : typeof cfg.infoSystems === "string" ? parseSystems(cfg.infoSystems) : [],
    epics: Array.isArray(cfg.epics) ? cfg.epics.map((k) => String(k).trim()).filter(Boolean) : [],
    people: Array.isArray(cfg.people) ? cfg.people.filter((p) => p && typeof p === "object" && p.name) : []
  };
}

// Роль/статус: принимаем id или подпись на любом языке, без учёта регистра.
function roleId(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  for (const id of ROLES) if (id === s || t(`role.${id}`).toLowerCase() === s) return id;
  const aliases = { "1с dev": "onec", "1c": "onec", "1с": "onec", dev: "developer", "team lead": "teamlead", "project manager": "pm" };
  return aliases[s] || null;
}
const STATUS_ALIASES = { staff: "staff", "штатный сотрудник": "staff", штатный: "staff", outstaff: "outstaff", аутстаф: "outstaff", fired: "fired", уволен: "fired", left: "fired" };
function statusId(v) {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  if (STATUSES.includes(s)) return s;
  for (const st of STATUSES) if (t(`pstatus.${st}`).toLowerCase() === s) return st;
  return STATUS_ALIASES[s] ?? null;
}

// id поля из значения конфига: id как есть, название — через список полей Jira.
async function resolveField(value, fieldListPromise) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (/^customfield_\d+$/i.test(v) || STANDARD_FIELDS.has(v.toLowerCase())) return v.toLowerCase().startsWith("customfield") ? v : v.toLowerCase();
  const list = await fieldListPromise();
  const norm = (x) => String(x || "").trim().toLowerCase();
  const hit = list.find((f) => [f.name, ...(f.clauseNames || [])].map(norm).includes(norm(v)));
  if (!hit) throw new Error(t("cfg.fieldNotFound", { name: v }));
  return hit.id;
}

// Применение конфигурации. Возвращает журнал строк и список ключей эпиков для выгрузки.
export async function applyConfig(cfg, { onLog = () => {} } = {}) {
  const log = (m) => onLog(m);
  let fieldsCache = null;
  const fieldList = async () => (fieldsCache ||= await jira.fields());

  // 1. Поля и справочник систем.
  const fields = {};
  for (const key of FIELD_KEYS) {
    if (!(key in cfg.fields)) continue;
    try {
      fields[key] = await resolveField(cfg.fields[key], fieldList);
      log(t("cfg.fieldSet", { key, id: fields[key] || t("dash") }));
    } catch (e) {
      log(t("cfg.error", { msg: e.message }));
    }
  }
  const systems = [...new Set([...(settings.get().infoSystems || []), ...cfg.infoSystems.map((x) => String(x).trim()).filter(Boolean)])];
  await settings.save({ fields, infoSystems: systems });
  if (cfg.infoSystems.length) log(t("cfg.systemsSet", { n: cfg.infoSystems.length, total: systems.length }));

  // 2. Эпики: находим в Jira и добавляем к сохранённым.
  let addedEpics = [];
  if (cfg.epics.length) {
    try {
      const found = await sync.fetchEpics(cfg.epics);
      const foundKeys = new Set(found.map((e) => e.key));
      const missing = cfg.epics.filter((k) => !foundKeys.has(k.toUpperCase()) && !foundKeys.has(k));
      const stored = await sync.selectedEpics();
      const byKey = new Map(stored.map((e) => [e.key, e]));
      for (const e of found) byKey.set(e.key, { ...(byKey.get(e.key) || {}), ...e, hidden: false });
      await sync.saveSelection([...byKey.values()]);
      addedEpics = found.map((e) => e.key);
      log(t("cfg.epicsSaved", { n: found.length }));
      if (missing.length) log(t("cfg.epicsMissing", { list: missing.join(", ") }));
    } catch (e) {
      log(t("cfg.error", { msg: e.message }));
    }
  }

  // 3. Сотрудники: роль, статус, системы — по имени; неизвестные системы попадают в справочник.
  if (cfg.people.length) {
    const profiles = await db.all(db.STORES.people);
    const byName = new Map(profiles.map((p) => [p.name, p]));
    const extraSystems = new Set(systems);
    let applied = 0;
    for (const p of cfg.people) {
      const name = normName(p.name);
      const cur = byName.get(name) || { name, displayName: String(p.name).trim(), login: "", key: "", role: "", systems: [], status: "" };
      const role = p.role !== undefined ? roleId(p.role) : cur.role;
      const status = p.status !== undefined ? statusId(p.status) : cur.status;
      if (role === null) log(t("cfg.badRole", { name: p.name, role: p.role }));
      if (status === null) log(t("cfg.badStatus", { name: p.name, status: p.status }));
      const sys = Array.isArray(p.systems) ? p.systems.map((x) => String(x).trim()).filter(Boolean) : typeof p.systems === "string" ? parseSystems(p.systems) : cur.systems;
      sys.forEach((x) => extraSystems.add(x));
      const rec = { ...cur, role: role || "", status: status || "", systems: sys, updatedAt: Date.now() };
      if (p.login) rec.login = String(p.login);
      byName.set(name, rec);
      applied += 1;
    }
    await db.putAll(db.STORES.people, [...byName.values()]);
    if (extraSystems.size !== systems.length) await settings.save({ infoSystems: [...extraSystems] });
    log(t("cfg.peopleSaved", { n: applied }));
  }
  return { addedEpics };
}

// Экспорт текущего состояния в формат конфига.
export async function exportConfig() {
  const s = settings.get();
  const [epics, issues, others, profiles] = await Promise.all([
    db.all(db.STORES.epics),
    db.all(db.STORES.issues),
    db.all(db.STORES.others),
    db.all(db.STORES.people)
  ]);
  const rows = mergeProfiles(collectPeople(issues, others), profiles);
  return {
    version: CONFIG_VERSION,
    baseUrl: s.baseUrl || "",
    fields: {
      plannedStart: s.fields.plannedStart || "",
      plannedEnd: s.fields.plannedEnd || "",
      epicAssignee: s.fields.epicAssignee || "assignee",
      epicReporter: s.fields.epicReporter || "reporter"
    },
    infoSystems: s.infoSystems || [],
    epics: epics.map((e) => e.key),
    people: rows.map((r) => ({ name: r.displayName, login: r.login || "", role: r.role || "", status: r.status || "", systems: r.systems || [] }))
  };
}
