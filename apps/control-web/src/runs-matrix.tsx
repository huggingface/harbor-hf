import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { RunList } from "./api";
import { cn, humanize, shortId } from "./lib";
import { taskQueryOptions } from "./queries";
import { trialDescription, trialKey, trialState, trialStates } from "./trial-matrix";
import { Button, Empty, Hint, Progress } from "./ui";

const RUNS_PER_PAGE = 8;
const TRIALS_PER_PAGE = 50;

export function RunsMatrix({ runs }: { runs: RunList["items"] }) {
  const [runPage, setRunPage] = useState(0);
  const [trialPage, setTrialPage] = useState(0);
  const [search, setSearch] = useState("");
  const page = Math.min(
    runPage,
    Math.max(0, Math.ceil(runs.length / RUNS_PER_PAGE) - 1),
  );
  const visibleRuns = runs.slice(page * RUNS_PER_PAGE, (page + 1) * RUNS_PER_PAGE);
  const queries = useQueries({
    queries: visibleRuns.map((run) => ({
      ...taskQueryOptions(run.run_id),
      staleTime: 5_000,
      refetchInterval: 15_000,
    })),
  });
  const columns = queries.map(
    (query) => new Map((query.data?.items ?? []).map((task) => [trialKey(task), task])),
  );
  const rows = [...new Map(columns.flatMap((column) => [...column])).values()]
    .filter((task) => task.task_id.toLowerCase().includes(search.toLowerCase()))
    .sort(
      (a, b) =>
        a.task_id.localeCompare(b.task_id) ||
        a.input_digest.localeCompare(b.input_digest),
    );
  const rowPage = Math.min(
    trialPage,
    Math.max(0, Math.ceil(rows.length / TRIALS_PER_PAGE) - 1),
  );
  const visibleRows = rows.slice(
    rowPage * TRIALS_PER_PAGE,
    (rowPage + 1) * TRIALS_PER_PAGE,
  );
  if (!runs.length) return <Empty>No runs match this filter</Empty>;
  return (
    <section
      aria-label="Trial progress matrix"
      className="rounded-xl border border-slate-800 bg-slate-950/70 p-4"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-100">Trial progress</h2>
          <p className="mt-1 text-xs text-slate-400">
            Trials × runs · refreshes every 15s. Hover or focus a cell for details;
            select it to inspect.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Rows match task identity and input digest. Completion is not a passing
            score; missing rewards are never treated as zero.
          </p>
        </div>
        <label className="text-xs text-slate-400">
          Find a trial
          <input
            className="ml-2 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-100"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setTrialPage(0);
            }}
            type="search"
          />
        </label>
      </div>
      <ul
        aria-label="Trial state legend"
        className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-300"
      >
        {Object.values(trialStates).map((state) => (
          <li key={state.label} className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                "inline-flex h-5 w-5 items-center justify-center rounded border font-mono",
                state.className,
              )}
            >
              {state.symbol}
            </span>
            {state.label}
          </li>
        ))}
        <li>— Not in run</li>
      </ul>
      <div className="max-h-[65vh] overflow-auto rounded-lg border border-slate-800">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <caption className="sr-only">
            Logical trials by run. Symbols and colors indicate progress, not aggregate
            scores.
          </caption>
          <thead className="sticky top-0 z-20 bg-slate-900">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-30 min-w-40 bg-slate-900 p-3 text-left text-slate-400"
              >
                Trial / input
              </th>
              {visibleRuns.map((run, index) => (
                <th
                  key={run.run_id}
                  scope="col"
                  className="min-w-32 max-w-48 border-l border-slate-800 p-3 align-top"
                >
                  <Link
                    className="mb-2 block break-all font-mono text-cyan-300 hover:underline"
                    to={`/runs/${encodeURIComponent(run.run_id)}`}
                  >
                    {run.run_id}
                  </Link>
                  <span className="mb-2 block font-normal text-slate-400">
                    {humanize(run.status)}
                  </span>
                  <Progress
                    label={`${run.terminal_tasks}/${run.total_tasks} sealed`}
                    value={
                      run.total_tasks ? (100 * run.terminal_tasks) / run.total_tasks : 0
                    }
                  />
                  {queries[index]?.isError ? (
                    <div role="status" className="mt-2 text-rose-300">
                      {queries[index]?.data ? "Stale data" : "Unavailable"}
                      <Button
                        variant="ghost"
                        onClick={() => void queries[index]?.refetch()}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : null}
                  {queries[index]?.isPending ? (
                    <span role="status">Loading trials…</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
              <tr key={trialKey(row)}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 max-w-64 border-t border-slate-800 bg-slate-950 px-3 py-2 text-left font-normal"
                >
                  <span className="block break-all font-mono text-slate-300">
                    {row.task_id}
                  </span>
                  <Hint text={`Input digest: ${row.input_digest}`}>
                    <span className="text-[10px] text-slate-500">
                      {shortId(row.input_digest)}
                    </span>
                  </Hint>
                </th>
                {visibleRuns.map((run, index) => {
                  const task = columns[index]?.get(trialKey(row));
                  const query = queries[index];
                  const unavailable = query?.isPending
                    ? "Loading"
                    : query?.isError && !query.data
                      ? "Unavailable"
                      : "Not in run";
                  if (!task)
                    return (
                      <td
                        key={run.run_id}
                        className="border-l border-t border-slate-800 p-1 text-center text-slate-500"
                      >
                        <Hint text={`${run.run_id}: ${unavailable}`}>
                          <span role="img" aria-label={unavailable}>
                            {unavailable === "Not in run" ? "—" : "?"}
                          </span>
                        </Hint>
                      </td>
                    );
                  const state = trialStates[trialState(task)];
                  return (
                    <td
                      key={run.run_id}
                      className="border-l border-t border-slate-800 p-1 text-center"
                    >
                      <Link
                        to={`/runs/${encodeURIComponent(run.run_id)}/tasks/${encodeURIComponent(task.task_id)}`}
                        aria-label={`${task.task_id} in ${run.run_id}: ${state.label}`}
                        className={cn(
                          "inline-flex h-8 w-10 items-center justify-center rounded-md border font-mono text-sm font-semibold transition hover:brightness-125 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300",
                          state.className,
                        )}
                      >
                        <Hint
                          text={`${query?.isError ? "Stale data — refresh failed.\n" : ""}${trialDescription(task)}`}
                        >
                          <span aria-hidden="true">{state.symbol}</span>
                        </Hint>
                      </Link>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length ? (
          <p role="status" className="p-6 text-center text-sm text-slate-400">
            {queries.some((query) => query.isPending)
              ? "Loading trials…"
              : queries.some((query) => query.isError)
                ? "Some trial data could not be loaded. Retry the affected run."
                : search
                  ? "No trials match your search."
                  : "No prepared trials yet."}
          </p>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={page === 0}
            onClick={() => {
              setRunPage(page - 1);
              setTrialPage(0);
            }}
          >
            Previous columns
          </Button>
          <span>
            {page * RUNS_PER_PAGE + 1}–
            {Math.min((page + 1) * RUNS_PER_PAGE, runs.length)} of {runs.length} runs on
            this page
          </span>
          <Button
            variant="ghost"
            disabled={(page + 1) * RUNS_PER_PAGE >= runs.length}
            onClick={() => {
              setRunPage(page + 1);
              setTrialPage(0);
            }}
          >
            Next columns
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            disabled={rowPage === 0}
            onClick={() => setTrialPage(rowPage - 1)}
          >
            Previous trials
          </Button>
          <span>
            {rows.length ? rowPage * TRIALS_PER_PAGE + 1 : 0}–
            {Math.min((rowPage + 1) * TRIALS_PER_PAGE, rows.length)} of {rows.length}{" "}
            trials
          </span>
          <Button
            variant="ghost"
            disabled={(rowPage + 1) * TRIALS_PER_PAGE >= rows.length}
            onClick={() => setTrialPage(rowPage + 1)}
          >
            Next trials
          </Button>
        </div>
      </div>
    </section>
  );
}
