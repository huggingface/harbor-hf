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
export const useCampaigns = () =>
  useQuery({
    queryKey: keys.campaigns,
    queryFn: () => request<CampaignList>("/api/v1/campaigns"),
    refetchInterval: poll,
  });
export const useCampaign = (id: string) =>
  useQuery({
    queryKey: keys.campaign(id),
    queryFn: () => request<Campaign>(`/api/v1/campaigns/${encodeURIComponent(id)}`),
    refetchInterval: poll,
    enabled: Boolean(id),
  });
export const useTasks = (id: string) =>
  useQuery({
    queryKey: keys.tasks(id),
    queryFn: () =>
      request<TaskList>(`/api/v1/campaigns/${encodeURIComponent(id)}/tasks`),
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
export const useJobs = () =>
  useQuery({
    queryKey: keys.jobs,
    queryFn: () => request<JobList>("/api/v1/jobs"),
    refetchInterval: poll,
  });
export const useEndpoints = () =>
  useQuery({
    queryKey: keys.endpoints,
    queryFn: () => request<EndpointList>("/api/v1/endpoints"),
    refetchInterval: poll,
  });
export const useProfiles = () =>
  useQuery({
    queryKey: keys.profiles,
    queryFn: () => request<ProfileList>("/api/v1/profiles"),
  });
export const useResults = () =>
  useQuery({
    queryKey: keys.results,
    queryFn: () => request<ResultList>("/api/v1/results"),
    refetchInterval: poll,
  });
export const useAudit = () =>
  useQuery({
    queryKey: keys.audit,
    queryFn: () => request<AuditResponse>("/api/v1/audit?limit=250"),
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
