import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { RunView } from "./api";
import { costCoverageLabel } from "./native-cost-coverage";
import {
  settleReplacementInspection,
  useReplacementResult,
  useResultEvidenceClock,
} from "./result-browsing-query";
import { millionTokens, nativeScore, resultStat, roundedScore } from "./run-summary";
import { CostValue, ExactValue } from "./summary-values";
import { Button } from "./ui";

export function NativeResultSummary({
  result,
  includeCost = true,
}: {
  result: unknown;
  includeCost?: boolean;
}) {
  const score = nativeScore(result);
  return (
    <div className="space-y-1 tabular-nums">
      <p className="text-xl">
        <ExactValue
          value={score.value}
          text={`${score.label}: ${roundedScore(score.value)}`}
          label="Score"
        />
      </p>
      <p>Reported tokens · M</p>
      {(
        [
          ["Input incl. cache", "n_input_tokens"],
          ["Output", "n_output_tokens"],
          ["Cache (in input)", "n_cache_tokens"],
        ] as const
      ).map(([label, key]) => (
        <p key={key}>
          <ExactValue
            value={resultStat(result, key)}
            text={`${label}: ${millionTokens(resultStat(result, key))}`}
            label={`${label} tokens`}
          />
        </p>
      ))}
      {includeCost ? (
        <>
          <p>
            Selected reported cost: <CostValue value={resultStat(result, "cost_usd")} />
          </p>
          <p className="text-xs text-slate-400">{costCoverageLabel(result)}</p>
        </>
      ) : null}
    </div>
  );
}

export function BrowsingResult({
  run,
  hasChildren,
  knownChildren,
  relationships = "",
}: {
  run: RunView;
  hasChildren: boolean;
  knownChildren?: string[] | undefined;
  relationships?: string | undefined;
}) {
  const query = useReplacementResult(run.record.run_id, hasChildren);
  const client = useQueryClient();
  const runId = run.record.run_id;
  // Full-list descendant edges are discovery fences only. The API's direct
  // child list and native assembly remain authoritative for result selection.
  const missingDirectChildren = Boolean(
    query.data &&
      knownChildren?.some(
        (id) => !query.data?.children.some((child) => child.run_id === id),
      ),
  );
  const observation = JSON.stringify([
    runId,
    [...(knownChildren ?? [])].sort(),
    relationships,
  ]);
  const [checkedRelationships, setCheckedRelationships] = useState(() =>
    !relationships && !missingDirectChildren ? observation : "",
  );
  const missingChildren = missingDirectChildren || checkedRelationships !== observation;
  useEffect(() => {
    if (checkedRelationships === observation) return;
    let disposed = false;
    const recheck = async () => {
      const filters = { queryKey: ["replacements", runId], exact: true };
      // A flight begun before discovery cannot certify the newly observed edges.
      // Await it without cancellation, then explicitly inspect fresh evidence.
      if (client.isFetching(filters)) {
        await client.refetchQueries(filters, { cancelRefetch: false });
      }
      const admitted = settleReplacementInspection(runId);
      if (admitted) await admitted;
      if (disposed) return;
      await client.refetchQueries(filters, { cancelRefetch: false });
      if (!disposed) setCheckedRelationships(observation);
    };
    void recheck();
    return () => {
      disposed = true;
    };
  }, [client, runId, observation, checkedRelationships]);
  const now = useResultEvidenceClock();
  const expired = Boolean(query.data) && now - query.dataUpdatedAt > 60_000;
  const view = !query.error && !expired && !missingChildren ? query.data : undefined;
  const result =
    view?.assembly.availability === "available" ? view.assembly.result : null;
  return (
    <section aria-label="Browsing native result" className="min-w-60 space-y-2">
      <h3 className="font-semibold">
        {hasChildren ? "Combined" : "Original"}
        {run.record.operator_selection ? " · replacement subset" : ""}
      </h3>
      {!hasChildren ? (
        <NativeResultSummary result={run.result} />
      ) : (
        <>
          {query.isFetching ? <p>Loading fresh combined evidence…</p> : null}
          {query.error || expired || missingChildren ? (
            <p role="alert">
              Combined unavailable:{" "}
              {query.error?.message ??
                (missingChildren
                  ? "known replacement relationships changed"
                  : "saved evidence has expired")}
              . Original is not a Combined fallback.
            </p>
          ) : result ? (
            <>
              {query.isFetching ? (
                <p>Showing the last completed evidence check while refreshing.</p>
              ) : null}
              <NativeResultSummary result={result} />
            </>
          ) : (
            <p>
              {!view || view.assembly.availability === "pending"
                ? "Combined pending: waiting for native replacement evidence."
                : "Combined unavailable: no valid native assembly. Original is not a Combined fallback."}
            </p>
          )}
          {query.error || expired || missingChildren || (view && !result) ? (
            <Button
              type="button"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Retry combined rollup
            </Button>
          ) : null}
          {view?.incurred ? (
            <p className="text-xs">
              All-incurred reported subtotal:{" "}
              <CostValue value={view.incurred.cost_usd} /> ·{" "}
              {view.incurred.unknown_attempts} unknown-cost /{" "}
              {view.incurred.total_attempts} observed attempts (including replaced-away
              attempts)
            </p>
          ) : (
            <p className="text-xs">All-incurred cost coverage unavailable.</p>
          )}
        </>
      )}
    </section>
  );
}
