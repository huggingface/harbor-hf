import { asRecord } from "./lib";

/** Display coverage only. Harbor owns selection and monetary aggregation. */
export function nativeCostCoverage(
  result: unknown,
): { total: number; missing: number } | null {
  const trials = asRecord(result)?.trial_results;
  if (!Array.isArray(trials)) return null;
  let missing = 0;
  for (const value of trials) {
    const trial = asRecord(value);
    if (!trial) return null;
    // Match TrialResult.compute_token_cost_totals context precedence. A present
    // single-step context with null cost must not borrow a step's reported cost.
    let contexts: unknown[];
    if (trial.agent_result != null) contexts = [trial.agent_result];
    else if (trial.step_results != null) {
      if (!Array.isArray(trial.step_results)) return null;
      contexts = [];
      for (const step of trial.step_results) {
        const item = asRecord(step);
        if (!item) return null;
        if (item.agent_result != null) contexts.push(item.agent_result);
      }
    } else contexts = [];
    let reported = false;
    for (const context of contexts) {
      const agent = asRecord(context);
      if (!agent) return null;
      const cost = agent.cost_usd;
      if (cost == null) continue;
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
      reported = true;
    }
    if (!reported) missing++;
  }
  return { total: trials.length, missing };
}

export function costCoverageLabel(result: unknown): string {
  const coverage = nativeCostCoverage(result);
  return coverage
    ? `${coverage.missing} of ${coverage.total} native trial results missing reported cost. Reported costs may still be partial within a trial.`
    : "Cost coverage unavailable: native trial evidence is absent or invalid; missing-cost count is unknown.";
}
