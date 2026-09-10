// Определение компетенций по подтверждённым ролям/истории и назначение работ.
import { AREAS, classifyWork, normalizeText } from "./classification.js";

export function employeeAreas(employee, history) {
  const tokens = normalizeText([...(employee.roles || []), ...(employee.skills || []), employee.grade].join(" "));
  const result = new Set();
  for (const area of AREAS) if (area.words.some((word) => tokens.includes(word))) result.add(area.id);
  if (/разработчик|developer/.test(tokens)) result.add("backend");
  const historicalAreas = new Map();
  for (const issue of history || []) {
    const actor = issue.assignee || {};
    const aliases = [employee.accountId, employee.username, employee.key, employee.displayName, ...(employee.aliases || [])].map(normalizeText);
    const issueAliases = [actor.accountId, actor.username, actor.key, actor.displayName].map(normalizeText);
    if (aliases.some((alias) => alias && issueAliases.includes(alias))) {
      const area = classifyWork(`${issue.summary} ${(issue.components || []).join(" ")}`).id;
      historicalAreas.set(area, (historicalAreas.get(area) || 0) + 1);
    }
  }
  for (const [area, count] of historicalAreas) if (count >= 3) result.add(area);
  return result;
}

export function staffingGaps(items, employees, history) {
  const employeeAreaMap = new Map(employees.map((employee) => [employee.id, employeeAreas(employee, history)]));
  const required = new Map();
  for (const item of items) {
    if (!item.area?.id) continue;
    if (!required.has(item.area.id)) required.set(item.area.id, { area: item.area.id, label: item.area.label, hours: 0, itemIds: [] });
    const row = required.get(item.area.id);
    row.hours += Number(item.estimateHours || 0);
    row.itemIds.push(item.id);
  }
  const roles = {
    analysis: "системный или бизнес-аналитик",
    frontend: "frontend-разработчик",
    backend: "backend-разработчик",
    data: "data/ETL-разработчик",
    analytics: "BI-разработчик / аналитик",
    qa: "QA-инженер",
    access: "backend-разработчик с опытом IAM/доступов"
  };
  return [...required.values()].filter((requirement) =>
    !employees.some((employee) => employeeAreaMap.get(employee.id)?.has(requirement.area))
  ).map((requirement) => ({
    ...requirement,
    suggestedRole: roles[requirement.area] || requirement.label,
    severity: requirement.area === "analysis" ? "medium" : "high",
    message: `В выбранном составе не найден ${roles[requirement.area] || requirement.label}; ${Math.round(requirement.hours)} ч назначены предварительно.`
  }));
}

export function assignWork(items, employees, history) {
  const allocated = new Map(employees.map((employee) => [employee.id, 0]));
  const areas = new Map(employees.map((employee) => [employee.id, employeeAreas(employee, history)]));
  return items.map((item) => {
    const ranked = employees.slice().sort((left, right) => {
      const leftMatch = areas.get(left.id)?.has(item.area.id) ? 2 : 0;
      const rightMatch = areas.get(right.id)?.has(item.area.id) ? 2 : 0;
      const leftReliability = Number.isFinite(left.score) ? left.score / 100 : 0.65;
      const rightReliability = Number.isFinite(right.score) ? right.score / 100 : 0.65;
      const leftLoad = allocated.get(left.id) / Math.max(0.1, Number(left.commitment || 100) / 100);
      const rightLoad = allocated.get(right.id) / Math.max(0.1, Number(right.commitment || 100) / 100);
      return (rightMatch + rightReliability - rightLoad / 200) - (leftMatch + leftReliability - leftLoad / 200);
    });
    const employee = ranked[0];
    allocated.set(employee.id, allocated.get(employee.id) + item.estimateHours);
    return { ...item, assigneeId: employee.id, assigneeName: employee.displayName || employee.username || employee.id };
  });
}
