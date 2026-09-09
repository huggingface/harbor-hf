import { useQuery } from "@tanstack/react-query";
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
import { Badge, Button, Hint } from "./ui";

const TASKS = 25;
// Keying the inner view resets filters, focus, and observation memory on navigation.
export function RunWaffle({ run }: { run: RunView }) {
  return <RunWaffleContents key={run.record.run_id} run={run} />;
}
function RunWaffleContents({ run }: { run: RunView }) {
  const id = run.record.run_id;
  const stats = asRecord(run.result?.stats);
  const [taskPage, setTaskPage] = useState(0);
  const [search, setSearch] = useState("");
  const query = useQuery({
    queryKey: ["trial-progress", id],
    queryFn: () => getTrialProgress(id),
    staleTime: 5_000,
    refetchInterval: ["finished", "cancelled", "cost_stopped"].includes(run.status)
      ? 120_000
      : 15_000,
    retry: false,
  });
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  const assignments = useRef<WaffleCell[]>([]);
  const history = useRef<SeparateObservation[]>([]);
  const cells = query.data
    ? waffleCells(run, query.data, now, query.isError, assignments.current)
    : [];
  const observations = query.data
    ? separateObservations(query.data, cells, history.current, assignments.current)
    : [];
  useEffect(() => {
    if (query.data) {
      assignments.current = cells;
      history.current = observations;
    }
  });
  const groups = new Map<string, WaffleCell[]>();
  for (const cell of cells) {
    const key = JSON.stringify([cell.task, cell.digest]);
    const group = groups.get(key) ?? [];
    group.push(cell);
    groups.set(key, group);
  }
  // Filter whole task rows, never hide individual repeats or change planned totals.
  const needle = search.toLowerCase();
  const rows = [...groups.entries()].filter(([, row]) =>
    row.some((cell) =>
      [
        cell.task,
        cell.digest,
        cell.trial?.trial_name ?? "",
        trialExceptionLabel(cell.trial),
        waffleStates[cell.state].label,
      ].some((text) => text.toLowerCase().includes(needle)),
    ),
  );
  const page = Math.min(taskPage, Math.max(0, Math.ceil(rows.length / TASKS) - 1));
  const shown = rows.slice(page * TASKS, (page + 1) * TASKS);
  return (
    <section
      aria-label="Trial progress waffle"
      className="mt-6 rounded-xl border border-slate-800 bg-slate-950/70 p-4"
    >
      <div className="mb-3 flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="font-semibold">Trial progress</h2>
          <p className="text-xs text-slate-400">
            One task/input per row · one square per lock entry (observations only
            without a lock) · active runs refresh every 15s; terminal runs every 2m
          </p>
          <p className="text-xs text-slate-500">
            Artifact observations, not scheduling authority. Repeats stay separate;
            display slots are not attempt ordinals.
          </p>
        </div>
        <label className="text-xs">
          Find a trial{" "}
          <input
            type="search"
            value={search}
            placeholder="Task, trial, state or exception"
            className="rounded border border-slate-700 bg-slate-900 p-1"
            onChange={(event) => {
              setSearch(event.target.value);
              setTaskPage(0);
            }}
          />
        </label>
      </div>
      <RunDiagnosticsSummary run={run} />
      {query.isFetching && !query.isPending ? (
        <span role="status">Refreshing…</span>
      ) : null}
      {query.data && !query.isError && !recent(query.data.observed_at, now) ? (
        <span role="status">Stale data</span>
      ) : null}
      {query.isError ? (
        <span role="status">
          {query.data ? "Stale data" : "Unavailable"}{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </span>
      ) : null}
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
      </ul>
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-800 p-2">
        <table className="w-max border-separate border-spacing-0 text-xs">
          <caption className="sr-only">
            Tasks by input digest with separate repetition squares; display slots are
            not attempt ordinals
          </caption>
          <tbody>
            {shown.map(([key, row]) => (
              <tr key={key}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-60 bg-slate-950 py-2 pr-3 text-left font-normal"
                >
                  <span className="block break-words">{row[0]?.task}</span>{" "}
                  <span
                    className="block max-w-48 truncate text-[10px] text-slate-500"
                    title={row[0]?.digest}
                  >
                    {row[0]?.digest}
                  </span>
                </th>
                {row.map((cell) => {
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
            ))}
          </tbody>
        </table>
        {!rows.length ? (
          <p role="status" className="p-4 text-sm text-slate-400">
            {query.isPending
              ? "Loading trial artifacts…"
              : query.isError
                ? "Trial observations unavailable. Retry the affected run."
                : search
                  ? "No trials match your search."
                  : "No trial artifacts or prepared lock observed yet."}
          </p>
        ) : null}
      </div>
      <div className="my-3 text-xs text-slate-400">
        <Button variant="ghost" disabled={!page} onClick={() => setTaskPage(page - 1)}>
          Previous tasks
        </Button>{" "}
        {rows.length ? page * TASKS + 1 : 0}–{Math.min((page + 1) * TASKS, rows.length)}{" "}
        / {rows.length} task rows{" "}
        <Button
          variant="ghost"
          disabled={(page + 1) * TASKS >= rows.length}
          onClick={() => setTaskPage(page + 1)}
        >
          Next tasks
        </Button>
      </div>
      <details className="my-2 text-xs text-slate-400">
        <summary>
          {run.record.run_id}:{" "}
          {query.data?.lock
            ? `${cells.length} planned squares`
            : "Planned total unknown (no job lock)"}{" "}
          · {observations.length} separate observations
        </summary>
        <ul aria-label="Native trial exception evidence">
          {cells.map((cell) => {
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
          Unmapped, excess, or removed observations do not add planned squares. Removed
          means absent from the current snapshot, not a terminal outcome. Replacement
          names do not establish equivalent repetitions.
        </p>
        <ul>
          {observations.map(({ trial, removed }) => (
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
      <details className="text-xs text-slate-400">
        <summary className="cursor-pointer">
          HF Jobs and Harbor totals (separate observations)
        </summary>
        <p className="my-2">
          Queued means waiting at HF; a running sandbox does not prove its agent is
          executing. No individual trial-to-Job mapping is assumed.
        </p>

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
            HF observations: {query.data?.jobs_observed_at ?? "unavailable"}
            {!recent(query.data?.jobs_observed_at, now) ? " · stale / unavailable" : ""}
          </p>
          <ul className="max-h-40 overflow-auto">
            {query.data?.jobs.map((job) => (
              <li key={job.id} className="break-all">
                {job.role} · {job.id} ·{" "}
                {job.stage === "queued" ? "queued (waiting at HF)" : job.stage}
              </li>
            ))}
          </ul>
          {!query.data?.jobs.length ? <p>No HF Job observations available.</p> : null}
        </div>
      </details>
    </section>
  );
}
