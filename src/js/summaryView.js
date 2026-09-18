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
import * as charts from "./trendCharts.js";

const DAY = 86400000;

// Состояние графиков, пока вкладка открыта: какие эпики на графике запаса и какой эпик раскрыт.
const view = { trendKeys: null, expanded: null };

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
  // Автообновление сегодня не удалось из-за недоступности Jira — скорее всего, не включён VPN.
  let unreachableAt = 0;
  try {
    const { autoSyncState = {} } = await chrome.storage.local.get("autoSyncState");
    const today = new Date(now).toDateString();
    if (s.autoSync.enabled && autoSyncState.lastAttempt === "unreachable" && new Date(s.lastSync || 0).toDateString() !== today) {
      unreachableAt = autoSyncState.lastAttemptAt || 0;
    }
  } catch {
    // вне расширения — без состояния автообновления
  }
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
    unreachableAt,
    thresholds: s.summary,
    excludeTypes,
    now
  });
  // «Принято»: отметки исчезнувших сигналов снимаем — вернувшийся сигнал будет новым случаем.
  const rawAcks = (await db.metaGet("acks", {})) || {};
  const acks = summary.pruneAcks(rawAcks, signals);
  if (Object.keys(acks).length !== Object.keys(rawAcks).length) await db.metaSet("acks", acks);
  return { current, base, weekly, signals, acks, lastSync: s.lastSync, lastSyncId, now, epics, unreachableAt };
}

// Счётчик на вкладке (Б7): новые сигналы «внимание» и «критично», не принятые и не показанные
// при прошлом просмотре сводки.
export async function badgeCount() {
  const data = await loadData({ session: { baseSyncId: await db.metaGet("seenSyncId", null) } });
  if (data.empty) return 0;
  return summary.freshCount(data.signals, data.acks, await db.metaGet("seenSignalIds", []), settings.get().summary);
}

async function setAck(sig, on) {
  const acks = (await db.metaGet("acks", {})) || {};
  if (on) acks[sig.id] = { ...summary.ackOf(sig), at: Date.now() };
  else delete acks[sig.id];
  await db.metaSet("acks", acks);
}

// Отчёт для мессенджера и почты (Б7): дата, база, итог по цветам, «Требует внимания» со ссылками.
export function buildReport(data, { format = "md", baseUrl = "", limit = 7 } = {}) {
  const th = settings.get().summary;
  const md = format === "md";
  const lines = [];
  const url = (key) => (baseUrl ? `${baseUrl.replace(/\/+$/, "")}/browse/${key}` : "");
  const title = t("rep.title", { at: fmtDateTime(data.lastSync || data.lastSyncId) });
  lines.push(md ? `**${title}**` : title);
  lines.push(data.base ? t("sum.base", { at: fmtDateTime(data.base.at) }) : t("sum.noBase"));
  const counts = { red: 0, yellow: 0, green: 0, unknown: 0, nodue: 0, done: 0 };
  for (const st of data.current.values()) counts[summary.colorOf(st, th, data.now)] += 1;
  lines.push(
    ["red", "yellow", "green", "unknown", "nodue", "done"]
      .filter((c) => counts[c])
      .map((c) => t(`sum.color.${c}`, { n: counts[c] }))
      .join(" · ")
  );
  lines.push("");
  const active = data.signals.filter((x) => !summary.isAcked(x, data.acks, th));
  const top = summary.attention(active, limit);
  lines.push(md ? `**${t("sum.attention")}**` : `${t("sum.attention")}:`);
  if (!top.length) lines.push(t("sum.calm"));
  for (const sig of top) {
    const mark = sig.severity === "critical" ? t("rep.critical") : t("rep.warning");
    const text = signalText(sig, data.current);
    const link = sig.epicKey ? url(sig.epicKey) : "";
    const label = epicLabel(data.current.get(sig.epicKey)) || sig.epicKey || "";
    if (md) lines.push(`- ${mark} ${link && label && text.includes(label) ? text.replace(label, `[${label}](${link})`) : text}`);
    else lines.push(`— ${mark} ${text}${link ? ` (${link})` : ""}`);
  }
  return lines.join("\n");
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
  if (sig.type === "unreachable") params.at = fmtDateTime(params.at);
  for (const k of Object.keys(params)) {
    if (sig.type === "unreachable") break;
    if (dated && DATE_PARAMS.has(k)) params[k] = fmtDate(params[k]);
    else if (k === "buffer" || (sig.type === "melting" && (k === "from" || k === "to"))) params[k] = fmtWeeks(params[k]);
    else if (typeof params[k] === "number" && !Number.isInteger(params[k])) params[k] = fmtNum(params[k]);
  }
  return t(`sig.${sig.type}`, params);
}

const SEV_ICON = { critical: "●", warning: "▲", info: "·" };

function signalRow(sig, data, onOpenEpic, onRefresh = () => {}) {
  const acked = summary.isAcked(sig, data.acks, settings.get().summary);
  const row = el("div", `sig sig-${sig.severity}${acked ? " acked" : ""}`);
  row.append(el("span", "sig-icon", SEV_ICON[sig.severity]));
  const text = el("span", "sig-text", signalText(sig, data.current));
  row.append(text);
  const ack = el("button", "link sig-ack", acked ? t("sum.unack") : t("sum.ack"));
  ack.type = "button";
  ack.title = acked ? t("sum.unackHint") : t("sum.ackHint");
  ack.onclick = async (e) => {
    e.stopPropagation();
    await setAck(sig, !acked);
    onRefresh();
  };
  row.append(ack);
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

export async function render(container, { mode = "seen", session, onOpenEpic = () => {}, onMode = () => {}, onRefresh = () => {} } = {}) {
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
  if (data.unreachableAt) head.append(el("span", "cmt-error", t("sum.unreachable", { at: fmtDate(new Date(data.lastSync || data.lastSyncId).toISOString()) })));
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
  const copy = el("div", "sum-copy");
  for (const fmt of ["md", "text"]) {
    const b = el("button", null, t(`sum.copy.${fmt}`));
    b.type = "button";
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(buildReport(data, { format: fmt, baseUrl: settings.get().baseUrl, limit: Number(th.attention) || 7 }));
        b.textContent = t("sum.copied");
      } catch {
        b.textContent = t("sum.copyFailed");
      }
      setTimeout(() => (b.textContent = t(`sum.copy.${fmt}`)), 2000);
    };
    copy.append(b);
  }
  head.append(copy);
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
  const active = data.signals.filter((x) => !summary.isAcked(x, data.acks, th));
  const top = summary.attention(active, Number(th.attention) || 7);
  const allImportant = summary.attention(active, Infinity);
  container.append(el("h3", "sum-h", t("sum.attention")));
  const att = el("div", "sum-attention");
  if (!top.length) att.append(el("div", "muted", t("sum.calm")));
  for (const sig of top) att.append(signalRow(sig, data, onOpenEpic, onRefresh));
  if (allImportant.length > top.length) {
    const more = el("button", "link", t("sum.more", { n: allImportant.length - top.length }));
    more.type = "button";
    more.onclick = () => {
      more.remove();
      for (const sig of allImportant.slice(top.length)) att.append(signalRow(sig, data, onOpenEpic, onRefresh));
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
    for (const sig of list) details.append(signalRow(sig, data, onOpenEpic, onRefresh));
    container.append(details);
  }

  // Показанные сигналы больше не «новые» для счётчика на вкладке.
  await db.metaSet("seenSignalIds", active.filter((x) => x.severity !== "info").map((x) => x.id));

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
      view.expanded = view.expanded === st.epicKey ? null : st.epicKey;
      rerenderEpic();
    };
    tbody.append(tr);
    // Раскрытая строка: как менялся прогноз и сделано против объёма (Б6.2, Б6.3).
    const detail = el("tr", "sum-detail");
    detail.dataset.key = st.epicKey;
    const cell = el("td");
    cell.colSpan = 7;
    detail.append(cell);
    tbody.append(detail);
  }
  table.append(tbody);
  wrap.append(table);
  container.append(wrap);

  const rerenderEpic = () => {
    for (const d of tbody.querySelectorAll("tr.sum-detail")) {
      const cell = d.firstChild;
      cell.textContent = "";
      d.hidden = d.dataset.key !== view.expanded;
      if (d.hidden) continue;
      cell.append(epicCharts(d.dataset.key, data, onOpenEpic));
    }
    for (const r of tbody.querySelectorAll("tr.clickable")) r.classList.toggle("open", r.nextSibling?.dataset.key === view.expanded);
  };
  rerenderEpic();

  // Тренд запаса по портфелю (Б6.1): по умолчанию жёлтые и красные эпики, не больше 8 линий.
  container.append(portfolioTrend(data, rows, th));
  return data;
}

function epicCharts(key, data, onOpenEpic) {
  const box = el("div", "sum-epic-charts");
  const points = data.weekly.get(key) || [];
  const head = el("div", "sum-epic-charts-head");
  const open = el("button", "link", t("sum.openCard"));
  open.type = "button";
  open.onclick = (e) => {
    e.stopPropagation();
    onOpenEpic(key, open);
  };
  head.append(open);
  if (points.some((p) => p.restored)) head.append(el("span", "muted small", t("tr.restoredHint")));
  box.append(head);
  const fc = charts.forecastChart(points);
  box.append(el("div", "tr-title", t("tr.forecastTitle")));
  if (fc) {
    box.append(charts.legend([
      { label: t("tr.legend.p85"), cls: "sw-p85" },
      { label: t("tr.legend.band"), cls: "sw-band" },
      { label: t("tr.legend.due"), cls: "sw-due" }
    ]));
    box.append(fc);
  } else box.append(el("div", "muted small", t("tr.noData")));
  const bu = charts.burnupChart(points);
  box.append(el("div", "tr-title", t("tr.burnupTitle")));
  if (bu) {
    box.append(charts.legend([
      { label: t("tr.legend.total"), cls: "sw-total" },
      { label: t("tr.legend.done"), cls: "sw-done" }
    ]));
    box.append(bu);
  } else box.append(el("div", "muted small", t("tr.noData")));
  return box;
}

function portfolioTrend(data, rows, th) {
  const box = el("div", "sum-trend-box");
  box.append(el("h3", "sum-h", t("sum.trend")));
  const withHistory = rows.filter((st) => (data.weekly.get(st.epicKey) || []).filter((r) => r.buffer != null).length >= 2);
  if (!withHistory.length) {
    box.append(el("div", "muted small", t("tr.noData")));
    return box;
  }
  if (!view.trendKeys) {
    view.trendKeys = withHistory
      .filter((st) => ["red", "yellow"].includes(summary.colorOf(st, th, data.now)))
      .slice(0, charts.MAX_LINES)
      .map((st) => st.epicKey);
    if (!view.trendKeys.length) view.trendKeys = withHistory.slice(0, 3).map((st) => st.epicKey);
  }
  const draw = () => {
    box.querySelector(".tr-legend")?.remove();
    box.querySelector("svg")?.remove();
    box.querySelector(".tr-empty")?.remove();
    const legendItems = withHistory.map((st) => {
      const on = view.trendKeys.includes(st.epicKey);
      return {
        label: epicLabel(st),
        color: on ? charts.colorFor(st.epicKey) : null,
        off: !on,
        onClick: (e) => {
          e.stopPropagation();
          if (on) view.trendKeys = view.trendKeys.filter((k) => k !== st.epicKey);
          else if (view.trendKeys.length < charts.MAX_LINES) view.trendKeys = [...view.trendKeys, st.epicKey];
          draw();
        }
      };
    });
    box.append(charts.legend(legendItems));
    const svg = charts.bufferChart(charts.bufferSeries(data.weekly, view.trendKeys, (k) => epicLabel(data.current.get(k))));
    if (svg) box.append(svg);
    else box.append(el("div", "muted small tr-empty", t("tr.pick")));
  };
  box.append(el("div", "muted small", t("sum.trendHint", { n: charts.MAX_LINES })));
  draw();
  return box;
}
