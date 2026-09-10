// Объяснение перехода от базовой оценки к P50/P80/P90.

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const percentile = { optimistic: "P50", realistic: "P80", pessimistic: "P90" };

export function calibratedFactor(item, scenario, fallbackFactors, minimumUnknownPercent = 0) {
  const factors = item.calibration?.factors;
  if (!factors) return Number(fallbackFactors[scenario] || 1);
  const optimistic = clamp(factors.optimistic || 1, 0.4, 4);
  const minimumUnknown = clamp(minimumUnknownPercent, 0, 200) / 100;
  const realistic = Math.max(clamp(factors.realistic || optimistic, optimistic, 5), optimistic * (1 + minimumUnknown));
  const pessimistic = Math.max(clamp(factors.pessimistic || realistic, realistic, 6), realistic);
  return scenario === "optimistic" ? optimistic : scenario === "realistic" ? realistic : pessimistic;
}

export function forecastAdjustment({
  item,
  employee,
  scenario,
  fallbackFactors,
  minimumUnknownPercent = 0,
  activeProjectCount = 0
}) {
  const calibrationFactor = calibratedFactor(item, scenario, fallbackFactors, minimumUnknownPercent);
  const observedMultitasking = activeProjectCount ? clamp(employee?.multitaskingFactor || 1, 1, 1.5) : 1;
  const multitaskingFactor = scenario === "optimistic" ? 1 + (observedMultitasking - 1) * 0.5
    : scenario === "realistic" ? observedMultitasking
    : 1 + (observedMultitasking - 1) * 1.25;
  const totalFactor = calibrationFactor * multitaskingFactor;
  const baseHours = Number(item.estimateHours || 0);
  return {
    scenario,
    percentile: percentile[scenario],
    baseHours,
    calibration: {
      factor: Number(calibrationFactor.toFixed(3)),
      source: item.calibration?.source || "fallback",
      sourceLabel: item.calibration?.sourceLabel || "общая модель",
      sample: Number(item.calibration?.sample || 0),
      confidence: Number(item.calibration?.confidence || 0),
      minimumUnknownPercent: Number(minimumUnknownPercent || 0)
    },
    multitasking: {
      factor: Number(multitaskingFactor.toFixed(3)),
      observedFactor: Number(observedMultitasking.toFixed(3)),
      activeProjectCount
    },
    totalFactor: Number(totalFactor.toFixed(3)),
    forecastHours: Number((baseHours * totalFactor).toFixed(1)),
    formula: "Базовая оценка × калибровка plan/fact × влияние активного портфеля"
  };
}

export function explainWorkItem({ item, employee, fallbackFactors, minimumUnknownPercent = 0, activeProjectCount = 0 }) {
  return {
    base: item.estimateExplanation || {
      stage: "base-estimate",
      method: "provided",
      label: "Переданная базовая оценка",
      formula: "Переданная оценка",
      resultHours: Number(item.estimateHours || 0),
      inputs: []
    },
    scenarios: {
      p50: forecastAdjustment({ item, employee, scenario: "optimistic", fallbackFactors, minimumUnknownPercent, activeProjectCount }),
      p80: forecastAdjustment({ item, employee, scenario: "realistic", fallbackFactors, minimumUnknownPercent, activeProjectCount }),
      p90: forecastAdjustment({ item, employee, scenario: "pessimistic", fallbackFactors, minimumUnknownPercent, activeProjectCount })
    }
  };
}
