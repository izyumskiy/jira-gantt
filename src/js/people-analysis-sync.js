// Двухэтапная выгрузка аналитики: Tempo-команды → выбранная команда → только её активность за период.
import * as db from "./db.js";
import * as jira from "./jira.js";
import * as settings from "./settings.js";
import * as tempo from "./people-tempo.js";

const DAY = 86400000;
const USER_CHUNK = 35;
const KEY_CHUNK = 80;
const QUERY_CONCURRENCY = 3;
const DETAIL_CONCURRENCY = 8;
const q = (value) => `"${jira.escapeJql(value)}"`;
const chunks = (items, size) => { const out = []; for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size)); return out; };

function addDay(value) {
  const date = new Date(`${value}T00:00:00`);
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function periodBounds(from, to) {
  return {
    start: new Date(`${from}T00:00:00`).getTime(),
    end: new Date(`${addDay(to)}T00:00:00`).getTime()
  };
}

function inPeriod(value, bounds) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= bounds.start && time < bounds.end;
}

export function issueTouchesPeriod(issue, from, to) {
  const bounds = periodBounds(from, to);
  return [issue.created, issue.resolved, issue.updated].some((value) => inPeriod(value, bounds))
    || (issue.histories || []).some((history) => inPeriod(history.at || history.created, bounds))
    || (issue.worklogs || []).some((worklog) => inPeriod(worklog.started || worklog.created, bounds));
}

export function buildPeriodQueries(users, from, to) {
  const list = users.map(q).join(",");
  const until = addDay(to);
  const updated = `updated >= ${q(from)} AND updated < ${q(until)}`;
  const current = `${updated} AND assignee in (${list})`;
  return [
    {
      kind: "activity",
      label: "изменения и назначения",
      jql: `${updated} AND (assignee in (${list}) OR assignee WAS IN (${list}) DURING (${q(from)}, ${q(to)}))`,
      fallbackJql: current,
      required: true
    },
    {
      kind: "worklog",
      label: "списания времени",
      jql: `worklogAuthor in (${list}) AND worklogDate >= ${q(from)} AND worklogDate <= ${q(to)}`,
      required: false
    }
  ];
}

function userOf(raw) {
  return raw ? {
    username: raw.name || raw.username || "",
    key: raw.key || "",
    accountId: raw.accountId || "",
    displayName: raw.displayName || raw.name || "",
    active: raw.active !== false
  } : null;
}

function sprintOf(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return {
    id: raw.id || "", name: raw.name || "", state: raw.state || "",
    startDate: raw.startDate || "", endDate: raw.endDate || raw.completeDate || "", completeDate: raw.completeDate || ""
  };
  const text = String(raw), read = (name) => text.match(new RegExp(`${name}=([^,\\]]*)`))?.[1]?.trim() || "";
  return { id: read("id"), name: read("name"), state: read("state"), startDate: read("startDate"), endDate: read("endDate"), completeDate: read("completeDate") };
}

function worklogOf(raw) {
  return {
    id: String(raw.id || ""),
    ...userOf(raw.author),
    started: raw.started || raw.created || "",
    timeSpentSeconds: Number(raw.timeSpentSeconds || 0)
  };
}

export function mapIssue(raw, sprintField, worklogs = []) {
  const f = raw.fields || {}, sprintRaw = sprintField ? f[sprintField] : [];
  return {
    key: raw.key,
    summary: f.summary || "",
    assignee: userOf(f.assignee),
    reporter: userOf(f.reporter),
    type: f.issuetype?.name || "",
    priority: f.priority?.name || "",
    status: f.status?.name || "",
    resolution: f.resolution?.name || "",
    project: { key: f.project?.key || "", name: f.project?.name || "" },
    created: f.created || "",
    resolved: f.resolutiondate || "",
    updated: f.updated || "",
    originalEstimateSeconds: Number(f.timeoriginalestimate || 0),
    remainingEstimateSeconds: Number(f.timeestimate || 0),
    timeSpentSeconds: Number(f.timespent || 0),
    labels: f.labels || [],
    components: (f.components || []).map((item) => item.name),
    fixVersions: (f.fixVersions || []).map((item) => item.name),
    sprints: (Array.isArray(sprintRaw) ? sprintRaw : [sprintRaw]).map(sprintOf).filter(Boolean),
    worklogs: worklogs.map(worklogOf),
    histories: (raw.changelog?.histories || []).map((history) => ({
      id: String(history.id || ""), at: history.created || "", author: userOf(history.author),
      items: (history.items || []).map((item) => ({
        field: item.field || "", from: item.from || "", to: item.to || "",
        fromString: item.fromString || "", toString: item.toString || ""
      }))
    }))
  };
}

async function concurrent(items, limit, worker, progress) {
  const out = new Array(items.length); let next = 0, done = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i]);
      progress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

async function sprintFieldId() {
  let sprintField = settings.get().fields.sprint;
  if (sprintField) return sprintField;
  const fields = await jira.fields();
  return fields.find((field) =>
    String(field.name).toLowerCase() === "sprint" || String(field.schema?.custom || "").includes("gh-sprint")
  )?.id || "";
}

async function discoverIssueKeys(jobs, warnings, onProgress) {
  const found = new Set();
  await concurrent(jobs, QUERY_CONCURRENCY, async (job) => {
    const search = (jql) => jira.search(`${jql} ORDER BY updated DESC`, ["project"], (loaded, total) =>
      onProgress?.(`Jira: ${job.label} — ${loaded}/${total}`));
    let rows;
    try {
      rows = await search(job.jql);
    } catch (error) {
      if (job.fallbackJql) {
        warnings.push(`История назначений недоступна, использованы текущие назначения: ${error.message}`);
        rows = await search(job.fallbackJql);
      } else if (job.required) {
        throw error;
      } else {
        warnings.push(`${job.label}: ${error.message}`);
        rows = [];
      }
    }
    rows.forEach((issue) => issue?.key && found.add(issue.key));
  });
  return found;
}

async function loadIssues(keys, fields, onProgress) {
  if (!keys.length) return [];
  const groups = chunks(keys, KEY_CHUNK);
  const pages = await concurrent(groups, 2, (group) => jira.searchExpanded(
    `key in (${group.map(q).join(",")}) ORDER BY updated DESC`,
    fields,
    (loaded, total) => onProgress?.(`Jira: поля и история — ${loaded}/${total}`)
  ));
  const byKey = new Map();
  pages.flat().forEach((issue) => issue?.key && byKey.set(issue.key, issue));
  return [...byKey.values()];
}

function embeddedWorklogs(issue) {
  const page = issue.fields?.worklog;
  const rows = Array.isArray(page) ? page : page?.worklogs || [];
  const total = Array.isArray(page) ? rows.length : Number(page?.total ?? rows.length);
  const spent = Number(issue.fields?.timespent || 0);
  return {
    rows,
    needsFull: spent > 0 && (!page || total > rows.length || (total === 0 && !rows.length))
  };
}

export async function loadTeams(onProgress) {
  onProgress?.("Tempo: загружаю активные команды");
  const teams = await tempo.activeTeams();
  if (!teams.length) throw new Error("Tempo не вернул активных команд");
  await db.clear(db.STORES.paTeams);
  await db.putAll(db.STORES.paTeams, teams);
  await db.metaSet("paTeams", { at: Date.now(), count: teams.length });
  return teams;
}

export async function loadTeam(team, from, to, onProgress) {
  const startedAt = Date.now();
  if (!team) throw new Error("Выберите команду Tempo");
  if (!from || !to || new Date(from) > new Date(to)) throw new Error("Проверьте даты периода");

  onProgress?.(`Tempo: активный состав «${team.name}»`);
  const roster = await tempo.activeMembers(team);
  if (!roster.members.length) throw new Error("В выбранной команде нет активных сотрудников");
  const users = [...new Set(roster.members.map((member) => member.username || member.key || member.accountId).filter(Boolean))];
  if (!users.length) throw new Error("Tempo не передал Jira-логины сотрудников");

  const warnings = [...roster.warnings];
  const jobs = chunks(users, USER_CHUNK).flatMap((group) => buildPeriodQueries(group, from, to));
  const discovered = await discoverIssueKeys(jobs, warnings, onProgress);
  onProgress?.(`Найдено задач за ${from}–${to}: ${discovered.size}`);

  const sprintField = await sprintFieldId();
  const fieldList = [
    "summary", "assignee", "reporter", "issuetype", "priority", "status", "resolution", "project",
    "created", "resolutiondate", "updated", "timeoriginalestimate", "timeestimate", "timespent", "worklog",
    "labels", "components", "fixVersions", sprintField
  ].filter(Boolean);
  const raw = await loadIssues([...discovered], fieldList, onProgress);

  let extraWorklogRequests = 0, extraChangelogRequests = 0;
  const details = await concurrent(raw, DETAIL_CONCURRENCY, async (issue) => {
    const embedded = embeddedWorklogs(issue);
    let worklogs = embedded.rows;
    let histories = issue.changelog?.histories || [];
    if (embedded.needsFull) {
      extraWorklogRequests += 1;
      try { worklogs = await jira.issueWorklogs(issue.key); }
      catch (error) { warnings.push(`${issue.key} worklog: ${error.message}`); }
    }
    const historyTotal = Number(issue.changelog?.total || histories.length);
    if (historyTotal > histories.length && inPeriod(issue.fields?.resolutiondate, periodBounds(from, to))) {
      extraChangelogRequests += 1;
      try { histories = await jira.issueChangelog(issue.key); }
      catch (error) { warnings.push(`${issue.key} changelog: ${error.message}`); }
    }
    return { worklogs, histories };
  }, (done, total) => onProgress?.(`Проверка worklog и истории: ${done}/${total}`));

  const mapped = raw.map((issue, index) => mapIssue({
    ...issue,
    changelog: { ...(issue.changelog || {}), histories: details[index].histories }
  }, sprintField, details[index].worklogs));
  const issues = mapped.filter((issue) => issueTouchesPeriod(issue, from, to));
  const discardedOutsidePeriod = mapped.length - issues.length;
  if (discardedOutsidePeriod) warnings.push(`Исключено задач вне выбранного периода: ${discardedOutsidePeriod}`);

  const projects = [...new Map(issues.filter((issue) => issue.project.key).map((issue) => [issue.project.key, issue.project])).values()];
  await db.clear(db.STORES.paMembers);
  await db.clear(db.STORES.paIssues);
  await db.putAll(db.STORES.paMembers, roster.members);
  await db.putAll(db.STORES.paIssues, issues);
  const meta = {
    at: Date.now(), teamId: team.id, teamName: team.name, from, to, projects,
    memberCount: roster.members.length, issueCount: issues.length,
    worklogCount: issues.reduce((sum, issue) => sum + issue.worklogs.length, 0),
    queryCount: jobs.length, extraWorklogRequests, extraChangelogRequests, discardedOutsidePeriod,
    loadDurationMs: Date.now() - startedAt,
    warnings: [...new Set(warnings)]
  };
  await db.metaSet("peopleAnalysis", meta);
  return { members: roster.members, issues, meta };
}
