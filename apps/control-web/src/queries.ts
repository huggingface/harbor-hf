import { type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  AuditResponse,
  Capacity,
  EndpointList,
  JobList,
  Leaderboard,
  NamespaceCapacity,
  ProfileList,
  ResultDetail,
  ResultList,
  Run,
  RunList,
  SessionResponse,
  SystemResponse,
  TaskDetail,
  TaskList,
} from "./api";
import { ApiError, request } from "./api";

export const keys = {
  session: ["session"] as const,
  system: ["system"] as const,
  infrastructureCapacity: ["infrastructure-capacity"] as const,
  runs: ["runs"] as const,
  run: (id: string) => ["run", id] as const,
  capacity: (id: string) => ["capacity", id] as const,
  tasks: (id: string) => ["tasks", id] as const,
  task: (run: string, task: string) => ["task", run, task] as const,
  jobs: ["jobs"] as const,
  runJobs: (id: string) => ["run-jobs", id] as const,
  endpoints: ["endpoints"] as const,
  profiles: ["profiles"] as const,
  results: ["results"] as const,
  leaderboard: ["leaderboard"] as const,
  result: (id: string) => ["result", id] as const,
  audit: ["audit"] as const,
};

export interface ResultFilters {
  model?: string | undefined;
  benchmark?: string | undefined;
  agent?: string | undefined;
  status?: string | undefined;
  search?: string | undefined;
  published_after?: string | undefined;
  published_before?: string | undefined;
  sort?: "published_at" | "model" | "benchmark" | "status" | "score";
  order?: "asc" | "desc";
}

export interface ControlEvent {
  id?: string;
  type: string;
  occurred_at: string;
  data: Record<string, unknown>;
  replay?: boolean;
  cursor_reset?: boolean;
}

export type LiveStatus = "connected" | "reconnecting" | "offline" | "stale";
// Control records arrive in bursts while Jobs are active. One bounded refresh
// window keeps collection queries current without continuously refetching them.
export const SSE_INVALIDATION_DEBOUNCE_MS = 5_000;

export interface LiveState {
  status: LiveStatus;
  lastSuccessfulUpdate: number | null;
  retryAt: number | null;
}

export function collectionUrl(
  path: string,
  cursor?: string,
  limit?: number,
  filters: Record<string, string | undefined> = {},
): string {
  const parameters = new URLSearchParams();
  if (cursor) parameters.set("cursor", cursor);
  if (limit) parameters.set("limit", String(limit));
  for (const [key, value] of Object.entries(filters)) {
    if (value) parameters.set(key, value);
  }
  const query = parameters.toString();
  return query ? `${path}?${query}` : path;
}

export function queryRetryDelay(attempt: number, error: unknown): number {
  const exponential = Math.min(1_000 * 2 ** attempt, 30_000);
  if (!(error instanceof ApiError) || !error.retryAt) return exponential;
  return Math.min(Math.max(error.retryAt - Date.now(), exponential), 300_000);
}

const retryTransient = (count: number, error: unknown) =>
  error instanceof ApiError &&
  error.transient &&
  (!error.retryAt || error.retryAt - Date.now() <= 300_000) &&
  count < 3;

export const useSession = () =>
  useQuery({
    queryKey: keys.session,
    queryFn: () => request<SessionResponse>("/api/v1/auth/session"),
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 401) &&
      retryTransient(count, error),
    retryDelay: queryRetryDelay,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
export const useSystem = (enabled = true) =>
  useQuery({
    enabled,
    queryKey: keys.system,
    queryFn: () => request<SystemResponse>("/api/v1/system"),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useInfrastructureCapacity = () =>
  useQuery({
    queryKey: keys.infrastructureCapacity,
    queryFn: () => request<NamespaceCapacity>("/api/v1/capacity"),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
    staleTime: 5_000,
  });
export const useRuns = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.runs, cursor ?? null],
    queryFn: () => request<RunList>(collectionUrl("/api/v1/runs", cursor)),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useRun = (id: string) =>
  useQuery({
    queryKey: keys.run(id),
    queryFn: () => request<Run>(`/api/v1/runs/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useCapacity = (id: string) =>
  useQuery({
    queryKey: keys.capacity(id),
    queryFn: () => request<Capacity>(`/api/v1/runs/${encodeURIComponent(id)}/capacity`),
    enabled: Boolean(id),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useTasks = (id: string) =>
  useQuery({
    queryKey: keys.tasks(id),
    queryFn: () => request<TaskList>(`/api/v1/runs/${encodeURIComponent(id)}/tasks`),
    enabled: Boolean(id),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useTask = (run: string, task: string) =>
  useQuery({
    queryKey: keys.task(run, task),
    queryFn: () =>
      request<TaskDetail>(
        `/api/v1/runs/${encodeURIComponent(run)}/tasks/${encodeURIComponent(task)}`,
      ),
    enabled: Boolean(run && task),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useJobs = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.jobs, cursor ?? null],
    queryFn: () => request<JobList>(collectionUrl("/api/v1/jobs", cursor)),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
export const useRunJobs = (runId: string) =>
  useQuery({
    queryKey: keys.runJobs(runId),
    queryFn: () =>
      request<JobList>(
        collectionUrl("/api/v1/jobs", undefined, undefined, {
          run_id: runId,
        }),
      ),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    enabled: Boolean(runId),
  });
export const useEndpoints = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.endpoints, cursor ?? null],
    queryFn: () => request<EndpointList>(collectionUrl("/api/v1/endpoints", cursor)),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export async function collectPagedItems<T>(
  loadPage: (cursor?: string) => Promise<{ items: T[]; next_cursor: string | null }>,
  itemKey?: (item: T) => string,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  const requestedCursors = new Set<string>();
  const observedItems = new Set<string>();
  for (;;) {
    if (cursor) requestedCursors.add(cursor);
    const result = await loadPage(cursor);
    let added = 0;
    for (const item of result.items) {
      if (itemKey) {
        const key = itemKey(item);
        if (observedItems.has(key)) continue;
        observedItems.add(key);
      }
      items.push(item);
      added += 1;
    }
    if (!result.next_cursor) return items;
    if (added === 0) throw new Error("paged list made no progress");
    if (result.next_cursor === cursor || requestedCursors.has(result.next_cursor))
      throw new Error("paged list repeated a cursor");
    cursor = result.next_cursor;
  }
}

export const useProfiles = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.profiles, cursor ?? null],
    queryFn: () => request<ProfileList>(collectionUrl("/api/v1/profiles", cursor, 100)),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });

/** Load every profile page. Launch needs models and harnesses that sort after deployments. */
export const useAllProfiles = () =>
  useQuery({
    queryKey: [...keys.profiles, "all"],
    queryFn: async () => ({
      items: await collectPagedItems(
        (cursor) =>
          request<ProfileList>(collectionUrl("/api/v1/profiles", cursor, 100)),
        (item) => item.profile_id,
      ),
      next_cursor: null,
    }),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useResults = (cursor?: string, filters: ResultFilters = {}) =>
  useQuery({
    queryKey: [...keys.results, cursor ?? null, filters],
    queryFn: () =>
      request<ResultList>(
        collectionUrl(
          "/api/v1/results",
          cursor,
          50,
          filters as Record<string, string | undefined>,
        ),
      ),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useLeaderboard = () =>
  useQuery({
    queryKey: keys.leaderboard,
    queryFn: () => request<Leaderboard>("/api/v1/leaderboard"),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useResult = (id: string) =>
  useQuery({
    queryKey: keys.result(id),
    queryFn: () => request<ResultDetail>(`/api/v1/results/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useAudit = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.audit, cursor ?? null],
    queryFn: () => request<AuditResponse>(collectionUrl("/api/v1/audit", cursor, 250)),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });

function stringData(event: ControlEvent, key: string): string | null {
  const value = event.data[key];
  return typeof value === "string" ? value : null;
}

function queryKeyStartsWith(key: QueryKey, prefix: QueryKey): boolean {
  return (
    prefix.length <= key.length &&
    prefix.every((value, index) => Object.is(value, key[index]))
  );
}

function coalesceQueryKey(pending: QueryKey[], next: QueryKey): QueryKey[] {
  if (pending.some((key) => queryKeyStartsWith(next, key))) return pending;
  return [...pending.filter((key) => !queryKeyStartsWith(key, next)), next];
}

export function affectedQueryKeys(event: ControlEvent): QueryKey[] {
  if (event.type === "heartbeat") return [];
  const affected: QueryKey[] = [keys.audit];
  const runId = stringData(event, "run_id");
  const taskId = stringData(event, "task_id");
  if (event.type.startsWith("profile.")) {
    affected.push(keys.profiles);
    if (stringData(event, "profile_kind") === "capacity")
      affected.push(keys.infrastructureCapacity, ["capacity"]);
  }
  if (event.type === "publication.receipt")
    affected.push(keys.results, keys.leaderboard);
  if (
    event.type.startsWith("run.") ||
    event.type.startsWith("budget.") ||
    event.type.startsWith("attempt.") ||
    event.type.startsWith("terminal.") ||
    event.type.startsWith("task.") ||
    event.type.startsWith("action.") ||
    event.type.startsWith("job.") ||
    event.type === "publication.receipt"
  ) {
    affected.push(keys.runs);
    if (runId) {
      affected.push(keys.run(runId), keys.capacity(runId), keys.tasks(runId));
      if (taskId) affected.push(keys.task(runId, taskId));
    } else {
      affected.push(["run"], ["tasks"], ["task"]);
    }
  }
  if (event.type.startsWith("job.")) {
    affected.push(keys.jobs, keys.infrastructureCapacity);
    affected.push(runId ? keys.runJobs(runId) : ["run-jobs"]);
  }
  if (event.type.startsWith("action.")) {
    const actionKind = stringData(event, "action_kind") ?? "";
    if (actionKind.startsWith("endpoint.")) affected.push(keys.endpoints);
    else if (actionKind.startsWith("job.")) {
      affected.push(keys.jobs, keys.infrastructureCapacity);
      affected.push(runId ? keys.runJobs(runId) : ["run-jobs"]);
    } else {
      affected.push(keys.jobs, keys.endpoints);
      affected.push(runId ? keys.runJobs(runId) : ["run-jobs"]);
    }
  }
  return affected;
}

export function useLiveUpdates(
  enabled: boolean,
  initialCursor?: string | null,
): LiveState {
  const client = useQueryClient();
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [state, setState] = useState<LiveState>({
    status: enabled && navigator.onLine !== false ? "reconnecting" : "offline",
    lastSuccessfulUpdate: null,
    retryAt: null,
  });
  const attempts = useRef(0);
  const lastEventId = useRef<string | null>(null);
  const pendingInvalidations = useRef<QueryKey[]>([]);
  const invalidationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (initialCursor && !lastEventId.current) lastEventId.current = initialCursor;

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const flushInvalidations = () => {
      const queryKeys = pendingInvalidations.current;
      pendingInvalidations.current = [];
      invalidationTimer.current = null;
      for (const queryKey of queryKeys)
        void client.invalidateQueries({ queryKey, refetchType: "active" });
    };
    const enqueueInvalidations = (queryKeys: QueryKey[]) => {
      if (queryKeys.length === 0) return;
      for (const queryKey of queryKeys)
        pendingInvalidations.current = coalesceQueryKey(
          pendingInvalidations.current,
          queryKey,
        );
      invalidationTimer.current ??= setTimeout(
        flushInvalidations,
        SSE_INVALIDATION_DEBOUNCE_MS,
      );
    };
    const refreshCurrentState = () => {
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== keys.session[0],
        refetchType: "active",
      });
    };

    const connect = () => {
      if (stopped) return;
      if (navigator.onLine === false) {
        setState((current) => ({ ...current, status: "offline", retryAt: null }));
        return;
      }
      setState((current) => ({ ...current, status: "reconnecting" }));
      const eventUrl = lastEventId.current
        ? `/api/v1/events?cursor=${encodeURIComponent(lastEventId.current)}`
        : "/api/v1/events";
      source = new EventSource(eventUrl, { withCredentials: true });
      source.onopen = () => {
        attempts.current = 0;
        const now = Date.now();
        setState({ status: "connected", lastSuccessfulUpdate: now, retryAt: null });
      };
      source.onmessage = (message) => {
        if (message.lastEventId) lastEventId.current = message.lastEventId;
        let event: ControlEvent;
        try {
          event = JSON.parse(message.data) as ControlEvent;
        } catch {
          return;
        }
        const now = Date.now();
        attempts.current = 0;
        setState({ status: "connected", lastSuccessfulUpdate: now, retryAt: null });
        if (event.type === "cursor.reset" || event.cursor_reset) {
          const latestCursor = event.data.latest_cursor;
          lastEventId.current = typeof latestCursor === "string" ? latestCursor : null;
          refreshCurrentState();
          return;
        }
        // Live resource events already identify the affected queries. System
        // state needs a refetch only when replay catches this browser up.
        enqueueInvalidations([
          ...(event.replay && event.type !== "heartbeat" ? [keys.system] : []),
          ...affectedQueryKeys(event),
        ]);
      };
      source.onerror = () => {
        source?.close();
        source = null;
        if (stopped) return;
        if (navigator.onLine === false) {
          setState((current) => ({ ...current, status: "offline", retryAt: null }));
          return;
        }
        const base = Math.min(1_000 * 2 ** attempts.current, 30_000);
        attempts.current += 1;
        const delay = Math.round(base * (0.8 + Math.random() * 0.4));
        const retryAt = Date.now() + delay;
        setState((current) => ({ ...current, status: "reconnecting", retryAt }));
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    const onOffline = () => {
      source?.close();
      source = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      setState((current) => ({ ...current, status: "offline", retryAt: null }));
    };
    const onOnline = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      attempts.current = 0;
      connect();
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    connect();
    return () => {
      stopped = true;
      source?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (invalidationTimer.current) clearTimeout(invalidationTimer.current);
      pendingInvalidations.current = [];
      invalidationTimer.current = null;
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [client, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      setState((current) =>
        current.status === "connected" &&
        current.lastSuccessfulUpdate !== null &&
        Date.now() - current.lastSuccessfulUpdate > 45_000
          ? { ...current, status: "stale" }
          : current,
      );
    }, 5_000);
    return () => clearInterval(timer);
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !visible || state.status === "connected") return;
    const timer = setInterval(() => {
      void client.invalidateQueries({
        predicate: (query) => query.queryKey[0] !== keys.session[0],
        refetchType: "active",
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, [client, enabled, state.status, visible]);

  return state;
}
