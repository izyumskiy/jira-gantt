// Инфраструктурный helper схемы Jira. Не зависит от источников требований,
// синхронизации сотрудников или UI и может быть заменён адаптером новой оболочки.
import * as jira from "../jira.js";
import * as settings from "../settings.js";

export async function resolveFields() {
  const configured = settings.get().fields;
  if (configured.sprint && configured.epicLink && configured.plannedStart && configured.plannedEnd) return configured;
  const fields = await jira.fields();
  const byName = (matcher) => fields.find((field) => matcher(String(field.name || "").toLowerCase(), String(field.schema?.custom || "")))?.id || "";
  return {
    ...configured,
    sprint: configured.sprint || byName((name, schema) => name === "sprint" || schema.includes("gh-sprint")),
    epicLink: configured.epicLink || byName((name) => name === "epic link" || name === "связь с эпиком"),
    plannedStart: configured.plannedStart || byName((name) => /planned start|план.*начал/.test(name)),
    plannedEnd: configured.plannedEnd || byName((name) => /planned end|план.*оконч|план.*заверш/.test(name))
  };
}
