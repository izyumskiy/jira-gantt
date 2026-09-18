// Вкладка «Сводка» (Б5): что изменилось, что близко к завершению, где опаздываем, что с ресурсами,
// качество данных и таблица портфеля с трендом запаса до срока. Расчёты — summary.js и analytics.js;
// здесь только чтение истории из базы и отрисовка.
import { t, getLang } from "./i18n.js";
import * as db from "./db.js";
import * as settings from "./settings.js";
import * as agg from "./agg.js";
import * as flowlib from "./flow.js";
import * as analytics from "./analytics.js";
import * as summary from "./summary.js";

const DAY = 86400000;

// ---------- база сравнения ----------

// Отметка просмотра (Б5): номер последней синхронизации, которую пользователь видел в сводке.
// При открытии вкладки база показа = прежняя отметка, а отметка сразу сдвигается на последнюю
// синхронизацию; пока вкладка на экране, отметка сдвигается после каждой синхронизации.
// Событие ухода со страницы не используется — Chrome может выгрузить вкладку.
export async function openSession() {
  const base = await db.metaGet("seenSyncId", null);
  const last = await db.metaGet("lastSyncId", null);
  if (last) await db.metaSet("seenSyncId", last);
  return { baseSyncId: base };
}

export async function markSeen() {
  const last = await db.metaGet("lastSyncId", null);
  if (last) await db.metaSet("seenSyncId", last);
}

async function syncIds() {
  const rows = await db.all(db.STORES.syncLog);
  return [...new Set(rows.map((r) => r.syncId))].sort((a, b) => a - b);
}

// Состояния эпиков на момент базы. mode: "seen" — с последнего просмотра, "week" — за 7 дней.
async function loadBase(mode, session, lastSyncId, now) {
  if (mode === "week") {
    const target = now - 7 * DAY;
    const ids = (await syncIds()).filter((id) => id <= target);
    if (ids.length) {
      const id = ids[ids.length - 1];
      return { states: toMap(await db.allByIndex(db.STORES.syncLog, "syncId", id)), at: id, note: "" };
    }
    const rows = await db.allByIndex(db.STORES.epicWeeks, "week", flowlib.weekKey(target));
    if (rows.length) {
      return { states: toMap(rows), at: flowlib.mondayOf(target), note: rows.some((r) => r.restored) ? t("sum.baseRestored") : "" };
    }
    return null;
  }
  const id = session.baseSyncId;
  if (!id) return null;
  if (id === lastSyncId) return { states: null, at: id, note: "" }; // та же синхронизация — изменений нет
  let rows = await db.allByIndex(db.STORES.syncLog, "syncId", id);
  if (rows.length) return { states: toMap(rows), at: id, note: "" };
  // База старше 30 дней: журнал уже почищен — берём самую старую запись.
  const ids = await syncIds();
  if (!ids.length || ids[0] === lastSyncId) return null;
  rows = await db.allByIndex(db.STORES.syncLog, "syncId", ids[0]);
  return { states: toMap(rows), at: ids[0], note: t("sum.baseOldest") };
}

const toMap = (rows) => new Map(rows.map((r) => [r.epicKey, r]));

// ---------- данные для правил ----------

export async function loadData({ mode = "seen", session = { baseSyncId: null }, now = Date.now() } = {}) {
  const lastSyncId = await db.metaGet("lastSyncId", null);
  if (!lastSyncId) return { empty: true };
  const [currentRows, weekRows, epics, issues, others, flowRows, tempo, profiles, sprints, boards, apiLimited] = await Promise.all([
    db.allByIndex(db.STORES.syncLog, "syncId", lastSyncId),
    db.all(db.STORES.epicWeeks),
    db.all(db.STORES.epics),
    db.all(db.STORES.issues),
    db.all(db.STORES.others),
    db.all(db.STORES.flow),
    db.all(db.STORES.tempo),
    db.all(db.STORES.people),
    db.all(db.STORES.sprints),
    db.all(db.STORES.boards),
    db.metaGet("lastApiLimited", false)
  ]);
  // Только эпики, которые сейчас сохранены: удалённые из выбора живут в истории, но в сводке их нет.
  const stored = new Set(epics.map((e) => e.key));
  const current = new Map(currentRows.filter((r) => stored.has(r.epicKey)).map((r) => [r.epicKey, r]));
  const weekly = new Map();
  for (const r of weekRows.sort((a, b) => a.week.localeCompare(b.week))) {
    if (!stored.has(r.epicKey)) continue;
    if (!weekly.has(r.epicKey)) weekly.set(r.epicKey, []);
    weekly.get(r.epicKey).push(r);
  }
  const base = await loadBase(mode, session, lastSyncId, now);
  const s = settings.get();
  const model = agg.buildModel({ issues, others, sprints, epics, boards, tempo, profiles, mode: "assignee", timelineIssues: [...issues, ...others] });
  const load = analytics.personLoad(model, issues, others);
  const teamOf = analytics.flowTeamOf({ tempo, profiles });
  const sizes = new Map();
  for (const tm of tempo) sizes.set(`t:${tm.id}`, (tm.members || []).length);
  for (const p of profiles) if (p.team) sizes.set(`m:${p.team}`, (sizes.get(`m:${p.team}`) || 0) + 1);
  const excludeTypes = flowlib.parseTypeList(s.forecastExcludeTypes);
  const signals = summary.computeSignals({
    current,
    base: base && base.states,
    weekly,
    issues,
    others,
    flowRows,
    teamOf,
    teamSize: (id) => sizes.get(id) || 0,
    load,
    model,
    profiles,
    lastSync: s.lastSync,
    apiLimited,
    thresholds: s.summary,
    excludeTypes,
    now
  });
  return { current, base, weekly, signals, lastSync: s.lastSync, lastSyncId, now, epics };
}

// ---------- отрисовка ----------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const p2 = (n) => String(n).padStart(2, "0");
function fmtDate(v) {
  if (!v) return t("dash");
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  return Number.isNaN(+d) ? v : `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
// Дробное число с одним знаком: в русском — запятая.
function fmtNum(v) {
  const s = (Math.round(v * 10) / 10).toString();
  return getLang() === "ru" ? s.replace(".", ",") : s;
}

export function fmtWeeks(v) {
  if (v == null) return t("dash");
  const abs = Math.abs(v).toFixed(1);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${getLang() === "ru" ? abs.replace(".", ",") : abs}`;
}

const epicLabel = (st) => (st ? `${st.epicKey} · ${st.epicName || st.summary || ""}`.trim() : "");
const DATE_PARAMS = new Set(["from", "to", "due", "date"]);

// Текст сигнала: шаблон sig.<type>, даты и запас — в человеческом виде.
export function signalText(sig, current) {
  const params = { ...sig.params, epic: epicLabel(current.get(sig.epicKey)) || sig.epicKey || "" };
  const dated = sig.type === "shiftLater" || sig.type === "shiftEarlier" || sig.type === "dueChanged" || sig.type === "overdue" || sig.type === "near";
  for (const k of Object.keys(params)) {
    if (dated && DATE_PARAMS.has(k)) params[k] = fmtDate(params[k]);
    else if (k === "buffer" || (sig.type === "melting" && (k === "from" || k === "to"))) params[k] = fmtWeeks(params[k]);
    else if (typeof params[k] === "number" && !Number.isInteger(params[k])) params[k] = fmtNum(params[k]);
  }
  return t(`sig.${sig.type}`, params);
}

const SEV_ICON = { critical: "●", warning: "▲", info: "·" };

function signalRow(sig, data, onOpenEpic) {
  const row = el("div", `sig sig-${sig.severity}`);
  row.append(el("span", "sig-icon", SEV_ICON[sig.severity]));
  const text = el("span", "sig-text", signalText(sig, data.current));
  row.append(text);
  if (sig.epicKey && data.current.has(sig.epicKey)) {
    row.classList.add("clickable");
    row.title = t("sum.openEpic");
    row.onclick = (e) => {
      e.stopPropagation();
      onOpenEpic(sig.epicKey, row);
    };
  }
  return row;
}

// Мини-график запаса до срока за последние 12 недель; ноль — обещание.
function sparkline(points) {
  const svgNs = "http://www.w3.org/2000/svg";
  const w = 84;
  const h = 22;
  const svg = document.createElementNS(svgNs, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "spark");
  const vals = points.map((r) => r.buffer).filter((v) => v != null);
  if (vals.length < 2) return svg;
  const lo = Math.min(0, ...vals);
  const hi = Math.max(0, ...vals);
  const span = hi - lo || 1;
  const y = (v) => h - 2 - ((v - lo) / span) * (h - 4);
  const zero = document.createElementNS(svgNs, "line");
  zero.setAttribute("x1", "0");
  zero.setAttribute("x2", String(w));
  zero.setAttribute("y1", String(y(0)));
  zero.setAttribute("y2", String(y(0)));
  zero.setAttribute("class", "spark-zero");
  svg.append(zero);
  const usable = points.filter((r) => r.buffer != null);
  const step = w / Math.max(1, usable.length - 1);
  const line = document.createElementNS(svgNs, "polyline");
  line.setAttribute("points", usable.map((r, i) => `${(i * step).toFixed(1)},${y(r.buffer).toFixed(1)}`).join(" "));
  line.setAttribute("class", `spark-line${usable[usable.length - 1].buffer < 0 ? " neg" : ""}`);
  svg.append(line);
  return svg;
}

export async function render(container, { mode = "seen", session, onOpenEpic = () => {}, onMode = () => {} } = {}) {
  const data = await loadData({ mode, session });
  container.textContent = "";
  if (data.empty) {
    container.append(el("div", "empty", t("sum.empty")));
    return data;
  }
  const th = settings.get().summary;

  // 1. Шапка: когда обновлено, с чем сравниваем, переключатель базы.
  const head = el("div", "sum-head");
  head.append(el("span", "muted", t("sum.updated", { at: fmtDateTime(data.lastSync || data.lastSyncId) })));
  const baseText = data.base
    ? t("sum.base", { at: fmtDateTime(data.base.at) }) + (data.base.note ? ` · ${data.base.note}` : "")
    : t("sum.noBase");
  head.append(el("span", "muted", baseText));
  const modes = el("div", "chips sum-modes");
  for (const m of ["seen", "week"]) {
    const chip = el("button", "chip" + (m === mode ? " on" : ""), t(`sum.mode.${m}`));
    chip.type = "button";
    chip.onclick = () => onMode(m);
    modes.append(chip);
  }
  head.append(modes);
  container.append(head);

  // 2. Итог по цветам.
  const counts = { green: 0, yellow: 0, red: 0, nodue: 0, unknown: 0, done: 0 };
  for (const st of data.current.values()) counts[summary.colorOf(st, th, data.now)] += 1;
  const totals = el("div", "sum-totals");
  for (const c of ["red", "yellow", "green", "unknown", "nodue", "done"]) {
    if (!counts[c]) continue;
    const item = el("span", `sum-total c-${c}`);
    item.append(el("i", `dot-status c-${c}`), document.createTextNode(t(`sum.color.${c}`, { n: counts[c] })));
    totals.append(item);
  }
  container.append(totals);

  // 3. Требует внимания.
  const top = summary.attention(data.signals, Number(th.attention) || 7);
  const allImportant = summary.attention(data.signals, Infinity);
  container.append(el("h3", "sum-h", t("sum.attention")));
  const att = el("div", "sum-attention");
  if (!top.length) att.append(el("div", "muted", t("sum.calm")));
  for (const sig of top) att.append(signalRow(sig, data, onOpenEpic));
  if (allImportant.length > top.length) {
    const more = el("button", "link", t("sum.more", { n: allImportant.length - top.length }));
    more.type = "button";
    more.onclick = () => {
      more.remove();
      for (const sig of allImportant.slice(top.length)) att.append(signalRow(sig, data, onOpenEpic));
    };
    att.append(more);
  }
  container.append(att);

  // 4. Блоки по группам — свёрнуты, в заголовке число сигналов.
  for (const group of summary.GROUPS) {
    const list = data.signals
      .filter((s) => s.group === group)
      .sort((a, b) => summary.SEVERITY_ORDER[a.severity] - summary.SEVERITY_ORDER[b.severity] || b.rank - a.rank);
    const details = el("details", `sum-group g-${group}`);
    const sumEl = el("summary", null, t(`sum.group.${group}`, { n: list.length }));
    details.append(sumEl);
    if (!list.length) {
      details.append(el("div", "muted small", group === "changes" && !data.base ? t("sum.noBase") : t("sum.none")));
    }
    for (const sig of list) details.append(signalRow(sig, data, onOpenEpic));
    container.append(details);
  }

  // 5. Таблица портфеля: от худшего запаса; без срока и готовые — внизу.
  container.append(el("h3", "sum-h", t("sum.portfolio")));
  const order = { red: 0, yellow: 1, unknown: 2, green: 3, nodue: 4, done: 5 };
  // Сначала эпики с запасом — от худшего; дальше без прогноза, без срока и готовые.
  const sortKey = (st) => {
    const c = summary.colorOf(st, th, data.now);
    return st.buffer != null && c !== "done" && c !== "nodue" ? [0, st.buffer] : [1 + order[c], 0];
  };
  const rows = [...data.current.values()].sort((a, b) => {
    const [ga, va] = sortKey(a);
    const [gb, vb] = sortKey(b);
    return ga - gb || va - vb || a.epicKey.localeCompare(b.epicKey, undefined, { numeric: true });
  });
  const wrap = el("div", "sum-table-wrap");
  const table = el("table", "sum-table");
  const hr = el("tr");
  for (const key of ["sum.col.epic", "sum.col.buffer", "sum.col.trend", "sum.col.chance", "sum.col.p85", "sum.col.due", "sum.col.done"]) hr.append(el("th", null, t(key)));
  const thead = el("thead");
  thead.append(hr);
  table.append(thead);
  const tbody = el("tbody");
  for (const st of rows) {
    const color = summary.colorOf(st, th, data.now);
    const tr = el("tr", "clickable");
    const name = el("td", "sum-epic");
    name.append(el("i", `dot-status c-${color}`), document.createTextNode(epicLabel(st)));
    name.title = t(`sum.colorHint.${color}`);
    tr.append(name);
    tr.append(el("td", `tp-num${st.buffer != null && st.buffer < 0 ? " neg" : ""}`, st.buffer == null ? t("dash") : fmtWeeks(st.buffer)));
    const trend = el("td", "sum-trend");
    trend.append(sparkline((data.weekly.get(st.epicKey) || []).slice(-12)));
    tr.append(trend);
    tr.append(el("td", "tp-num", st.chance == null ? t("dash") : `${Math.round(st.chance * 100)}%`));
    tr.append(el("td", "tp-num", fmtDate(st.p85)));
    tr.append(el("td", "tp-num", fmtDate(st.dueDate)));
    tr.append(el("td", "tp-num", `${Math.round(summary.donePct(st))}%`));
    tr.onclick = (e) => {
      e.stopPropagation();
      onOpenEpic(st.epicKey, tr);
    };
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);
  return data;
}
