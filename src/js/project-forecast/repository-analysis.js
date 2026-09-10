// Read-only GitLab-адаптер. Сетевой слой только собирает подтверждённые сигналы;
// распознавание стека и техническая декомпозиция находятся в чистом модуле.
import { buildTechnologyProfile } from "../../modules/project-planning/repository/technology-profile.js";
import { detectProjectIntent, repositoryWorkItems } from "../../modules/project-planning/repository/work-items.js";

const MAX_TREE_PAGES = 12;
const TREE_PAGE_SIZE = 100;
const MAX_INSPECTED_FILES = 24;
const MANIFEST_NAMES = new Set([
  "composer.json", "composer.lock", "package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "pyproject.toml", "requirements.txt", "pipfile", "pipfile.lock", "poetry.lock", "setup.py",
  "dbt_project.yml", "airflow.cfg", "superset_config.py", "pom.xml", "build.gradle", "build.gradle.kts",
  "go.mod", "cargo.toml", "gemfile", "gemfile.lock", ".gitlab-ci.yml", "docker-compose.yml",
  "docker-compose.yaml", "phpunit.xml", "phpunit.xml.dist", "pytest.ini", "jest.config.js",
  "jest.config.ts", "vitest.config.js", "vitest.config.ts", "playwright.config.js", "playwright.config.ts"
]);

const normalize = (value) => String(value || "").toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
const basename = (path) => String(path || "").split("/").pop() || "";
const sourceText = (source = {}) => [
  source.title,
  source.description,
  ...(source.comments || []).map((item) => item?.body || item),
  ...(source.children || []).flatMap((item) => [item.summary, item.description]),
  ...(source.remoteLinks || []).flatMap((item) => [item.url, item.title])
].filter(Boolean).join("\n");

function repositoryFromUrl(value, { trustedGitLabLink = false } = {}) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const path = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
  const gitLabShaped = path.includes("/-/") || /gitlab/i.test(url.hostname);
  if (!trustedGitLabLink && !gitLabShaped) return null;
  const projectPath = path.includes("/-/") ? path.split("/-/")[0] : path;
  if (!projectPath || projectPath.split("/").length < 2) return null;
  return {
    origin: url.origin,
    id: projectPath,
    label: projectPath.split("/").pop(),
    url: `${url.origin}/${projectPath}`,
    area: ""
  };
}

function linkedRepositories(source = {}) {
  const textUrls = sourceText(source).match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const fromText = textUrls.map((value) => repositoryFromUrl(value.replace(/[.,;!?]+$/, ""))).filter(Boolean);
  const fromRemoteLinks = (source.remoteLinks || []).map((link) => repositoryFromUrl(link?.url, {
    trustedGitLabLink: /gitlab/i.test(`${link?.applicationType || ""} ${link?.applicationName || ""} ${link?.title || ""}`)
  })).filter(Boolean);
  return [...fromText, ...fromRemoteLinks];
}

export function repositoriesFor(source = {}) {
  return [...new Map(linkedRepositories(source).map((repository) => [`${repository.origin}/${repository.id}`, repository])).values()];
}

export async function ensureGitLabPermission(repositoriesOrSource = []) {
  const repositories = Array.isArray(repositoriesOrSource) ? repositoriesOrSource : repositoriesFor(repositoriesOrSource);
  const origins = [...new Set(repositories.map((repository) => `${repository.origin}/*`).filter(Boolean))];
  if (!origins.length || await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

async function gitlab(origin, path, accept = "application/json", includeMeta = false) {
  const response = await fetch(`${origin}${path}`, {
    method: "GET",
    credentials: "include",
    headers: { Accept: accept }
  });
  const body = await response.text();
  if (response.status === 401 || response.status === 403 || /^\s*<(!doctype|html)/i.test(body)) {
    throw new Error("GitLab требует вход через внутренний браузер");
  }
  if (!response.ok) {
    const error = new Error(response.status === 404
      ? "репозиторий не найден или недоступен текущей браузерной сессии"
      : `GitLab HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  const data = accept === "application/json" && body ? JSON.parse(body) : body;
  return includeMeta ? { data, totalPages: Number(response.headers.get("x-total-pages") || 0) } : data;
}

async function optionalFile(origin, projectId, file, branch) {
  try {
    const path = `/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(branch)}`;
    return await gitlab(origin, path, "text/plain");
  } catch (error) {
    if (error.status === 404) return "";
    throw error;
  }
}

async function optionalJson(origin, path, fallback = {}) {
  try { return await gitlab(origin, path); } catch (error) {
    if (error.status === 404) return fallback;
    throw error;
  }
}

async function repositoryTree(origin, projectId, branch) {
  const pagePath = (page) => `/api/v4/projects/${encodeURIComponent(projectId)}/repository/tree?recursive=true&per_page=${TREE_PAGE_SIZE}&page=${page}&ref=${encodeURIComponent(branch)}`;
  const first = await gitlab(origin, pagePath(1), "application/json", true);
  const firstRows = first.data || [];
  if (firstRows.length < TREE_PAGE_SIZE) return { rows: firstRows, truncated: false };
  const requestedPages = first.totalPages ? Math.min(first.totalPages, MAX_TREE_PAGES) : MAX_TREE_PAGES;
  const rest = requestedPages > 1
    ? await Promise.all(Array.from({ length: requestedPages - 1 }, (_, index) => gitlab(origin, pagePath(index + 2))))
    : [];
  const rows = [firstRows, ...rest].flat();
  const lastPage = rest.at(-1) || firstRows;
  return { rows, truncated: first.totalPages ? first.totalPages > MAX_TREE_PAGES : lastPage.length === TREE_PAGE_SIZE };
}

function isInspectable(path) {
  const name = basename(path).toLocaleLowerCase("en-US");
  return MANIFEST_NAMES.has(name)
    || /^requirements(?:[-_.][\w.-]+)?\.txt$/.test(name)
    || /^dockerfile(?:\.[\w.-]+)?$/.test(name)
    || /^readme(?:\.[\w.-]+)?$/i.test(name);
}

function inspectPriority(path) {
  const name = basename(path).toLocaleLowerCase("en-US");
  const depth = String(path).split("/").length - 1;
  const manifest = /^(composer\.json|package\.json|pyproject\.toml|requirements\.txt|dbt_project\.yml|airflow\.cfg|pom\.xml|build\.gradle|go\.mod|cargo\.toml)$/.test(name);
  const lock = /lock|package-lock|yarn|pnpm/.test(name);
  const runtime = /gitlab-ci|docker|phpunit|pytest|jest|vitest|playwright/.test(name);
  return (manifest ? 300 : lock ? 200 : runtime ? 100 : 0) - depth * 4;
}

function inspectedPaths(tree) {
  return tree.filter((item) => item.type === "blob" && isInspectable(item.path))
    .map((item) => item.path)
    .sort((left, right) => inspectPriority(right) - inspectPriority(left) || left.localeCompare(right))
    .slice(0, MAX_INSPECTED_FILES);
}

async function inspectRepository(repository, source, onProgress) {
  onProgress?.(`GitLab: ${repository.label} — определяю ветку`);
  const project = await gitlab(repository.origin, `/api/v4/projects/${encodeURIComponent(repository.id)}`);
  const branch = project.default_branch || "main";
  onProgress?.(`GitLab: ${repository.label} — определяю стек и тестовый контур`);
  const [treeResult, languages] = await Promise.all([
    repositoryTree(repository.origin, repository.id, branch),
    optionalJson(repository.origin, `/api/v4/projects/${encodeURIComponent(repository.id)}/languages`, {})
  ]);
  const paths = treeResult.rows.filter((item) => item.type === "blob").map((item) => item.path);
  const candidates = inspectedPaths(treeResult.rows);
  const loaded = await Promise.all(candidates.map(async (path) => [path, await optionalFile(repository.origin, repository.id, path, branch)]));
  const contents = new Map(loaded.filter(([, content]) => content));
  const technologyProfile = buildTechnologyProfile({ paths, contents, languages, treeTruncated: treeResult.truncated });
  const result = {
    ...repository,
    branch,
    lastActivityAt: project.last_activity_at || "",
    files: [...contents.keys()],
    testFiles: technologyProfile.tests.files,
    technologyProfile
  };
  result.workItems = repositoryWorkItems(result, source);
  return result;
}

export async function loadRepositoryAnalysis(source, onProgress) {
  const repositories = repositoriesFor(source);
  if (!repositories.length) return {
    requested: true, complete: false, repositories: [], workItems: [],
    warnings: ["В Jira не найдено подтверждённой связи с GitLab-репозиторием. Прогноз продолжен без предположения о технологическом стеке."]
  };
  if (!(await ensureGitLabPermission(repositories))) return {
    requested: true, complete: false, repositories: [], workItems: [],
    warnings: [`Не выдано разрешение на чтение связанных GitLab-доменов: ${[...new Set(repositories.map((repository) => repository.origin))].join(", ")}.`]
  };
  const inspected = [];
  const warnings = [];
  for (const repository of repositories) {
    try {
      inspected.push(await inspectRepository(repository, source, onProgress));
    } catch (error) {
      warnings.push(`${repository.label}: ${error.message}`);
    }
  }
  const workItems = inspected.flatMap((repository) => repository.workItems || []);
  for (const repository of inspected) {
    if (repository.technologyProfile?.scope?.treeTruncated) warnings.push(`${repository.label}: просмотрена только первая часть дерева; стек подтверждён частично.`);
  }
  return {
    requested: true,
    complete: inspected.length === repositories.length && !inspected.some((repository) => repository.technologyProfile?.scope?.treeTruncated),
    repositories: inspected.map(({ workItems: ignored, ...repository }) => repository),
    workItems,
    warnings
  };
}

export { buildTechnologyProfile, detectProjectIntent, repositoryWorkItems };
