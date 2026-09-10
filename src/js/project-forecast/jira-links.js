// Чистое преобразование Jira issue links в зависимости планировщика.
// Вынесено из source/sync, чтобы инфраструктурные адаптеры не зависели друг от друга.
export function jiraDependencyKeys(links = []) {
  const keys = [];
  for (const link of links || []) {
    const inwardLabel = String(link.type?.inward || "").toLocaleLowerCase("ru-RU");
    const outwardLabel = String(link.type?.outward || "").toLocaleLowerCase("ru-RU");
    if (link.inwardIssue?.key && /blocked by|depends on|is caused by|блокир|зависит|причин/.test(inwardLabel)) keys.push(link.inwardIssue.key);
    if (link.outwardIssue?.key && /blocked by|depends on|is caused by|блокир|зависит|причин/.test(outwardLabel)) keys.push(link.outwardIssue.key);
  }
  return [...new Set(keys)];
}
