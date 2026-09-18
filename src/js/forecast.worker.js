// Фоновый поток для прогнозов Монте-Карло (А3): тысячи прогонов не замораживают страницу.
// Работает только с flow.js — чистые функции без DOM, настроек и сети.
import { forecastForTeams, seededRandom } from "./flow.js";

self.onmessage = (e) => {
  const { id, args } = e.data;
  try {
    const rnd = args.seed ? seededRandom(args.seed) : Math.random;
    self.postMessage({ id, res: forecastForTeams({ ...args, rnd }) });
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
