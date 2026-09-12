import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  getReplacements,
  submitReplacements,
  validateReplacements,
  type LaunchValidation,
  type ReplacementSubmission,
  type ReplacementView,
  type RunView,
  type TrialIdentity,
} from "./api";
import { useControlState } from "./control-state";
import { formatMoneyUsd } from "./lib";
import { RUN_POLL_INTERVAL_MS } from "./queries";
import { nativeScore, resultStat, roundedScore } from "./run-summary";
import { Button, Card } from "./ui";

type Tab = "Original" | "Replacements" | "Combined";
type Review = {
  validation: LaunchValidation;
  body: ReplacementSubmission;
  key: string;
};

export function RunReplacements({
  run,
  trials,
}: {
  run: RunView;
  trials: TrialIdentity[];
}) {
  const [open, setOpen] = useState<boolean | null>(null);
  return (
    <Card className="my-6">
      <h2 className="font-semibold text-white">Infrastructure replacements</h2>
      {run.record.operator_selection ? (
        <p>
          This is a replacement run.{" "}
          <Link
            className="underline"
            to={`/runs/${run.record.operator_selection.original_run_id}`}
          >
            Original run
          </Link>
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="mt-3"
        aria-expanded={Boolean(open)}
        aria-controls="replacement-panel"
        onClick={() => setOpen(!open)}
      >
        {open ? "Close replacements" : "Replace infrastructure failures"}
      </Button>
      {/* Keep an uncertain submission in memory when the panel is closed. */}
      <div id="replacement-panel" hidden={!open}>
        {open !== null ? (
          <ReplacementPanel run={run} trials={trials} open={open} />
        ) : null}
      </div>
    </Card>
  );
}

function ReplacementPanel({
  run,
  trials,
  open,
}: {
  run: RunView;
  trials: TrialIdentity[];
  open: boolean;
}) {
  const { writesAllowed } = useControlState();
  const eligible = writesAllowed && run.status === "finished";
  const runId = run.record.run_id;
  const query = useQuery({
    queryKey: ["replacements", runId],
    queryFn: () => getReplacements(runId),
    enabled: open,
    refetchInterval: open ? RUN_POLL_INTERVAL_MS : false,
    retry: false,
  });
  const [tab, setTab] = useState<Tab>("Original");
  const [selected, setSelected] = useState<string[]>([]);
  const [budget, setBudget] = useState("");
  const [classified, setClassified] = useState(false);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<"review" | "submit" | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const revision = useRef(0);
  const used = new Set(
    query.data?.children.flatMap((child) => child.operator_selection.trial_ids),
  );
  const candidates = trials.filter(
    (trial) =>
      trial.status === "error" &&
      trial.result.id &&
      trial.result.exception_info?.exception_type,
  );
  const overlap = selected.some((id) => used.has(id));
  const cost = Number(budget);
  const canReview =
    eligible &&
    Boolean(query.data) &&
    !query.error &&
    selected.length > 0 &&
    !overlap &&
    classified &&
    Number.isFinite(cost) &&
    cost > 0 &&
    !busy &&
    !uncertain;
  function invalidate() {
    revision.current++;
    setReview(null);
    setError(null);
  }
  async function validate() {
    if (!canReview) return;
    const version = revision.current;
    const input = { trial_ids: [...selected], cost_ceiling_usd: cost };
    setBusy("review");
    setError(null);
    try {
      const validation = await validateReplacements(runId, input);
      if (version === revision.current)
        setReview({
          validation,
          body: { ...input, fingerprint: validation.fingerprint },
          key: crypto.randomUUID(),
        });
    } catch (reason) {
      if (version === revision.current) setError(String(reason));
    } finally {
      setBusy(null);
    }
  }
  async function submit() {
    if (
      !review ||
      !eligible ||
      busy ||
      (!uncertain && (overlap || Boolean(query.error)))
    )
      return;
    setBusy("submit");
    setError(null);
    try {
      const result = await submitReplacements(runId, review.body, review.key);
      setCreated(result.run.run_id);
      setTab("Replacements");
      setUncertain(false);
      setReview(null);
      setSelected([]);
      setClassified(false);
      revision.current++;
      void query.refetch();
    } catch (reason) {
      // Never guess whether a failed response preceded or followed immutable creation.
      setUncertain(true);
      setError(String(reason));
    } finally {
      setBusy(null);
    }
  }
  const locked = uncertain || busy === "submit";
  return (
    <div className="mt-4 space-y-4">
      <p>
        Original execution remains below. Combined results are a view, not this run’s
        execution status.
      </p>
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">Replacement views</legend>
        {(["Original", "Replacements", "Combined"] as const).map((value) => (
          <Button
            key={value}
            type="button"
            variant={tab === value ? "default" : "outline"}
            aria-pressed={tab === value}
            onClick={() => setTab(value)}
          >
            {value}
          </Button>
        ))}
      </fieldset>
      <div className="min-h-10" aria-live="polite">
        {query.isFetching ? <p>Refreshing replacement evidence…</p> : null}
        {query.error ? (
          <p role="alert">
            Replacement evidence could not be refreshed.{" "}
            {query.data ? "Showing saved data." : ""}{" "}
            <Button
              type="button"
              variant="outline"
              disabled={query.isFetching}
              onClick={() => void query.refetch()}
            >
              Retry replacement evidence
            </Button>
          </p>
        ) : null}
      </div>
      {created ? (
        <p role="status">
          Replacement created:{" "}
          <Link className="underline" to={`/runs/${created}`}>
            {created}
          </Link>
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {uncertain ? (
        <div role="status">
          <p>
            Creation is unconfirmed. Selection and budget are locked. Replay the same
            reviewed request with the same key to resolve it; no automatic resubmission.
          </p>
          <Button
            type="button"
            disabled={!eligible || Boolean(busy)}
            onClick={() => void submit()}
          >
            Replay reviewed submission
          </Button>
        </div>
      ) : null}
      {tab === "Original" ? (
        <section aria-label="Original replacement candidates" className="space-y-4">
          <p>
            Native exceptions are candidates, not an infrastructure classification.
            Review the error evidence yourself; rewards do not determine selection.
          </p>
          {!eligible ? (
            <p>
              Selection requires a finished source run, operator access, and enabled
              writes. The server rechecks live evidence before creation.
            </p>
          ) : null}
          <fieldset
            disabled={!eligible || locked || !query.data || Boolean(query.error)}
            className="space-y-3"
          >
            <legend>Errored native attempts</legend>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                invalidate();
                setClassified(false);
                setSelected(
                  candidates.flatMap((trial) =>
                    trial.result.id && !used.has(trial.result.id)
                      ? [trial.result.id]
                      : [],
                  ),
                );
              }}
            >
              Select all unused candidates
            </Button>
            {candidates.length === 0 ? (
              <p>No errored native UUID candidates available.</p>
            ) : null}
            {candidates.map((trial) => {
              const id = trial.result.id as string;
              return (
                <div key={id} className="flex flex-wrap items-center gap-2">
                  <label className="break-all">
                    <input
                      type="checkbox"
                      checked={selected.includes(id)}
                      disabled={used.has(id)}
                      onChange={(event) => {
                        invalidate();
                        setClassified(false);
                        setSelected(
                          event.target.checked
                            ? [...selected, id]
                            : selected.filter((value) => value !== id),
                        );
                      }}
                    />{" "}
                    {id}
                  </label>
                  <Link
                    className="underline"
                    to={`/runs/${runId}/trials/${encodeURIComponent(trial.trial_name)}`}
                  >
                    {trial.trial_name}
                  </Link>
                  <span>{trial.result.exception_info?.exception_type}</span>
                  {used.has(id) ? <span>Already selected by a replacement</span> : null}
                </div>
              );
            })}
            <p>{selected.length} exact attempts selected</p>
            <label className="block">
              Replacement cost ceiling (USD){" "}
              <input
                className="rounded border border-slate-600 bg-slate-900 p-2"
                type="number"
                min="0"
                step="any"
                value={budget}
                onChange={(event) => {
                  invalidate();
                  setBudget(event.target.value);
                }}
              />
            </label>
            <label className="block">
              <input
                type="checkbox"
                checked={classified}
                onChange={(event) => {
                  invalidate();
                  setClassified(event.target.checked);
                }}
              />{" "}
              I reviewed these as infrastructure failures
            </label>
          </fieldset>
          <Button type="button" disabled={!canReview} onClick={() => void validate()}>
            Review replacements
          </Button>
          {review ? (
            <section aria-label="Replacement budget review" className="space-y-3">
              <h3 className="font-semibold">Replacement budget review</h3>
              <p>
                {review.body.trial_ids.length} exact attempts · ceiling{" "}
                {formatMoneyUsd(review.body.cost_ceiling_usd)}
              </p>
              <p>
                Inspector: {review.validation.trials} trials, {review.validation.tasks}{" "}
                tasks, {review.validation.agents} agents · Harbor{" "}
                {review.validation.harbor_revision}
              </p>
              <p>
                Credentials available:{" "}
                {review.validation.credentials_available ? "yes" : "no"}
              </p>
              <h4>Warnings</h4>
              {review.validation.warnings.length ? (
                <ul>
                  {review.validation.warnings.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
              ) : (
                <p>None reported.</p>
              )}
              <h4>Not performed</h4>
              <ul>
                {review.validation.not_performed.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
              <details>
                <summary>Effective configuration</summary>
                <pre className="overflow-auto">
                  {JSON.stringify(review.validation.effective_config, null, 2)}
                </pre>
              </details>
              <p>
                Confirming creates a related run through normal submission and may spend
                up to the reviewed ceiling. Server checks may still reject it.
              </p>
              {!uncertain ? (
                <Button
                  type="button"
                  disabled={
                    !eligible || Boolean(busy) || overlap || Boolean(query.error)
                  }
                  onClick={() => void submit()}
                >
                  Confirm and create replacement run
                </Button>
              ) : null}
            </section>
          ) : null}
        </section>
      ) : null}
      {tab === "Replacements" && query.data ? (
        <section aria-label="Related replacement runs">
          <p>
            Direct replacements. Open a child’s native run page to review its own failed
            attempts; the root Combined view includes descendants automatically.
          </p>
          {query.data.children.length ? (
            <ul>
              {query.data.children.map((child) => (
                <li key={child.run_id}>
                  <Link className="underline" to={`/runs/${child.run_id}`}>
                    {child.run_id}
                  </Link>{" "}
                  · {child.status ?? "Status unavailable"} ·{" "}
                  {child.operator_selection.trial_ids.length} exact attempts selected
                </li>
              ))}
            </ul>
          ) : (
            <p>No related replacement runs yet.</p>
          )}
        </section>
      ) : null}
      {tab === "Combined" && query.data ? (
        <CombinedReplacementView view={query.data} />
      ) : null}
    </div>
  );
}

export function CombinedReplacementView({ view }: { view: ReplacementView }) {
  const result =
    view.assembly.availability === "available" ? view.assembly.result : null;
  const score = nativeScore(result);
  return (
    <section aria-label="Combined native result" className="space-y-3">
      <h3 className="font-semibold">Combined · {view.assembly.availability}</h3>
      <p>
        Original cohort with operator-selected attempts replaced one-for-one by native
        descendant results. Original and replaced-away evidence remains intact.
      </p>
      {!result ? (
        <p>
          {view.assembly.availability === "pending"
            ? "Waiting for native replacement results and assembly rebuild."
            : "No combined native result is available. Original execution is not a fallback assembly."}
        </p>
      ) : (
        <>
          <p>
            {score.label}: {roundedScore(score.value)}
          </p>
          <p>
            Native completed trials:{" "}
            {resultStat(result, "n_completed_trials") ?? "Unknown"} · Native errors:{" "}
            {resultStat(result, "n_errored_trials") ?? "Unknown"}
          </p>
          <details>
            <summary>
              Inspect combined native JobResult (stats, metrics and source trials)
            </summary>
            <pre className="max-h-96 overflow-auto">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
          <a
            className="underline"
            download="combined-job-result.json"
            href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(result, null, 2))}`}
          >
            Download combined native JSON
          </a>
        </>
      )}
      <p>
        Selected native cohort cost:{" "}
        {view.selected_cost_usd === null
          ? "Unknown"
          : formatMoneyUsd(view.selected_cost_usd)}
      </p>
      <p>
        All-incurred reported agent-cost subtotal:{" "}
        {view.incurred?.cost_usd == null
          ? "Unknown"
          : formatMoneyUsd(view.incurred.cost_usd)}
      </p>
      {view.incurred ? (
        <p>
          {view.incurred.reported_attempts} reported · {view.incurred.unknown_attempts}{" "}
          unknown-cost · {view.incurred.total_attempts} observed attempts (original and
          all descendants, including replaced-away attempts).
        </p>
      ) : (
        <p>Attempt-cost coverage unavailable.</p>
      )}
      <p>
        Unknown costs remain unknown. These are reported agent costs, not HF
        infrastructure billing or planned-attempt coverage.
      </p>
    </section>
  );
}
