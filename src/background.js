// Фоновый скрипт: открывает страницу приложения по клику на иконку и ведёт автообновление (Б8).
// Сам он ничего не синхронизирует: Chrome усыпляет фоновый скрипт, и полная синхронизация может
// не успеть. Синхронизирует страница плагина — открытая пользователем или открытая здесь же
// в неактивной вкладке.
import { ALARM, PERIOD_MINUTES, planAuto, probeJira, decideNotification } from "./js/autoSync.js";

const APP_URL = chrome.runtime.getURL("src/app.html");
const NOTIFY_ID = "ohmygant-auto";

// Клик по иконке открывает полноэкранную страницу приложения (или фокусирует уже открытую).
chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: APP_URL });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
});

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM);
  if (!existing) await chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES, delayInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => ensureAlarm());
// Браузер был закрыт в назначенное время — проверяем сразу после запуска.
chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarm();
  await check();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) check();
});

async function check() {
  const { settings = {} } = await chrome.storage.local.get("settings");
  if (planAuto({ auto: settings.autoSync, lastSync: settings.lastSync }) !== "run" || !settings.baseUrl) return;
  // Без VPN — тихо ждём следующей проверки: ни вкладок, ни уведомлений.
  if (!(await probeJira(settings.baseUrl))) {
    const { autoSyncState = {} } = await chrome.storage.local.get("autoSyncState");
    await chrome.storage.local.set({ autoSyncState: { ...autoSyncState, lastAttempt: "unreachable", lastAttemptAt: Date.now() } });
    return;
  }
  const tabs = await chrome.tabs.query({ url: APP_URL });
  if (tabs.length) {
    // Страница открыта — пусть обновится сама (замок не даст двум вкладкам синхронизироваться разом).
    chrome.runtime.sendMessage({ type: "ohmygant-auto-sync" }).catch(() => {});
    return;
  }
  const tab = await chrome.tabs.create({ url: `${APP_URL}#auto`, active: false });
  await chrome.storage.session.set({ autoTab: tab.id });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "ohmygant-auto-done") onDone(msg, sender);
});

async function onDone(msg, sender) {
  const { autoSyncState = {} } = await chrome.storage.local.get("autoSyncState");
  const { notify, state } = decideNotification({ ok: msg.ok, kind: msg.kind, state: autoSyncState });
  await chrome.storage.local.set({ autoSyncState: state });
  if (notify && msg.text) {
    chrome.notifications.create(NOTIFY_ID, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Jira OhMyGant",
      message: msg.text
    });
  }
  // Вкладку автообновления закрываем, только если пользователь её не открыл.
  const { autoTab } = await chrome.storage.session.get("autoTab");
  if (autoTab && sender.tab && sender.tab.id === autoTab) {
    await chrome.storage.session.remove("autoTab");
    try {
      const tab = await chrome.tabs.get(autoTab);
      if (!tab.active) await chrome.tabs.remove(autoTab);
    } catch {
      // вкладку уже закрыли
    }
  }
}

// Клик по уведомлению — вкладка «Сводка».
chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== NOTIFY_ID) return;
  chrome.notifications.clear(id);
  const tabs = await chrome.tabs.query({ url: APP_URL });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    chrome.runtime.sendMessage({ type: "ohmygant-show-summary" }).catch(() => {});
  } else {
    await chrome.tabs.create({ url: `${APP_URL}#summary` });
  }
});
