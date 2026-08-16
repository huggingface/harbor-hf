import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  AuditResponse,
  Campaign,
  CampaignList,
  EndpointList,
  JobList,
  ProfileList,
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
  audit: ["audit"] as const,
};

const poll = 10_000;

export function collectionUrl(path: string, cursor?: string, limit?: number): string {
  const parameters = new URLSearchParams();
  if (cursor) parameters.set("cursor", cursor);
  if (limit) parameters.set("limit", String(limit));
  const query = parameters.toString();
  return query ? `${path}?${query}` : path;
}

export const useSession = () =>
  useQuery({
    queryKey: keys.session,
    queryFn: () => request<SessionResponse>("/api/v1/auth/session"),
    retry: (count, error) =>
      !(error instanceof ApiError && error.status === 401) && count < 2,
  });
export const useSystem = () =>
  useQuery({
    queryKey: keys.system,
    queryFn: () => request<SystemResponse>("/api/v1/system"),
    refetchInterval: poll,
  });
export const useCampaigns = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.campaigns, cursor ?? null],
    queryFn: () => request<CampaignList>(collectionUrl("/api/v1/campaigns", cursor)),
    refetchInterval: poll,
  });
export const useCampaign = (id: string) =>
  useQuery({
    queryKey: keys.campaign(id),
    queryFn: () => request<Campaign>(`/api/v1/campaigns/${encodeURIComponent(id)}`),
    refetchInterval: poll,
    enabled: Boolean(id),
  });
export const useTasks = (id: string, cursor?: string) =>
  useQuery({
    queryKey: [...keys.tasks(id), cursor ?? null],
    queryFn: () =>
      request<TaskList>(
        collectionUrl(`/api/v1/campaigns/${encodeURIComponent(id)}/tasks`, cursor),
      ),
    refetchInterval: poll,
    enabled: Boolean(id),
  });
export const useTask = (campaign: string, task: string) =>
  useQuery({
    queryKey: keys.task(campaign, task),
    queryFn: () =>
      request<TaskDetail>(
        `/api/v1/campaigns/${encodeURIComponent(campaign)}/tasks/${encodeURIComponent(task)}`,
      ),
    refetchInterval: poll,
    enabled: Boolean(campaign && task),
  });
export const useJobs = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.jobs, cursor ?? null],
    queryFn: () => request<JobList>(collectionUrl("/api/v1/jobs", cursor)),
    refetchInterval: poll,
  });
export const useEndpoints = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.endpoints, cursor ?? null],
    queryFn: () => request<EndpointList>(collectionUrl("/api/v1/endpoints", cursor)),
    refetchInterval: poll,
  });
export const useProfiles = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.profiles, cursor ?? null],
    queryFn: () => request<ProfileList>(collectionUrl("/api/v1/profiles", cursor)),
  });
export const useResults = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.results, cursor ?? null],
    queryFn: () => request<ResultList>(collectionUrl("/api/v1/results", cursor)),
    refetchInterval: poll,
  });
export const useAudit = (cursor?: string) =>
  useQuery({
    queryKey: [...keys.audit, cursor ?? null],
    queryFn: () => request<AuditResponse>(collectionUrl("/api/v1/audit", cursor, 250)),
    refetchInterval: poll,
  });

export function useLiveUpdates(
  enabled: boolean,
): "connected" | "reconnecting" | "offline" {
  const client = useQueryClient();
  const [status, setStatus] = useState<"connected" | "reconnecting" | "offline">(
    "offline",
  );
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/v1/events", { withCredentials: true });
    source.onopen = () => setStatus("connected");
    source.onerror = () => setStatus("reconnecting");
    source.onmessage = () => void client.invalidateQueries();
    return () => {
      source.close();
      setStatus("offline");
    };
  }, [client, enabled]);
  return status;
}
