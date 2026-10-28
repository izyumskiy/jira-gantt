// Отрисовка результатов набора тестов на странице расширения.

import { runSuite, benchmark } from './suite.js';

const results = runSuite();
const list = document.querySelector('#results');
let failed = 0;
for (const r of results) {
  const li = document.createElement('li');
  li.className = r.ok ? 'ok' : 'fail';
  li.textContent = `${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.message}`}`;
  list.appendChild(li);
  if (!r.ok) failed++;
}
const summary = document.querySelector('#summary');
summary.textContent = `${results.length - failed} из ${results.length} тестов пройдено${failed ? `, провалено ${failed}` : ''}`;
summary.className = failed ? 'fail' : 'ok';

const b = benchmark(1000);
document.querySelector('#bench').textContent =
  `Задач: ${b.count}\n`
  + `Сырой JSON из Jira (с changelog): ${(b.jsonBytes / 1024).toFixed(0)} КБ (${b.perIssueJson} Б на задачу)\n`
  + `Компактная запись: ${(b.packedBytes / 1024).toFixed(0)} КБ (${b.perIssuePacked} Б на задачу)\n`
  + `Из них история статусов: ${b.perIssueSteps} Б на задачу\n`
  + `Экономия: в ${b.ratio.toFixed(1)} раза`;
