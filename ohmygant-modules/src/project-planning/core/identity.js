// Нормализация идентичности сотрудника между Tempo, Jira и локальными снимками.
export function normalizeIdentity(value) {
  return String(value || "").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ");
}

export function personAliases(person = {}) {
  return new Set([
    person.id,
    person.accountId,
    person.username,
    person.key,
    person.displayName,
    ...(person.aliases || [])
  ].map(normalizeIdentity).filter(Boolean));
}

export function samePerson(left, right) {
  const leftAliases = personAliases(left);
  return [...personAliases(right)].some((alias) => leftAliases.has(alias));
}
