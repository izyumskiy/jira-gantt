// Объяснение срока от LLM (US-9, ТЗ А5.2): по факторам расчёта — 3–5 предложений, с главной причины.
// Каждое число и дата в тексте проверяются по факторам: лишнее — один повтор, затем шаблонный текст.
import { complete } from "./client.js";
import { ymd } from "../js/workcal.js";

const MAX_TEXT = 1500;

// Факторы для модели: даты — ГГГГ-ММ-ДД, остальное — как в факторах (aiAnalysis.buildFactors).
export function facts(f) {
  const dates = (x) => ({ p50: ymd(x.p50), p85: ymd(x.p85), p95: ymd(x.p95) });
  return {
    percentiles: [50, 85, 95],
    ready: dates(f.dates.done),
    development: dates(f.dates.dev),
    chance_by_due_pct: f.dates.chance == null ? null : Math.round(f.dates.chance * 100),
    remaining_tasks: Math.round(f.remaining.total),
    stub_tasks: f.remaining.stubs,
    support_tasks: f.remaining.support || 0,
    llm_stub_tasks: f.llmStubs || 0,
    teams: f.shares,
    bottleneck: f.plan && !f.plan.unplanned ? null : f.last[0] || null,
    plan: f.plan ? { ...f.plan, end: ymd(f.plan.end) } : null,
    release_days: f.release,
    blockers_days: f.blockersAssessed ? f.blockers : null,
    blockers: f.blockerList || [],
    acceptance: {
      ...f.acceptance,
      btSince: f.acceptance.btSince ? ymd(f.acceptance.btSince) : null,
      stubs: f.acceptance.stubs
        ? { ...f.acceptance.stubs, from: ymd(f.acceptance.stubs.from), to: ymd(f.acceptance.stubs.to), devEnd: f.acceptance.stubs.devEnd ? ymd(f.acceptance.stubs.devEnd) : null }
        : undefined
    },
    holidays_workdays: f.holidays,
    spread_days: f.spread,
    notes: f.notes || []
  };
}

const PROMPT = (lang) => `Ты объясняешь менеджеру проекта, почему срок готовности эпика с вероятностью 95% именно такой.
Ниже — факторы расчёта. Напиши 3–5 предложений на ${lang === "en" ? "английском" : "русском"} языке, начиная с главной
причины. Используй только числа и даты из факторов, ничего не вычисляй и не округляй сам. Даты пиши как
ДД.ММ.ГГГГ. Не пересказывай все факторы — только то, что двигает срок.
Верни JSON-объект: {"text": "..."}.`;

const DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b|\b(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\b/g;
const NUM_RE = /\d+(?:[.,]\d+)?/g;

// Что разрешено в тексте: даты из фактов (день-месяц и с годом) и числа из фактов.
function allowed(fx) {
  const json = JSON.stringify(fx);
  const dates = new Set();
  for (const [, y, m, d] of json.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    dates.add(`${+d}.${+m}`);
    dates.add(`${+d}.${+m}.${y}`);
    dates.add(`${+d}.${+m}.${y.slice(2)}`);
  }
  const nums = new Set(json.replace(/\d{4}-\d{2}-\d{2}/g, " ").match(NUM_RE)?.map((n) => Number(n)) || []);
  return { dates, nums };
}

// Проверка текста: { ok } или { error } со списком лишнего.
export function check(text, fx) {
  if (typeof text !== "string" || !text.trim()) return { error: "пустой текст" };
  if (text.length > MAX_TEXT) return { error: "слишком длинный текст" };
  const a = allowed(fx);
  const extra = [];
  const rest = text.replace(DATE_RE, (m, y, mo, d, d2, mo2, y2) => {
    const key = y ? `${+d}.${+mo}.${y}` : `${+d2}.${+mo2}${y2 ? `.${y2}` : ""}`;
    // «0.4» или «1.5» — дробное число из фактов, а не дата
    if (!a.dates.has(key) && !(!y && !y2 && a.nums.has(Number(m)))) extra.push(m);
    return " ";
  });
  for (const n of rest.match(NUM_RE) || []) if (!a.nums.has(Number(n.replace(",", ".")))) extra.push(n);
  return extra.length ? { error: `чисел и дат нет в факторах: ${[...new Set(extra)].join(", ")}` } : { ok: true };
}

// Запрос текста: проверка, при лишнем — один повтор с указанием ошибки. Не вышло — { text: null, error }:
// показывается шаблонный текст.
export async function request({ factors, lang = "ru", ...opts }) {
  const fx = facts(factors);
  const messages = [
    { role: "system", content: PROMPT(lang) },
    { role: "user", content: JSON.stringify(fx) }
  ];
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let text;
    try {
      const raw = await complete({ ...opts, messages, json: true });
      text = raw && typeof raw.text === "string" ? raw.text.trim() : "";
    } catch (e) {
      error = e && e.message ? e.message : String(e);
      if (error !== "bad json") return { text: null, error };
      text = "";
    }
    const v = check(text, fx);
    if (v.ok) return { text, error: "" };
    error = v.error;
    messages.push({ role: "assistant", content: JSON.stringify({ text }) });
    messages.push({ role: "user", content: `Текст не прошёл проверку: ${error}. Перепиши, используя только числа и даты из факторов.` });
  }
  return { text: null, error };
}
