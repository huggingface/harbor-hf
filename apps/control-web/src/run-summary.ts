import { asRecord, numberValue } from "./lib";

export function resultStat(result: unknown, key: string): number | null {
  return numberValue(asRecord(asRecord(result)?.stats)?.[key]);
}

// A single native mean only: never average evaluations or unrelated metrics.
export function nativeScore(result: unknown): { value: number | null; label: string } {
  const evals = asRecord(asRecord(asRecord(result)?.stats)?.evals);
  const evaluations = Object.values(evals ?? {});
  const missing = { value: null, label: "Score" };
  if (evaluations.length !== 1) return missing;
  const evaluation = asRecord(evaluations[0]);
  const metrics = evaluation?.metrics;
  if (!Array.isArray(metrics) || metrics.length !== 1) return missing;
  const metric = asRecord(metrics[0]);
  if (!metric || Object.keys(metric).length !== 1) return missing;
  const value = numberValue(metric.mean);
  if (value === null) return missing;
  const keys = Object.keys(asRecord(evaluation?.reward_stats) ?? {});
  return {
    value,
    label: keys.length === 1 ? `Score · ${keys[0]} mean` : "Score · mean",
  };
}

export function progressPercent(
  completed: number | null,
  total: number | null,
): number | null {
  if (
    completed === null ||
    total === null ||
    !Number.isFinite(completed) ||
    !Number.isFinite(total) ||
    completed < 0 ||
    total <= 0 ||
    completed > total
  )
    return null;
  return (completed / total) * 100;
}

export function roundedScore(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "-" : value.toFixed(3);
}

export function millionTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "-";
  if (value > 0 && value < 1000) return "<0.001M";
  return `${(value / 1_000_000).toFixed(3)}M`;
}
