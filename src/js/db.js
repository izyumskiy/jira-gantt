// Локальное хранилище IndexedDB: эпики, задачи, спринты, служебные ключи — и данные Control Chart.
// База одна на весь плагин: всё, что знает плагин о Jira, лежит в одном месте (в том числе для
// будущих инструментов, которым нужна полная картина). Схема описана только здесь.
const DB_NAME = "jiragantt";
const DB_VER = 9;

// others — задачи людей из целевых эпиков, лежащие в ДРУГИХ эпиках (текущий и будущие спринты).
// people — введённые вручную свойства людей (роль, системы, статус); ключ — нормализованное имя.
export const STORES = {
  epics: "epics",
  issues: "issues",
  others: "others",
  sprints: "sprints",
  boards: "boards",
  people: "people",
  tempo: "tempo", // команды Tempo с составом участников
  flow: "flow", // история завершённых задач людей — для прогноза сроков по потоку
  // Чужие задачи историй (Р2, Р5): связанные с историями выбранных эпиков, но из других эпиков или
  // без эпика. Снимок — перечитывается целиком при каждой синхронизации.
  linked: "linked",
  // История для «Сводки»: состояние эпиков на каждую синхронизацию (30 дней) и на конец недели
  // (104 недели). Удаление эпика из выбора историю не трогает — она нужна трендам и проверке прогнозов.
  syncLog: "syncLog",
  epicWeeks: "epicWeeks",
  meta: "meta",
  // Control Chart (src/cc): доски, словари строк и задачи с упакованной историей статусов.
  // Пишет и читает их только src/cc — синхронизация Ганта сюда не заходит (docs/cc/DATA-MODEL.md).
  ccBoards: "ccBoards",
  ccDicts: "ccDicts",
  ccIssues: "ccIssues"
};

// Хранилища Control Chart: у него своя выгрузка и своя чистка («Хранилище» на его вкладке), поэтому
// «Очистить базу» и импорт конфигурации Ганта их не трогают.
export const CC_STORES = new Set([STORES.ccBoards, STORES.ccDicts, STORES.ccIssues]);

let dbp = null;

export function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.epics)) {
        db.createObjectStore(STORES.epics, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORES.issues)) {
        const s = db.createObjectStore(STORES.issues, { keyPath: "key" });
        s.createIndex("epicKey", "epicKey", { unique: false });
        s.createIndex("assigneeKey", "assigneeKey", { unique: false });
        s.createIndex("projectKey", "projectKey", { unique: false });
        s.createIndex("sprintId", "sprintId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.sprints)) {
        db.createObjectStore(STORES.sprints, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.others)) {
        const o = db.createObjectStore(STORES.others, { keyPath: "key" });
        o.createIndex("assigneeKey", "assigneeKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.flow)) {
        const f = db.createObjectStore(STORES.flow, { keyPath: "key" });
        f.createIndex("resolved", "resolved", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.linked)) {
        db.createObjectStore(STORES.linked, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(STORES.tempo)) {
        db.createObjectStore(STORES.tempo, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.people)) {
        db.createObjectStore(STORES.people, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(STORES.boards)) {
        db.createObjectStore(STORES.boards, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.syncLog)) {
        const l = db.createObjectStore(STORES.syncLog, { keyPath: ["syncId", "epicKey"] });
        l.createIndex("syncId", "syncId", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.epicWeeks)) {
        const w = db.createObjectStore(STORES.epicWeeks, { keyPath: ["epicKey", "week"] });
        w.createIndex("week", "week", { unique: false });
        w.createIndex("epicKey", "epicKey", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: "k" });
      }
      // Control Chart (версия 9). Ключ задачи — [доска, id задачи]: задача на двух досках хранится
      // дважды, зато расчёт по доске — один запрос по индексу.
      if (!db.objectStoreNames.contains(STORES.ccBoards)) {
        db.createObjectStore(STORES.ccBoards, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.ccDicts)) {
        db.createObjectStore(STORES.ccDicts, { keyPath: "n" });
      }
      if (!db.objectStoreNames.contains(STORES.ccIssues)) {
        const c = db.createObjectStore(STORES.ccIssues, { keyPath: ["b", "i"] });
        c.createIndex("by_board", "b", { unique: false });
        c.createIndex("by_board_done", ["b", "dn"], { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Новая версия схемы открывается в другой странице плагина — уступаем, иначе её обновление
      // ждало бы, пока закроют эту вкладку.
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putAll(store, items) {
  if (!items.length) return;
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const os = t.objectStore(store);
    for (const it of items) os.put(it);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function all(store) {
  const db = await open();
  return done(tx(db, store, "readonly").getAll());
}

export async function getOne(store, key) {
  const db = await open();
  return done(tx(db, store, "readonly").get(key));
}

export async function delKeys(store, keys) {
  if (!keys.length) return;
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const os = t.objectStore(store);
    for (const k of keys) os.delete(k);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

// Одна транзакция на несколько хранилищ: записано либо всё, либо ничего (синхронизация, А2).
// ops — по порядку: [{ store, clear?: true, del?: [ключи], put?: [записи] }].
export async function commit(ops) {
  const stores = [...new Set(ops.map((o) => o.store))];
  if (!stores.length) return;
  const db = await open();
  await new Promise((resolve, reject) => {
    const t = db.transaction(stores, "readwrite");
    for (const op of ops) {
      const os = t.objectStore(op.store);
      if (op.clear) os.clear();
      for (const k of op.del || []) os.delete(k);
      for (const it of op.put || []) os.put(it);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// Первичные ключи записей, у которых значение индекса строго меньше bound (для чистки истории).
export async function keysBelow(store, index, bound) {
  const db = await open();
  return done(tx(db, store, "readonly").index(index).getAllKeys(IDBKeyRange.upperBound(bound, true)));
}

// Все записи с заданным значением индекса.
export async function allByIndex(store, index, value) {
  const db = await open();
  return done(tx(db, store, "readonly").index(index).getAll(IDBKeyRange.only(value)));
}

export async function clear(store) {
  const db = await open();
  await done(tx(db, store, "readwrite").clear());
}

// Очистка выгрузки. Профили людей — ручной ввод, их не трогаем; данные Control Chart — тоже.
export async function clearAll() {
  for (const s of Object.values(STORES)) if (s !== STORES.people && !CC_STORES.has(s)) await clear(s);
}

// Полная очистка, включая профили людей — перед импортом конфигурации. Control Chart не трогаем.
export async function clearEverything() {
  for (const s of Object.values(STORES)) if (!CC_STORES.has(s)) await clear(s);
}

export async function metaGet(k, dflt = null) {
  const row = await getOne(STORES.meta, k);
  return row ? row.v : dflt;
}

export async function metaSet(k, v) {
  await putAll(STORES.meta, [{ k, v }]);
}
