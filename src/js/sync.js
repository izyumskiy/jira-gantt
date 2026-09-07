// Загрузка данных из Jira в IndexedDB: эпики, их задачи, спринты.
import * as jira from "./jira.js";
import * as db from "./db.js";
import * as settings from "./settings.js";
import { t } from "./i18n.js";

// ---------- определение кастомных полей ----------

export async function detectFields() {
  const list = await jira.fields();
  const find = (pred) => (list.find(pred) || {}).id || "";
  const custom = (suffix) =>
    find((f) => f.schema && typeof f.schema.custom === "string" && f.schema.custom.endsWith(suffix));

  const norm = (v) => String(v || "").trim().toLowerCase();
  const isDateType = (f) => ["date", "datetime"].includes(String(f.schema?.type || ""));
  // Совпадение по имени поля ИЛИ по его JQL-имени (clauseNames) — в JQL поле зовётся «Planned Start».
  const namesOf = (f) => [f.name, ...(f.clauseNames || [])].map(norm);
  const dateFields = list.filter(isDateType).map((f) => ({ id: f.id, name: f.name || f.id }));
  // Поля-пользователи (одиночные и множественные) — для выбора исполнителя/постановщика эпика.
  const isUserType = (f) => ["user"].includes(String(f.schema?.type || "")) || String(f.schema?.items || "") === "user";
  const userFields = list.filter(isUserType).map((f) => ({ id: f.id, name: f.name || f.id }));
  // Плановые даты: сначала среди полей типа «дата» (в Jira бывают одноимённые поля разных типов), потом среди всех.
  const byName = (...names) => {
    const wanted = names.map(norm);
    const hit = (pool) => pool.find((f) => namesOf(f).some((n) => wanted.includes(n)));
    return (hit(list.filter(isDateType)) || hit(list) || {}).id || "";
  };

  const fields = {
    version: FIELDS_VERSION,
    epicLink: custom("gh-epic-link") || find((f) => f.name === "Epic Link"),
    sprint: custom("gh-sprint") || find((f) => f.name === "Sprint"),
    storyPoints: find((f) => f.name === "Story Points" || f.name === "Story point estimate"),
    plannedStart: byName("planned start", "planned start date", "плановое начало", "плановая дата начала", "target start"),
    plannedEnd: byName("planned end", "planned end date", "плановое завершение", "плановая дата завершения", "target end"),
    // Выбор пользователя не сбрасываем: он задаётся вручную в настройках.
    epicAssignee: settings.get().fields.epicAssignee || "assignee",
    epicReporter: settings.get().fields.epicReporter || "reporter"
  };
  await settings.save({ fields, dateFields, userFields });
  return fields;
}

const FIELDS_VERSION = 4;

async function ensureFields() {
  const s = settings.get();
  if (s.fields.epicLink && s.fields.sprint && (s.fields.version || 0) >= FIELDS_VERSION) return s.fields;
  return detectFields();
}

// Поля эпика для списка на вкладке «Поиск эпиков».
function epicFieldList() {
  const f = settings.get().fields;
  return [
    "summary", "project", "status", "updated", "created", "duedate", "labels",
    f.epicAssignee || "assignee", f.epicReporter || "reporter",
    f.plannedStart, f.plannedEnd
  ].filter(Boolean);
}

// Пользователь из поля Jira: объект или (у множественных полей) массив — тогда имена через запятую.
function userOf(v) {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const users = list.filter((u) => u && typeof u === "object");
  return {
    key: users.length ? users[0].key || users[0].name || "" : "",
    name: users.map((u) => u.displayName || u.name || "").filter(Boolean).join(", ")
  };
}

// Дата из Jira: у duedate/кастомных полей — «YYYY-MM-DD», у created — ISO с временем. Храним как есть.
const dateOf = (v) => (typeof v === "string" && v ? v : "");

// ---------- разбор спринтов ----------

// Jira Server отдаёт спринт либо объектом, либо строкой вида
// com.atlassian.greenhopper.service.sprint.Sprint@1f[id=57,state=ACTIVE,name=Sprint 5,startDate=...]
export function parseSprint(raw) {
  if (!raw) return null;
  if (typeof raw === "object") {
    return normSprint({
      id: raw.id,
      name: raw.name,
      state: raw.state,
      startDate: raw.startDate,
      endDate: raw.endDate,
      completeDate: raw.completeDate,
      boardId: raw.originBoardId || raw.boardId
    });
  }
  const inner = String(raw).slice(String(raw).indexOf("[") + 1, String(raw).lastIndexOf("]"));
  const obj = {};
  for (const part of inner.split(/,(?=[a-zA-Z]+=)/)) {
    const i = part.indexOf("=");
    if (i > 0) obj[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  const nn = (v) => (!v || v === "<null>" || v === "null" ? null : v);
  return normSprint({
    id: Number(obj.id),
    name: nn(obj.name),
    state: nn(obj.state),
    startDate: nn(obj.startDate),
    endDate: nn(obj.endDate),
    completeDate: nn(obj.completeDate),
    boardId: obj.rapidViewId ? Number(obj.rapidViewId) : null
  });
}

function normSprint(s) {
  if (!s || !Number.isFinite(Number(s.id))) return null;
  return {
    id: Number(s.id),
    name: s.name || `#${s.id}`,
    state: String(s.state || "").toUpperCase(),
    startDate: s.startDate || null,
    endDate: s.endDate || null,
    completeDate: s.completeDate || null,
    boardId: s.boardId || s.originBoardId || null
  };
}

// Спринт задачи — последний в списке (соглашение Jira: текущий спринт задачи идёт последним).
function issueSprint(value) {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  const parsed = arr.map(parseSprint).filter(Boolean);
  return { current: parsed.length ? parsed[parsed.length - 1] : null, all: parsed };
}

// ---------- маппинг задачи ----------

function mapIssue(issue, fields, epicKeyFallback) {
  const f = issue.fields || {};
  const sp = issueSprint(f[fields.sprint]);
  const assignee = f.assignee || null;
  return {
    key: issue.key,
    id: issue.id,
    summary: f.summary || "",
    epicKey: (fields.epicLink && f[fields.epicLink]) || epicKeyFallback || "",
    projectKey: f.project?.key || "",
    projectName: f.project?.name || f.project?.key || "",
    assigneeKey: assignee ? assignee.key || assignee.name || assignee.accountId || "" : "",
    assigneeLogin: assignee ? assignee.name || "" : "",
    assigneeName: assignee ? assignee.displayName || assignee.name || "" : "",
    statusName: f.status?.name || "",
    statusCategory: f.status?.statusCategory?.key || "",
    typeName: f.issuetype?.name || "",
    updated: f.updated || "",
    originalEstimate: f.timeoriginalestimate ?? null,
    remainingEstimate: f.timeestimate ?? null,
    storyPoints: fields.storyPoints ? f[fields.storyPoints] ?? null : null,
    sprintId: sp.current ? sp.current.id : null,
    sprintName: sp.current ? sp.current.name : "",
    _sprints: sp.all
  };
}

// ---------- поиск эпиков ----------

export async function searchEpics(query) {
  const q = (query || "").trim();
  let jql = "issuetype = Epic";
  if (q) {
    const esc = jira.escapeJql(q);
    const parts = [`summary ~ "${esc}"`];
    if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(q)) parts.push(`key = "${esc}"`);
    jql += ` AND (${parts.join(" OR ")})`;
  }
  jql += " ORDER BY updated DESC";
  await ensureFields();
  const issues = await jira.search(jql, epicFieldList());
  return issues.map(mapEpic);
}

function mapEpic(i) {
  const f = settings.get().fields;
  return {
    key: i.key,
    id: i.id,
    summary: i.fields.summary || "",
    projectKey: i.fields.project?.key || "",
    projectName: i.fields.project?.name || "",
    statusName: i.fields.status?.name || "",
    statusCategory: i.fields.status?.statusCategory?.key || "",
    statusColor: i.fields.status?.statusCategory?.colorName || "",
    created: dateOf(i.fields.created),
    dueDate: dateOf(i.fields.duedate),
    assigneeKey: userOf(i.fields[f.epicAssignee || "assignee"]).key,
    assigneeName: userOf(i.fields[f.epicAssignee || "assignee"]).name,
    reporterName: userOf(i.fields[f.epicReporter || "reporter"]).name,
    labels: Array.isArray(i.fields.labels) ? i.fields.labels.filter(Boolean) : [],
    plannedStart: f.plannedStart ? dateOf(i.fields[f.plannedStart]) : "",
    plannedEnd: f.plannedEnd ? dateOf(i.fields[f.plannedEnd]) : ""
  };
}

// Снятая галочка на «Поиске эпиков»: эпик остаётся в базе, но не показывается на «Ганте по эпикам».
export async function setHidden(hiddenByKey) {
  const epics = await db.all(db.STORES.epics);
  const changed = [];
  for (const e of epics) {
    if (!(e.key in hiddenByKey)) continue;
    const hidden = !!hiddenByKey[e.key];
    if (!!e.hidden !== hidden) changed.push({ ...e, hidden });
  }
  if (changed.length) await db.putAll(db.STORES.epics, changed);
}

// Статусы и названия самих эпиков живут отдельно от их задач — обновляем при каждой синхронизации.
// Локальный флаг hidden при этом сохраняем: из Jira он не приходит.
async function refreshEpics(keys) {
  const fresh = [];
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const issues = await jira.search(`key in (${chunk.join(",")})`, epicFieldList());
    fresh.push(...issues.map(mapEpic));
  }
  if (!fresh.length) return;
  const existing = new Map((await db.all(db.STORES.epics)).map((e) => [e.key, e]));
  await db.putAll(db.STORES.epics, fresh.map((e) => ({ ...e, hidden: !!existing.get(e.key)?.hidden })));
}

// ---------- выбор эпиков ----------

export async function selectedEpics() {
  return db.all(db.STORES.epics);
}

export async function saveSelection(epics) {
  const keep = new Set(epics.map((e) => e.key));
  const old = await db.all(db.STORES.epics);
  await db.delKeys(
    db.STORES.epics,
    old.filter((e) => !keep.has(e.key)).map((e) => e.key)
  );
  // Сохранённый выбор — значит эпик отмечен: снимаем «скрыт», если он был.
  await db.putAll(db.STORES.epics, epics.map((e) => ({ ...e, hidden: false })));
  await db.clear(db.STORES.others);
  // Задачи снятых эпиков больше не нужны.
  const issues = await db.all(db.STORES.issues);
  await db.delKeys(
    db.STORES.issues,
    issues.filter((i) => !keep.has(i.epicKey)).map((i) => i.key)
  );
}

// ---------- задачи людей вне целевых эпиков ----------

// Для каждого исполнителя из целевых эпиков берём ВСЕ его задачи в текущем и будущих спринтах,
// не относящиеся к целевым эпикам, — чтобы видеть полную загрузку человека. Это снимок:
// при каждой синхронизации он собирается заново.
async function loadOthers({ collected, full, fields, fieldList, epicKeys, onProgress }) {
  const logins = new Set(collected.map((i) => i.assigneeLogin).filter(Boolean));
  if (!full) for (const i of await db.all(db.STORES.issues)) if (i.assigneeLogin) logins.add(i.assigneeLogin);
  const list = [...logins];
  if (!list.length) return [];

  const cf = `cf[${jira.cfId(fields.epicLink)}]`;
  const notTarget = epicKeys.length ? ` AND (${cf} not in (${epicKeys.join(",")}) OR ${cf} is EMPTY)` : "";
  const targetKeys = new Set(epicKeys);
  const out = [];
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25).map((l) => `"${jira.escapeJql(l)}"`).join(",");
    const jql =
      `assignee in (${chunk}) AND (sprint in openSprints() OR sprint in futureSprints())${notTarget} ORDER BY key ASC`;
    const issues = await jira.search(jql, fieldList, (n) => onProgress(t("st.othersLoading", { n: out.length + n })));
    for (const it of issues) {
      const m = mapIssue(it, fields);
      if (!targetKeys.has(m.epicKey)) out.push(m);
    }
  }

  // Названия «прочих» эпиков — для подсказки по человеку.
  const otherEpicKeys = [...new Set(out.map((i) => i.epicKey).filter(Boolean))];
  const summaries = new Map();
  for (let i = 0; i < otherEpicKeys.length; i += 50) {
    const chunk = otherEpicKeys.slice(i, i + 50);
    for (const e of await jira.search(`key in (${chunk.join(",")})`, ["summary"])) summaries.set(e.key, e.fields.summary || "");
  }
  for (const it of out) it.epicSummary = summaries.get(it.epicKey) || "";
  return out;
}

// ---------- обновление спринтов ----------

// Смена дат спринта в Jira не меняет `updated` у задач, поэтому спринты перечитываем всегда:
// сначала целиком доски (там видны и новые спринты без задач), затем поштучно те незакрытые,
// до которых доска не дотянулась.
// Даты из названия спринта — запасной вариант, когда в Jira они не заполнены.
// Понимает «… [08.10 - 21.10]», «… [08.10.2026 - 21.10.2026]», «08.10–21.10»; год — из названия
// (первое 20xx) или текущий; если конец раньше начала — переход через Новый год.
export function datesFromName(name, now = new Date()) {
  const m = String(name || "").match(/(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\s*[-–—]\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?/);
  if (!m) return null;
  const yearInName = (String(name).match(/\b(20\d{2})\b/) || [])[1];
  const y1 = Number(m[3] || yearInName || now.getFullYear());
  let y2 = Number(m[6] || yearInName || y1);
  const mk = (y, mo, d) => new Date(y, mo - 1, d, 0, 0, 0, 0);
  let start = mk(y1, Number(m[2]), Number(m[1]));
  let end = mk(y2, Number(m[5]), Number(m[4]));
  if (Number.isNaN(+start) || Number.isNaN(+end)) return null;
  if (end < start) {
    y2 += 1;
    end = mk(y2, Number(m[5]), Number(m[4]));
  }
  end.setHours(23, 59, 59, 0);
  return { startDate: toLocalIso(start), endDate: toLocalIso(end) };
}

// ISO с локальным смещением («2026-10-08T00:00:00.000+03:00»), как отдаёт Jira; toISOString()
// перевёл бы полночь в UTC и сдвинул дату на день назад.
function toLocalIso(d) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000` +
    `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  );
}

// Обновление спринтов. Возвращает сводку — она уходит в строку статуса, чтобы было видно,
// что именно перечитано и почему у спринта нет дат.
async function refreshSprints(sprintMap) {
  const stats = { boardsOk: 0, boardsFailed: [], agileOk: 0, agileFailed: 0, fromName: 0, withDates: 0, noDates: 0 };
  const boardIds = new Set();
  if (settings.get().boardId) boardIds.add(String(settings.get().boardId));
  for (const s of sprintMap.values()) if (s.boardId) boardIds.add(String(s.boardId));

  for (const boardId of boardIds) {
    try {
      for (const raw of await jira.boardSprints(boardId)) {
        const n = normSprint(raw);
        if (!n) continue;
        sprintMap.set(n.id, { ...n, boardId: n.boardId || Number(boardId), source: "board" });
      }
      stats.boardsOk += 1;
    } catch (e) {
      // Kanban-доска спринтов не отдаёт, а на чужую может не быть прав — добьём поштучно.
      stats.boardsFailed.push(`#${boardId}: ${e && e.message ? e.message : e}`);
      console.warn("[OhMyGant] board sprints failed", boardId, e);
    }
  }

  // Поштучно — все незакрытые спринты без дат (в т.ч. отданные доской без дат) и те, до которых
  // доска не дотянулась. Смена дат в Jira не меняет задачи, поэтому это единственный надёжный путь.
  const stale = [...sprintMap.values()].filter((s) => s.state !== "CLOSED" && (!s.startDate || s.source !== "board"));
  for (let i = 0; i < stale.length; i += 5) {
    await Promise.all(
      stale.slice(i, i + 5).map(async (s) => {
        try {
          const n = normSprint(await jira.sprint(s.id));
          if (n) {
            sprintMap.set(n.id, { ...n, boardId: n.boardId || s.boardId || null, source: "agile" });
            stats.agileOk += 1;
          }
        } catch (e) {
          stats.agileFailed += 1;
          console.warn("[OhMyGant] sprint refresh failed", s.id, s.name, e);
        }
      })
    );
  }

  // Запасной вариант: даты из названия спринта.
  for (const s of sprintMap.values()) {
    if (!s.startDate) {
      const parsed = datesFromName(s.name);
      if (parsed) {
        sprintMap.set(s.id, { ...s, ...parsed, dateSource: "name" });
        stats.fromName += 1;
      }
    }
  }
  for (const s of sprintMap.values()) {
    if (s.state === "CLOSED") continue;
    s.startDate ? (stats.withDates += 1) : (stats.noDates += 1);
  }
  return stats;
}

// ---------- синхронизация ----------

function jqlDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// full = true — скачиваем задачи целиком, иначе только изменённые с прошлой синхронизации.
export async function sync({ full = false, onProgress = () => {} } = {}) {
  const fields = await ensureFields();
  if (!fields.epicLink) throw new jira.JiraError(t("err.noEpicField"), 0);

  const epics = await db.all(db.STORES.epics);
  if (!epics.length) return { issues: 0, sprints: 0 };

  const since = full ? 0 : settings.get().lastSync || 0;
  const fieldList = [
    "summary",
    "project",
    "assignee",
    "status",
    "issuetype",
    "updated",
    "timeoriginalestimate",
    "timeestimate",
    fields.epicLink,
    fields.sprint
  ];
  if (fields.storyPoints) fieldList.push(fields.storyPoints);

  const keys = epics.map((e) => e.key);
  const collected = [];
  // JQL режем на пачки, чтобы не упереться в лимит длины запроса.
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    let jql = `cf[${jira.cfId(fields.epicLink)}] in (${chunk.join(",")})`;
    if (since) jql += ` AND updated >= "${jqlDate(since)}"`;
    jql += " ORDER BY key ASC";
    let issues;
    try {
      issues = await jira.search(jql, fieldList, (n) => onProgress(t("st.issuesLoading", { n: collected.length + n })));
    } catch (e) {
      // Запасной вариант — обращение к полю по имени.
      let alt = `"Epic Link" in (${chunk.join(",")})`;
      if (since) alt += ` AND updated >= "${jqlDate(since)}"`;
      alt += " ORDER BY key ASC";
      issues = await jira.search(alt, fieldList, (n) => onProgress(t("st.issuesLoading", { n: collected.length + n })));
    }
    collected.push(...issues.map((it) => mapIssue(it, fields)));
  }

  if (full) {
    // Полная перезагрузка: старые задачи выбранных эпиков выкидываем.
    const existing = await db.all(db.STORES.issues);
    await db.delKeys(db.STORES.issues, existing.map((i) => i.key));
  }

  // Спринты из задач — основа; ниже их перекроют свежие данные из Agile API.
  const sprintMap = new Map();
  for (const issue of collected) {
    for (const s of issue._sprints || []) sprintMap.set(s.id, { ...s, source: "issue" });
    delete issue._sprints;
  }
  // Инкрементальный синк тянет только изменённые задачи, поэтому уже сохранённые спринты
  // берём из базы: их даты тоже надо обновить, хотя задачи в них могли не меняться.
  if (!full) {
    for (const s of await db.all(db.STORES.sprints)) if (!sprintMap.has(s.id)) sprintMap.set(s.id, s);
  }

  // Задачи людей вне целевых эпиков. Ошибка здесь не должна ронять основную загрузку:
  // сообщаем о ней отдельно, а старый снимок оставляем.
  let others = [];
  let othersError = "";
  try {
    others = await loadOthers({ collected, full, fields, fieldList, epicKeys: keys, onProgress });
    for (const issue of others) {
      for (const s of issue._sprints || []) if (!sprintMap.has(s.id)) sprintMap.set(s.id, { ...s, source: "issue" });
      delete issue._sprints;
    }
  } catch (e) {
    othersError = t("err.others", { msg: e && e.message ? e.message : String(e) });
  }

  try {
    await refreshEpics(keys);
  } catch {
    // Статус эпика — украшение: если запрос не прошёл, оставляем сохранённые данные.
  }

  onProgress(t("st.sprintsLoading"));
  const sprintStats = await refreshSprints(sprintMap);

  // Доски нужны, чтобы назвать команду спринта; без них команда подпишется как «#id».
  try {
    const boards = await jira.boards();
    await db.putAll(
      db.STORES.boards,
      boards.map((b) => ({ id: Number(b.id), name: b.name || `#${b.id}`, type: b.type || "" }))
    );
  } catch {
    // Agile API может быть недоступен — команды останутся безымянными.
  }

  await db.putAll(db.STORES.issues, collected);
  if (!othersError) {
    await db.clear(db.STORES.others);
    await db.putAll(db.STORES.others, others);
  }
  await db.putAll(db.STORES.sprints, [...sprintMap.values()]);
  await settings.save({ lastSync: Date.now() });
  onProgress(t("st.done"));
  return { issues: collected.length, sprints: sprintMap.size, others: others.length, othersError, sprintStats };
}
