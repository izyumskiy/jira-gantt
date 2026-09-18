// Прогнозы Монте-Карло в фоновом потоке (А3). Если поток создать нельзя — считаем здесь же,
// результат тот же.
import { forecastForTeams, seededRandom } from "./flow.js";

let worker = null;
let broken = false;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker || broken) return worker;
  try {
    worker = new Worker(new URL("./forecast.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const { id, res, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      error ? p.reject(new Error(error)) : p.resolve(res);
    };
    worker.onerror = (e) => {
      // Поток не поднялся (например, модуль не загрузился) — дальше считаем на странице.
      broken = true;
      worker = null;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.fallback();
      }
      e.preventDefault?.();
    };
  } catch {
    broken = true;
    worker = null;
  }
  return worker;
}

const local = (args) => forecastForTeams({ ...args, rnd: args.seed ? seededRandom(args.seed) : Math.random });

// args — как у forecastForTeams, но вместо генератора — необязательное зерно seed (строка).
export function runForecast(args) {
  const w = getWorker();
  if (!w) return Promise.resolve(local(args));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, fallback: () => resolve(local(args)) });
    w.postMessage({ id, args });
  });
}

// Для проверок: работает ли фоновый поток.
export const workerAvailable = () => !!getWorker();
