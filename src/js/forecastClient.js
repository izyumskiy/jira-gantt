// Прогнозы Монте-Карло в фоновых потоках (А3). Потоков несколько (по числу ядер, не больше 4):
// восстановление истории считает тысячи прогнозов, и в фоновой вкладке, где Chrome урезает
// процессорное время, один поток не успевал бы. Если потоки создать нельзя — считаем здесь же,
// результат тот же.
import { forecastForTeams, seededRandom } from "./flow.js";
import { portfolioForecast } from "./portfolio.js";

const POOL = Math.max(1, Math.min(4, ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 2) - 1));
let workers = null;
let broken = false;
let next = 0;
let seq = 0;
const pending = new Map();

const local = (args) => forecastForTeams({ ...args, rnd: args.seed ? seededRandom(args.seed) : Math.random });

function breakPool() {
  // Поток не поднялся (например, модуль не загрузился) — дальше считаем на странице.
  broken = true;
  for (const w of workers || []) w.terminate();
  workers = null;
  for (const [id, p] of pending) {
    pending.delete(id);
    p.fallback();
  }
}

function pool() {
  if (workers || broken) return workers;
  try {
    workers = Array.from({ length: POOL }, () => {
      const w = new Worker(new URL("./forecast.worker.js", import.meta.url), { type: "module" });
      w.onmessage = (e) => {
        const { id, res, error } = e.data;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        error ? p.reject(new Error(error)) : p.resolve(res);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        breakPool();
      };
      return w;
    });
  } catch {
    breakPool();
  }
  return workers;
}

// args — как у forecastForTeams, но вместо генератора — необязательное зерно seed (строка).
export function runForecast(args) {
  return send(undefined, args, local);
}

// Прогноз портфеля (US-4): args — как у portfolioForecast.
export function runPortfolio(args) {
  return send("portfolio", args, portfolioForecast);
}

function send(kind, args, here) {
  const ws = pool();
  if (!ws) return Promise.resolve(here(args));
  const w = ws[next++ % ws.length];
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, fallback: () => resolve(here(args)) });
    w.postMessage({ id, args, kind });
  });
}

// Для проверок: работают ли фоновые потоки и сколько их.
export const workerAvailable = () => !!pool();
export const poolSize = () => (pool() || []).length;
