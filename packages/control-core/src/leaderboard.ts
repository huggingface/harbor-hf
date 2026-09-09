import type { PresetCatalog } from "./presets.js";
import type { Projection } from "./projection.js";

export type LeaderboardRow = import("@harbor-hf/contracts").LeaderboardRowV1;

interface Aggregate
  extends Omit<
    LeaderboardRow,
    "n_trials" | "pass_rate" | "cost_usd" | "shared_estimate"
  > {
  rewards: number[];
  costs: number[];
  estimates: number[];
  totalRuns: number;
}

export function leaderboard(
  projection: Projection,
  presets: PresetCatalog,
): LeaderboardRow[] {
  const groups = new Map<string, Aggregate>();
  for (const view of projection.listRuns()) {
    const { record } = view;
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
    const trials = projection.trials(record.run_id);
    const rewards = trials
      .map((trial) => trial.reward)
      .filter((reward): reward is number => reward !== null);
    const costs = trials
      .map((trial) => trial.cost_usd)
      .filter((cost): cost is number => cost !== null);
    if (rewards.length === 0) continue;
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
    const estimate = view.shared_estimate?.cost_usd;
    const estimates =
      typeof estimate === "number" && Number.isFinite(estimate) && estimate >= 0
        ? [estimate]
        : [];
    if (group) {
      group.rewards.push(...rewards);
      group.costs.push(...costs);
      group.estimates.push(...estimates);
      group.totalRuns += 1;
    } else
      groups.set(key, {
        ...values,
        rewards: [...rewards],
        costs: [...costs],
        estimates,
        totalRuns: 1,
      });
  }
  return [...groups.values()]
    .map(({ rewards, costs, estimates, totalRuns, ...row }) => {
      const subtotal = estimates.reduce((sum, cost) => sum + cost, 0);
      return {
        shared_estimate: {
          basis: "launch_rates_reported_usage" as const,
          cost_usd: estimates.length > 0 && Number.isFinite(subtotal) ? subtotal : null,
          estimated_runs: estimates.length,
          total_runs: totalRuns,
        },
        ...row,
        n_trials: rewards.length,
        pass_rate: rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length,
        cost_usd: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
      };
    })
    .sort(
      (left, right) =>
        right.pass_rate - left.pass_rate ||
        left.benchmark.localeCompare(right.benchmark) ||
        left.agent.localeCompare(right.agent) ||
        left.model.localeCompare(right.model),
    );
}
