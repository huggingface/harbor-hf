import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  getJobs,
  getLeaderboard,
  getModelProviders,
  getPresets,
  getRun,
  getRuns,
  getSession,
  getSystem,
  getTrial,
  getTrialProgress,
  getTrials,
} from "./api";

export const RUN_POLL_INTERVAL_MS = 10_000;

// Display age and freshness must advance even while a request hangs.
export function useRunClock() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), RUN_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export const keys = {
  session: ["session"] as const,
  system: ["system"] as const,
  presets: ["presets"] as const,
  modelProviders: (model: string) => ["model-providers", model] as const,
  leaderboard: ["leaderboard"] as const,
  runs: ["runs"] as const,
  run: (runId: string) => ["run", runId] as const,
  trials: (runId: string) => ["trials", runId] as const,
  trial: (runId: string, trialName: string) => ["trial", runId, trialName] as const,
  jobs: ["jobs"] as const,
};

export function useSession() {
  return useQuery({ queryKey: keys.session, queryFn: getSession, staleTime: 60_000 });
}

export function useSystem() {
  return useQuery({
    queryKey: keys.system,
    queryFn: getSystem,
    refetchInterval: 15_000,
  });
}

export function usePresets() {
  return useQuery({ queryKey: keys.presets, queryFn: getPresets });
}

export function useModelProviders(model: string) {
  const normalized = model.trim();
  return useQuery({
    queryKey: keys.modelProviders(normalized),
    queryFn: () => getModelProviders(normalized),
    enabled: Boolean(normalized),
    staleTime: 300_000,
  });
}

export function useLeaderboard() {
  return useQuery({ queryKey: keys.leaderboard, queryFn: getLeaderboard });
}

export function useRuns() {
  return useQuery({
    queryKey: keys.runs,
    queryFn: getRuns,
    refetchInterval: RUN_POLL_INTERVAL_MS,
    placeholderData: keepPreviousData,
  });
}

export function useRun(runId: string) {
  return useQuery({
    queryKey: keys.run(runId),
    queryFn: () => getRun(runId),
    enabled: Boolean(runId),
    refetchInterval: RUN_POLL_INTERVAL_MS,
  });
}

export function useTrials(runId: string) {
  return useQuery({
    queryKey: keys.trials(runId),
    queryFn: () => getTrials(runId),
    enabled: Boolean(runId),
    refetchInterval: RUN_POLL_INTERVAL_MS,
  });
}

export function useTrial(runId: string, trialName: string) {
  return useQuery({
    queryKey: keys.trial(runId, trialName),
    queryFn: () => getTrial(runId, trialName),
    enabled: Boolean(runId && trialName),
  });
}

export function useJobs() {
  return useQuery({
    queryKey: keys.jobs,
    queryFn: getJobs,
    refetchInterval: RUN_POLL_INTERVAL_MS,
  });
}

export function useTrialProgress(runId: string) {
  return useQuery({
    queryKey: ["trial-progress", runId],
    queryFn: () => getTrialProgress(runId),
    staleTime: RUN_POLL_INTERVAL_MS,
    enabled: Boolean(runId),
    refetchInterval: RUN_POLL_INTERVAL_MS,
    retry: false,
  });
}
