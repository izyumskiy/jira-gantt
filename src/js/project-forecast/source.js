// Read-only получение бизнес-требований из Jira или Confluence.
import * as jira from "../jira.js";
import * as settings from "../settings.js";
import { resolveFields } from "./jira-fields.js";
import { jiraDependencyKeys } from "./jira-links.js";

const quoted = (value) => `"${jira.escapeJql(value)}"`;

function richText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(richText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    return richText(value.content || value.value || "");
  }
  return String(value);
}

export function issueSourceKey(value) {
  const source = String(value || "").trim();
  const fromUrl = /\/browse\/([A-Z][A-Z0-9_]*-\d+)/i.exec(source)?.[1];
  if (fromUrl) return fromUrl.toUpperCase();
  return /^[A-Z][A-Z0-9_]*-\d+$/i.test(source) ? source.toUpperCase() : "";
}

function userOf(raw) {
  return raw ? {
    accountId: raw.accountId || "",
    username: raw.name || raw.username || "",
    key: raw.key || "",
    displayName: raw.displayName || raw.name || ""
  } : null;
}

function sourceIssue(raw) {
  const fields = raw?.fields || {};
  return {
    key: raw?.key || "",
    title: fields.summary || raw?.key || "",
    summary: fields.summary || "",
    description: richText(fields.description),
    type: fields.issuetype?.name || "",
    status: fields.status?.name || "",
    labels: fields.labels || [],
    components: (fields.components || []).map((item) => item.name || item.value).filter(Boolean),
    assignee: userOf(fields.assignee),
    originalEstimateSeconds: Number(fields.timeoriginalestimate || 0),
    remainingEstimateSeconds: Number(fields.timeestimate || 0),
    timeSpentSeconds: Number(fields.timespent || 0),
    dependsOnKeys: jiraDependencyKeys(fields.issuelinks)
  };
}

async function jiraRequirementSource(value, onProgress) {
  const key = issueSourceKey(value);
  if (!key) return null;
  onProgress?.(`Jira: читаю требования ${key}`);
  const resolved = await resolveFields();
  const fields = [
    "summary", "description", "issuetype", "status", "project", "labels", "components", "assignee", "reporter",
    "timeoriginalestimate", "timeestimate", "timespent", "subtasks", "issuelinks", resolved.epicLink
  ].filter(Boolean);
  const issue = await jira.request(`/rest/api/2/issue/${encodeURIComponent(key)}?fields=${encodeURIComponent(fields.join(","))}`);
  const [comments, remoteLinks] = await Promise.all([
    jira.comments(key).catch(() => []),
    jira.request(`/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`).catch(() => [])
  ]);
  let children = [];
  if (/эпик|epic/i.test(issue.fields?.issuetype?.name || "")) {
    const childFields = [
      "summary", "description", "issuetype", "status", "labels", "components", "assignee",
      "timeoriginalestimate", "timeestimate", "timespent", "issuelinks", resolved.sprint
    ].filter(Boolean);
    const fieldJql = resolved.epicLink ? `cf[${jira.cfId(resolved.epicLink)}] = ${quoted(key)}` : `"Epic Link" = ${quoted(key)}`;
    try {
      children = await jira.search(`${fieldJql} ORDER BY key ASC`, childFields, (loaded, total) => onProgress?.(`Jira: задачи проекта — ${loaded}/${total}`));
    } catch (error) {
      if (!resolved.epicLink) throw error;
      children = await jira.search(`"Epic Link" = ${quoted(key)} ORDER BY key ASC`, childFields);
    }
  }
  const subtasks = issue.fields?.subtasks || [];
  const known = new Set(children.map((row) => row.key));
  if (subtasks.some((row) => !known.has(row.key))) {
    const missing = subtasks.filter((row) => !known.has(row.key)).map((row) => quoted(row.key));
    children.push(...(missing.length ? await jira.search(`key in (${missing.join(",")})`, fields) : []));
  }
  const mapped = sourceIssue(issue);
  return {
    ...mapped,
    type: "jira",
    url: String(value || "").includes("/") ? String(value).trim() : `${String(settings.get().baseUrl || "").replace(/\/+$/, "")}/browse/${key}`,
    comments: comments.map((comment) => ({ body: richText(comment.body), author: comment.author?.displayName || "", created: comment.created || "" })),
    remoteLinks: (Array.isArray(remoteLinks) ? remoteLinks : []).map((link) => ({
      url: link?.object?.url || "",
      title: link?.object?.title || "",
      relationship: link?.relationship || "",
      applicationType: link?.application?.type || "",
      applicationName: link?.application?.name || ""
    })).filter((link) => link.url),
    children: children.map(sourceIssue)
  };
}

function stripHtml(value) {
  const document = new DOMParser().parseFromString(String(value || ""), "text/html");
  document.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  document.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,tr").forEach((node) => node.append("\n"));
  return String(document.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
}

function confluenceFailure(code, message, url, status = 0) {
  const error = new Error(message);
  error.code = code;
  error.actionUrl = url.href;
  error.status = status;
  return error;
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function confluencePageId(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(String(value || "").trim()); } catch { return ""; }
  return url.searchParams.get("pageId") || /\/pages\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] || "";
}

export function confluenceContextPath(value) {
  let url;
  try { url = value instanceof URL ? value : new URL(String(value || "").trim()); } catch { return ""; }
  const marker = /\/(?:pages|display|spaces)(?:\/|$)/.exec(url.pathname);
  if (!marker || marker.index === 0) return "";
  return url.pathname.slice(0, marker.index).replace(/\/+$/, "");
}

async function confluenceJson(url, path) {
  const origin = url.origin;
  const allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (!allowed) {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) throw new Error(`Нет разрешения на чтение Confluence ${origin}`);
  }
  const contextPath = confluenceContextPath(url);
  const apiRoots = [...new Set([`${origin}${contextPath}/rest/api`, `${origin}/rest/api`])];
  let notFound = null;
  for (const apiRoot of apiRoots) {
    const response = await fetch(`${apiRoot}${path}`, { headers: { Accept: "application/json" }, credentials: "include" });
    const body = await response.text();
    const payload = parseJson(body);
    const authorizationHiddenAs404 = response.status === 404 && payload?.data?.authorized === false;
    if (response.status === 401 || response.status === 403 || authorizationHiddenAs404 || /^\s*<(!doctype|html)/i.test(body)) {
      throw confluenceFailure(
        "CONFLUENCE_AUTH_REQUIRED",
        "Confluence не авторизован или у вас нет доступа к статье. Откройте статью, войдите во внутреннем браузере и повторите анализ.",
        url,
        response.status
      );
    }
    if (response.status === 404) {
      notFound = confluenceFailure(
        "CONFLUENCE_PAGE_NOT_FOUND",
        "Статья Confluence не найдена. Проверьте ссылку, pageId и доступ к пространству.",
        url,
        response.status
      );
      continue;
    }
    if (!response.ok) {
      throw confluenceFailure(
        "CONFLUENCE_HTTP_ERROR",
        `Confluence временно недоступен: HTTP ${response.status}.`,
        url,
        response.status
      );
    }
    return payload;
  }
  throw notFound || confluenceFailure("CONFLUENCE_HTTP_ERROR", "Не удалось прочитать статью Confluence.", url);
}

async function confluenceRequirementSource(value, onProgress) {
  let url;
  try { url = new URL(String(value || "").trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  onProgress?.("Confluence: читаю бизнес-требования");
  const pageId = confluencePageId(url);
  let page;
  if (pageId) {
    page = await confluenceJson(url, `/content/${encodeURIComponent(pageId)}?expand=body.storage,version,space`);
  } else {
    const match = /\/display\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) throw new Error("Не удалось определить страницу Confluence по ссылке");
    const query = `spaceKey=${encodeURIComponent(decodeURIComponent(match[1]))}&title=${encodeURIComponent(decodeURIComponent(match[2]).replace(/\+/g, " "))}&expand=body.storage,version,space`;
    const found = await confluenceJson(url, `/content?${query}`);
    page = found?.results?.[0];
  }
  if (!page) throw new Error("Страница Confluence не найдена");
  return {
    type: "confluence", key: String(page.id || pageId), url: url.href,
    title: page.title || "Страница Confluence",
    description: stripHtml(page.body?.storage?.value || ""), comments: [], children: []
  };
}

export async function loadRequirementSource(value, onProgress) {
  const source = String(value || "").trim();
  if (!source) throw new Error("Укажите ссылку на требования или ключ задачи Jira");
  const fromJira = await jiraRequirementSource(source, onProgress);
  if (fromJira) return fromJira;
  const fromConfluence = await confluenceRequirementSource(source, onProgress);
  if (fromConfluence) return fromConfluence;
  throw new Error("Поддерживается ключ/ссылка Jira или ссылка на статью Confluence");
}
