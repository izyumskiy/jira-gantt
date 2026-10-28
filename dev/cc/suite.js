// Набор тестов чистой логики: упаковка, расчёт Control Chart, разбор истории.
// Не зависит от DOM — запускается и в браузере (tests/test.html), и в jsc
// (tests/run.js).

import {
  packSteps, unpackSteps, toSegments, toMin, minToDate, Dict, StatusDict, MIN_PER_DAY,
} from '../../src/cc/lib/codec.js';
import { buildSteps, doneMinute, toRecord } from '../../src/cc/lib/sync.js';
import {
  buildChart, computePoints, rollingAverage, percentile, doneAtFrom, statusSet,
  defaultDoneColumns, defaultCycleColumns, defaultDoneStatuses, defaultCycleStatuses,
  statusUsage, mappedStatuses, byAssignee,
} from '../../src/cc/lib/control-chart.js';
import { renderMarkdown, tableOfContents, slug } from '../../src/cc/lib/markdown.js';
import {
  weekStart, nextWeek, weeklyThroughput, throughputStats, simulate, forecast, dateAfterWeeks,
} from '../../src/cc/lib/forecast.js';
import { MESSAGES, LOCALES, DEFAULT_LOCALE } from '../../src/cc/lib/messages.js';
import { t, tn, setLocale, getLocale, pluralIndex, detectLocale, isSupported } from '../../src/cc/lib/i18n.js';
import { formatDuration, formatBytes, formatDays } from '../../src/cc/lib/format.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, message: err.message });
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message || 'ожидалось true');
}
function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message || ''} получено ${a}, ожидалось ${b}`);
}

// ------------------------------------------------------------- codec

test('toMin/minToDate — обратимость', () => {
  const iso = '2025-03-17T12:34:00.000Z';
  const min = toMin(iso);
  eq(minToDate(min).toISOString(), iso);
});

test('toMin для пустого значения даёт -1', () => {
  eq(toMin(null), -1);
  eq(toMin(''), -1);
  eq(toMin(undefined), -1);
});

test('packSteps/unpackSteps сохраняют историю', () => {
  const created = toMin('2025-01-10T09:00:00Z');
  const steps = [
    { t: created, s: 0 },
    { t: created + 90, s: 1 },
    { t: created + 90 + 4000, s: 2 },
    { t: created + 90 + 4000 + 100000, s: 3 },
  ];
  const packed = packSteps(steps);
  eq(unpackSteps(packed, created), steps);
  assert(packed.length <= steps.length * 4, `упаковка слишком большая: ${packed.length} байт`);
});

test('unpackSteps на пустых данных', () => {
  eq(unpackSteps(null, 100), []);
  eq(unpackSteps(new Uint8Array(0), 100), []);
});

test('toSegments закрывает последний отрезок моментом until', () => {
  const steps = [{ t: 100, s: 0 }, { t: 160, s: 1 }];
  eq(toSegments(steps, 500), [{ s: 0, from: 100, to: 160 }, { s: 1, from: 160, to: 500 }]);
});

test('Dict выдаёт стабильные коды', () => {
  const d = new Dict('type');
  eq(d.code('Bug'), 0);
  eq(d.code('Task'), 1);
  eq(d.code('Bug'), 0);
  eq(d.name_(1), 'Task');
  eq(d.code(''), -1);
});

test('StatusDict помнит id и категорию', () => {
  const s = new StatusDict();
  const code = s.code('10001', 'In Progress', 'indeterminate');
  eq(s.codeOf('10001'), code);
  eq(s.category(code), 'indeterminate');
  s.code('10001', 'In Progress', 'indeterminate');
  eq(s.items.length, 1, 'повторный код не должен плодить записи:');
});

// -------------------------------------------------------------- sync

const DICTS = () => ({
  status: new StatusDict(),
  project: new Dict('project'),
  type: new Dict('type'),
  priority: new Dict('priority'),
  user: new Dict('user'),
  label: new Dict('label'),
});

function issueFixture() {
  return {
    id: '10500',
    key: 'ABC-42',
    fields: {
      summary: 'Починить экспорт',
      created: '2025-02-01T10:00:00.000+0000',
      updated: '2025-02-06T18:00:00.000+0000',
      resolutiondate: '2025-02-06T18:00:00.000+0000',
      status: { id: '6', name: 'Done', statusCategory: { key: 'done' } },
      issuetype: { name: 'Bug' },
      priority: { name: 'High' },
      assignee: { displayName: 'Иванов И.' },
      labels: ['backend'],
      timeoriginalestimate: 28800,
    },
    changelog: {
      total: 3,
      histories: [
        { created: '2025-02-03T09:00:00.000+0000', items: [{ field: 'status', from: '1', fromString: 'To Do', to: '3', toString: 'In Progress' }] },
        { created: '2025-02-05T15:00:00.000+0000', items: [{ field: 'status', from: '3', fromString: 'In Progress', to: '10001', toString: 'In Review' }] },
        { created: '2025-02-06T18:00:00.000+0000', items: [{ field: 'status', from: '10001', fromString: 'In Review', to: '6', toString: 'Done' }] },
      ],
    },
  };
}

test('buildSteps начинает с создания и исходного статуса', () => {
  const dicts = DICTS();
  const steps = buildSteps(issueFixture(), dicts);
  eq(steps.length, 4);
  eq(steps[0].t, toMin('2025-02-01T10:00:00Z'));
  eq(dicts.status.name_(steps[0].s), 'To Do');
  eq(dicts.status.name_(steps[3].s), 'Done');
});

test('buildSteps без истории даёт один шаг с текущим статусом', () => {
  const dicts = DICTS();
  const issue = issueFixture();
  issue.changelog = { total: 0, histories: [] };
  const steps = buildSteps(issue, dicts);
  eq(steps.length, 1);
  eq(dicts.status.name_(steps[0].s), 'Done');
});

test('doneMinute находит вход в финальный «готовый» участок', () => {
  const dicts = DICTS();
  dicts.status.code('6', 'Done', 'done');
  dicts.status.code('1', 'To Do', 'new');
  dicts.status.code('3', 'In Progress', 'indeterminate');
  dicts.status.code('10001', 'In Review', 'indeterminate');
  const steps = buildSteps(issueFixture(), dicts);
  eq(doneMinute(steps, dicts.status), toMin('2025-02-06T18:00:00Z'));
});

test('doneMinute = -1, если задача снова в работе', () => {
  const dicts = DICTS();
  dicts.status.code('6', 'Done', 'done');
  dicts.status.code('3', 'In Progress', 'indeterminate');
  const steps = [{ t: 0, s: dicts.status.codeOf('6') }, { t: 100, s: dicts.status.codeOf('3') }];
  eq(doneMinute(steps, dicts.status), -1);
});

test('toRecord складывает компактную запись', () => {
  const dicts = DICTS();
  dicts.status.code('6', 'Done', 'done');
  const rec = toRecord(issueFixture(), 7, dicts, {
    storeSummaries: true, summaryMaxLen: 80, storeAssignee: true, storeLabels: true, storyPointsField: '',
  });
  eq(rec.b, 7);
  eq(rec.i, 10500);
  eq(rec.k, 42);
  eq(dicts.project.name_(rec.pj), 'ABC');
  eq(dicts.type.name_(rec.ty), 'Bug');
  eq(rec.es, 480);
  assert(rec.tr instanceof Uint8Array, 'история должна быть Uint8Array');
  eq(unpackSteps(rec.tr, rec.c).length, 4);
});

test('summary обрезается по настройке', () => {
  const dicts = DICTS();
  const issue = issueFixture();
  issue.fields.summary = 'я'.repeat(200);
  const rec = toRecord(issue, 1, dicts, { storeSummaries: true, summaryMaxLen: 30 });
  eq(rec.su.length, 30);
});

// ----------------------------------------------------- control chart

function chartFixture() {
  // 0 — To Do, 1 — In Progress, 2 — Done
  const created = toMin('2025-03-01T09:00:00Z');
  const mk = (id, offsets) => ({
    b: 1, i: id, k: id, pj: 0, ty: 0, c: created,
    tr: packSteps([
      { t: created, s: 0 },
      { t: created + offsets[0], s: 1 },
      { t: created + offsets[1], s: 2 },
    ]),
  });
  return {
    created,
    issues: [
      mk(1, [MIN_PER_DAY, 3 * MIN_PER_DAY]),      // цикл 2 дня
      mk(2, [MIN_PER_DAY, 5 * MIN_PER_DAY]),      // цикл 4 дня
      mk(3, [2 * MIN_PER_DAY, 8 * MIN_PER_DAY]),  // цикл 6 дней
    ],
  };
}

test('computePoints считает время в выбранных колонках', () => {
  const { issues } = chartFixture();
  const { points } = computePoints(issues, {
    cycleCodes: new Set([1]),
    doneCodes: new Set([2]),
  });
  eq(points.map((p) => p.cycle / MIN_PER_DAY), [2, 4, 6]);
});

test('незавершённые задачи не попадают на график', () => {
  const { issues } = chartFixture();
  const { points, excluded } = computePoints(issues, {
    cycleCodes: new Set([1]),
    doneCodes: new Set([99]),
  });
  eq(points.length, 0);
  eq(excluded.notDone, 3);
});

test('фильтр периода отсекает точки', () => {
  const { issues, created } = chartFixture();
  const { points, excluded } = computePoints(issues, {
    cycleCodes: new Set([1]),
    doneCodes: new Set([2]),
    fromMin: created,
    toMin: created + 4 * MIN_PER_DAY,
  });
  eq(points.length, 1);
  eq(excluded.outOfRange, 2);
});

test('doneAtFrom берёт начало последнего готового участка', () => {
  const steps = [{ t: 0, s: 0 }, { t: 10, s: 2 }, { t: 20, s: 1 }, { t: 30, s: 2 }, { t: 40, s: 3 }];
  eq(doneAtFrom(steps, new Set([2, 3])), 30);
});

test('percentile считает как ожидается', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  eq(percentile(values, 50), 5.5);
  eq(percentile(values, 100), 10);
  eq(percentile(values, 0), 1);
});

test('rollingAverage возвращает окно и σ', () => {
  const points = Array.from({ length: 20 }, (_, i) => ({ doneAt: i, cycle: 100 }));
  const { series, window } = rollingAverage(points, 0.25);
  eq(window, 5);
  eq(series.length, 20);
  eq(series[0].avg, 100);
  eq(series[0].sd, 0);
});

test('buildChart отсекает выбросы по IQR', () => {
  const base = Array.from({ length: 12 }, (_, i) => ({
    b: 1, i: i + 1, k: i + 1, pj: 0, ty: 0, c: 0,
    tr: packSteps([{ t: 0, s: 0 }, { t: 10, s: 1 }, { t: 10 + 60, s: 2 }]),
  }));
  base.push({
    b: 1, i: 99, k: 99, pj: 0, ty: 0, c: 0,
    tr: packSteps([{ t: 0, s: 0 }, { t: 10, s: 1 }, { t: 10 + 100000, s: 2 }]),
  });
  const chart = buildChart(base, {
    cycleCodes: new Set([1]), doneCodes: new Set([2]), excludeOutliers: true,
  });
  eq(chart.outliers.length, 1);
  eq(chart.points.length, 12);
});

test('колонки доски разворачиваются в набор статусов', () => {
  const board = { columns: [{ name: 'To Do', st: [0] }, { name: 'In Progress', st: [1, 4] }, { name: 'Done', st: [2] }] };
  eq([...statusSet(board, ['In Progress'])], [1, 4]);
  const statuses = new StatusDict([
    { id: '1', n: 'To Do', c: 'new' },
    { id: '3', n: 'In Progress', c: 'indeterminate' },
    { id: '6', n: 'Done', c: 'done' },
    { id: '7', n: 'Review', c: 'indeterminate' },
  ]);
  eq(defaultDoneColumns(board, statuses), ['Done']);
  eq(defaultCycleColumns(board, statuses), ['In Progress']);
});


test('statusUsage считает задачи и время по статусам', () => {
  const issues = [
    { c: 0, tr: packSteps([{ t: 0, s: 0 }, { t: 100, s: 1 }, { t: 400, s: 2 }]) },
    { c: 0, tr: packSteps([{ t: 0, s: 0 }, { t: 50, s: 2 }]) },
  ];
  const usage = statusUsage(issues, 1000);
  eq(usage.get(0).issues, 2);
  eq(usage.get(0).minutes, 150);      // 100 + 50
  eq(usage.get(1).issues, 1);
  eq(usage.get(1).minutes, 300);
  eq(usage.get(2).minutes, 600 + 950); // хвосты до `until`
});

test('mappedStatuses собирает статусы всех колонок доски', () => {
  const board = { columns: [{ name: 'A', st: [0, 1] }, { name: 'B', st: [3] }] };
  eq([...mappedStatuses(board)].sort((x, y) => x - y), [0, 1, 3]);
});

test('умолчания отдаются кодами статусов, а не именами колонок', () => {
  const board = {
    columns: [
      { name: 'To Do', st: [0] },
      { name: 'In Progress', st: [1, 4] },
      { name: 'Done', st: [2] },
    ],
  };
  const statuses = new StatusDict([
    { id: '1', n: 'To Do', c: 'new' },
    { id: '3', n: 'In Progress', c: 'indeterminate' },
    { id: '6', n: 'Done', c: 'done' },
    { id: '7', n: 'Review', c: 'indeterminate' },
    { id: '9', n: 'Blocked', c: 'indeterminate' },
  ]);
  eq(defaultDoneStatuses(board, statuses), [2]);
  eq(defaultCycleStatuses(board, statuses), [1, 4]);
});

test('разбор отброшенных: где стоят и куда утекло время', () => {
  const stuck = { i: 1, c: 0, s: 1, tr: packSteps([{ t: 0, s: 0 }, { t: 50, s: 1 }]) };
  const straight = { i: 2, c: 0, s: 2, tr: packSteps([{ t: 0, s: 0 }, { t: 100, s: 2 }]) };
  const { excluded, details } = computePoints([stuck, straight], {
    cycleCodes: new Set([1]),
    doneCodes: new Set([2]),
  });
  eq(excluded.notDone, 1);
  eq(excluded.noTime, 1);
  eq([...details.notDoneByStatus.entries()], [[1, 1]], 'застряли в статусе 1:');
  eq([...details.noTimeByStatus.entries()], [[0, 1]], 'время прошло в статусе 0:');
});

test('buildChart прокидывает разбор наружу', () => {
  const chart = buildChart([{ i: 1, c: 0, s: 1, tr: packSteps([{ t: 0, s: 0 }, { t: 50, s: 1 }]) }], {
    cycleCodes: new Set([1]), doneCodes: new Set([2]),
  });
  assert(chart.details && chart.details.notDoneByStatus.size === 1, 'details должны приходить из buildChart');
});

// ---------------------------------------------------------- markdown

test('заголовки получают якоря', () => {
  const html = renderMarkdown('# Заголовок\n\n## Раздел один\n\nтекст');
  assert(html.includes('<h1>Заголовок</h1>'), html);
  assert(html.includes('<h2 id="раздел-один">Раздел один</h2>'), html);
  assert(html.includes('<p>текст</p>'), html);
});

test('таблица разбирается в thead/tbody', () => {
  const html = renderMarkdown('| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |');
  eq((html.match(/<tr>/g) || []).length, 3);
  eq((html.match(/<th>/g) || []).length, 2);
  assert(html.includes('<td>4</td>'), html);
});

test('списки и мягкие переносы абзаца', () => {
  const html = renderMarkdown('- раз\n- два\n\nабзац\nпродолжение');
  assert(html.includes('<ul><li>раз</li><li>два</li></ul>'), html);
  assert(html.includes('<p>абзац продолжение</p>'), html);
});

test('строчная разметка и экранирование HTML', () => {
  const html = renderMarkdown('**жирный** и `код` и [ссылка](https://example.com)');
  assert(html.includes('<strong>жирный</strong>'), html);
  assert(html.includes('<code>код</code>'), html);
  assert(html.includes('<a href="https://example.com" target="_blank" rel="noopener">ссылка</a>'), html);
  const unsafe = renderMarkdown('<img src=x onerror=alert(1)> и [клик](javascript:alert(1))');
  assert(!unsafe.includes('<img'), 'HTML из документа не должен исполняться');
  assert(!/<a\s/.test(unsafe), 'ссылка с опасной схемой не должна становиться тегом');
  assert(unsafe.includes('&lt;img'), 'исходный текст должен остаться экранированным');
});

test('оглавление собирается по заголовкам второго уровня', () => {
  const md = '# Титул\n\n## Первый\n\n### Вложенный\n\n## Второй';
  eq(tableOfContents(md), ['Первый', 'Второй']);
  eq(slug('Шаг 0. Собрать выборку — это 80%'), 'шаг-0-собрать-выборку-это-80');
});

test('summarize считает коэффициент вариации', () => {
  const mk = (values) => values.map((cycle) => ({ cycle }));
  // одинаковые значения: разброса нет
  eq(buildChart([], { cycleCodes: new Set(), doneCodes: new Set() }).stats.cv, 0,
    'на пустой выборке CV равен нулю:');
  const groups = byAssignee(mk([100, 100, 100]));
  eq(groups[0].stats.cv, 0);
  // σ равна среднему → CV = 1
  const spread = byAssignee(mk([0, 200]))[0].stats;
  eq(spread.avg, 100);
  eq(spread.sd, 100);
  eq(spread.cv, 1);
});

test('byAssignee группирует точки и считает статистику по каждому', () => {
  const points = [
    { as: 1, cycle: 100 }, { as: 1, cycle: 300 },
    { as: 2, cycle: 200 },
    { cycle: 500 },                    // без исполнителя
  ];
  const groups = byAssignee(points).sort((a, b) => a.code - b.code);
  eq(groups.map((g) => g.code), [-1, 1, 2], 'задачи без исполнителя уходят в код -1:');
  eq(groups.map((g) => g.stats.count), [1, 2, 1]);
  eq(groups.find((g) => g.code === 1).stats.median, 200);
  eq(groups.find((g) => g.code === 1).stats.avg, 200);
  eq(groups.find((g) => g.code === -1).stats.max, 500);
});

test('byAssignee на пустой выборке не падает', () => {
  eq(byAssignee([]), []);
});

// ---------------------------------------------------------- прогноз

const MONDAY = toMin(new Date(2026, 0, 5));   // 5 января 2026 — понедельник

test('weekStart приводит любой день к понедельнику', () => {
  eq(weekStart(MONDAY), MONDAY);
  eq(weekStart(toMin(new Date(2026, 0, 8, 13, 40))), MONDAY, 'четверг той же недели:');
  eq(weekStart(toMin(new Date(2026, 0, 11, 23, 59))), MONDAY, 'воскресенье той же недели:');
  eq(weekStart(toMin(new Date(2026, 0, 12))), nextWeek(MONDAY), 'следующий понедельник:');
});

test('weeklyThroughput выбрасывает неполные недели и сохраняет нули', () => {
  const done = [
    toMin(new Date(2026, 0, 6)), toMin(new Date(2026, 0, 7)),   // неделя 1: две задачи
    // неделя 2 пустая
    toMin(new Date(2026, 0, 20)),                                // неделя 3: одна
  ];
  const from = MONDAY;
  const to = toMin(new Date(2026, 0, 25, 23, 59));               // воскресенье, три полные недели
  const weeks = weeklyThroughput(done, from, to);
  eq(weeks.map((w) => w.count), [2, 0, 1]);

  // старт со вторника — первая неделя неполная и не считается
  const shifted = weeklyThroughput(done, toMin(new Date(2026, 0, 6)), to);
  eq(shifted.map((w) => w.count), [0, 1]);
});

test('weeklyThroughput не отдаёт текущую незавершённую неделю', () => {
  const to = toMin(new Date(2026, 0, 21));   // среда
  const weeks = weeklyThroughput([], MONDAY, to);
  eq(weeks.length, 2, 'недели 5 и 12 января, неделя 19-го ещё идёт:');
});

test('throughputStats считает медиану и разброс', () => {
  const stats = throughputStats([{ count: 5 }, { count: 15 }, { count: 10 }]);
  eq(stats.weeks, 3);
  eq(stats.median, 10);
  eq(stats.min, 5);
  eq(stats.max, 15);
  eq(stats.total, 30);
});

test('прогноз на ровном потоке даёт точный срок', () => {
  const counts = [10, 10, 10, 10];
  const result = forecast([{ name: 'A', counts, tasks: 60, share: 1 }], { trials: 200 });
  eq([result.weeks.p50, result.weeks.p85, result.weeks.p95], [6, 6, 6]);
  eq(result.blocked[0].share, 1);
});

test('доля потока пересчитывается в объём', () => {
  const counts = [10, 10, 10, 10];
  // проекту достаётся половина команды: ради 30 задач команда выпустит 60
  const half = forecast([{ name: 'A', counts, tasks: 30, share: 0.5 }], { trials: 100 });
  eq(half.weeks.p85, 6);
  const full = forecast([{ name: 'A', counts, tasks: 30, share: 1 }], { trials: 100 });
  eq(full.weeks.p85, 3);
});

test('несколько команд не складываются, а идут параллельно', () => {
  const fast = { name: 'Быстрая', counts: [20, 20], tasks: 20, share: 1 };   // 1 неделя
  const slow = { name: 'Медленная', counts: [5, 5], tasks: 40, share: 1 };   // 8 недель
  const result = forecast([fast, slow], { trials: 200 });
  eq(result.weeks.p85, 8, 'срок задаёт самая медленная, а не сумма потоков:');
  eq(result.blocked[1].share, 1, 'последней всегда оказывается медленная:');
  eq(result.blocked[0].share, 0);
});

test('запас на рост объёма увеличивает срок', () => {
  const counts = [10, 10];
  const plain = forecast([{ name: 'A', counts, tasks: 60, share: 1 }], { trials: 100 });
  const grown = forecast([{ name: 'A', counts, tasks: 60, share: 1 }], { trials: 100, growth: 0.5 });
  eq(plain.weeks.p85, 6);
  eq(grown.weeks.p85, 9);
});

test('симуляция воспроизводима при одном зерне', () => {
  const teams = [{ counts: [3, 7, 11], target: 40 }];
  const a = simulate(teams, { trials: 50, seed: 42 });
  const b = simulate(teams, { trials: 50, seed: 42 });
  eq(a.durations, b.durations);
  const c = simulate(teams, { trials: 50, seed: 43 });
  assert(JSON.stringify(a.durations) !== JSON.stringify(c.durations), 'разные зёрна дают разные прогоны');
});

test('прогноз без пригодных команд возвращает null', () => {
  eq(forecast([]), null);
  eq(forecast([{ name: 'A', counts: [], tasks: 10, share: 1 }]), null);
  eq(forecast([{ name: 'A', counts: [5], tasks: 0, share: 1 }]), null);
});

test('dateAfterWeeks сдвигает дату на недели', () => {
  eq(dateAfterWeeks(MONDAY, 2), toMin(new Date(2026, 0, 19)));
});

// -------------------------------------------------------------- i18n

test('словари совпадают по ключам', () => {
  const codes = LOCALES.map((l) => l.code);
  const base = Object.keys(MESSAGES[DEFAULT_LOCALE]).sort();
  for (const code of codes) {
    assert(MESSAGES[code], `нет словаря для ${code}`);
    const keys = Object.keys(MESSAGES[code]).sort();
    const missing = base.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !base.includes(k));
    eq(missing, [], `в ${code} не хватает ключей:`);
    eq(extra, [], `в ${code} лишние ключи:`);
  }
});

test('пустых строк в словарях нет', () => {
  for (const [code, dict] of Object.entries(MESSAGES)) {
    for (const [key, value] of Object.entries(dict)) {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        assert(typeof item === 'string' && item.trim(), `${code}/${key} пустой`);
      }
    }
  }
});

test('формы множественного числа заданы полностью', () => {
  eq(MESSAGES.ru['plural.issue'].length, 3);
  eq(MESSAGES.en['plural.issue'].length, 2);
  eq(MESSAGES.ru['units.bytes'].length, MESSAGES.en['units.bytes'].length);
});

test('t подставляет значения и не теряет неизвестный ключ', () => {
  setLocale('ru');
  eq(t('sync.saved', { saved: 7 }), 'Задач сохранено: 7');
  eq(t('нет.такого.ключа'), 'нет.такого.ключа');
  eq(t('sync.saved'), 'Задач сохранено: {saved}', 'без параметров плейсхолдер остаётся:');
  setLocale('en');
  eq(t('sync.saved', { saved: 7 }), 'Issues saved: 7');
});

test('правила множественного числа', () => {
  const ru = [1, 2, 4, 5, 11, 21, 22, 25, 100, 101, 114].map((n) => pluralIndex(n, 'ru'));
  eq(ru, [0, 1, 1, 2, 2, 0, 1, 2, 2, 0, 2]);
  const en = [0, 1, 2, 21].map((n) => pluralIndex(n, 'en'));
  eq(en, [1, 0, 1, 1]);
});

test('tn склеивает число с нужной формой', () => {
  setLocale('ru');
  eq([1, 3, 5, 21].map((n) => tn('plural.issue', n)),
    ['1 задача', '3 задачи', '5 задач', '21 задача']);
  setLocale('en');
  eq([1, 3].map((n) => tn('plural.issue', n)), ['1 issue', '3 issues']);
});

test('неизвестный язык откатывается на язык по умолчанию', () => {
  setLocale('de');
  eq(getLocale(), DEFAULT_LOCALE);
  assert(!isSupported('de'));
  assert(isSupported('en'));
  assert(['ru', 'en'].includes(detectLocale()));
});

test('форматирование единиц зависит от языка', () => {
  setLocale('ru');
  eq(formatDuration(3 * 1440 + 240), '3д 4ч');
  eq(formatDuration(90), '1ч 30м');
  eq(formatDays(1440), '1д');
  assert(formatBytes(2048).endsWith('КБ'), formatBytes(2048));
  setLocale('en');
  eq(formatDuration(3 * 1440 + 240), '3d 4h');
  eq(formatDuration(90), '1h 30m');
  eq(formatDays(1440), '1d');
  assert(formatBytes(2048).endsWith('KB'), formatBytes(2048));
  setLocale(DEFAULT_LOCALE);
});

// ------------------------------------------------- оценка размера

/** Длина строки в байтах UTF-8 (без зависимости от Blob/TextEncoder). */
function utf8Size(text) {
  let bytes = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Грубая оценка размера записи в IndexedDB. */
function approxSize(rec) {
  let bytes = 0;
  for (const [key, value] of Object.entries(rec)) {
    bytes += key.length + 2;
    if (value instanceof Uint8Array) bytes += value.length + 8;
    else if (typeof value === 'number') bytes += 8;
    else if (typeof value === 'string') bytes += utf8Size(value) + 4;
    else if (Array.isArray(value)) bytes += value.length * 8 + 4;
  }
  return bytes;
}

/** Сравнивает размер сырого JSON Jira и компактной записи. */
export function benchmark(count = 1000) {
  const dicts = DICTS();
  const settings = {
    storeSummaries: true, summaryMaxLen: 80,
    storeAssignee: true, storeLabels: false, storyPointsField: '',
  };
  let packedBytes = 0;
  let jsonBytes = 0;
  let stepsBytes = 0;
  for (let i = 0; i < count; i++) {
    const issue = issueFixture();
    issue.id = String(10000 + i);
    issue.key = `ABC-${i}`;
    const rec = toRecord(issue, 1, dicts, settings);
    packedBytes += approxSize(rec);
    stepsBytes += rec.tr.length;
    jsonBytes += utf8Size(JSON.stringify(issue));
  }
  return {
    count,
    jsonBytes,
    packedBytes,
    perIssueJson: Math.round(jsonBytes / count),
    perIssuePacked: Math.round(packedBytes / count),
    perIssueSteps: Math.round(stepsBytes / count),
    ratio: jsonBytes / packedBytes,
  };
}

/** Прогоняет все тесты и отдаёт результаты. */
export function runSuite() {
  return results;
}
