// Фоновый поток для прогнозов Монте-Карло (А3): тысячи прогонов не замораживают страницу.
// Работает с чистыми функциями без DOM и сети: прогноз эпика (flow.js) и портфеля (portfolio.js, US-4).
import { forecastForTeams, seededRandom } from "./flow.js";
import { portfolioForecast } from "./portfolio.js";

self.onmessage = (e) => {
  const { id, args, kind } = e.data;
  try {
    if (kind === "portfolio") {
      self.postMessage({ id, res: portfolioForecast(args) });
      return;
    }
    const rnd = args.seed ? seededRandom(args.seed) : Math.random;
    self.postMessage({ id, res: forecastForTeams({ ...args, rnd }) });
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
