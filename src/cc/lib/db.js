// Доступ к данным Control Chart. Все промисы, никаких зависимостей.
//
// База — общая с OhMyGant («jiragantt»): схема и версия описаны в src/js/db.js, здесь только
// работа со своими хранилищами. Так всё, что плагин знает о Jira, лежит в одном месте.
//
// Сторы:
//   ccBoards (keyPath 'id')         — доски: имя, колонки, состояние синхронизации
//   ccDicts  (keyPath 'n')          — словари строк (status/type/project/…)
//   ccIssues (keyPath ['b','i'])    — задачи; 'b' = id доски, 'i' = id задачи
//     index by_board       -> b
//     index by_board_done  -> [b, dn]   (dn = минута попадания в «Готово»)

import { t } from './i18n.js';
import { open, STORES } from '../../js/db.js';

const BOARDS = STORES.ccBoards;
const DICTS = STORES.ccDicts;
const ISSUES = STORES.ccIssues;

export function openDB() {
  return open();
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error(t('errors.txAborted')));
  });
}

function reqDone(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode, fn) {
  const db = await openDB();
  const tx = db.transaction(name, mode);
  const store = tx.objectStore(name);
  const result = await fn(store);
  await txDone(tx);
  return result;
}

// ---------------------------------------------------------------- boards

export async function getBoards() {
  const list = await withStore(BOARDS, 'readonly', (s) => reqDone(s.getAll()));
  return list.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
}

export async function getBoard(id) {
  return withStore(BOARDS, 'readonly', (s) => reqDone(s.get(Number(id))));
}

export async function putBoard(board) {
  return withStore(BOARDS, 'readwrite', (s) => reqDone(s.put(board)));
}

export async function patchBoard(id, patch) {
  const db = await openDB();
  const tx = db.transaction(BOARDS, 'readwrite');
  const store = tx.objectStore(BOARDS);
  const current = (await reqDone(store.get(Number(id)))) || { id: Number(id) };
  const next = { ...current, ...patch, id: Number(id) };
  await reqDone(store.put(next));
  await txDone(tx);
  return next;
}

// ----------------------------------------------------------------- dicts

export async function getDictRecord(name) {
  return withStore(DICTS, 'readonly', (s) => reqDone(s.get(name)));
}

export async function putDictRecord(record) {
  return withStore(DICTS, 'readwrite', (s) => reqDone(s.put(record)));
}

// ---------------------------------------------------------------- issues

/** Пакетная запись задач (одна транзакция на пачку). */
export async function putIssues(records) {
  if (!records.length) return 0;
  const db = await openDB();
  const tx = db.transaction(ISSUES, 'readwrite');
  const store = tx.objectStore(ISSUES);
  for (const rec of records) store.put(rec);
  await txDone(tx);
  return records.length;
}

/** Все задачи доски. */
export async function getBoardIssues(boardId) {
  const db = await openDB();
  const tx = db.transaction(ISSUES, 'readonly');
  const index = tx.objectStore(ISSUES).index('by_board');
  const out = await reqDone(index.getAll(IDBKeyRange.only(Number(boardId))));
  await txDone(tx);
  return out;
}

/** Задачи доски, попавшие в «Готово» в интервале минут [from, to]. */
export async function getBoardIssuesDoneBetween(boardId, fromMin, toMin) {
  const db = await openDB();
  const tx = db.transaction(ISSUES, 'readonly');
  const index = tx.objectStore(ISSUES).index('by_board_done');
  const range = IDBKeyRange.bound([Number(boardId), fromMin], [Number(boardId), toMin]);
  const out = await reqDone(index.getAll(range));
  await txDone(tx);
  return out;
}

export async function countBoardIssues(boardId) {
  const db = await openDB();
  const tx = db.transaction(ISSUES, 'readonly');
  const index = tx.objectStore(ISSUES).index('by_board');
  const n = await reqDone(index.count(IDBKeyRange.only(Number(boardId))));
  await txDone(tx);
  return n;
}

/** Удаляет доску вместе с задачами. */
export async function deleteBoard(boardId) {
  const id = Number(boardId);
  const db = await openDB();
  const tx = db.transaction([ISSUES, BOARDS], 'readwrite');
  const index = tx.objectStore(ISSUES).index('by_board');
  const cursorReq = index.openKeyCursor(IDBKeyRange.only(id));
  const issues = tx.objectStore(ISSUES);
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      issues.delete(cursor.primaryKey);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  tx.objectStore(BOARDS).delete(id);
  await txDone(tx);
}

/**
 * Чистка: выбрасывает поле summary у всех задач доски (экономит больше всего
 * места) и/или удаляет задачи старше указанного момента.
 */
export async function vacuumBoard(boardId, { dropSummaries = false, olderThanMin = null } = {}) {
  const id = Number(boardId);
  const db = await openDB();
  const tx = db.transaction(ISSUES, 'readwrite');
  const store = tx.objectStore(ISSUES);
  const cursorReq = store.index('by_board').openCursor(IDBKeyRange.only(id));
  let removed = 0;
  let trimmed = 0;
  await new Promise((resolve, reject) => {
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve();
      const rec = cursor.value;
      const finished = rec.dn >= 0 ? rec.dn : rec.c;
      if (olderThanMin !== null && finished < olderThanMin) {
        cursor.delete();
        removed++;
      } else if (dropSummaries && rec.su) {
        delete rec.su;
        cursor.update(rec);
        trimmed++;
      }
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
  await txDone(tx);
  return { removed, trimmed };
}

/** Полная очистка данных Control Chart (данные Ганта и настройки не трогаем). */
export async function wipeAll() {
  const db = await openDB();
  const names = [ISSUES, BOARDS, DICTS];
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  await txDone(tx);
}

/** Оценка занятого места: браузерная квота + счётчики по доскам. */
export async function storageStats() {
  const boards = await getBoards();
  const perBoard = [];
  let total = 0;
  for (const b of boards) {
    const n = await countBoardIssues(b.id);
    perBoard.push({ id: b.id, name: b.name, issues: n });
    total += n;
  }
  let usage = null;
  let quota = null;
  if (navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      usage = est.usage ?? null;
      quota = est.quota ?? null;
    } catch { /* нет доступа к квоте — не критично */ }
  }
  return { boards: perBoard, issues: total, usage, quota };
}
