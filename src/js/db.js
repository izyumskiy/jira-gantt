// Локальное хранилище IndexedDB: эпики, задачи, спринты, служебные ключи.
const DB_NAME = "jiragantt";
const DB_VER = 4;

// others — задачи людей из целевых эпиков, лежащие в ДРУГИХ эпиках (текущий и будущие спринты).
// people — введённые вручную свойства людей (роль, системы, статус); ключ — нормализованное имя.
export const STORES = {
  epics: "epics",
  issues: "issues",
  others: "others",
  sprints: "sprints",
  boards: "boards",
  people: "people",
  meta: "meta"
};

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
      if (!db.objectStoreNames.contains(STORES.people)) {
        db.createObjectStore(STORES.people, { keyPath: "name" });
      }
      if (!db.objectStoreNames.contains(STORES.boards)) {
        db.createObjectStore(STORES.boards, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORES.meta)) {
        db.createObjectStore(STORES.meta, { keyPath: "k" });
      }
    };
    req.onsuccess = () => resolve(req.result);
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

export async function clear(store) {
  const db = await open();
  await done(tx(db, store, "readwrite").clear());
}

// Очистка выгрузки. Профили людей — ручной ввод, их не трогаем.
export async function clearAll() {
  for (const s of Object.values(STORES)) if (s !== STORES.people) await clear(s);
}

// Полная очистка, включая профили людей — перед импортом конфигурации.
export async function clearEverything() {
  for (const s of Object.values(STORES)) await clear(s);
}

export async function metaGet(k, dflt = null) {
  const row = await getOne(STORES.meta, k);
  return row ? row.v : dflt;
}

export async function metaSet(k, v) {
  await putAll(STORES.meta, [{ k, v }]);
}
