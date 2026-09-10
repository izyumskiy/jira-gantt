// Tempo Teams поверх штатного Jira-клиента OhMyGant.
import * as jira from "./jira.js";

const TEAM_ENDPOINTS = [
  "/rest/tempo-teams/2/team",
  "/rest/tempo-teams/2/team?type=ALL",
  "/rest/tempo-teams/1/team",
  "/rest/tempo-teams/1/team?type=ALL"
];
const MEMBER_ENDPOINTS = (id) => [
  `/rest/tempo-teams/2/team/${encodeURIComponent(id)}/member`,
  `/rest/tempo-teams/2/team/${encodeURIComponent(id)}/members`,
  `/rest/tempo-teams/1/team/${encodeURIComponent(id)}/member`
];
const MEMBER_KEYS = ["members", "values", "results", "data", "teamMembers"];
const INACTIVE_STATES = new Set(["inactive", "archived", "closed", "disabled"]);
const EXCLUDED_MEMBER_TYPES = new Set(["GROUP", "GENERIC_RESOURCE"]);

function rowsOf(body, keys) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const key of keys) {
    const value = body[key];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = rowsOf(value, keys);
      if (nested.length) return nested;
    }
  }
  return [];
}

function memberRows(body, teamId, depth = 0) {
  if (Array.isArray(body)) return { rows: body, recognized: true };
  if (!body || typeof body !== "object" || depth > 4) return { rows: [], recognized: false };

  const id = String(teamId);
  if (Array.isArray(body[id])) return { rows: body[id], recognized: true };
  if (body[id] && typeof body[id] === "object") {
    const nested = memberRows(body[id], id, depth + 1);
    if (nested.recognized) return nested;
  }

  for (const key of MEMBER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const value = body[key];
    if (Array.isArray(value)) {
      const block = value.find((item) => String(returnedTeamId(item) ?? "") === id && !looksLikeMember(item));
      if (block) {
        const nested = memberRows(block, id, depth + 1);
        if (nested.recognized) return nested;
      }
      return { rows: value, recognized: true };
    }
    const nested = memberRows(value, id, depth + 1);
    if (nested.recognized) return nested;
  }

  if (Array.isArray(body.teams)) {
    const block = body.teams.find((item) => String(returnedTeamId(item) ?? item?.id ?? "") === id);
    if (block) return memberRows(block, id, depth + 1);
  }
  return { rows: [], recognized: false };
}

function looksLikeMember(row) {
  return Boolean(row && typeof row === "object" && (
    row.member || row.memberBean || row.user || row.employee || row.membership
    || row.accountId || row.username || row.userName
  ));
}

function activeFlag(value, fallback = true) {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["false", "0", "inactive", "archived", "closed", "disabled", "no"].includes(String(value).trim().toLowerCase());
}

function dateBoundary(value, end = false) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text || ["null", "undefined", "-"].includes(text.toLowerCase())) return null;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const date = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    if (end) date.setDate(date.getDate() + 1);
    return date.getTime();
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp + (end ? 1 : 0) : null;
}

function firstValue(row, keys) {
  for (const key of keys) if (row?.[key] != null && row[key] !== "") return row[key];
  return null;
}

function dateActive(row, now = Date.now()) {
  const fromRaw = firstValue(row, ["from", "startDate", "dateFrom", "validFrom"]);
  const toRaw = firstValue(row, ["to", "endDate", "dateTo", "validTo"]);
  const from = dateBoundary(fromRaw);
  const to = dateBoundary(toRaw, true);
  // Неизвестный формат даты не должен молча удалять сотрудника из команды.
  return (from == null || from <= now) && (to == null || now < to);
}

function isActive(row = {}, now = Date.now()) {
  const state = String(row.status || row.state || "").trim().toLowerCase();
  return !INACTIVE_STATES.has(state)
    && !activeFlag(row.archived ?? row.isArchived, false)
    && activeFlag(row.active ?? row.isActive ?? row.enabled, true)
    && dateActive(row, now);
}

function identityOf(raw) {
  const user = raw.member || raw.memberBean || raw.user || raw.employee || raw;
  return {
    username: user.name || user.username || user.userName || raw.username || raw.userName || raw.name || "",
    key: user.key || user.userKey || raw.userKey || raw.key || "",
    accountId: user.accountId || raw.accountId || "",
    displayName: user.displayName || user.displayname || user.fullName || raw.displayName || raw.displayname || raw.name || "",
    avatarUrl: user.avatarUrls?.["48x48"] || user.avatar?.["48x48"] || ""
  };
}

function returnedTeamId(raw) {
  return raw?.teamId ?? raw?.team?.id ?? raw?.membership?.teamId ?? raw?.membership?.team?.id ?? null;
}

function belongsToTeam(raw, team) {
  const id = returnedTeamId(raw);
  return id == null || id === "" || String(id) === String(team.id);
}

function memberIdentity(member) {
  return String(member.accountId || member.username || member.key || member.displayName || "").trim().toLowerCase();
}

function mergeText(first, second) {
  return [...new Set(`${first || ""},${second || ""}`.split(",").map((item) => item.trim()).filter(Boolean))].join(", ");
}

function mergeSkills(first = [], second = []) {
  const seen = new Map();
  for (const skill of [...first, ...second]) {
    const text = String(skill || "").trim();
    if (text && !seen.has(text.toLowerCase())) seen.set(text.toLowerCase(), text);
  }
  return [...seen.values()];
}

export function dedupeMembers(members) {
  const byIdentity = new Map();
  for (const member of members) {
    const identity = memberIdentity(member);
    if (!identity) continue;
    const current = byIdentity.get(identity);
    if (!current) {
      byIdentity.set(identity, member);
      continue;
    }
    const preferred = current.sourceType === "GROUP_USER" && member.sourceType === "USER" ? member : current;
    const other = preferred === current ? member : current;
    byIdentity.set(identity, {
      ...other,
      ...preferred,
      role: mergeText(current.role, member.role),
      grade: preferred.grade || other.grade,
      skills: mergeSkills(current.skills, member.skills),
      commitment: Math.max(Number(current.commitment) || 0, Number(member.commitment) || 0),
      sourceTypes: [...new Set([...(current.sourceTypes || [current.sourceType]), ...(member.sourceTypes || [member.sourceType])].filter(Boolean))]
    });
  }
  return [...byIdentity.values()];
}

async function firstWorking(endpoints, keys) {
  const attempts = [];
  for (const endpoint of endpoints) {
    try {
      const body = await jira.request(endpoint);
      return { rows: rowsOf(body, keys), endpoint };
    } catch (error) {
      attempts.push(`${endpoint}: ${error.code || error.message}`);
      if ([401, 403].includes(error.code)) throw error;
    }
  }
  const error = new Error(`Tempo Teams API не найден. Проверено: ${attempts.join("; ")}`);
  error.attempts = attempts;
  throw error;
}

async function firstWorkingMembers(team) {
  const attempts = [];
  for (const endpoint of MEMBER_ENDPOINTS(team.id)) {
    try {
      const body = await jira.request(endpoint);
      const extracted = memberRows(body, team.id);
      if (extracted.recognized) return { rows: extracted.rows, endpoint };
      attempts.push(`${endpoint}: неизвестный формат ответа`);
    } catch (error) {
      attempts.push(`${endpoint}: ${error.code || error.message}`);
      if ([401, 403].includes(error.code)) throw error;
    }
  }
  const error = new Error(`Tempo Teams API участников не найден. Проверено: ${attempts.join("; ")}`);
  error.attempts = attempts;
  throw error;
}

export function normalizeTeam(raw, endpoint = "") {
  return {
    id: String(raw.id ?? raw.teamId ?? raw.key ?? raw.name),
    name: raw.name || raw.teamName || `Команда ${raw.id}`,
    lead: identityOf(raw.lead || raw.teamLead || {}),
    active: isActive(raw),
    endpoint
  };
}

export function normalizeMember(raw, team, now = Date.now()) {
  const person = identityOf(raw);
  const membership = raw.membership || {};
  const memberBean = raw.member || raw.memberBean || raw.user || raw.employee || {};
  const memberType = String(memberBean.type || raw.type || "USER").trim().toUpperCase();
  const role = raw.roles || raw.roleNames || membership.role?.name || raw.role?.name || raw.teamRole?.name || raw.role || "";
  const grade = raw.grade?.name || raw.grade || raw.level?.name || raw.level || "";
  const skills = raw.skills || raw.skillNames || raw.competencies || [];
  const identity = person.accountId || person.username || person.key || person.displayName;
  return {
    id: `${team.id}::${String(identity || "").toLowerCase()}`,
    teamId: String(team.id),
    sourceTeamId: returnedTeamId(raw),
    teamName: team.name,
    ...person,
    role: Array.isArray(role) ? role.map((item) => item?.name || item).filter(Boolean).join(", ") : String(role || ""),
    grade: typeof grade === "object" ? grade.name || "" : String(grade || ""),
    skills: (Array.isArray(skills) ? skills : String(skills).split(",")).map((item) => item?.name || String(item)).filter(Boolean),
    commitment: Number(raw.commitmentPercent ?? raw.commitment ?? raw.allocation ?? membership.availability ?? 100),
    sourceType: memberType,
    sourceTypes: [memberType],
    active: Boolean(identity)
      && !EXCLUDED_MEMBER_TYPES.has(memberType)
      && isActive(raw, now)
      && isActive(membership, now)
      && isActive(memberBean, now)
      && activeFlag(memberBean.activeInJira ?? raw.activeInJira, true)
  };
}

export function selectActiveMembers(rows, team, now = Date.now()) {
  const scopedRows = rows.filter((row) => belongsToTeam(row, team));
  const crossTeam = rows.length - scopedRows.length;
  const normalized = scopedRows.map((row) => normalizeMember(row, team, now));
  const active = normalized.filter((member) => member.active && memberIdentity(member));
  const members = dedupeMembers(active);
  return {
    members,
    scopedRows: scopedRows.length,
    crossTeam,
    inactive: normalized.length - active.length,
    duplicates: active.length - members.length
  };
}

function rosterWarnings(selection) {
  const warnings = [];
  if (selection.crossTeam) warnings.push(`Tempo: исключено записей других команд — ${selection.crossTeam}`);
  if (selection.duplicates) warnings.push(`Tempo: объединено дублей участников — ${selection.duplicates}`);
  return warnings;
}

export async function activeTeams() {
  const result = await firstWorking(TEAM_ENDPOINTS, ["teams", "values", "results", "data"]);
  const byId = new Map();
  for (const row of result.rows) {
    const team = normalizeTeam(row, result.endpoint);
    if (team.active && team.id && team.id !== "undefined") byId.set(team.id, team);
  }
  return [...byId.values()];
}

export async function activeMembers(team) {
  const warnings = [];
  try {
    const body = await jira.request("/rest/tempo-teams/2/team/members", {
      method: "POST",
      body: { ids: [String(team.id)], onlyActive: true }
    });
    const extracted = memberRows(body, team.id);
    if (extracted.recognized) {
      const selection = selectActiveMembers(extracted.rows, team);
      warnings.push(...rosterWarnings(selection));
      // Если bulk вернул только чужие команды, считаем фильтр Tempo ненадёжным и используем endpoint конкретной команды.
      if (selection.scopedRows > 0 || extracted.rows.length === 0) {
        return { members: selection.members, endpoint: "/rest/tempo-teams/2/team/members", warnings };
      }
    }
  } catch (error) {
    warnings.push(`Tempo bulk members: ${error.message}`);
  }

  const result = await firstWorkingMembers(team);
  const selection = selectActiveMembers(result.rows, team);
  warnings.push(...rosterWarnings(selection));
  return { members: selection.members, endpoint: result.endpoint, warnings };
}

// Общий каталог сотрудников для проектного планирования. Сначала используем один
// bulk-запрос Tempo, а при неоднозначном формате ответа — ограниченный параллельный fallback.
export async function activeRoster(teams, onProgress) {
  const active = (teams || []).filter((team) => team?.active !== false && team?.id);
  if (!active.length) return { members: [], warnings: [], endpoint: "" };

  const warnings = [];
  try {
    const endpoint = "/rest/tempo-teams/2/team/members";
    const body = await jira.request(endpoint, {
      method: "POST",
      body: { ids: active.map((team) => String(team.id)), onlyActive: true }
    });
    const rows = rowsOf(body, MEMBER_KEYS);
    const hasTeamMarkers = rows.some((row) => returnedTeamId(row) != null);
    if (hasTeamMarkers) {
      const members = [];
      for (const team of active) {
        const selection = selectActiveMembers(rows, team);
        members.push(...selection.members);
        warnings.push(...rosterWarnings(selection));
      }
      if (members.length) return { members, warnings: [...new Set(warnings)], endpoint };
    }
  } catch (error) {
    warnings.push(`Tempo bulk roster: ${error.message}`);
  }

  let next = 0;
  let completed = 0;
  const results = new Array(active.length);
  async function worker() {
    while (next < active.length) {
      const index = next++;
      const team = active[index];
      results[index] = await activeMembers(team);
      completed += 1;
      onProgress?.(completed, active.length, team);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, active.length) }, worker));
  return {
    members: results.flatMap((result) => result?.members || []),
    warnings: [...new Set([...warnings, ...results.flatMap((result) => result?.warnings || [])])],
    endpoint: "per-team"
  };
}
