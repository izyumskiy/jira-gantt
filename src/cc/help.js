// Справка Control Chart: рендерит docs/cc/HOWTO.md (или HOWTO.en.md) из файлов плагина.

import { renderMarkdown, tableOfContents, slug } from './lib/markdown.js';
import { escapeHtml } from './lib/format.js';
import { loadSettings } from './lib/settings.js';
import { t, setLocale, detectLocale, applyStatic } from './lib/i18n.js';

const settings = await loadSettings();
setLocale(settings.locale || detectLocale());
applyStatic();

const version = document.querySelector('#about-version');
if (version) version.textContent = chrome.runtime?.getManifest?.().version || '';

// Справка открывается отдельной вкладкой браузера; назад — в OhMyGant, сразу на вкладку графика.
const appUrl = (params) => `../app.html?${new URLSearchParams(params)}`;

document.querySelector('#btn-tour').addEventListener('click', () => {
  location.href = appUrl({ tab: 'cc', tour: '1' });
});

document.querySelector('#btn-back').addEventListener('click', () => {
  if (history.length > 1) history.back();
  else location.href = appUrl({ tab: 'cc' });
});

const docPath = t('help.doc');

try {
  const res = await fetch(docPath);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const markdown = await res.text();

  document.querySelector('#doc').innerHTML = renderMarkdown(markdown);
  document.querySelector('#toc').innerHTML = tableOfContents(markdown)
    .map((title) => `<a href="#${slug(title)}">${escapeHtml(title)}</a>`)
    .join('');

  // Подсветка текущего раздела в оглавлении.
  const links = new Map([...document.querySelectorAll('#toc a')]
    .map((a) => [a.getAttribute('href').slice(1), a]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of links.values()) link.classList.remove('is-active');
      links.get(entry.target.id)?.classList.add('is-active');
    }
  }, { rootMargin: '-10% 0px -80% 0px' });
  for (const id of links.keys()) {
    const heading = document.getElementById(id);
    if (heading) observer.observe(heading);
  }
} catch (err) {
  document.querySelector('#doc').innerHTML =
    `<p>${escapeHtml(t('help.error', { message: err.message }))}</p>
     <p>${escapeHtml(t('help.errorHint', { file: docPath.replace('../../', '') }))}</p>`;
}
