// Выгрузка проекта в Excel с ракурса «Эпик — история»: строка на сотрудника каждого эпика,
// списанные часы по месяцам. Формат — CSV с BOM и разделителем «;»: Excel открывает его двойным
// щелчком, а писать zip-архив .xlsx ради таблицы из полутора десятков колонок незачем.
//
// Логика (сборка строк и CSV) — без DOM и сети, её проверяет самопроверка. Запросы к Jira идут
// через api: самопроверка подменяет его заглушкой.
import { t } from "./i18n.js";
import * as jira from "./jira.js";
import { normName } from "./team.js";

export const api = {
  search: (jql, fields) => jira.search(jql, fields),
  worklogs: (key) => jira.worklogs(key)
};

const SEC_IN_HOUR = 3600;
const p2 = (n) => String(n).padStart(2, "0");

// Месяц списания — «ГГГГ-ММ» по местному времени (как его видит менеджер в Jira).
export function monthKey(started) {
  const d = new Date(started);
  return Number.isNaN(+d) ? "" : `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

export const monthTitle = (key) => `${key.slice(5)}.${key.slice(0, 4)}`;

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(+d) ? "" : `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

const personOf = (w) => w.author || w.updateAuthor || {};

// Ворклог Jira → плоская запись. epicKey — чей это эпик (задача или сам эпик).
const mapLog = (issueKey, epicKey, w) => ({
  issueKey,
  epicKey,
  name: personOf(w).displayName || personOf(w).name || "",
  login: personOf(w).name || "",
  started: w.started || "",
  seconds: Number(w.timeSpentSeconds) || 0
});

// Списания по задачам. Сначала пачками через поиск (одно обращение на 100 задач), и только у тех,
// у кого Jira отдала список не целиком (их больше 20) или пачка не прошла, — поштучно.
export async function fetchWorklogs(epicOfKey, { onProgress = () => {} } = {}) {
  const keys = [...epicOfKey.keys()];
  const out = [];
  const rest = [];
  let done = 0;
  const tick = () => onProgress(Math.min(done, keys.length), keys.length);
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    let rows = null;
    try {
      rows = await api.search(`key in (${chunk.join(",")})`, ["worklog"]);
    } catch {
      rest.push(...chunk); // пачка не прошла (например, задачу удалили) — дочитаем поштучно
    }
    for (const it of rows || []) {
      const w = (it.fields && it.fields.worklog) || {};
      const list = Array.isArray(w.worklogs) ? w.worklogs : [];
      if (Number(w.total || list.length) > list.length) rest.push(it.key);
      else out.push(...list.map((x) => mapLog(it.key, epicOfKey.get(it.key) || "", x)));
    }
    done += chunk.length;
    tick();
  }
  for (let i = 0; i < rest.length; i += 5) {
    const part = rest.slice(i, i + 5);
    const pages = await Promise.all(part.map((k) => api.worklogs(k).catch(() => [])));
    pages.forEach((rows, n) => out.push(...rows.map((x) => mapLog(part[n], epicOfKey.get(part[n]) || "", x))));
    done += part.length;
    tick();
  }
  return out;
}

// Строки выгрузки: эпик × сотрудник. Сотрудник — исполнитель задач эпика или автор списания:
// человек с часами виден, даже если задачи на него не назначены, а исполнитель без часов — с нулями.
// У эпика без таких людей остаётся одна строка с пустым сотрудником, чтобы эпик не пропал.
export function buildExport({ epics, issuesByEpic = new Map(), logs = [], profiles = [] }) {
  const roleOf = new Map(profiles.filter((p) => p.role).map((p) => [p.name, p.role]));
  const months = new Set();
  const byEpic = new Map(epics.map((e) => [e.key, new Map()]));
  const person = (epicKey, name) => {
    const bag = byEpic.get(epicKey);
    if (!bag) return null;
    const id = normName(name);
    if (!bag.has(id)) bag.set(id, { id, name: String(name || "").trim(), hours: new Map(), total: 0 });
    return bag.get(id);
  };
  for (const e of epics) for (const i of issuesByEpic.get(e.key) || []) if (i.assigneeName) person(e.key, i.assigneeName);
  for (const w of logs) {
    const p = w.name && person(w.epicKey, w.name);
    if (!p) continue;
    const m = monthKey(w.started);
    if (!m) continue;
    months.add(m);
    p.hours.set(m, (p.hours.get(m) || 0) + w.seconds);
    p.total += w.seconds;
  }
  const cols = [...months].sort();
  const hours = (sec) => Math.round((sec / SEC_IN_HOUR) * 10) / 10;
  const rows = [];
  for (const e of epics) {
    const people = [...byEpic.get(e.key).values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    const head = [
      e.key,
      e.epicName || e.summary || "",
      fmtDate(e.plannedStart || e.created || ""),
      fmtDate(e.dueDate || e.plannedEnd || "")
    ];
    if (!people.length) rows.push([...head, "", "", ...cols.map(() => 0), 0]);
    for (const p of people) {
      rows.push([...head, p.name, roleOf.has(p.id) ? t(`role.${roleOf.get(p.id)}`) : "", ...cols.map((m) => hours(p.hours.get(m) || 0)), hours(p.total)]);
    }
  }
  const header = [t("xls.epicKey"), t("xls.epicName"), t("xls.start"), t("xls.end"), t("xls.person"), t("xls.role"), ...cols.map(monthTitle), t("xls.total")];
  return { header, rows, months: cols };
}

// CSV для Excel: BOM, разделитель «;», дробные — с запятой (так Excel с русской локалью читает
// файл без мастера импорта).
export function toCsv({ header, rows }, { decimal = "," } = {}) {
  const cell = (v) => {
    if (typeof v === "number") return String(v).replace(".", decimal);
    const s = String(v ?? "");
    return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n")}\r\n`;
}

// Имя файла: латиница и цифры из названия проекта плюс дата.
export function fileName(projectName, now = new Date()) {
  const base = String(projectName || "")
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `ohmygant-${base || "project"}-${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}.csv`;
}
