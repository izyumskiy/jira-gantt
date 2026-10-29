// Поправки LLM к сроку эпика (US-8, ТЗ А4): что отдаём модели, промпт, проверка ответа кодом и
// задержка блокировки из перегруза. Сам срок считает код (portfolio.js); LLM только называет
// блокировки, дополнительные заглушки, коэффициент к приёмке и отсутствие заказчика — в границах.
import { complete, LlmError } from "./client.js";
import { overloadDelayWeeks } from "../js/portfolio.js";

const H = 3600; // оценки и ёмкость в секундах
const round1 = (x) => Math.round(x * 10) / 10;
export const BT_FACTOR_MIN = 0.5;
export const BT_FACTOR_MAX = 2;
export const ABSENCE_MIN_P = 0.6;

export const SYSTEM_PROMPT = `Ты помогаешь менеджеру проектов оценить срок готовности эпика в Jira.
Срок считает программа (Монте-Карло по потоку команд и истории приёмок заказчика). От тебя нужны
только поправки по данным, которых программа не видит. Не придумывай: опирайся на переданные данные.

Верни JSON-объект строго такого вида:
{
  "blockers": [{"epic": "КЛЮЧ эпика из portfolio или null, если это прочая работа",
                "people": ["имя исполнителя из load"], "sections": ["id секции из load"],
                "confidence": 0.0-1.0, "reason": "кратко, почему"}],
  "stub_tasks": [{"key": "КЛЮЧ открытой задачи этого эпика", "reason": "почему это заглушка"}],
  "support_tasks": [{"key": "КЛЮЧ открытой задачи этого эпика", "reason": "почему это сопровождение"}],
  "bt_factor": 0.5-2.0,
  "bt_factor_reason": "почему приёмка будет дольше или короче обычной у заказчика",
  "customer_absence": [{"from": "ГГГГ-ММ-ДД", "to": "ГГГГ-ММ-ДД", "reason": "...", "confidence": 0.0-1.0}],
  "notes": ["до 3 наблюдений, которые не влияют на расчёт, но важны"]
}

Правила:
- blockers — только если исполнитель задач эпика перегружен (overload_h > 0) в секции работой другого
  эпика портфеля (other_epics_h) или прочей работой (other_work_h). Блокер — тот, кто съел ёмкость.
- stub_tasks — задачи, обозначающие время отладки, сопровождения или бизнес-теста, а не разработку,
  которые не помечены stub_by_settings. Только открытые задачи этого эпика.
- support_tasks — задачи сопровождения проекта, не помеченные support_by_settings: аналитик или
  архитектор сначала пишет требования, а потом по ходу проекта отвечает на вопросы — задача тянется
  весь проект, но времени почти не занимает. Не разработка и не бизнес-тест.
- bt_factor — 1, если оснований менять срок приёмки нет.
- customer_absence — только если в комментариях прямо сказано об отпуске или отсутствии заказчика.
- Пустые списки, если ничего не нашёл. Тексты — по-русски, коротко.`;

// Загрузка людей эпика по секциям — строками для LLM. load — agg.personLoad (с byEpic), people —
// Map(норм. имя → имя), target — ключ эпика, portfolio — ключи других эпиков портфеля.
export function loadRows(load, { people, target, portfolio }) {
  const rows = [];
  for (const [norm, name] of people) {
    const secs = load.byEpic.get(norm);
    for (const sec of load.sections) {
      const byEpic = (secs && secs.get(sec.id)) || new Map();
      let total = 0;
      let own = 0;
      let other = 0;
      const others = {};
      for (const [epic, sec2] of byEpic) {
        total += sec2;
        if (epic === target) own += sec2;
        else if (portfolio.has(epic)) others[epic] = round1(sec2 / H);
        else other += sec2;
      }
      rows.push({
        person: name,
        section: String(sec.id),
        sprints: sec.title,
        capacity_h: round1(sec.cap / H),
        load_h: round1(total / H),
        this_epic_h: round1(own / H),
        other_epics_h: others,
        other_work_h: round1(other / H),
        overload_h: sec.cap > 0 ? round1(Math.max(0, total - sec.cap) / H) : 0
      });
    }
  }
  return rows;
}

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const text = (v, max = 300) => String(v == null ? "" : v).trim().slice(0, max);
const arr = (v) => v === undefined || v === null || Array.isArray(v);

// Проверка ответа. Нарушение формата — ошибка (повторный запрос); поправка, не прошедшая проверку по
// данным (чужой эпик, человек не из исполнителей, неизвестная секция, чужая задача), — отбрасывается.
// ctx: { portfolio: Set, people: Map(норм. имя → имя), norm: имя → норм. имя, sections: Map(id → спринты),
//        openTasks: Set }
export function validate(raw, ctx) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "ответ — не JSON-объект" };
  for (const f of ["blockers", "stub_tasks", "support_tasks", "customer_absence", "notes"]) if (!arr(raw[f])) return { error: `поле ${f} — не список` };
  if (raw.bt_factor != null && !Number.isFinite(Number(raw.bt_factor))) return { error: "bt_factor — не число" };
  let dropped = 0;
  const blockers = [];
  for (const b of raw.blockers || []) {
    const p = Number(b && b.confidence);
    const people = Array.isArray(b && b.people) ? b.people.map((n) => ctx.norm(n)) : [];
    const sections = Array.isArray(b && b.sections) ? b.sections.map(String) : [];
    const epic = b && b.epic ? String(b.epic).trim().toUpperCase() : null;
    const ok =
      Number.isFinite(p) &&
      people.length && people.every((n) => ctx.people.has(n)) &&
      sections.length && sections.every((x) => ctx.sections.has(x)) &&
      (epic === null || ctx.portfolio.has(epic));
    if (!ok) {
      dropped += 1;
      continue;
    }
    blockers.push({ id: `blocker:${epic || "other"}`, epic, people: [...new Set(people)].map((n) => ctx.people.get(n)), sections: [...new Set(sections)], sectionNames: [...new Set(sections)].map((x) => ctx.sections.get(x) || x), p: Math.min(1, Math.max(0, p)), reason: text(b.reason) });
  }
  const stubs = [];
  for (const x of raw.stub_tasks || []) {
    const key = String((x && x.key) || "").trim().toUpperCase();
    if (!ctx.openTasks.has(key) || stubs.some((y) => y.key === key)) {
      dropped += 1;
      continue;
    }
    stubs.push({ id: `stub:${key}`, key, reason: text(x.reason) });
  }
  const support = [];
  for (const x of raw.support_tasks || []) {
    const key = String((x && x.key) || "").trim().toUpperCase();
    if (!ctx.openTasks.has(key) || stubs.some((y) => y.key === key) || support.some((y) => y.key === key)) {
      dropped += 1;
      continue;
    }
    support.push({ id: `support:${key}`, key, reason: text(x.reason) });
  }
  const absence = [];
  for (const a of raw.customer_absence || []) {
    const p = Number(a && a.confidence);
    if (!a || !isDate(a.from) || !isDate(a.to) || a.from > a.to || !Number.isFinite(p)) {
      dropped += 1;
      continue;
    }
    absence.push({ id: `absence:${a.from}`, from: a.from, to: a.to, p: Math.min(1, Math.max(0, p)), reason: text(a.reason) });
  }
  const f = raw.bt_factor == null ? 1 : Number(raw.bt_factor);
  return {
    adj: {
      blockers,
      stubs,
      support,
      btFactor: Math.min(BT_FACTOR_MAX, Math.max(BT_FACTOR_MIN, f)),
      btFactorRaw: f,
      btFactorReason: text(raw.bt_factor_reason),
      absence,
      notes: (raw.notes || []).map((n) => text(n)).filter(Boolean).slice(0, 3),
      dropped
    }
  };
}

// Запрос поправок: проверка, при нарушении формата — один повтор с указанием ошибки. Сбой сети или
// провайдера и повторная ошибка — { adj: null, error }: расчёт пойдёт без поправок.
export async function request({ payload, ctx, ...opts }) {
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(payload) }
  ];
  let error = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try {
      raw = await complete({ ...opts, messages, json: true });
    } catch (e) {
      if (!(e instanceof LlmError) || e.message !== "bad json") return { adj: null, error: e && e.message ? e.message : String(e) };
      error = "ответ — не JSON";
    }
    if (raw !== undefined) {
      const v = validate(raw, ctx);
      if (v.adj) return { adj: v.adj, error: "" };
      error = v.error;
      messages.push({ role: "assistant", content: JSON.stringify(raw) });
    }
    messages.push({ role: "user", content: `Ответ не прошёл проверку: ${error}. Верни JSON-объект строго по формату.` });
  }
  return { adj: null, error };
}

// Сохранённые поправки или null. Анализы до US-8 хранили вместо поправок пустой объект {}.
export const stored = (adj) => (adj && Array.isArray(adj.blockers) ? adj : null);

// Действующие поправки: без отключённых пользователем («Не учитывать», ids).
export function effective(adj, disabled = []) {
  adj = stored(adj);
  if (!adj) return null;
  const off = new Set(disabled);
  return {
    ...adj,
    blockers: adj.blockers.filter((b) => !off.has(b.id)),
    stubs: adj.stubs.filter((x) => !off.has(x.id)),
    support: (adj.support || []).filter((x) => !off.has(x.id)),
    btFactor: off.has("factor") ? 1 : adj.btFactor,
    absence: adj.absence.filter((a) => !off.has(a.id))
  };
}

// Задержка блокировки (ТЗ А2, шаг 6): по каждому человеку и секции — работа этого эпика, которую
// вытесняет перегруз блокера (null — прочей работы вне портфеля): меньшее из перегруза, часов блокера
// и часов человека по эпику. Весь перегруз человека эпик не ждёт — только свою не влезшую работу.
// Задержка — по наибольшему.
export function blockerDelay(b, load, { norm, target, portfolio, hoursPerDay = 8 }) {
  const hours = b.people.map((name) => {
    const secs = load.byEpic.get(norm(name));
    let h = 0;
    for (const sec of load.sections) {
      if (!b.sections.includes(String(sec.id)) || !(sec.cap > 0)) continue;
      const byEpic = (secs && secs.get(sec.id)) || new Map();
      let total = 0;
      let cause = 0;
      for (const [epic, sec2] of byEpic) {
        total += sec2;
        if (b.epic ? epic === b.epic : epic !== target && !portfolio.has(epic)) cause += sec2;
      }
      h += Math.min(Math.max(0, total - sec.cap), cause, byEpic.get(target) || 0) / H;
    }
    return round1(h);
  });
  return { hours, weeks: overloadDelayWeeks(hours, hoursPerDay) };
}

// Дни отсутствия заказчика (уверенность ≥ 0,6) — нерабочие для приёмки.
export function absenceDays(absence) {
  const out = [];
  for (const a of absence) {
    if (a.p < ABSENCE_MIN_P) continue;
    for (let d = new Date(`${a.from}T12:00:00`); d <= new Date(`${a.to}T12:00:00`); d.setDate(d.getDate() + 1)) {
      const pad = (n) => String(n).padStart(2, "0");
      out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
  }
  return [...new Set(out)];
}
