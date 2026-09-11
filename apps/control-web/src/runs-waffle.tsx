import { RunSectionQuery } from "./run-section-query";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RunView } from "./api";
import { useRunClock, useTrialProgress } from "./queries";
import { asRecord, cn } from "./lib";
import { projectRunExceptions } from "./run-diagnostics";
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

const TASKS = 100;
// Keying the inner view resets filters, focus, and observation memory on navigation.
export function RunWaffle({ run }: { run: RunView }) {
  return <RunWaffleContents key={run.record.run_id} run={run} />;
}
function RunWaffleContents({ run }: { run: RunView }) {
  const id = run.record.run_id;
  const stats = asRecord(run.result?.stats);
  const [taskPage, setTaskPage] = useState(0);
  const [search, setSearch] = useState("");
  const query = useTrialProgress(id);
  const now = useRunClock();
  const assignments = useRef<WaffleCell[]>([]);
  const history = useRef<SeparateObservation[]>([]);
  const cells = query.data
    ? waffleCells(run, query.data, now, assignments.current)
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
  // Filter whole task columns, never hide individual repeats or change planned totals.
  const needle = search.toLowerCase();
  const columns = [...groups.entries()].filter(([, row]) =>
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
  const page = Math.min(taskPage, Math.max(0, Math.ceil(columns.length / TASKS) - 1));
  const shown = columns.slice(page * TASKS, (page + 1) * TASKS);
  const evidence = projectRunExceptions(run.result);
  const stale = !!(query.data && !recent(query.data.observed_at, now));
  const freshnessWarning = stale
    ? "Stale — discovery observation is older than one minute or its timestamp is unavailable"
    : query.isError
      ? query.data
        ? "Refresh failed; recent discovery observation"
        : "Trial observations unavailable"
      : undefined;
  const repeats = Math.max(0, ...[...groups.values()].map((group) => group.length));
  const rowLabelWidth = Math.max(2, String(repeats).length) * 8 + 8;
  const matrixStyle: CSSProperties & { "--cell-size": string } = {
    "--cell-size": `clamp(12px, calc((100cqw - ${rowLabelWidth + 2}px) / ${Math.max(1, shown.length)}), 18px)`,
  };
  if (!query.data) {
    return (
      <section
        aria-label="Trial progress waffle"
        className="mt-6 rounded-xl border border-slate-800 bg-slate-950/70 p-4"
      >
        <h2 className="font-semibold">Trial progress</h2>
        <RunSectionQuery label="trial progress" query={query} />
      </section>
    );
  }
  return (
    <section
      aria-label="Trial progress waffle"
      className="mt-6 rounded-xl border border-slate-800 bg-slate-950/70 p-4"
    >
      <RunSectionQuery label="trial progress" query={query} />
      <div className="mb-3 flex flex-wrap justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="font-semibold">Trial progress</h2>
            <fieldset
              aria-label="Discovery observation freshness"
              className="flex h-6 w-36 shrink-0 items-center gap-2 text-xs text-amber-400/80"
            >
              <span role="status" title={freshnessWarning}>
                {stale
                  ? "● Stale"
                  : query.isError && !query.data
                    ? "● Unavailable"
                    : ""}
              </span>
            </fieldset>
          </div>
          <p className="text-xs text-slate-400">
            {groups.size} tasks × {repeats} repeat slots · {cells.length}{" "}
            {query.data?.lock ? "planned" : "observed"}
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
      <Link
        to={`/runs/${encodeURIComponent(id)}#diagnostics`}
        className={cn(
          "text-xs",
          evidence.affectedTrials > 0 ? "text-red-400" : "text-slate-400",
        )}
      >
        {evidence.affectedTrials > 0
          ? `${evidence.complete ? "" : "≥"}${evidence.affectedTrials} affected trials`
          : evidence.complete
            ? "Exception evidence"
            : "Exception evidence partial / unavailable"}
      </Link>
      <details className="my-3 text-xs text-slate-400">
        <summary className="cursor-pointer">Legend and display-slot help</summary>
        <p>
          Tasks/input digests are columns; repetitions are display slots, not aligned
          real attempt numbers. One square per lock entry (observations only without a
          lock). Artifact observations are not scheduling authority: unfinished does not
          mean running. The browser polls every 30s while visible. Artifact reads are on
          demand with a 30s backend cache, regardless of run status. Completed records
          are reconciled every 5 minutes on demand and retain their last-checked time
          between checks. Header freshness reflects discovery; unfinished squares use
          each trial's last check (discovery time for legacy responses). The separate
          reconciler defaults to 15s (configurable, non-overlapping). These intervals do
          not guarantee update latency; requests and background tabs can delay updates.
          Slots do not establish equivalent repetitions across runs or individual HF Job
          associations. Missing exception evidence is unknown; no recorded exception is
          not proof of valid scoring. Infrastructure classification is not recorded by
          Harbor. Reported cost may be partial, not billing. Open a linked trial for
          full native details.
        </p>
        <ul
          aria-label="Trial state legend"
          className="mb-4 flex flex-wrap gap-x-4 gap-y-2 text-xs text-slate-300"
        >
          {Object.values(waffleStates).map((state) => (
            <li key={state.label} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex items-center justify-center rounded-[2px] border text-[9px] leading-none",
                  state.marker,
                  state.color,
                )}
              >
                {state.symbol}
              </span>
              {state.label}
            </li>
          ))}
        </ul>
      </details>
      <div className="max-h-[60vh] overflow-auto rounded-lg border border-slate-800 p-2 [container-type:inline-size]">
        <table
          style={matrixStyle}
          className="w-max border-separate border-spacing-0 text-xs leading-none"
        >
          <caption className="sr-only">
            Task columns by input digest and repetition-slot rows; display slots are not
            attempt ordinals
          </caption>
          <thead className="sr-only">
            <tr>
              <th scope="col" className="sticky left-0 z-10 bg-slate-950 pr-2">
                Slot
              </th>
              {shown.map(([key, group]) => (
                <th
                  key={key}
                  scope="col"
                  aria-label={`${group[0]?.task} ${group[0]?.digest}`}
                >
                  {group[0]?.task} {group[0]?.digest}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: shown.length ? repeats : 0 }, (_, repeat) => (
              // Display slots never reorder; native cell keys still reset replacement focus.
              // biome-ignore lint/suspicious/noArrayIndexKey: the row identity is its display repetition slot
              <tr key={repeat}>
                <th
                  scope="row"
                  style={{ width: rowLabelWidth, minWidth: rowLabelWidth }}
                  className="sticky left-0 z-10 bg-slate-950 pr-2 text-right font-mono font-normal"
                  aria-label={`Repeat slot ${repeat + 1}`}
                >
                  {repeat + 1}
                </th>
                {shown.map(([key, group]) => {
                  const cell = group[repeat];
                  if (!cell)
                    return (
                      <td
                        key={key}
                        className="text-center text-slate-500"
                        aria-label={`${group[0]?.task}, repeat slot ${repeat + 1}: Not planned`}
                      >
                        -
                      </td>
                    );
                  const state = waffleStates[cell.state];
                  const label = `${cell.trial?.trial_name ?? `${cell.task} slot ${cell.slot}`} in ${id}: ${state.label}`;
                  const className = cn(
                    "flex h-[var(--cell-size)] w-[var(--cell-size)] min-h-3 min-w-3 items-center justify-center rounded-[2px] font-mono text-[9px] leading-none hover:brightness-150 focus-visible:outline-2 focus-visible:outline-cyan-300 [@media(pointer:coarse)]:h-6 [@media(pointer:coarse)]:w-6 [&>span]:h-full [&>span]:w-full [&>span]:justify-center [&>span>span]:flex [&>span>span]:border-0",
                  );
                  const content = (
                    <Hint
                      text={`${freshnessWarning ? `${freshnessWarning}\n` : ""}${cellDescription(cell, query.data?.observed_at)}`}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "inline-flex items-center justify-center rounded-[2px] border",
                          state.marker,
                          state.color,
                        )}
                      >
                        {state.symbol}
                      </span>
                    </Hint>
                  );
                  return (
                    <td key={cell.key} className="p-0">
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
        {!columns.length ? (
          <p role="status" className="p-4 text-sm text-slate-400">
            {query.isPending
              ? "Loading trial artifacts…"
              : query.isError && !query.data
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
        {columns.length ? page * TASKS + 1 : 0}–
        {Math.min((page + 1) * TASKS, columns.length)} / {columns.length} task columns{" "}
        <Button
          variant="ghost"
          disabled={(page + 1) * TASKS >= columns.length}
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
            <span className="block h-4">
              {!recent(query.data?.jobs_observed_at, now) ? "stale / unavailable" : ""}
            </span>
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
