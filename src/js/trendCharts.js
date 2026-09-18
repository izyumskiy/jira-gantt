// Графики тренда «Сводки» (Б6): запас до срока по портфелю, прогноз эпика во времени, сделано
// против объёма. Собственный SVG (внешние библиотеки в MV3 не подключаем). Одна точка — одна
// недельная запись; восстановленный участок бледнее, ориентировочные недели — пунктиром.
import { t, getLang } from "./i18n.js";

const DAY = 86400000;
const SVG = "http://www.w3.org/2000/svg";
export const MAX_LINES = 8;
// Категориальная палитра: порядок фиксирован, цвет следует за эпиком, а не за местом в списке.
export const PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

// ---------- подготовка данных (без DOM) ----------

const dayMs = (iso) => (iso ? Date.parse(iso.length === 10 ? `${iso}T00:00:00` : iso) : NaN);

// Недели, в которые срок исполнения отличается от предыдущей записи: «срок перенесли».
export function dueChanges(points) {
  const out = new Set();
  for (let i = 1; i < points.length; i++) {
    if ((points[i].dueDate || "") !== (points[i - 1].dueDate || "") && points[i].dueDate && points[i - 1].dueDate) out.add(points[i].week);
  }
  return out;
}

// Первая неделя, с которой прогноз 85% позже срока исполнения (до этого был не позже).
export function crossingWeek(points) {
  let wasOk = false;
  for (const p of points) {
    if (!p.p85 || !p.dueDate) continue;
    const late = dayMs(p.p85) > dayMs(p.dueDate);
    if (!late) wasOk = true;
    else if (wasOk) return p.week;
  }
  return null;
}

// Цвет эпика — по хешу ключа: при фильтрации и смене набора линий цвет не «перекрашивается».
export function colorFor(key) {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

// Серии запаса для портфеля: не больше MAX_LINES.
export function bufferSeries(weekly, keys, labelOf) {
  return keys.slice(0, MAX_LINES).map((key) => {
    const points = (weekly.get(key) || []).filter((r) => r.buffer != null);
    return { key, label: labelOf(key), color: colorFor(key), points, dueChanged: dueChanges(weekly.get(key) || []) };
  });
}

// «Круглый» шаг делений оси: 1, 2, 5, 10, 20, 50… — чтобы деления проходили через ноль.
export function niceStep(span, target = 5) {
  const raw = Math.max(span / target, 1e-9);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

// Деления от lo до hi кратные шагу (ноль попадает всегда, если он в диапазоне).
export function niceTicks(lo, hi, target = 5) {
  const step = niceStep(hi - lo, target);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

// ---------- отрисовка ----------

function node(tag, attrs = {}, text = null) {
  const n = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text != null) n.textContent = text;
  return n;
}

const p2 = (n) => String(n).padStart(2, "0");
const fmtDay = (ms) => {
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}`;
};
const fmtDate = (ms) => {
  const d = new Date(ms);
  return `${p2(d.getDate())}.${p2(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
};
const fmtNum = (v) => {
  const s = (Math.round(v * 10) / 10).toString();
  return getLang() === "ru" ? s.replace(".", ",") : s;
};
const fmtWeeks = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtNum(Math.abs(v))}`;

// Каркас графика: область, ось недель, горизонтальная сетка. y — функции масштаба снаружи.
function frame({ weeks, yTicks, yLabel, height = 220 }) {
  const W = 760;
  const H = height;
  const m = { l: 56, r: 12, t: yLabel ? 22 : 12, b: 26 };
  const svg = node("svg", { viewBox: `0 0 ${W} ${H}`, class: "trend-svg", role: "img" });
  const x0 = m.l;
  const x1 = W - m.r;
  const y0 = H - m.b;
  const y1 = m.t;
  const xs = weeks.length > 1 ? (x1 - x0) / (weeks.length - 1) : 0;
  const x = (i) => x0 + i * xs;
  for (const tk of yTicks) {
    const yy = tk.y(y0, y1);
    svg.append(node("line", { x1: x0, x2: x1, y1: yy, y2: yy, class: tk.zero ? "tr-zero" : "tr-grid" }));
    svg.append(node("text", { x: x0 - 6, y: yy + 4, class: "tr-tick", "text-anchor": "end" }, tk.label));
  }
  const every = Math.max(1, Math.ceil(weeks.length / 8));
  weeks.forEach((w, i) => {
    if (i % every) return;
    svg.append(node("text", { x: x(i), y: H - 8, class: "tr-tick", "text-anchor": "middle" }, fmtDay(dayMs(w))));
  });
  if (yLabel) svg.append(node("text", { x: 4, y: 11, class: "tr-tick" }, yLabel));
  return { svg, x, y0, y1, x0, x1 };
}

// Ломаная по точкам с учётом восстановленных и ориентировочных участков: каждый отрезок
// рисуется своим стилем по правой точке.
function polyline(svg, pts, cls, color) {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const style = `${cls}${b.restored ? " restored" : ""}${b.approximate ? " approx" : ""}`;
    svg.append(node("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: style, ...(color ? { stroke: color } : {}) }));
  }
}

function dot(svg, p, cls, title, color) {
  const c = node("circle", { cx: p.x, cy: p.y, r: 3, class: `${cls}${p.restored ? " restored" : ""}`, ...(color ? { fill: color } : {}) });
  c.append(node("title", {}, title));
  svg.append(c);
}

function weekAxis(series) {
  const set = new Set();
  for (const s of series) for (const p of s) set.add(p.week);
  return [...set].sort();
}

// 6.1. Портфель: запас до срока во времени; ноль — обещание.
export function bufferChart(series) {
  const weeks = weekAxis(series.map((s) => s.points)).slice(-26);
  if (weeks.length < 2) return null;
  const idx = new Map(weeks.map((w, i) => [w, i]));
  const vals = series.flatMap((s) => s.points.filter((p) => idx.has(p.week)).map((p) => p.buffer));
  const lo = Math.min(0, ...vals) - 0.5;
  const hi = Math.max(0, ...vals) + 0.5;
  const scale = (v) => (y0, y1) => y0 - ((v - lo) / (hi - lo)) * (y0 - y1);
  const ticks = niceTicks(lo, hi).map((v) => ({ y: scale(v), label: v === 0 ? "0" : fmtWeeks(v), zero: v === 0 }));
  const f = frame({ weeks, yTicks: ticks, yLabel: t("tr.bufferAxis") });
  const y = (v) => scale(v)(f.y0, f.y1);
  for (const s of series) {
    const pts = s.points.filter((p) => idx.has(p.week)).map((p) => ({ ...p, x: f.x(idx.get(p.week)), y: y(p.buffer) }));
    polyline(f.svg, pts, "tr-line", s.color);
    pts.forEach((p, i) => {
      const prev = pts[i - 1];
      const delta = prev ? ` (${fmtWeeks(p.buffer - prev.buffer)})` : "";
      dot(f.svg, p, "tr-dot", `${s.label} · ${fmtDate(dayMs(p.week))}: ${t("tr.buffer", { v: fmtWeeks(p.buffer) })}${delta}${p.restored ? ` · ${t("tr.restored")}` : ""}`, s.color);
      if (s.dueChanged.has(p.week)) {
        const mark = node("text", { x: p.x, y: p.y - 7, class: "tr-due-mark", "text-anchor": "middle" }, "⇅");
        mark.append(node("title", {}, t("tr.dueMoved", { d: p.dueDate ? fmtDate(dayMs(p.dueDate)) : "—", week: fmtDate(dayMs(p.week)) })));
        f.svg.append(mark);
      }
    });
  }
  return f.svg;
}

// 6.2. Эпик: как менялся прогноз — коридор 50–85%, линия 85%, срок исполнения ступенькой.
export function forecastChart(points) {
  const pts = points.filter((p) => p.p85);
  const weeks = points.map((p) => p.week);
  if (pts.length < 2) return null;
  const idx = new Map(weeks.map((w, i) => [w, i]));
  const dates = pts.flatMap((p) => [dayMs(p.p50 || p.p85), dayMs(p.p85)]).concat(points.filter((p) => p.dueDate).map((p) => dayMs(p.dueDate)));
  const lo = Math.min(...dates) - 7 * DAY;
  const hi = Math.max(...dates) + 7 * DAY;
  const scale = (v) => (y0, y1) => y0 - ((v - lo) / (hi - lo)) * (y0 - y1);
  const ticks = [];
  const span = hi - lo;
  for (let i = 0; i <= 5; i++) {
    const v = lo + (span * i) / 5;
    ticks.push({ y: scale(v), label: fmtDate(v) });
  }
  const f = frame({ weeks, yTicks: ticks });
  const y = (v) => scale(v)(f.y0, f.y1);
  // коридор 50–85%
  const band = pts.map((p) => `${f.x(idx.get(p.week))},${y(dayMs(p.p85))}`).concat(
    [...pts].reverse().map((p) => `${f.x(idx.get(p.week))},${y(dayMs(p.p50 || p.p85))}`)
  );
  f.svg.append(node("polygon", { points: band.join(" "), class: "tr-band" }));
  // срок исполнения — ступенькой
  const due = points.filter((p) => p.dueDate).map((p) => ({ x: f.x(idx.get(p.week)), y: y(dayMs(p.dueDate)) }));
  if (due.length) {
    let d = `M ${due[0].x} ${due[0].y}`;
    for (let i = 1; i < due.length; i++) d += ` H ${due[i].x} V ${due[i].y}`;
    f.svg.append(node("path", { d, class: "tr-due" }));
  }
  const line = pts.map((p) => ({ ...p, x: f.x(idx.get(p.week)), y: y(dayMs(p.p85)) }));
  polyline(f.svg, line, "tr-line tr-p85");
  line.forEach((p, i) => {
    const prev = line[i - 1];
    const shift = prev ? Math.round((dayMs(p.p85) - dayMs(prev.p85)) / DAY) : 0;
    const tail = prev && shift ? ` (${shift > 0 ? "+" : "−"}${Math.abs(shift)} ${t("tr.days")})` : "";
    dot(f.svg, p, "tr-dot tr-p85", `${fmtDate(dayMs(p.week))}: ${t("tr.p85", { d: fmtDate(dayMs(p.p85)) })}${tail}${p.dueDate ? ` · ${t("tr.due", { d: fmtDate(dayMs(p.dueDate)) })}` : ""}${p.restored ? ` · ${t("tr.restored")}` : ""}`);
  });
  const cross = crossingWeek(points);
  if (cross) {
    const p = line.find((q) => q.week === cross);
    if (p) {
      const c = node("circle", { cx: p.x, cy: p.y, r: 6, class: "tr-cross" });
      c.append(node("title", {}, t("tr.crossed", { d: fmtDate(dayMs(cross)) })));
      f.svg.append(c);
    }
  }
  return f.svg;
}

// 6.3. Эпик: сделано против объёма — две накопительные линии.
export function burnupChart(points) {
  const weeks = points.map((p) => p.week);
  if (points.length < 2) return null;
  const hi = Math.max(1, ...points.map((p) => p.total)) * 1.08;
  const scale = (v) => (y0, y1) => y0 - (v / hi) * (y0 - y1);
  const ticks = niceTicks(0, hi).filter((v) => Number.isInteger(v)).map((v) => ({ y: scale(v), label: String(v) }));
  const f = frame({ weeks, yTicks: ticks, yLabel: t("tr.issuesAxis"), height: 180 });
  const y = (v) => scale(v)(f.y0, f.y1);
  const total = points.map((p, i) => ({ ...p, x: f.x(i), y: y(p.total) }));
  const done = points.map((p, i) => ({ ...p, x: f.x(i), y: y(p.done) }));
  polyline(f.svg, total, "tr-line tr-total");
  polyline(f.svg, done, "tr-line tr-done");
  total.forEach((p, i) => {
    const prev = points[i - 1];
    const d = prev ? ` (${p.total - prev.total >= 0 ? "+" : "−"}${Math.abs(p.total - prev.total)} / ${p.done - prev.done >= 0 ? "+" : "−"}${Math.abs(p.done - prev.done)})` : "";
    dot(f.svg, p, "tr-dot tr-total", `${fmtDate(dayMs(p.week))}: ${t("tr.burnup", { total: p.total, done: p.done })}${d}${p.restored ? ` · ${t("tr.restored")}` : ""}`);
  });
  return f.svg;
}

// Легенда: цветной квадрат + подпись (текст — нейтральным цветом).
export function legend(items) {
  const box = document.createElement("div");
  box.className = "tr-legend";
  for (const it of items) {
    const span = document.createElement("span");
    span.className = "tr-legend-item" + (it.off ? " off" : "");
    const sw = document.createElement("i");
    sw.className = `tr-swatch ${it.cls || ""}`;
    if (it.color) sw.style.background = it.color;
    span.append(sw, document.createTextNode(it.label));
    if (it.onClick) {
      span.classList.add("clickable");
      span.onclick = it.onClick;
    }
    box.append(span);
  }
  return box;
}
