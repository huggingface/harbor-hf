import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useSyncExternalStore } from "react";
import { keys, useRunClock } from "./queries";

/** Run detail owns fetch feedback; evidence freshness stays in its sections. */
export const ConsolidatedRunRefresh = createContext(false);

function RefreshEntry({
  label,
  queryKey,
  now,
}: {
  label: string;
  queryKey: readonly string[];
  now: number;
}) {
  const client = useQueryClient();
  const subscribe = useCallback(
    (notify: () => void) => client.getQueryCache().subscribe(notify),
    [client],
  );
  const state = useSyncExternalStore(subscribe, () => client.getQueryState(queryKey));
  const fetching = state?.fetchStatus === "fetching";
  const failed = state?.status === "error";
  const updatedAt = state?.dataUpdatedAt ?? 0;
  const age = Math.max(0, Math.floor((now - updatedAt) / 1_000));
  const ageLabel = age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
  const status = fetching
    ? updatedAt
      ? "Refreshing…"
      : "Loading…"
    : failed
      ? updatedAt
        ? "Refresh failed · saved data"
        : "Unavailable"
      : updatedAt
        ? "Idle"
        : "Waiting…";
  return (
    <fieldset className="min-w-0" aria-label={`${label} refresh`}>
      <div className="truncate text-xs font-medium text-slate-300">{label}</div>
      <div
        role={failed ? "alert" : "status"}
        className={`h-5 truncate text-xs ${failed ? "text-amber-400" : "text-slate-400"}`}
        title={status}
      >
        {status}
      </div>
      <div className="flex h-5 items-center gap-2 text-xs text-slate-500">
        <span
          className="min-w-0 truncate tabular-nums"
          title={updatedAt ? new Date(updatedAt).toISOString() : undefined}
        >
          {updatedAt ? `Received ${ageLabel}` : "No response yet"}
        </span>
        {failed ? (
          <button
            type="button"
            className="shrink-0 text-amber-400 underline disabled:opacity-50"
            aria-label={`Retry ${label}`}
            disabled={fetching}
            onClick={() => void client.refetchQueries({ queryKey, exact: true })}
          >
            Retry
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}

export function RunRefreshStatus({ runId }: { runId: string }) {
  const now = useRunClock();
  return (
    <section
      aria-label="Refresh status"
      className="mb-5 rounded-lg border border-slate-800 bg-slate-950/50 px-4 py-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2 text-xs text-slate-500">
        <h2 className="font-medium text-slate-300">Refresh status</h2>
        <span title="Response age is not the age of Harbor evidence. Polling pauses in background tabs.">
          Polls every 30s while visible
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <RefreshEntry label="Run details" queryKey={keys.run(runId)} now={now} />
        <RefreshEntry
          label="Trial progress"
          queryKey={["trial-progress", runId]}
          now={now}
        />
        <RefreshEntry label="Trials" queryKey={keys.trials(runId)} now={now} />
        <RefreshEntry label="Parent Jobs" queryKey={keys.jobs} now={now} />
      </div>
    </section>
  );
}
