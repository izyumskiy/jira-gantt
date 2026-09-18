// Автообновление (Б8) и одна синхронизация на все вкладки (А4). Модуль без DOM и без chrome.* —
// его используют и фоновый скрипт, и страница, и селфтест.
//
// Jira доступна только через VPN, поэтому обновление не привязано к точному времени: оно
// «догоняющее» — один раз за рабочий день, как только Jira стала доступна. Будильник срабатывает
// каждые 15 минут, проверяет план и лёгкой пробой — доступна ли Jira; без VPN тихо ждёт.

export const ALARM = "ohmygant-auto-sync";
export const PERIOD_MINUTES = 15;
export const PROBE_TIMEOUT_MS = 5000;
export const SYNC_LOCK = "ohmygant-sync";
export const CHANNEL = "ohmygant";
export const DEFAULT_AUTO = { enabled: false, days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" };

const p2 = (n) => String(n).padStart(2, "0");

// Местная дата «ГГГГ-ММ-ДД».
export function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const minutes = (hhmm) => {
  const [h, m] = String(hhmm || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

// Что делать сейчас: "disabled" | "day" (не рабочий день) | "window" (вне окна) | "done" (сегодня
// уже была успешная синхронизация — ручная тоже считается) | "run".
export function planAuto({ auto, now = Date.now(), lastSync = 0 }) {
  const a = { ...DEFAULT_AUTO, ...(auto || {}) };
  if (!a.enabled) return "disabled";
  const d = new Date(now);
  const dow = d.getDay() === 0 ? 7 : d.getDay(); // 1 = понедельник … 7 = воскресенье
  if (!a.days.includes(dow)) return "day";
  const m = d.getHours() * 60 + d.getMinutes();
  if (m < minutes(a.from) || m >= minutes(a.to)) return "window";
  if (lastSync && dayKey(lastSync) === dayKey(now)) return "done";
  return "run";
}

// Проба доступности: любой HTTP-ответ (даже «не авторизован») — Jira доступна; сетевая ошибка или
// таймаут — нет (выключен VPN, нет сети).
export async function probeJira(baseUrl, { timeoutMs = PROBE_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  if (!baseUrl) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}/status`, { signal: ctrl.signal, credentials: "include", cache: "no-store" });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Итог автообновления → показать ли уведомление и новое состояние.
//   успех — всегда (сколько новых сигналов); Jira недоступна — молча, повтор на следующей проверке;
//   не авторизован и прочие ошибки — не чаще раза в день каждого вида.
export function decideNotification({ ok, kind = "", state = {}, now = Date.now() }) {
  const today = dayKey(now);
  const next = { ...state, lastAttemptAt: now, notified: { ...(state.notified || {}) } };
  if (ok) {
    next.lastAttempt = "ok";
    return { notify: true, state: next };
  }
  if (kind === "network") {
    next.lastAttempt = "unreachable";
    return { notify: false, state: next };
  }
  const k = kind === "auth" ? "auth" : "other";
  next.lastAttempt = k;
  if (next.notified[k] === today) return { notify: false, state: next };
  next.notified[k] = today;
  return { notify: true, state: next };
}

// Одна синхронизация на все вкладки (А4): если замок занят другой вкладкой, fn не запускается —
// onBusy вызывается сразу, а результат — { busy: true, done } (done ждёт освобождения замка).
export async function withSyncLock(fn, { locks = globalThis.navigator && navigator.locks, onBusy = () => {} } = {}) {
  if (!locks) return { busy: false, result: await fn() };
  let busy = false;
  const result = await locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      busy = true;
      return null;
    }
    return fn();
  });
  if (!busy) return { busy: false, result };
  onBusy();
  return { busy: true, done: locks.request(SYNC_LOCK, async () => {}) };
}
