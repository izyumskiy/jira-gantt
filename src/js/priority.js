// Приоритеты Jira (ТЗ «Эпик — история», Р6): порядок из /rest/api/2/priority (от высшего к низшему),
// сравнение и пиктограмма. Если пиктограммы Jira не грузятся (закрыты для расширения) — цветной
// кружок по месту в порядке приоритетов, от красного к серому.

// Приоритет из поля задачи Jira → компактная запись для базы.
export function fromField(p) {
  if (!p || typeof p !== "object") return null;
  return { id: String(p.id ?? ""), name: p.name || "", iconUrl: p.iconUrl || "" };
}

// Место приоритета в порядке: 0 — высший. Нет приоритета или он неизвестен — ниже самого низкого.
export function rankOf(priority, order) {
  if (!priority) return order.length;
  const i = order.findIndex((p) => (priority.id && p.id === priority.id) || (!priority.id && p.name === priority.name));
  return i >= 0 ? i : order.length;
}

export function compare(a, b, order) {
  return rankOf(a, order) - rankOf(b, order);
}

// Самый высокий приоритет из списка (например, приоритет проекта по его незавершённым эпикам).
export function highest(list, order) {
  let best = null;
  for (const p of list) if (p && (best == null || compare(p, best, order) < 0)) best = p;
  return best;
}

const FALLBACK = ["#de350b", "#ff5630", "#ff8b00", "#ffab00", "#6b778c", "#a5adba"];

// Цвет запасного кружка: от красного (высший) к серому (низший), по месту в порядке.
export function fallbackColor(priority, order) {
  const n = order.length;
  const r = rankOf(priority, order);
  if (!priority || r >= n) return FALLBACK[FALLBACK.length - 1];
  const i = n > 1 ? Math.round((r / (n - 1)) * (FALLBACK.length - 1)) : 0;
  return FALLBACK[i];
}

// Пиктограмма приоритета: картинка из Jira, при ошибке загрузки — цветной кружок. Название — в подсказке.
export function icon(priority, order, t = (k) => k) {
  const title = priority && priority.name ? priority.name : t("prio.none");
  const circle = () => {
    const c = document.createElement("i");
    c.className = "prio-dot";
    c.style.background = fallbackColor(priority, order);
    c.title = title;
    c.setAttribute("aria-label", title);
    return c;
  };
  if (!priority || !priority.iconUrl) return circle();
  const img = document.createElement("img");
  img.className = "prio-icon";
  img.src = priority.iconUrl;
  img.alt = title;
  img.title = title;
  img.width = 16;
  img.height = 16;
  img.onerror = () => img.replaceWith(circle());
  return img;
}
