import { useQueries } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getTrialProgress, type RunView } from "./api";
import { asRecord, cn } from "./lib";
import { RunDiagnosticsSummary } from "./run-diagnostics";
import {
  cellDescription,
  recent,
  type SeparateObservation,
  separateObservations,
  trialExceptionLabel,
  type WaffleCell,
  waffleCells,
  waffleStates,
} from "./trial-waffle";
import { Badge, Button, Empty, Hint } from "./ui";

const RUNS = 8;
const TRIALS = 50;
export function RunsWaffle({ runs }: { runs: RunView[] }) {
  const [runPage, setRunPage] = useState(0);
  const [trialPage, setTrialPage] = useState(0);
  const [search, setSearch] = useState("");
  const page = Math.min(runPage, Math.max(0, Math.ceil(runs.length / RUNS) - 1));
  const visible = runs.slice(page * RUNS, (page + 1) * RUNS);
  const queries = useQueries({
    queries: visible.map((run) => ({
      queryKey: ["trial-progress", run.record.run_id],
      queryFn: () => getTrialProgress(run.record.run_id),
      staleTime: 5_000,
      refetchInterval: ["finished", "cancelled", "cost_stopped"].includes(run.status)
        ? 120_000
        : 15_000,
      retry: false,
    })),
  });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  // Mount-local presentation memory only; never persisted or sent to execution.
  const assignments = useRef(new Map<string, WaffleCell[]>());
  const observationHistory = useRef(new Map<string, SeparateObservation[]>());
  const rows = queries.map((query, index) => {
    const run = visible[index];
    if (!query?.data || !run) return [];
    return waffleCells(
      run,
      query.data,
      now,
      query.isError,
      assignments.current.get(run.record.run_id),
    );
  });
  const observations = visible.map((run, index) => {
    const data = queries[index]?.data;
    return data
      ? separateObservations(
          data,
          rows[index] ?? [],
          observationHistory.current.get(run.record.run_id),
          assignments.current.get(run.record.run_id),
        )
      : [];
  });
  useEffect(() => {
    for (const id of assignments.current.keys()) {
      if (!runs.some((run) => run.record.run_id === id)) {
        assignments.current.delete(id);
        observationHistory.current.delete(id);
      }
    }
    visible.forEach((run, index) => {
      const row = rows[index];
      if (queries[index]?.data && row) {
        assignments.current.set(run.record.run_id, row);
        observationHistory.current.set(run.record.run_id, observations[index] ?? []);
      }
    });
  });
  const cells = rows.map((row) => new Map(row.map((cell) => [cell.columnKey, cell])));
  const columns = [...new Map(cells.flatMap((row) => [...row])).values()]
    .filter((cell) => {
      const needle = search.toLowerCase();
      return (
        cell.task.toLowerCase().includes(needle) ||
        cells.some((row) =>
          row.get(cell.columnKey)?.trial?.trial_name.toLowerCase().includes(needle),
        )
      );
    })
    .sort(
      (a, b) =>
        a.task.localeCompare(b.task) ||
        a.digest.localeCompare(b.digest) ||
        a.slot - b.slot,
    );
  const columnPage = Math.min(
    trialPage,
    Math.max(0, Math.ceil(columns.length / TRIALS) - 1),
  );
  const shown = columns.slice(columnPage * TRIALS, (columnPage + 1) * TRIALS);
  if (!runs.length) return <Empty>No runs are available</Empty>;
  return (
    <section
      aria-label="Trial progress waffle"
      className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"
    >
      <div className="mb-3 flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="font-semibold">Trial progress</h2>
          <p className="text-xs text-slate-400">
            One run per row · one square per lock entry (observations only without a
            lock) · active rows refresh every 15s; terminal rows every 2m
          </p>
          <p className="text-xs text-slate-500">
            Artifact observations, not scheduling authority. Repeats stay separate;
            slots are not attempt ordinals or equivalent repetitions across runs.
          </p>
        </div>
        <label className="text-xs">
          Find a trial{" "}
          <input
            type="search"
            value={search}
            className="rounded border border-slate-700 bg-slate-900 p-1"
            onChange={(event) => {
              setSearch(event.target.value);
              setTrialPage(0);
            }}
          />
        </label>
      </div>
      <ul
        aria-label="Trial state legend"
        className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-300"
      >
        {Object.values(waffleStates).map((state) => (
          <li key={state.label} className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-4 w-4 items-center justify-center rounded-[2px] border text-[9px]",
                state.color,
              )}
            >
              {state.symbol}
            </span>
            {state.label}
          </li>
        ))}
        <li>— Not in run (excluded by prepared lock)</li>
        <li>? Unknown / not observed</li>
      </ul>
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-800 p-2">
        <table className="w-max border-separate border-spacing-0 text-xs">
          <caption className="sr-only">
            Runs by task and input digest, with independently assigned display slots;
            repetitions are not matched across runs
          </caption>
          <thead className="sticky top-0 z-20 bg-slate-950">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-30 min-w-48 bg-slate-950 pr-3 pb-2 text-left"
              >
                Run
              </th>
              {shown.map((cell, index) => (
                <th
                  scope="col"
                  key={cell.columnKey}
                  className="px-px pb-2 text-[8px] font-normal text-slate-400"
                >
                  <Hint
                    text={`Task: ${cell.task}\nInput: ${cell.digest}\nDisplay slot: ${cell.slot}`}
                  >
                    <span aria-hidden="true">{columnPage * TRIALS + index + 1}</span>
                    <span className="sr-only">
                      {cell.task}, slot {cell.slot}, {cell.digest}
                    </span>
                  </Hint>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((run, index) => {
              const query = queries[index];
              const id = run.record.run_id;
              return (
                <tr key={id}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 bg-slate-950 py-px pr-3 text-left font-normal"
                  >
                    <Link
                      title={id}
                      className="block max-w-44 truncate font-mono text-[10px] text-cyan-300"
                      to={`/runs/${encodeURIComponent(id)}`}
                    >
                      {id}
                    </Link>
                    <RunDiagnosticsSummary run={run} />
                    {query?.isFetching && !query.isPending ? (
                      <span role="status" className="text-[10px]">
                        Refreshing…
                      </span>
                    ) : null}
                    {query?.data &&
                    !query.isError &&
                    !recent(query.data.observed_at, now) ? (
                      <span role="status" className="text-[10px]">
                        Stale data
                      </span>
                    ) : null}
                    {query?.isError ? (
                      <span role="status" className="text-[10px] text-rose-300">
                        {query?.data ? "Stale data" : "Unavailable"}{" "}
                        <button
                          type="button"
                          className="underline"
                          onClick={() => void query?.refetch()}
                        >
                          Retry
                        </button>
                      </span>
                    ) : null}
                    {query?.isPending ? (
                      <span role="status" className="text-[10px]">
                        Loading…
                      </span>
                    ) : null}
                  </th>
                  {shown.map((column) => {
                    const cell = cells[index]?.get(column.columnKey);
                    const excluded =
                      query?.data?.lock?.trials.every(
                        (trial) =>
                          trial.task.name !== column.task ||
                          trial.task.digest !== column.digest,
                      ) ?? false;
                    if (!cell)
                      return (
                        <td
                          key={column.columnKey}
                          className="px-px py-px text-center text-slate-600"
                        >
                          <span
                            role="img"
                            aria-label={
                              query?.isPending
                                ? "Loading"
                                : query?.isError
                                  ? "Unavailable"
                                  : excluded
                                    ? "Not in run"
                                    : "Unknown / not observed"
                            }
                          >
                            {!query?.isPending && !query?.isError && excluded
                              ? "—"
                              : "?"}
                          </span>
                        </td>
                      );
                    const state = waffleStates[cell.state];
                    const label = `${cell.trial?.trial_name ?? `${cell.task} slot ${cell.slot}`} in ${id}: ${state.label}`;
                    const className = cn(
                      "flex h-3.5 w-3.5 items-center justify-center rounded-[2px] border font-mono text-[9px] leading-none hover:brightness-150 focus-visible:outline-2 focus-visible:outline-cyan-300 [&_span]:border-0",
                      state.color,
                    );
                    const content = (
                      <Hint
                        text={`${query?.isError ? "Stale data — refresh failed.\n" : ""}${cellDescription(cell)}`}
                      >
                        <span
                          aria-hidden="true"
                          className="inline-flex h-3 w-3 items-center justify-center"
                        >
                          {state.symbol}
                        </span>
                      </Hint>
                    );
                    return (
                      <td key={cell.key} className="px-px py-px">
                        {cell.trial?.result?.finished_at ||
                        cell.trial?.result?.exception_info?.exception_type ? (
                          <Link
                            aria-label={label}
                            aria-description={trialExceptionLabel(cell.trial)}
                            className={className}
                            to={`/runs/${encodeURIComponent(id)}/trials/${encodeURIComponent(cell.trial.trial_name)}`}
                          >
                            {content}
                          </Link>
                        ) : (
                          <button
                            type="button"
                            aria-label={label}
                            aria-description={trialExceptionLabel(cell.trial)}
                            className={className}
                          >
                            {content}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!columns.length ? (
          <p role="status" className="p-4 text-sm text-slate-400">
            {queries.some((query) => query?.isPending)
              ? "Loading trial artifacts…"
              : queries.some((query) => query?.isError)
                ? "Trial observations unavailable. Retry the affected run."
                : search
                  ? "No trials match your search."
                  : "No trial artifacts or prepared lock observed yet."}
          </p>
        ) : null}
      </div>
      <div className="my-3 flex flex-wrap justify-between gap-2 text-xs text-slate-400">
        <div>
          <Button
            variant="ghost"
            disabled={!page}
            onClick={() => {
              setRunPage(page - 1);
              setTrialPage(0);
            }}
          >
            Previous runs
          </Button>{" "}
          {page * RUNS + 1}–{Math.min((page + 1) * RUNS, runs.length)} / {runs.length}{" "}
          runs{" "}
          <Button
            variant="ghost"
            disabled={(page + 1) * RUNS >= runs.length}
            onClick={() => {
              setRunPage(page + 1);
              setTrialPage(0);
            }}
          >
            Next runs
          </Button>
        </div>
        <div>
          <Button
            variant="ghost"
            disabled={!columnPage}
            onClick={() => setTrialPage(columnPage - 1)}
          >
            Previous trials
          </Button>{" "}
          {columns.length ? columnPage * TRIALS + 1 : 0}–
          {Math.min((columnPage + 1) * TRIALS, columns.length)} / {columns.length}{" "}
          trials{" "}
          <Button
            variant="ghost"
            disabled={(columnPage + 1) * TRIALS >= columns.length}
            onClick={() => setTrialPage(columnPage + 1)}
          >
            Next trials
          </Button>
        </div>
      </div>
      {visible.map((run, index) => (
        <details key={run.record.run_id} className="my-2 text-xs text-slate-400">
          <summary>
            {run.record.run_id}:{" "}
            {queries[index]?.data?.lock
              ? `${rows[index]?.length ?? 0} planned squares`
              : "Planned total unknown (no job lock)"}{" "}
            · {observations[index]?.length ?? 0} separate observations
          </summary>
          <ul aria-label="Native trial exception evidence">
            {rows[index]?.map((cell) => {
              const trial = cell.trial;
              if (!trial) return null;
              return (
                <li key={cell.key}>
                  {trial.result ? (
                    <Link
                      className="text-cyan-300 hover:underline"
                      to={`/runs/${encodeURIComponent(run.record.run_id)}/trials/${encodeURIComponent(trial.trial_name)}`}
                    >
                      {trial.trial_name}
                    </Link>
                  ) : (
                    trial.trial_name
                  )}{" "}
                  <Badge>{trialExceptionLabel(trial)}</Badge>
                </li>
              );
            })}
          </ul>
          <p>
            Native exception types are evidence, not root-cause classifications. Missing
            evidence is unknown; absence of exceptions does not prove valid scoring.
            Colors and rewards retain their existing meaning.
          </p>
          <p>
            Unmapped, excess, or removed observations do not add planned squares.
            Removed means absent from the current snapshot, not a terminal outcome.
            Replacement names do not establish equivalent repetitions.
          </p>
          <ul>
            {observations[index]?.map(({ trial, removed }) => (
              <li key={trial.trial_name}>
                <span>
                  {trial.trial_name}:{" "}
                  {removed ? "Removed observation" : "Unmapped observation"}
                </span>{" "}
                {trial.result ? (
                  <Link
                    className="text-cyan-300 hover:underline"
                    to={`/runs/${encodeURIComponent(run.record.run_id)}/trials/${encodeURIComponent(trial.trial_name)}`}
                  >
                    Native evidence
                  </Link>
                ) : null}
                {" · "}
                {trialExceptionLabel(trial)}
              </li>
            ))}
          </ul>
        </details>
      ))}
      <details className="text-xs text-slate-400">
        <summary className="cursor-pointer">
          HF Jobs and Harbor totals (separate observations)
        </summary>
        <p className="my-2">
          Queued means waiting at HF; a running sandbox does not prove its agent is
          executing. No individual trial-to-Job mapping is assumed.
        </p>
        {visible.map((run, index) => {
          const data = queries[index]?.data;
          const stats = asRecord(run.result?.stats);
          return (
            <div
              key={run.record.run_id}
              className="my-2 rounded border border-slate-800 p-2"
            >
              <p className="break-all font-mono">
                {run.record.run_id} · {run.status}
              </p>
              <p>
                Harbor:{" "}
                {["n_pending_trials", "n_running_trials", "n_completed_trials"]
                  .map(
                    (key) =>
                      `${key}: ${typeof stats?.[key] === "number" ? stats[key] : "unknown"}`,
                  )
                  .join(" · ")}
              </p>
              <p>
                HF observations: {data?.jobs_observed_at ?? "unavailable"}
                {!recent(data?.jobs_observed_at, now) ? " · stale / unavailable" : ""}
              </p>
              <ul className="max-h-40 overflow-auto">
                {data?.jobs.map((job) => (
                  <li key={job.id} className="break-all">
                    {job.role} · {job.id} ·{" "}
                    {job.stage === "queued" ? "queued (waiting at HF)" : job.stage}
                  </li>
                ))}
              </ul>
              {!data?.jobs.length ? <p>No HF Job observations available.</p> : null}
            </div>
          );
        })}
      </details>
    </section>
  );
}
