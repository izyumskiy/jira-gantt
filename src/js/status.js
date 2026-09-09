// Статусы рабочего процесса Jira: цвет лейбла, место эпика в сортировке и признак «готово».
//
// Jira Server через REST отдаёт только КАТЕГОРИЮ статуса (new / indeterminate / done),
// а в реальном потоке завершающих статусов больше: «On Prod», «Готово», «Закрыто» — и
// категория у них бывает не done. Поэтому название статуса здесь важнее категории:
// сначала ищем статус в таблице ниже, и только если не нашли — смотрим на категорию.
//
// Свои статусы можно не править кодом: список завершающих статусов дополняется полем
// «Статусы, означающие “Готово”» в настройках плагина.
//
// rank — порядок сверху вниз на вкладке «Гант по эпикам»: чем меньше, тем выше.
import * as settings from "./settings.js";

export const STATUS_RULES = [
  { id: "progress", rank: 1, names: ["в работе", "in progress", "разработка", "development", "in dev", "выполняется"] },
  { id: "test", rank: 2, names: ["бизнес тест", "бизнес-тест", "business test", "тестирование", "на тестировании", "testing", "qa", "проверка", "review", "код ревью", "code review"] },
  { id: "todo", rank: 4, names: ["сделать", "to do", "todo", "к выполнению", "open", "открыт", "открыта"] },
  { id: "new", rank: 5, names: ["new", "новый", "новая", "новое", "создан", "создана", "создано", "backlog", "бэклог"] },
  {
    id: "done",
    rank: 6,
    names: [
      "готово", "готова", "done", "закрыт", "закрыта", "закрыто", "выполнено", "выполнена",
      "resolved", "closed", "complete", "completed", "завершено", "завершена",
      "on prod", "onprod", "on production", "on prom", "на проде", "в проде", "продакшн",
      "production", "deployed", "задеплоено", "выкачено", "выкачена", "внедрено", "внедрена",
      "cancel", "cancelled", "canceled", "отмен"
    ]
  }
];

// Неизвестный статус: место и цвет берём по категории статуса из Jira.
const BY_CATEGORY = {
  done: { id: "done", rank: 6 },
  indeterminate: { id: "other", rank: 3 },
  new: { id: "todo", rank: 4 }
};
const UNKNOWN = { id: "other", rank: 3 };

function norm(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[_\-–—/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const isWordChar = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

// Вхождение засчитываем только с начала слова: «preprod» не считается «prod»,
// а «тестировании» — считается «тестировани…».
function contains(haystack, needle) {
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    if (i === 0 || !isWordChar(haystack[i - 1])) return true;
    i = haystack.indexOf(needle, i + 1);
  }
  return false;
}

// Дополнительные завершающие статусы из настроек (через запятую).
function extraDoneNames() {
  return String(settings.get().doneStatuses || "")
    .split(/[,;\n]/)
    .map(norm)
    .filter(Boolean);
}

// Возвращает { id, rank }: id идёт в css-класс лейбла (.lz-s-<id>), rank — в сортировку.
export function classify(statusName, statusCategory) {
  const n = norm(statusName);
  if (n) {
    const extra = extraDoneNames();
    if (extra.some((a) => a === n) || extra.some((a) => contains(n, a))) return { id: "done", rank: 6 };
    for (const rule of STATUS_RULES) {
      if (rule.names.some((a) => norm(a) === n)) return { id: rule.id, rank: rule.rank };
    }
    for (const rule of STATUS_RULES) {
      if (rule.names.some((a) => contains(n, norm(a)))) return { id: rule.id, rank: rule.rank };
    }
  }
  return BY_CATEGORY[statusCategory] || UNKNOWN;
}

// Название статуса важнее категории: «On Prod» в Jira нередко остаётся жёлтым,
// но по процессу это уже завершённая задача.
// Отменённая задача: по названию статуса (cancel/cancelled/canceled/отмен…). Считается готовой,
// но её оценка в суммы дней не входит — работа не делалась.
const CANCEL_NAMES = ["cancel", "cancelled", "canceled", "отмен"];
export function isCancelledStatus(statusName) {
  const n = norm(statusName);
  return !!n && CANCEL_NAMES.some((a) => n === a || contains(n, a));
}

export function isDoneStatus(statusName, statusCategory) {
  if (String(statusName || "").trim()) return classify(statusName, "").id === "done" || statusCategory === "done";
  return statusCategory === "done";
}
