// Выгрузка задач доски в IndexedDB: полная и инкрементальная.

import * as db from './db.js';
import { Dict, StatusDict, toMin, minToDate, nowMin, packSteps } from './codec.js';
import { t } from './i18n.js';

const BASE_FIELDS = [
  'summary', 'created', 'updated', 'resolutiondate',
  'status', 'issuetype', 'priority', 'assignee', 'labels', 'timeoriginalestimate', 'timespent',
];

/** Загружает словари из базы. */
export async function loadDicts() {
  const [statusRec, projRec, typeRec, prioRec, userRec, labelRec] = await Promise.all([
    db.getDictRecord('status'),
    db.getDictRecord('project'),
    db.getDictRecord('type'),
    db.getDictRecord('priority'),
    db.getDictRecord('user'),
    db.getDictRecord('label'),
  ]);
  return {
    status: StatusDict.fromRecord(statusRec),
    project: Dict.fromRecord(projRec, 'project'),
    type: Dict.fromRecord(typeRec, 'type'),
    priority: Dict.fromRecord(prioRec, 'priority'),
    user: Dict.fromRecord(userRec, 'user'),
    label: Dict.fromRecord(labelRec, 'label'),
  };
}

export async function saveDicts(dicts) {
  await db.putDictRecord(dicts.status.toRecord());
  for (const name of ['project', 'type', 'priority', 'user', 'label']) {
    await db.putDictRecord(dicts[name].toRecord());
  }
}

/** JQL-представление момента времени (минуты от эпохи). */
function jqlDate(min) {
  const d = minToDate(min);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Обновляет карточку доски: название, тип, колонки (имя + статусы).
 * Колонки нужны Control Chart: пользователь выбирает, время в каких
 * колонках считать циклом.
 */
export async function syncBoardMeta(client, board, dicts) {
  const conf = await client.boardConfiguration(board.id);
  const columns = (conf.columnConfig?.columns || []).map((col) => ({
    name: col.name,
    st: (col.statuses || [])
      .map((s) => dicts.status.codeOf(s.id))
      .filter((code) => code >= 0),
  }));
  const record = {
    id: Number(board.id),
    name: board.name || conf.name || t('board.fallbackName', { id: board.id }),
    type: board.type || conf.type || '',
    projectKey: board.location?.projectKey || conf.location?.projectKey || '',
    filterId: conf.filter?.id ? Number(conf.filter.id) : null,
    columns,
    estimationField: conf.estimation?.field?.fieldId || '',
    lastSyncMin: board.lastSyncMin ?? null,
    syncedAt: board.syncedAt ?? null,
  };
  await db.putBoard(record);
  return record;
}

/** Заполняет словарь статусов из /rest/api/2/status (там есть категории). */
export async function refreshStatusDict(client, dicts) {
  const list = await client.statuses();
  for (const st of list) {
    dicts.status.code(st.id, st.name, st.statusCategory?.key || '');
  }
  return dicts.status;
}

// ------------------------------------------------------- преобразование

function keyNumber(key) {
  const m = /-(\d+)$/.exec(key || '');
  return m ? Number(m[1]) : -1;
}

function projectPrefix(key) {
  const m = /^([^-]+)-/.exec(key || '');
  return m ? m[1] : '';
}

/**
 * История статусов задачи → массив шагов {t, s}.
 * Первый шаг — момент создания с исходным статусом.
 */
export function buildSteps(issue, dicts) {
  const createdMin = toMin(issue.fields?.created);
  const histories = (issue.changelog?.histories || []).slice().sort(
    (a, b) => Date.parse(a.created) - Date.parse(b.created),
  );

  const changes = [];
  for (const h of histories) {
    for (const item of h.items || []) {
      if ((item.field || item.fieldId) !== 'status') continue;
      changes.push({
        t: toMin(h.created),
        fromId: item.from,
        fromName: item.fromString,
        toId: item.to,
        toName: item.toString,
      });
    }
  }

  const currentStatus = issue.fields?.status;
  let initialCode;
  if (changes.length) {
    initialCode = dicts.status.code(changes[0].fromId, changes[0].fromName, '');
  } else {
    initialCode = dicts.status.code(currentStatus?.id, currentStatus?.name, currentStatus?.statusCategory?.key);
  }

  const steps = [{ t: createdMin, s: initialCode }];
  let prevT = createdMin;
  for (const ch of changes) {
    const code = dicts.status.code(ch.toId, ch.toName, '');
    const t = Math.max(prevT, ch.t);
    prevT = t;
    if (steps[steps.length - 1].s === code) continue; // защита от дублей
    steps.push({ t, s: code });
  }
  return steps;
}

/** Момент попадания в финальный «готовый» статус (по категории), иначе -1. */
export function doneMinute(steps, statusDict) {
  if (!steps.length) return -1;
  const last = steps[steps.length - 1];
  if (statusDict.category(last.s) !== 'done') return -1;
  let idx = steps.length - 1;
  while (idx > 0 && statusDict.category(steps[idx - 1].s) === 'done') idx--;
  return steps[idx].t;
}

/** Задача Jira → компактная запись IndexedDB. */
export function toRecord(issue, boardId, dicts, settings) {
  const f = issue.fields || {};
  const steps = buildSteps(issue, dicts);
  const createdMin = steps.length ? steps[0].t : toMin(f.created);
  const statusCode = dicts.status.code(f.status?.id, f.status?.name, f.status?.statusCategory?.key);

  const rec = {
    b: Number(boardId),
    i: Number(issue.id),
    k: keyNumber(issue.key),
    pj: dicts.project.code(projectPrefix(issue.key)),
    ty: dicts.type.code(f.issuetype?.name),
    pr: dicts.priority.code(f.priority?.name),
    c: createdMin,
    u: toMin(f.updated),
    r: toMin(f.resolutiondate),
    s: statusCode,
    dn: doneMinute(steps, dicts.status),
    tr: packSteps(steps),
  };

  if (settings.storeAssignee) {
    const assignee = f.assignee?.displayName || f.assignee?.name || '';
    if (assignee) rec.as = dicts.user.code(assignee);
  }
  if (settings.storeLabels && Array.isArray(f.labels) && f.labels.length) {
    rec.lb = f.labels.map((l) => dicts.label.code(l));
  }
  if (settings.storeSummaries && f.summary) {
    rec.su = String(f.summary).slice(0, settings.summaryMaxLen || 255);
  }
  const sp = settings.storyPointsField ? f[settings.storyPointsField] : null;
  if (typeof sp === 'number') rec.sp = sp;
  if (typeof f.timeoriginalestimate === 'number') rec.es = Math.round(f.timeoriginalestimate / 60);
  // Списанное на задачу время (сумма ворклогов), минуты.
  if (typeof f.timespent === 'number') rec.ts = Math.round(f.timespent / 60);

  return rec;
}

// ------------------------------------------------------------ синхронизация

/**
 * Выгружает задачи доски.
 * @param {JiraClient} client
 * @param {number} boardId
 * @param {object} settings — настройки расширения
 * @param {{full?:boolean, onProgress?:Function, signal?:{aborted:boolean}}} opts
 */
export async function syncBoard(client, boardId, settings, opts = {}) {
  const { full = false, onProgress = () => {}, signal = { aborted: false } } = opts;
  const startedAtMin = nowMin();
  const dicts = await loadDicts();

  onProgress({ phase: 'meta', message: t('sync.statuses') });
  await refreshStatusDict(client, dicts);

  const stored = (await db.getBoard(boardId)) || { id: Number(boardId) };
  onProgress({ phase: 'meta', message: t('sync.boardConfig') });
  const board = await syncBoardMeta(client, { ...stored, id: Number(boardId) }, dicts);

  const incremental = !full && Number.isFinite(stored.lastSyncMin);
  // Запас в сутки: JQL сравнивает в таймзоне сервера, плюс переписывание
  // записей идемпотентно (ключ ['b','i']).
  const since = incremental ? stored.lastSyncMin - 24 * 60 : null;
  const jql = incremental
    ? `updated >= "${jqlDate(since)}" ORDER BY created ASC`
    : 'ORDER BY created ASC';

  const fields = [...BASE_FIELDS];
  if (settings.storyPointsField) fields.push(settings.storyPointsField);
  const fieldsParam = fields.join(',');

  const pageSize = Math.max(10, Math.min(100, settings.pageSize || 50));
  let startAt = 0;
  let total = null;
  let saved = 0;
  let truncatedFixed = 0;

  for (;;) {
    if (signal.aborted) break;
    const page = await client.boardIssues(boardId, {
      startAt, maxResults: pageSize, jql, fields: fieldsParam,
    });
    total = page.total ?? total ?? 0;
    const issues = page.issues || [];
    if (!issues.length) break;

    const records = [];
    for (const issue of issues) {
      if (signal.aborted) break;
      let full_ = issue;
      const cl = issue.changelog;
      // Agile-выдача может обрезать историю — дочитываем задачу отдельно.
      if (cl && typeof cl.total === 'number' && cl.total > (cl.histories?.length || 0)) {
        try {
          const detailed = await client.issueChangelog(issue.id);
          full_ = { ...issue, changelog: detailed.changelog };
          truncatedFixed++;
        } catch { /* не смогли дочитать — используем то, что есть */ }
      }
      records.push(toRecord(full_, boardId, dicts, settings));
    }
    await db.putIssues(records);
    saved += records.length;
    startAt += issues.length;

    onProgress({
      phase: 'issues',
      saved,
      total,
      message: total ? t('sync.savedOf', { saved, total }) : t('sync.saved', { saved }),
    });

    if (startAt >= total) break;
    if (page.isLast) break;
  }

  await saveDicts(dicts);
  const patch = {
    syncedAt: Date.now(),
    lastSyncMin: signal.aborted ? stored.lastSyncMin ?? null : startedAtMin,
    issueCount: await db.countBoardIssues(boardId),
  };
  const updated = await db.patchBoard(boardId, patch);

  return {
    board: { ...board, ...updated },
    saved,
    total: total || saved,
    truncatedFixed,
    aborted: signal.aborted,
    incremental,
  };
}
