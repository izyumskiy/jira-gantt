// Демонстрация рендера графика на синтетических данных (без Jira и IndexedDB).

import { ControlChart } from '../../src/cc/lib/chart.js';
import { buildChart } from '../../src/cc/lib/control-chart.js';
import { packSteps, nowMin, MIN_PER_DAY } from '../../src/cc/lib/codec.js';
import { formatDuration, escapeHtml } from '../../src/cc/lib/format.js';

const TYPES = ['Bug', 'Task', 'Story'];
const STATUSES = ['To Do', 'In Progress', 'In Review', 'Done'];

// Псевдослучайность с фиксированным зерном — картинка воспроизводима.
let seed = 20250820;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const issues = [];
const end = nowMin();
for (let i = 0; i < 420; i++) {
  const doneAt = end - Math.round(rnd() * 180 * MIN_PER_DAY);
  const trend = 1 + (end - doneAt) / (180 * MIN_PER_DAY);           // раньше было медленнее
  const cycle = Math.max(60, Math.round((rnd() ** 2.2) * 14 * MIN_PER_DAY * trend + 240));
  const review = Math.round(cycle * (0.15 + rnd() * 0.3));
  const created = doneAt - cycle - Math.round(rnd() * 5 * MIN_PER_DAY);
  issues.push({
    b: 1, i: 1000 + i, k: 1000 + i, pj: 0, ty: i % 3, c: created,
    su: `Демо-задача №${i + 1}`,
    tr: packSteps([
      { t: created, s: 0 },
      { t: doneAt - cycle, s: 1 },
      { t: doneAt - review, s: 2 },
      { t: doneAt, s: 3 },
    ]),
  });
}

const data = buildChart(issues, {
  cycleCodes: new Set([1, 2]),
  doneCodes: new Set([3]),
  rollingPercent: 0.1,
});

const chart = new ControlChart(document.querySelector('#chart'), {
  onZoom: (from, to) => console.log('zoom', from, to),
  onPick: (items) => console.log('pick', items.map((p) => p.k)),
});
chart.setContext({
  typeName: (code) => TYPES[code] || '',
  projectKey: () => 'DEMO',
  statusName: (code) => STATUSES[code] || '',
});
chart.setData(data);

const s = data.stats;
document.querySelector('#stats').innerHTML = [
  ['Задач', String(s.count)],
  ['Среднее', formatDuration(s.avg)],
  ['Медиана', formatDuration(s.median)],
  ['85-й перцентиль', formatDuration(s.p85)],
  ['Окно среднего', `${data.rollingWindow} зад.`],
].map(([label, value]) => `<div class="stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join('');
