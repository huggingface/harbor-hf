import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type {
  AuditResponse,
  Campaign,
  CampaignList,
  EndpointList,
  JobList,
  ProfileList,
  ResultDetail,
  ResultList,
  SessionResponse,
  SystemResponse,
  TaskDetail,
  TaskList,
} from "./api";
import { ApiError, request } from "./api";

export const keys = {
  session: ["session"] as const,
  system: ["system"] as const,
  campaigns: ["campaigns"] as const,
  campaign: (id: string) => ["campaign", id] as const,
  tasks: (id: string) => ["tasks", id] as const,
  task: (campaign: string, task: string) => ["task", campaign, task] as const,
  jobs: ["jobs"] as const,
  endpoints: ["endpoints"] as const,
  profiles: ["profiles"] as const,
  results: ["results"] as const,
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
}

export type LiveStatus = "connected" | "reconnecting" | "offline" | "stale";

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
export const useSystem = () =>
  useQuery({
    queryKey: keys.system,
    queryFn: () => request<SystemResponse>("/api/v1/system"),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useCampaigns = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.campaigns, cursor ?? null],
    queryFn: () => request<CampaignList>(collectionUrl("/api/v1/campaigns", cursor)),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useCampaign = (id: string) =>
  useQuery({
    queryKey: keys.campaign(id),
    queryFn: () => request<Campaign>(`/api/v1/campaigns/${encodeURIComponent(id)}`),
    enabled: Boolean(id),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useTasks = (id: string, cursor?: string) =>
  useQuery({
    queryKey: [...keys.tasks(id), cursor ?? null],
    queryFn: () =>
      request<TaskList>(
        collectionUrl(`/api/v1/campaigns/${encodeURIComponent(id)}/tasks`, cursor),
      ),
    enabled: Boolean(id),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useTask = (campaign: string, task: string) =>
  useQuery({
    queryKey: keys.task(campaign, task),
    queryFn: () =>
      request<TaskDetail>(
        `/api/v1/campaigns/${encodeURIComponent(campaign)}/tasks/${encodeURIComponent(task)}`,
      ),
    enabled: Boolean(campaign && task),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useJobs = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.jobs, cursor ?? null],
    queryFn: () => request<JobList>(collectionUrl("/api/v1/jobs", cursor)),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useEndpoints = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.endpoints, cursor ?? null],
    queryFn: () => request<EndpointList>(collectionUrl("/api/v1/endpoints", cursor)),
    retry: retryTransient,
    retryDelay: queryRetryDelay,
  });
export const useProfiles = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.profiles, cursor ?? null],
    queryFn: () => request<ProfileList>(collectionUrl("/api/v1/profiles", cursor, 100)),
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

export function affectedQueryKeys(event: ControlEvent): QueryKey[] {
  if (event.type === "heartbeat") return [];
  const affected: QueryKey[] = [keys.audit];
  const campaignId = stringData(event, "campaign_id");
  const taskId = stringData(event, "task_id");
  if (event.type.startsWith("profile.")) affected.push(keys.profiles);
  if (event.type === "publication.receipt") affected.push(keys.results);
  if (
    event.type.startsWith("campaign.") ||
    event.type.startsWith("budget.") ||
    event.type.startsWith("attempt.") ||
    event.type.startsWith("terminal.") ||
    event.type.startsWith("action.") ||
    event.type === "publication.receipt"
  ) {
    affected.push(keys.campaigns);
    if (campaignId) {
      affected.push(keys.campaign(campaignId), keys.tasks(campaignId));
      if (taskId) affected.push(keys.task(campaignId, taskId));
    }
  }
  if (event.type.startsWith("action.")) {
    const actionKind = stringData(event, "action_kind") ?? "";
    if (actionKind.startsWith("endpoint.")) affected.push(keys.endpoints);
    else if (actionKind.startsWith("job.") || actionKind.startsWith("sandbox."))
      affected.push(keys.jobs);
    else affected.push(keys.jobs, keys.endpoints);
  }
  return affected;
}

export function useLiveUpdates(enabled: boolean): LiveState {
  const client = useQueryClient();
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");
  const [state, setState] = useState<LiveState>({
    status: navigator.onLine === false ? "offline" : "reconnecting",
    lastSuccessfulUpdate: null,
    retryAt: null,
  });
  const attempts = useRef(0);
  const lastEventId = useRef<string | null>(null);

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
        if (event.type !== "heartbeat")
          client.setQueryData<SystemResponse>(keys.system, (current) =>
            current
              ? {
                  ...current,
                  projection: {
                    ...current.projection,
                    object_count: current.projection.object_count + 1,
                    last_sync_at: event.occurred_at,
                  },
                }
              : current,
          );
        for (const queryKey of affectedQueryKeys(event))
          void client.invalidateQueries({ queryKey });
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
