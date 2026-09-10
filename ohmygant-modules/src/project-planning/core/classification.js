// Общая классификация текста требований и работ.

export const AREAS = [
  { id: "analysis", label: "Системный анализ", hours: 12, words: ["требован", "анализ", "согласован", "сценари", "бизнес", "процесс"] },
  { id: "frontend", label: "Frontend", hours: 24, words: ["frontend", "фронтенд", "ui", "ux", "интерфейс", "форма", "экран", "страниц", "виджет"] },
  { id: "backend", label: "Backend / API", hours: 28, words: ["backend", "бэкенд", "api", "endpoint", "rest", "сервис", "интеграц", "webhook"] },
  { id: "data", label: "Контур данных", hours: 32, words: ["airflow", "dag", "etl", "elt", "dwh", "хранилищ", "витрин", "pipeline", "пайплайн", "загрузк", "sql", "баз данных"] },
  { id: "analytics", label: "BI / аналитика", hours: 24, words: ["superset", "dashboard", "дашборд", "отчет", "аналитик", "график", "метрик"] },
  { id: "qa", label: "Проверка результата", hours: 16, words: ["qa", "тест", "провер", "приемк", "acceptance"] },
  { id: "access", label: "Доступы и роли", hours: 18, words: ["роль", "прав", "доступ", "авторизац", "аутентификац", "permission"] }
];

export const TECHNOLOGIES = [
  ["PHP / Composer", /\bphp\b|\bcomposer\b/i],
  ["Airflow", /\bairflow\b|\bdag\b/i],
  ["Superset", /\bsuperset\b/i],
  ["SQL / DWH", /\bsql\b|\bdwh\b|хранилищ|витрин/i],
  ["REST API", /\brest\b|\bapi\b|endpoint/i],
  ["Frontend", /frontend|фронтенд|интерфейс|\bui\b/i],
  ["Backend", /backend|бэкенд|сервис/i]
];

const STOP = new Set("и в во на по для из от до с со к ко о об а но или что это как при над под за уже нужно должен должна должны будет быть есть через без между после перед проект задача задачи функционал система данные".split(" "));

export const unique = (values) => [...new Set(values.filter(Boolean))];

export function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9+#.]+/gi, " ")
    .trim();
}

export function tokenize(value) {
  return unique(normalizeText(value).split(/\s+/).filter((word) => word.length >= 3 && !STOP.has(word)));
}

export function classifyWork(value) {
  const haystack = normalizeText(value);
  let best = AREAS[2];
  let score = 0;
  for (const area of AREAS) {
    const matched = area.words.filter((word) => haystack.includes(word)).length;
    if (matched > score) {
      best = area;
      score = matched;
    }
  }
  return best;
}

export function plainLines(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\{[^}\n]+\}/g, " ")
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]+|\d+[.)]|h\d\.|#+)\s*/, "").trim())
    .filter(Boolean);
}
