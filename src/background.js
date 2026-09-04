// Клик по иконке открывает полноэкранную страницу приложения (или фокусирует уже открытую).
const APP_URL = chrome.runtime.getURL("src/app.html");

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: APP_URL });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: APP_URL });
  }
});
