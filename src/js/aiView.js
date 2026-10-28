// Интерфейс AI-анализа (US-5): пиктограмма ✦ у эпика, объяснение срока, блок в карточке эпика.
import { t } from "./i18n.js";

export const fmtDay = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "2-digit" });

// Результат старше последней синхронизации — устарел.
export const isStale = (rec, lastSync) => !!rec && Number(lastSync) > rec.at;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ai — { results: Map(ключ → результат), lastSync, onAnalyze(ключ, кнопка) }.
export function aiButton(key, ai) {
  const rec = ai.results.get(key);
  const stale = isStale(rec, ai.lastSync);
  const btn = el("button", "ai-btn" + (rec ? " has" : "") + (stale ? " stale" : ""), "✦");
  btn.type = "button";
  btn.title = rec
    ? t("ai.btnDone", { at: fmtDay(rec.at), p95: fmtDay(rec.res.done.p95) }) + (stale ? ` · ${t("ai.stale")}` : "")
    : t("ai.btn");
  btn.setAttribute("aria-label", t("ai.btn"));
  btn.onclick = (e) => {
    e.stopPropagation();
    if (btn.classList.contains("busy")) return;
    ai.onAnalyze(key, btn);
  };
  return btn;
}

const sign = (n) => (n > 0 ? `+${n}` : String(n));

// Факторы списком — строки для объяснения.
export function factorLines(f) {
  const d = f.dates;
  const lines = [
    t("ai.fDone", { p50: fmtDay(d.done.p50), p85: fmtDay(d.done.p85), p95: fmtDay(d.done.p95) }),
    t("ai.fDev", { p50: fmtDay(d.dev.p50), p85: fmtDay(d.dev.p85), p95: fmtDay(d.dev.p95) })
  ];
  if (d.chance != null) lines.push(t("ai.fChance", { pct: Math.round(d.chance * 100) }));
  lines.push(t("ai.fRemaining", { n: Math.round(f.remaining.total), stubs: f.remaining.stubs }));
  for (const x of f.shares) lines.push(t("ai.fShare", { team: x.team, share: x.share, pace: x.pace, people: x.people.join(", ") || t("dash") }));
  if (f.last.length) lines.push(t("ai.fLast", { team: f.last[0].team, pct: f.last[0].pct }));
  lines.push(f.blockersAssessed ? t("ai.fInfluence", { release: sign(f.release), blockers: sign(f.blockers) }) : t("ai.fInfluenceNoBlockers", { release: sign(f.release) }));
  const a = f.acceptance;
  if (a.none) lines.push(t("ai.fAccNone"));
  else if (a.noHistory) lines.push(t("ai.fAccGeneral", { customer: a.customer || t("dash") }));
  else lines.push(t("ai.fAcc", { customer: a.customer, n: a.n, median: a.median, p95: a.p95, ret: a.returnRate }));
  if (a.btSince) lines.push(t("ai.fInBt", { since: fmtDay(a.btSince) }));
  lines.push(t("ai.fCalendar", { n: f.holidays }));
  lines.push(t("ai.fSpread", { days: f.spread }));
  return lines;
}

// Объяснение: текст, факторы, дата анализа (и пометка «устарело»).
export function explanation(rec, lastSync) {
  const box = el("div", "ai-expl");
  box.append(el("p", "ai-text", rec.text));
  const ul = el("ul", "ai-factors");
  for (const line of factorLines(rec.factors)) ul.append(el("li", null, line));
  box.append(ul);
  box.append(el("div", "ai-at muted small", t("ai.at", { at: fmtDay(rec.at) }) + (isStale(rec, lastSync) ? ` · ${t("ai.stale")}` : "")));
  return box;
}

// Блок «AI-анализ» в карточке эпика. «Пересчитать» — расчёт без LLM; «Новый анализ» (с LLM) — US-8.
export function cardBlock(rec, { lastSync, onRecalc }) {
  const box = el("div", "ai-card");
  box.append(el("div", "tip-sub", t("ai.title")));
  if (rec) box.append(explanation(rec, lastSync));
  else box.append(el("div", "muted small", t("ai.none")));
  const row = el("div", "row");
  const btn = el("button", null, rec ? t("ai.recalc") : t("ai.run"));
  btn.type = "button";
  btn.onclick = () => onRecalc(btn);
  row.append(btn);
  box.append(row);
  return box;
}
