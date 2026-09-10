import type { RunView } from "./api";
import { LaunchEstimate } from "./launch-pricing";
import { resultStat } from "./run-summary";
import { CostValue } from "./summary-values";
import { Hint } from "./ui";

export function RunInferenceCost({ run }: { run: RunView }) {
  const reported = resultStat(run.result, "cost_usd");
  const estimate = run.shared_estimate;
  const historyUnavailable =
    run.pricing_corrections_available === false ||
    estimate?.unavailable_reason === "correction_history_unavailable";
  const available =
    !historyUnavailable &&
    estimate?.unavailable_reason == null &&
    typeof estimate?.cost_usd === "number" &&
    Number.isFinite(estimate.cost_usd) &&
    estimate.cost_usd >= 0;
  const source =
    estimate?.basis === "corrected_rates_reported_usage"
      ? "Corrected rates"
      : "Launch rates";
  const reason = historyUnavailable
    ? "Correction history unavailable — no launch fallback"
    : estimate?.unavailable_reason === "usage_unavailable"
      ? "Reported usage unavailable or invalid"
      : "Estimate unavailable";
  return (
    <>
      <h2>Inference cost</h2>
      <p className="text-xl">
        {reported === null && available ? (
          <LaunchEstimate run={run} compact />
        ) : (
          <CostValue value={reported} />
        )}
      </p>
      <p className="text-xs text-slate-400">
        <Hint text="Reported usage may be partial; not billed charges.">
          {reported !== null ? "Reported" : available ? "Estimated" : "Unavailable"}
          {reported === null && available ? ` · ${source}` : ""}
        </Hint>
      </p>
      {reported !== null && available ? (
        <div className="mt-1 text-xs">
          Estimated: <LaunchEstimate run={run} compact />
          <p className="text-slate-400">{source}</p>
        </div>
      ) : !available &&
        (run.record.pricing || run.pricing_corrections || historyUnavailable) ? (
        <p className="mt-1 text-xs text-slate-400">{reason}</p>
      ) : null}
    </>
  );
}
