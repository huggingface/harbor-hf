import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import { getReplacements, type RunView } from "./api";
import { RUN_POLL_INTERVAL_MS, useRunClock } from "./queries";

const Clock = createContext<number | null>(null);

/** One browser polling/expiry clock, not one timer for each table cell. */
export function ResultBrowsingProvider({ children }: { children: ReactNode }) {
  const now = useRunClock();
  const client = useQueryClient();
  useEffect(() => {
    const refresh = (staleOnly = false) => {
      if (document.visibilityState === "hidden") return;
      void client.refetchQueries(
        {
          queryKey: ["replacements"],
          type: "active",
          ...(staleOnly ? { stale: true } : {}),
        },
        { cancelRefetch: false },
      );
    };
    const timer = setInterval(() => refresh(), RUN_POLL_INTERVAL_MS);
    const onFocus = () => refresh(true);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [client]);
  return <Clock.Provider value={now}>{children}</Clock.Provider>;
}

const started = new Map<string, ReturnType<typeof getReplacements>>();
let active = 0;
const waiting: Array<() => void> = [];
async function boundedReplacements(runId: string, getSignal: () => AbortSignal) {
  const existing = started.get(runId);
  if (existing) return existing;
  let signal: AbortSignal | undefined;
  if (active >= 2) {
    signal = getSignal();
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active += 1;
  try {
    // Rows filtered away while queued must not start cold evidence inspection.
    // Do not consume cancellation for an immediately started inspection: the
    // endpoint continues independently, so a remount must reuse its query.
    signal?.throwIfAborted();
    // Another queued owner may already have admitted this run. Share only live
    // HTTP work, never completed evidence, and keep its slot until settlement.
    const existing = started.get(runId);
    if (existing) return await existing;
    const request = getReplacements(runId);
    started.set(runId, request);
    try {
      return await request;
    } finally {
      started.delete(runId);
    }
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}

/** A cancelled query owner can leave admitted HTTP work running independently. */
export function settleReplacementInspection(runId: string) {
  // The query owns error presentation; relationship discovery still rechecks.
  return started.get(runId)?.catch(() => undefined);
}

export function useReplacementResult(runId: string, enabled = true) {
  return useQuery({
    queryKey: ["replacements", runId],
    queryFn: (context) => boundedReplacements(runId, () => context.signal),
    enabled,
    staleTime: RUN_POLL_INTERVAL_MS,
    retry: false,
  });
}

export function useResultEvidenceClock() {
  return useContext(Clock) ?? Date.now();
}

/** Discover before presentation/search filters; the endpoint owns recursion. */
export function runsWithDirectChildren(runs: RunView[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const run of runs) {
    const parent = run.record.operator_selection?.original_run_id;
    if (!parent) continue;
    const ids = children.get(parent) ?? [];
    ids.push(run.record.run_id);
    children.set(parent, ids);
  }
  return children;
}

/** Discovery only: descendant edges fence ancestors, never select trial results. */
export function descendantRelationships(runs: RunView[]): Map<string, string> {
  const parents = new Map(
    runs.flatMap((run) => {
      const parent = run.record.operator_selection?.original_run_id;
      return parent ? [[run.record.run_id, parent] as const] : [];
    }),
  );
  const edges = new Map<string, string[]>();
  for (const [child, parent] of parents) {
    const seen = new Set([child]);
    let ancestor: string | undefined = parent;
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor);
      // Direct children are already fenced against the endpoint's child list.
      if (ancestor !== parent) {
        const relations = edges.get(ancestor) ?? [];
        relations.push(JSON.stringify([parent, child]));
        edges.set(ancestor, relations);
      }
      ancestor = parents.get(ancestor);
    }
  }
  return new Map([...edges].map(([id, relations]) => [id, relations.sort().join(",")]));
}
