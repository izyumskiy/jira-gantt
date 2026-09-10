import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const browserPath = chromeCandidates.find(existsSync);
if (!browserPath) throw new Error("Chrome/Edge не найден: браузерный smoke-test пропущен");

const mime = new Map([
  [".html", "text/html; charset=utf-8"], [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"], [".json", "application/json; charset=utf-8"],
  [".png", "image/png"], [".svg", "image/svg+xml"]
]);
const server = http.createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const target = path.resolve(root, `.${pathname}`);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("outside root");
    const body = await fs.readFile(target);
    response.writeHead(200, { "Content-Type": mime.get(path.extname(target)) || "application/octet-stream" });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end("not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const profile = await fs.mkdtemp(path.join(os.tmpdir(), "jira-gantt-browser-smoke-"));
const browser = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--window-size=1440,900", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"
], { stdio: "ignore", windowsHide: true });

const waitFor = async (fn, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Smoke-test timeout ${timeoutMs} ms`);
};

let socket;
try {
  const debugFile = path.join(profile, "DevToolsActivePort");
  const [debugPort] = (await waitFor(async () => (await fs.readFile(debugFile, "utf8")).trim())).split(/\r?\n/);
  const target = await waitFor(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()).find((row) => row.type === "page"));
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let requestId = 0;
  const pending = new Map();
  const exceptions = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      return message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails?.text || "JavaScript exception");
  };
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  // Legacy self-test asserts the light theme's exact RGB values.
  await cdp("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }]
  });
  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/dev/apptest.html` });
  await waitFor(async () => {
    const result = await cdp("Runtime.evaluate", { expression: "document.readyState === 'complete' && Boolean(document.querySelector('#pfCalculate'))", returnByValue: true });
    return result.result?.value;
  });
  await cdp("Runtime.evaluate", { expression: "document.querySelector('[data-tab=analysis]').click()" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const analyticsInspected = await cdp("Runtime.evaluate", {
    expression: `JSON.stringify({
      visible: !document.querySelector('#page-analysis').classList.contains('hidden'),
      hasTeamLoader: document.querySelector('#paLoadTeams') instanceof HTMLElement,
      hasPeriod: document.querySelector('#paFrom') instanceof HTMLElement && document.querySelector('#paTo') instanceof HTMLElement,
      teamTabKept: document.querySelector('[data-tab=team]') instanceof HTMLElement,
      legacyShellKept: [
        '#btnFind',
        '#page-epicPeople',
        '#epicPeopleChart',
        '#page-team',
        '#page-settings'
      ].every((selector) => document.querySelector(selector) instanceof HTMLElement),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1
    })`, returnByValue: true
  });
  const analyticsState = JSON.parse(analyticsInspected.result?.value || "{}");
  assert.equal(analyticsState.visible, true);
  assert.equal(analyticsState.hasTeamLoader, true);
  assert.equal(analyticsState.hasPeriod, true);
  assert.equal(analyticsState.teamTabKept, true, "Существующая вкладка команды должна сохраниться");
  assert.equal(analyticsState.legacyShellKept, true, "Существующие страницы и элементы OhMyGant должны сохраниться");
  assert.equal(analyticsState.overflow, false, "Страница аналитики не должна создавать горизонтальный overflow окна");
  await cdp("Runtime.evaluate", { expression: "document.querySelector('[data-tab=forecast]').click()" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const inspected = await cdp("Runtime.evaluate", {
    expression: `JSON.stringify({
      forecastVisible: !document.querySelector('#page-forecast').classList.contains('hidden'),
      participantCount: document.querySelector('#pfParticipantCount')?.textContent,
      hasPortfolio: document.querySelector('#pfActiveRows') instanceof HTMLElement,
      hasCapacity: document.querySelector('#pfCapacityRows') instanceof HTMLElement,
      hasProgress: document.querySelector('#pfProgress') instanceof HTMLElement,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1
    })`, returnByValue: true
  });
  const state = JSON.parse(inspected.result?.value || "{}");
  assert.equal(exceptions.length, 0, exceptions.join("; "));
  assert.equal(state.forecastVisible, true);
  assert.equal(state.participantCount, "0");
  assert.equal(state.hasPortfolio, true);
  assert.equal(state.hasCapacity, true);
  assert.equal(state.hasProgress, true);
  assert.equal(state.overflow, false, "Страница прогноза не должна создавать горизонтальный overflow окна");

  await cdp("Page.navigate", { url: `http://127.0.0.1:${port}/dev/selftest.html` });
  await waitFor(async () => {
    const result = await cdp("Runtime.evaluate", {
      expression: "document.readyState === 'complete' && /ALL PASSED|FAILED/.test(document.querySelector('#log')?.firstElementChild?.textContent || '')",
      returnByValue: true
    });
    return result.result?.value;
  });
  const legacyInspected = await cdp("Runtime.evaluate", {
    expression: `JSON.stringify({
      total: document.querySelector('#log')?.firstElementChild?.textContent || '',
      failures: document.querySelectorAll('#log .t-fail').length,
      failureMessages: [...document.querySelectorAll('#log .t-fail')].slice(1).map((node) => node.textContent)
    })`,
    returnByValue: true
  });
  const legacyState = JSON.parse(legacyInspected.result?.value || "{}");
  assert.equal(legacyState.total, "ALL PASSED", `Встроенный self-test OhMyGant: ${legacyState.total}; ${legacyState.failureMessages?.join('; ')}`);
  assert.equal(legacyState.failures, 0, "Встроенный self-test OhMyGant не должен содержать ошибок");
  assert.equal(exceptions.length, 0, exceptions.join("; "));
  console.log("Analytics, project forecast and legacy OhMyGant browser smoke-test: OK");
} finally {
  socket?.close();
  if (browser.exitCode == null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
  server.close();
  if (path.basename(profile).startsWith("jira-gantt-browser-smoke-")) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        await fs.rm(profile, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error.code !== "EBUSY" || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}
