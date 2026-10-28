// Подсказки по интерфейсу: нумерованные метки поверх реальных элементов панели.
//
// Намеренно не скриншот: разметка меняется, картинка устаревает, а метки
// привязаны к селекторам и всегда показывают то, что сейчас на экране.

import { t } from './lib/i18n.js';

/** Элементы панели по порядку обхода. Тексты берутся по ключам tour.<id>.* */
export const SPOTS = [
  { id: 'board', selector: '#board-picker' },
  { id: 'sync', selector: '#btn-sync' },
  { id: 'syncFull', selector: '#btn-sync-full' },
  { id: 'forecast', selector: '#btn-forecast' },
  { id: 'period', selector: '#range-presets' },
  { id: 'cycle', selector: '#cycle-statuses' },
  { id: 'done', selector: '#done-statuses' },
  { id: 'types', selector: '#type-filter' },
  { id: 'assignees', selector: '#assignee-filter' },
  { id: 'rolling', selector: '#rolling' },
  { id: 'excluded', selector: '#excluded' },
  { id: 'stats', selector: '#cc-stats' },
  { id: 'chart', selector: '#chart' },
  { id: 'people', selector: '#people-table' },
  { id: 'issues', selector: '#issues-table' },
  { id: 'storage', selector: '#btn-storage' },
];

let layer = null;
let bar = null;
let card = null;
let marks = [];
let activeIndex = -1;

export function isActive() {
  return Boolean(layer);
}

/** Ставит метку в левый верхний угол элемента, не вылезая за край окна. */
function placeMark(mark, element) {
  const rect = element.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    mark.hidden = true;
    return;
  }
  mark.hidden = false;
  mark.style.left = `${Math.max(4, rect.left + window.scrollX - 9)}px`;
  mark.style.top = `${Math.max(4, rect.top + window.scrollY - 9)}px`;
}

function reposition() {
  for (const { mark, element } of marks) placeMark(mark, element);
  if (activeIndex >= 0) showCard(activeIndex);
}

function showCard(index) {
  const { mark, spot } = marks[index];
  activeIndex = index;
  for (const item of marks) item.mark.classList.toggle('is-active', item.mark === mark);

  card.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'tour-card-title';
  title.textContent = `${index + 1}. ${t(`tour.${spot.id}.title`)}`;
  const text = document.createElement('div');
  text.className = 'tour-card-text';
  text.textContent = t(`tour.${spot.id}.text`);
  card.append(title, text);
  card.hidden = false;

  // Карточка идёт правее метки, но не за правым краем окна.
  const markLeft = parseFloat(mark.style.left);
  const markTop = parseFloat(mark.style.top);
  const width = card.offsetWidth;
  const left = Math.min(markLeft + 26, window.scrollX + document.documentElement.clientWidth - width - 12);
  card.style.left = `${Math.max(window.scrollX + 8, left)}px`;
  card.style.top = `${markTop + 26}px`;
}

function hideCard() {
  activeIndex = -1;
  card.hidden = true;
  for (const item of marks) item.mark.classList.remove('is-active');
}

function onKeyDown(event) {
  if (event.key === 'Escape') stop();
}

/** Включает режим подсказок. */
export function start() {
  if (layer) return;

  layer = document.createElement('div');
  layer.className = 'tour-layer';

  card = document.createElement('div');
  card.className = 'tour-card';
  card.hidden = true;
  layer.appendChild(card);

  marks = [];
  SPOTS.forEach((spot, index) => {
    const element = document.querySelector(spot.selector);
    if (!element) return;
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'tour-mark';
    mark.textContent = String(index + 1);
    mark.title = t(`tour.${spot.id}.title`);
    mark.addEventListener('click', () => {
      const position = marks.findIndex((item) => item.mark === mark);
      if (position === activeIndex) hideCard();
      else showCard(position);
    });
    layer.appendChild(mark);
    marks.push({ spot, element, mark });
  });

  bar = document.createElement('div');
  bar.className = 'tour-bar';
  const label = document.createElement('span');
  label.textContent = t('tour.bar');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn btn-sm';
  close.textContent = t('tour.close');
  close.addEventListener('click', stop);
  bar.append(label, close);

  // Внутрь вкладки: стили и переменные Control Chart привязаны к #page-cc. Контейнер не позиционирован,
  // поэтому координаты меток по-прежнему считаются от документа.
  (document.querySelector('#page-cc') || document.body).append(layer, bar);
  for (const { mark, element } of marks) placeMark(mark, element);

  window.addEventListener('resize', reposition);
  window.addEventListener('scroll', reposition, { passive: true });
  document.addEventListener('keydown', onKeyDown);
}

/** Выключает режим подсказок и убирает всё за собой. */
export function stop() {
  if (!layer) return;
  window.removeEventListener('resize', reposition);
  window.removeEventListener('scroll', reposition);
  document.removeEventListener('keydown', onKeyDown);
  layer.remove();
  bar.remove();
  layer = null;
  bar = null;
  card = null;
  marks = [];
  activeIndex = -1;
}

export function toggle() {
  if (layer) stop();
  else start();
}
