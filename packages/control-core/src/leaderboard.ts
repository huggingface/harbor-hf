import type { PresetCatalog } from "./presets.js";
import type { Projection } from "./projection.js";

export interface LeaderboardRow {
  benchmark: string;
  preset: string;
  agent: string;
  agent_version: string;
  model: string;
  provider: string;
  reasoning_effort: string;
  n_attempts: number;
  n_trials: number;
  pass_rate: number;
  cost_usd: number | null;
}

interface Aggregate
  extends Omit<LeaderboardRow, "n_trials" | "pass_rate" | "cost_usd"> {
  rewards: number[];
  costs: number[];
}

export function leaderboard(
  projection: Projection,
  presets: PresetCatalog,
): LeaderboardRow[] {
  const groups = new Map<string, Aggregate>();
  for (const view of projection.listRuns()) {
    const { record } = view;
    if (view.status !== "finished" || record.role !== "final") continue;
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
    if (group) {
      group.rewards.push(...rewards);
      group.costs.push(...costs);
    } else groups.set(key, { ...values, rewards: [...rewards], costs: [...costs] });
  }
  return [...groups.values()]
    .map(({ rewards, costs, ...row }) => ({
      ...row,
      n_trials: rewards.length,
      pass_rate: rewards.reduce((sum, reward) => sum + reward, 0) / rewards.length,
      cost_usd: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
    }))
    .sort(
      (left, right) =>
        right.pass_rate - left.pass_rate ||
        left.benchmark.localeCompare(right.benchmark) ||
        left.agent.localeCompare(right.agent) ||
        left.model.localeCompare(right.model),
    );
}
