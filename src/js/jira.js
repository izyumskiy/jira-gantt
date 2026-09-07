// Клиент Jira Server 9.x: сначала сессионные cookie, при 401/403 — PAT.
import { t } from "./i18n.js";
import * as settings from "./settings.js";

export class JiraError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function baseUrl() {
  const s = settings.get();
  const url = (s.baseUrl || "").trim().replace(/\/+$/, "");
  if (!url) throw new JiraError(t("err.noBaseUrl"), 0);
  return url;
}

async function once(url, opts, auth) {
  // X-Atlassian-Token: no-check — иначе Jira Server отвергает POST под cookie-сессией (XSRF).
  const headers = { Accept: "application/json", "X-Atlassian-Token": "no-check" };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (auth === "pat") headers.Authorization = `Bearer ${settings.get().pat}`;
  return fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: auth === "pat" ? "omit" : "include",
    redirect: "follow"
  });
}

// Ответ считаем неавторизованным и при 401/403, и при редиректе Jira на форму логина.
function unauthorized(res, text) {
  if (res.status === 401 || res.status === 403) return true;
  if (res.headers.get("X-Seraph-LoginReason") === "AUTHENTICATED_FAILED") return true;
  return res.ok && /^\s*<(!doctype|html)/i.test(text || "");
}

export async function request(path, opts = {}) {
  const url = baseUrl() + path;
  let res, text;
  try {
    res = await once(url, opts, "cookie");
    text = await res.text();
  } catch (e) {
    throw new JiraError(t("err.network"), 0);
  }

  if (unauthorized(res, text) && settings.get().pat) {
    try {
      res = await once(url, opts, "pat");
      text = await res.text();
    } catch (e) {
      throw new JiraError(t("err.network"), 0);
    }
  }

  if (unauthorized(res, text)) throw new JiraError(t("err.auth"), res.status || 401);
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      msg = (j.errorMessages || []).join("; ") || JSON.stringify(j.errors || {}) || msg;
    } catch {}
    throw new JiraError(t("err.http", { code: res.status, msg }), res.status);
  }
  return text ? JSON.parse(text) : null;
}

export function myself() {
  return request("/rest/api/2/myself");
}

export function fields() {
  return request("/rest/api/2/field");
}

// Постраничный поиск по JQL. onPage вызывается после каждой страницы (для прогресса).
export async function search(jql, fieldList, onPage) {
  const out = [];
  let startAt = 0;
  const maxResults = 100;
  for (;;) {
    const page = await request("/rest/api/2/search", {
      method: "POST",
      body: { jql, startAt, maxResults, fields: fieldList }
    });
    out.push(...page.issues);
    if (onPage) onPage(out.length, page.total);
    startAt += page.issues.length;
    if (!page.issues.length || startAt >= page.total) break;
  }
  return out;
}

export async function boards() {
  const out = [];
  let startAt = 0;
  for (;;) {
    const page = await request(`/rest/agile/1.0/board?startAt=${startAt}&maxResults=50`);
    out.push(...(page.values || []));
    if (page.isLast || !page.values?.length) break;
    startAt += page.values.length;
  }
  return out;
}

export async function boardSprints(boardId) {
  const out = [];
  let startAt = 0;
  for (;;) {
    const page = await request(
      `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint?startAt=${startAt}&maxResults=50`
    );
    out.push(...(page.values || []));
    if (page.isLast || !page.values?.length) break;
    startAt += page.values.length;
  }
  return out;
}

// Комментарии задачи (эпика): все, сортировку делаем на клиенте — orderBy есть не во всех версиях.
export async function comments(issueKey) {
  const page = await request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment?maxResults=1000`);
  return page && Array.isArray(page.comments) ? page.comments : [];
}

export function addComment(issueKey, text) {
  return request(`/rest/api/2/issue/${encodeURIComponent(issueKey)}/comment`, { method: "POST", body: { body: text } });
}

// Поиск пользователей для упоминаний (@): user/picker отдаёт логин и имя; запасной путь — user/search.
export async function userSearch(query) {
  const q = encodeURIComponent(query);
  try {
    const res = await request(`/rest/api/2/user/picker?query=${q}&maxResults=10`);
    if (res && Array.isArray(res.users)) return res.users.map((u) => ({ name: u.name, displayName: u.displayName || u.name }));
  } catch {
    // ниже запасной вариант
  }
  const list = await request(`/rest/api/2/user/search?username=${q}&maxResults=10`);
  return (Array.isArray(list) ? list : []).map((u) => ({ name: u.name || u.key, displayName: u.displayName || u.name }));
}

// Один спринт по id — так обновляем даты, даже если ни одна задача не менялась.
export function sprint(sprintId) {
  return request(`/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}`);
}

// Разрешение на домен запрашивается по клику пользователя (optional_host_permissions).
export async function hasPermission(baseUrlStr) {
  const origin = settings.originOf(baseUrlStr);
  if (!origin) return false;
  return chrome.permissions.contains({ origins: [origin + "/*"] });
}

export async function requestPermission(baseUrlStr) {
  const origin = settings.originOf(baseUrlStr);
  if (!origin) return false;
  return chrome.permissions.request({ origins: [origin + "/*"] });
}

// customfield_12345 → 12345: в JQL кастомные поля адресуются как cf[12345].
export function cfId(fieldId) {
  const m = String(fieldId || "").match(/(\d+)/);
  return m ? m[1] : String(fieldId || "");
}

export function escapeJql(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
