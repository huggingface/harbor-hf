import type { RunRecordV1 } from "@harbor-hf/contracts";

import type { ReplacementView } from "./replacements.js";
import type { PresetCatalog } from "./presets.js";
import type { Projection } from "./projection.js";

export type LeaderboardRow = import("@harbor-hf/contracts").LeaderboardRowV1;

interface Aggregate
  extends Omit<
    LeaderboardRow,
    "n_trials" | "pass_rate" | "cost_usd" | "shared_estimate"
  > {
  rewards: number[];
  nativeCohorts: Array<{ count: number; mean: number }>;
  costs: number[];
  estimates: number[];
  totalRuns: number;
  effective: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The existing scalar leaderboard can present an unambiguous native mean only.
 * Missing/custom/multi-eval/multi-reward metrics cannot be reduced here.
 * A multi-reward metric may itself have a reward dimension named "mean".
 * In particular Harbor's mean retains unsuccessful trials in its denominator.
 */
function nativeCohort(result: Record<string, unknown>) {
  const evals = Object.values(object(object(result.stats)?.evals) ?? {});
  if (evals.length !== 1 || !Array.isArray(result.trial_results)) return null;
  const metrics = object(evals[0])?.metrics;
  if (!Array.isArray(metrics) || metrics.length !== 1) return null;
  const metric = object(metrics[0]);
  if (!metric || Object.keys(metric).length !== 1) return null;
  const mean = metric.mean;
  const count = result.n_total_trials;
  if (
    typeof mean !== "number" ||
    !Number.isFinite(mean) ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count <= 0 ||
    count !== result.trial_results.length
  )
    return null;
  return { count, mean };
}

export function leaderboard(
  projection: Projection,
  presets: PresetCatalog,
  replacements: ReadonlyMap<string, ReplacementView> = new Map(),
  records: readonly RunRecordV1[] = projection.listRuns().map((view) => view.record),
): LeaderboardRow[] {
  const groups = new Map<string, Aggregate>();
  const runs = projection.listRuns();
  const parents = new Set(
    records.flatMap((record) =>
      record.operator_selection ? [record.operator_selection.original_run_id] : [],
    ),
  );
  const subsets = new Set(
    records
      .filter((record) => record.operator_selection)
      .map((record) => record.run_id),
  );
  for (const view of runs) {
    const { record } = view;
    const replacement = replacements.get(record.run_id);
    if (
      subsets.has(record.run_id) ||
      record.operator_selection ||
      (parents.has(record.run_id) && replacement?.assembly.availability !== "available")
    )
      continue;
    if (
      view.status !== "finished" ||
      record.role !== "final" ||
      !record.submission.model ||
      !record.submission.harness
    )
      continue;
    let eligible = false;
    try {
      eligible = presets.leaderboardEligible(
        record.submission.benchmark.name,
        record.submission.benchmark.preset,
      );
    } catch {
      eligible = false;
    }
    if (!eligible) continue;
    const assembled =
      replacement?.assembly.availability === "available"
        ? replacement.assembly.result
        : null;
    const cohort = assembled ? nativeCohort(assembled) : null;
    if (assembled && !cohort) continue;
    const trials = assembled ? [] : projection.trials(record.run_id);
    const rewards = trials
      .map((trial) => trial.reward)
      .filter((reward): reward is number => reward !== null);
    const nativeCohorts = cohort ? [cohort] : [];
    const costs = assembled
      ? replacement?.selected_cost_usd === null ||
        replacement?.selected_cost_usd === undefined
        ? []
        : [replacement.selected_cost_usd]
      : trials
          .map((trial) => trial.cost_usd)
          .filter((cost): cost is number => cost !== null);
    if (rewards.length === 0 && !cohort) continue;
    const config = record.harbor_job_config;
    const nAttempts = typeof config.n_attempts === "number" ? config.n_attempts : 1;
    const values = {
      benchmark: record.submission.benchmark.name,
      preset: record.submission.benchmark.preset,
      agent: record.submission.harness.agent,
      agent_version: record.submission.harness.version,
      model: record.submission.model.id,
      provider: record.submission.model.provider,
      reasoning_effort: record.submission.model.reasoning_effort,
      n_attempts: nAttempts,
    };
    const key = JSON.stringify(values);
    const group = groups.get(key);
    const estimate = assembled ? null : view.shared_estimate?.cost_usd;
    const estimates =
      typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0
        ? [estimate]
        : [];
    if (group) {
      group.rewards.push(...rewards);
      group.nativeCohorts.push(...nativeCohorts);
      group.costs.push(...costs);
      group.estimates.push(...estimates);
      group.totalRuns += 1;
      group.effective ||= view.shared_estimate?.basis !== "launch_rates_reported_usage";
    } else
      groups.set(key, {
        ...values,
        rewards: [...rewards],
        nativeCohorts,
        costs: [...costs],
        estimates,
        totalRuns: 1,
        effective: view.shared_estimate?.basis !== "launch_rates_reported_usage",
      });
  }
  return [...groups.values()]
    .map(
      ({ rewards, nativeCohorts, costs, estimates, totalRuns, effective, ...row }) => {
        const count =
          rewards.length + nativeCohorts.reduce((sum, cohort) => sum + cohort.count, 0);
        const subtotal = estimates.reduce((sum, cost) => sum + cost, 0);
        return {
          shared_estimate: {
            basis: effective
              ? ("effective_rates_reported_usage" as const)
              : ("launch_rates_reported_usage" as const),
            cost_usd:
              estimates.length > 0 && Number.isFinite(subtotal) ? subtotal : null,
            estimated_runs: estimates.length,
            total_runs: totalRuns,
          },
          ...row,
          n_trials: count,
          pass_rate:
            (rewards.reduce((sum, reward) => sum + reward, 0) +
              nativeCohorts.reduce(
                (sum, cohort) => sum + cohort.mean * cohort.count,
                0,
              )) /
            count,
          cost_usd:
            costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
        };
      },
    )
    .sort(
      (left, right) =>
        right.pass_rate - left.pass_rate ||
        left.benchmark.localeCompare(right.benchmark) ||
        left.agent.localeCompare(right.agent) ||
        left.model.localeCompare(right.model),
    );
}
