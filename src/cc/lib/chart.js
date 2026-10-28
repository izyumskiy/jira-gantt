// Отрисовка Control Chart на «голом» SVG: точки, скользящее среднее,
// полоса ±1σ, линия среднего, перцентили, зум мышью и подсказки.

import { MIN_PER_DAY, minToDate, toMin as dateToMin } from './codec.js';
import { formatDuration, formatDateShort, formatDateTime, formatDays, escapeHtml } from './format.js';
import { t, tn } from './i18n.js';

const NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 16, right: 18, bottom: 34, left: 62 };

const Y_STEPS = [15, 30, 60, 120, 240, 480, 720, 1440, 2880, 4320, 7200, 10080,
  14400, 20160, 30240, 43200, 86400, 129600, 259200, 525600];
const X_STEPS_DAYS = [1, 2, 3, 7, 14, 30, 60, 90, 180, 365];

function el(name, attrs = {}) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Начало локальных суток для момента (в минутах от эпохи). */
function dayStart(min) {
  const d = minToDate(min);
  d.setHours(0, 0, 0, 0);
  return dateToMin(d);
}

function niceYStep(maxValue, target = 5) {
  for (const step of Y_STEPS) {
    if (maxValue / step <= target) return step;
  }
  return Y_STEPS[Y_STEPS.length - 1];
}

export class ControlChart {
  /**
   * @param {HTMLElement} container
   * @param {{onZoom?:Function, onPick?:Function}} handlers
   */
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.data = { points: [], rolling: [], stats: null, rollingWindow: 0 };
    // Подсветка одного исполнителя на фоне остальных: код + его скользящее среднее.
    this.highlight = null;
    this.options = {
      showBand: true,
      showRolling: true,
      showAverage: true,
      showP85: true,
      logScale: false,
    };
    this.ctx = { typeName: () => '', projectKey: () => '', statusName: () => '', issueUrl: () => null };

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'cc-tooltip';
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);

    this.svg = el('svg', { class: 'cc-svg' });
    container.appendChild(this.svg);

    // Состояние протяжки живёт на экземпляре: при каждой перерисовке SVG
    // пересобирается, а обработчики окна должны остаться в одном экземпляре.
    this._brushing = false;
    this._startX = 0;
    this._onMouseUp = (event) => this._finishBrush(event);
    this._onDblClick = () => this.handlers.onZoom?.(null, null);
    window.addEventListener('mouseup', this._onMouseUp);
    this.svg.addEventListener('dblclick', this._onDblClick);

    this._resize = new ResizeObserver(() => this.render());
    this._resize.observe(container);
  }

  destroy() {
    this._resize.disconnect();
    window.removeEventListener('mouseup', this._onMouseUp);
    this.svg.removeEventListener('dblclick', this._onDblClick);
    this.svg.remove();
    this.tooltip.remove();
  }

  setContext(ctx) {
    this.ctx = { ...this.ctx, ...ctx };
  }

  setOptions(patch) {
    // Пересчёт зовёт нас на каждый чих; перерисовываем только при реальной смене.
    const changed = Object.entries(patch).some(([key, value]) => this.options[key] !== value);
    this.options = { ...this.options, ...patch };
    if (changed) this.render();
  }

  /**
   * @param {object} data
   * @param {{code:number, rolling:Array}|null} [highlight] — если передан,
   *   применяется вместе с данными, чтобы не перерисовывать график дважды.
   */
  setData(data, highlight) {
    this.data = data;
    if (arguments.length > 1) this.highlight = highlight;
    this.render();
  }

  /**
   * Подсвечивает точки одного исполнителя (code) или целой команды (codes — набор кодов
   * исполнителей), остальные приглушает.
   * @param {{code:number, codes?:Set<number>, rolling:Array}|null} highlight
   */
  setHighlight(highlight) {
    this.highlight = highlight;
    this.render();
  }

  // ------------------------------------------------------------ отрисовка

  render() {
    // Контейнер может быть ещё не разложен (скрытая вкладка, первый кадр) —
    // ResizeObserver позовёт нас снова, когда появится ширина.
    if (this.container.clientWidth < 1) return;
    const width = Math.max(320, this.container.clientWidth);
    const height = Math.max(240, this.container.clientHeight);
    const { points, rolling, stats } = this.data;

    this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    this.svg.setAttribute('width', width);
    this.svg.setAttribute('height', height);
    while (this.svg.firstChild) this.svg.removeChild(this.svg.firstChild);

    const plotW = width - MARGIN.left - MARGIN.right;
    const plotH = height - MARGIN.top - MARGIN.bottom;
    if (plotW <= 10 || plotH <= 10) return;

    if (!points.length) {
      const text = el('text', {
        x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'cc-empty',
      });
      text.textContent = t('chart.empty');
      this.svg.appendChild(text);
      return;
    }

    // --- шкалы
    let xMin = points[0].doneAt;
    let xMax = points[points.length - 1].doneAt;
    if (xMax - xMin < MIN_PER_DAY) { xMin -= MIN_PER_DAY / 2; xMax += MIN_PER_DAY / 2; }
    const padX = (xMax - xMin) * 0.02;
    xMin -= padX;
    xMax += padX;

    let yMax = 0;
    for (const p of points) yMax = Math.max(yMax, p.cycle);
    if (this.options.showBand) for (const r of rolling) yMax = Math.max(yMax, r.hi);
    yMax = Math.max(yMax * 1.08, 60);
    const yMin = this.options.logScale ? Math.max(15, Math.min(...points.map((p) => p.cycle)) * 0.8) : 0;

    const xScale = (min) => MARGIN.left + ((min - xMin) / (xMax - xMin)) * plotW;
    const yScale = this.options.logScale
      ? (v) => {
        const lo = Math.log(yMin);
        const hi = Math.log(yMax);
        const value = Math.log(Math.max(v, yMin));
        return MARGIN.top + plotH - ((value - lo) / (hi - lo)) * plotH;
      }
      : (v) => MARGIN.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

    this._xScale = xScale;
    this._xMin = xMin;
    this._xMax = xMax;
    this._plot = { x: MARGIN.left, y: MARGIN.top, w: plotW, h: plotH };

    const root = el('g');
    this.svg.appendChild(root);

    // --- сетка и оси
    const grid = el('g', { class: 'cc-grid' });
    root.appendChild(grid);

    const yStep = niceYStep(yMax, 5);
    const yTicks = [];
    if (this.options.logScale) {
      for (const step of Y_STEPS) {
        if (step >= yMin && step <= yMax) yTicks.push(step);
      }
    } else {
      for (let v = 0; v <= yMax; v += yStep) yTicks.push(v);
    }
    for (const v of yTicks) {
      const y = yScale(v);
      grid.appendChild(el('line', {
        x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y, y2: y, class: 'cc-gridline',
      }));
      const label = el('text', {
        x: MARGIN.left - 8, y: y + 4, 'text-anchor': 'end', class: 'cc-tick',
      });
      label.textContent = v === 0 ? '0' : formatDays(v);
      grid.appendChild(label);
    }

    const spanDays = (xMax - xMin) / MIN_PER_DAY;
    const stepDays = X_STEPS_DAYS.find((d) => spanDays / d <= 8) || 365;
    let tick = dayStart(xMin);
    while (tick < xMin) tick += MIN_PER_DAY;
    for (; tick <= xMax; tick += stepDays * MIN_PER_DAY) {
      const x = xScale(tick);
      grid.appendChild(el('line', {
        x1: x, x2: x, y1: MARGIN.top, y2: MARGIN.top + plotH, class: 'cc-gridline cc-gridline-v',
      }));
      const label = el('text', {
        x, y: MARGIN.top + plotH + 18, 'text-anchor': 'middle', class: 'cc-tick',
      });
      label.textContent = formatDateShort(tick);
      grid.appendChild(label);
    }

    root.appendChild(el('line', {
      x1: MARGIN.left, x2: MARGIN.left + plotW,
      y1: MARGIN.top + plotH, y2: MARGIN.top + plotH, class: 'cc-axis',
    }));

    // --- полоса ±1σ
    if (this.options.showBand && rolling.length > 1) {
      const up = rolling.map((r) => `${xScale(r.x).toFixed(1)},${yScale(r.hi).toFixed(1)}`);
      const down = rolling.slice().reverse()
        .map((r) => `${xScale(r.x).toFixed(1)},${yScale(Math.max(r.lo, yMin)).toFixed(1)}`);
      root.appendChild(el('polygon', { class: 'cc-band', points: [...up, ...down].join(' ') }));
    }

    // --- среднее и перцентили
    if (this.options.showAverage && stats) {
      const y = yScale(stats.avg);
      root.appendChild(el('line', {
        x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y, y2: y, class: 'cc-avg-line',
      }));
      const label = el('text', { x: MARGIN.left + plotW - 4, y: y - 6, 'text-anchor': 'end', class: 'cc-line-label' });
      label.textContent = t('chart.avgLabel', { value: formatDuration(stats.avg) });
      root.appendChild(label);
    }
    if (this.options.showP85 && stats) {
      const y = yScale(stats.p85);
      root.appendChild(el('line', {
        x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y, y2: y, class: 'cc-p85-line',
      }));
      const label = el('text', { x: MARGIN.left + plotW - 4, y: y - 6, 'text-anchor': 'end', class: 'cc-line-label cc-p85-label' });
      label.textContent = t('chart.p85Label', { value: formatDuration(stats.p85) });
      root.appendChild(label);
    }

    // --- точки (склеиваем близкие в один кружок)
    // При подсветке кластеризуем группы раздельно, иначе точки выбранного
    // человека склеятся с чужими и подсветка потеряет смысл.
    const highlightCode = this.highlight ? this.highlight.code : null;
    const hlCodes = this.highlight?.codes || null;
    const isPicked = (p) => (hlCodes ? hlCodes.has(p.as ?? -1) : (p.as ?? -1) === highlightCode);
    const cluster = (list) => {
      const map = new Map();
      for (const p of list) {
        const px = xScale(p.doneAt);
        const py = yScale(p.cycle);
        const key = `${Math.round(px / 7)}:${Math.round(py / 7)}`;
        let group = map.get(key);
        if (!group) {
          group = { x: px, y: py, items: [] };
          map.set(key, group);
        }
        group.items.push(p);
      }
      return [...map.values()];
    };

    const dimmed = highlightCode === null
      ? cluster(points)
      : cluster(points.filter((p) => !isPicked(p)));
    const picked = highlightCode === null
      ? []
      : cluster(points.filter(isPicked));
    this._clusters = [...dimmed, ...picked];

    const drawDots = (list, extraClass) => {
      const dots = el('g', { class: `cc-dots${extraClass ? ` ${extraClass}` : ''}` });
      for (const group of list) {
        const n = group.items.length;
        const r = n === 1 ? 3.4 : Math.min(11, 3.4 + Math.log2(n) * 1.9);
        dots.appendChild(el('circle', {
          cx: group.x.toFixed(1), cy: group.y.toFixed(1), r: r.toFixed(1), class: 'cc-dot',
        }));
        if (n > 1) {
          const label = el('text', {
            x: group.x, y: group.y + 3, 'text-anchor': 'middle', class: 'cc-dot-count',
          });
          label.textContent = String(n);
          dots.appendChild(label);
        }
      }
      root.appendChild(dots);
    };

    drawDots(dimmed, highlightCode === null ? '' : 'is-dimmed');
    if (picked.length) drawDots(picked, 'is-picked');

    // --- скользящее среднее: команда и (при подсветке) выбранный исполнитель
    const line = (series) => series
      .map((r) => `${xScale(r.x).toFixed(1)},${yScale(r.avg).toFixed(1)}`).join(' ');
    if (this.options.showRolling && rolling.length > 1) {
      root.appendChild(el('polyline', {
        class: `cc-rolling${highlightCode === null ? '' : ' is-dimmed'}`,
        points: line(rolling),
      }));
    }
    if (this.highlight?.rolling?.length > 1) {
      root.appendChild(el('polyline', { class: 'cc-rolling-hl', points: line(this.highlight.rolling) }));
    }

    // --- слой мыши
    const overlay = el('rect', {
      x: MARGIN.left, y: MARGIN.top, width: plotW, height: plotH, class: 'cc-overlay',
    });
    root.appendChild(overlay);
    this._brushRect = el('rect', { class: 'cc-brush', x: 0, y: MARGIN.top, width: 0, height: plotH, visibility: 'hidden' });
    root.appendChild(this._brushRect);
    this._hoverRing = el('circle', { class: 'cc-hover-ring', r: 9, visibility: 'hidden' });
    root.appendChild(this._hoverRing);

    this._bindMouse(overlay);
  }

  // -------------------------------------------------------------- мышь

  _localX(event) {
    const rect = this.svg.getBoundingClientRect();
    const scale = rect.width ? (this.svg.viewBox.baseVal.width || rect.width) / rect.width : 1;
    return (event.clientX - rect.left) * scale;
  }

  _localY(event) {
    const rect = this.svg.getBoundingClientRect();
    const scale = rect.height ? (this.svg.viewBox.baseVal.height || rect.height) / rect.height : 1;
    return (event.clientY - rect.top) * scale;
  }

  _bindMouse(overlay) {
    overlay.addEventListener('mousedown', (event) => {
      this._brushing = true;
      this._startX = this._localX(event);
      this._brushRect.setAttribute('visibility', 'visible');
      this._brushRect.setAttribute('x', this._startX);
      this._brushRect.setAttribute('width', 0);
    });

    overlay.addEventListener('mousemove', (event) => {
      const x = this._localX(event);
      if (this._brushing) {
        this._brushRect.setAttribute('x', Math.min(this._startX, x));
        this._brushRect.setAttribute('width', Math.abs(x - this._startX));
        this.tooltip.hidden = true;
        return;
      }
      this._showTooltip(x, this._localY(event));
    });

    overlay.addEventListener('mouseleave', () => {
      this.tooltip.hidden = true;
      this._hoverRing.setAttribute('visibility', 'hidden');
    });
  }

  /** Завершение протяжки: короткое движение — выбор точки, длинное — зум. */
  _finishBrush(event) {
    if (!this._brushing) return;
    this._brushing = false;
    this._brushRect?.setAttribute('visibility', 'hidden');
    const startX = this._startX;
    const endX = this._localX(event);
    if (!Number.isFinite(startX) || !Number.isFinite(endX) || !this._plot) return;
    if (Math.abs(endX - startX) < 6) {
      this._pick(Math.min(startX, endX), this._localY(event));
      return;
    }
    const toMinValue = (px) => this._xMin + ((px - this._plot.x) / this._plot.w) * (this._xMax - this._xMin);
    this.handlers.onZoom?.(
      Math.round(toMinValue(Math.min(startX, endX))),
      Math.round(toMinValue(Math.max(startX, endX))),
    );
  }

  _nearest(x, y, radius = 16) {
    let best = null;
    let bestDist = radius * radius;
    for (const cluster of this._clusters || []) {
      const dx = cluster.x - x;
      const dy = cluster.y - y;
      const dist = dx * dx + dy * dy;
      if (dist <= bestDist) {
        bestDist = dist;
        best = cluster;
      }
    }
    return best;
  }

  _pick(x, y) {
    const cluster = this._nearest(x, y);
    if (cluster) this.handlers.onPick?.(cluster.items);
  }

  _showTooltip(x, y) {
    const cluster = this._nearest(x, y);
    if (!cluster) {
      this.tooltip.hidden = true;
      this._hoverRing.setAttribute('visibility', 'hidden');
      return;
    }
    this._hoverRing.setAttribute('cx', cluster.x);
    this._hoverRing.setAttribute('cy', cluster.y);
    this._hoverRing.setAttribute('visibility', 'visible');

    const items = cluster.items.slice(0, 6);
    const rows = items.map((p) => {
      const key = `${this.ctx.projectKey(p.pj)}-${p.k}`;
      const type = this.ctx.typeName(p.ty);
      return `<div class="cc-tt-row">
        <span class="cc-tt-key">${escapeHtml(key)}</span>
        <span class="cc-tt-cycle">${escapeHtml(formatDuration(p.cycle))}</span>
        <span class="cc-tt-sum">${escapeHtml(p.su || type || '')}</span>
      </div>`;
    }).join('');

    const first = items[0];
    const breakdown = cluster.items.length === 1
      ? `<div class="cc-tt-break">${first.breakdown.map(([code, min]) =>
        `<span>${escapeHtml(this.ctx.statusName(code))}: ${escapeHtml(formatDuration(min))}</span>`).join('')}</div>`
      : '';
    const more = cluster.items.length > items.length
      ? `<div class="cc-tt-more">${escapeHtml(t('chart.tooltipMore', { count: cluster.items.length - items.length }))}</div>`
      : '';

    this.tooltip.innerHTML = `
      <div class="cc-tt-head">${escapeHtml(formatDateTime(first.doneAt))} · ${escapeHtml(tn('plural.issue', cluster.items.length))}</div>
      ${rows}${more}${breakdown}
      <div class="cc-tt-hint">${escapeHtml(t('chart.tooltipHint'))}</div>`;

    const rect = this.svg.getBoundingClientRect();
    const scaleX = rect.width / (this.svg.viewBox.baseVal.width || rect.width);
    const scaleY = rect.height / (this.svg.viewBox.baseVal.height || rect.height);
    this.tooltip.hidden = false;
    const tipW = this.tooltip.offsetWidth;
    const left = Math.min(Math.max(4, cluster.x * scaleX + 14), rect.width - tipW - 4);
    const top = Math.max(4, cluster.y * scaleY - 12);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }
}
