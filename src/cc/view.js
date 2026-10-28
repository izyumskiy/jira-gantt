// Вкладка Control Chart внутри OhMyGant: синхронизация досок, фильтры, график, таблицы, прогноз.
//
// Живёт на одной странице с Гантом, но изолированно: своя разметка (view.html вставляется в
// контейнер вкладки при первом открытии), свои сторы в общей базе, своя выгрузка. Общие с OhMyGant
// только подключение к Jira, язык и таблица людей («Команда»). Наружу — show() и setLanguage().

import * as db from './lib/db.js';
import { JiraClient } from './lib/jira.js';
import {
  loadSettings, saveSettings,
  hasHostPermission, requestHostPermission, getChartPrefs, setChartPrefs,
} from './lib/settings.js';
import { loadDicts, syncBoard } from './lib/sync.js';
import {
  buildChart, statusSet, statusUsage, mappedStatuses,
  defaultCycleStatuses, defaultDoneStatuses, byAssignee, rollingAverage, summarize,
} from './lib/control-chart.js';
import { ControlChart } from './lib/chart.js';
import {
  completions, weeklyThroughput, throughputStats, forecast, dateAfterWeeks,
} from './lib/forecast.js';
import * as tour from './tour.js';
import { teamProfiles, normName, roleLabel, statusLabel } from './people.js';
import { nowMin, toMin as dateToMin, minToDate, MIN_PER_DAY } from './lib/codec.js';
import {
  formatDuration, formatDate, formatDateTime, formatIsoDate, formatBytes, escapeHtml,
} from './lib/format.js';
import {
  t, tn, setLocale, detectLocale, applyStatic, intlTag,
} from './lib/i18n.js';

// Все запросы к разметке — внутри своего контейнера: на странице рядом разметка Ганта.
let root = document;
const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];

// Связь с OhMyGant: { openSettings() } — открыть его настройки подключения.
let host = { openSettings: () => {} };

const freshState = () => ({
  settings: null,
  dicts: null,
  board: null,
  issues: [],
  data: null,
  picked: null,          // Set id задач, выбранных кликом по графику
  highlight: null,       // код исполнителя, подсвеченного на графике
  highlightTeam: null,   // команда, подсвеченная на графике (режим «Команды» в сравнении)
  peopleMode: 'person',  // сравнение: 'person' — по людям, 'team' — по командам
  profiles: new Map(),   // профили из общей таблицы людей («Команда»), ключ — нормализованное имя
  peopleSort: { field: 'name', dir: 1 },
  sort: { field: 'cycle', dir: -1 },
  search: '',
  syncSignal: null,
  usage: new Map(),      // код статуса → {issues, minutes} по выгруженным задачам
  forecast: { rows: [], result: null },
  pendingSelection: null, // сохранённый выбор статусов до загрузки словаря
  filters: {
    days: 180,
    from: null,
    to: null,
    cycle: new Set(),    // коды статусов, время в которых считается циклом
    done: new Set(),     // коды статусов, означающих «Готово»
    types: null,         // Set кодов типов или null (все)
    assignees: null,     // Set кодов исполнителей или null (все)
    rollingPercent: 10,
  },
  chartOptions: {
    showBand: true, showRolling: true, showAverage: true, showP85: true,
    logScale: false, excludeOutliers: false,
  },
});

let state = freshState();
let chart = null;
let mounted = null; // промис первой отрисовки вкладки

// ------------------------------------------------------------- утилиты

/** Открывает справку (docs/cc/HOWTO.md) в новой вкладке. */
function openHelp(anchor = '') {
  const url = new URL('./help.html', import.meta.url);
  if (anchor) url.hash = anchor;
  window.open(url.href, '_blank', 'noopener');
}

function banner(message, kind = 'err') {
  const node = $('#banner');
  if (!message) {
    node.hidden = true;
    return;
  }
  node.textContent = message;
  node.className = `banner ${kind === 'info' ? 'info' : ''}`;
  node.hidden = false;
}

function client() {
  return new JiraClient({
    baseUrl: state.settings.baseUrl,
    authMode: state.settings.authMode,
    token: state.settings.token,
  });
}

function issueKey(point) {
  const prefix = state.dicts.project.name_(point.pj) || state.board?.projectKey || '';
  return prefix ? `${prefix}-${point.k}` : String(point.k);
}

function issueUrl(point) {
  const base = state.settings.baseUrl;
  return base ? `${base}/browse/${issueKey(point)}` : null;
}

/** Смена языка в OhMyGant: перерисовываем всё, что содержит текст. */
async function applyLocale(code) {
  setLocale(code);
  applyStatic(root);
  await updateConnState();
  if (state.board) {
    $('#board-name').textContent = state.board.name
      || t('board.fallbackName', { id: state.board.id });
    renderBoardMeta();
    renderStatusFilters();
    renderTypeFilter();
    renderAssigneeFilter();
    recompute();
  }
}

/** Подпись под названием доски: сколько задач и когда обновлялось. */
function renderBoardMeta() {
  if (!state.board) return;
  const synced = state.board.syncedAt
    ? t('board.synced', { time: formatDateTime(dateToMin(state.board.syncedAt)) })
    : t('board.neverSynced');
  $('#board-meta').textContent = `${tn('plural.issue', state.issues.length)} · ${synced}`;
}

async function updateConnState() {
  const pill = $('#conn-state');
  const url = state.settings.baseUrl;
  if (!url) {
    pill.textContent = t('conn.none');
    pill.className = 'pill pill-off';
    return false;
  }
  const granted = await hasHostPermission(url);
  pill.textContent = granted ? new URL(url).host : t('conn.noHost');
  pill.className = `pill ${granted ? 'pill-on' : 'pill-off'}`;
  $('#btn-sync').disabled = !granted || !state.board;
  $('#btn-sync-full').disabled = !granted || !state.board;
  return granted;
}

// ------------------------------------------------------------- запуск

async function init() {
  state.settings = await loadSettings();
  setLocale(state.settings.locale || detectLocale());
  applyStatic(root);
  state.dicts = await loadDicts();
  state.profiles = await loadProfiles();

  chart = new ControlChart($('#chart'), {
    onZoom: (from, to) => {
      if (from === null) {
        state.filters.from = null;
        state.filters.to = null;
        state.filters.days = 0;
      } else {
        state.filters.from = from;
        state.filters.to = to;
        state.filters.days = null;
      }
      syncRangeInputs();
      recompute();
    },
    onPick: (items) => {
      if (items.length === 1) {
        const url = issueUrl(items[0]);
        if (url) window.open(url, '_blank', 'noopener');
        return;
      }
      state.picked = new Set(items.map((p) => p.i));
      $('#btn-clear-pick').hidden = false;
      renderTable();
      $('.table-wrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
  });
  chart.setContext({
    typeName: (code) => state.dicts.type.name_(code),
    projectKey: (code) => state.dicts.project.name_(code) || state.board?.projectKey || '',
    statusName: (code) => state.dicts.status.name_(code),
  });

  wireEvents();
  await updateConnState();

  const boards = await db.getBoards();
  const lastId = state.settings.lastBoardId;
  const board = boards.find((b) => b.id === lastId) || boards[0] || null;
  if (board) {
    await selectBoard(board.id);
  } else if (!state.settings.baseUrl) {
    banner(t('app.needSetup'), 'info');
  } else {
    banner(t('app.needBoard'), 'info');
  }
}

/**
 * Показ вкладки. Первый раз — вставляет разметку и запускает панель; дальше только перечитывает
 * настройки: адрес Jira или PAT могли поменять в OhMyGant, пока вкладка была скрыта.
 * @param {HTMLElement} container — #page-cc
 * @param {{openSettings?: Function, tour?: boolean}} opts
 */
export async function show(container, opts = {}) {
  if (opts.openSettings) host = { ...host, openSettings: opts.openSettings };
  if (!mounted) mounted = mount(container);
  else {
    await mounted;
    state.settings = await loadSettings();
    await updateConnState();
    // Команды и роли могли поменять во вкладке «Команда», пока Control Chart был скрыт.
    state.profiles = await loadProfiles();
    if (state.board) {
      renderAssigneeFilter();
      recompute();
    }
  }
  await mounted;
  if (opts.tour && !tour.isActive()) tour.start();
}

async function mount(container) {
  const html = await (await fetch(new URL('./view.html', import.meta.url))).text();
  container.innerHTML = html;
  root = container;
  state = freshState();
  try {
    await init();
  } catch (err) {
    banner(t('app.startError', { message: err.message }));
  }
}

/** После удаления данных — та же вкладка с нуля (раньше это был перезапуск страницы). */
async function remount() {
  if (tour.isActive()) tour.stop();
  chart?.destroy?.();
  chart = null;
  const container = root;
  mounted = mount(container);
  await mounted;
}

/** Язык меняется в OhMyGant; вкладка, которую ещё не открывали, подхватит его при запуске. */
export async function setLanguage(code) {
  if (!mounted) return;
  await mounted;
  await applyLocale(code);
}

function wireEvents() {
  $('#btn-setup').addEventListener('click', openSetup);
  $('#btn-host-settings').addEventListener('click', () => {
    $('#dlg-setup').close();
    host.openSettings();
  });
  $('#assignee-all').addEventListener('click', () => {
    // null означает «выбраны все»; пустое множество — «не выбран никто».
    state.filters.assignees = state.filters.assignees ? null : new Set();
    renderAssigneeFilter();
    recompute();
  });
  $('#btn-save-setup').addEventListener('click', saveSetup);
  $('#btn-test').addEventListener('click', testConnection);
  $('#board-picker').addEventListener('click', openBoards);
  $('#btn-boards-close').addEventListener('click', () => $('#dlg-boards').close());
  $('#btn-load-boards').addEventListener('click', loadBoardsFromJira);
  $('#board-search').addEventListener('input', renderBoardsList);
  $('#btn-sync').addEventListener('click', () => doSync(false));
  $('#btn-sync-full').addEventListener('click', () => doSync(true));
  $('#btn-cancel').addEventListener('click', () => { if (state.syncSignal) state.syncSignal.aborted = true; });
  $('#btn-storage').addEventListener('click', openStorage);
  $('#btn-forecast').addEventListener('click', openForecast);
  $('#btn-fc-close').addEventListener('click', () => $('#dlg-forecast').close());
  $('#btn-fc-copy').addEventListener('click', copyForecastSummary);
  $('#btn-fc-csv').addEventListener('click', exportThroughputCsv);
  $('#fc-history').addEventListener('change', () => {
    computeForecastFlow();
    renderForecastRows();
    recomputeForecast();
  });
  for (const id of ['#fc-start', '#fc-growth']) {
    $(id).addEventListener('input', recomputeForecast);
  }
  $('#btn-help').addEventListener('click', () => openHelp());
  $('#btn-tour').addEventListener('click', () => tour.toggle());
  $('#hint-cycle').addEventListener('click', () => openHelp(t('help.anchorSample')));
  $('#btn-storage-close').addEventListener('click', () => $('#dlg-storage').close());
  $('#btn-diag-close').addEventListener('click', () => $('#dlg-diag').close());
  $('#btn-csv').addEventListener('click', exportCsv);
  $('#btn-clear-pick').addEventListener('click', () => {
    state.picked = null;
    $('#btn-clear-pick').hidden = true;
    renderTable();
  });

  $('#range-presets').addEventListener('click', (event) => {
    const button = event.target.closest('.chip');
    if (!button) return;
    $$('#range-presets .chip').forEach((c) => c.classList.toggle('is-active', c === button));
    state.filters.days = Number(button.dataset.days);
    state.filters.from = null;
    state.filters.to = null;
    syncRangeInputs();
    recompute();
  });

  for (const id of ['#date-from', '#date-to']) {
    $(id).addEventListener('change', () => {
      const from = $('#date-from').value;
      const to = $('#date-to').value;
      state.filters.from = from ? dateToMin(new Date(`${from}T00:00:00`)) : null;
      state.filters.to = to ? dateToMin(new Date(`${to}T23:59:00`)) : null;
      state.filters.days = null;
      $$('#range-presets .chip').forEach((c) => c.classList.remove('is-active'));
      recompute();
    });
  }

  $('#rolling').addEventListener('input', (event) => {
    state.filters.rollingPercent = Number(event.target.value);
    $('#rolling-out').textContent = `${event.target.value}%`;
    recompute();
  });

  const optionMap = {
    '#opt-band': 'showBand',
    '#opt-rolling': 'showRolling',
    '#opt-avg': 'showAverage',
    '#opt-p85': 'showP85',
    '#opt-log': 'logScale',
    '#opt-outliers': 'excludeOutliers',
  };
  for (const [sel, key] of Object.entries(optionMap)) {
    $(sel).addEventListener('change', (event) => {
      state.chartOptions[key] = event.target.checked;
      recompute();
    });
  }

  $('#table-search').addEventListener('input', (event) => {
    state.search = event.target.value.trim().toLowerCase();
    renderTable();
  });

  $('#people-mode').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (chip) setPeopleMode(chip.dataset.mode);
  });

  $$('#people-table th[data-psort]').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.psort;
      state.peopleSort = state.peopleSort.field === field
        ? { field, dir: -state.peopleSort.dir }
        : { field, dir: field === 'name' ? 1 : -1 };
      renderPeople();
    });
  });

  $$('#issues-table th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const field = th.dataset.sort;
      state.sort = state.sort.field === field
        ? { field, dir: -state.sort.dir }
        : { field, dir: field === 'su' || field === 'key' ? 1 : -1 };
      renderTable();
    });
  });

  $('#btn-drop-summaries').addEventListener('click', async () => {
    if (!state.board) return;
    const { trimmed } = await db.vacuumBoard(state.board.id, { dropSummaries: true });
    await saveSettings({ storeSummaries: false });
    state.settings.storeSummaries = false;
    banner(t('storage.summariesDropped', { issues: tn('plural.issue', trimmed) }), 'info');
    await openStorage();
    await loadBoardData();
  });

  $('#btn-drop-old').addEventListener('click', async () => {
    if (!state.board) return;
    const cutoff = nowMin() - 365 * MIN_PER_DAY;
    const { removed } = await db.vacuumBoard(state.board.id, { olderThanMin: cutoff });
    banner(t('storage.oldRemoved', { issues: tn('plural.issue', removed) }), 'info');
    await openStorage();
    await loadBoardData();
  });

  $('#btn-drop-board').addEventListener('click', async () => {
    if (!state.board) return;
    if (!confirm(t('storage.confirmBoard', { name: state.board.name }))) return;
    await db.deleteBoard(state.board.id);
    await saveSettings({ lastBoardId: null });
    $('#dlg-storage').close();
    await remount();
  });

  $('#btn-wipe').addEventListener('click', async () => {
    if (!confirm(t('storage.confirmWipe'))) return;
    await db.wipeAll();
    await saveSettings({ lastBoardId: null });
    $('#dlg-storage').close();
    await remount();
  });
}

// -------------------------------------------------------- подключение

function openSetup() {
  const s = state.settings;
  $('#setup-conn').textContent = s.baseUrl
    ? t('setup.connValue', { host: hostOf(s.baseUrl), auth: s.token ? t('setup.connPat') : t('setup.connCookie') })
    : t('setup.connNone');
  $('#in-sp-field').value = s.storyPointsField;
  $('#in-store-summary').checked = s.storeSummaries;
  $('#in-summary-len').value = s.summaryMaxLen;
  $('#in-store-assignee').checked = s.storeAssignee;
  $('#in-store-labels').checked = s.storeLabels;
  $('#setup-msg').textContent = '';
  $('#setup-msg').className = 'dialog-msg';
  $('#dlg-setup').showModal();
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function setupValues() {
  return {
    storyPointsField: $('#in-sp-field').value.trim(),
    storeSummaries: $('#in-store-summary').checked,
    summaryMaxLen: Math.max(20, Math.min(255, Number($('#in-summary-len').value) || 255)),
    storeAssignee: $('#in-store-assignee').checked,
    storeLabels: $('#in-store-labels').checked,
  };
}

function setupMessage(text, kind = '') {
  const node = $('#setup-msg');
  node.textContent = text;
  node.className = `dialog-msg ${kind}`;
}

/** Проверка общего подключения; заодно находит поле Story Points, если оно не задано. */
async function testConnection() {
  const values = setupValues();
  state.settings = { ...state.settings, ...(await loadSettings()) };
  const { baseUrl } = state.settings;
  if (!baseUrl) return setupMessage(t('setup.badUrl'), 'err');
  setupMessage(t('setup.requesting'));
  const granted = await requestHostPermission(baseUrl);
  if (!granted) return setupMessage(t('setup.needPermission'), 'err');

  const probe = client();
  try {
    setupMessage(t('setup.testing'));
    const [me, info] = await Promise.all([probe.myself(), probe.serverInfo().catch(() => null)]);
    let spField = values.storyPointsField;
    if (!spField) {
      spField = await probe.detectStoryPointsField().catch(() => '');
      if (spField) $('#in-sp-field').value = spField;
    }
    setupMessage(t('setup.testOk', {
      user: me.displayName || me.name,
      version: info?.version ? t('setup.testVersion', { version: info.version }) : '',
      sp: spField ? t('setup.testSp', { field: spField }) : '',
    }), 'ok');
  } catch (err) {
    setupMessage(err.message, 'err');
  }
  return undefined;
}

async function saveSetup() {
  state.settings = await saveSettings(setupValues());
  await updateConnState();
  banner('');
  $('#dlg-setup').close();
}

// ------------------------------------------------------------- доски

let boardsCache = [];

async function openBoards() {
  boardsCache = await db.getBoards();
  renderBoardsList();
  $('#dlg-boards').showModal();
  if (!boardsCache.length) loadBoardsFromJira();
}

async function loadBoardsFromJira() {
  if (!state.settings.baseUrl) {
    $('#boards-list').innerHTML = `<div class="muted">${escapeHtml(t('boards.needSetup'))}</div>`;
    return;
  }
  if (!(await hasHostPermission(state.settings.baseUrl))) {
    const granted = await requestHostPermission(state.settings.baseUrl);
    if (!granted) return;
  }
  $('#boards-list').innerHTML = `<div class="muted">${escapeHtml(t('boards.loading'))}</div>`;
  try {
    const remote = await client().boards();
    const local = new Map((await db.getBoards()).map((b) => [b.id, b]));
    boardsCache = remote.map((b) => ({
      id: Number(b.id),
      name: b.name,
      type: b.type,
      projectKey: b.location?.projectKey || '',
      issueCount: local.get(Number(b.id))?.issueCount ?? null,
      syncedAt: local.get(Number(b.id))?.syncedAt ?? null,
    }));
    renderBoardsList();
  } catch (err) {
    $('#boards-list').innerHTML = `<div class="muted">${escapeHtml(err.message)}</div>`;
  }
}

function renderBoardsList() {
  const query = $('#board-search').value.trim().toLowerCase();
  const list = boardsCache.filter((b) => !query || (b.name || '').toLowerCase().includes(query));
  const container = $('#boards-list');
  container.innerHTML = '';
  if (!list.length) {
    container.innerHTML = `<div class="muted">${escapeHtml(t('boards.empty'))}</div>`;
    return;
  }
  for (const board of list.slice(0, 300)) {
    const button = document.createElement('button');
    button.className = `board-item${state.board?.id === board.id ? ' is-current' : ''}`;
    const synced = board.syncedAt ? `· ${tn('plural.issue', board.issueCount || 0)}` : '';
    button.innerHTML = `<span>${escapeHtml(board.name || t('board.fallbackName', { id: board.id }))}</span>
      <span class="b-type">${escapeHtml(board.projectKey || '')} ${escapeHtml(board.type || '')} ${synced}</span>`;
    button.addEventListener('click', async () => {
      $('#dlg-boards').close();
      await selectBoard(board.id, board);
    });
    container.appendChild(button);
  }
}

async function selectBoard(boardId, remote = null) {
  let board = await db.getBoard(boardId);
  if (!board && remote) {
    board = {
      id: Number(boardId), name: remote.name, type: remote.type,
      projectKey: remote.projectKey, columns: [], lastSyncMin: null, syncedAt: null,
    };
    await db.putBoard(board);
  }
  if (!board) return;
  state.board = board;
  state.settings = await saveSettings({ lastBoardId: board.id });
  $('#board-name').textContent = board.name || t('board.fallbackName', { id: board.id });
  await updateConnState();

  restorePrefs(await getChartPrefs(board.id));
  await loadBoardData();

  if (!board.syncedAt) {
    banner(t('app.boardEmpty'), 'info');
  }
}

/**
 * Восстанавливает сохранённые настройки доски. Статусы возвращаем не сразу:
 * их коды известны только после загрузки словаря, поэтому кладём в
 * `pendingSelection` и разбираем в `resolveSelection`.
 */
function restorePrefs(prefs) {
  state.pendingSelection = null;
  state.filters.cycle = new Set();
  state.filters.done = new Set();
  state.filters.types = null;
  if (!prefs) return;

  const f = prefs.filters || {};
  if (f.days !== undefined) state.filters.days = f.days;
  state.filters.from = f.from ?? null;
  state.filters.to = f.to ?? null;
  state.filters.rollingPercent = f.rollingPercent ?? state.filters.rollingPercent;
  state.chartOptions = { ...state.chartOptions, ...(prefs.chartOptions || {}) };
  state.pendingSelection = {
    cycleIds: f.cycleStatusIds || null,
    doneIds: f.doneStatusIds || null,
    // формат до перехода на выбор по статусам — имена колонок
    cycleColumns: f.cycleColumns || null,
    doneColumns: f.doneColumns || null,
  };
  applyOptionInputs();
}

/** Превращает сохранённый выбор в коды статусов; иначе берёт значения по умолчанию. */
function resolveSelection() {
  const dict = state.dicts.status;
  const board = state.board;
  const byIds = (ids) => new Set((ids || []).map((id) => dict.codeOf(id)).filter((code) => code >= 0));
  const pending = state.pendingSelection;

  if (pending) {
    if (pending.cycleIds) state.filters.cycle = byIds(pending.cycleIds);
    else if (pending.cycleColumns) state.filters.cycle = statusSet(board, pending.cycleColumns);
    if (pending.doneIds) state.filters.done = byIds(pending.doneIds);
    else if (pending.doneColumns) state.filters.done = statusSet(board, pending.doneColumns);
    state.pendingSelection = null;
  }
  if (!state.filters.cycle.size) state.filters.cycle = new Set(defaultCycleStatuses(board, dict));
  if (!state.filters.done.size) state.filters.done = new Set(defaultDoneStatuses(board, dict));
}

function applyOptionInputs() {
  $('#opt-band').checked = state.chartOptions.showBand;
  $('#opt-rolling').checked = state.chartOptions.showRolling;
  $('#opt-avg').checked = state.chartOptions.showAverage;
  $('#opt-p85').checked = state.chartOptions.showP85;
  $('#opt-log').checked = state.chartOptions.logScale;
  $('#opt-outliers').checked = state.chartOptions.excludeOutliers;
  $('#rolling').value = state.filters.rollingPercent;
  $('#rolling-out').textContent = `${state.filters.rollingPercent}%`;
  $$('#range-presets .chip').forEach((c) => {
    c.classList.toggle('is-active', Number(c.dataset.days) === state.filters.days);
  });
}

// ------------------------------------------------------ синхронизация

async function doSync(full) {
  if (!state.board) return;
  if (!(await hasHostPermission(state.settings.baseUrl))) {
    const granted = await requestHostPermission(state.settings.baseUrl);
    if (!granted) return;
  }
  const signal = { aborted: false };
  state.syncSignal = signal;
  $('#progress-text').textContent = t('progress.title');
  $('#progress').hidden = false;
  $('#btn-sync').disabled = true;
  $('#btn-sync-full').disabled = true;
  banner('');

  try {
    const result = await syncBoard(client(), state.board.id, state.settings, {
      full,
      signal,
      onProgress: (p) => {
        $('#progress-text').textContent = p.message;
        const pct = p.total ? Math.min(100, Math.round((p.saved / p.total) * 100)) : 0;
        $('#progress-fill').style.width = `${pct}%`;
      },
    });
    state.board = result.board;
    state.dicts = await loadDicts();
    await loadBoardData();
    banner(t('sync.result', {
      mode: result.incremental ? t('sync.modeIncremental') : t('sync.modeFull'),
      issues: tn('plural.issue', result.saved),
      changelog: result.truncatedFixed ? t('sync.changelog', { count: result.truncatedFixed }) : '',
      aborted: result.aborted ? t('sync.aborted') : '',
    }), 'info');
  } catch (err) {
    banner(err.message, 'err');
  } finally {
    state.syncSignal = null;
    $('#progress').hidden = true;
    $('#progress-fill').style.width = '0';
    await updateConnState();
  }
}

// ----------------------------------------------------------- данные

async function loadBoardData() {
  if (!state.board) return;
  state.issues = await db.getBoardIssues(state.board.id);
  renderBoardMeta();
  state.usage = statusUsage(state.issues);
  resolveSelection();
  renderStatusFilters();
  renderTypeFilter();
  renderAssigneeFilter();
  recompute();
}

/** Группы статусов: колонки доски + отдельная группа для незамапленных. */
function statusGroups() {
  const mapped = mappedStatuses(state.board);
  const groups = (state.board?.columns || []).map((col) => ({
    name: col.name,
    codes: col.st || [],
  }));
  const unmapped = [...state.usage.keys()]
    .filter((code) => !mapped.has(code))
    .sort((a, b) => (state.usage.get(b)?.issues || 0) - (state.usage.get(a)?.issues || 0));
  if (unmapped.length) {
    groups.push({ name: t('filters.unmapped'), codes: unmapped, unmapped: true });
  }
  return groups;
}

/**
 * Списки статусов для цикла и «Готово». Статусы сгруппированы по колонкам
 * доски; галка на заголовке колонки включает всю группу разом.
 */
function renderStatusFilters() {
  const groups = statusGroups();
  for (const [selector, key] of [['#cycle-statuses', 'cycle'], ['#done-statuses', 'done']]) {
    const container = $(selector);
    const scroll = container.scrollTop;
    container.innerHTML = '';
    if (!groups.length) {
      container.innerHTML = `<div class="muted">${escapeHtml(t('filters.noStatuses'))}</div>`;
      continue;
    }
    for (const group of groups) container.appendChild(statusGroupNode(group, key));
    container.scrollTop = scroll;
  }
}

function statusGroupNode(group, key) {
  const dict = state.dicts.status;
  const selected = state.filters[key];
  const wrap = document.createElement('div');
  wrap.className = `st-group${group.unmapped ? ' is-unmapped' : ''}`;

  const head = document.createElement('label');
  head.className = 'check st-head';
  const headBox = document.createElement('input');
  headBox.type = 'checkbox';
  const boxes = [];

  const syncHead = () => {
    const chosen = group.codes.filter((code) => selected.has(code)).length;
    headBox.checked = chosen > 0 && chosen === group.codes.length;
    headBox.indeterminate = chosen > 0 && chosen < group.codes.length;
  };

  headBox.addEventListener('change', () => {
    for (const code of group.codes) {
      if (headBox.checked) selected.add(code);
      else selected.delete(code);
    }
    for (const box of boxes) box.input.checked = headBox.checked;
    syncHead();
    recompute();
  });

  const title = document.createElement('span');
  title.textContent = group.name;
  head.append(headBox, title);

  if (group.unmapped) {
    const mark = document.createElement('span');
    mark.className = 'st-warn';
    mark.textContent = '!';
    mark.title = t('filters.unmappedTitle');
    head.appendChild(mark);
  }
  wrap.appendChild(head);

  for (const code of group.codes) {
    const row = document.createElement('label');
    row.className = 'check st-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selected.has(code);
    input.addEventListener('change', () => {
      if (input.checked) selected.add(code);
      else selected.delete(code);
      syncHead();
      recompute();
    });

    const name = document.createElement('span');
    name.textContent = dict.name_(code) || String(code);

    const use = state.usage.get(code);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = use ? String(use.issues) : '0';
    row.title = use
      ? t('filters.statusUsage', { count: use.issues, time: formatDuration(use.minutes) })
      : t('filters.statusUnused');

    row.append(input, name, count);
    boxes.push({ code, input });
    wrap.appendChild(row);
  }

  syncHead();
  return wrap;
}

function renderTypeFilter() {
  const counts = new Map();
  for (const rec of state.issues) counts.set(rec.ty, (counts.get(rec.ty) || 0) + 1);
  const container = $('#type-filter');
  container.innerHTML = '';
  const codes = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  if (!codes.length) {
    container.innerHTML = `<div class="muted">${escapeHtml(t('filters.noData'))}</div>`;
    return;
  }
  for (const code of codes) {
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !state.filters.types || state.filters.types.has(code);
    input.addEventListener('change', () => {
      const selected = new Set();
      container.querySelectorAll('input').forEach((box, i) => {
        if (box.checked) selected.add(codes[i]);
      });
      state.filters.types = selected.size === codes.length ? null : selected;
      recompute();
    });
    const text = document.createElement('span');
    text.textContent = state.dicts.type.name_(code) || t('units.unknown');
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = counts.get(code);
    label.append(input, text, count);
    container.appendChild(label);
  }
}

/** Имя исполнителя по коду; -1 — задачи без исполнителя. */
function assigneeName(code) {
  return code === -1 ? t('people.unassigned') : (state.dicts.user.name_(code) || t('people.unassigned'));
}

// ------------------------------------------- общая таблица людей («Команда»)

async function loadProfiles() {
  try {
    return await teamProfiles();
  } catch {
    return new Map(); // без профилей — просто без команд и ролей
  }
}

/** Профиль человека из «Команды» по коду исполнителя. */
function profileOf(code) {
  if (code === -1) return null;
  return state.profiles.get(normName(state.dicts.user.name_(code))) || null;
}

function teamOf(code) {
  return profileOf(code)?.team || '';
}

/** Подпись команды; '' — «Без команды». */
function teamLabel(team) {
  return team || t('people.noTeam');
}

/** Пометки человека: роль, аутстаф, уволен — из общей таблицы людей. */
function personMarks(code) {
  const prof = profileOf(code);
  const marks = [];
  if (prof?.role) marks.push({ text: roleLabel(prof.role), cls: 'p-role' });
  if (prof?.status === 'outstaff' || prof?.status === 'fired') {
    marks.push({ text: statusLabel(prof.status), cls: `p-${prof.status}` });
  }
  return marks;
}

function appendMarks(node, code) {
  for (const mark of personMarks(code)) {
    const tag = document.createElement('span');
    tag.className = `p-mark ${mark.cls}`;
    tag.textContent = mark.text;
    node.appendChild(tag);
  }
}

function renderAssigneeFilter() {
  const counts = new Map();
  for (const rec of state.issues) {
    const code = rec.as ?? -1;
    counts.set(code, (counts.get(code) || 0) + 1);
  }
  const container = $('#assignee-filter');
  const toggle = $('#assignee-all');
  container.innerHTML = '';

  // Единственная группа «не назначен» означает, что исполнителей не выгружали.
  const onlyUnassigned = counts.size <= 1 && counts.has(-1);
  if (!counts.size || onlyUnassigned) {
    const message = state.settings.storeAssignee && !onlyUnassigned
      ? t('filters.noData') : t('filters.assigneesOff');
    container.innerHTML = `<div class="muted">${escapeHtml(message)}</div>`;
    toggle.hidden = true;
    return;
  }
  toggle.hidden = false;
  toggle.classList.toggle('is-empty', Boolean(state.filters.assignees) && state.filters.assignees.size === 0);

  const codes = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
  const boxes = new Map(); // код → чекбокс человека
  const commit = () => {
    const selected = new Set(codes.filter((code) => boxes.get(code).checked));
    state.filters.assignees = selected.size === codes.length ? null : selected;
    syncTeamBoxes();
    recompute();
  };

  const personRow = (code, indent) => {
    const label = document.createElement('label');
    label.className = `check${indent ? ' team-member' : ''}${profileOf(code)?.status === 'fired' ? ' is-fired' : ''}`;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !state.filters.assignees || state.filters.assignees.has(code);
    input.addEventListener('change', commit);
    boxes.set(code, input);
    const text = document.createElement('span');
    text.className = 'p-name';
    text.textContent = assigneeName(code);
    appendMarks(text, code);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = counts.get(code);
    label.append(input, text, count);
    return label;
  };

  // Команды — из общей таблицы людей. Если ни у кого команды нет, группировать нечего.
  const teamBoxes = [];
  const syncTeamBoxes = () => {
    for (const { box, members } of teamBoxes) {
      const on = members.filter((code) => boxes.get(code).checked).length;
      box.checked = on === members.length;
      box.indeterminate = on > 0 && on < members.length;
    }
  };
  const byTeam = new Map();
  for (const code of codes) {
    const team = teamOf(code);
    if (!byTeam.has(team)) byTeam.set(team, []);
    byTeam.get(team).push(code);
  }
  if (byTeam.size === 1 && byTeam.has('')) {
    for (const code of codes) container.appendChild(personRow(code, false));
    return;
  }
  const teams = [...byTeam.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b, 'ru'));
  for (const team of teams) {
    const members = byTeam.get(team);
    const head = document.createElement('label');
    head.className = 'check team-head';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.title = t('filters.teamToggle');
    box.addEventListener('change', () => {
      for (const code of members) boxes.get(code).checked = box.checked;
      commit();
    });
    teamBoxes.push({ box, members });
    const name = document.createElement('span');
    name.textContent = teamLabel(team);
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = members.reduce((sum, code) => sum + counts.get(code), 0);
    head.append(box, name, count);
    container.appendChild(head);
    for (const code of members) container.appendChild(personRow(code, true));
  }
  syncTeamBoxes();
}

// ------------------------------------------------- сравнение по людям

/**
 * Режим сравнения, который сейчас действует: «Команды» — только когда в выборке есть люди с командой.
 * Выбор пользователя при этом не трогаем: опустела выборка — вернётся, как только появятся команды.
 */
function peopleModeNow() {
  return state.peopleMode === 'team' && hasTeams() ? 'team' : 'person';
}

/** Строки таблицы сравнения из точек, уже прошедших все фильтры: по людям или по командам. */
function peopleRows() {
  const points = state.data?.points || [];
  let rows;
  if (peopleModeNow() === 'team') {
    // Команда — из общей таблицы людей; её точки — точки всех её людей.
    const groups = new Map();
    for (const point of points) {
      const team = teamOf(point.as ?? -1);
      if (!groups.has(team)) groups.set(team, []);
      groups.get(team).push(point);
    }
    rows = [...groups.entries()].map(([team, list]) => ({
      team, name: teamLabel(team), points: list, codes: new Set(list.map((pt) => pt.as ?? -1)), stats: summarize(list),
    }));
  } else {
    rows = byAssignee(points).map(({ code, points: list, stats }) => ({
      code, name: assigneeName(code), team: teamOf(code), points: list, stats,
    }));
  }
  rows = rows.map((row) => ({
    ...row,
    count: row.stats.count,
    median: row.stats.median,
    p85: row.stats.p85,
    sd: row.stats.sd,
    ratio: row.stats.median > 0 ? row.stats.p85 / row.stats.median : 0,
  }));
  const { field, dir } = state.peopleSort;
  return rows.sort((a, b) => {
    if (field === 'name') return a.name.localeCompare(b.name, 'ru') * dir;
    if (field === 'team') return (teamLabel(a.team).localeCompare(teamLabel(b.team), 'ru') || a.name.localeCompare(b.name, 'ru')) * dir;
    return (a[field] - b[field]) * dir;
  });
}

const FEW_ISSUES = 20; // ниже этого порога перцентили не показываем всерьёз

/** Есть ли у кого-то из исполнителей выборки команда в общей таблице людей. */
function hasTeams() {
  return (state.data?.points || []).some((point) => teamOf(point.as ?? -1));
}

function renderPeople() {
  const teams = hasTeams();
  const byTeam = peopleModeNow() === 'team';
  const rows = peopleRows();
  const body = $('#people-table tbody');
  body.innerHTML = '';
  // По людям таблица нужна от двух человек; по командам — уже с одной (видно, кого сравниваем).
  $('#people-wrap').hidden = byTeam ? rows.length < 1 : rows.length < 2;
  $('#people-mode').hidden = !teams;
  $$('#people-mode .chip').forEach((chip) => chip.classList.toggle('is-active', chip.dataset.mode === peopleModeNow()));
  // В режиме «Команды» первая колонка — сама команда, отдельная колонка команды не нужна.
  const nameHead = $('#people-table th[data-psort="name"]');
  nameHead.textContent = t(byTeam ? 'people.colTeam' : 'people.colName');
  $('#people-table th[data-psort="team"]').hidden = byTeam || !teams;
  $('#people-hint').textContent = t(byTeam ? 'people.hintTeam' : 'people.hint');
  if ($('#people-wrap').hidden) return;

  for (const row of rows) {
    const tr = document.createElement('tr');
    const picked = byTeam ? state.highlightTeam === row.team : state.highlight === row.code;
    if (picked) tr.className = 'is-picked';

    const few = row.count < FEW_ISSUES;
    const nameCell = document.createElement('td');
    nameCell.textContent = row.name;
    if (!byTeam) appendMarks(nameCell, row.code);
    tr.appendChild(nameCell);
    if (!byTeam && teams) {
      const teamCell = document.createElement('td');
      teamCell.className = 'muted';
      teamCell.textContent = row.team || '—';
      tr.appendChild(teamCell);
    }
    const cells = [
      String(row.count),
      formatDuration(row.median),
      formatDuration(row.p85),
      formatDuration(row.sd),
      row.ratio ? row.ratio.toFixed(1) : t('units.unknown'),
    ];
    cells.forEach((value, index) => {
      const td = document.createElement('td');
      td.textContent = value;
      td.classList.add('num');
      if (few && index > 0) {
        td.classList.add('few');
        td.title = t('people.few', { count: row.count });
      }
      tr.appendChild(td);
    });

    tr.addEventListener('click', () => {
      if (byTeam) setTeamHighlight(state.highlightTeam === row.team ? null : row.team);
      else setHighlight(state.highlight === row.code ? null : row.code);
    });
    body.appendChild(tr);
  }
}

/**
 * Данные подсветки для графика: исполнитель (или команда — все её люди) и скользящее среднее.
 * Возвращает null, если подсветка снята или выбранное выпало из выборки.
 */
function highlightPayload() {
  if (state.highlightTeam !== null) {
    const row = peopleModeNow() === 'team' && peopleRows().find((r) => r.team === state.highlightTeam);
    if (!row) return null;
    const rolling = row.points.length >= 5
      ? rollingAverage(row.points, state.filters.rollingPercent / 100).series || []
      : [];
    return { code: 'team', codes: row.codes, rolling };
  }
  if (state.highlight === null) return null;
  const row = peopleModeNow() === 'person' && peopleRows().find((r) => r.code === state.highlight);
  if (!row) return null;
  // Линию строим, только когда точек хватает: на пяти задачах она бессмысленна.
  const rolling = row.points.length >= 5
    ? rollingAverage(row.points, state.filters.rollingPercent / 100).series || []
    : [];
  return { code: state.highlight, rolling };
}

/** Подпись в легенде: выбранный исполнитель или выбранная команда. */
function legendHighlight(payload) {
  const node = $('#legend-highlight');
  node.hidden = !payload;
  const label = node.querySelector('[data-cc-i18n]');
  const key = payload?.codes ? 'legend.highlightTeam' : 'legend.highlight';
  label.setAttribute('data-cc-i18n', key);
  label.textContent = t(key);
}

/** Подсветка одного исполнителя на фоне остальных. */
function setHighlight(code) {
  state.highlight = code;
  state.highlightTeam = null;
  const payload = highlightPayload();
  if (!payload) state.highlight = null;
  chart.setHighlight(payload);
  legendHighlight(payload);
  renderPeople();
}

/** Подсветка целой команды: все её люди — выбранный цвет, остальные приглушены. */
function setTeamHighlight(team) {
  state.highlightTeam = team;
  state.highlight = null;
  const payload = highlightPayload();
  if (!payload) state.highlightTeam = null;
  chart.setHighlight(payload);
  legendHighlight(payload);
  renderPeople();
}

/** Переключение сравнения «Люди / Команды»; подсветка сбрасывается — она про другие строки. */
function setPeopleMode(mode) {
  if (state.peopleMode === mode) return;
  state.peopleMode = mode;
  state.highlight = null;
  state.highlightTeam = null;
  chart.setHighlight(null);
  legendHighlight(null);
  renderPeople();
}

function currentRange() {
  const to = state.filters.to ?? nowMin();
  let from = state.filters.from;
  if (from === null || from === undefined) {
    from = state.filters.days ? to - state.filters.days * MIN_PER_DAY : -Infinity;
  }
  return { from, to };
}

function syncRangeInputs() {
  const { from, to } = currentRange();
  $('#date-from').value = Number.isFinite(from) ? formatIsoDate(from) : '';
  $('#date-to').value = Number.isFinite(to) ? formatIsoDate(to) : '';
}

function recompute() {
  if (!state.board) return;
  const cycleCodes = state.filters.cycle;
  const doneCodes = state.filters.done;
  const { from, to } = currentRange();

  state.data = buildChart(state.issues, {
    cycleCodes,
    doneCodes,
    fromMin: from,
    toMin: to,
    typeCodes: state.filters.types,
    assigneeCodes: state.filters.assignees,
    rollingPercent: state.filters.rollingPercent / 100,
    excludeOutliers: state.chartOptions.excludeOutliers,
  });

  chart.setOptions(state.chartOptions);
  // Подсвеченный человек (или команда) мог выпасть из выборки после смены фильтров.
  if (state.highlight !== null
    && !state.data.points.some((p) => (p.as ?? -1) === state.highlight)) {
    state.highlight = null;
  }
  const highlight = highlightPayload();
  if (!highlight) state.highlightTeam = null;
  chart.setData(state.data, highlight);
  legendHighlight(highlight);
  renderPeople();
  renderStats();
  renderExcluded();
  renderTable();
  syncRangeInputs();

  const dict = state.dicts.status;
  const statusIds = (codes) => [...codes].map((code) => dict.get(code)?.id).filter(Boolean);
  setChartPrefs(state.board.id, {
    filters: {
      days: state.filters.days,
      from: state.filters.from,
      to: state.filters.to,
      cycleStatusIds: statusIds(state.filters.cycle),
      doneStatusIds: statusIds(state.filters.done),
      rollingPercent: state.filters.rollingPercent,
    },
    chartOptions: state.chartOptions,
  });
}

/**
 * Эффективность потока: списанное время, делённое на время цикла.
 * Считаем только по задачам, где время списывали, иначе цифра занижена.
 */
function flowEfficiency(points) {
  let spent = 0;
  let cycle = 0;
  for (const p of points) {
    if (p.ts >= 0) {
      spent += p.ts;
      cycle += p.cycle;
    }
  }
  return cycle > 0 && spent > 0 ? spent / cycle : null;
}

/** Коэффициент вариации: два знака после запятой либо прочерк на пустой выборке. */
function cvValue(stats) {
  return stats.count ? stats.cv.toFixed(2) : t('units.unknown');
}

/** Цвет карточки CV: до 0,5 — зелёный, до 1 — синий, выше — жёлтый. */
function cvTone(stats) {
  if (!stats.count) return '';
  if (stats.cv < 0.5) return 'tone-good';
  if (stats.cv <= 1) return 'tone-ok';
  return 'tone-warn';
}

/** Дробная часть только когда она есть: 13 → «13», 13.5 → «13.5». */
function trimNumber(value) {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Медианный недельный поток по текущей выборке графика. */
function currentThroughput() {
  const points = state.data?.points || [];
  if (!points.length) return 0;
  const done = points.map((p) => p.doneAt).sort((a, b) => a - b);
  const { from, to } = currentRange();
  const start = Number.isFinite(from) ? from : done[0];
  return throughputStats(weeklyThroughput(done, start, to)).median;
}

function renderStats() {
  const { stats, rollingWindow } = state.data;
  const flow = flowEfficiency(state.data.points);
  // Третий элемент — подсказка при наведении: что эта цифра значит и как её читать.
  const cards = [
    [t('stats.count'), String(stats.count), t('stats.countHint')],
    [t('stats.avg'), formatDuration(stats.avg), t('stats.avgHint')],
    [t('stats.median'), formatDuration(stats.median), t('stats.medianHint')],
    [t('stats.p85'), formatDuration(stats.p85), t('stats.p85Hint')],
    [t('stats.p95'), formatDuration(stats.p95), t('stats.p95Hint')],
    [t('stats.sd'), formatDuration(stats.sd), t('stats.sdHint')],
    [t('stats.cv'), cvValue(stats), t('stats.cvHint'), cvTone(stats)],
    [t('stats.flow'), flow === null ? t('units.unknown') : `${Math.round(flow * 100)}%`, t('stats.flowHint')],
    [t('stats.max'), formatDuration(stats.max), t('stats.maxHint')],
    [t('stats.window'), t('stats.windowValue', { count: rollingWindow || 0 }), t('stats.windowHint')],
    [t('stats.throughput'), t('stats.throughputValue', { count: trimNumber(currentThroughput()) }),
      t('stats.throughputHint')],
  ];
  $('#cc-stats').innerHTML = cards
    .map(([label, value, hint, tone]) => `<div class="stat${tone ? ` ${tone}` : ''}" title="${escapeHtml(hint)}">`
      + `<b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`)
    .join('');
}

function renderExcluded() {
  const ex = state.data.excluded;
  const rows = [
    [t('excluded.notDone'), ex.notDone, 'notDone'],
    [t('excluded.outOfRange'), ex.outOfRange, null],
    [t('excluded.noTime'), ex.noTime, 'noTime'],
    [t('excluded.filtered'), ex.filtered, null],
    [t('excluded.outliers'), ex.outliers || 0, null],
  ].filter(([, n]) => n > 0);

  const list = $('#excluded');
  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = `<li class="muted">${escapeHtml(t('excluded.none'))}</li>`;
    return;
  }
  for (const [label, count, kind] of rows) {
    const li = document.createElement('li');
    if (kind) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link-btn';
      button.textContent = label;
      button.title = t('excluded.rowTitle');
      button.addEventListener('click', () => openDiagnostics(kind));
      li.appendChild(button);
    } else {
      const span = document.createElement('span');
      span.textContent = label;
      li.appendChild(span);
    }
    const value = document.createElement('b');
    value.textContent = String(count);
    li.appendChild(value);
    list.appendChild(li);
  }
}

/** Разбор отброшенных задач по статусам: где стоят и куда утекло время. */
function openDiagnostics(kind) {
  const dict = state.dicts.status;
  const details = state.data?.details;
  const map = kind === 'notDone' ? details?.notDoneByStatus : details?.noTimeByStatus;
  const mapped = mappedStatuses(state.board);
  const rows = [...(map || new Map()).entries()].sort((a, b) => b[1] - a[1]);

  $('#diag-title').textContent = t(kind === 'notDone' ? 'diag.titleNotDone' : 'diag.titleNoTime');
  $('#diag-hint').textContent = t(kind === 'notDone' ? 'diag.hintNotDone' : 'diag.hintNoTime');

  const body = $('#diag-body');
  body.innerHTML = '';
  if (!rows.length) {
    body.innerHTML = `<div class="muted">${escapeHtml(t('diag.empty'))}</div>`;
  }
  for (const [code, count] of rows) {
    const row = document.createElement('div');
    row.className = 'diag-row';

    const name = document.createElement('span');
    name.textContent = dict.name_(code) || String(code);
    if (!mapped.has(code)) {
      const tag = document.createElement('span');
      tag.className = 'diag-tag';
      tag.textContent = t('diag.unmappedTag');
      name.append(' ', tag);
    }

    const value = document.createElement('b');
    value.textContent = String(count);
    row.append(name, value);
    body.appendChild(row);
  }
  $('#dlg-diag').showModal();
}

function visiblePoints() {
  let points = state.data?.points || [];
  if (state.picked) points = points.filter((p) => state.picked.has(p.i));
  if (state.search) {
    points = points.filter((p) =>
      issueKey(p).toLowerCase().includes(state.search)
      || (p.su || '').toLowerCase().includes(state.search));
  }
  const { field, dir } = state.sort;
  const value = (p) => {
    if (field === 'key') return p.k;
    if (field === 'su') return (p.su || '').toLowerCase();
    if (field === 'ty') return state.dicts.type.name_(p.ty);
    return p[field];
  };
  return points.slice().sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va < vb) return -dir;
    if (va > vb) return dir;
    return 0;
  });
}

function renderTable() {
  const points = visiblePoints();
  const title = state.picked
    ? t('table.titlePicked', { count: points.length })
    : t('table.titleCount', { count: points.length });
  const spent = points.reduce((sum, p) => sum + (p.ts > 0 ? p.ts : 0), 0);
  $('#table-title').textContent = spent > 0
    ? `${title} · ${t('table.totalSpent', {
      hours: Math.round(spent / 60).toLocaleString(intlTag()),
    })}`
    : title;
  const body = $('#issues-table tbody');
  body.innerHTML = points.slice(0, 500).map((p) => {
    const key = issueKey(p);
    const url = issueUrl(p);
    return `<tr>
      <td>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(key)}</a>` : escapeHtml(key)}</td>
      <td class="summary" title="${escapeHtml(p.su || '')}">${escapeHtml(p.su || '')}</td>
      <td>${escapeHtml(state.dicts.type.name_(p.ty))}</td>
      <td class="num">${escapeHtml(formatDuration(p.cycle))}</td>
      <td class="num">${escapeHtml(formatDuration(p.lead))}</td>
      <td class="num">${p.ts >= 0 ? escapeHtml(formatDuration(p.ts)) : escapeHtml(t('units.unknown'))}</td>
      <td>${escapeHtml(formatDate(p.doneAt))}</td>
    </tr>`;
  }).join('');
}

function exportCsv() {
  const points = visiblePoints();
  if (!points.length) return;
  const header = ['key', 'summary', 'type', 'cycle_hours', 'cycle_days', 'lead_days',
    'spent_hours', 'created', 'done'];
  const rows = points.map((p) => [
    issueKey(p),
    (p.su || '').replace(/"/g, '""'),
    state.dicts.type.name_(p.ty),
    (p.cycle / 60).toFixed(2),
    (p.cycle / MIN_PER_DAY).toFixed(2),
    (p.lead / MIN_PER_DAY).toFixed(2),
    p.ts >= 0 ? (p.ts / 60).toFixed(2) : '',
    minToDate(p.created).toISOString(),
    minToDate(p.doneAt).toISOString(),
  ]);
  const csv = [header, ...rows]
    .map((row) => row.map((cell) => `"${String(cell)}"`).join(','))
    .join('\n');
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `control-chart-${state.board?.id || 'board'}-${formatIsoDate(nowMin())}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

// ---------------------------------------------------------- прогноз

const FORECAST_TRIALS = 10000;
const FORECAST_MIN_WEEKS = 5;    // ниже этого прогноз не строим
const FORECAST_WEAK_WEEKS = 12;  // ниже этого предупреждаем о неустойчивости

/** Загружает доски с данными и считает их недельный поток. */
async function loadForecastRows() {
  const statusDict = state.dicts.status;
  const rows = [];
  for (const board of await db.getBoards()) {
    const issues = await db.getBoardIssues(board.id);
    if (!issues.length) continue;
    const prefs = await getChartPrefs(board.id);
    const ids = prefs?.filters?.doneStatusIds;
    const doneCodes = ids?.length
      ? new Set(ids.map((id) => statusDict.codeOf(id)).filter((code) => code >= 0))
      : new Set(defaultDoneStatuses(board, statusDict));
    rows.push({
      id: board.id,
      name: board.name || t('board.fallbackName', { id: board.id }),
      syncedAt: board.syncedAt || null,
      issues,
      doneCodes,
      enabled: board.id === state.board?.id,
      tasks: '',
      share: 100,
      weeks: [],
      stats: null,
    });
  }
  return rows;
}

/** Пересчитывает недельный поток каждой доски под выбранную глубину истории. */
function computeForecastFlow() {
  const days = Number($('#fc-history').value);
  const to = nowMin();
  for (const row of state.forecast.rows) {
    const from = days ? to - days * MIN_PER_DAY : -Infinity;
    const done = completions(row.issues, row.doneCodes, from, to);
    const start = Number.isFinite(from) ? from : (done.length ? done[0] : to);
    row.weeks = weeklyThroughput(done, start, to);
    row.stats = throughputStats(row.weeks);
  }
}

function renderForecastRows() {
  const body = $('#fc-teams tbody');
  body.innerHTML = '';
  for (const row of state.forecast.rows) {
    const tr = document.createElement('tr');
    if (!row.enabled) tr.className = 'is-off';

    const flow = document.createElement('td');
    flow.className = 'num';
    // Обновляем клетку потока точечно: полная перерисовка таблицы отбирала бы
    // фокус у поля ввода после каждого набранного символа.
    const updateFlow = () => {
      const median = (row.stats?.median || 0) * (Number(row.share) || 0) / 100;
      flow.textContent = t('forecast.flowValue', { value: trimNumber(median) });
    };

    const pick = document.createElement('td');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = row.enabled;
    box.addEventListener('change', () => {
      row.enabled = box.checked;
      tr.classList.toggle('is-off', !row.enabled);
      recomputeForecast();
    });
    pick.appendChild(box);

    const name = document.createElement('td');
    name.textContent = row.name;
    const note = document.createElement('span');
    note.className = 'fc-board-note';
    const parts = [t('forecast.flowWeeks', { weeks: row.stats?.weeks ?? 0 })];
    if (row.syncedAt) {
      parts.push(t('forecast.stale', { date: formatDate(dateToMin(row.syncedAt)) }));
    }
    note.textContent = parts.join(' · ');
    name.appendChild(note);

    const tasks = document.createElement('td');
    tasks.className = 'num';
    const tasksInput = document.createElement('input');
    tasksInput.type = 'number';
    tasksInput.min = '0';
    tasksInput.step = '1';
    tasksInput.value = row.tasks;
    tasksInput.addEventListener('input', () => {
      row.tasks = tasksInput.value;
      recomputeForecast();
    });
    tasks.appendChild(tasksInput);

    const share = document.createElement('td');
    share.className = 'num';
    const shareInput = document.createElement('input');
    shareInput.type = 'number';
    shareInput.min = '1';
    shareInput.max = '100';
    shareInput.step = '5';
    shareInput.value = row.share;
    shareInput.addEventListener('input', () => {
      row.share = shareInput.value;
      updateFlow();
      recomputeForecast();
    });
    share.appendChild(shareInput);

    updateFlow();
    tr.append(pick, name, tasks, share, flow);
    body.appendChild(tr);
  }
}

/** Задачи, попавшие сразу на несколько выбранных досок: их поток посчитается дважды. */
function forecastOverlap(rows) {
  const seen = new Set();
  const twice = new Set();
  for (const row of rows) {
    for (const rec of row.issues) {
      if (seen.has(rec.i)) twice.add(rec.i);
      else seen.add(rec.i);
    }
  }
  return twice.size;
}

function recomputeForecast() {
  const warnings = $('#fc-warnings');
  const result = $('#fc-result');
  const histogram = $('#fc-histogram');
  const summary = $('#fc-summary');
  warnings.innerHTML = '';
  result.innerHTML = '';
  histogram.innerHTML = '';
  summary.textContent = '';
  state.forecast.result = null;

  const note = (text, kind = 'fc-note') => {
    const div = document.createElement('div');
    div.className = kind;
    div.textContent = text;
    warnings.appendChild(div);
  };

  const active = state.forecast.rows.filter((row) => row.enabled);
  const ready = active.filter((row) => Number(row.tasks) > 0 && Number(row.share) > 0 && row.weeks.length);
  if (!ready.length) {
    note(t('forecast.empty'));
    return;
  }

  const shortest = Math.min(...ready.map((row) => row.weeks.length));
  if (shortest < FORECAST_MIN_WEEKS) {
    note(t('forecast.noHistory', { weeks: shortest }), 'fc-warn');
    return;
  }
  if (shortest < FORECAST_WEAK_WEEKS) note(t('forecast.fewHistory', { weeks: shortest }), 'fc-warn');

  const overlap = forecastOverlap(active);
  if (overlap) note(t('forecast.overlap', { count: overlap }), 'fc-warn');
  if (ready.some((row) => Number(row.share) !== 100)) note(t('forecast.manualShare'));
  note(t('forecast.assumption'));

  const growth = Math.max(0, Number($('#fc-growth').value) || 0) / 100;
  const teams = ready.map((row) => ({
    name: row.name,
    counts: row.weeks.map((week) => week.count),
    tasks: Number(row.tasks),
    share: Number(row.share) / 100,
  }));
  // Зерно зависит только от входных данных: прогноз не дрожит при перерисовке.
  const seed = teams.reduce((acc, team) => acc + team.tasks * 7 + team.share * 1000, 17);
  const data = forecast(teams, { trials: FORECAST_TRIALS, growth, seed: Math.round(seed) });
  if (!data) {
    note(t('forecast.empty'));
    return;
  }
  state.forecast.result = data;
  if (!data.converged) note(t('forecast.notConverged'), 'fc-warn');

  // --- перцентили сроков
  const startValue = $('#fc-start').value;
  const startMin = startValue ? dateToMin(new Date(`${startValue}T00:00:00`)) : nowMin();
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
      <th>${escapeHtml(t('forecast.probability'))}</th>
      <th class="num">${escapeHtml(t('forecast.colWeeks'))}</th>
      <th class="num">${escapeHtml(t('forecast.colSprints'))}</th>
      <th>${escapeHtml(t('forecast.colDate'))}</th>
    </tr></thead><tbody></tbody>`;
  const rows = [['50%', data.weeks.p50], ['85%', data.weeks.p85], ['95%', data.weeks.p95]];
  const body = table.querySelector('tbody');
  for (const [label, weeks] of rows) {
    const tr = document.createElement('tr');
    if (label === '85%') tr.className = 'is-key';
    tr.innerHTML = `<td>${label}</td><td class="num">${weeks}</td>`
      + `<td class="num">${Math.ceil(weeks / 2)}</td>`
      + `<td>${escapeHtml(formatDate(dateAfterWeeks(startMin, weeks)))}</td>`;
    body.appendChild(tr);
  }
  result.appendChild(table);

  // --- кто оказался последним
  if (data.blocked.length > 1) {
    const blocked = document.createElement('div');
    blocked.className = 'fc-blocked';
    blocked.title = t('forecast.blockedHint');
    const title = document.createElement('b');
    title.textContent = `${t('forecast.blocked')}:`;
    blocked.appendChild(title);
    for (const team of [...data.blocked].sort((a, b) => b.share - a.share)) {
      const span = document.createElement('span');
      span.textContent = `${team.name} — ${Math.round(team.share * 100)}%`;
      blocked.appendChild(span);
    }
    result.appendChild(blocked);
  }

  renderForecastHistogram(histogram, data.histogram, data.weeks.p85);

  const totalTasks = ready.reduce((acc, row) => acc + Number(row.tasks), 0);
  const totalFlow = ready.reduce((acc, row) => acc + (row.stats.median * Number(row.share)) / 100, 0);
  summary.textContent = t('forecast.summary', {
    tasks: totalTasks,
    flow: trimNumber(totalFlow),
    date: formatDate(dateAfterWeeks(startMin, data.weeks.p85)),
  });
}

/** Столбчатая диаграмма исходов симуляции. */
function renderForecastHistogram(container, histogram, keyWeeks) {
  container.innerHTML = '';
  if (histogram.length < 2) return;
  const NS = 'http://www.w3.org/2000/svg';
  const width = 700;
  const height = 92;
  const pad = 10;
  const base = height - 18;

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const maxCount = Math.max(...histogram.map((bin) => bin.count));
  const first = histogram[0].weeks;
  const last = histogram[histogram.length - 1].weeks;
  const span = Math.max(1, last - first + 1);
  const step = (width - pad * 2) / span;

  for (const bin of histogram) {
    const x = pad + (bin.weeks - first) * step;
    const h = Math.max(1, (bin.count / maxCount) * (base - 6));
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', x.toFixed(1));
    rect.setAttribute('y', (base - h).toFixed(1));
    rect.setAttribute('width', Math.max(1.5, step - 1).toFixed(1));
    rect.setAttribute('height', h.toFixed(1));
    rect.setAttribute('class', `fc-bar${bin.weeks === keyWeeks ? ' is-key' : ''}`);
    svg.appendChild(rect);
  }

  const label = (x, anchor, text) => {
    const node = document.createElementNS(NS, 'text');
    node.setAttribute('x', x);
    node.setAttribute('y', height - 4);
    node.setAttribute('text-anchor', anchor);
    node.setAttribute('class', 'fc-axis');
    node.textContent = text;
    svg.appendChild(node);
  };
  label(pad, 'start', String(first));
  label(pad + (keyWeeks - first) * step, 'middle', `85% · ${keyWeeks}`);
  label(width - pad, 'end', String(last));
  container.appendChild(svg);
}

async function openForecast() {
  $('#fc-start').value = formatIsoDate(nowMin());
  state.forecast.rows = await loadForecastRows();
  computeForecastFlow();
  renderForecastRows();
  recomputeForecast();
  if (!$('#dlg-forecast').open) $('#dlg-forecast').showModal();
}

/** Недельный поток выбранных досок — файл под собственную симуляцию. */
function exportThroughputCsv() {
  const rows = state.forecast.rows.filter((row) => row.enabled && row.weeks.length);
  if (!rows.length) return;
  const lines = [['board', 'week_start', 'completed']];
  for (const row of rows) {
    for (const week of row.weeks) {
      lines.push([row.name, formatIsoDate(week.start), String(week.count)]);
    }
  }
  const csv = lines.map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `throughput-${formatIsoDate(nowMin())}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 5000);
}

async function copyForecastSummary() {
  const text = $('#fc-summary').textContent.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const button = $('#btn-fc-copy');
    const original = button.textContent;
    button.textContent = t('forecast.copied');
    setTimeout(() => { button.textContent = original; }, 1500);
  } catch {
    // буфер недоступен — текст и так виден на экране
  }
}

// -------------------------------------------------------- хранилище

async function openStorage() {
  const stats = await db.storageStats();
  const perIssue = stats.usage && stats.issues ? stats.usage / stats.issues : null;
  const usageLine = stats.usage !== null
    ? (stats.quota
      ? t('storage.usedValue', { used: formatBytes(stats.usage), quota: formatBytes(stats.quota) })
      : formatBytes(stats.usage))
    : t('storage.unknown');
  const bar = stats.usage && stats.quota
    ? `<div class="bar"><i style="width:${Math.min(100, (stats.usage / stats.quota) * 100).toFixed(2)}%"></i></div>`
    : '';
  const boards = stats.boards
    .map((b) => `<div>${escapeHtml(t('storage.boardRow', {
      name: b.name || t('board.fallbackName', { id: b.id }),
      issues: tn('plural.issue', b.issues),
    }))}</div>`)
    .join('');
  $('#storage-info').innerHTML = `
    <div><b>${escapeHtml(t('storage.used'))}</b> ${escapeHtml(usageLine)}</div>
    ${bar}
    <div><b>${escapeHtml(t('storage.issues'))}</b> ${stats.issues}${
  perIssue ? escapeHtml(t('storage.perIssue', { size: formatBytes(perIssue) })) : ''}</div>
    <div class="muted">${boards || escapeHtml(t('storage.noBoards'))}</div>`;
  if (!$('#dlg-storage').open) $('#dlg-storage').showModal();
}

