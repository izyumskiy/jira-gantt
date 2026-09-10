// Чистый распознаватель технического профиля по дереву и содержимому манифестов.
// Не выполняет сетевых запросов и не зависит от GitLab или Chrome.

const uniq = (values) => [...new Set(values.filter(Boolean))];
const basename = (path) => String(path || "").split("/").pop() || "";

function json(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function dependenciesOf(packageJson) {
  return { ...(packageJson?.dependencies || {}), ...(packageJson?.devDependencies || {}) };
}

function composerDependencies(composer) {
  return { ...(composer?.require || {}), ...(composer?.["require-dev"] || {}) };
}

function packageEntries(contents, fileName) {
  return [...contents.entries()].filter(([path]) => basename(path).toLocaleLowerCase("en-US") === fileName);
}

function languageRows(languages = {}) {
  return Object.entries(languages).filter(([, share]) => Number(share) >= 1)
    .sort((left, right) => Number(right[1]) - Number(left[1]))
    .slice(0, 5)
    .map(([name, share]) => ({ name, share: Number(Number(share).toFixed(1)) }));
}

export function buildTechnologyProfile({ paths = [], contents = new Map(), languages = {}, treeTruncated = false } = {}) {
  const files = paths.map((path) => ({ path, name: basename(path).toLocaleLowerCase("en-US") }));
  const allPaths = paths.map((path) => String(path).toLocaleLowerCase("en-US"));
  const corpus = [...contents.values()].join("\n").toLocaleLowerCase("en-US");
  const composerFiles = packageEntries(contents, "composer.json").map(([, value]) => json(value)).filter(Boolean);
  const composerLocks = packageEntries(contents, "composer.lock").map(([, value]) => json(value)).filter(Boolean);
  const packageFiles = packageEntries(contents, "package.json").map(([, value]) => json(value)).filter(Boolean);
  const composerDeps = Object.assign({}, ...composerFiles.map(composerDependencies));
  const nodeDeps = Object.assign({}, ...packageFiles.map(dependenciesOf));
  const dependencyNames = new Set([...Object.keys(composerDeps), ...Object.keys(nodeDeps)].map((name) => name.toLocaleLowerCase("en-US")));
  const hasDependency = (...names) => names.some((name) => dependencyNames.has(name));
  const technologies = [];
  const frameworks = [];
  const runtimes = [];
  const detectedLanguages = languageRows(languages);

  const phpConstraint = composerFiles.map((item) => item?.require?.php).find(Boolean) || "";
  if (composerFiles.length || detectedLanguages.some((item) => item.name.toLowerCase() === "php")) technologies.push("PHP");
  if (composerFiles.length) technologies.push("Composer");
  if (hasDependency("symfony/framework-bundle")) frameworks.push("Symfony");
  if (hasDependency("yiisoft/yii2")) frameworks.push("Yii");
  if (phpConstraint) runtimes.push(`PHP ${phpConstraint}`);

  const nodeVersion = packageFiles.map((item) => item?.engines?.node).find(Boolean) || "";
  if (packageFiles.length || hasDependency("typescript")) technologies.push(hasDependency("typescript") ? "Node.js / TypeScript" : "Node.js");
  if (hasDependency("react")) frameworks.push("React");
  if (hasDependency("vue")) frameworks.push("Vue");
  if (hasDependency("@angular/core")) frameworks.push("Angular");
  if (hasDependency("next")) frameworks.push("Next.js");
  if (hasDependency("nuxt")) frameworks.push("Nuxt");
  if (nodeVersion) runtimes.push(`Node.js ${nodeVersion}`);

  const hasPythonManifest = files.some(({ name }) => ["pyproject.toml", "requirements.txt", "pipfile", "setup.py", "poetry.lock"].includes(name) || name.startsWith("requirements"));
  if (hasPythonManifest || detectedLanguages.some((item) => item.name.toLowerCase() === "python")) technologies.push("Python");
  if (/apache-airflow|\bairflow\b/.test(corpus) || allPaths.some((path) => /(^|\/)dags\//.test(path))) frameworks.push("Airflow");
  if (/\bdbt(?:-|_|\s)|dbt-core/.test(corpus) || files.some(({ name }) => name === "dbt_project.yml")) frameworks.push("dbt");
  if (/apache-superset|\bsuperset\b/.test(corpus) || files.some(({ name }) => name === "superset_config.py")) frameworks.push("Superset");
  if (/\bdjango\b/.test(corpus)) frameworks.push("Django");
  if (/\bfastapi\b/.test(corpus)) frameworks.push("FastAPI");
  if (/\bflask\b/.test(corpus)) frameworks.push("Flask");

  if (files.some(({ name }) => name === "pom.xml" || name.startsWith("build.gradle"))) technologies.push("Java / JVM");
  if (files.some(({ name }) => name === "go.mod")) technologies.push("Go");
  if (files.some(({ name }) => name === "cargo.toml")) technologies.push("Rust");
  if (files.some(({ name }) => name === "gemfile")) technologies.push("Ruby");
  if (allPaths.some((path) => path.endsWith(".sql")) || frameworks.includes("dbt")) technologies.push("SQL / DWH");

  const lockedComposerDependencies = composerLocks.reduce((sum, item) => sum + (item?.packages || []).length + (item?.["packages-dev"] || []).length, 0);
  const directDependencies = Object.keys(composerDeps).length + Object.keys(nodeDeps).length;
  const testFiles = allPaths.filter((path) => /(^|\/)(?:__tests__|tests?|specs?)(\/|$)|(?:^|\/)(?:test|spec)[_.-]|\.(?:test|spec)\./.test(path)).length;
  const sourceFiles = allPaths.filter((path) => /\.(?:php|py|js|jsx|ts|tsx|vue|java|kt|go|rs|rb|sql)$/.test(path)).length;
  const sqlFiles = allPaths.filter((path) => path.endsWith(".sql")).length;
  const dagFiles = allPaths.filter((path) => /(^|\/)dags\/.*\.py$/.test(path)).length;
  const migrationFiles = allPaths.filter((path) => /(^|\/)(?:migrations?|alembic|versions)(\/|$)/.test(path)).length;
  const ciFiles = files.filter(({ name }) => /gitlab-ci|dockerfile|docker-compose/.test(name)).map(({ path }) => path);
  const testTools = uniq([
    hasDependency("phpunit/phpunit") ? "PHPUnit" : "",
    hasDependency("jest") ? "Jest" : "",
    hasDependency("vitest") ? "Vitest" : "",
    hasDependency("cypress") ? "Cypress" : "",
    hasDependency("@playwright/test") ? "Playwright" : "",
    /\bpytest\b/.test(corpus) ? "pytest" : ""
  ]);
  return {
    technologies: uniq([...frameworks, ...technologies, ...detectedLanguages.map((item) => item.name)]).slice(0, 10),
    frameworks: uniq(frameworks),
    runtimes: uniq(runtimes),
    languages: detectedLanguages,
    manifests: [...contents.keys()],
    tests: { files: testFiles, tools: testTools },
    scope: { files: allPaths.length, sourceFiles, sqlFiles, dagFiles, migrationFiles, treeTruncated },
    dependencies: { direct: directDependencies, locked: lockedComposerDependencies },
    delivery: { ciFiles },
    php: { constraint: phpConstraint }
  };
}
