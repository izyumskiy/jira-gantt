// Стабильный контракт подключаемых бизнес-модулей Jira OhMyGant.
// Здесь нет зависимостей от Chrome, DOM, Jira-клиента или способа хранения данных.

export const MODULE_API_VERSION = "1.0.0";

export function defineModuleManifest(manifest) {
  const required = ["id", "version", "title", "kind"];
  for (const field of required) {
    if (!String(manifest?.[field] || "").trim()) throw new Error(`Module manifest: field ${field} is required`);
  }
  return Object.freeze({
    apiVersion: MODULE_API_VERSION,
    ...manifest,
    readOnly: true,
    capabilities: Object.freeze([...(manifest.capabilities || [])]),
    styles: Object.freeze([...(manifest.styles || [])])
  });
}

export function requirePort(port, method, moduleId) {
  if (typeof port?.[method] !== "function") {
    throw new Error(`${moduleId}: integration port ${method}() is not configured`);
  }
  return port[method].bind(port);
}

export function assertPeriod(from, to) {
  const fromTime = Date.parse(`${from}T00:00:00`);
  const toTime = Date.parse(`${to}T00:00:00`);
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || fromTime > toTime) {
    throw new Error("Проверьте период анализа: дата начала должна быть не позже даты окончания");
  }
}

export function progressReporter(listener) {
  return typeof listener === "function" ? listener : () => {};
}
