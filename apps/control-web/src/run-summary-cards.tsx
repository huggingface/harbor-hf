import { configuredTimeouts, RunStatusTiming } from "./agent-timing";
import type { RunView } from "./api";
import { LaunchEstimate } from "./launch-pricing";
import { CostValue, ExactValue } from "./summary-values";
export { CostValue, ExactValue } from "./summary-values";
import { RunDiagnosticsSummary } from "./run-diagnostics";
import {
  cacheHitRate,
  millionTokens,
  nativeScore,
  progressPercent,
  resultStat,
  roundedScore,
} from "./run-summary";
import { Card, Hint, Progress } from "./ui";

export function ScoreValue({ result }: { result: unknown }) {
  const score = nativeScore(result);
  return (
    <ExactValue value={score.value} text={roundedScore(score.value)} label="Score" />
  );
}

export function TokenValue({ value, label }: { value: number | null; label: string }) {
  return (
    <ExactValue value={value} text={millionTokens(value)} label={`${label} tokens`} />
  );
}

export function RunSummaryCards({ run }: { run: RunView }) {
  const completed = resultStat(run.result, "n_completed_trials");
  const total =
    typeof run.result?.n_total_trials === "number" ? run.result.n_total_trials : null;
  const percent = progressPercent(completed, total);
  return (
    <section
      aria-label="Run summary"
      className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6 [&>div]:min-w-0 [&>div]:p-3 [&_h2]:text-sm"
    >
      <Card>
        <h2>
          <Hint
            text="Agent Σ sums measured agent intervals in current trial results, not elapsed job time or lifetime retries."
            icon
          >
            Status
          </Hint>
        </h2>
        <RunStatusTiming run={run} />
        <span className="text-xs text-slate-400">
          <Hint text={configuredTimeouts(run.record.harbor_job_config)}>
            Configured timeouts
          </Hint>
        </span>
      </Card>
      <Card>
        <h2>Progress</h2>
        <p className="text-xl tabular-nums">
          {completed ?? "-"} / {total ?? "-"}
        </p>
        {percent !== null && <Progress value={percent} label="Trial progress" />}
        <p className="text-xs text-slate-400">Includes errored trials</p>
      </Card>
      <Card>
        <h2>{nativeScore(run.result).label}</h2>
        <p className="text-xl">
          <ScoreValue result={run.result} />
        </p>
      </Card>
      <Card>
        <h2>Exceptions</h2>
        <RunDiagnosticsSummary run={run} />
      </Card>
      <Card>
        <h2>Reported tokens · M</h2>
        <p className="text-xl tabular-nums">
          <CacheHitValue result={run.result} />
        </p>
        <dl className="text-xs">
          {(
            [
              ["Input incl. cache", "n_input_tokens", "Input"],
              ["Output", "n_output_tokens", "Output"],
              ["Cache (in input)", "n_cache_tokens", "Cache"],
            ] as const
          ).map(([label, key, tooltipLabel]) => (
            <div className="flex justify-between gap-3" key={key}>
              <dt>{label}</dt>
              <dd>
                <TokenValue value={resultStat(run.result, key)} label={tooltipLabel} />
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card>
        <h2>Inference cost</h2>
        <p className="text-xl">
          <CostValue value={resultStat(run.result, "cost_usd")} />
        </p>
        <p className="text-xs text-slate-400">Reported; may be partial; not billing</p>
        {run.record.pricing ||
        run.pricing_corrections ||
        run.pricing_corrections_available === false ? (
          <div className="mt-1 text-xs">
            {run.shared_estimate?.basis === "corrected_rates_reported_usage" ||
            run.shared_estimate?.basis === "effective_rates_reported_usage"
              ? "Shared estimate:"
              : "Launch estimate:"}{" "}
            <LaunchEstimate run={run} />
            <p className="text-slate-400">
              {run.shared_estimate?.unavailable_reason ===
              "correction_history_unavailable"
                ? "Correction history unavailable — no launch fallback"
                : run.shared_estimate?.unavailable_reason === "usage_unavailable"
                  ? "Reported usage unavailable or invalid"
                  : run.shared_estimate?.cost_usd == null
                    ? "Estimate unavailable"
                    : run.shared_estimate?.basis === "corrected_rates_reported_usage"
                      ? "Audited corrected rates · reported usage may be partial"
                      : "Immutable launch rates · reported usage may be partial"}
            </p>
          </div>
        ) : null}
      </Card>
    </section>
  );
}

export function CacheHitValue({ result }: { result: unknown }) {
  return (
    <span title="Reported cached tokens / input tokens (including cache); usage may be partial">
      {cacheHitRate(
        resultStat(result, "n_cache_tokens"),
        resultStat(result, "n_input_tokens"),
      )}{" "}
      <span className="text-xs text-slate-400">cache hit</span>
    </span>
  );
}
