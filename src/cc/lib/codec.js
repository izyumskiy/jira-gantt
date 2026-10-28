// Кодирование/декодирование компактного представления задач.
//
// Идея экономии места:
//  1. Время — целые МИНУТЫ от 2000-01-01 UTC (вместо ISO-строк в 24 байта).
//  2. Строки-повторы (статусы, типы, проекты, приоритеты, исполнители, метки)
//     живут в словарях, в записи задачи лежит маленький целочисленный код.
//  3. История переходов по статусам (то, ради чего вообще нужна выгрузка)
//     пакуется в Uint8Array: varint(дельта минут от предыдущего перехода) +
//     varint(код статуса). Дельты маленькие → ~3 байта на переход вместо
//     ~120 байт JSON-объекта.
//
// Подробности — docs/DATA-MODEL.md

export const EPOCH_MS = Date.UTC(2000, 0, 1); // 946684800000
export const MIN_PER_DAY = 1440;
const MIN_MS = 60000;

/** ISO-строка / Date / ms → минуты от эпохи (или -1). */
export function toMin(value) {
  if (value === null || value === undefined || value === '') return -1;
  const ms = value instanceof Date ? value.getTime()
    : typeof value === 'number' ? value
    : Date.parse(value);
  if (!Number.isFinite(ms)) return -1;
  return Math.round((ms - EPOCH_MS) / MIN_MS);
}

/** Минуты от эпохи → ms. */
export function minToMs(min) {
  return EPOCH_MS + min * MIN_MS;
}

/** Минуты от эпохи → Date. */
export function minToDate(min) {
  return new Date(minToMs(min));
}

/** Текущий момент в минутах от эпохи. */
export function nowMin() {
  return Math.round((Date.now() - EPOCH_MS) / MIN_MS);
}

// ---------------------------------------------------------------- varint

class ByteWriter {
  constructor() {
    this.buf = new Uint8Array(64);
    this.len = 0;
  }
  _ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  /** LEB128, беззнаковый. */
  varuint(value) {
    let v = value >>> 0;
    this._ensure(5);
    while (v >= 0x80) {
      this.buf[this.len++] = (v & 0x7f) | 0x80;
      v >>>= 7;
    }
    this.buf[this.len++] = v;
  }
  bytes() {
    return this.buf.slice(0, this.len);
  }
}

class ByteReader {
  constructor(bytes) {
    this.b = bytes;
    this.p = 0;
  }
  get eof() {
    return this.p >= this.b.length;
  }
  varuint() {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.b[this.p++];
      result += (byte & 0x7f) * Math.pow(2, shift);
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }
}

// ------------------------------------------------------------ переходы

/**
 * Пакует историю статусов.
 * @param {{t:number,s:number}[]} steps — абсолютные минуты + код статуса,
 *        отсортированы по возрастанию, первый элемент = момент создания задачи.
 * @returns {Uint8Array}
 */
export function packSteps(steps) {
  const w = new ByteWriter();
  let prev = steps.length ? steps[0].t : 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const delta = Math.max(0, step.t - prev);
    prev = step.t;
    w.varuint(delta);
    w.varuint(step.s);
  }
  return w.bytes();
}

/**
 * Разворачивает историю статусов обратно в абсолютные минуты.
 * @param {Uint8Array|ArrayBuffer} packed
 * @param {number} createdMin — момент создания задачи (первая дельта от него).
 * @returns {{t:number,s:number}[]}
 */
export function unpackSteps(packed, createdMin) {
  if (!packed) return [];
  const bytes = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
  const r = new ByteReader(bytes);
  const out = [];
  let t = createdMin;
  while (!r.eof) {
    t += r.varuint();
    const s = r.varuint();
    out.push({ t, s });
  }
  return out;
}

/**
 * Отрезки «задача находилась в статусе S с t1 по t2».
 * Последний отрезок закрывается моментом `until` (по умолчанию — сейчас).
 */
export function toSegments(steps, until = nowMin()) {
  const segs = [];
  for (let i = 0; i < steps.length; i++) {
    const from = steps[i].t;
    const to = i + 1 < steps.length ? steps[i + 1].t : Math.max(from, until);
    segs.push({ s: steps[i].s, from, to });
  }
  return segs;
}

// ------------------------------------------------------------- словари

/**
 * Словарь строк: строка ↔ маленький целочисленный код.
 * Хранится одной записью в сторе `dicts`, в записях задач — только код.
 */
export class Dict {
  constructor(name, items = []) {
    this.name = name;
    this.items = items.slice();
    this.index = new Map(this.items.map((v, i) => [v, i]));
    this.dirty = false;
  }
  /** Код строки; при необходимости добавляет её в словарь. */
  code(value) {
    if (value === null || value === undefined || value === '') return -1;
    const key = String(value);
    let code = this.index.get(key);
    if (code === undefined) {
      code = this.items.length;
      this.items.push(key);
      this.index.set(key, code);
      this.dirty = true;
    }
    return code;
  }
  /** Строка по коду (или ''). */
  name_(code) {
    return code >= 0 && code < this.items.length ? this.items[code] : '';
  }
  toRecord() {
    return { n: this.name, a: this.items };
  }
  static fromRecord(rec, name) {
    return new Dict(name || rec?.n, rec?.a || []);
  }
}

/**
 * Словарь статусов: кроме имени хранит id Jira и категорию
 * (`new` / `indeterminate` / `done`) — она нужна, чтобы понять,
 * какие колонки считать завершающими.
 */
export class StatusDict {
  constructor(items = []) {
    this.items = items.slice(); // [{id, n, c}]
    this.byId = new Map(this.items.map((v, i) => [String(v.id), i]));
  }
  code(id, name, category) {
    if (id === null || id === undefined) return -1;
    const key = String(id);
    let code = this.byId.get(key);
    if (code === undefined) {
      code = this.items.length;
      this.items.push({ id: key, n: name || key, c: category || '' });
      this.byId.set(key, code);
    } else {
      const item = this.items[code];
      if (name && item.n !== name) item.n = name;
      if (category && item.c !== category) item.c = category;
    }
    return code;
  }
  codeOf(id) {
    const code = this.byId.get(String(id));
    return code === undefined ? -1 : code;
  }
  get(code) {
    return this.items[code] || null;
  }
  name_(code) {
    return this.items[code]?.n || '';
  }
  category(code) {
    return this.items[code]?.c || '';
  }
  toRecord() {
    return { n: 'status', a: this.items };
  }
  static fromRecord(rec) {
    return new StatusDict(rec?.a || []);
  }
}
