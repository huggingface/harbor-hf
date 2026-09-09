import type { RunView } from "./api";
import { formatMoneyUsd, humanize } from "./lib";
import { RunDiagnosticsSummary } from "./run-diagnostics";
import {
  millionTokens,
  nativeScore,
  progressPercent,
  resultStat,
  roundedScore,
} from "./run-summary";
import { Badge, Card, Hint, Progress } from "./ui";

export function ExactValue({
  value,
  text,
  label,
}: {
  value: number | null;
  text: string;
  label: string;
}) {
  const exact = value === null ? `${label}: unavailable` : `${label}: ${value}`;
  return (
    <Hint text={exact}>
      <output
        aria-live="off"
        className="whitespace-nowrap tabular-nums"
        title={exact}
        aria-label={exact}
      >
        {text}
      </output>
    </Hint>
  );
}

export function ScoreValue({ result }: { result: unknown }) {
  const score = nativeScore(result);
  return (
    <ExactValue
      value={score.value}
      text={roundedScore(score.value)}
      label={score.label}
    />
  );
}

export function CostValue({
  value,
  label = "Reported USD (may be partial; not billing)",
}: {
  value: number | null;
  label?: string;
}) {
  return (
    <ExactValue
      value={value}
      text={value === null ? "-" : formatMoneyUsd(value)}
      label={label}
    />
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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <Card>
        <h2>Status</h2>
        <Badge status={run.status}>{humanize(run.status)}</Badge>
      </Card>
      <Card>
        <h2>Progress</h2>
        <p className="text-xl tabular-nums">
          {completed ?? "-"} / {total ?? "-"}
        </p>
        {percent !== null && <Progress value={percent} label="Trial progress" />}
        <p className="text-xs text-slate-400">Completed includes errored trials</p>
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
        <h2>Reported tokens · millions</h2>
        <dl className="text-sm">
          {(
            [
              ["Input incl. cache", "n_input_tokens"],
              ["Output", "n_output_tokens"],
              ["Cache (part of input)", "n_cache_tokens"],
            ] as const
          ).map(([label, key]) => (
            <div className="flex justify-between gap-3" key={key}>
              <dt>{label}</dt>
              <dd>
                <TokenValue value={resultStat(run.result, key)} label={label} />
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
      </Card>
    </div>
  );
}
